# 分级自治成长激活器

`dsh-supervised-growth-setup --profile web` 在完成 Lark owner onboarding 后，把
`supervised-growth/v2` 作为无模型的 `assistant-recovery` Host runbook 激活。它不把恢复步骤、
目标 scope、owner route 或 Policy 参数交给模型选择。另有独立、受限的 adoption analyst；它不参与
Recovery，只能把一个 Host 选出的候选转为 owner 审批卡。

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-supervised-growth-setup --profile web

# 只有在确认其他现存 active automation 可以继续运行时才使用
~/.dsh/profiles/web/node_modules/.bin/dsh-supervised-growth-setup \
  --profile web \
  --ack-existing-automations
```

激活器先从有效配置读取 Delivery、Automations 和 Recovery 的真实 SQLite 路径，再等待唯一一条
与 account、tenant、默认 workspace 和 preset 完全一致的 active owner 私聊 binding。没有匹配、
存在多个匹配、binding 在写入或重启前发生变化时均不会继续。

## 两阶段激活与完整回滚

一次激活只生成一个非 bearer `activationNonce`，并动态读取已安装 Recovery 包当前编译的
`RECOVERY_CATALOG_DIGEST`。随后严格执行两个重启阶段：

1. 写入 `activationState: preview`。此时普通 Automations scheduler 固定为关闭；Recovery 只通过
   exact `runSystemDry` 运行一次完整 preview。升级配置中的旧 `supervised-growth` Heartbeat 会先被
   标记为 disabled、清空 allowed tools，并通过唯一的 reconcile 权限把 durable
   `heartbeat:supervised-growth` 暂停；新的 `heartbeat:supervised-growth-analyst` 也固定为 paused。
2. resident 进程 running 只是第一道门。激活器继续有界轮询 Recovery SQLite，要求本次重启的
   `bootstrapStatus` 为 `succeeded`，并证明 legacy Heartbeat、Recovery preview 与 analyst 都处于
   预期状态，analyst definition 和私有 scratch 与受管合约逐项一致。
3. 只有 preview 通过，才用同一 nonce、catalog digest、owner authority 和完整计划写入
   `activationState: active`，打开 scheduler 并再次重启。
4. active 阶段同样要求本次持久 bootstrap 成功，并从 Automations SQLite 证明
   `recovery:supervised-growth` 由 `dsh-enhanced-assistant-recovery` 持有、处于 active，且完整
   production definition 与当前编译计划逐项一致；analyst 必须由 `assistant-heartbeat` 持有、处于
   active，且仍与同一 exact definition 相等。

preview 配置验证、preview bootstrap、active 配置验证、active bootstrap、binding 重验或 resident
健康任一失败，激活器都会原样写回进入命令前的 patch，并重启原 profile。不会留下“进程还活着，
但 Recovery 已降级/失败”的半激活状态。

## 生成的受管配置

- 稳定 Delivery owner route `supervised-growth-owner` 精确固定 conversation、principal、绝对
  workspace、preset、policyRef 和首次启用时的 minimum generation；后续同 lineage `/new` 可以前进，
  身份或 scope 漂移会失败关闭。
- Recovery job `supervised-growth` 每天在 Asia/Shanghai 的
  08:00、10:00、12:00、14:00、16:00、18:00、20:00 运行，使用 `automation-runs` workspace
  budget，每天最多 7 次、每次固定 1。
- analyst 每天 08:00 最多运行一次，使用独立 `automation-runs` workspace budget。它的 immutable
  allowlist 只有 `evolution_adoption_review` 和 `evolution_adoption_propose`，Policy 还把 inspect/propose
  限定到 production `heartbeat:supervised-growth-analyst`。定义只带 `approvalBindingId`，不带
  `deliveryBindingId`，所以只有 proposal 卡会发给 owner，普通模型正文不会投递。
- 固定 runbook 依次做 owner authority/Health admission、Evaluation durable projection、至多一条
  Preference retention、至多一个 evidence-ready T1 激活、至多一条可信回归 Evolution rollback、
  至多一个 exact circuit production canary，最后再次验证 authority 与 Health。
- preview 完成相同的读取、规划和验证，但不提交 production mutation、exposure、Delivery 或 circuit。
- workflow learning 不以 Lark 消息、卡片或 callback 作为写入面。只有 Delivery 通过私有、可撤销的
  trace sink 投影已证明的 content-free revision；自动来源还要求 active owner 对已投递普通 Agent reply
  的精确 `/feedback achieved` 与静态 catalog selector。候选仍须 owner approval、replay、effect-blocked
  shadow、单次 canary 和 trusted outcome，Lark 只负责呈现 Delivery 已持久的结果。
- Automation incident 只能由固定 `assistant-automations-incidents` 主体投递：Host run
  限定到 `message/route:supervised-growth-owner`，analyst Agent run 限定到当前 exact owner
  binding。两条授权都绑定同一 workspace 和 principal，不能互相借用。Evolution proposal
  审批仍只能投递给当前 exact owner binding。
- 普通 owner Agent 继续拥有 foreground/external 的 Evolution review/propose/rollback/undo 工具与
  inspect/propose 权限，以及 Preference/Evolution prompt snapshot；这些权限不对 Recovery 或 legacy
  background model heartbeat 开放。analyst 只获得上述两个 adoption 工具和精确 evolution resource。

overlay 不授予 Recovery shell、文件系统内容读取、网络、浏览器、凭据、代码修改或 Policy 修改能力。
T2/T3 与自由文本 guidance 仍需 owner 审批。确定性 T1 激活、可信回归回滚和固定 circuit canary 按
runbook 执行，不增加逐动作审批。

## Health 与安装场景

`supervised` 场景安装 `assistant-evaluation`、`preference-learning`、`assistant-evolution`、`assistant-growth-experiments`、
`assistant-heartbeat`、`assistant-health` 和 `assistant-recovery`。Heartbeat 不接管 Recovery，只承载
独立 analyst，因此 `assistantHeartbeat` 始终是 supervised Health required provider；用户已有的其他
Heartbeat 配置保持不变。

必需 Health provider 包含 Policy、Memory、Wiki、Automations、Evaluation、Preference、Evolution、
Delivery、Heartbeat、Recovery 和 Lark Channel。Recovery bootstrap 的 `failed`、stale run/step、缺 provider、
Lark 断联、open incident/circuit 等都不会被 resident running 状态掩盖。

TraeX 或其他模型 route 不是 Recovery 依赖。它们只影响普通前台助手；需要时用 `--with traex` 等
方式单独安装。Windows Task Scheduler 没有可验证的 resident running gate，因此当前拒绝激活
supervised growth。

## 已有 Automation 与重复执行

除 exact managed `heartbeat:supervised-growth`、`heartbeat:supervised-growth-analyst` 和
`recovery:supervised-growth` 外，任何 active
Automation 默认阻止激活，以免打开 scheduler 时意外运行。确认这些其他任务可继续后，显式传入
`--ack-existing-automations`。已成功启用的 profile 可以再次运行激活器；它会为新一轮 preview
生成新 nonce，先暂停旧 managed definition，再按相同两阶段协议重新证明，而不要求为自身使用
ack 参数。
