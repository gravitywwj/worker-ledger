// Browser and Agent share deterministic product validation and price calculations.
export const PRODUCT_UNITS = {
  ml: { dimension: 'volume', factor: 1, base: 'ml', display: '100 ml', scale: 100 },
  L: { dimension: 'volume', factor: 1000, base: 'ml', display: '100 ml', scale: 100 },
  g: { dimension: 'weight', factor: 1, base: 'g', display: 'kg', scale: 1000 },
  kg: { dimension: 'weight', factor: 1000, base: 'g', display: 'kg', scale: 1000 },
  '斤': { dimension: 'weight', factor: 500, base: 'g', display: 'kg', scale: 1000 },
  '个': { dimension: 'count', factor: 1, base: '个', display: '个', scale: 1 },
  '片': { dimension: 'count', factor: 1, base: '片', display: '片', scale: 1 },
  '粒': { dimension: 'count', factor: 1, base: '粒', display: '粒', scale: 1 },
};
export const DEFAULT_PRODUCT_CATEGORIES = [
  { id: 'pc-drinks', name: '酒水', dimension: 'volume', baseUnit: 'ml' },
  { id: 'pc-food', name: '食品', dimension: 'weight', baseUnit: 'g' },
  { id: 'pc-cleaning', name: '清洁用品', dimension: 'volume', baseUnit: 'ml' },
  { id: 'pc-count', name: '计件用品', dimension: 'count', baseUnit: '个' },
];
export const productKey = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const text = (value) => String(value || '').trim();
export const purchaseDate = (value) => { const date = new Date(value); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; };
const uid = () => globalThis.crypto.randomUUID();

export function normalizeProductItems(rawItems = [], { amount, type = 'expense', makeId = uid } = {}) {
  if (!Array.isArray(rawItems)) throw new Error('商品明细必须是数组。');
  if (rawItems.length > 50) throw new Error('一笔流水最多记录 50 条商品明细。');
  if (rawItems.length && type !== 'expense') throw new Error('商品明细只适用于支出，请先移除明细再修改流水类型。');
  const seen = new Set();
  const items = rawItems.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('商品明细格式无效。');
    const unit = text(raw.unit);
    const nameSnapshot = text(raw.nameSnapshot || raw.name);
    const categoryName = text(raw.categoryName);
    const quantity = Number(raw.quantity);
    const unitSize = Number(raw.unitSize);
    const paidAmount = raw.paidAmount !== undefined ? Number(raw.paidAmount) : Math.round(Number(raw.paidAmountYuan) * 100);
    if (categoryName.length > 30 || text(raw.brand).length > 60 || text(raw.variant).length > 60) throw new Error('商品品类、品牌或款式过长。');
    if (raw.paidAmount === undefined && Math.abs(Number(raw.paidAmountYuan) * 100 - paidAmount) > 0.000001) throw new Error('商品总价最多两位小数。');
    if (!nameSnapshot || nameSnapshot.length > 100) throw new Error('请填写 1–100 字的商品名称。');
    if (!categoryName && !raw.productCategoryId) throw new Error('请填写商品品类。');
    if (!PRODUCT_UNITS[unit]) throw new Error('请选择容量、重量或计件单位。');
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) throw new Error('包装数量必须是正整数；散装商品填 1，重量填在单件规格。');
    if (!Number.isFinite(unitSize) || unitSize <= 0) throw new Error('单件规格必须大于 0。');
    if (PRODUCT_UNITS[unit].dimension === 'count' && !Number.isInteger(unitSize)) throw new Error('计件规格必须是正整数。');
    const total = quantity * unitSize * PRODUCT_UNITS[unit].factor;
    if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) throw new Error('商品总规格过大。');
    if (!Number.isSafeInteger(paidAmount) || paidAmount <= 0) throw new Error('商品实付总价必须大于 0，最多两位小数。');
    const itemId = text(raw.id) || makeId();
    if (seen.has(itemId)) throw new Error('商品明细 ID 重复。');
    seen.add(itemId);
    if (raw.priceBasis && !['actual', 'unallocated'].includes(raw.priceBasis)) throw new Error('商品价格口径无效。');
    return { id: itemId, productId: text(raw.productId), productCategoryId: text(raw.productCategoryId),
      nameSnapshot, categoryName, brand: text(raw.brand), variant: text(raw.variant), quantity, unitSize, unit,
      paidAmount, priceBasis: raw.priceBasis || 'actual' };
  });
  const sum = items.reduce((value, item) => value + item.paidAmount, 0);
  if (!Number.isSafeInteger(sum)) throw new Error('商品金额合计过大。');
  if (amount !== undefined && sum > amount) throw new Error('商品明细合计不能超过账单总额，请核对优惠后的价格。');
  return items;
}

