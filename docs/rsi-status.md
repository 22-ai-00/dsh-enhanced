# RSI 当前状态

更新：2026-10-13。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，历史实施细节查 Git。

## 目标

普通使用驱动持续自迭代：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。初始配置和授权后，主人不必逐次编排改进。

**完整普通使用闭环尚未验收，npm 发布门未满足。**

## 能力边界

- 已有原生任务调度、认证反馈及持久记忆学习；后续真实任务的质量、成本、延迟与回归收益仍待验收。
- 已有源码发现、失败任务复盘、新工具独立验收、有限签名采用和动态加载。有限修订候选有独立父行为回归门，但不包含父版本 / slot 替换授权；unknown 不自动重放。
- 开发安装默认进入 supervised 学习配置，仍需可信配对、模型、有限预算、Linux systemd 和隔离构建前提。显式轻量安装与不启动选项保留；远程发布制品尚未更新。
- 开发锁及 peers 已适配官方 npm latest **DSH `0.2.0-rc.2`**；上游尚无正式稳定版。安装先解析 latest，再固定受支持的精确版本，不追踪 next。

## 当前交付

修复 CI，完成旧 Home 的联合 Host / 源码迁移，再启用生产学习并验证远端 CI。事件主动跟进和 npm 新版本等待这一部署及普通使用验收，不并列展开新主任务。

生产 canonical Home `/data00/home/jiataorui/.dsh` 已完成 DSH `0.1.5-rc.3` → `0.2.0-rc.2` 联合迁移，以及同 Host 的全 Home 源码更新至 `24cd6feb`。assistant、预备协调器、ACP、Web、headless 的依赖图完成离线物化。assistant 与原用量监控服务 active/running、重启计数为零；14 个签名身份、三个暂停且无下一运行时间的旧任务以及会话模型保持不变。

原生 DSH 异步导入旧 `settings.yaml` 导致接受后的 profile 摘要改变，迁移按设计收容停服。现已用禁网副本精确复现，签署仅绑定该事务和已发生单 profile 后继的恢复许可；原设置、旧标记、前后补丁、回放方法 / 原始观察和许可保存在事务外私有归档。重新启动通过 fresh readiness 后完成清理；没有放松普通漂移检查或回退已运行 Home。三节 UI / 旧 preset 设置被上游拒绝，仅保留原件，不宣称已生效。后续迁移在停服前拒绝尚待导入的旧设置。

旧 `rsi-creation-builds` 已经原生迁移至当前签名源码；旧收据完整私有归档，新行为镜像的真实进程检查 7/7 通过。同 Host 联合更新保持 Host 绑定及服务 unit 原字节；不使用普通单 profile 路径绕过预备协调器或旧 cache 边界。

首次 owner 安装暴露采集器把包名当成 executor 标识的问题；实际 authority validator 正确拒绝 `@deepseek-ai/dsh`。采集器改用合法 `dsh`，仍固定原包身份、版本、路径和摘要，并增加真实采集器 → 编译配置 → adoption / trust 校验回归。失败清理补齐 SQLite sidecar 的身份、纳秒元数据和摘要检查；既有或改写文件不删除。此次已发生的残留在 Home 锁及停服 mask 窗口中完整私有归档，原生 pre-owner 证明及服务恢复独立核验通过。owner 配置 / registry 尚为空、学习 scheduler 仍关闭；下一步部署这项修复再启用。

## 最新验证与阻塞

- CI 修复 `db54e533` 已推送 dev：原 macOS evaluation 失败已消失，但远端运行 [38323695472](https://github.com/22-ai-00/dsh-enhanced/actions/runs/38323695472) 又暴露目录 setgid 夹具及三个 Git 修订测试超时；修复提交 `2d20a4d1` 尚未推送。Windows 已通过；Linux 全部测试通过后触及 35 分钟上限。新配置移除根检查的重复构建，将 Linux 根测试与包测试 / 37 包 prepack / dry-run pack 分为两个独立作业，原 `verify` 必须等两者成功；未减少验收门，新配置尚待最终完整检查及远端验证。
- 最近完整 `VITEST_MAX_WORKERS=2 pnpm check` 退出 0：8488 项通过、61 项跳过、37 包 dry-run pack；同 Host 入口另有 79 项定向回归。owner 修复的增强版完整检查正在运行，尚无最终结果；跳过外部场景不代表 live 行为已验证。
- 独立只读审查通过签名许可和恢复边界；生产恢复退出 0，Host binding / receipt、服务实际 executable 与稳定 InvocationID、事务清理、私有归档及原身份 / 暂停任务 / 会话模型保留均已独立核验。学习启用及远端 CI 尚待完成。
- 原 DeepSeek 固定合同已于 2026-10-08 过期；不延长合同或旧授权。保留 `super-relay/ark/seed-evolving` 会话模型及既有 fallback，静态配置不代表 live 模型调用通过。

证据存放于忽略目录 `docs/evidence/ci-migration/`。生产启用后，仍需新的真实普通任务证明创建 → 独立验证 → 动态采用 → 后续复用及纠正 / 撤回 / 重启边界，满足[发布门](releasing.md)后才发布 npm。
