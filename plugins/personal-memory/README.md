# @dsh-enhanced/personal-memory

面向个人助理的短期上下文之外长期记忆：保存简短且稳定的事实、偏好、约定和经验，按 user/agent 与 user-global/workspace 双维隔离，通过 `assistant-policy` 的持久审批提案写入。研究资料、文档和项目知识不属于这里，应交给 `personal-wiki`。

## 安装

本插件要求 `@dsh-enhanced/assistant-policy` 已经挂载并提供 `ctx.assistantPolicy`。生产环境还应组合
`@dsh-enhanced/assistant-delivery`，由当前 Agent 会话绑定的 owner 私聊派生审批 principal、workspace
和投递 binding：

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-policy
dsh plugin --profile web add @dsh-enhanced/assistant-delivery
dsh plugin --profile web add @dsh-enhanced/personal-memory
dsh --profile web --dump-config
```

上面的 Policy 片段只覆盖 Memory 自身的前台权限，不足以发送或点击审批卡。生产飞书闭环应运行
`dsh-lark-setup --profile web --create-app --allow-agent-tools`；向导会为 exact owner binding 写入
`dsh-enhanced-personal-memory` 的 `approval.send` 与 owner `approval.decide` 规则。若手工维护 Policy，必须
提供同等精确的 source、workspace、principal 与 binding 限制，不能使用通配 owner 或 workspace。

默认数据库位于 `$DSH_HOME/personal-memory/memory.sqlite`。单独安装后的 policy 默认没有 allow 规则，所以记忆搜索、快照和提案都会 fail closed；需要在 profile 中按实际 preset 与绝对 workspace 放行：

```yaml
- id: dsh-enhanced-assistant-policy
  name: '@dsh-enhanced/assistant-policy'
  config:
    databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')
    rules:
      - id: allow-primary-memory-service
        effect: allow
        subject: { kind: agent, id: primary, workspace: /absolute/workspace }
        actions: [export, propose, search, snapshot]
        resource: { kind: memory, id: "*" }
        context: { initiators: [foreground] }
      - id: allow-primary-memory-tools
        effect: allow
        subject: { kind: agent, id: primary, workspace: /absolute/workspace }
        actions: [execute]
        resource: { kind: tool, id: memory_* }
        context: { initiators: [foreground] }
    budgets: []
