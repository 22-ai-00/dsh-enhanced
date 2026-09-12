# 仓库架构

## 为什么采用多包仓库

DSH 当前把可安装插件定义为 profile bundle：包的 `dsh.bundle.patch` 指向一个 patch 层，用户通过 `dsh plugin --profile <name> add <package>` 安装后，该层进入 profile 的有序 bundle 列表。由此，本仓库以“一个用户可启用能力对应一个 npm 包”为发布边界。

这一边界带来三个结果：

- 插件可以独立安装、回滚和审计；当前仓库级 release 会统一推进所有包的版本。
- 每个插件保持独立 npm 包边界，但一次整体发版仍会校验并发布全部包；中途失败按下文的同 tag 重试协议恢复。
- 共享实现可以进入 `packages/*`，但共享库没有 `dsh.bundle`，不会意外激活。

## 层次

```text
DSH profile
  -> 已安装 bundle 的 cordis.patch.yml
    -> plugins/<name> 的 Host/Cordis 入口
      -> 可选 packages/<name> 共享库
      -> 可选 Web client 入口
```

`plugins/*` 是产品层，`packages/*` 是复用层，`templates/plugin` 和 `scripts/*` 是工程层。根脚本只负责编排，不包含插件业务逻辑。

## 插件包最小契约

每个插件至少包含：

```text
plugins/<name>/
  src/index.ts
  src/version.ts
  tests/index.spec.ts
  package.json
  cordis.patch.yml
  tsconfig.json
  tsconfig.build.json
  README.md
  LICENSE
```

`package.json` 的 `dsh.bundle.patch`、`files` 和 `exports` 必须覆盖 patch 与构建产物。`cordis.patch.yml` 使用稳定 `id`，并通过发布后的包名挂载入口；加载顺序由 Cordis service injection 决定，而不是 YAML 行序。

## Host 与 Web 双端插件

普通插件只有 Node/Host 入口。需要改动 Web UI 时，一个包通常同时拥有 Host 与 browser 两半：Host 提供数据/RPC，browser 入口通过 `dsh.client` 声明 `platform: web` 和依赖边，并从 `exports["./client"]` 发布已构建的客户端文件。

双端模板尚未固化，因为它依赖具体 UI slot 和 Host contract。创建这类插件时应先在当前 DSH 源码中确认 client module manifest、目标 slot/service 及构建产物，再把可复用形态提炼成新模板，而不是扩张基础 Host 模板。

## 分发

本地开发可以把 `plugins/<name>` 目录链接进 profile。正式分发以独立 npm 包或预构建 tarball 为准。Git package 安装以仓库根为包边界，不适合作为多插件子目录的默认分发方式。

发布由 tag 驱动的 CI 自动完成。维护者先用根目录的 `release:prepare` 统一更新仓库版本和 `release-manifest.json` 的 `pending`，验证后合入 `main`；发布标签必须严格为 `vX.Y.Z`，必须从当时的 `origin/main` HEAD 创建，而且版本必须等于 `pending`。GitHub Actions（`.github/workflows/release.yml`）检出这个精确 tag，而不是移动中的分支，并在发布前要求 tag peeled commit 仍等于当前 `origin/main` HEAD。它还会验证 current/history/pending 的账本顺序、根版本、pending 包集合与全部 `plugins/*` / `packages/*` 目录一一对应，且每个包的 manifest 和运行时版本都一致；`src/version.ts` 只允许单一稳定字面量导出。任一条件不满足都会 fail closed。

发布阶段必须使用 pnpm，让 workspace `catalog:` 依赖在上传前转换为实际版本；插件的 `prepublishOnly` 会拒绝直接使用 npm 发布。当前新包首次发布以 GitHub Environment `npm-release` 中的 `NPM_TOKEN` 作为 bootstrap 凭据，该 secret 应是有期限、最小包范围的 granular access token；environment 必须配置 required reviewers 和允许的部署分支/标签。workflow 在发布前验证 token 非空并执行 `npm whoami`。新包完成首次发布和 npm 侧配置后，可以迁移到 trusted publishing/OIDC，但当前流程不擅自启用 OIDC。publish job 只有仓库只读权限，持有写权限的 record job 不安装依赖且拿不到 npm token；本地 record 脚本执行步骤也不注入仓库写 token。

