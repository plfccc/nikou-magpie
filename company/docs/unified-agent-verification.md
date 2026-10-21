# 统一 Agent 接线验收记录

## 当前边界

本批提供本机连接登记和未验证模型目录。登记不启动或重启 Worker，不修改主从协议。目录元数据不等于真实供应商验收，页面显示“已登记，待执行验证”。

页面复用原生按钮、卡片、菜单及已有加载动画，不新增动画库；登记不会清除未保存的引擎、模型草稿。

## 已验证

- Nikou 页面 Chromium / WebKit：32 项通过，包含宽窄窗口、草稿保留、回执、失败、无重复提交和令牌不进入 DOM。
- 文案键守卫：3 项通过。
- 公司维护脚本：63 项通过。
- Go 的 Nikou 连接与 GUI 桥接专项通过；Windows 全仓 `go vet -tags nogui ./...` 通过。
- Windows 桌面构建与全仓 `go vet ./...` 通过；Windows / Linux 的 `nogui` 构建通过；Linux 全仓 `go vet -tags nogui ./...` 通过。
- 实际 Go 客户端与隔离 Nikou Console 完成 6 个响应校验：握手、初始状态、登记、重复回执、目录、最终状态；登记前后均无 Worker PID。

## 阻止正式发布的验证缺口

全量 `go test -tags nogui ./...` 未通过。日志保留在本地 `artifacts/unified-agent-go-tests.txt`。已修复公司运行标识 `NIKOU_MANAGED_RUNTIME` 未加入 `agentenv.Vars` 的测试隔离遗漏；`TestFolderVarsAreListed` 重测通过。

以下两项单独复测仍失败，尚未修复：

| 用例 | 实际失败 | 定位入口 |
| --- | --- | --- |
| `TestCodexDriftReached` | 新增外部 WebSocket 日志后仍读取上一条连接拒绝记录 | `internal/agent/applied_test.go`、`codexReached` |
| `TestAsideOfflineDisconnectRestoresWithoutDaemon` | Windows 下缺 CLI 的夹具仍被判为可用 | `internal/agent/aside_offline_test.go`、`Agent.CLIMissing`、`goneOS` |

全量 Go 的 Agent 包还触发 10 分钟包级超时；当时栈停在 `TestClaude1MMarked` 的文件读取中，尚未确定根因。全量 GUI 测试停在既有 `agent-app-version` / `agent-cli-missing` 文件且没有最终汇总。已停止这两棵测试进程树并保留现场摘要，不将已取消的全量运行计为通过。

尚未完成：完整回归、可信模型能力验证服务、真实供应商、五分钟任务、真实飞书单聊/测试群及安装回滚验收。不得据本批专项测试发布或自动切换默认执行器。

## 部署结论

后续仅需部署本机 Magpie、Nikou Console 与从节点；远端主节点无需部署。本批未安装、未切换在线 Worker。
