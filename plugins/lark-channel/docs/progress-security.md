# 进度展示、安全与权限边界

## 默认进度策略

进度是展示层，不是 Delivery 的可靠性真源。`assistant-delivery` 先把 session fact 转成有界、可展示的强类型 update，Lark adapter 再按会话受众决定是否发送细节。

```yaml
config:
  showProgress: true
  progressDetails: direct
  statusReactions: true
```

| 配置 | 私聊 | 群聊 |
| --- | --- | --- |
| `showProgress: false` | 不创建原生进度 | 不创建原生进度 |
| `showProgress: true`, `progressDetails: off` | 阶段、步骤、工具名、成功/失败、待办、终态 | 同左 |
| `showProgress: true`, `progressDetails: direct`（默认） | 上述状态，以及限长、常见凭据已脱敏的工具参数与结果 | 仍仅显示状态，不发送参数或结果 |

`progressDetails` 只接受 `off` 或 `direct`，不存在允许群聊详情的模式。群聊即使由 owner 直接 @ 机器人，也始终是 status-only。

`assistant/chunk` 的流式 `reasoning-delta` 与 `assistant/message` 的已组装 reasoning 块都不会越过 Delivery 的进度边界；DSH 将它们定义为 thinking content，不保证是可公开摘要。provider 原始错误消息、系统提示和完整工具对象同样不会进入进度。`step/start` 会产生中性的阶段文案，避免面板为空。

## 工具参数和结果 preview

私聊详情来自 Delivery 生成的 presentation-only preview，不是 durable Delivery state：

- 工具参数优先解析为 JSON，并递归处理敏感 key；最大输入 32,768 字符、最大深度 16、最多 500 个节点，每层数组/对象最多保留 100 项；
- 单个参数或结果 preview 最多 1,500 个 Unicode 字符；超限内容明确标记 truncated；
- 常见敏感 key 包括 API/access key、authorization/bearer、cookie、credential、password/passwd、private key、secret、session/token 等，并识别 snake_case、kebab-case、camelCase 与常见前缀；
- 合法 JSON 结果会先递归脱敏；普通文本中未加引号的敏感赋值因没有可靠终止符，会保守遮蔽到当前逻辑行末；
- 文本还会处理 PEM private key、URL userinfo、Basic/Bearer authorization、GitHub/OpenAI/xAI 风格 token 和 JWT 形态；
- 图片结果显示为 `[图片]`，嵌套工具结果有深度限制；
- 空参数按 `{}` 展示；无法解析或原始输入超过上限时只显示 `invalidJson` / `truncated` JSON 状态，不回显不可信 raw text。

这是一层常见凭据防泄漏措施，不是通用秘密扫描器。业务数据、未识别的 token 格式或敏感自然语言仍可能出现在经 Delivery 授权的私聊；默认向导只授权 owner。若不希望任何参数/结果离开 Host，应设置 `progressDetails: off`。群聊不依赖脱敏结果，adapter 直接丢弃参数与结果 preview。

## 飞书 `message_cot` 映射

原生进度使用 `/open-apis/im/v1/message_cot`。该接口不在固定版 Node SDK 的高层 API 中，因此 transport 直接调用 OpenAPI，并把它视为可降级能力。

HTTP 外层使用 `cot_id`、`message_id`、`event_type` 等 snake_case 字段；`events[].content` 则是独立的 AG-UI JSON，必须使用 `messageId`、`delta`、`threadId`、`runId`、`toolCallId` 等 camelCase 字段。若把外层 snake_case 混入 content，飞书会把 JSON 原样显示为正文，而不是渲染 COT 气泡。

强类型 update 映射如下：

- started：`RUN_STARTED` 加“正在分析请求并制定执行步骤…”；
- step：独立文本 message id，追加中性阶段说明；
- tool-started：工具名和开始/结束事件；只在允许详情的授权私聊附加 `TOOL_CALL_ARGS`；
- tool-finished：私聊详情显示有界结果和短错误码；其他情况只显示“已完成”或“执行失败”，错误码固定为 `TOOL_FAILED`；
- todos：最多 20 项，每项最多 240 字符，显示 pending / in-progress / completed 状态；
- completed / failed：明确终态。失败会在正文写“任务未完成”并仅附短错误码，再发送 `RUN_ERROR`。

同一运行的步骤与待办各自使用独立 `messageId`，避免新内容覆盖旧气泡。单个编码事件限制为 4,096 字符；JSON 转义后仍超限时会继续缩短可见文本，并保留 tool/result identity 与 truncated 标记。

