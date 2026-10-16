import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildTransactionHistoryIndex, searchTransactionHistory, findDuplicateTransactions, normalizeTransactionNote, parseHistoryQuery } from '../src/transaction-history.mjs';
import { executeAgentTool, extractTransactionCandidates, validateTransactionDrafts } from '../agent/tools.mjs';
import { normalizeAgentResponse } from '../agent/schemas.mjs';
import { createLedgerAgent } from '../agent/agent.mjs';
import { parseTransactionRouting, statementEntry, associateTransaction, normalizeTransactionDetails, statementIdentity, maskStatementReferences, statementHints } from '../src/transaction-reconciliation.mjs';
import { normalizeBackup } from '../src/product-backup.mjs';

const categories = [{ id: 'food', label: '餐饮', type: 'expense' }, { id: 'salary', label: '工资', type: 'income' }];
const accounts = [{ id: 'wechat', name: '微信' }, { id: 'salary-card', name: '工资卡' }];
const entry = (values = {}) => ({ id: 'old', type: 'expense', amount: 2800, note: '午餐', categoryId: 'food', accountId: 'wechat', occurredAt: '2020-01-01T12:00:00Z', ...values });

test('common ledger synonyms normalize without turning a salary account into income', () => {
  for (const [left, right] of [['午饭', '午餐'], ['早饭', '早餐'], ['薪资', '工资到账'], ['租金', '房租'], ['的士', '打车'], ['CHAT GPT', 'ChatGPT']]) {
    assert.equal(normalizeTransactionNote(left), normalizeTransactionNote(right));
  }
  assert.notEqual(normalizeTransactionNote('工资卡'), normalizeTransactionNote('工资'));
  assert.equal(normalizeTransactionNote(normalizeTransactionNote('ChatGPT 手机话费')), normalizeTransactionNote('ChatGPT 手机话费'));
});

test('finds older-than-30 synonym matches across complete history and labels recurring entries honestly', () => {
  const transactions = [entry(), ...Array.from({ length: 40 }, (_, i) => entry({ id: `new-${i}`, amount: 10000 + i, note: '其他购物', occurredAt: '2026-10-01T12:00:00Z' }))];
  const index = buildTransactionHistoryIndex(transactions);
  const result = findDuplicateTransactions(index, [entry({ id: 'candidate', note: '午饭', occurredAt: '2026-10-14T12:00:00Z' })]);
  assert.equal(result.length, 1);
  assert.equal(result[0].matches[0].transaction.id, 'old');
  assert.equal(result[0].matches[0].kind, 'similar_history');
  assert.equal(findDuplicateTransactions(index, [entry({ id: 'candidate', type: 'income' })]).length, 0);
  assert.equal(findDuplicateTransactions(index, [entry()]).length, 0);
  assert.equal(findDuplicateTransactions(buildTransactionHistoryIndex([entry({ deletedAt: '2026-10-14' })]), [entry({ id: 'candidate' })]).length, 0);
});

test('amount index keeps cent-level tolerance boundaries and finds duplicates inside a draft batch', () => {
  const candidate = entry({ id: 'candidate', amount: 2000 });
  assert.equal(findDuplicateTransactions(buildTransactionHistoryIndex([entry({ amount: 2105 })]), [candidate]).length, 1);
  assert.equal(findDuplicateTransactions(buildTransactionHistoryIndex([entry({ amount: 2106 })]), [candidate]).length, 0);
  const batch = findDuplicateTransactions(buildTransactionHistoryIndex([]), [candidate, { ...candidate, id: 'second', note: '午饭' }]);
  assert.equal(batch[0].matches[0].draftMatch, true);
  assert.equal(batch[0].matches[0].kind, 'possible_duplicate');
  const unnamed = entry({ note: '' });
  assert.equal(findDuplicateTransactions(buildTransactionHistoryIndex([unnamed]), [{ ...unnamed, id: 'new' }]).length, 1);
  assert.equal(findDuplicateTransactions(buildTransactionHistoryIndex([unnamed]), [{ ...unnamed, id: 'new', accountId: 'other' }]).length, 1);
});

test('duplicate review caps same-day batch scans for 5000 imported rows', () => {
  const batch = Array.from({ length: 5000 }, (_, index) => entry({ id: `import-${index}`, amount: 1234,
    note: `row-${index}`, occurredAt: '2026-10-01T12:00:00Z', statementEntries: [] }));
  const matches = findDuplicateTransactions(buildTransactionHistoryIndex([]), batch, 3);
  assert.equal(matches.length, 4999);
  assert.equal(matches.at(-1).matches.length, 3);
});

