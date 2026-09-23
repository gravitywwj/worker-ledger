import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { createLedgerAgent } from './agent.mjs';
import { executeAgentTool, extractTransactionCandidates, validateTransactionDrafts } from './tools.mjs';
import { normalizeAgentResponse } from './schemas.mjs';
import { buildPeriodicReviewFacts, normalizePeriodicReviewPayload } from './periodic-review.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const categories = [
  { id: 'food', label: '餐饮', type: 'expense' }, { id: 'commute', label: '交通', type: 'expense' },
  { id: 'housing', label: '居住', type: 'expense' }, { id: 'daily', label: '日用', type: 'expense' },
  { id: 'shopping', label: '购物', type: 'expense' }, { id: 'fun', label: '娱乐', type: 'expense' },
  { id: 'subscription', label: '订阅服务', type: 'expense' }, { id: 'health', label: '健康', type: 'expense' },
  { id: 'learn', label: '学习', type: 'expense' }, { id: 'social', label: '人情', type: 'expense' },
  { id: 'travel', label: '旅行', type: 'expense' }, { id: 'other', label: '其他', type: 'expense' },
  { id: 'salary', label: '工资', type: 'income' }, { id: 'bonus', label: '奖金', type: 'income' },
  { id: 'reimburse', label: '报销退款', type: 'income' }, { id: 'other-income', label: '其他收入', type: 'income' },
];
const accounts = [{ id: 'salary-card', name: '工资卡' }, { id: 'alipay', name: '支付宝' }, { id: 'wechat', name: '微信' }];
const context = { today: '2026-08-27', availableCategories: categories, availableAccounts: accounts };

test('extracts all amounts from a multi-day natural language entry', () => {
  const input = '8月17，抖音购物79.51元；抖音退款39.6元；微信转账退回160元；盒马购物76.27元；8月18日：盒马购物130.08元和55.29元；盒马退款0.14，0.05，0.56，0.47，0.38，0.16，0.02。燃气费99元充值；236.2元淘宝购物；22.82淘宝退款；';
  const candidates = extractTransactionCandidates(input, context);
  assert.equal(candidates.length, 16);
  assert.deepEqual(candidates.map((item) => item.amountYuan), [79.51, 39.6, 160, 76.27, 130.08, 55.29, 0.14, 0.05, 0.56, 0.47, 0.38, 0.16, 0.02, 99, 236.2, 22.82]);
  assert.equal(candidates.filter((item) => item.typeHint === 'income').length, 10);
  assert.equal(candidates.find((item) => item.amountYuan === 76.27).categoryCandidates[0].id, 'daily');
  assert.equal(candidates.find((item) => item.amountYuan === 236.2).categoryCandidates[0].id, 'shopping');
  assert.deepEqual([...new Set(candidates.map((item) => item.date))], ['2026-08-17', '2026-08-18']);
});

test('handles colloquial, thousands, Chinese and date-like amounts', () => {
  assert.deepEqual(extractTransactionCandidates('今天午餐28块8', context).map((item) => item.amountYuan), [28.8]);
  assert.deepEqual(extractTransactionCandidates('京东支付¥1,234.56', context).map((item) => item.amountYuan), [1234.56]);
  assert.deepEqual(extractTransactionCandidates('收到退款一百二十三元', context).map((item) => item.amountYuan), [123]);
  assert.deepEqual(extractTransactionCandidates('8.13支出：外卖31.8；22.82淘宝退款', context).map((item) => item.amountYuan), [31.8, 22.82]);
});

test('rejects incomplete drafts and accepts a complete validated draft set', () => {
  const input = '8月17，抖音购物79.51元；抖音退款39.6元；';
  const candidates = extractTransactionCandidates(input, context);
  const drafts = [
    { type: 'expense', amountYuan: 79.51, category: '购物', account: '微信', toAccount: '', occurredAt: '2026-08-17T12:00:00.000Z', note: '抖音购物', tags: [] },
    { type: 'income', amountYuan: 39.6, category: '报销退款', account: '微信', toAccount: '', occurredAt: '2026-08-17T12:00:00.000Z', note: '抖音退款', tags: [] },
  ];
  const valid = validateTransactionDrafts({ drafts }, { candidates, ledgerContext: context });
  assert.equal(valid.valid, true);
  assert.equal(validateTransactionDrafts({ drafts: drafts.slice(0, 1) }, { candidates, ledgerContext: context }).valid, false);
});