provider 可能在生成任何正文前失败。只发送 `RUN_ERROR` 会让飞书面板停在首行、看似卡住，因此失败路径额外追加“任务未完成”；仅在 `progressDetails: direct` 的授权私聊透传短错误码，不发送可能含 prompt 或上游载荷的原始错误消息。群聊和 `off` 模式只显示通用失败状态。

创建或更新 `message_cot` 失败只写入 channel health，不重跑任务，不改变 Outbox settlement，也不阻断最终回复。租户或应用类型不支持该接口时会自然退化为 reaction 与最终答复；查看 `assistant_health.larkChannel.lastErrorCode` 和 Host 错误日志定位展示问题。

## Reaction 状态

只有合法、非重复且已经 `queued` 的入站会异步添加大小写敏感的 `Get`。最终答复成功回复原消息后才异步添加 `DONE`。未授权、死信、重放、发送失败、无最终回复、任务失败或取消不会添加相应状态。

reaction 与 `message_cot` 都是 best-effort。其失败只降低 channel health，不影响 Delivery 已持久化的 Inbox/Outbox，也不会触发任务重跑。首版保留 `Get`，不会为了替换表情申请 reaction 读取权限。

## Agent Policy 与权限档位

`--allow-agent-tools` 是高权限显式开关。它为本地 Web/direct `foreground` 写入跨 preset/workspace 的通用 capability allow，并为 Delivery 当前/兼容的精确 canonical owner principal + preset + 绝对 workspace + `external` initiator 写入通用 capability 与工具规则。默认不附带工具 deny，因此这些身份可达部署已挂载的动态 skill/插件工具，也可进入 `memory.search`、`wiki.read`、`automation.propose` 等插件内部二次 Policy 检查。`background` initiator 不在这两类规则中。

action/resource 使用通配而非静态枚举，是因为模型工具和插件动作都由实际挂载动态注册；静态列表会在新能力加入时立刻过期，表现为 Agent 已看到工具却被 `default-deny`，或进入插件后被二次门拒绝。

这些规则决定 Policy 层可达性，不会安装或挂载插件。模型工具仍经过 sandbox、approval reviewer 和 `assistant-policy` 的 `tools/pre-execute`；插件内部动作仍经过身份、参数、预算和业务硬门。显式 deny、紧急停止与这些硬门不会被通配 allow 绕过。ask/auto 中，文件写入、网络访问和危险命令仍可能要求审批。

owner 可用 `/permissions` 查看档位，用 `/permission ask`、`/permission auto` 或 `/permission full confirm` 切换：

- `ask`：需要审阅的调用向 owner 私聊发一次性审批卡；
- `auto`：低风险自动允许，敏感、reviewer 失败或原生 sandbox escalation 发审批卡；
- `full`：`danger-full-access + never + none`，关闭逐次审批并放开 sandbox，但显式 deny、紧急停止、身份与预算硬门仍生效。

若需收紧具体工具，应配置显式 deny 或更窄 allow；deny 优先于通配 allow。Delivery 外部主体的 `subject.id` 与 workspace 始终精确；只有本地 foreground 为支持 Web/direct 切换而使用 `*`，并由 `initiator: foreground` 隔离。

Bash/Pwsh 本身可启动子进程并访问 sandbox 允许的内容。选择 full 后，应把飞书 owner 和应用可用范围保持最小，并按需配置 deny、紧急停止和预算。

`skill` 是标准 DSH base 中 `tool-skill` row 注册的模型工具，用于发现和加载 `ctx.skills`（包括 `skill-filesystem` 提供的本机 `SKILL.md`）。通用 capability/工具规则已经覆盖它，无需单独授权；技能加载不会额外提权，内部命令仍走相同 sandbox、approval 与 Policy 管线。

## Policy 拒绝诊断

外部会话报告工具被拒时，检查 `~/.dsh/assistant-policy/policy.sqlite` 的 `audit_events`：

- `reason_code: default-deny`：没有规则匹配该会话，通常是 principal、preset 或 workspace 与 Delivery binding 不一致；运行 `dsh-lark-setup --profile web --refresh-agent-policy --allow-agent-tools` 对齐；
- `reason_code: rule-deny`：命中显式 deny。

两者都不是审批拦截。审批由 `tools/pre-execute` reviewer 发起，不写 `audit_events` denied 记录。

Policy tool guard 与插件内部 `authorizeAgent()` 都携带 Delivery binding 的 canonical principal。setup 创建的 external reply/capability/tool 规则只匹配当前 account 的精确 owner；其他 connector、Lark account 或 principal 即使使用相同 preset/workspace，也不会继承授权。owner 在群内 @ 机器人时仍沿用同一 principal，因此这不是“仅 owner 私聊才能调用工具”的限制；只有审批卡和参数/结果详情限于 owner DM。

