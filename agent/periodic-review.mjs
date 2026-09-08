const PLACEHOLDER_PATTERN = /\{\{\s*([^{}\s]+)\s*\}\}/g;
const FORBIDDEN_LANGUAGE_PATTERN = /你应该|建议|要不要控制一下|该不该|该收敛|乱花钱|这样不行|月光族|剁手党/;
const EMOJI_PATTERN = /[\p{Extended_Pictographic}\uFE0F]/u;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundYuan(value) {
  return Math.round(finiteNumber(value) * 100) / 100;
}

function monthKey(dateInput) {
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthIndex(key) {
  const [year, month] = String(key).split('-').map(Number);
  return year * 12 + month;
}

function monthLabel(key) {
  const month = Number(String(key).split('-')[1]);
  return Number.isFinite(month) ? `${month}月` : '';
}

function normalizeFacts(facts) {
  return (Array.isArray(facts) ? facts : [])
    .filter((fact) => fact && typeof fact === 'object' && text(fact.id))
    .map((fact) => ({
      id: text(fact.id),
      value: fact.value,
      label: text(fact.label) || text(fact.id),
      valueType: text(fact.valueType) || 'text',
    }));
}

function transactionAmountYuan(transaction) {
  if (transaction?.amountYuan !== undefined) return finiteNumber(transaction.amountYuan);
  return finiteNumber(transaction?.amount) / 100;
}

function transactionCategory(transaction) {
  return text(transaction?.category || transaction?.categoryLabel || transaction?.categoryName) || '未分类';
}

function transactionNote(transaction) {
  return text(transaction?.note) || '未注明用途';
}

function isScopedToYear(transaction, year) {
  if (!year) return true;
  const date = new Date(transaction?.occurredAt);
  return !Number.isNaN(date.getTime()) && date.getFullYear() === year;
}

function buildFacts(entries) {
  const monthly = new Map();
  const categoryTotals = new Map();
  let totalIncome = 0;
  let totalExpense = 0;
  let biggestExpense = null;

  for (const entry of entries) {
    const amountYuan = Math.abs(transactionAmountYuan(entry));
    const key = monthKey(entry.occurredAt);
    if (!key || !(amountYuan > 0)) continue;
    const current = monthly.get(key) || { incomeYuan: 0, expenseYuan: 0 };
    if (entry.type === 'income') {
      current.incomeYuan += amountYuan;
      totalIncome += amountYuan;
    } else if (entry.type === 'expense') {
      current.expenseYuan += amountYuan;
      totalExpense += amountYuan;
      const category = transactionCategory(entry);
      const categoryTotal = categoryTotals.get(category) || 0;
      categoryTotals.set(category, categoryTotal + amountYuan);
      if (!biggestExpense || amountYuan > biggestExpense.amountYuan) {
        biggestExpense = { amountYuan, note: transactionNote(entry) };
      }
    } else {
      continue;
    }
    monthly.set(key, current);
  }

  const monthKeys = [...monthly.keys()].sort();
  const categories = [...categoryTotals.entries()].sort((left, right) => right[1] - left[1]);
  const bestSavingMonth = monthKeys
    .map((key) => ({ key, amountYuan: monthly.get(key).incomeYuan - monthly.get(key).expenseYuan }))
    .sort((left, right) => right.amountYuan - left.amountYuan)[0];

  let currentStreak = 0;
  let longestStreak = 0;
  let previousKey = '';
  for (const key of monthKeys) {
    const balance = monthly.get(key).incomeYuan - monthly.get(key).expenseYuan;
    const consecutive = previousKey && monthIndex(key) === monthIndex(previousKey) + 1;
    currentStreak = balance > 0 ? (consecutive ? currentStreak + 1 : 1) : 0;
    longestStreak = Math.max(longestStreak, currentStreak);
    previousKey = key;
  }

  const facts = [
    { id: 'total_months', value: monthKeys.length, label: '记账月数', valueType: 'count' },
    { id: 'total_income', value: roundYuan(totalIncome), label: '累计收入', valueType: 'currency' },
    { id: 'total_expense', value: roundYuan(totalExpense), label: '累计支出', valueType: 'currency' },
  ];
  if (categories[0]) {
    facts.push(
      { id: 'top_category', value: categories[0][0], label: '支出最多的分类', valueType: 'text' },
      { id: 'top_category_amount', value: roundYuan(categories[0][1]), label: '该分类累计金额', valueType: 'currency' },
    );
  }
  if (biggestExpense) {
    facts.push(
      { id: 'biggest_single_expense', value: roundYuan(biggestExpense.amountYuan), label: '单笔最大支出金额', valueType: 'currency' },
      { id: 'biggest_single_expense_note', value: biggestExpense.note, label: '单笔最大支出备注', valueType: 'text' },
    );
  }
  if (bestSavingMonth) {
    facts.push(
      { id: 'best_saving_month', value: monthLabel(bestSavingMonth.key), label: '结余最高的月份', valueType: 'month' },
      { id: 'best_saving_month_amount', value: roundYuan(bestSavingMonth.amountYuan), label: '该月结余金额', valueType: 'currency' },
    );
  }
  if (longestStreak > 0) facts.push({ id: 'streak_positive_months', value: longestStreak, label: '连续结余为正的月数', valueType: 'count' });

  return { facts, coverageMonths: monthKeys.length, monthly };
}

export function buildPeriodicReviewFacts(transactions = [], options = {}) {
  const annual = Boolean(options.annual);
  const year = annual ? Number(options.year || new Date().getFullYear()) : null;
  const entries = (Array.isArray(transactions) ? transactions : [])
    .filter((transaction) => transaction && !transaction.deletedAt && transaction.type !== 'transfer')
    .filter((transaction) => !year || isScopedToYear(transaction, year));
  const result = buildFacts(entries);
  return {
    facts: result.facts,
    coverageMonths: result.coverageMonths,
    annual,
    year,
  };
}

export function normalizePeriodicReviewPayload(rawPayload, facts = []) {
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  const normalizedFacts = normalizeFacts(facts);
  const factIds = new Set(normalizedFacts.map((fact) => fact.id));
  const headline = text(payload.headline);
  const closing = text(payload.closing);
  const rawHighlights = Array.isArray(payload.highlights) ? payload.highlights : [];
  const errors = [];

  if (!headline) errors.push('回顾缺少 headline。');
  if ([...headline].length > 24) errors.push('回顾 headline 不能超过 24 个汉字。');
  if (/[0-9%]/.test(headline)) errors.push('回顾 headline 不能包含具体数字。');
  if (!closing) errors.push('回顾缺少 closing。');
  if (/[0-9%]/.test(closing)) errors.push('回顾 closing 不能直接书写具体数字。');
  if (rawHighlights.length > 5) errors.push('回顾 highlights 最多 5 条。');

  const highlights = rawHighlights.map((item, index) => {
    const factId = text(item?.fact_id);
    const line = text(item?.line);
    const placeholders = [...line.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]);
    if (!factId || !factIds.has(factId)) errors.push(`第 ${index + 1} 条 highlight 的 fact_id 不在 facts 中。`);
    if (!line) errors.push(`第 ${index + 1} 条 highlight 缺少 line。`);
    if (!placeholders.length) errors.push(`第 ${index + 1} 条 highlight 必须使用 facts 占位符。`);
    for (const placeholder of placeholders) {
      if (!factIds.has(placeholder)) errors.push(`第 ${index + 1} 条 highlight 引用了不存在的 fact_id：${placeholder}。`);
    }
    if ((line.match(/[!！]/g) || []).length > 1) errors.push(`第 ${index + 1} 条 highlight 最多使用一个感叹号。`);
    if (/[0-9%]/.test(line)) errors.push(`第 ${index + 1} 条 highlight 不能直接书写数字或百分比。`);
    if (FORBIDDEN_LANGUAGE_PATTERN.test(line)) errors.push(`第 ${index + 1} 条 highlight 包含评判或建议性措辞。`);
    if (EMOJI_PATTERN.test(line)) errors.push(`第 ${index + 1} 条 highlight 不能使用表情符号。`);
    return { fact_id: factId, line };
  });

  const totalExclamations = `${headline}${highlights.map((item) => item.line).join('')}${closing}`.match(/[!！]/g) || [];
  if (totalExclamations.length > 2) errors.push('整张回顾卡片最多使用两个感叹号。');
  if (FORBIDDEN_LANGUAGE_PATTERN.test(headline) || FORBIDDEN_LANGUAGE_PATTERN.test(closing)) errors.push('回顾包含评判或建议性措辞。');
  if (EMOJI_PATTERN.test(headline) || EMOJI_PATTERN.test(closing)) errors.push('回顾不能使用表情符号。');
  if (errors.length) throw new Error(`阶段回顾校验失败：${errors.join(' ')}`);

  return { headline, highlights, closing, facts: normalizedFacts };
}

export function periodicReviewPlaceholderIds(line = '') {
  return [...String(line).matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]);
}
