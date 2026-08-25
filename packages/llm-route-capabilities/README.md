# @dsh-enhanced/llm-route-capabilities

普通、非激活型 TypeScript 库，用于把 provider/model 的工具调用能力声明附着到一个精确的 DSH `LlmRuntime` 实例。它不声明 `dsh.bundle`，也不会向 profile 注入任何 Cordis patch。

能力分为 `none`（不能接收 DSH tools）、`native`（原生 tool-call stream）和 `bridge`（由 provider 的受约束协议桥接为 DSH tool calls）。精确 model 声明覆盖 provider 声明；重复 selector 会失败，卸载 disposer 只撤回自己注册的声明。
