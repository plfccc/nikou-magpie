# Windows 自动维护任务

任务名称 `NikouMagpie-UpstreamMaintenance`，默认每天北京时间09:00执行，使用当前用户登录态，不保存密码。错过计划后在下次可用时补跑；电脑关机或用户未登录时不能执行。单次最多六小时，同名互斥锁阻止重入。

入口：`company/scripts/scheduled-update.ps1`。先用现有 check-upstreams 只读查询两个上游，未变化直接结束；有更新且两个公司工作树干净时，由本机已登录的 Codex CLI 执行固定维护指令，消耗当前 Codex 账户额度。执行器非交互运行，在当前用户权限下可构建和安装。依赖 Git、Node、固定 Go、Playwright、Codex 登录态及公司网络；路径配置在入口脚本中。

版本包只安装本机，不上传 GitHub Release。公司 Magpie 源码允许快进推送到已授权的私有仓库 `plfccc/nikou-magpie` 的 main，不上传 Nikou 源码或组合资产。版本号以 `company/version.json` 为准，从 `1.0.0` 开始按 SemVer 递增，不再使用 dev 后缀。正式发布资格仍由组合门禁决定，预览包不能变成正式包。维护规则见 [执行指令](../scripts/scheduled-update-prompt.md)。冲突、脏目录、测试失败或需要中断 Worker 时停止并记录，不伪造成功。只允许重启绝对路径校验后的受管 GUI。

日志：`%LOCALAPPDATA%\NikouMagpie\maintenance\runs\时间戳`，包含 upstreams.json、codex.log、result.json、result.md。最新状态在同根 latest.json。CLI 登录失效、无额度或任务被阻止时会记录失败。

只检查并验证入口，不合并安装：

```powershell
& .\company\scripts\scheduled-update.ps1 -CheckOnly
```

手动完整执行：

```powershell
Start-ScheduledTask -TaskName 'NikouMagpie-UpstreamMaintenance'
```

暂停或删除：

```powershell
Disable-ScheduledTask -TaskName 'NikouMagpie-UpstreamMaintenance'
Unregister-ScheduledTask -TaskName 'NikouMagpie-UpstreamMaintenance' -Confirm:$false
```

任务内 AI 会判断兼容性和生成补丁，无法保证每次上游更新都能无人值守完成；失败不继续安装。运行结果以测试、安装事务和实际进程路径证据为准。
