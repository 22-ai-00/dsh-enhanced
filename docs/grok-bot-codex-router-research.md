# Grok Bot 0.18 重构仓库的 Codex 路由调研

日期：2026-08-25
外部仓库审计提交：`a9f633e09d49a85829b8236331b9e21f7e612634`

## 执行摘要

这个仓库值得借鉴，但不能直接移植。

它证明了一条重要路径在工程上可行：把宿主工具声明成 Responses function tools，接收 Codex 的 `function_call`，由宿主执行，再用原始 `call_id` 回填 `function_call_output`，循环到最终文本。这个机制解释了为什么“Codex 模型本来支持工具，但改造前的 DSH route 仍然是 text-only”：限制来自当时的 transport/adapter，而不是模型。

不过，该仓库的 Codex 请求没有经过 Codex CLI 或 Codex App Server。它读取 `~/.codex/auth.json`，自行刷新凭据，并直接调用 `https://chatgpt.com/backend-api/codex/responses`。这不是官方文档承诺的公共集成面；仓库本身还是非官方逆向重构，明确没有授予 reconstructed source 的上游源码许可。因此只能 clean-room 借鉴协议与架构，不能复制实现。

> **后续决策（覆盖本报告最初的“不采用”建议）：** 用户明确要求落地同类直连。本项目现已把它实现为默认关闭、必须显式选择 `transport: direct-responses` 的实验路径，并用 OpenAI Codex 当前源码和 fixtures 独立核对 private wire，而不是复制该重构仓库。默认 CLI 路径不变；私有 endpoint、auth 文件布局和 OAuth 刷新仍可能随时失效。

对当前项目，推荐顺序是：

1. 近期：保留官方 Codex CLI 订阅认证，用 `--image` 实现图片输入；用 `--output-schema` 实现类似现有 TraeX 的结构化 tool bridge，输出 DSH 标准 `tool-call`，让现有 Agent Loop/Policy 执行工具。
2. 正式 native route：若可以使用 API key 与 API 计费，新增基于官方 `/v1/responses` 的独立 provider，原生映射图片、function call、usage、cancel 和 replay。
3. 实验路线：评估 Codex App Server 的 `dynamicTools`。它已由官方文档和本机 0.149.0 schema 证明存在，但仍标记为 experimental，而且要求客户端在同一个 Codex turn 中响应工具调用，与 DSH 当前“adapter 先返回 tool-call、Agent Loop 执行、下一 model step 回填”的边界并不直接同构。

不要悄悄把现有 `codex-subscription` 从 `none` 改成全工具权限。工具 bridge 应显式启用，或使用独立 route；图片输入可以作为与工具能力分离的 transport capability 落地。

## 调研范围与可信度

