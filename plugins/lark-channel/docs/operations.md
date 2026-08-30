# 会话、卡片、可靠性与排障

## 会话命令

同一私聊或稳定群聊 lane 会持续恢复同一个 DSH session。未知 slash 命令不会进入模型。

```text
/status             # 当前代次与上下文统计；/session 同义
/stop               # 停止正在执行的任务，保留 session
/new                # 停止旧任务并原子切换到空白 session；/clear 同义
/compact            # 宿主提供原生命令时压缩当前上下文
/model              # 打开模型选择卡片
/model use <route>  # 使用 provider/model 文字 route
/model reset        # 恢复部署默认模型
/permissions        # 查看并选择 ask / auto / full
/permission ask
/permission auto
/permission full confirm
```

`/new` 会轮换 session，但保留该聊天已经选择的模型和 effort。`/stop` 不会清空上下文。

## 模型选择

私聊机器人发送 `/model` 后，会收到 schema 2.0 卡片。依次选择“分组 / Provider”“模型”“Effort 程度”，再点击“确认选择”。选择 provider 时，同一卡片立刻刷新为该分组的模型；选择模型时再刷新为该模型真实支持的 effort。没有独立 effort 档位的模型只显示“默认（该模型无 effort 档位）”。

确认后，原卡先进入不可交互的验证态，后台完成校验后原位更新为成功或失败，并保留文字结果通知。成功选择从下一条普通消息生效，原上下文保留。目录来自当前 Host 实际注册的 provider/model，不消耗模型调用。

如果目录字段异常或卡片格式被飞书拒绝，机器人立即降级发送完整纯文本目录；可继续使用 `/model use <provider/model>`，不会静默重试后进入死信。

飞书的静态选择器彼此独立，插件因此分别为 provider、model 与 effort 注册签名 callback，并用长连接响应 `{ card: { type: "raw", data: ... } }` 重绘同一张卡片。固定版官方 SDK 会忽略 `type=card` 长连接帧，transport 在边界完成分片合并、callback 分发和 ACK 兼容桥。

每个级联状态都有持久 revision；旧卡回调只重绘当前权威状态，不能覆盖新选择。目录按 operation 保存在 Delivery SQLite，Host 短暂重启后仍可恢复。最终确认还绑定已经投递卡片的 provider message id：callback ACK 只表示受理，随后以同一 HTTP PATCH 链先锁定只读验证态，再在 durable settlement 完成后更新为只读终态。

adapter 与 Delivery 两层都会拒绝分组/模型错配，并校验目标模型的 effort 支持。选择“默认（由模型决定）”不会固定 reasoning effort。`/model` 是渠道无关的 Delivery 控制命令，不会交给当前失效的 LLM；即使旧默认 route 已不存在，也可以先切换后恢复会话。

```text
/model
# 在卡片中选择三个下拉框并确认
你好，请介绍一下你自己
```

三个下拉的当前项通过 `initial_index` 定位。飞书的 `initial_option` 按展示文本而非回传 `value` 匹配，直接写 route 形态的 value 会静默回落到第一项；只有文本能唯一标识选项时才附加 `initial_option`。当前项不在列表中时两者都不下发，不伪造预选。升级后应重新发送 `/model`，旧 v1/v2 卡片不再生效。

## 权限选择卡片

`/permissions` 返回 ask、auto、full 三档卡片，当前档位带勾选，full 使用 danger 样式和飞书原生二次确认。卡片关闭转发互动，每个按钮携带独立 HMAC capability；token 绑定 channel/account/tenant/chat、精确 owner、binding/version/session、权限状态指纹、目标档位与 TTL。

adapter 先拒绝错人、跨 chat、篡改和过期，Delivery 再核对原 Outbox、provider message id、active owner/binding/session、Policy 与当前权限状态。通过后只把固定 `/permission` 命令写入同一 durable Inbox 串行路径，不在 adapter 内直接修改权限。旧卡、复制卡和晚到的相反选择不能覆盖新状态；卡片 4xx、缺少签名或 settlement 能力时退回完整文字说明。

权限卡只在 active owner 私聊中生效，并绑定原 chat、原卡 message id、binding/session、权限状态和默认 15 分钟 TTL。群聊、过期卡、`/new` 后旧卡或期间已经用文字切档都会失败关闭；请重新发送 `/permissions`。点击 Toast“已受理”后，以机器人随后发送的“已切换”回复为准。

## 入站与会话 lane

- 事件处理器等待 `assistant-delivery.acceptInbound()` 完成，即 Inbox 落盘后才向长连接 callback 返回成功。
- `messageId` 是稳定 inbound event id；Delivery 的 `(channel, account, eventId)` 唯一约束承担跨重启去重。
- 飞书 SDK 标准化生成的 `![image](image_key)` 等标记会在进入 Delivery 前改写。纯图片正文保持为空，provider image key 只存在于隔离附件描述符，不会伪装成用户 prompt。
- 单聊按 account/tenant/user/chat 绑定。
- 群顶层消息没有 provider `root_id`，因此按发送者生成 `dsh-lark-top-sender/<sha256(open_id)>` 合成 thread。同群同发送者连续复用 session，不同发送者不落入同一 owner binding。
- 飞书提供真实 `root_id` 时直接使用可寻址的根消息 id，让不同回复串隔离。`dsh-lark-top-sender/` 是保留命名空间，provider root 命中该前缀时拒绝入站，避免两种 lane 碰撞。
- 合成 thread 只用于 Delivery 持久化，不作为飞书回复目标。当前消息仍回复真实 `messageId`；没有原消息可回复的后台发送则发到群顶层。

