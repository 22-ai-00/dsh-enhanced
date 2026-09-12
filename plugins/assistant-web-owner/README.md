# @dsh-enhanced/assistant-web-owner

将现有 DSH Web 聊天接到一个已配对的 Delivery owner，让原生用户文本回合能够使用 `assistant-goals` 等依赖可信人类回合的能力。沿用原生 `SessionController`、Typert、Goal UI 和 AgentLoop。

## 安装与配置

兼容 DSH `0.1.2-rc.1`。这是可选实验性 bundle，尚未正式发布。本地源码安装可使用现有安装器的显式 Web 场景；默认 `core` 不会自动启用它：

```sh
./scripts/install/install-local.sh --scenario web --workspace /absolute/workspace --yes --no-service
```

该入口安装 core、Delivery、Goals 和 Web owner；先通过本地 `dsh-web-owner-setup` 初始化 owner 与完整 profile 配置，再探测真实 Host 激活。它复用有效 Delivery 数据库路径，固定 principal 为 `web/<profile>/local/operator`。不配置飞书或常驻服务，不会自行更改全局模型/权限选择；模型设置和验证仍沿现有安装器选项。完整目标执行、独立验收和隔离配置并未因此自动完成。

单独使用 CLI 时先安装这些 bundle，停止目标 Host，再运行 `dsh-web-owner-setup --profile web --workspace /absolute/workspace`。它保留 YAML 标签、自定义配置和 Policy 规则；重复运行保留 owner ID/version、已有绑定和任务。修改过的受管规则或不同 owner/scope 会拒绝覆盖。新增精确 owner 的外部 ingest/capability 规则只提供能力可达性，现有 deny、原生 sandbox 和审批约束仍生效。

Web principal 必须是 `channel: web`，其 account、tenant、user 由可信本地安装者固定。安装器使用 `ensurePrincipalLocally()`：只在空库初始化，或原样保留完全匹配的 active owner，不替换其他 owner、不复活已撤权身份。已有 Lark 或不同 owner 使用同一数据库时会拒绝，可为独立部署选择另一个 `DSH_HOME`。高级离线交接 API `pairPrincipalLocally()` 仍保留其原本的显式交接语义；本安装器不调用它。当前不支持跨渠道 owner 别名或多用户 Web 身份映射。

本 bundle patch 先禁用上游 `session-controller` 行，再插入 `dsh-enhanced-assistant-web-owner`。在该 bundle 后追加完整配置 patch：

```yaml
- id: dsh-enhanced-assistant-web-owner
  name: '@dsh-enhanced/assistant-web-owner'
  config:
    principal: { account: local, tenant: local, user: operator }
    workspace: /absolute/workspace
    preset: standard
    maxExecutionMs: 300000
```

安装后用 `dsh --profile <测试配置> --dump-config` 检查：只有本 bundle 的 Controller 激活，owner 和作用域与本地配对一致。卸载 bundle 会移除本层禁用 patch，恢复原 Controller；Delivery 的持久 Session 归属保护仍生效。

`workspace` 必须是绝对路径，`preset` 必须与实际原生 preset 一致。`maxExecutionMs` 为每次 Agent 激活的最大时间，范围 1–300000 毫秒，默认 300000。原生 factory 的冷加载也使用这一取消期限。空闲 Agent 清理后释放 Session 给 Delivery/Automations；未证明完成清理的执行保持 unknown。

原生 Goal 仍为 `active` 且 `armed` 时，即使 Agent 暂时 idle，也会保留它和原 Session lease，等待宿主 GoalRoundDriver 完成保存并续跑。目标终态或 disarm 后再释放；执行期限、撤权和卸载仍优先生效，不因新目标轮重置。缺少 GoalRoundDriver 时最多保持到原执行期限，此检查不另行调度任务。

Policy 至少需要显式允许该 `web/account/tenant/user` 的 `ingest`，以及该 principal、workspace、preset 下需要的 Agent `reply`、工具执行和 Goals/Memory 操作。配对不会自动放宽 Policy。

## 当前行为与限制