`release:publish` 紧前会再次检查 tag、`origin/main` 和 tracked index/worktree；未跟踪构建产物不影响发布，但任何 staged/unstaged tracked 改动都会拒绝。发布成功后，`release:record` 复用同一套版本与包集合校验，只更新 `release-manifest.json`：提升 `current`、追加 `history` 并清空 `pending`。workflow 只提交这个账本文件，并在推送前再次确认 `origin/main` 没有从发布源码提交前进。按下述 immutable tag ruleset 部署后，tag 会稳定指向发布源码，而账本记录位于其后的独立提交；workflow 自身不创建也不移动 tag。

这些远端复核只能缩小 TOCTOU 窗口，不能证明检查与 npm registry 写入之间具有原子性。仓库必须为 `v*` 配置 immutable tag ruleset（禁止删除和 force-update），发布期间冻结 `main` 合入，或让所有 main 写入者共享一个会实际阻塞写入的互斥机制；protected environment 的审批只能约束 job/secret 使用，不能单独锁定分支。递归 npm 发布也不是原子事务；暂时性失败应通过 Actions rerun，或用 `workflow_dispatch` 输入同一个现有 tag 重试，不能创建替代 tag 或改变 pending/source。整体发版统一推进版本，同时仍保留每个包作为独立 npm 安装、回滚和审计边界。

## 持续目标上下文

`assistant-goals` 是独立、可移除的业务 bundle。DSH `goals` 仍拥有原生状态、revision、轮次和 activation；本插件只在真实 Delivery owner 当前人类 turn 创建原生目标时绑定不可变 owner lineage，保存目标原文、原生状态投影与未验证的规划笔记。它不复制 AgentLoop、调度器或原生 goal 状态机。

业务记录以原 SessionId + GoalId 确定身份，scope 包含 principal record/version、workspace 和 preset。当前会话的 focus 是业务数据库中的引用，可以读取同 owner 其他会话的上下文，不改变原生执行归属。卸载插件不留下无法被标准 Session reader 识别的自定义事件。原生 `complete` 显示为待验收，不能写入可信 achieved；后续目标编排须复用 Automations 的持久唤醒与 Verifier 的独立结果协议。

原生回合累计预算仍属于 `assistant-goals` 独立 bundle：可信 Host 注册精确模型路由的计量声明，插件在现有 `llm/stream` 与 `tools/execute` 管线执行预留和计数。私有 `.budgets` SQLite 以 owner scope + 业务目标 ID 保存不可变上限、绝对期限和 held/settled 记录；不与普通前台或账户级预算混算。它不创建模型循环或持久调度器；未来自动唤醒复用 Automations，并须与 Delivery 前台共享持久 Session 排他和后台 owner 证明，不能直接复用会创建新 Session 的普通 Automation runner。

Delivery 内置运行时通过同一 schema 19 Session lease 表序列化 active binding 的恢复与绑定前 construction，Session ID 是最终排他键。新会话的持久身份在 binding 写入前就固定，released orphan 不允许换主体接管。生命周期由原生 AgentLoop 驱动；lease 不负责调度，过期的 dispatched/unknown 也不授予恢复权限。未来 Goals wake 必须接入同一 gate，与前台共享排他，再按既有 Automations 的持久任务意图派发。


## 离线隔离执行

