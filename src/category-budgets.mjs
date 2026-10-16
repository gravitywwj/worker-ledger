const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function normalizeCategoryBudgets(rawBudgets, categories) {
  if (!Array.isArray(rawBudgets)) throw new Error('分类预算必须是列表。');
  const seen = new Set();
  return rawBudgets.map((raw) => {
    const key = `${raw.month}:${raw.categoryId}`;
    if (!raw.id || !MONTH_PATTERN.test(raw.month) || seen.has(key) || !categories.some((category) => category.id === raw.categoryId && category.type === 'expense')
      || !Number.isSafeInteger(raw.amount) || raw.amount < 0) throw new Error('分类预算月份、分类或金额无效。');
    seen.add(key);
    return { id: key, month: raw.month, categoryId: raw.categoryId, amount: raw.amount };
  });
}

export function categoryBudgetRows({ month, budgets = [], transactions = [], categories = [] }) {
  if (!MONTH_PATTERN.test(month)) throw new Error('预算月份无效。');
  const budgetByCategory = new Map(budgets.filter((item) => item.month === month).map((item) => [item.categoryId, item.amount]));
  const usedByCategory = new Map();
  let totalUsed = 0;
  for (const transaction of transactions) {
    const date = new Date(transaction.occurredAt);
    const transactionMonth = Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : '';
    if (transaction.deletedAt || transaction.type !== 'expense' || !Number.isSafeInteger(transaction.amount) || transaction.amount <= 0
      || transactionMonth !== month) continue;
    usedByCategory.set(transaction.categoryId, (usedByCategory.get(transaction.categoryId) || 0) + transaction.amount);
    totalUsed += transaction.amount;
  }
  const rows = categories.filter((item) => item.type === 'expense').map((category) => {
    const limit = budgetByCategory.get(category.id) || 0;
    const used = usedByCategory.get(category.id) || 0;
    return { category, limit, used, remaining: Math.max(0, limit - used), over: Math.max(0, used - limit) };
  }).filter((item) => item.limit > 0 || item.used > 0);
  const totalLimit = [...budgetByCategory.values()].reduce((sum, value) => sum + value, 0);
  return { month, rows, totalLimit, totalUsed, totalRemaining: Math.max(0, totalLimit - totalUsed), totalOver: Math.max(0, totalUsed - totalLimit) };
}

export function previousMonthBudgets(budgets, month) {
  if (!MONTH_PATTERN.test(month)) throw new Error('预算月份无效。');
  const [year, monthNumber] = month.split('-').map(Number);
  const previous = monthNumber === 1 ? `${year - 1}-12` : `${year}-${String(monthNumber - 1).padStart(2, '0')}`;
  return budgets.filter((item) => item.month === previous).map((item) => ({ id: `${month}:${item.categoryId}`, month, categoryId: item.categoryId, amount: item.amount }));
}
