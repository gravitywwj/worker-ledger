export const PAYMENT_CHANNELS = ['微信', '支付宝', '银行卡', '现金', '其他'];
const TYPES = ['expense', 'income', 'transfer'];
const REFERENCE_PATTERN = /(?:交易单号|订单号|交易号|流水号|单号)\s*[:：]?\s*([A-Za-z0-9_-]+)/g;

export function statementHints(value) {
  const input = String(value || '');
  const references = [...input.matchAll(REFERENCE_PATTERN)];
  return { source: input.match(/(?:微信|支付宝|银行卡)(?:账单|流水)/)?.[0] || '', externalId: references.length === 1 ? references[0][1] : '' };
}

export function candidateIndexForDraft(draft, candidates) {
  const matches = candidates.map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => Math.round(candidate.amountYuan * 100) === Math.round(draft.amountYuan * 100));
  if (draft.candidateId) {
    const match = matches.find(({ candidate }) => candidate.candidateId === draft.candidateId);
    if (!match) throw new Error('草稿候选 ID 与原始金额不匹配。');
    return match.index;
  }
  const routing = new Set(matches.map(({ candidate }) => JSON.stringify([candidate.typeHint, candidate.accountHint, candidate.toAccountHint, candidate.paymentChannel, candidate.date, candidate.sourceText])));
  if (routing.size > 1) throw new Error('多笔同额流水的来源不同，必须返回对应的 candidateId。');
  return matches[0]?.index ?? -1;
}

export function maskStatementReferences(value) {
  return String(value || '').replace(REFERENCE_PATTERN, (match) => match.replace(/[A-Za-z0-9_-]/g, ' '));
}

function text(value, limit, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > limit) throw new Error(`${label}格式无效。`);
  return value.trim();
}

export function statementIdentity(entry) {
  const source = String(entry.source || '').normalize('NFKC').replace(/\s+/g, '').replace(/(?:账单|流水)$/, '').toLowerCase();
  return entry.source && entry.externalId ? JSON.stringify([source || entry.source, entry.accountId || '', entry.externalId]) : '';
}

export function normalizeTransactionDetails(transaction) {
  const paymentChannel = text(transaction.paymentChannel, 20, '支付渠道');
  if (paymentChannel && !PAYMENT_CHANNELS.includes(paymentChannel)) throw new Error('支付渠道无效。');
  if (transaction.statementEntries !== undefined && !Array.isArray(transaction.statementEntries)) throw new Error('流水来源必须是列表。');
  const statementEntries = (transaction.statementEntries || []).map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('流水来源格式无效。');
    const entry = {
      source: text(raw.source, 80, '流水来源'), accountId: text(raw.accountId, 120, '来源账户'),
      externalId: text(raw.externalId, 120, '交易单号'), postedAt: text(raw.postedAt, 40, '入账时间'),
      note: text(raw.note, 4000, '原始说明'), occurredAt: text(raw.occurredAt, 40, '来源交易时间'),
      amount: raw.amount, type: raw.type,
      paymentChannel: text(raw.paymentChannel, 20, '来源支付渠道'),
    };
    if (!entry.source || !Number.isSafeInteger(entry.amount) || entry.amount <= 0 || !TYPES.includes(entry.type)
      || !entry.occurredAt || !Number.isFinite(Date.parse(entry.occurredAt))
      || (entry.postedAt && !Number.isFinite(Date.parse(entry.postedAt)))
      || (entry.paymentChannel && !PAYMENT_CHANNELS.includes(entry.paymentChannel))) throw new Error('流水来源的金额、类型、渠道或日期无效。');
    return entry;
  });
  return { paymentChannel, statementEntries };
}

export function statementEntry(transaction, details = {}) {
  return normalizeTransactionDetails({ statementEntries: [{
    source: transaction.source === 'agent' ? '助手记录' : '手工记录', accountId: transaction.accountId || '',
    externalId: '', postedAt: '', note: transaction.note || '', occurredAt: transaction.occurredAt,
    amount: transaction.amount, type: transaction.type, paymentChannel: transaction.paymentChannel || '', ...details,
  }] }).statementEntries[0];
}