外部仓库是公开 Grok Bot 0.18.0 应用的非官方 source-oriented reconstruction，Router 是作者后加的实验，不是 Anysphere、Cursor 或 OpenAI 的官方实现。[仓库说明](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/README.md#L5-L24)

其 NOTICE 明确写明没有主张或授予上游源码许可，发布或分发前需独立审查权利与服务条款。因此本报告只提炼协议和架构思想，不建议复制源码。[NOTICE](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/NOTICE.md#L3-L15)

本次只读检查了：

- Codex 认证、直接 Responses transport、SSE、tool loop、usage；
- Claude Code 临时 MCP bridge；
- OpenRouter function tools；
- Cursor typed stream、多模态和取消链路；
- 当前 DSH `coding-subscription-provider`、TraeX bridge、route capability 和 Agent Loop 边界；
- OpenAI 官方 Codex App Server、Responses API 与 GPT-5.3-Codex 能力文档；
- 本机 `codex-cli 0.149.0` 的 help 和 experimental App Server JSON Schema。

外部仓库的 Codex 专项行为测试只有三个：文本分片、保留 exact call ID 的两步工具循环、截断 SSE fail-closed。[专项测试](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/tests/codex-direct-responses.test.mjs#L27-L100) 其他 Router 检查相当一部分是源码字符串/正则断言，不足以证明真实认证、取消、权限或多模态行为。[publication checks](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/tests/publication-packaging.test.mjs#L81-L132)

## 外部仓库的 Codex 实现

### 请求链路

它把 Codex CLI 当作登录入口，但 CLI binary 不在实际推理请求路径中。[本地状态判定](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/shared/node/inference-router-local.ts#L43-L54)

运行时链路是：

```text
~/.codex/auth.json
        │
        ├─ 读取 access / refresh / id token 与 account id
        ├─ 首次 401 时自行刷新并重写 auth.json
        ▼
chatgpt.com/backend-api/codex/responses
        │
        ├─ SSE text delta
        ├─ reasoning encrypted content
        └─ function_call
                 │
                 ▼
        Grok Bot 宿主 MCP executor
                 │
                 ▼
        function_call_output → 下一 Responses step
```

凭据读取至少做了普通文件、非 symlink 和 group/other 权限检查，但它随后自行承担 token refresh 与凭据文件替换。[凭据读取](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/extensions/inference/provider-session.ts#L65-L80) [刷新及认证头](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/extensions/inference/provider-session.ts#L82-L131)

### 工具循环

请求会把宿主 schema 转成 Responses function tool，设置 `tool_choice: auto`、`parallel_tool_calls: true`、`stream: true`、`store: false`，并请求保留 encrypted reasoning content。[请求构造](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/extensions/inference/codex-direct-responses.ts#L100-L134)

SSE 层处理文本 delta、output item、completed、failed/error；畸形 JSON、截断 event 和缺失 `response.completed` 都 fail closed。[SSE parser](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/extensions/inference/codex-direct-responses.ts#L42-L70) [事件归并](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/extensions/inference/codex-direct-responses.ts#L137-L160)

当出现 function call 时，它保留完整 output item 与原始 `call_id`，执行宿主工具，再追加相同 `call_id` 的 `function_call_output`。未知工具、非法 JSON 和 executor 异常会变成模型可见的错误结果；最多循环八步。[tool loop](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/extensions/inference/codex-direct-responses.ts#L156-L182)

Codex 没有直连临时 MCP server。Coordinator 先取 Grok Bot MCP schemas，作为 functions 交给 Codex，再把 call 通过内部 RPC 送回宿主 executor。[Coordinator](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/node-agent-coordinator/inference-router.ts#L162-L180) [宿主执行入口](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/host-gateway-api.ts#L141-L163)

### 它没有真正解决 Codex 多模态

尽管底层 Responses 协议和 Codex 模型可以接收图片，这个 Router 的 transcript 与入口仍是字符串。Coordinator 只接受字符串 prompt，并把历史存成字符串。[string-only transcript](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/node-agent-coordinator/inference-router.ts#L10-L20) [string prompt path](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/node-agent-coordinator/inference-router.ts#L121-L152)

即使上层 message content 是数组，Codex provider 也会 `JSON.stringify` 后作为普通文本发送，而不是构造 `input_image`。[内容降格](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/extensions/inference/provider-session.ts#L178-L187)

因此，这个仓库对“工具支持”有参考价值，对“图片输入”没有可直接复用的完成实现。

## 与改造前 DSH 项目的差异

以下是本报告形成时的代码快照；后续 `direct-responses` 实现已经改变这些结论，而默认 CLI transport 仍保持原边界。当时 route 的 text-only 是适配器选择，不是 Codex 模型能力：

- `coding-subscription-provider` 在注册时把所有 route 声明为 `toolCalls: 'none'`：`plugins/coding-subscription-provider/src/index.ts`。
- prompt serializer 遇到 DSH image block 直接报错：`plugins/coding-subscription-provider/src/prompt.ts`。
- Codex catalog 已验证并保留上游 `inputModalities`，但 `listModels()` 和 `resolveModel()` 又固定对外报告 `['text']`：`plugins/coding-subscription-provider/src/codex-catalog.ts` 与 `src/adapter.ts`。
- `stream()` 在认证和 subprocess 之前拒绝非空 `options.tools`：`plugins/coding-subscription-provider/src/adapter.ts`。
- 生成仍走 `codex exec --json ...`，parser 只把 agent message 映射成文本；没有 DSH `tool-call` projector：`plugins/coding-subscription-provider/src/providers.ts` 与 `src/process.ts`。

这组约束是上一轮五断点中用于 fail-closed 的安全边界。它防止把 tool schemas 静默丢掉，但并不代表 Codex 永远只能做文本。

当前项目也已经具备正确的工具执行架构：TraeX 把模型的结构化调用意图映射成 DSH `tool-call` chunks，并以 `finish: tool-calls` 交还 Agent Loop。之后由 DSH 记录 `tool/call`、经过 Policy/预算/allowlist 执行、记录 `tool/result`，再进入下一模型 step。Codex bridge 应复用这个边界，而不是照搬 Grok Bot 的 provider-owned executeTool subloop。

## 官方能力核验

OpenAI 官方文档明确说明 GPT-5.3-Codex 支持图片输入、文本输出、streaming 和 function calling。因此“模型只能文本”这个判断不成立；只能说某个具体 transport 当前只投影了文本。[GPT-5.3-Codex model](https://developers.openai.com/api/docs/models/gpt-5.3-codex)

官方 Responses API 支持文本、图片和文件输入，也支持 custom functions、MCP tools、streaming 和 parallel tool calls。[Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)

官方 Codex App Server 是给 rich client 使用的正式集成面，涵盖认证、会话、审批和流式 agent events。其 stdio transport 是 JSONL；WebSocket transport仍是 experimental/unsupported。[Codex App Server](https://developers.openai.com/codex/app-server)

当前官方 App Server 文档还明确给出：

- `model/list` 返回 `inputModalities`；
- `turn/start.input` 接受 `text`、远程 `image` 和 `localImage`；
- `thread/start.dynamicTools` 与 `item/tool/call` 支持客户端执行 dynamic tool，但该字段和流程仍是 experimental；
- dynamic tool result 可以包含文本、图片和音频 content item。

本机验证结果：

- `codex-cli 0.149.0`；
- `codex exec --help` 提供 `--image`、`--output-schema`，并支持 prompt 从 stdin 读取；
- `codex app-server generate-json-schema --experimental` 生成的 schema 含 `DynamicToolSpec`、`DynamicToolCallParams`、`DynamicToolCallResponse`、`image` 与 `localImage`；
- 当前项目已经用 App Server 的 `initialize + model/list` 做模型目录发现，所以不是从零引入协议。

## 借鉴矩阵

| 外部做法 | 判断 | 当前项目应如何处理 |
| --- | --- | --- |
| Responses function schemas | 借鉴设计 | clean-room 映射 DSH `ToolSchema`；严格校验名称、参数和数量 |
| exact `call_id` continuation | 必须保留 | 绑定 session、provider、principal、schema digest 和 durable call event |
| SSE typed event projector | 借鉴设计 | 加入 deadline、AbortSignal、reader cancel、字节/事件上限和完整终态校验 |
| 多 step usage 累计 | 借鉴设计 | 继续使用 DSH disjoint token accounting；活动统计不冒充账单 |
| Codex 私有 backend 直连 | 已按用户决策实验性采用 | 独立 clean-room 实现；显式 opt-in；固定 endpoint；有界 POSIX auth 读取、单次 401 refresh、CAS 写回和稳定错误分类；默认 CLI 不变 |
| provider 内部执行全部工具 | 不采用 | 输出 DSH `tool-call`，让 Agent Loop/Policy 执行 |
| Claude loopback MCP 拓扑 | 仅借鉴骨架 | 若使用，需精确 allowlist、Host/Content-Type、deadline、并发和租约；annotation 不能授权 |
| 基于名称猜测 destructive/read-only | 不采用 | 使用 DSH Policy 中的声明式 authority 与审批规则 |
| 字符串 transcript / JSON.stringify 图片 | 不采用 | 使用 typed content projection 与 attachment store |
| 并行标志但串行 execute | 不采用 | 并发由 DSH tool scheduler 和工具声明决定 |
| 全局 JSON transcript/usage store | 不采用 | 复用现有 Session、Policy ledger、Delivery/Automation durable stores |

## 原调研建议与实际落地决策

下列 A/B/C 是调研时基于公开接口稳定性给出的原始建议。用户随后明确选择了另一条路线：直接读取本机 Codex ChatGPT session 并请求私有 Responses endpoint。实际实现因此以独立的 `direct-responses` transport 落地，同时保留这些方案作为未来迁移到公开、稳定接口时的备选。

### A. 近期首选：官方 CLI 上的显式 bridge

为订阅 route 增加两个彼此独立的能力：

1. 图片：从 `ctx.attachments` 读取、校验并限额，写入单次调用私有临时目录，以重复 `--image <file>` 传给 Codex；调用完成或取消后清理。模型 metadata 应报告 catalog 与 transport 的能力交集，而不是固定 `['text']`。
2. 工具：复用 TraeX 的 bridge 语义，按本次 `options.tools` 生成严格 output schema，通过 `codex exec --output-schema` 约束最终结果为“final text”或“DSH tool calls”。Adapter 只投影 `tool-call` chunks，不执行工具。
3. prompt 改走 stdin，避免大段会话继续出现在 process argv；仍保留 shell-free spawn、canonical live-session cwd、环境变量过滤、timeout、output bounds 和进程组 teardown。
4. bridge 默认关闭，显式启用后才把 route capability 从 `none` 注册为 `bridge`。现有安装不应被静默扩权。

这条路径不能称为 Codex 原生 function calling，但最符合当前 DSH 的 LlmAdapter/Agent Loop 边界，且不需要接触私有 OAuth token。

### B. 生产级 native route：官方 Responses API

如果部署接受 API key 与独立 API 计费，新增单独 provider，而不是改变订阅 route：

- typed `input_text` / `input_image`；
- native function call → DSH tool-call；
- 下一 DSH step 把 tool result 映射为 `function_call_output`；
- 保存 encrypted reasoning replay state；
- 全链路 cancel、deadline、usage、error mapping 与 no-unsafe-retry。

这是与 DSH Agent Loop 最自然的协议匹配，也是把 Grok Bot 的好思路转为官方、可维护实现的最佳方式。

### C. 实验路线：Codex App Server dynamic tools

App Server 值得做 spike，但不应直接替换 A：

- 优点：继续使用 Codex 自己管理的登录；原生图片；rich events；官方协议；本机版本已有 schema。
- 约束：`dynamicTools` 仍 experimental；工具请求要求客户端在同一 turn 内响应，而 DSH adapter API 只有 schemas，没有 `executeTool` callback。
- 若 adapter 自己调用工具，就会绕过现有 Agent Loop 的 durable call/result、Policy、预算与审批。
- 若要保持 DSH 边界，需要设计有状态的 pending-call/replay handoff，或先在 DSH 核心增加一个受信、可审计的 executor seam；这不是简单改 parser。

因此 App Server spike 的验收条件应是：在不绕过 DSH Agent Loop/Policy 的前提下完成一轮 exact tool call、重启恢复、取消、拒绝、歧义副作用和图片输入。未满足前只标记 experimental。

## 必须保留的安全与可靠性边界

- 工具 schemas 必须是 preset 挂载和 scoped allowlist 后的精确快照。
- 每个 call 绑定 session、principal、provider/model、cwd、tool schema digest 和 call id。
- 工具实际执行只能进入现有 Policy → budget → owner approval → audit/settlement 链。
- 不信任 MCP annotations、模型声称的 principal、工具名称启发式或 provider 内部批准。
- AbortSignal 贯穿 attachment read、subprocess/fetch、protocol reader 和 pending bridge。
- 对 prompt、schema、图片总量、单行、stdout/stderr、SSE event、tool count、arguments 和 results 分别设上限。
- 只在能证明工具尚未开始执行时重试；出现 timeout/断线后的歧义副作用必须停车等待 reconciliation 或人工处理。
- App Server thread 若用于 bridge，应 ephemeral、按 Agent/session 隔离，不能复用过期工具目录。
- 私有临时图片和 schema 文件使用 `0700` 目录、`0600` 文件并确定性清理。
- route capability 应反映 transport，不把“模型支持”直接等同于“当前 adapter 支持”。至少分别表达 input modalities、tool mode 与 experimental readiness。

## 最小验证清单

正式改代码时至少需要这些先失败后通过的测试：

1. catalog 声明 image 且 CLI 支持时，model metadata 不再被强制降为 text-only。
2. image bytes 由 attachment store 读取并正确传递；MIME、大小、数量、历史总量、取消和清理 fail closed。
3. 有工具时生成 bounded output schema；普通 final 与一个/多个 tool calls 正确分流。
4. unknown tool、重复 call id、非法 arguments、超大 arguments、混合 prose、畸形 JSON 均 protocol error。
5. Adapter 只输出 DSH tool-call；真实 executor 仍由 Agent Loop/Policy 调用。
6. Policy denial、预算不足、飞书审批、重启 replay、unknown-after-side-effect 不产生重复执行。
7. auth、catalog、generation 之前仍复核 live session 与 canonical cwd。
8. abort/timeout 后 prompt submission state、assistant text、teardown 与 ambiguity 状态可观测。
9. bridge 未显式启用时仍注册 `none`；启用并通过版本/能力检查时才注册 `bridge`。
10. App Server spike 需覆盖 experimental capability negotiation、dynamic tool request/response、图片、turn interrupt 和进程退出。

## 最终判断

这个外部仓库回答了“能不能”的一半：Codex 订阅态确实可以被改造成会调用宿主工具的 router；但它依靠未公开 endpoint，且没有真正实现用户图片输入，也没有 DSH 所需的 Policy、预算、审批、取消和 durable settlement 边界。

当前项目已经 clean-room 借鉴 typed function-call 编排、exact `call_id`、usage、encrypted reasoning replay 和 provider-specific transport，并按用户决策采用私有认证与 endpoint；但没有采用 provider-owned tool execution、字符串多模态或启发式授权。工具仍回到 DSH Agent Loop / Policy，图片仍走 typed attachment seam。

当前实际落地点是显式 opt-in 的 `direct-responses`，默认 CLI 行为不变。后续若公开 Responses 订阅接口或稳定 App Server handoff 能覆盖同一能力，应优先迁移；在此之前必须把这条私有路径视为可随时中断的兼容实验，而不是 OpenAI 官方支持的第三方集成。
