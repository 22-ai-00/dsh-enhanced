# 飞书消息 Reaction 与安全进度展示研究

> 研究目标：为 `lark-channel` 增加“收到消息后标记 `Get`、成功完成后标记 `DONE`”以及安全、可审计的执行进度展示。本文以飞书官方 API、官方 Node/Channel SDK 为准，结合 OpenClaw、`dsh-lark-link` 和 `omdsh-dev/dsh-lark` 的实现进行取舍。

## 结论

建议采用两条彼此独立的展示链路：

1. **Reaction 是轻量状态信号**：消息通过鉴权、去重并持久化进入 Inbox 后，在原始消息上添加 `Get`；最终回复已经可靠进入发送队列或得到飞书发送成功确认后，再添加 `DONE`。
2. **进度卡片是可选的实时预览**：只展示经过清洗的阶段、工具类别、成功/失败状态和显式可公开的推理摘要；不展示模型原始 Chain-of-Thought、系统提示词、工具参数、工具原始返回、密钥或本地敏感路径。
3. **最终回答仍走现有持久化 Delivery Outbox**：reaction 和进度失败只能导致“界面降级”，不能使消息处理或最终回答失败。
4. **首版不必删除 `Get`**：保留 `Get` 并追加 `DONE` 最稳妥，不需要读取 reaction，也不会因删除失败造成错误状态。如果产品希望完成时替换 `Get`，必须保存创建接口返回的 `reaction_id`，再按 ID 删除。

推荐生命周期：

```text
收到事件
  -> 鉴权 / 路由 / 去重
  -> Inbox 持久化成功
  -> 异步添加 Get
  -> 执行中：更新同一张“执行进度”卡片
  -> 任务语义成功 + 最终回复可靠入队/发送成功
  -> 在同一发送 lane 中添加 DONE

失败或取消
  -> 进度卡片标记失败/已取消，并尽力发送错误说明
  -> 不添加 DONE
```

## 1. 飞书 Reaction 官方能力

### 1.1 API 与权限

| 操作 | API | 关键返回/限制 | 所需权限 |
| --- | --- | --- | --- |
| 添加 reaction | `POST /open-apis/im/v1/messages/:message_id/reactions` | 请求体为 `{ "reaction_type": { "emoji_type": "Get" } }`；成功返回 `reaction_id`，应保存它以便精确撤销 | `im:message` 或最小权限 `im:message.reactions:write_only` |
| 删除 reaction | `DELETE /open-apis/im/v1/messages/:message_id/reactions/:reaction_id` | 只能删除当前调用身份自己添加的 reaction；`message_id` 与 `reaction_id` 必须匹配 | `im:message` 或 `im:message.reactions:write_only` |
| 查询 reaction | `GET /open-apis/im/v1/messages/:message_id/reactions` | 支持按 `reaction_type` 筛选并分页，返回 reaction ID、操作者和表情类型 | `im:message.reactions:read` 或 `im:message:readonly` |

以上接口均支持 tenant/user access token；应用需要启用机器人能力，而且调用身份必须能访问目标消息所在会话。添加和删除接口限流为每分钟 1000 次、每秒 50 次。详见飞书官方的[添加消息表情回复](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create)、[删除消息表情回复](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/delete)和[获取消息表情回复](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/list)文档。

本需求应使用的精确 `emoji_type` 为：

| 用途 | `emoji_type` | 备注 |
| --- | --- | --- |
| 已收到/已受理 | `Get` | 大小写敏感，不能写成 `GET` |
| 已完成 | `DONE` | 全大写 |
| 正在处理（可选替代） | `Typing` | OpenClaw 使用它作为临时处理中标记 |

这些值来自飞书官方[表情类型说明](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce)。首版建议严格白名单化为 `Get`、`DONE`，不要让模型生成任意 `emoji_type`。

### 1.2 官方 Node Channel SDK

飞书官方 Channel SDK 已封装以下辅助方法：

```ts
addReaction(messageId, emojiType): Promise<string>
removeReaction(messageId, reactionId): Promise<void>
removeReactionByEmoji(messageId, emojiType): Promise<boolean>
```

