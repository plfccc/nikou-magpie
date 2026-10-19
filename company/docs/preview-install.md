# Windows 本机开发预览安装

此入口安装开发预览，始终标记 `developmentOnly=true`、`releaseEligible=false`，不能作为正式发布验收。正式发布仍使用组合安装器与完整验收清单。

```powershell
rtk proxy node company/scripts/install-preview.mjs --info artifacts/company/preview/preview-info.json --nikou-dir ../nikou-cli-integration --install-root "$env:LOCALAPPDATA\NikouMagpie\preview"
```

安装器先校验 EXE 和 tgz 的 SHA256、Node 版本与 ABI、Nikou 包元数据及锁定依赖摘要，再复制私有 Node，解包 `dist`，通过 Node 与 `npm-cli.js` 执行 `npm ci --omit=dev --include=optional`。不会替换全局 Node 或 Nikou。依赖安装需要可访问配置的 npm 仓库。

专用目录通过当前用户与 SYSTEM 的 Windows ACL 保护；不接管非空陌生目录、不自动抢占安装锁、不跟随安装路径中的链接。在同根暂存目录完成构建和隔离 HOME、USERPROFILE、APPDATA、LOCALAPPDATA 自检后，原子更新 `current.json` 指针。失败时保留原指针与版本。

重复安装先只读检查 ACL。已有目录仅含当前用户与 SYSTEM 的完整可继承授权且禁止继承时，不重复设置，避免 Windows 遍历旧版本的依赖树；权限不满足时先加固并再次核验，不能只凭 `icacls` 返回成功放行。

安装结果位于 `releases/<事务 ID>`，其 `preview-install-receipt.json` 记录源产物摘要、Node 摘要与两组件自检结果。安装器不会签发正式 release manifest 或 install evidence。

手动运行 `launch-magpie.ps1` 打开网关；`launch-console.ps1` 会拒绝已占用的 19736 端口和已运行的 Worker。两个入口设置受管运行时、magpie 账号后端并关闭控制台自动拉起。控制台入口不执行 Worker 启动命令。现有 CC Switch、Worker、控制台、账号和配置都不由安装器更改。

入口还设置 `NIKOU_PREVIEW_NO_LIBRARY_SYNC=1`，跳过 GUI 启动时的 Skills/MCP 自动同步及 KeepLinked 后台维护，避免仅打开预览就修改各 Agent 配置。此开关只约束启动行为：用户在库页面手动编辑、启用或禁用内容仍会触发同步，因此开发预览并非只读模式。进行这类操作前应完成对应 Agent 配置备份。

命令行安装成功后会创建桌面“Nikou Magpie 开发预览”快捷方式，使用隐藏 PowerShell 调用网关入口；同名快捷方式已存在时保留原文件。安装后会逐一比对打包 `dist` 的文件名和 SHA256，并在最终目录运行自检，捕获移动过程中出现的文件改名或内容变更。

安装过程不会启动桌面程序、控制台、Worker 或 MCP。要切换真实 Worker 管理权，需要另行完成受控交接与真实链路验收。

本机此次安装位于 `%LOCALAPPDATA%\NikouMagpie\preview`，当前版本为 `1.0.0-dev.1` / Nikou `0.1.89`。已对最终目录内 55 个 `dist` 文件逐一核对文件名与 SHA256，两组件隔离自检通过；13 个直接依赖入口可解析，扫描 19,706 个依赖文件未发现 `.IPGSD` 改名文件。另从已安装 runtime 启动临时隔离控制台，仅请求 `hello`、`status` 与未认证拒绝接口，均通过，随后只关闭该临时进程。验收报告位于 `artifacts/company/local-acceptance/preview-console-acceptance.json` 与 `preview-post-install.json`，这不代表真实 Worker、账号或 MCP 链路已验收。