- 启动时在 owner 已证明后解析或注册配置 workspace；配置路径必须是实际路径（`realpath`），避免 Delivery scope key 漂移。原生界面使用该 workspaceId，Controller 保留工作区与会话关联；直接调用可省略位置或提供相同 cwd。其他 workspaceId、不同 cwd/preset 或外部 Session ID 均拒绝。同一请求不能同时提供 cwd 和 workspaceId。
- 文本先以确切 Inbox 原子领取，再通过原生 `source.kind=user`、requestId、内容和实际 inserted/claimed 消息对象建立一次性证明。只复制来源标签或重发相同文本不能获得第二次准入。
- Session 列表、搜索、历史、控制流、技能目录及 `api-session/*` 广播过滤非 owner 会话；原生 Goal RPC 的 Agent lookup 使用同一受限入口。
- 空闲释放只回收内存 Agent，保留已持久化的会话和界面选择；再次输入沿原生恢复路径执行。不会把原生 `session/disposed` 当作持久会话删除。
- 忙时拒绝新的输入，当前不支持输入图片、fork、子 Agent 历史地址或任意宿主路径打开。排队/steer 的完整交互、附件的一次性准入与长期跨日运行仍待完成。
- 中断的 native Inbox 不转成普通 Delivery 消息重放，包括尚未调用原生 prompt 的崩溃窗口。已有 Session/Goal/业务记录保留。

Web client 在构建时复用 DSH `0.1.2-rc.1` Session Controller 的浏览器 bundle，只将 ModuleLoader 注册 id 改为本包 id；不会重新实现 session RPC 或 UI 状态。构建脚本会验证上游版本、完整 `dsh.client` 元数据、MIT 许可证、单一注册 id 和无自引用 require，格式变化时失败。生成产物携带上游完整 MIT 文本于 `lib/THIRD_PARTY_LICENSES`，并保留 client 文件的版权 notice；该方案依赖当前 DSH UI bundles 不通过 ModuleLoader require 原 Controller client id。其他 UI manifest 的旧 inject 边在该版本只影响 graph 到达顺序，Cordis client service injection 仍等待本 clone 提供 `sessions`。

当 Delivery 接受了同一 owner Session 的主动提醒时，输入框上方会显示只读“主动提醒”区域。该区域通过严格 Typert `deliveryNotices.list(sessionId)` 读取，并在每次读取结束后约两秒发起下一次读取；切换会话、断开连接、撤权或读取失败会清空旧内容。提醒保持独立于聊天记录，不会伪装成用户或模型消息，也不会触发模型、创建 Session 或改变提醒状态。Host 每次读取重新校验固定 Web owner 能力、owner lineage 和期限；提醒只会在 Delivery 已通过实时背景 `send` Policy 后被接受，不属于该主人的 Session 请求会被拒绝。

## 权限与数据

运行时不创建监听端口、凭证或浏览器认证，复用已有的已认证单 owner Web 控制面。离线 setup CLI 调用本机 `dsh --dump-config` 读取配置，不执行任意 YAML JS；写入目标 profile patch、Delivery owner 数据库和所选工作区目录，使用安装锁与原子文件替换。配对与 YAML 不能跨库原子提交，写文件失败可能留下尚未启用的首次身份；同身份重试不会轮换权限。CLI 不读取凭证存储、不发模型请求，也无安装生命周期脚本。

运行时通过宿主服务驱动 Agent 已有的文件、网络、子进程、凭证和浏览器能力，仍受 Policy 与原生审批约束。

Delivery 保存 Web owner/binding、Inbox 文本、内容摘要、尝试与租约；原生 Session 保存实际对话。返回的固定 capability 只给受信 Host 配置使用，并非对同进程插件或同 UID 进程的 OS 隔离边界。

单元与组合测试覆盖实际 AgentLoop、SessionController、Typert Gateway、双事件订阅、SQLite、业务 Goal 及空闲后恢复。另有独立浏览器命令 `CI=true pnpm test:web-owner`：全新临时 profile 安装、真实认证/HTTP/WS、原生审批、Goal 落库、Host 重启后新浏览器上下文恢复同一会话，详见仓库 `scripts/e2e/README.md`。模型仍为确定性 adapter；这些证据不证明真实模型收益、可信目标达成或长期自治。该命令需要本地 DSH 与 Chromium，不包含在普通 `pnpm check` 中。

