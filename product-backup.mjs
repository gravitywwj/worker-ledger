import { normalizeProductItems, PRODUCT_UNITS, DEFAULT_PRODUCT_CATEGORIES } from './product-prices.mjs';
export function normalizeBackup(data) {
  if (!data || typeof data !== 'object') throw new Error('文件内容不是有效备份。');
  if (data.version !== undefined && ![1, 2, 3].includes(data.version)) throw new Error('不支持这个备份版本，请使用兼容版本导出。');
  const arrays = ['transactions', 'categories', 'accounts'];
  if (data.version === 3) arrays.push('products', 'productCategories');
  for (const key of arrays) {
    if (!Array.isArray(data[key])) throw new Error('备份缺少 ' + key + ' 数据。');
    const ids = new Set();
    for (const item of data[key]) {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new Error(key + ' 包含无效或重复 ID。');
      ids.add(item.id);
    }
  }
  const products = data.version === 3 ? data.products : [];
  const productCategories = data.version === 3 ? data.productCategories : DEFAULT_PRODUCT_CATEGORIES.map((item) => ({ ...item }));
  for (const category of productCategories) {
    if (typeof category.name !== 'string' || !category.name.trim() || !Object.values(PRODUCT_UNITS).some((unit) => unit.base === category.baseUnit && unit.dimension === category.dimension)) throw new Error('商品品类格式无效。');
  }
  for (const product of products) {
    if (typeof product.name !== 'string' || !product.name.trim() || !productCategories.some((item) => item.id === product.productCategoryId) || (product.aliases !== undefined && (!Array.isArray(product.aliases) || product.aliases.some((alias) => typeof alias !== 'string')))) throw new Error('商品目录或品类引用无效。');
  }
  const transactions = data.transactions.map((transaction) => {
    if (!Number.isSafeInteger(transaction.amount) || transaction.amount <= 0 || !['expense', 'income', 'transfer'].includes(transaction.type) || typeof transaction.occurredAt !== 'string' || Number.isNaN(Date.parse(transaction.occurredAt))) throw new Error('流水金额、类型或日期无效。');
    if (!data.accounts.some((item) => item.id === transaction.accountId) || (transaction.type === 'transfer' && (!data.accounts.some((item) => item.id === transaction.toAccountId) || transaction.accountId === transaction.toAccountId))) throw new Error('流水账户引用无效。');
    if (transaction.type !== 'transfer' && !data.categories.some((item) => item.id === transaction.categoryId)) throw new Error('流水分类引用无效。');
    const items = normalizeProductItems(transaction.items || [], { amount: transaction.amount, type: transaction.type });
    for (const item of items) {
      const product = products.find((p) => p.id === item.productId);
      const category = productCategories.find((c) => c.id === item.productCategoryId);
      if (!product || !category || product.productCategoryId !== category.id || PRODUCT_UNITS[item.unit].base !== category.baseUnit || PRODUCT_UNITS[item.unit].dimension !== category.dimension) throw new Error('商品明细引用或单位无效。');
    }
    return { ...transaction, items };
  });
  return { ...data, transactions, products, productCategories };
}
