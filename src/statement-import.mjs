import { statementEntry } from './transaction-reconciliation.mjs';

const FIELDS = {
  date: ['交易时间', '交易日期', '发生时间', '日期', '付款时间', '入账时间', 'date', 'datetime', 'time'],
  direction: ['收/支', '收支', '收入支出', '方向', '资金方向', 'direction'],
  amount: ['金额(元)', '金额（元）', '交易金额', '发生金额', '金额', 'amount'],
  note: ['商品说明', '商品', '摘要', '备注', '用途', 'description', 'memo'],
  counterparty: ['交易对方', '商户名称', '对方名称', 'counterparty', 'payee'],
  paymentMethod: ['收/付款方式', '支付方式', '付款方式', '收款方式', 'payment method'],
  status: ['当前状态', '交易状态', '订单状态', '状态', 'status'],
  externalId: ['交易单号', '交易订单号', '订单号', '流水号', '交易号', 'transaction id'],
};

const normalizeHeader = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s()（）【】\[\]：:]/g, '');
const DEFAULT_ID = () => globalThis.crypto?.randomUUID?.() || `import-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export function decodeStatementFile(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { return new TextDecoder('gb18030').decode(bytes).replace(/^\uFEFF/, ''); }
}

export function parseStatementCsv(input) {
  const text = String(input || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && !cell) quoted = true;
    else if (character === ',') { row.push(cell); cell = ''; }
    else if (character === '\n' || character === '\r') {
      row.push(cell); cell = '';
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    } else cell += character;
  }
  if (quoted) throw new Error('CSV 中存在未闭合的引号。');
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  if (!rows.length) throw new Error('CSV 文件没有可读取内容。');
  return rows;
}

function fieldIndex(headers, names) {
  const normalized = headers.map(normalizeHeader);
  for (const name of names) {
    const index = normalized.indexOf(normalizeHeader(name));
    if (index >= 0) return index;
  }
  return -1;
}

export function inspectStatementCsv(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('CSV 文件没有可读取内容。');
  const headerRowIndex = rows.findIndex((row) => fieldIndex(row, FIELDS.date) >= 0 && fieldIndex(row, FIELDS.amount) >= 0);
  if (headerRowIndex < 0) throw new Error('未找到同时包含日期和金额的表头，请检查 CSV 文件。');
  const headers = rows[headerRowIndex].map((value) => String(value || '').trim());
  const mapping = Object.fromEntries(Object.entries(FIELDS).map(([key, names]) => [key, fieldIndex(headers, names)]));
  const signature = new Set(headers.map(normalizeHeader));
  const source = signature.has(normalizeHeader('当前状态')) && signature.has(normalizeHeader('交易单号')) && signature.has(normalizeHeader('支付方式'))
    ? '微信支付账单'
    : signature.has(normalizeHeader('收/付款方式')) || signature.has(normalizeHeader('交易订单号')) ? '支付宝账单' : '银行卡账单';
  return { headers, headerRowIndex, mapping, source, rows: rows.slice(headerRowIndex + 1) };
}

function parseAmount(value) {
  const original = String(value || '').trim();
  const parenthesized = /^\(.*\)$/.test(original);
  const normalized = original.replace(/[(),¥￥\s]|CNY|RMB|元/gi, '');
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const decimals = normalized.split('.')[1] || '';
  if (decimals.length > 2) return null;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount === 0 || !Number.isSafeInteger(Math.round(Math.abs(amount) * 100))) return null;
  return { cents: Math.round(Math.abs(amount) * 100), negative: parenthesized || amount < 0 };
}

function parseOccurredAt(value) {
  let input = String(value || '').trim();
  if (!input) return '';
  input = input.replace(/年|\//g, '-').replace(/月/g, '-').replace(/日/g, '').replace(/\./g, '-').replace(/\s+/g, 'T');
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(input)) input += 'T12:00:00';
  const timestamp = new Date(input);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : '';
}

function fieldValue(row, index) { return index < 0 ? '' : String(row[index] || '').trim(); }

export function mapStatementRows(statement, mapping = statement.mapping, options = {}) {
  const makeId = options.makeId || DEFAULT_ID;
  const rows = statement.rows.map((cells, index) => {
    const line = statement.headerRowIndex + index + 2;
    const raw = Object.fromEntries(Object.entries(mapping).map(([key, column]) => [key, fieldValue(cells, Number(column))]));
    const status = raw.status;
    const skipReason = /关闭|取消|撤销|失败|已关闭|已取消|交易关闭|交易失败/i.test(status) ? `交易状态：${status}` : '';
    const directionText = `${raw.direction} ${raw.note} ${raw.counterparty} ${raw.paymentMethod} ${status}`;
    const parsedAmount = parseAmount(raw.amount);
    const type = /转账|充值|提现/.test(raw.direction) ? 'transfer'
      : /退款|退回|退还|返现/.test(directionText) ? 'income'
        : /收入|收款|收|退款成功/.test(raw.direction) ? 'income'
          : /支出|付款|支付|消费|付/.test(raw.direction) ? 'expense'
            : parsedAmount?.negative ? 'expense' : /转账|充值|提现/.test(directionText) ? 'transfer' : 'expense';
    const occurredAt = parseOccurredAt(raw.date);
    const note = raw.note || raw.counterparty || raw.paymentMethod;
    const sourceNote = [raw.counterparty, raw.note].filter(Boolean).join(' · ') || note;
    const incomeCategory = /退|返/.test(directionText) ? 'reimburse' : options.incomeCategoryId || 'other-income';
    const categoryId = type === 'transfer' ? 'transfer' : type === 'income' ? incomeCategory : options.defaultCategoryId || 'other';
    const transaction = {
      id: makeId(), type, amount: parsedAmount?.cents || 0, categoryId,
      accountId: options.defaultAccountId || '', toAccountId: '',
      occurredAt, note, tags: [], shopName: '',
      paymentChannel: /微信/.test(statement.source) ? '微信' : /支付宝/.test(statement.source) ? '支付宝' : '银行卡',
      source: 'statement-import', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const errors = [];
    if (!occurredAt) errors.push('交易日期无效');
    if (!parsedAmount) errors.push('金额无效或超过两位小数');
    if (raw.externalId.length > 120) errors.push('交易单号超过 120 字，请重新映射或跳过');
    if (note.length > 4000 || sourceNote.length > 4000) errors.push('备注或原始说明超过 4000 字，请重新映射或跳过');
    if (!skipReason && !/成功|完成|已支付|已收款|已付款|已退款|已到账|交易成功|支付成功/i.test(status)) errors.push('交易状态待确认');
    if (!transaction.accountId) errors.push('实际扣款或到账账户待确认');
    if (type === 'transfer') errors.push('转账需确认转出和转入账户');
    if (type !== 'transfer' && !(options.categories || []).some((category) => category.id === categoryId && category.type === type)) errors.push('分类需确认');
    if (parsedAmount && occurredAt && raw.externalId.length <= 120 && sourceNote.length <= 4000) {
      transaction.statementEntries = [statementEntry(transaction, {
        source: statement.source || '账单 CSV', accountId: options.sourceAccountId || '',
        externalId: raw.externalId, note: sourceNote,
      })];
    }
    return {
      line, raw, transaction: { ...transaction, note: note.slice(0, 4000) }, errors, skipReason,
      decision: skipReason ? 'skip' : 'pending', duplicates: [],
    };
  });
  return rows;
}

export function statementFieldOptions(headers, selectedIndex = -1) {
  const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  return `<option value="-1">不导入</option>${headers.map((header, index) => `<option value="${index}" ${index === selectedIndex ? 'selected' : ''}>${escape(header)}</option>`).join('')}`;
}
