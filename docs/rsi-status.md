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
| 部署 | 本机 pre-owner 冻结维护已部署 `6a8dce4`，25 个包/18 个根 bundle，包含默认禁用的 Memory Learning；14 个身份摘要不变，原 Agent 恢复运行。owner 安装未就绪，学习调度尚未启用。 | [安装](../plugins/lark-channel/docs/rsi-setup.md)、[维护](../scripts/install/README.md#checkout-内的-pre-owner-冻结源码维护) |

## 当前阻塞与下一验收

本机目标为 `assistant`，原 Agent 与用量监控服务运行，学习仍禁用。用户已确认修复离线升级并开启学习 scheduler；升级后只读数据库核查三个旧 Heartbeat/Recovery 任务均为 paused、下一运行时间为空，满足本次 `--ack-existing-automations` 前提。

离线完整元数据、临时 peer 包预热及原生 fallback 修复已通过正式维护，事务退出 0、完成服务验收并清理事务目录；未放宽生产链接守卫。随后 owner 安装退出 1：新协调器 profile 缺少 `@deepseek-ai/dsh-base/cordis.patch.yml`，尚未返回 ready；保留现场排查，不以包安装成功代替调度就绪。启用后该冻结安装的本地更新路径仍受限。

CI 保留 Linux/macOS 完整检查，修正真实 Linux/bwrap/ELF 测试的平台边界、macOS 临时目录的 canonical 短路径、模拟 Docker 和发行包夹具、GNU stat/tar 假设及 Linux 子进程启动等待窗口；删除首次失败后的重复全包测试。`6a8dce4` 的 macOS 根测试还剩 4 项夹具假设失败；补丁显式恢复夹具 PATH、固定 Linux auto 场景并补充 Linux/macOS Home 绑定覆盖，定向 7 项通过，待下一次远端验证。

独立父行为回归门已完成集成与完整根检查；下一交付是独立替换授权、稳定入口切换与回退。现有配置没有父版本/slot 替换授权，不能扩大旧创建或采用额度的语义。当前任务身份按 Inbox 建立，不能推断跨 Inbox 的语义同一性。

启用后由新的真实普通任务验收创建 → 独立验证 → 动态采用 → 后续会话原生发现与复用；记录版本、实际调用、质量、成本、延迟和回归，检查纠正/撤回、重启及 unknown 不重放。之前组件诊断停在 unknown，无候选、采用或复用，不能作为闭环完成证据。两条普通使用通道通过可安装部署与[发布门](releasing.md)后再发布 npm。

## 最新验证

本轮 `pnpm check` 首轮退出 1：validate、零警告 lint、typecheck 和根测试 879 项通过；既有 Automations WAL 写锁测试一次未拒绝活跃 writer。原样单项及整个包复跑分别 1/276 项通过，首次漏检原因尚未确认，未修改生产锁检查。为避免重复根检查，仅续跑失败包和未完成包，再执行 build 与 pack；续跑退出 0，去重合计 8318 项通过、61 项跳过、37 个包 dry-run pack。不能称单次完整命令通过，WAL 安全测试波动仍须跟踪。

原生 fallback 修复在真实失败 stage 的隔离副本调用生产 helper 通过：3 个悬空链接清零，1197 条链接通过原守卫，四份 profile 元数据不变；随后正式升级退出 0。完整检查、续跑、定向输出及升级/owner 安装结果保留在忽略的证据目录。

Cordis、SQLite、Git 使用真实实现；模型及 Docker 行为观察使用夹具，61 项跳过不证明外部/live 行为。本轮升级已部署，但学习尚未就绪、未发布 npm，也不证明普通任务收益。完整检查、定向输出及本机维护/恢复证据保留在忽略目录 `docs/evidence/rsi-default-learning/` 与 `docs/evidence/rsi-offline-learning/`。

生产 DeepSeek 固定合同仍于 2026-10-08 过期；Super Relay 预算插件的固定合同于 2026-10-14 到期，但本机未安装该预算插件，不能据此判断当前会话路由是否可用。保留 owner 会话的 `super-relay/ark/seed-evolving` 选择，不把静态选择当作 live 调用证明；本轮不延长供应合同、不替换用户模型、不续期旧授权。
