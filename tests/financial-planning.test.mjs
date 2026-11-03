import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinancialPlanFacts, latestSalaryReference, normalizeFinancialPlan } from '../src/financial-planning.mjs';
import { normalizeBackup } from '../src/product-backup.mjs';

const today = new Date(2026, 10, 3, 12);
const goal = (patch = {}) => ({ id: 'computer', name: '电脑', kind: 'purchase', targetAmount: 600000,
  allocatedAmount: 100000, monthlyContribution: 100000, deadline: '2027-01-31', ...patch });
const plan = (patch = {}) => ({ monthlyIncome: 1000000, availableCash: 1000000, ...patch });

test('unconfigured fields remain unknown and a zero income is not treated as missing', () => {
  const facts = buildFinancialPlanFacts(undefined, today);
  assert.equal(facts.spending, null);
  assert.equal(facts.unallocatedCash, null);
  assert.equal(facts.targetAssets, null);
  assert.deepEqual(facts.goals, []);
  assert.equal(buildFinancialPlanFacts(plan({ monthlyIncome: 0, availableCash: 0 }), today).spending, 0);
  assert.equal(buildFinancialPlanFacts(plan({ monthlyIncome: 0, reserveMonths: 3 }), today).targetAssets, null);
  assert.equal(buildFinancialPlanFacts(plan({ monthlyIncome: 0, reserveMonths: 3 }), today).reserveFloor, null);
});

test('allocation preserves cents, zero shares and the confirmed income without counting goal saving twice', () => {
  const facts = buildFinancialPlanFacts(plan({ goals: [goal()] }), today);
  assert.deepEqual([facts.investment, facts.reserve, facts.spending], [200000, 300000, 500000]);
  assert.equal(facts.dailySpending, 400000);
  assert.equal(facts.investment + facts.reserve + facts.purchaseMonthly + facts.dailySpending, facts.plan.monthlyIncome);
  assert.equal(buildFinancialPlanFacts(plan({ goals: [goal({ allocatedAmount: 599999 })] }), today).purchaseMonthly, 1);
  for (let amount = 0; amount < 110; amount++) {
    const rounded = buildFinancialPlanFacts(plan({ monthlyIncome: amount, investmentPercent: 50, reservePercent: 50, spendingPercent: 0 }), today);
    assert.equal(rounded.investment + rounded.reserve + rounded.spending, amount);
    assert.equal(rounded.spending, 0);
  }
});

test('purchase goals share one cash pool and expose both cash and monthly budget conflicts', () => {
  const goals = [goal({ allocatedAmount: 600000 }), goal({ id: 'phone', allocatedAmount: 500000 })];
  const facts = buildFinancialPlanFacts(plan({ goals }), today);
  assert.equal(facts.allocationShortfall, 100000);
  assert.ok(facts.goals.every((item) => item.state === 'conflict'));
  const overspent = buildFinancialPlanFacts(plan({ goals: [goal({ targetAmount: 700000, monthlyContribution: 600000 })] }), today);
  assert.equal(overspent.spendingShortfall, 100000);
  assert.equal(overspent.dailySpending, 0);
});

test('an affordable purchase is impact-only until a buffer floor is explicitly set', () => {
  const base = plan({ monthlyLivingExpense: 200000, goals: [goal()] });
  const unknown = buildFinancialPlanFacts(base, today).goals[0];
  assert.equal(unknown.state, 'impact-only');
  assert.equal(unknown.cashAfterPurchase, 400000);
  assert.equal(unknown.bufferAfterPurchaseMonths, 2);
  assert.equal(buildFinancialPlanFacts({ ...base, reserveMonths: 3 }, today).goals[0].state, 'below-floor');
  assert.equal(buildFinancialPlanFacts({ ...base, reserveMonths: 1 }, today).goals[0].state, 'within-plan');
  assert.equal(buildFinancialPlanFacts({ ...base, availableCash: 0 }, today).goals[0].state, 'conflict');
  assert.equal(buildFinancialPlanFacts({ ...base, availableCash: null }, today).goals[0].state, 'unknown');
});

test('savings goals use the reserve share and overlap the buffer floor rather than being deducted twice', () => {
  const facts = buildFinancialPlanFacts(plan({ monthlyLivingExpense: 200000, reserveMonths: 3,
    goals: [goal({ targetAmount: 400000 }), goal({ id: 'reserve', kind: 'savings', allocatedAmount: 600000, monthlyContribution: 300000 })] }), today);
  assert.equal(facts.purchaseMonthly, 100000);
  assert.equal(facts.savingsMonthly, 0);
  assert.equal(facts.goals[0].state, 'within-plan');
  assert.equal(facts.goals[1].state, 'funded');
  const shortage = buildFinancialPlanFacts(plan({ goals: [goal({ kind: 'savings', monthlyContribution: 400000 })] }), today);
  assert.equal(shortage.reserveMonthlyShortfall, 100000);
});

