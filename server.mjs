import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const maxRequestBytes = 1024 * 1024;
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
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 900,
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      throw new Error(`模型服务连接失败：${String(reason).slice(0, 240)}`);
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const joined = content.map((item) => item?.text || '').join('').trim();
      if (joined) return joined;
    }
    throw new Error('模型没有返回可读取的内容。');
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('模型连接超时，请检查 API 地址或网络。');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function agentSystemPrompt(ledgerContext) {
  return `你是“打工人小账本”的记账助手。你只处理个人记账、收支查询和账本分析，不提供投资、借贷或税务决策建议。

请始终返回一个 JSON 对象，不要使用 Markdown 代码块。结构只能是以下三种之一：
1. {"kind":"transaction_draft","reply":"给用户的简短说明","draft":{"type":"expense|income|transfer","amountYuan":数字,"categoryId":"分类 id","accountId":"账户 id","toAccountId":"转入账户 id 或空字符串","occurredAt":"ISO 时间","note":"备注","tags":["标签"]}}
2. {"kind":"answer","reply":"基于账本数据的回答"}
3. {"kind":"clarify","reply":"只追问一个最关键的缺失信息"}

规则：
- 只有用户明确表达要记一笔收入、支出或转账时，才返回 transaction_draft。
- 金额不明确时必须 clarify，禁止猜测。
- 优先使用上下文中已有的分类 id 和账户 id；无法判断时 clarify。
- 不得声称已经写入账本，草稿仍需用户确认。
- 回答查账问题时必须以给定汇总和流水为依据，不得编造数据。
- reply 使用简洁自然的中文。

当前账本上下文：${JSON.stringify(ledgerContext)}`;
}

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
        { role: 'system', content: '只回复 OK。' },
        { role: 'user', content: '测试模型连接。' },
      ], { maxTokens: 8, temperature: 0 });
      sendJson(response, 200, { ok: true });
      return;
    }
    if (pathname === '/api/agent/chat') {
      const history = Array.isArray(payload.messages) ? payload.messages.slice(-12) : [];
      const messages = [
        { role: 'system', content: agentSystemPrompt(payload.ledgerContext || {}) },
        ...history.map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: String(message.content || '').slice(0, 4000),
        })),
      ];
      const reply = await callChatCompletions(payload.config, messages);
      sendJson(response, 200, { ok: true, reply });
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
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
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