可选的 `CI=true pnpm test:web-owner:real` 使用现有 Codex subscription 登录，验证真实模型生成程序、原生目标续跑、独立步骤/整体回执以及最终释放。它有精确工具范围和模型调用/时间上限，属于有引导的小任务实验，不证明长期自治、生产 token/费用硬预算或 OS 隔离；前置条件与证据边界见同一浏览器说明。

## 有限离线执行安装

仓库安装器 `--scenario autonomy` 调用本包 setup 的可选 `--isolation-image`、`--isolation-max-runs`、`--isolation-lease-ms`、`--isolation-runtime-ms`。普通 Web setup 不加载 Isolation；显式选择时需安装匹配版本的 Isolation、Actions 和 Keychain。

该路径先验证最终合并配置，再使用实际配置的 Docker executable 和生产 supervisor 做固定任务探测，成功后初始化本机 owner 并原子写入有限 grant。重复执行不延长 grant、不重置账本、不替换或复活 owner；冲突配置拒绝并要求明确迁移。Isolation、Actions、Keychain、Skills 与 Proactive 的可变状态路径均规范化到真实 `DSH_HOME` 内，Skills 的嵌套比较/留出 `stateRoot` 也受同一约束；已有祖先 symlink 逃逸会拒绝。旧 Skills/Proactive published-default SQLite 或 sidecar 若已有数据，不会静默切换位置，必须先停 Host 并显式离线迁移。setup 在失败前可能创建工作区目录，owner 数据库与 patch 也不能跨库原子提交。

此选项额外使用本机 Docker、子进程和私有临时 staging；不拉取镜像或配置外部凭据。未知清理状态的探测目录保留以供排查。具体参数、前置条件和未完成的自治能力见[安装说明](../../scripts/install/README.md)。

## 有限 Goal admission（实验性）

在已完成 `autonomy` 安装后，可用一次离线 setup 把**一个已有、空闲的 Web owner Session**配置为固定 DeepSeek 路由、有限 Goals 预算、独立隔离验收条件和可选 wake route。先停止目标 Host；准备工作区之外、当前用户所有且权限为 `0600` 的 JSON 任务文件。不要把 API key 写进文件，`apiKeyEnv` 只是 credential reference。

先用正式 setup 入口列出当前 owner 的真实空闲 Session；它只读取匹配当前 Web principal、workspace 和 preset 的 Delivery binding，绝不创建或伪造原生 Session。新 profile 需要先从原生 Web UI 打开一次，让 DSH 创建 Session。`--session-id` 可显式选择；省略时只有一个合法空闲 binding 才会自动选择，多个候选会原样列出并拒绝继续。

```sh
# 已完成 autonomy 安装；Host 停止后执行
chmod 600 /private/goal-admission.json
dsh-web-owner-setup --profile web --workspace /absolute/workspace --list-goal-sessions
dsh-web-owner-setup --profile web --workspace /absolute/workspace \
  --goal-admission /private/goal-admission.json

# 应用 patch 后才重启目标 Host
dsh --profile web --no-open
```

重启后，在已有 Session 的模型选择器中选择 `deepseek-goal-metered` 下与任务一致的模型，再发送原始 objective。CLI 只配置默认路由；已有 Session 和用户 settings 保存的模型选择仍会保留，不会自动迁移到新模型。

可用任务文件如下。每个字段都是有限值；未知字段、成本上限字段、明文凭据、模型别名和任意 endpoint 都会拒绝。

```json
{
  "version": 1,
  "objective": "Create a shell program that reads two integers and prints their sum",
  "model": "deepseek-v4-flash",
  "apiKeyEnv": "DEEPSEEK_API_KEY",
  "maxGoalRounds": 3,
  "stepMaxDurationMs": 60000,
  "executionBudget": {
    "modelCalls": 6,
    "toolCalls": 3,
    "inputTokens": 2100000,
    "outputTokens": 6000,
    "durationMs": 240000,
    "maxOutputTokensPerCall": 1024
  },
  "verification": {
    "artifactPath": "answer.sh",
    "command": "/bin/sh /workspace/artifact < /workspace/input",
    "maxRuns": 12,
    "maxTotalDurationMs": 240000,
    "maxDurationMs": 20000,
    "maxOutputBytes": 4096,
    "cases": [
      { "stdin": "19 23", "expectedStdout": "42", "expectedExitCode": 0 },
      { "stdin": "-8 5", "expectedStdout": "-3", "expectedExitCode": 0 }
    ]
  },
  "wake": { "maxDelayMs": 60000, "runTimeoutMs": 90000, "maxRuns": 3 }
}
```

