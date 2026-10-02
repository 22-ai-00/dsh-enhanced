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
| 工程进化 | 任务绑定的新工具候选已接入独立验收、有限签名采用与 Cordis 动态入口；每次调用在独立容器挂载精确包。当前限有界纯工具和原来源窗口；真实普通使用收益、版本替换回退待验收。旧修改采用仍重启整 Host。 | [Growth](../plugins/assistant-growth-driver/README.md)、[Control Plane](../plugins/plugin-control-plane/README.md)、[Verifier](../plugins/assistant-verifier/README.md) |
| 部署 | 安装、双 Host 交接与回退已有组件；普通使用闭环待部署验收。 | [安装](../plugins/lark-channel/docs/rsi-setup.md)、[试用](bounded-live-adoption.md) |

## 下一次验收

**验收真实普通任务驱动的创建→独立验收→动态采用→后续任务复用。** 初始一次配置后无需逐 Goal arm；记录准确工具版本、实际调用和后续任务质量、成本、延迟及回归，验证纠正/撤回、重启与 unknown 不重放。

随后补齐版本替换回退与跨来源窗口的能力延续，验收记忆对真实后续决策的收益；以可安装部署验证两条普通使用通道，通过[发布门](releasing.md)后再发布 npm。

## 最新验证

有限采用定向检查 70 项通过；真实 Docker/native Agent 采用回归 1 项通过，任务、供应商和来源身份接口使用夹具。9 月 30 日 `VITEST_MAX_WORKERS=1 pnpm check` 退出 0，包含全仓验证、构建与 37 包 dry-run pack；两个受影响真实包的文件边界及编译字节匹配。10 月 2 日从原执行完成事件恢复退出码；除随后更新的本状态页外，其余 18 个冻结文件哈希一致。

首轮全仓检查退出 1（3 个超时、1 个性能断言）；保持原断言与超时的单 worker 隔离复跑 13/13、18/18 通过。原始日志与退出码记录在忽略目录 `docs/evidence/rsi-created-capability/`。这些结果不证明真实普通部署闭环。
