const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  test(`${name}: 公司工具与 Job 展示、确认及回执不重发`, async t => {
    const browser = await engine.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    const writes = [];
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith('/api/nikou/')) return route.fulfill({ contentType: 'text/html', body: '<main id="root"></main>' });
      const endpoint = url.pathname.slice('/api/nikou/'.length);
      const body = route.request().postDataJSON();
      let data = {};
      if (body) {
        writes.push({ endpoint, body });
        return route.fulfill({ json: { protocol: 1, requestId: body.requestId, ok: false, error: { code: 'OPERATION_UNKNOWN', message: '待确认' } } });
      }
      if (endpoint === 'hello') data = { instanceId: 'test' };
      if (endpoint === 'company-tools') data = { tools: [{ name: 'hst-mcp', installed: '1.1.15', latest: '1.1.16', state: 'update-available' }, { name: 'nikou-node', installed: '2.0.70', latest: '2.0.74', state: 'update-available' }], initialization: { hst: { state: 'ready' }, node: { state: 'ready' } } };
      if (endpoint === 'jobs') data = { daemon: { status: 'running' }, jobs: [{ id: 'job-1', name: '<img src=x onerror=alert(1)>', enabled: true, lastStatus: 'success' }] };
      if (endpoint === 'jobs/service') data = { registered: true, running: true };
      if (endpoint.startsWith('operations/')) data = { state: 'succeeded', reply: { data: { updated: true } } };
      return route.fulfill({ json: { protocol: 1, requestId: 'test', ok: true, data } });
    });
    await page.goto('https://magpie.test');
    await page.evaluate(() => {
      window.ui = { el(tag, cls, value) { const node = document.createElement(tag); if (cls) node.className = cls; if (value) node.textContent = value; return node; }, button(label, handler) { const b = document.createElement('button'); b.textContent = label; b.onclick = handler; return b; } };
    });
    await page.addScriptTag({ path: path.join(__dirname, '../assets/plugins/nikou/company.js') });
    await page.evaluate(() => { window.panel = window.mountNikouCompany(document.querySelector('#root'), window.ui); return window.panel.refresh(); });
    assert.match(await page.textContent('#root'), /1\.1\.16/);
    assert.match(await page.textContent('#root'), /已开启登录启动/);
    assert.equal(await page.locator('img').count(), 0);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-tool="hst-mcp"]').getByRole('button', { name: '检查并升级' }).click();
    await page.getByRole('status').filter({ hasText: '操作已完成' }).waitFor();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.confirmed, true);
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.panel.dispose());
    assert.equal(await page.locator('.nikou-company').count(), 0);
  });
}