`addReaction` 返回 `reaction_id`；官方文档也明确说明 reaction 事件本身不包含 `reaction_id`，因此创建方应自行保存返回值。参见官方 Node SDK 的 [Channel API 文档](https://github.com/larksuite/node-sdk/blob/main/docs/channel.md#low-level-helpers)和 [channel-sdk-node API](https://github.com/larksuite/channel-sdk-node#api)。

官方 SDK 的 `removeReactionByEmoji` 是先查询、再删除筛选出的应用 reaction；其实现只筛选 `operator_type === "app"`，并不校验具体应用 ID。在多个机器人可能使用同一 emoji 的环境里，主路径应当使用创建时保存的 `reaction_id`，不要依赖“按 emoji 删除”。实现细节见官方 [channel.ts](https://github.com/larksuite/channel-sdk-node/blob/main/src/channel.ts#L571-L630)及其[测试](https://github.com/larksuite/channel-sdk-node/blob/main/src/__tests__/channel-api.test.ts#L160-L265)。

### 1.3 落地前的授权缺口与当前修复

落地前，一键建应用只申请了机器人基础信息、接收单聊/群聊消息和机器人发消息权限，尚未包含 reaction 写权限。当前实现已在 [`plugins/lark-channel/src/setup.ts`](../plugins/lark-channel/src/setup.ts) 追加最小权限：

```text
im:message.reactions:write_only
```

- 对一键创建的新应用：在创建/授权清单中直接加入该 scope。
- 对已经绑定的应用：提示管理员补充权限、重新发布应用版本，并在需要时重新授权；插件启动时可做一次能力探测并给出明确修复指引。
- 若仅保留 `Get` 并追加 `DONE`，或始终按已保存的 `reaction_id` 删除，则不需要 reaction 读取权限。
- 添加机器人自身 reaction 不需要订阅 reaction 事件；只有要消费“用户添加/删除 reaction”时才需要相关事件订阅。

## 2. Reaction 的完成、撤销与失败语义

### 2.1 推荐语义

| 状态 | 行为 | 原因 |
| --- | --- | --- |
| 事件尚未通过鉴权/路由 | 不添加 `Get` | 避免对无权处理、非触发消息或攻击流量作出反馈 |
| 重复事件 | 不重复添加 | 以 `accountId + messageId + phase` 做幂等键 |
| Inbox 持久化成功 | 异步添加 `Get` | 表示系统已经可靠接单，而不是仅收到 WebSocket 包 |
| 执行中 | 可更新进度卡片 | reaction 不适合承载细粒度进度 |
| 任务逻辑完成但最终回复未可靠入队/发送 | 暂不添加 `DONE` | 否则用户会看到“完成”却没有结果 |
| 最终回复可靠入队或发送成功 | 添加 `DONE` | 建议与最终回答使用同一会话 lane，保证最终回答在前 |
| 失败、取消或超时 | 不添加 `DONE` | 更新状态卡片/发送简短错误说明；可未来增加独立失败 reaction |
| Reaction API 失败 | 记录可观测指标并降级 | 不回滚任务，不阻断最终回答 |

如果希望“完成后把 `Get` 替换为 `DONE`”，推荐顺序是：**先添加 `DONE`，成功后再按保存的 `reaction_id` 删除 `Get`**。这样删除失败最多留下两个表情，不会出现完成状态完全不可见。首版保留两者更简单，也更符合事件审计。

### 2.2 失败分类和重试

飞书官方接口给出的关键错误包括：

| 错误码 | 含义 | 建议处理 |
| --- | --- | --- |
| `230110` | 消息已删除 | 永久失败，不重试 |
| `231001` | emoji 无效 | 配置/代码错误，永久失败并告警 |
| `231002`、`231008`、`231021`、`231022` | 无消息权限、调用者不能访问、外部群限制或机器人对用户不可用 | 永久或需人工修复，不自动热循环 |
| `231003`、`231004`、`232009` | 消息不存在/已撤回，或会话不存在/已归档/已解散 | 永久失败，不重试 |
| `231015` | 重复 reaction 请求仍在处理中 | 短暂失败；抖动退避后有界重试，避免并发重复提交 |
| `231017` | 消息类型不支持 reaction | 永久失败，回退到无 reaction 模式 |
| `231007` | 尝试删除其他操作者的 reaction | 永久失败；检查 reaction 所有权 |
| `231010`、`231011` | reaction 不属于该消息，或 reaction ID 无效/不存在 | 删除可视为已经清理或状态失配；不要无限重试 |

错误含义来自飞书官方[添加](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create)和[删除](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/delete)接口文档。

网络超时存在“服务端可能已经成功、客户端未收到响应”的歧义。实现上应：

- 以稳定幂等键串行化同一消息同一阶段的 reaction 操作；
- 对网络错误、限流和 `231015` 使用指数退避及有限次数重试；
- 如果启用了读权限，可在重试前查询并协调状态；没有读权限时宁可停止盲重试并记录降级，也不要制造请求风暴；
- 将 `reaction_id` 与生命周期状态持久化，重启后才能精确撤销。

## 3. “思考过程”应实现为安全的执行进度

不建议把模型原始 Chain-of-Thought 直接发送到飞书。原始推理可能包含系统/开发者指令、内部策略、未验证假设、工具参数、密钥和私人数据。OpenAI 公开说明其产品选择不展示原始推理链，而是提供模型生成的摘要；其 API 也将 reasoning summary 设计成与原始推理分离的公开输出。参见 OpenAI 的[推理模型说明](https://openai.com/index/learning-to-reason-with-llms/)和[流式 reasoning summary 事件](https://platform.openai.com/docs/api-reference/responses-streaming/response/reasoning_summary_text/delta)。

面向用户的名称建议使用“执行进度”或“推理摘要”，不要叫“原始 CoT”。可展示的内容：

- 阶段：正在理解任务、搜索资料、读取文件、执行命令、整理结果、生成回答；
- 状态：等待中、进行中、已完成、失败、已取消；
- 经过清洗的工具类别和步骤标题，不含参数及原始结果；
- 耗时、已完成步骤数、有限长度的错误摘要；
- 模型供应商明确标记为可公开输出的 reasoning summary，经长度限制和脱敏后展示。

禁止展示：

- 原始 `reasoning-delta` / hidden CoT；
- system/developer prompt 或内部策略；
- 工具完整参数、shell 命令、查询语句、HTTP headers；
- 工具原始返回、文件全文、本地绝对路径、用户未要求公开的数据；
- token、secret、cookie、App Secret、凭据句柄；
- 未经核实的中间猜测。

### 3.1 推荐的卡片体验

飞书官方 Channel SDK 的 streaming reply 会先发送 Thinking 占位，并使用 CardKit 的原生打字机效果更新同一张卡片；生成异常时会追加中断提示并继续向调用方抛错。官方建议一次流式调用持续追加内容，而不是循环发送多条消息。参见官方 [Streaming Replies](https://github.com/larksuite/node-sdk/blob/main/docs/channel.md#streaming-replies)。

在本项目里建议做一个更受控的“状态卡 + 最终回答”双通道：

1. 接单后延迟约 1–1.5 秒再创建状态卡，短任务不闪烁。
2. 整个任务只维护一张卡片，按 0.8–1.5 秒节流合并最新状态，避免触发更新频率限制。
3. 卡片仅接收强类型 `ProgressSnapshot`，不接受模型直接生成的任意卡片 JSON。
4. 成功时将卡片收束为“处理完成”，然后通过持久化 Delivery Outbox 发送最终回答，最后添加 `DONE`。
5. 失败/取消时卡片显示终态和简短可行动说明，不添加 `DONE`。
6. 进度卡片属于 best-effort 预览；即使创建/更新失败，最终回答仍独立发送。

建议的跨 channel 抽象：

```ts
type ProgressSnapshot = {
  operationId: string;
  sourceEventId: string;
  phase: "analyzing" | "working" | "composing" | "finished";
  status: "running" | "succeeded" | "failed" | "cancelled";
  publicSummary?: string;
  steps?: Array<{
    kind: "analysis" | "search" | "read" | "write" | "command" | "other";
    label: string;
    status: "pending" | "running" | "succeeded" | "failed";
  }>;
  updatedAt: number;
};
```

`publicSummary` 必须由上游明确标注为公开摘要，或由确定性的事件映射生成；不能把任意 `reasoning-delta` 填进去。渲染层还应统一做密钥模式、URL 查询参数、绝对路径和最大长度过滤。

## 4. 可借鉴的开源实现

### 4.1 OpenClaw

OpenClaw 的飞书扩展具有独立的 reaction 模块：添加时返回并保存 `reaction_id`，删除时按 ID 操作，列表查询正确处理分页和响应校验，见 [`reactions.ts`](https://github.com/openclaw/openclaw/blob/782a7d7aed45ff708565374a403295e402ebf1fd/extensions/feishu/src/reactions.ts)。它还提供默认开启、可配置关闭的 `typingIndicator`，见[配置文档](https://github.com/openclaw/openclaw/blob/main/docs/channels/feishu.md#configuration-reference)和[配置 Schema](https://github.com/openclaw/openclaw/blob/782a7d7aed45ff708565374a403295e402ebf1fd/extensions/feishu/src/config-schema.ts#L226-L278)。

其值得借鉴的设计是：

- reaction 有独立开关；
- 先检查消息访问权限，再允许 reaction mutation，见 [`channel.ts`](https://github.com/openclaw/openclaw/blob/782a7d7aed45ff708565374a403295e402ebf1fd/extensions/feishu/src/channel.ts#L1535-L1647)；
- `Typing` 生命周期封装成带 `active/cleaned` 状态的对象，启动和清理只执行一次，见 [`comment-reaction.ts`](https://github.com/openclaw/openclaw/blob/782a7d7aed45ff708565374a403295e402ebf1fd/extensions/feishu/src/comment-reaction.ts)。

本项目可以借鉴其“明确生命周期 + 精确 reaction ID + 幂等清理”，但应接入现有 Inbox/Outbox，而不是把网络 mutation 直接散落在消息处理器中。

### 4.2 `amlyczz/dsh-lark-link`

`dsh-lark-link` 已实现“收到时随机 receipt reaction、成功结束时 `DONE`”的体验，README 对行为有直接说明，见[消息处理与状态反馈](https://github.com/amlyczz/dsh-lark-link/blob/36c3295af81f13a641538e97c0e3e79c07423cdd/README.md#L206-L224)。其表情白名单保持飞书要求的大小写，并将 `DONE` 从随机接单池中排除，见 [`reactions.ts`](https://github.com/amlyczz/dsh-lark-link/blob/36c3295af81f13a641538e97c0e3e79c07423cdd/src/common/reactions.ts)。

值得借鉴：

- reaction 放在去重、allowlist 和群聊触发判断之后，且始终绑定原始消息 ID，见 [`message-handler.ts`](https://github.com/amlyczz/dsh-lark-link/blob/36c3295af81f13a641538e97c0e3e79c07423cdd/src/application/message-handler.ts#L294-L351)；
- 每个 turn 重置 `hasOutput/doneIssued`，只在确有输出时添加 `DONE`，工具事件留在内部 UI，见 [`event-forwarder.ts`](https://github.com/amlyczz/dsh-lark-link/blob/36c3295af81f13a641538e97c0e3e79c07423cdd/src/outbound/event-forwarder.ts#L77-L195)；
- CardKit 流式预览与最终持久化回复分离，流式失败不丢最终答案，见 [`cardkit-stream.ts`](https://github.com/amlyczz/dsh-lark-link/blob/36c3295af81f13a641538e97c0e3e79c07423cdd/src/outbound/cardkit-stream.ts)。

需要在本项目中加强的部分是：receipt 和 `DONE` 不应只是不可恢复的直接 best-effort 网络调用；应通过生命周期状态或 Outbox job 获得幂等、重试和重启恢复能力。

### 4.3 `omdsh-dev/dsh-lark`

该项目将 DSH 事件映射为 AG-UI 风格的 run、reasoning、tool 和 terminal 事件，做了批量上报、事件长度限制、工具结果截断，并把进度失败与最终回答隔离，见 [`cot.ts`](https://github.com/omdsh-dev/dsh-lark/blob/632807d9abafbb866a5e208a0298eff21c7856d1/src/cot.ts)。这些“独立队列、批处理、终态、失败隔离”机制可以借鉴。

但它使用 `/open-apis/im/v1/message_cot` 原始路径并直接转发 `reasoning-delta` 和工具信息，见 [`runtime.ts`](https://github.com/omdsh-dev/dsh-lark/blob/632807d9abafbb866a5e208a0298eff21c7856d1/src/runtime.ts#L30-L33)。该端点未出现在本次核对到的飞书公开 Node/Channel SDK 文档中，因此不应作为首版的稳定依赖；其原始推理内容策略也不应照搬。应只借鉴传输与状态管理架构，将载荷替换为经过安全映射的 `ProgressSnapshot`。

## 5. 推荐落地架构

### 5.1 Reaction lifecycle service

新增一个只接受强类型操作的内部服务，不向模型暴露任意 reaction API：

```ts
type ReactionPhase = "accepted" | "completed";

type ReactionIntent = {
  accountId: string;
  messageId: string;
  sourceEventId: string;
  phase: ReactionPhase;
};
```

服务内部映射：`accepted -> Get`、`completed -> DONE`，并持久化：

- 幂等键：`accountId/messageId/phase`；
- 创建返回的 `reaction_id`；
- `pending/succeeded/failed-permanent` 状态、尝试次数和最后错误；
- 是否允许重试以及下次执行时间。

应在 `DeliveryAdapterContext.accept()` 返回 `duplicate=false` 后创建 `accepted` intent；`completed` intent 则由“任务成功且最终回答可靠入队/发送成功”的明确事件创建。网络调用异步执行，不应阻塞飞书 WebSocket 的事件处理时限。

### 5.2 与 Delivery Outbox 的关系

优先方案是扩展现有持久化投递体系，使同一会话 lane 能承载受限的 channel side effect：

```text
outbox: final reply
outbox: reaction(DONE)
```

这样可以保证最终回答先于 `DONE`。如果暂时不扩展通用 Outbox，也至少要使用一个本地持久化 reaction job 表，而不是裸 `void client...create()`。

进度更新不必全部持久化：只需保存卡片 ID、最新序号和终态；中间 snapshot 可以合并丢弃。最终回答和 `DONE` 不能依赖进度卡片是否成功。

### 5.3 配置建议

```yaml
reactions:
  enabled: true
  acceptedEmoji: Get
  completedEmoji: DONE
  removeAcceptedOnComplete: false

progress:
  enabled: true
  createDelayMs: 1200
  updateThrottleMs: 1000
  showPublicReasoningSummary: false
  maxSteps: 8
  maxSummaryChars: 500
```

`acceptedEmoji` / `completedEmoji` 即使暴露配置，也必须通过飞书表情白名单校验。`showPublicReasoningSummary` 默认关闭；开启后也只能接收供应商明确提供的公开 reasoning summary。

## 6. 当前实现与后续验收清单

- [x] 一键建应用加入 `im:message.reactions:write_only`，README 给出已有应用补权限/重新发布步骤。
- [x] 收到合法且非重复的消息，Inbox 成功后只添加一次 `Get`；死信和重放不添加。
- [x] 成功产生并由飞书接受最终回答后添加一次 `DONE`。
- [x] 无最终回复、任务失败或最终回答发送失败时不添加 `DONE`。
- [x] reaction 和原生进度失败不会阻断 agent 执行及最终回答。
- [ ] 如果删除 `Get`，只按已保存的 `reaction_id` 删除自己的 reaction。
- [ ] 覆盖 `231015`、限流、网络超时、消息撤回、机器人失权和进程重启。
- [ ] 进度卡片更新经过节流与合并，终态只发生一次。
- [x] 类型边界和测试保证不转发原始 CoT/reasoning、系统提示、工具参数/原始结果和凭据。
- [x] 原生进度失败时，最终 Delivery Outbox 仍能发送完整答案。
- [ ] 在真实已补 scope 的飞书应用上完成 `Get -> 安全进度 -> 最终回复 -> DONE` 端到端验收。