test('date, amount and type find sparse records across accounts without requiring notes or channels', () => {
  const old = entry({ occurredAt: '2026-10-15T12:00:00Z' });
  const index = buildTransactionHistoryIndex([old]);
  const sparse = entry({ id: 'new', note: '', accountId: '', categoryId: '', occurredAt: '2026-10-15T16:00:00Z' });
  assert.equal(findDuplicateTransactions(index, [sparse])[0].matches[0].kind, 'possible_duplicate');
  assert.equal(findDuplicateTransactions(index, [{ ...sparse, occurredAt: '2026-10-18T12:00:00Z' }]).length, 1);
  assert.equal(findDuplicateTransactions(index, [{ ...sparse, occurredAt: '2026-10-19T12:00:00Z' }]).length, 0);
  assert.equal(findDuplicateTransactions(index, [{ ...sparse, amount: 2801 }]).length, 0);
  assert.equal(findDuplicateTransactions(index, [{ ...sparse, type: 'income' }]).length, 0);
  const crossAccount = findDuplicateTransactions(index, [{ ...sparse, accountId: 'salary-card' }]);
  assert.equal(crossAccount[0].matches[0].accountConflict, true);
});

test('source transaction IDs match all dates, stay scoped, and expose conflicting amounts', () => {
  const old = entry({ note: '' });
  old.statementEntries = [statementEntry(old, { source: '微信账单', accountId: 'wechat', externalId: 'WX-123' })];
  const candidate = entry({ id: 'new', note: '', occurredAt: '2026-10-15T12:00:00Z' });
  candidate.statementEntries = [statementEntry(candidate, { source: '微信流水', accountId: 'wechat', externalId: 'WX-123' })];
  const index = buildTransactionHistoryIndex([old]);
  assert.equal(findDuplicateTransactions(index, [candidate])[0].matches[0].sameStatement, true);
  assert.equal(findDuplicateTransactions(index, [{ ...candidate, amount: 9999 }])[0].matches[0].difference, 7199);
  for (const changes of [{ source: '支付宝账单' }, { accountId: 'another-wallet' }]) {
    const other = { ...candidate, statementEntries: [{ ...candidate.statementEntries[0], ...changes }] };
    assert.equal(findDuplicateTransactions(index, [other]).length, 0);
  }
  assert.equal(searchTransactionHistory(index, { keyword: 'WX-123' }).count, 1);
});

test('transfer legs can attach as evidence while transfers stay outside income and expense totals', () => {
  const transfer = entry({ type: 'transfer', categoryId: 'transfer', amount: 20000, note: '银行卡向微信零钱充值', accountId: 'salary-card', toAccountId: 'wechat' });
  const leg = entry({ id: 'incoming', type: 'income', amount: 20000, note: '充值到账' });
  const index = buildTransactionHistoryIndex([transfer]);
  assert.equal(findDuplicateTransactions(index, [leg])[0].matches[0].transferLeg, true);
  assert.equal(findDuplicateTransactions(index, [{ ...leg, type: 'expense', note: '购物' }]).length, 0);
  assert.equal(findDuplicateTransactions(index, [{ ...leg, note: '', accountId: '' }])[0].matches[0].transferLeg, true);
  const attached = associateTransaction(transfer, leg);
  assert.equal(attached.type, 'transfer');
  assert.equal(attached.id, transfer.id);
  assert.equal(attached.statementEntries.length, 2);
  const result = searchTransactionHistory(buildTransactionHistoryIndex([attached]));
  assert.equal(result.incomeAmount, 0); assert.equal(result.expenseAmount, 0); assert.equal(result.transferAmount, 20000);
  assert.throws(() => associateTransaction(transfer, leg, true), /不能覆盖内部转账/);
  assert.throws(() => associateTransaction(leg, transfer), /修正为内部转账/);
  assert.equal(associateTransaction(leg, transfer, true).type, 'transfer');
});

