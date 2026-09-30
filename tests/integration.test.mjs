import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

test('local summary and draft API keeps money aggregated and drafts pending', async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const directory = await mkdtemp(join(tmpdir(), 'ledger-integration-'));
  const server = spawn(process.execPath, ['server/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), LEDGER_INTEGRATION_DIR: directory },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const request = async (path, method = 'GET', data) => {
    const response = await fetch(base + path, {
      method, headers: data ? { 'Content-Type': 'application/json' } : {},
      body: data ? JSON.stringify(data) : undefined,
    });
    return [response.status, await response.json()];
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { await request('/api/integration/summary'); ready = true; break; }
      catch { await delay(100); }
    }
    assert.equal(ready, true);
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /src\/app\.js/);
    for (const path of ['/src/app.js', '/src/styles.css', '/src/product-prices.mjs', '/agent/periodic-review.mjs']) {
      const asset = await fetch(base + path);
      assert.equal(asset.status, 200, `${path} should be served`);
    }
    assert.equal((await request('/api/integration/summary'))[1].status, 'not_shared');
    const summary = { currency: 'CNY', months: [{ month: '2026-09', income_fen: 10000, expense_fen: 2800,
      transaction_count: 1, expense_categories: [{ label: '餐饮', amount_fen: 2800 }] }] };
    assert.equal((await request('/api/integration/summary', 'POST', summary))[0], 200);
    const shared = (await request('/api/integration/summary?month=2026-09'))[1];
    assert.equal(shared.months[0].balance_fen, 7200);
    assert.equal('transactions' in shared, false);
    assert.equal((await request('/api/integration/summary', 'POST', summary))[0], 200);
    assert.equal((await request('/api/integration/summary', 'POST', {
      ...summary, months: [{ ...summary.months[0], expense_fen: -1 }],
    }))[0], 400);
    const [created, draft] = await request('/api/integration/drafts', 'POST', { text: '午餐 28 元' });
    assert.equal(created, 201);
    assert.equal((await request('/api/integration/drafts', 'POST', { text: '晚餐 35 元' }))[0], 409);
    assert.equal((await request('/api/integration/drafts'))[1].draft.text, '午餐 28 元');
    assert.equal((await request(`/api/integration/drafts/${draft.draft_id}`, 'DELETE'))[0], 200);
    assert.equal((await request('/api/integration/drafts'))[1].draft, null);
    const concurrent = await Promise.all([
      request('/api/integration/drafts', 'POST', { text: '午餐 28 元' }),
      request('/api/integration/drafts', 'POST', { text: '晚餐 35 元' }),
    ]);
    assert.deepEqual(concurrent.map(([status]) => status).sort(), [201, 409]);
    const surviving = concurrent.find(([status]) => status === 201)[1];
    assert.equal((await request('/api/integration/drafts'))[1].draft.id, surviving.draft_id);
    assert.equal((await fetch(base + '/.local/summary.json')).status, 404);
  } finally {
    server.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
