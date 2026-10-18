# 公司Windows验证Runner

`.github/workflows/release.yml` 仅允许人工运行维护/事务测试，已移除官方 repository-dispatch、官方资产等待、镜像和发布动作。它不替代完整构建验收。

可访问GitLab权威源码、内部npm私服和已固定工具链的原生Windows runner使用 `company/ci/windows-verify.ps1 -NikouDir <绝对路径> -Version x.y.z`。Nikou源码必须已检出 lock 的effectiveCommit且干净，不能默认从latest构建。该模板按source验证、build、artifacts验证、package顺序执行；任一退出码非零即停止。

安装与回滚需要单独指定受管隔离目录和offline模式，由实际事务生成证据。release-plan只生成本地待审说明；任何workflow均不创建官方或公司release、不push、不自动发布通道。
补充：已对docker.yml和ui-preview.yml增加官方仓库限定，公司fork不会自动推镜像或调用上游UI预览服务；release.yml已改只读手动验证。公司入口仍须跑完整source/artifacts/install后再生成release-plan。

GUI 门禁依赖 Playwright 1.59.1 与 Chromium/WebKit；请在隔离工具目录安装固定版本并通过 NODE_PATH 提供给 Node，浏览器由 Playwright 安装到其用户缓存。source 验证会实际运行两种浏览器的 Nikou、builtins、plugin-kernel，以及文案键守卫；依赖或浏览器缺失会失败，不能标记为已验证。未修改的完整799文件GUI套件本轮未全部运行，正式推广前还应按上游规范补齐。
