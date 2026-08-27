import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { createLedgerAgent } from './agent.mjs';
import { extractTransactionCandidates, validateTransactionDrafts } from './tools.mjs';

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
