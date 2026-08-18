/* 打工人小账本：本地优先的个人收支账本。 */

const DB_NAME = 'worker-ledger';
const DB_VERSION = 3;
const STORES = {
  transactions: 'transactions',
  settings: 'profile_settings',
  categories: 'categories',
  accounts: 'accounts',
};

const DEFAULT_PROFILE = {
  bookName: '日常账本',
  currency: 'CNY',
  monthlyBudget: 10000,
  salaryEstimate: {
    gross: 0,
    socialInsurance: 0,
    housingFund: 0,
    individualTax: 0,
    otherDeductions: 0,
    postTaxAllowance: 0,
  },
};

const DEFAULT_CATEGORIES = [
  { id: 'food', label: '餐饮', icon: 'ph-fork-knife', type: 'expense' },
  { id: 'commute', label: '交通', icon: 'ph-train', type: 'expense' },
  { id: 'housing', label: '居住', icon: 'ph-house-line', type: 'expense' },
  { id: 'daily', label: '日用', icon: 'ph-shopping-bag', type: 'expense' },
  { id: 'fun', label: '娱乐', icon: 'ph-game-controller', type: 'expense' },
  { id: 'health', label: '健康', icon: 'ph-first-aid-kit', type: 'expense' },
  { id: 'learn', label: '学习', icon: 'ph-book-open', type: 'expense' },
  { id: 'other', label: '其他', icon: 'ph-dots-three', type: 'expense' },
  { id: 'salary', label: '工资', icon: 'ph-briefcase', type: 'income' },
  { id: 'bonus', label: '奖金', icon: 'ph-sparkle', type: 'income' },
  { id: 'reimburse', label: '报销退款', icon: 'ph-receipt', type: 'income' },
  { id: 'other-income', label: '其他收入', icon: 'ph-coins', type: 'income' },
];

const DEFAULT_ACCOUNTS = [
  { id: 'salary-card', name: '工资卡', type: 'bank', openingBalance: 0, includeInAssets: true, archivedAt: null },
  { id: 'alipay', name: '支付宝', type: 'payment', openingBalance: 0, includeInAssets: true, archivedAt: null },
  { id: 'wechat', name: '微信', type: 'payment', openingBalance: 0, includeInAssets: true, archivedAt: null },
];

const CATEGORY_ICON_FALLBACKS = {
  food: 'ph-fork-knife',
  commute: 'ph-train',
  housing: 'ph-house-line',
  daily: 'ph-shopping-bag',
  fun: 'ph-game-controller',
  health: 'ph-first-aid-kit',
  learn: 'ph-book-open',
  other: 'ph-dots-three',
  salary: 'ph-briefcase',
  bonus: 'ph-sparkle',
  reimburse: 'ph-receipt',
  'other-income': 'ph-coins',
  transfer: 'ph-arrows-left-right',
};

const ACCOUNT_TYPE_LABELS = {
  cash: '现金',
  bank: '银行卡',
  card: '信用卡',
  payment: '支付平台',
  savings: '储蓄账户',
  other: '其他账户',
};

const ACCOUNT_TYPE_ICONS = {
  cash: 'ph-money',
  bank: 'ph-credit-card',
  card: 'ph-credit-card',
  payment: 'ph-device-mobile',
  savings: 'ph-piggy-bank',
  other: 'ph-wallet',
};

const CURRENCY_FORMATTER = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  currencyDisplay: 'narrowSymbol',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const NUMBER_FORMATTER = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const DEMO_MODE = new URLSearchParams(location.search).get('demo') === '1';

const state = {
  db: null,
  loading: true,
  error: null,
  activeView: 'home',
  selectedMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  profile: { ...DEFAULT_PROFILE, salaryEstimate: { ...DEFAULT_PROFILE.salaryEstimate } },
  transactions: [],
  categories: [...DEFAULT_CATEGORIES],
  accounts: [...DEFAULT_ACCOUNTS],
  searchTerm: '',
  ledgerType: 'all',
  ledgerAccount: 'all',
  reportPeriod: 'month',
  demo: DEMO_MODE,
};

let searchTimer = null;
let resizeTimer = null;

