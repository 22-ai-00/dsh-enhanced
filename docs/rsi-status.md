# RSI 当前状态

更新：2026-09-30。默认只读本页和当前任务相关的 README；验收按需查[合同](rsi-acceptance.md)，完成项与历史探针查 Git。

## 唯一目标

**实现一个能在普通使用中持续自迭代的智能工具：持久记忆与工程能力一起进化，以创建、动态加载 Cordis 插件为主要扩展方式。** 初始配置和授权后，用户不必逐次编排改进。

真实任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。

**完整普通使用闭环尚未验收，npm 发布门未满足。**

## 当前能力边界

| 能力 | 已有实现与剩余边界 | 按需入口 |
| --- | --- | --- |
| 日常任务 | owner 绑定、持久投递、工具审批、反馈与原生调度。 | [Delivery](../plugins/assistant-delivery/README.md) |
| 持久记忆 | 自动提取、独立审查、有限采用、纠正撤回和 unknown 对账；待真实部署及后续任务收益验收。 | [Memory Learning](../plugins/assistant-memory-learning/README.md) |
| 工程进化 | 插件修改与新插件候选准备，绑定真实任务、成长模型/预算/会话；候选行为由独立父进程观察，输出仍须外部验收。创建仍止于 pending；当前采用仍重启整 Host。 | [Growth](../plugins/assistant-growth-driver/README.md)、[Control Plane](../plugins/plugin-control-plane/README.md)、[Verifier](../plugins/assistant-verifier/README.md) |
| 安装恢复 | 冻结安装、owner 配置、双 Host 交接、有限试用与回退；待生产激活。 | [安装](../plugins/lark-channel/docs/rsi-setup.md)、[试用](bounded-live-adoption.md) |

## 剩余交付顺序

1. **新插件独立行为验收与有限签名采用。** 验收规则在候选写权限之外，审批绑定真实来源和精确制品；初始授权后能自动推进普通任务产生的候选。
2. **Cordis 动态加载与使用后观察。** 完成真实 Host 的动态装卸、后续任务复用、退化回滚和源码 unknown 自动资源对账；消除 Skills 逐 Goal 手动 arm。
3. **普通使用部署验收并发布。** 双 Host 在 owner 授权与预算下验证记忆/工程改进、后续收益、纠正撤回、重启及 unknown 恢复；通过后[发布 npm](releasing.md)。

## 最新验证

当前候选观察进程边界：根 `pnpm check` 通过（7972 passed、58 skipped；37 包 dry-run pack），检查期间源码冻结一致；最终镜像 7 项真实 Docker 回归与 Verifier 实际打包核对通过。原始证据在忽略目录 `docs/evidence/rsi-plugin-process-observer/`；工程 fixture 与跳过的外部测试不证明普通使用闭环。
