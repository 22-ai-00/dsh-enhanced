# @dsh-enhanced/assistant-recovery

`supervised-growth/v2` 的确定性恢复控制面。它把“成长心跳”从交互 Agent、模型和
preset 工具面中移出，注册一个版本化 Host executor，并按固定 catalog 执行有界步骤。
模型不能选择步骤、目标 scope、owner route、Policy principal 或操作上限。

## 安装

Recovery 是可独立发布、但不能在 fresh profile 中单包激活的 bundle。受支持的主安装路径是仓库的
`supervised` 场景；它会安装同一版本的完整服务集合，在飞书 owner onboarding 之后依次执行
Recovery preview、核验 receipt，再切换到 active：

```sh
./scripts/install/install-local.sh --scenario supervised --lark configure
dsh --profile web --dump-config
```

安装已发布版本时，从同一个固定发布标签运行 npm 安装器（把 `vX.Y.Z` 替换为真实标签）。安装器
默认把全部 `@dsh-enhanced/*` bundle 精确固定到它自身的发布版本，不使用可能在递归发布中途产生
混合版本的 `latest`：

```sh
DSH_ENHANCED_RELEASE=vX.Y.Z
bash -c "$(curl -fsSL "https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/$DSH_ENHANCED_RELEASE/scripts/install/install-npm.sh")" -- --scenario supervised --lark configure
```

不要把 `dsh plugin --profile web add @dsh-enhanced/assistant-recovery` 当作 fresh-profile 安装命令。
本包的 Cordis row 会等待 `assistantAutomations`、`assistantDelivery`、`assistantEvaluation`、
`assistantEvolution`、`assistantPreferenceLearning` 和 `assistantHealth`；peer 在包管理器层标记为
optional 只是为了让 DSH profile 提供唯一 Host 实例，不代表这些运行时服务可以缺失。手工组合仅适合
已经从同一仓库发布版本激活完整服务集合、并自行执行 supervised-growth 激活器的维护者。

不要在旧
`heartbeat:supervised-growth` 仍为 active 时直接启用生产 job；迁移必须先暂停旧任务，
再运行带新 `activationNonce` 的 preview，核对语义 receipt 后才启用 production。

运行时硬依赖 `assistantAutomations`、`assistantDelivery`、`assistantEvaluation`、`assistantEvolution`、
`assistantPreferenceLearning` 和 `assistantHealth`。Cordis 会等待这些服务就绪再加载 Recovery；
任一服务缺失都不会降级成模型心跳。

## 固定 runbook

runbook id 为 `supervised-growth/v2`，版本为 `3`。编译期 catalog digest 同时写入
Automation definition 和 Recovery ledger，任一漂移都会在执行前拒绝。顺序固定为：

1. 通过 Delivery Host receipt v2 精确重验 live owner route、workspace、preset、principal 以及
   durable principal row id/version，随后校验 Automation definition、Policy 与所需 Host service admission；
2. 从 Evaluation 的只读 Host outbox 精确选择一个 `evaluationId`，把该 ID 先写入 Recovery
   intent，再用 step idempotency key 投影到 Evolution；不会在 execute/replay 时重新选择“下一条”；
3. 先通过 Preference 的只读 Host owner-fence seam 固定当前 owner generation 与 Delivery
   principal row lineage，再持久化 action；执行前重验 live route，每轮最多清理一个已过
   retention 的 Preference evidence；
4. 每轮最多激活一个服务端已证明 evidence-ready、owner-attested 的 T1 preference；
5. 每轮最多回滚一个由 exact exposure 和可信 objective/verification evidence 证明退化的 Evolution rule；
6. 每轮最多通过 Automations 的原子 Host seam arm 一个 exact circuit，并在同一事务中持久化一个 production canary；不使用 arm-only probe；
7. 再次重验 Delivery owner route 并读取 content-free Health；所需 provider 全部可读且 readiness 成功时才结束为 succeeded。

preview 会完成所有只读 admission/规划/验证，但不会调用任何 mutation port，也不会写
production exposure、Delivery 或 circuit。

