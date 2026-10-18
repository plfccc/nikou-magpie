# Nikou 集成版 magpie

公司仓库：[plfccc/nikou-magpie](https://github.com/plfccc/nikou-magpie)，保持私有。官方 `yetone/magpie` 为 upstream；Nikou 的权威源码保持在公司 GitLab。

首版目标为 Windows amd64。内置 Nikou 管理插件、双端协议、Codex/Claude 账号桥接及维护脚本已实现。当前 Nikou Windows 全套测试未通过，正式发布仍被门禁阻断。尚未迁移真实用户配置或部署 Worker。

操作入口：`node company/scripts/integrate.mjs`。依次阅读：

- [基线与双上游同步](docs/baseline.md)
- [构建、包摘要与验收](docs/build.md)
- [迁移与离线交接](docs/migration.md)
- [日常更新](docs/update.md)
- [回滚和故障恢复](docs/recovery.md)
- [本轮验证记录](docs/validation.md)
- [双端职责与失败语义](../docs/subsystems/nikou-integration.md)

日常只更新 magpie、只更新 Nikou、同时更新二者，都使用 `check-upstreams` 报告和 `sync --component magpie|nikou|both` 生成候选工作树。禁止在运行环境拉 latest、全局 npm 升级或覆盖现有 EXE。
