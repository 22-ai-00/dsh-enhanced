# RSI 当前状态

更新：2026-10-03。本页是唯一进展入口；默认只加载本页和当前任务相关的 README。完成细节查 Git，验收条件按需查[合同](rsi-acceptance.md)。

## 唯一目标

**实现一个能在普通使用中持续自迭代的智能工具：持久记忆与工程能力一起进化，以创建、动态加载 Cordis 插件为主要扩展方式。** 初始配置和授权后，用户不必逐次编排改进。

真实任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。

**完整普通使用闭环尚未验收，npm 发布门未满足。**

## 当前边界与阻塞

| 能力 | 已有实现与剩余边界 | 按需入口 |
| --- | --- | --- |
| 任务与记忆 | 任务反馈、原生调度和记忆学习已有实现；同主人新会话保留原执行来源，记忆采用的双 producer 写锁保持原子。记忆对后续真实决策的收益待验收。 | [Delivery](../plugins/assistant-delivery/README.md)、[Memory](../plugins/assistant-memory-learning/README.md) |
| 工程进化 | 新工具独立验收、有限签名采用与 Cordis 动态入口已有实现；新安装一次配置创建/验收/采用授权及行为镜像。完整创建配置经校验后，仅为当前 owner 的普通外部会话开放本安装工具命名空间；执行器仍逐次检查采用状态、来源、期限和额度。同主人 `/new` 延续原窗口、额度和版本，主人轮换、纠正/撤回拒绝旧来源。当前限有界纯工具和原来源窗口，真实使用收益、跨窗口延续及版本替换回退待验收。旧修改采用仍重启整 Host。 | [Growth](../plugins/assistant-growth-driver/README.md)、[Control Plane](../plugins/plugin-control-plane/README.md)、[Verifier](../plugins/assistant-verifier/README.md) |
| 部署 | 安装、双 Host 交接与回退已有组件；普通使用闭环待部署验收。Super Relay 原生 system 投影已修复，真实模型来源与新会话延续探针通过；本地捕获通道和合成配对身份仍不代表真实用户部署验收。 | [安装](../plugins/lark-channel/docs/rsi-setup.md)、[试用](bounded-live-adoption.md) |

## 下一次验收

**验收真实普通任务驱动的创建→独立验收→动态采用→新任务会话原生发现并复用工具。** Growth 已能读取 owner 核对、过滤并纳入冻结来源的原始已发送答复；旧来源失配拒绝继续，unknown 不重放。最新真实供应商组件诊断仅完成任务、认证负反馈、canonical 持久投影和自动复盘，Growth reviewed 未提交候选，不能当成采用。后续以新的普通任务检验实际候选与复用，初始一次配置后无需逐 Goal arm；记录工具版本、实际调用、质量、成本、延迟及回归，验证纠正/撤回、重启、非目标能力存活与 unknown 不重放。

随后补齐版本替换回退与跨来源窗口的能力延续，验收记忆对真实后续决策的收益；以可安装部署验证两条普通使用通道，通过[发布门](releasing.md)后再发布 npm。

## 最新验证

10 月 3 日 owner 绑定的已发送答复证据能力独立复核 PASS：原答复在 16 KiB 完整读取上限内先过滤常见凭据形状，再限至 4096 UTF-8 字节，超限仅给占位文本；Growth 只接收文本和标志，Host 保留完整摘要及 Outbox 绑定。Delivery 只读来源读取复用已有 writer fence，独立读取仍开启事务，跨包记忆采用回归通过。

冻结 12 个交付文件的 `VITEST_MAX_WORKERS=1 pnpm check` 退出 0：manifest、零 lint 警告、类型检查、8099 项测试通过/61 项跳过、干净构建及 37 个包 dry-run pack；Delivery/Growth 发布文件清单已确认。检查后仅更新本状态页的结果说明；实现、测试和 README 摘要保持不变。完整检查与独立审查证据位于忽略目录 `docs/evidence/rsi-growth-reply-evidence/`。跳过的外部测试不建立现场行为验收。

最新原生组件诊断退出 0、7 次真实供应商调用；独立审查判完整闭环 FAIL。首答改写了组合字符，Growth reviewed 但候选、采用和复用均为零；结算仍有 scheduled usage scan。合成 owner 和本地捕获通道不代表真实用户部署。证据在忽略目录 `docs/evidence/rsi-ordinary-native-followup/`；此前 unknown 未重放，历史验证查 Git。
