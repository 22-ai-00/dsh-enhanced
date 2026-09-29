# Assistant Memory Learning

普通任务驱动的持久事实与经验学习。一次 owner 配置与有限授权后，原生 Automations 发现已完成的普通对话，原生 Agent 提取候选，独立 Verifier 重读来源审查，Personal Memory 在授权范围内采用。后续任务沿 Memory 的动态检索与 System Prompt seam 使用已采用记录。无需逐条调用捕获或批准工具。

兼容当前 DSH `>=0.1.5-rc.3 <0.1.6`、Cordis `^4.0.1` 和本仓库 `0.1.48` 同批 Delivery、Evaluation、Automations、Policy、Verifier、Memory。安装本包不会启用其他 bundle。发布 patch 默认禁用，必须先配置下述 owner/grants 和预算，再启用该稳定行。

```sh
dsh plugin --profile assistant add @dsh-enhanced/assistant-memory-learning
```

## 配置与授权

`Config` 是同步 Standard-Schema；部署值缺失、未知字段、路径或预算不合法时，在打开数据库前拒绝。所有字段必填，只有 `model` 可省略：

| 字段 | 含义与边界 |
| --- | --- |
| `databasePath` | 工作区外的绝对规范路径；父目录当前 UID 私有 `0700`，数据库与 WAL/SHM 为私有 `0600`，拒绝软链与多链接。 |
| `authorityId`, `owner` | 本轮提取授权 ID 和 Delivery 的准确 owner lineage。`owner` 包含 route `authorityId/authorityHash`、`principalId`、`principalRecordId/principalVersion`、`workspace/agentPreset`；提取授权 ID 可以与 route ID 不同。不能由模型或 task text 提供。 |
| `expiresAt`, `maxExtractions` | 有限到期时间戳和授权生命周期内最多 1–10,000 次提取 admission；同一数据库授权配置不可变，失败/unknown 不返还额度，不自动续期。 |
| `maxPending`, `lookbackMs` | 最多 1–1,000 个待处理意图；来源窗口 1 秒至 365 天。背压时不推进游标。事实按 completion 时间发现；经验按后来到达的 objective 时间发现。 |
| `policy` | owner 的学习规则，非空且最多 8 KiB；验收与授权仍由 Host 服务拥有。 |
| `maxInputBytes`, `maxOutputTokens`, `timeoutMs` | 提取输入总字节 4–128 KiB、单轮输出 1–8,192 token、单轮期限 1–300 秒。一个任务最多提取一条候选或明确 noop。 |
| `budgetId/budgetAmount`, `scanBudgetId/scanBudgetAmount` | 原生 Automations 的学习、扫描预算 ID 和每次 reservation（1–10,000,000 整数）。Policy 中须配置有限 `automation-runs` budgets；不启用 unbudgeted execution。 |
| `reviewAuthorityId/reviewAuthorityDigest` | Verifier `memoryReviews` 的准确独立授权 ID 和 `growthObjectDigest(validateMemoryReviewConfig(config))`。 |
| `adoptionAuthorityId/adoptionGrantDigest` | Memory `automaticLearning` 的准确采用授权 ID 和 `growthObjectDigest(validateMemoryLearningAdoptionGrant(grant))`。 |
| `model` | 可选显式 `{provider,model,reasoningEffort?}` 覆盖；省略时继承触发任务已冻结的模型。每项快照持久化供应与完整配置指纹，重启不换模型。 |

先通过 Delivery 当前 route 查询准确 owner；给 Verifier 设置其 `memoryReviews`，给 Memory 设置 `automaticLearning`，再把两份验证后配置的指纹写入本包。采用 grant 可分别限制 kinds、operations、总记录数/字节和 TTL；本包的提取 admission、Verifier 的 review admission 与 Memory 的 mutation quota 是三份独立、不可自动扩大或返还的授权。额度探针只读；不足或指纹不匹配时停止新的付费提取。

Policy 最少需要这些准确 owner/workspace、`initiators: ['background']` 的规则：

