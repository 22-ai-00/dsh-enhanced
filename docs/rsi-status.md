# RSI 当前状态

更新：2026-10-12。本页是唯一进展入口；只加载本页及当前任务相关 README。验收条件见[合同](rsi-acceptance.md)，历史细节查 Git。

## 目标

实现普通使用驱动的持续自迭代：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。初始配置和授权后，主人不必逐次编排改进。

**完整普通使用闭环尚未验收，npm 发布门未满足。**

## 能力边界

| 能力 | 当前边界 | 入口 |
| --- | --- | --- |
| 任务与记忆 | 已有认证反馈、原生调度与持久记忆学习；真实后续决策收益待验收。 | [Delivery](../plugins/assistant-delivery/README.md)、[Memory](../plugins/assistant-memory-learning/README.md) |
| 工程进化 | 已有源码发现、失败任务复盘、新工具独立验收、有限签名采用与动态加载，精确版本调用/反馈关联及独立签名源码保留。默认关闭的有限修订候选已具备独立父行为回归门：首作者请求前冻结专用授权，Verifier 私有父用例与候选写权限分离，父/候选新隔离观察，独立额度与签名结果，unknown 不重放。候选仍不执行或替换父版本，历史证据不延续执行权；稳定入口切换、回退与真实收益待验收。 | [Growth](../plugins/assistant-growth-driver/README.md)、[Control Plane](../plugins/plugin-control-plane/README.md) |
| 默认安装 | 开发版 Linux shell 与 CLI 默认进入完整学习配置；可信配对、模型与构建前提仍必需，路径和有限预算自动生成。保留显式轻量场景和不启用服务/渠道的退出选项；裸 bundle 不绕过配置验证，远程发布 tag 尚未更新。 | [安装器](../scripts/install/README.md) |
| 部署 | 本机 pre-owner 冻结维护已部署 `962911e`，25 个包/18 个根 bundle，包含默认禁用的 Memory Learning；14 个身份及持久配置保留，目标安装锁随新制品物化。尚未安装 owner/coordinator 或启用学习调度。 | [安装](../plugins/lark-channel/docs/rsi-setup.md)、[维护](../scripts/install/README.md#checkout-内的-pre-owner-冻结源码维护) |

## 当前阻塞与下一验收

本机目标为 `assistant`，原 Agent 与用量监控服务已恢复运行；部署仍为上述 `962911e`，学习禁用。三个旧 paused Automation 为两个 Heartbeat 与一个 Recovery，当前配置没有启用它们。已请求确认保持旧任务暂停并开启学习 scheduler，尚无答复，不能自动添加 `--ack-existing-automations`。

当前开发增量的 pre-owner 更新被暂存链接安全门拒绝，未切换 Home。pnpm 11.7.0 的隔离离线 `add` 结果锁缺失 Koffi 的 20 个可选平台条目，相同依赖的在线 `add` 对照保留；内部机制尚未证实。原锁仅补齐已安装 Koffi 3.3.2 的 20 个平台条目并规范排序，持锁、备份与 CAS 操作通过独立审查；未在原 Home 安装新包或修改授权、模型，25 个已安装 cohort 包复验通过。尚无保持离线边界的已验证修复。原生 `local-service-recover` 退出 0、通过原服务就绪验收，用量监控也已恢复。下一步先修复并验证实际离线维护路径，再配置 owner/coordinator；启用后该冻结安装的本地更新路径仍受限。

独立父行为回归门已完成集成与完整根检查；下一交付是独立替换授权、稳定入口切换与回退。现有配置没有父版本/slot 替换授权，不能扩大旧创建或采用额度的语义。当前任务身份按 Inbox 建立，不能推断跨 Inbox 的语义同一性。

启用后由新的真实普通任务验收创建 → 独立验证 → 动态采用 → 后续会话原生发现与复用；记录版本、实际调用、质量、成本、延迟和回归，检查纠正/撤回、重启及 unknown 不重放。之前组件诊断停在 unknown，无候选、采用或复用，不能作为闭环完成证据。两条普通使用通道通过可安装部署与[发布门](releasing.md)后再发布 npm。

## 最新验证

默认安装实现 `b1a17f0` 已提交并推送 `dev`，独立审查通过。`VITEST_MAX_WORKERS=4 pnpm check` 最终退出 0：8306 项通过、61 项跳过；manifest 校验、零 lint 警告、类型检查、构建及 37 个包 dry-run pack 通过。安装器定向 16 项、CLI 156 项、端口预检 7 项通过；新默认覆盖 Linux auto/非交互/菜单、显式退出、非支持平台、缺 Bot 前置拒绝、CLI 重复参数及原端口安全门。后续仓库修改仅为本页状态更新。

Cordis、SQLite、Git 使用真实实现；模型及 Docker 行为观察使用夹具，61 项跳过不证明外部/live 行为。本轮尚未成功部署或发布 npm，也不证明普通任务收益。完整检查、定向输出及本机维护/恢复证据保留在忽略目录 `docs/evidence/rsi-default-learning/`。

生产 DeepSeek 固定合同仍于 2026-10-08 过期；当前 owner 会话的 Super Relay 选择需在启用时重验，其合同于 2026-10-14 到期。本轮不延长供应合同、不替换用户模型、不续期旧授权。