test('linking preserves the original transaction and source descriptions; correction changes only confirmed account routing', () => {
  const old = entry({ note: '银行卡流水里的午餐', items: [{ preserved: true }] });
  const incoming = entry({ id: 'new', accountId: 'salary-card', paymentChannel: '微信', note: '微信账单里的午餐', updatedAt: '2026-10-15' });
  const linked = associateTransaction(old, incoming);
  assert.equal(linked.id, old.id); assert.equal(linked.accountId, 'wechat');
  assert.equal(linked.paymentChannel, '微信');
  assert.deepEqual(linked.items, old.items);
  assert.deepEqual(linked.statementEntries.map((item) => item.note), [old.note, incoming.note]);
  assert.equal(old.statementEntries, undefined);
  const corrected = associateTransaction(old, incoming, true);
  assert.equal(corrected.accountId, 'salary-card');
  assert.equal(corrected.note, old.note); assert.equal(corrected.occurredAt, old.occurredAt);
  assert.equal(corrected.statementEntries.find((item) => item.source === '修正前记录').accountId, 'wechat');
  assert.throws(() => associateTransaction(old, { ...incoming, amount: 1 }), /金额不同/);
  assert.throws(() => associateTransaction(old, { ...incoming, accountId: '' }, true), /确认实际账户/);
  const identified = { ...incoming, statementEntries: [statementEntry(incoming, { source: '微信账单', externalId: 'WX-1' })] };
  assert.equal(associateTransaction(associateTransaction(old, identified), identified).statementEntries.length, 2);
});

test('funding accounts differ from payment channels and owned transfers differ from merchant payments', () => {
  const available = [...accounts, { id: 'alipay', name: '支付宝', type: 'payment' }];
  assert.deepEqual(parseTransactionRouting('微信支付午餐30元，银行卡扣款', available), { type: 'expense', accountId: 'salary-card', toAccountId: '', paymentChannel: '微信' });
  assert.equal(parseTransactionRouting('微信零钱支付午餐30元', available).accountId, 'wechat');
  assert.equal(parseTransactionRouting('支付宝支付30元', available).accountId, '');
  assert.equal(parseTransactionRouting('支出30元', available).accountId, '');
  assert.equal(parseTransactionRouting('收到微信扣款通知，银行卡支出30元', available).type, 'expense');
  for (const input of ['银行卡给微信零钱充值200元', '微信零钱充值200元，从银行卡扣款']) {
    const routing = parseTransactionRouting(input, available);
    assert.equal(routing.type, 'transfer'); assert.equal(routing.accountId, 'salary-card'); assert.equal(routing.toAccountId, 'wechat');
  }
  const withdrawal = parseTransactionRouting('微信零钱提现到银行卡200元', available);
  assert.equal(withdrawal.type, 'transfer'); assert.equal(withdrawal.accountId, 'wechat'); assert.equal(withdrawal.toAccountId, 'salary-card');
  for (const input of ['微信给商家转账30元，银行卡扣款', '银行卡充值话费50元', '微信给朋友转账30元', '微信给张三转账30元，银行卡扣款', '微信给张三充值200元，银行卡扣款']) assert.equal(parseTransactionRouting(input, available).type, 'expense');
  const pendingTopup = parseTransactionRouting('微信零钱充值到账200元', available);
  assert.equal(pendingTopup.type, 'transfer'); assert.equal(pendingTopup.accountId, ''); assert.equal(pendingTopup.toAccountId, 'wechat');
  assert.equal(parseTransactionRouting('微信转账退回160元', available).type, 'income');
  const twoBanks = [...available, { id: 'second-bank', name: '另一张卡', type: 'bank' }];
  assert.equal(parseTransactionRouting('微信支付，银行卡扣款30元', twoBanks).accountId, '');
});

test('draft preprocessing masks order numbers, retains original evidence and leaves unknown funding accounts pending', () => {
  const context = { today: '2026-10-15', availableAccounts: accounts, availableCategories: categories };
  const input = '今天微信账单支出30元，交易单号202610150000001，银行卡扣款';
  const candidates = extractTransactionCandidates(input, context);
  assert.deepEqual(candidates.map((candidate) => candidate.amountYuan), [30]);
  assert.equal(candidates[0].accountHint, '工资卡'); assert.equal(candidates[0].sourceText, input);
  assert.ok(!maskStatementReferences(input).includes('202610150000001'));
  const payload = { kind: 'transaction_draft', reply: '核对', drafts: [{ type: 'expense', amountYuan: 30, category: '餐饮', account: '微信', occurredAt: '2026-10-15', note: '午餐' }] };
  const normalized = normalizeAgentResponse(payload, { candidates });
  assert.equal(normalized.drafts[0].account, '工资卡');
  const pending = normalizeAgentResponse(payload, { candidates: extractTransactionCandidates('今天微信支付30元', context) });
  assert.equal(pending.drafts[0].account, ''); assert.equal(pending.drafts[0].paymentChannel, '微信');
  assert.equal(statementHints('微信账单交易单号WX-1，另一笔交易单号WX-2').externalId, '');
});

