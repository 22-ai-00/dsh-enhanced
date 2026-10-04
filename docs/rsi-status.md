# RSI 当前状态

更新：2026-10-04。本页是唯一进展入口；只加载本页及当前任务相关 README。验收条件见[合同](rsi-acceptance.md)，历史细节查 Git。

## 目标

实现普通使用驱动的持续自迭代：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。初始配置和授权后，主人不必逐次编排改进。

**完整普通使用闭环尚未验收，npm 发布门未满足。**

## 能力边界

| 能力 | 当前边界 | 入口 |
| --- | --- | --- |
| 任务与记忆 | 已有认证反馈、原生调度与持久记忆学习；真实后续决策收益待验收。 | [Delivery](../plugins/assistant-delivery/README.md)、[Memory](../plugins/assistant-memory-learning/README.md) |
| 工程进化 | 已有源码目标发现、失败任务优先复盘、新工具独立验收、有限签名采用与动态加载；新会话延续原窗口及额度。跨窗口能力延续、版本替换回退和真实收益待验收。 | [Growth](../plugins/assistant-growth-driver/README.md)、[Control Plane](../plugins/plugin-control-plane/README.md) |
| 部署 | 已有冻结源码候选、pre-owner 更新和 Memory Learning 根包扩展；pnpm 相邻契约依赖修复已交付。副本 FD 与多级相对链接解析修复通过全检，正式更新尚待重试。 | [安装](../plugins/lark-channel/docs/rsi-setup.md)、[维护](../scripts/install/README.md#checkout-内的-pre-owner-冻结源码维护) |

## 当前阻塞与下一验收

正式更新在切换前拒绝副本内有效的 pnpm peer 链接，旧 Home 与服务已恢复并独立复核 PASS（33 项身份与配置摘要不变、active/running、重启计数 0）。FD 词法与原样多级相对外链解析修复已通过全检；完成独立复核与交付后，重试冻结更新及 learner 扩展。旧安装尚无 Memory Learning 根依赖或 owner/coordinator；随后需要一次 owner 配置。开启 scheduler 涉及现有三个 paused Automation，已请求确认但尚无答复，不能自动添加 `--ack-existing-automations`。

随后由新的真实普通任务验收创建 → 独立验证 → 动态采用 → 后续会话原生发现与复用；记录版本、实际调用、质量、成本、延迟和回归，检查纠正/撤回、重启及 unknown 不重放。之前组件诊断停在 unknown，无候选、采用或复用，不能作为闭环完成证据。两条普通使用通道通过可安装部署与[发布门](releasing.md)后再发布 npm。

## 最新验证

`VITEST_MAX_WORKERS=4 pnpm check` 退出 0：8156 项通过、61 项跳过，构建及 37 个包 dry-run pack 通过。新增链接回归 8/8，相关测试 332 项通过；真实失败归档全树只读复验通过（原 Home 1280、副本 1355 条包链接）。`ca74d27` 已推送 `dev`，授权依赖修复已交付；后续正式更新退出 1，切换前恢复独立 PASS。单行路径修复曾主动取消全检，补齐多级解析后本轮重新通过。首轮不限制 workers 的三个失败路径隔离复验与两次有界全检均通过，首轮根因未确定。这些结果不证明正式升级或普通任务收益。

原始日志与退出记录保存在忽略目录 `docs/evidence/rsi-next-deployment/`。外部跳过测试和可丢弃副本探针不证明真实普通任务收益。