该 v1 格式保留固定 `deepseek-v4-flash` 或 `deepseek-v4-pro` 路径，endpoint 不可配置。每次目标模型调用会保守预留至少 `2,097,152` 输入 tokens；当前没有 USD 硬预算，任务不得添加 `costUsdMicros`。

v2 可使用安装器已经配置且实际出现在 `agent-default-model` 的任意精确 provider/model，例如 `super-relay`、`auto_model` 或 `alwaysday1`。它不会写入 provider、endpoint 或 secret 配置：`route` 必须与已配置默认 route 完全相等，且 calls budget 的唯一 `routes` 项必须与它相同。启用后台唤醒时，setup 同时将 Delivery 的默认 provider/model 和输出上限设为这条已授权线路，保证恢复使用相同线路；运行时仍逐次检查预算。

```json
{
  "version": 2,
  "objective": "Verify the generated artifact",
  "route": { "provider": "super-relay", "model": "relay-v2" },
  "maxGoalRounds": 2,
  "stepMaxDurationMs": 60000,
  "executionBudget": {
    "mode": "calls", "modelCalls": 3, "toolCalls": 3,
    "durationMs": 120000, "maxOutputTokensPerCall": 8192,
    "routes": [{ "provider": "super-relay", "model": "relay-v2" }]
  },
  "verification": { "artifactPath": "result.txt", "command": "node verify.mjs", "maxRuns": 4, "maxTotalDurationMs": 100000, "maxDurationMs": 20000, "maxOutputBytes": 4096, "cases": [{ "stdin": "one\n", "expectedStdout": "one\n", "expectedExitCode": 0 }] }
}
```

v2 的硬限制是模型请求数、工具请求数、总时长和每次输出上限；若 adapter 提供 usage，会作为记录使用，但不是 token 或 USD 硬限制。重复相同 admission 不改变 patch 字节、不会续期 Isolation grant、不会重置已用次数或扩大预算。与本次任务要求冲突的已有受管配置或同 ID 条目会拒绝，而不是被覆盖。

### 验收后仓库交付

v2 任务可增加 `repositoryDelivery`，继续使用同一个 `--goal-admission` 命令。字段为 `repository`（例如 `owner/project`）、`baseBranch`、`branch`、`paths`、`credentialHandle`、`expiresAt`（明确的 Unix 毫秒到期时间）、`maxActions`、`maxTotalBytes` 和 `openPullRequest`，另可显式设置 `acceptance: "goal-step"` 允许独立步骤验收后的中间提交。省略时为 `goal-outcome`，继续要求整体验收；CLI 会显示实际模式。当前 `paths` 只允许包含本任务的 `verification.artifactPath`，因为只有该文件具备配置的独立验收。目标分支必须已存在，PR 基准分支必须与它不同。

`credentialHandle` 引用已配置在 Keychain 中的凭据；该 handle 必须使用可静态读取的无标签配置，允许 `dsh-enhanced-assistant-actions` 消费者与 `github.commit` 用途，且 `maxLeaseMs` 不小于 30,000。任务文件不接受 token，也不会创建或修改 handle。`expiresAt` 必须覆盖配置时刻后的整个目标执行预算并额外预留 60 秒交付时间，同时不超过当前隔离授权期限；重复设置不会续期。`maxActions` 同时计入仓库读取与提交、PR 操作：仅提交至少 2 次，创建 PR 至少 3 次；额外调查需要更多次数。

设置命令从已有主人和空闲 Session 派生 Actions grant、owner route、有限调度预算及精确 Policy 规则，包含后台提交与原会话通知；无需用户填写内部身份、路由或规则 ID。未提供 `wake` 时自动配置至多一次后台运行；已有合法 `wake` 配置继续使用。已有同 ID 配置冲突会拒绝整次配置，而不会覆盖。正式 CLI 在取得配置锁后及写入前重读有效配置，发现下层凭据或插件配置变化时拒绝；多文件配置与数据库仍不构成一个跨进程原子事务。所需 Actions、Keychain、Goals、Automations 与 Delivery 必须来自匹配的安装集合。

