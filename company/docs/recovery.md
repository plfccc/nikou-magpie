# 离线安装与恢复

先关闭 CC Switch 旧自动拉起，停止旧 Worker、Nikou 控制台和 magpie；首版要求操作者核验离线状态。不得仅传 offline 参数却继续运行旧监督器。

`install --manifest <最终release-manifest绝对路径> --install-root <绝对受管目录> --offline` 校验清单、逐文件 SHA256、平台和入口，复制到独立版本目录，执行两个无副作用自检，健康后才提交 current 指针。不覆盖正在被 Windows 占用的旧二进制。

安装结果给出 transactionId。回滚使用 `rollback --transaction <该ID> --install-root <相同受管目录> --offline`。只允许恢复该事务原来的完整指针；后续安装或人工修改会阻止回滚。旧版本重新验摘要和健康后再激活。首次安装回滚移除 current 指针，保留版本现场。

事务保存在 `transactions/<ID>.json`。状态为 STAGED、VERIFIED、BACKED_UP、OLD_STOPPED、ACTIVATING、HEALTHY、COMMITTED；失败进入 ROLLING_BACK，再到 ROLLED_BACK 或 RECOVERY_REQUIRED。OLD_STOPPED 在首版表示调用者已明确确认离线，安装器没有自动停止生产进程。

遇到 RECOVERY_REQUIRED 或残留 `.install.lock`，先核实对应进程确实退出并保留事务、current 和版本目录副本。不要直接删除回执、覆盖 current、删旧版本或再次安装。确认无安装进程后才由维护者处理残留锁，按原事务回滚；指针存在后改时先人工协调冲突。配置迁移使用独立回执和备份，恢复规则见 migration。

真实用户目录没有在本轮被安装器接管。Windows ACL、真实登录切换、飞书交互、Worker生命周期及正式发布需要后续在指定测试身份和环境中验收；当前脚本门禁不会把缺失证据视为通过。
