import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeStatementFile, inspectStatementCsv, mapStatementRows, parseStatementCsv } from '../src/statement-import.mjs';
import { dueRecurringBills, firstRecurringDate, nextRecurringDate, normalizeRecurringBill, recurringBillCandidates } from '../src/recurring-bills.mjs';
import { categoryBudgetRows, normalizeCategoryBudgets, previousMonthBudgets } from '../src/category-budgets.mjs';
import { normalizeShoppingItem } from '../src/shopping-list.mjs';
import { buildSpendingChangeFacts } from '../src/transaction-facts.mjs';

test('CSV parser retains quoted commas, doubled quotes, embedded newlines and cents', () => {
  const parsed = parseStatementCsv('\uFEFF交易时间,收/支,金额(元),商品,交易单号,当前状态\r\n2026-10-01 12:00:00,支出,"1,234.56","茶, ""大杯""\n加冰",A-1,交易成功\r\n');
  const statement = inspectStatementCsv(parsed);
  const [row] = mapStatementRows(statement, statement.mapping, { makeId: () => 'row-1', defaultAccountId: 'bank', sourceAccountId: 'alipay', defaultCategoryId: 'daily', categories: [{ id: 'daily', type: 'expense' }] });
  assert.equal(row.transaction.amount, 123456);
  assert.equal(row.transaction.note, '茶, "大杯"\n加冰');
  assert.equal(row.transaction.statementEntries[0].externalId, 'A-1');
  assert.equal(row.transaction.statementEntries[0].accountId, 'alipay');
  assert.equal(row.transaction.accountId, 'bank');
  assert.equal(decodeStatementFile(new TextEncoder().encode('金额,备注\n1,正常')), '金额,备注\n1,正常');
});

test('closed and uncertain rows stay out of the ready-to-book group', () => {
  const statement = inspectStatementCsv(parseStatementCsv('交易时间,收/支,金额,商品,交易单号,当前状态\n2026-10-01,支出,1,关闭订单,X1,交易关闭\n2026-10-02,支出,2,待确认,X2,处理中'));
  const rows = mapStatementRows(statement, statement.mapping, { defaultAccountId: 'bank', defaultCategoryId: 'daily', categories: [{ id: 'daily', type: 'expense' }] });
  assert.equal(rows[0].decision, 'skip');
  assert.match(rows[0].skipReason, /交易关闭/);
  assert.ok(rows[1].errors.includes('交易状态待确认'));
});

test('refunds become income and transfers stay pending until both own accounts are confirmed', () => {
  const statement = inspectStatementCsv(parseStatementCsv('交易时间,收/支,金额,备注,交易单号,交易状态\n2026-10-01,支出,8.50,商品退款,R1,退款成功\n2026-10-02,转账,500,账户转入,T1,交易成功'));
  const rows = mapStatementRows(statement, statement.mapping, { defaultAccountId: 'bank', defaultCategoryId: 'daily', incomeCategoryId: 'reimburse',
    categories: [{ id: 'daily', type: 'expense' }, { id: 'reimburse', type: 'income' }] });
  assert.equal(rows[0].transaction.type, 'income');
  assert.equal(rows[0].transaction.categoryId, 'reimburse');
  assert.equal(rows[1].transaction.type, 'transfer');
  assert.ok(rows[1].errors.includes('转账需确认转出和转入账户'));
});

test('oversized source fields stay visible as row errors instead of aborting the file', () => {
  const statement = inspectStatementCsv(parseStatementCsv(`交易时间,收/支,金额,商品,交易单号,当前状态\n2026-10-01,支出,1,${'备'.repeat(4001)},${'X'.repeat(121)},交易成功`));
  const [row] = mapStatementRows(statement, statement.mapping, { defaultAccountId: 'bank', defaultCategoryId: 'daily', categories: [{ id: 'daily', type: 'expense' }] });
  assert.ok(row.errors.some((error) => error.includes('交易单号超过')));
  assert.ok(row.errors.some((error) => error.includes('原始说明超过')));
  assert.equal(row.transaction.statementEntries, undefined);
});

test('monthly and yearly due dates preserve month end and leap day', () => {
  assert.equal(nextRecurringDate('2026-01-31', 'monthly', 31), '2026-02-28');
  assert.equal(nextRecurringDate('2028-02-29', 'yearly', 29, 2), '2029-02-28');
  assert.equal(nextRecurringDate('2029-02-28', 'yearly', 29, 2), '2030-02-28');
  assert.equal(firstRecurringDate({ cadence: 'monthly', paymentDay: 31, today: new Date(2026, 0, 30, 12) }), '2026-01-31');
  assert.equal(firstRecurringDate({ cadence: 'yearly', paymentDay: 29, paymentMonth: 2, today: new Date(2028, 2, 1, 12) }), '2029-02-28');
});

