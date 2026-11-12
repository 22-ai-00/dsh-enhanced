# Assistant Memory Learning

普通任务驱动的持久事实与经验学习：前台对话可形成事实与经验；显式开启 `workItemExperiences` 并配置相应有限授权后，后台 WorkItem 的认证主人结果反馈也可形成经验。一次 owner 配置与有限授权后，原生 Automations 发现来源，原生 Agent 提取候选，独立 Verifier 重读来源审查，Personal Memory 在授权范围内采用。后续任务沿 Memory 的动态检索与 System Prompt seam 使用已采用记录。无需逐条调用捕获或批准工具。

验证基线为仓库固定的 DSH `0.2.1-rc.2`、Cordis `4.0.5` 与同批 Delivery、Evaluation、Automations、Policy、Verifier、Memory。安装本包不会启用其他 bundle。发布 patch 默认禁用，必须先配置下述 owner/grants 和预算，再启用该稳定行。

```sh
dsh plugin --profile assistant add @dsh-enhanced/assistant-memory-learning
```

## 配置与授权

`Config` 是同步 Standard-Schema；部署值缺失、未知字段、路径或预算不合法时，在打开数据库前拒绝。除 `model`、`workItemExperiences` 可省略外，所有字段必填：

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
| `workItemExperiences` | 可选严格布尔开关。缺失或 `false` 规范化为缺失，保留原配置指纹；只有 `true` 开启后台结果经验。该值冻结在授权配置中。已有数据库不能扩权或重置 `grant_record`；开启时显式配置新授权及新数据库，保留旧库、历史与已用额度。独立 review/adoption grant 同样必须显式开启此能力，并提供准确新指纹。 |
| `model` | 可选显式 `{provider,model,reasoningEffort?}` 覆盖；省略时继承触发任务已冻结的模型。每项快照持久化供应与完整配置指纹，重启不换模型。 |

先通过 Delivery 当前 route 查询准确 owner；给 Verifier 设置其 `memoryReviews`，给 Memory 设置 `automaticLearning`，再把两份验证后配置的指纹写入本包。采用 grant 可分别限制 kinds、operations、总记录数/字节和 TTL；本包的提取 admission、Verifier 的 review admission 与 Memory 的 mutation quota 是三份独立、不可自动扩大或返还的授权。额度探针只读；不足或指纹不匹配时停止新的付费提取。

Policy 最少需要这些准确 owner/workspace、`initiators: ['background']` 的规则：

- subject `{kind:'background', id:'assistant-memory-learning'}` 对 `memory:learning:<提取 authorityId>` 允许 `extract`。
- 同 subject 对 `memory:learning:<review authorityId>` 允许 `review`，对 `memory:learning:<adoption authorityId>` 允许 `adopt`。
- 同 subject 对本插件受管 automation IDs 允许 `reconcile`；原生 Automation occurrence subject 对这些 IDs 允许 `execute`。完整 Automation subject 和预算配置见 [Automations](../assistant-automations/README.md)。
- 前台 Memory 的 read/search/snapshot 权限继续按 [Memory](../personal-memory/README.md) 配置。

