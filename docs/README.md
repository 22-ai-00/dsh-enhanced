# 文档索引

第一次使用从[首页的三步安装](../README.md#开始使用)开始。无需先了解插件结构或自迭代架构。本页把仓库内的参考说明类文档按「我要做什么」分类；一次性运行结果、过期交接快照与原始日志不入库，历史从 Git 查询。

## 使用帮助

| 想做什么 | 从这里开始 |
| --- | --- |
| 安装、选择场景、解决启动问题 | [安装指南](../scripts/install/README.md) |
| 添加 API 模型、使用 TraeX / Antigravity (`agy`)、切换模型 | [模型配置](models.md) |
| 连接飞书、绑定机器人、排查没有回复 | [飞书接入](../plugins/lark-channel/docs/setup.md) |
| 接入另一个 bot（peer agent）、配置白名单与排障 | [Peer agent 白名单与真实渠道验收](peer-agent-verification.md) |
| 查状态、看日志、升级、重装或卸载 | [dsh-ray 命令参考](../packages/cli/README.md) |
| 了解当前能力与平台限制 | [当前状态](rsi-status.md) |
| 安装更多功能 | [插件目录](../plugins/README.md) |

以下资料供开发、维护或专项验收时查阅。

## 自迭代主线

- [当前状态](rsi-status.md)：唯一进展入口；目标是在普通使用中完成反馈、改进、独立验证、采用和后续观察。
- [Ray 自主成长设计](ray-autonomous-self.md)：身体内核、永续生命流（前台意识+持久 worker）、情景记忆、点子池与主动性、分级热插拔、Ray Home 搬家/传授及 P1–P6 路线。
- [双 Host 安装](../plugins/lark-channel/docs/rsi-setup.md)、[有限试用采用](bounded-live-adoption.md)：当前主线部署与采用合同。
- [Linux 原生运行时](dockerless-runtime.md)：无 Docker 安装、委派 cgroup v1 / 统一 cgroup v2 要求，以及 pre-owner 维护与已有 owner 迁移的不同边界。
- [持久后台任务](../plugins/assistant-work-items/README.md)：默认关闭；显式授权后支持诊断、断点召回、报告回复续办与主人结果反馈。
- [自动记忆学习](../plugins/assistant-memory-learning/README.md)：前台事实/经验，以及另行授权的后台结果经验；独立审查、有限采用与来源撤回。后台工程 Growth 和后续真实任务收益仍待验收。
- [联想记忆层](../plugins/assistant-association/README.md)：进程内存双缓冲关联图与 ≤5ms 联想召回（Slice S1–S4，Schema v4）；由 `--plugin-preset dogfood` 安装并启用本地联想与 Hebbian/WP22 参数自调参（S3 做梦建边/observe 信号与 S4 隔离子进程只读 Web 学习均默认关闭），配合[macOS Dogfood 预设](examples/dogfood-macos.profile.json)与 `dsh-ray growth-report` 第 6 节开展日常记忆通道验收。
- [完整验收合同](rsi-acceptance.md)：涉及具体能力或发布审查时查阅，保留完整成功条件与限定验收边界。
- [持续成长设计](continuous-personal-assistant-growth.md)：产品目标、反馈信任和自治边界；偏好学习不替代工具/插件自迭代。

## 开发与维护

- [Linux 验证环境与完整门前提](linux-validation.md)：在 Linux 独立副本复跑 `pnpm check` 的验证约定与三条环境前提（原生 `@pnpm/exe`、已填充 pnpm store、短 `TMPDIR`）。
- [贡献指南](../CONTRIBUTING.md)、[安全政策](../SECURITY.md)：分支治理（`dev`/`main`）、提交要求、六类权限披露与漏洞私下上报途径。
- [新增插件](creating-a-plugin.md)：插件目录、manifest、patch、测试、README 和目录登记的完整清单。
- [仓库架构](architecture.md)、[共享包与工具包](../packages/README.md)：bundle 与共享库边界、独立发布和 Host/Web 双面设计。
- [Cordis 运行时契约](cordis-runtime-contracts.md)：修改生命周期、注入、配置、资源归属或重载时必读。
- [兼容性基线](compatibility.md)：DSH、Cordis、Node.js 与 pnpm 的版本约束（单一权威来源）。
- [发版指南](releasing.md)：统一版本、tag/workflow、失败重试、竞态和 npm 凭据协议。

## 高级维护与平台兼容

- [高级维护](../scripts/install/maintenance.md)：旧 Home 迁移、冻结源码维护和中断恢复。
- [旧 Delivery 会话迁移](../scripts/maintenance/README.md)：遗留 DSH 0.1（format v2→v3）带 `delivery` 来源会话的离线迁移工具。
- [ACP Windows 兼容性复查](acp-windows-compatibility.md)：原生 Windows 支持现状和限制。

## Provider 参考

- [Coding subscription provider 详细参考](coding-subscription-provider-reference.md)：完整配置、认证门禁、传输协议、错误码与已知限制。

## 按需实现与验证参考

- [端到端与集成探针目录](../scripts/e2e/README.md)：可选浏览器/实时模型/原生边界探针与当前迁移状态（不在默认 `pnpm check` 中）。
- [原生技能复用评测接线](native-skill-reuse.md)：来源验证、受限 Host 委派、原生双臂评测与签名留出报告。
- [目标编排](goal-orchestration-design.md)：原生执行、独立验收、持久唤醒与事件等待。
- [PTC 执行模式与持续成长](ptc-growth-integration.md)：可预测阶段交给程序、轨迹作为成长输入，以及分阶段落地边界。
- [固定任务评测](benchmark-implementation.md)、[执行策略评测](goal-strategy-evaluation.md)：固定供应与预算的比较方法及证据限制。
- [技能比较配置](skill-comparison-profiles.md)、[独立留出验收](skill-holdout-authority.md)：原生重放、冻结后生成任务、签名验收与有限 canary。
- [源码提案与持久检查](live-durable-source-proposal.md)、[真实仓库 E2E](live-repository-e2e.md)：当前验证合同；`live-repository-e2e.md`（`repo-autonomy-real.spec.mjs`）已迁入 `linux-native` 与锁定 Host `0.2.2-rc.5`（专用沙箱仓库实跑待执行），而 `live-durable-source-proposal.md` 涉及的 `personal-memory-source-acceptance.mjs` 及其他 Docker 时代探针迁移待完成。
- [systemd Host 签名器](systemd-host-attestor.md)、[运行时观测](runtime-observer.md)、[阻断回放](effect-blocked-replay.md)：当前发布/启用组件契约与验证限制。
- [发布 adapter](npm-publish-adapter.md)、[独立发布验签](npm-release-verifier.md)、[catalog 准入](npm-catalog-admission.md)、[registry 读回](npm-registry-readback.md)：发布组件与可复现探针；[adapter 生命周期](control-plane-adapter-lifetime.md)说明进程归属、取消和清理边界。

原始运行 JSON 和日志留在本地忽略目录或 CI artifacts；仓库保留维护中的合同、当前可运行命令和必要的验证结论。过期交接快照与重复实施流水从 Git 历史查询。

## 历史研究（仅按需读取）

- [自迭代研究与开发原则](research-dsh-plugin-self-iteration-2026-09-19.md)：模型供应、原生组合与独立验收的设计依据。
- [npm publish adapter 协议研究](research-npm-publish-adapter-2026-09-19.md)：发布 wire 协议、现有发布契约与有界接线的观测记录；当前协议见 [publish adapter](npm-publish-adapter.md)。
- [CLIProxyAPI 设计依据](cliproxyapi-provider-evidence-review.md)：历史设计依据（固定上游来源与当时对照快照）；当前 provider 契约见[详细参考](coding-subscription-provider-reference.md)与各 provider README。
- [插件生态研究](dsh-personal-assistant-plugin-landscape.md)：固定来源与第三方候选审查；旧安装方案和建设清单已移除，当前包列表见[插件目录](../plugins/README.md)。

以下飞书文档保存设计依据，不作为当前配置或行为说明；当前行为见 [`lark-channel`](../plugins/lark-channel/README.md) 与 [`assistant-delivery`](../plugins/assistant-delivery/README.md)。

- [飞书连接与会话模型选择](lark-channel-open-source-design-notes.md)：官方与社区实现的设计取舍。
- [消息 Reaction 与安全进度展示](lark-message-reactions-and-progress-notes.md)：API、权限、隐私和进度状态研究。
