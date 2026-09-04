const CATEGORY_RULES = [
  { id: 'food', keywords: /早餐|午饭|午餐|晚饭|晚餐|夜宵|外卖|咖啡|奶茶|餐饮|吃饭/ },
  { id: 'commute', keywords: /公交卡|交通卡|地铁卡|地铁|公交|打车|出租|网约车|交通|通勤|加油|停车/ },
  { id: 'housing', keywords: /房租|租金|物业|住房|居住/ },
  { id: 'health', keywords: /医院|门诊|药|体检|健康/ },
  { id: 'learn', keywords: /课程|书|学习|培训|资料/ },
  { id: 'travel', keywords: /火车|高铁|机票|酒店|旅行|旅游/ },
  { id: 'subscription', keywords: /GPT|OpenAI|会员|订阅|软件服务|续费/ },
  { id: 'fun', keywords: /电影|游戏|娱乐|演出/ },
  { id: 'social', keywords: /红包|礼物|随礼|人情|请客/ },
  { id: 'daily', keywords: /日用|盒马|超市|买菜|生鲜|家政|洗衣液|垃圾桶|枕头|厨房|客厅|厕所|锅|刀具|锅铲|驱蚊器|水电|燃气|天然气|话费/ },
  { id: 'shopping', keywords: /抖音|淘宝|天猫|京东|拼多多|购物|服装|衣服|鞋|数码|电子产品|商品/ },
];

const INCOME_RULES = [
  { id: 'bonus', keywords: /奖金|年终奖|绩效/ },
  { id: 'reimburse', keywords: /报销|退款|退回|退还|返还|返款|返现/ },
  { id: 'salary', keywords: /工资|薪资|兼职|补贴|津贴/ },
];

const ACCOUNT_ALIASES = [
  { value: '农行工资卡', label: '工资卡' },
  { value: '工资卡', label: '工资卡' },
  { value: '银行卡', label: '银行卡' },
  { value: '支付宝', label: '支付宝' },
  { value: '微信', label: '微信' },
];

const CATEGORY_LABELS = {
  food: '餐饮', commute: '交通', housing: '居住', daily: '日用', shopping: '购物',
  fun: '娱乐', subscription: '订阅服务', health: '健康', learn: '学习', social: '人情',
  travel: '旅行', other: '其他', salary: '工资', bonus: '奖金', reimburse: '报销退款', 'other-income': '其他收入',
};

const COLLOQUIAL_AMOUNT_PATTERN = /(?:[¥￥]\s*)?(\d+)\s*块\s*(\d{1,2})(?!\d)/g;
const NUMBER_PATTERN = /(?:[¥￥]\s*)?(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?:\s*(万|千))?(?![\d.])/g;
const CHINESE_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CHINESE_UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };

