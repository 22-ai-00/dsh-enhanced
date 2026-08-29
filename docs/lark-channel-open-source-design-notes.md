# 飞书连接与会话模型选择：开源方案研究记录

> **历史研究。** 本文保存设计依据，不作为当前行为说明；当前配置、安全边界和使用方式见 [`lark-channel` README](../plugins/lark-channel/README.md) 与 [`assistant-delivery` README](../plugins/assistant-delivery/README.md)。

本文记录 `lark-channel` / `assistant-delivery` 对飞书官方实现与社区项目的设计借鉴。结论用于独立实现边界与测试，不复制第三方源码。

## 结论

当前实现继续采用飞书官方 Node SDK 的 `WSClient + EventDispatcher + Client`，无需公网回调地址。连接层保持“薄”：收到事件后只做标准化并等待 durable Inbox 落盘，然后尽快返回；Agent 推理和最终回复异步进行。模型选择属于渠道无关的会话控制面，放在 `assistant-delivery`，不放进飞书 transport。

这与官方长连接约束相符：本地只需访问公网，但事件处理超过 3 秒会触发重推；同一应用的多客户端是竞争消费而不是广播。[飞书官方 Node SDK：长连接模式](https://github.com/larksuite/node-sdk#subscribing-to-events-using-long-connection-mode)

## 参考实现与采用项

| 来源 | 值得借鉴 | 本仓库采用方式 |
| --- | --- | --- |
| [飞书官方 Agent 接入说明](https://open.larkoffice.com/document/mcp_open_tools/integrating-agents-with-feishu/overview) | 官方授权入口与应用接入流程 | setup wizard 使用官方设备授权并允许选择已有应用或创建新应用 |
| [飞书官方 Node SDK](https://github.com/larksuite/node-sdk) | `WSClient` 长连接、`EventDispatcher`、typed OpenAPI client | 当前生产 transport；凭据生命周期仍由 Keychain lease 和 Cordis disposer 管理 |
| [官方 `@larksuite/channel`](https://github.com/larksuite/channel-sdk-node) | 自动重连、keepalive、消息归一化、按 chat 串行、富媒体和卡片；`registerApp` 一键授权 | `registerApp` 已用于 onboarding；高层 channel 作为未来富媒体/keepalive 迁移候选，不引入其内存 policy/dedup 作为第二真源 |
| [`omdsh-dev/dsh-lark`](https://github.com/omdsh-dev/dsh-lark) | `/model` 展示宿主目录、交互式选择、`/new` 保持模型选择、后台服务监管 | 独立实现为 Delivery 通用 typed intent；选择写入 Delivery SQLite，飞书只渲染受限卡片并转交签名回调 |
| [飞书卡片交互组件](https://open.feishu.cn/document/common-capabilities/message-card/add-card-interaction/interaction-module?lang=zh-CN) | 静态下拉框、按钮与 callback behavior | schema 2.0 卡片让 provider/model/effort 各自即时 callback 并原位重绘，不混用 `form_submit` |
| [OpenClaw 飞书插件](https://github.com/openclaw/openclaw/tree/main/extensions/feishu) | channel 作为可安装扩展，不把飞书协议揉进 Agent 核心 | 保持 `lark-channel`、`assistant-delivery`、Policy/Memory 等包可独立发布与组合 |

## `/model` 的实现取舍

1. `/model`、`/model use ...`、`/model reset` 在 Agent follow-up 之前截获，所以失效的默认模型不会阻断自救。
2. 列表读取 DSH `ctx.llm.listProviders()` 与 `listModels()`；各 provider 并行读取，单项失败不会让整个目录失败，最多展示 50 个模型。
3. `provider/model` 按第一个 `/` 分割，允许模型 id 自身继续包含 `/`；provider 必须已经注册。
4. 覆盖以 canonical conversation 的 SHA-256 key 写入 SQLite，不绑定某一 generation，因此 `/new` 清上下文但保留模型偏好。
5. 切换只改变下一次 `agents.resume()` 的 model selection，不修改 session id，也不把控制命令写入模型上下文；显式 effort 会随 provider/model 一起传给下一轮。

社区 `dsh-lark` 的交互式模型选择证明了卡片体验的价值，但本仓库没有开放任意 card JSON。Delivery 现在只接受有界的 typed `model-picker` intent；Lark adapter 把它渲染为 provider、model、effort 三个彼此独立的静态选择器和一个普通确认按钮。模型标签包含 provider 前缀，确认后还会校验 provider/model 对应关系。

提交 capability 用 app secret 做 HMAC 签名，并绑定 operation、binding、chat、expiry、动作、revision 与当前 provider/model/effort；SDK 边界只接收 `action.option` 和签名 callback value，不依赖控件名或 `action.form_value`。固定的 Node SDK 版本会忽略 `type=card` 长连接帧，因此 transport 在 SDK 边界补充分片合并、EventDispatcher 分发和 ACK 兼容桥。Delivery 用 schema v5 SQLite CAS 保存权威 revision，旧卡片回调只能重绘当前状态。确认回调在第一次异步模型探测前持久领取 operation 并立即响应飞书，带租约和 fencing token 的 worker 会在启动与 tick 时恢复未完成任务；提交前再次核对 active binding、owner principal、chat、Policy，并用实时 `resolveModelInfo()` 验证模型和 effort。选择、结算结果和 durable Outbox 确认在同一事务中提交。文字 `/model use` 和 `/model reset` 继续作为渠道无关后备。

## Reaction 与执行进度的实现取舍

1. 借鉴 OpenClaw 和 Hermes 的轻量状态反馈，但采用飞书精确表情类型 `Get` / `DONE`：只有消息完成鉴权、去重并持久化为 `queued` 后才异步添加 `Get`，最终回复 API 成功后才追加 `DONE`。展示失败不会改变 Inbox/Outbox 状态。
2. 一键建应用补入最小权限 `im:message.reactions:write_only`；不申请 reaction 读取权限，也不删除 `Get`，避免为了展示状态扩大权限和引入“先查再删”的竞态。
3. 借鉴 `omdsh-dev/dsh-lark` 的原生 `message_cot` 事件队列与终态，但不转发其原始 reasoning、工具参数或工具结果。Delivery 只产生强类型的 `started / tool-started / tool-finished / todos / completed / failed`，Lark 侧再渲染固定 AG-UI 事件。
4. 原生进度接口不属于 pinned Node SDK 的高层稳定 API，因此明确是可关闭、可降级的展示层。最终答案始终使用现有持久 Outbox，进度失败不能触发 Agent 重试或吞掉回复。

更完整的 API、权限、社区对照和安全边界见[飞书消息 Reaction 与安全进度展示研究](lark-message-reactions-and-progress-notes.md)。

## 为什么暂不整体切换到高层 Channel SDK

官方 `@larksuite/channel` 已经提供重连、keepalive、dedup、stale-drop、按 chat 串行以及多种出站格式，是后续减少协议维护成本的首选候选。[官方 Channel SDK 能力清单](https://github.com/larksuite/channel-sdk-node#capabilities)

但本仓库已经由 `assistant-delivery` 持有 durable dedup、租约、同 binding 串行、重试和 unknown-after-send 语义。如果直接同时开启 Channel SDK 的内存 dedup/retry/policy，会出现两个状态机，难以判断谁是恢复真源。因此迁移时只应先替换 WebSocket/消息归一化/富媒体 transport，并显式关闭或适配重叠的内存可靠性功能；通过崩溃、重连、重复事件和未知发送测试后再切换。

## 后续优先级

- P1：为 WebSocket 增加独立 keepalive/watchdog 和退避可观测性，或以兼容层接入官方 Channel SDK 的 transport 生命周期。
- P2：可选同步飞书原生 slash-command 菜单，让输入 `/` 时能发现 `/model`；同步失败不能影响手工命令。
- P2：逐类接入 `post`、合并转发、图片和文件，继续让二进制权限、隔离和 durable operation 留在 Delivery 边界。
