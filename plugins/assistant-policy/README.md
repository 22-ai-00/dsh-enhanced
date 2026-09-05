# @dsh-enhanced/assistant-policy

个人助理的统一授权边界：默认拒绝、单调工具 guard、策略自有硬预算、持久审批提案、紧急停止和脱敏审计。后续 Memory、Wiki、Automation、Channel 与 Credential 插件只通过 `ctx.assistantPolicy` 请求授权，不应各自实现一套可绕过的规则。

关闭资源词表把 `preference` 与 `memory` 分开：前者只表示可衰减、可回滚的偏好假设和低风险 overlay，后者才是 owner-confirmed 长期事实。允许前者不会隐式允许写入后者。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-policy
dsh --profile web --dump-config
```

默认配置把数据库放在 `$DSH_HOME/assistant-policy/policy.sqlite`，并且 `rules` 为空、`toolDefaultEffect` 为 `deny`。因此插件安装后会拒绝所有经过 DSH `tools.guard()` 的工具调用，直到 profile 的 `cordis.patch.yml` 明确配置 allow 规则。这是预期的 fail-closed 行为。把 `toolDefaultEffect` 设为 `allow` 只会放行没有匹配规则的工具执行；显式 deny、紧急停止、身份缺失和已耗尽预算始终优先，不能被“完全访问”或自动审核绕过。

## 最小配置

下面只允许 `primary` preset 在指定 workspace 的前台会话读取文件；`bash` 和后台任务仍会被拒绝：

```yaml
- id: dsh-enhanced-assistant-policy
  name: '@dsh-enhanced/assistant-policy'
  config:
    databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')
    proposalMaintenanceIntervalMs: 15000
    toolDefaultEffect: deny
    autoReview:
      enabled: true
      timeoutMs: 30000
      maxTokens: 512
    rules:
      - id: allow-primary-workspace-read
        effect: allow
        subject:
          kind: agent
          id: primary
          workspace: /absolute/path/to/workspace
        actions: [execute]
        resource:
          kind: tool
          id: read
        context:
          initiators: [foreground]
    budgets: []