test('runs a bounded validate-tool ReAct loop before final JSON', async () => {
  const drafts = [
    { type: 'expense', amountYuan: 79.51, category: '购物', account: '微信', toAccount: '', occurredAt: '2026-08-17T12:00:00.000Z', note: '抖音购物', tags: [] },
    { type: 'income', amountYuan: 39.6, category: '报销退款', account: '微信', toAccount: '', occurredAt: '2026-08-17T12:00:00.000Z', note: '抖音退款', tags: [] },
  ];
  let calls = 0;
  const complete = async (_config, messages, options = {}) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(options.toolChoice.function.name, 'validate_transaction_drafts');
      return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'validate-1', type: 'function', function: { name: 'validate_transaction_drafts', arguments: JSON.stringify({ drafts }) } }] } };
    }
    assert.equal(messages.at(-1).role, 'tool');
    assert.equal(JSON.parse(messages.at(-1).content).valid, true);
    assert.equal(options.tools, undefined);
    return { message: { role: 'assistant', content: JSON.stringify({ kind: 'transaction_draft', reply: '已核验。', drafts }) } };
  };
  const agent = await createLedgerAgent({ root, complete });
  const result = await agent.run({
    config: { baseUrl: 'http://fake.local', model: 'fake' },
    messages: [{ role: 'user', content: '8月17，抖音购物79.51元；抖音退款39.6元；' }],
    ledgerContext: context,
  });
  assert.equal(calls, 2);
  assert.equal(result.candidateCount, 2);
  assert.equal(result.toolRounds, 1);
});

test('enforces the final JSON contract and amount coverage', () => {
  const complete = {
    kind: 'transaction_draft',
    reply: '请审核。',
    drafts: [{ type: 'expense', amountYuan: 28.8, category: '餐饮', account: '微信', toAccount: '', occurredAt: '2026-08-27T12:00:00.000Z', note: '午餐', tags: [] }],
  };
  const result = normalizeAgentResponse(JSON.stringify(complete), { candidates: [{ amountYuan: 28.8 }] });
  assert.equal(result.drafts[0].amountYuan, 28.8);
  assert.throws(() => normalizeAgentResponse(JSON.stringify({ ...complete, drafts: [] }), { candidates: [{ amountYuan: 28.8 }] }), /没有返回记账草稿/);
  assert.throws(() => normalizeAgentResponse(JSON.stringify({ ...complete, drafts: [{ ...complete.drafts[0], amountYuan: 8.13 }] }), { candidates: [{ amountYuan: 28.8 }] }), /没有完整覆盖/);
});

test('habit tool excludes transfers and returns only aggregate facts', () => {
  const result = executeAgentTool('analyze_spending_habits', { months: 3 }, { ledgerContext: { recentTransactions: [
    { occurredAt: new Date().toISOString(), type: 'expense', amountYuan: 28.8, category: '餐饮', account: '微信', note: '外卖', tags: [] },
    { occurredAt: new Date().toISOString(), type: 'expense', amountYuan: 50, category: '日用', account: '支付宝', note: '盒马', tags: [] },
    { occurredAt: new Date().toISOString(), type: 'transfer', amountYuan: 1000, category: '转账', account: '微信', note: '转入银行卡', tags: [] },
  ] } });
  assert.equal(result.sampleCount, 2);
  assert.equal(result.expenseYuan, 78.8);
  assert.equal(result.topCategories[0].name, '日用');
  assert.ok(!Object.hasOwn(result, 'transactions'));
});
test('strictly validates a transaction update and keeps the target id', () => {
  const update = {
    kind: 'transaction_update',
    reply: '请核对修改前后内容。',
    update: { transactionId: 'tx-1', changes: { occurredAt: '2026-08-10T12:00:00.000Z' } },
  };
  const result = normalizeAgentResponse(JSON.stringify(update), { ledgerContext: { recentTransactions: [{ id: 'tx-1' }] } });
  assert.equal(result.update.transactionId, 'tx-1');
  assert.equal(result.update.changes.occurredAt, '2026-08-10T12:00:00.000Z');
  assert.throws(() => normalizeAgentResponse(JSON.stringify({ ...update, update: { ...update.update, transactionId: 'missing' } }), { ledgerContext: { recentTransactions: [{ id: 'tx-1' }] } }), /近期流水范围/);
});

