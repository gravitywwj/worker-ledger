const MAX_MONEY = 1_000_000_000_000;

export const DEFAULT_FINANCIAL_PLAN = Object.freeze({
  monthlyIncome: null,
  availableCash: null,
  cashConfirmedAt: '',
  investmentPercent: 20,
  reservePercent: 30,
  spendingPercent: 50,
  monthlyLivingExpense: null,
  reserveMonths: null,
  annualReturnRate: 4,
});

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && date.getFullYear() === Number(value.slice(0, 4))
    && date.getMonth() + 1 === Number(value.slice(5, 7)) && date.getDate() === Number(value.slice(8, 10));
}

function money(value, label, nullable = false) {
  if (nullable && value === null) return value;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MONEY) throw new Error(`${label}需要是有效的非负金额。`);
  return value;
}

export function normalizeFinancialPlan(raw) {
  if (raw === undefined) raw = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('资金规划格式无效。');
  const plan = { ...DEFAULT_FINANCIAL_PLAN, ...raw };
  for (const [key, label] of [['monthlyIncome', '到手月收入'], ['availableCash', '可动用现金'], ['monthlyLivingExpense', '计划月生活费']]) {
    money(plan[key], label, true);
  }
  const percentKeys = ['investmentPercent', 'reservePercent', 'spendingPercent'];
  if (percentKeys.some((key) => !Number.isInteger(plan[key]) || plan[key] < 0 || plan[key] > 100)
    || percentKeys.reduce((total, key) => total + plan[key], 0) !== 100) throw new Error('三项分配比例需要是 0 到 100 的整数，合计为 100%。');
  if (plan.reserveMonths !== null && (!Number.isFinite(plan.reserveMonths) || plan.reserveMonths < 0 || plan.reserveMonths > 120)) throw new Error('缓冲底线需要在 0 到 120 个月之间，也可以留空。');
  if (!Number.isFinite(plan.annualReturnRate) || plan.annualReturnRate < -100 || plan.annualReturnRate > 100) throw new Error('假设年化收益率需要在 -100% 到 100% 之间。');
  if (plan.cashConfirmedAt !== '' && !validDate(plan.cashConfirmedAt)) throw new Error('现金确认日期无效。');
  const rawGoals = raw.goals === undefined ? [] : raw.goals;
  if (!Array.isArray(rawGoals)) throw new Error('资金目标必须是列表。');
  const ids = new Set();
  const goals = rawGoals.map((goal) => {
    if (!goal || typeof goal !== 'object' || typeof goal.id !== 'string' || !goal.id || goal.id.length > 100 || ids.has(goal.id)) throw new Error('资金目标包含无效或重复 ID。');
    ids.add(goal.id);
    const name = typeof goal.name === 'string' ? goal.name.trim() : '';
    if (!name || name.length > 80 || !['purchase', 'savings'].includes(goal.kind)) throw new Error('请填写目标名称并选择购买或储蓄用途。');
    money(goal.targetAmount, '目标金额');
    money(goal.allocatedAmount, '目标已预留金额');
    money(goal.monthlyContribution, '目标每月预留金额');
    if (goal.targetAmount === 0 || goal.allocatedAmount > goal.targetAmount) throw new Error('目标金额需要大于零，已预留金额不能超过目标金额。');
    const deadline = goal.deadline ?? '';
    if (deadline !== '' && !validDate(deadline)) throw new Error('目标期限无效。');
    return { id: goal.id, name, kind: goal.kind, targetAmount: goal.targetAmount,
      allocatedAmount: goal.allocatedAmount, monthlyContribution: goal.monthlyContribution, deadline };
  });
  return { ...Object.fromEntries(Object.keys(DEFAULT_FINANCIAL_PLAN).map((key) => [key, plan[key]])), goals };
}

function totalMoney(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total > MAX_MONEY) throw new Error('目标合计金额超过可计算范围。');
  return total;
}

function splitIncome(income, percentages) {
  if (income === null) return percentages.map(() => null);
  const amounts = percentages.map((percent) => Math.floor(income * percent / 100));
  const order = percentages.map((percent, index) => ({ index, remainder: income * percent % 100 }))
    .sort((a, b) => b.remainder - a.remainder);
  const remaining = income - amounts.reduce((sum, amount) => sum + amount, 0);
  for (let index = 0; index < remaining; index++) amounts[order[index].index] += 1;
  return amounts;
}