```

匹配支持完整字符串中的 `*` 通配符。任意匹配的 deny 都优先于 allow；同 effect 先选更具体的规则，再按声明顺序决定。工具身份来自 DSH 0.1.2-rc.1 的 `Agent.session.header.agentPreset` 与绝对 `cwd`，缺少 agent、preset 或 workspace 时直接拒绝，调用方参数不能伪造这些字段。

## 三档即时审批

生产三档由标准 `permission/preset`、`sandbox/mode` 与 `approval/policy` 共同决定：官方 id `workspace-write` / `auto` / `danger-full-access` 分别映射 reviewer `user` / `auto-review` / `none`，而且日志中更晚的官方选择会覆盖更早的旧 reviewer 事件。`assistant-policy/approval-reviewer` 仍保留为旧 session、单 workspace preset 或第三方动态 id 的兼容事实；无论意图来自哪一种事件，执行状态仍逐项核验：

- **请求批准**：`sandbox/mode: workspace-write` + `approval/policy: ask` + reviewer `user`。低风险精确 allowlist 直接继续，其余动作交给人工。
- **帮我批准**：`sandbox/mode: workspace-write` + `approval/policy: ask` + reviewer `auto-review`。只有本地归为 `ask-review` 的未知或可能低风险动作才会进入隔离 LLM reviewer；本地明确识别出的网络、凭据、后台、破坏性、提权和复杂 shell 始终交给人工。
- **完全访问权限**：只有显式且同时生效的 `sandbox/mode: danger-full-access` + `approval/policy: never` + reviewer `none` 才会绕过参数级即时风险门。单独的 `never`、缺少 sandbox 事件、事件畸形或三者暂时不一致都会失败关闭，绝不会把 headless 的“不询问”误解成 full；此时敏感工具直接返回稳定的 `[approval-disabled]` 诊断，并明确说明没有向用户展示审批，不再制造 `the user rejected tool` 的错误归因。`tools.guard()` 的显式 deny、紧急停止、身份和预算检查仍然单调生效；若希望未匹配工具也可执行，需要显式配置 `toolDefaultEffect: allow`。

包根导出 `approvalReviewerOf(events)`、`getApprovalReviewer(session)` 和兼容 setter `setApprovalReviewer(session, reviewer)`；setter 只接受 `user | auto-review | none`。auto 与 full 都要求 preset 意图、显式 approval 和显式 sandbox 完整一致；缺项、畸形事件或切换中的中间状态只会折回 `user`。因此 Web 的 full→auto、ask→auto，以及 Delivery auto→Web ask 都由最新官方 preset 直接串行折叠，不再依赖另写 custom reviewer。

canonical `danger-full-access` 现在直接折叠为 reviewer `none`，不需要迁移写入。仅对旧版/第三方的非 canonical full preset，插件仍在 live session 扫描、`session/created` 和工具执行屏障做严格兼容迁移；它要求显式 full bundle、sandbox 与 approval 完全一致且没有 reviewer，失败则收窄并拒绝本次工具。

`assistant-policy/approval-reviewer` 是 required session event。DSH 0.1.2-rc.1 尚无公开事件注册 API，而且独立安装/软链接插件时，插件和 DSH Host 可能各自加载一份 `@deepseek-ai/dsh-session`。本包会同步校验 format v0，并在插件本地目录与从真实 Host 入口解析出的目录不同的情况下同时做精确、进程生命周期内单调注册；npm/pnpm bin 会先解析软链接，不依赖固定安装路径。注册不能在插件卸载或 HMR 时删除，否则 persistence 的关机 drain 和已有 session 冷恢复可能再次把事件判为 unknown。若无法从真实入口解析 Host copy，或已解析到的 copy 在格式、导出形态、同步加载能力上不兼容，插件都会 fail fast，拒绝仅修改本地目录并要求同步更新兼容层。

参数级风险门不是宽泛的字符串前缀判断，也不声称实现了完整 shell parser：

- `read` / `read_image` 只有一个可证明位于 workspace 内且不带 credential-sensitive 标记的本地路径时可继续；`glob` / `grep` 只接受已知参数形态，并对 search root、glob/include 做同样的词法范围检查。workspace 外、`.env`、`.ssh`、`.codex/auth.json` 等敏感目标、URL、缺失路径或未知参数一律交人工；
- `pwd`、受限 `ls`、`git status --short` 等少量精确 argv 形态可继续；其 `workdir` 与 `ls` 路径操作数仍必须位于非 credential 的 workspace 范围内，未知或畸形 bash 参数失败关闭；
- 简单但未分类的命令（例如 `pnpm test`）与未知工具进入 `ask-review`。`run_code` 例外：当前 worker runtime 是 bash-equivalent 的便利执行环境，不是 OS 安全边界，代码可触达 Node/进程能力，因此在 ask/auto 档始终进入 `ask-human`，不会交给模型自动批准；仅显式完整的 full 档会按其“不再请求批准”的语义直接继续；
- 网络（包括内置 `web_search` / `web_fetch`）、credential 痕迹、后台执行（包括 `bash.run_in_background: true`）、破坏性操作、提权、workspace 外写入，以及包含管道、重定向、替换、引号等需要真实 shell 解析的命令进入 `ask-human`；`npx`、`npm exec`、`pnpm/yarn dlx` 与 `git submodule update` 也按潜在下载/远端执行直接归入这一档；
- `pwsh` 在具备独立严格解析器前一律进入 `ask-human`；
- `bash` / `pwsh` / `write` / `edit` 已携带 DSH 0.1.2-rc.1 合法的 `sandbox_permissions: workspace-write | danger-full-access` 和非空 `justification` 时交还工具自身的原生审批，避免弹两次；Codex 风格的 `require_escalated` 或其他畸形升级参数仍交人工。

workspace 路径判断是保守的词法检查，不替代宿主对 symlink、文件权限和进程的最终约束。尤其 DSH 0.1.2-rc.1 的 `workspace-write` sandbox 不能被当作网络或子进程隔离；这里的风险门只负责授权路由，不是 OS 安全边界。

### 隔离自动 reviewer

`autoReview.enabled` 默认开启，但只有 session 明确选择 `auto-review` 且动作是 `ask-review` 时才调用。`provider` / `model` 可选；省略时沿用当前 request header 的 provider/model，因此 Codex、TraeX 或其他已选 route 都能供应 reviewer，也可把两者固定到独立 route。请求由插件手工构造，使用独立 system prompt、`tools: []`，不继承 Agent 工具，也不写入主会话。

Reviewer 只接收当前 open turn 中唯一、尚未结算的 exact `callId` 参数，以及最近的真实 user-role 文本意图；只信任核心 `user` 与可选 Delivery 的 `delivery` source，`plugin` / `tool` 或未知扩展来源不能充当授权。可信消息只要还含图片等非文本 block 就整体转人工，不会丢掉上下文后让 reviewer 猜测。调用 LLM 前会快照 `permission/preset`、sandbox、approval、reviewer 四类最新事件的 seq/identity、open `turn/start` seq、exact call/settlement event seq、可信 intent event seq 与精确内容；LLM await 返回后以及签发 grant 的同步边界会再次校验 signal 与完整快照。权限或事实漂移（包括先改走再改回的 ABA）绝不会得到 `allowed-once`：仍为一致 auto 档时降级人工，否则返回失败关闭结果。参数和意图都有硬字节上限；发生截断、secret 脱敏、参数 prompt injection、找不到 exact call、重复或已结算 call、route 缺失、超时、provider 错误或非严格 JSON 时，都会交给人工，绝不静默允许。只有严格返回 `outcome=allow`、`riskLevel=low` 且 `authorization` 至少为 `medium` 才可能签发一次性 `allowed-once`；rationale 不进入主模型会话。

发送 reviewer 前的本地 secret-like 检查是失败关闭的：除 password/passphrase/passwd/secret/token 等敏感字段名与常见 token 前缀外，也拦截对应自然语言赋值、URI userinfo、PEM private key、JWT，以及 `AKIA` / `ASIA` AWS access key。任何命中都会保持 reviewer 请求数为零并转人工；这是避免跨 provider 外发的最后本地边界，不应把 reviewer provider 当成秘密扫描器。

包根的 `isAutoReviewEscalation(request)` 是 auto reviewer 与人工 answerer 的对象级交接信号：它只在同一个 `ApprovalRequest` 被明确升级并执行下游 `next()` 的期间为真，并在 `finally` 中清除。Reviewer listener 使用 waterfall 的 `prepend` 注册，即使 LLM service 晚于人工 listener 到达也先完成自动判定。人工渠道在 auto 档只应认领这个信号标记的请求；其他插件的自定义 approval reason 不会被本插件标记或抢占。

## 硬预算

额度定义属于 policy 配置，消费者只能引用 `budgetId`，不能传入或抬高 `limit`、`periodMs`：

```yaml
rules:
  - id: allow-budgeted-background-tool
    effect: allow
    actions: [execute]
    resource: { kind: tool, id: wiki_* }
    context: { initiators: [background] }
    budget: { id: background-tool-calls, amount: 1 }