`assistant-isolation` 作为独立 bundle 接入原生 ToolRuntime，Host 仍拥有 AgentLoop、Delivery owner、Policy、SQLite 授权/结果账本及 detached supervisor。模型的离线任意 shell 代码进入 Linux Docker 容器；每任务使用有字节/inode 硬限制的独立 tmpfs volume，Host 输入经受限复制进入卷，不向容器暴露 Host bind mount、真实项目、Host 状态、Docker socket 或凭据。独立 keeper 持续挂载工作卷，执行容器删除后才由固定 BusyBox 命令导出已验证类型/链接/字节限制的文本产物，最后删除 keeper 与卷。Host 工具路由在配置的 workspace/preset 内拒绝改走通用代码工具，容器内也没有动作或出网代理。

Grant 绑定 owner lineage、范围、期限和次数/预留时长；请求摘要包含镜像与限制，Session 幂等键禁止未知结果重放。单 Controller 的持久 lease/fence 串行化预算与恢复，外部 CLI 先持久撤销再尝试终止容器。包同时发布 `lib/` 与 Node supervisor 的 `runtime/`，前者相对解析后者，不依赖源码目录。可回滚安装不等于回滚已发生的外部动作。

此切片的 Host/容器边界不能替代后续独立动作与凭据 broker、审计保留、生产 bootstrap 或外部补偿。可信 Host 插件仍处于现有 Host 信任域，不能据此声称全部第三方插件已经隔离。

Isolation schema v2 在同一 SQLite 事务中预留 worker memory + workspace capacity + 32 MiB keeper 及工作卷 inode；尚未确认删除全部运行资源的 unknown 保留占用。v1 行迁移后保留，旧活动行用量不明时先恢复清理再接收新预留。资源池只覆盖同一个 stateRoot 的任务，不代表对全机 Docker/kernel 开销的硬约束。


## 受限外部提交 broker

`assistant-actions` 仍是一个独立发布的 bundle，但包含两个明确分离的运行面。Cordis 挂载的 Host facade 注册现有工具、重验当前 Delivery owner 与 Policy，并通过 `actionSocketPath` 把显式选择的外部请求送到 broker；`dsh-actions-broker` 是同一包发布的独立进程入口，不是第二个 Cordis 插件，也不会由 `apply()` 或 import side effect 自动启动。外部模式使用版本化、签名、有界且角色分离的 action/admin Unix-domain sockets；broker 独占 GitHub credential、grant、动作 journal、controller generation 和固定 HTTPS 出口，Host、模型与 Docker worker均不接收 token。

第一阶段外部协议只接受 expected-head commit 与有界 repository/branch/file inspection；pull-request/checks/reviews inspection 只由 embedded compatibility 模式保留。分支创建、PR 创建、补偿/rollback、verified delivery 与 repository outcome readback 也仍只属于显式 embedded compatibility mode；外部模式遇到这些操作、daemon 不可达、协议/签名/代次不匹配或 socket 身份漂移时一律 fail closed，绝不回退到同进程 Keychain 或 GitHub transport。Host 的 deployment mirror 包含嵌套的 owner、destination、期限和预算，以及用于保守 discovery/preauthorization 的 `allowedOperations` 与 `allowedInspectKinds`；external config 对后者只接受 repository/branch/file。投影不包含 credential、client key/identity 或 policy/emergency epoch，且只能收窄 Host 工具可见性和执行前检查，不能扩张 broker 自己保存的 grant revision/digest 所定义的外部动作 authority。daemon grant 还精确绑定 client key、owner lineage 与 Session、source Host instance/generation、destination broker instance、repo/branch/paths、期限、action/byte limits 和有限 `github-api-units` 累计预算；该单位不是金额或 provider billing 保证。`source.classification` / `provenanceDigest` 只是 operator-issued grant 与 Host-signed request 的 exact-match 字段，不是可信内容分类器或 DLP 证明；broker 对所有已配置凭据原文及有限常见 credential-shaped literal 的拒绝也只是纵深防御，不能保证识别编码、拆分或未知凭据。

