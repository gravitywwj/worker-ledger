export async function runBrowserAcceptance(page, base) {
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 900 } });
  const p = await context.newPage();
  const errors = [];
  p.on('pageerror', error => errors.push(error.message));
  const check = (value, message) => { if (!value) throw new Error(message); };
  await p.route('**/qa-seed', route => route.fulfill({ contentType: 'text/html', body: '<html>migration fixture</html>' }));
  await p.goto(base + '/qa-seed');
  await p.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('worker-ledger', 5);
      req.onupgradeneeded = () => {
        for (const name of ['transactions','profile_settings','categories','accounts','agent_messages','agent_memory']) req.result.createObjectStore(name,{keyPath:name==='profile_settings'?'key':'id'});
        req.transaction.objectStore('accounts').put({id:'alipay',name:'支付宝',type:'payment',openingBalance:0,includeInAssets:true});
        req.transaction.objectStore('categories').put({id:'daily',label:'日用',type:'expense',icon:'ph-shopping-bag'});
        for (let i=0;i<41;i++) req.transaction.objectStore('transactions').put({id:'legacy-'+i,type:'expense',amount:100,categoryId:'daily',accountId:'alipay',occurredAt:'2026-09-01T12:00:00.000Z',note:'迁移测试 '+i,tags:[]});
      };
      req.onsuccess=()=>{req.result.close();resolve();}; req.onerror=()=>reject(req.error);
    });
  });
  const read = async store => p.evaluate(async store => new Promise((resolve,reject)=>{
    const req=indexedDB.open('worker-ledger');
    req.onsuccess=()=>{const db=req.result;const get=db.transaction(store).objectStore(store).getAll();get.onsuccess=()=>{db.close();resolve(get.result);};get.onerror=()=>reject(get.error);};
    req.onerror=()=>reject(req.error);
  }),store);
  await p.goto(base);
  await p.getByRole('button',{name:'记一笔',exact:true}).waitFor();
  check((await read('transactions')).length===41,'v5 records lost');
  check((await read('products')).length===0,'v6 product store missing');
  await p.getByRole('button',{name:'记一笔',exact:true}).click();
  await p.getByRole('spinbutton',{name:'¥ 金额',exact:true}).fill('105');
  await p.locator('#transaction-form [name="accountId"]').selectOption('alipay');
  await p.getByRole('textbox',{name:'发生时间',exact:true}).fill('2020-01-01T12:00');
  await p.getByRole('textbox',{name:'备注',exact:true}).fill('历史酒');
  await p.getByText('商品明细与单价（可选）',{exact:true}).click();
  await p.getByRole('button',{name:'添加商品',exact:true}).click();
  await p.getByRole('textbox',{name:'商品名称',exact:true}).fill('测试酒');
  await p.getByRole('textbox',{name:'商品品类',exact:true}).fill('酒水');
  await p.getByRole('spinbutton',{name:'每件规格',exact:true}).fill('1000');
  await p.getByRole('spinbutton',{name:'这些商品总价（元）',exact:true}).fill('105');
  await p.getByRole('button',{name:'保存这一笔',exact:true}).click();
  await p.getByRole('dialog').waitFor({state:'hidden'});
  check((await read('transactions')).length===42,'manual entry failed');
  await p.getByRole('link',{name:'智能助手',exact:true}).click();
  const ask = async text => {await p.waitForFunction(() => !document.querySelector('#agent-input').disabled); await p.getByRole('textbox',{name:'发送给账本助手'}).fill(text);await p.getByRole('button',{name:'发送消息',exact:true}).click();};
  await ask('测试酒每瓶980ml，2瓶共142元，划算吗');
  await p.getByText(/本次 7.24 元/).waitFor();
  check((await read('transactions')).length===42,'query wrote an expense');
  await ask('今天买了测试酒，每瓶980ml，2瓶共142元');
  await p.getByRole('button',{name:/确认.*入账/}).waitFor({timeout:4000});
  const draft=p.locator('[data-agent-draft-form]');
  check(await draft.locator('[data-agent-draft-entry]').count()===1,'spec numbers became money');
  check(await draft.getByRole('spinbutton',{name:'包装数量',exact:true}).inputValue()==='2','quantity lost in draft');
  await draft.locator('[name="accountId"]').selectOption('alipay');
  await draft.getByRole('button',{name:/确认.*入账/}).click();
  await p.getByText(/已写入账本/).waitFor();
  check((await read('transactions')).length===43,'draft not committed');
  check((await read('products')).length===1,'same product duplicated');
  await p.getByRole('button',{name:'查看 2020-01-01 的原账单',exact:true}).click();
  await p.getByRole('spinbutton',{name:'¥ 金额',exact:true}).fill('50');
  await p.getByRole('spinbutton',{name:'这些商品总价（元）',exact:true}).fill('50');
  await p.getByRole('button',{name:'保存修改',exact:true}).click();
  await p.getByRole('dialog').waitFor({state:'hidden'});
  await ask('测试酒历史单价');
  await p.getByText(/历史最低 5.00 元/).waitFor();
  await p.getByRole('link',{name:'流水',exact:true}).click();
  await p.locator('#ledger-scope-filter').selectOption('all');
  const latest=(await read('transactions')).find(t=>t.source==='agent');
  p.once('dialog',dialog=>dialog.accept());
  await p.locator('[data-action="delete-transaction"][data-transaction-id="'+latest.id+'"]').click();
  await p.getByRole('link',{name:'智能助手',exact:true}).click();
  await ask('测试酒历史单价');
  await p.getByText(/最近实付 5.00 元/).waitFor();
  check((await read('transactions')).length===42,'delete failed');
  await p.getByRole('link',{name:'设置',exact:true}).click();
  await p.evaluate(()=>{const original=URL.createObjectURL;URL.createObjectURL=blob=>{window.qaBackupBlob=blob;return original(blob);};});
  await p.getByRole('button',{name:'导出备份',exact:true}).click();
  const backup=await p.evaluate(async()=>JSON.parse(await window.qaBackupBlob.text()));
  check(backup.version===3 && backup.transactions.length===42 && backup.products.length===1,'v3 export missing products');
  const importBackup=async data=>{p.once('dialog',dialog=>dialog.accept());await p.locator('#backup-file').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});};
  const old={version:2,transactions:backup.transactions.filter(t=>t.id==='legacy-0'),categories:backup.categories,accounts:backup.accounts};
  await importBackup(old);
  await p.getByText('备份已导入。',{exact:true}).waitFor();
  check((await read('transactions')).length===1 && (await read('products')).length===0,'v2 import left stale product data');
  await importBackup(backup);
  await p.waitForFunction(()=>document.querySelector('#toast-region').textContent.includes('备份已导入'));
  await p.reload();
  await p.getByRole('button',{name:'导出备份',exact:true}).waitFor();
  check((await read('transactions')).length===42 && (await read('products')).length===1,'v3 restore/reload lost data');
  const bad={...backup,agentMemory:[{}]};
  await importBackup(bad);
  await p.getByText(/key path|回滚|保存失败|DataError/i).first().waitFor();
  check((await read('transactions')).length===42 && (await read('products')).length===1,'failed import was not atomic');
  await p.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await context.setOffline(true);
  await p.reload();
  await p.getByRole('button',{name:'导出备份',exact:true}).waitFor();
  check((await read('transactions')).length===42,'offline reload failed');
  await context.setOffline(false);
  check(errors.length===0,'browser errors: '+errors.join('; '));
  await context.close();
  return 'PASS: v5→v6, 41 legacy records, beyond-30 history, manual entry, quote no-write, draft approval, catalog reuse, v3 export/import, v2 import, reload persistence, atomic import rollback, edit/delete price sync, offline reload, zero page errors';
}

