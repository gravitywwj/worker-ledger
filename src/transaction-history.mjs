import { statementIdentity } from './transaction-reconciliation.mjs';

const NOTE_SYNONYMS = [
  [/早上吃饭|早饭|早膳/g, '早餐'],
  [/中午吃饭|午饭|中饭|午膳/g, '午餐'],
  [/晚上吃饭|晚饭|晚膳/g, '晚餐'],
  [/薪水|薪资|薪酬/g, '工资'],
  [/工资到账|工资收入/g, '工资'],
  [/房屋租金|房租费|租金/g, '房租'],
  [/出租车|网约车|的士/g, '打车'],
  [/公交车|公车/g, '公交'],
  [/手机话费|电话费/g, '话费'],
  [/退货退款|退款到账|退还款|返款/g, '退款'],
  [/报销到账|报销款/g, '报销'],
  [/绩效奖金|绩效奖/g, '奖金'],
  [/奖金到账/g, '奖金'],
  [/(?:chat)?gpt/g, 'chatgpt'],
];

export function normalizeTransactionNote(value) {
  let text = String(value || '').normalize('NFKC').toLowerCase().replace(/\s/g, '');
  for (const [pattern, replacement] of NOTE_SYNONYMS) text = text.replace(pattern, replacement);
  return text.replace(/[^\p{L}\p{N}]/gu, '');
}

function bigrams(note) {
  const chars = Array.from(note);
  return new Set(chars.slice(0, -1).map((char, index) => char + chars[index + 1]));
}