Broker 在自己的 WAL/FULL journal 中先保存请求，再跨越 `dispatched` 边界，之后至多执行一次固定 GitHub 请求。崩溃恢复把尚未派发的 `prepared` 终结为 `failed`；连接中断、撤权、stop、超时、lost ACK 或崩溃若发生在可能发送之后，结果保持 `unknown` 并禁止自动重放。admin `stop` 是持久 emergency admission stop：拒绝新动作、终结/取消相关在途请求并推进 emergency epoch，但不退出 daemon，admin control plane 保持可供 status/resume；真正停止进程由 service manager、SIGTERM 或 SIGINT 完成。resume 再次推进 emergency epoch，旧请求不会复活；这些控制仍不能撤回 GitHub 已接受的效果。Host Policy 与 broker journal 是跨进程、跨库边界，不假装具有原子事务。容器继续无网络，也不存在通用出网代理。

`serve` 同时绑定 distinct `actionSocketPath` / `adminSocketPath`，并分别固定两端的 parent/socket UID、GID、mode、peer UID/GID 和连接容量；action execution 另有独立并发上限。action endpoint 可由部署系统通过专用 group 或等价 ACL 开放给独立 Host UID，admin endpoint 则保持 broker/operator 私有。两套 listener、连接集合与容量彼此独立，action 连接池或执行并发耗尽不能占用 admin 的保留准入容量；协议也拒绝在错误 endpoint 上使用另一角色的请求。`serve` 与 admin 命令读取不同的 owner-only 配置：前者持有 admin public key，operator 配置仅指向 `adminSocketPath` 并持有 admin private key。server、Host client 与 admin 三把 Ed25519 key material 必须两两不同，即使位于不同路径，相同 material 也会在 bind 前拒绝；client/admin key id 也必须不同。包依赖提供基于 `koffi` 的固定 Linux `getsockopt(SO_PEERCRED)` 检查；daemon 对 action/admin 客户端分别固定 peer UID/GID，Host 与 operator 客户端也各自通过 required `expectedBrokerPeerUid`/`expectedBrokerPeerGid` 固定 daemon 身份。客户端完成 pathname identity 双检后、读取 signed hello 前执行内核 peer 检查。非 Linux、native binding 不可用或 peer 身份不匹配时 fail closed，其中平台/binding 可用性在 bind/connect 前验证。

这些 socket access control 与进程分离本身不等于独立 UID。若 Host 与 broker 以同一 UID 运行，同 UID 恶意进程仍属于威胁边界之外。生产隔离需由部署系统分配独立服务身份、不可由 Host 写入的 broker 状态及 Linux protected-file credential，以及受控 IPC 权限；broker 不从环境取得 token。本包只发布 daemon executable，不创建或管理独立 UID、systemd unit、密钥、凭据、基础设施或真实 profile 授权。

子进程集成测试分两层：一层启动 built production CLI 验证本机 `serve/status/stop` 与派发前拒绝；另一层启动加载 built core/server 和受控 test transport 的 fixture child，在 durable dispatch 后 `SIGKILL`，验证重启同 key 返回 `unknown` 且不产生第二次 transport call。后者不是 production GitHub transport；两层都不证明 live GitHub 或独立 UID 部署。

显式 embedded compatibility 模式中的可选 `verifiedDelivery` grant 将提交改为验收后的 Host 交付：模型只登记路径、预期分支 head 和交付意图；Goals 从同一准确原生回合的步骤及整体验收中回读、重验隔离产物。Actions 在原授权与当前 owner route 内，通过已有 Automations 一次性执行器交给同一动作账本和 Keychain，再将实际终态送入现有 Delivery 主人通知。第一阶段 external broker 不支持这条组合，也不会回退 embedded。该组合不增加 AgentLoop 或调度器，不向模型开放验收私有数据；Goals、Automations 和 Delivery 仍是独立 Host bundle。

## 隔离产物的独立验收