`preview` 启动时使用插件内部固定的远未来一次性 schedule 临时激活定义，执行一次
`runSystemDry`，随后无论成功或失败都恢复为 paused。`active` 启动在 Recovery ledger 中找不到
同 automation、scope、principal、owner route、activation nonce 和完整 activation plan digest 的成功 preview
时会直接拒绝加载，绝不会创建 active cron。修改任一 authority-bearing 配置时必须轮换
`activationNonce` 并重新 preview。plan digest 覆盖 cron、timezone、budget tuple、逐步超时、
Host definition、固定控制策略，以及 Delivery 对该 exact owner route 返回的稳定
`authorityHash`；binding version/generation 正常轮换不会让 proof 失效，但 authority 实体变化必须
重新 preview。仅保留旧 nonce 不能绕过重新验证。每次 mutation 和最终 verification 还会重取
live route，并要求它仍解析到同一个稳定 authority hash。Preference retention 与 activation 的
durable action 都会固定规划时的 Delivery principal row id/version 与 Preference owner generation；
执行前先重验 live row lineage，执行时把原 action fence 传给 Preference 再精确校验 generation，
并要求 receipt 回显完整 exact fence。因此同一外部 owner id 经历 A→B→A 复用时，旧
action/receipt 也不能作用到新 owner 代际。
如果启动时发现 production job 没有当前 proof（包括 route authority 漂移），Recovery 会先用
definition hash + version CAS 暂停同 owner 的旧 active definition，再拒绝加载，避免旧计划继续调度。

每次插件构造都会先在 SQLite 原子递增 `bootstrapGeneration` 并把旧 bootstrap proof 清空为
明确的 invalid/empty attestation；Delivery route 与完整 plan digest 都解析成功后，才用同一
generation 的 CAS 写入按 `automationId` 排序的 exact attestation set。每项只含
`automationId`、`activationState`、非 bearer `activationNonce` 和 `activationPlanDigest`，同时
保存整组 SHA-256 digest。最终 succeeded/failed receipt 也必须 CAS 同一 generation，因此旧实例
迟到的 async preview completion 不能覆盖新启动。Health 公开当前 generation、valid 标志、set
digest 和冻结的 bounded attestation set；stage gate 应核对目标 job 的 exact nonce + plan digest，
`bootstrapUpdatedAt` 仅用于诊断，不能作为代际证明。同毫秒启动或系统时钟回拨不会改变该语义。
跨包 stage gate 必须复用公开的 `canonicalRecoveryBootstrapAttestationSet()` 和
`recoveryBootstrapAttestationSetDigest()`；它们定义 schema v4 的 NFC/trim、按 automation id 排序、
原生 `JSON.stringify` 字节和 SHA-256 契约，避免安装器与 Store 各自实现后发生证明漂移。

## 崩溃与幂等

每一步先持久化 exact action、before digest 和
`recovery:3:<occurrenceId>:<stepId>`，再跨服务调用，最后写 after digest 和稳定结果码。
Preference retention action 的 exact identity 包含固定 limit、Delivery principal row id/version
和 Preference owner generation；activation action 还包含 hypothesis/version。回放不得从当前
scope 重新推导任何 owner fence 字段。
若进程在外部动作提交后、Recovery receipt 提交前崩溃，重启只会用原 action 和同一
idempotency key 重放；不会重新挑另一个偏好、规则或 incident。非协作调用超时后以
`unknown` 结算并交给 incident/owner，不自动猜测或扩大重试。
started intent 每次从 SQLite 读出时都会重新规范化 action JSON，并以常量时间比较其 SHA-256
和持久化 `action_digest`；账本被篡改或损坏时会 fail closed，不会执行无法证明的动作。
旧版本已持久化的 `{kind, limit}` maintenance action 仍可被 audit/read 读取，但只作为
legacy unfenced intent；新 intent 不再接受该形状，resume 也会在调用 Preference 前 fail closed。

Host definition 标记为 `idempotent`，但只允许一次 runner lease-expiry resume；这不是重新
规划或普通失败重试。Automations 会重新投递同一个 occurrence，Recovery 从 SQLite 中的
started intent 继续，并由 downstream operation receipt 证明此前是否已提交。

run 首次插入时会固定 `14 × maxStepDurationMs + 10s` 总 deadline；step intent 首次插入时
固定 `maxStepDurationMs + 10s` deadline。重启或后来修改 config 都不会延后旧 deadline。
每次 plan 使用 `min(config maxStepDurationMs, persisted run remaining)`，每次 execute 使用
`min(config maxStepDurationMs, persisted run remaining, persisted step remaining)`。在 deadline
边界或之后恢复的 started mutation 不再调用下游，即使下游支持幂等 replay 也只会把 step/run
结算为 content-free `unknown/action-deadline-expired-ambiguous`；read-only intent 则安全结算为
`failed/action-deadline-expired`。如果 deadline timer 已先触发而调用可能仍在外部提交，结论同样是
unknown；但 sink 已先返回有效 durable receipt 时，Recovery 会提交该 receipt，不会再用事后的
abort 或时钟检查推翻它。
Health 分别暴露 `staleRuns`/`staleSteps`，正常执行中的 intent 不降级，真正超期的 orphan
intent 才要求告警和人工/外围恢复。

