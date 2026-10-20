// 公司工具与 Job 复用 Nikou 本机控制台及操作回执，不另外监督 Worker。
window.mountNikouCompany = (root, ui) => {
  let disposed = false, busy = false;
  const tools = ui.el("section", "list nikou-card nikou-company");
  const jobs = ui.el("section", "list nikou-card nikou-company");
  const message = ui.el("p", "nikou-note");
  message.setAttribute("role", "status");
  const toolBody = ui.el("div"), jobBody = ui.el("div");
  const head = (section, title, buttonTitle, handler) => {
    const row = ui.el("div", "nikou-tools");
    const button = ui.button(buttonTitle, handler);
    button.dataset.companyRefresh = title === "公司工具" ? "tools" : "jobs";
    row.append(ui.el("h3", "", title), button);
    section.append(row);
  };
  const api = async (route, body) => {
    const response = await fetch("/api/nikou/" + route, { method: body ? "POST" : "GET", credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(body ? 20000 : 50000) });
    const reply = await response.json();
    if (!reply.ok || reply.protocol !== 1 || !reply.requestId || !response.ok) {
      const error = Error(reply.error?.message || "响应无效"); error.code = reply.error?.code; throw error;
    }
    return reply.data;
  };
  const setBusy = value => { busy = value; for (const button of [...tools.querySelectorAll("button"), ...jobs.querySelectorAll("button")]) button.disabled = value; };
  async function write(route, values, question) {
    if (busy || !window.confirm(question)) return;
    setBusy(true);
    const requestId = crypto.randomUUID();
    message.textContent = "正在处理，请勿重复操作…";
    try {
      const instance = (await api("hello")).instanceId;
      let result;
      try { result = await api(route, { ...values, requestId, confirmed: true }); }
      catch (error) {
        if (error.code && error.code !== "OPERATION_UNKNOWN") throw error;
        // 升级可能超过单次桥接时限，继续查原回执，绝不重发安装或 Job 执行。
        for (let i = 0; i < 600 && !disposed; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          if ((await api("hello")).instanceId !== instance) throw Error("控制台实例已变化，请核对实际状态");
          const receipt = await api("operations/" + requestId);
          if (receipt.state === "succeeded") { result = receipt.reply?.data || {}; break; }
          if (receipt.state !== "running") throw Error(receipt.reply?.error?.message || "操作结果未知，请核对实际状态");
        }
        if (!result) throw Error("操作仍未确认，请稍后检查实际版本或任务状态");
      }
      message.textContent = result.accepted ? "已提交执行，请刷新查看结果。" : result.terminalOpened ? "初始化终端已打开，完成后请刷新状态。" : result.resourceLibrarySyncRequired
        ? "MCP 配置已初始化；客户端分发由资源库统一管理，请在资源库核对华盛通 MCP 的分配。" : "操作已完成。";
      await refresh();
    } catch (error) { message.textContent = error.message; }
    finally { if (!disposed) setBusy(false); }
  }
  const label = { "not-checked": "尚未检测", "not-installed": "未安装", "update-available": "有更新", "local-newer": "本机版本较新", current: "已是最新", unknown: "检查失败" };
  const initialized = { ready: "已初始化", missing: "未初始化", incomplete: "配置待补齐" };
  async function loadTools(check = false) {
    const checkButton = tools.querySelector('[data-company-refresh="tools"]');
    if (check) { checkButton.textContent = "正在检测…"; checkButton.setAttribute("aria-busy", "true"); }
    try {
      const data = await api("company-tools" + (check ? "?check=1" : ""));
      if (disposed) return;
      toolBody.replaceChildren();
      for (const item of data.tools || []) {
        const row = ui.el("div", "nikou-company-row"); row.dataset.tool = item.name;
        const state = data.initialization?.[item.name === "hst-mcp" ? "hst" : "node"];
        const title = ui.el("div", "nikou-company-title");
        const badge = ui.el("span", "nikou-update-status", label[item.state] || "未知");
        badge.dataset.state = item.state;
        title.append(ui.el("strong", "", item.name === "hst-mcp" ? "华盛通 MCP" : "Nikou 本地工具"), badge);
        row.append(title,
          ui.el("p", "nikou-note", `本机版本 ${item.installed || "未安装"}　·　最新版本 ${item.latest || "未确认"}`),
          ui.el("p", "nikou-note", `${initialized[state?.state] || "配置状态未知"}${state?.missing?.length ? " · 缺少 " + state.missing.join("、") : ""}`));
        const actions = ui.el("div", "nikou-tools");
        actions.append(ui.button(item.installed ? "检查并升级" : "安装", () => write("company-tools/action", { tool: item.name, action: "update" }, `确认安装公司私服的最新 ${item.name}？`)),
          ui.button(item.name === "nikou-node" ? "打开初始化终端" : "初始化配置", () => write("company-tools/action", { tool: item.name, action: "initialize" }, "确认初始化？现有配置将按工具自身规则补齐。")));
        row.append(actions);
        if (item.error) row.append(ui.el("p", "nikou-error", item.error));
        toolBody.append(row);
      }
    } catch (error) { if (!disposed) toolBody.replaceChildren(ui.el("p", "nikou-error", error.message)); }
    finally { if (check && !disposed) { checkButton.textContent = "检查更新"; checkButton.removeAttribute("aria-busy"); } }
  }
  async function loadJobs() {
    try {
      const [data, service] = await Promise.all([api("jobs"), api("jobs/service")]);
      if (disposed) return;
      jobBody.replaceChildren(ui.el("p", "nikou-note", data.daemon?.status === "running" ? "Job 服务运行中" : "Job 服务未连接，未确认任务状态"));
      const serviceActions = ui.el("div", "nikou-tools");
      serviceActions.append(ui.el("span", "nikou-note", service.registered ? "已开启登录启动" : "未开启登录启动"));
      for (const [action, title] of [[service.running ? "stop" : "start", service.running ? "停止服务" : "启动服务"], [service.registered ? "uninstall" : "install", service.registered ? "关闭登录启动并停止" : "开启登录启动"]]) {
        serviceActions.append(ui.button(title, () => write("jobs/service", { action }, `确认${title}？停止服务可能中断正在执行的 Job。`)));
      }
      jobBody.append(serviceActions);
      for (const job of data.jobs || []) {
        const row = ui.el("div", "nikou-company-row"); row.dataset.job = job.id;
        row.append(ui.el("strong", "", job.name || job.id), ui.el("p", "nikou-note", `${job.enabled ? "已启用" : "已停用"} · ${job.triggerText || ""} · 最近执行 ${job.lastStatus || "暂无"}`));
        const actions = ui.el("div", "nikou-tools");
        for (const [action, title] of [["run", "立即执行"], [job.enabled ? "disable" : "enable", job.enabled ? "停用" : "启用"]]) actions.append(ui.button(title, () => write("jobs/action", { id: job.id, action }, `确认${title}此 Job？`)));
        actions.append(ui.button("详情与执行记录", async () => {
          try {
            const detail = await api("jobs/detail?id=" + encodeURIComponent(job.id));
            if (disposed) return;
            row.querySelector(".nikou-job-detail")?.remove();
            const summary = ui.el("div", "nikou-job-detail");
            const definition = detail.job || detail.definition || {};
            summary.append(ui.el("p", "", definition.description || "暂无描述"), ui.el("p", "", `最近执行：${definition.lastRunAt || "暂无"}`));
            for (const run of detail.runs || []) {
              const line = ui.el("div", "nikou-tools");
              line.append(ui.el("span", "", `${run.startedAt || ""} · ${run.status || "未知"}${run.error ? " · " + run.error : ""}`));
              for (const stream of ["stdout", "stderr"]) line.append(ui.button(stream === "stdout" ? "执行日志" : "错误日志", async () => {
                try {
                  const log = await api("jobs/log?" + new URLSearchParams({ id: run.id || run.runId, stream }));
                  if (disposed) return;
                  summary.querySelector("pre")?.remove();
                  summary.append(ui.el("pre", "nikou-job-detail", log.content || log.text || "暂无日志"));
                } catch (error) { message.textContent = error.message; }
              }));
              summary.append(line);
            }
            if (!detail.runs?.length) summary.append(ui.el("p", "", "暂无执行记录"));
            row.append(summary);
          } catch (error) { message.textContent = error.message; }
        }));
        row.append(actions); jobBody.append(row);
      }
      if (data.daemon?.status === "running" && !data.jobs?.length) jobBody.append(ui.el("p", "nikou-note", "暂无 Job。可通过完整控制台或 nikou-job CLI 创建。"));
    } catch (error) { if (!disposed) jobBody.replaceChildren(ui.el("p", "nikou-error", error.message)); }
  }
  head(tools, "公司工具", "检查更新", async () => { if (busy) return; setBusy(true); try { await loadTools(true); } finally { if (!disposed) setBusy(false); } });
  head(jobs, "Nikou Job", "刷新任务", loadJobs);
  tools.append(message, toolBody); jobs.append(jobBody);
  root.append(tools, jobs); tools.style.flexShrink = jobs.style.flexShrink = "0";
  const refresh = async () => { await Promise.all([loadTools(), loadJobs()]); };
  return { refresh, dispose: () => { disposed = true; tools.remove(); jobs.remove(); } };
};
