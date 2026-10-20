# Nikou 公司集成

公司版在上游内置插件机制内注册 Nikou 管理页；该插件随公司 EXE 构建。它不是可直接安装到官方原版 EXE 的外部 npm 插件。Nikou 源码仍在公司 GitLab 独立维护，magpie 不复制其源码。

## 职责与调用链

- [内置插件](../../plugins/nikou/nikou.go)声明页面及设置，[页面](../../internal/gui/assets/plugins/nikou/client.js)通过 `/api/nikou/*` 调用[桌面代理](../../internal/gui/nikou.go)。
- [ConsoleClient](../../internal/nikou/console_client.go)只调用回环 HTTP、固定路由和本机私有 token，不跟随重定向，不使用 HTTP 代理。远程 Web 页面不能调用该管理入口。
- Nikou 控制台的 `/api/integration/v1/*` 复用原有 Host、Origin、token 鉴权，返回版本化信封。协议定义在 [schema](../../company/schemas/nikou-bridge-v1.schema.json)与双方共享夹具中。
- Nikou 的账号后端使用参数数组执行 `NIKOU_MAGPIE_BIN nikou-bridge`，stdin/stdout 各一份 JSON。magpie 复用 provider 账号能力，保留现有账号来源，不读取 CC Switch 数据库。
- Worker 由 Nikou 控制台或其原有所属系统服务管理。magpie 不增加第二个 Worker 监督器。

## 写操作与失败

写操作必须带 requestId；相同 ID 与内容返回原结果，不自动重放。Nikou 控制台回执保留24小时；进程重启时残留 running 转为 unknown。magpie 的跨进程账号回执位于配置目录 `nikou-bridge-operations.json`，使用文件锁和原子写入；确认结果保留24小时，未确认 pending 不自动过期。锁失败拒绝执行；损坏回执保持未知，不按空记录重新执行。

普通读、写、额度刷新分别限时5、15、60秒。写响应不可信或超时后显示 `OPERATION_UNKNOWN`；页面查询回执并刷新真实状态，不重发写请求。页面记录 hello 的 instanceId，实例变化时不沿用旧回执宣称成功。成功保存模型配置不代表运行中的 Worker 已使用它。

首版原生账号能力限 Codex/Claude；Kiro 等返回不支持。额度失败回落旧快照时保留 stale，不能显示本次刷新成功。账号发现沿用上游 provider 行为，可能更新其本机缓存。

## 公司运行时与更新

[维护脚本](../../company/scripts/integrate.mjs)将两个上游、实际公司提交、依赖锁、协议、Node ABI 和逐资产摘要固定在组合清单中。`run` 从受管 `current.json` 解析实际 EXE/私有 Node；强制 magpie 账号后端，清除旧 CC Switch 文件交接路径。

安装为首版离线事务，操作前人工停止旧自动拉起、Worker、控制台和 magpie。新版本复制到独立目录，健康后切换整组指针；回滚检查完整指针、旧资产和健康状态，不覆盖人工后改。无法恢复时保留 `RECOVERY_REQUIRED` 和现场。没有实现在线热升级，也没有执行真实用户配置迁移。

公司构建注入 `update.CompanyMode=1`，禁止独立官方自更新。正式包必须通过 source、artifacts、install 三层门禁；缺证据不能生成正式发布计划。开发预览不能当作正式安装包。

## 验证

### 公司工具与 Job

Nikou 内置页增加公司工具及 Job 卡片，调用固定桥接路由 `company-tools`、`company-tools/action`、`jobs`、`jobs/detail`、`jobs/log`、`jobs/service`、`jobs/action`。实际操作与回执仍在 Nikou 控制台，Magpie 不另建任务库和调度器。工具升级按公司 hosted 主包／group 依赖分工，初始化不回传凭据；华盛通 MCP 通过受管 EXE 的 `nikou-hst-sync --json` 使用资源库事务及备份同步。写操作确认、去重及未知结果规则与原桥接一致。Job 手工执行的 accepted 仅表示已提交，页面不宣称任务执行成功。Windows 登录启动与进程身份校验由 Nikou 服务层负责。迁移边界见[公司工具状态](../../company/docs/company-tools-migration.md)。

`nikou-company.test.cjs` 在 Chromium/WebKit 验证状态展示、内容转义及未知操作回执不重放；`TestCompanyHSTPreservesAssignmentsAndEnvironment` 验证资源库迁移保持原范围且重复操作无额外修改。Nikou 的 `company-tools.test.ts` 验证凭据不回传、离线未知及操作白名单。

### 版本页上游检测

公司构建的版本区优先展示公司版和 Nikou 版本，以及两上游的“有更新／已同步上游／检查失败”状态；仓库、分支、集成提交和上游提交放入默认折叠的技术详情，刷新时保留展开状态。检查时间、立即检查与自动检测开关集中展示，开关复用现有设置；发现差异时提示需要集成验证后发布公司版。支持手动检查；启动五秒后及设置中的自动检测周期检查，关闭自动更新时仅手动检查。检测只读，不下载或安装，发现分支提交不同仅表示有差异，仍须通过组合维护脚本集成、验证和发布。公司版安装接口拒绝独立官方升级。

[上游检测](../../internal/gui/company_upstreams.go) 将构建时的 `company/upstreams.lock.json` 与 policy 嵌入 EXE，不依赖安装机存在源码。Magpie 查询固定 GitHub commit API，匿名 API 限流（403 且剩余额度为0，或429）时回退本机只读 Git 查询，无需额外 Token；其他 HTTP 失败不笼统解释为权限问题；Nikou 使用本机 Git 的只读 ls-remote 查询公司 GitLab，复用 Git 凭证助手，禁止交互式登录并限时15秒。应用不读取凭证，不回传 Git stderr。未安装 Git、认证失败、网络失败和无效响应均显示未知，不声称已是最新。页面分别展示 GitHub/GitLab 来源及仓库地址。结果在进程内缓存；重新启动重新检查。

### Nikou 选择菜单

`ui.menu` 支持 `layout.align`、`layout.className` 与 `disposeMenu`。Nikou 重建选择器或隐藏页面时清理挂在 body 的菜单，重复点击触发器关闭，Escape 和点击外部关闭；弹层与触发器左对齐。`nikou.test.cjs` 在 Chromium/WebKit、420/1100 宽度验证生命周期与定位。

`go test -tags nogui ./internal/gui -run 'TestCompanyUpstreams|TestCompanyVersion'` 验证基线差异、未知与凭证边界；`company-upstreams.test.cjs` 验证两浏览器宽窄窗口的版本行展示与手动检查。

`go test ./internal/nikou ./internal/cli ./internal/gui ./internal/update -run 'Nikou|Console|AccountReceipt|Company|Builtin'` 验证本机桥接、回执与内置守卫；维护脚本通过 `node --test company/tests/*.test.mjs` 验证真实临时 Git、路径、离线迁移、故障回滚。

`node company/scripts/check-contract.mjs <Nikou源码绝对路径>` 构建 Go 探针并启动隔离用户目录中的 Nikou 产物控制台，只验证 hello/status，不启动 Worker。`internal/gui/tests/nikou.test.cjs` 在 Chromium/WebKit 验证交互、错误处理、实例变化与轮询暂停。

公司工具脚本必须在实际 index.html 中先于 Nikou client 加载；Manifest 声明不会自动注入静态入口。TestBuiltinClientsLoaded 检查资源加载，nikou.test.cjs 使用真实入口在双浏览器断言两张卡片，防止孤立组件测试掩盖入口遗漏。