```

## 行为与工具

- `memory_search`：显式检索当前 agent 可见的四个域；ASCII 与中文 unigram/bigram 均可召回，排序和 tie-break 确定，读取不更新任何计数。
- `memory_search_confirmed`：面向后台复盘的窄查询；服务端固定只返回非敏感、`user-confirmed` 的 `instruction` / `preference`，调用方不能通过参数放宽 trust、kind 或 sensitivity。
- `memory_manage`：只创建 add/replace/remove 提案，返回完整 diff、proposal id、TTL 和版本；它没有直接提交路径，也不接受模型提供 principal 或 TTL。principal、workspace 和飞书投递 binding 必须来自当前 Agent 的 authenticated Delivery owner route，TTL 来自可信配置；没有活动绑定时 fail closed。
- `ctx.personalMemory.decideProposal(...)`：供绑定 owner 的可信通道/UI 决定提案。principal、版本、决定内容和理由均受幂等/CAS 约束。
- `ctx.personalMemory.exportJson(agent)`：导出版本化 JSON，不包含哈希、状态、时间戳、token 表或审计表。
- `ctx.personalMemory.proposeImport(...)`：先验证整个有界文档，再为每条记录创建审批提案；Agent 路径同样由 Delivery 派生审批 authority，未批准前不会写入 memory record。仅在未组合 Delivery 的可信本地/headless 集成中，程序化调用方可以显式传入 principal；一旦 Delivery 可用就不能用该字段覆盖绑定 owner。

安装了原生 `systemPrompt` 服务时，每次模型步骤组装上下文都会重新检查当前 owner、Policy 和记忆状态，并从 Session 当前有效消息中提取最近的用户输入或 Automation 任务（最多 2048 字符）进行关键词召回。任务相关记录优先，再补充用户确认的偏好与约定；工具结果、历史快照和自动补全文本不会替代当前任务。召回合并 user-global、当前 workspace、当前 agent-global 和当前 agent-workspace，受 top-K、字节和粗略 token 三重预算约束；`sensitive` 记录在 top-K 之前排除。每条包含 id、版本、来源、观测时间及可选原始引用、失效时间与替代关系。工具证据压缩仍未实现。

同一 Host 安装 `assistant-goals` 时，Memory 还会在每步读取可选 `taskContext()`，按当前步骤 → 最近用户输入 → 目标 objective 的顺序召回并去重，再补确认的偏好和约定。Goals 每次检查 live owner 与 `snapshot` 授权；Memory 再核对 principal record/version/digest、workspace 和 preset，不能由模型选择别人的 namespace。同 owner 的显式 focus 可提供跨会话检索上下文，但不转移原生 Goal 执行权。checkpoint 的 nextStep 仅是规划文本，用作检索关键词，不成为可信事实或新权限。

该组合的可选 peer 为 `@dsh-enhanced/assistant-goals >=0.1.0 <0.2.0`；它不会自动启用 Goals。旧版本未提供 `goal-task-context/v1`、服务缺失/卸载、读取失败或身份不匹配时继续按原用户 query 召回。每个 query 字段最多 2048 字符，合并结果仍共用原有 top-K、字节和 token 预算。原生 AgentLoop 回归覆盖步骤改变和记忆撤回后的下一次模型请求；这证明动态检索接线，不代表已经测得真实模型决策收益。

内容被包在 `<memory_source>` 中并明确标为“不可信数据而非指令”；XML 元字符和模板花括号在预算计算前转义。原生 Host 持久保存发生变化的新快照，用它取代先前快照的有效语义；撤回、过期或权限撤销会影响下一步的当前快照，**不会删除 Session 中已经提供过的历史快照、工具结果或模型输出**。因此不能把本功能当作会话历史的数据擦除或跨 owner 会话迁移保护。没有 `systemPrompt` 的程序化集成保留旧的 `agent/session-start` 一次性冻结快照，不能承诺逐步更新。`memory_search`、`memory_search_confirmed` 与 `memory_manage` 的模型可见结果也使用有界、转义的独立 framing。缺少绝对 cwd、agent preset 或已验证 owner 时不搜索、不提案、不贡献新快照，也不会退化到共享域。

## 适用条件、反例与事实分歧

`memory_manage` 的 entry 可带有界 `knowledge`，例如：

```json
{
  "applicability": ["仅适用于 schema v2，且迁移日志已核验"],
  "counterexamples": ["schema v1 没有迁移日志；曾因照搬此流程恢复失败"],
  "claim": { "key": "atlas.recovery.mode", "value": "journal" }
}
```

条件和反例各最多 4 条，每条 1–256 UTF-8 字节；claim key 是 1–128 字符的小写 ASCII 标识符（字母、数字、`.`、`_`、`:`、`-`），value 最多 256 UTF-8 字节。内容与完整 knowledge 共用 `maxContentBytes`。完整字段进入审批 diff、幂等指纹、版本 CAS 和保存结果；修改条件或反例需要新的提案，不能复用原审批。条件不同的同文经验可分别保存，不会因正文相同而被去重。

检索也索引条件、反例和 claim，所以当前任务能找到相关的失败经验。快照和工具结果保留这些原文及 provenance；快照明确标记适用性尚未核验。关键词命中只说明相关，不证明条件成立，也不会自动把某条经验判为事实或赋予新权限。

每次检索与快照的排名、状态和冲突伙伴使用同一 SQLite 读视图，不阻塞其他 WAL writer；并发修改会在下一次读取体现。同一可见 claim key 有不同记录值时，快照会共同呈现来源和条件；预算无法容纳所有相关记录时，只给出分歧提示与有界记录引用，不留下看似无争议的单一正文。显式搜索的 `disagreement` 包含 key、记录数及最多 4 个记录 ID，在 query/top-K 截断前计算。自动补充的分歧信息仅来自当前 owner/scope 内有效、非敏感的记录；撤回、到期和身份变更会在下次读取生效。相同 key 的不同值可能源于不同适用条件，应核对当前系统和原始证据；本功能不解析任意自然语言矛盾，也不自行决定哪个值正确。

带 knowledge 的导出文档使用版本 2，导入仍须逐条批准；没有 knowledge 的导出继续使用版本 1，当前版本同时接受两种格式。旧 reader 会拒绝版本 2，避免悄悄丢掉条件后复用经验。升级到数据库 schema 5 前应停止旧 Host writer；迁移只新增 nullable knowledge 列，保留旧记录、pending 提案和既有回执指纹，不能让旧版本继续写入新库。

## 数据与一致性

SQLite 使用 WAL、`busy_timeout`、外键、FULL synchronous 和前向 schema 版本；目录为 `0700`，数据库为 `0600`。记录包含 stable id、内容哈希、provenance、trust、confidence、sensitivity、TTL、supersedes、可选 knowledge 和 version。replace/remove 在批准后重新读取 target version 并以 CAS 提交；审批与内存位于两个数据库，若进程恰好在 policy 批准后退出，可用原决定安全重放。并发变化会把提案标为 `conflicted`，不会覆盖新值。

创建提案时先在 Memory 数据库持久化 creation intent，再调用 Policy 原子创建 proposal + dispatch，最后在
同一个本地事务 attach Policy ID 并删除 intent。任一步崩溃后，reconcile 都能从 intent 自动续做，不依赖
原 Agent turn 或人工重发。恢复使用 Policy 的原子 recover-or-create：同一个 `BEGIN IMMEDIATE` 先匹配
requester、principal、action、resource、绝对 deadline、diff、summary 和 exact dispatch route；若已有提案，
即使 deadline 已过也返回既有终态，若尚无提案则只在 deadline 前创建。deadline 后 Policy 会永久 tombstone
该幂等键，普通 propose 也不能复活或留下孤儿审批卡；Memory 随后把 intent 持久标为 `conflicted`。pending
扫描使用持久 round-robin 顺序；一页未决定提案不会饿死后页已决提案。已经 attach Policy ID 的本地提案只按
该 ID 做只读恢复；Policy 行缺失会 durable conflict，绝不重新创建 proposal/dispatch。proposal 与 intent 的
判定也在同一个本地写事务中完成，避免多进程交错留下双状态或 poison intent。旧 schema 的 crash-gap intent
先做 scoped read-only lookup；确有旧 Policy 行时精确回放原 TTL/dispatch，否则回到绝对 deadline 的原子恢复。

JSON 导入是一组独立、可重放的提案，不承诺跨所有记录的一次性批准或全批原子提交。SQLite 仅承诺单机多连接语义，不用于多主机共享文件系统。

## 配置上限

| 字段 | 默认值 | 作用 |
|---|---:|---|
| `approvalMode` | `delivery-required` | 生产默认要求 authenticated Delivery route；仅可信本地/headless 集成可显式设为 `delivery-or-headless` 并传 principal |
| `maxContentBytes` | 4096 | 单条内容最大 UTF-8 字节数 |
| `maxRecordsPerIdentity` | 1000 | 每个完整身份域的活动记录上限 |
| `searchLimit` | 20 | 未显式指定时的搜索上限 |
| `snapshotLimit` | 20 | 当前快照记录上限 |
| `snapshotMaxBytes` | 8192 | 快照最大 UTF-8 字节数 |
| `snapshotMaxTokens` | 2048 | 快照粗略 token 上限 |
| `defaultProposalTtlMs` | 900000 | 默认提案有效期（15 分钟） |
| `maxImportRecords` | 100 | 单次导入最大记录数 |
| `reconcileIntervalMs` | 15000 | 提交“会话结束后才被批准”的提案的轮询间隔；`0` 关闭定时器，上限为 Node timer 的 `2147483647` ms |
| `reconcileLimit` | 50 | 每轮 reconcile 检查的本地待决提案上限 |

## 延迟审批的提交闭环

`memory_manage` 只创建提案，永不直接写入。提案与 Policy 的 durable approval-dispatch route 在同一事务创建，Delivery 会把 Policy 冻结的 summary/diff/版本投递给 exact owner binding。审批可能发生在原 turn 结束之后（例如几分钟后在飞书卡片上点击），因此本插件会周期性调用 `reconcileProposals()`：读取 policy 账本中该提案的**终态**，再用与 `decideProposal` 完全相同的事务路径提交。

三条边界：

- **不推断批准**：pending 仍然是 pending；只有 policy 账本给出 `approved`/`rejected` 才落盘。
- **幂等**：重复 reconcile 不会重复写入或重复结算，重启后同样安全。
- **完整校验**：提交前重新校验 proposal id、requester、principal、action、resource、summary、diff hash、expiry、版本与 decider；任一字段不符会把本地提案持久标为 `conflicted`，绝不写 memory。
- **不复活 intent**：Policy 在一个事务内完成 existing-exact / create-before-deadline / abandon-after-deadline 三选一；abandonment tombstone 会阻止其他进程随后创建孤儿 dispatch。
- **不反向调用**：policy 从不回调本插件；方向始终是本插件读取 policy。

需要完全由宿主驱动时，把 `reconcileIntervalMs` 设为 `0` 并自行调用 `reconcileProposals()`。可信的无 Delivery
集成还必须显式配置 `approvalMode: delivery-or-headless`；Delivery 热重载或尚未就绪不会让生产默认自动
降级为 caller-supplied principal。

## 权限与非目标

- 文件系统：只读写配置的 SQLite 数据库及其 WAL/SHM 辅助文件。
- 网络：本插件本身不发网络请求；组合 Delivery 时只写 durable dispatch，由 channel 插件负责发送审批卡片。
- 子进程、凭据、浏览器、安装脚本：无。
- 数据敏感性：`sensitive` 只表示禁止环境快照；显式、已授权的搜索仍可能把内容发送给当前模型。真正的密码/API key 应放在后续 `credentials-keychain`，不要写入 memory。
- 非目标：向量数据库、自动无审批写入、自动遗忘/dreaming、知识图谱、Wiki 长文、跨设备同步和多用户 ACL。

## 兼容性

已针对 DeepSeek Harness `0.1.2-rc.1` 验证。详见仓库[兼容性基线](../../docs/compatibility.md)。
