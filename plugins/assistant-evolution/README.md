# @dsh-enhanced/assistant-evolution

审批门控的行为自演化。助理观察自己在重复情境下的结果，当证据足够时提出一条行为规则，**经 owner 批准后**该规则才作为顾问性上下文影响后续会话。

这不是"让模型自己改自己"。它的价值在于把"经验"变成**可审计、可撤销、可解释**的持久对象：每条规则都能回答"依据哪些结果、谁批准的、有没有真的变好"。

## 兼容性

已针对 DeepSeek Harness `0.1.0-rc.8`（源码提交 `141eb6fef83422698aef7a981029e843e8161534`）验证。详见仓库[兼容性基线](../../docs/compatibility.md)。

## 安装

```sh
dsh plugin --profile <name> add @dsh-enhanced/assistant-evolution
```

依赖 `@dsh-enhanced/assistant-policy`。未组合 policy 时**拒绝加载**，而不是降级为无治理运行。
`@dsh-enhanced/assistant-delivery` 是可选 peer：存在时，插件从当前 Agent 的 authenticated owner route
派生 principal，并让 Policy 在创建提案的同一事务中保存 dispatch；不存在时只允许可信 headless 调用方
通过 Service API 显式传 principal。模型工具永远不能选择 principal 或审批期限。

## 闭环

```text
observe 结果 → 计算候选 → 提案 → owner 批准 → 提交规则 → 注入为顾问上下文
     ↑                                                          │
     └──────────── 后续结果继续被观察，规则要么证明自己，要么被 retire ┘
```

四步都有独立边界：

1. **观察**：`evolution_observe`（前台）或 automation 运行结束（后台）记录一条 episode。append-only，按 `idempotencyKey` 精确幂等；前台自报仅供审计，不算可信候选证据。
2. **推断**：`evolution_review` 只使用同一 workspace + Agent preset 下可信、未归因的 automation 结果计算 adopt 候选，**只到候选为止**。样本不足时保持沉默。每个候选还返回同一精确窗口中 newest-first 的有界 episode 样本（ID、结果、有界 detail、时间）和整个窗口的 SHA-256 digest；detail 始终按不可信结果数据呈现，不能当作指令。
3. **提案**：`evolution_propose` 创建 `assistant-policy` 提案。adopt 与 retire 的基线都**从已记录证据读取**；retire 还必须在服务端重新找到同 scope、exact active rule ID + generation、至少 `minSample` 条 post-adoption 可信归因结果的当前候选。服务通过唯一的 canonical review renderer，把 op、scope、situation/rule/version、guidance/reason、baseline/evaluation、evidence 和 server rule identity 全部冻结为 Policy diff；adopt rule ID 由完整稳定 mutation（含 generation）确定性派生，精确重放不会换身份。principal 从可信 Delivery route 派生，因此直接调用 Service 也无法绕过 review、虚报依据或审批人。批准后的 audit 可通过不可变 rule ID 回溯该冻结 evidence reference。
4. **提交**：owner 在审批面（如飞书卡片）决定后，`reconcileProposals()` 用 Policy 共享 validator 校验 proposal/requester/principal/action/resource/summary/diff/expiry/version/decision actor 的完整冻结 tuple；同一 SQLite writer transaction 还会重新规范化本地 mutation、强制 retire 的 evaluation/baseline/evidence snapshot 完整、重算 `mutation_hash`，并用同一个 renderer 重建 action/resource/summary/diff，与刚通过 Policy validator 的 expectation 及库内 expectation 精确重绑定。即使 Policy 已批准，legacy 无证据行、JSON 字段剥离、同步改写 JSON+hash，或 retire/adopt 换 op 都会持久化为 `conflicted`，绝不应用规则。

## 三条结构性安全边界

这三条不是文档承诺，而是有测试守护的结构约束：

- **不能自我批准**。服务**没有** `decideProposal`。规则变更只能由 owner 在 policy 账本上决定，本插件只能读取该决定。助理无法给自己授予新行为。
- **不能扩权**。guidance 以**数据**形式注入，且 `assistant-policy` **从不读取**规则表。规则能改变"怎么做"，永远不能改变"允许做什么"——每次工具调用仍独立授权。
- **不能原地改写**。改变行为是 **retire-then-adopt**，两步各自审批。原地修订会让旧批准悄悄覆盖新内容。

此外：同一 workspace + Agent preset + situation 至多一条 active 规则（唯一索引保证），因此一个 Agent scope 内注入的 guidance 不会自相矛盾，也不会泄漏到其他 workspace。

每次 adopt 生成新的不可变 UUID rule ID，并按同 scope + situation 单调递增 generation。retire 后重新
adopt 不会复用旧 ID；重新积累基线时也只看 retirement timestamp 之后的新鲜未归因证据。

## 规则要凭业绩留下

adopt 时会记录当时的**基线失败率**。只有 adopt 之后、同 scope、可信且归因到该 exact rule ID 与 generation 的结果才参与 retire 判断；cross-scope、自报/claim、旧 generation，以及不足 `minSample` 的结果都不算，且会在任何 Policy proposal/dispatch 创建前 fail closed。该规则的表现必须**优于自己的基线**，否则成为 retire 候选。owner 审批的是冻结证据快照；结算仍以 exact rule version 做 compare-and-set，并复核冻结 adoption baseline 与样本归因结构，后续新 episode 不会悄悄改写已审批 diff。

