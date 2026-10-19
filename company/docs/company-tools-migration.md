# 公司配套工具迁移状态

截至 2026-10-19，Nikou 控制台桥接、账号桥接、组合运行时和上游检测已经集成。资源库的技能与 MCP 配置迁移不等于每个 MCP 服务均已完成真实连通性验收。

本机仍全局安装 `hst-mcp 1.1.15`、`nikou-node 2.0.70`；Nikou 组合运行时独立携带 CLI 0.1.89，不能用全局 CLI 的旧版本代表组合运行时版本。`nikou-node` 提供 nb、oc、am、VOPS、日志、Nacos 等命令，不应复制进 Magpie 源码。

执行 `node company/scripts/check-company-tools.mjs` 检测本机包元数据与公司 Nexus hosted 的 `dist-tags.latest`。失败返回 unknown，不能当成最新。脚本不启动 MCP、不修改全局工具、不读取业务凭据。本轮实际检测到 HST MCP 1.1.16、Nikou 工具包 2.0.74。隔离测试：`node --test company/tests/company-tools.test.mjs`。

1.0.2 将管理能力合并到「Nikou 管理」的公司工具与 Job 卡片：本机及私服版本、检测、安装升级、初始化状态、华盛通 MCP 初始化和资源库同步、Nikou 工具交互初始化终端；Job 服务状态、登录启动开关、启动停止、任务启停、提交执行、详情与执行日志。复杂任务创建、修订、事件规则仍使用完整控制台与 CLI。Nikou 在 Agent 页与资源库中的独立入口仍待处理，不能把它与底层执行引擎的配置简单复制成两份。

更新安装沿用 CC Switch 的仓库分工：内部包从 npm-hst hosted 取得 tarball，依赖从 npms group 解析。初始化保留 ~/ops 中现有配置，MCP 配置初始化前另行备份。分发经 Magpie 资源库，保留旧分配范围和环境，仅迁移历史命令入口；遇多个 HST 配置拒绝猜测覆盖。

Windows Job 服务能力迁入 Nikou CLI 服务层。健康端点确认服务身份，停止前校验 PID、命令行与启动时间；后台启动不创建可见终端。登录启动复用原「Nikou Job」注册表值，受管运行时通过 current.json 动态定位。nb-init 为交互命令，显式打开终端。耗时工具升级使用原操作 ID 的回执轮询，实例改变或结果未知时不重放写入。页面只展示配置状态，不回传密码和 Token。

## Windows 图标修复

原手工预览构建跳过了 go-winres，安装 EXE 只有默认程序图标。现已补生成资源并重新安装。修复后分别从 EXE 及运行窗口的 WM_GETICON／窗口类读取到正确 Magpie 图标；安装器两个隔离自检通过。任务栏最终显示还受用户固定快捷方式缓存影响，不能仅靠托盘图标判断。

预览构建改用 `company/scripts/build-preview-exe.ps1`，它先生成资源再编译。常规组合构建 `company/scripts/lib/build.mjs` 原本已包含资源生成。构建后仍须更新包摘要并通过安装器安装，不能手工覆盖正在使用的 EXE。
