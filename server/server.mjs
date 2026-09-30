import { createServer } from 'node:http';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedgerAgent } from '../agent/agent.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 4173);
const maxRequestBytes = 1024 * 1024;
const integrationDir = resolve(process.env.LEDGER_INTEGRATION_DIR || resolve(root, '.local'));
const summaryPath = resolve(integrationDir, 'summary.json');
const draftPath = resolve(integrationDir, 'draft.json');
let creatingDraft = false;
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxRequestBytes) {
        rejectBody(new Error('请求内容过大。'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        rejectBody(new Error('请求内容不是有效 JSON。'));
      }
    });
    request.on('error', rejectBody);
  });
}

async function readLocalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeLocalJson(path, value) {
  await mkdir(integrationDir, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

function validMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function validMoney(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000;
}

function validateSummary(payload) {
  if (payload?.currency !== 'CNY' || !Array.isArray(payload.months) || payload.months.length > 3) throw new Error('账本摘要格式无效。');
  const months = payload.months.map((item) => {
    if (!validMonth(item?.month) || !validMoney(item.income_fen) || !validMoney(item.expense_fen)
      || !Number.isSafeInteger(item.transaction_count) || item.transaction_count < 0
      || !Array.isArray(item.expense_categories) || item.expense_categories.length > 30) throw new Error('账本月份摘要无效。');
    const categories = item.expense_categories.map((category) => {
      if (typeof category?.label !== 'string' || category.label.length > 60 || !validMoney(category.amount_fen)) throw new Error('账本分类摘要无效。');
      return { label: category.label, amount_fen: category.amount_fen };
    });
    if (categories.reduce((total, category) => total + category.amount_fen, 0) > item.expense_fen) throw new Error('分类支出超过当月支出。');
    return { month: item.month, income_fen: item.income_fen, expense_fen: item.expense_fen,
      balance_fen: item.income_fen - item.expense_fen, transaction_count: item.transaction_count,
      expense_categories: categories };
  });
  if (new Set(months.map((item) => item.month)).size !== months.length) throw new Error('账本月份重复。');
  return { source: 'worker-ledger', currency: 'CNY', generated_at: new Date().toISOString(), months };
}

async function handleIntegrationApi(request, response, url) {
  const origin = request.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
    sendJson(response, 403, { error: '跨站请求被拒绝。' });
    return;
  }
  try {
    if (url.pathname === '/api/integration/summary') {
      if (request.method === 'POST') {
        const summary = validateSummary(await readJsonBody(request));
        await writeLocalJson(summaryPath, summary);
        sendJson(response, 200, { ok: true, generated_at: summary.generated_at });
        return;
      }
      if (request.method === 'GET') {
        const summary = await readLocalJson(summaryPath);
        if (!summary) { sendJson(response, 200, { status: 'not_shared', source: 'worker-ledger' }); return; }
        const month = url.searchParams.get('month');
        if (month && !validMonth(month)) throw new Error('月份必须为 YYYY-MM。');
        sendJson(response, 200, { ...summary, months: month ? summary.months.filter((item) => item.month === month) : summary.months });
        return;
      }
    }
    if (url.pathname === '/api/integration/drafts') {
      if (request.method === 'POST') {
        const payload = await readJsonBody(request);
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';
        if (!text || text.length > 1000) throw new Error('记账草稿必须为 1 到 1000 字。');
        if (creatingDraft) { sendJson(response, 409, { error: '已有一条待领取的记账草稿。' }); return; }
        creatingDraft = true;
        try {
          const pending = await readLocalJson(draftPath);
          if (pending) { sendJson(response, 409, { error: '已有一条待领取的记账草稿。' }); return; }
          const draft = { id: randomUUID(), text, created_at: new Date().toISOString() };
          await writeLocalJson(draftPath, draft);
          sendJson(response, 201, { status: 'pending', draft_id: draft.id });
        } finally {
          creatingDraft = false;
        }
        return;
      }
      if (request.method === 'GET') {
        sendJson(response, 200, { draft: await readLocalJson(draftPath) });
        return;
      }
    }
    const match = url.pathname.match(/^\/api\/integration\/drafts\/([0-9a-f-]{36})$/);
    if (match && request.method === 'DELETE') {
      const draft = await readLocalJson(draftPath);
      if (!draft || draft.id !== match[1]) { sendJson(response, 404, { error: '草稿不存在。' }); return; }
      await unlink(draftPath);
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 405, { error: '不支持这个请求方式。' });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : '集成请求失败。' });
  }
}