export async function runHistoryAcceptance(page, base) {
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Hong_Kong' });
  const p = await context.newPage();
  const errors = [];
  const check = (value, message) => { if (!value) throw new Error(message); };
  p.on('pageerror', error => errors.push(error.message));
  let modelRequests = 0;
  await p.route('**/api/agent/chat', route => {
    modelRequests += 1;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ reply: JSON.stringify({ kind: 'answer', reply: 'fixture response' }) }) });
  });
  const read = async () => p.evaluate(async () => new Promise((resolve, reject) => {
    const request = indexedDB.open('worker-ledger');
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction('transactions').objectStore('transactions').getAll();
      get.onsuccess = () => { db.close(); resolve(get.result); };
      get.onerror = () => reject(get.error);
    };
    request.onerror = () => reject(request.error);
  }));
  try {
    await p.goto(base);
    await p.getByRole('button', { name: '记一笔', exact: true }).waitFor();
    await p.evaluate(async () => {
      localStorage.setItem('worker-ledger-agent-config', JSON.stringify({ baseUrl: 'https://model.invalid/v1', model: 'fixture' }));
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('worker-ledger');
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('transactions', 'readwrite');
          const store = tx.objectStore('transactions');
          store.clear();
          const entry = { type: 'expense', categoryId: 'food', accountId: 'wechat', tags: [] };
          store.put({ ...entry, id: 'old-breakfast', amount: 3000, occurredAt: '2020-01-01T02:00:00Z', note: '早餐' });
          store.put({ ...entry, id: 'old-salary', type: 'income', amount: 500000, categoryId: 'salary', accountId: 'salary-card', occurredAt: '2020-08-01T02:00:00Z', note: '薪资' });
          for (let i = 0; i < 60; i++) store.put({ ...entry, id: `recent-${i}`, amount: 10000 + i, occurredAt: new Date(Date.now() - i * 60000).toISOString(), note: `其他采购${i}` });
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });
    });
    await p.reload();
    await p.getByRole('link', { name: '流水', exact: true }).click();
    await p.locator('#ledger-scope-filter').selectOption('all');
    await p.getByRole('heading', { name: '62 笔流水', exact: true }).waitFor();
    check(await p.locator('.ledger-list .transaction-row').count() === 50, 'full history rendered without a page limit');
    await p.getByRole('button', { name: '下一页', exact: true }).click();
    check(await p.locator('.ledger-list .transaction-row').count() === 12, 'history page two lost old records');
    await p.locator('#ledger-search').fill('早饭');
    await p.getByRole('heading', { name: '1 笔流水', exact: true }).waitFor();
    check(await p.locator('[data-transaction-id="old-breakfast"]').count() === 2, 'history synonym query missed an older-than-30 bill');
    await p.locator('#ledger-search').fill('30元');
    await p.waitForFunction(() => document.querySelector('#ledger-search')?.value === '30元' && document.querySelector('.ledger-list .transaction-row')?.textContent.includes('早餐'));
    await p.locator('#ledger-search').fill('');
    await p.getByRole('heading', { name: '62 笔流水', exact: true }).waitFor();
    await p.getByRole('button', { name: '记一笔', exact: true }).click();
    await p.getByRole('spinbutton', { name: '¥ 金额', exact: true }).fill('30');
    await p.getByRole('textbox', { name: '备注', exact: true }).fill('早饭');
    await p.locator('#transaction-form [name="accountId"]').selectOption('wechat');
    await p.getByRole('button', { name: '保存这一笔', exact: true }).click();
    const review = p.locator('.reconciliation-dialog');
    await review.waitFor();
    const warning = await review.innerText();
    check(warning.includes('2020-01-01') && warning.includes('历史相似'), 'save warning missed old synonym bill');
    await review.getByRole('button', { name: '返回修改', exact: true }).click();
    check((await read()).length === 62, 'cancelled duplicate was saved');
    check(await p.getByRole('dialog').isVisible(), 'cancel discarded the entry form');
    await p.locator('#transaction-form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await review.getByRole('button', { name: '另记一笔', exact: true }).click();
    await p.getByRole('dialog').waitFor({ state: 'hidden' });
    check((await read()).length === 63, 'approved historical match or duplicate-submit guard failed');
    await p.getByRole('link', { name: '智能助手', exact: true }).click();
    const ask = async text => { await p.locator('#agent-input').fill(text); await p.getByRole('button', { name: '发送消息', exact: true }).click(); };
    await ask('查询2020年1月早饭账单');
    await p.getByText(/已查询完整本地历史，匹配 1 笔/).waitFor();
    check(modelRequests === 0, 'explicit history query consumed a model request');
    await p.getByRole('button', { name: '查看 2020-01-01 · 早餐 的原账单', exact: true }).click();
    check(await p.getByRole('textbox', { name: '备注', exact: true }).inputValue() === '早餐', 'history source opened the wrong bill');
    await p.getByRole('textbox', { name: '备注', exact: true }).fill('旧账修正');
    await p.getByRole('button', { name: '保存修改', exact: true }).click();
    await p.getByRole('dialog').waitFor({ state: 'hidden' });
    await ask('查询2020年1月旧账修正账单');
    await p.getByRole('button', { name: '查看 2020-01-01 · 旧账修正 的原账单', exact: true }).waitFor();
    check(modelRequests === 0, 'query after edit consumed a model request');
    await ask('今天工资收入5000元，工资卡到账');
    const draft = p.locator('[data-agent-draft-form]').last();
    await draft.waitFor();
    check(await draft.locator('[name="type"]').inputValue() === 'income', 'salary fixture must exercise the income branch');
    await draft.getByRole('button', { name: /确认.*入账/ }).click();
    await review.getByRole('button', { name: '返回修改', exact: true }).click();
    check((await read()).length === 63, 'cancelled salary draft was written');
    check(await draft.getByRole('button', { name: /确认.*入账/ }).isEnabled(), 'cancel left draft submission locked');
    await draft.getByRole('button', { name: /确认.*入账/ }).click();
    await review.getByRole('button', { name: '另记一笔', exact: true }).click();
    await p.getByText(/已写入账本/).waitFor();
    check((await read()).length === 64, 'accepted salary synonym draft was not written');
    await p.evaluate(async () => { await navigator.serviceWorker.ready; });
    await context.setOffline(true);
    await p.reload();
    await p.locator('#agent-input').waitFor();
    await ask('查询2020年8月工资收入');
    await p.getByText(/2020-08-01 · 收入/).last().waitFor();
    check(errors.length === 0, 'browser errors: ' + errors.join('; '));
    return 'PASS: full-history paging, old-bill synonym search, amount search, cancel/accept manual and Agent duplicate warnings, original bill navigation, cache refresh after edit, zero model calls for history queries, offline history module, zero page errors';
  } finally {
    await context.close();
  }
}

