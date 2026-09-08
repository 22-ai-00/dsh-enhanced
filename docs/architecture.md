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

`assistant-actions` 是独立 Host bundle，依赖当前 Policy/Delivery/Keychain，不把通用 token 交给模型或 Docker worker。首个动作固定为 GitHub GraphQL expected-head commit：仓库/分支/路径来自 operator grant，内容来自有界工具输入，Keychain 短租约只在 Host 回调使用。Policy 预授权只绑定已注册 broker 的 exact ToolDefinition；单调 deny 仍在原生执行 guard 生效，Isolation 仅为该特定 broker 开放工具路由。Host 插件仍是受信任控制面，此接口不是同进程恶意插件的沙箱。

动作库独立持久化预留、期限、派发意图与结果；跨 Policy/Keychain/动作库没有原子事务，失败保守消耗预算，unknown 不重发。容器继续不出网，不提供通用网络代理。该 bundle 不自动加入安装场景或激活真实用户 profile。

可选 `verifiedDelivery` grant 将提交改为验收后的 Host 交付：模型只登记路径、预期分支 head 和交付意图；Goals 从同一准确原生回合的步骤及整体验收中回读、重验隔离产物。Actions 在原授权与当前 owner route 内，通过已有 Automations 一次性执行器交给同一动作账本和 Keychain，再将实际终态送入现有 Delivery 主人通知。该组合不增加 AgentLoop 或调度器，不向模型开放验收私有数据；Goals、Automations 和 Delivery 仍是独立 Host bundle。

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
