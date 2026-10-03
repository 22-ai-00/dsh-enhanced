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

**验收真实普通任务驱动的创建→独立验收→动态采用→新任务会话原生发现并复用工具。** Growth 已能读取 owner 核对、过滤并纳入冻结来源的原始已发送答复；旧来源失配拒绝继续，unknown 不重放。最新真实供应商组件诊断确认原已发送答复进入 Growth，并实际完成目标清单与插件文件清单发现；复盘在有限时长内中止为 unknown，尚无候选。可信 Git 基线中的有界插件目标发现已交付；清单只提供线索，后续读取绑定同一基线，不能代替来源授权、源码检查或证明根因。失败反馈的任务优先复盘及完整发送文本的冻结摘要已通过工程检查：仅失败且源码轨可用时优先当前任务需要，证据不足仍可不提案；是否能促成真实候选与收益尚待验收。后续以新的普通任务检验实际候选与复用，初始一次配置后无需逐 Goal arm；记录工具版本、实际调用、质量、成本、延迟及回归，验证纠正/撤回、重启、非目标能力存活与 unknown 不重放。

随后补齐版本替换回退与跨来源窗口的能力延续，验收记忆对真实后续决策的收益；以可安装部署验证两条普通使用通道，通过[发布门](releasing.md)后再发布 npm。

## 最新验证

任务优先复盘与完整执行提示绑定通过限定范围的独立源码复审。主代理 6 项原生请求定向检查、类型检查与零警告 lint 通过；`VITEST_MAX_WORKERS=4 pnpm check` 实际退出 0：8127 项测试通过/61 项跳过、构建和 37 个包 dry-run pack。四个受检文件哈希匹配，Growth 发布清单符合边界；原始日志和退出记录在忽略目录 `docs/evidence/rsi-failure-focused-growth/`。前一全检中 Goals 两轮验收测试失败；原样定向检查、346 项整包测试及本次全检均通过，但原失败原因未确认，失败记录保留。外部跳过测试不证明现场行为。

本机 `assistant` 服务仍运行旧安装。只读核查确认有唯一 active owner；用户 patch 未配置 owner route，profile 未声明 Memory Learning 根依赖，Growth、Control Plane、Verifier 的安装模块与当前构建字节不同。该核查不是有效运行图或普通使用闭环证明，未变更服务、身份或授权；后续需按现有冻结源码维护入口准备更新与 Memory Learning，再完成 owner 配置和部署验收。

最新原生组件诊断使用已推送的 `ad9b921`、全新私有 root 与一次性初始有限授权，实际退出 0、9 次真实供应商调用。原生持久事件记录 `plugin_source_targets` 成功返回同基线的 20 个提示，随后四次 `plugin_source_read(paths: [])` 只取得文件清单，没有读取正文。首任务未达成，认证反馈和 canonical 投影为 not-achieved；最后供应商调用被有限复盘时长中止，Growth 为 unknown，候选、采用与复用均为零。两次结算 runningTasks 0 / pendingTasks 4；旧 root 未续期，本次 unknown 未重放，重启后的行为仍待验收。独立审查判目标/文件清单发现 PASS、完整闭环 FAIL。约 346 秒；前八次调用报告 total token 合计 59918，中止调用未返回 usage，货币费用及同预算收益未知。合成 owner、本地捕获通道和固定任务族不代表真实用户部署。证据在忽略目录 `docs/evidence/rsi-ordinary-source-targets/`，历史验证查 Git。