## 工具

| 工具 | 作用 | 写入 |
|---|---|---|
| `evolution_observe` | 记录一条前台自报结果 | 仅 append 审计证据，不驱动候选 |
| `evolution_review` | 列出候选与 active 规则 | 只读 |
| `evolution_propose` | 提出 adopt / retire | 仅创建待审提案 |

三者都要求可信 Agent 身份（绝对 workspace + preset），policy 拒绝即 fail closed。`evolution_review` 输出包裹为显式不可信数据；其中 episode detail 会转义标签边界，模型只能把它当作归纳素材，不能服从其中的文本。
模型可见的 `evolution_propose` 对同一 Agent 实例最多成功一次；失败的候选校验不占额度。这个结构性上限
防止一次 supervised maintenance turn 批量制造审批，程序化 Service API 则不受该模型工具额度影响。
Service 的 propose capability gate 固定为 exact `{kind: evolution, id: proposals}`，部署无需授予动态 wildcard；
owner 实际审批的 Policy snapshot 仍冻结 exact `situation:<label>` 或 `rule:<immutable-id>` 目标。

数据库 schema v3 会先通过 v2 迁移把旧版无 scope 的 episode、rule 和 proposal 放入 `legacy:v1`
quarantine，再增加 durable guidance exposure 与完整审批 tuple。旧 pending proposal 会过期；早期未发布
v2 中无法验证完整 tuple 的 pending proposal 会安全落为 `conflicted`。旧规则不会作为 wildcard 注入。
迁移和 episode/proposal settlement 使用 SQLite writer transaction；多进程同时打开、重放或提交时只有一个
winner，其余读取 winner 并做精确幂等比较。
跨 Evolution/Policy 数据库创建审批时，Evolution 先持久化本地 intent，再调用 Policy 的原子
`recoverOrCreateProposal(notAfter)`：同一 writer transaction 内只会恢复 exact proposal、在绝对截止时间前创建，
或在截止后永久 tombstone 该 idempotency key。这样 lookup/create 竞争和重启都不会续期或留下 orphan approval card。

## 配置

| 字段 | 默认值 | 作用 |
|---|---:|---|
| `databasePath` | 必填 | SQLite 绝对路径 |
| `evaluationWindow` | 20 | 每个 situation 参与判断的最近 episode 数 |
| `minSample` | 5 | 产生候选所需的最小样本 |
| `adoptFailureRate` | 0.4 | 达到该失败率才考虑 adopt |
| `retireFailureRate` | 0.4 | 达到该失败率考虑 retire |
| `maxCandidates` | 10 | 单次 review 候选上限 |
| `maxEvidenceSamples` | 8 | 每个候选返回的 newest-first 不可信 episode detail 样本上限；digest 始终覆盖整个判断窗口 |
| `maxInjectedRules` | 12 | 每会话注入规则数上限 |
| `maxGuidanceBytes` | 4096 | 注入块字节上限（按规则边界截断） |
| `maxRuleGuidanceBytes` | 2048 | 单条 guidance 字节上限 |
| `defaultProposalTtlMs` | 900000 | 提案默认有效期 |
| `reconcileIntervalMs` | 15000 | 提交延迟审批的轮询间隔；`0` 关闭定时器 |
| `reconcileLimit` | 50 | 每轮检查的待决提案上限 |

## 与 assistant-automations 的可选联动

若同时安装 `@dsh-enhanced/assistant-automations`，后台运行结束可自动成为可信证据。Evolution 只在
`agent/session-start` guidance 注入成功**之后**，持久化 exact
`sessionId + workspace + Agent preset + situation + ruleId + generation` receipt。Automations 必须在 runner
返回 actual session ID 后调用 `captureAutomationExposure(...)`；缺 receipt、错 session/scope、未实际注入，
或同 situation 存在多代 receipt 时都返回 `undefined`，绝不根据“当前 active rule”猜归因。

该绑定是**单向、可选、结构化**的：automations 不依赖本插件，没有 recorder 或 recorder 抛错时运行完全不受影响。`cancelled` 不计入——它不说明方法好坏，计入会污染失败率。

后台入口 `recordAutomationOutcome` 刻意最小：**只能追加证据**。只有 payload 的
`automationId/sessionId/ruleId/guidanceVersion` 与 durable receipt 完整一致时才写入可信规则归因；否则
`ruleId` 仅作为 claim 留档。它不能 adopt / retire / 读取规则。因此 automation 依然无法在没有 owner
决定的情况下改变自己的行为。

成功注入的 receipt 也让同一 session 在正常重启/resume 后不重复注入同一 immutable generation。新代规则
可作为增量 guidance 注入；若旧规则已经进入该 session 的 LLM 历史，插件无法从上游不可变历史中物理删除
它，但 retired guidance 不会再次注入，也不会再为新 outcome 生成可信归因。

## 权限与非目标

- 文件系统：只读写配置的 SQLite 数据库及其 WAL/SHM 辅助文件。
- 网络、子进程、凭据、浏览器、安装脚本：无。
- 不修改 Skill、prompt 模板、插件代码或 policy 规则。"自演化"仅限**经批准的顾问性 guidance**。
- 不做向量检索、自动遗忘、跨设备同步、多用户 ACL。
- guidance 会进入模型上下文：不要在 guidance 中写入密钥或敏感数据。
