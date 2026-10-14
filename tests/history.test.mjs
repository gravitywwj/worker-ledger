import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildTransactionHistoryIndex, searchTransactionHistory, findDuplicateTransactions, normalizeTransactionNote, parseHistoryQuery } from '../src/transaction-history.mjs';
import { executeAgentTool } from '../agent/tools.mjs';
import { normalizeAgentResponse } from '../agent/schemas.mjs';
import { createLedgerAgent } from '../agent/agent.mjs';

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
  assert.equal(findDuplicateTransactions(index, [entry({ id: 'candidate', type: 'transfer' })]).length, 0);
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
  assert.equal(findDuplicateTransactions(buildTransactionHistoryIndex([unnamed]), [{ ...unnamed, id: 'new', accountId: 'other' }]).length, 0);
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
