# 双上游维护基线

维护入口为 `node company/scripts/integrate.mjs`，当前已实现 `doctor`、`check-upstreams`、`sync`、`verify`、`build`、`package`、`release-plan`、离线 `install/rollback` 和 `migrate plan/apply/restore`。构建及发布证据说明见[构建验收](build.md)，迁移限制见[离线迁移](migration.md)。

magpie 上游为 `https://github.com/yetone/magpie.git`，基线为 `d783df46cbac9021e26a6bd71ca0b55544552eb2`。主代理已建立私有公司 origin `https://github.com/plfccc/nikou-magpie.git`，upstream 指向官方；维护代理已只读核对，未自行创建或推送远端。维护工具不向上游仓库发布公司提交。

Nikou 已验证的源码来源是 `http://gitlab.inzwc.com/nikou/nikou-cli.git`，基线为 `c1ebb2c55df0e8102ca028049f033e1a64fb41f1`。源码 package.json 是 `nikou-cli@0.1.89`，package-lock.json SHA256 为 `97f6bc31468b5fa4ba8bedf250f8433a81e040058b78118c1aa5fac2d6cd074c`。工作树是 `../nikou-cli-integration`，可用 `--nikou-dir` 显式选择；自动化测试只创建临时本地仓库。

`version` 来自源码包声明；`commit` 是上游提交，`effectiveCommit` 是包含公司改造的实际构建提交。当前二者相同；公司修改提交后必须将后者更新到实际提交。公共 npm 的旧 `0.1.85`、registryGitHead 和完整性只属于历史 artifact 调研，不冒充此源码版本的包发布证明。旧 GitHub 元数据来源未通过验证。

工具链锁为 Node `24.11.1`（ABI `137`）、Go `1.26.8`、Bun `1.4.2`。Node 版本已在本机用于维护脚本测试；Nikou 原生依赖与完整应用功能还需构建验收，不能仅靠维护测试宣称全部兼容。原始 magpie/Nikou 完整构建及测试结果另见实施报告；未运行项不视为通过。

策略中的 stable 是明确的 `refs/heads/main` 查询规则，报告记录完整 SHA；运行版本只消费 lock。候选报告绑定公司 base、两个仓库的公司 base、上游 ref、lock/policy SHA256、生成时间和报告摘要；默认24小时失效。查询或引用校验失败会报错，不写成“无更新”。artifact 锁可做只读诊断和 magpie 查询；没有源码的 Nikou 同步拒绝为11。

```powershell
rtk proxy node company/scripts/integrate.mjs doctor --mode source --json
rtk proxy node company/scripts/integrate.mjs check-upstreams --channel stable --out artifacts/upstreams/candidate.json
rtk proxy node company/scripts/integrate.mjs sync --from-report artifacts/upstreams/candidate.json --component both --dry-run
rtk proxy node company/scripts/integrate.mjs sync --from-report artifacts/upstreams/candidate.json --component both
rtk proxy node --test company/tests/doctor.test.mjs company/tests/lock.test.mjs company/tests/sync.test.mjs
```

sync 只在相邻 `.company-integrations/<报告ID>-<组件>/` 创建独立 Git 工作树，在 Git 公共目录保存状态和互斥锁。Nikou 与 magpie 的历史保持隔离。仅同步 Nikou 时也创建未合并 magpie 上游的 magpie 候选工作树承载拟定 lock；原工作树和 lock 不变。工作树与分支名称固定到候选ID；已完成候选检查 HEAD、拟定 lock 和额外用户修改后直接返回。不同候选对同一仓库并发时返回10。

冲突返回12和文件清单，工作树保留；在对应工作树人工解决并提交后，以相同报告加 `--resume` 重试。脚本不执行 reset、clean、abort。中断遗留的互斥文件需先确认对应 PID 不再运行，再人工移除；脚本不猜测并自动抢锁。dry-run 会读取本地 Git 与远端引用，只返回命令计划，不创建工作树、分支、状态或拟定锁；只有显式 `--out` 才可新建结果报告。报告路径已存在时拒绝覆盖。

退出码：0成功；2参数、过期或篡改报告；10工作树或并发占用；11来源、权限或工具调用失败；12合并冲突；13协议不兼容；14测试失败；15产物或摘要不符；16安装/回滚未完成。13、14、16为后续命令保留，当前不会用空操作声称已验证这些流程。