test('recurring candidates need repeated periods plus close dates and amounts', () => {
  const categories = [{ id: 'home', label: '居住', type: 'expense' }];
  const bill = (id, date, amount, note = '宽带') => ({ id, type: 'expense', categoryId: 'home', amount, accountId: 'bank', note, occurredAt: `${date}T12:00:00Z` });
  const rows = [bill('a', '2026-07-03', 10000), bill('b', '2026-08-04', 10100), bill('c', '2026-09-02', 9900)];
  const [candidate] = recurringBillCandidates(rows, categories);
  assert.deepEqual(candidate.transactionIds, ['a', 'b', 'c']);
  assert.equal(recurringBillCandidates([rows[0], rows[1], bill('c', '2026-10-20', 9900)], categories).length, 0);
  const paused = { id: 'r', name: '宽带', amount: 10000, accountId: 'bank', cadence: 'monthly', paymentDay: 3, nextDueDate: '2026-10-03', status: 'paused' };
  assert.deepEqual(dueRecurringBills([normalizeRecurringBill(paused)], new Date(2026, 9, 16)), []);
});

test('category budgets count expense cents only, copy prior month and validate references', () => {
  const categories = [{ id: 'food', type: 'expense' }, { id: 'salary', type: 'income' }];
  const budgets = normalizeCategoryBudgets([{ id: 'old', month: '2026-09', categoryId: 'food', amount: 5000 }], categories);
  assert.deepEqual(previousMonthBudgets(budgets, '2026-10'), [{ id: '2026-10:food', month: '2026-10', categoryId: 'food', amount: 5000 }]);
  const result = categoryBudgetRows({ month: '2026-10', budgets: [{ id: 'b', month: '2026-10', categoryId: 'food', amount: 1000 }], categories,
    transactions: [
      { id: 'e', type: 'expense', categoryId: 'food', amount: 2500, occurredAt: '2026-10-10T12:00:00Z' },
      { id: 't', type: 'transfer', categoryId: 'transfer', amount: 99999, occurredAt: '2026-10-11T12:00:00Z' },
      { id: 'deleted', type: 'expense', categoryId: 'food', amount: 4000, occurredAt: '2026-10-12T12:00:00Z', deletedAt: '2026-10-13' },
    ] });
  assert.deepEqual([result.totalUsed, result.rows[0].over], [2500, 1500]);
  assert.throws(() => normalizeCategoryBudgets([{ id: 'x', month: '2026-10', categoryId: 'salary', amount: 1 }], categories), /无效/);
});

test('shopping quote validates product references without becoming a transaction', () => {
  const products = [{ id: 'p', name: '茶', productCategoryId: 'drink' }];
  const categories = [{ id: 'drink', dimension: 'volume', baseUnit: 'ml' }];
  const item = normalizeShoppingItem({ id: 's', productId: 'p', quantity: 2, unitSize: 500, unit: 'ml', quoteAmount: 4500 }, products, categories);
  assert.equal(item.quoteAmount, 4500);
  assert.equal(item.nameSnapshot, '茶');
  assert.throws(() => normalizeShoppingItem({ ...item, productId: 'missing' }, products, categories), /无效/);
  assert.throws(() => normalizeShoppingItem({ ...item, unit: 'g' }, products, categories), /不匹配/);
});

test('spending change facts use cents, ignore transfers, and retain source transaction IDs', () => {
  const categories = [{ id: 'food', label: '餐饮' }, { id: 'shop', label: '购物' }];
  const facts = buildSpendingChangeFacts({ month: '2026-10', categories, transactions: [
    { id: 'old-food', type: 'expense', categoryId: 'food', amount: 12000, occurredAt: '2026-09-12T12:00:00Z' },
    { id: 'now-food', type: 'expense', categoryId: 'food', amount: 20000, occurredAt: '2026-10-12T12:00:00Z' },
    { id: 'now-shop', type: 'expense', categoryId: 'shop', amount: 5000, occurredAt: '2026-10-13T12:00:00Z' },
    { id: 'transfer', type: 'transfer', categoryId: 'transfer', amount: 90000, occurredAt: '2026-10-14T12:00:00Z' },
  ] });
  assert.equal(facts.currentAmount, 25000);
  assert.equal(facts.previousAmount, 12000);
  assert.equal(facts.difference, 13000);
  assert.equal(facts.categories[0].category, '餐饮');
  assert.deepEqual(facts.transactionIds.sort(), ['now-food', 'now-shop', 'old-food']);
});
