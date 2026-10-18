# Windows 离线配置迁移

本工具只迁移 CC Switch 本地 Master 管理凭据到 Nikou 控制台，不启动、停止或监督 Worker，也不把配置写入成功当作运行态交接成功。管理方始终为 Nikou console；magpie 不建立第二监督器。首版交接必须离线执行。

字段依据：旧仓库 `src-tauri/src/settings.rs` 使用 camelCase，真实字段为 `nikouMasterBaseUrl`、`nikouMasterAdminKey`、`nikouWorkerAutostart`；`nikou_master.rs` 读取前两项。Nikou `src/console/routes/master.ts` 私有文件为 `.nikou-block/console/master-admin.json`，字段为 `url`、`key`。Worker 配置和运行范围位于 `.nikou-block/worker/config.json`、`runtime-scopes.json`。路径均由调用方显式传入，工具不自动探测真实用户目录。

维护入口可导入 `company/scripts/lib/migration.mjs` 的同步函数 `planMigration(options)`、`applyMigration(options)`、`restoreMigration(options)`。失败抛出中文异常。通用参数如下：

统一 CLI 已接入 `migrate plan|apply|restore`：路径参数依次为 `--settings-path`、`--worker-config-path`、`--runtime-scopes-path`、`--master-credentials-path`、`--managed-dir`，必须都是明确绝对路径。apply另需 `--migration-id <计划ID> --request-id <唯一请求ID> --old-process-ids <逗号分隔旧PID> --offline --private-directory-confirmed`；restore需 `--managed-dir --migration-id --request-id --offline`。CLI保持与上述同步函数相同的安全检查，失败返回2，不生成假成功回执。

```js
const options = {
  settingsPath: 'D:/隔离用户/.cc-switch/settings.json',
  workerConfigPath: 'D:/隔离用户/.nikou-block/worker/config.json',
  runtimeScopesPath: 'D:/隔离用户/.nikou-block/worker/runtime-scopes.json',
  masterCredentialsPath: 'D:/隔离用户/.nikou-block/console/master-admin.json',
  managedDir: 'D:/隔离用户/私有迁移记录',
};
const plan = planMigration(options);
const result = applyMigration({
  ...options, migrationId: plan.migrationId, requestId: '明确唯一请求ID',
  privateDirectoryConfirmed: true, offlineConfirmed: true,
  oldProcessIds: [1234, 5678], // 实际核验的旧监督器和 Worker PID，不能照抄示例
});
```

执行顺序：

1. 在 CC Switch 人工关闭 Worker 自动启动，确认落盘 `nikouWorkerAutostart:false`；退出旧 Worker、CC Switch 与 Nikou 控制台，关闭其他会改这些配置的程序。明确检查旧 `NIKOU_WORKER_SUPERVISOR=cc-switch` 进程退出，避免继续等待无人消费的文件交接请求。
2. 在 Windows 提前建立仅当前用户和系统可访问的受管备份目录，核验继承 ACL；`privateDirectoryConfirmed` 是操作者明确确认，工具不会把 POSIX mode 当作 Windows ACL 已生效。
3. 生成计划并审阅。计划只输出文件路径、SHA256、字段名称、管理方及限制，不输出地址、密钥或原始配置，不写备份。损坏 JSON、缺失必需配置、已有不同 Master 凭据一律拒绝；首版仅支持严格 JSON，含注释配置须人工转换后重新生成计划。
4. 显式 apply 传入计划 ID、唯一 requestId、离线确认和已核验的旧 PID。工具检查 PID 不再存在并再次比较源文件摘要。只有此时才在受管目录写私有原始备份和回执；Worker/profile、runtime-scopes 和旧账号文件均不改动。全局迁移锁抑制并行迁移。仅创建新 Master 凭据文件，不覆盖现有不同配置。
5. 回执 `APPLIED_OFFLINE` 仅表示配置离线准备完成，`runtimeStatus` 仍为 `MANUAL_VERIFICATION_REQUIRED`。由 Nikou console 启动并确认唯一 Worker；人工验证启动、手动停止、异常退出恢复、飞书切换引擎、升级交接和重复启动抑制。本工具不宣称这些运行态项目通过。

同一 requestId 返回已有回执，不再次写配置；计划不同则拒绝。`PREPARED` 表示写入曾中断或后置摘要检查失败，应审阅私有现场并执行恢复，不自动重试覆盖。进程退出检查属于离线前置证据，不能阻止操作者之后重新启动旧软件；操作期间必须保持离线。

恢复传入原 `managedDir`、`requestId`、`migrationId` 及 `offlineConfirmed:true`。只删除本次实际新增且摘要仍匹配的 Master 凭据文件，不回写只备份未改动的 Worker/profile、旧 settings 或 scopes。目标被后改则报告冲突并保留当前文件和原始私有备份。原有相同凭据属于无变更事务，恢复不会删除。不要把受管备份、回执及配置上传到报告、Git 或共享目录。

保留旧账号和全部 profile，不承诺 Kiro 原生数据库/Keychain 切换等价。不迁移系统服务、端口、CLI 原生登录态或自动配置账户后端；这些项目必须由对应账户能力和 Nikou 运行管理入口单独验证。