重启 Host 后，在原会话提交与配置一致的目标，并说明需要交付到已授权仓库。模型可查询可用授权、读取目标分支 head、修复隔离产物并登记交付；独立步骤和整体验收通过后由后台提交准确产物、按授权创建 PR，并主动显示最终结果。步骤模式允许原目标保持 active 或 paused。可选 `repositoryDelivery.outcome` 将整体验收绑定到实际提交的 CI/评审新鲜回读；省略时仍使用本地隔离产物条件。设置命令只证明配置和当前身份匹配；凭据是否可用、远端仓库访问和真实 GitHub 提交仍须实际运行验证。本机端到端测试的 GitHub 传输是明确替身，不能视为真实 GitHub 认证成功。

需要仓库整体验收时，在 `repositoryDelivery` 中设置 `acceptance: "goal-step"`、`openPullRequest: true`，并增加：

```json
"outcome": {
  "requiredChecks": [{ "name": "tests", "appId": 12345 }],
  "reviewerIds": [67890], "minApprovals": 1,
  "timeoutMs": 10000, "freshnessMs": 30000
}
```

上述名称和数字应替换为目标仓库实际要求的 check 名称、GitHub App ID 和 reviewer ID。每次验收重新读取 checks、reviews、PR 和 branch，要求同一提交 head、全部指定 checks 成功及足够当前评审通过；pending 或截断结果不能完成目标。至少配置 `maxActions: 7`（读取初始 head、commit、PR、四次验收读取），重试与后续事件需要额外有限次数。总目标时长还须覆盖步骤执行、本地验收和 `outcome.timeoutMs`。

需要等待 CI/评审变化时，同一 `repositoryDelivery` 可显式增加 `events`：

```json
"events": {
  "credentialHandle": "github-observe",
  "maxPolls": 180, "maxFires": 4,
  "pollIntervalMs": 2000, "requestTimeoutMs": 10000
}
```

须安装匹配版本的 EventTriggers，且上述 Keychain handle 已允许 `dsh-enhanced-event-triggers` / `github.observe`。CLI 创建绑定当前 owner、仓库及分支的正式来源、有限无模型 observer 和 Goals 等待权限；Goals 向模型公开当前授权范围内的来源 ID。设置不会验证远端连通性。`maxPolls` 必须大于 `maxFires`，`maxGoalRounds` 至少为 2；`maxActions` 须覆盖 `3 + 12 × maxGoalRounds`（每轮最多三次四读验收），显式 wake 的 `maxRuns` 至少为 `maxFires + 1`。不足时拒绝配置，不自动扩额。观察期限沿用明确的 `repositoryDelivery.expiresAt`，重复设置不续期。完整真实 GitHub 生命周期仍须实际验证。

每个验收 profile 的验证窗口为 `verification.maxDurationMs × verification.cases.length`，必须小于 `stepMaxDurationMs`。未配置仓库 outcome 时两个 profile 都使用该窗口；因此 `executionBudget.durationMs` 必须严格大于 `stepMaxDurationMs + 2 × 验证窗口`，以覆盖 native round、step 验收和 whole-goal 验收。setup 会拒绝不足的明确预算，不会自动扩大时长或权限。

该精确 Session 仅用于核验 owner 和可选 wake route；生成的 profiles 绑定 owner、scope 和 objective。setup 只写入并复核本地配置、已有 owner snapshot 与持久 grant；它不发 DeepSeek 请求、不创建 Goal、不证明凭据可用、网络连通、模型质量、隔离验收成功或完整 WP17/长期自治已经完成。grant 已过期、撤销、耗尽，owner/version 改变，或 Session 有 pending/dispatched/unknown lease 时必须先按正常运维流程处理，不能靠重跑此命令续权。

发布文件同时包含 `dsh-autonomy-doctor --profile web`。此 CLI 读取有效 profile 和当前 Delivery owner、Isolation grant/累计预算快照，再运行独立的固定 Docker 探测，最后复核配置/授权没有失效；不会开启第二个 Host、配对 owner、迁移数据库、续期 grant 或重置预算。使用 SQLite 只读连接，不读取凭据/业务产物，也不请求模型。缺失或不支持的 schema、owner 版本改变、撤销、过期、耗尽和配置不一致都失败。当前支持 Delivery schema 20、Isolation schema 6 和安装器的单一受管 grant；要求匹配本批源码的 Isolation diagnostics API，缺失该 API 时明确要求升级，不回退到忽略持久授权的探测。新 bundle 尚未发布，正式发布时需保持实际首发版本与 peer 下界一致。

