# @dsh-enhanced/assistant-verifier

独立核对事先确定的任务验收条件，分别记录执行状态与目标是否达成。验收契约、验证任务和结果回执保存在本地 SQLite，验证重试不会重新执行原任务。

当前已接通前台、Automations 的 AgentLoop 生产入口和 Goals 的可选原生回合入口，以及 Evaluation canonical 判断和前台/Automation owner 反馈修订，已发布基线与开发增量以根发布账本为准；完整自治目标的剩余工作见 [RSI 当前状态](../../docs/rsi-status.md)。

## 安装与默认行为

本包使用标准 DSH bundle patch，可在同一发布批次可用后安装：

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-verifier
dsh --profile web --dump-config
```

默认配置创建独立账本，但没有验收 profile 或执行权限。`requireAcceptance: false` 时，没有匹配 profile 的任务继续原有执行路径，其结果不会由本插件授予可信成功。启用 `requireAcceptance: true` 后，已支持的 Host 入口必须在提交任务前取得匹配的验收契约；缺少 owner 身份或验收配置会阻止该次提交。它不拦截第三方绕过 Host 入口的任意代码。

本包接入 Delivery 的普通前台 AgentLoop 任务，以及 Automations 的 production AgentLoop 任务，原始目标分别来自入站文字与已批准 definition 的 prompt。`/stop` 等控制命令、preview 和独立的 Host runbook executor 不在这个入口范围；它们继续使用各自的执行协议。Host runbook 没有原始用户 prompt，不能用生成的文字冒充其目标契约；该类执行也不能作为行为学习的目标样本。

同一 Delivery/Automations 服务生命周期内，一旦注册过必需验收，验证器短暂卸载或重新注册为可选都不能降低要求。缺失时停止新提交；恢复验证器后继续。管理员永久关闭必需验收需要调整 Host 配置并重启相应生产服务。

Goals 原生回合使用显式 `task-acceptance/v2` / `task-verification/v2` 和 `taskKind: goal-step`，绑定目标定义、step/run、原 Session 与 native goal/revision。前台和 Automation 保留 v1。整体业务目标使用独立的 v3 `goal-outcome`，绑定定义摘要、原 Session/GoalId 和 assessment ID，不伪造 step/run/revision。启用 Goals `verifyNativeRounds` 后，该生产者总是要求精确的 goal-step profile；owner 反馈修订协议仍仅覆盖原有两种任务，不会把目标步骤错当普通前台。

## 验收配置

`authorities` 是管理员控制的验证资源，`profiles` 是管理员确认的精确任务规格。每个 profile 绑定 `scope.workspace`、`scope.preset`、真实 owner 的 `principalRecordId`/`principalVersion`、`taskKind` 和原始 `objective`，并包含版本、有效期、验证预算及非空条件集合。更改已接受任务的规格会被拒绝，不能在看到结果后放宽要求。

| 类型 | 读取或执行内容 | 能证明的范围 |
| --- | --- | --- |
| `runner` | 固定程序、固定参数、明确环境变量、workspace 产物和有限 stdin/stdout | 指定输入的实际输出和退出码同时符合预期 |
| `document` | workspace 文档、配置的 HTTPS 来源 | 指定文字存在；直接引文、来源 URI 与字节摘要匹配 |
| `readback` | 固定 HTTPS 模板，仅替换一个路径段的对象 ID | 目标 ID、可选版本和指定 JSON Pointer 字段符合预期 |
| `repository-readback` | 通过当前 Actions grant 与 Keychain 读取实际提交的 checks、reviews、PR、branch | 准确 head 的指定 checks/评审符合配置条件 |

通过 `createVerifierAuthorities({ authorities })` 得到冻结配置和每个资源的 `digest`，将 `{ id, digest }` 填入条件的 `authority`。profile 类型为包导出的 `AcceptanceProfile`，条件格式来自 `@dsh-enhanced/task-acceptance-contract`。资源变更会改变摘要，旧契约不能悄悄使用新资源。

可信 Host 可用 `inspectAcceptanceProfile({ scope, owner, objective, taskKind })` 查询精确配置，返回独立深冻结的 `{ profile, digest }`，无匹配返回 `null`。参数不允许缺字段、额外字段或 getter；objective 保持精确文本，不默认选择 owner 或 task kind。`inspectAcceptanceObjectives({ scope, owner, taskKind })` 使用相同的严格输入规则，返回该边界内去重并冻结的原始 objective 数组。它不返回 profile、criteria、验证命令或输入，也不越过 scope、owner record/version 或 task kind 发现其他配置。两个入口都不创建契约、不调用执行生产者或验证程序，不是授权或目标达成证明；服务卸载后拒绝查询。可用于安装配置诊断和提交前预检，真实执行仍必须取得绑定到实际任务身份的验收契约。

`databasePath` 是私有 SQLite 文件绝对路径；默认 `dshHomePath('assistant-verifier/verification.sqlite')`。`tickIntervalMs` 默认 5000，0 表示由 Host 调用 `tick()`。契约最长有效 7 天，单轮验证最长 5 分钟，不确定的验证最多尝试 3 次。无法证明执行已停止、契约过期或尝试耗尽时保留待处理状态；Host 通过 `inspect(contractId)` 和 `continuations()` 查看。需要把回执逐项绑定到完整已接纳契约的 Host，可同步调用 `inspectAcceptedTask(contractId)`；它仅在契约和状态都存在时返回冻结的 `{ contract, ...state }`，不会把单独的回执状态当作验收证据。过期回执不会作为新的可信结果投递。

回执描述该次任务在观测时刻的结果，`validUntil` 限制结果进入 Evaluation 的时间。已接纳的历史结果不会仅因时间流逝被改写；它不证明外部系统现在仍处于同一状态。持续目标、发布或权限决策需要自己的新鲜度要求及新契约回读。owner 的显式纠正与撤回仍可修改 canonical 判断。

`health()` 给出准确的等待执行、等待验证、未投递回执、过期回执和待处理数量。配合 `assistant-health`，待处理结果或缺少 Evaluation 的积压会显示诊断；默认空 profile 显示验收未启用。分页轮转避免前 100 条未完成任务或过期回执阻塞后续任务。Host 回读与 Evaluation 投递各等待最多 5 秒，关闭服务会中断等待；失去确认的回执保留待投递，原任务不会重跑。

## 权限与数据

- **文件系统**：读 workspace 下指定普通文件，拒绝符号链接与越界产物，限制大小并核对读前后身份。写独立 SQLite 主文件、WAL、SHM。账本包含目标、预期字段与证据引用，应按私有任务数据保存。
- **网络**：获取配置来源或精确目标，不跟随重定向，不接受 URL 凭据。HTTPS 默认；`allowHttpLoopback` 仅显式允许本机 HTTP。它不是进程级网络隔离。
- **子进程**：固定程序和参数，末尾追加私有只读产物快照路径，工作目录保持原 workspace；不用 shell，不继承环境凭据。快照只涵盖指定文件，按产物自身路径解析的相对 import 不再指向原目录，因此该驱动适用于明确的单文件输入检查。时间和输出有上限，超时尝试终止所建 POSIX 进程组并关闭本方管道，有界返回 unknown；逃离进程组的后代不保证已停止。可执行文件 SHA 检查与实际 spawn 仍是两个操作，不提供原子执行身份保证。
- **凭据、浏览器、安装脚本**：没有通用凭据或浏览器接口，没有额外安装脚本。仓库认证回读通过 Actions 的受保护 broker 与短凭据租约完成，不应把密钥写入 profile。

执行产物代码仍使用 Host 的 OS 用户；进程组、摘要和进程内 capability 不能防止同 UID 恶意代码修改授权器、期望、数据库或读取其他文件。插件也不证明所有程序输入正确、未列出的文档陈述属实或一般性的目标完成。高权限代码隔离与受保护评测须完成工作包 08–10。

文件路径检查拒绝读取时发现的 symlink，但 Node 的逐段检查无法消除恶意并发替换父目录的窗口；固定 runner 的解释器参数所引用的额外文件也不纳入单 artifact 摘要。当前应只使用管理员维护的 runner 与合作式任务，不能将其接纳结果当作不可信自生成代码的发布安全证明。

## 兼容性

遵循 [兼容基线](../../docs/compatibility.md)。实际 Host producer 须实现 `TaskAcceptanceProducer`，Evaluation 须实现对应私有注册协议；仅安装名称相同的旧版本不会获得新接口。模型不能通过公开工具创建可信验收结果。

测试使用实际文件、SQLite、子进程和本机 HTTP。组合测试通过真实 owner 配对、前台 AgentLoop、Automation 提案审批与调度入口验证契约先于模型调用落库，以及反馈纠正、撤回和服务卸载恢复；模型与外部 transport 仍为确定性替身。单元测试的 producer fixture 本身不作为生产接线证据。仓库验收为根 `pnpm check`，真实外部系统、隔离运行和长期收益另行验证。

Goals Host 的 `prepareGoalAssessment(input, template)` 从已持久化的初始 v3 契约派生新 assessment，完整保留条件、profile、验证预算和绝对有效期。模板身份、owner、定义或当前 profile 摘要改变会拒绝。v3 验证结束后再次读取同一 Host 的执行证明和注册代次，失效或不同的证明产生 unknown，不能签发 achieved。该能力不对 Delivery、Automations 或模型工具开放。

## 隔离代码产物验收（v4）

`isolated-process-behavior` 只用于 `goal-step` / `goal-outcome`，使用 `task-acceptance/v4` 与 `task-verification/v4`。条件包含 `id`、`authority: { id, digest }`、`artifactPath`、`testSetId`；不允许与旧 criterion 混用。v1/v2/v3 的原有格式和摘要保持兼容。

对应 Host authority 为 `isolated-runner`，配置固定 `stateRoot`、已存在的 `sha256:…` 镜像、绝对 `dockerPath`、固定 `command`、绝对 `expiresAt`、`maxRuns`、`maxTotalDurationMs`、`maxDurationMs`、`maxOutputBytes`，以及 `testSets: [{ id, cases: [{ stdin, expectedStdout, expectedExitCode }] }]`。例如固定命令 `/bin/sh /workspace/artifact < /workspace/input` 在容器内运行复制的 shell 产物。authority 摘要覆盖全部配置和测试向量；验收 profile 必须引用编译后的精确摘要。不能把模型生成的测试向量当作 Host 验收条件。

预期结果只保存在 Host authority 中。容器每次只收到 `artifact` 和当前 `input`；模型反馈、契约、回执不包含测试输入或预期输出。反馈会披露有限的通过/失败信息，这不是密码学意义的测试集保密。

此能力需要同一 Host 中已启用的 `assistant-isolation`，它是可选 peer；普通验收不自动安装或激活 Isolation。Verifier 通过当前 Goals producer 找回真实 step acceptance，再核对 owner、workspace、preset、Session、原生目标、定义与 run。产物只能来自该次 admitted native round 派发前绑定的 Isolation job；新的失败/unknown 产物尝试会遮蔽旧成功，已清理正文或缺少 provenance 时返回 unknown。whole-goal 使用其持久 `triggerRunId`，不能换成上下文 focus 的目标。

独立验收使用另一私有 stateRoot 和 Isolation 持久控制器、资源池与预算，不使用模型 Agent 身份，也不在 Host 上执行产物。每测试用例的幂等键绑定契约、criterion、源 job、内容摘要、authority、testSet 和序号。相同 key 重读已知结果；派发不明的任务保留 unknown 和占用，重启不重放。更改配置不会自动扩额或续期；需要 operator 明确处置私有账本和未确认的运行资源。Docker 文件系统、网络、子进程和凭据边界与 Isolation 一致；Host 插件和同 UID 管理者仍属于可信控制面。

## 仓库整体验收

`repository-readback` authority 固定 `grantId`、`grantRevision`、`repository`、`branch`、`baseBranch`、`requiredChecks: [{ name, appId }]`、`reviewerIds`、`minApprovals`、`timeoutMs`（最多 30 秒）及 `freshnessMs`（最多 60 秒）。使用现有 v3 `goal-outcome` 的 `target-readback`，`objectId` 必须为准确的 `repository:branch`；以 `/ready` 等于 `true` 作为目标条件。正式配置入口见 WebOwner README。

此路径需要当前 Actions 可选 Host peer。Actions 从已验收步骤的持久交付结果选择实际 commit/PR，绑定原 Goal/Session、owner、定义及当前 assessment；允许后续回合验收较早步骤的交付。每次验证通过既有动作账本分别消耗四次读取额度，逐次重查授权与来源；不会从旧成功结果绕过新的 pending/unknown 交付。没有当前成功且 quiescent 的执行证明不签发成功。

待运行 CI、待评审、截断数据或无法认证返回 unknown；失败 CI/请求修改不能通过 `/ready`。回执有效期从读取开始计时，最多为 `freshnessMs` 且不晚于契约到期。回执仅描述这次观察，不能证明远端之后不变，也不自动配置事件订阅。测试覆盖真实 Verifier→Actions Host 调用，GitHub 传输为替身；真实远端认证与完整事件跟进仍需验证。

## 新插件包的隔离行为观察

从 `@dsh-enhanced/assistant-verifier/plugin-behavior-runner` 显式导入 `PluginBehaviorRunner`，它是供可信 Host 构造的观察器，未自动激活，也不注册模型工具。主 bundle 不加载可选 Isolation peer；仅使用这个子入口时才需要它。构造参数复用 `IsolatedVerifierRunnerConfig`，省略 `command`；命令由实现固定。必须使用[专用镜像](../../scripts/isolation/README.md)、私有 `stateRoot`、不可变镜像 ID、有限次数与累计时间，`maxOutputBytes` 至少 65536。Host 持有实例并在所属 Cordis effect 的 disposer 中等待 `close()`。

`run({ key, artifact, operation, signal })` 接受真实 tgz 的 `Buffer`：`operation: { kind: 'discover' }` 返回工具 schema 与摘要；`{ kind: 'invoke', schemaDigest, calls: [{ id, toolName, arguments }] }` 仅在 schema 摘要匹配时执行调用。每包最多 512 KiB，每轮最多 8 次调用。两轮分别消耗持久预算，key 须绑定候选、操作与调用输入；派发不明的 key 不重放。

新版镜像的父观察器不导入候选；候选在另一个受限进程中用固定 Cordis、SystemPrompt 和原生 Tools 加载，不提供模拟 Agent、owner 或缺失注入。父进程核对包字节、调用身份和结果大小，自行计算 schema 摘要与环境版本，等候子进程真实退出；候选 stdout/stderr 不作为父观察协议。worker 协议 v2 拒绝旧同进程镜像的 v1 结果，需要重新构建专用镜像。候选没有工具、注入不满足、包非法、超时、结果帧非法或无法确认资源结束时返回 `unknown`。

该镜像目前要求 Linux x64。固定原生启动器在加载候选前设置 `no_new_privs` 与 seccomp，限制文件写入、非线程进程创建、网络和跨进程操作；父进程禁用信号启动调试器并设置 [non-dumpable](https://man7.org/linux/man-pages/man2/PR_SET_DUMPABLE.2const.html)，避免同 UID 子进程重开其受保护的 `/proc` 内存或描述符。设置失败即拒绝运行；容器仍沿用 Isolation 的无网络、只读根文件系统、无 capability 和资源限额，不新增 Host 权限。Node 的路径权限只是额外限制，[官方权限模型](https://nodejs.org/download/release/latest-v22.x/docs/api/permissions.html)并不保证抵抗恶意代码；[seccomp](https://docs.kernel.org/userspace-api/seccomp_filter.html) 不检查路径内容，不能单独当完整沙箱。

容器只收到制品与调用输入；预期结果、验收政策和签名密钥留在 Host。schema 和工具结果仍是候选的黑箱输出；`observed` 与 `quiescent` 只说明本次输出、子进程退出与外层容器回收，不能证明候选按原语义执行了工具或 Cordis disposer，也不能单独证明目标达成或发布安全。可选创建验收见下文；真实加载后的外部观察与自动采用仍需接通。

新增权限为通过固定 Docker executable 写入私有隔离账本、暂存包和输入，在无网络、只读根文件系统且有资源上限的容器内执行候选。运行时不执行安装脚本、不挂载 Host 仓库或凭据。专用镜像准备会联网下载公开系统依赖，随后按完整锁文件离线安装且禁用依赖脚本；详见镜像指南。

## 普通任务产生的新插件验收

`creationReviews` 是可选 Host 配置。Control Plane 复用原生 SourceJobs 续跑调用 `verifyPluginCreation({ protocol: 'assistant-growth/creation-verification-request/v1', planId })`；此入口不注册为模型工具。相关原生服务与可选 Control Plane peer 未就绪时返回 `unknown`，provider 替换或卸载时取消并等待在途验收。

配置必须包括以下字段；owner 是与 `sourceReviews.owner` 相同的七字段稳定身份，不包含每任务变化的 session/binding/generation。完整任务身份仍由 Control Plane 当前来源检查。

| 字段 | 约束 |
| --- | --- |
| `authorityId`, `keyId`, `namePrefix`, `expiresAt` | 明确的有限验收授权，与 Control Plane 创建命名空间和期限一致。 |
| `owner` | `authorityId`, `authorityHash`, `principalId`, `principalRecordId`, `principalVersion`, `workspace`, `agentPreset`。workspace 为已存在的 canonical 绝对路径。 |
| `keyPath` | owner 私有、单链接、非符号链接的 Ed25519 PKCS8 文件；不会交给模型或容器。 |
| `maxVerifications` | 1–1000；失败与未知派发也消费持久额度，不随重启返还。 |
| `runner` | `stateRoot`, `image`, `dockerPath`, `expiresAt`, `maxRuns`, `maxTotalDurationMs`, `maxDurationMs`, `maxOutputBytes`；使用当前锁文件的专用观察镜像。最坏每次消耗 `1 + maxCases` 个独立容器调用。 |
| `policy` | owner 固定的验收政策，最多 8192 字节。 |
| `maxInputBytes`, `maxOutputTokens` | 输入 4096–262144 字节，每个模型回合 1–32768 输出 token。 |
| `maxDurationMs`, `maxCases`, `receiptTtlMs` | 整次验收 1 秒至 30 分钟；2–8 个不同输入；回执 1 秒至 24 小时，受所有原授权窗口收窄。 |

部署前用导出的 `compileCreationReviewConfig(config)` 取得 `{ authority, publicKey }`，只将这两个公开字段写入 Control Plane 的 `creationVerifications`。验收政策、固定规则、密钥指纹、镜像及预算纳入 authority digest。Growth 在首次作者模型请求前持久冻结这个引用；历史无引用的候选不会取得新签名资格。

封存精确 tgz 后，第一轮全新、无工具的原生 Agent 从当前认证任务/纠正正文与候选参数结构生成私有用例；不读取候选代码、测试或调用结果。schema 的说明文字不进入此轮。Host 在调用前持久保存用例，分别在独立子进程执行并精确比较文本或 JSON 值。第二轮全新 Agent 检查实际已核对的源码补丁、任务语义与固定用例；两轮均使用来源 Growth run 的准确模型，不增加默认供应商或隐式恢复切换。

只有实际比较通过、源码审查通过且最终当前来源 fence 有效，才签发 `assistant-growth/creation-verification/v1` Ed25519 凭证。它绑定任务修订、Growth run、精确源码/制品、私有合同摘要、观察作业、SDK 环境、模型和预算。私有 SQLite 在每次派发前持久 claim；崩溃、取消或不明执行不自动重放。含糊任务、不可支持的行为或缺失证据保持 `unknown`。

生成用例与源码审查仍依赖模型语义判断；剥离 schema 说明和禁止工具不证明模型判断总是正确。此凭证仅证明这些任务派生检查通过，不是 owner 审批、通用目标成功、发布许可或采用授权。Control Plane 仍保留 `pending-approval`；之后的有限采用、Cordis 动态加载及真实后续收益必须分别验收。

新增数据与权限：读取当前 Host 认证任务和检查补丁，向该任务模型供应商发送这些材料；写私有合同、观察摘要、模型 Session、有限额度与签名账本；读取私有签名密钥，并通过固定 Docker executable 执行封存候选。没有浏览器或运行时联网容器权限，没有安装脚本或公开验收写工具。

## 已采用插件的新任务修订验收

`revisionReviews` 是可选、独立的 Host 配置，字段及限制与上表 `creationReviews` 相同；须单独配置修订 authority、Ed25519 密钥引用、政策和有限额度，密钥文件可与创建验收共用，但两种用途不能互相代用。用 `compileRevisionReviewConfig(config)` 取得 `{ authority, publicKey }`，仅将这两个公开字段交给 Control Plane 的 `revisionVerifications`；还须配置其独立的 `sourceJobs.revision` 授权和保留的已采用父版本源码。`revisionReviews` 缺省时不启用本轨，不借用创建验收引用或额度。修订 authority 使用 `assistant-growth/revision-acceptance-authority/v1` 和独立政策摘要，私有账本位于 `databasePath + '.revision-reviews'`；失败与 unknown 派发也占用修订额度，未知结果不自动重放。

新的普通认证失败任务经 Growth 冻结 `revisionAcceptance`、原任务模型及预算，并选择同 owner 已采用父版本后，Control Plane 原生 SourceJobs 才能调用 Host-only `verifyPluginRevision({ protocol: 'assistant-growth/revision-verification-request/v1', planId })`。它不注册为模型工具。Host 重新核对当前 owner/任务、父版本签名归档、精确源码基线、父绑定及封存制品；任务纠正、撤回、授权或 provider 变化会使旧验收失效。父绑定含 `planId`、`certificateDigest`、`artifactSha256`、`sourceArchiveDigest`、`sourceDigest`，并同时进入持久 claim、最终 fence 和凭证。

验收沿用两个全新的无工具原生模型回合与有界 Docker 行为观察：先依据这次任务和工具结构生成私有用例，不看候选源码；再对实际补丁、已观察用例及父绑定作源码审查。两轮使用这次新任务冻结的 supplier，另受 `revisionReviews` 的独立模型调用、输出和时限预算约束。通过后签发独立 `assistant-growth/revision-verification/v1` Ed25519 凭证，绑定父版本、当前任务、Growth run、精确制品/源码、观察环境与结果；修订签名域与旧创建凭证不互通。验收仅覆盖本次新任务及这些检查，不能推断父版本全部行为已回归通过。结果保留为 `prepared-revise` / `pending-approval` 候选；本阶段不授权执行、替换当前版本、扩大旧创建采用额度或声称版本回滚与后续收益已验证。

## 独立源码审查

`sourceReviews` 是可选 Host 能力，供 Control Plane 的 `sourceReleaseExecution.independentReview` 调用。复用当前 DSH `agents`、`sessions`、`tools`、`llm`、`systemPrompt` 与 `assistantPolicy`，不新增调度器。缺少这些服务时保持未就绪，依赖替换或卸载会取消并等待当前审查。Host 在 PR 前检查精确 owner、插件、模型、目录与剩余额度；已存在的 operation 可进入终态恢复核验。

```yaml
sourceReviews:
  authorityId: owner-source-review-1
  expiresAt: 1790000000000 # 必须替换为本次授权期限
  maxReviews: 10
  repository: /private/owner/source.git # 固定 bare remote，与 release PR 仓库一致
  git:
    path: /usr/bin/git # canonical executable
    sha256: <git-executable-sha256>
  decisionRoot: /private/owner/review-decisions # 已存在、0700，与 Control Plane/review adapter 相同
  plugins: [personal-memory]
  owner:
    authorityId: <delivery-owner-route>
    authorityHash: <owner-authority-sha256>
    principalId: <owner-principal>
    principalRecordId: <owner-record>
    principalVersion: 1
    workspace: /private/owner/workspace
    agentPreset: primary
  reviewerPrincipal: source-reviewer
  policy: Check the actual task, correctness, regressions and Cordis resource ownership.
  maxChangedFiles: 30
  maxInputBytes: 262144
  maxOutputTokens: 4096
  timeoutMs: 120000
  # 不填 model 时继承原任务的 provider/model/reasoningEffort；缺失或不一致则等待。
  # model: { provider: super-relay, model: day1 }
