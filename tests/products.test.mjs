import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRODUCT_CATEGORIES, normalizeProductItems, prepareProductTransactions, unitPrice, compareProductPrices, formatPriceComparison, parseProductQuote, parseProductEntry, isProductQuery } from '../product-prices.mjs';
import { normalizeBackup } from '../product-backup.mjs';
import { extractTransactionCandidates, executeAgentTool } from '../agent/tools.mjs';
import { createLedgerAgent } from '../agent/agent.mjs';
import { normalizeAgentResponse } from '../agent/schemas.mjs';
const raw = { nameSnapshot: '测试酒', categoryName: '酒水', quantity: 1, unitSize: 1000, unit: 'ml', paidAmount: 10500, priceBasis: 'actual' };
const tx = (id, item = raw, date = '2020-01-01T12:00:00.000Z') => ({ id, type: 'expense', amount: item.paidAmount, occurredAt: date, accountId: 'a', categoryId: 'c', items: [item] });
const catalog = () => prepareProductTransactions([tx('old')], [], DEFAULT_PRODUCT_CATEGORIES);

test('sample price uses total quantity and keeps precision until display', () => {
  const data = catalog();
  const result = compareProductPrices(data, { query: '测试酒划算吗', quote: { ...raw, quantity: 2, unitSize: 980, paidAmount: 14200 } });
  assert.equal(result.groups[0].quote.totalSize, 1960);
  assert.ok(Math.abs(result.groups[0].percentChange + 31.0009718) < 0.0001);
  assert.ok(Math.abs(result.groups[0].savingsYuan - 63.8) < 1e-8);
  assert.match(formatPriceComparison(result), /7.24 元\/100 ml/);
  assert.match(formatPriceComparison(result), /63.80/);
});
test('volume, weight and count normalize without mixing dimensions', () => {
  assert.equal(unitPrice({ ...raw, unit: 'L', unitSize: 1 }).totalSize, 1000);
  assert.equal(unitPrice({ ...raw, unit: '斤', unitSize: 2 }).totalSize, 1000);
  assert.equal(unitPrice({ ...raw, unit: '片', unitSize: 20 }).displayUnit, '片');
  const result = compareProductPrices(catalog(), { query: '测试酒', quote: { ...raw, unit: 'g' } });
  assert.equal(result.groups[0].comparable, false);
});
test('invalid, over-budget and non-expense items are rejected', () => {
  for (const item of [{ ...raw, quantity: 0 }, { ...raw, unitSize: NaN }, { ...raw, quantity: 1.5 }, { ...raw, paidAmount: 1.5 }, { ...raw, unit: '片', unitSize: 0.5 }]) assert.throws(() => normalizeProductItems([item]));
  assert.throws(() => normalizeProductItems([raw], { amount: 100 }));
  assert.throws(() => normalizeProductItems([raw], { type: 'income' }));
  assert.equal(normalizeProductItems([raw], { amount: 20000 }).length, 1);
});
test('catalog reuses same identity across sizes and separates variants', () => {
  const data = prepareProductTransactions([tx('1'), tx('2', { ...raw, unitSize: 980 }), tx('3', { ...raw, variant: '特别版' })], [], DEFAULT_PRODUCT_CATEGORIES);
  assert.equal(data.products.length, 2);
  assert.equal(data.transactions[0].items[0].productId, data.transactions[1].items[0].productId);
  assert.equal(compareProductPrices(data, { query: '测试酒' }).status, 'ambiguous');
  assert.equal(compareProductPrices(data, { query: '酒水所有商品单价' }).groups.length, 2);
});
test('old records are included and edits/deletions change baselines', () => {
  const data = catalog();
  data.transactions.push(...Array.from({ length: 40 }, (_, i) => ({ id: 'unrelated'+i, type: 'expense', amount: 100, occurredAt: '2026-09-01', items: [] })));
  const result = compareProductPrices(data, { query: '测试酒' });
  assert.equal(result.groups[0].lowest.transactionId, 'old');
  data.transactions[0].items[0].paidAmount = 9000;
  assert.equal(compareProductPrices(data, { query: '测试酒' }).groups[0].lowest.displayPrice, 9);
  data.transactions.shift();
  assert.equal(compareProductPrices(data, { query: '测试酒' }).status, 'not_found');
});
test('unallocated discounts do not become a false historical low', () => {
  const data = prepareProductTransactions([tx('actual'), tx('unallocated', { ...raw, paidAmount: 5000, priceBasis: 'unallocated' }, '2026-01-01')], [], DEFAULT_PRODUCT_CATEGORIES);
  const group = compareProductPrices(data, { query: '测试酒' }).groups[0];
  assert.equal(group.sampleCount, 2);
  assert.equal(group.actualCount, 1);
  assert.equal(group.lowest.transactionId, 'actual');
});
test('quantity ambiguity is clarified and specification numbers are not money', () => {
  assert.ok(parseProductQuote('两瓶980ml需要142元').error);
  assert.equal(parseProductQuote('每瓶980ml，2瓶共142元').quantity, 2);
  assert.equal(parseProductQuote('两瓶总容量1960ml共142元').quantity, 1);
  assert.ok(parseProductQuote('之前1000ml105元，现在980ml142元').error);
  assert.deepEqual(extractTransactionCandidates('今天买测试酒，每瓶980ml，2瓶共142元').map((item) => item.amountYuan), [142]);
  assert.equal(parseProductEntry('今天买了测试酒，每瓶980ml，2瓶共142元').item.nameSnapshot, '测试酒');
  assert.ok(isProductQuery('之前买的测试酒现在142元划算吗'));
});
test('v3 backup roundtrip and v2 import; reject broken references before writes', () => {
  const data = { version: 3, ...catalog(), accounts: [{ id: 'a' }], categories: [{ id: 'c' }] };
  assert.deepEqual(normalizeBackup(JSON.parse(JSON.stringify(data))).transactions, data.transactions);
  const old = normalizeBackup({ version: 2, transactions: [{ ...tx('legacy'), items: undefined }], accounts: [{ id: 'a' }], categories: [{ id: 'c' }] });
  assert.deepEqual(old.products, []);
  assert.deepEqual(old.transactions[0].items, []);
  assert.throws(() => normalizeBackup({ ...data, products: [] }));
  assert.throws(() => normalizeBackup({ ...data, accounts: [] }));
  assert.throws(() => normalizeBackup({ ...data, version: 99 }));
});
test('Agent schema preserves product details and validates line total', () => {
  const draft = { type: 'expense', amountYuan: 105, category: '日用', account: '微信', occurredAt: '2026-09-07', note: '测试酒', items: [raw] };
  const result = normalizeAgentResponse({ kind: 'transaction_draft', reply: '请审核', drafts: [draft] });
  assert.equal(result.drafts[0].items[0].unitSize, 1000);
  assert.throws(() => normalizeAgentResponse({ kind: 'transaction_draft', reply: '请审核', drafts: [{ ...draft, amountYuan: 10 }] }));
});
test('Agent invokes comparison tool and cannot turn a quote into an expense', async () => {
  const comparison = compareProductPrices(catalog(), { query: '测试酒' });
  let calls=0;
  const agent = await createLedgerAgent({ root: process.cwd(), complete: async (_config, messages, options) => {
    calls++;
    if (calls === 1) {
      assert.equal(options.toolChoice.function.name, 'compare_product_prices');
      return { message: { role: 'assistant', tool_calls: [{ id: 'price', type: 'function', function: { name: 'compare_product_prices', arguments: '{}' } }] } };
    }
    assert.equal(JSON.parse(messages.at(-1).content).groups[0].latest.transactionId, 'old');
    return { message: { content: JSON.stringify({ kind: 'transaction_draft', reply: '错误的记账建议', drafts: [] }) } };
  } });
  const result=await agent.run({ messages: [{ role: 'user', content: '之前买的测试酒现在142元划算吗' }], ledgerContext: { productContext: comparison } });
  assert.equal(JSON.parse(result.reply).kind, 'answer');
  assert.equal(calls,2);
  assert.equal(executeAgentTool('compare_product_prices', {}, { ledgerContext: { productContext: comparison } }), comparison);
});

