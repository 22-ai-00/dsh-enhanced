# RSI 当前状态

更新：2026-10-02。本页是唯一进展入口；默认只加载本页和当前任务相关的 README。完成细节查 Git，验收条件按需查[合同](rsi-acceptance.md)。

## 唯一目标

**实现一个能在普通使用中持续自迭代的智能工具：持久记忆与工程能力一起进化，以创建、动态加载 Cordis 插件为主要扩展方式。** 初始配置和授权后，用户不必逐次编排改进。

真实任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。

**完整普通使用闭环尚未验收，npm 发布门未满足。**

## 当前边界与阻塞

| 能力 | 已有实现与剩余边界 | 按需入口 |
| --- | --- | --- |
| 任务与记忆 | 任务反馈、原生调度和记忆学习已有实现；记忆对后续真实决策的收益待验收。 | [Delivery](../plugins/assistant-delivery/README.md)、[Memory](../plugins/assistant-memory-learning/README.md) |
| 工程进化 | 新工具独立验收、有限签名采用与 Cordis 动态入口已有实现；新安装一次配置创建/验收/采用授权及不可变行为镜像，旧安装重试保持原范围与额度。每次调用在独立容器挂载精确包，当前限有界纯工具和原来源窗口，真实使用收益、版本替换回退待验收。旧修改采用仍重启整 Host。 | [Growth](../plugins/assistant-growth-driver/README.md)、[Control Plane](../plugins/plugin-control-plane/README.md)、[Verifier](../plugins/assistant-verifier/README.md) |
| 部署 | 安装、双 Host 交接与回退已有组件；普通使用闭环待部署验收。 | [安装](../plugins/lark-channel/docs/rsi-setup.md)、[试用](bounded-live-adoption.md) |

## 下一次验收

**验收真实普通任务驱动的创建→独立验收→动态采用→新任务会话发现并复用工具。** 初始一次配置后无需逐 Goal arm；先验证原有效窗口内的后续任务，记录准确工具版本、实际调用和后续任务质量、成本、延迟及回归，验证纠正/撤回、重启、非目标能力存活与 unknown 不重放。

随后补齐版本替换回退与跨来源窗口的能力延续，验收记忆对真实后续决策的收益；以可安装部署验证两条普通使用通道，通过[发布门](releasing.md)后再发布 npm。

## 最新验证

10 月 2 日安装授权链定向检查 37 项通过，独立复核 PASS；真实 Docker 行为镜像准备、只读读取和重复复用退出 0，固定 worker 摘要匹配且镜像无应用源码。`VITEST_MAX_WORKERS=1 pnpm check` 退出 0，含全仓清单、lint、类型、测试、构建及 37 包 dry-run pack；根测试 829 通过、3 跳过，Lark 包 922 通过、1 跳过。全检结束时 15 个冻结文件摘要一致，随后仅本页更新验证记录；真实 Lark tarball 的新模块、文件边界及编译字节匹配构建。原始日志与完成回执在忽略目录 `docs/evidence/rsi-creation-setup/`；这些工程和镜像结果不证明真实普通部署闭环。
