import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeStatementFile, inspectStatementCsv, mapStatementRows, parseStatementCsv, readStatementFile } from '../src/statement-import.mjs';
import { utils, write } from '../node_modules/xlsx/xlsx.mjs';
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

test('local Excel import finds statement sheets and preserves dates and text order IDs', async () => {
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([['导出说明']]), '说明');
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([
    ['交易时间', '金额(元)', '商品', '交易单号'],
    [new Date(2025, 7, 1, 12, 30), 28.8, '午餐', '0012345678901234567890'],
  ], { dateNF: 'yyyy-mm-dd hh:mm:ss' }), '明细');
  const statement = await readStatementFile(write(workbook, { type: 'array', bookType: 'xlsx' }), 'wechat.xlsx');
  assert.equal(statement.sheetName, '明细');
  const [row] = mapStatementRows(statement);
  assert.equal(row.transaction.amount, 2880);
  assert.equal(new Date(row.transaction.occurredAt).getFullYear(), 2025);
  assert.equal(row.transaction.statementEntries[0].externalId, '0012345678901234567890');
  const csv = await readStatementFile(new TextEncoder().encode('日期,金额\n2025-08-01,28'), 'bank.csv');
  assert.equal(csv.rows.length, 1);
});

test('Excel import rejects ambiguous sheets, unreadable files and unsupported formats', async () => {
  const workbook = utils.book_new();
  for (const name of ['一月', '二月']) utils.book_append_sheet(workbook, utils.aoa_to_sheet([['日期', '金额'], ['2025-01-01', 28]]), name);
  await assert.rejects(readStatementFile(write(workbook, { type: 'array', bookType: 'xlsx' }), 'two.xlsx'), /多个账单工作表/);
  await assert.rejects(readStatementFile(new Uint8Array(), 'bad.xlsx'), /无法读取|未找到/);
  await assert.rejects(readStatementFile(new Uint8Array(), 'archive.zip'), /先解压/);
  await assert.rejects(readStatementFile(new Uint8Array(20 * 1024 * 1024 + 1), 'large.xlsx'), /超过 20 MB/);
});

test('non-spending movements and unknown directions require explicit review', () => {
  const statement = inspectStatementCsv(parseStatementCsv('日期,收/支,金额,备注,交易状态\n2025-08-01,不计收支,300,信用卡还款,支付成功\n2025-08-02,未知,28,未识别交易,支付成功'));
  const rows = mapStatementRows(statement, statement.mapping, { defaultAccountId: 'bank', defaultCategoryId: 'daily', categories: [{ id: 'daily', type: 'expense' }] });
  assert.equal(rows[0].transaction.type, 'transfer');
  assert.ok(rows[0].errors.includes('转账需确认转出和转入账户'));
  assert.ok(rows[1].errors.includes('收支方向待确认'));
  assert.equal(rows[1].decision, 'pending');
});

test('merchant refund rows become refund income while original refunded payments remain expenses', () => {
  const statement = inspectStatementCsv(parseStatementCsv([
    '交易时间,交易类型,收/支,金额,备注,交易单号,交易状态',
    '2026-10-01,商户退款,不计收支,8.50,京东商品,R1,成功',
    '2026-10-01,商户退款,/,5.00,京东商品,R2,成功',
    '2026-10-01,,支出,3.20,商品退款,R3,退款成功',
    '2026-10-01,商户消费,支出,8.50,京东商品,P1,已全额退款',
    '2026-10-01,商户退款,不计收支,8.50,京东商品,R4,退款失败',
    '2026-10-02,转账,转账,500,账户转入,T1,交易成功',
  ].join('\n')));
  const [refund, noDirection, refundNote, payment, failed, transfer] = mapStatementRows(statement, statement.mapping, {
    defaultAccountId: 'bank', defaultCategoryId: 'daily',
    categories: [{ id: 'daily', type: 'expense' }, { id: 'refund', type: 'income' }],
  });
  for (const row of [refund, noDirection]) {
    assert.equal(row.transaction.type, 'income');
    assert.equal(row.transaction.categoryId, 'refund');
    assert.deepEqual(row.errors, []);
  }
  assert.equal(refundNote.transaction.type, 'expense');
  assert.equal(refundNote.transaction.categoryId, 'daily');
  assert.ok(refundNote.errors.includes('收支方向与原始信息冲突，请确认'));
  assert.match(refund.transaction.statementEntries[0].note, /商户退款/);
  assert.equal(payment.transaction.type, 'expense');
  assert.deepEqual(payment.errors, []);
  assert.equal(failed.decision, 'skip');
  assert.equal(transfer.transaction.type, 'transfer');
  assert.ok(transfer.errors.includes('转账需确认转出和转入账户'));
});

test('explicit directions take priority and conflicting source fields require review', () => {
  const statement = inspectStatementCsv(parseStatementCsv([
    '交易时间,收/支,金额(元),商品说明,交易对方,当前状态,交易单号,支付方式,交易类型',
    '2026-11-05,支出,10,退款手续费,模拟平台,支付成功,fee-1,零钱,商户消费',
    '2026-11-05,收入,-20,工资,公司,收款成功,salary-1,银行卡,工资',
    '2026-11-05,支出,25,早餐,餐馆,已部分退款,meal-1,银行卡,商户消费',
    '2026-11-05,转账,30,退款,平台,交易成功,transfer-1,零钱,转账',
    '2026-11-05,收入,40,说明,商家,交易成功,mismatch-1,零钱,商户消费',
  ].join('\n')));
  const options = { defaultAccountId: 'bank', defaultCategoryId: 'daily', categories: [{ id: 'daily', type: 'expense' }, { id: 'other-income', type: 'income' }] };
  const rows = mapStatementRows(statement, statement.mapping, options);
  assert.deepEqual(rows.map((row) => row.transaction.type), ['expense', 'income', 'expense', 'transfer', 'income']);
  assert.ok(rows[0].errors.includes('收支方向与原始信息冲突，请确认'));
  assert.ok(rows[1].errors.includes('收支方向与原始信息冲突，请确认'));
  assert.ok(!rows[2].errors.includes('收支方向与原始信息冲突，请确认'));
  assert.ok(rows[3].errors.includes('收支方向与原始信息冲突，请确认'));
  assert.ok(rows[4].errors.includes('收支方向与原始信息冲突，请确认'));
  assert.match(rows[0].transaction.statementEntries[0].note, /支付方式：零钱/);
  const [third] = mapStatementRows(statement, statement.mapping, { ...options, rowIndices: [2] });
  assert.equal(third.line, 4);
  assert.equal(third.transaction.amount, 2500);
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