function id() {
  return globalThis.crypto?.randomUUID?.() || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function centsFromYuan(value) {
  return Math.round(number(value) * 100);
}

function yuanFromCents(value) {
  return number(value) / 100;
}

function money(cents) {
  return CURRENCY_FORMATTER.format(yuanFromCents(cents)).replace('CN¥', '¥').replace('￥', '¥').replace(/\s/g, '');
}

function signedMoney(transaction) {
  const amount = Math.abs(number(transaction.amount));
  if (transaction.type === 'income') return `+${money(amount)}`;
  if (transaction.type === 'expense') return `-${money(amount)}`;
  return money(amount);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function localDateTimeValue(dateInput = new Date()) {
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseLocalDateTime(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function monthKey(dateInput = new Date()) {
  const date = new Date(dateInput);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function dateKey(dateInput) {
  const date = new Date(dateInput);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function monthLabel(dateInput = state.selectedMonth) {
  const date = new Date(dateInput);
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}

function todayLabel(dateInput = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(dateInput)).replace('周', '周');
}

function timeLabel(dateInput) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(dateInput));
}

function groupDateLabel(dateInput) {
  const date = new Date(dateInput);
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${weekday}`;
}

function rangeLabel(start, end) {
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${start.getMonth() + 1} 月 ${start.getDate()} 日至 ${end.getDate()} 日`;
  }
  return `${start.getMonth() + 1} 月 ${start.getDate()} 日至 ${end.getMonth() + 1} 月 ${end.getDate()} 日`;
}

function icon(name, extraClass = '') {
  return `<i class="ph ${escapeHtml(name)} ${escapeHtml(extraClass)}" aria-hidden="true"></i>`;
}

function sortTransactions(items) {
  return [...items].filter((item) => !item.deletedAt).sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
}

function activeAccounts() {
  return state.accounts.filter((account) => !account.archivedAt);
}

function getCategory(categoryId) {
  if (categoryId === 'transfer') return { id: 'transfer', label: '转账', icon: 'ph-arrows-left-right', type: 'transfer' };
  return state.categories.find((category) => category.id === categoryId)
    || DEFAULT_CATEGORIES.find((category) => category.id === categoryId)
    || DEFAULT_CATEGORIES[7];
}

function categoryIcon(category) {
  if (String(category?.icon || '').startsWith('ph-')) return category.icon;
  return CATEGORY_ICON_FALLBACKS[category?.id] || (category?.type === 'income' ? 'ph-coins' : 'ph-tag');
}

function accountName(accountId) {
  return state.accounts.find((account) => account.id === accountId)?.name || '未指定账户';
}

function accountIcon(account) {
  return ACCOUNT_TYPE_ICONS[account?.type] || 'ph-wallet';
}

function periodBounds(period = 'month') {
  if (period === 'week') {
    const anchor = monthKey(new Date()) === monthKey(state.selectedMonth)
      ? new Date()
      : new Date(state.selectedMonth.getFullYear(), state.selectedMonth.getMonth(), 15);
    const weekday = anchor.getDay() || 7;
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - weekday + 1, 0, 0, 0, 0);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 59, 59, 999);
    return { start, end };
  }
  const start = new Date(state.selectedMonth.getFullYear(), state.selectedMonth.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(state.selectedMonth.getFullYear(), state.selectedMonth.getMonth() + 1, 0, 23, 59, 59, 999);
  return { start, end };
}

function transactionsInRange(start, end) {
  return sortTransactions(state.transactions).filter((item) => {
    const timestamp = new Date(item.occurredAt).getTime();
    return timestamp >= start.getTime() && timestamp <= end.getTime();
  });
}

function statsForRange(start, end) {
  const transactions = transactionsInRange(start, end);
  return transactions.reduce((stats, item) => {
    if (item.type === 'income') stats.income += number(item.amount);
    if (item.type === 'expense') stats.expense += number(item.amount);
    return stats;
  }, { income: 0, expense: 0, balance: 0, transactions });
}

function monthlyStats() {
  const { start, end } = periodBounds('month');
  const stats = statsForRange(start, end);
  stats.balance = stats.income - stats.expense;
  return stats;
}

function accountBalance(accountId, transactions = state.transactions) {
  const account = state.accounts.find((item) => item.id === accountId);
  let balance = Math.trunc(number(account?.openingBalance));
  transactions.filter((item) => !item.deletedAt).forEach((item) => {
    if (item.type === 'income' && item.accountId === accountId) balance += Math.trunc(number(item.amount));
    if (item.type === 'expense' && item.accountId === accountId) balance -= Math.trunc(number(item.amount));
    if (item.type === 'adjustment' && item.accountId === accountId) balance += Math.trunc(number(item.adjustmentDelta));
    if (item.type === 'transfer') {
      if (item.accountId === accountId) balance -= Math.trunc(number(item.amount));
      if (item.toAccountId === accountId) balance += Math.trunc(number(item.amount));
    }
  });
  return balance;
}

function totalAssets() {
  return activeAccounts()
    .filter((account) => account.includeInAssets !== false)
    .reduce((total, account) => total + accountBalance(account.id), 0);
}

function salaryEstimate(values = state.profile.salaryEstimate) {
  const gross = number(values.gross);
  const deductions = number(values.socialInsurance) + number(values.housingFund) + number(values.individualTax) + number(values.otherDeductions);
  return Math.max(0, gross - deductions + number(values.postTaxAllowance));
}

function demoDate(day, time) {
  const [hour, minute] = time.split(':').map(Number);
  return new Date(2026, 7, day, hour, minute).toISOString();
}

function makeDemoTransaction(transactionId, type, amount, categoryId, accountId, day, time, note, tags = []) {
  return {
    id: transactionId,
    type,
    amount: centsFromYuan(amount),
    categoryId,
    accountId,
    toAccountId: '',
    note,
    tags,
    occurredAt: demoDate(day, time),
    source: 'demo',
    createdAt: demoDate(day, time),
    updatedAt: demoDate(day, time),
  };
}

function demoData() {
  const accounts = [
    { id: 'salary-card', name: '工资卡', type: 'bank', openingBalance: centsFromYuan(678), includeInAssets: true, archivedAt: null },
    { id: 'alipay', name: '支付宝', type: 'payment', openingBalance: centsFromYuan(1254), includeInAssets: true, archivedAt: null },
    { id: 'wechat', name: '微信', type: 'payment', openingBalance: centsFromYuan(486), includeInAssets: true, archivedAt: null },
  ];
  const transactions = [
    makeDemoTransaction('demo-salary', 'income', 6400, 'salary', 'salary-card', 18, '19:18', '工资到账', ['工资']),
    makeDemoTransaction('demo-lunch', 'expense', 32, 'food', 'alipay', 18, '12:30', '午餐'),
    makeDemoTransaction('demo-metro', 'expense', 4, 'commute', 'alipay', 18, '08:15', '地铁'),
    makeDemoTransaction('demo-rent', 'expense', 1800, 'housing', 'salary-card', 17, '19:45', '房租', ['固定支出']),
    makeDemoTransaction('demo-dinner', 'expense', 28, 'food', 'alipay', 17, '12:20', '晚餐'),
    makeDemoTransaction('demo-metro-2', 'expense', 54, 'commute', 'alipay', 17, '08:10', '本月交通'),
    makeDemoTransaction('demo-side', 'income', 200, 'salary', 'salary-card', 16, '18:30', '周末兼职收入'),
    makeDemoTransaction('demo-lunch-2', 'expense', 26, 'food', 'alipay', 16, '11:50', '午餐'),
    makeDemoTransaction('demo-shopping', 'expense', 86, 'daily', 'alipay', 16, '10:20', '生活用品'),
    makeDemoTransaction('demo-health', 'expense', 350, 'health', 'salary-card', 15, '17:10', '门诊和药品'),
    makeDemoTransaction('demo-groceries', 'expense', 360, 'daily', 'alipay', 14, '18:40', '日常采购'),
    makeDemoTransaction('demo-reimburse', 'income', 600, 'reimburse', 'alipay', 12, '16:10', '差旅报销'),
    makeDemoTransaction('demo-refund', 'income', 120, 'reimburse', 'alipay', 11, '14:15', '购物退款'),
    makeDemoTransaction('demo-bonus', 'income', 1100, 'bonus', 'salary-card', 10, '10:00', '项目奖金'),
    makeDemoTransaction('demo-utilities', 'expense', 220, 'daily', 'salary-card', 9, '09:20', '水电燃气'),
    makeDemoTransaction('demo-fun', 'expense', 98, 'fun', 'alipay', 8, '20:30', '电影'),
    makeDemoTransaction('demo-phone', 'expense', 68, 'daily', 'salary-card', 7, '12:00', '手机话费'),
    makeDemoTransaction('demo-coffee', 'expense', 22, 'food', 'alipay', 6, '15:00', '咖啡'),
    makeDemoTransaction('demo-learn', 'expense', 120, 'learn', 'salary-card', 5, '20:00', '课程资料'),
    makeDemoTransaction('demo-taxi', 'expense', 18, 'commute', 'alipay', 4, '21:10', '打车'),
  ];
  return {
    profile: { ...DEFAULT_PROFILE, bookName: '日常账本', monthlyBudget: 10000 },
    categories: [...DEFAULT_CATEGORIES],
    accounts,
    transactions: sortTransactions(transactions),
  };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('当前浏览器不支持本地资料库。'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error || new Error('本地资料库无法打开。'));
    request.onupgradeneeded = () => {
      const db = request.result;
      const transactionStore = db.objectStoreNames.contains(STORES.transactions)
        ? request.transaction.objectStore(STORES.transactions)
        : db.createObjectStore(STORES.transactions, { keyPath: 'id' });
      if (!transactionStore.indexNames.contains('occurredAt')) transactionStore.createIndex('occurredAt', 'occurredAt');
      if (!transactionStore.indexNames.contains('categoryId')) transactionStore.createIndex('categoryId', 'categoryId');
      if (!transactionStore.indexNames.contains('accountId')) transactionStore.createIndex('accountId', 'accountId');
      if (!db.objectStoreNames.contains(STORES.settings)) db.createObjectStore(STORES.settings, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORES.categories)) db.createObjectStore(STORES.categories, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.accounts)) db.createObjectStore(STORES.accounts, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function dbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    request.onerror = () => reject(request.error || new Error('读取本地数据失败。'));
    request.onsuccess = () => resolve(request.result);
  });
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    request.onerror = () => reject(request.error || new Error('读取本地数据失败。'));
    request.onsuccess = () => resolve(request.result || []);
  });
}

function dbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction(storeName, 'readwrite');
    transaction.onerror = () => reject(transaction.error || new Error('保存失败。'));
    transaction.onabort = () => reject(transaction.error || new Error('保存操作已取消。'));
    transaction.objectStore(storeName).put(value);
    transaction.oncomplete = () => resolve(value);
  });
}

function dbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction(storeName, 'readwrite');
    transaction.onerror = () => reject(transaction.error || new Error('删除失败。'));
    transaction.objectStore(storeName).delete(key);
    transaction.oncomplete = () => resolve();
  });
}

function dbClear(storeName) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction(storeName, 'readwrite');
    transaction.onerror = () => reject(transaction.error || new Error('清理失败。'));
    transaction.objectStore(storeName).clear();
    transaction.oncomplete = () => resolve();
  });
}

async function ensureInitialData() {
  if ((await dbGetAll(STORES.categories)).length === 0) {
    for (const category of DEFAULT_CATEGORIES) await dbPut(STORES.categories, category);
  }
  if ((await dbGetAll(STORES.accounts)).length === 0) {
    for (const account of DEFAULT_ACCOUNTS) await dbPut(STORES.accounts, account);
  }
  if (!(await dbGet(STORES.settings, 'profile'))) {
    await dbPut(STORES.settings, { key: 'profile', ...DEFAULT_PROFILE });
  }
}

async function loadData() {
  state.loading = true;
  render();
  try {
    if (state.demo) {
      const demo = demoData();
      Object.assign(state, demo);
    } else {
      if (!state.db) state.db = await openDatabase();
      await ensureInitialData();
      const [profileRecord, transactions, categories, accounts] = await Promise.all([
        dbGet(STORES.settings, 'profile'),
        dbGetAll(STORES.transactions),
        dbGetAll(STORES.categories),
        dbGetAll(STORES.accounts),
      ]);
      state.profile = {
        ...DEFAULT_PROFILE,
        ...(profileRecord || {}),
        salaryEstimate: { ...DEFAULT_PROFILE.salaryEstimate, ...(profileRecord?.salaryEstimate || {}) },
      };
      delete state.profile.key;
      state.transactions = sortTransactions(transactions);
      state.categories = categories.length ? categories : [...DEFAULT_CATEGORIES];
      state.accounts = accounts.length ? accounts : [...DEFAULT_ACCOUNTS];
    }
    state.error = null;
  } catch (error) {
    state.error = error instanceof Error ? error.message : '读取本地资料库失败。';
  } finally {
    state.loading = false;
    render();
  }
}