export const AGENT_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'extract_transaction_candidates',
      description: '从用户原话中提取所有金额、日期、动作和语义线索。只读，不写入账本。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', description: '用户原始输入' } },
        required: ['text'],
      },
      strict: true,
    },
  },
  {
    type: 'function',
    function: {
      name: 'resolve_category_candidates',
      description: '根据交易语义生成可用分类候选，只读，不写入账本。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array', items: { type: 'object' }, description: '金额候选数组' },
        },
        required: ['items'],
      },
      strict: false,
    },
  },
  {
    type: 'function',
    function: {
      name: 'validate_transaction_drafts',
      description: '校验模型生成的记账草稿是否覆盖所有金额、日期和必要字段。校验失败必须修正后再返回。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          drafts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string' },
                amountYuan: { type: 'number' },
                category: { type: 'string' },
                account: { type: 'string' },
                toAccount: { type: 'string' },
                occurredAt: { type: 'string' },
                note: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
              },
              required: ['type', 'amountYuan', 'category', 'account', 'toAccount', 'occurredAt', 'note', 'tags'],
            },
          },
        },
        required: ['drafts'],
      },
      strict: false,
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_ledger',
      description: '读取当前账本上下文，供回答收入、支出、结余和分类问题。只读。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { query: { type: 'string', description: '用户的账本查询' } },
        required: ['query'],
      },
      strict: true,
    },
  },  {
    type: 'function',
    function: {
      name: 'search_transactions',
      description: '按关键词、类型或时间读取流水摘要，只读，不写入账本。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          keyword: { type: 'string', description: '商户、备注或分类关键词，可为空' },
          type: { type: 'string', enum: ['expense', 'income', 'transfer', ''], description: '流水类型，可为空' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回条数' },
        },
        required: ['keyword', 'type', 'limit'],
      },
      strict: true,
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_spending_habits',
      description: '分析账本中的消费分类、商户、频率、固定支出和异常金额，只读。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          months: { type: 'integer', minimum: 1, maximum: 24, description: '分析最近几个月，默认 3' },
        },
        required: ['months'],
      },
      strict: true,
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_user_preferences',
      description: '读取用户已经明确确认过的记账偏好，只读。',
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      strict: true,
    },
  },
];

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cents(value) {
  return Math.round(number(value) * 100);
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function baseDate(today) {
  if (today && /^\d{4}-\d{2}-\d{2}$/.test(today)) return new Date(`${today}T12:00:00`);
  return new Date();
}

function chineseAmountToNumber(value) {
  const text = String(value || '');
  const [integerText, fractionText = ''] = text.split(/[点.]/);
  let section = 0;
  let total = 0;
  let current = 0;
  for (const character of integerText) {
    if (character in CHINESE_DIGITS) current = CHINESE_DIGITS[character];
    else if (character in CHINESE_UNITS) {
      const unit = CHINESE_UNITS[character];
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
  const fraction = [...fractionText].map((character) => CHINESE_DIGITS[character]).filter((item) => item !== undefined).join('');
  return fraction ? number(`${integer}.${fraction}`) : integer;
}

function readLeadingDate(fragment, fallbackDate) {
  const relative = String(fragment).match(/^\s*(今天|昨天|前天)\s*[，,、:：-]?\s*/);
  if (relative) {
    const date = new Date(fallbackDate);
    if (relative[1] === '昨天') date.setDate(date.getDate() - 1);
    if (relative[1] === '前天') date.setDate(date.getDate() - 2);
    return { date: dateKey(date), length: relative[0].length };
  }
  const full = String(fragment).match(/^\s*(?:(\d{4})\s*[年/-]\s*)?(1[0-2]|0?[1-9])\s*(?:月|[./-])\s*(3[01]|[12]\d|0?[1-9])\s*(?:日|号)?(?!\d)\s*[，,、:：-]?\s*/);
  if (full) {
    const date = new Date(fallbackDate);
    date.setFullYear(Number(full[1] || date.getFullYear()), Number(full[2]) - 1, Number(full[3]));
    return { date: dateKey(date), length: full[0].length };
  }
  const dayOnly = String(fragment).match(/^\s*(3[01]|[12]\d|0?[1-9])\s*(?:日|号)\s*[，,、:：-]?\s*/);
  if (dayOnly) {
    const date = new Date(fallbackDate);
    date.setDate(Number(dayOnly[1]));
    return { date: dateKey(date), length: dayOnly[0].length };
  }
  return { date: dateKey(fallbackDate), length: 0 };
}

function readAmounts(text) {
  const matches = [];
  for (const match of String(text).matchAll(COLLOQUIAL_AMOUNT_PATTERN)) {
    const fraction = match[2].length === 1 ? `${match[2]}0` : match[2];
    const amountYuan = number(`${match[1]}.${fraction}`);
    if (amountYuan > 0) matches.push({ index: match.index, end: match.index + match[0].length, amountYuan });
  }
  for (const match of String(text).matchAll(NUMBER_PATTERN)) {
    if (matches.some((item) => match.index < item.end && match.index + match[0].length > item.index)) continue;
    const before = text.slice(Math.max(0, match.index - 1), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 1);
    const beforeTwo = text.slice(Math.max(0, match.index - 2), match.index);
    const afterTwo = text.slice(match.index + match[0].length, match.index + match[0].length + 2);
    if (/[年月日号点时分秒/\-]/.test(`${before}${after}`)) continue;
    if ((/[：:]/.test(after) && /\d/.test(afterTwo.slice(1))) || (/[：:]/.test(before) && /\d/.test(beforeTwo.slice(0, 1)))) continue;
    const multiplier = match[2] === '万' ? 10000 : match[2] === '千' ? 1000 : 1;
    const amountYuan = number(match[1].replaceAll(',', '')) * multiplier;
    if (amountYuan > 0) matches.push({ index: match.index, end: match.index + match[0].length, amountYuan });
  }
  const chinesePattern = /([零〇一二两三四五六七八九十百千万亿]+(?:[点.]?[零〇一二两三四五六七八九]+)?)\s*(?=[元块人民币])/g;
  for (const match of String(text).matchAll(chinesePattern)) {
    const amountYuan = chineseAmountToNumber(match[1]);
    if (amountYuan > 0) matches.push({ index: match.index, end: match.index + match[0].length, amountYuan });
  }
  return matches.sort((a, b) => a.index - b.index).filter((item, index, all) => index === 0 || item.index >= all[index - 1].end);
}

function amountClause(text, amount, amounts, index) {
  const source = String(text);
  const previousEnd = index > 0 ? amounts[index - 1].end : 0;
  const before = source.slice(0, amount.index);
  const boundaries = [...before.matchAll(/[，,、。！？!?；;:：]/g)];
  const boundaryStart = boundaries.length ? boundaries.at(-1).index + 1 : 0;
  const start = Math.max(previousEnd, boundaryStart);
  const nextIndex = amounts[index + 1]?.index ?? source.length;
  const afterAmount = source.slice(amount.end, nextIndex);
  const separatorIndex = afterAmount.search(/[，,、。！？!?；;:：]/);
  const end = separatorIndex >= 0 ? amount.end + separatorIndex : nextIndex;
  return source.slice(start, end).trim();
}

function semanticText(value) {
  return String(value || '')
    .replace(/[\d¥￥元块钱人民币\s，,、:：/\\.+-]/g, '')
    .replace(/^(?:和|以及|还有)+|(?:和|以及|还有)+$/g, '')
    .trim();
}

function inferType(text) {
  const value = String(text || '');
  if (/退款|退回|退还|返还|返款|返现|报销到账/.test(value)) return 'income';
  if (/转账|转到|转入|转出/.test(value)) return 'transfer';
  if (/工资到账|薪资到账|工资收入|薪资收入|奖金到账|兼职收入|补贴到账|收到/.test(value)) return 'income';
  return 'expense';
}

function categoryCandidates(text, type, availableCategories = []) {
  const value = String(text || '');
  const rules = type === 'income' ? INCOME_RULES : CATEGORY_RULES;
  const ranked = rules.filter((rule) => rule.keywords.test(value)).map((rule) => ({ id: rule.id, score: 1, reason: '命中语义关键词' }));
  if (type === 'income' && !ranked.length) ranked.push({ id: 'other-income', score: 0.2, reason: '未命中特定收入语义' });
  if (type === 'expense' && !ranked.length) ranked.push({ id: 'other', score: 0.2, reason: '未命中特定支出语义' });
  const allowed = availableCategories.map((item) => ({ id: item.id || item.label, label: item.label || item.id, type: item.type }));
  return ranked.map((candidate) => {
    const match = allowed.find((item) => item.id === candidate.id || item.label === candidate.id);
    return { ...candidate, label: match?.label || CATEGORY_LABELS[candidate.id] || candidate.id };
  });
}

function accountCandidates(text, availableAccounts = []) {
  const value = String(text || '').toLowerCase();
  const aliases = ACCOUNT_ALIASES.filter((alias) => value.includes(alias.value.toLowerCase())).map((alias) => alias.label);
  const named = availableAccounts.filter((account) => value.includes(String(account.name || '').toLowerCase())).map((account) => account.name);
  return [...new Set([...aliases, ...named])];
}

function stripAmount(value) {
  return String(value || '').replace(/(?:[¥￥]\s*)?\d+(?:,\d{3})*(?:\.\d{1,2})?\s*(?:万|千)?\s*(?:元|块钱|块|人民币)?/, ' ');
}

function expandWaterElectricity(body, amounts) {
  const match = String(body).match(/水电费(?:充值|缴费|缴纳)?\s*(?:各|分别)\s*(?:[¥￥]\s*)?(\d+(?:\.\d{1,2})?)\s*(?:元|块钱|块|人民币)?/);
  if (!match) return null;
  const amount = number(match[1]);
  return amounts.find((item) => cents(item.amountYuan) === cents(amount));
}

export function extractTransactionCandidates(rawText, options = {}) {
  const text = String(rawText || '').trim();
  const fallbackDate = baseDate(options.today);
  const candidates = [];
  let currentDate = dateKey(fallbackDate);
  const groups = text.replace(/\r?\n/g, '；').split(/[；;。！？!?]/).map((raw) => raw.trim()).filter(Boolean);
  for (const raw of groups) {
    const dateInfo = readLeadingDate(raw, new Date(`${currentDate}T12:00:00`));
    currentDate = dateInfo.date;
    const body = raw.slice(dateInfo.length).trim();
    const amounts = readAmounts(body);
    if (!amounts.length) continue;
    const groupHint = semanticText(body.slice(0, amounts[0].index));
    const groupType = inferType(body);
    const waterAmount = expandWaterElectricity(body, amounts);
    for (let index = 0; index < amounts.length; index += 1) {
      const amount = amounts[index];
      const clause = amountClause(body, amount, amounts, index);
      const context = semanticText(stripAmount(clause));
      const hint = context || groupHint || semanticText(body);
      const type = inferType(hint || body) || groupType;
      const isWater = waterAmount && cents(waterAmount.amountYuan) === cents(amount.amountYuan);
      const base = {
        amountYuan: amount.amountYuan,
        date: currentDate,
        sourceText: clause || body,
        typeHint: type,
        categoryCandidates: categoryCandidates(hint || body, type, options.availableCategories || []),
        accountCandidates: accountCandidates(body, options.availableAccounts || []),
        semanticHint: hint || '',
      };
      if (isWater) {
        candidates.push({ ...base, candidateId: `candidate-${candidates.length + 1}`, noteHint: '水费充值', semanticHint: '水费充值' });
        candidates.push({ ...base, candidateId: `candidate-${candidates.length + 1}`, noteHint: '电费充值', semanticHint: '电费充值' });
      } else {
        candidates.push({ ...base, candidateId: `candidate-${candidates.length + 1}`, noteHint: hint || '' });
      }
    }
  }
  return candidates;
}

export function resolveCategoryCandidates(items = [], options = {}) {
  return (Array.isArray(items) ? items : []).map((item, index) => {
    const type = ['expense', 'income', 'transfer'].includes(item.typeHint) ? item.typeHint : 'expense';
    return {
      candidateId: item.candidateId || `candidate-${index + 1}`,
      amountYuan: number(item.amountYuan),
      typeHint: type,
      candidates: type === 'transfer' ? [{ id: 'transfer', label: '转账', score: 1, reason: '账户间转移' }] : categoryCandidates(item.semanticHint || item.sourceText, type, options.availableCategories || []),
    };
  });
}

function normalizeValue(value) {
  return String(value || '').trim().replace(/[\s（）()]/g, '');
}

function availableCategory(value, type, categories) {
  if (type === 'transfer' && normalizeValue(value) === '转账') return true;
  const raw = normalizeValue(value);
  return categories.some((item) => item.type === type && (normalizeValue(item.id) === raw || normalizeValue(item.label) === raw));
}

function availableAccount(value, accounts) {
  const raw = normalizeValue(value);
  return accounts.some((item) => normalizeValue(item.id) === raw || normalizeValue(item.name) === raw);
}

function sameAmountMultiset(expected, actual) {
  if (expected.length !== actual.length) return false;
  const counts = (items) => items.reduce((map, item) => {
    const key = String(cents(item));
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map());
  const left = counts(expected);
  const right = counts(actual);
  return left.size === right.size && [...left].every(([key, count]) => right.get(key) === count);
}

function expectedCandidates(candidates) {
  return candidates.flatMap((candidate) => Array.from({ length: Math.max(1, Number(candidate.count || 1)) }, () => candidate));
}

function ledgerItems(context) {
  const value = context.ledgerContext?.analysisTransactions || context.ledgerContext?.recentTransactions || [];
  return Array.isArray(value) ? value : [];
}

function normalizedItem(item) {
  return {
    id: String(item.id || ''),
    occurredAt: item.occurredAt,
    type: item.type,
    amountYuan: number(item.amountYuan ?? item.amount),
    category: String(item.category || ''),
    account: String(item.account || ''),
    note: String(item.note || ''),
    tags: Array.isArray(item.tags) ? item.tags : [],
  };
}

function analyzeHabits(context, months = 3) {
  const items = ledgerItems(context).map(normalizedItem).filter((item) => item.type !== 'transfer' && item.amountYuan > 0);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - Math.max(1, Number(months) || 3));
  const scoped = items.filter((item) => !item.occurredAt || new Date(item.occurredAt) >= cutoff);
  const expenses = scoped.filter((item) => item.type === 'expense');
  const income = scoped.filter((item) => item.type === 'income');
  const groupBy = (values, key) => values.reduce((map, item) => {
    const name = item[key] || '未分类';
    const current = map.get(name) || { name, amountYuan: 0, count: 0 };
    current.amountYuan += item.amountYuan;
    current.count += 1;
    map.set(name, current);
    return map;
  }, new Map());
  const categories = [...groupBy(expenses, 'category').values()].sort((a, b) => b.amountYuan - a.amountYuan);
  const merchants = [...groupBy(expenses, 'note').values()].filter((item) => item.name).sort((a, b) => b.amountYuan - a.amountYuan);
  const fixed = merchants.filter((item) => item.count >= 2).slice(0, 8);
  const averageExpense = expenses.length ? expenses.reduce((sum, item) => sum + item.amountYuan, 0) / expenses.length : 0;
  const largest = [...expenses].sort((a, b) => b.amountYuan - a.amountYuan).slice(0, 5);
  return {
    months: Math.max(1, Number(months) || 3), sampleCount: scoped.length,
    expenseYuan: expenses.reduce((sum, item) => sum + item.amountYuan, 0),
    incomeYuan: income.reduce((sum, item) => sum + item.amountYuan, 0),
    averageExpenseYuan: Math.round(averageExpense * 100) / 100,
    topCategories: categories.slice(0, 8), repeatedMerchants: fixed, largestExpenses: largest,
    note: scoped.length < 8 ? '样本较少，只能做初步观察。' : '',
  };
}
export function validateTransactionDrafts(args = {}, context = {}) {
  const drafts = Array.isArray(args.drafts) ? args.drafts : [];
  const candidates = expectedCandidates(Array.isArray(context.candidates) ? context.candidates : []);
  const ledgerContext = context.ledgerContext || {};
  const categories = Array.isArray(ledgerContext.availableCategories) ? ledgerContext.availableCategories : [];
  const accounts = Array.isArray(ledgerContext.availableAccounts) ? ledgerContext.availableAccounts : [];
  const errors = [];
  const warnings = [];
  const amounts = drafts.map((draft) => number(draft.amountYuan));
  const expectedAmounts = candidates.map((candidate) => candidate.amountYuan);
  if (!drafts.length) errors.push('没有生成任何草稿。');
  if (candidates.length && !sameAmountMultiset(expectedAmounts, amounts)) {
    errors.push(`草稿金额必须完整覆盖候选金额：期望 ${expectedAmounts.join('、')}，收到 ${amounts.join('、') || '空'}`);
  }
  const usedCandidates = new Set();
  for (const [index, draft] of drafts.entries()) {
    const type = String(draft.type || '');
    if (!['expense', 'income', 'transfer'].includes(type)) errors.push(`第 ${index + 1} 笔类型无效。`);
    if (!(number(draft.amountYuan) > 0)) errors.push(`第 ${index + 1} 笔金额必须大于 0。`);
    if (!availableCategory(draft.category, type, categories)) errors.push(`第 ${index + 1} 笔分类不在可用分类中。`);
    if (!availableAccount(draft.account, accounts)) errors.push(`第 ${index + 1} 笔账户不在可用账户中。`);
    if (Number.isNaN(new Date(draft.occurredAt || '').getTime())) errors.push(`第 ${index + 1} 笔缺少合法发生时间。`);
    if (type === 'transfer' && !availableAccount(draft.toAccount, accounts)) errors.push(`第 ${index + 1} 笔转账缺少合法转入账户。`);
    const candidateIndex = candidates.findIndex((candidate, candidatePosition) => !usedCandidates.has(candidatePosition) && cents(candidate.amountYuan) === cents(draft.amountYuan));
    if (candidateIndex >= 0) {
      usedCandidates.add(candidateIndex);
      const candidate = candidates[candidateIndex];
      if (candidate.typeHint !== type) errors.push(`第 ${index + 1} 笔 ${draft.amountYuan} 元的类型应为 ${candidate.typeHint}，不是 ${type}。`);
    }
  }
  if (errors.length) return { valid: false, errors, warnings, expectedAmounts, receivedAmounts: amounts };
  return { valid: true, errors: [], warnings, expectedAmounts, receivedAmounts: amounts, message: '草稿已覆盖全部候选金额和必要字段。' };
}

export function executeAgentTool(name, args, context = {}) {
  if (name === 'extract_transaction_candidates') {
    return { candidates: extractTransactionCandidates(args?.text || context.userText || '', { today: context.ledgerContext?.today, availableCategories: context.ledgerContext?.availableCategories || [], availableAccounts: context.ledgerContext?.availableAccounts || [] }) };
  }
  if (name === 'resolve_category_candidates') {
    return { items: resolveCategoryCandidates(args?.items || [], { availableCategories: context.ledgerContext?.availableCategories || [] }) };
  }
  if (name === 'validate_transaction_drafts') return validateTransactionDrafts(args, context);
  if (name === 'query_ledger') return { query: String(args?.query || ''), ledgerContext: context.ledgerContext || {} };
  if (name === 'search_transactions') {
    const keyword = String(args?.keyword || '').trim().toLowerCase();
    const type = String(args?.type || '');
    const limit = Math.min(50, Math.max(1, Number(args?.limit) || 20));
    const items = ledgerItems(context).map(normalizedItem).filter((item) => {
      const matchesType = !type || item.type === type;
      const haystack = [item.category, item.account, item.note, ...item.tags].join(' ').toLowerCase();
      return matchesType && (!keyword || haystack.includes(keyword));
    });
    return { count: items.length, transactions: items.slice(0, limit) };
  }
  if (name === 'analyze_spending_habits') return analyzeHabits(context, args?.months);
  if (name === 'get_user_preferences') return { preferences: context.ledgerContext?.userPreferences || [] };
  throw new Error(`未知 Agent tool：${name}`);
}