test('same-amount model drafts bind to their source candidate IDs instead of response order', () => {
  const context = { today: '2026-10-15', availableAccounts: accounts, availableCategories: categories };
  const candidates = extractTransactionCandidates('10月14日，微信零钱午餐30元；10月15日，银行卡扣款30元', context);
  const draft = { type: 'expense', amountYuan: 30, category: '餐饮', account: '', toAccount: '', occurredAt: '2026-10-15', note: '午餐' };
  const payload = { kind: 'transaction_draft', reply: '核对', drafts: [{ ...draft, candidateId: candidates[1].candidateId }, { ...draft, candidateId: candidates[0].candidateId }] };
  const normalized = normalizeAgentResponse(payload, { candidates });
  assert.deepEqual(normalized.drafts.map((item) => item.account), ['工资卡', '微信']);
  assert.deepEqual(normalized.drafts.map((item) => item.sourceText), [candidates[1].sourceText, candidates[0].sourceText]);
  assert.throws(() => normalizeAgentResponse({ ...payload, drafts: [draft, draft] }, { candidates }), /candidateId/);
  assert.equal(validateTransactionDrafts({ drafts: [draft, draft] }, { candidates, ledgerContext: context }).valid, false);
});

test('backup retains legacy shapes and validates new source fields, references and shared transaction IDs', () => {
  const old = entry();
  const backup = { version: 2, transactions: [old], accounts, categories };
  assert.equal(Object.hasOwn(normalizeBackup(backup).transactions[0], 'statementEntries'), false);
  const detailed = { ...old, paymentChannel: '微信', statementEntries: [statementEntry(old, { source: '微信账单', externalId: 'WX-001' })] };
  const normalized = normalizeBackup({ ...backup, transactions: [detailed] }).transactions[0];
  assert.equal(normalized.statementEntries[0].externalId, 'WX-001');
  assert.throws(() => normalizeTransactionDetails({ paymentChannel: '无效渠道' }), /渠道/);
  assert.throws(() => normalizeTransactionDetails({ statementEntries: [{ ...detailed.statementEntries[0], postedAt: 'not a date' }] }), /日期/);
  assert.throws(() => normalizeBackup({ ...backup, transactions: [{ ...detailed, statementEntries: [{ ...detailed.statementEntries[0], accountId: 'missing' }] }] }), /来源账户/);
  assert.throws(() => normalizeBackup({ ...backup, transactions: [detailed, { ...detailed, id: 'second' }] }), /交易单号/);
  assert.notEqual(statementIdentity(detailed.statementEntries[0]), statementIdentity({ ...detailed.statementEntries[0], accountId: 'salary-card' }));
});

test('history query totals include every match while pages are bounded and edits/deletes change results', () => {
  const transactions = Array.from({ length: 61 }, (_, i) => entry({ id: String(i) }));
  const index = buildTransactionHistoryIndex(transactions, { categories, accounts });
  const result = searchTransactionHistory(index, { keyword: '午饭 微信', limit: 20 });
  assert.equal(result.count, 61);
  assert.equal(result.expenseAmount, 61 * 2800);
  assert.equal(result.transactions.length, 20);
  assert.equal(result.hasMore, true);
  assert.equal(searchTransactionHistory(index, { keyword: '28元', limit: 50, offset: 50 }).transactions.length, 11);
  assert.equal(searchTransactionHistory(index, { categoryId: 'all' }).count, index.entries.length);
  assert.equal(searchTransactionHistory(index, { startDate: '2026-01-01' }).count, 0);
  assert.equal(searchTransactionHistory(index, { keyword: '2020-01' }).count, 61);
  const updated = buildTransactionHistoryIndex(transactions.map((item, i) => i === 0 ? { ...item, note: '咖啡' } : { ...item, deletedAt: '2026-10-14' }), { categories, accounts });
  assert.equal(searchTransactionHistory(updated, { keyword: '午饭' }).count, 0);
  assert.equal(searchTransactionHistory(updated, { keyword: '咖啡' }).count, 1);
  assert.throws(() => searchTransactionHistory(index, { startDate: '2025-02-31' }), /日期无效/);
  assert.throws(() => searchTransactionHistory(index, { minAmountYuan: 30, maxAmountYuan: 20 }), /金额范围无效/);
});

