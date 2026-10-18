# 公司构建与验收

构建链把源码、资产和安装演练分成三个不可互相替代的证据层。`verify --profile source` 在隔离 HOME 下运行维护脚本测试、Go/Nikou 检查，并记录两仓库 HEAD、脏状态、工具链与每条命令退出码。`--allow-dirty` 仅允许本地排查，生成的证据 `releaseEligible:false`，不能驱动正式构建。

正式 Windows amd64 构建要求源码工作树干净、sourceVerified lock、Nikou effectiveCommit 与 package-lock 摘要匹配。构建固定调用 `go-winres@v0.3.3`、Go `production` 与 `-H windowsgui`，并加入 `-X github.com/yetone/magpie/internal/update.CompanyMode=1`。Nikou 运行 `npm ci`、build、test、privacy-scan、pack:check 和 pack。npm 始终由锁定 Node 与 `npm-cli.js` 参数数组执行，不调用 npm.cmd 或全局 latest。

输出位于 `artifacts/company/builds/<公司HEAD-随机ID>/`，包含生产 EXE、Nikou `.tgz`、Node 私有运行时、运行时依赖、控制台资源及双方许可证。`build.json` 为每个文件记录大小和 SHA256，同时记录 magpie 上游/公司提交、Nikou 上游/effective 提交、lock SHA256、Node ABI 和命令退出码。

`verify --profile artifacts` 重新计算所有资产摘要，检查 npm 包中的 `dist/console/assets/index.html` 和其它控制台资源，随后只允许两个专用自检：magpie EXE `nikou-self-check --json`，Nikou `node dist/index.js integration-check --json`。两个输出都必须声明 protocol=1、正确 component、版本；Nikou 还必须匹配 Node ABI。未具备自检、ABI不符、摘要变化或跨平台运行 Windows EXE 时，验收失败，不会给出可发布证据。

`package --version x.y.z` 只接受与当前 lock/HEAD 绑定且 artifacts 验收通过的 build，复制资产到 `artifacts/company/releases/x.y.z/`，生成不自引用的 `release-manifest.json` 与 `SHA256SUMS`。清单分别记录 magpie 上游和公司提交、Nikou 上游和 effective 提交、lock SHA256、协议、平台、架构、Node 版本/ABI、私有 runtime 路径和全部资产摘要。MIT 与 Nikou 内部许可证原文分别保留。

`verify --profile install` 和 `release-plan` 需要安装事务真实生成 `artifacts/company/install-evidence.json`：`schemaVersion=1`、`profile=install`、`ok=true`、精确 `manifestSha256`、可选 packageSha256、transactionId，以及 install 和 rollback 均为 pass 的检查。缺失、篡改、只含安装没有回滚或绑定其他 manifest 时返回16。release-plan 还要求公司 origin 已配置且不是上游；不发布、不 push、不回退官方 feed。

`install --manifest <绝对路径> --install-root <绝对受管目录> --offline` 和 `rollback --transaction <事务ID> --install-root <绝对受管目录> --offline` 仅接入离线事务入口。运行前需要停止旧自动拉起、Worker、console、magpie；首版不会虚假操作真实进程。目录不能是磁盘根、用户目录或未标记非空目录。当前只在隔离目录验收，未部署到真实生产用户目录。

## Windows 进程超时
维护脚本对 Windows 子进程超时使用 taskkill /PID <本次启动的PID> /T /F，终止该任务树；Unix 使用独立进程组。该逻辑仅管理维护脚本本次启动的命令，不枚举或终止用户已有 Worker。

最终包生成后可运行 `node company/scripts/exercise-install.mjs <manifest绝对路径> <install-evidence输出绝对路径>`。脚本只在新建临时受管目录执行首次安装、更新、真实双组件自检和回滚，成功后生成绑定最终 manifest 的 install 证据；任一步失败不生成通过证据。它不验证生产Worker生命周期，也不替代故障注入测试。
