# CLIProxyAPI：Provider 设计依据

上游研究截点为 2026-08-18，固定提交 [`d3a5988`](https://github.com/router-for-me/CLIProxyAPI/tree/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0)。本页保留来源和可迁移的设计依据；旧实施计划与复核流水从 Git 历史查询。当前行为以 [Coding provider](../plugins/coding-subscription-provider/README.md)、[详细参考](coding-subscription-provider-reference.md) 和 [TraeX provider](../plugins/traex-acp-provider/README.md) 为准。

## 当前实现对应关系

按本仓库代码复核（2026-09-20）：

| 机制 | 当前实现与边界 |
| --- | --- |
| 生命周期诊断 | Coding 的 [CLI transport](../plugins/coding-subscription-provider/src/process.ts) 与 TraeX 的 [ACP client](../plugins/traex-acp-provider/src/acp-client.ts) 已有 `ProviderFailureContext`：phase、prompt submission、文本观察、terminal、teardown 与明确起点的延迟。诊断不改变结算结果。 |
| 模型发现 | TraeX 已有有界 catalog cache 和不提交 prompt 的目录探针；执行仍以每次新 session 的 catalog 为准。配置和目录边界见 [README](../plugins/traex-acp-provider/README.md)。 |
| 工具归属 | 两个 provider 把工具请求交还 DSH Host，由 ToolRuntime、Policy、审批与审计执行；供应变化不能扩展工具权限。 |
| 凭据归属 | CLI/ACP 路线由官方客户端管理凭据；Codex 默认 direct Responses 路线已显式读取本机 auth 文件，并支持受限刷新与写前比较、原子替换。跨进程并发保护仅为 best-effort。旧研究的“两插件均不读凭据”结论不能套用于 direct 路线。 |
| usage 与重放 | TraeX 的原始 ACP usage 仅作诊断，不能冒充 DSH TokenUsage 或订阅余额。已提交的 provider 请求不自动重放；上层有界续跑是新的调用。 |

## 保留的上游依据

- **分层。** CLIProxyAPI 分离认证、executor 和 translator；其 executor 直接访问上游 HTTP API，不能当成官方 CLI 或 ACP 适配 SDK。见固定版本的 [executor 接口](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/executor/types.go#L59-L69) 与 [Codex executor](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/internal/runtime/executor/codex_executor_execute.go#L21-L104)。可迁移协议分层与诊断方法，不能直接复用其授权责任。
- **认证。** 上游自管 token 文件和刷新状态，见 [file store](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/auth/filestore.go#L55-L165)。任何新增凭据读取、刷新、账号池或代理路径都需要独立定义权限与生命周期，不能由引用该实现隐式获得。
- **发现与执行分离。** 上游 registry 维护支持关系，也使用静态 catalog，见 [service models](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/service_models.go#L63-L157)。目录或缓存不是一次实际请求的成功证明。
- **失败状态。** 上游按失败类型管理 cooldown，见 [conductor cooldown](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/conductor_cooldown.go#L704-L884)。本地 Agent 已接收 prompt 后可能产生副作用或计费；没有输出文本不能证明未提交或允许重试。
- **流与计量。** 上游区分启动失败与流中断，并记录 usage，见 [stream conductor](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/auth/conductor_stream.go#L84-L113) 和 [usage manager](https://github.com/router-for-me/CLIProxyAPI/blob/d3a5988fc07d96f90cb1c2e3b2b7dfb9c2a310e0/sdk/cliproxy/usage/manager.go#L21-L75)。这些结构不能证明另一供应商的 token 口径、计费或权威剩余额度。

模型供应工程服务于稳定执行。项目的自迭代验收仍是同供应、同预算的新任务复用收益，见 [RSI 当前状态](rsi-status.md)。本页没有重新探测上游服务，也不声明生产端到端验收完成。