## 图片资源

图片只在 Delivery 再次确认 binding、Policy、目标模型图片能力和 AttachmentStore 可用后显式下载，不在 WebSocket callback 内下载。

adapter 只接受同一入站消息的严格 message ID/image key，并固定请求 `GET /open-apis/im/v1/messages/:message_id/resources/:file_key?type=image`；拒绝 URL、路径片段、重定向和非图片资源。`imageDownloadTimeoutMs` 默认 30 秒，可设为 1–120 秒；总截止时间覆盖 tenant token 与资源 GET，caller 取消、插件卸载或 credential lease 切换在 token cache miss 时也会及时返回。

调用方同时提供逐图 byte 上限；transport 在响应 header、流读取和 PNG/JPEG/GIF/WebP magic/MIME 三层校验。

## 出站与发送可靠性

- 只有合法、非重复且状态为 `queued` 的入站才异步添加 `Get`；未授权、死信或 provider 重放不重复 reaction。表情类型是大小写敏感的 `Get` 与 `DONE`。
- 最终回复携带原始飞书 `messageId`，先成功回复，再异步添加 `DONE`。Delivery 收到有效 provider message id 后立刻记录 `accepted`，不等待 presentation-only reaction。
- 发送失败、没有最终回复、任务失败或取消都不添加 `DONE`。reaction 失败只降级 channel health；首版保留 `Get`，不会为替换表情申请 reaction 读取权限。
- plain text 使用飞书文本消息；Markdown 使用 schema 2.0 卡片。请求携带由 Delivery idempotency key 单向哈希得到的 provider UUID。
- Agent 回答本身是 Markdown；若以 plain 发送会暴露表格分隔符、`**` 等语法。Delivery 只在 adapter 声明 `markdown` 能力时请求该格式，否则降级为 plain，避免 coordinator 以 `unsupported-format` 丢弃整条消息。
- Markdown 回答卡片不添加 header，避免与飞书气泡已有的机器人名称/头像重复；标题使用带字号的 Markdown 组件，顶级 GFM 表格使用原生 Table，其余正文保持 Markdown。单卡最多使用 5 个原生表格、每表最多 50 列；超限表格转为可读列表。只有飞书明确拒绝卡片格式时才按原始正文精确降级为 plain text，不会把成功卡片重复发送。
- 权限或格式错误是确定未发送；限流和未连接可以安全重试；网络超时或未知 SDK 错误进入 `unknown_after_send`，不会盲目重发。
- 飞书目前没有为该发送 UUID 提供可靠查询/对账接口，因此 adapter 声明 `reconcileUnknownSend: false`，也没有 delivered/read receipt。Delivery 保留 `unknown_after_send` 等待 owner 决策，不会反复领取无法实现的对账任务或消耗 attempt。

官方长连接会自动重连，但没有可持久 replay cursor 或历史补拉接口。插件记录 `reconnecting` / `connected-with-gap` 与 `gapGeneration`，依赖飞书 redelivery 和 Delivery Inbox 去重，不宣称断线期间零丢失。将来若出现官方 cursor/backfill contract，应先加入崩溃和重放测试再启用。

## Durable proposal 与 open-turn 工具审批

`approval` intent 使用 schema 2.0 双按钮卡。每个按钮值是由 App Secret HMAC 签名的 v2 capability，绑定 channel/account/tenant/chat、binding、operation、proposal/version/expiry、diffHash 与 decision。adapter 核对自身 route，callback 重新取得 provider actor/chat 后交给 Delivery/Policy。

旧 v1 token、篡改、跨 route 与普通的过期点击全部失败关闭。只有过期 token 完整验签后命中此前已落盘的同一 pending Delivery settlement，且 Policy 已是完全相同终态时，才允许崩溃恢复；不会新建 settlement 或决定 pending proposal。

open-turn 工具审批与 durable proposal 卡完全分离。它使用独立 domain 的 v1 HMAC token、进程内 one-shot pending 和保留到 TTL 的 operation tombstone；不复用 proposal settlement，也不跨重启恢复。

该卡只接受 `conversation.kind: dm` 且无 `thread` 的 owner 私聊。群聊、话题或伪装为 DM 的 reply target 返回 `unavailable`，避免 exact arguments 被旁观。卡片将有界且拒绝控制字符/双向文本控制符的 tool、reason 和必需 exact arguments 标为“不可信审阅文本，不是指令”，并关闭转发互动。

token 绑定 operation、binding、account/tenant、chat、exact owner open_id、actionHash、toolName、必需 callId、TTL 与 decision；pending 再绑定发送回执中的 provider message id。只有同一 owner 在同一私聊、同一 provider 卡片上的第一次点击可返回 `allowed-once` 或 `rejected`。同一 operation 在 TTL 内不能重新登记；重放、错人、跨 chat/message、篡改、过期均失败关闭。