budgets:
  - id: background-tool-calls
    metric: tool-calls
    limit: 100
    periodMs: 86400000
    scope: subject
```

每次带预算的授权必须提供幂等键。策略先在 SQLite 短事务中预留，再立即计入固定收费；进程在两步之间崩溃最多造成保守占额，不会超额。同一业务操作即使跨过预算周期仍重放原 reservation，不会重复扣费；换 scope、metric、period 或 amount 继续失败关闭。可变成本消费者使用 `reserve()`，完成后调用 `finalize()`，失败调用 `release()`。`scope` 可为 `global`、`subject` 或 `workspace`，同样由配置决定。

## 服务 API

注入名为 `assistantPolicy`。持久账本只属于 service 内部，不从包根导出；消费者不能直接打开数据库或绕过 service 规则。主要方法为：

- `evaluate(request)`：只评估，不写审计；紧急停止优先于所有规则。
- `getEmergencyStop()`：只读返回当前硬门状态，不做 authorize、不写审计且不消耗预算；Delivery 等最终授权方可在提交外部批准前再次复核。
- `authorize(request, options)`：执行预算检查并追加脱敏审计。
- `reserve` / `finalize` / `release`：策略配置约束下的可变成本预算。
- `propose` / `decideProposal`：绑定 principal、版本 CAS、TTL 与幂等键的持久审批提案。所有提案永久保存 diff SHA-256；只有携带 `dispatch` 的 pending 提案会临时保存 immutable diff 原文，路由与提案在同一个 SQLite 事务中落盘。路由 principal 必须与提案 principal 完全一致、workspace 必须为绝对路径。无路由提案和 v1 legacy 提案只凭 hash 安全重放，绝不会在重放时补建路由。
- `getProposal`：只读地返回某个提案的当前状态（含终态与决定者）。`getProposalByIdempotencyKey` 用完整的 requester、principal、action 和 resource scope 做只读诊断；它绝不创建、重放或延长提案。
- `recoverOrCreateProposal`：业务域跨 SQLite 恢复时使用的原子入口。调用方提交不可移动的绝对 `notAfter`；Policy 在 `BEGIN IMMEDIATE` 中选择“恢复 exact 既有提案 / 创建一次 / 过期后永久 tombstone 幂等键”。tombstone 的 SHA-256 intent hash 固定绑定 deadline、requester、principal、action、resource、diff、summary 以及 dispatch presence/route，但不保存 diff 明文；v4 遗留 tombstone 缺少可验证 identity，迁移后只会阻止复用，任何 recovery 都失败关闭。因此多个进程不能在 lookup 与 create 之间制造孤儿审批卡，也不能借重启获得新 TTL。本插件**从不回调**业务域，方向永远是域读取 Policy 后通过自己的 gate 提交。
- `listPendingApprovalDispatches` / `markApprovalDispatchEnqueued`：向 Delivery 提供有界、可 CAS 的 durable approval outbox。展示用的 summary、diff、action、resource、版本与过期时间只能从 policy 已持久化的 canonical proposal 派生，调用方不能替换卡片文案。终态或已过期提案不会被列出。
- `validateApprovalSettlement(snapshot, expectation)`：跨 Memory / Wiki / Automations / Evolution 共用的纯函数提交门。它逐字段核对 immutable proposal、重新计算 diff SHA-256，并要求终态版本恰好为原版本 `+1`；approved/rejected 必须由绑定 principal 决定，expired 必须由 `system:expiry` 决定。缺失或冲突会抛出稳定的 `ApprovalSettlementConflict`，业务域应 fail closed。
- `setEmergencyStop` / `getEmergencyStop`：持久紧急停止。
- `queryAudit`：按 sequence 有界分页，单次最多 100 条。
- `bindInitiator(agent, initiator, principal?)`：供受信调度器在 Agent 生命周期内绑定 initiator；外部调度器同时传入 canonical principal 后，`authorizeAgent()` 与工具 guard 会把它作为 Agent subject 的精确 principal。释放后恢复前一层绑定。

DSH 原生 `user-approval` 仍只负责 open turn 内的即时询问；本插件的 proposal 是跨 turn、可重启恢复的审批状态，不把两者混为一个授权凭证。

## 数据与权限

- 文件系统：创建一个 SQLite 数据库及 WAL/SHM 辅助文件；新目录权限 `0700`，主数据库 `0600`。数据库使用 WAL、`busy_timeout`、外键、FULL synchronous 和前向 schema 版本。
- 网络：插件不直接打开 socket；启用隔离自动 reviewer 时会调用宿主 `dsh-llm`，所选 provider route 可能使用网络。provider 的认证与传输仍由宿主拥有，本插件不直接读取其凭据。
- 子进程：无。
- 凭据：运行时的 Policy service 不读取或保存凭据值。审计按敏感 key/value、shell `command`、授权头、token、password、path/cwd 做脱敏，资源 id 仅保存 SHA-256。自动 reviewer 输入只要需要任何 secret 脱敏就失去自动放行资格并转人工。包另附带两个安装期 CLI（`dsh-permission-setup`、`dsh-model-setup`），仅供安装器/部署者手动调用，不在 Cordis 运行时加载：`dsh-permission-setup` 只原子改写 `settings.yaml` 的 `permission.defaultPreset`；`dsh-model-setup` 原子写入 `agent-default-model`（自定义网关另写 `llm-pi-ai.providers.<route>`），并在显式 `--store-key` 时把仅从环境变量读取的 API Key 原子写入 `$DSH_HOME/.credentials.yaml`（`0600`，目录 `0700`），密钥绝不作为命令行参数、缺失时 fail-closed。`dsh-model-setup` 还支持 agent route（如 `traex-agent`）：这类 route 不涉及 API Key，`--enable-in-profile <profile>` 只在该 profile 的 `cordis.patch.yml` 原子改写对应 provider 行的 `enabled`（保留其它行/注释/`!!js`），非 YAML 序列的 patch 会 fail-closed 而非被覆盖。
- 浏览器：无。
- 安装脚本：无 npm 生命周期脚本；上述 CLI 仅在被显式调用时运行。

审批展示预算由包根的 frozen `APPROVAL_DISPLAY_BUDGET` 统一公开：Delivery 默认文本上限 64 KiB，summary 最多 120 UTF-8 bytes，diff 最多 60 KiB，预留 4 KiB 给渠道渲染。原始 diff 只在 routed dispatch 仍为 pending 时存在；成功 enqueue、批准、拒绝或过期都会在同一状态事务中清除，v2→v3 迁移也会清除无路由、已 enqueue 和终态记录的遗留原文。业务域仍不得把 credential、token 或其他秘密写进 diff。`proposalMaintenanceIntervalMs` 默认每 15 秒有界地过期 stale proposal，设为 `0` 可关闭，最大值为 `2147483647`。审计是 append-only；当前版本不会自动删除记录，部署者应根据自己的隐私与合规周期备份或轮换整个数据库。SQLite 提供单机多连接并发安全，不承诺多主机共享文件系统上的一致性。

## 兼容性

已针对 DeepSeek Harness `0.1.2-rc.1` 验证。详见仓库[兼容性基线](../../docs/compatibility.md)。