本包不伪造 owner、不签发 grant、不修改 Policy。新 supervised owner 安装会自动组合这三份 grant 与有限预算，再启用默认禁用行，见 [双 Host 配置](../lark-channel/docs/rsi-setup.md#普通任务的自动记忆学习)。Memory 沿用 Personal Assistant 内嵌 provider。已有 owner manifest 不会被重跑安装静默补签。此前前台链路的本机生产启用与新鲜就绪已验收，不覆盖本轮后台经验能力；后续真实任务收益仍需持续验证。

## 来源、独立审查与恢复

前台两个持久游标分别读取 Delivery 的 owner foreground completion feed 和 Evaluation canonical feed；显式开启 `workItemExperiences` 后，第三个 `evaluation-work-items` 游标从零独立读取当前后台 canonical 结果。事实仍只来自真实前台完成记录。后台任务只生成 experience，采用 `work-item:<itemId>` 独立身份；当前 objective 定位先与游标原子保存，报告 reader 临时不可用时保留 pending。后台来源使用 v2 review/source 协议，不伪装 Inbox 或 owner 陈述。Delivery 持有准确来源栅栏，再依次核对 Evaluation 与 WorkItems 来源锁；回调只执行本地检查和账本写入。更正、撤回及窗口过期使旧意图停止采用。先在同一 SQLite 事务落意图再推进游标；完成元数据先于 reply Outbox 时保留 pending，由原生周期扫描补读。后到的真实 objective、纠正、撤回不会因 completion 已消费而漏掉。Evaluation staging 不持有 Delivery 锁；前台执行与采用维持 Delivery → Evaluation → Memory 的来源检查顺序；后台分支为 Delivery → Evaluation → WorkItems → Memory。

后台快照显式区分 `taskBrief`、`workerReport` 和 `ownerFeedback`；前两项是不可信上下文，只有原样 ownerFeedback 可作引文。拒绝截断展示；允许脱敏，但每片展示的 truncated/redacted 标记均冻结进快照和模型输入，禁止推测被遮蔽内容。绑定完整来源和展示摘要；纯脱敏占位符或无字母数字的 ownerFeedback 在付费前拒绝，引文同样须有可见实质文本。supplier 继承原 proofIdentity，显式 `model` 才可覆盖，缺失 effort 保持缺失。后台 replace/remove 只可指向受管 experience。review/adoption peer 必须明确返回 `workItemExperiences: true`、可用状态和准确授权摘要，否则付费提取及 claim 均拒绝，忽略参数的旧 peer 不能满足资格。

事实只提取明确 owner 陈述；经验必须绑定当前可信 objective，不能把回复成功当任务成功。严格模型输出只含 mutation/quotation；命名空间、信任、TTL、provenance、authority 不可由候选修改。replace/remove 只指向 Host 提供的准确受管 id/version；人工改写后不能再自动接管。每个模型边界、送审前、采用前都检查来源和 owner。审查 session 与提取 session 独立且都零工具，Verifier 自己读取原始 Inbox/Outbox 与 canonical 结果，Memory 从实际 reviewer 账本查回执后才采用。

提取快照、原生 occurrence、候选请求和原始终态指纹持久化。付费 admission 后失败保留消耗，绝不换 operation ID 自动重跑。未保存 request 证明尚未调用审查/采用：学习意图终结为 failed，释放队列容量；原生 Automation 仍可标记 unknown，表示付费模型调用成本/结果未确认，而非记忆写入发生。已保存请求的 unknown 先用同请求对账原始采用，再查询原始审查回执；反馈修订、撤回或窗口过期不会丢弃待对账的原操作，也不能据此认定原采用未发生。approved 仅可在当前来源和原授权内完成新采用；过期、撤回或修订后的旧来源禁止新采用，待对账请求仍保留。unknown 不重新提取或重复审查。失败历史保留。

卸载/依赖更换先关闭 admission、移除 executor、取消执行并持久化未结任务，然后等待 drain。关闭有 5 秒上界；超时报告失败并保留未知结果，不能据此宣称外部执行已释放。迟到模型输出不再触发审查或采用。队列由原生 Automations 拥有：本包不增加 timer、AgentLoop 或 Goal 状态机。

提取的原生请求允许 DSH 必需的当前工作目录快照，但会逐字核验它与冻结 owner workspace 一致；额外上下文仍在模型派发前拒绝。这一兼容仅影响新提取，旧失败的付费 operation 不会自动重试。

## 权限与数据边界

- **文件系统：**私有 SQLite 意图/游标/额度账本及其 WAL/SHM；通过原生 Session 服务持久化提取会话。来源含 owner 任务文字，按敏感私有数据管理；不会写插件源码或任意业务文件。
- **网络与凭据：**通过当前原生 LLM supplier 调用模型，遵守供应商既有凭据配置；不读取/管理 Keychain、不自建 HTTP 客户端，不发送飞书/邮件或其他外部动作。模型会收到有界原始任务、回复、反馈和受管目标摘要。
- **子进程、浏览器、install scripts：**不创建子进程，不访问浏览器，不执行动态 install scripts；提取/审查 Agent 不具有任何工具。
- **授权：**本包不授予目标任务的新权限，Cordis injection/isolation 不构成 OS sandbox；当前 owner、Policy、独立 review 和采用 grant 每步仍须有效。

## 证据边界

包内测试覆盖原生 Agent 提取守卫、Automations 调度与有限预算、背压及恢复。本轮后台专项 4 项与选定前台 v1 回归 6 项均通过（EXIT 0）；前台 fixture 模拟来源、提取与审查语义，仅作为回归，不替代后台真实组件组合证据。

后台专项经真实 Delivery owner 输入、WorkItems 报告接受记录和 Evaluation 的 not-achieved canonical，沿原 supplier 的零工具原生提取、独立原生审查 Session 与持久 review 账本，完成实际 Memory 采用。随后通过真实 `/new` 和普通 owner turn，在原生 Agent 的 pre-step 由 Host 调用 `Memory.search` 读回；此项不证明 Agent 自动选择检索工具。真实更正、撤回后，旧经验立即隐藏，并在同进程 Memory、Verifier、learner 卸载重挂后仍隐藏。实际采用后丢 ACK 且回执暂不可读时，已保存的 unknown 经组件重挂继续对账原操作，没有重复提取、审查或重付额度。

`tests/installer-config.integration.spec.ts` 直接使用安装器生成器（lark-channel 的编译产物 `plugins/lark-channel/lib/rsi-memory-learning.js`）产出的三份 grant，注入真实 Delivery/Evaluation/WorkItems/Verifier/Memory 链路；因此该测试依赖仓库先 build 再 test 的顺序（根 `pnpm check` / `pnpm test` 已保证）。单独运行本包测试前先构建 lark-channel：`pnpm --filter @dsh-enhanced/lark-channel run build`。

上述供应商与审查语义使用本地脚本 fixture；冷恢复仅重挂 Memory、Verifier、learner，同进程上游保持运行，不是完整 Host 进程冷启动或 Bot 实连验收。这些证据不证明任意真实模型能力或后续任务质量、成本、延迟收益。原始运行与冻结摘要位于 `docs/evidence/work-item-memory-learning/native/`。此前前台链路的本机 owner 部署与新鲜就绪已验收，不覆盖本轮后台经验的生产部署。普通任务驱动的新插件创建、Cordis 动态工程采用及后续真实任务收益仍按 [当前状态](../../docs/rsi-status.md) 继续验收。


扫描器在启动、原生派发及来源复核前先检查 Automations 的持久退休标记与 Delivery 的当前 owner 状态。仅准确 owner 被持久撤销时，以原定义摘要及版本退休自身扫描 cron；旧任务、unknown、请求、grant 与已用预算原样保留，不再做旧来源失效或自动回退扫描。退休标记跨重启和身份切回保留，相同扫描 ID 不会自动复活。新 owner 必须使用显式配置的新代次，不能转移旧授权。

缺失 binding、临时数据库/连接故障不触发永久退休；扫描器保留原生 executor、事件或 cron 恢复入口。退休查询暂不可用时，仅尝试由 Automations 的事务与数据库退休栅栏准入原扫描 cron；明确退休、明确撤销或退休被 Policy 拒绝时不激活。若注册也暂时失败，未完成初始化的实例由现有原生 scheduler wake 重试初始化；成功后只沿原 cron 和预算扫描，不增加业务扫描频率。恢复初始化不派发业务工作或消耗新的学习 admission。Policy 拒绝退休时同样阻止新工作，并报告失败；不把拒绝当退休成功。卸载仍独立取消及有界等待本扫描器拥有的执行，不关闭普通聊天或整个插件。