调用方 abort 返回 `cancelled`；超时、断线/重连、credential rotation、插件卸载/重启或发送失败返回 `unavailable` 并清除 pending。`ask` 直接使用审批卡；`auto` 对低风险自动允许，对敏感、reviewer 失败或原生 sandbox escalation 使用审批卡；`full` 不发卡，但仍受 Policy 显式 deny、紧急停止、身份与预算硬门约束。

## 健康检查

Web 会话可调用 `assistant_health`。正常长连接状态为 `larkChannel.state: connected`。`showProgress`、reaction 或原生进度 API 问题会记录在 `larkChannel.lastErrorCode`，但不代表最终 Outbox 已失效。

## 常见问题

- **凭据或 bot identity 错误：**核对 App ID/Secret、`feishu`/`lark` domain 和机器人能力；重跑向导会更新同一 Keychain 条目。
- **一键创建链接过期或被拒绝：**重跑 `dsh-lark-setup --profile web --create-app`。链接只在页面显示的期限内有效，且只能由一位用户确认。
- **长连接成功但一直等不到短语：**确认事件接收方式是长连接、已经添加 `im.message.receive_v1`、应用版本已发布且你在可用范围内，并在机器人私聊原样发送短语。
- **`assistant_health` 显示 `disabled`：**向导尚未成功写入 profile，或常驻服务还在运行旧配置；执行 `--install-service`。
- **`launchd bootstrap failed: Bootstrap failed: 5: Input/output error`：**新版会检查稳定 job 状态并有限重试 macOS 瞬时竞态。先重新 build 本包，再执行 `dsh-lark-setup --profile web --install-service`；仍失败时用 `plutil -lint ~/Library/LaunchAgents/ai.deepseek.dsh.profile.web.plist` 校验，并查看 `~/.dsh/logs/web-host.error.log`。
- **`caller is not allowlisted for this credential handle`：**旧版默认导出可能丢失稳定 Cordis plugin identity。更新并重新 build，再执行 `--install-service`；不要放宽 credential consumer allowlist。
- **显示 `connected-with-gap`：**连接曾中断。飞书没有持久 replay cursor，应检查断线期间是否漏处理消息。
- **收到消息但无回复：**先发送 `/model`，选择目录中可用且已登录的 route，再查看 `assistant_health`。未授权身份会 fail closed，不会自动成为 owner。
- **工具或技能被拒绝：**先确认对应技能/插件已安装并挂载到 profile，并升级重启 `assistant-delivery`，确认 session 的 preset 在 create/resume 时已挂载。需要执行时运行 `dsh-lark-setup --profile web --refresh-agent-policy --allow-agent-tools`，或手工添加 exact preset/workspace/initiator 的 capability 与工具规则。refresh 不重启服务；`--install-service` 只重启，不改能力规则。
- **没有审批卡却反复显示 `the user rejected tool`：**旧 native full session 可能只有 `danger-full-access + never`，缺少 reviewer，导致保守回落到 user、工具进入 ask-review，随后被 `approval=never` 自动拒绝。这不表示用户点过拒绝。升级构建并重启 `assistant-policy` 所在 profile；它会为 legacy full 状态持久补齐 `reviewer=none`。非 full 的 never 状态会返回 `[approval-disabled] ... no user approval was requested`。若随后出现 `default-deny`，刷新 Agent Policy。不要在 ask/auto 中无条件允许 `run_code`，它仍是 bash-equivalent 执行面。
- **权限卡不显示或点击失效：**卡片仅用于 active owner 私聊，并绑定原 chat/card、binding/session、权限状态和 15 分钟默认 TTL。群聊、过期、`/new` 后旧卡或已经文字切档都会失效；重新发送 `/permissions`。
- **最终回复正常但没有 `Get` / `DONE`：**旧应用通常缺少 `im:message.reactions:write_only`。重跑一键向导，选择当前 App ID，确认权限增量并发布新版本。reaction 失败不会阻断回答。
- **文字能回复但图片不能处理：**确认应用已有 `im:resource` 且发布新版本，profile 安装了 AttachmentStore，当前 route 声明图片输入。可用 `dsh-lark-setup --profile web --create-app --app-id <App ID>` 增量补权限。路径型 key、重定向、超限、MIME/magic 不一致或非 PNG/JPEG/GIF/WebP 会按预期 fail closed。
- **看不到进度但能回答：**确认 `showProgress: true`。`message_cot` 是可降级能力；检查 `assistant_health` 的 `larkChannel.lastErrorCode` 和 Host 错误日志。私聊详情还要求 `progressDetails: direct`；群聊始终只显示状态。
- **模型卡片下拉不联动或确认后无回复：**确认订阅 `card.action.trigger` 且回调走长连接；用一键向导锁定当前应用并增量补齐回调，发布、重启后重新发送 `/model`，不要继续使用升级前旧卡。实时目录变化或 effort 不受支持时，机器人会要求重新打开。