function localDate(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function historyEntry(transaction, categories, accounts) {
  const amount = transaction.amountYuan === undefined ? Number(transaction.amount) : Math.round(Number(transaction.amountYuan) * 100);
  const timestamp = new Date(transaction.occurredAt).getTime();
  if (transaction.deletedAt || !Number.isFinite(amount) || !(amount > 0) || !Number.isFinite(timestamp)) return null;
  const note = normalizeTransactionNote(transaction.note)
    .replace(/(?:微信|支付宝|银行卡|工资卡)(?:支付|付款|收款|扣款|到账|账单|流水|余额|零钱)/g, '')
    .replace(/^(?:支出|收入|消费|付款|到账|收款|账户转账|内部转账|转账|充值|提现)$/, '');
  const date = transaction.date || localDate(transaction.occurredAt);
  const category = transaction.category || categories.get(transaction.categoryId) || '';
  const account = transaction.account || accounts.get(transaction.accountId) || '';
  const statements = transaction.statementEntries || [];
  return { transaction, amount, timestamp, date, note, grams: bigrams(note),
    identities: statements.map(statementIdentity).filter(Boolean),
    days: [...new Set([date, ...statements.flatMap((entry) => [entry.occurredAt, entry.postedAt].filter(Boolean).map(localDate))].map((value) => Date.parse(value) / 86400000))],
    searchText: normalizeTransactionNote([category, account, accounts.get(transaction.toAccountId), transaction.note, transaction.paymentChannel,
      ...statements.flatMap((entry) => [entry.source, accounts.get(entry.accountId), entry.externalId, entry.note, entry.postedAt]),
      ...(transaction.tags || []), date].join(' ')) };
}

export function buildTransactionHistoryIndex(transactions, { categories = [], accounts = [] } = {}) {
  const categoryNames = new Map(categories.map((item) => [item.id, item.label]));
  const accountNames = new Map(accounts.map((item) => [item.id, item.name]));
  const entries = transactions.map((item) => historyEntry(item, categoryNames, accountNames)).filter(Boolean).sort((a, b) => b.timestamp - a.timestamp);
  const byType = new Map();
  const byStatement = new Map();
  for (const entry of entries) {
    if (!byType.has(entry.transaction.type)) byType.set(entry.transaction.type, []);
    byType.get(entry.transaction.type).push(entry);
    for (const key of entry.identities) {
      if (!byStatement.has(key)) byStatement.set(key, []);
      byStatement.get(key).push(entry);
    }
  }
  for (const entries of byType.values()) entries.sort((a, b) => a.amount - b.amount || b.timestamp - a.timestamp);
  return { entries, byType, byStatement };
}

export function searchTransactionHistory(index, query = {}) {
  for (const value of [query.startDate, query.endDate].filter(Boolean)) {
    const date = new Date(`${value}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('查询日期无效。');
  }
  if (query.startDate && query.endDate && query.startDate > query.endDate) throw new Error('查询开始日期不能晚于结束日期。');
  const keyword = String(query.keyword || '').trim();
  const amountQuery = keyword.match(/^[¥￥]?(\d+(?:\.\d{1,2})?)元?$/);
  const terms = amountQuery ? [] : keyword.split(/[\s,，]+/).map(normalizeTransactionNote).filter(Boolean);
  const minAmount = amountQuery ? Math.round(Number(amountQuery[1]) * 100) : query.minAmountYuan == null ? 0 : Math.round(Number(query.minAmountYuan) * 100);
  const maxAmount = amountQuery ? minAmount : query.maxAmountYuan == null ? Infinity : Math.round(Number(query.maxAmountYuan) * 100);
  if (!Number.isFinite(minAmount) || minAmount < 0 || Number.isNaN(maxAmount) || maxAmount < minAmount) throw new Error('查询金额范围无效。');
  const matches = index.entries.filter(({ transaction, date, amount, searchText }) => {
    if (query.type && query.type !== 'all' && transaction.type !== query.type) return false;
    if (query.accountId && query.accountId !== 'all' && transaction.accountId !== query.accountId && transaction.toAccountId !== query.accountId) return false;
    if (query.categoryId && transaction.categoryId !== query.categoryId) return false;
    return (!query.startDate || date >= query.startDate) && (!query.endDate || date <= query.endDate)
      && amount >= minAmount && amount <= maxAmount && terms.every((term) => searchText.includes(term));
  });
  const limit = Math.max(1, Math.min(200, Math.floor(Number(query.limit) || 20)));
  const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
  const totals = { expense: 0, income: 0, transfer: 0 };
  for (const entry of matches) if (Object.hasOwn(totals, entry.transaction.type)) totals[entry.transaction.type] += entry.amount;
  return { count: matches.length, totalCount: index.entries.length, incomeAmount: totals.income, expenseAmount: totals.expense,
    transferAmount: totals.transfer, offset, hasMore: offset + limit < matches.length,
    transactions: matches.slice(offset, offset + limit).map((entry) => entry.transaction) };
}

function noteSimilarity(left, right) {
  if (!left.note || !right.note) return 0;
  if (left.note === right.note) return 1;
  if (Math.min(left.note.length, right.note.length) >= 2
    && Math.min(left.note.length, right.note.length) / Math.max(left.note.length, right.note.length) >= 0.4
    && (left.note.includes(right.note) || right.note.includes(left.note))) return 0.75;
  if (!left.grams.size || !right.grams.size) return 0;
  const shared = [...left.grams].filter((gram) => right.grams.has(gram)).length;
  return 2 * shared / (left.grams.size + right.grams.size);
}

function duplicateMatch(candidate, existing) {
  if (candidate.transaction.id && candidate.transaction.id === existing.transaction.id) return null;
  const difference = Math.abs(candidate.amount - existing.amount);
  const sameStatement = candidate.identities.some((key) => existing.identities.includes(key));
  const elapsed = Math.abs(candidate.timestamp - existing.timestamp);
  if (sameStatement) return { transaction: existing.transaction, kind: 'possible_duplicate', elapsed, similarity: 1, difference, sameStatement: true,
    reason: difference ? '同一来源账户的交易单号相同，但金额不同，请核对' : '同一来源账户的交易单号相同' };
  if (difference > Math.max(100, Math.round(Math.max(candidate.amount, existing.amount) * 0.05))) return null;
  let dayGap = Infinity;
  for (const left of candidate.days) for (const right of existing.days) dayGap = Math.min(dayGap, Math.abs(left - right));
  const nearbyAmount = difference === 0 && dayGap <= 3;
  const sameType = candidate.transaction.type === existing.transaction.type;
  if (!sameType) {
    const transfer = candidate.transaction.type === 'transfer' ? candidate.transaction : existing.transaction.type === 'transfer' ? existing.transaction : null;
    const leg = transfer === candidate.transaction ? existing.transaction : candidate.transaction;
    const legEntry = transfer === candidate.transaction ? existing : candidate;
    if (!transfer || !nearbyAmount || !['expense', 'income'].includes(leg.type)) return null;
    const expectedAccount = leg.type === 'expense' ? transfer.accountId : transfer.toAccountId;
    const transferDescription = /充值|提现|转入|转出|转账/.test(leg.note || '');
    if (leg.accountId ? leg.accountId !== expectedAccount && !transferDescription : !!legEntry.note && !transferDescription) return null;
    return { transaction: existing.transaction, kind: 'possible_duplicate', elapsed, similarity: 0, difference, transferLeg: true,
      reason: '可能是内部转账的一侧扣款或到账，关联后只计一次转账' };
  }
  const similarity = noteSimilarity(candidate, existing);
  const sparseMatch = nearbyAmount && (!candidate.note || !existing.note);
  if (similarity < 0.6 && !sparseMatch && !(nearbyAmount && dayGap === 0)) return null;
  const recent = nearbyAmount || elapsed <= 24 * 60 * 60 * 1000;
  const reason = similarity >= 0.6 ? difference === 0 ? '备注相同或同义、相似，金额相同' : '备注同义或相似，金额接近'
    : dayGap === 0 ? '同日、同金额、同类型，需确认是否为两笔独立收支' : '日期相邻且金额、类型相同，可能存在入账日期差异';
  return { transaction: existing.transaction, kind: recent ? 'possible_duplicate' : 'similar_history', elapsed, similarity, difference,
    accountConflict: !!candidate.transaction.accountId && !!existing.transaction.accountId && candidate.transaction.accountId !== existing.transaction.accountId, reason };
}

function lowerAmountBound(entries, amount) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle].amount < amount) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function findDuplicateTransactions(index, transactions, limit = 3) {
  const results = [];
  const earlierDrafts = [];
  for (const transaction of transactions) {
    const candidate = historyEntry(transaction, new Map(), new Map());
    if (!candidate || !['expense', 'income', 'transfer'].includes(transaction.type)) continue;
    const minimum = candidate.amount - Math.max(100, Math.round(candidate.amount * 0.05)) - 1;
    const maximum = Math.ceil(Math.max(candidate.amount + 100, candidate.amount / 0.95)) + 1;
    const matches = [];
    const checked = new Set();
    const check = (entry) => {
      if (checked.has(entry)) return;
      checked.add(entry);
      const match = duplicateMatch(candidate, entry);
      if (match) matches.push(match);
    };
    for (const key of candidate.identities) for (const entry of index.byStatement.get(key) || []) check(entry);
    const types = transaction.type === 'transfer' ? ['transfer', 'expense', 'income'] : [transaction.type, 'transfer'];
    for (const type of types) {
      const entries = index.byType.get(type) || [];
      for (let i = lowerAmountBound(entries, minimum); i < entries.length && entries[i].amount <= maximum; i++) check(entries[i]);
    }
    for (const draft of earlierDrafts) {
      const match = duplicateMatch(candidate, draft);
      if (match) matches.push({ ...match, draftMatch: true });
    }
    matches.sort((a, b) => Number(!!b.sameStatement) - Number(!!a.sameStatement) || Number(b.kind === 'possible_duplicate') - Number(a.kind === 'possible_duplicate')
      || b.similarity - a.similarity || a.difference - b.difference || a.elapsed - b.elapsed);
    if (matches.length) results.push({ candidate: transaction, count: matches.length, matches: matches.slice(0, limit) });
    earlierDrafts.push(candidate);
  }
  return results;
}

export function parseHistoryQuery(value, { today = new Date(), categories = [], accounts = [] } = {}) {
  let text = String(value || '').normalize('NFKC');
  if (!/查询|查找|查一下|查历史|查之前|查以前|搜索|找出|找一下|查.*(?:账单|流水|记录)|(?:历史|之前|以前).*(?:账单|流水|记录)|有没有.*(?:记|账单|流水)|是否.*记过/.test(text)) return null;
  const current = new Date(today);
  const query = { keyword: '', type: /转账/.test(text) ? 'transfer' : /收入/.test(text) ? 'income' : /支出/.test(text) ? 'expense' : '' };
  let year = /去年/.test(text) ? current.getFullYear() - 1 : current.getFullYear();
  const setMonth = (year, month) => {
    query.startDate = localDate(new Date(year, month - 1, 1));
    query.endDate = localDate(new Date(year, month, 0));
  };
  const explicit = text.match(/(\d{4})\s*[/.\-]\s*(\d{1,2})(?:\s*[/.\-]\s*(\d{1,2})(?!\d))?|(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月(?:\s*(\d{1,2})\s*(?:日|号))?/);
  if (explicit) {
    year = Number(explicit[1] || explicit[4] || year);
    const month = Number(explicit[2] || explicit[5]);
    const day = Number(explicit[3] || explicit[6] || 0);
    if (month < 1 || month > 12 || (day && (day < 1 || day > new Date(year, month, 0).getDate()))) throw new Error('查询日期无效。');
    if (day) query.startDate = query.endDate = localDate(new Date(year, month - 1, day));
    else setMonth(year, month);
    text = text.replace(explicit[0], ' ');
  } else if (/上个月|上月|本月|这个月/.test(text)) {
    const month = new Date(current.getFullYear(), current.getMonth() - (/上个月|上月/.test(text) ? 1 : 0), 1);
    setMonth(month.getFullYear(), month.getMonth() + 1);
  } else if (/今天|昨天|前天/.test(text)) {
    current.setDate(current.getDate() - (/前天/.test(text) ? 2 : /昨天/.test(text) ? 1 : 0));
    query.startDate = query.endDate = localDate(current);
  } else {
    const yearMatch = text.match(/(\d{4})年/);
    if (yearMatch || /去年|今年/.test(text)) {
      year = Number(yearMatch?.[1] || year);
      query.startDate = `${year}-01-01`;
      query.endDate = `${year}-12-31`;
      if (yearMatch) text = text.replace(yearMatch[0], ' ');
    }
  }
  const amount = text.match(/(?:[¥￥]\s*)?(\d+(?:\.\d{1,2})?)\s*(?:元|块钱|块)/);
  if (amount) {
    query.minAmountYuan = query.maxAmountYuan = Number(amount[1]);
    text = text.replace(amount[0], ' ');
  }
  const account = accounts.find((item) => text.includes(item.name));
  if (account) { query.accountId = account.id; text = text.replace(account.name, ' '); }
  const category = categories.find((item) => text.includes(item.label));
  if (category) { query.categoryId = category.id; text = text.replace(category.label, ' '); }
  text = text.replace(/查找一下|查询一下|查一下|找一下|查历史|查之前|查以前|帮我|请|查询|查找|搜索|找出|查|找|有没有|是否|记过|以前|之前|历史|过去|所有|全部|上个月|上月|本月|这个月|去年|今年|今天|昨天|前天|账单|流水|记录|明细|收入|支出|转账|合计|总共|一共|多少|那笔|这笔|的|了|吗|[?？。!！]/g, ' ');
  query.keyword = text.trim().replace(/\s+/g, ' ');
  return query;
}