## 审批卡的边界

durable proposal 卡和 open-turn 工具审批卡是两个独立协议。具体签名、settlement 与崩溃恢复语义见[操作文档](operations.md#durable-proposal-与-open-turn-工具审批)。共同原则是：

- capability 与原 route、chat、owner、binding/operation 和 expiry 绑定；
- 篡改、重放、错人、跨 chat/message 和普通过期点击失败关闭；
- exact tool arguments 只出现在 active owner 的无 thread 私聊，并明确标为不可信审阅文本；
- 群聊、话题和伪装的 DM target 不显示审批详情；
- 模型不能直接决定、伪造或发送审批卡，也不能绕过 Delivery/Policy settlement。

## Authority 与数据边界

- **网络：**只访问所选 `domain` 的飞书/Lark OpenAPI、token 服务和 WebSocket endpoint。图片读取使用固定消息资源相对端点，不接受模型、消息正文或 provider payload 提供的 URL，并关闭重定向；本包没有通用 HTTP 工具。
- **凭据：**优先通过 `credentials-keychain` handle 获取；兼容模式只读取 `appSecretEnv` 指定的一项。值不写数据库、不进入 tool、health、route、日志或异常文本。Linux protected-file 没有额外静态加密，同 UID、root 和可读备份能取得内容；runtime 会复核父目录/文件 owner、类型、链接数、`0700`/`0600` 与大小。`appId` 不是 Secret。
- **文件系统：**runtime 除 credential provider 读取受保护 Secret 外没有业务文件读写。setup wizard 原子更新所选 profile patch，通过 Delivery 本地控制面写入精确 owner，以版本化独占路径创建 Linux protected-file，并以 `0600` 写用户级 LaunchAgent/systemd 配置，在 `$DSH_HOME/logs` 创建 Host 日志。SDK 依赖 `protobufjs` 的 postinstall 只打印版本建议；仓库显式设置 `allowBuilds: false`，运行不需要安装脚本。
- **子进程：**runtime 只使用 credential provider 的固定、无 shell 命令。setup 在 macOS 调用 `/usr/bin/security` 与 launchd；Linux 按需调用 `/usr/bin/secret-tool`、`/usr/bin/systemd-ask-password`、`loginctl`、`systemctl --user`；Windows 调用固定 PowerShell DPAPI 命令与 Task Scheduler。Secret 只经 stdin 或 setup-owned protected-file 传递，不作为 argv。所有平台调用 `dsh --dump-config` 校验；常驻配置只含解析后程序路径和最小环境，不复制 ambient token/password。
- **浏览器：**setup 输出飞书官方短期设备授权链接与二维码，不自动操控浏览器。用户在官方页面选择或创建应用并确认权限增量。
- **消息数据：**Delivery SQLite 保存标准化文本、provider message id、chat/user/thread id 和最多 10 个受限附件描述符。raw event、token 与下载 URL 不保存；provider file key 只是隔离账本中的不可信引用，不进入模型正文。授权 worker 下载图片字节后只交 AttachmentStore；本插件不把二进制写入 Delivery session 或 prompt。
- **进度数据：**状态与文字均限长。私聊详情是限长且常见凭据脱敏的 preview；群聊不发送参数/结果；任何会话都不发送 reasoning/thinking 内容或 provider 原始错误详情。
- **群消息：**默认必须直接提及机器人；`@all` 不等于提及机器人。最终授权始终由 Delivery/Policy 决定。

## 当前边界

- v0.1 自动处理文本和图片描述符入站、文本/Markdown-card 出站、durable proposal、owner-DM one-shot tool approval、model/permission picker、`Get`/`DONE` 与脱敏原生进度。模型不能提交任意 card JSON，也不能直接控制 reaction 或进度载荷。
- 只有图片资源具备受限下载能力，而且只有 Delivery 图片桥、AttachmentStore 与目标模型图片能力全部存在时启用。文件、音频、视频和 sticker 仍只进入 durable metadata quarantine；本插件不做病毒扫描或附件出站上传。
- 消息编辑和上传尚未实现；未来也必须先创建 Delivery 持久 operation，不能让模型直接调用 SDK。
- 单应用长连接是集群竞争消费，不提供广播或多节点 exactly-once。当前 suite 的可靠性目标是由 supervisor 管理的单机进程。
- setup wizard 正式支持 macOS 与 Linux，Windows 为 best-effort；需要交互式终端和一次 owner 私聊，不接受 `--app-secret` 参数。一键模式在扫码确认后通过官方流程选择或创建应用；企业管理员审批等租户控制面仍由飞书强制执行。
