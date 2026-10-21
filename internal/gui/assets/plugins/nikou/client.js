(() => {
  magpie.plugin("nikou", (ctx) => {
    const { ui } = ctx;
    let root, timer, observer, controller, reading = null, companyPanel;
    let hello = null, snapshot = null, catalogs = {}, accounts = null;
    let selectedEngine = "", drafts = {}, dirty = false, busy = false, checked = false, disposed = false;
    let errorText = "", noticeText = "", catalogTurn = 0, gatewayState = null, writingEndpoint = "";
    const $ = (selector) => root.querySelector(selector);
    const words = (value) => t(value);
    const text = (tag, cls, value) => ui.el(tag, cls, words(value));
    const statusNames = { running: "运行中", stopped: "已停止", online: "已连接", connected: "已连接", offline: "未连接", connecting: "连接中" };
    const ownerNames = { console: "控制台", "cc-switch": "cc-switch", systemd: "系统服务", none: "未托管" };
    const effortNames = { low: "低", medium: "中", high: "高", xhigh: "更高", max: "最高" };
    const active = () => !disposed && root && !root.hidden && !document.hidden
      && !document.querySelector('#nav [data-view="nikou"]')?.hidden;
    const can = (capability) => checked && !!hello?.capabilities?.[capability] && !busy && !reading && active();
    const accountSupported = () => !!hello?.capabilities?.accounts && ["codex", "claude"].includes(selectedEngine);
    const current = () => snapshot?.status || {};
    const showError = (error) => { errorText = String(error?.message || words("请求失败，请重试")); paintMessages(); };

    async function request(endpoint, body, signal) {
      const response = await fetch("/api/nikou/" + endpoint, {
        method: body ? "POST" : "GET", credentials: "same-origin", signal,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = await response.json();
      if (result?.protocol !== 1 || result?.ok !== true || !response.ok) {
        const error = new Error(result?.error?.message || words("控制台响应无效"));
        error.code = result?.error?.code;
        throw error;
      }
      if ((endpoint !== "open" && (typeof result.requestId !== "string" || !result.requestId.trim()
        || body && result.requestId !== body.requestId)) || !result.data || typeof result.data !== "object") throw new Error(words("控制台响应无效"));
      return result.data;
    }

    function pause() {
      clearTimeout(timer);
      timer = null;
      root?.querySelectorAll("[data-pick]").forEach(button => button.disposeMenu?.());
      if (!busy) controller?.abort();
    }

    function schedule() {
      clearTimeout(timer);
      if (!active() || busy) return;
      const seconds = Math.min(120, Math.max(5, Number(ctx.config.pollSeconds) || 10));
      timer = setTimeout(() => { if (active()) refresh(); }, seconds * 1000);
    }

    function paintMessages() {
      if (!root) return;
      $(".nikou-error").textContent = errorText;
      $(".nikou-error").hidden = !errorText;
      $("[data-notice]").textContent = noticeText;
      $("[data-connection]").textContent = checked ? words("控制台已连接") : words("控制台尚未连接，写操作暂不可用");
    }

    function lock() {
      if (!root) return;
      root.setAttribute("aria-busy", String(busy || !!reading));
      for (const button of root.querySelectorAll("button")) {
        const action = button.dataset.action;
        if (action === "check") button.disabled = busy || !!reading;
        else if (action === "open") button.disabled = busy || !!reading || !active();
        else if (["start", "stop", "restart"].includes(action)) button.disabled = !can("workerControl");
        else if (action === "gateway-connect") {
          button.disabled = !can("gatewayConnection") || !gatewayState?.known;
          const registering = busy && writingEndpoint === "gateway/connect";
          button.textContent = words(registering ? "正在登记…" : "登记网关连接");
          button.setAttribute("aria-busy", String(registering));
        }
        else if (action?.startsWith("save-")) {
          const scope = action.slice(5), catalog = catalogs[scope];
          button.disabled = !can("scopedRuntime")
            || !catalog?.engines?.some((item) => item.value === selectedEngine && item.enabled !== false)
            || !catalog?.models?.some((item) => option(item).v === drafts[scope]?.model && item.enabled !== false);
        }
        else if (action?.startsWith("account-")) button.disabled = !can("accounts") || !accountSupported() || button.dataset.current === "true" && action === "account-select";
        else button.disabled = busy || !!reading || !checked || !active() || button.dataset.unavailable === "true";
      }
    }

    function menu(host, kind, options, value, title, onPick) {
      options = options.filter((item) => !item.disabled);
      host.firstElementChild?.disposeMenu?.();
      const button = ui.menu(options, value, words(title), onPick, { align: "left", className: "nikou-menu" });
      button.dataset.pick = kind;
      button.setAttribute("aria-label", words(title));
      button.dataset.unavailable = String(!options.some((item) => !item.disabled));
      host.replaceChildren(button);
    }

    const option = (item) => typeof item === "string"
      ? { v: item, name: words(effortNames[item] || item) }
      : { v: item.value, name: item.label || item.value, disabled: item.enabled === false };

    function paintPickers() {
      const catalog = catalogs.p2p || {};
      menu($("[data-engine]"), "engine", (catalog.engines || []).map(option), selectedEngine || words("尚未读取"), "选择引擎", async (engine) => {
        selectedEngine = engine;
        dirty = true;
        drafts = {};
        await readCatalogs();
      });
      for (const scope of ["p2p", "group"]) {
        const cat = catalogs[scope] || {};
        const draft = drafts[scope] || {};
        menu($(`[data-model="${scope}"]`), "model-" + scope, (cat.models || []).map(option), draft.model || words("无可用模型"), "选择模型", async (model) => {
          drafts[scope] = { ...drafts[scope], model };
          dirty = true;
          await readCatalogs(scope);
        });
        menu($(`[data-effort="${scope}"]`), "effort-" + scope, (cat.efforts || []).map(option), draft.effort || words("由引擎决定"), "选择思考档位", (effort) => {
          drafts[scope] = { ...drafts[scope], effort };
          dirty = true;
        });
        $(`[data-saved="${scope}"]`).textContent = words("已保存：") + (snapshot?.scopes?.[scope]?.model || words("默认模型"))
          + " · " + words(effortNames[snapshot?.scopes?.[scope]?.effort] || snapshot?.scopes?.[scope]?.effort || "由引擎决定");
      }
      $("[data-catalog-note]").textContent = catalog.note || (catalog.stale ? words("模型目录为缓存，请检查控制台连接后重试。") : "");
      lock();
    }

    function paintAccounts() {
      const list = $("[data-accounts]");
      list.replaceChildren();
      if (!accountSupported()) {
        list.append(text("p", "nikou-note", "当前引擎暂不支持在此管理账号。"));
        return;
      }
      list.append(text("p", "nikou-note", words("当前账号：") + (accounts?.currentAlias || words("尚未选择"))));
      if (!accounts?.profiles?.length) list.append(text("p", "nikou-note", "没有可用账号，请在完整控制台中配置。"));
      for (const profile of accounts?.profiles || []) {
        const row = ui.el("div", "row nikou-account");
        const who = ui.el("div", "who");
        who.append(ui.el("div", "name", profile.alias || profile.account || words("未命名账号")),
          ui.el("div", "sub", [profile.planLabel, profile.usageLabel, profile.ruleLabel].filter(Boolean).join(" · ")));
        const stale = profile.stale === true || profile.fetchOk === false;
        const freshness = ui.el("div", "nikou-note");
        freshness.dataset.quotaFreshness = stale ? "stale" : "fresh";
        freshness.textContent = (stale ? words("额度快照已过期或刷新失败，当前数值仅供参考。") : words("额度快照"))
          + " · " + words("快照时间：") + (profile.updatedAt || words("尚未记录"));
        who.append(freshness);
        const tools = ui.el("div", "nikou-tools");
        for (const [action, label] of [["select", "切换账号"], ["refresh", "刷新用量"]]) {
          const button = ui.button(words(label), () => write("accounts/" + action, { engine: selectedEngine, accountId: profile.id }));
          button.dataset.action = "account-" + action;
          button.dataset.current = String(!!profile.current);
          tools.append(button);
        }
        row.append(who, tools);
        list.append(row);
      }
      lock();
    }

    async function readGateway(connected, signal) {
      if (!connected.capabilities?.gatewayConnection) return null;
      try {
        const [gateway, catalog] = await Promise.all([
          request("gateway", undefined, signal), request("v2/runtime/catalog", undefined, signal),
        ]);
        if (!Array.isArray(gateway.models) || !Array.isArray(catalog.models) || typeof catalog.configured !== "boolean") throw new Error();
        // 仅保留展示摘要，不把来源标识和端点凭据交给 DOM 或页面状态。
        return { known: true, configured: catalog.configured, availableCount: gateway.models.length, registeredCount: catalog.models.length };
      } catch { return { known: false }; }
    }

    function paintGateway() {
      const panel = $("[data-gateway]");
      panel.hidden = !hello?.capabilities?.gatewayConnection;
      $("[data-gateway-state]").textContent = words(!gatewayState?.known ? "登记状态读取失败，请重新检查连接。"
        : gatewayState.configured ? "已登记，待执行验证" : "尚未登记");
      $("[data-gateway-count]").textContent = gatewayState?.known
        ? words("当前网关目录模型数：") + gatewayState.availableCount + " · " + words("已登记模型数：") + gatewayState.registeredCount : "";
    }

    function paint() {
      const state = current();
      const values = {
        worker: words(statusNames[state.workerStatus] || "尚未读取"), connection: words(statusNames[state.connection] || "尚未读取"),
        engine: state.engine || words("尚未读取"), model: state.launchProfile?.model || words("默认模型"),
        effort: words(effortNames[state.launchProfile?.effort] || state.launchProfile?.effort || "由引擎决定"),
        supervisor: words(ownerNames[state.supervisor] || state.supervisor || "尚未读取"),
      };
      for (const [key, value] of Object.entries(values)) $(`[data-status="${key}"]`).textContent = value;
      paintMessages();
      paintPickers();
      paintAccounts();
      paintGateway();
      lock();
    }

    const catalogPath = (engine, model = "") => "runtime/catalog?" + new URLSearchParams({ engine, model });

    function takeDraft(scope, catalog, values = {}) {
      const models = (catalog.models || []).map((item) => option(item).v);
      const efforts = (catalog.efforts || []).map((item) => option(item).v);
      return { model: models.includes(values.model) ? values.model : catalog.defaultModel || models[0] || "",
        effort: efforts.includes(values.effort) ? values.effort : catalog.defaultEffort || efforts[0] || "" };
    }

    async function readCatalogs(scope) {
      const turn = ++catalogTurn;
      const engine = selectedEngine;
      busy = true;
      lock();
      try {
        const scopes = scope ? [scope] : ["p2p", "group"];
        const results = await Promise.all(scopes.map(async (key) => [key, await request(catalogPath(engine, drafts[key]?.model))]));
        const nextAccounts = !scope && accountSupported() ? await request("accounts?" + new URLSearchParams({ engine })) : accounts;
        if (turn !== catalogTurn || disposed) return;
        for (const [key, cat] of results) {
          catalogs[key] = cat;
          drafts[key] = takeDraft(key, cat, drafts[key]);
        }
        accounts = nextAccounts;
        errorText = "";
        paintPickers();
        paintAccounts();
      } catch (error) { if (turn === catalogTurn) { checked = false; showError(error); } }
      finally { if (turn === catalogTurn) { busy = false; lock(); schedule(); } }
    }

    async function refresh() {
      if (!active() || busy) return;
      if (reading) return reading;
      clearTimeout(timer);
      controller = new AbortController();
      const signal = controller.signal;
      const timeout = setTimeout(() => controller.abort(), 15000);
      reading = (async () => {
        try {
          const connected = await request("hello", undefined, signal);
          if (connected.service !== "nikou-console" || connected.protocol !== 1) throw new Error(words("连接的服务不兼容，请检查控制台端口。"));
          const next = await request("status", undefined, signal);
          if (!next.status || !next.scopes) throw new Error(words("控制台状态无效"));
          const engine = dirty ? selectedEngine : next.status.engine;
          const results = await Promise.all(["p2p", "group"].map(async (key) => {
            const values = dirty ? drafts[key] : next.scopes[key];
            return [key, await request(catalogPath(engine, values?.model), undefined, signal)];
          }));
          const nextAccounts = connected.capabilities?.accounts && ["codex", "claude"].includes(engine)
            ? await request("accounts?" + new URLSearchParams({ engine }), undefined, signal) : null;
          const nextGateway = await readGateway(connected, signal);
          if (!active() || signal.aborted) return;
          hello = connected;
          snapshot = next;
          selectedEngine = engine;
          accounts = nextAccounts;
          gatewayState = nextGateway;
          for (const [key, cat] of results) {
            catalogs[key] = cat;
            drafts[key] = takeDraft(key, cat, dirty ? drafts[key] : next.scopes[key]);
          }
          checked = true;
          errorText = "";
          paint();
        } catch (error) {
          checked = false;
          if (active()) showError(signal.aborted ? new Error(words("连接超时，请重试")) : error);
        } finally {
          clearTimeout(timeout);
          reading = null;
          lock();
          schedule();
        }
      })();
      lock();
      return reading;
    }

    async function write(endpoint, body) {
      if (endpoint !== "open" && !checked || busy || reading || !active()) return;
      busy = true;
      writingEndpoint = endpoint;
      pause();
      controller?.abort();
      if (reading) await reading;
      const requestId = crypto.randomUUID();
      const instanceId = hello?.instanceId;
      controller = new AbortController();
      const signal = controller.signal;
      const timeout = setTimeout(() => controller.abort(), 30000);
      noticeText = words("正在执行，请稍候…");
      errorText = "";
      paintMessages();
      lock();
      let succeeded = false, instanceChanged = false;
      try {
        const result = await request(endpoint, { ...body, confirmed: true, requestId }, signal);
        if (endpoint !== "open") {
          const connected = await request("hello", undefined, signal);
          if (!instanceId || connected.instanceId !== instanceId) {
            instanceChanged = true;
            checked = false;
            throw new Error(words("控制台实例已变化，操作结果待确认，请检查实际状态。"));
          }
        }
        succeeded = true;
        if (endpoint === "runtime/select") dirty = false;
        noticeText = endpoint === "open" ? words(result.opened ? "已打开完整控制台" : "控制台未能打开，请重试")
          : words("操作已提交，正在重新读取状态。") + (result.requiresRestart ? words("账号切换需要重启工作进程后生效。") : "");
      } catch (error) {
        noticeText = words("操作结果待确认，请在完整控制台中检查。");
        showError(signal.aborted ? new Error(words("操作等待超时，正在查询回执，请勿重复提交。")) : error);
        if (!disposed && (!error.code || error.code === "OPERATION_UNKNOWN") && hello?.capabilities?.operationStatus) {
          try {
            const connected = await request("hello");
            instanceChanged = !instanceId || connected.instanceId !== instanceId;
            if (instanceChanged) {
              checked = false;
              noticeText = words("控制台实例已变化，操作结果待确认，请检查实际状态。");
            } else {
              const receipt = await request("operations/" + encodeURIComponent(requestId));
              noticeText = ["succeeded", "completed"].includes(receipt.state || receipt.status)
                ? words("操作已完成，请重新检查连接以读取实际状态。") : words("操作结果待确认，请在完整控制台中检查。");
            }
          } catch { /* 保留首次失败，避免误报操作成功。 */ }
        }
      } finally {
        clearTimeout(timeout);
        busy = false;
        writingEndpoint = "";
        paintMessages();
        lock();
        if (succeeded || instanceChanged) await refresh();
        else schedule();
      }
    }

    function save(scope) {
      if (!can("scopedRuntime")) return;
      const restart = selectedEngine !== current().engine;
      if (restart && !window.confirm(words("切换引擎将重启工作进程，正在进行的任务可能被中断。确认切换？"))) return;
      return write("runtime/select", { engine: selectedEngine, scope, ...drafts[scope], restart });
    }

    function mount(main) {
      root = main;
      root.style.width = "100%";
      root.style.boxSizing = "border-box";
      root.innerHTML = `<div class="nikou-head"><div><h2></h2><p data-connection></p></div><div class="nikou-tools" data-tools></div></div>
        <div class="nikou-error" role="alert" hidden></div><p class="nikou-note" data-notice role="status"></p>
        <section class="list nikou-card"><h3 data-heading="status"></h3><dl class="nikou-state"></dl><div class="nikou-tools" data-worker></div></section>
        <section class="list nikou-card nikou-gateway" data-gateway hidden><h3 data-heading="gateway"></h3><p data-gateway-state role="status"></p><p class="nikou-note" data-gateway-count></p><p class="nikou-note" data-gateway-note></p><div class="nikou-tools" data-gateway-tools></div></section>
        <section class="list nikou-card"><h3 data-heading="runtime"></h3><div class="nikou-fields"><div class="nikou-field"><span data-engine-label></span><div data-engine></div></div></div><p class="nikou-note" data-catalog-note></p><div data-scopes></div></section>
        <section class="list nikou-card"><h3 data-heading="accounts"></h3><div data-accounts></div></section>`;
      // 页面沿用纵向 flex 滚动容器；卡片必须保持内容高度，避免按钮与相邻内容重叠。
      for (const child of root.children) child.style.flexShrink = "0";
      $("h2").textContent = words("Nikou 管理");
      for (const [key, title] of [["status", "运行状态"], ["runtime", "会话模型与思考档位"], ["accounts", "账号管理"]]) $(`[data-heading="${key}"]`).textContent = words(title);
      $("[data-heading='gateway']").textContent = words("Magpie 网关连接");
      $("[data-gateway-note]").textContent = words("仅登记连接和模型目录，不影响当前工作进程；模型执行与工具权限仍待验证。");
      $("[data-engine-label]").textContent = words("目标引擎");
      const action = (parent, key, label, handler) => {
        const button = ui.button(words(label), handler);
        button.dataset.action = key;
        $(parent).append(button);
        return button;
      };
      action("[data-tools]", "check", "检查连接", refresh);
      action("[data-tools]", "open", "打开完整控制台", () => write("open", {}));
      action("[data-gateway-tools]", "gateway-connect", "登记网关连接", () => write("gateway/connect", {})).classList.add("primary");
      for (const [key, title] of [["worker", "工作进程"], ["connection", "连接状态"], ["engine", "实际引擎"], ["model", "实际模型"], ["effort", "实际思考档位"], ["supervisor", "管理方"]]) {
        const pair = ui.el("div");
        const value = text("dd", "", "尚未读取");
        value.dataset.status = key;
        pair.append(text("dt", "", title), value);
        $(".nikou-state").append(pair);
      }
      for (const [key, label] of [["start", "启动"], ["stop", "停止"], ["restart", "重启"]]) action("[data-worker]", key, label, () => write("worker/control", {
        action: key, engine: current().engine, model: current().launchProfile?.model || "", effort: current().launchProfile?.effort || "",
      }));
      for (const [key, label] of [["p2p", "单聊"], ["group", "群聊"]]) {
        const section = ui.el("section", "nikou-scope");
        section.append(text("h3", "", label));
        const fields = ui.el("div", "nikou-fields");
        for (const [field, title] of [["model", "模型"], ["effort", "思考档位"]]) {
          const wrap = ui.el("div", "nikou-field"), holder = ui.el("div");
          holder.dataset[field] = key;
          wrap.append(text("span", "", title), holder);
          fields.append(wrap);
        }
        const button = ui.button(words("保存") + words(label), () => save(key));
        button.classList.add("primary");
        button.dataset.action = "save-" + key;
        fields.append(button);
        const saved = ui.el("p", "nikou-note");
        saved.dataset.saved = key;
        section.append(fields, saved);
        $("[data-scopes]").append(section);
      }
      companyPanel?.dispose();
      companyPanel = window.mountNikouCompany?.(root, ui);
      observer?.disconnect();
      observer = new MutationObserver(() => {
        if (!active()) pause();
        lock();
      });
      observer.observe(root, { attributes: true, attributeFilter: ["hidden"] });
      const nav = document.querySelector('#nav [data-view="nikou"]');
      if (nav) observer.observe(nav, { attributes: true, attributeFilter: ["hidden"] });
      paint();
    }

    const visibility = () => { if (active()) refresh(); else pause(); };
    document.addEventListener("visibilitychange", visibility);
    ctx.onConfig(() => { checked = false; hello = null; pause(); if (active()) refresh(); });
    ctx.onDispose(() => {
      disposed = true;
      companyPanel?.dispose();
      pause();
      controller?.abort();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", visibility);
    });
    ctx.slots.add("page", { key: "nikou", title: "Nikou 管理", mount, open: () => { refresh(); companyPanel?.refresh(); }, relang: paint });
  });
})();