async function persistProfile(patch, successMessage = '设置已保存。') {
  const next = {
    ...state.profile,
    ...patch,
    salaryEstimate: { ...state.profile.salaryEstimate, ...(patch.salaryEstimate || {}) },
  };
  if (!state.demo) await dbPut(STORES.settings, { key: 'profile', ...next });
  state.profile = next;
  setSavedStatus();
  render();
  toast(successMessage);
}

async function persistTransaction(transaction, successMessage = '这笔流水已保存。') {
  if (!state.demo) await dbPut(STORES.transactions, transaction);
  const existingIndex = state.transactions.findIndex((item) => item.id === transaction.id);
  if (existingIndex >= 0) state.transactions[existingIndex] = transaction;
  else state.transactions.push(transaction);
  state.transactions = sortTransactions(state.transactions);
  setSavedStatus();
  render();
  toast(successMessage);
}

async function persistAccount(account, successMessage = '账户已保存。') {
  if (!state.demo) await dbPut(STORES.accounts, account);
  const existingIndex = state.accounts.findIndex((item) => item.id === account.id);
  if (existingIndex >= 0) state.accounts[existingIndex] = account;
  else state.accounts.push(account);
  setSavedStatus();
  render();
  toast(successMessage);
}

async function persistCategory(category) {
  if (!state.demo) await dbPut(STORES.categories, category);
  state.categories.push(category);
  setSavedStatus();
  render();
  toast('分类已添加。');
}

function setSavedStatus() {
  const element = document.querySelector('#save-status');
  if (!element) return;
  element.textContent = `已保存 ${timeLabel(new Date())}`;
}

function setLoading(active) {
  document.querySelector('#loading-line')?.classList.toggle('active', active);
}

function toast(message, type = 'success') {
  const region = document.querySelector('#toast-region');
  if (!region) return;
  const element = document.createElement('div');
  element.className = `toast ${type === 'error' ? 'error' : ''}`;
  element.innerHTML = `${icon(type === 'error' ? 'ph-warning-circle' : 'ph-check-circle')}<span>${escapeHtml(message)}</span>`;
  region.append(element);
  window.setTimeout(() => element.remove(), 3200);
}

function showNotice(message, type = '') {
  const notice = document.querySelector('#app-notice');
  if (!notice) return;
  notice.className = `app-notice ${type}`.trim();
  notice.innerHTML = message;
}

function hideNotice() {
  document.querySelector('#app-notice')?.classList.add('hidden');
}

function monthHeader(title = monthLabel()) {
  return `
    <header class="page-header">
      <div class="month-control">
        <button class="icon-button" type="button" data-action="previous-month" aria-label="上个月">${icon('ph-caret-left')}</button>
        <h1>${escapeHtml(title)}</h1>
        <button class="icon-button" type="button" data-action="next-month" aria-label="下个月">${icon('ph-caret-right')}</button>
        <span class="today-label">${escapeHtml(todayLabel())}</span>
      </div>
      <div class="header-actions">
        <button class="icon-button" type="button" data-action="open-search" aria-label="搜索流水">${icon('ph-magnifying-glass')}</button>
        <button class="primary-button" type="button" data-action="open-transaction">${icon('ph-plus')}<span>记一笔</span></button>
      </div>
    </header>`;
}

function pageHeader(title, description, actions = '') {
  return `
    <header class="page-header">
      <div class="page-heading-block">
        <h1 class="page-title">${escapeHtml(title)}</h1>
        <p>${escapeHtml(description)}</p>
      </div>
      <div class="header-actions">${actions}</div>
    </header>`;
}

function categoryOptions(type, selected = '') {
  if (type === 'transfer') return '<option value="transfer">账户转账</option>';
  return state.categories
    .filter((category) => category.type === type)
    .map((category) => `<option value="${escapeHtml(category.id)}" ${category.id === selected ? 'selected' : ''}>${escapeHtml(category.label)}</option>`)
    .join('');
}

function accountOptions(selected = '') {
  return activeAccounts()
    .map((account) => `<option value="${escapeHtml(account.id)}" ${account.id === selected ? 'selected' : ''}>${escapeHtml(account.name)}</option>`)
    .join('');
}

function transactionRow(item, options = {}) {
  const category = getCategory(item.categoryId);
  const typeLabel = item.type === 'income' ? '收入' : item.type === 'expense' ? '支出' : '转账';
  const actions = options.actions
    ? `<div class="transaction-actions">
        <button class="row-action" type="button" data-action="edit-transaction" data-transaction-id="${escapeHtml(item.id)}" aria-label="编辑 ${escapeHtml(item.note || category.label)}">${icon('ph-pencil-simple')}</button>
        <button class="row-action danger" type="button" data-action="delete-transaction" data-transaction-id="${escapeHtml(item.id)}" aria-label="删除 ${escapeHtml(item.note || category.label)}">${icon('ph-trash')}</button>
      </div>`
    : '';
  return `
    <div class="transaction-row">
      <div class="transaction-time"><span class="category-icon ${escapeHtml(item.type)}">${icon(categoryIcon(category))}</span><span>${escapeHtml(timeLabel(item.occurredAt))}</span></div>
      <span class="transaction-type ${escapeHtml(item.type)}">${typeLabel}</span>
      <span class="transaction-title">${escapeHtml(category.label)}</span>
      <span class="transaction-account">${escapeHtml(accountName(item.accountId))}</span>
      <span class="transaction-note">${escapeHtml(item.note || '未填写备注')}</span>
      <strong class="transaction-amount ${escapeHtml(item.type)}">${escapeHtml(signedMoney(item))}</strong>
      ${actions}
    </div>`;
}

