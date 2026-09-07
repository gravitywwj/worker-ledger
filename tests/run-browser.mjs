// Optional browser acceptance: use an installed Playwright or PLAYWRIGHT_MODULE file URL.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { runBrowserAcceptance } from './browser-acceptance.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'pipe' });
let serverOutput = '';
server.stderr.on('data', chunk => { serverOutput += chunk; });
let browser;
try {
  const base = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { ready = (await fetch(base + '/api/agent/health')).ok; } catch {}
    if (ready || server.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Test server did not start: ' + serverOutput);
  const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  console.log(await runBrowserAcceptance(await browser.newPage(), base));
} finally {
  if (browser) await browser.close();
  server.kill();
}
