# RSI 当前状态

更新：2026-10-04。本页是唯一进展入口；只加载本页及当前任务相关 README。验收条件见[合同](rsi-acceptance.md)，历史细节查 Git。

## 目标

实现普通使用驱动的持续自迭代：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。初始配置和授权后，主人不必逐次编排改进。

**完整普通使用闭环尚未验收，npm 发布门未满足。**

## 能力边界

| 能力 | 当前边界 | 入口 |
| --- | --- | --- |
| 任务与记忆 | 已有认证反馈、原生调度与持久记忆学习；真实后续决策收益待验收。 | [Delivery](../plugins/assistant-delivery/README.md)、[Memory](../plugins/assistant-memory-learning/README.md) |
| 工程进化 | 已有源码目标发现、失败任务优先复盘、新工具独立验收、有限签名采用与动态加载；新会话延续原窗口及额度。跨窗口能力延续与版本替换回退尚未实现；真实收益待验收。 | [Growth](../plugins/assistant-growth-driver/README.md)、[Control Plane](../plugins/plugin-control-plane/README.md) |
| 部署 | 本机冻结更新已成功，绑定 `c79d30e`，25 个包/18 个根 bundle，包含默认禁用的 Memory Learning；原身份与配置保留。尚未安装 owner/coordinator 或启用学习调度。 | [安装](../plugins/lark-channel/docs/rsi-setup.md)、[维护](../scripts/install/README.md#checkout-内的-pre-owner-冻结源码维护) |

## 当前阻塞与下一验收

下一步完成一次 owner/coordinator 配置。开启 scheduler 涉及现有三个 paused Automation，已请求确认但尚无答复，不能自动添加 `--ack-existing-automations`；重复任务提示不等于该确认。部署准备已完成，学习仍禁用。

随后由新的真实普通任务验收创建 → 独立验证 → 动态采用 → 后续会话原生发现与复用；记录版本、实际调用、质量、成本、延迟和回归，检查纠正/撤回、重启及 unknown 不重放。之前组件诊断停在 unknown，无候选、采用或复用，不能作为闭环完成证据。两条普通使用通道通过可安装部署与[发布门](releasing.md)后再发布 npm。

## 最新验证

`ca74d27`、`c79d30e` 已推送 `dev`。`VITEST_MAX_WORKERS=4 pnpm check` 退出 0：8156 项通过、61 项跳过，构建及 37 个包 dry-run pack 通过，代码独立复核 PASS。链接回归 8/8、相关测试 332 项通过；真实归档全树只读复验通过（原 Home 1280、副本 1355 条包链接）。正式升级退出 0，部署独立复核 PASS：25 个包文件匹配、新 InvocationID、Host ready、真实 Lark connected、active/running、重启计数 0，33 项身份与配置摘要未变；临时暂停的 Kaboo 用量采样服务已恢复。这些结果不证明普通任务收益。

原始日志与退出记录保存在忽略目录 `docs/evidence/rsi-next-deployment/`。外部跳过测试和可丢弃副本探针不证明真实普通任务收益。
