# @dsh-enhanced/llm-route-capabilities

普通、非激活型 TypeScript 库，用于把 provider/model 的工具调用能力声明附着到一个精确的 DSH `LlmRuntime` 实例。它不声明 `dsh.bundle`，也不会向 profile 注入任何 Cordis patch。

能力分为 `none`（不能接收 DSH tools）、`native`（原生 tool-call stream）和 `bridge`（由 provider 的受约束协议桥接为 DSH tool calls）。精确 model 声明覆盖 provider 声明；重复 selector 会失败，卸载 disposer 只撤回自己注册的声明。

本库也提供 `createAgentLoopRequestAttestor()`，供本机子进程 provider 跨
`dsh-llm` 包副本及 adapter 请求克隆验证 Agent Loop 来源。它使用 Host 的
`AgentRegistry` initiator，要求 Agent 仍为 `running`、registry 与 `sessions`
返回同一个 Agent/Session 对象，并从该 Session 的 request header 与 derived
messages 重建完整普通对话请求。唯一允许的消息差异是 DSH rc.8
`forAdapter()` 为跨 route 历史删除 `replayState` 时产生的冻结副本；辅助调用、
任意嵌套调用、过期 Session 与其他变形均失败关闭。该证明不替代 provider
自己的静态授权目录或 canonical cwd 复核。
