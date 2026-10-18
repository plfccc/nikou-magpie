# Windows 开发版验证记录

日期：2026-10-19。此记录用于开发分支审查，不表示正式发布通过。未执行真实账号切换、用户配置迁移、主从节点部署、Worker启停或群通知。

| 检查 | 结果 |
| --- | --- |
| 维护脚本全套 | 43/43，通过；临时真实Git、双上游合并、安装/迁移故障与profile导入 |
| 安装/迁移故障覆盖 | 16/16，通过；包含人工指针修改与回执write/rename中断 |
| Go桥接、GUI内置守卫、公司更新守卫 | 通过 |
| Go internal/nikou race | 通过 |
| Go本机vet、Linux nogui vet/build | 通过；Linux仅编译检查，不表示Linux产品已交付 |
| Windows production EXE | 通过；固定winres 0.3.3、公司自更新隔离与无控制台窗口链接 |
| Chromium/WebKit Nikou、builtins、kernel和文案守卫 | 联合35/35，通过 |
| Nikou初轮聚焦与兼容测试 | 29/29，通过 |
| 最终UTF-8、公司运行时更新隔离及旧版本比较回归 | 11/11，通过；UTF-8测试已先复现中文损坏 |
| Nikou ESM/DTS、privacy-scan、npm包清单 | 通过 |
| 真实Go→Nikou hello/status | 源码与构建产物均通过；隔离HOME/USERPROFILE/APPDATA/LOCALAPPDATA，Worker stopped |
| Nikou Windows全套 | **未通过**：786项，714通过、71失败、1取消；API模式测试挂起后受控终止 |
| 上游完整GUI 799文件套件、Windows桌面WebView2人工验收 | 未完成；不能从页面模拟测试推导原生桌面全部通过 |
| 真实原生账号与Worker生命周期 | 未运行 |
| 正式最终组合包、原生安装/回滚发布证据 | 未签发；全套Nikou失败仍阻断正式构建链 |

全套失败涉及POSIX权限位断言、Windows脚本执行与原生Runner等兼容问题。没有通过删除测试或跳过门禁将其转绿。后续应在公司分支逐项解决，并在目标Windows环境重跑后才进入正式发布。

开发预览位于本机 `artifacts/company/preview/`：EXE版本为 `1.0.0-dev.1`，Nikou npm包为当前0.1.89公司源码构建。它们不是已通过组合安装门禁的正式安装包，未上传Release。源码和实际提交以 lock及Git历史为准，预览文件不纳入Git。

独立审查已发现并修复回滚覆盖后改指针、迁移回执截断、UTF-8分块损坏和额度stale未显示问题。普通全局Nikou保留原更新行为；公司私有运行时通过 `NIKOU_MANAGED_RUNTIME=1` 禁止Nikou全局npm升级和公共latest查询，避免绕开组合更新。
