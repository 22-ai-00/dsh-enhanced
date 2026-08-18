# CLIProxyAPI 对两个 Provider 插件的改进调研（最终版）

> 调研日期：2026-08-18  
> 版本：final（Agent-T 主笔，经 Agent-C 三轮第一手证据交叉复核后定稿）  
> 落地状态：Phase A 完成；Phase B 仅完成 parser 分层与 catalog observation 子阶段（真实 fixture / catalog cache / usage 保留 / latency-TTFT 未做）。详见文末「落地记录」。  
> 对象仓库：[`router-for-me/CLIProxyAPI`](https://github.com/router-for-me/CLIProxyAPI)  
> 复核提交：`d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0`  
> 对照对象：`@dsh-enhanced/coding-subscription-provider`、`@dsh-enhanced/traex-acp-provider`  
> 配套文档：[`docs/cliproxyapi-provider-evidence-review.md`](cliproxyapi-provider-evidence-review.md)  
> 本文只做研究和文档记录，不修改两个 provider 的实现。

## 修订说明（版本演进）

本报告经过多轮交叉复核。关键结论变更如下，均以本地代码/契约为准：

**v1/v2 → v3（已修正）**

1. **撤回**：`coding-subscription-provider` 的 `resolveModel()` 应改成静态 allowlist。这条违反 DSH 契约，见 §2.6。当前接受目录外模型是正确行为，不是 bug。
2. **收紧**：安全重试的判据从“是否已输出 text”改为**三态 `promptSubmissionState`**，见 §2.4。
3. **收紧**：ACP usage 不能直接映射为 DSH `TokenUsage`，必须先证明口径一致，见 §2.7。
4. **降级**：parser 完整分层由 P0 降为 P1（P0 只保留“采集真实版本 fixture”）。

**v3 → final（本版定稿，六处边界修正）**

1. **删除**“session/close 卡住不应覆盖已成功的 prompt 结果”。现有实现「teardown 失败→整体失败结算」是**正确的**；改为区分 `modelOutcome`/`teardownOutcome`，但 DSH `finish: success` 仍须等有界 teardown 完成，无法确认完成则以错误结算。见 §2.5、§3.2。
2. **降级**：`not-submitted` 只是自动重试的**必要非充分**条件。当前无等价 route/账号池，pre-prompt fallback 从 P1 移到 **P2/未来产品决策**；`promptSubmissionState` 当前只用于诊断和证明“不允许重试”。见 §2.4、§6。
3. **收紧**：catalog cache 第一版**完全非权威**——不参与 `resolveModel()`、不阻止新 session、不返回 `MODEL_NOT_FOUND`、不“预校验/抑制无效请求”。本次 `session/new` 的 catalog 永远是唯一执行依据。见 §3.2。
4. **收紧**：catalog cache key **不得 fingerprint 环境变量值**（哈希也可能成为可关联标识）。见 §3.2。
5. **降级**：TraeX normalized event **不作 P0**，且不保存 `tool.title`/`plan` 内容/`raw: unknown`（可能含路径、命令、业务文本）。P0 只增加生命周期信号，忽略的 update 只统计 kind 和数量。见 §3.2。
6. **收紧**：本地 cooldown TTL **不能写入 `providerRetryAfterMs`**——该字段语义是 provider 请求的等待时间（`index.d.ts:50-51`）。只有官方 CLI 返回可信 retry-after 才可映射。见 §2.3。

## 摘要结论

CLIProxyAPI **有助于本项目改进**，但帮助主要来自它的运行时工程方法，而不是来自把本项目改造成一个代理服务器。

一个前置事实决定了所有边界：**CLIProxyAPI 不是四个官方 CLI 的统一子进程封装**，而是一个 Go 编写的 HTTP API gateway。以 Codex 为例，它直接构造请求访问 `https://chatgpt.com/backend-api/codex`，并自行加载、保存、刷新 OAuth/token 文件，而不是启动本机 `codex` 命令（[`codex_executor_execute.go#L21-L104`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/internal/runtime/executor/codex_executor_execute.go#L21-L104)、[`sdk/auth/filestore.go#L55-L165`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/auth/filestore.go#L55-L165)）。因此“用它的 Go SDK 替换 Node 子进程”不是重构，而是同时更换认证责任、协议、发布形态和信任边界的架构重写。

最值得借鉴的是它的**运行时状态机与可观测性思想**，按优先级排序：

1. **P0：为两个插件建立统一的内部失败上下文**。CLIProxyAPI 能区分请求无效、凭据失效、配额冷却、上游暂时失败、流在首包前失败以及流已经开始后的失败。两个插件虽已 fail-closed，但 adapter 最终把许多细节压成 `CLI_FAILED`、`ACP_PROCESS_FAILED` 或 `ACP_PROTOCOL_ERROR`。应在内部保留 phase、`promptSubmissionState`、assistant text observed/forwarded、exit/signal、terminalReason、`teardownState`。**注意：DSH 当前 `LlmError` 没有承载任意 phase metadata 的稳定顶层字段，这些上下文先留在内部 error/cause/诊断，不进公共契约、不进共享包。**
2. **P0：统一 TraeX `models` 的注释、README 与运行语义**。当前配置注释写 “Advisory”，实现却是 hard allowlist。这是低风险的合同修正，应明确它是**部署者 allowlist**，而不是 DSH 要求。
3. **P0：补充生命周期测试**，固化 teardown（成功终态后 `closeSession` 失败仍以错误结算）、SIGKILL 后仍等待 close、abort 不污染 health 等既有不变量。
4. **P0：为现有 coding parser 采集脱敏的真实 CLI 版本 fixture**（不要求本阶段完成大规模重构）。
5. **P1：把 coding parser 重构为“provider-specific decoder → normalized event → reducer”分层**。
6. **P1：TraeX 缓存正常请求握手中已观察到的 model catalog**，短 TTL，**第一版完全非权威**：只记录、不参与 `resolveModel()`、不阻止新 session。
7. **P1：按真实协议字段逐步补 usage、精确定义时钟起点的延迟指标、失败 phase**，严格区分 ACP `PromptResponse.usage` 与 `usage_update`，验证口径后才向上暴露。
8. **P1（条件性，默认可暂不开启）：对可证明的 pre-prompt 失败增加有界内存 negative cache**。当前两个 provider 无备用账号池，收益只是“少重复启动坏进程”，不是提高成功率；本地 TTL 不得写入 `providerRetryAfterMs`。
9. **P2：pre-prompt fallback / 动态 `listModels()` / session resume / shared runtime**，均需数据或产品决策后再定。

明确不建议直接引入：

- 用 Go 重写或直接嵌入 CLIProxyAPI SDK 替换现有两个 npm 插件；
- 由插件读取、复制、保存或刷新 Codex、Claude、Cursor、TraeX 凭据；
- OAuth 登录、token 文件、refresh token、账号池和远程管理 API；
- 面向 HTTP 请求的自动换号/自动重试语义，尤其是 **prompt 已提交后的自动重放**；
- 为这两个本地 coding agent 增加通用 OpenAI/Claude/Gemini HTTP 代理层；
- 把 TraeX ACP provider 并入已有 `plugins/acp`（两者 ACP 方向相反）；
- 宣称能统一展示所有订阅的权威 5 小时/7 天剩余额度（见 §2.7）。

## 1. 两个项目解决的问题不同

### CLIProxyAPI 的边界

CLIProxyAPI 是一个本地或远程可访问的 **HTTP API gateway**。它自己持有或加载 OAuth/API-key credential，向上游发 HTTP/WebSocket 请求，再把多个上游协议翻译成 OpenAI、Anthropic 或 Gemini 兼容接口。

它的核心抽象是：

```text
HTTP request
  -> request translator
  -> provider/model/auth selector
  -> credential refresh and cooldown
  -> provider executor（直接访问上游 HTTP API）
  -> stream translator
  -> HTTP-compatible response
```

证据：

- executor 直接访问上游、translator 负责协议转换：[`sdk/cliproxy/executor/types.go#L59-L69`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/executor/types.go#L59-L69)、[`docs/sdk-advanced_CN.md#L10-L31`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/docs/sdk-advanced_CN.md#L10-L31)
- Codex executor 直接 POST `https://chatgpt.com/backend-api/codex` 的 `/responses`，不启动本机 CLI：[`codex_executor_execute.go#L21-L104`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/internal/runtime/executor/codex_executor_execute.go#L21-L104)
- 自管理 token 文件：[`sdk/auth/filestore.go#L55-L165`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/auth/filestore.go#L55-L165)
- 固定提交下**没有** TraeX ACP 或 Cursor CLI executor；README 出现的相关名称属于外围生态项目。
- 代码模块已是 Go `v7`、要求 Go 1.26，同一提交的 SDK 文档仍展示 `v6` 导入路径，说明任何直接嵌入都必须以可编译 spike 验证，不能按 README 估算成本：[`go.mod#L1-L3`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/go.mod#L1-L3)、[`docs/sdk-usage_CN.md#L1-L22`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/docs/sdk-usage_CN.md#L1-L22)

### 本项目两个 provider 的边界

`coding-subscription-provider` 和 `traex-acp-provider` 是 DSH 的 **本地外部 Agent connector**：

```text
DSH GenerateOptions
  -> text-only prompt serialization
  -> local official CLI / TraeX ACP child process
  -> bounded event parser
  -> DSH StreamChunk
```

它们不拥有上游模型协议的 token，也不代替官方工具登录、刷新或共享账号：

- `plugins/coding-subscription-provider/src/process.ts` 使用 `shell: false`、进程组清理、输出限额和订阅环境隔离。
- `plugins/coding-subscription-provider/src/auth.ts` 只运行官方 CLI 的 status probe，并对订阅来源 fail closed。
- `plugins/traex-acp-provider/src/acp-client.ts` 只启动 ACP server、进行握手、校验 session/model/终态，并拒绝权限请求。
- 两个 adapter 都把 `providerRetryPolicy` 设成 `maxRetries: 0`。这是因为外部 coding agent 可能已经读取工作区、消耗额度或产生不可见副作用，不能按普通 HTTP request 重试。

因此，CLIProxyAPI 的可迁移资产是 **状态机、调度和可观察性思想**，不是它的 credential ownership 和 HTTP gateway 实现。

## 2. CLIProxyAPI 值得学习的实现

### 2.1 Auth 是运行时实体，不只是一个 token

CLIProxyAPI 的 `Auth` 记录除了 provider 和凭据，还包含稳定 ID、来源、enabled/disabled/unavailable 状态、quota 与 `NextRecoverAt`、auth/model 级 `NextRetryAfter`、成功/失败环、last error、refresh 时间。来源：[`sdk/cliproxy/auth/types.go#L46-L94`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/types.go#L46-L94)。

对本项目的启发**不是**建立 `Auth` token 对象，而是为本地运行时建立一个更小的、**不含任何身份材料的** execution health record：

```ts
interface LocalProviderHealth {
  provider: string
  command: string
  state: 'ready' | 'auth-required' | 'cooldown' | 'broken'
  lastFailure?: {
    phase: 'auth' | 'spawn' | 'protocol' | 'terminal' | 'process'
    code: string
    at: number
  }
  nextRetryAt?: number
  consecutiveFailures: number
  successCount: number
  failureCount: number
}
```

它不应包含 token、邮箱、auth 文件路径或原始 stderr，默认只在进程内存中存在。

### 2.2 调度器以 provider + model 建 shard

CLIProxyAPI 的 selector 会过滤已阻塞 credential、优先取最高 priority，再在候选间轮询（[`selector.go#L251-L335`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/selector.go#L251-L335)），并支持 round-robin/weighted/fill-first/session-affinity。

本项目当前没有多账号实体，但有四个 CLI route 和一个 TraeX ACP route。可迁移的只是 shard key 概念：

```text
route + configured model + executable identity
```

第一版不需要权重调度，只需要：某 route 的 pre-prompt 失败在短窗口内被记录，避免每个请求都重复启动坏命令。**关键约束：由于没有备用账号池或等价 route，这套机制不提供“失败就换号”的成功率提升，只减少重复启动坏进程。** 不能照搬“失败就换 credential”。

### 2.3 Cooldown 是带原因的状态，且必须按失败类型分级

CLIProxyAPI 按失败原因设置不同范围和时长的 cooldown：未授权/禁止、model unsupported、quota/rate limit、timeout/5xx 并非一律处理（[`conductor_cooldown.go#L704-L884`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/conductor_cooldown.go#L704-L884)）。这个“错误分类 → 有界健康状态”的模式值得借鉴，但必须**条件性**采用，不能默认全开：

| 失败 | 是否冷却 | 推荐行为 |
|---|---:|---|
| `CLI_NOT_FOUND`（`ENOENT`） | 可缓存 | 配置/插件重载时清除；健康刷新时再探测 |
| `login status` 明确未登录（auth required） | 极短 TTL | 用户可能刚完成登录，不能长时间挡住 |
| 认证 probe timeout | 短窗口退避 | 防止每次请求卡住 |
| ACP `initialize`/`session/new` 协议错误 | 短窗口熔断 | 版本漂移或握手 bug，禁止热循环 |
| provider 明确 rate limit/quota | 仅当官方输出提供可信分类或 retry-after 时 | 无可信信号时只诊断，不臆测 |
| spawn 前参数/配置错误 | 否 | 插件/config bug，应立即报错 |
| prompt 已提交后的任何失败 | 影响后续诊断，但**不冷却当前请求、不重放** | 见 §2.4 |
| 用户 abort/timeout | 否 | 保留取消语义，不污染 provider health |

**落地顺序**：没有真实重复故障数据时，先做 failure context 和指标，再决定默认 TTL。

**retry-after 约束（已核对契约）**：DSH `LlmErrorOptions.providerRetryAfterMs` 的语义是“**provider 请求的**等待时间”（[`index.d.ts:50-51`](../node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts)，`LlmFailure` 同字段见 `types.d.ts:34`）。因此：

- 官方 CLI/ACP 明确返回可信 retry-after → 可映射进 `providerRetryAfterMs`；
- 插件自设的 negative-cache TTL（如 5s）→ **不得**写入该字段，只留在内部 health/diagnostic；
- 对外继续返回原稳定错误码；若未来要公开 local retry-after，应扩展 DSH 契约，而不是复用 provider 字段。

### 2.4 安全重试的判据：三态 `promptSubmissionState`，不是“是否有文本”

这是关键收紧。**“尚未输出 assistant text”不能证明“尚未产生副作用”**：coding agent 或 TraeX 可能已读写文件、调用工具、访问网络或消耗额度。因此安全重试的**必要**依据是**请求是否已提交**，而且必须用三态而非 boolean：

```ts
type PromptSubmissionState =
  | 'not-submitted'  // 可证明 prompt 未提交（自动重试的必要非充分条件）
  | 'submitted'      // prompt 已提交，当前请求禁止自动重放
  | 'unknown'        // 无法证明，一律按 submitted 处理
```

两个插件的置位时机（已核对代码）：

- **coding**：CLI prompt 位于 argv 中。当前 runner 只监听 `error` 和 `close`，**没有监听 `spawn`**（[`process.ts:210-213`](../plugins/coding-subscription-provider/src/process.ts#L210)）。应新增 `spawn` 监听：spawn 成功后保守标记 `submitted`；`ENOENT` 等 spawn error 仍为 `not-submitted`；未观察到 spawn 且事件顺序异常时设 `unknown`。
- **TraeX**：必须在调用 `client.prompt()` **之前**标记 `submitted`，因为调用过程中请求可能已写入 ACP stream，即使 Promise 最终失败（[`acp-client.ts:381`](../plugins/traex-acp-provider/src/acp-client.ts#L381)，现有 `promptActive = true` 就在正确位置）；不要根据 Promise 是否 reject 反推 prompt 没有发送。

pre-prompt 安全域已经天然存在：coding 的 `verifyAuth` 在 spawn 之前；TraeX 的 `initialize`/`newSession`/`setSessionConfigOption` 都在 prompt 之前。三态不是新造阶段，而是把已有边界显式命名。

同时把 assistant text 拆成两个信号，且**`block-start` 不算 assistant text**：

- `assistantTextObserved`：transport 已收到（[`acp-client.ts:325`](../plugins/traex-acp-provider/src/acp-client.ts#L325) 的 `sawAssistantText`，已是成功的既有不变量）；
- `assistantTextForwarded`：已经 `yield` 给 DSH 消费者（[`adapter.ts:195`](../plugins/traex-acp-provider/src/adapter.ts#L195)）。

`forwarded` 主要服务于“绝不可重试”的判断，不改变终态成功判定。

**必要非充分（final 版更正）**：`not-submitted` 只是允许重试的**必要**条件，不等于应该重试。自动重试/换 route 还要求：存在语义等价的 route、不改变账号/费用/模型行为、用户明确允许、有严格次数与总时限、失败不是确定性配置错误。当前项目**不存在账号池或等价 route**，因此 `promptSubmissionState` 现阶段的用途是**诊断与证明“不允许重试”**，而不是开启重试；自动 fallback 见 §6 归入 P2/未来产品决策。

### 2.5 Stream bootstrap 和结构化错误

CLIProxyAPI 在返回 stream 前先读取第一个非空 payload，把立即错误、空 stream 与有效 stream 区分开；首个有效 payload 之后的错误转发给消费者，而不是悄悄重启（[`conductor_stream.go#L84-L113`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/conductor_stream.go#L84-L113)）。它的错误对象带 code、retryable、retry-after、status，并区分 stop / stop-and-cooldown / continue / continue-and-cooldown。

两个插件已正确做到“必须有文本和成功终态”，但 adapter 层仍丢失了信息（`cliFailure()` 把多数情况归为 `CLI_FAILED`；TraeX 未暴露失败发生在 initialize/newSession/setModel/prompt/close 的哪一步）。建议在**内部**保留一个不暴露敏感内容的失败上下文，原始 `cause` 继续保留：

```ts
interface ProviderFailureContext {
  phase:
    | 'auth' | 'spawn' | 'initialize' | 'new-session' | 'model-catalog'
    | 'set-model' | 'prompt' | 'stream' | 'terminal' | 'close-session' | 'child-close'
  promptSubmissionState: 'not-submitted' | 'submitted' | 'unknown'
  assistantTextObserved: boolean
  assistantTextForwarded: boolean
  terminalReason?: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  // teardown 与 model outcome 分开记录，但不改变“teardown 未确认完成→整体错误结算”的行为
  teardownState: 'not-started' | 'in-progress' | 'completed' | 'failed' | 'unknown'
}
```

原始 stderr、prompt、token、邮箱和完整命令行不能进入此 metadata。**在 DSH 扩展契约之前，它只用于内部诊断、指标和重试安全判断，不进 `LlmError` 公共字段、不进共享包。**

**关于 teardown（final 版更正）**：现有 TraeX transport 在成功终态后仍会 `closeSession()` → `shutdown(false)` → 等待 child close，然后才让 operation 成功结算；`closeSession` 失败会落入 catch 抛错（[`acp-client.ts:390-412`](../plugins/traex-acp-provider/src/acp-client.ts#L390)）。**这是正确的资源生命周期保障，必须保留**：插件不能一边报告成功、一边遗留未知状态的进程。规则应是——内部区分 `modelOutcome` 与 `teardownOutcome`（前者不该被 teardown 失败伪装成“模型生成失败”），但 DSH `finish: success` **仍须等有界 teardown 完成**；teardown 无法确认完成时，本次调用继续以错误结算。除非未来 DSH 提供“成功结果 + cleanup warning”的独立契约，否则不能吞掉 cleanup failure。

### 2.6 模型语义：`listModels()` 是发现面，不是路由白名单

**这是撤回旧结论的核心依据。** 本地依赖 `@deepseek-ai/dsh-llm@0.1.0-rc.6` 的公开契约明确规定：

> Provider and model metadata is a discovery surface, not a routing whitelist. …an adapter may accept model ids absent from `listModels()`; consumers must not reject a request because its model is unlisted.

（[`dsh-llm/README.md:31`](../node_modules/@deepseek-ai/dsh-llm/README.md)、`README.md:35` 进一步说明 adapter “can describe an unlisted dynamic model”。）

因此：

- **coding `resolveModel()` 接受目录外 model 是正确行为**。`listModels()` 返回配置中的提示性目录，`resolveModel()` 接受任意 id 并原样传给官方 CLI `--model`，与 README 承诺一致（[`coding README.md:16`](../plugins/coding-subscription-provider/README.md#L16)）。**v1/v2 建议把它改成静态 allowlist 的结论作废——那会错误地收窄 DSH 允许的动态模型能力。**
- **TraeX 保留严格 allowlist 可以，是插件自身策略**（[`traex adapter.ts:124`](../plugins/traex-acp-provider/src/adapter.ts#L124)），但配置注释 “Advisory model ids shown by DSH” 与实现不符（[`traex config.ts:10`](../plugins/traex-acp-provider/src/config.ts#L10)）。README 已基本按 allowlist 描述（[`traex README.md:61`](../plugins/traex-acp-provider/README.md#L61)）。**要修的是注释：明确 `models` 是部署者 allowlist，而不是让 coding 去跟随 TraeX 的策略。**

CLIProxyAPI 的模型 registry 记录 quota/suspend/支持关系，但服务注册时大量使用内置静态 catalog 或配置列表（按 Codex plan 选预置模型），并非普遍向上游实时发现（[`service_models.go#L63-L157`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/service_models.go#L63-L157)）。所以它不构成“通用动态模型探测”的范例。

TraeX 的真实 catalog 只在 `session/new` 后出现，现有实现已校验 catalog、请求目标模型并再次确认（[`acp-client.ts:365-378`](../plugins/traex-acp-provider/src/acp-client.ts#L365)、`validateModelCatalog` 见 [`acp-client.ts:499`](../plugins/traex-acp-provider/src/acp-client.ts#L499)）。合理增强见 §3.2 的 catalog cache。

### 2.7 Usage 与 quota：结构化记录可学，映射必须先证明口径

CLIProxyAPI 的 usage record 含 provider、model、auth、latency、TTFT、失败标志和 token detail（[`usage/manager.go#L21-L75`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/usage/manager.go#L21-L75)）。但：

- 核心 `QuotaState` 主要表达 exceeded/reason/recovery/backoff，不是所有 provider 的权威“剩余百分比”（[`types.go#L167-L195`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/types.go#L167-L195)）。
- README 明确从 v6.10.0 起不再内置统计功能，5h/7d dashboard 主要由外围项目提供。**因此不能承诺两个插件能获得所有订阅的权威 5 小时/7 天剩余额度。**

ACP usage 不能直接映射为 DSH `TokenUsage`。DSH 契约（已核对 [`types.d.ts:116-129`](../node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts)）要求：

- `inputTokens`、`outputTokens` 是**必填 number**，不能用 `undefined`；
- `inputTokens` 必须是 **uncached input only**，cache 单列为 `cacheReadTokens`/`cacheWriteTokens`；把 cache 折进总数的 provider 要自己减出来；
- `cacheReadTokens`/`cacheWriteTokens`/`reasoningTokens` 缺失才保持 `undefined`；
- 合法的真实零值必须保留，不能把 0 当作缺失。

而 ACP 的 `Usage.inputTokens` 是否已排除 cache 并无证明，`usage_update` 表达的是 session context-window/cost，**与 token 计数不是一回事**，真正 token 位于实验性的 `PromptResponse.usage`。所以：

> 第一阶段只记录**原始 ACP usage + 协议版本**；只有通过 TraeX 实际输出 fixture 或官方字段契约证明口径一致后，才发 DSH `usage` chunk。不能未经证明映射，也不能未经证明做减法。

在此之前，内部诊断 sink 可以先记录脱敏后的计数/耗时/状态（invocation-start、auth-result、first-text、terminal、failure），交给 `ctx.logger`，不记录 prompt 和原始事件。

## 3. 对两个插件的具体建议

### 3.1 `coding-subscription-provider`

文件范围：`plugins/coding-subscription-provider/src/{adapter,auth,process,providers,config,prompt}.ts`。

#### P0：统一 invocation phase、prompt 提交状态和错误元数据

现有 `process.ts` 基础很好（`close` 而非 `exit` 结算、SIGINT→SIGKILL、malformed/unknown/missing-terminal 均 fail closed、Cursor 校验 `apiKeySource==='login'`、stderr/line/output 有界）。改进方向：

- 新增 `spawn` 监听，驱动 §2.4 的三态 `promptSubmissionState`；
- `runCliText()` 通过回调报告 `spawned -> recognized-event -> first-text -> terminal -> closed`；
- adapter 映射错误时在内部保留 §2.5 的 `ProviderFailureContext`；
- 稳定 `LlmError` code 与 `maxRetries: 0` 行为不变。

#### P0：采集真实 CLI 版本 fixture（不含大规模重构）

当前 parser 已覆盖成功、malformed、无事件/无文本、认证来源、失败 terminal、异常退出等场景。本阶段只需把**捕获自明确 CLI 版本的真实输出**脱敏后固化为 fixture。

> **执行前提**：真实 fixture 需要在装有并已登录 codex/claude/cursor/grok 的环境实采。完成定义是“捕获到的真实版本样本”，不是构造样本。若当前环境不具备采集条件，此项标注为**待采集**，不阻塞其余 P0。

#### P0：不改 `resolveModel()` 的动态模型行为

见 §2.6。**保留**目录外模型原样传给 `--model` 的现有行为，撤回旧的 allowlist 建议。

#### P1：CLI-specific parser 重构为 profile + reducer

`parseProviderEvent()` 当前同时承担 shape recognition、text extraction、terminal outcome、Cursor auth source、Grok 兼容格式。建议拆成：

```text
decode JSON line
  -> provider capability/version profile
  -> normalized LocalAgentEvent
  -> text / usage / terminal / auth reducer
```

每个 CLI 建立 success / partial-then-success / terminal-failure / malformed / auth-source / usage（若官方输出有）/ version profile fixture。

> 优先级判断：现有 parser 已有较完整测试，本项主要是**可维护性增强**，故为 P1。若近期遇到官方 CLI 版本频繁漂移导致线上兼容问题，再提升为 P0。

#### P2：安全的 pre-prompt fallback（需产品决策）

保留 README “不自动切换 provider 或重试” 与 `maxRetries: 0` 的默认。**当前不实现自动 fallback**：项目无等价 route/账号池，且 §2.4 已说明 `not-submitted` 只是必要非充分条件。未来若增加显式策略，安全门至少要满足：

```text
retry/fallback allowed =
  promptSubmissionState === 'not-submitted'
  AND failure phase ∈ { spawn(ENOENT) / auth-not-logged-in / preflight }
  AND 存在语义等价 route AND 用户明确允许 AND 有次数/总时限上限
  AND 失败不是确定性配置错误
```

`unknown` 一律按 `submitted` 处理，模型 turn 开始后即使无 text 也不自动重放。

#### P2：stdin prompt 传输作为 provider-specific 安全增强

后续可按官方 CLI 能力逐个用版本 fixture 验证 Codex/Claude/Cursor/Grok 的 stdin 行为，不能为统一而强制。

### 3.2 `traex-acp-provider`

文件范围：`plugins/traex-acp-provider/src/{acp-client,adapter,auth,config,prompt}.ts`。

#### P0：修正 `models` 注释语义

见 §2.6。把 `config.ts` 注释从 “Advisory” 改为明确的**部署者 allowlist**，与 README 和实现一致。

#### P0：把 ACP wire event 和 DSH text event 分开，并校准失败阶段

当前 `sessionUpdate()` 只处理 `agent_message_chunk`，其余忽略；`TraexAcpError` 只有粗分类。**P0 只增加生命周期信号**（phase / prompt state / terminal / teardown），归一化事件的 tool/plan/usage 不作 P0：

```ts
// P0：仅生命周期，不保存业务内容
type TraexLifecycleSignal =
  | { type: 'text-delta'; text: string }              // 唯一转发给 DSH 的内容
  | { type: 'ignored'; sessionUpdate: string }        // 只统计 kind 和数量
  | { type: 'terminal'; stopReason: StopReason }
```

**不保存 `tool.title`、`plan` 内容或 `raw: unknown`**——它们可能包含文件路径、命令和业务文本。被忽略的 update 只记录 kind 名称与计数。usage 的 typed 字段留到 §3.2 P1 处理；tool/plan 的可脱敏映射留到 DSH 真正支持相应 UI 时再单独设计。

并在内部保留失败阶段：`initialize` / `new-session` / `model-catalog` / `set-model` / `prompt` / `close-session` / `child-close`。**`close-session` 卡住属 teardown，按 §2.5——不把已成功的 `modelOutcome` 伪装成模型失败，但整体仍须等有界 teardown 完成，无法确认完成则以错误结算。**

#### P1：动态模型 catalog cache（区分 `default`，第一版完全非权威）

真实 catalog 在 `session/new` 后可得。**不要为了 `listModels()` 主动启动新 ACP session**（有进程、认证、session 成本）。语义规则（已核对 [`adapter.ts:172`](../plugins/traex-acp-provider/src/adapter.ts#L172)，`default` 是哨兵、命中时不下发模型选择）：

- `default`：若配置允许，表示使用当前 ACP session 的 `currentValue`，**不是真实 model id**，不参与“取交集”；
- 具体 model id：执行时必须**同时**出现在配置 allowlist 和**本次** ACP selector 中。

**第一版 cache 完全非权威（final 版更正）**——旧 catalog 不能据此拒绝或放行新请求（用户可能已切换账号/套餐、TraeX catalog 可能刚更新、executable 可能原地升级，短 TTL 也不能证明 entitlement 没变）：

- 只记录 `currentValue`、观察到的具体模型集合、观察时间、协议/CLI 版本；
- **不**参与 `resolveModel()`；
- **不**阻止新 session；
- **不**返回 `MODEL_NOT_FOUND`；
- **不**做“预校验/抑制无效请求”；
- **本次 `session/new` 返回的 catalog 永远是唯一执行依据**；目录为空仍返回 `ACP_ENTITLEMENT_REQUIRED`。

cache key **只用非敏感、可验证的标识**，**不得 fingerprint 环境变量值**（明文或哈希都可能成为可关联标识）：adapter 实例 + provider route + normalized command + cwd + 非敏感配置 revision + 可验证的 executable version/identity。登录身份无法安全得知时，依靠短 TTL，并在 auth failure、配置/插件 reload、CLI version 变化时清空缓存。

后续若要驱动 `listModels()`，必须**一起**实现 `llm/adapters-updated`、去抖、缓存代际、配置/reload 失效、auth/protocol failure 失效（[`dsh-llm/README.md:33`](../node_modules/@deepseek-ai/dsh-llm/README.md)）；这属于 §6 的 P2。

#### P1：保留协作式取消，但明确成功结算边界

现有实现先 `session/cancel` 再 SIGINT/SIGKILL 并等待 child close，优于普通 CLI。应固化不变量：cancel 发出后仍须等待 prompt response 或 child close；SIGKILL 发出不代表 child 已退出；child close 后不能把已验证成功的 prompt 改写为普通 process failure；外部 AbortSignal 不进入 provider cooldown；permission cancellation 不当作 model refusal。

#### P2：不要把 ACP session affinity 偷换成 DSH 对话续接

除非 DSH `GenerateOptions` 提供稳定 conversation/session identity，否则不使用 ACP `session/load` 或保存外部 session id。将来引入应做成独立 external-agent runtime contract，而不是在 text-only `LlmAdapter` 中偷偷持久化。

## 4. 哪些 CLIProxyAPI 设计不应该复制

- **OAuth/token ownership**：不读取 `auth.json`/Claude credentials/Trae keyring，不复制 refresh token，不实现浏览器/device login，不把单用户订阅变成 HTTP 服务。两个 README 的安全声明保持不变。
- **HTTP protocol translation**：`internal/translator/*`、`internal/runtime/executor/*` 面对的协议方向、生命周期、credential 来源都与本项目不同，不构成可直接复用的代码。可借鉴的是“每个 provider 有独立 translator + normalized event + golden tests”的**结构**。
- **无条件自动重试和多账号轮询**：`HTTP request fallback != local Agent invocation fallback`。任何 fallback 必须以 §2.4 的 `promptSubmissionState` 为约束。
- **过早建立大而全的公共层**：先以测试定义公共合同，再考虑 `packages/*`（见 §5 Phase D）。

## 5. 推荐落地路线

### Phase A：失败/生命周期合同（P0）

1. 为 `runCliText()` 和 `runTraexAcpText()` 增加 §2.5 的 `ProviderFailureContext`：phase、三态 `promptSubmissionState`、assistant text observed/forwarded、terminalReason、exit/signal、`teardownState`；coding 新增 `spawn` 监听。
2. 保留稳定 `LlmError` code 与 `maxRetries: 0`、以及现有 teardown 等待策略；exit code/signal/phase 仅作内部非敏感 cause metadata，不进公共契约。
3. 修正 TraeX `models` 注释为部署者 allowlist。
4. 补生命周期测试：spawn event/error 顺序、prompt 调用同步/异步失败、**成功 terminal 后 `closeSession` 失败仍以错误结算**、SIGKILL 后仍等待 close、partial text 后 teardown failure、abort 不污染 health。
5. 采集脱敏真实 CLI 版本 fixture（缺采集环境则标注待采集，不阻塞其余 P0）。

验收：`pnpm check` 通过；不记录 prompt/token/raw stderr；no-retry 行为不变；用户 abort 不进入错误冷却；`close` 未发生前不结算 child 已销毁；teardown 未确认完成时整体以错误结算。

### Phase B：parser 分层、catalog 与观测（P1）

1. coding parser 重构为 `JSON decode → provider-specific decoder → normalized event → reducer`。版本号主要作为 fixture 元数据；除非有缓存且可信的 `--version` probe，不在每个请求前跑版本检测，也不让运行时 decoder 过度依赖版本字符串。
2. TraeX catalog cache（第一版**完全非权威**，见 §3.2：只记录、不参与 `resolveModel()`、不阻止 session、key 不含 env 值）；驱动 `listModels()` 归入 Phase D。
3. TraeX usage：只保留显式挑选的数值字段和协议版本，丢弃 `_meta`/未知 raw；先验证 ACP input/cache 口径与 DSH disjoint 定义一致，再发 `usage` chunk；缺失不伪造为 0，真实 0 保留。
4. 指标定义清晰时钟起点，避免笼统 latency/TTFT 无法跨 provider 比较：`authProbeDurationMs`、`spawnToFirstEventMs`、`promptToFirstTextMs`、`promptToTerminalMs`、`teardownDurationMs`。

验收：`default` 正确回退到 `currentValue`；执行 gate 只依据本次 session catalog、不受缓存影响；usage 缺失不伪造、真实 0 保留；指标口径一致。

### Phase C：条件性 health/negative cache（P1，默认可暂不开启）

先收集 Phase A/B 数据，再决定是否启用与默认 TTL。health key **按失败域划分**，不使用一个笼统的 route+model+executable：

- missing executable → executable identity；
- auth failure → route + command + config revision；
- ACP handshake → route + executable + protocol version；
- TraeX model catalog → route + specific model + catalog generation；
- coding 的 prompt/model 失败已发生在 spawn 之后，**不属于** pre-prompt model cooldown。

行为：`CLI_NOT_FOUND` 缓存至 reload/config change；auth-required 极短 TTL；auth probe timeout 短退避；ACP handshake/version drift 短熔断；用户 abort 不计 provider failure；prompt 已提交后的失败只记录诊断、不重放当前请求；**插件本地 TTL 不写入 `providerRetryAfterMs`**（见 §2.3）；提供 reload/reset 清理。

验收：同一坏 CLI 不会短时间被每个请求重复启动；abort/timeout 不被误判为 quota；已提交请求的失败绝不自动重放；对外错误码不变，本地 TTL 不冒充 provider retry-after。

### Phase D：后续能力（P2）

- catalog 驱动动态 `listModels()`，连同 `llm/adapters-updated`、去抖、缓存代际、reload/auth/protocol 失效一起实现；
- 显式、用户授权的等价 route fallback（见 §3.1 P2 与 §2.4 必要非充分条件）；
- stdin prompt 的 provider-specific 验证；
- ACP session resume/affinity；
- 小型 shared runtime package——仅当两个插件测试证明边界真实相同才抽取。候选：bounded byte accumulator、diagnostic redaction、child lifecycle/close barrier、environment name filtering、normalized phase/failure-context 类型、fixture helper。不共享：provider flags、TraeX ACP method/identity policy、subscription auth policy、model catalog semantics、README 合规说明。

## 6. 风险和优先级矩阵（final）

| 建议 | 价值 | 风险 | 优先级 | 结论 |
|---|---|---|---|---|
| 内部 failure context + 三态 promptSubmission | 高 | 低 | P0 | 立即做，仅内部 |
| 生命周期测试（含 teardown 失败→错误结算） | 高 | 低 | P0 | 固化既有正确行为 |
| TraeX `models` 注释/语义统一 | 中 | 低 | P0 | 低风险合同修正 |
| 采集真实 CLI 版本 fixture | 高 | 低 | P0 | 依赖采集环境，否则待采集 |
| coding `resolveModel()` 改 allowlist | — | — | 撤回 | 违反 DSH 契约，不做 |
| coding parser 分层重构 | 中高 | 中 | P1 | 可维护性增强，漂移严重再升 P0 |
| TraeX catalog cache（完全非权威） | 中 | 中 | P1 | 只记录，不参与 resolve/gate |
| typed usage 观察 + 精确延迟指标 | 中高 | 中 | P1 | 先证明口径，再映射 |
| health/negative cache | 中 | 中 | P1（条件性，默认关） | 无账号池，收益仅减少坏进程重启 |
| catalog 驱动 listModels() + 更新事件 | 中 | 中 | P2 | 需连同去抖/失效/代际一起做 |
| pre-prompt 自动 fallback | 中 | 高 | P2 | 需等价 route + 用户授权，属产品决策 |
| session affinity/resume | 高但复杂 | 很高 | P2 | 暂不做 |
| 多账号/多 credential scheduler | 取决于产品方向 | 很高 | P2 | 暂不做 |
| shared runtime package | 中 | 中 | P2 | 先测试后抽取 |
| Go 重写 / 嵌入 SDK | — | 极高 | 禁止 | 换认证/协议/发布/信任边界 |
| OAuth/token manager | 不符合边界 | 极高 | 禁止 | 不做 |
| HTTP gateway/translator | 与插件定位不同 | 高 | 禁止 | 不做 |
| prompt 提交后自动重放 | — | 极高 | 禁止 | 不做 |
| 本地 TTL 冒充 `providerRetryAfterMs` | — | 高 | 禁止 | 语义是 provider 请求等待 |
| 宣称统一 5h/7d 权威额度 | — | — | 禁止 | 无核心证据支持 |

## 7. 最终判断

CLIProxyAPI 可以帮助本项目把两个 provider 从“安全的单次调用适配器”推进到“可长期运行、可诊断的本地 provider runtime”，但必须做边界转换：

```text
CLIProxyAPI:
  Go HTTP gateway + credential pool + upstream protocol translation
  + HTTP-request retry/fallback

本项目应吸收（仅设计模式）:
  execution phase + 三态 prompt 提交状态 + capability 观察
  + structured failure context + stream bootstrap
  + latency/TTFT/usage 可观测性（验证口径后）
  + 分级、有界、pre-prompt 的 health/cooldown

本项目明确保留（硬约束）:
  official CLI / TraeX 自持凭据
  shell:false + bounded child lifecycle
  text-only DSH compatibility seam
  maxRetries:0，prompt 提交后绝不自动重放
  independently publishable plugin bundles
```

最终定性（按 Agent-C 复核收敛）：

- **立即做（P0）**：内部 failure context + 三态 prompt 状态、TraeX `models` allowlist 文档、生命周期测试（含 teardown 失败→错误结算）、真实版本 fixture。
- **随后做（P1）**：真实 fixture 驱动的 parser 分层、typed usage 观察、精确定义时钟起点的延迟指标、完全非权威的 catalog cache。
- **有数据再做（P1，默认关）**：按失败域划分的 health/negative cache。
- **暂不做（P2/产品决策）**：自动 fallback、动态 `listModels()`、session resume、shared runtime。
- **永远不沿当前方向做**：Go 替换、OAuth/token ownership、账号池、HTTP gateway、prompt 提交后自动重放、本地 TTL 冒充 `providerRetryAfterMs`、伪造 quota。

若只落地三件事，顺序是：

1. **两个 adapter 的内部 failure context + 三态 `promptSubmissionState`，统一 TraeX `models` 注释语义，并补生命周期测试固化 teardown/取消不变量。**
2. **coding parser 分层 + 采集真实版本 fixture；TraeX 完全非权威 catalog cache 与 typed usage/延迟指标。**
3. **按失败域、有界、仅 pre-prompt 的 negative cache，默认可暂不开启，绝不重放已提交的 turn，也不写入 `providerRetryAfterMs`。**

这三项直接提升正确性、可诊断性和长期运行稳定性，且不破坏凭据 ownership、独立发布和安全默认值。

## 8. 证据索引

### CLIProxyAPI（均固定到 `d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0`）

- README 与使用量统计说明：[README_CN.md#L143-L158](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/README_CN.md#L143-L158)
- Codex executor 直接访问上游：[codex_executor_execute.go#L21-L104](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/internal/runtime/executor/codex_executor_execute.go#L21-L104)
- token 文件管理：[sdk/auth/filestore.go#L55-L165](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/auth/filestore.go#L55-L165)
- Auth runtime state / QuotaState：[sdk/cliproxy/auth/types.go#L46-L94](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/types.go#L46-L94)、[#L167-L195](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/types.go#L167-L195)
- Selector 与 priority/round-robin：[selector.go#L251-L335](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/selector.go#L251-L335)
- Cooldown 分类：[conductor_cooldown.go#L704-L884](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/conductor_cooldown.go#L704-L884)
- Stream bootstrap：[conductor_stream.go#L84-L113](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/conductor_stream.go#L84-L113)
- Usage manager：[usage/manager.go#L21-L75](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/usage/manager.go#L21-L75)
- Model registry / service models：[model_registry.go#L114-L130](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/internal/registry/model_registry.go#L114-L130)、[service_models.go#L63-L157](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/service_models.go#L63-L157)
- 模块版本与 SDK 文档偏差：[go.mod#L1-L3](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/go.mod#L1-L3)、[docs/sdk-usage_CN.md#L1-L22](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/docs/sdk-usage_CN.md#L1-L22)

### 本项目

- DSH LLM 契约（discovery surface / `TokenUsage` / adapters-updated）：`node_modules/@deepseek-ai/dsh-llm/README.md:31,33`、`lib/types/types.d.ts:116-129`
- 编程订阅 README / 进程 / adapter：[README.md](../plugins/coding-subscription-provider/README.md)、[process.ts](../plugins/coding-subscription-provider/src/process.ts)（`spawn` 未监听见 L210）、[adapter.ts](../plugins/coding-subscription-provider/src/adapter.ts)（`resolveModel` 见 L131）
- TraeX README / transport / adapter / config：[README.md:61](../plugins/traex-acp-provider/README.md)、[acp-client.ts](../plugins/traex-acp-provider/src/acp-client.ts)（`promptActive` L381、`sawAssistantText` L325、`validateModelCatalog` L499）、[adapter.ts:172](../plugins/traex-acp-provider/src/adapter.ts)、[config.ts:10](../plugins/traex-acp-provider/src/config.ts)
- 第一手证据复核（配套）：[docs/cliproxyapi-provider-evidence-review.md](cliproxyapi-provider-evidence-review.md)
- DSH 当前 ACP event mapper：[plugins/acp/src/codec.ts](../plugins/acp/src/codec.ts)
- 插件独立发布与共享包边界：[docs/architecture.md](architecture.md)

## 9. 落地记录（Phase A + B）

针对 DSH `@deepseek-ai/dsh-llm` rc.6/rc.7（契约仅 `finish.replayState` 由 `unknown` 收紧为 `ReplayEnvelope`，两插件均不发该字段，无影响）已实现以下内容，全部为**内部诊断侧信道**：不改任何对外 `LlmError`/`TraexAcpError` code 与 cause，保持 `maxRetries: 0`，不读凭据、不落敏感内容。

**coding-subscription-provider**

- `src/process.ts`：导出 `PromptSubmissionState` / `CliLifecyclePhase` / `ProviderFailureContext`；新增 `SpawnedProcess` 的 `spawn` 监听驱动三态提交状态（spawn→`submitted`，ENOENT→`not-submitted`，无 spawn 却有输出→`unknown`）；`RunCliTextOptions.onSettled` 可选回调**成功/失败各恰好报告一次**（try/catch 包裹），并覆盖 pre-abort、同步 spawn 抛错等 pre-spawn 失败（报 `not-submitted`）。parser 重构为 `decode → 每 provider decoder（codex/claude/cursor/grok）→ 归一化事件 → reducer`，行为与断言不变。
- `src/adapter.ts`：`RouteFailureContext`（含 `auth`/`preflight` 阶段、adapter 拥有的 `assistantTextForwarded`、稳定 `RouteOutcome` 分类）；`buildPrompt` 置于 preflight 守护内（超长 prompt 等失败报 `not-submitted`+`preflight`）；成功路径也报 `outcome: 'ok'`。
- `src/index.ts`：接上生产 sink——`onSettled` 按 outcome 走 `ctx.logger.debug`(ok)/`info`(失败)，仅记录脱敏生命周期字段。
- `tests/fixtures/README.md`：真实 CLI 版本 fixture 标注为 **PENDING CAPTURE**（需已登录环境、消耗额度、显式授权、提交前脱敏）。

**traex-acp-provider**

- `src/acp-client.ts`：导出 `PromptSubmissionState` / `TeardownState` / `TraexLifecyclePhase` / `ProviderFailureContext` / `CatalogObservation`；跟踪 phase、`promptSubmissionState`（在 `client.prompt()` 前置 `submitted`）、`teardownState`；`onSettled` 在结算（成功+失败）恰好报告一次，并覆盖 validate 失败、pre-abort、同步 spawn 抛错等 pre-spawn 失败（报 `not-submitted`）；`onCatalogObserved` 报告**完全非权威**的 catalog 观测（不参与 `resolveModel`/`listModels`、不 gate 请求、不含任何 env 值）。**保留** teardown 语义：成功仍等待有界 teardown，`closeSession` 失败仍以错误结算。`PromptResponse.usage` 口径未验证，暂不映射、不发 `usage` chunk。
- `src/adapter.ts`：`RouteFailureContext` + `assistantTextForwarded` + 稳定 `RouteOutcome`；`buildPrompt` preflight 守护；成功报 `outcome: 'ok'`，透传 `onCatalogObserved`。
- `src/index.ts`：接上生产 sink——`onSettled`（按 outcome debug/info）与 `onCatalogObserved`（debug，仅模型**数量**，不含任何 model id 原文）。
- `src/config.ts` + `README.md`：`models` 注释/文档改为明确的**部署者 allowlist（插件策略，非 DSH 要求）**。

**回调合同（经多轮复核修正）**：`onSettled` 语义明确为「每次 invocation 结算**恰好一次**，成功失败都调用」。两个 adapter 用 `try/finally` + `reported` guard 保证:即使消费者在 `block-start` 或某个 text delta 后提前 `return()`,也恰好上报一次;TraeX 最早的 pre-auth `signal.aborted` 抛出也纳入 guard 上报。`RouteOutcome` 提供稳定失败分类（`aborted`/`timeout`/`auth-required`/`not-found`/`protocol`/`process`/`output-limit`/`line-limit`/`io`/`preflight`/…），使 abort 与 auth failure、本地安全限额与 provider/process 失败互不混淆，为 Phase C health/cooldown 预留可路由信号。coding 的 output-limit/line-limit/stream-io 已带稳定 `cause`,公开 `LlmError` code 不变。TraeX catalog 生产日志只记录模型**数量**,不落未净化的 ACP model id。

**尚未做（Phase B 未完成项）**：真实 CLI 版本 fixture（`tests/fixtures/README.md` 标 PENDING CAPTURE，需授权采集）、normalized reducer 的 version profile、TraeX catalog **cache**（当前只有非权威 observation hook + 数量日志）、ACP `PromptResponse.usage` 的 typed snapshot 保留、latency/TTFT 计时。coding 亦尚无显式 teardownState（仅 phase=child-close + exit/signal）。

**未启动（按计划）**：Phase C（按失败域的 negative cache/cooldown，默认关；本地 TTL 不写入 `providerRetryAfterMs`）、Phase D（catalog 驱动 `listModels()`+`llm/adapters-updated`、pre-prompt fallback、session resume、shared runtime）、ACP usage 的 DSH 映射。

**准确定性**：Phase A 完成；Phase B 仅 parser 分层 + catalog observation 子阶段完成，**不能称 Phase B 完成**。

**验证**：`pnpm check` 全绿（validate 4 插件 / oxlint 零告警 / typecheck / 测试 coding 67+TraeX 79+acp 28+hello 2 = 176 / build / 4 插件 dry-run pack）。测试结果与仓库要求的 Node 引擎（`^22.19.0 || >=24.0.0`）无关、可跨环境复现；具体运行 Node 版本随执行环境而定，低于该范围时会出现 engine 警告但不影响本套检查通过。