test('history query parsing distinguishes month/date numbers from money and account names from categories', () => {
  const options = { today: '2026-10-14T12:00:00Z', categories, accounts };
  const month = parseHistoryQuery('查询2025年8月28元的午饭账单', options);
  assert.equal(month.startDate, '2025-08-01');
  assert.equal(month.endDate, '2025-08-31');
  assert.equal(month.minAmountYuan, 28);
  assert.equal(month.keyword, '午饭');
  const day = parseHistoryQuery('查询2024-02-29午饭账单', options);
  assert.equal(day.startDate, '2024-02-29');
  assert.equal(day.endDate, '2024-02-29');
  const account = parseHistoryQuery('查询工资卡的历史流水', options);
  assert.equal(account.accountId, 'salary-card');
  assert.equal(account.categoryId, undefined);
  assert.equal(account.keyword, '');
  assert.equal(parseHistoryQuery('查询上个月午饭账单', options).startDate, '2026-09-01');
  assert.equal(parseHistoryQuery('今天午饭28元，微信支付', options), null);
  assert.throws(() => parseHistoryQuery('查询2025年2月29日的账单', options), /日期无效/);
});

test('read-only search uses compact history facts, exposes truncation, and query_ledger omits detail arrays', () => {
  const transactions = [entry({ amount: undefined, amountYuan: 28, category: '餐饮', account: '微信', date: '2020-01-01' })];
  const historyQuery = { fullHistory: true, count: 61, totalCount: 100, hasMore: true, query: { keyword: '午饭' }, transactions };
  const result = executeAgentTool('search_transactions', { keyword: '午餐', type: 'expense', startDate: '2020-01-01', endDate: '2020-01-31', minAmountYuan: 28, maxAmountYuan: 28, limit: 5 }, { ledgerContext: { historyQuery } });
  assert.equal(result.transactions[0].id, 'old');
  assert.equal(result.transactions[0].amountYuan, 28);
  assert.equal(result.sourceMatchCount, 61);
  assert.equal(result.countIsPartial, true);
  assert.equal(result.fullHistory, true);
  const facts = executeAgentTool('query_ledger', {}, { ledgerContext: { historyQuery, recentTransactions: transactions, analysisTransactions: transactions, currentMonth: { count: 1 } } });
  assert.equal(facts.ledgerContext.currentMonth.count, 1);
  assert.equal('transactions' in facts.ledgerContext.historyQuery, false);
  assert.equal('recentTransactions' in facts.ledgerContext, false);
});

test('historical updates stay inside disclosed query IDs including an empty candidate scope', () => {
  const update = { kind: 'transaction_update', reply: '核对修改', update: { transactionId: 'old', changes: { amountYuan: 29 } } };
  assert.equal(normalizeAgentResponse(JSON.stringify(update), { ledgerContext: { recentTransactions: [], historyQuery: { transactions: [{ id: 'old' }] } } }).update.transactionId, 'old');
  assert.throws(() => normalizeAgentResponse(JSON.stringify(update), { ledgerContext: { recentTransactions: [] } }), /流水范围/);
});

test('ordinary entry model prompts omit unrelated previous bills', async () => {
  const agent = await createLedgerAgent({ root: fileURLToPath(new URL('..', import.meta.url)), complete: async (_config, messages) => {
    assert.ok(!messages[0].content.includes('PRIVATE_OLD_ENTRY'));
    return { message: { role: 'assistant', content: JSON.stringify({ kind: 'transaction_draft', reply: '核对', drafts: [{ type: 'expense', amountYuan: 28, category: '餐饮', account: '微信', toAccount: '', occurredAt: '2026-10-14T12:00:00Z', note: '午餐', tags: [] }] }) } };
  } });
  const result = await agent.run({ messages: [{ role: 'user', content: '今天午餐28元，微信支付' }], ledgerContext: { today: '2026-10-14', availableCategories: categories, availableAccounts: accounts, recentTransactions: [{ note: 'PRIVATE_OLD_ENTRY' }] } });
  assert.equal(JSON.parse(result.reply).kind, 'transaction_draft');
});
