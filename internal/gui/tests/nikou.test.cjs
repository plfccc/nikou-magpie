const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const envelope = (data) => ({ protocol: 1, requestId: "fixture-read", ok: true, data });

async function userClick(page, locator) {
  // 全局阅读位置守卫只接受用户主动滚动；先用真实滚轮把控件带入视口。
  const delta = await locator.evaluate((element) => {
    const view = element.closest(".view");
    if (!view) return 0;
    const target = element.getBoundingClientRect(), bounds = view.getBoundingClientRect();
    return target.top < bounds.top ? target.top - bounds.top - 16
      : target.bottom > bounds.bottom ? target.bottom - bounds.bottom + 16 : 0;
  });
  if (delta) {
    const view = page.locator("#view-nikou");
    const bounds = await view.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, delta);
  }
  await locator.click();
}

async function fixture(browser, lang = "zh", width = 420, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: 820 } });
  const page = await context.newPage();
  if (options.clock) await page.clock.install();
  page.setDefaultTimeout(5000);
  const errors = [], writes = [], reads = [];
  const state = { instanceId: "fixture-instance", failStatus: false, failWrite: false, failHello: !!options.failHello, holdWrite: false,
    status: { workerStatus: "running", connection: "online", engine: "codex", supervisor: "console", launchProfile: { model: "gpt-test", effort: "medium" } },
    scopes: { p2p: { model: "gpt-test", effort: "medium" }, group: { model: "gpt-test", effort: "high" } } };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = ${JSON.stringify({ lang, theme: "light", web: false, pluginConfig: { nikou: { pollSeconds: 5 } } })};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname.startsWith("/api/nikou/")) {
      const endpoint = url.pathname.slice("/api/nikou/".length);
      if (request.method() === "POST") {
        writes.push({ endpoint, body: request.postDataJSON() });
        while (state.holdWrite) await new Promise((resolve) => setTimeout(resolve, 10));
        if (state.nextInstanceId) state.instanceId = state.nextInstanceId;
        if (state.operationUnknown) return json({ protocol: 1, requestId: request.postDataJSON().requestId, ok: false, error: { code: "OPERATION_UNKNOWN", message: "操作结果未知" } });
        if (state.failWrite) return json({ protocol: 1, ok: false, error: { code: "WORKER_ERROR", message: "操作失败 <img src=x onerror=alert(1)>" } });
        return json({ ...envelope(endpoint === "open" ? { opened: true, url: "http://127.0.0.1:19736/" } : {}), requestId: state.wrongWriteId ? "wrong-id" : request.postDataJSON().requestId });
      }
      reads.push(endpoint);
      if (endpoint === "hello") {
        if (state.httpError) return route.fulfill({ status: 503, json: { protocol: 1, ok: false, error: { code: "OFFLINE", message: "控制台 HTTP 故障" } } });
        if (state.badRead) return json({ ...envelope({}), protocol: 2 });
        if (state.missingReadId) return json({ protocol: 1, ok: true, data: { service: "nikou-console", protocol: 1 } });
        return json(state.failHello ? { protocol: 1, ok: false, error: { code: "UNAVAILABLE", message: "控制台暂不可用" } } : envelope({ service: "nikou-console", protocol: 1, instanceId: state.instanceId, capabilities: state.noCapabilities ? {} : { workerControl: true, scopedRuntime: true, operationStatus: true, accounts: true } }));
      }
      if (endpoint === "status") return json(state.failStatus ? { protocol: 1, ok: false, error: { code: "OFFLINE", message: "连接中断" } } : envelope({ status: state.status, scopes: state.scopes }));
      if (endpoint === "runtime/catalog") return json(envelope({ engines: ["codex", "claude", "kiro"].map((value) => ({ value, label: value, enabled: true })), models: [{ value: "gpt-test", label: "gpt-test" }, { value: "other-model", label: "other-model" }], efforts: ["medium", "high"], defaultModel: "gpt-test", defaultEffort: "medium" }));
      if (endpoint === "accounts") return json(envelope({ currentAlias: "主账号", profiles: [{ id: "encoded-account-id", alias: "备用账号", planLabel: "套餐", usageLabel: "剩余 80%", stale: !!state.quotaStale, fetchOk: !state.quotaStale, updatedAt: "2026-10-18T08:00:00Z" }] }));
      return json(envelope({ state: state.unknownReceipt ? "unknown" : "succeeded" }));
    }
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: { lang, theme: "light" } });
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: {}, plugins: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    try { return route.fulfill({ body: await fs.readFile(file), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[path.extname(file)] }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  await page.goto("https://magpie.test/?view=nikou");
  return { context, page, state, writes, reads, errors, view: page.locator("#view-nikou") };
}

for (const engine of process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"]) {
  test(`${engine}: Nikou 菜单关闭、重绘清理和定位`, async t => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    for (const width of [420, 1100]) {
      const f = await fixture(browser, "zh", width, { clock: true });
      try {
        const pick = f.view.locator('[data-pick="engine"]');
        const menu = f.page.getByRole("menu");
        await f.view.locator('[data-action="check"]:enabled').waitFor();
        await userClick(f.page, pick);
        await menu.waitFor();
        const anchor = await pick.boundingBox(), box = await menu.boundingBox();
        assert.ok(Math.abs(anchor.x - box.x) < 2, "菜单左侧与触发器对齐");
        assert.ok(box.x >= 0 && box.x + box.width <= width, "菜单不超出窗口");
        await f.view.locator('[data-engine-label]').click();
        await menu.waitFor({ state: "detached" });
        await pick.click();
        await pick.click();
        await menu.waitFor({ state: "detached" });
        await pick.click();
        await f.page.keyboard.press("Escape");
        await menu.waitFor({ state: "detached" });
        assert.equal(await pick.getAttribute("aria-expanded"), "false");
        await pick.click();
        await f.page.clock.runFor(5100);
        await f.view.locator('[data-action="check"]:enabled').waitFor();
        await menu.waitFor({ state: "detached" });
        await pick.click();
        await f.page.evaluate(() => show("agents"));
        await menu.waitFor({ state: "detached" });
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    }
  });

  test(`${engine}: Nikou 显示真实状态并确认写操作`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    for (const lang of ["zh", "en"]) for (const width of [420, 1100]) await t.test(`${lang} ${width}`, async () => {
      const f = await fixture(browser, lang, width);
      const { page, view, state, writes } = f;
      try {
        await view.locator('[data-status="engine"]').filter({ hasText: "codex" }).waitFor().catch(async (error) => {
          error.message += "\n" + JSON.stringify({ errors: f.errors, reads: f.reads, page: (await page.locator("body").innerText()).slice(-1800) });
          throw error;
        });
        assert.equal(await view.locator('[data-status="supervisor"]').innerText(), "控制台");
        assert.match(await view.innerText(), /gpt-test/);
        assert.equal(await view.locator("select, iframe").count(), 0);
        await view.locator('[data-pick="engine"]').click();
        await page.getByRole("menuitemradio", { name: "claude", exact: true }).click();
        page.once("dialog", (dialog) => dialog.dismiss());
        await view.locator('[data-action="save-p2p"]').click();
        assert.equal(writes.length, 0, "取消引擎确认不应写入");
        page.once("dialog", (dialog) => dialog.accept());
        state.holdWrite = true;
        const posted = page.waitForRequest((r) => r.url().endsWith("/api/nikou/runtime/select") && r.method() === "POST");
        await view.locator('[data-action="save-p2p"]').click();
        await posted;
        assert.equal(await view.locator('[data-action="restart"]').isDisabled(), true);
        assert.equal(writes[0].body.engine, "claude");
        assert.equal(writes[0].body.scope, "p2p");
        assert.equal(writes[0].body.restart, true);
        assert.equal(writes[0].body.confirmed, true);
        assert.match(writes[0].body.requestId, /^[a-f0-9-]{36}$/);
        state.holdWrite = false;
        await view.locator('[data-action="restart"]:enabled').waitFor();
        assert.equal(await view.locator('[data-status="engine"]').innerText(), "codex", "写回执不能冒充新的运行状态");
        state.failWrite = true;
        await view.locator('[data-action="restart"]').click();
        await view.getByRole("alert").filter({ hasText: "操作失败" }).waitFor();
        assert.equal(await view.locator('img[src="x"]').count(), 0);
        assert.notEqual(writes[0].body.requestId, writes[1].body.requestId);
        assert.equal(await view.locator('[data-status="engine"]').innerText(), "codex");
        state.failWrite = false;
        const opened = page.waitForResponse((r) => r.url().endsWith("/api/nikou/open"));
        await userClick(page, view.locator('[data-action="open"]'));
        await opened;
        assert.equal(writes.at(-1).endpoint, "open");
        assert.ok(await view.evaluate((element) => element.scrollWidth <= element.clientWidth), "窄窗口没有横向溢出");
        assert.deepEqual(f.errors, []);
      } finally { state.holdWrite = false; await f.context.close(); }
    });
  });

  test(`${engine}: Nikou 握手失败禁止写入且重读失败保留数据`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const f = await fixture(browser, "zh", 420, { failHello: true });
    t.after(() => f.context.close());
    await f.view.getByRole("alert").filter({ hasText: "控制台暂不可用" }).waitFor();
    assert.equal(await f.view.locator('[data-action="start"]').isDisabled(), true);
    await f.view.locator('[data-action="open"]').click();
    await f.view.getByText("已打开完整控制台", { exact: true }).waitFor();
    assert.equal(f.writes.at(-1).endpoint, "open");
    f.state.failHello = false;
    await userClick(f.page, f.view.locator('[data-action="check"]'));
    await f.view.locator('[data-status="engine"]').filter({ hasText: "codex" }).waitFor();
    f.state.failStatus = true;
    await userClick(f.page, f.view.locator('[data-action="check"]'));
    await f.view.getByRole("alert").filter({ hasText: "连接中断" }).waitFor();
    assert.equal(await f.view.locator('[data-status="engine"]').innerText(), "codex");
    assert.equal(await f.view.locator('[data-action="start"]').isDisabled(), true);
    assert.deepEqual(f.errors, []);
  });

  test(`${engine}: Nikou 账号使用稳定引用且不支持的能力不可操作`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const f = await fixture(browser);
    t.after(() => f.context.close());
    const clickWrite = async (selector, endpoint) => {
      const response = f.page.waitForResponse((r) => r.url().endsWith("/api/nikou/" + endpoint));
      await userClick(f.page, f.view.locator(selector));
      await response;
      await f.view.locator('[data-action="check"]:enabled').waitFor();
    };
    await clickWrite('[data-action="account-select"]', "accounts/select");
    assert.equal(f.writes.at(-1).body.accountId, "encoded-account-id");
    assert.equal(f.writes.at(-1).body.confirmed, true);
    await clickWrite('[data-action="account-refresh"]', "accounts/refresh");
    assert.equal(f.writes.at(-1).body.accountId, "encoded-account-id");
    await clickWrite('[data-action="save-group"]', "runtime/select");
    assert.equal(f.writes.at(-1).body.scope, "group");
    assert.equal(f.writes.at(-1).body.restart, false);
    await clickWrite('[data-action="stop"]', "worker/control");
    assert.equal(f.writes.at(-1).body.action, "stop");
    assert.equal(f.writes.at(-1).body.engine, "codex");
    assert.equal(f.writes.at(-1).body.model, "gpt-test");
    await f.view.locator('[data-pick="engine"]').click();
    await f.page.getByRole("menuitemradio", { name: "kiro", exact: true }).click();
    await f.view.getByText("当前引擎暂不支持在此管理账号。", { exact: true }).waitFor();
    assert.equal(await f.view.locator('[data-action="account-select"]').count(), 0);
    assert.equal(new Set(f.writes.map((item) => item.body.requestId)).size, f.writes.length);
    assert.deepEqual(f.errors, []);
  });

  test(`${engine}: Nikou 查询未知结果且隔离控制台实例的回执`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    for (const change of ["same", "unknown-new", "success-new"]) {
      const f = await fixture(browser);
      try {
        await f.view.locator('[data-action="check"]:enabled').waitFor();
        f.state.operationUnknown = change !== "success-new";
        if (change !== "same") f.state.nextInstanceId = "replacement-instance";
        const beforeStatus = f.reads.filter((item) => item === "status").length;
        await userClick(f.page, f.view.locator('[data-action="stop"]'));
        await f.view.locator('[data-action="check"]:enabled').waitFor();
        if (change === "same") {
          await f.view.locator('[data-notice]').filter({ hasText: "操作已完成" }).waitFor();
          assert.equal(f.reads.filter((item) => item.startsWith("operations/")).length, 1);
        } else {
          await f.view.locator('[data-notice]').filter({ hasText: "控制台实例已变化" }).waitFor();
          assert.equal(f.reads.filter((item) => item.startsWith("operations/")).length, 0, "不应读取新实例的同 ID 回执");
          assert.ok(f.reads.filter((item) => item === "status").length > beforeStatus, "实例变化后重读真实状态");
        }
        assert.equal(f.writes.length, 1, "结果未知或实例更换均不重放写操作");
      } finally { await f.context.close(); }
    }
  });

  test(`${engine}: Nikou 写超时保留结果未知且不自动重放`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const f = await fixture(browser, "zh", 420, { clock: true });
    t.after(async () => { f.state.holdWrite = false; await f.context.close(); });
    await f.view.locator('[data-action="check"]:enabled').waitFor();
    f.state.holdWrite = true;
    f.state.unknownReceipt = true;
    const posted = f.page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/worker/control"));
    await f.view.locator('[data-action="stop"]').click();
    await posted;
    await f.page.clock.runFor(30001);
    await f.view.getByRole("alert").filter({ hasText: "操作等待超时" }).waitFor();
    await f.view.locator('[data-notice]').filter({ hasText: "操作结果待确认" }).waitFor();
    assert.equal(f.writes.length, 1);
    assert.equal(await f.view.locator('[data-status="engine"]').innerText(), "codex");
  });

  test(`${engine}: Nikou 校验协议、关联写回执并显示 HTTP 错误`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const f = await fixture(browser, "zh", 420);
    t.after(() => f.context.close());
    await f.view.locator('[data-action="check"]:enabled').waitFor();
    f.state.wrongWriteId = true;
    await f.view.locator('[data-action="stop"]').click();
    await f.view.getByRole("alert").filter({ hasText: "控制台响应无效" }).waitFor();
    assert.equal(f.writes.length, 1, "错误回执不能重放写操作");
    f.state.httpError = true;
    await userClick(f.page, f.view.locator('[data-action="check"]'));
    await f.view.getByRole("alert").filter({ hasText: "控制台 HTTP 故障" }).waitFor();
    f.state.httpError = false;
    f.state.badRead = true;
    await userClick(f.page, f.view.locator('[data-action="check"]'));
    await f.view.getByRole("alert").filter({ hasText: "控制台响应无效" }).waitFor();
    f.state.badRead = false;
    f.state.missingReadId = true;
    await userClick(f.page, f.view.locator('[data-action="check"]'));
    await f.view.getByRole("alert").filter({ hasText: "控制台响应无效" }).waitFor();
    f.state.missingReadId = false;
    f.state.noCapabilities = true;
    await userClick(f.page, f.view.locator('[data-action="check"]'));
    await f.view.locator('[data-action="check"]:enabled').waitFor();
    assert.equal(await f.view.locator('[data-action="stop"]').isDisabled(), true);
    assert.equal(await f.view.locator('[data-action="save-p2p"]').isDisabled(), true);
    assert.equal(await f.view.locator('[data-action="account-select"]').count(), 0);
  });

  test(`${engine}: 额度刷新失败后轮询仍明确展示旧快照及时间`, async t => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const f = await fixture(browser, "zh", 1100);
    t.after(() => f.context.close());
    await f.view.locator('[data-quota-freshness="fresh"]').waitFor();
    f.state.quotaStale = true;
    f.state.failWrite = true;
    await userClick(f.page, f.view.locator('[data-action="account-refresh"]'));
    await f.view.getByRole("alert").waitFor();
    await userClick(f.page, f.view.locator('[data-action="check"]'));
    const stale = f.view.locator('[data-quota-freshness="stale"]');
    await stale.waitFor();
    assert.match(await stale.innerText(), /已过期或刷新失败/);
    assert.match(await stale.innerText(), /2026-10-18T08:00:00Z/);
    assert.match(await f.view.locator('[data-accounts]').innerText(), /剩余 80%/);
    assert.equal(f.writes.filter(w => w.endpoint === "accounts/refresh").length, 1);
  });

  test(`${engine}: Nikou 页面隐藏、标签隐藏或插件关闭时暂停轮询`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    const f = await fixture(browser, "zh", 1100, { clock: true });
    t.after(() => f.context.close());
    await f.view.locator('[data-action="check"]:enabled').waitFor();
    const count = () => f.reads.filter((item) => item === "status").length;
    const initial = count();
    await f.page.clock.runFor(5100);
    await f.page.waitForFunction(() => document.querySelector('#view-nikou [data-action="check"]').disabled === false);
    assert.ok(count() > initial, "可见页面按配置刷新");
    await f.page.evaluate(() => show("agents"));
    const hidden = count();
    await f.page.clock.runFor(16000);
    assert.equal(count(), hidden, "离开页面后不再轮询");
    await f.page.evaluate(() => show("nikou"));
    await f.view.locator('[data-action="check"]:enabled').waitFor();
    assert.ok(count() > hidden);
    await f.page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const invisible = count();
    await f.page.clock.runFor(16000);
    assert.equal(count(), invisible, "浏览器标签隐藏后不再轮询");
    await f.page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await f.view.locator('[data-action="check"]:enabled').waitFor();
    await f.page.evaluate(() => applyFeatures([{ id: "nikou", on: false }]));
    const disabled = count();
    await f.page.clock.runFor(16000);
    assert.equal(count(), disabled, "关闭插件后不再轮询");
    assert.deepEqual(f.errors, []);
  });
}
