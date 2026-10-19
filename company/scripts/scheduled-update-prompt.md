# 公司版自动维护任务

用户授权：定时检查两个上游；有更新时自动合并、验证、生成本机版本包并安装。输出全部使用简体中文。

发布范围仅本机开发预览版本目录，不推送源码、不创建 GitHub Release、不上传公司 Nikou 源码和资产到外部。当前生产资格未完成，不伪造正式发布证据。

## 执行要求

1. 阅读 AGENTS.md、docs/subsystems/nikou-integration.md、company/docs/preview-install.md 和维护脚本。上游仅 company/upstreams.policy.json 的两个固定仓库。把本次目标 SHA 固定，不以执行过程中的远端变化替换目标。
2. 若任一公司工作树有未提交修改，停止并记录。不得 stash、reset、clean 或覆盖人工修改。仅在独立 worktree 执行上游合并，优先使用 integrate.mjs 的 check-upstreams/sync。保留公司改造；合并冲突时保留现场并停止，不自动选择 ours/theirs。工作区头部变化时停止。
3. Nikou 合并后更新精确版本、依赖锁摘要和 effectiveCommit。magpie 锁记录两个实际集成的上游提交。只提交本次维护改动；中文提交说明。不得丢弃现有公司提交。
4. 验证两边依赖及桥接契约。Nikou 必须 build、完整 npm test、privacy-scan、pack:check 通过；Magpie 必须公司维护脚本全测试、GUI Nikou/版本检测/内核相关双浏览器测试、Go Nikou/公司更新/桥接聚焦测试、Windows production 构建通过。用隔离用户目录测试，不触碰真实账号、Skills、MCP。任何失败均停止发布安装，不跳过测试或降低现有门禁来制造成功。记录未运行的平台测试。
5. 仍为开发预览发布：递增本机公司版预发布编号，保留 developmentOnly=true、releaseEligible=false。构建 EXE 必须包含 CompanyMode=1，生成新 Nikou tgz，重新计算精确资产摘要、工具链、源码来源。不得沿用旧包或旧测试证据冒充新版本。优先复用已有 build/package 链，正式门禁不满足时只能走明确标记的 preview 安装。
6. 本机安装根为 %LOCALAPPDATA%\NikouMagpie\preview。使用 install-preview.mjs 的事务安装，不覆盖旧版本目录；安装前保存 current.json、进程路径、两组件版本及所有可能修改的配置备份，保留可执行回滚入口。安装失败不切换旧指针。
7. 现有 Worker 和控制台可能由 CC Switch 管理，不得直接结束、重启或切换管理权。先验证新 Nikou 包可与当前 Worker/控制台协议共存；如果需要中断真实 Worker、配置迁移或破坏协议兼容，记录 awaiting-maintenance-window 并保留旧指针，不能自动安装一半组件。允许只重启经过绝对路径确认的受管 Magpie GUI 来加载兼容的新组合预览。关闭启动库自动同步保护必须保持不变。
8. 安装后核对指针、实际 EXE 路径及 SHA、两组件隔离自检与只读 hello/status。验收不通过按原指针回滚并复核，保留失败现场。无需发送飞书、邮件或其他外部消息。
9. 成功后将维护结果以提交合并回公司分支（本地即可，不 push），确保下一轮锁已前进，避免重复集成。最终 result.md 写清状态：up-to-date / installed / blocked / failed / awaiting-maintenance-window，以及两上游提交、测试统计、安装事务、旧指针、回滚命令、错误原因。无法完成时明确失败，不声称发布完成。

本机 Go：D:\project\hst\nikou\.tools\go1.26.8\go；Node 必须匹配 policy（当前24.11.1/ABI137）；npm 用 Node + npm-cli.js；Playwright NODE_PATH 在维护入口设置。实际 shell 可执行命令遵循 RTK.md。Git 仅在本机凭证助手中认证，不输出或复制凭证。