export function prepareProductTransactions(transactions, products = [], categories = [], makeId = uid) {
  const nextProducts = products.map((item) => ({ ...item }));
  const nextCategories = categories.map((item) => ({ ...item }));
  const prepared = transactions.map((transaction) => ({ ...transaction, items:
    normalizeProductItems(transaction.items || [], { amount: transaction.amount, type: transaction.type, makeId }).map((item) => {
      const spec = PRODUCT_UNITS[item.unit];
      let category = nextCategories.find((entry) => entry.id === item.productCategoryId);
      if (!category) category = nextCategories.find((entry) => productKey(entry.name) === productKey(item.categoryName) && entry.dimension === spec.dimension && entry.baseUnit === spec.base);
      if (!category) {
        if (!item.categoryName) throw new Error('商品引用的品类不存在。');
        category = { id: makeId(), name: item.categoryName, dimension: spec.dimension, baseUnit: spec.base };
        nextCategories.push(category);
      }
      if (category.dimension !== spec.dimension || category.baseUnit !== spec.base) throw new Error('商品品类与规格单位不一致。');
      const identity = (entry) => entry.productCategoryId === category.id && productKey(entry.name) === productKey(item.nameSnapshot)
        && productKey(entry.brand) === productKey(item.brand) && productKey(entry.variant) === productKey(item.variant);
      let product = nextProducts.find((entry) => entry.id === item.productId && identity(entry));
      if (!product) product = nextProducts.find(identity);
      if (!product) {
        product = { id: makeId(), productCategoryId: category.id, name: item.nameSnapshot, brand: item.brand, variant: item.variant, aliases: [] };
        nextProducts.push(product);
      }
      return { ...item, productId: product.id, productCategoryId: category.id, categoryName: category.name };
    }) }));
  return { transactions: prepared, products: nextProducts, productCategories: nextCategories };
}

export function unitPrice(item) {
  const spec = PRODUCT_UNITS[item.unit];
  if (!spec) throw new Error('不支持的单位。');
  const totalSize = item.quantity * item.unitSize * spec.factor;
  return { totalSize, baseUnit: spec.base, displayUnit: spec.display, scale: spec.scale,
    pricePerBase: item.paidAmount / 100 / totalSize, displayPrice: item.paidAmount / 100 / totalSize * spec.scale };
}

