# RSI 当前状态

更新：2026-10-03。本页是唯一进展入口；只加载本页及当前任务相关 README。验收条件见[合同](rsi-acceptance.md)，历史细节查 Git。

## 目标

实现普通使用驱动的持续自迭代：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。初始配置和授权后，主人不必逐次编排改进。

**完整普通使用闭环尚未验收，npm 发布门未满足。**

## 能力边界

| 能力 | 当前边界 | 入口 |
| --- | --- | --- |
| 任务与记忆 | 已有认证反馈、原生调度与持久记忆学习；真实后续决策收益待验收。 | [Delivery](../plugins/assistant-delivery/README.md)、[Memory](../plugins/assistant-memory-learning/README.md) |
| 工程进化 | 已有源码目标发现、失败任务优先复盘、新工具独立验收、有限签名采用与动态加载；新会话延续原窗口及额度。跨窗口能力延续、版本替换回退和真实收益待验收。 | [Growth](../plugins/assistant-growth-driver/README.md)、[Control Plane](../plugins/plugin-control-plane/README.md) |
| 部署 | 已有冻结源码候选、pre-owner 更新和 Memory Learning 根包扩展。已实现停服前的私有供应链验证/预取及新进程安装复核；完整离线安装副本验收通过，全仓检查已通过，尚未切换本机服务。 | [安装](../plugins/lark-channel/docs/rsi-setup.md)、[维护](../scripts/install/README.md#checkout-内的-pre-owner-冻结源码维护) |

## 当前阻塞与下一验收

本机旧 `assistant` 已通过官方恢复事务恢复，服务 active/running、重启计数 0；身份与配置未更换。旧安装没有 Memory Learning 根依赖或 owner/coordinator 配置。下一步先完成冻结更新及 learner 扩展，再完成一次 owner 配置；开启 scheduler 涉及现有三个 paused Automation，仍须按安装合同显式确认。

随后由新的真实普通任务验收创建 → 独立验证 → 动态采用 → 后续会话原生发现与复用；记录版本、实际调用、质量、成本、延迟和回归，检查纠正/撤回、重启及 unknown 不重放。之前组件诊断停在 unknown，无候选、采用或复用，不能作为闭环完成证据。两条普通使用通道通过可安装部署与[发布门](releasing.md)后再发布 npm。

## 最新验证

本次官方恢复退出 0，独立只读复核 PASS。33 项维护/缓存测试、45 项包安装测试通过。真实 pnpm 11.7.0 使用全新私有缓存，通过旧锁 145 项供应链检查并预取 126 项依赖；无网络、禁安装脚本的完整原生安装与候选闭包/文件核验退出 0，约 17 秒，正式 Home 未改动。`VITEST_MAX_WORKERS=4 pnpm check` 实际退出 0：8145 项通过、61 项跳过，干净构建及 37 个包 dry-run pack 通过；受检源码/测试摘要与检查开始时一致。独立交付审查 PASS；该结论限定于冻结源码维护修复，不证明正式服务更新或普通任务收益。

原始日志与退出记录保存在忽略目录 `docs/evidence/rsi-next-deployment/`。外部跳过测试和可丢弃副本探针不证明真实普通任务收益。