export function associateTransaction(existing, incoming, correctAccount = false) {
  if (existing.amount !== incoming.amount) throw new Error('两笔金额不同，请先核对金额，不能直接关联。');
  if (existing.type !== incoming.type && existing.type !== 'transfer' && incoming.type !== 'transfer') throw new Error('收入和支出不能关联为同一笔。');
  if (incoming.type === 'transfer' && existing.type !== 'transfer' && !correctAccount) throw new Error('请明确将原记录修正为内部转账。');
  if (correctAccount && (!incoming.accountId || (incoming.type === 'transfer' && (!incoming.toAccountId || incoming.toAccountId === incoming.accountId)))) throw new Error('修正原记录需要确认实际账户。');
  if (correctAccount && existing.type === 'transfer' && incoming.type !== 'transfer') throw new Error('转账的单边流水只能补充来源，不能覆盖内部转账。');
  const originalDetails = normalizeTransactionDetails(existing);
  const incomingDetails = normalizeTransactionDetails(incoming);
  const entries = [
    ...(originalDetails.statementEntries.length ? originalDetails.statementEntries : [statementEntry(existing)]),
    ...(correctAccount && (existing.accountId !== incoming.accountId || existing.toAccountId !== incoming.toAccountId || existing.type !== incoming.type)
      ? [statementEntry(existing, { source: '修正前记录' })] : []),
    ...(incomingDetails.statementEntries.length ? incomingDetails.statementEntries : [statementEntry(incoming)]),
  ];
  const seen = new Set();
  const statementEntries = entries.filter((entry) => {
    const key = JSON.stringify(entry);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return {
    ...existing,
    ...(correctAccount ? { type: incoming.type, accountId: incoming.accountId, toAccountId: incoming.type === 'transfer' ? incoming.toAccountId : '',
      categoryId: incoming.type === 'transfer' ? 'transfer' : existing.categoryId } : {}),
    paymentChannel: originalDetails.paymentChannel || incomingDetails.paymentChannel,
    statementEntries, updatedAt: incoming.updatedAt,
  };
}

// A platform name alone describes a channel; balance wording identifies its own account.
export function parseTransactionRouting(value, accounts = []) {
  const input = String(value || '').normalize('NFKC');
  const lower = input.toLowerCase();
  const available = accounts.map((account) => ({ ...account, id: account.id || account.name }));
  const aliases = available.flatMap((account) => {
    const names = [account.name || account.id];
    if (/微信/.test(account.name || account.id)) names.push('微信', '微信零钱', '微信余额', '零钱');
    if (/支付宝/.test(account.name || account.id)) names.push('支付宝', '支付宝余额');
    if (account.type === 'cash' || /现金/.test(account.name || '')) names.push('现金');
    return [...new Set(names)].map((name) => ({ account, name }));
  });
  const banks = available.filter((account) => ['bank', 'card', 'savings'].includes(account.type) || /银行卡|工资卡|银行/.test(account.name || ''));
  if (banks.length === 1) aliases.push({ account: banks[0], name: '银行卡' });
  const mentions = aliases.flatMap(({ account, name }) => {
    const index = lower.indexOf(name.toLowerCase());
    return index < 0 ? [] : [{ ...account, index, name, end: index + name.length }];
  }).sort((a, b) => a.index - b.index || b.name.length - a.name.length);
  const unique = mentions.filter((mention, index) => mentions.findIndex((item) => item.id === mention.id) === index);
  const channelNames = ['微信', '支付宝', '现金', '银行卡'].filter((name) => input.includes(name));
  const paymentChannel = channelNames.find((name) => new RegExp(`${name}[^，,。；;]{0,6}(?:支付|付款|收款)`).test(input)) || channelNames[0] || '';
  const refund = /退款|退回|退还|返还|返款|返现|报销到账/.test(input);
  let type = refund ? 'income' : /支出|消费|花费|付款|付了|买了|购买|扣款|外卖|餐饮/.test(input) ? 'expense'
    : /收入|工资到账|薪资到账|工资收入|薪资收入|奖金到账|兼职收入|补贴到账|收到|收款|到账/.test(input) ? 'income' : 'expense';
  let accountId = '', toAccountId = '';
  const movement = /转账|转到|转入|转出|充值|提现|转存/.test(input);
  const externalTarget = /商家|商户|朋友|别人|他人|话费|水费|电费|燃气|公交卡|交通卡|游戏/.test(input);
  const walletMovement = mentions.some((mention) => /微信|支付宝|零钱/.test(mention.name) && /^\s*(?:充值|提现)/.test(input.slice(mention.end)));
  if (!refund && movement && unique.length === 2 && !externalTarget) {
    let [from, to] = unique;
    if (/提现/.test(input)) {
      from = unique.find((account) => /微信|支付宝/.test(account.name)) || from;
      to = unique.find((account) => account.id !== from.id);
    } else if (/从/.test(input)) {
      const fromMention = mentions.find((mention) => /从\s*$/.test(input.slice(Math.max(0, mention.index - 3), mention.index)));
      if (fromMention) { from = fromMention; to = unique.find((account) => account.id !== from.id); }
    } else if (/充值/.test(input) && unique.some((account) => banks.some((bank) => bank.id === account.id))) {
      from = unique.find((account) => banks.some((bank) => bank.id === account.id));
      to = unique.find((account) => account.id !== from.id);
    }
    const between = input.slice(unique[0].end, unique[1].index);
    const connected = /^(?:\s*(?:余额|零钱))?\s*(?:向|给|到|至|转到|转入|转至|转账到|转账给|转账至|转出到|提现到|提现至|转(?:账|出)?\s*[¥￥\d.,元块\s]*(?:到|至))\s*(?:自己的|本人)?\s*$/.test(between);
    if (connected || walletMovement) {
      type = 'transfer'; accountId = from.id; toAccountId = to.id;
    }
  }
  if (!refund && !externalTarget && walletMovement && unique.length === 1) {
    type = 'transfer';
    accountId = /提现/.test(input) ? unique[0].id : '';
    toAccountId = /充值/.test(input) ? unique[0].id : '';
  }
  if (type !== 'transfer') {
    const explicit = mentions.filter((mention) => {
      const before = input.slice(Math.max(0, mention.index - 8), mention.index);
      const after = input.slice(mention.end, mention.end + 12);
      const wallet = /微信|支付宝|零钱/.test(mention.name);
      return /(?:扣款|扣除|到账|入账|付款账户|收款账户|实际账户|实际走|走的|使用|用|从)\s*(?:是|为|到|至|了)?\s*$/.test(before)
        || /^\s*(?:扣款|扣除|到账|入账|余额|零钱)/.test(after)
        || (wallet && /余额|零钱/.test(mention.name)) || (!wallet && (unique.length === 1 || /^\s*(?:支出|收入|消费|支付|付款|收款|流水|账单)/.test(after)));
    });
    const explicitIds = [...new Set(explicit.map((mention) => mention.id))];
    if (explicitIds.length === 1) accountId = explicitIds[0];
  }
  return { type, accountId, toAccountId, paymentChannel };
}