具体写路径都具备跨账本重放语义：Evaluation 投影冻结 exact `evaluationId`；Preference
retention/activation 使用 owner-fenced operation receipt；Evolution rollback 和 Automation circuit canary
使用 exact target + expected version/CAS。普通 proposal ledger 目前没有 exact claim API，因此
Recovery 不调用 `reconcileProposals(1)` 这类“处理下一条”的接口，避免崩溃重放误处理第二条。

## 配置

`databasePath` 和每个 job 的 `workspace` 必须是绝对路径。job 还固定：

- `activationState`: `paused`、`preview` 或 `active`；
- 非 bearer 的 `activationNonce`；
- 当前编译的 `catalogDigest`；
- exact `preset`、owner `principal` 和 Delivery `ownerRouteId`；
- cron/timezone；
- 可选、成对出现的 `budgetId`/`budgetAmount`。

job id 和 activation nonce 在一个 profile 内必须唯一。Recovery 不接受模型参数覆盖这些值。
进入 `preview` 或 `active` 时 budget tuple 为必填；preview 本身不消耗 production budget，
但它必须先证明未来 production 的完整预算计划。只有纯 `paused` job 可省略。默认 patch 只注册
executor，`jobs` 为空，不会擅自创建 schedule。
每次启动会读取本插件 owner 名下的 content-free Automation inventory；已经从 `jobs` 删除但仍
active 的旧定义会通过 definition hash + version CAS 原地 pause，不会猜测或重写 definition。

## 权限与数据

- 文件系统：只创建并写入 `databasePath` 的 SQLite/WAL 文件；目录为 `0700`、数据库为
  `0600`。不读取目标 workspace 内容。
- 网络：无直接网络客户端。Recovery 失败由 Assistant Automations 的 Host incident/outbox 使用
  definition 中固定的 owner route 投递；Recovery 自己不能构造任意 Delivery 目标。
- 模型、工具、浏览器、子进程、凭据：均不使用。
- Policy、凭据、安全目录、预算定义/上限：没有修改 API。Recovery 只能消费 profile 中
  Host 已固定的 T1 grant；emergency stop 和显式 deny 始终优先。
- SQLite receipt 只保存标识符、版本、低基数结果码和摘要，不保存模型输出、异常正文、
  owner 消息或 Preference/Evolution 内容。

## 限制

该插件是恢复/监督执行器，不是自由目标生成器，也不写代码或安装 Skill/插件。语义自评、
能力工厂和 shadow/canary 晋升属于后续独立 lane；它们只能产出候选或调用这里已经固定的
exact action，不能修改本 runbook 或 T3 不变量。

一个正在 open circuit、executor 缺失或进程完全退出的 job 不能运行自己来修复自己。当前
incident step 只能从同一 Recovery 配置中的其他 job 选择一个 exact open circuit，并通过
Automations 原子地 arm + 创建 durable production canary；缺少该 seam 时会安全 noop；
Recovery Service 启动时会检查所有 required Host seam，缺失 atomic canary、exact projection、
read-only Preference owner fence、route validation 或 pause inventory 任一能力都会拒绝加载；
runbook 内的 noop 仅是防御性边界，
不会把旧版本依赖伪装成可用生产系统。
Automations scheduler 会处理 task lease expiry、executor 缺失 incident/owner alert，但进程未
启动、scheduler 被禁用或实例未取得 duty 时，仍必须由 systemd/container 和外部 tick-freshness
监控提供 restart/告警；Recovery 不会虚构自己的存活证明。Recovery 也不会在
缺少 exact claim/operation receipt 的情况下结算普通 Automation、Memory、Wiki 或 Evolution
proposal。

## 兼容性

参见仓库[兼容性基线](../../docs/compatibility.md)。Recovery 所需的 6 个 Host seam 在已发布的
`0.1.7` 内部 peer 集合中尚不存在，因此 manifest 明确拒绝这些旧 peer；首次发布必须通过仓库
`release:prepare` 统一提升版本，不能把当前工作树伪装成 `0.1.7` 兼容包。