export function buildFinancialPlanFacts(raw, today = new Date()) {
  const plan = normalizeFinancialPlan(raw);
  const now = new Date(today);
  if (!Number.isFinite(now.getTime())) throw new Error('资金规划计算日期无效。');
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const [investment, reserve, spending] = splitIncome(plan.monthlyIncome, [plan.investmentPercent, plan.reservePercent, plan.spendingPercent]);
  const purchaseAllocated = totalMoney(plan.goals.filter((goal) => goal.kind === 'purchase').map((goal) => goal.allocatedAmount));
  const savingsAllocated = totalMoney(plan.goals.filter((goal) => goal.kind === 'savings').map((goal) => goal.allocatedAmount));
  const totalAllocated = totalMoney([purchaseAllocated, savingsAllocated]);
  const purchaseMonthly = totalMoney(plan.goals.filter((goal) => goal.kind === 'purchase').map((goal) => Math.min(goal.monthlyContribution, goal.targetAmount - goal.allocatedAmount)));
  const savingsMonthly = totalMoney(plan.goals.filter((goal) => goal.kind === 'savings').map((goal) => Math.min(goal.monthlyContribution, goal.targetAmount - goal.allocatedAmount)));
  const livingExpense = plan.monthlyLivingExpense ?? (spending > 0 ? spending : null);
  const rawFloor = livingExpense !== null && plan.reserveMonths !== null ? Math.ceil(livingExpense * plan.reserveMonths) : null;
  const reserveFloor = rawFloor !== null && Number.isSafeInteger(rawFloor) ? rawFloor : null;
  const allocationShortfall = plan.availableCash === null ? null : Math.max(0, totalAllocated - plan.availableCash);
  const goals = plan.goals.map((goal) => {
    const gap = goal.targetAmount - goal.allocatedAmount;
    const overdue = Boolean(goal.deadline && goal.deadline < todayKey && gap > 0);
    const monthsLeft = goal.deadline && !overdue
      ? Math.max(1, (Number(goal.deadline.slice(0, 4)) - now.getFullYear()) * 12 + Number(goal.deadline.slice(5, 7)) - now.getMonth()) : null;
    const otherAllocated = totalAllocated - goal.allocatedAmount;
    const cashAfterPurchase = plan.availableCash !== null && goal.kind === 'purchase' ? plan.availableCash - goal.targetAmount : null;
    const otherPurchaseAllocated = purchaseAllocated - (goal.kind === 'purchase' ? goal.allocatedAmount : 0);
    const cashAvailableForGoal = plan.availableCash === null ? null : plan.availableCash - otherAllocated;
    const purchaseShortfall = cashAvailableForGoal === null || goal.kind !== 'purchase' ? null : Math.max(0, goal.targetAmount - cashAvailableForGoal);
    const bufferAfterPurchase = cashAfterPurchase === null ? null : cashAfterPurchase - otherPurchaseAllocated;
    const bufferShortfall = reserveFloor === null || bufferAfterPurchase === null ? null : Math.max(0, reserveFloor - bufferAfterPurchase);
    const state = plan.availableCash === null ? 'unknown' : allocationShortfall > 0 ? 'conflict'
      : goal.kind === 'savings' ? (gap === 0 ? 'funded' : 'saving')
        : purchaseShortfall > 0 ? 'shortfall' : bufferShortfall > 0 ? 'below-floor'
          : reserveFloor === null ? 'impact-only' : 'within-plan';
    return { ...goal, gap, overdue, monthsLeft, requiredMonthly: monthsLeft === null ? null : Math.ceil(gap / monthsLeft),
      deadlineShortfall: monthsLeft === null ? null : gap - Math.min(gap, goal.monthlyContribution * monthsLeft),
      fundingMonths: gap === 0 ? 0 : goal.monthlyContribution > 0 ? Math.ceil(gap / goal.monthlyContribution) : null,
      progress: goal.allocatedAmount / goal.targetAmount * 100, state, cashAfterPurchase, purchaseShortfall, bufferShortfall,
      bufferAfterPurchaseMonths: bufferAfterPurchase !== null && livingExpense > 0 ? Math.max(0, bufferAfterPurchase) / livingExpense : null };
  });
  const rawTarget = livingExpense !== null && plan.annualReturnRate > 0 ? Math.ceil(livingExpense * 12 / (plan.annualReturnRate / 100)) : null;
  return { plan, investment, reserve, spending, purchaseMonthly, savingsMonthly, livingExpense,
    livingExpenseIsEstimate: plan.monthlyLivingExpense === null,
    dailySpending: spending === null ? null : Math.max(0, spending - purchaseMonthly),
    spendingShortfall: spending === null ? null : Math.max(0, purchaseMonthly - spending),
    reserveRemaining: reserve === null ? null : Math.max(0, reserve - savingsMonthly),
    reserveMonthlyShortfall: reserve === null ? null : Math.max(0, savingsMonthly - reserve),
    totalAllocated, purchaseAllocated, savingsAllocated, allocationShortfall,
    unallocatedCash: plan.availableCash === null ? null : plan.availableCash - totalAllocated,
    bufferMonths: plan.availableCash !== null && livingExpense > 0 ? Math.max(0, plan.availableCash - purchaseAllocated) / livingExpense : null,
    reserveFloor, goals,
    targetAssets: rawTarget !== null && Number.isSafeInteger(rawTarget) ? rawTarget : null,
    salaryMultipleReference: plan.monthlyIncome === null ? null : plan.monthlyIncome * 300 };
}

export function latestSalaryReference(transactions, today = new Date()) {
  const now = new Date(today);
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const months = new Map();
  for (const transaction of transactions) {
    if (transaction.deletedAt || transaction.type !== 'income' || transaction.categoryId !== 'salary'
      || !Number.isSafeInteger(transaction.amount) || transaction.amount <= 0) continue;
    const date = new Date(transaction.occurredAt);
    if (!Number.isFinite(date.getTime())) continue;
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (month >= currentMonth) continue;
    months.set(month, totalMoney([months.get(month) || 0, transaction.amount]));
  }
  const month = [...months.keys()].sort().at(-1);
  return month ? { month, amount: months.get(month) } : null;
}
