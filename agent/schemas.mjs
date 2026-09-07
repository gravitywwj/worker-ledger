import { normalizeProductItems } from '../product-prices.mjs';
const VALID_KINDS = new Set(['transaction_draft', 'transaction_update', 'answer', 'clarify', 'memory_suggestion']);
const VALID_TYPES = new Set(['expense', 'income', 'transfer']);

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asAmount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : NaN;
}

function extractJsonObject(raw) {
  const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('模型返回格式不完整。');
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error('模型返回的 JSON 无法解析。');
  }
}

function cents(value) {
  return Math.round(Number(value) * 100);
}

function sameAmountMultiset(expected, actual) {
  if (expected.length !== actual.length) return false;
  const count = (values) => values.reduce((result, value) => {
    const key = String(cents(value));
    result.set(key, (result.get(key) || 0) + 1);
    return result;
  }, new Map());
  const left = count(expected);
  const right = count(actual);
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

function normalizeDraft(rawDraft) {
  const draft = rawDraft && typeof rawDraft === 'object' ? rawDraft : {};
  const type = asText(draft.type);
  const amountYuan = asAmount(draft.amountYuan ?? draft.amount);
  const category = asText(draft.category ?? draft.categoryName ?? draft.categoryLabel);
  const account = asText(draft.account ?? draft.accountName ?? draft.accountLabel);
  const toAccount = asText(draft.toAccount ?? draft.toAccountName ?? draft.toAccountLabel);
  const occurredAt = asText(draft.occurredAt);
  const note = asText(draft.note);
  const tags = Array.isArray(draft.tags) ? draft.tags.map(asText).filter(Boolean).slice(0, 8) : [];
  return { type, amountYuan, category, account, toAccount, occurredAt, note, tags, items: normalizeProductItems(draft.items || [], { amount: cents(amountYuan), type }) };
}

function normalizeUpdate(rawUpdate, context = {}) {
  const update = rawUpdate && typeof rawUpdate === 'object' ? rawUpdate : {};
  const transactionId = asText(update.transactionId ?? update.targetId ?? update.id);
  const rawChanges = update.changes && typeof update.changes === 'object' ? update.changes : {};
  const changes = {};
  const amountValue = rawChanges.amountYuan ?? rawChanges.amount;
  if (amountValue !== undefined && amountValue !== null && amountValue !== '') changes.amountYuan = asAmount(amountValue);
  for (const key of ['type', 'category', 'categoryName', 'categoryLabel', 'account', 'accountName', 'accountLabel', 'toAccount', 'toAccountName', 'toAccountLabel', 'occurredAt', 'note']) {
    if (rawChanges[key] !== undefined && rawChanges[key] !== null) changes[key] = asText(rawChanges[key]);
  }
  if (changes.categoryName && !changes.category) changes.category = changes.categoryName;
  if (changes.categoryLabel && !changes.category) changes.category = changes.categoryLabel;
  if (changes.accountName && !changes.account) changes.account = changes.accountName;
  if (changes.accountLabel && !changes.account) changes.account = changes.accountLabel;
  if (changes.toAccountName && !changes.toAccount) changes.toAccount = changes.toAccountName;
  if (changes.toAccountLabel && !changes.toAccount) changes.toAccount = changes.toAccountLabel;
  delete changes.categoryName;
  delete changes.categoryLabel;
  delete changes.accountName;
  delete changes.accountLabel;
  delete changes.toAccountName;
  delete changes.toAccountLabel;
  const errors = [];
  if (!transactionId) errors.push('缺少目标流水 ID。');
  if (!Object.keys(changes).length) errors.push('没有提出任何修改字段。');
  if (Object.hasOwn(changes, 'amountYuan') && !(changes.amountYuan > 0)) errors.push('修改后的金额必须大于 0。');
  if (Object.hasOwn(changes, 'type') && !VALID_TYPES.has(changes.type)) errors.push('修改后的类型无效。');
  if (Object.hasOwn(changes, 'occurredAt') && (!changes.occurredAt || Number.isNaN(new Date(changes.occurredAt).getTime()))) errors.push('修改后的发生时间无效。');
  if (Object.hasOwn(changes, 'category') && !changes.category) errors.push('修改后的分类不能为空。');
  if (Object.hasOwn(changes, 'account') && !changes.account) errors.push('修改后的账户不能为空。');
  if (Object.hasOwn(changes, 'note') && !changes.note) errors.push('修改后的备注不能为空。');
  const transactions = Array.isArray(context.ledgerContext?.recentTransactions) ? context.ledgerContext.recentTransactions : [];
  if (transactionId && transactions.length && !transactions.some((item) => item?.id === transactionId)) errors.push('目标流水不在可修改的近期流水范围内。');
  if (errors.length) throw new Error(`模型修改建议校验失败：${errors.join(' ')}`);
  return { transactionId, changes };
}

export function normalizeAgentResponse(rawReply, context = {}) {
  const parsed = typeof rawReply === 'string' ? extractJsonObject(rawReply) : rawReply;
  if (!parsed || typeof parsed !== 'object' || !VALID_KINDS.has(parsed.kind)) throw new Error('模型返回了未知操作。');
  const reply = asText(parsed.reply);
  if (!reply) throw new Error('模型返回缺少可读说明。');

  if (parsed.kind === 'transaction_update') {
    const update = normalizeUpdate(parsed.update, context);
    return { kind: parsed.kind, reply, update };
  }
  if (parsed.kind !== 'transaction_draft') {
    if (parsed.kind === 'memory_suggestion') {
      const memory = parsed.memory && typeof parsed.memory === 'object' ? parsed.memory : {};
      const key = asText(memory.key);
      const value = asText(memory.value);
      if (!key || !value) throw new Error('模型返回的记忆建议不完整。');
      return { kind: parsed.kind, reply, memory: { key, value, label: asText(memory.label) || key } };
    }
    return { kind: parsed.kind, reply };
  }

  const rawDrafts = Array.isArray(parsed.drafts) ? parsed.drafts : parsed.draft ? [parsed.draft] : [];
  if (!rawDrafts.length) throw new Error('模型没有返回记账草稿。');
  const drafts = rawDrafts.map(normalizeDraft);
  const errors = [];
  drafts.forEach((draft, index) => {
    const label = `第 ${index + 1} 笔`;
    if (!VALID_TYPES.has(draft.type)) errors.push(`${label}类型无效。`);
    if (!(draft.amountYuan > 0)) errors.push(`${label}金额无效。`);
    if (!draft.category) errors.push(`${label}缺少分类。`);
    if (!draft.account) errors.push(`${label}缺少账户。`);
    if (!draft.occurredAt || Number.isNaN(new Date(draft.occurredAt).getTime())) errors.push(`${label}缺少合法发生时间。`);
    if (!draft.note) errors.push(`${label}缺少备注。`);
    if (draft.type === 'transfer' && !draft.toAccount) errors.push(`${label}缺少转入账户。`);
  });
  const expectedAmounts = Array.isArray(context.candidates) ? context.candidates.map((item) => item.amountYuan) : [];
  if (expectedAmounts.length && !sameAmountMultiset(expectedAmounts, drafts.map((draft) => draft.amountYuan))) {
    errors.push('模型草稿没有完整覆盖脚本预处理识别到的金额。');
  }
  if (errors.length) throw new Error(`模型结果校验失败：${errors.join(' ')}`);
  return {
    kind: parsed.kind,
    reply,
    drafts,
    ...(drafts.length === 1 ? { draft: drafts[0] } : {}),
  };
}

export function agentResponseJson(result) {
  return JSON.stringify(result);
}

export const AGENT_RESPONSE_KINDS = [...VALID_KINDS];
