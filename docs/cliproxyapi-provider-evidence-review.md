# CLIProxyAPI 对两个 provider 插件的第一手证据复核

## 范围与复核基线

- CLIProxyAPI 锁定在 2026-08-18 的提交 [`d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0`](https://github.com/router-for-me/CLIProxyAPI/tree/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0)。以下外部链接全部固定到该提交，避免分支后续变化污染结论。
- 本项目按当前工作区快照复核；两个目标插件已由提交 `4ceacf7` 纳入仓库。本文用本地相对路径和行号指向当前实现。
- 证据只取 CLIProxyAPI 官方仓库与本仓库源码、测试和文档。重点是判断哪些机制可迁移，而不是比较两个项目的功能数量。

## 结论先行

CLIProxyAPI 确实提供了有价值的长期运行机制：模型/凭据可用性状态、优先级与轮询、错误分类后的 cooldown、首个有效流事件前的 bootstrap 判断、结构化 usage/失败记录。它们可以启发两个插件从“每请求启动一次本地 CLI/ACP”演进为更可诊断的 provider runtime。

但 CLIProxyAPI 的核心不是对官方 CLI 子进程的通用封装。它是一个 Go HTTP API 服务：executor 翻译请求后直接向 Codex、Claude、Gemini、XAI 等上游发 HTTP 请求，同时自己加载、保存和刷新认证材料。当前两个插件则是 TypeScript/npm 独立包，刻意让官方 CLI 持有凭据。因而“用 CLIProxyAPI Go SDK 替换 Node 实现”不是低风险重构，而是会同时改变发布形态、进程边界、凭据责任和协议表面的架构重写。

最确定、最应先落地的是内部 phase-aware 错误上下文和 provider/version fixture 驱动的解析层。其后才是基于已观察握手结果的 TraeX 能力缓存、严格限定在 prompt 提交前失败的 health/cooldown，以及按真实协议字段逐步补充 usage。不能据 CLIProxyAPI 的设计直接推出 OAuth 账号池、通用 HTTP 代理或 coding agent 自动重试适合本项目。

## 证据索引

### 1. 执行器和 translator：可借鉴分层，不能当成 CLI 适配 SDK

CLIProxyAPI 把认证管理、executor 与协议 translator 分开。`ProviderExecutor` 公开普通请求、流请求、刷新、token 计数和 HTTP 请求接口；executor 的输入已经是翻译到目标协议的 JSON（[`sdk/cliproxy/auth/conductor.go#L15-L31`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/conductor.go#L15-L31)、[`sdk/cliproxy/executor/types.go#L59-L69`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/executor/types.go#L59-L69)）。其 SDK 文档也明确把 executor 定义为实际访问上游 API、translator 负责协议转换（[`docs/sdk-advanced_CN.md#L10-L31`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/docs/sdk-advanced_CN.md#L10-L31)）。

Codex executor 会从认证对象取得 API key/base URL，默认指向 `https://chatgpt.com/backend-api/codex`，构造 `/responses` POST 并直接通过 HTTP client 发送；它不是启动用户机器上的 `codex` 可执行文件（[`internal/runtime/executor/codex_executor_execute.go#L21-L46`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/internal/runtime/executor/codex_executor_execute.go#L21-L46)、[`internal/runtime/executor/codex_executor_execute.go#L76-L104`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/internal/runtime/executor/codex_executor_execute.go#L76-L104)）。固定提交的实现中也没有 TraeX ACP 或 Cursor CLI executor；README 中出现的相关名称属于外围生态项目介绍，不能作为核心支持能力的证据。

本项目的 `coding-subscription-provider` 明确以 `shell: false` 启动官方 CLI，并声明不读取 credential 文件（[`process.ts`](../plugins/coding-subscription-provider/src/process.ts#L129)）；TraeX 插件则实现 ACP initialize、`session/new`、`session/prompt` 的一轮客户端生命周期（[`acp-client.ts`](../plugins/traex-acp-provider/src/acp-client.ts#L343)）。可迁移的是“raw protocol → normalized event → provider adapter”这类分层思想，不是 CLIProxyAPI executor 本身。

此外，当前 CLIProxyAPI 代码模块已是 Go `v7` 且要求 Go 1.26（[`go.mod#L1-L3`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/go.mod#L1-L3)），同一提交的 SDK 用法文档仍展示 `v6` 导入路径（[`docs/sdk-usage_CN.md#L7-L22`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/docs/sdk-usage_CN.md#L7-L22)）。这至少说明任何直接嵌入方案都必须以代码和可编译 spike 验证，不能只按 README 估算成本。

### 2. 认证：CLIProxyAPI 接管凭据，当前插件有意不接管

CLIProxyAPI 的文件 token store 会把认证 metadata/token 写入 JSON、重新枚举并加载这些文件（[`sdk/auth/filestore.go#L55-L75`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/auth/filestore.go#L55-L75)、[`sdk/auth/filestore.go#L75-L165`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/auth/filestore.go#L75-L165)、[`sdk/auth/filestore.go#L227-L351`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/auth/filestore.go#L227-L351)）。`Auth` 对象同时保存 backing file、token metadata、quota、错误与 refresh 时间（[`sdk/cliproxy/auth/types.go#L46-L94`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/types.go#L46-L94)），conductor 会周期刷新，也会在未授权响应后触发刷新（[`sdk/cliproxy/auth/conductor_refresh.go#L38-L69`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/conductor_refresh.go#L38-L69)、[`sdk/cliproxy/auth/conductor_refresh.go#L460-L550`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/conductor_refresh.go#L460-L550)）。

本项目两插件正好相反：coding 插件通过官方 CLI 的 status 命令做 fail-closed probe（[`auth.ts`](../plugins/coding-subscription-provider/src/auth.ts#L46)），子进程环境显式排除 API key、token 与 endpoint（[`process.ts`](../plugins/coding-subscription-provider/src/process.ts#L99)）；TraeX 同样只调用精确的 `traex login status`，并拒绝交互式认证（[`auth.ts`](../plugins/traex-acp-provider/src/auth.ts#L35)、[`acp-client.ts`](../plugins/traex-acp-provider/src/acp-client.ts#L163)）。因此 OAuth/token manager、多账号凭据池不是可无损复用的优化；引入它们意味着主动修改本项目的安全边界。

### 3. 模型 registry：思想有用，但不是通用动态探测

CLIProxyAPI registry 按 credential/client 注册模型，记录 quota、suspend 状态与支持关系（[`internal/registry/model_registry.go#L114-L130`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/internal/registry/model_registry.go#L114-L130)、[`internal/registry/model_registry.go#L286-L350`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/internal/registry/model_registry.go#L286-L350)、[`internal/registry/model_registry.go#L705-L818`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/internal/registry/model_registry.go#L705-L818)）。但是服务注册时大量使用内置静态 catalog 或配置列表，例如按 Codex plan 选预置模型，而非普遍向上游实时发现（[`sdk/cliproxy/service_models.go#L63-L157`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/service_models.go#L63-L157)）。

coding 插件的 `listModels()` 从 `profile.models` 提供提示性目录，而 `resolveModel()` 接受目录外 model id（[`adapter.ts`](../plugins/coding-subscription-provider/src/adapter.ts#L119)）。这不是 bug：当前依赖 `@deepseek-ai/dsh-llm@0.1.0-rc.6` 的公开契约明确规定模型元数据是 discovery surface、不是 routing whitelist，adapter 可以解析目录外的动态模型；插件 README 也明确写明模型目录不会阻止新模型并会把 id 原样传给 `--model`（[`README.md`](../plugins/coding-subscription-provider/README.md#L16)）。因此 Agent-T 建议的 allowlist 修复反而会收窄现有 DSH 语义。

TraeX 目前选择了更严格的配置 allowlist（[`adapter.ts`](../plugins/traex-acp-provider/src/adapter.ts#L113)），这可以是插件自身策略，但它的配置注释却称 `models` 为“Advisory”（[`config.ts`](../plugins/traex-acp-provider/src/config.ts#L10)）。真正需要修的是这处文档/行为歧义：要么明确它是部署者安全 allowlist，要么像 coding 插件一样接受目录外模型并在 ACP 握手时验证；不能拿 TraeX 的策略倒推 DSH 的全局契约。

TraeX 的真实模型 catalog 只有在 `session/new` 后出现，当前实现已经校验 catalog、请求目标模型并再次确认选择结果（[`acp-client.ts`](../plugins/traex-acp-provider/src/acp-client.ts#L343)、[`acp-client.ts`](../plugins/traex-acp-provider/src/acp-client.ts#L499)）。合理的增强是短 TTL 缓存“已在正常请求握手中观察到的 catalog”，用于改善诊断或模型展示；每次 prompt 前仍须重新校验。为了 `listModels()` 主动启动一个 ACP session 会增加进程、认证与 session 成本，不能仅凭 CLIProxyAPI registry 的存在就认定值得做。

### 4. 调度、重试和 cooldown：仅有界迁移到 prompt 之前

CLIProxyAPI selector 会过滤已阻塞 credential、优先取最高 priority，再在候选间轮询（[`sdk/cliproxy/auth/selector.go#L251-L335`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/selector.go#L251-L335)、[`sdk/cliproxy/auth/selector.go#L369-L395`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/selector.go#L369-L395)）。配置中确有 request retry、最大 credential 尝试数、等待上限、round-robin/weighted/fill-first/session-affinity 与 quota 行为（[`config.example.yaml#L144-L166`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/config.example.yaml#L144-L166)、[`config.example.yaml#L198-L218`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/config.example.yaml#L198-L218)）。

它还按失败原因设置不同范围和时长的 cooldown：未授权/禁止、model unsupported、quota/rate limit、timeout/5xx 并非一律处理（[`sdk/cliproxy/auth/conductor_cooldown.go#L704-L884`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/conductor_cooldown.go#L704-L884)）。这个“错误分类 → 有界健康状态”的模式值得借鉴。

不过两个本地 adapter 都显式关闭 DSH 自动重试（[`coding adapter.ts`](../plugins/coding-subscription-provider/src/adapter.ts#L115)、[`TraeX adapter.ts`](../plugins/traex-acp-provider/src/adapter.ts#L109)）。这是合理的：HTTP 模型调用在首个响应前失败，和本地 coding agent 已经收到 prompt 但还没输出文本，不是同一种幂等边界。coding agent 或 TraeX 可能已读写文件、调用工具、访问网络或消耗额度；“尚未产生 text delta”不能证明“尚未产生副作用”。

可安全考虑 cooldown 的范围应先限制为可证明在 prompt 提交前的失败，例如认证 probe 失败、可执行文件不存在、initialize/`session/new` 明确失败。状态放内存、有短 TTL、按 provider/model 或失败域隔离。prompt 已提交后的失败默认只诊断，不自动重放。

### 5. Streaming：首事件判定很成熟，但安全边界不能照搬

CLIProxyAPI 在向调用者返回 stream 前先读取第一个非空 payload，把立即错误、空 stream 与有效 stream 区分开（[`sdk/cliproxy/auth/conductor_stream.go#L84-L113`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/conductor_stream.go#L84-L113)）。模型池切换只发生在启动/bootstrap 阶段；首个有效 payload 之后，中途错误转发给消费者，而不是悄悄重启一次调用（[`sdk/cliproxy/auth/conductor_stream.go#L204-L340`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/conductor_stream.go#L204-L340)、[`sdk/cliproxy/auth/conductor_stream.go#L379-L423`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/conductor_stream.go#L379-L423)）。

本地 coding adapter 在真正消费 CLI runner 之前就发出 `block-start`（[`adapter.ts`](../plugins/coding-subscription-provider/src/adapter.ts#L183)），TraeX 也类似（[`adapter.ts`](../plugins/traex-acp-provider/src/adapter.ts#L189)）。因此若引入 bootstrap 状态，至少要单独记录 `promptSubmitted`、`assistantTextEmitted` 和 terminal/teardown phase；不能把“DSH 是否已发 block-start”或“是否已有文本”当作唯一重试条件。

### 6. Usage 与 quota：结构化记录可学，“真实剩余额度”不能泛化

CLIProxyAPI 的 usage record 包含 provider、executor、model/alias、auth 标识、latency、TTFT、失败标志和 token detail，并通过队列分发给插件（[`sdk/cliproxy/usage/manager.go#L21-L75`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/usage/manager.go#L21-L75)、[`sdk/cliproxy/usage/manager.go#L212-L367`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/usage/manager.go#L212-L367)）。runtime reporter 会发布 token、失败、延迟和认证维度（[`internal/runtime/executor/helps/usage_helpers.go#L24-L84`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/internal/runtime/executor/helps/usage_helpers.go#L24-L84)、[`internal/runtime/executor/helps/usage_helpers.go#L117-L301`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/internal/runtime/executor/helps/usage_helpers.go#L117-L301)）。

但核心 `QuotaState` 主要表达 exceeded/reason/recovery/backoff，而不是所有 provider 的权威“剩余百分比”（[`sdk/cliproxy/auth/types.go#L167-L195`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/types.go#L167-L195)）。README 中若干 5 小时/7 天 dashboard 是外围生态项目能力，不等同于核心对所有订阅都提供精确 quota。核心的内置 usage statistics 默认也可关闭（[`config.example.yaml#L125-L131`](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/config.example.yaml#L125-L131)）。

当前 TraeX 插件只转发本 session 的文本 `agent_message_chunk`，其他 update 被忽略（[`acp-client.ts`](../plugins/traex-acp-provider/src/acp-client.ts#L293)），README 也明确暂不转发 token usage（[`README.md`](../plugins/traex-acp-provider/README.md#L103)）。ACP SDK 0.25.1 中，token 计数实际位于实验性的 `PromptResponse.usage`；`usage_update` 表达的是 session context-window 使用量与可选成本，二者不能混为一谈。两插件可先建立内部 normalized event/diagnostic，只有实际 CLI/ACP 提供、且与 DSH“uncached input 与 cache read/write 分离”口径核对后的 usage 才向上暴露；没有权威信号时不能推导精确订阅余额。

### 7. 错误与 parser：需要统一上下文，但现有测试并非空白

coding transport 已保留协议失败 reason、exit code 和 signal，并以原始 `cause` 传给 adapter；TraeX 也已有细分的 transport failure code。缺的是跨插件一致的 phase、`promptSubmitted`、`assistantTextEmitted`、terminal 和 teardown 上下文，而不是所有错误信息都被完全丢失。建议先定义内部 `ProviderFailureContext`，再按 DSH 可承载的字段稳定映射。当前 `LlmErrorOptions` 没有任意 phase metadata 槽位，因此这些上下文应先保留在内部错误/cause/诊断日志中；若要成为稳定的顶层 failure 字段，需要先扩展 DSH 契约。

coding parser 当前集中处理 Codex、Claude、Cursor、Grok 多种 JSON 形态（[`process.ts`](../plugins/coding-subscription-provider/src/process.ts#L282)），现有测试已经覆盖成功、malformed、无事件/无文本、认证来源、失败 terminal、异常退出等场景。把真实 CLI 版本输出固化为 fixture、拆成 provider/version capability profile 是合理的维护性增强，但应以捕获到的真实版本样本驱动，不能先假定 CLIProxyAPI 的 translator registry 能替代这些 CLI 专属协议。

## 建议优先级

### P0：确定、局部、可测试

1. 不改变对外错误码的前提下，给两 transport 补统一的内部失败上下文：phase、provider/model、prompt 是否提交、是否输出文本、exit/signal、terminal 状态。原始 `cause` 继续保留。
2. 把 coding parser 拆成 provider/version capability profile 与 normalized reducer，并用捕获自明确 CLI 版本的 fixture 固化成功、认证失败、terminal 失败、partial/malformed 和 usage（若该版本确实提供）合同。
3. 统一 TraeX `models` 的注释、README 与运行语义；保留严格 allowlist 时，应明确这是插件策略，不是 DSH 要求。

### P1：有价值，但须守住副作用边界

1. TraeX 缓存正常请求中已观察到的 model catalog，短 TTL、与配置 allowlist 取交集、请求时重新校验；不默认因 `listModels()` 主动建 session。
2. 对认证 probe、missing executable、initialize/handshake 等可证明的 pre-prompt 失败增加内存级 bounded cooldown；prompt 提交后不自动重试。
3. 先记录可验证的 usage、latency、TTFT、失败 phase；精确 quota 只在官方协议明确给出可信 reset/remaining 信息时提供。

### 暂不建议

- 把两个 npm 插件迁移成 Go 或直接嵌入 CLIProxyAPI SDK。
- 由插件读取、复制、保存或刷新 Codex、Claude、Cursor、TraeX 凭据。
- 引入 OAuth/token manager、多账号池或远程管理 API。
- 为这两个本地 coding agent 增加通用 OpenAI/Claude/Gemini HTTP 代理层。
- 以“尚未输出文本”为条件自动重放 agent turn。
- 宣称可统一展示所有订阅的权威 5h/7d 剩余额度。

## 客观总评

CLIProxyAPI 最值得本项目学习的是运行时状态机与可观测性，而不是它的协议代理、凭据管理或 Go 实现。两项目的共同问题域是“如何稳定选择能力、处理流和失败”；不同的信任边界则是“谁持有凭据、谁真正执行 agent、一次失败能否安全重放”。优化应沿共同问题域吸收模式，同时把不同信任边界当作硬约束。
