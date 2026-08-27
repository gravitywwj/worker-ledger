/* 打工人小账本：本地优先的个人收支账本。 */

const DB_NAME = 'worker-ledger';
const DB_VERSION = 4;
const STORES = {
  transactions: 'transactions',
  settings: 'profile_settings',
  categories: 'categories',
  accounts: 'accounts',
  agentMessages: 'agent_messages',
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

const DEFAULT_AGENT_CONFIG = {
  baseUrl: '',
  model: '',
  apiKey: '',
  rememberKey: false,
};

const AGENT_STORAGE_KEYS = {
  config: 'worker-ledger-agent-config',
  rememberedKey: 'worker-ledger-agent-api-key',
  sessionKey: 'worker-ledger-agent-session-key',
};

let agentVoiceRecognition = null;

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
const VALID_VIEWS = ['home', 'agent', 'ledger', 'reports', 'accounts', 'categories', 'settings'];
const AGENT_MAX_INPUT_LENGTH = 1000;

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
  agentMessages: [],
  agentSending: false,
  agentVoiceStatus: 'idle',
  agentVoiceMessage: '',
  agentConnection: 'idle',
  agentConnectionMessage: '本地基础模式可用',
  agentConfig: { ...DEFAULT_AGENT_CONFIG },
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

function readStoredJson(key, fallback = {}) {
  try {
    return JSON.parse(localStorage.getItem(key) || '') || fallback;
  } catch {
    return fallback;
  }
}

function loadAgentConfig() {
  const stored = readStoredJson(AGENT_STORAGE_KEYS.config, {});
  const rememberKey = stored.rememberKey === true;
  const apiKey = rememberKey
    ? localStorage.getItem(AGENT_STORAGE_KEYS.rememberedKey) || ''
    : sessionStorage.getItem(AGENT_STORAGE_KEYS.sessionKey) || '';
  return {
    ...DEFAULT_AGENT_CONFIG,
    baseUrl: String(stored.baseUrl || ''),
    model: String(stored.model || ''),
    rememberKey,
    apiKey,
  };
}

function saveAgentConfig(config) {
  const next = {
    ...DEFAULT_AGENT_CONFIG,
    ...config,
    baseUrl: String(config.baseUrl || '').trim().replace(/\/+$/, ''),
    model: String(config.model || '').trim(),
    apiKey: String(config.apiKey || '').trim(),
    rememberKey: config.rememberKey === true,
  };
  localStorage.setItem(AGENT_STORAGE_KEYS.config, JSON.stringify({
    baseUrl: next.baseUrl,
    model: next.model,
    rememberKey: next.rememberKey,
  }));
  if (next.rememberKey) {
    localStorage.setItem(AGENT_STORAGE_KEYS.rememberedKey, next.apiKey);
    sessionStorage.removeItem(AGENT_STORAGE_KEYS.sessionKey);
  } else {
    localStorage.removeItem(AGENT_STORAGE_KEYS.rememberedKey);
    if (next.apiKey) sessionStorage.setItem(AGENT_STORAGE_KEYS.sessionKey, next.apiKey);
    else sessionStorage.removeItem(AGENT_STORAGE_KEYS.sessionKey);
  }
  state.agentConfig = next;
  return next;
}

function hasRemoteAgentConfig() {
  return Boolean(state.agentConfig.baseUrl && state.agentConfig.model);
}

async function postJson(path, payload) {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (error instanceof TypeError) throw new Error('无法连接本地账本服务，请先运行 start.bat 并保持窗口开启。');
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试。');
  return data;
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
    agentMessages: [],
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
      const messageStore = db.objectStoreNames.contains(STORES.agentMessages)
        ? request.transaction.objectStore(STORES.agentMessages)
        : db.createObjectStore(STORES.agentMessages, { keyPath: 'id' });
      if (!messageStore.indexNames.contains('createdAt')) messageStore.createIndex('createdAt', 'createdAt');
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

function dbPutMany(storeName, values) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction(storeName, 'readwrite');
    transaction.onerror = () => reject(transaction.error || new Error('保存失败。'));
    transaction.onabort = () => reject(transaction.error || new Error('保存操作已取消。'));
    const store = transaction.objectStore(storeName);
    values.forEach((value) => store.put(value));
    transaction.oncomplete = () => resolve(values);
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
      const [profileRecord, transactions, categories, accounts, agentMessages] = await Promise.all([
        dbGet(STORES.settings, 'profile'),
        dbGetAll(STORES.transactions),
        dbGetAll(STORES.categories),
        dbGetAll(STORES.accounts),
        dbGetAll(STORES.agentMessages),
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
      state.agentMessages = agentMessages
        .filter((message) => message?.role === 'user' || message?.role === 'assistant')
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .slice(-80);
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

async function persistTransactions(transactions, successMessage = '这些流水已保存。') {
  if (!transactions.length) return;
  if (!state.demo) await dbPutMany(STORES.transactions, transactions);
  const ids = new Set(transactions.map((item) => item.id));
  state.transactions = sortTransactions([
    ...state.transactions.filter((item) => !ids.has(item.id)),
    ...transactions,
  ]);
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

async function persistAgentMessage(message) {
  if (!state.demo) await dbPut(STORES.agentMessages, message);
  const existingIndex = state.agentMessages.findIndex((item) => item.id === message.id);
  if (existingIndex >= 0) state.agentMessages[existingIndex] = message;
  else state.agentMessages.push(message);
  state.agentMessages = state.agentMessages
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(-80);
}

async function updateAgentMessage(messageId, patch) {
  const existing = state.agentMessages.find((message) => message.id === messageId);
  if (!existing) return null;
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  await persistAgentMessage(next);
  return next;
}

async function clearAgentMessages() {
  if (!state.demo) await dbClear(STORES.agentMessages);
  state.agentMessages = [];
  render();
  toast('聊天记录已清空。');
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

function agentMessage(role, content, extra = {}) {
  const now = new Date().toISOString();
  return {
    id: id(),
    role,
    content: String(content || '').trim(),
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function chineseAmountToNumber(value) {
  const normalized = String(value || '').replaceAll('\u4e24', '\u4e8c').replaceAll('\u3007', '\u96f6');
  if (!normalized || !/[\u96f6\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07\u4ebf]/.test(normalized)) return 0;
  const digits = { '\u96f6': 0, '\u4e00': 1, '\u4e8c': 2, '\u4e09': 3, '\u56db': 4, '\u4e94': 5, '\u516d': 6, '\u4e03': 7, '\u516b': 8, '\u4e5d': 9 };
  const units = { '\u5341': 10, '\u767e': 100, '\u5343': 1000, '\u4e07': 10000, '\u4ebf': 100000000 };
  const [integerText, fractionText = ''] = normalized.split(/[\u70b9.]/);
  let total = 0;
  let section = 0;
  let current = 0;
  for (const character of integerText) {
    if (character in digits) current = digits[character];
    else if (character in units) {
      const unit = units[character];
      if (unit >= 10000) {
        section += current;
        total += section * unit;
        section = 0;
      } else {
        section += (current || 1) * unit;
      }
      current = 0;
    }
  }
  const integer = total + section + current;
  const fractionDigits = [...fractionText].map((character) => digits[character]).filter((digit) => digit !== undefined).join('');
  return fractionDigits ? number(`${integer}.${fractionDigits}`) : integer;
}

function agentAmountFromText(text) {
  const currencyPrefix = text.match(/[¥￥]\s*(\d+(?:\.\d{1,2})?)/);
  if (currencyPrefix) return number(currencyPrefix[1]);
  const currencySuffix = text.match(/(\d+(?:\.\d{1,2})?)\s*(?:元|块钱|块|人民币)/);
  if (currencySuffix) return number(currencySuffix[1]);
  const chineseCurrencySuffix = text.match(/([\u96f6\u3007\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07\u4ebf]+(?:[\u70b9.]?[\u96f6\u3007\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d]+)?)\s*(?:元|块钱|块|人民币)/);
  if (chineseCurrencySuffix) return chineseAmountToNumber(chineseCurrencySuffix[1]);
  const candidates = [...text.matchAll(/\d+(?:\.\d{1,2})?/g)]
    .filter((match) => {
      const before = text.slice(Math.max(0, match.index - 1), match.index);
      const after = text.slice(match.index + match[0].length, match.index + match[0].length + 1);
      return !/[年月日号:：点时分秒/\-]/.test(`${before}${after}`);
    })
    .map((match) => number(match[0]))
    .filter((value) => value > 0);
  return candidates.at(-1) || 0;
}

function inferAgentType(text) {
  if (/转账|转到|转入|转出/.test(text)) return 'transfer';
  if (/支出|消费|花费|付款|付了|买了|购买|充值|扣款|外卖|餐饮/.test(text)) return 'expense';
  if (/收入|工资到账|薪资到账|工资收入|薪资收入|奖金到账|报销到账|退款到账|兼职收入|补贴到账|收到/.test(text)) return 'income';
  return 'expense';
}

function inferAgentCategory(text, type) {
  const rules = type === 'income'
    ? [
        ['bonus', /奖金|年终奖|绩效/],
        ['reimburse', /报销|退款|返现/],
        ['salary', /工资|薪资|兼职|补贴|津贴/],
      ]
    : [
        ['food', /早餐|午饭|午餐|晚饭|晚餐|夜宵|外卖|咖啡|奶茶|餐饮|吃饭/],
        ['commute', /公交卡|交通卡|地铁卡|地铁|公交|打车|出租|网约车|交通|通勤|加油|停车/],
        ['housing', /房租|租金|物业|住房|居住/],
        ['health', /医院|门诊|药|体检|健康/],
        ['learn', /课程|书|学习|培训|资料/],
        ['fun', /电影|游戏|娱乐|演出|旅行|GPT|OpenAI|会员|订阅|软件服务/],
        ['daily', /日用|超市|买菜|购物|话费|水电|水费|电费|燃气|枕头|家政|洗衣液|垃圾桶|厨房|客厅|厕所|锅|刀具|锅铲|驱蚊器/],
      ];
  const matched = rules.find(([, pattern]) => pattern.test(text))?.[0];
  if (matched && state.categories.some((category) => category.id === matched && category.type === type)) return matched;
  return state.categories.find((category) => category.type === type)?.id || (type === 'income' ? 'other-income' : 'other');
}

function inferAgentAccount(text, excludedId = '', fallbackId = '') {
  const normalized = text.toLowerCase();
  const aliases = [
    ['农行工资卡', 'salary-card'],
    ['微信', 'wechat'],
    ['支付宝', 'alipay'],
    ['工资卡', 'salary-card'],
  ];
  const matches = [];
  for (const [label, accountId] of aliases) {
    const index = normalized.indexOf(label.toLowerCase());
    if (index >= 0 && accountId !== excludedId && activeAccounts().some((item) => item.id === accountId)) matches.push({ accountId, index });
  }
  for (const account of activeAccounts()) {
    const index = normalized.indexOf(account.name.toLowerCase());
    if (index >= 0 && account.id !== excludedId) matches.push({ accountId: account.id, index });
  }
  matches.sort((a, b) => a.index - b.index);
  return matches[0]?.accountId
    || activeAccounts().find((item) => item.id === fallbackId && item.id !== excludedId)?.id
    || activeAccounts().find((item) => item.id !== excludedId)?.id
    || '';
}

function inferAgentOccurredAt(text) {
  const date = new Date();
  if (/前天/.test(text)) date.setDate(date.getDate() - 2);
  else if (/昨天/.test(text)) date.setDate(date.getDate() - 1);
  const dateMatch = text.match(/(?:(\d{4})\s*[年/-]\s*)?(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*(?:日|号)?/);
  if (dateMatch) date.setMonth(Number(dateMatch[2]) - 1, Number(dateMatch[3]));
  else {
    const dayMatch = text.match(/(?:^|[^\d])(\d{1,2})\s*(?:日|号)/);
    if (dayMatch) date.setDate(Number(dayMatch[1]));
  }
  const timeMatch = text.match(/(?:上午|下午|晚上|早上)?\s*(\d{1,2})[:：点时](\d{1,2})?/);
  if (timeMatch) {
    let hour = Number(timeMatch[1]);
    if (/下午|晚上/.test(timeMatch[0]) && hour < 12) hour += 12;
    date.setHours(hour, Number(timeMatch[2] || 0), 0, 0);
  }
  return date.toISOString();
}

function inferAgentNote(text, type) {
  const notes = [
    ['早餐', /早餐/], ['午餐', /午饭|午餐/], ['晚餐', /晚饭|晚餐/], ['咖啡', /咖啡/], ['奶茶', /奶茶/],
    ['地铁', /地铁/], ['公交', /公交/], ['打车', /打车|出租|网约车/], ['房租', /房租|租金/],
    ['日常采购', /超市|买菜|日用/], ['工资到账', /工资|薪资/], ['奖金到账', /奖金|绩效/],
    ['报销到账', /报销/], ['退款到账', /退款/],
  ];
  return notes.find(([, pattern]) => pattern.test(text))?.[0] || (type === 'income' ? '收入' : type === 'transfer' ? '账户转账' : '支出');
}

function normalizeAgentLabel(value) {
  return String(value || '').trim().replace(/[\s（）()]/g, '');
}

function resolveAgentCategoryId(value, type, note = '') {
  const raw = normalizeAgentLabel(value);
  const byId = state.categories.find((category) => category.id === raw && category.type === type);
  if (byId) return byId.id;
  const byLabel = state.categories.find((category) => normalizeAgentLabel(category.label) === raw && category.type === type);
  if (byLabel) return byLabel.id;
  const aliases = type === 'income'
    ? { 工资收入: 'salary', 薪资: 'salary', 报销: 'reimburse', 退款: 'reimburse', 其他: 'other-income' }
    : { 吃饭: 'food', 餐饮消费: 'food', 交通卡: 'commute', 公交卡: 'commute', 家庭用品: 'daily', 日常用品: 'daily', 订阅: 'fun' };
  const aliasId = aliases[raw];
  if (aliasId && state.categories.some((category) => category.id === aliasId && category.type === type)) return aliasId;
  return inferAgentCategory(note, type);
}

function resolveAgentAccountId(value, fallbackId = '') {
  const raw = normalizeAgentLabel(value);
  const byId = activeAccounts().find((account) => account.id === raw);
  if (byId) return byId.id;
  const byName = activeAccounts().find((account) => normalizeAgentLabel(account.name) === raw);
  if (byName) return byName.id;
  const aliases = { 农行工资卡: 'salary-card', 工资卡: 'salary-card', 银行卡: 'salary-card' };
  const aliasId = aliases[raw];
  if (aliasId && activeAccounts().some((account) => account.id === aliasId)) return aliasId;
  return activeAccounts().find((account) => account.id === fallbackId)?.id || activeAccounts()[0]?.id || '';
}

function normalizeAgentDraft(rawDraft = {}) {
  const type = ['expense', 'income', 'transfer'].includes(rawDraft.type) ? rawDraft.type : 'expense';
  const amountYuan = number(rawDraft.amountYuan ?? rawDraft.amount);
  if (!(amountYuan > 0)) return null;
  const note = String(rawDraft.note || '').trim();
  const categoryValue = rawDraft.category ?? rawDraft.categoryName ?? rawDraft.categoryLabel ?? rawDraft.categoryId;
  const accountValue = rawDraft.account ?? rawDraft.accountName ?? rawDraft.accountLabel ?? rawDraft.accountId;
  const toAccountValue = rawDraft.toAccount ?? rawDraft.toAccountName ?? rawDraft.toAccountLabel ?? rawDraft.toAccountId;
  const categoryId = type === 'transfer' ? 'transfer' : resolveAgentCategoryId(categoryValue, type, note);
  const accountId = resolveAgentAccountId(accountValue);
  const occurredAt = new Date(rawDraft.occurredAt || Date.now());
  const resolvedToAccountId = resolveAgentAccountId(toAccountValue);
  const toAccountId = type === 'transfer'
    ? resolvedToAccountId !== accountId ? resolvedToAccountId : activeAccounts().find((item) => item.id !== accountId)?.id || ''
    : '';
  return {
    type,
    amountYuan,
    categoryId,
    accountId,
    toAccountId,
    occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date().toISOString() : occurredAt.toISOString(),
    note: note || (type === 'income' ? '收入' : type === 'transfer' ? '账户转账' : '支出'),
    tags: Array.isArray(rawDraft.tags) ? rawDraft.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 8) : [],
  };
}

function splitAgentTransactionGroups(text) {
  return String(text || '')
    .replace(/\r?\n/g, '；')
    .split(/[；;]/)
    .map((fragment) => fragment.trim())
    .filter(Boolean)
    .map((fragment) => {
      const dateMatch = fragment.match(/^\s*(?:(?:\d{4})\s*[年/-]\s*)?\d{1,2}\s*(?:月\s*\d{1,2}\s*(?:日|号)?|[./-]\s*\d{1,2}\s*(?:日|号)?|(?:日|号))\s*[，,、:：-]?\s*/);
      return {
        raw: fragment,
        dateText: dateMatch?.[0] || '',
        body: fragment.slice(dateMatch?.[0]?.length || 0).trim(),
      };
    })
    .filter((group) => group.body);
}

function agentAmountMatches(text) {
  const matches = [];
  const numericPattern = /(?:[¥￥]\s*)?(\d+(?:\.\d{1,2})?)/g;
  for (const match of text.matchAll(numericPattern)) {
    const before = text.slice(Math.max(0, match.index - 1), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 1);
    const beforeTwo = text.slice(Math.max(0, match.index - 2), match.index);
    const afterTwo = text.slice(match.index + match[0].length, match.index + match[0].length + 2);
    if (/[年月日号点时分秒/\-]/.test(`${before}${after}`)) continue;
    if ((/[：:]/.test(after) && /\d/.test(afterTwo.slice(1))) || (/[：:]/.test(before) && /\d/.test(beforeTwo.slice(0, 1)))) continue;
    const amountYuan = number(match[1]);
    if (amountYuan > 0) matches.push({ index: match.index, end: match.index + match[0].length, amountYuan });
  }
  const chinesePattern = /([\u96f6\u3007\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07\u4ebf]+(?:[\u70b9.]?[\u96f6\u3007\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d]+)?)\s*(?=[元块人民币])/g;
  for (const match of text.matchAll(chinesePattern)) {
    const amountYuan = chineseAmountToNumber(match[1]);
    if (amountYuan > 0) matches.push({ index: match.index, end: match.index + match[0].length, amountYuan });
  }
  return matches
    .sort((a, b) => a.index - b.index)
    .filter((match, index, all) => index === 0 || match.index >= all[index - 1].end);
}

function inferAgentItemNote(prefix) {
  const chunks = String(prefix || '').split(/[，,、:：]/).map((chunk) => chunk.trim()).filter(Boolean);
  return (chunks.at(-1) || String(prefix || ''))
    .replace(/^[，,、:：\s元块人民币]+/, '')
    .replace(/^(?:今天|昨天|前天)\s*/, '')
    .replace(/^(?:支出|收入|消费|花费|付款|支付|内容|明细|记录)\s*[:：]?\s*/, '')
    .replace(/^(?:是|为)\s*/, '')
    .replace(/^(?:购买|买了|买)\s*/, '')
    .replace(/\s*(?:各|分别)\s*$/, '')
    .trim();
}

function waterAndElectricityEachAmount(text) {
  const match = String(text || '').match(/水电费(?:充值|缴费|缴纳)?\s*(?:各|分别)\s*(?:[¥￥]\s*)?(\d+(?:\.\d{1,2})?)\s*(?:元|块钱|块|人民币)?/);
  if (!match) return null;
  const amountIndex = match.index + match[0].lastIndexOf(match[1]);
  return {
    index: amountIndex,
    end: amountIndex + match[1].length,
    amountYuan: number(match[1]),
  };
}

function buildLocalAgentDrafts(text) {
  const drafts = [];
  const groups = splitAgentTransactionGroups(text);
  let occurredAt = new Date().toISOString();
  let accountId = '';
  for (const group of groups) {
    if (group.dateText) occurredAt = inferAgentOccurredAt(group.dateText, occurredAt);
    accountId = inferAgentAccount(`${group.raw} ${group.body}`, '', accountId);
    let cursor = 0;
    const waterEach = waterAndElectricityEachAmount(group.body);
    const detectedAmounts = agentAmountMatches(group.body);
    const amounts = waterEach
      ? [
          ...detectedAmounts.filter((amount) => amount.index !== waterEach.index),
          { ...waterEach, noteOverride: '水费充值' },
          { ...waterEach, noteOverride: '电费充值' },
        ].sort((a, b) => a.index - b.index)
      : detectedAmounts;
    for (let index = 0; index < amounts.length; index += 1) {
      const amount = amounts[index];
      const prefix = group.body.slice(cursor, amount.index);
      const nextAmount = amounts[index + 1];
      const suffix = group.body.slice(amount.end, nextAmount?.index ?? group.body.length);
      const note = amount.noteOverride || inferAgentItemNote(`${prefix} ${suffix}`) || inferAgentNote(group.body, inferAgentType(group.body));
      const type = inferAgentType(`${group.body} ${note}`);
      const draft = normalizeAgentDraft({
        type,
        amountYuan: amount.amountYuan,
        categoryId: type === 'transfer' ? 'transfer' : inferAgentCategory(note || group.body, type),
        accountId: inferAgentAccount(group.body, '', accountId),
        toAccountId: type === 'transfer' ? inferAgentAccount(group.body, accountId, '') : '',
        occurredAt,
        note,
        tags: ['Agent 记账'],
      });
      if (draft) drafts.push(draft);
      cursor = amount.end;
    }
  }
  return drafts;
}

function buildLocalAgentDraft(text) {
  return buildLocalAgentDrafts(text)[0] || null;
}

function statsForPreviousMonth() {
  const start = new Date(state.selectedMonth.getFullYear(), state.selectedMonth.getMonth() - 1, 1);
  const end = new Date(state.selectedMonth.getFullYear(), state.selectedMonth.getMonth(), 0, 23, 59, 59, 999);
  const stats = statsForRange(start, end);
  stats.balance = stats.income - stats.expense;
  return stats;
}

function localAgentAnswer(text) {
  const normalized = text.replace(/\s/g, '');
  const stats = monthlyStats();
  const previous = statsForPreviousMonth();
  const category = state.categories.find((item) => normalized.includes(item.label));
  if (category && /上月|上个月|相比|对比|变化|多|少/.test(normalized)) {
    const currentAmount = stats.transactions.filter((item) => item.type === category.type && item.categoryId === category.id).reduce((sum, item) => sum + number(item.amount), 0);
    const previousAmount = previous.transactions.filter((item) => item.type === category.type && item.categoryId === category.id).reduce((sum, item) => sum + number(item.amount), 0);
    const difference = currentAmount - previousAmount;
    const direction = difference === 0 ? '持平' : difference > 0 ? `多了 ${money(Math.abs(difference))}` : `少了 ${money(Math.abs(difference))}`;
    return { kind: 'answer', reply: `${monthLabel()}${category.label}${category.type === 'income' ? '收入' : '支出'} ${money(currentAmount)}，比上月${direction}。` };
  }
  if (/最多|最高|主要花在|支出分类/.test(normalized)) {
    const top = reportCategoryData(stats.transactions)[0];
    return top
      ? { kind: 'answer', reply: `本月支出最多的是${top.category.label}，共 ${money(top.amount)}，占本月支出的 ${NUMBER_FORMATTER.format(stats.expense ? top.amount / stats.expense * 100 : 0)}%。` }
      : { kind: 'answer', reply: '本月还没有支出记录。' };
  }
  if (/结余|剩下|剩余/.test(normalized)) return { kind: 'answer', reply: `本月收入 ${money(stats.income)}，支出 ${money(stats.expense)}，目前结余 ${money(stats.balance)}。` };
  if (/收支|账单|消费情况|花费情况/.test(normalized)) return { kind: 'answer', reply: `本月收入 ${money(stats.income)}，支出 ${money(stats.expense)}，目前结余 ${money(stats.balance)}，共记录 ${stats.transactions.length} 笔流水。` };
  if (/收入/.test(normalized) && /多少|统计|本月|这个月/.test(normalized)) return { kind: 'answer', reply: `本月共记录 ${stats.transactions.filter((item) => item.type === 'income').length} 笔收入，合计 ${money(stats.income)}。` };
  if (/花了多少|支出多少|消费多少|本月支出|这个月花/.test(normalized)) return { kind: 'answer', reply: `本月共记录 ${stats.transactions.filter((item) => item.type === 'expense').length} 笔支出，合计 ${money(stats.expense)}。` };
  if (/多少笔|记录情况/.test(normalized)) return { kind: 'answer', reply: `本月已经记录 ${stats.transactions.length} 笔流水，其中收入 ${stats.transactions.filter((item) => item.type === 'income').length} 笔、支出 ${stats.transactions.filter((item) => item.type === 'expense').length} 笔。` };
  return null;
}

function localAgentResponse(text) {
  const answer = localAgentAnswer(text);
  if (answer) return answer;
  const transactionIntent = /记|花|买|付|消费|支出|收入|工资|薪资|到账|奖金|报销|退款|转账|充值|会员|GPT|OpenAI|外卖|早餐|午饭|午餐|晚餐|地铁|公交|打车|房租/.test(text);
  if (transactionIntent) {
    const drafts = buildLocalAgentDrafts(text);
    if (!drafts.length) return { kind: 'clarify', reply: '我还没有识别到明确金额。请补充金额，例如“午餐 28 元，微信支付”。' };
    return {
      kind: 'transaction_draft',
      reply: `我识别到 ${drafts.length} 笔${drafts.every((draft) => draft.type === 'expense') ? '支出' : '收支'}草稿。请逐笔核对，确认后才会写入账本。`,
      drafts,
      ...(drafts.length === 1 ? { draft: drafts[0] } : {}),
    };
  }
  return null;
}

function speechRecognitionConstructor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function setAgentVoiceState(status, message = '') {
  state.agentVoiceStatus = status;
  state.agentVoiceMessage = message;
}

function agentVoiceErrorMessage(errorCode) {
  const messages = {
    'not-allowed': '浏览器没有授予麦克风权限，请允许后重试。',
    'audio-capture': '没有检测到可用麦克风，请检查设备后重试。',
    'no-speech': '没有听清内容，请再说一次金额、收支和支付账户。',
    'network': '语音识别服务暂时不可用，请改用文本输入。',
  };
  return messages[errorCode] || '语音输入没有完成，请改用文本输入重试。';
}

function toggleAgentVoiceInput() {
  if (agentVoiceRecognition) {
    agentVoiceRecognition.stop();
    return;
  }
  const Recognition = speechRecognitionConstructor();
  if (!Recognition) {
    toast('当前浏览器不支持语音输入，请改用文本输入。', 'error');
    return;
  }

  const input = document.querySelector('#agent-input');
  if (!input || state.agentSending) return;
  const baseText = input.value.trim();
  const recognition = new Recognition();
  let voiceFailed = false;
  agentVoiceRecognition = recognition;
  setAgentVoiceState('listening');
  render();
  const rerenderedInput = document.querySelector('#agent-input');
  if (rerenderedInput && baseText) rerenderedInput.value = baseText;

  recognition.lang = 'zh-CN';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onresult = (event) => {
    const transcript = Array.from(event.results).map((result) => result[0]?.transcript || '').join('').trim();
    const target = document.querySelector('#agent-input');
    if (!target || !transcript) return;
    target.value = [baseText, transcript].filter(Boolean).join('，').slice(0, AGENT_MAX_INPUT_LENGTH);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  };
  recognition.onerror = (event) => {
    voiceFailed = true;
    agentVoiceRecognition = null;
    setAgentVoiceState('error', agentVoiceErrorMessage(event.error));
    render();
    toast(state.agentVoiceMessage, 'error');
  };
  recognition.onend = () => {
    agentVoiceRecognition = null;
    if (voiceFailed) {
      setAgentVoiceState('idle');
      render();
      return;
    }
    const text = document.querySelector('#agent-input')?.value.trim() || '';
    const hasNewText = text && text !== baseText;
    setAgentVoiceState('idle');
    if (hasNewText && !state.agentSending) {
      sendAgentMessage(text).catch((error) => toast(error instanceof Error ? error.message : '语音记账分析失败，请重试。', 'error'));
      return;
    }
    render();
  };
  try {
    recognition.start();
  } catch (error) {
    agentVoiceRecognition = null;
    setAgentVoiceState('error', '语音输入启动失败，请检查浏览器麦克风权限。');
    render();
    toast(state.agentVoiceMessage, 'error');
  }
}

function ledgerContextForAgent() {
  const stats = monthlyStats();
  const previous = statsForPreviousMonth();
  const categories = reportCategoryData(stats.transactions).map(({ category, amount }) => ({ id: category.id, label: category.label, amountYuan: yuanFromCents(amount) }));
  return {
    selectedMonth: monthKey(state.selectedMonth),
    today: dateKey(new Date()),
    currency: 'CNY',
    currentMonth: { incomeYuan: yuanFromCents(stats.income), expenseYuan: yuanFromCents(stats.expense), balanceYuan: yuanFromCents(stats.balance), count: stats.transactions.length },
    previousMonth: { incomeYuan: yuanFromCents(previous.income), expenseYuan: yuanFromCents(previous.expense), balanceYuan: yuanFromCents(previous.balance), count: previous.transactions.length },
    categories,
    availableCategories: state.categories.map((item) => ({ label: item.label, type: item.type })),
    availableAccounts: activeAccounts().map((item) => ({ name: item.name, type: item.type })),
    recentTransactions: sortTransactions(state.transactions).slice(0, 30).map((item) => ({
      occurredAt: item.occurredAt,
      type: item.type,
      amountYuan: yuanFromCents(item.amount),
      category: getCategory(item.categoryId).label,
      account: accountName(item.accountId),
      note: item.note,
      tags: item.tags || [],
    })),
  };
}

function parseAgentModelReply(rawReply) {
  const cleaned = String(rawReply || '').replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('模型返回格式不完整。');
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!['transaction_draft', 'answer', 'clarify'].includes(parsed.kind)) throw new Error('模型返回了未知操作。');
  if (parsed.kind === 'transaction_draft') {
    const rawDrafts = Array.isArray(parsed.drafts) ? parsed.drafts : [parsed.draft];
    const drafts = rawDrafts.map((draft) => normalizeAgentDraft(draft)).filter(Boolean);
    if (!drafts.length || drafts.length !== rawDrafts.length) return { kind: 'clarify', reply: '我没有完整识别出每笔流水的金额或字段，请补充后再试。' };
    return {
      kind: parsed.kind,
      reply: String(parsed.reply || `请确认这 ${drafts.length} 笔记账草稿。`),
      drafts,
      ...(drafts.length === 1 ? { draft: drafts[0] } : {}),
    };
  }
  return { kind: parsed.kind, reply: String(parsed.reply || '我暂时没有读懂，可以换一种说法吗？') };
}

async function remoteAgentResponse() {
  const messages = state.agentMessages.slice(-12).map((message) => ({ role: message.role, content: message.content }));
  const response = await postJson('/api/agent/chat', {
    config: state.agentConfig,
    messages,
    ledgerContext: ledgerContextForAgent(),
  });
  return parseAgentModelReply(response.reply);
}

function agentDraftsMatchLocalResult(remoteDrafts, localDrafts) {
  if (remoteDrafts.length !== localDrafts.length) return false;
  return remoteDrafts.every((draft, index) => (
    draft.type === localDrafts[index].type
    && centsFromYuan(draft.amountYuan) === centsFromYuan(localDrafts[index].amountYuan)
    && draft.categoryId === localDrafts[index].categoryId
  ));
}

async function sendAgentMessage(text) {
  const content = String(text || '').trim();
  if (!content || state.agentSending) return;
  if (content.length > AGENT_MAX_INPUT_LENGTH) {
    toast(`单次输入最多 ${AGENT_MAX_INPUT_LENGTH} 个字符，请分段发送。`, 'error');
    return;
  }
  await persistAgentMessage(agentMessage('user', content));
  state.agentSending = true;
  render();
  requestAnimationFrame(scrollAgentToLatest);
  try {
    let result = null;
    if (hasRemoteAgentConfig()) {
      try {
        result = await remoteAgentResponse();
        state.agentConnection = 'connected';
        state.agentConnectionMessage = `已连接 ${state.agentConfig.model}`;
      } catch (error) {
        state.agentConnection = 'error';
        state.agentConnectionMessage = '模型暂时不可用，已切换本地模式';
        toast(error instanceof Error ? error.message : '模型暂时不可用。', 'error');
      }
    }
    const localResult = localAgentResponse(content);
    if (localResult?.kind === 'transaction_draft') {
      const remoteDrafts = result?.kind === 'transaction_draft'
        ? (Array.isArray(result.drafts) ? result.drafts : result.draft ? [result.draft] : [])
        : [];
      const localDrafts = Array.isArray(localResult.drafts) ? localResult.drafts : localResult.draft ? [localResult.draft] : [];
      if (!agentDraftsMatchLocalResult(remoteDrafts, localDrafts)) {
        result = localResult;
        if (hasRemoteAgentConfig() && state.agentConnection === 'connected') {
          state.agentConnectionMessage = `已连接 ${state.agentConfig.model} · 已校验多笔流水`;
        }
      }
    }
    result ||= localResult;
    result ||= {
      kind: 'answer',
      reply: hasRemoteAgentConfig()
        ? '我暂时没能处理这个问题。你可以换一种说法，或先检查模型连接。'
        : '目前我可以直接帮你记账和查询本月收支。配置模型后，还能理解更灵活的表达。',
    };
    const drafts = Array.isArray(result.drafts) ? result.drafts : result.draft ? [result.draft] : [];
    const draftData = drafts.length === 1
      ? { draft: drafts[0], drafts, draftStatus: 'pending' }
      : drafts.length > 1
        ? { drafts, draftStatus: 'pending' }
        : {};
    await persistAgentMessage(agentMessage('assistant', result.reply, draftData));
  } finally {
    state.agentSending = false;
    render();
    requestAnimationFrame(scrollAgentToLatest);
  }
}

function agentConnectionMeta() {
  if (state.agentConnection === 'testing') return { className: 'testing', iconName: 'ph-circle-notch', label: '正在测试连接' };
  if (state.agentConnection === 'connected') return { className: 'connected', iconName: 'ph-check-circle', label: state.agentConnectionMessage };
  if (state.agentConnection === 'error') return { className: 'error', iconName: 'ph-warning-circle', label: state.agentConnectionMessage };
  if (hasRemoteAgentConfig()) return { className: 'configured', iconName: 'ph-plugs-connected', label: `已配置 ${state.agentConfig.model}` };
  return { className: 'local', iconName: 'ph-device-mobile', label: '本地基础模式可用' };
}

function agentDraftsFromMessage(message) {
  if (Array.isArray(message.drafts)) return message.drafts.filter(Boolean);
  return message.draft ? [message.draft] : [];
}

function agentDraftTypeLabel(type) {
  return type === 'income' ? '收入' : type === 'transfer' ? '转账' : '支出';
}

function renderAgentDraftEntry(draft, index) {
  return `
    <section class="agent-draft-entry" data-agent-draft-entry data-draft-index="${index}">
      <div class="agent-draft-entry-heading"><span>第 ${index + 1} 笔 · ${escapeHtml(groupDateLabel(draft.occurredAt))}</span><strong>${agentDraftTypeLabel(draft.type)} · ${money(centsFromYuan(draft.amountYuan))}</strong></div>
      <div class="agent-draft-grid">
        <label class="field"><span>类型</span><select class="select-input agent-draft-type" name="type"><option value="expense" ${draft.type === 'expense' ? 'selected' : ''}>支出</option><option value="income" ${draft.type === 'income' ? 'selected' : ''}>收入</option><option value="transfer" ${draft.type === 'transfer' ? 'selected' : ''}>转账</option></select></label>
        <label class="field"><span>金额</span><input class="text-input" name="amount" type="number" min="0.01" step="0.01" value="${number(draft.amountYuan)}" required /></label>
        <label class="field"><span>分类</span><select class="select-input agent-draft-category" name="categoryId">${categoryOptions(draft.type, draft.categoryId)}</select></label>
        <label class="field"><span>账户</span><select class="select-input" name="accountId" required>${accountOptions(draft.accountId)}</select></label>
        <label class="field agent-draft-transfer ${draft.type === 'transfer' ? '' : 'hidden'}"><span>转入账户</span><select class="select-input" name="toAccountId">${accountOptions(draft.toAccountId)}</select></label>
        <label class="field"><span>发生时间</span><input class="text-input" name="occurredAt" type="datetime-local" value="${escapeHtml(localDateTimeValue(draft.occurredAt))}" required /></label>
        <label class="field field-span-2"><span>备注</span><input class="text-input" name="note" value="${escapeHtml(draft.note)}" maxlength="80" /></label>
      </div>
    </section>`;
}

function renderAgentDraft(message) {
  const drafts = agentDraftsFromMessage(message);
  if (!drafts.length) return '';
  const total = drafts.reduce((sum, draft) => sum + centsFromYuan(draft.amountYuan), 0);
  const countLabel = `${drafts.length} 笔`;
  const summary = drafts.map((draft) => `${escapeHtml(groupDateLabel(draft.occurredAt))} · ${escapeHtml(draft.note || getCategory(draft.categoryId).label)} · ${money(centsFromYuan(draft.amountYuan))}`).join('；');
  if (message.draftStatus === 'committed') {
    return `<div class="agent-draft-card committed"><div class="agent-draft-result">${icon('ph-check-circle')}<div><strong>已写入账本 · ${countLabel}</strong><span>${summary}</span></div></div><button class="text-button" type="button" data-view="ledger">查看流水 ${icon('ph-caret-right')}</button></div>`;
  }
  if (message.draftStatus === 'dismissed') return `<div class="agent-draft-card dismissed">${icon('ph-x-circle')}<span>这 ${countLabel} 草稿已放弃，没有写入账本。</span></div>`;
  return `
    <form class="agent-draft-card" data-agent-draft-form data-message-id="${escapeHtml(message.id)}">
      <div class="agent-draft-heading"><div>${icon('ph-receipt')}<span><strong>记账草稿 · ${countLabel}</strong><small>逐笔核对后一次性入账</small></span></div><strong class="agent-draft-amount">${money(total)}</strong></div>
      <p class="agent-draft-summary">已识别 ${countLabel}：${summary}</p>
      ${drafts.map(renderAgentDraftEntry).join('')}
      <div class="agent-draft-actions"><button class="secondary-button" type="button" data-action="dismiss-agent-draft" data-message-id="${escapeHtml(message.id)}">放弃草稿</button><button class="primary-button" type="submit">${icon('ph-check')}确认并入账 ${countLabel}</button></div>
    </form>`;
}

function renderAgentMessage(message) {
  const assistant = message.role === 'assistant';
  return `
    <article class="agent-message ${assistant ? 'assistant' : 'user'}">
      ${assistant ? `<span class="agent-avatar">${icon('ph-chat-circle-dots')}</span>` : ''}
      <div class="agent-message-content">
        <div class="agent-bubble">${escapeHtml(message.content).replaceAll('\n', '<br>')}</div>
        ${assistant ? renderAgentDraft(message) : ''}
        <time datetime="${escapeHtml(message.createdAt)}">${escapeHtml(timeLabel(message.createdAt))}</time>
      </div>
    </article>`;
}

function renderAgent() {
  const connection = agentConnectionMeta();
  const voiceListening = state.agentVoiceStatus === 'listening';
  const voiceHint = voiceListening
    ? '正在听，请说出金额、收支和支付账户…'
    : state.agentVoiceMessage || 'Enter 发送，Shift + Enter 换行；语音结束后自动整理为待审核草稿';
  const messages = state.agentMessages.length
    ? state.agentMessages.map(renderAgentMessage).join('')
    : `<article class="agent-message assistant"><span class="agent-avatar">${icon('ph-chat-circle-dots')}</span><div class="agent-message-content"><div class="agent-bubble"><strong>你好，我是账本助手。</strong><br>你可以直接说“午餐 28 元，微信支付”，也可以问“这个月花了多少”。记账草稿需要你确认后才会写入。</div></div></article>`;
  const prompts = ['今天午餐 28 元，微信支付', '本月花了多少？', '本月支出最多的是哪类？', '餐饮比上月多吗？'];
  return `
    ${pageHeader('智能助手', '一句话记账，也可以直接询问收入、支出和结余。', `<button class="secondary-button" type="button" data-action="open-agent-settings">${icon('ph-sliders-horizontal')}模型设置</button>`)}
    <div class="agent-workspace">
      <section class="agent-chat-panel" aria-label="账本助手聊天">
        <header class="agent-chat-header"><div><span class="agent-avatar">${icon('ph-chat-circle-dots')}</span><span><strong>账本助手</strong><small class="agent-status ${connection.className}">${icon(connection.iconName)}${escapeHtml(connection.label)}</small></span></div><button class="icon-button" type="button" data-action="clear-agent-chat" aria-label="清空聊天记录" title="清空聊天记录">${icon('ph-trash')}</button></header>
        <div class="agent-message-list" id="agent-message-list" aria-live="polite">
          ${messages}
          ${state.agentSending ? `<article class="agent-message assistant"><span class="agent-avatar">${icon('ph-chat-circle-dots')}</span><div class="agent-message-content"><div class="agent-bubble agent-typing"><span></span><span></span><span></span><b class="visually-hidden">正在整理账本信息</b></div></div></article>` : ''}
        </div>
        <div class="agent-mobile-prompts">${prompts.slice(0, 2).map((prompt) => `<button type="button" data-agent-prompt="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>`).join('')}</div>
        <form class="agent-composer" id="agent-chat-form">
          <label class="visually-hidden" for="agent-input">发送给账本助手</label>
          <textarea id="agent-input" name="message" rows="1" maxlength="${AGENT_MAX_INPUT_LENGTH}" placeholder="说一笔收支，或问问本月账单" ${state.agentSending ? 'disabled' : ''}></textarea>
          <button class="agent-voice-button ${voiceListening ? 'listening' : ''}" type="button" data-action="toggle-agent-voice" ${state.agentSending ? 'disabled' : ''} aria-label="${voiceListening ? '结束语音输入' : '开始语音输入'}" aria-pressed="${voiceListening}" title="${voiceListening ? '结束语音输入' : '开始语音输入'}">${icon(voiceListening ? 'ph-stop' : 'ph-microphone')}</button>
          <button class="agent-send-button" type="submit" ${state.agentSending ? 'disabled' : ''} aria-label="发送消息">${icon(state.agentSending ? 'ph-circle-notch' : 'ph-arrow-up')}</button>
          <small><span>${voiceHint}</span><span id="agent-input-count">0/${AGENT_MAX_INPUT_LENGTH}</span></small>
        </form>
      </section>
      <aside class="agent-side">
        <section class="side-panel agent-methods-card"><div class="panel-heading"><h3>记录方法</h3><span class="agent-methods-badge">先审核再入账</span></div><div class="panel-body agent-method-list">
          <button class="record-method-item" type="button" data-action="open-transaction">${icon('ph-pencil-simple')}<span><strong>手动填写</strong><small>自己填写金额、类型、分类和账户</small></span>${icon('ph-caret-right')}</button>
          <div class="record-method-item">${icon('ph-text-aa')}<span><strong>文本输入</strong><small>一句话自动识别收支、金额、分类、账户和备注</small></span></div>
          <div class="record-method-item">${icon('ph-microphone')}<span><strong>语音输入</strong><small>说完自动转写并整理成待审核草稿</small></span></div>
        </div></section>
        <section class="side-panel agent-connection-card"><div class="panel-heading"><h3>模型连接</h3><span class="agent-status ${connection.className}">${icon(connection.iconName)}${escapeHtml(connection.label)}</span></div><div class="panel-body"><p>常见记账与查账可在本地完成。连接兼容模型后，可以理解更灵活的表达。</p><button class="secondary-button button-full" type="button" data-action="open-agent-settings">${icon('ph-plugs-connected')}配置并测试连接</button></div></section>
        <section class="side-panel"><div class="panel-heading"><h3>试着这样问</h3></div><div class="panel-body agent-prompt-list">${prompts.map((prompt) => `<button type="button" data-agent-prompt="${escapeHtml(prompt)}">${icon('ph-arrow-bend-down-right')}<span>${escapeHtml(prompt)}</span></button>`).join('')}</div></section>
        <section class="side-panel"><div class="panel-heading"><h3>数据边界</h3></div><div class="panel-body agent-privacy-note">${icon('ph-shield-check')}<p>写入前需要确认。模型只会收到必要汇总与近期流水，API Key 不会进入账本备份。</p></div></section>
      </aside>
    </div>`;
}

function scrollAgentToLatest() {
  const list = document.querySelector('#agent-message-list');
  if (list) list.scrollTop = list.scrollHeight;
}

async function testAgentConnection(config) {
  state.agentConnection = 'testing';
  state.agentConnectionMessage = '正在测试连接';
  render();
  try {
    await postJson('/api/agent/test', { config });
    state.agentConnection = 'connected';
    state.agentConnectionMessage = `已连接 ${config.model}`;
    render();
    toast('模型连接成功。');
  } catch (error) {
    state.agentConnection = 'error';
    state.agentConnectionMessage = '连接测试失败';
    render();
    throw error;
  }
}

async function confirmAgentDraft(form) {
  if (form.dataset.submitting === 'true') return;
  form.dataset.submitting = 'true';
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton) submitButton.disabled = true;
  try {
    const entries = [...form.querySelectorAll('[data-agent-draft-entry]')];
    if (!entries.length) throw new Error('没有可确认的记账草稿。');
    const read = (entry, name) => entry.querySelector(`[name="${name}"]`)?.value || '';
    const drafts = entries.map((entry) => {
      const type = String(read(entry, 'type'));
      const amount = centsFromYuan(read(entry, 'amount'));
      const occurredAt = parseLocalDateTime(read(entry, 'occurredAt'));
      const accountId = String(read(entry, 'accountId'));
      const toAccountId = type === 'transfer' ? String(read(entry, 'toAccountId')) : '';
      if (!['expense', 'income', 'transfer'].includes(type)) throw new Error('请为每笔流水选择有效类型。');
      if (!(amount > 0)) throw new Error('每笔金额都需要大于 0。');
      if (!occurredAt) throw new Error('请选择每笔流水的有效发生时间。');
      if (!accountId) throw new Error('请为每笔流水选择账户。');
      if (type === 'transfer' && (!toAccountId || accountId === toAccountId)) throw new Error('请选择不同的转入账户。');
      return {
        type,
        amount,
        categoryId: type === 'transfer' ? 'transfer' : String(read(entry, 'categoryId')),
        accountId,
        toAccountId,
        occurredAt,
        note: String(read(entry, 'note')).trim(),
        tags: ['Agent 记账'],
      };
    });
    const now = new Date().toISOString();
    const transactions = drafts.map((draft) => ({
      id: id(),
      ...draft,
      source: 'agent',
      createdAt: now,
      updatedAt: now,
    }));
    const committedDrafts = transactions.map((transaction) => ({
      type: transaction.type,
      amountYuan: yuanFromCents(transaction.amount),
      categoryId: transaction.categoryId,
      accountId: transaction.accountId,
      toAccountId: transaction.toAccountId,
      occurredAt: transaction.occurredAt,
      note: transaction.note,
      tags: transaction.tags,
    }));
    await persistTransactions(transactions, `Agent ${transactions.length} 笔草稿已确认入账。`);
    await updateAgentMessage(form.dataset.messageId, transactions.length === 1
      ? { draft: committedDrafts[0], drafts: committedDrafts, draftStatus: 'committed' }
      : { drafts: committedDrafts, draftStatus: 'committed' });
    render();
    requestAnimationFrame(scrollAgentToLatest);
  } catch (error) {
    delete form.dataset.submitting;
    if (submitButton) submitButton.disabled = false;
    throw error;
  }
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
  const connection = agentConnectionMeta();
  return `
    ${pageHeader('设置', '管理账本口径、模型连接、可选工资估算和本地备份。', '')}
    <div class="settings-grid">
      <div class="settings-main">
        <section class="settings-section" id="agent-model-settings">
          <div class="settings-title-row"><div><h2>Agent 模型连接</h2><p>兼容 OpenAI 风格的聊天接口，也可填写支持该接口的本地模型地址。DeepSeek V4 Flash 可使用官方地址和模型 ID。</p></div><span class="agent-status ${connection.className}">${icon(connection.iconName)}${escapeHtml(connection.label)}</span></div>
          <form id="agent-settings-form" autocomplete="off">
            <div class="form-grid">
              <label class="field field-span-2"><span>API 地址</span><input class="text-input" name="baseUrl" type="url" inputmode="url" value="${escapeHtml(state.agentConfig.baseUrl)}" placeholder="例如：https://api.deepseek.com" /><small class="field-hint">填写基础地址，不要包含 /chat/completions；DeepSeek 使用 https://api.deepseek.com。</small></label>
              <label class="field"><span>模型名称</span><input class="text-input" name="model" value="${escapeHtml(state.agentConfig.model)}" placeholder="例如：deepseek-v4-flash" spellcheck="false" /></label>
              <label class="field"><span>API Key</span><span class="secret-input"><input class="text-input" name="apiKey" type="password" value="${escapeHtml(state.agentConfig.apiKey)}" placeholder="本地模型可留空" autocomplete="new-password" /><button class="icon-button" type="button" data-action="toggle-agent-key" aria-label="显示 API Key">${icon('ph-eye')}</button></span></label>
              <label class="check-field field-span-2"><input type="checkbox" name="rememberKey" ${state.agentConfig.rememberKey ? 'checked' : ''} /><span><strong>在这台设备记住 API Key</strong><small>关闭时只保留到当前浏览器会话结束；API Key 不会进入账本备份。</small></span></label>
            </div>
            <div class="form-actions"><button class="secondary-button" type="button" data-action="clear-agent-config">清除配置</button><button class="primary-button" type="submit" ${state.agentConnection === 'testing' ? 'disabled' : ''}>${state.agentConnection === 'testing' ? `${icon('ph-circle-notch')}正在测试` : `${icon('ph-plugs-connected')}保存并测试连接`}</button></div>
          </form>
        </section>

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
            <li>${icon('ph-check-circle')}<span>不会自动同步或上传完整账本</span></li>
            <li>${icon('ph-check-circle')}<span>使用外部模型时，仅在提问后发送必要汇总与近期流水</span></li>
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
      agent: renderAgent,
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
  if (!VALID_VIEWS.includes(view)) view = 'home';
  state.activeView = view;
  if (location.hash !== `#${view}`) history.pushState(null, '', `#${view}`);
  render();
  document.querySelector('#main-content')?.focus({ preventScroll: true });
  if (options.focusSearch) requestAnimationFrame(() => document.querySelector('#ledger-search')?.focus());
  if (view === 'agent') requestAnimationFrame(scrollAgentToLatest);
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
    await Promise.all([dbClear(STORES.transactions), dbClear(STORES.categories), dbClear(STORES.accounts), dbClear(STORES.agentMessages)]);
    for (const item of data.transactions) await dbPut(STORES.transactions, item);
    for (const item of data.categories) await dbPut(STORES.categories, item);
    for (const item of data.accounts) await dbPut(STORES.accounts, item);
    await dbPut(STORES.settings, { key: 'profile', ...DEFAULT_PROFILE, ...(data.profile || {}) });
  }
  state.profile = { ...DEFAULT_PROFILE, ...(data.profile || {}), salaryEstimate: { ...DEFAULT_PROFILE.salaryEstimate, ...(data.profile?.salaryEstimate || {}) } };
  state.transactions = sortTransactions(data.transactions);
  state.categories = data.categories;
  state.accounts = data.accounts;
  state.agentMessages = [];
  render();
  toast('备份已导入。');
}

async function resetData() {
  if (!window.confirm('确定清空当前设备中的全部账本数据吗？此操作不能撤销。')) return;
  if (!state.demo) {
    await Promise.all([dbClear(STORES.transactions), dbClear(STORES.categories), dbClear(STORES.accounts), dbClear(STORES.agentMessages)]);
    await dbPut(STORES.settings, { key: 'profile', ...DEFAULT_PROFILE });
    for (const category of DEFAULT_CATEGORIES) await dbPut(STORES.categories, category);
    for (const account of DEFAULT_ACCOUNTS) await dbPut(STORES.accounts, account);
  }
  state.profile = { ...DEFAULT_PROFILE, salaryEstimate: { ...DEFAULT_PROFILE.salaryEstimate } };
  state.transactions = [];
  state.agentMessages = [];
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
  const promptTarget = event.target.closest('[data-agent-prompt]');
  if (promptTarget) {
    try {
      await sendAgentMessage(promptTarget.dataset.agentPrompt);
    } catch (error) {
      toast(error instanceof Error ? error.message : '发送失败，请重试。', 'error');
    }
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
    if (action === 'open-agent-settings') {
      navigate('settings');
      requestAnimationFrame(() => document.querySelector('#agent-model-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      return;
    }
    if (action === 'toggle-agent-voice') { toggleAgentVoiceInput(); return; }
    if (action === 'clear-agent-chat') {
      if (!state.agentMessages.length) { toast('当前没有聊天记录。'); return; }
      if (window.confirm('清空当前设备中的 Agent 聊天记录吗？账本流水不会受影响。')) await clearAgentMessages();
      return;
    }
    if (action === 'dismiss-agent-draft') {
      await updateAgentMessage(actionTarget.dataset.messageId, { draftStatus: 'dismissed' });
      render();
      toast('草稿已放弃，没有写入账本。');
      return;
    }
    if (action === 'toggle-agent-key') {
      const input = actionTarget.closest('.secret-input')?.querySelector('input');
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
      actionTarget.setAttribute('aria-label', input.type === 'password' ? '显示 API Key' : '隐藏 API Key');
      actionTarget.innerHTML = icon(input.type === 'password' ? 'ph-eye' : 'ph-eye-slash');
      return;
    }
    if (action === 'clear-agent-config') {
      saveAgentConfig(DEFAULT_AGENT_CONFIG);
      state.agentConnection = 'idle';
      state.agentConnectionMessage = '本地基础模式可用';
      render();
      toast('模型配置已清除，本地基础模式仍可使用。');
      return;
    }
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
  if (event.target.classList.contains('agent-draft-type')) {
    const entry = event.target.closest('[data-agent-draft-entry]');
    const type = event.target.value;
    const category = entry?.querySelector('.agent-draft-category');
    if (category) category.innerHTML = categoryOptions(type, '');
    entry?.querySelector('.agent-draft-transfer')?.classList.toggle('hidden', type !== 'transfer');
  }
  if (event.target.id === 'backup-file') {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try { await importData(file); } catch (error) { toast(error instanceof Error ? error.message : '导入失败。', 'error'); }
  }
});

document.addEventListener('input', (event) => {
  if (event.target.classList.contains('salary-input')) updateSalaryEstimatePreview();
  if (event.target.id === 'agent-input') {
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(132, event.target.scrollHeight)}px`;
    const counter = document.querySelector('#agent-input-count');
    if (counter) {
      counter.textContent = `${event.target.value.length}/${AGENT_MAX_INPUT_LENGTH}`;
      counter.classList.toggle('limit', event.target.value.length >= AGENT_MAX_INPUT_LENGTH);
    }
  }
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
    if (form.id === 'agent-chat-form') {
      await sendAgentMessage(data.get('message'));
      return;
    }
    if (form.matches('[data-agent-draft-form]')) {
      await confirmAgentDraft(form);
      return;
    }
    if (form.id === 'agent-settings-form') {
      const config = saveAgentConfig({
        baseUrl: data.get('baseUrl'),
        model: data.get('model'),
        apiKey: data.get('apiKey'),
        rememberKey: data.get('rememberKey') === 'on',
      });
      if (!config.baseUrl || !config.model) throw new Error('请填写 API 地址和模型名称。');
      await testAgentConnection(config);
      return;
    }
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

document.addEventListener('keydown', (event) => {
  if (event.target.id !== 'agent-input' || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  event.target.form?.requestSubmit();
});

document.querySelector('#app-dialog')?.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeDialog();
});

window.addEventListener('hashchange', () => {
  const view = location.hash.replace('#', '');
  if (!view || view === state.activeView) return;
  state.activeView = VALID_VIEWS.includes(view) ? view : 'home';
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
  if (VALID_VIEWS.includes(hashView)) state.activeView = hashView;
  state.agentConfig = loadAgentConfig();
  if (new URLSearchParams(location.search).get('qa') === '1') document.documentElement.dataset.qa = 'true';
  if (state.demo) state.selectedMonth = new Date(2026, 7, 1);
  if (localStorage.getItem('worker-ledger-sidebar') === 'collapsed') document.querySelector('#app-shell')?.classList.add('sidebar-collapsed');
  render();
  registerServiceWorker();
  loadData();
}

initialize();
