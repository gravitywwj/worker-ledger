const monthBounds = (month) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('分析月份无效。');
  const [year, monthNumber] = month.split('-').map(Number);
  const start = `${month}-01`;
  const end = `${year}-${String(monthNumber).padStart(2, '0')}-${String(new Date(year, monthNumber, 0).getDate()).padStart(2, '0')}`;
  return { start, end };
};
const priorMonth = (month) => { const [year, number] = month.split('-').map(Number); return number === 1 ? `${year - 1}-12` : `${year}-${String(number - 1).padStart(2, '0')}`; };

export function buildSpendingChangeFacts({ month, transactions = [], categories = [] }) {
  const previousMonth = priorMonth(month);
  const currentBounds = monthBounds(month), previousBounds = monthBounds(previousMonth);
  const expenses = transactions.filter((item) => !item.deletedAt && item.type === 'expense' && Number.isSafeInteger(item.amount) && item.amount > 0);
  const aggregate = (monthKey) => {
    const selected = expenses.filter((item) => {
      const date = new Date(item.occurredAt);
      return Number.isFinite(date.getTime()) && `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` === monthKey;
    });
    const byCategory = new Map();
    for (const transaction of selected) {
      const row = byCategory.get(transaction.categoryId) || { amount: 0, transactionIds: [] };
      row.amount += transaction.amount; row.transactionIds.push(transaction.id); byCategory.set(transaction.categoryId, row);
    }
    return { selected, byCategory, amount: selected.reduce((sum, item) => sum + item.amount, 0) };
  };
  const current = aggregate(month), previous = aggregate(previousMonth);
  const categoryIds = new Set([...current.byCategory.keys(), ...previous.byCategory.keys()]);
  const categoriesChanged = [...categoryIds].map((categoryId) => {
    const now = current.byCategory.get(categoryId) || { amount: 0, transactionIds: [] };
    const before = previous.byCategory.get(categoryId) || { amount: 0, transactionIds: [] };
    const difference = now.amount - before.amount;
    return { fact_id: `category-${categoryId}`, categoryId,
      category: categories.find((item) => item.id === categoryId)?.label || categoryId,
      currentAmount: now.amount, previousAmount: before.amount, difference,
      transactionIds: [...now.transactionIds, ...before.transactionIds] };
  }).sort((a, b) => b.difference - a.difference);
  const difference = current.amount - previous.amount;
  const changed = categoriesChanged.filter((item) => item.difference !== 0);
  const relevantIds = [...new Set(changed.flatMap((item) => item.transactionIds))];
  return { fact_id: 'spending-change-total', month, previousMonth, currentPeriod: currentBounds, previousPeriod: previousBounds,
    currentAmount: current.amount, previousAmount: previous.amount, difference,
    currentCount: current.selected.length, previousCount: previous.selected.length,
    categories: categoriesChanged.map((item) => ({ ...item,
      contributionPercent: difference > 0 ? Math.round(item.difference / difference * 1000) / 10 : 0 })),
    transactionIds: relevantIds };
}