test('explicit per-item descriptions stay entries; incomplete or nested offers clarify', () => {
  assert.equal(isProductQuery('今天买了鸡蛋，每个50g，两盒共20元'), false);
  assert.equal(isProductQuery('测试酒每ml多少钱'), true);
  assert.ok(parseProductQuote('2箱每箱6瓶，每瓶980ml共142元').error);
  assert.equal(compareProductPrices(catalog(), { query: '测试酒现在142元划算吗' }).status, 'clarify');
  assert.throws(() => normalizeProductItems([{ ...raw, paidAmount: undefined, paidAmountYuan: 1.234 }]));
});

test('deterministic product specifications survive an incomplete model draft', async () => {
  const agent=await createLedgerAgent({ root:process.cwd(),complete:async()=>({message:{content:JSON.stringify({kind:'transaction_draft',reply:'请审核',drafts:[{type:'expense',amountYuan:142,category:'日用',account:'微信',occurredAt:'2026-09-07',note:'测试酒'}]})}}) });
  const result=JSON.parse((await agent.run({messages:[{role:'user',content:'今天买了测试酒，每瓶980ml，2瓶共142元'}],ledgerContext:{today:'2026-09-07'}})).reply);
  assert.equal(result.drafts[0].items[0].quantity,2);
  assert.equal(result.drafts[0].items[0].unitSize,980);
  assert.equal(result.drafts[0].items[0].paidAmount,14200);
});

test('offer amounts preserve thousands and reject excessive decimals', () => {
  assert.equal(parseProductQuote('每瓶980ml，2瓶共1,234.56元').paidAmount,123456);
  assert.ok(parseProductQuote('每瓶980ml，2瓶共105.123元').error);
  assert.ok(parseProductQuote('每瓶980ml，2瓶共-142元').error);
});

test('latest price sorts actual instants across timezone offsets', () => {
  const data=prepareProductTransactions([tx('later',raw,'2026-01-01T20:00:00Z'),tx('earlier',{...raw,paidAmount:9000},'2026-01-02T00:00:00+08:00')],[],DEFAULT_PRODUCT_CATEGORIES);
  assert.equal(compareProductPrices(data,{query:'测试酒'}).groups[0].latest.transactionId,'later');
});