```

Host 独立读取精确 PR ref、单一 base parent、改动范围和已检查 tree/patch digest，再给全新、无 preset、无工具的原生 Agent 审查。候选代码和任务文本仅作为不可信数据；固定政策、模型、一次调用、输入字节、输出 token、期限与累计调用数构成审查边界。完整 `completed` 回合、用量和严格 JSON 结果缺一不可；源码审查不等于行为改善证明，后续构建、签名和采用仍有各自检查。

持久账本位于 `databasePath + '.source-reviews'`，目录须私有且 canonical。调用前落 claim；崩溃、取消或不明确结果不会自动重调模型。相同授权下的已完成批准可在再次核对来源与 PR 后恢复同一 decision 文件；改变政策、模型、目录或额度须使用新的授权标识。拒绝不会写批准文件。已 claim 的未知调用需要管理员核查本地 Session/账本，Host 返回的 `sessionId` 可定位该请求的原生会话；当前没有自动重审或模型自我批准入口。

新增权限为：读取固定 Git executable/仓库、执行受限 Git 读命令、经 Host 模型供应商发送任务目标与补丁、写私有 SQLite/Session/decision。模型不能读取凭据、执行命令或写文件。该进程内工具边界不构成 OS 隔离；候选构建与 decision 写权限必须由部署隔离。原始任务、补丁、审查输出和账本留本地，不提交到 GitHub。

## 普通任务记忆候选审查

可选 `memoryReviews` 提供 Host-only `reviewMemoryLearning(request, signal?)` 与
`lookupMemoryLearningReview(request)`。调用者只传共享库的候选和来源定位，不传入批准结论。
Host-only `inspectMemoryLearningReviewAvailability({ owner })` 返回当前配置授权的
`authorityId`、`authorityDigest`、`expiresAt`、`remainingReviews`、`available`。
它核对完整 owner 与当前 Delivery route、Policy 及私有账本；首次 claim 前显示配置上限，
到期、服务缺失、授权变化、账本损坏或额度耗尽时不可用。查询只读，不建立 claim、
消耗额度或调用模型；历史 unknown 仍须按原 operation ID 精确查询，不能通过该探针重派。
Verifier 独立读取 Delivery 原任务、普通回复与当前 owner；经验还须绑定当前 canonical
结果，允许保留失败经验。事实引用只能来自 owner 原文，任务未获目标结果不妨碍审查事实，
明确的 owner 撤回则会阻止审查。替换/删除还需 PersonalMemory 的 exact managed target reader；
缺少该服务或目标版本不符即拒绝，不把手动记录交给模型自动接管。

`memoryReviews` 必填字段为 `authorityId`、`owner`（同上七个 owner 字段）、`expiresAt`、
`maxReviews`、`policy`、`maxInputBytes`、`maxOutputTokens`、`timeoutMs`。`model` 可选，
默认继承原任务冻结的供应商、模型和推理强度。最多 10000 次审查、128 KiB 输入、8192 输出
tokens、每次 5 分钟；配置更改不能给原授权续期或补额度。Policy 还必须允许精确 background
subject `assistant-memory-learning`（绑定 workspace/principal），action `review`、memory resource
`learning:<authorityId>`；可通过该规则的持久预算进一步限制调用。未配置时没有默认审查权限。

原生审查使用新会话、固定规则和零工具，每次至多一次模型调用。它只判断候选是否受来源支持，
不证明事实在现实中为真或后续任务得到改善，也不直接写入 Memory。完整原文被截断时拒绝审查。
`.memory-reviews` 私有 SQLite 使用独立授权和持久 claim；重复调用/重启只回读既有结果，unknown
不重派。来源、owner、canonical 状态与目标版本在结束后重验，批准落盘使用
Delivery → Evaluation → review ledger 同步 writer fence；卸载会先取消并等待在途审查。

普通任务的自动发现、提取与调度见独立 [assistant-memory-learning](../assistant-memory-learning/README.md)；
有限采用与下一任务召回由 [Memory](../personal-memory/README.md) 负责。批准回执不能替代采用时的当前来源与权限检查。新增数据权限仅为读取这些
owner 来源/受管理目标，经既有 Host 模型供应商发送有界文本，并写私有审查账本和原生会话；
无新增浏览器、子进程、凭据读取或安装脚本权限。
