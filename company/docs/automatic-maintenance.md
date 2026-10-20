# AI 自动维护与飞书通知

Windows 任务 `NikouMagpie-UpstreamMaintenance` 每天北京时间 09:00 执行 `company/scripts/scheduled-update.ps1`。有更新时使用 Codex CLI 在独立 worktree 集成两个固定上游；AI 可解决有代码和测试依据的冲突，不能确认的业务取舍返回 blocked，原安装保留。

验证顺序为安装依赖、构建 Nikou、完整测试、隐私与包检查、Magpie 维护及 GUI/Go 检查、组合构建、隔离自检与事务安装。失败先定位并修复，不通过不能发布。当前公司工作区有人工修改则停止，不自动 stash 或覆盖。

`%LOCALAPPDATA%/NikouMagpie/maintenance/latest.json` 保存最近状态，版本页面展示摘要和飞书通知结果。每轮详细日志保存在 `runs/<时间>/`。通知配置保存在同目录 `notification.json`，仅含收件人 open_id、Bot profile 和 lark-cli 入口，不保存 token。

安装完成的通知必须说明旧版→新版、两个上游的具体改动及验证结果；无法确认时通知给出具体问题和可选方案。没有更新不通知。发送使用固定妮蔻 Bot、固定宿主收件人和幂等键，成功回执避免重复发送，通知失败不会把安装成功改成失败。

用户在与妮蔻的单聊回复后，由维护会话读取本轮结果、核对候选 SHA 与选项，再继续验证；调度器不会监听任意聊天并直接批准。可以运行 `node company/scripts/maintenance-notify.mjs <maintenance目录>` 重试最近通知。

本轮修复包括 Windows 临时目录长短路径比较，以及 worktree 下通过 NIKOU_TEST_SOURCE_DIR 显式传入候选 Nikou 的依赖来源。所有必需测试仍保留。
