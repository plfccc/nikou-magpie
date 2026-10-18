# 双上游维护

工具版本固定在 policy，源码和依赖摘要固定在 lock。`magpie.commit`、`nikou.commit` 是上游基线；`nikou.effectiveCommit` 必须是包含桥接修改的公司实际提交。公司 magpie HEAD 在构建证据中单独记录，避免 lock 自引用。

在公司 magpie 工作树依次执行：

```powershell
node company/scripts/integrate.mjs doctor --mode source --json
node company/scripts/integrate.mjs check-upstreams --channel stable --out artifacts/upstreams/candidate.json
node company/scripts/integrate.mjs sync --from-report artifacts/upstreams/candidate.json --component both --dry-run
node company/scripts/integrate.mjs sync --from-report artifacts/upstreams/candidate.json --component both
```

单独更新时将 both 改为 magpie 或 nikou。检查报告默认24小时有效；上游引用移动、摘要变化、来源不可用或脏源码均停止。sync 在新分支与工作树合并，不改原 main；冲突现场保留，修复后按原报告 resume。具体参数和退出码见 baseline。

随后切换到 sync 实际输出的候选工作树，使用明确 Nikou 工作树路径执行验证、构建、包验收：

```powershell
node company/scripts/integrate.mjs verify --profile source --nikou-dir <Nikou工作树绝对路径>
node company/scripts/integrate.mjs build --platform windows --arch amd64 --version 1.0.0 --nikou-dir <Nikou工作树绝对路径>
node company/scripts/integrate.mjs verify --profile artifacts --nikou-dir <Nikou工作树绝对路径>
node company/scripts/integrate.mjs package --version 1.0.0 --nikou-dir <Nikou工作树绝对路径>
```

尖括号是实际输出占位，执行前替换。任一步失败即停止，不跳过 npm test、不伪造 source 证据。安装和回滚演练必须绑定最终 manifest 摘要；`verify --profile install` 与 `release-plan` 消费该证据。release-plan 仅生成本地待审说明，不推送发布。

运行已安装组合：`run --component console --install-root <绝对受管目录>` 与 `run --component magpie --install-root <绝对受管目录>`。控制台端口默认19736，`--port` 可指定；需要同时在内置 Nikou 插件设置中使用相同端口。运行时使用私有 Node 和 EXE，账号后端明确设为 magpie。

API 引擎可用 `profile plan --worker-config-path <绝对路径> --gateway-url http://127.0.0.1:<实际端口>/v1 --api-key-env <密钥环境变量名> --out <计划文件>` 从真实 `/v1/models` 生成完整模型白名单。审阅后 `profile apply --from-plan <计划文件> --managed-dir <私有备份绝对目录> --confirmed --offline --private-directory-confirmed`。只新增 magpie profile，保留 active、其他 profiles 与引擎；实际选用通过 Nikou 控制台明确操作。密钥不写入计划或报告。
