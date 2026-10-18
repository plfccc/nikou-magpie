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

`go test ./internal/nikou ./internal/cli ./internal/gui ./internal/update -run 'Nikou|Console|AccountReceipt|Company|Builtin'` 验证本机桥接、回执与内置守卫；维护脚本通过 `node --test company/tests/*.test.mjs` 验证真实临时 Git、路径、离线迁移、故障回滚。

`node company/scripts/check-contract.mjs <Nikou源码绝对路径>` 构建 Go 探针并启动隔离用户目录中的 Nikou 产物控制台，只验证 hello/status，不启动 Worker。`internal/gui/tests/nikou.test.cjs` 在 Chromium/WebKit 验证交互、错误处理、实例变化与轮询暂停。
