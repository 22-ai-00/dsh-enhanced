# @dsh-enhanced/assistant-evaluation

个人助理的可信自评测账本。它把一次任务的三个事实分开记录：执行是否正常、目标是否达成、结果是否送达；不会再把“Agent loop 正常结束”误当成“用户目标已经完成”。

插件提供本地、追加式 SQLite service，以及两个严格限权的模型工具：`evaluation_review` 读取当前 Agent 精确 scope 的有界结果，`evaluation_self_assess` 只能给既有、objective 未知的结果追加一条 `self-reported` 目标判断。可信事实仍只能通过 Host service `assistantEvaluation.append()` 写入，模型不能创建或升级 `trusted` 记录。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-evaluation
dsh --profile web --dump-config
```

默认数据库位于 `$DSH_HOME/assistant-evaluation/evaluation.sqlite`。

## 数据模型

`OutcomeEnvelope` 必须包含：

- 精确作用域 `scope.workspace + scope.preset` 和稳定 `situation`；
- 相互独立的 `executionStatus`、`objectiveStatus`、`deliveryStatus`；
- Host producer 的 `source`、证据等级 `trust`；
- 仅含引用的 `evidence`，不复制原始对话或产物；
- 有界 JSON `metrics`，标准整数键为 `costUsdMicros`、`latencyMs`、`inputTokens`、`outputTokens`、`toolCalls`、`retries`；
- `occurredAt`、`idempotencyKey` 和为判断逻辑定版的 `evaluator.id/version`。

公开 service 接口是：

```ts
ctx.assistantEvaluation.append(outcome)
ctx.assistantEvaluation.appendSelfAssessment({ outcomeId, scope, objectiveStatus, evidence, occurredAt, idempotencyKey, evaluator })
ctx.assistantEvaluation.query({ scope, situation, limit: 20 })
ctx.assistantEvaluation.summary({ scope, fromOccurredAt, toOccurredAt })
ctx.assistantEvaluation.health()
ctx.assistantEvaluation.limits()
```

`append()` 是给 Automations、Delivery、断言执行器等 Host 插件的组合 seam。调用方负责依据真实来源设置 `trust`：模型生成的判断只能标为 `self-reported`，签名用户反馈或 Host 可验证回执才可进入 `trusted`。相同 `idempotencyKey` 的完全相同输入安全重放；内容变化会以 `idempotency-conflict` 失败关闭。

第一版要求 producer 对一个执行单元只追加一条 terminal envelope，并在该条记录上给出当时已知的三种状态。若目标或投递状态之后才到达，不能再把更新伪装成第二个任务结果，否则汇总会重复计数；后续版本将用 linked assessment/latest projection 表达这类晚到证据。

`appendSelfAssessment()` 要求既有 `outcomeId` 和相同 scope；账本继承原记录的 execution/delivery 状态，只追加 objective 判断与 evidence refs，并强制保存在独立的 `self-reported` assessment 表。它不会增加任务总数或升级原 outcome 的 trust。模型侧的 `evaluation_self_assess` 进一步固定 scope、时间、幂等键和 evaluator，只允许选择目标状态并引用最多 10 个实际检索到的 Memory id。

`query()` 永远要求精确 scope，并对条数、字符串、时间和枚举做边界校验。`summary()` 只接受不超过 `maxSummaryWindowMs` 的窗口。`evaluation_review` 从当前 live Agent 派生 scope，只返回有界摘要、脱敏结果和经过 first-party provenance + 格式校验的 Automation run id；不返回 workspace、source id 或任意 evidence ref。默认自动 review 会排除 `automation:heartbeat:*`，避免维护任务递归自评并饿死真实任务；显式 situation 查询仍可审计它们。内置 self-evaluation skill 要求先精确读取 run，再通过 `memory_search_confirmed` 检索非敏感 owner-confirmed Memory，证据不足时保持 `unknown`。

## 配置

| 键 | 默认值 | 说明 |
|---|---:|---|
| `databasePath` | DSH patch 设置 | 绝对 SQLite 路径；测试可用 `:memory:`。 |
| `maxQueryLimit` | `100` | Host 单次查询硬上限，最大可配置为 500。 |
| `maxReviewOutcomes` | `20` | 模型单次 review 最近结果上限，最大 50。 |
| `maxSituationBytes` | `200` | situation 的 UTF-8 字节上限；200 是 producer 互操作下限，只能上调。 |
| `maxMetricsBytes` | `4096` | canonical metrics JSON 字节上限；256 是 durable producer 互操作下限，只能上调。 |
| `maxEvidenceRefs` | `32` | 每条 outcome 的证据引用数上限。 |
| `defaultSummaryWindowMs` | 30 天 | 未指定起点时的默认汇总窗口。 |
| `maxSummaryWindowMs` | 365 天 | 单次汇总允许的最大窗口。 |

## 权限与数据边界

- **文件系统：** 创建数据库父目录并写入本地 SQLite；新数据库目录使用 `0700`、数据库使用 `0600`。现有数据库若为符号链接、硬链接、非当前用户所有或对 group/other 开放，会拒绝启动。数据库启用 WAL、`synchronous=FULL`、迁移版本检查和 5 秒 busy timeout。
- **网络：** 无。
- **子进程：** 无。
- **凭据：** 无。
- **浏览器：** 无。
- **install script：** 无；仅有标准 TypeScript build/prepack 和仓库发布保护脚本。

scope、situation、producer/evaluator id、证据引用和指标属于本地评测元数据，可能仍有隐私含义；调用方不应把原始 prompt、secret、消息正文或绝对产物路径放入这些字段。

## 限制

- 账本保存“谁以什么证据做了什么判断”，并不把模型自评提升为 ground truth。
- 自评可以辅助判断 objective，但永远保持 `self-reported`；插件不自动修改 Memory、Evolution、Automation、代码或权限。
- scope 路径做绝对路径的语法规范化，不主动访问文件系统解析符号链接。
- 当前面向单机个人助理，SQLite 依赖仓库兼容基线规定的 Node.js 版本。

## 兼容性

对齐仓库的 [DSH / Cordis 兼容性基线](../../docs/compatibility.md)。Host 提供 Cordis、Agent 和 ToolRuntime；插件自身携带 Schemastery。
