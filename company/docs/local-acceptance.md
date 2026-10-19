# Windows 本机安装与验收记录（2026-10-19）

本机已安装开发预览，已把 CC Switch 的本地库复制到 Magpie。该版本仍为 `developmentOnly=true`、`releaseEligible=false`，不能称为全功能正式验收通过。

Windows 全套失败已于本轮修复：Nikou `npm test` **796/796**，维护与安装测试 **56/56**。修复版已更新到本机，当前安装事务为 `c2971ede-5c32-4715-a9c7-d44039ce6575`；详细源码身份与复验见 [Windows 修复记录](windows-fixes.md)。原 71 项失败、1 项取消的记录属于历史审计结果。

## 安装与入口

- 受管目录：`C:\Users\lingpfeng.peng\AppData\Local\NikouMagpie\preview`
- 桌面入口：`Nikou Magpie 开发预览.lnk`
- 版本：magpie `1.0.0-dev.1`、Nikou `0.1.89`、私有 Node `24.11.1` / ABI `137`
- 当前指针：安装根目录 `current.json`；每版目录保留 `preview-install-receipt.json`
- EXE SHA256：`2ccf386bb2c0506fe58597c3c6a297946c3b7bb50d5be115a39cbf53f43b5e91`

安装没有替换全局 Nikou 或 Node，没有自动打开 GUI，也没有启动新的 Worker。快捷方式设置 `NIKOU_PREVIEW_NO_LIBRARY_SYNC=1`，只跳过启动时的库同步与关联指令轮询；手动修改库仍会写入 agent 配置，预览并非只读沙盒。详情见 [预览安装](preview-install.md)。

## Skills 与 MCP

- 80 个 Skills 已复制到 `%USERPROFILE%\.config\magpie\library\skills`，全部文件名与内容摘要和 CC Switch 源目录一致。
- 8 个 MCP 已写入 Magpie `library.json`，受支持配置值和 Claude/Codex/OpenCode 等开关均已核对。
- 原 CC Switch 的 3 个 Nikou MCP 启用映射仅保存在兼容性元数据中，尚未成为 Magpie 的 Nikou agent 配置。`startup_timeout_sec` 等字段也保留在元数据与私有备份中，未冒充已生效。
- SQLite 备份 `integrity_check=ok`，重复导入计划为 80 个 Skills、8 个 MCP 全部已存在且无冲突。
- Magpie 配置与备份根目录、敏感库文件的 ACL 已限制为当前用户和 SYSTEM。
- 文件过滤器曾把 39 个脚本条目显示为 `.IPGSD`；确认摘要一致后恢复原名，逐文件复验通过。随后目录枚举仍可能报告不存在的临时后缀项，导入器只忽略对应原名确实存在且临时项读取为 ENOENT 的情况。

私有备份：

```text
C:\Users\lingpfeng.peng\AppData\Local\NikouMagpie\backups\20261019-local-install\0036c8ac-3200-40f6-a730-e89e109df621
```

本次未调用 `library.Sync()`，未改写现有 Claude/Codex 配置，未启动 MCP。参数与恢复说明见 [库导入](library-import.md)。

## 验收覆盖

| 功能 | 证据与边界 |
| --- | --- |
| 本轮维护与安装测试总计 | 库导入、预览安装与 ACL 升级故障测试均覆盖，最新统计见 [Windows 修复记录](windows-fixes.md) |
| 双上游检查、隔离合并、冲突恢复、锁、来源摘要 | 本轮维护测试；覆盖真实临时 Git 仓库与故障注入 |
| 组合安装、整组回滚、配置迁移、profile 导入 | 本轮维护测试；隔离目录与模拟服务，未交接真实 Worker |
| 账号稳定引用、持久回执、去重、unknown 结果 | Go bridge/CLI 聚焦测试通过；真实账号切换未做 |
| Nikou 页面状态、确认写入、超时、旧额度、轮询 | Chromium/WebKit 页面夹具测试本轮 31/31；WebView2 真实桌面未做 |
| production Windows EXE | 本轮构建通过；包含启动库同步保护的本地源码改动，回执明确记录 dirty 开发来源 |
| 已安装 EXE 与 Nikou runtime | 两组件隔离自检通过；55 个 dist 文件名与 SHA256 一致，13 个直接依赖可解析，19,706 个依赖文件无异常改名 |
| 已安装控制台集成协议 | 临时隔离真实控制台 hello/status、未认证拒绝通过；临时控制台已关闭 |
| Skills/MCP 数据迁移 | 真实本机数据入库及逐文件、逐配置核对通过；服务连通性未做 |
| 真实 Worker 生命周期、模型对话、飞书往返 | 未做；现有 Worker 继续由 CC Switch 管理 |
| 全量 Windows Nikou 测试 | 修复后 796/796 通过，0 失败、0 取消、0 跳过；详见 [Windows 修复记录](windows-fixes.md) |
| 上游完整 GUI 套件 | 未完整运行，不能用聚焦测试替代全套 |

原有进程 `28596`（CC Switch）、`34812`（控制台）、`37208`（Worker）保持运行，本轮未启停。Windows Worker 使用固定控制管道，真实交接不能和旧 Worker 并行；需备份后受控切换并完成对话验收。

## 脱敏证据

- `artifacts/company/local-acceptance/library-verification.json`
- `artifacts/company/local-acceptance/preview-post-install.json`
- `artifacts/company/local-acceptance/preview-console-acceptance.json`
- `artifacts/company/local-acceptance/maintenance-final-test.log`
- `artifacts/company/windows-acceptance-audit.md`

这些记录不包含账号、token、MCP env 值或请求头。原始配置仅保存在受保护的本机目录中。
