# @dsh-enhanced/assistant-dreaming

默认关闭、owner 显式启用的"做梦/突发奇想"插件。启用后它以低频率、确定性随机、
空闲感知的方式回顾**已认证的历史投影**（可信任务投影、owner 目标、活动技能的
有界摘要），在随机时刻让一个冻结的单工具 Agent 产生少量结构化 idea，并只写入
插件私有的 SQLite 账本。

它**不是**成长复盘：输入是跨任务的模式与空白，输出是未验证假设。默认级别 L0
（仅私有 idea），不通知、不开 Goal/WorkItem、不形成候选、不自动采用；模型输出
schema 不允许任何评分/置信度/自收益字段，沉默不算正向。

## 信任边界与权限

- 注入：`assistantAutomations`、`assistantPolicy`、`assistantDelivery`、
  `assistantEvaluation`、`assistantGoals`、`assistantSkills`、`agents`、`sessions`、
  `tools`、`llm`。
- 不读 Memory、不读原始 transcript/工具参数/验收回执、不读凭据；所有输入是 Host
  投影后的有界摘要，每条带证据摘要，idea 必须引用本 wake 材料内的证据 digest。
- 工具面冻结为恰好一个 `dream_submit_ideas`；其余全局工具在 Agent setup 中
  `restrict` 拒绝，并做精确 allowlist 断言。
- 每次 wake 经 `assistantPolicy.reserve` 做幂等预算预留；模型/工具调用次数、输出
  token、时长、输入字节、每日次数都有硬顶。
- 随机性是 `HMAC(seedDigest, lane+occurrence)` 的确定性抽签，可审计可重放，从不
  调用 `Math.random`。

## 配置（全部默认关；未知字段拒绝）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 关闭时不注册 automation、不打开数据库、零写入。 |
| `scope` | 无 | `workspace/preset/principalId/ownerRouteId`；启用时必填。 |
| `databasePath` | 无 | 私有 SQLite 绝对规范路径；启用时必填，目录不可组/全局可写。 |
| `baseIntervalMs` | `3600000` | 抽签节拍（15 分钟–24 小时），复用原生 Automations `every`。 |
| `runProbabilityPpm` | `250000` | 每节拍抽中率（0–1,000,000）。 |
| `idleMinMs` | `1800000` | 距最近可信活动至少 30 分钟才触发；缺活动标记 fail-closed。 |
| `activeHours` | 无 | 同日窗口 `timezone/startMinute/endMinute`，不跨午夜。 |
| `randomSeed` | 无 | 可选 HMAC seed；只持久化其 digest。 |
| `maxDreamsPerDay` | `3` | 每日做梦次数硬顶（1–24）。 |
| `maxIdeasPerWake` | `3` | 每次 wake 最多 idea 数（1–5）。 |
| `maxModelCalls` / `maxToolCalls` / `maxOutputTokens` / `maxDurationMs` | `2/1/2048/90000` | 单轮冻结上限。 |
| `maxInputBytes` / `maxEvidenceRefs` | `16384/8` | 输入材料上限。 |
| `notifyOwner` | `false` | S0/S1 始终为 false；L1 通知在后续切片实现。 |
| `budgetId` / `budgetAmount` | 无 | 必须成对；启用时必填。 |
| `provider` / `model` | 无 | 供应商中立通用字段，必须成对；`reasoningEffort` 可选。 |
| `apiKeyEnv` | 无 | 只允许环境变量引用名，不存密钥。 |
| `retentionDays` | `90` | idea 保留期，过期硬删除。 |

启用时 fail-closed 校验：scope、规范绝对 `databasePath`、provider/model 对、
budget 对、`maxNotificationsPerDay <= maxDreamsPerDay`、activeHours 同日窗口；
任何一项不满足直接拒绝装配。

## 账本

`dream_runs`（每次抽签/运行与 drawDigest）、`dream_ideas`（含状态机
`recorded → owner-acknowledged → validated/rejected` 或 `withdrawn`，同 lane 同日
同摘要去重）、`dream_idea_events`、`dream_counters`（每日做梦/通知计数）。
`PRAGMA user_version=1`，schema 变新即拒绝启动。

## 不做的事

- 不发通知（L1 后续切片）、不读 Memory（S4）、不读 web、不调用任何写工具或
  Goal/WorkItem 候选 API。
- 不评分、不排序、不把工具成功或 owner 沉默当作收益证据；任何"采用"只认后续真实
  owner 动作或独立验收轨道。
- 不新建循环或定时器：调度完全走 `assistant-automations`，`misfire: skip`、
  `overlap: skip`、`retrySafety: never`、`maxRetries: 0`，重启后 running 仅转
  `interrupted`，不自动重放。

## 测试

`pnpm --filter @dsh-enhanced/assistant-dreaming test`：config fail-closed、
确定性抽签/active-hours/idle/日上限门、SQLite 账本/状态机/保留期/ownData 防护。
完整真实模型长跑与真实通知留待后续切片独立验收。
