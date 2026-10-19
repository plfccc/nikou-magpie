# CC Switch 的 Skills 与 MCP 导入

该流程把 CC Switch 的本地库复制到 Magpie 的库目录。它只写 Magpie 自己的 `library.json` 和 `library/skills`，不会调用 Magpie 的 `library.Sync()`，因此不会立即改写 Claude、Codex 或其他 agent 的配置，也不会启动 MCP 或操作 Nikou Worker。

## 数据源与目标

Windows 默认数据源如下：

- SQLite：`%USERPROFILE%\.cc-switch\cc-switch.db`
- Skills：`%USERPROFILE%\.cc-switch\skills`
- Magpie 配置：`%USERPROFILE%\.config\magpie`
- 私有备份：`%LOCALAPPDATA%\NikouMagpie\backups\<批次>`

目标和备份目录必须使用绝对路径，且不能互相包含或经过符号链接。导入前会以只读方式查询 SQLite；计划文件只保留名称、摘要、agent 开关和兼容性字段，不输出命令参数、URL、headers、env 或 token。

## 先计划，再应用

生成脱敏计划：

```powershell
rtk proxy node company/scripts/integrate.mjs library plan `
  --database-path "$env:USERPROFILE\.cc-switch\cc-switch.db" `
  --skills-root "$env:USERPROFILE\.cc-switch\skills" `
  --magpie-config-dir "$env:USERPROFILE\.config\magpie" `
  --backup-dir "$env:LOCALAPPDATA\NikouMagpie\backups\20261019-local-install" `
  --out artifacts/company/library-import-plan.json
```

检查计划后应用：

```powershell
rtk proxy node company/scripts/integrate.mjs library apply `
  --database-path "$env:USERPROFILE\.cc-switch\cc-switch.db" `
  --skills-root "$env:USERPROFILE\.cc-switch\skills" `
  --magpie-config-dir "$env:USERPROFILE\.config\magpie" `
  --backup-dir "$env:LOCALAPPDATA\NikouMagpie\backups\20261019-local-install" `
  --from-plan artifacts/company/library-import-plan.json `
  --confirmed --private-directory-confirmed
```

应用会先备份原 SQLite、原 `library.json`（若存在）和 MCP 私有配置，然后复制 Skills 并校验摘要，最后原子写入库文件。重复执行是幂等的；目标 Skill 被用户改过时会报告冲突并保留用户版本。源或目标在应用期间发生变化会中止并清理本次新建内容。

本机实际数据基线为 80 个 Skills、8 个 MCP，CC Switch 中有 3 个 MCP 启用到 Nikou（`apifox`、`hst`、`serena`）。Magpie 尚无 Nikou agent 的 Library 目标，因此该映射仅保留在 `unsupportedAssignments` 元数据，尚未在 Nikou 生效。MCP 的 `startup_timeout_sec` 等 CC Switch 扩展字段不属于 Magpie `Server` 模型，导入时会写入 `cc-switch-import.json` 的兼容性元数据并保存在私有备份中，不能静默丢失。当前所有 MCP 均为 stdio。

应用前必须关闭 Magpie，避免 GUI 不遵循导入锁而并发改写库。Windows 应用时会限制目标和备份根目录为当前用户及 SYSTEM，并检查 ACL；已有额外显式授权会导致拒绝，需先审查处理。普通 Magpie GUI 启动会自动同步库到 agent；公司开发预览启动脚本通过 `NIKOU_PREVIEW_NO_LIBRARY_SYNC=1` 跳过启动同步与关联指令轮询，但页面中的手动库编辑仍会同步。

## 恢复与边界

每次应用都会返回事务目录，例如：

```text
%LOCALAPPDATA%\NikouMagpie\backups\20261019-local-install\<transaction-id>
```

其中的 `receipt.json` 记录提交状态，`cc-switch.db` 可直接用 SQLite 打开验证。恢复时先保留当前 `library.json`，再依据备份中的 `library.json.backup` 和私有源配置人工核对后恢复；脚本不会删除 CC Switch 数据，也不会覆盖 agent 配置。

导入完成后只读核验 `library.json`、每个 `SKILL.md` 的摘要、MCP agent 映射和备份 SQLite。真实 Worker、账号切换和 MCP 服务连通性必须另行验收。
