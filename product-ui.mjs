import { PRODUCT_UNITS, normalizeProductItems, unitPrice, purchaseDate } from './product-prices.mjs';
const esc = (value = '') => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
export function productRow(item = {}) {
  const input = (name, label, value = '', attrs = '') => `<label class="field"><span>${label}</span><input class="text-input" data-product-field="${name}" value="${esc(value)}" ${attrs} required></label>`;
  return `<fieldset class="product-row" data-product-row data-item-id="${esc(item.id || '')}" data-product-id="${esc(item.productId || '')}"><legend>商品明细</legend>
    <div class="product-row-fields">
    ${input('nameSnapshot', '商品名称', item.nameSnapshot, 'maxlength="100" placeholder="品牌 + 商品名称"')}
    ${input('categoryName', '商品品类', item.categoryName, 'maxlength="30" placeholder="如：酒水、食品"')}
    ${input('brand', '品牌（可选）', item.brand, 'maxlength="60"').replace(' required>', '>')}
    ${input('variant', '款式（可选）', item.variant, 'maxlength="60"').replace(' required>', '>')}
    ${input('unitSize', '每件规格', item.unitSize ?? '', 'type="number" min="0.001" step="any" placeholder="如：980"')}
    <label class="field"><span>规格单位</span><select class="select-input" data-product-field="unit">${Object.keys(PRODUCT_UNITS).map((unit) => `<option value="${unit}" ${unit === (item.unit || 'ml') ? 'selected' : ''}>${unit}</option>`).join('')}</select></label>
    ${input('quantity', '包装数量', item.quantity ?? 1, 'type="number" min="1" step="1"')}
    ${input('paidAmountYuan', '这些商品总价（元）', item.paidAmount ? item.paidAmount / 100 : '', 'type="number" min="0.01" step="0.01"')}
    <label class="field"><span>价格口径</span><select class="select-input" data-product-field="priceBasis"><option value="actual">实付（已扣优惠）</option><option value="unallocated" ${item.priceBasis === 'unallocated' ? 'selected' : ''}>优惠尚未分摊</option></select></label>
    </div><div class="product-row-footer"><output data-product-preview aria-live="polite">填写规格和总价后显示单价</output><button type="button" class="text-button" data-action="remove-product-row">移除商品</button></div></fieldset>`;
}
export function renderProductEditor(items = [], products = [], categories = []) {
  return `<section class="product-editor" data-product-editor>
    <details ${items.length ? 'open' : ''}><summary>商品明细与单价（可选）${items.length ? ` · ${items.length} 项` : ''}</summary>
    <p class="product-help">只记录想跟踪的商品。散装商品数量填 1；总价填写这些商品的实际支付金额。</p>
    <div class="product-editor-toolbar"><label class="field"><span>复用已有商品</span><select class="select-input" data-product-reuse><option value="">选择商品后添加</option>${products.map((p) => `<option value="${esc(p.id)}">${esc([p.brand, p.name, p.variant, categories.find((c) => c.id === p.productCategoryId)?.name].filter(Boolean).join(' · '))}</option>`).join('')}</select></label><button type="button" class="secondary-button" data-action="add-product-row">添加商品</button></div>
    <div data-product-rows>${items.map(productRow).join('')}</div></details></section>`;
}
export function readProductEditor(container) {
  return [...container.querySelectorAll('[data-product-row]')].map((row) => {
    const item = { id: row.dataset.itemId, productId: row.dataset.productId };
    row.querySelectorAll('[data-product-field]').forEach((input) => { item[input.dataset.productField] = input.value; });
    return item;
  });
}
export function updateProductPreviews(container) {
  container.querySelectorAll('[data-product-row]').forEach((row) => {
    const target = row.querySelector('[data-product-preview]');
    try {
      const raw = {};
      row.querySelectorAll('[data-product-field]').forEach((input) => { raw[input.dataset.productField] = input.value; });
      const [item] = normalizeProductItems([raw]);
      const price = unitPrice(item);
      target.textContent = `${price.totalSize} ${price.baseUnit} 合计 · ${price.displayPrice.toFixed(2)} 元/${price.displayUnit}${item.priceBasis === 'unallocated' ? '（未分摊优惠）' : ''}`;
    } catch { target.textContent = '请填写完整、有效的商品规格和总价'; }
  });
}
export function renderPriceSources(result) {
  if (!result) return '';
  if (result.status === 'ambiguous') return `<div class="price-sources">${result.candidates.map((p) => `<span>${esc([p.brand, p.name, p.variant].filter(Boolean).join(' · '))}</span>`).join('')}</div>`;
  const sources = new Map();
  for (const group of result.groups || []) for (const record of [group.latest, group.lowest].filter(Boolean)) sources.set(record.transactionId, record);
  return `<div class="price-sources">${[...sources.values()].map((record) => `<button type="button" class="text-button" data-action="view-price-source" data-transaction-id="${esc(record.transactionId)}">查看 ${esc(purchaseDate(record.occurredAt))} 的原账单</button>`).join('')}</div>`;
}
