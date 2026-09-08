# @dsh-enhanced/assistant-verifier

独立核对事先确定的任务验收条件，分别记录执行状态与目标是否达成。验收契约、验证任务和结果回执保存在本地 SQLite，验证重试不会重新执行原任务。

当前已接通前台、Automations 的 AgentLoop 生产入口和 Goals 的可选原生回合入口，以及 Evaluation canonical 判断和前台/Automation owner 反馈修订，尚未正式发布。工程验证与完整自治目标的剩余工作见 [实施账本](../../docs/agent-autonomy-implementation.md)。

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