结果只说明有限隔离检查，不能替代动态 Policy、实时资源准入、模型硬预算、Goal 验收或外部 Actions 检查。该 CLI 的临时探测使用现有 Isolation 资源边界和清理规则；未知清理保留证据，不消耗业务 grant。

要为这份目标配置启用原生策略建议，可在私有 admission JSON 中增加 `"strategy": { "maxRunsPerGoal": 4 }`。setup 写入有界策略配置及精确 owner/workspace/preset 的 `goal_strategy`/`delegate` 规则；启用 wake 时同样覆盖该目标的后台路径。父子模型调用共用原来的 `executionBudget`，不会增加预算或延长隔离授权。省略该字段保持默认关闭。重新启动 Host 后生效；策略建议仍需原有独立验收，不能直接作为目标完成依据。

### 有限 repair admission

当 profile 启用了 Isolation 时，repair setup 会为 Skills 写入依赖该服务的
Cordis `inject`，并保留已有注入配置。Host 崩溃后，隔离控制器可能需要等待旧的
30 秒租约自然到期；在隔离服务就绪前，修复流程保持等待，避免提前恢复后随
Host 启动失败而中断。未启用 Isolation 的独立 Skills 安装不因此新增依赖。

停止目标 Host 后，在已安装并完成普通 owner setup 的目标 profile 上运行：

```sh
dsh-web-owner-setup --profile web --workspace /absolute/workspace \
  --repair-admission /private/repair-admission.json
```

admission 文件必须是 workspace 外部的 canonical、owner-only（`0600`）普通 JSON 文件，大小不超过 1 MiB。顶层**只**能有 `repairProfiles`、`externalHoldouts` 与 `ownerRouteId`：

```json
{
  "ownerRouteId": "existing-owner-route-id",
  "externalHoldouts": [{ "...": "complete Skills external-holdout profile" }],
  "repairProfiles": [{
    "id": "repair-profile-id",
    "scope": {
      "principalId": "web/web/local/operator",
      "principalRecordId": "current-owner-record-id",
      "principalVersion": 1,
      "workspace": "/absolute/workspace",
      "preset": "standard"
    },
    "skillName": "saved-skill", "taskFamilyId": "family-id", "description": "bounded repair",
    "externalHoldoutProfileId": "holdout-id", "provider": "traex-agent", "model": "model-selector",
    "allowedTools": ["read", "write"], "maxGoalRounds": 1, "maxModelCalls": 4,
    "maxToolCalls": 8, "maxOutputTokens": 4096, "maxDurationMs": 300000,
    "canaryRuns": 1, "maxCanaryRuns": 2, "maxIterations": 1
  }]
}
```

`externalHoldouts` 中每项必须是完整的已发布 Skills external-holdout profile，不能用上例的占位对象。每个 repair profile 只能使用上述字段；可选 `followupProfileIds` 和 `bindings` 也必须符合 Skills contract。`scope.principalId` 必须为 `web/<profile>/local/operator`，其 record id/version、workspace 与 preset 必须精确匹配当前 owner 和命令参数。`allowedTools` 至少一个，且不能包含 `skill_*`、`goal_create`、`goal_control`、`set_goal` 或 `update_goal`。

命令只读核验 account 精确等于 `--profile` 的 current owner lineage、已有 owner route、Goals 有限 calls execution budget（model calls、tool calls、时长和每次输出上限）及其精确 provider/model route、Skills prospective holdouts 和 Verifier profiles，然后原子合并有限 profiles/holdouts 并保留已有配置键。每个 profile 的 `maxModelCalls`、`maxToolCalls`、`maxDurationMs` 与 `maxOutputTokens` 都不得超过既有 Goals budget 的对应值。已有 TraeX calls budget 即可；该流程不要求 DeepSeek budget bundle。写入前会重新读取有效配置和 owner lineage，任一变化都会拒绝提交；重复完全相同的 admission 不改变 patch 字节。它不创建 Goal、Session、owner、credential、grant 或无限权限。配置成功不是 repair 验收、canary 成功、模型质量或自主改进成功的证据。
