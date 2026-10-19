// 公司版只检查上游差异，升级仍通过组合发布完成。
const companyUpstreamTimers = new WeakMap();
function renderCompanyUpstreams(row, result) {
  clearTimeout(companyUpstreamTimers.get(row));
  row.classList.add("company-version");
  const who = row.querySelector(".who"), val = row.querySelector(".val");
  const sub = who.querySelector(".sub") || who.appendChild(el("div", "sub"));
  const expanded = sub.querySelector("details")?.open || false;
  sub.classList.add("wraps");
  sub.replaceChildren();
  val.replaceChildren();
  const status = result.upstreams;
  sub.append(el("div", "cu-version", `公司版 ${result.current || "未知"} · Nikou ${status.nikouVersion || "未知"}`));
  const list = el("div", "cu-list");
  const items = ["magpie", "nikou"].map(name => (status.items || []).find(item => item.name === name) || { name });
  for (const item of items) {
    const entry = el("div", "cu-entry");
    const heading = el("div", "cu-heading");
    heading.append(el("strong", "", item.name === "magpie" ? "Magpie" : "Nikou"),
      el("span", "cu-source", item.name === "magpie" ? "GitHub" : "公司 GitLab"));
    const label = { changed: "有更新", current: "已同步上游", unknown: "检查失败" }[item.state] || (status.checking ? "正在检查" : "尚未检查");
    entry.append(heading, el("span", "cu-state cu-" + (item.state || "pending"), label));
    if (item.error) entry.append(el("div", "cu-error", item.error));
    list.append(entry);
  }
  sub.append(list);
  if (items.some(item => item.state === "changed")) sub.append(el("p", "cu-hint", "上游有新提交，需要集成验证后发布公司版。"));
  const controls = el("div", "cu-controls");
  const check = el("button", "text", status.checking ? "正在检查…" : "立即检查");
  check.type = "button";
  check.disabled = status.checking;
  const checked = el("span", "cu-time", status.checkedAt ? `最近检查：${new Date(status.checkedAt).toLocaleString()}` : "尚未检查");
  controls.append(check, checked);
  const automatic = el("label", "cu-auto");
  const toggle = el("input");
  toggle.type = "checkbox";
  toggle.checked = !prefs?.noAutoUpdate;
  toggle.onchange = async () => {
    toggle.disabled = true;
    try { await savePrefs({ noAutoUpdate: !toggle.checked }); }
    catch { toggle.checked = !toggle.checked; checked.textContent = "设置保存失败，请重试"; }
    finally { toggle.disabled = false; }
  };
  automatic.append(toggle, el("span", "", `自动检测（每 ${prefs?.updateEvery || 360} 分钟）`));
  controls.append(automatic);
  sub.append(controls);
  check.onclick = async () => {
    check.disabled = true;
    check.textContent = "正在检查…";
    try { await api(updatePath("update/check"), {}); }
    catch { checked.textContent = "检查请求失败，请重试"; check.disabled = false; check.textContent = "立即检查"; return; }
    if (row.isConnected) renderUpdate(row);
  };
  const details = el("details", "cu-details");
  details.open = expanded;
  details.append(el("summary", "", "技术详情"));
  for (const item of items) {
    const block = el("div", "cu-detail");
    block.append(el("strong", "", item.name === "magpie" ? "Magpie" : "Nikou"));
    for (const [label, value] of [["仓库", item.repository], ["分支", item.ref?.replace(/^refs\/heads\//, "")], ["集成提交", item.baseline], ["上游提交", item.latest]]) {
      block.append(el("div", "", `${label}：${value || "未知"}`));
    }
    details.append(block);
  }
  sub.append(details);
  companyUpstreamTimers.set(row, setTimeout(() => { if (row.isConnected) renderUpdate(row); }, status.checking ? 1000 : 60000));
}