export function isProductQuery(input) {
  return /单价|比价|划算|便宜|贵不贵|贵了|省多少|每\s*(?:毫升|ml|升|克|kg|公斤|斤|个|片|粒).*(?:多少|价格)|历史.*价格|买过.*(?:多少|价格)|同款.*(?:价格|对比)|同类.*(?:价格|对比)/i.test(input);
}
const unitToken = '(ml|毫升|kg|公斤|千克|g|克|L|升|斤|个|片|粒)';
const canonicalUnit = (value) => ({ ml: 'ml', 毫升: 'ml', l: 'L', 升: 'L', g: 'g', 克: 'g', kg: 'kg', 公斤: 'kg', 千克: 'kg' }[value.toLowerCase()] || value);
export function parseProductQuote(input) {
  const source = String(input || '');
  const sizes = [...source.matchAll(new RegExp('(\\d+(?:\\.\\d+)?)\\s*' + unitToken + '(?![a-z])', 'gi'))];
  const amounts = [...source.matchAll(/(\d+(?:\.\d{1,2})?)\s*(?:元|块|人民币)/g)];
  if (!sizes.length && !amounts.length) return null;
  if (!sizes.length) return null;
  if (!amounts.length) return { error: '请补充这些商品的实付总价，例如每瓶 980 ml，2 瓶共 142 元。' };
  if (sizes.length !== 1 || amounts.length !== 1) return { error: '请一次提供一个报价，写清每件规格、数量和全部商品总价。' };
  if (/\d+\s*(?:箱|组|套)|每箱|每组|每套/.test(source)) return { error: '多层包装请先换算成总容量、总重量或总件数，再提供总价。' };
  const size = sizes[0];
  const count = source.match(/(\d+|两|二|一|三|四|五|六|七|八|九|十)\s*(?:瓶|包|袋|盒|罐|件)/);
  const multiply = source.match(/(?:×|\*|x)\s*(\d+)/i);
  const countValue = count ? ({ 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[count[1]] || Number(count[1])) : multiply ? Number(multiply[1]) : null;
  const totalSpecified = /总容量|总重量|合计.*(?:ml|毫升|克|kg)|共\s*\d+(?:\.\d+)?\s*(?:ml|毫升|kg|克)/i.test(source);
  if (countValue > 1 && !totalSpecified && !/每瓶|每包|每袋|每盒|每罐|每件|\/瓶|\/包|\/袋|\/盒|\/罐|\/件|×|\*|\bx\s*\d/i.test(source)) return { error: '这个规格是每件还是全部合计？例如：每瓶 980 ml，2 瓶共 142 元。' };
  if (countValue > 1 && /每瓶.*\d+\s*元|每件.*\d+\s*元/.test(source) && !/共|总价|合计|实付/.test(source)) return { error: '请补充全部商品的实付总价。' };
  return { quantity: totalSpecified ? 1 : countValue || 1, unitSize: Number(size[1]), unit: canonicalUnit(size[2]), paidAmount: Math.round(Number(amounts[0][1]) * 100), priceBasis: 'actual' };
}

export function compareProductPrices({ transactions = [], products = [], productCategories = [] }, { query = '', productId = '', categoryId = '', quote = null } = {}) {
  const key = productKey(query);
  let matches = products.filter((product) => productId ? product.id === productId : [product.name, ...(product.aliases || [])].some((name) => name && key.includes(productKey(name))));
  if (!productId && matches.length > 1) {
    const longest = Math.max(...matches.map((item) => productKey(item.name).length));
    matches = matches.filter((item) => productKey(item.name).length === longest);
    const specific = matches.filter((item) => { const fields = [item.brand, item.variant].filter(Boolean); return fields.length && fields.every((value) => key.includes(productKey(value))); });
    if (specific.length) matches = specific;
  }
  const categoryMatches = categoryId ? productCategories.filter((item) => item.id === categoryId) : productCategories.filter((item) => key.includes(productKey(item.name)));
  const categoryMode = !!categoryId || /同类|品类|哪些|所有/.test(query);
  let usedCategory = categoryMode;
  if (categoryMode || !matches.length) {
    const categoryIds = new Set(categoryMatches.map((item) => item.id));
    if (categoryIds.size) { matches = products.filter((item) => categoryIds.has(item.productCategoryId)); usedCategory = true; }
  }
  if (!quote && /\d+(?:\.\d+)?\s*(?:元|块|人民币)/.test(query) && /现在|本次|这次|划算|便宜/.test(query)) return { status: 'clarify', reply: '请补充本次报价的每件规格和包装数量，例如每瓶 980 ml，2 瓶共 142 元。', groups: [] };
  if (!matches.length) return { status: 'not_found', reply: '没有找到匹配的商品记录。请提供已记录的商品名称或品类，或先在账单中添加商品明细。', groups: [] };
  if (matches.length > 1 && !usedCategory) return { status: 'ambiguous', reply: '找到多个同名或相近商品，请选择具体款式。', candidates: matches.slice(0, 20), truncated: matches.length > 20, groups: [] };
  if (quote?.error) return { status: 'clarify', reply: quote.error, groups: [] };
  if (quote) {
    try { normalizeProductItems([{ ...quote, nameSnapshot: '报价', categoryName: '报价' }]); }
    catch (error) { return { status: 'clarify', reply: error.message, groups: [] }; }
  }
  const matchedCount = matches.length;
  const groups = matches.slice(0, 20).map((product) => {
    const records = transactions.filter((entry) => entry.type === 'expense').flatMap((transaction) => (transaction.items || [])
      .filter((item) => item.productId === product.id).map((item) => ({ ...item, transactionId: transaction.id, occurredAt: transaction.occurredAt, ...unitPrice(item) })))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
    const actual = records.filter((item) => item.priceBasis === 'actual');
    const latest = actual[0] || null;
    const lowest = actual.reduce((best, entry) => !best || entry.pricePerBase < best.pricePerBase ? entry : best, null);
    const quotePrice = quote ? unitPrice(quote) : null;
    const comparable = !!latest && !!quotePrice && latest.baseUnit === quotePrice.baseUnit;
    return { product, sampleCount: records.length, actualCount: actual.length, latest, lowest, records: records.slice(0, 10),
      quote: quotePrice, comparable, ...(comparable ? {
        percentChange: (quotePrice.pricePerBase / latest.pricePerBase - 1) * 100,
        savingsYuan: (latest.pricePerBase - quotePrice.pricePerBase) * quotePrice.totalSize,
      } : {}) };
  }).filter((group) => group.sampleCount);
  return { status: groups.length ? 'ok' : 'not_found', groups, coverage: 'all-local-history', matchedCount, truncated: matchedCount > 20, reply: groups.length ? '' : '这个商品还没有购买记录。' };
}
export function formatPriceComparison(result) {
  if (result.status !== 'ok') return result.reply;
  const lines = result.groups.map((group) => {
    const label = [group.product.brand, group.product.name, group.product.variant].filter(Boolean).join(' ');
    if (!group.latest) return `${label}：${group.sampleCount} 条记录均未分摊优惠，暂不参与实付最低价比较。`;
    const price = (record) => `${record.displayPrice.toFixed(2)} 元/${record.displayUnit}`;
    let line = `${label}：最近实付 ${price(group.latest)}（${purchaseDate(group.latest.occurredAt)}），历史最低 ${price(group.lowest)}（${purchaseDate(group.lowest.occurredAt)}），共 ${group.actualCount} 条实付记录。`;
    if (group.quote) line += group.comparable ? ` 本次 ${price(group.quote)}，比最近一次${group.percentChange <= 0 ? '低' : '高'} ${Math.abs(group.percentChange).toFixed(1)}%；按本次总规格计算${group.savingsYuan >= 0 ? '少花' : '多花'} ${Math.abs(group.savingsYuan).toFixed(2)} 元。` : ' 本次报价与历史规格单位不兼容，无法直接比较。';
    if (group.sampleCount > group.actualCount) line += ` 另有 ${group.sampleCount - group.actualCount} 条未分摊优惠记录，未计入基准。`;
    return line;
  });
  if (result.groups.length > 1) lines.push('不同款式分别列出，单价仅供参考。');
  if (result.truncated) lines.push('匹配超过 20 款商品，请补充具体名称缩小范围；每款统计均基于完整历史。');
  return lines.join('\n');
}
export function maskProductMeasurements(input) {
  return String(input).replace(new RegExp('\\d+(?:\\.\\d+)?\\s*' + unitToken + '(?![a-z])', 'gi'), (value) => ' '.repeat(value.length))
    .replace(/\d+\s*(?:瓶|包|袋|盒|罐|件)|[×*x]\s*\d+/gi, (value) => ' '.repeat(value.length));
}

export function parseProductEntry(input) {
  if (/退款|退回|退还|返现|报销|转账|收入/.test(input)) return null;
  const quote = parseProductQuote(input);
  if (!quote || quote.error) return quote?.error ? { error: quote.error } : null;
  const size = String(input).search(new RegExp('\\d+(?:\\.\\d+)?\\s*' + unitToken + '(?![a-z])', 'i'));
  let name = String(input).slice(0, size).replace(/^(?:今天|昨天|前天)?\s*(?:帮我)?\s*(?:记一笔|记录|记账|记下|买了|购买了|购买|买)?\s*/, '')
    .replace(/(?:每瓶|每包|每袋|每盒|每罐|每件|规格|容量|净含量)\s*$/, '')
    .replace(/(?:\d+|两|二|一)\s*(?:瓶|包|袋|盒|罐|件)/g, '').replace(/[，,：:\s]+$/g, '').trim();
  if (!name || name.length > 100) return { error: '请补充商品名称，或在账单表单中填写商品明细。' };
  const dimension = PRODUCT_UNITS[quote.unit].dimension;
  const categoryName = dimension === 'weight' ? '食品' : dimension === 'count' ? '计件用品' : /洗|清洁|消毒/.test(name) ? '清洁用品' : '酒水';
  return { item: { ...quote, nameSnapshot: name, categoryName, brand: '', variant: '' } };
}