- subject `{kind:'background', id:'assistant-memory-learning'}` 对 `memory:learning:<提取 authorityId>` 允许 `extract`。
- 同 subject 对 `memory:learning:<review authorityId>` 允许 `review`，对 `memory:learning:<adoption authorityId>` 允许 `adopt`。
- 同 subject 对本插件受管 automation IDs 允许 `reconcile`；原生 Automation occurrence subject 对这些 IDs 允许 `execute`。完整 Automation subject 和预算配置见 [Automations](../assistant-automations/README.md)。
- 前台 Memory 的 read/search/snapshot 权限继续按 [Memory](../personal-memory/README.md) 配置。

本包不伪造 owner、不签发 grant、不修改 Policy。现有 owner setup 尚未自动组合这三份新 grant；安装配置属于初始配置步骤，不能据此声称现有 production profile 已启用学习。

## 来源、独立审查与恢复

两个持久游标分别读取 Delivery completion feed 和 Evaluation canonical feed。先在同一 SQLite 事务落意图再推进游标；完成元数据先于 reply Outbox 时保留 pending，由原生周期扫描补读。后到的真实 objective、纠正、撤回不会因 completion 已消费而漏掉。Evaluation staging 不持有 Delivery 锁；执行与采用维持 Delivery → Evaluation → Memory 的来源检查顺序。

事实只提取明确 owner 陈述；经验必须绑定当前可信 objective，不能把回复成功当任务成功。严格模型输出只含 mutation/quotation；命名空间、信任、TTL、provenance、authority 不可由候选修改。replace/remove 只指向 Host 提供的准确受管 id/version；人工改写后不能再自动接管。每个模型边界、送审前、采用前都检查来源和 owner。审查 session 与提取 session 独立且都零工具，Verifier 自己读取原始 Inbox/Outbox 与 canonical 结果，Memory 从实际 reviewer 账本查回执后才采用。

提取快照、原生 occurrence、候选请求和原始终态指纹持久化。付费 admission 后失败保留消耗，绝不换 operation ID 自动重跑。未保存 request 证明尚未调用审查/采用：学习意图终结为 failed，释放队列容量；原生 Automation 仍可标记 unknown，表示付费模型调用成本/结果未确认，而非记忆写入发生。已保存请求的 unknown 只用同请求查询原始采用/审查回执；approved 可在当前来源和原授权内完成采用，unknown 不重复审查，过期/撤回/修订后的旧意图停止采用。失败历史保留。

卸载/依赖更换先关闭 admission、移除 executor、取消执行并持久化未结任务，然后等待 drain。关闭有 5 秒上界；超时报告失败并保留未知结果，不能据此宣称外部执行已释放。迟到模型输出不再触发审查或采用。队列由原生 Automations 拥有：本包不增加 timer、AgentLoop 或 Goal 状态机。

## 权限与数据边界

- **文件系统：**私有 SQLite 意图/游标/额度账本及其 WAL/SHM；通过原生 Session 服务持久化提取会话。来源含 owner 任务文字，按敏感私有数据管理；不会写插件源码或任意业务文件。
- **网络与凭据：**通过当前原生 LLM supplier 调用模型，遵守供应商既有凭据配置；不读取/管理 Keychain、不自建 HTTP 客户端，不发送飞书/邮件或其他外部动作。模型会收到有界原始任务、回复、反馈和受管目标摘要。
- **子进程、浏览器、install scripts：**不创建子进程，不访问浏览器，不执行动态 install scripts；提取/审查 Agent 不具有任何工具。
- **授权：**本包不授予目标任务的新权限，Cordis injection/isolation 不构成 OS sandbox；当前 owner、Policy、独立 review 和采用 grant 每步仍须有效。

## 证据边界

包内测试覆盖真实原生 Agent 提取守卫、真实 Automations 调度与预算、真实 Delivery/Evaluation/Memory 的普通来源→采用→后续 System Prompt/检索、纠正/撤回、重启、背压和 lost ACK。模型输出与独立审查语义仍用测试 fixture；这不是线上供应商效果或后续任务质量/成本/延迟收益证明。安装内 owner 配置、新插件自动创建与 Cordis 动态工程采用、实际 owner 部署和普通任务收益仍按 [当前状态](../../docs/rsi-status.md) 继续验收。
