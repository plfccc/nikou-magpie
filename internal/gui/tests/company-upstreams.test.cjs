const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  for (const width of [420, 1100]) test(`${name} 上游检测 ${width}`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      // 隔离版本行组件，防止测试触发任何真实 API。
      await page.setContent(`<style>.row{display:flex;gap:12px}.who{flex:1;min-width:0}.sub{overflow-wrap:anywhere}.val{width:110px;flex-shrink:0}button{max-width:100%;white-space:normal}</style><div class="row"><div class="who"></div><div class="val"></div></div>`);
      await page.addStyleTag({ content: await fs.readFile(path.resolve(__dirname, "../assets/app.css"), "utf8") });
      await page.addStyleTag({ content: await fs.readFile(path.resolve(__dirname, "../assets/company-upstreams.css"), "utf8") });
      await page.addScriptTag({ content: `const el=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls||"";e.textContent=text||"";return e};const prefs={updateEvery:360};const updatePath=x=>x;let calls=0,saved=null;const api=async()=>{calls++};const savePrefs=async x=>{saved=x};const renderUpdate=()=>{};` });
      await page.addScriptTag({ content: await fs.readFile(path.resolve(__dirname, "../assets/company-upstreams.js"), "utf8") });
      const fixture = { current: "1.0.0-dev.1", upstreams: { nikouVersion: "0.1.89", checkedAt: "2026-10-19T00:00:00Z", items: [
        { name: "magpie", baseline: "a".repeat(40), latest: "b".repeat(40), state: "changed" },
        { name: "nikou", baseline: "c".repeat(40), state: "unknown", error: "上游返回 HTTP 401，可能需要仓库访问权限" },
      ] } };
      fixture.upstreams.maintenance = {status:'blocked',summary:'接口兼容存在两种方案，请确认保留旧行为还是迁移',completedAt:'2026-10-20T09:00:00+08:00',notification:{status:'sent'}};
      await page.evaluate(data => renderCompanyUpstreams(document.querySelector(".row"), data), fixture);
      assert.match(await page.locator(".cu-list").innerText(), /有更新/);
      assert.match(await page.locator('.cu-maintenance').innerText(), /等待你确认/);
      assert.match(await page.locator('.cu-maintenance').innerText(), /飞书通知已发送/);
      assert.match(await page.locator('.cu-maintenance').innerText(), /接口兼容/);
      fixture.upstreams.maintenance = { status: 'running', progress: { stage: 'Nikou完整测试', status: 'running', completedChecks: 12 }, heartbeat: { updatedAt: '2026-10-20T09:01:00+08:00' } };
      await page.evaluate(data => renderCompanyUpstreams(document.querySelector('.row'), data), fixture);
      assert.match(await page.locator('.cu-maintenance').innerText(), /Nikou完整测试/);
      assert.match(await page.locator('.cu-maintenance').innerText(), /已完成 12 项检查/);
      assert.match(await page.locator('.cu-maintenance').innerText(), /执行器心跳/);
      assert.match(await page.locator(".cu-list").innerText(), /检查失败/);
      assert.match(await page.locator(".cu-version").innerText(), /1.0.0-dev.1 · Nikou 0.1.89/);
      assert.equal(await page.locator("details").getAttribute("open"), null);
      assert.ok(!(await page.locator(".sub").innerText()).includes("aaaaaaaa"), "默认隐藏提交号");
      await page.getByText("技术详情", { exact: true }).click();
      assert.match(await page.locator("details").innerText(), /aaaaaaaa/);
      await page.getByRole("checkbox").uncheck();
      assert.equal(await page.evaluate(() => saved.noAutoUpdate), true);
      assert.equal(await page.locator("button").count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByRole("button", { name: "立即检查" }).click();
      assert.equal(await page.evaluate(() => calls), 1);
      await page.evaluate(data => { data.upstreams.checking = true; renderCompanyUpstreams(document.querySelector(".row"), data); }, fixture);
      assert.equal(await page.getByRole("button").isDisabled(), true);
      assert.equal(await page.locator("details").getAttribute("open"), "", "刷新保留详情展开状态");
      if (process.env.NIKOU_UI_SCREENSHOTS) {
        await page.getByText("技术详情", { exact: true }).click();
        await page.screenshot({ path: path.join(process.env.NIKOU_UI_SCREENSHOTS, `version-${name}-${width}.png`) });
      }
    } finally { await browser.close(); }
  });
}
