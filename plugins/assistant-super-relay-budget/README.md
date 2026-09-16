# @dsh-enhanced/assistant-super-relay-budget

为 `assistant-goals` 提供固定的 Super Relay OpenAI Responses 路由，以及同生命周期的保守 token 预算计量。它只注册 `super-relay` provider，并且只接受单一模型 `auto_model/alwaysday1`；不能改 endpoint、模型别名或 context window。

普通界面调用会等待一次完整、受字节限制的 JSON Responses 调用，随后才向 DSH 发出 blocks；它不是流式 UI。目标预算使用固定 `200,000` 输入 token 上界——这是在网关未公开官方 context window 时采用的保守值，而非从其文档抄得的硬容量。网关没有公开定价，因此 USD 费率刻意为 `null`，绝不估算或伪造 cost。

## 安装与配置

先安装并配置 `assistant-goals` 的有限 `executionBudget`。本插件仅在 `enabled: true` 时启用；此时若 Goals 预算能力不存在，整个路由不会注册。

```yaml
- id: dsh-enhanced-assistant-super-relay-budget
  name: '@dsh-enhanced/assistant-super-relay-budget'
  config:
    enabled: true
    apiKeyEnv: SUPER_RELAY_API_KEY
    timeoutMs: 60000
    maxResponseBytes: 4194304
    defaultMaxTokens: 8192
```

字段约束：

- `enabled`（默认 `false`）：关闭时不注册 adapter，也不注册任何 meter。
- `apiKeyEnv`（默认 `SUPER_RELAY_API_KEY`）：DSH credential reference 的**环境变量引用名**，必须匹配 `^[A-Z_][A-Z0-9_]*$`。它不是 API key，配置绝不接受明文 key。
- `timeoutMs`（默认 `60000`，范围 `1000`–`300000`）：单次上游调用的硬竞速上限。
- `maxResponseBytes`（默认 `4194304`，即 4 MiB）：响应体字节上限。
- `defaultMaxTokens`（默认 `8192`，上限 `32768`）：wire `max_output_tokens` 的缺省值；实际取值始终来自受限的 DSH request。

配置 Proxy 拒绝非对象入参和任何未知字段，`normalizeConfig()` 返回冻结对象。

## 凭证

每次请求优先通过 `ctx.credentials.resolve()` 读取 `apiKeyEnv` 指向的引用；仅在当前 adapter 尚未观察到 credentials 服务且该服务不存在时，才读取同名进程环境变量。一旦观察过该服务，服务移除、拒绝或解析失败都会拒绝请求（`MISSING_CREDENTIAL`），不回退环境变量。请求头携带 `Authorization: Bearer <key>`；key 只在内存中短暂使用，不会被记录或回显。

## 协议契约与限制

固定使用 `POST https://super-relay.byted.org/v1/responses`（OpenAI **Responses** 协议，不是 Chat Completions）、`stream: false`、`redirect: 'error'`、`credentials: 'omit'`，没有自动重试、图片/文件 API、全局 fetch patch 或额外 wire 字段。

- system prompt 必须走顶层 `instructions` 字段；直接传 `system` role 消息会被拒绝。
- 工具以 Responses `tools` 发送；响应中的 `function_call` item 映射为 DSH `tool-call` block，finish 置为 `tool-calls`。
- 校验响应 `status`、`output` 数组与 `usage`（要求 `total_tokens === input_tokens + output_tokens`）；未知 status、非数组 output、usage 不一致均 fail closed。空完成抛 `EMPTY_RESPONSE_CODE`。
- `incomplete` 状态仅接受 `reason === 'max_output_tokens'`，其余拒绝。

### 硬竞速取消

请求取消、超时和插件卸载不能依赖被取消的 fetch/stream 自己结束——非配合的网关可能忽略 abort 信号而让调用方永久挂起。adapter 因此对每个不可信异步边界使用独立的 `bounded()` 硬竞速：即使上游忽略 `AbortSignal`，调用方也会在 `timeoutMs` 确定地 reject。这与 assistant-policy 中修复 approval waterfall 冻结所用的同一类保证。

### 短期 primary-source contract

协议契约 id 为 `super-relay-responses-2026-09-14`，`checkedAt = 2026-09-14`，`expiresAt = 2026-10-14`。契约基于对真实 endpoint 的非合成探测建立。过期后每个新 request 与每次目标预算计量都会 fail-closed 拒绝，直到维护者用新的 primary-source 证据复核并更新 `src/contract.ts`。

## 卸载与生命周期

`apply()` 先为每个 model 注册一个 goal budget meter，再注册 provider adapter；任一注册失败都会逆序回滚已注册项并 shutdown adapter。`ctx.effect()` 注册的清理逻辑在卸载时逆序撤销 adapter、释放所有 meter 并 shutdown；shutdown 后 adapter 翻转为非活动态，后续 stream 直接拒绝。

## 测试与证据边界

包内 `tests/index.spec.ts` 是**工程层测试**：通过 adapter deps 注入假 `fetch`、伪造 cordis 服务面运行，不发起任何真实网络请求、不使用真实密钥。它们 pin 住配置校验、Responses 请求/响应映射、usage 校验、凭证解析、contract 过期门、meter 路由/maxTokens 校验、硬超时与卸载语义，但**不构成真实 Super Relay 外部系统行为的证据**。真实协议结论以 `src/contract.ts` 的短期 primary-source contract 为准；真实配对评测须在 assistant-evaluation 中以真实 `SUPER_RELAY_API_KEY` 单独执行，其费率/cost 字段如实给 `null`。

## 权限与数据

- 网络：仅向固定 Super Relay HTTPS endpoint 发出 Responses 请求，禁止重定向、不携带 cookie。
- 凭据：每次调用短暂读取 credential reference 或环境变量；不会记录 key 或原始响应。
- 文件系统、子进程、浏览器、安装脚本：无。
- 普通前台调用同样使用该 adapter；Goals 预算只对处于已绑定目标执行的 Agent 生效，部署者仍须为前台使用配置 DSH 自身的权限与成本控制。
