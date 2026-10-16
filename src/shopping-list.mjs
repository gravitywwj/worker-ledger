import { PRODUCT_UNITS } from './product-prices.mjs';

export function normalizeShoppingItem(raw, products, productCategories) {
  const product = products.find((item) => item.id === raw.productId);
  const quantity = Number(raw.quantity), unitSize = Number(raw.unitSize), quoteAmount = raw.quoteAmount === '' || raw.quoteAmount == null ? 0 : Number(raw.quoteAmount);
  if (!raw.id || !product || !Number.isInteger(quantity) || quantity < 1 || quantity > 999 || !Number.isFinite(unitSize) || unitSize <= 0
    || !PRODUCT_UNITS[raw.unit] || !Number.isSafeInteger(quoteAmount) || quoteAmount < 0) throw new Error('待购商品的商品、规格、数量或报价无效。');
  const category = productCategories.find((item) => item.id === product.productCategoryId);
  if (!category || (raw.productCategoryId && raw.productCategoryId !== product.productCategoryId)
    || PRODUCT_UNITS[raw.unit].dimension !== category.dimension || PRODUCT_UNITS[raw.unit].base !== category.baseUnit) throw new Error('待购商品规格单位与商品品类不匹配。');
  return { id: raw.id, productId: product.id, productCategoryId: category.id, nameSnapshot: product.name,
    brand: product.brand || '', variant: product.variant || '', quantity, unitSize, unit: raw.unit,
    quoteAmount, createdAt: raw.createdAt || new Date().toISOString() };
}