export async function runReconciliationAcceptance(page, base) {
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Hong_Kong' });
  const p = await context.newPage();
  const errors = [];
  const check = (value, message) => { if (!value) throw new Error(message); };
  p.on('pageerror', error => errors.push(error.message));
  let modelRequests = 0;
  await p.route('**/api/agent/chat', route => { modelRequests += 1; return route.abort(); });
  const read = async () => p.evaluate(async () => new Promise((resolve, reject) => {
    const request = indexedDB.open('worker-ledger');
    request.onsuccess = () => {
      const db = request.result, get = db.transaction('transactions').objectStore('transactions').getAll();
      get.onsuccess = () => { db.close(); resolve(get.result); }; get.onerror = () => reject(get.error);
    };
    request.onerror = () => reject(request.error);
  }));
  const review = p.locator('.reconciliation-dialog');
  const manual = async (amount, date, { accountId = '', note = '', channel = '' } = {}) => {
    await p.getByRole('link', { name: '首页', exact: true }).click();
    await p.getByRole('button', { name: '记一笔', exact: true }).click();
    const form = p.locator('#transaction-form');
    await form.locator('[name="amount"]').fill(String(amount));
    await form.locator('[name="occurredAt"]').fill(date);
    await form.locator('[name="accountId"]').selectOption(accountId);
    await form.locator('[name="note"]').fill(note);
    await form.locator('[name="paymentChannel"]').selectOption(channel);
    return form;
  };
  const submit = form => form.getByRole('button', { name: '保存这一笔', exact: true }).click();
  const ask = async text => {
    await p.getByRole('link', { name: '智能助手', exact: true }).click();
    await p.locator('#agent-input').fill(text);
    await p.getByRole('button', { name: '发送消息', exact: true }).click();
    return p.locator('[data-agent-draft-form]').last();
  };
  try {
    await p.goto(base);
    await p.getByRole('button', { name: '记一笔', exact: true }).waitFor();
    await p.evaluate(async () => new Promise((resolve, reject) => {
      const request = indexedDB.open('worker-ledger');
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('transactions', 'readwrite'), store = tx.objectStore('transactions');
        store.clear();
        const defaults = { type: 'expense', categoryId: 'food', tags: [], source: 'manual' };
        store.put({ ...defaults, id: 'bank-expense', amount: 3000, accountId: 'salary-card', note: '', occurredAt: '2026-10-15T04:00:00Z' });
        store.put({ ...defaults, id: 'wrong-wallet', amount: 4500, accountId: 'wechat', note: '咖啡', occurredAt: '2026-10-14T04:00:00Z' });
        store.put({ ...defaults, id: 'owned-transfer', type: 'transfer', categoryId: 'transfer', amount: 20000, accountId: 'salary-card', toAccountId: 'wechat', note: '微信零钱充值', occurredAt: '2026-10-15T04:00:00Z' });
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    }));
    await p.reload();
    let form = await manual(30, '2026-10-15T12:00');
    await submit(form);
    await review.waitFor();
    check((await review.innerText()).includes('实际账户待确认'), 'sparse entry did not reach duplicate review');
    await p.screenshot({ path: 'output/playwright/reconciliation-desktop.png' });
    await p.setViewportSize({ width: 375, height: 812 });
    check(await review.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), 'reconciliation overflows mobile dialog');
    await p.screenshot({ path: 'output/playwright/reconciliation-mobile.png' });
    await p.setViewportSize({ width: 1280, height: 900 });
    await review.getByRole('button', { name: '同一笔，补充来源', exact: true }).click();
    await p.locator('#app-dialog').waitFor({ state: 'hidden' });
    let rows = await read();
    check(rows.length === 3 && rows.find(row => row.id === 'bank-expense').accountId === 'salary-card', 'linking sparse entry changed balance or added a row');
    check(rows.find(row => row.id === 'bank-expense').statementEntries.length === 2, 'sparse source evidence was lost');

    form = await manual(45, '2026-10-14T12:00', { accountId: 'salary-card', note: '咖啡', channel: '微信' });
    await submit(form);
    await review.waitFor();
    check((await review.locator('[data-reconciliation-impact]').innerText()).includes('余额影响'), 'account correction lacks balance preview');
    await review.getByRole('button', { name: '修正账户并关联', exact: true }).click();
    await p.locator('#app-dialog').waitFor({ state: 'hidden' });
    rows = await read();
    check(rows.length === 3 && rows.find(row => row.id === 'wrong-wallet').accountId === 'salary-card', 'account correction duplicated the expense');
    check(rows.find(row => row.id === 'wrong-wallet').paymentChannel === '微信', 'payment channel was lost');

    await p.getByRole('link', { name: '智能助手', exact: true }).click();
    let draft = await ask('10月15日，微信零钱充值到账200元');
    await draft.waitFor();
    check(await draft.locator('[name="type"]').inputValue() === 'transfer', 'wallet topup was mistaken for income or expense');
    check(await draft.locator('[name="accountId"]').inputValue() === '', 'topup invented a source bank account');
    await draft.getByRole('button', { name: /确认.*入账/ }).click();
    await review.getByRole('button', { name: '同一笔，补充来源', exact: true }).click();
    await p.getByText(/已完成核对 · 新增 0 笔/).waitFor();
    rows = await read();
    check(rows.length === 3 && rows.every(row => row.type !== 'income'), 'wallet topup double-counted income');

    form = await manual(11, '2020-01-01T12:00', { accountId: 'salary-card', note: '历史消费' });
    await form.locator('.statement-details > summary').click();
    await form.locator('[name="statementSource"]').fill('微信账单');
    await form.locator('[name="statementAccountId"]').selectOption('wechat');
    await form.locator('[name="externalId"]').fill('WX-0007');
    await submit(form);
    await p.locator('#app-dialog').waitFor({ state: 'hidden' });
    form = await manual(11, '2026-10-15T12:00');
    await form.locator('.statement-details > summary').click();
    await form.locator('[name="statementSource"]').fill('微信流水');
    await form.locator('[name="statementAccountId"]').selectOption('wechat');
    await form.locator('[name="externalId"]').fill('WX-0007');
    await submit(form);
    await review.waitFor();
    check(await review.getByRole('button', { name: '另记一笔', exact: true }).isDisabled(), 'same source transaction ID allowed a second entry');
    await review.getByRole('button', { name: '同一笔，补充来源', exact: true }).click();
    await p.locator('#app-dialog').waitFor({ state: 'hidden' });
    check((await read()).length === 4, 'cross-date ID reconciliation created a duplicate');

    const before = JSON.stringify(await read());
    draft = await ask('10月15日，微信零钱支出30元；10月14日，银行卡扣款45元');
    await draft.waitFor();
    check(await draft.locator('[data-agent-draft-entry]').count() === 2, 'batch fixture did not produce two drafts');
    await draft.getByRole('button', { name: /确认.*入账/ }).click();
    await review.getByRole('button', { name: '修正账户并关联', exact: true }).click();
    await review.getByRole('button', { name: '返回修改', exact: true }).click();
    check(JSON.stringify(await read()) === before, 'cancelling the second draft persisted a partial batch');
    check(await draft.getByRole('button', { name: /确认.*入账/ }).isEnabled(), 'cancelled draft stayed locked');

    form = await manual(99, '2026-10-15T12:00', { note: '新支出' });
    await submit(form);
    await p.getByText('请确认实际扣款或到账账户。', { exact: true }).waitFor();
    check((await read()).length === 4, 'entry without actual account was saved');
    await form.locator('[name="accountId"]').selectOption('salary-card');
    await submit(form);
    await p.locator('#app-dialog').waitFor({ state: 'hidden' });
    check((await read()).length === 5, 'confirmed missing account could not be saved');
    check(modelRequests === 0, 'local reconciliation consumed a model call');
    await p.evaluate(async () => { await navigator.serviceWorker.ready; });
    await context.setOffline(true);
    await p.reload();
    await p.getByRole('button', { name: '记一笔', exact: true }).waitFor();
    check((await read()).length === 5 && errors.length === 0, 'offline reload or page errors: ' + errors.join('; '));
    return 'PASS: sparse duplicate link, cross-account correction, transfer source attachment, scoped transaction IDs, batch cancel rollback, pending account guard, desktop/mobile layout, offline reload, zero model calls';
  } finally {
    await context.close();
  }
}