function validateModelConfig(config = {}) {
  const baseUrl = String(config.baseUrl || '').trim().replace(/\/+$/, '');
  const model = String(config.model || '').trim();
  if (!baseUrl) throw new Error('请填写 API 地址。');
  if (!model) throw new Error('请填写模型名称。');
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('请填写有效的 API 地址。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('API 地址需要使用 HTTP 或 HTTPS。');
  return { baseUrl, model, apiKey: String(config.apiKey || '').trim() };
}

async function callChatCompletions(rawConfig, messages, options = {}) {
  const config = validateModelConfig(rawConfig);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  const thinking = options.thinking ?? { type: 'disabled' };
  const requestBody = {
    model: config.model,
    messages,
    max_tokens: options.maxTokens ?? 8192,
    stream: false,
    response_format: options.responseFormat ?? { type: 'json_object' },
    thinking,
    ...(thinking.type === 'disabled' ? { temperature: options.temperature ?? 0.2 } : {}),
    ...(thinking.type === 'enabled' && options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
    ...(Array.isArray(options.tools) && options.tools.length ? { tools: options.tools, tool_choice: options.toolChoice ?? 'auto' } : {}),
  };
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      throw new Error(`模型服务连接失败：${String(reason).slice(0, 240)}`);
    }
    const choice = payload?.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('模型输出被截断，请缩短输入或稍后重试。');
    const rawMessage = choice?.message || {};
    const message = { ...rawMessage };
    const content = message?.content ?? choice?.text ?? payload?.output_text;
    if (typeof content === 'string') message.content = content.trim();
    if (Array.isArray(content)) {
      const joined = content.map((item) => item?.text || item?.content?.text || '').join('').trim();
      message.content = joined;
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) return { message, finishReason: choice?.finish_reason || 'tool_calls' };
    if (message.content) return { message, finishReason: choice?.finish_reason || 'stop' };
    if (message?.reasoning_content) throw new Error('模型只返回了思考过程，没有返回最终内容；请关闭思考模式或增加输出长度。');
    throw new Error('模型没有返回可读取的内容。');
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('模型连接超时，请检查 API 地址或网络。');
    if (error?.name === 'TypeError' && /fetch failed/i.test(error.message || '')) {
      const cause = error.cause?.code || error.cause?.message;
      throw new Error(`无法访问模型服务${cause ? `（${String(cause).slice(0, 80)}）` : ''}，请检查 API 地址、网络或代理设置。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const ledgerAgent = await createLedgerAgent({ root, complete: callChatCompletions });

async function handleAgentApi(request, response, pathname) {
  try {
    if (request.method === 'GET' && pathname === '/api/agent/health') {
      sendJson(response, 200, { ok: true, localAgent: true });
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: '不支持这个请求方式。' });
      return;
    }
    const payload = await readJsonBody(request);
    if (pathname === '/api/agent/test') {
      await callChatCompletions(payload.config, [
        { role: 'system', content: '只返回合法 json 对象：{"ok":true}。不要返回 Markdown。' },
        { role: 'user', content: '测试模型连接。' },
      ], { maxTokens: 512, thinking: { type: 'disabled' } });
      sendJson(response, 200, { ok: true });
      return;
    }
    if (pathname === '/api/agent/chat') {
      const history = Array.isArray(payload.messages) ? payload.messages.slice(-12) : [];
      const result = await ledgerAgent.run({
        config: payload.config,
        messages: history.map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: String(message.content || '').slice(0, 4000),
        })),
        ledgerContext: payload.ledgerContext || {},
      });
      sendJson(response, 200, { ok: true, reply: result.reply, agentMeta: { candidateCount: result.candidateCount, toolRounds: result.toolRounds } });
      return;
    }
    sendJson(response, 404, { error: '接口不存在。' });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : '模型请求失败。' });
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    if (url.pathname.startsWith('/api/agent/')) {
      await handleAgentApi(request, response, url.pathname);
      return;
    }
    if (url.pathname.startsWith('/api/integration/')) {
      await handleIntegrationApi(request, response, url);
      return;
    }
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    if (pathname.split('/').some((part) => part.startsWith('.'))) throw new Error('private path');
    const filePath = resolve(root, `.${pathname}`);
    if (!filePath.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) throw new Error('invalid path');
    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`打工人小账本运行在 http://127.0.0.1:${port}`);
});
