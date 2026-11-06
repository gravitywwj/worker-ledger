import { createHash } from 'node:crypto';

export async function runStatementImportAcceptance(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const check = (value, message) => { if (!value) throw new Error(message); };
  const upload = (name, content) => page.locator('#statement-file').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(content) });
  const saved = () => page.getByText('核对进度已保存在本机', { exact: true }).waitFor();
  const headers = '交易时间,收/支,金额(元),商品说明,交易对方,当前状态,交易单号,支付方式,交易类型,次级说明';
  const first = [headers, '2026-09-01,支出,1,首笔,商家,支付成功,seed-1,银行卡,商户消费,首笔'].join('\n');
  const edge = [headers,
    '2026-10-04,支出,980.50,房租,房东,支付成功,rent-1,零钱,商户消费,房租',
    '2026-11-05,支出,10,退款手续费,模拟平台,支付成功,fee-1,零钱,商户消费,退款手续费',
    '2026-11-05,支出,25,早餐,早餐店,支付成功,pay-1,招商银行储蓄卡(1234),商户消费,面包',
    '2026-11-05,支出,16.20,日用品,商店,,status-1,零钱,商户消费,日用品',
  ].join('\n');
  try {
    await page.clock.setFixedTime(new Date('2027-01-10T12:00:00'));
    await page.goto(base);
    await page.getByRole('button', { name: '导入账单', exact: true }).click();
    await upload('seed.csv', first);
    await page.locator('#statement-mapping-form').waitFor();
    await page.locator('[name="sourceAccountId"]').selectOption('wechat');
    await page.locator('[name="defaultAccountId"]').selectOption('salary-card');
    await page.getByRole('button', { name: '生成分页核对表' }).click();
    await page.locator('[data-import-row="0"] .import-row-editor summary').click();
    await page.locator('[data-import-row="0"] [data-import-decision]').selectOption('pending');
    await page.getByRole('button', { name: '返回字段映射' }).click();
    await page.getByRole('button', { name: '生成分页核对表' }).click();
    check(await page.locator('[data-import-row="0"] [data-import-decision]').inputValue() === 'pending', 'unchanged mapping overrode an explicit pending decision');
    await page.locator('[data-import-row="0"] [data-import-decision]').selectOption('import');
    await page.locator('[data-import-row="0"] [data-import-field="note"]').fill('首笔已核对');
    await page.locator('[data-import-row="0"] [data-import-field="accountId"]').selectOption('alipay');
    await page.getByRole('button', { name: '返回字段映射' }).click();
    await page.locator('[name="defaultAccountId"]').selectOption('wechat');
    await page.locator('[name="defaultCategoryId"]').selectOption('social');
    await page.getByRole('button', { name: '生成分页核对表' }).click();
    check(await page.locator('[data-import-row="0"] [data-import-field="note"]').inputValue() === '首笔已核对', 'changing defaults reset an unrelated note');
    check(await page.locator('[data-import-row="0"] [data-import-field="accountId"]').inputValue() === 'alipay', 'changing the default reset an explicitly confirmed account');
    check(await page.locator('[data-import-row="0"] [data-import-field="categoryId"]').inputValue() === 'social', 'changed default did not update its dependent category');
    await page.getByRole('button', { name: '确认整批入账（1 笔）' }).click();
    await page.locator('.ledger-list').waitFor();

    await page.getByRole('button', { name: '导入账单', exact: true }).click();
    await upload('edge.csv', edge);
    await page.locator('#statement-mapping-form').waitFor();
    check(await page.locator('[name="sourceAccountId"]').inputValue() === 'wechat', 'source preset was lost');
    check(await page.locator('[name="defaultAccountId"]').inputValue() === '', 'old funding account was silently reused');
    await page.locator('[name="defaultAccountId"]').selectOption('salary-card');
    await page.getByRole('button', { name: '生成分页核对表' }).click();
    await page.locator('.import-review-list').waitFor();
    check(await page.locator('[data-import-row="0"] [data-import-field="accountId"]').inputValue() === '', 'mixed payment applied a default funding account');
    check(await page.getByRole('button', { name: '应用到全部行', exact: true }).count() === 0, 'mixed payments still offered an unchecked all-rows account override');
    check((await page.locator('[data-import-row="1"]').innerText()).includes('原支付方式：零钱'), 'original payment method was not visible');
    check((await page.locator('[data-import-row="1"]').innerText()).includes('入账账户：未指定账户'), 'funding account was not shown beside original method');
    check(await page.locator('[data-import-row="1"] [data-import-field="type"]').inputValue() === 'expense', 'refund fee became income');
    check((await page.locator('[data-import-row="1"]').innerText()).includes('收支方向与原始信息冲突'), 'direction conflict was not flagged');
    await page.locator('[data-import-payment-account="零钱"]').selectOption('wechat');
    await page.locator('[data-import-payment-account="招商银行储蓄卡(1234)"]').selectOption('salary-card');
    check(await page.locator('[data-import-row="0"] [data-import-field="accountId"]').inputValue() === 'wechat', 'wallet method did not map to wallet account');
    check(await page.locator('[data-import-row="2"] [data-import-field="accountId"]').inputValue() === 'salary-card', 'bank method did not map to bank account');
    await page.screenshot({ path: 'output/playwright/p1-statement-review-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'mixed-payment review overflows on mobile');
    await page.screenshot({ path: 'output/playwright/p1-statement-review-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.locator('[data-import-row="0"] .import-row-editor summary').click();
    await page.evaluate(() => {
      window.originalStatementPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'profile_settings' && String(args[0]?.key).startsWith('statement-import:')) throw new DOMException('Draft save test', 'DataError');
        return window.originalStatementPut.apply(this, args);
      };
    });
    await page.locator('[data-import-row="0"] [data-import-field="categoryId"]').selectOption('daily');
    await page.getByText('核对进度未能保存，刷新前请重试', { exact: true }).first().waitFor();
    await page.evaluate(() => { IDBObjectStore.prototype.put = window.originalStatementPut; });
    await page.getByRole('button', { name: '重试保存进度' }).click();
    await saved();
    await page.locator('[data-import-row="0"] [data-import-field="categoryId"]').selectOption('housing');
    await saved();

    const decision = page.locator('[data-import-row="1"] [data-import-decision]');
    await decision.focus();
    await decision.selectOption('import');
    check(await page.locator('[data-import-row="1"] .import-row-editor').evaluate((element) => element.open), 'editor collapsed after keyboard change');
    check(await page.evaluate(() => document.activeElement?.matches('[data-import-row="1"] [data-import-decision]')), 'focus was lost after editing');
    await page.locator('[data-import-row="3"] [data-import-decision]').selectOption('import');
    await page.locator('[data-import-row="0"] [data-import-field="note"]').fill('房租已核对');
    await saved();
    await page.getByRole('button', { name: '返回字段映射' }).click();
    await page.getByRole('button', { name: '生成分页核对表' }).click();
    check((await page.getByRole('button', { name: '待核对 0', exact: true }).count()) === 1, 'unchanged mapping reset decisions');
    check(await page.locator('[data-import-row="0"] [data-import-field="note"]').inputValue() === '房租已核对', 'unchanged mapping reset an edit');

    await page.getByRole('button', { name: '返回字段映射' }).click();
    await page.locator('.import-column-mapping summary').click();
    await page.locator('[name="map-note"]').selectOption('9');
    await page.getByRole('button', { name: '生成分页核对表' }).click();
    check(await page.locator('[data-import-row="0"] [data-import-field="note"]').inputValue() === '房租已核对', 'unchanged row was recomputed after a mapping change');
    check(await page.locator('[data-import-row="1"] [data-import-decision]').inputValue() === 'import', 'unaffected conflict decision was lost');
    check(await page.locator('[data-import-row="2"] [data-import-field="note"]').inputValue() === '面包', 'affected row was not recomputed');
    await page.locator('[data-import-payment-account="招商银行储蓄卡(1234)"]').selectOption('salary-card');
    await saved();
    await page.reload();
    await page.locator('.import-review-list').waitFor();
    check(await page.locator('[data-import-row="0"] [data-import-field="note"]').inputValue() === '房租已核对', 'reload lost a row edit');
    check(await page.locator('[data-import-row="1"] [data-import-decision]').inputValue() === 'import', 'reload lost a direction decision');
    check(await page.locator('[data-import-row="2"] [data-import-field="accountId"]').inputValue() === 'salary-card', 'reload lost a method account');
    check((await page.getByRole('button', { name: '待核对 0', exact: true }).count()) === 1, 'reload restored unresolved rows');

    await page.getByRole('button', { name: '返回流水', exact: true }).click();
    await page.locator('.ledger-list').waitFor();
    await page.reload();
    await page.locator('.ledger-list').waitFor();
    await page.getByRole('button', { name: '导入账单', exact: true }).click();
    await page.locator('.import-review-list').waitFor();
    check(await page.locator('[data-import-row="1"] [data-import-decision]').inputValue() === 'import', 'leaving the review discarded its draft');

    await upload('other.csv', first + '\n2026-09-02,支出,2,其他,商家,支付成功,other-1,银行卡,商户消费,其他');
    await page.locator('#statement-mapping-form').waitFor();
    await upload('edge-renamed.csv', edge);
    await page.locator('.import-review-list').waitFor();
    check(await page.locator('[data-import-row="1"] [data-import-decision]').inputValue() === 'import', 'reselecting the same file did not restore its draft');
    await page.getByRole('button', { name: '确认整批入账（4 笔）' }).click();
    await page.locator('.ledger-list').waitFor();
    const transactions = await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('worker-ledger');
      request.onsuccess = () => {
        const db = request.result;
        const query = db.transaction('transactions').objectStore('transactions').getAll();
        query.onsuccess = () => { db.close(); resolve(query.result); };
        query.onerror = () => reject(query.error);
      };
      request.onerror = () => reject(request.error);
    }));
    const fee = transactions.find((row) => row.statementEntries?.some((entry) => entry.externalId === 'fee-1'));
    check(fee?.type === 'expense' && fee.amount === 1000 && fee.accountId === 'wechat', 'confirmed fee was booked with the wrong direction or account');
    check(fee.statementEntries[0].note.includes('支付方式：零钱'), 'raw payment method was not retained as source evidence');
    const settingsKeys = await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('worker-ledger');
      request.onsuccess = () => {
        const db = request.result;
        const query = db.transaction('profile_settings').objectStore('profile_settings').getAllKeys();
        query.onsuccess = () => { db.close(); resolve(query.result); };
        query.onerror = () => reject(query.error);
      };
      request.onerror = () => reject(request.error);
    }));
    const edgeKey = `statement-import:${createHash('sha256').update(edge).digest('hex')}`;
    check(!settingsKeys.includes(edgeKey) && !settingsKeys.includes('statement-import-current'), 'successful import left a stale active draft');
    check(settingsKeys.some((key) => String(key).startsWith('statement-import:')), 'switching files discarded a different draft');
    check((await page.locator('.import-result').innerText()).includes('1,031.7'), 'cross-month result total was incorrect');
    await page.getByRole('button', { name: '2026 年 11 月报表' }).click();
    check((await page.locator('#app-view').innerText()).includes('51.2'), 'November report included the wrong amount');
    await page.getByRole('button', { name: '查看流水', exact: true }).click();
    check(await page.locator('#ledger-start-date').inputValue() === '2026-11-01', 'monthly drill-down had the wrong start');
    check(await page.locator('#ledger-end-date').inputValue() === '2026-11-30', 'monthly drill-down had the wrong end');
    check(!(await page.locator('.ledger-list').innerText()).includes('房租已核对'), 'monthly drill-down included October');

    await page.locator('[data-view="reports"]:visible').first().click();
    await page.getByRole('button', { name: '每周', exact: true }).click();
    await page.getByRole('button', { name: '上一期' }).click();
    await page.getByRole('button', { name: '上一期' }).click();
    await page.getByRole('button', { name: '查看流水', exact: true }).click();
    check(await page.locator('#ledger-start-date').inputValue() === '2026-10-26', 'weekly drill-down had the wrong start');
    check(await page.locator('#ledger-end-date').inputValue() === '2026-11-01', 'weekly drill-down had the wrong end');
    check(!errors.length, `browser errors: ${errors.join('; ')}`);
    return 'PASS: statement conflicts, payment-account mapping, local draft recovery, selective remapping, focus, and monthly/weekly drill-down';
  } catch (error) {
    throw new Error(`${error.message}\nPage errors: ${errors.join('; ')}\nPage text: ${(await page.locator('#app-view').innerText()).slice(0, 1600)}`, { cause: error });
  } finally {
    await context.close();
  }
}
