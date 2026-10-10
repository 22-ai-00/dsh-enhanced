# RSI 当前状态

更新：2026-10-10。本页是唯一进展入口；只加载本页及当前任务相关 README。验收条件见[合同](rsi-acceptance.md)，历史细节查 Git。

## 目标

实现普通使用驱动的持续自迭代：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。初始配置和授权后，主人不必逐次编排改进。

**完整普通使用闭环尚未验收，npm 发布门未满足。**

## 能力边界

| 能力 | 当前边界 | 入口 |
| --- | --- | --- |
| 任务与记忆 | 已有认证反馈、原生调度与持久记忆学习；真实后续决策收益待验收。 | [Delivery](../plugins/assistant-delivery/README.md)、[Memory](../plugins/assistant-memory-learning/README.md) |
| 工程进化 | 已有源码发现、失败任务复盘、新工具独立验收、有限签名采用与动态加载，精确版本调用/反馈关联及独立签名源码保留。默认关闭的有限修订候选已具备独立父行为回归门：首作者请求前冻结专用授权，Verifier 私有父用例与候选写权限分离，父/候选新隔离观察，独立额度与签名结果，unknown 不重放。候选仍不执行或替换父版本，历史证据不延续执行权；稳定入口切换、回退与真实收益待验收。 | [Growth](../plugins/assistant-growth-driver/README.md)、[Control Plane](../plugins/plugin-control-plane/README.md) |
| 部署 | 本机 pre-owner 冻结维护已部署 `962911e`，25 个包/18 个根 bundle，包含默认禁用的 Memory Learning；14 个身份及持久配置保留，目标安装锁随新制品物化。尚未安装 owner/coordinator 或启用学习调度。 | [安装](../plugins/lark-channel/docs/rsi-setup.md)、[维护](../scripts/install/README.md#checkout-内的-pre-owner-冻结源码维护) |

## 当前阻塞与下一验收

下一步完成一次 owner/coordinator 配置。开启 scheduler 涉及现有三个 paused Automation，已请求确认但尚无答复，不能自动添加 `--ack-existing-automations`；重复任务提示不等于该确认。部署仍为上述 `962911e`，学习禁用；后续开发增量尚未部署。

独立父行为回归门已完成集成与完整根检查；下一交付是独立替换授权、稳定入口切换与回退。现有配置没有父版本/slot 替换授权，不能扩大旧创建或采用额度的语义。当前任务身份按 Inbox 建立，不能推断跨 Inbox 的语义同一性。

启用后由新的真实普通任务验收创建 → 独立验证 → 动态采用 → 后续会话原生发现与复用；记录版本、实际调用、质量、成本、延迟和回归，检查纠正/撤回、重启及 unknown 不重放。之前组件诊断停在 unknown，无候选、采用或复用，不能作为闭环完成证据。两条普通使用通道通过可安装部署与[发布门](releasing.md)后再发布 npm。

## 最新验证

`VITEST_MAX_WORKERS=4 pnpm check` 退出 0：8285 项通过、61 项跳过；manifest 校验、零 lint 警告、类型检查、构建及 37 个包 dry-run pack 通过，新回归合同与验收模块进入包。31 个实现/测试文件冻结摘要一致。Control Plane 1138 项、Growth Driver 156 项、Verifier 180 项通过；独立控制面定向 144 项通过。

覆盖私有父用例、双方新观察、专用授权与额度、签名和原子落账失败、来源纠正/撤回、owner 换代、冷启动与 unknown 不重放，以及 schema 33 → 34 保留旧证据/累计额度和拒绝未知结构。Cordis、SQLite、Git 使用真实实现；模型及 Docker 行为观察使用夹具，61 项跳过不证明外部/live 行为。本轮未部署或发布 npm，也不证明普通任务收益。

全检发现既有 DeepSeek 测试依赖真实日期；经确认仅修正测试时钟并验证到期拒绝，生产合同仍于 2026-10-08 过期，未延长供给或授权。初跑失败、全包审计和最终重验记录保留在忽略目录 `docs/evidence/rsi-revision-regression/`；部署历史查 Git。
