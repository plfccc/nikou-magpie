# Windows 全套失败修复记录

日期：2026-10-19。此记录接续最初的 786 项测试（714 通过、71 失败、1 取消），覆盖 Nikou 公司集成分支的 Windows 运行时和测试适配。

## 修复内容

1. 命令解析先识别 Node shebang，使用当前 Node 和参数数组执行；原生 EXE 直接启动，批处理保留兼容入口。脚本识别只读取有界头部。真实子进程回归覆盖中文、空格、空参数、引号和 shell 元字符；NB 使用同一解析逻辑。
2. ACP 执行清理等待子进程 `close`，不再把 kill 信号当作已经退出；companion 区分 `exit` 与 stdio `close`。新增真实子进程与事件顺序回归。
3. 私有配置、凭据、历史库、统计库、运行档案和群 MCP 使用实际 NTFS DACL，仅当前用户和 SYSTEM 可访问；POSIX 保留 0600/0700。敏感内容写入前保护目录及临时文件，随机 UUID、`wx` 排他创建，通过句柄写入；写入失败不替换旧文件，也不删除被其他进程抢占的临时路径。
4. 现有数据库、WAL、SHM 在打开前加固权限；数据库路径必须是普通文件。权限工具拒绝目标类型不匹配，防止把目录按文件处理导致子项失去继承权限。
5. SQLite 测试先关闭 recorder、executor、store 再删除目录；目录链接使用 Windows junction 继续验证越界保护。移除原本提前返回的两项 Windows Worker 控制测试，改为随机 named pipe，真实测试 cancel/detach 与 Job 请求。
6. 修复路径分隔符、包内逻辑路径、目录祖先错误、Unix socket、macOS 专属通知契约；远程脚本在 Windows 通过 shebang 保留执行意图。测试使用 Node 参数替代 `/usr/bin/printf`，继续验证参数不被 shell 展开。
7. `npm test` 通过统一脚本枚举完整套件，每个测试进程在模块加载前隔离 HOME、USERPROFILE、APPDATA、LOCALAPPDATA、临时目录、agent 配置目录，清除继承的业务凭据环境。定向运行同样使用隔离入口，避免依赖全局 CLI 与真实用户配置。

独立审查指出的写入前 ACL 和 `exit`/`close` 竞态均已修复。测试并非通过批量跳过或删除断言转绿。

## 验证与安装

最终 Windows `npm test`：**796/796 通过，0 失败、0 取消、0 跳过**。公司 Nikou 修复提交为 `bca6a1357912cfbd6bfbfd35afb3837b7a07cbf7`；组合锁已更新到该提交。历史与权限组合 35/35、进程与协议组合 16/16，ESM/DTS 构建、隐私扫描和 npm 包清单均通过。

公司维护与安装测试 **56/56 通过**，包含预览升级时 ACL 只读复核及加固后再次核验。本机当前安装事务为 `c2971ede-5c32-4715-a9c7-d44039ce6575`，安装目录通过 `current.json` 指向该版；55 个 dist 文件名与摘要一致，13 个直接依赖入口可解析，19,706 个依赖文件无异常改名。已安装组件自检、真实隔离控制台 hello/status 和未认证拒绝通过，临时控制台已经关闭。桌面原快捷方式继续有效。

最终证据保存在 `artifacts/company/local-acceptance/`：

- `windows-npm-test-verified.log`：最终完整 `npm test`。
- `windows-history-type-final.log`：历史与权限边界组合。
- `windows-edge-final.log`：命令、companion 与群关联。
- `windows-build-verified.log`：ESM 与 DTS 构建。
- `windows-privacy-verified.log`：隐私扫描。
- `windows-pack-verified.log`：npm 包清单。

修复完成后更新本机受管开发预览的 Nikou 私有运行时，组合锁记录实际公司提交。仍不签发正式发布证据：真实账号切换、Worker 管理权交接、飞书往返、各 MCP 连通性及 WebView2 人工验收有各自边界，测试通过不替代这些验收。

本轮没有启停现有 CC Switch、Nikou 控制台或 Worker，也没有部署远端服务。运行时改动包含双方公共配置工具；若要更新公司远端主从服务，部署范围为“主节点和从节点均需部署”，需按独立发布部署流程执行，本轮范围仅本机开发预览。