test('deadlines include the current month, report overdue dates and require a contribution for a time estimate', () => {
  const facts = buildFinancialPlanFacts(plan({ goals: [goal()] }), today);
  assert.equal(facts.goals[0].monthsLeft, 3);
  assert.equal(facts.goals[0].requiredMonthly, 166667);
  assert.equal(facts.goals[0].fundingMonths, 5);
  assert.equal(facts.goals[0].deadlineShortfall, 200000);
  const overdue = buildFinancialPlanFacts(plan({ goals: [goal({ deadline: '2026-11-02', monthlyContribution: 0 })] }), today).goals[0];
  assert.equal(overdue.overdue, true);
  assert.equal(overdue.requiredMonthly, null);
  assert.equal(overdue.fundingMonths, null);
  assert.equal(buildFinancialPlanFacts(plan({ goals: [goal({ deadline: '2026-11-03' })] }), today).goals[0].monthsLeft, 1);
});

test('return assumptions calculate expense coverage, distinguish the salary reference and handle nonpositive returns', () => {
  const facts = buildFinancialPlanFacts(plan(), today);
  assert.equal(facts.targetAssets, 150000000);
  assert.equal(facts.salaryMultipleReference, 300000000);
  assert.equal(facts.livingExpenseIsEstimate, true);
  assert.equal(buildFinancialPlanFacts(plan({ annualReturnRate: 0 }), today).targetAssets, null);
  assert.equal(buildFinancialPlanFacts(plan({ annualReturnRate: -4 }), today).targetAssets, null);
  assert.equal(buildFinancialPlanFacts(plan({ monthlyLivingExpense: 0 }), today).targetAssets, 0);
});

test('invalid amounts, ratios, dates and duplicate goal identities fail before persistence', () => {
  for (const patch of [{ availableCash: -1 }, { monthlyIncome: '100' }, { availableCash: 1.5 }, { monthlyIncome: Infinity },
    { spendingPercent: 51 }, { investmentPercent: 20.5 }, { annualReturnRate: Infinity }, { reserveMonths: -1 },
    { cashConfirmedAt: '2026-02-30' }, { goals: [goal({ deadline: '2026-02-30' })] },
    { goals: [goal(), goal()] }, { goals: [goal({ allocatedAmount: 600001 })] }, { goals: [goal({ kind: 'unknown' })] }]) {
    assert.throws(() => normalizeFinancialPlan(plan(patch)));
  }
  assert.throws(() => normalizeFinancialPlan(null));
  assert.throws(() => normalizeFinancialPlan([]));
});

test('salary references exclude this month, refunds, transfers, other income and deleted entries', () => {
  const entries = [
    { type: 'income', categoryId: 'salary', amount: 600000, occurredAt: '2026-10-01T12:00:00' },
    { type: 'income', categoryId: 'salary', amount: 100000, occurredAt: '2026-10-02T12:00:00' },
    { type: 'income', categoryId: 'salary', amount: 900000, occurredAt: '2026-11-01T12:00:00' },
    { type: 'income', categoryId: 'reimburse', amount: 500000, occurredAt: '2026-10-01T12:00:00' },
    { type: 'income', categoryId: 'other-income', amount: 100000, occurredAt: '2026-10-01T12:00:00' },
    { type: 'transfer', categoryId: 'salary', amount: 100000, occurredAt: '2026-10-01T12:00:00' },
    { type: 'income', categoryId: 'salary', amount: 100000, occurredAt: '2026-10-01T12:00:00', deletedAt: '2026-10-02' },
  ];
  assert.deepEqual(latestSalaryReference(entries, today), { month: '2026-10', amount: 700000 });
  assert.equal(latestSalaryReference([], today), null);
});

test('planning survives a v4 backup round trip and rejects bad planning before any writes', () => {
  const backup = { version: 4, transactions: [], categories: [], accounts: [], products: [], productCategories: [],
    recurringBills: [], categoryBudgets: [], shoppingList: [], profile: { monthlyBudget: 1000,
      financialPlan: normalizeFinancialPlan(plan({ goals: [goal()] })) } };
  assert.deepEqual(normalizeBackup(JSON.parse(JSON.stringify(backup))).profile.financialPlan, backup.profile.financialPlan);
  assert.throws(() => normalizeBackup({ ...backup, profile: { financialPlan: { ...backup.profile.financialPlan, availableCash: -1 } } }));
  assert.equal(normalizeBackup({ version: 2, transactions: [], categories: [], accounts: [] }).profile, undefined);
});
