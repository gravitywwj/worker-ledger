import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedgerAgent } from './agent/agent.mjs';

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