任务协议 v4 为 Goals step/outcome 增加只含 testSet 引用的 isolated criterion；具体测试向量属于 Verifier Host authority。Isolation 普通依赖共享任务协议；Verifier 将 Isolation 声明为可选 Host peer，只在隔离验收时使用其私有 runner。Goals 通过共享 admission 值和 Host producer 方法交接来源，Isolation 不反向依赖 Goals 包。引导构建在 Delivery 后、Verifier 前先构建 Isolation，独立发布 bundle 的边界保持不变。

来源 worker 与 verification worker 使用不同持久账本和有限授权。Verifier 从实时 Goals producer 获取 step acceptance，核验精确任务与 scope 后读 Isolation 的不可变产物；全目标验收由持久 trigger run 选取来源。固定验收命令在独立容器读取 artifact/input，Host 保存预期结果并生成 v4 回执。原生 GoalLoop 继续拥有调度；此路径没有新增模型循环，也不授予通用 Host 代码执行权。


单次 Goals wake 通过 Delivery 的版本化 Host capability 等待终态验收。Delivery 仅调用 Goals 提供的 `settle(agent, signal)` 并维持当前 Session lease；Goals 只等待该 Agent 已结束回合的步骤/全目标结算。此等待仍服从原期限和取消信号，不引入第二套目标循环。末轮 `blocked` 到独立验收后的 `complete` 多一次 revision，只有同 owner/定义/Session/最终执行及验收回执的证明才允许该转移；旧 Delivery 缺少结算能力时拒绝调度。

## 固定模型路由的目标预算

`assistant-deepseek-budget` 是可选独立 bundle，持有自己的 `deepseek-goal-metered` provider 和两个精确文本模型的 Goals meter。它不为其他 provider 同名配置背书，不读取可配置模型目录来推导预算。固定 HTTPS Chat Completions 请求禁止重定向，不使用内部自动重试；按有限响应字节和期限读取完整 JSON，然后才向原生 LLM stream 发布验证后的内容、usage 和终态。AgentLoop、工具执行、Goal 轮次和持久预算仍由现有服务拥有。

计量依赖有期限的官方 API 契约：使用覆盖文档上下文口径的保守输入预留，成功时按包含缓存的实际输入结算；无法确认时保留原预留。它不声明金额上限，价格快照不能成为稳定账单保证。普通前台与辅助请求不属于 Goals 原生回合预算，仍受单次输出、响应字节和请求期限约束；完整账户预算另行接入。

已有 Web owner 的目标配置继续由 `assistant-web-owner` 的安装内 CLI 负责。离线 `--goal-admission` 路径动态加载可选 Goals/Verifier/DeepSeek peers，将工作区外私有任务规格编译成 owner/scope/objective 精确验收、有限预算及可选的 Session wake route；每个 bundle 仍独立安装，autonomy 安装器只预装禁用的模型 bundle。Delivery 提供只读 owner/binding 快照，配置器不构造会迁移数据库的 DeliveryStore，也不获取运行 lease、续期 grant 或创建 Goal。配置锁只序列化 setup，DB 快照与文件替换不构成跨库事务；Host 停止后配置，重启后运行时再次核对权限。持久 Session/settings 模型选择由原生 UI 管理，改默认配置不会迁移既有选择。


## 私有技能配对比较

Skills 的比较器复用 Evaluation 的 BenchmarkStore/runBenchmark/report，按固定输入与预算调度两个技能版本。每个 cell 新建仅含原生文件工具的 Context 与私有临时 workspace；它不创建 AgentLoop，也不继承调用方任意 Host 工具。生成的 artifact 交给独立 IsolatedVerifierRunner，在有限离线容器中执行，Host 对照配置答案判定。Native FS 库随 Skills 包交付，Evaluation/Isolation 是可选 peer，导入不激活其 bundle。比较报告没有发布或晋升权限；调用方 Host 本身的高权限尚不构成密封留出边界，必须与未来自动推广授权分开验证。
