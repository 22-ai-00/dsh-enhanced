# @dsh-enhanced/assistant-deepseek-budget

为 `assistant-goals` 提供固定的 DeepSeek v4 文本与工具调用路由，以及同生命周期的保守 token 预算计量。它只注册 `deepseek-goal-metered`，并且只接受 `deepseek-v4-flash` 和 `deepseek-v4-pro`；不能改 endpoint、模型别名或 context window。

普通界面调用会等待一次完整、受字节限制的 JSON completion，随后才向 DSH 发出 blocks；它不是流式 UI。目标预算保留使用固定 `2,097,152` 输入 token 上界，以涵盖官方所述 1M context 的十进制或二进制歧义。USD 费率刻意为 `null`，不把文档价格表误称为硬账单上限。

## 安装与配置

先安装并配置 `assistant-goals` 的有限 `executionBudget`。本插件仅在 `enabled: true` 时启用；此时若 Goals 预算能力不存在，整个路由不会注册。

```yaml
- id: dsh-enhanced-assistant-deepseek-budget
  name: '@dsh-enhanced/assistant-deepseek-budget'
  config:
    enabled: true
    apiKeyEnv: DEEPSEEK_API_KEY
    timeoutMs: 60000
    maxResponseBytes: 4194304
    defaultMaxTokens: 8192
```

`apiKeyEnv` 是 DSH credential reference，不是 API key。每次请求优先通过 `ctx.credentials.resolve()` 读取它；仅在当前 adapter 尚未观察到该服务且服务不存在时读取同名进程环境变量。一旦观察过该服务，服务移除、拒绝或解析失败都会拒绝请求，不回退环境变量；凭据等待期间服务被替换也会拒绝派发。配置不接受明文 key。`defaultMaxTokens` 最大为 32768；实际 wire `max_tokens` 始终来自受限的 DSH request。

## 协议契约与限制

实现固定使用 `POST https://api.deepseek.com/chat/completions`、`stream: false` 和 `redirect: 'error'`，没有自动重试、图片/文件 API、全局 fetch patch 或额外 wire 字段。它支持 text、reasoning replay 和 function tools；未知 DSH 内容、非精确 provider/model、无 usage、多个 choice、不一致 usage 或 finish 均 fail closed。请求取消、超时和插件卸载会 abort 正在进行的 fetch；卸载也撤销 adapter 和两个 meters。

契约会在 2026-10-08 失效。失效后每个新 request 和每次目标预算计量都会拒绝，直到维护者复核并更新。依据：DeepSeek [Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion/) 和 [pricing/context documentation](https://api-docs.deepseek.com/quick_start/pricing/)（checked 2026-09-07）。本包没有真实付费调用测试。

## 权限与数据

- 网络：仅向固定 DeepSeek HTTPS endpoint 发出 completion 请求，禁止重定向。
- 凭据：每次调用短暂读取 credential reference 或环境变量；不会记录 key 或原始响应。
- 文件系统、子进程、浏览器、安装脚本：无。
- 普通前台调用同样使用该 adapter；Goals 预算只对处于已绑定目标执行的 Agent 生效，部署者仍须为前台使用配置 DSH 自身的权限与成本控制。