function transactionTable(items, options = {}) {
  const transactions = sortTransactions(items).slice(0, options.limit || items.length);
  if (!transactions.length) {
    return `
      <div class="empty-state">
        ${icon('ph-receipt')}
        <h3>还没有流水</h3>
        <p>先记录一笔实际收入或支出，本月汇总和报表会自动更新。</p>
        <button class="primary-button" type="button" data-action="open-transaction">${icon('ph-plus')}记录第一笔</button>
      </div>`;
  }
  const groups = new Map();
  transactions.forEach((item) => {
    const key = dateKey(item.occurredAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const head = options.actions
    ? '<div class="transaction-head"><span>日期</span><span>类型</span><span>分类</span><span>账户</span><span>备注</span><span>金额</span><span>操作</span></div>'
    : '<div class="transaction-head"><span>日期</span><span>类型</span><span>分类</span><span>账户</span><span>备注</span><span>金额</span></div>';
  const body = [...groups.values()].map((group) => `
    <div class="transaction-group">${escapeHtml(groupDateLabel(group[0].occurredAt))}</div>
    ${group.map((item) => transactionRow(item, options)).join('')}`).join('');
  return `<div class="table-scroll">${head}${body}</div>`;
}

function renderHome() {
  const stats = monthlyStats();
  const balanceRate = stats.income > 0 ? Math.max(0, (stats.balance / stats.income) * 100) : 0;
  const budgetCents = centsFromYuan(state.profile.monthlyBudget);
  const budgetRate = budgetCents > 0 ? Math.min(100, (stats.expense / budgetCents) * 100) : 0;
  const accountRows = activeAccounts().slice(0, 4).map((account) => `
    <div class="account-row">
      <span class="account-icon">${icon(accountIcon(account))}</span>
      <span class="account-main"><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(ACCOUNT_TYPE_LABELS[account.type] || '账户')}</small></span>
      <strong class="account-balance">${money(accountBalance(account.id))}</strong>
    </div>`).join('');
  return `
    ${monthHeader()}
    <section class="home-summary" aria-label="本月收支摘要">
      <div class="summary-panel summary-pair">
        <div class="summary-metric">
          <span class="summary-label">本月收入</span>
          <strong class="summary-amount income">${money(stats.income)}</strong>
          <span class="summary-note">共 ${stats.transactions.filter((item) => item.type === 'income').length} 笔收入</span>
        </div>
        <div class="summary-metric">
          <span class="summary-label">本月支出</span>
          <strong class="summary-amount expense">${money(stats.expense)}</strong>
          <span class="summary-note">共 ${stats.transactions.filter((item) => item.type === 'expense').length} 笔支出</span>
        </div>
      </div>
      <div class="summary-panel balance-panel">
        <span class="summary-label">本月结余</span>
        <strong class="summary-amount">${money(stats.balance)}</strong>
        <span class="balance-rate">结余率 ${NUMBER_FORMATTER.format(balanceRate)}%</span>
      </div>
    </section>

    <section class="home-workspace">
      <div class="content-panel transaction-table">
        <div class="panel-heading">
          <h2>最近流水</h2>
          <button class="text-button" type="button" data-view="ledger">全部流水 ${icon('ph-caret-right')}</button>
        </div>
        ${transactionTable(stats.transactions, { limit: 9 })}
      </div>

      <aside class="home-side">
        <section class="side-panel">
          <div class="panel-heading"><h3>账户概览</h3><button class="text-button" type="button" data-view="accounts">管理账户</button></div>
          <div class="panel-body">
            <div class="account-list">${accountRows || '<p class="panel-note">还没有账户。</p>'}</div>
            <div class="account-total"><span>资产合计</span><strong>${money(totalAssets())}</strong></div>
          </div>
        </section>

        <section class="side-panel">
          <div class="panel-heading"><h3>收支趋势</h3><span class="panel-note">本月</span></div>
          <div class="panel-body">
            <div class="chart-legend"><span><i class="legend-dot"></i>收入 ${money(stats.income)}</span><span><i class="legend-dot expense"></i>支出 ${money(stats.expense)}</span></div>
            <canvas class="trend-canvas" data-chart="trend" aria-label="本月累计收入和支出趋势"></canvas>
          </div>
        </section>

        <section class="side-panel budget-panel">
          <div class="panel-heading"><h3>本月预算</h3><button class="text-button" type="button" data-view="settings">设置预算</button></div>
          <div class="panel-body">
            <div class="budget-line"><span>总预算 <strong>${state.profile.monthlyBudget > 0 ? money(budgetCents) : '未设置'}</strong></span><span>已用 ${NUMBER_FORMATTER.format(budgetRate)}%</span></div>
            <div class="progress-track"><div class="progress-bar ${budgetRate >= 100 ? 'danger' : budgetRate >= 80 ? 'warning' : ''}" style="width:${budgetRate}%"></div></div>
            <div class="budget-line"><span>剩余预算</span><strong>${state.profile.monthlyBudget > 0 ? money(Math.max(0, budgetCents - stats.expense)) : '设置后显示'}</strong></div>
          </div>
        </section>
      </aside>
    </section>`;
}

function filteredLedgerTransactions() {
  const { start, end } = periodBounds('month');
  const query = state.searchTerm.trim().toLowerCase();
  return transactionsInRange(start, end).filter((item) => {
    if (state.ledgerType !== 'all' && item.type !== state.ledgerType) return false;
    if (state.ledgerAccount !== 'all' && item.accountId !== state.ledgerAccount && item.toAccountId !== state.ledgerAccount) return false;
    if (!query) return true;
    const category = getCategory(item.categoryId);
    const searchable = [category.label, accountName(item.accountId), item.note, ...(item.tags || [])].join(' ').toLowerCase();
    return searchable.includes(query);
  });
}

function renderLedger() {
  const transactions = filteredLedgerTransactions();
  return `
    ${pageHeader('流水', '按月份、类型、账户或关键词查找，每笔金额都能追溯到原始记录。', `<button class="primary-button" type="button" data-action="open-transaction">${icon('ph-plus')}记一笔</button>`)}
    <div class="toolbar">
      <div class="filter-row">
        <label class="search-input-wrap">
          ${icon('ph-magnifying-glass')}
          <input class="text-input" id="ledger-search" type="search" placeholder="搜索分类、备注或标签" value="${escapeHtml(state.searchTerm)}" />
        </label>
        <label class="field compact-select"><span>类型</span><select class="select-input" id="ledger-type-filter"><option value="all">全部类型</option><option value="expense" ${state.ledgerType === 'expense' ? 'selected' : ''}>支出</option><option value="income" ${state.ledgerType === 'income' ? 'selected' : ''}>收入</option><option value="transfer" ${state.ledgerType === 'transfer' ? 'selected' : ''}>转账</option></select></label>
        <label class="field compact-select"><span>账户</span><select class="select-input" id="ledger-account-filter"><option value="all">全部账户</option>${accountOptions(state.ledgerAccount)}</select></label>
      </div>
      <div class="month-control">
        <button class="icon-button" type="button" data-action="previous-month" aria-label="上个月">${icon('ph-caret-left')}</button>
        <strong>${escapeHtml(monthLabel())}</strong>
        <button class="icon-button" type="button" data-action="next-month" aria-label="下个月">${icon('ph-caret-right')}</button>
      </div>
    </div>
    <section class="content-panel transaction-table ledger-list">
      <div class="panel-heading"><h2>${transactions.length} 笔流水</h2><span class="panel-note">金额单位：人民币</span></div>
      ${transactionTable(transactions, { actions: true })}
    </section>`;
}

function reportCategoryData(transactions) {
  const grouped = new Map();
  transactions.filter((item) => item.type === 'expense').forEach((item) => {
    const category = getCategory(item.categoryId);
    const current = grouped.get(category.id) || { category, amount: 0 };
    current.amount += number(item.amount);
    grouped.set(category.id, current);
  });
  return [...grouped.values()].sort((a, b) => b.amount - a.amount);
}

function renderReports() {
  const { start, end } = periodBounds(state.reportPeriod);
  const stats = statsForRange(start, end);
  stats.balance = stats.income - stats.expense;
  const categories = reportCategoryData(stats.transactions);
  const maxCategory = categories[0]?.amount || 1;
  const categoryRows = categories.slice(0, 7).map(({ category, amount }) => `
    <div class="category-breakdown-row">
      <span><span class="category-icon expense">${icon(categoryIcon(category))}</span>${escapeHtml(category.label)}</span>
      <span class="mini-track"><span style="width:${Math.max(4, amount / maxCategory * 100)}%"></span></span>
      <strong>${money(amount)}</strong>
    </div>`).join('');
  return `
    ${pageHeader('报表', '周报看近期变化，月报看完整收支和分类结构。', `<button class="secondary-button" type="button" data-view="ledger">${icon('ph-list-bullets')}查看流水</button>`)}
    <div class="toolbar">
      <div class="period-switch">
        <button class="${state.reportPeriod === 'week' ? 'primary-button' : 'secondary-button'}" type="button" data-action="report-period" data-period="week">每周</button>
        <button class="${state.reportPeriod === 'month' ? 'primary-button' : 'secondary-button'}" type="button" data-action="report-period" data-period="month">每月</button>
      </div>
      <div class="month-control">
        <button class="icon-button" type="button" data-action="previous-month" aria-label="上一期">${icon('ph-caret-left')}</button>
        <strong>${state.reportPeriod === 'week' ? escapeHtml(rangeLabel(start, end)) : escapeHtml(monthLabel())}</strong>
        <button class="icon-button" type="button" data-action="next-month" aria-label="下一期">${icon('ph-caret-right')}</button>
      </div>
    </div>
    <div class="report-grid">
      <div class="report-main">
        <section class="content-panel report-summary">
          <div><span>收入</span><strong class="income">${money(stats.income)}</strong></div>
          <div><span>支出</span><strong class="expense">${money(stats.expense)}</strong></div>
          <div><span>结余</span><strong>${money(stats.balance)}</strong></div>
        </section>
        <section class="content-panel">
          <div class="panel-heading"><h2>收支变化</h2><span class="panel-note">${state.reportPeriod === 'week' ? '按日' : '按日期'}</span></div>
          <div class="panel-body"><canvas class="report-canvas" data-chart="report" aria-label="收入和支出柱状图"></canvas></div>
        </section>
      </div>
      <aside class="report-side">
        <section class="side-panel">
          <div class="panel-heading"><h3>支出分类</h3><span class="panel-note">前 ${Math.min(7, categories.length)} 项</span></div>
          <div class="panel-body category-breakdown">${categoryRows || '<p class="panel-note">这个周期还没有支出。</p>'}</div>
        </section>
        <section class="side-panel">
          <div class="panel-heading"><h3>记录情况</h3></div>
          <div class="panel-body">
            <div class="account-row"><span class="account-icon">${icon('ph-receipt')}</span><span class="account-main"><strong>${stats.transactions.length} 笔</strong><small>本期已记录流水</small></span></div>
            <div class="account-row"><span class="account-icon">${icon('ph-calendar-check')}</span><span class="account-main"><strong>${new Set(stats.transactions.map((item) => dateKey(item.occurredAt))).size} 天</strong><small>有记账的日期</small></span></div>
          </div>
        </section>
      </aside>
    </div>`;
}

function renderAccounts() {
  const cards = activeAccounts().map((account) => `
    <article class="account-card">
      <div class="account-card-top">
        <div class="account-card-title"><span class="account-icon">${icon(accountIcon(account))}</span><div><h2>${escapeHtml(account.name)}</h2><p>${escapeHtml(ACCOUNT_TYPE_LABELS[account.type] || '账户')}</p></div></div>
        <button class="row-action" type="button" data-action="edit-account" data-account-id="${escapeHtml(account.id)}" aria-label="编辑 ${escapeHtml(account.name)}">${icon('ph-pencil-simple')}</button>
      </div>
      <div class="account-card-amount">${money(accountBalance(account.id))}</div>
      <div class="account-card-footer"><span>期初余额 ${money(account.openingBalance)}</span><span>${account.includeInAssets === false ? '不计入资产' : '计入资产'}</span></div>
    </article>`).join('');
  return `
    ${pageHeader('账户', '银行卡、支付平台和现金分开记录，余额由期初金额与流水自动计算。', `<button class="primary-button" type="button" data-action="open-account">${icon('ph-plus')}添加账户</button>`)}
    <section class="summary-panel balance-panel" style="margin-bottom:18px">
      <span class="summary-label">账户资产合计</span>
      <strong class="summary-amount income">${money(totalAssets())}</strong>
      <span class="balance-rate">共 ${activeAccounts().length} 个有效账户</span>
    </section>
    <section class="account-page-list">${cards || `<div class="empty-state">${icon('ph-wallet')}<h3>还没有账户</h3><p>添加常用银行卡或支付平台后，就能追踪每笔钱从哪里来、到哪里去。</p><button class="primary-button" type="button" data-action="open-account">添加账户</button></div>`}</section>`;
}

function renderCategories() {
  const categorySection = (type, title) => {
    const items = state.categories.filter((category) => category.type === type).map((category) => `
      <div class="category-item">
        <span class="category-icon ${type}">${icon(categoryIcon(category))}</span>
        <span><strong>${escapeHtml(category.label)}</strong><small>${type === 'income' ? '收入分类' : '支出分类'}</small></span>
      </div>`).join('');
    return `<section class="category-section"><div class="panel-heading"><h2>${escapeHtml(title)}</h2><span class="panel-note">${state.categories.filter((category) => category.type === type).length} 项</span></div><div class="category-grid">${items}</div></section>`;
  };
  return `
    ${pageHeader('分类', '常用分类保持精简；确实需要时，再添加自己的分类。', `<button class="primary-button" type="button" data-action="open-category">${icon('ph-plus')}添加分类</button>`)}
    <div class="category-page-list">${categorySection('expense', '支出分类')}${categorySection('income', '收入分类')}</div>`;
}

function renderSettings() {
  const estimate = salaryEstimate();
  return `
    ${pageHeader('设置', '管理账本口径、可选工资估算和本地备份。', '')}
    <div class="settings-grid">
      <div class="settings-main">
        <section class="settings-section">
          <h2>账本设置</h2>
          <p>预算只用于提醒，不会限制记账；金额默认使用人民币。</p>
          <form id="ledger-settings-form">
            <div class="form-grid">
              <label class="field"><span>账本名称</span><input class="text-input" name="bookName" value="${escapeHtml(state.profile.bookName)}" maxlength="24" /></label>
              <label class="field"><span>每月预算</span><input class="text-input" name="monthlyBudget" type="number" min="0" step="100" value="${number(state.profile.monthlyBudget)}" /></label>
              <label class="field"><span>币种</span><select class="select-input" name="currency"><option value="CNY" selected>人民币 CNY</option></select><small class="field-hint">当前版本以单币种账本为主。</small></label>
            </div>
            <div class="form-actions"><button class="primary-button" type="submit">保存账本设置</button></div>
          </form>
        </section>

        <section class="settings-section">
          <h2>工资到手估算</h2>
          <p>这是可选工具。你也可以完全跳过，直接把实际到账金额记为收入；估算结果不会自动写入流水。</p>
          <form id="salary-estimate-form">
            <div class="form-grid">
              <label class="field"><span>税前工资</span><input class="text-input salary-input" name="gross" type="number" min="0" step="0.01" value="${number(state.profile.salaryEstimate.gross)}" /></label>
              <label class="field"><span>个人社保</span><input class="text-input salary-input" name="socialInsurance" type="number" min="0" step="0.01" value="${number(state.profile.salaryEstimate.socialInsurance)}" /></label>
              <label class="field"><span>个人公积金</span><input class="text-input salary-input" name="housingFund" type="number" min="0" step="0.01" value="${number(state.profile.salaryEstimate.housingFund)}" /></label>
              <label class="field"><span>个人所得税</span><input class="text-input salary-input" name="individualTax" type="number" min="0" step="0.01" value="${number(state.profile.salaryEstimate.individualTax)}" /></label>
              <label class="field"><span>其他扣除</span><input class="text-input salary-input" name="otherDeductions" type="number" min="0" step="0.01" value="${number(state.profile.salaryEstimate.otherDeductions)}" /></label>
              <label class="field"><span>税后补贴</span><input class="text-input salary-input" name="postTaxAllowance" type="number" min="0" step="0.01" value="${number(state.profile.salaryEstimate.postTaxAllowance)}" /></label>
            </div>
            <div class="estimate-result"><div><span>预计到手</span><strong id="salary-estimate-value">${money(centsFromYuan(estimate))}</strong></div><div class="button-row"><button class="secondary-button" type="button" data-action="use-salary-estimate">按这个金额记收入</button><button class="primary-button" type="submit">保存估算参数</button></div></div>
          </form>
        </section>
      </div>

      <aside class="settings-side">
        <section class="settings-section">
          <h2>本地数据</h2>
          <p>所有流水、账户和分类默认只保存在当前浏览器。换设备或清理浏览器前，请先导出备份。</p>
          <ul class="privacy-list">
            <li>${icon('ph-check-circle')}<span>不要求注册账号</span></li>
            <li>${icon('ph-check-circle')}<span>不会自动上传流水</span></li>
            <li>${icon('ph-check-circle')}<span>备份文件可在另一台设备导入</span></li>
          </ul>
          <div class="backup-actions"><button class="secondary-button button-full" type="button" data-action="export-data">${icon('ph-download-simple')}导出备份</button><button class="secondary-button button-full" type="button" data-action="import-data">${icon('ph-upload-simple')}导入备份</button></div>
        </section>
        <section class="settings-section danger-zone">
          <h2>清空账本</h2>
          <p>删除当前设备中的流水、账户和分类。请先导出备份；此操作不能撤销。</p>
          <button class="danger-button button-full" type="button" data-action="reset-data">${icon('ph-trash')}清空本地数据</button>
        </section>
      </aside>
    </div>`;
}

function renderError() {
  return `
    <div class="empty-state">
      ${icon('ph-warning-circle')}
      <h3>本地账本暂时打不开</h3>
      <p>${escapeHtml(state.error || '请稍后重试。')}</p>
      <button class="primary-button" type="button" data-action="retry-load">重新读取</button>
    </div>`;
}

function renderSkeleton() {
  return `
    ${monthHeader()}
    <section class="home-summary"><div class="summary-panel summary-pair"><div class="summary-metric"><span class="summary-label">正在读取本地账本</span></div><div class="summary-metric"><span class="summary-label">请稍候</span></div></div><div class="summary-panel balance-panel"><span class="summary-label">数据不会上传</span></div></section>`;
}

function render() {
  const view = document.querySelector('#app-view');
  if (!view) return;
  setLoading(state.loading);
  if (state.error) {
    view.innerHTML = renderError();
  } else if (state.loading) {
    view.innerHTML = renderSkeleton();
  } else {
    const views = {
      home: renderHome,
      ledger: renderLedger,
      reports: renderReports,
      accounts: renderAccounts,
      categories: renderCategories,
      settings: renderSettings,
    };
    view.innerHTML = (views[state.activeView] || views.home)();
  }
  document.querySelectorAll('[data-view]').forEach((item) => item.classList.toggle('active', item.dataset.view === state.activeView));
  hideNotice();
  requestAnimationFrame(drawCharts);
}

function navigate(view, options = {}) {
  if (!['home', 'ledger', 'reports', 'accounts', 'categories', 'settings'].includes(view)) view = 'home';
  state.activeView = view;
  if (location.hash !== `#${view}`) history.pushState(null, '', `#${view}`);
  render();
  document.querySelector('#main-content')?.focus({ preventScroll: true });
  if (options.focusSearch) requestAnimationFrame(() => document.querySelector('#ledger-search')?.focus());
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function shiftMonth(delta) {
  state.selectedMonth = new Date(state.selectedMonth.getFullYear(), state.selectedMonth.getMonth() + delta, 1);
  render();
}

function openDialog(content) {
  const dialog = document.querySelector('#app-dialog');
  if (!dialog) return;
  dialog.innerHTML = content;
  if (!dialog.open) dialog.showModal();
}

function closeDialog() {
  const dialog = document.querySelector('#app-dialog');
  if (dialog?.open) dialog.close();
  if (dialog) dialog.innerHTML = '';
}

function openTransactionDialog(transaction = null, prefill = {}) {
  const type = prefill.type || transaction?.type || 'expense';
  const amount = prefill.amount ?? (transaction ? yuanFromCents(transaction.amount) : '');
  const categoryId = prefill.categoryId || transaction?.categoryId || state.categories.find((category) => category.type === type)?.id || 'food';
  const accountId = prefill.accountId || transaction?.accountId || activeAccounts()[0]?.id || '';
  const occurredAt = prefill.occurredAt || transaction?.occurredAt || new Date();
  const note = prefill.note ?? transaction?.note ?? '';
  const tags = Array.isArray(transaction?.tags) ? transaction.tags.join('，') : '';
  openDialog(`
    <form class="dialog-content" id="transaction-form" data-transaction-id="${escapeHtml(transaction?.id || '')}">
      <div class="dialog-header">
        <div><h2 id="dialog-title">${transaction ? '编辑流水' : '记一笔'}</h2><p>按实际到账或实际支付金额记录，保存后立即更新月度汇总。</p></div>
        <button class="icon-button dialog-close" type="button" data-action="close-dialog" aria-label="关闭">${icon('ph-x')}</button>
      </div>
      <div class="type-segment" role="group" aria-label="流水类型">
        <button class="${type === 'expense' ? 'active' : ''}" type="button" data-action="set-transaction-type" data-type="expense">支出</button>
        <button class="${type === 'income' ? 'active' : ''}" type="button" data-action="set-transaction-type" data-type="income">收入</button>
        <button class="${type === 'transfer' ? 'active' : ''}" type="button" data-action="set-transaction-type" data-type="transfer">转账</button>
      </div>
      <input type="hidden" name="type" id="transaction-type" value="${escapeHtml(type)}" />
      <div class="dialog-form-grid">
        <label class="field amount-field"><span>¥</span><b class="field-label">金额</b><input class="text-input" name="amount" type="number" min="0.01" step="0.01" value="${escapeHtml(amount)}" placeholder="0.00" required autofocus /></label>
        <label class="field"><span>分类</span><select class="select-input" name="categoryId" id="transaction-category">${categoryOptions(type, categoryId)}</select></label>
        <label class="field"><span>账户</span><select class="select-input" name="accountId" required>${accountOptions(accountId)}</select></label>
        <label class="field ${type === 'transfer' ? '' : 'hidden'}" id="to-account-field"><span>转入账户</span><select class="select-input" name="toAccountId">${accountOptions(transaction?.toAccountId || '')}</select></label>
        <label class="field"><span>发生时间</span><input class="text-input" name="occurredAt" type="datetime-local" value="${escapeHtml(localDateTimeValue(occurredAt))}" required /></label>
        <label class="field"><span>标签（可选）</span><input class="text-input" name="tags" value="${escapeHtml(tags)}" placeholder="如：工作日、固定支出" /></label>
        <label class="field field-span-2"><span>备注</span><textarea class="text-area" name="note" placeholder="这笔钱花在了哪里，或来自哪里">${escapeHtml(note)}</textarea></label>
      </div>
      <div class="dialog-actions"><button class="secondary-button" type="button" data-action="close-dialog">取消</button><button class="primary-button" type="submit">${transaction ? '保存修改' : '保存这一笔'}</button></div>
    </form>`);
}

function updateTransactionType(type) {
  const typeInput = document.querySelector('#transaction-type');
  const categorySelect = document.querySelector('#transaction-category');
  const toAccountField = document.querySelector('#to-account-field');
  if (!typeInput || !categorySelect || !toAccountField) return;
  typeInput.value = type;
  document.querySelectorAll('[data-action="set-transaction-type"]').forEach((button) => button.classList.toggle('active', button.dataset.type === type));
  categorySelect.innerHTML = categoryOptions(type, '');
  toAccountField.classList.toggle('hidden', type !== 'transfer');
}

function openAccountDialog(account = null) {
  openDialog(`
    <form class="dialog-content" id="account-form" data-account-id="${escapeHtml(account?.id || '')}">
      <div class="dialog-header"><div><h2 id="dialog-title">${account ? '编辑账户' : '添加账户'}</h2><p>期初余额和后续流水一起决定当前余额。</p></div><button class="icon-button dialog-close" type="button" data-action="close-dialog" aria-label="关闭">${icon('ph-x')}</button></div>
      <div class="dialog-form-grid">
        <label class="field field-span-2"><span>账户名称</span><input class="text-input" name="name" value="${escapeHtml(account?.name || '')}" placeholder="如：工资卡" maxlength="30" required autofocus /></label>
        <label class="field"><span>账户类型</span><select class="select-input" name="type">${Object.entries(ACCOUNT_TYPE_LABELS).map(([value, label]) => `<option value="${value}" ${account?.type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label class="field"><span>期初余额</span><input class="text-input" name="openingBalance" type="number" step="0.01" value="${account ? yuanFromCents(account.openingBalance) : 0}" /></label>
        <label class="field field-span-2"><span>资产统计</span><select class="select-input" name="includeInAssets"><option value="true" ${account?.includeInAssets !== false ? 'selected' : ''}>计入资产合计</option><option value="false" ${account?.includeInAssets === false ? 'selected' : ''}>不计入资产合计</option></select></label>
      </div>
      <div class="dialog-actions"><button class="secondary-button" type="button" data-action="close-dialog">取消</button><button class="primary-button" type="submit">保存账户</button></div>
    </form>`);
}

function openCategoryDialog() {
  const iconOptions = [
    ['ph-fork-knife', '餐饮'], ['ph-train', '交通'], ['ph-house-line', '居住'], ['ph-shopping-bag', '购物'],
    ['ph-heartbeat', '健康'], ['ph-book-open', '学习'], ['ph-game-controller', '娱乐'], ['ph-coins', '收入'], ['ph-tag', '其他'],
  ];
  openDialog(`
    <form class="dialog-content" id="category-form">
      <div class="dialog-header"><div><h2 id="dialog-title">添加分类</h2><p>分类保持少而清楚，报表会更容易阅读。</p></div><button class="icon-button dialog-close" type="button" data-action="close-dialog" aria-label="关闭">${icon('ph-x')}</button></div>
      <div class="dialog-form-grid">
        <label class="field field-span-2"><span>分类名称</span><input class="text-input" name="label" maxlength="12" placeholder="如：宠物" required autofocus /></label>
        <label class="field"><span>类型</span><select class="select-input" name="type"><option value="expense">支出</option><option value="income">收入</option></select></label>
        <label class="field"><span>图标</span><select class="select-input" name="icon">${iconOptions.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
      </div>
      <div class="dialog-actions"><button class="secondary-button" type="button" data-action="close-dialog">取消</button><button class="primary-button" type="submit">添加分类</button></div>
    </form>`);
}

function setupCanvas(canvas, height) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(240, Math.round(rect.width));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

function cumulativeDailyData() {
  const year = state.selectedMonth.getFullYear();
  const month = state.selectedMonth.getMonth();
  const days = new Date(year, month + 1, 0).getDate();
  const values = Array.from({ length: days }, () => ({ income: 0, expense: 0 }));
  monthlyStats().transactions.forEach((item) => {
    const day = new Date(item.occurredAt).getDate() - 1;
    if (item.type === 'income') values[day].income += number(item.amount);
    if (item.type === 'expense') values[day].expense += number(item.amount);
  });
  let income = 0;
  let expense = 0;
  return values.map((value) => {
    income += value.income;
    expense += value.expense;
    return { income, expense };
  });
}

function drawLine(context, points, color, width, height, maxValue, inset) {
  if (!points.length || maxValue <= 0) return;
  context.beginPath();
  points.forEach((value, index) => {
    const x = inset + (index / Math.max(1, points.length - 1)) * (width - inset * 2);
    const y = height - inset - (value / maxValue) * (height - inset * 2);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.stroke();
}

function drawTrendChart(canvas) {
  const { context, width, height } = setupCanvas(canvas, 150);
  const data = cumulativeDailyData();
  const income = data.map((item) => item.income);
  const expense = data.map((item) => item.expense);
  const maxValue = Math.max(...income, ...expense, 100);
  const inset = 20;
  context.strokeStyle = '#e4e9e6';
  context.lineWidth = 1;
  for (let index = 0; index < 4; index += 1) {
    const y = inset + index * ((height - inset * 2) / 3);
    context.beginPath();
    context.moveTo(inset, y);
    context.lineTo(width - inset, y);
    context.stroke();
  }
  drawLine(context, income, '#13865a', width, height, maxValue, inset);
  drawLine(context, expense, '#de4d49', width, height, maxValue, inset);
  context.fillStyle = '#718078';
  context.font = '10px Inter, system-ui, sans-serif';
  context.textAlign = 'center';
  [1, 8, 15, 22, data.length].forEach((day) => {
    const index = day - 1;
    const x = inset + (index / Math.max(1, data.length - 1)) * (width - inset * 2);
    context.fillText(`${state.selectedMonth.getMonth() + 1}-${day}`, x, height - 3);
  });
}

function periodChartData() {
  const { start, end } = periodBounds(state.reportPeriod);
  const count = state.reportPeriod === 'week' ? 7 : end.getDate();
  const values = Array.from({ length: count }, () => ({ income: 0, expense: 0 }));
  transactionsInRange(start, end).forEach((item) => {
    const index = state.reportPeriod === 'week'
      ? Math.floor((new Date(item.occurredAt).setHours(0, 0, 0, 0) - new Date(start).setHours(0, 0, 0, 0)) / 86400000)
      : new Date(item.occurredAt).getDate() - 1;
    if (!values[index]) return;
    if (item.type === 'income') values[index].income += number(item.amount);
    if (item.type === 'expense') values[index].expense += number(item.amount);
  });
  return values;
}

function drawReportChart(canvas) {
  const { context, width, height } = setupCanvas(canvas, 260);
  const data = periodChartData();
  const maxValue = Math.max(...data.flatMap((item) => [item.income, item.expense]), 100);
  const insetLeft = 34;
  const insetBottom = 28;
  const top = 18;
  const plotHeight = height - top - insetBottom;
  context.strokeStyle = '#e4e9e6';
  context.fillStyle = '#718078';
  context.font = '10px Inter, system-ui, sans-serif';
  context.textAlign = 'right';
  for (let index = 0; index < 5; index += 1) {
    const y = top + index * (plotHeight / 4);
    context.beginPath();
    context.moveTo(insetLeft, y);
    context.lineTo(width - 8, y);
    context.stroke();
    const value = maxValue - index * (maxValue / 4);
    context.fillText(value >= 100000 ? `${Math.round(value / 100000)}k` : `${Math.round(value / 100)}`, insetLeft - 6, y + 3);
  }
  const slot = (width - insetLeft - 12) / data.length;
  const barWidth = Math.max(2, Math.min(10, slot * .28));
  data.forEach((item, index) => {
    const x = insetLeft + slot * index + slot / 2;
    const incomeHeight = item.income / maxValue * plotHeight;
    const expenseHeight = item.expense / maxValue * plotHeight;
    context.fillStyle = '#13865a';
    context.fillRect(x - barWidth - 1, top + plotHeight - incomeHeight, barWidth, incomeHeight);
    context.fillStyle = '#de4d49';
    context.fillRect(x + 1, top + plotHeight - expenseHeight, barWidth, expenseHeight);
  });
  context.fillStyle = '#718078';
  context.textAlign = 'center';
  const tickCount = state.reportPeriod === 'week' ? 7 : 6;
  for (let index = 0; index < tickCount; index += 1) {
    const dataIndex = Math.round(index * (data.length - 1) / Math.max(1, tickCount - 1));
    const x = insetLeft + slot * dataIndex + slot / 2;
    const label = state.reportPeriod === 'week' ? ['一', '二', '三', '四', '五', '六', '日'][dataIndex] : `${dataIndex + 1}日`;
    context.fillText(label, x, height - 7);
  }
}

function drawCharts() {
  document.querySelectorAll('[data-chart="trend"]').forEach(drawTrendChart);
  document.querySelectorAll('[data-chart="report"]').forEach(drawReportChart);
}

function updateSalaryEstimatePreview() {
  const form = document.querySelector('#salary-estimate-form');
  const output = document.querySelector('#salary-estimate-value');
  if (!form || !output) return;
  const values = Object.fromEntries(new FormData(form).entries());
  output.textContent = money(centsFromYuan(salaryEstimate(values)));
}

async function removeTransaction(transactionId) {
  const transaction = state.transactions.find((item) => item.id === transactionId);
  if (!transaction) return;
  if (!window.confirm(`确定删除“${transaction.note || getCategory(transaction.categoryId).label}”这笔流水吗？`)) return;
  if (!state.demo) await dbDelete(STORES.transactions, transactionId);
  state.transactions = state.transactions.filter((item) => item.id !== transactionId);
  render();
  toast('流水已删除。');
}

async function exportData() {
  const payload = {
    app: '打工人小账本',
    version: 2,
    exportedAt: new Date().toISOString(),
    profile: state.profile,
    categories: state.categories,
    accounts: state.accounts,
    transactions: state.transactions,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `打工人小账本-${dateKey(new Date())}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  toast('备份已导出。');
}

function validateBackup(data) {
  if (!data || typeof data !== 'object') throw new Error('文件内容不是有效备份。');
  if (!Array.isArray(data.transactions) || !Array.isArray(data.categories) || !Array.isArray(data.accounts)) throw new Error('备份缺少流水、分类或账户数据。');
}

async function importData(file) {
  const data = JSON.parse(await file.text());
  validateBackup(data);
  if (!window.confirm(`将导入 ${data.transactions.length} 笔流水，并替换当前账本数据。继续吗？`)) return;
  if (!state.demo) {
    await Promise.all([dbClear(STORES.transactions), dbClear(STORES.categories), dbClear(STORES.accounts)]);
    for (const item of data.transactions) await dbPut(STORES.transactions, item);
    for (const item of data.categories) await dbPut(STORES.categories, item);
    for (const item of data.accounts) await dbPut(STORES.accounts, item);
    await dbPut(STORES.settings, { key: 'profile', ...DEFAULT_PROFILE, ...(data.profile || {}) });
  }
  state.profile = { ...DEFAULT_PROFILE, ...(data.profile || {}), salaryEstimate: { ...DEFAULT_PROFILE.salaryEstimate, ...(data.profile?.salaryEstimate || {}) } };
  state.transactions = sortTransactions(data.transactions);
  state.categories = data.categories;
  state.accounts = data.accounts;
  render();
  toast('备份已导入。');
}

async function resetData() {
  if (!window.confirm('确定清空当前设备中的全部账本数据吗？此操作不能撤销。')) return;
  if (!state.demo) {
    await Promise.all([dbClear(STORES.transactions), dbClear(STORES.categories), dbClear(STORES.accounts)]);
    await dbPut(STORES.settings, { key: 'profile', ...DEFAULT_PROFILE });
    for (const category of DEFAULT_CATEGORIES) await dbPut(STORES.categories, category);
    for (const account of DEFAULT_ACCOUNTS) await dbPut(STORES.accounts, account);
  }
  state.profile = { ...DEFAULT_PROFILE, salaryEstimate: { ...DEFAULT_PROFILE.salaryEstimate } };
  state.transactions = [];
  state.categories = [...DEFAULT_CATEGORIES];
  state.accounts = [...DEFAULT_ACCOUNTS];
  navigate('home');
  toast('本地账本已清空。');
}

document.addEventListener('click', async (event) => {
  const viewTarget = event.target.closest('[data-view]');
  if (viewTarget) {
    event.preventDefault();
    navigate(viewTarget.dataset.view);
    return;
  }
  const actionTarget = event.target.closest('[data-action]');
  if (!actionTarget) return;
  const { action } = actionTarget.dataset;
  try {
    if (action === 'retry-load') { await loadData(); return; }
    if (action === 'open-transaction') { openTransactionDialog(); return; }
    if (action === 'close-dialog') { closeDialog(); return; }
    if (action === 'set-transaction-type') { updateTransactionType(actionTarget.dataset.type); return; }
    if (action === 'previous-month') { shiftMonth(-1); return; }
    if (action === 'next-month') { shiftMonth(1); return; }
    if (action === 'open-search') { navigate('ledger', { focusSearch: true }); return; }
    if (action === 'toggle-sidebar') {
      const shell = document.querySelector('#app-shell');
      shell?.classList.toggle('sidebar-collapsed');
      localStorage.setItem('worker-ledger-sidebar', shell?.classList.contains('sidebar-collapsed') ? 'collapsed' : 'expanded');
      return;
    }
    if (action === 'edit-transaction') {
      const transaction = state.transactions.find((item) => item.id === actionTarget.dataset.transactionId);
      if (transaction) openTransactionDialog(transaction);
      return;
    }
    if (action === 'delete-transaction') { await removeTransaction(actionTarget.dataset.transactionId); return; }
    if (action === 'open-account') { openAccountDialog(); return; }
    if (action === 'edit-account') {
      const account = state.accounts.find((item) => item.id === actionTarget.dataset.accountId);
      if (account) openAccountDialog(account);
      return;
    }
    if (action === 'open-category') { openCategoryDialog(); return; }
    if (action === 'report-period') { state.reportPeriod = actionTarget.dataset.period; render(); return; }
    if (action === 'export-data') { await exportData(); return; }
    if (action === 'import-data') { document.querySelector('#backup-file')?.click(); return; }
    if (action === 'use-salary-estimate') {
      const form = document.querySelector('#salary-estimate-form');
      const values = form ? Object.fromEntries(new FormData(form).entries()) : state.profile.salaryEstimate;
      const estimate = salaryEstimate(values);
      if (!(estimate > 0)) { toast('请先填写税前工资和个人扣除。', 'error'); return; }
      openTransactionDialog(null, { type: 'income', amount: estimate, categoryId: 'salary', note: '工资到账' });
      return;
    }
    if (action === 'reset-data') { await resetData(); }
  } catch (error) {
    toast(error instanceof Error ? error.message : '操作失败，请重试。', 'error');
  }
});

document.addEventListener('change', async (event) => {
  if (event.target.id === 'ledger-type-filter') { state.ledgerType = event.target.value; render(); }
  if (event.target.id === 'ledger-account-filter') { state.ledgerAccount = event.target.value; render(); }
  if (event.target.id === 'backup-file') {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try { await importData(file); } catch (error) { toast(error instanceof Error ? error.message : '导入失败。', 'error'); }
  }
});

document.addEventListener('input', (event) => {
  if (event.target.classList.contains('salary-input')) updateSalaryEstimatePreview();
  if (event.target.id === 'ledger-search') {
    state.searchTerm = event.target.value;
    const position = event.target.selectionStart;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      render();
      requestAnimationFrame(() => {
        const input = document.querySelector('#ledger-search');
        if (input) { input.focus(); input.setSelectionRange(position, position); }
      });
    }, 120);
  }
});

document.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  try {
    if (form.id === 'transaction-form') {
      const original = state.transactions.find((item) => item.id === form.dataset.transactionId);
      const type = String(data.get('type'));
      const amount = centsFromYuan(data.get('amount'));
      const occurredAt = parseLocalDateTime(data.get('occurredAt'));
      if (!(amount > 0)) throw new Error('金额需要大于 0。');
      if (!occurredAt) throw new Error('请选择有效的发生时间。');
      if (type === 'transfer' && data.get('accountId') === data.get('toAccountId')) throw new Error('转出和转入账户不能相同。');
      const now = new Date().toISOString();
      const transaction = {
        ...(original || {}),
        id: original?.id || id(),
        type,
        amount,
        categoryId: type === 'transfer' ? 'transfer' : String(data.get('categoryId')),
        accountId: String(data.get('accountId')),
        toAccountId: type === 'transfer' ? String(data.get('toAccountId')) : '',
        note: String(data.get('note') || '').trim(),
        tags: String(data.get('tags') || '').split(/[，,]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 8),
        occurredAt,
        source: original?.source || 'manual',
        createdAt: original?.createdAt || now,
        updatedAt: now,
      };
      await persistTransaction(transaction, original ? '流水修改已保存。' : '这笔流水已保存。');
      closeDialog();
      return;
    }
    if (form.id === 'account-form') {
      const original = state.accounts.find((item) => item.id === form.dataset.accountId);
      const name = String(data.get('name') || '').trim();
      if (!name) throw new Error('请填写账户名称。');
      const account = {
        ...(original || {}),
        id: original?.id || id(),
        name,
        type: String(data.get('type')),
        openingBalance: centsFromYuan(data.get('openingBalance')),
        includeInAssets: data.get('includeInAssets') === 'true',
        archivedAt: original?.archivedAt || null,
      };
      await persistAccount(account);
      closeDialog();
      return;
    }
    if (form.id === 'category-form') {
      const label = String(data.get('label') || '').trim();
      if (!label) throw new Error('请填写分类名称。');
      await persistCategory({ id: `custom-${id()}`, label, type: String(data.get('type')), icon: String(data.get('icon')) });
      closeDialog();
      return;
    }
    if (form.id === 'ledger-settings-form') {
      await persistProfile({ bookName: String(data.get('bookName') || '').trim() || '日常账本', monthlyBudget: Math.max(0, number(data.get('monthlyBudget'))), currency: 'CNY' }, '账本设置已保存。');
      return;
    }
    if (form.id === 'salary-estimate-form') {
      const estimateValues = {
        gross: number(data.get('gross')),
        socialInsurance: number(data.get('socialInsurance')),
        housingFund: number(data.get('housingFund')),
        individualTax: number(data.get('individualTax')),
        otherDeductions: number(data.get('otherDeductions')),
        postTaxAllowance: number(data.get('postTaxAllowance')),
      };
      await persistProfile({ salaryEstimate: estimateValues }, '工资估算参数已保存。');
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : '保存失败，请重试。', 'error');
  }
});

document.querySelector('#app-dialog')?.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeDialog();
});

window.addEventListener('hashchange', () => {
  const view = location.hash.replace('#', '');
  if (!view || view === state.activeView) return;
  state.activeView = ['home', 'ledger', 'reports', 'accounts', 'categories', 'settings'].includes(view) ? view : 'home';
  render();
});

window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(drawCharts, 140);
});

function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // 离线缓存失败不影响本地记账。
    });
  }
}

function initialize() {
  const hashView = location.hash.replace('#', '');
  if (['home', 'ledger', 'reports', 'accounts', 'categories', 'settings'].includes(hashView)) state.activeView = hashView;
  if (new URLSearchParams(location.search).get('qa') === '1') document.documentElement.dataset.qa = 'true';
  if (state.demo) state.selectedMonth = new Date(2026, 7, 1);
  if (localStorage.getItem('worker-ledger-sidebar') === 'collapsed') document.querySelector('#app-shell')?.classList.add('sidebar-collapsed');
  render();
  registerServiceWorker();
  loadData();
}

initialize();
