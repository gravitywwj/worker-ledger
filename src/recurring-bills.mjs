const DAY = 86400000;
const dateParts = (value) => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('周期账单日期无效。');
  const parts = match.slice(1).map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2], 12);
  if (date.getFullYear() !== parts[0] || date.getMonth() !== parts[1] - 1 || date.getDate() !== parts[2]) throw new Error('周期账单日期无效。');
  return parts;
};
const dateKey = (year, month, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

function clampedDate(year, month, day) {
  const last = new Date(year, month, 0).getDate();
  return dateKey(year, month, Math.min(day, last));
}

export function nextRecurringDate(dueDate, cadence, paymentDay, paymentMonth = null) {
  const [year, month] = dateParts(dueDate);
  if (!Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 31) throw new Error('付款日需要是 1 到 31。');
  if (cadence === 'monthly') {
    const nextMonth = month === 12 ? 1 : month + 1;
    return clampedDate(month === 12 ? year + 1 : year, nextMonth, paymentDay);
  }
  if (cadence === 'yearly' && Number.isInteger(paymentMonth) && paymentMonth >= 1 && paymentMonth <= 12) return clampedDate(year + 1, paymentMonth, paymentDay);
  throw new Error('周期仅支持月付或年付。');
}

export function firstRecurringDate({ cadence, paymentDay, paymentMonth = null, today = new Date() }) {
  const current = new Date(today);
  if (!Number.isFinite(current.getTime())) throw new Error('当前日期无效。');
  const year = current.getFullYear(), month = current.getMonth() + 1, day = current.getDate();
  if (cadence === 'monthly') {
    const candidate = clampedDate(year, month, paymentDay);
    return candidate >= dateKey(year, month, day) ? candidate : nextRecurringDate(candidate, cadence, paymentDay);
  }
  if (cadence === 'yearly') {
    const targetMonth = paymentMonth || month;
    let candidate = clampedDate(year, targetMonth, paymentDay);
    if (candidate < dateKey(year, month, day)) candidate = clampedDate(year + 1, targetMonth, paymentDay);
    return candidate;
  }
  throw new Error('周期仅支持月付或年付。');
}

export function normalizeRecurringBill(raw) {
  const bill = { ...raw, name: String(raw?.name || '').trim(), status: raw?.status || 'active' };
  if (!bill.id || !bill.name || bill.name.length > 80 || !Number.isSafeInteger(bill.amount) || bill.amount <= 0) throw new Error('周期账单名称或金额无效。');
  if (!['monthly', 'yearly'].includes(bill.cadence) || !['active', 'paused', 'ended'].includes(bill.status)) throw new Error('周期账单周期或状态无效。');
  if (!Number.isInteger(bill.paymentDay) || bill.paymentDay < 1 || bill.paymentDay > 31) throw new Error('付款日需要是 1 到 31。');
  if (bill.cadence === 'yearly' && (!Number.isInteger(bill.paymentMonth) || bill.paymentMonth < 1 || bill.paymentMonth > 12)) throw new Error('年付账单需要确认付款月份。');
  dateParts(bill.nextDueDate);
  if (!bill.accountId) throw new Error('周期账单需要选择账户。');
  const payments = Array.isArray(bill.payments) ? bill.payments : [];
  for (const payment of payments) {
    dateParts(payment.dueDate);
    if (!payment.transactionId) throw new Error('周期账单关联流水无效。');
  }
  return { ...bill, payments };
}

export function recurringBillCandidates(transactions, categories, { minimumMonthly = 3, minimumYearly = 2 } = {}) {
  const expenseRows = transactions.filter((item) => !item.deletedAt && item.type === 'expense' && Number.isSafeInteger(item.amount) && item.amount > 0);
  const groups = new Map();
  for (const item of expenseRows) {
    const note = String(item.note || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '').slice(0, 80);
    if (!note) continue;
    const key = `${item.categoryId}:${note}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const candidates = [];
  for (const items of groups.values()) {
    items.sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
    for (const cadence of ['monthly', 'yearly']) {
      const minimum = cadence === 'monthly' ? minimumMonthly : minimumYearly;
      const accepted = [];
      for (const item of items) {
        const date = new Date(item.occurredAt);
        const sameCycle = accepted.at(-1) && (cadence === 'monthly'
          ? date.getFullYear() * 12 + date.getMonth() - (new Date(accepted.at(-1).occurredAt).getFullYear() * 12 + new Date(accepted.at(-1).occurredAt).getMonth()) === 1
          : date.getFullYear() - new Date(accepted.at(-1).occurredAt).getFullYear() === 1);
        const prior = accepted.at(-1);
        const dateNear = prior && (cadence === 'monthly'
          ? Math.abs(date.getDate() - new Date(prior.occurredAt).getDate()) <= 3
          : Math.abs(date.getMonth() - new Date(prior.occurredAt).getMonth()) <= 0 && Math.abs(date.getDate() - new Date(prior.occurredAt).getDate()) <= 3);
        const amountNear = prior && Math.abs(item.amount - prior.amount) <= Math.max(100, Math.round(Math.max(item.amount, prior.amount) * 0.05));
        if (!prior || (sameCycle && dateNear && amountNear)) accepted.push(item);
        else if (!sameCycle || !dateNear || !amountNear) accepted.splice(0, accepted.length, item);
      }
      if (accepted.length >= minimum) candidates.push({ name: accepted.at(-1).note, categoryId: accepted.at(-1).categoryId,
        category: categories.find((category) => category.id === accepted.at(-1).categoryId)?.label || '', cadence,
        amount: Math.round(accepted.reduce((sum, item) => sum + item.amount, 0) / accepted.length),
        accountId: accepted.at(-1).accountId, paymentDay: new Date(accepted.at(-1).occurredAt).getDate(), count: accepted.length,
        transactionIds: accepted.map((item) => item.id) });
    }
  }
  return candidates;
}

export function recordRecurringPayment(bill, transaction, today = new Date()) {
  if (!bill || !transaction || transaction.type !== 'expense') throw new Error('周期账单只能关联支出流水。');
  if ((bill.payments || []).some((payment) => payment.transactionId === transaction.id)) throw new Error('这笔流水已关联到该周期账单。');
  const nextDueDate = nextRecurringDate(bill.nextDueDate, bill.cadence, bill.paymentDay, bill.paymentMonth);
  return normalizeRecurringBill({ ...bill, nextDueDate, payments: [...(bill.payments || []), { dueDate: bill.nextDueDate, transactionId: transaction.id, linkedAt: today.toISOString() }] });
}

export function removeRecurringPayment(bill, transactionId) {
  const payments = bill.payments || [];
  const index = payments.findIndex((payment) => payment.transactionId === transactionId);
  if (index < 0) return bill;
  const payment = payments[index];
  const lastPayment = index === payments.length - 1;
  return normalizeRecurringBill({ ...bill, ...(lastPayment ? { nextDueDate: payment.dueDate } : {}), payments: payments.filter((entry) => entry.transactionId !== transactionId) });
}

export function dueRecurringBills(bills, today = new Date()) {
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return bills.filter((bill) => bill.status === 'active').map((bill) => ({ ...bill, isDue: bill.nextDueDate <= key,
    daysUntilDue: Math.round((new Date(`${bill.nextDueDate}T12:00:00`) - new Date(`${key}T12:00:00`)) / DAY) }))
    .sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));
}