test('uses a read-only search tool before returning a transaction update', async () => {
  const recentTransactions = [{ id: 'tx-1', occurredAt: '2026-08-17T12:00:00.000Z', type: 'expense', amountYuan: 28.8, category: '餐饮', account: '微信', note: '美团外卖', tags: [] }];
  let calls = 0;
  const complete = async (_config, messages, options = {}) => {
    calls += 1;
    if (calls === 1) {
      assert.ok(Array.isArray(options.tools));
      return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'search-1', type: 'function', function: { name: 'search_transactions', arguments: JSON.stringify({ keyword: '美团外卖', type: 'expense', limit: 5 }) } }] } };
    }
    assert.equal(messages.at(-1).role, 'tool');
    assert.match(messages.at(-1).content, /tx-1/);
    return { message: { role: 'assistant', content: JSON.stringify({ kind: 'transaction_update', reply: '请核对修改前后内容。', update: { transactionId: 'tx-1', changes: { occurredAt: '2026-08-10T12:00:00.000Z' } } }) } };
  };
  const agent = await createLedgerAgent({ root, complete });
  const result = await agent.run({
    config: { baseUrl: 'http://fake.local', model: 'fake' },
    messages: [{ role: 'user', content: '把美团外卖那笔记错的日期改成 8 月 10 日。' }],
    ledgerContext: { ...context, recentTransactions },
  });
  const parsed = JSON.parse(result.reply);
  assert.equal(calls, 2);
  assert.equal(parsed.kind, 'transaction_update');
  assert.equal(parsed.update.transactionId, 'tx-1');
});

test('builds periodic review facts without counting transfers', () => {
  const result = buildPeriodicReviewFacts([
    { occurredAt: '2026-01-10T12:00:00.000Z', type: 'income', amountYuan: 5000 },
    { occurredAt: '2026-01-12T12:00:00.000Z', type: 'expense', amountYuan: 1000, category: '餐饮', note: '外卖' },
    { occurredAt: '2026-02-10T12:00:00.000Z', type: 'income', amountYuan: 5000 },
    { occurredAt: '2026-02-12T12:00:00.000Z', type: 'expense', amountYuan: 1200, category: '餐饮', note: '聚餐' },
    { occurredAt: '2026-02-15T12:00:00.000Z', type: 'transfer', amountYuan: 9000, category: '转账' },
  ]);
  const facts = Object.fromEntries(result.facts.map((fact) => [fact.id, fact.value]));
  assert.equal(result.coverageMonths, 2);
  assert.equal(facts.total_income, 10000);
  assert.equal(facts.total_expense, 2200);
  assert.equal(facts.top_category, '餐饮');
  assert.equal(facts.streak_positive_months, 2);
});

test('validates periodic review placeholders against local facts', () => {
  const facts = [
    { id: 'total_income', value: 5000, label: '累计收入', valueType: 'currency' },
    { id: 'top_category', value: '餐饮', label: '支出最多的分类', valueType: 'text' },
  ];
  const review = normalizePeriodicReviewPayload({
    headline: '这段时间，账本记得挺清楚',
    highlights: [{ fact_id: 'top_category', line: '主要花在{{top_category}}' }],
    closing: '数字都在这儿，怎么花是你的自由',
  }, facts);
  assert.equal(review.highlights[0].fact_id, 'top_category');
  assert.throws(() => normalizePeriodicReviewPayload({
    headline: '这段时间，账本记得挺清楚',
    highlights: [{ fact_id: 'total_income', line: '累计{{missing_fact}}' }],
    closing: '结束',
  }, facts), /不存在的 fact_id/);
});

test('runs the periodic review prompt without query tools and normalizes its response', async () => {
  let optionsSeen;
  const facts = [{ id: 'total_income', value: 5000, label: '累计收入', valueType: 'currency' }];
  const complete = async (_config, messages, options = {}) => {
    optionsSeen = options;
    assert.match(messages[0].content, /阶段\/年度回顾文案技能/);
    assert.match(messages[0].content, /total_income/);
    return { message: { role: 'assistant', content: JSON.stringify({
      headline: '这段时间，账本记得挺清楚',
      highlights: [{ fact_id: 'total_income', line: '累计收入{{total_income}}' }],
      closing: '数字都在这儿，怎么花是你的自由',
    }) } };
  };
  const agent = await createLedgerAgent({ root, complete });
  const result = await agent.run({
    config: { baseUrl: 'http://fake.local', model: 'fake' },
    messages: [{ role: 'user', content: '看看阶段回顾' }],
    ledgerContext: { ...context, periodicReviewFacts: facts },
  });
  const parsed = JSON.parse(result.reply);
  assert.equal(optionsSeen.tools, undefined);
  assert.equal(parsed.kind, 'periodic_review');
  assert.equal(parsed.highlights[0].fact_id, 'total_income');
});
