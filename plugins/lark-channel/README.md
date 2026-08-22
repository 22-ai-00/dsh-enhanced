# @dsh-enhanced/lark-channel

飞书/Lark 的薄协议适配器。它把长连接消息转换成 `assistant-delivery` 的 typed inbox，并把后者已经落盘的 outbox intent 转成飞书发送或回复 API；本包不拥有配对、会话、重试或授权真源。

默认是 `enabled: false`，所以安装包不会立刻读取凭据或联网。

启用后，合法的新消息完成鉴权、去重并进入持久 Inbox 后，机器人会在原消息上添加 `Get`；普通 Agent 任务同时创建一条飞书原生执行进度消息，只展示阶段、步骤说明、工具名和显式待办状态；最终答复发送成功后再在原消息上添加 `DONE`。进度与 reaction 都是 best-effort 展示层，最终答复仍由 Delivery Outbox 保证。插件不会发送流式 `reasoning-delta`、工具参数或工具原始结果。

## 最快启用：跨平台 setup wizard

安装完成后，推荐让向导完成 Keychain、owner 身份、最小 Policy 和 Web profile 配置，而不是手写 YAML：

```sh
cd /path/to/dsh-enhanced
pnpm --filter @dsh-enhanced/lark-channel build
pnpm --filter @dsh-enhanced/lark-channel run onboard --profile web --create-app
```

如果 Web profile 已按本仓库的本地源码方式安装，也可以直接运行：

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup --profile web --create-app
```

向导会依次：

1. 调用飞书官方 Node SDK 的 `registerApp`，显示十分钟有效的确认链接和终端二维码；
2. 你在飞书中选择已有应用或创建新应用，并确认权限增量；
3. 将返回的 `App Secret` 自动写入 macOS Keychain、Linux Secret Service 或当前 Windows 用户的 DPAPI 加密文件；Secret 不经过命令行参数、不写 profile、也不打印；
4. 用真实凭据建立一次临时长连接；
5. 显示一次性 `DSH-CONNECT-...` 短语，等待你私聊机器人并原样发送；
6. 从这条单聊取得应用作用域下的准确 `open_id`，只把该身份配为 owner；
7. 更新 `web/cordis.patch.yml`，启用 channel，添加精确 ingress/reply/credential 规则，并运行 `dsh --profile web --dump-config` 自检；
8. 安装并启动该 profile 的用户级常驻服务：macOS 使用 launchd，Linux 使用 systemd，Windows 使用 best-effort Task Scheduler；均以 `dsh --profile web --no-open` 运行。

一键模式使用官方的 OAuth 2.0 Device Authorization Grant。只传 `--create-app` 时，官方确认页会同时提供“选择已有应用”和“创建新应用”；与 `--app-id` 组合时则锁定更新该已有应用。两种方式都会先展示权限、事件和回调的增量，只有你确认后才会生效。向导始终不传 `createOnly`，并使用 `addons.preset: false`，不采用官方默认智能体模板中与本 channel 无关的文档、Wiki、群管理、批量消息等权限。确认页只申请：

- `application:bot.basic_info:read`：连接时取得机器人身份；
- `im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`：接收私聊和群内 @ 消息；
- `im:message.reactions:write_only`：在原消息上添加 `Get` / `DONE` 状态；
- `im:message:send_as_bot`：发送及回复消息；
- `im.message.receive_v1`：消息事件；
- `card.action.trigger`：处理审批卡片按钮、模型选择级联刷新和最终确认按钮。

事件与回调由官方一键创建流程预置为 WebSocket 长连接，不需要公网 callback URL。实现依据是飞书开放平台的[一键创建飞书智能体应用](https://open.larkoffice.com/document/mcp_open_tools/integrating-agents-with-feishu/overview)和官方 Node SDK 的[`registerApp` 文档](https://github.com/larksuite/node-sdk/blob/main/README.zh.md#%E4%B8%80%E9%94%AE%E5%88%9B%E5%BB%BA%E5%BA%94%E7%94%A8)。

已有应用仍可复用：

```sh
# 通过官方授权页给指定已有应用增量补齐权限、事件和回调（推荐）
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --create-app \
  --app-id cli_0123456789abcdef

# 仅手工录入已有应用凭据，不修改飞书控制台配置
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --app-id cli_0123456789abcdef
```

单独使用 `--app-id` 的手工路径会通过当前系统的安全输入读取 App Secret，适合已自行完成控制台配置的应用。通常应使用官方授权路径；省略 `--create-app` 和 `--app-id` 时，向导会询问 App ID，直接回车即进入一键选择/创建。

重复执行会更新同一个 account 的受管配置，不重复添加规则或 handle。profile 校验失败时会在进程内恢复原内容；不会保留备份文件。

飞书授权只是建立应用凭据和 owner 绑定；`lark-channel` 本身仍是运行在 DSH Host 内的插件。因为这里安装到 `web` profile，默认由向导在后台常驻这个 profile，不需要保持浏览器打开，也不需要再手动执行 `dsh web`。

已完成飞书配置、只需安装或重启常驻服务时运行：

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --install-service
```

macOS 会创建 `~/Library/LaunchAgents/ai.deepseek.dsh.profile.web.plist`，登录后自动启动、异常退出后自动拉起；只写入 `DSH_HOME` 和不含相对目录的 `PATH`，不会复制当前 shell 的 token、password 或其他环境变量。常用运维命令：

```sh
# 查看状态
launchctl print gui/$(id -u)/ai.deepseek.dsh.profile.web

# 查看错误日志
tail -f ~/.dsh/logs/web-host.error.log

# 停止并卸载当前登录会话中的服务；重新执行 --install-service 可恢复
launchctl bootout gui/$(id -u)/ai.deepseek.dsh.profile.web
```

Linux 会创建私有的 `~/.config/systemd/user/dsh-profile-web.service`，只配置 DSH 所需路径以及 Secret Service 所需的用户 D-Bus/XDG 定位：

```sh
systemctl --user status dsh-profile-web.service
journalctl --user -u dsh-profile-web.service -f
systemctl --user restart dsh-profile-web.service
```

Linux 一键凭据需要当前桌面会话中运行 Secret Service，并提供 `/usr/bin/secret-tool` 与 `/usr/bin/systemd-ask-password`。无桌面 Secret Service 的服务器或容器请使用 `--no-service`，并通过下文的 `environment` provider 和自己的 systemd/container secret injection 管理凭据。

Windows 会把 DPAPI 加密的 PSCredential 保存到 `$DSH_HOME/credentials-keychain`，并创建当前用户的 `DSH profile web` 登录任务。该实现不会保存明文，但 Windows/Node/npm/Git Bash 组合差异较大，因此属于 best-effort，不作兼容承诺：

```powershell
schtasks.exe /Query /TN "DSH profile web"
schtasks.exe /End /TN "DSH profile web"
schtasks.exe /Run /TN "DSH profile web"
```

如果确实希望自己管理进程，在首次向导中加 `--no-service`，然后手动运行 `dsh --profile web --no-open`。不要同时启动前台和 LaunchAgent 两份相同 profile，否则 Web 端口与飞书长连接会发生竞争。

服务启动后，可以先在飞书里私聊机器人发送 `/model`。机器人会返回一张飞书卡片，依次选择“分组 / Provider”“模型”“Effort 程度”，再点击“确认选择”；选择 provider 时，同一张卡片会立即刷新为该分组的模型，选择模型时又会刷新为该模型实际支持的 effort。没有独立 effort 档位的模型只显示“默认（该模型无 effort 档位）”。系统确认后会发一条文字回复，下一条普通消息开始使用新选择，原上下文保留。目录来自当前 Host 实际注册的 provider/model，不消耗一次模型调用。若目录中的异常字段或飞书卡片格式错误导致卡片未被接受，机器人会立即改发完整纯文本目录，可继续使用 `/model use <provider/model>`，不会静默重试后进入死信。

飞书的多个静态选择器本身彼此独立，所以插件在 provider、model、effort 选择器上分别注册签名 callback，并通过长连接回调返回 `{ card: { type: "raw", data: ... } }` 更新同一张 schema 2.0 卡片。固定的官方 Node SDK 会忽略 `type=card` 长连接帧，transport 因此在其边界补充分片合并、callback 分发和 ACK 兼容桥。每次级联状态都带持久化 revision；旧卡片回调只会重绘当前权威状态，不会覆盖较新的选择。目录按 operation 保存在 Delivery SQLite，Host 短暂重启后仍能恢复。最终确认时还会在 adapter 与 Delivery 两层拒绝不匹配的分组/模型，并校验目标模型支持的 effort。选择“默认（由模型决定）”不会固定 reasoning effort。`/model use <provider/model>` 仍可作为文字后备，`/model reset` 恢复部署默认模型，`/new` 轮换到新 session 但保留该聊天的模型与 effort。Web 会话里可调用 `assistant_health` 查看 `larkChannel.state`，正常应为 `connected`。

例如本机已安装并登录 `@dsh-enhanced/coding-subscription-provider` 的 Codex CLI 时：

```text
/model
# 在卡片中选择三个下拉框并点击“确认选择”
你好，请介绍一下你自己
```

`/model` 是 `assistant-delivery` 的渠道无关控制命令，不会被交给当前失效的 LLM；因此即使 profile 中的旧默认 route 已不存在，也能先切换再恢复正常对话。

向导正式支持 macOS Keychain + launchd 和 Linux Secret Service + systemd user service。Windows DPAPI + Task Scheduler 已实现但仅为 best-effort。容器仍使用下文的手工 `credentialHandle` 或 `appSecretEnv` 配置，并由 Docker 等 supervisor 常驻 DSH Host。

## 安装

先安装并配置 `@dsh-enhanced/assistant-policy` 与 `@dsh-enhanced/assistant-delivery`，再安装本包：

```sh
dsh plugin --profile web add @dsh-enhanced/lark-channel
dsh --profile web --dump-config
```

如果不使用向导，可在 profile patch 中填写真实值并启用：

```yaml
config:
  enabled: true
  account: personal-bot
  tenant: personal
  appId: cli_0123456789abcdef
  credentialHandle: lark-app-secret
  credentialPurpose: connect
  credentialLeaseMs: 86400000
  domain: feishu
  requireMentionInGroups: true
  showProgress: true
  statusReactions: true
```

该 handle 由 `@dsh-enhanced/credentials-keychain` 提供，并应只允许 consumer `dsh-enhanced-lark-channel`、purpose `connect`。兼容部署也可以不用 keychain service，改为仅配置 `appSecretEnv`，再通过进程环境或操作系统 service manager 注入：

```sh
LARK_APP_SECRET='...' dsh --profile web
```

`credentialHandle` 与 `appSecretEnv` 只能选一个；配置不接受 `appSecret` 等明文字段。handle 模式会把 adapter 的整个连接生命周期放在 credential lease callback 内。自然 TTL 到期会先清理旧连接，再申请新 lease 并重连；运维撤销或插件卸载会清理连接并停止续租，不能把 revoke 误当成 expiry 自动恢复。

## 已有飞书应用的手工配置

1. 在[飞书开放平台](https://open.feishu.cn/app)创建“企业自建应用”，在“凭证与基础信息”复制 `App ID` 和 `App Secret`。
2. 在“添加应用能力”中开启“机器人”。
3. 在“权限管理”中开通接收/发送单聊和群聊消息，并添加最小 reaction 写权限 `im:message.reactions:write_only`；如果控制台为接收事件提示额外权限，也一并按最小范围开通。
4. 在“事件与回调/事件订阅”中选择“使用长连接接收事件”，添加 [`im.message.receive_v1`](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)。使用审批卡片或 `/model` 选择卡片时，还要把“回调订阅方式”设为长连接并添加 `card.action.trigger`；普通消息 onboarding 不依赖这个可选回调。
5. 创建并发布应用版本，把可用范围至少包含你自己；未发布或不在可用范围时，飞书客户端可能搜索不到机器人或不会投递事件。

这一节只适用于手工输入 `--app-id` 的路径。一键选择/创建路径会在飞书确认页预置机器人、最小权限、消息事件与卡片回调；选择已有应用时这些配置只做增量添加，不会删除其现有权限。若企业策略要求管理员审批，仍需由企业管理员在飞书侧完成该审批。运行时不需要公网 callback URL；官方 Node SDK 的[长连接说明](https://github.com/larksuite/node-sdk/blob/main/README.zh.md#%E4%BD%BF%E7%94%A8%E9%95%BF%E9%93%BE%E6%A8%A1%E5%BC%8F%E5%A4%84%E7%90%86%E4%BA%8B%E4%BB%B6)也说明本地环境只需能访问公网。

如果应用是在 reaction 或模型卡片回调功能加入前通过向导绑定的，需要重新运行一次一键向导，确认新增的 `im:message.reactions:write_only` 权限与 `card.action.trigger` 回调；随后按飞书要求发布新版本/完成管理员审批。指定 App ID 后，向导只增量更新该应用，不会新建第二个应用，也不会删除已有配置：

```sh
# 暂停旧长连接，避免 owner 确认消息被常驻实例竞争消费；向导结束会重新安装并拉起服务
launchctl bootout gui/$(id -u)/ai.deepseek.dsh.profile.web

~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --create-app \
  --app-id cli_0123456789abcdef
```

如果在官方确认或 owner 私聊阶段中途取消，可运行 `dsh-lark-setup --profile web --install-service` 恢复原常驻服务。

长连接订阅至少需要：

- `im.message.receive_v1` 接收消息事件；
- 发送/回复消息所需的 IM 权限；
- 机器人读取自身身份所需权限；
- 如果希望群内无需 `@机器人` 就触发，必须同时把 `requireMentionInGroups` 设为 `false` 并在飞书侧申请更宽的群消息权限。

`account` 和 `tenant` 是 DSH 内部的稳定路由命名，不是 Secret。个人单应用通常保持默认 `account: primary`、`tenant: personal`；真正的飞书身份由向导发现的应用作用域 `open_id` 决定。

陌生外部身份仍会由 `assistant-delivery` 以 fail-closed 方式拒绝；不要依赖飞书侧“能收到事件”等同于已授权。

## 可靠性语义

- 事件处理器会等待 `assistant-delivery.acceptInbound()` 完成，即 inbox 落盘后才向长连接回调返回成功。
- 只有合法、非重复且状态为 `queued` 的入站消息会异步添加 `Get`；未授权、死信或 provider 重放不会重复 reaction。精确表情类型为大小写敏感的 `Get` 和 `DONE`。
- Agent 的最终回复会显式携带原始飞书 `messageId`，先成功回复该消息，再添加 `DONE`。发送失败、无最终回复、任务失败或取消均不会添加 `DONE`；首版保留 `Get`，不会为了替换表情再申请 reaction 读取权限。
- 执行进度使用飞书原生 `/open-apis/im/v1/message_cot` 展示：`showProgress: false` 可关闭。该接口不在固定版 Node SDK 的高层 API 中，因此作为可降级展示使用；创建或更新失败只记录 channel health，不会重跑任务或影响最终 Outbox 回复。
- 进度映射只接受 Delivery 的强类型事件：开始、步骤说明、脱敏工具名、工具成功/失败、待办快照和终态；`assistant/chunk`（包括流式 `reasoning-delta`）、工具 arguments、工具 output、系统提示和错误详情不会进入飞书载荷。步骤说明优先取 `assistant/message` 已定稿的 `reasoning` 块（助手自己对该步的说明，不是流式片段）；**并非所有 provider 都会产出 reasoning**——订阅制 CLI 只声明 effort 能力、实际仅回传 `text`，ACP 的 thought 通道到 DSH reasoning 的映射尚未实现，因此 `step/start` 另外映射为中性阶段文案，保证这些 provider 也不会出现空面板。同一次运行的每条步骤/待办各用独立 `messageId` 追加，避免互相覆盖。
- 回合失败时除 `RUN_ERROR` 外还会在面板正文写入一行「任务未完成」，附带上游错误码（如 `ACP_PROTOCOL_ERROR`）：provider 可能在产出任何内容前就失败，只发 `RUN_ERROR` 会让面板停在首行、看起来像卡住。只透传短错误码，provider 的原始错误消息可能包含 prompt 或上游载荷，不出边界。
- Agent 回答按 Markdown 渲染：回答本身是 Markdown（表格、加粗、行内代码），以 `plain` 文本发送会把 `|---|`、`**` 等原始语法直接暴露给用户。Delivery 仅在渠道 adapter 声明了 `markdown` 能力时才请求该格式，否则降级为 `plain`——coordinator 会把 adapter 未声明的格式判为 `unsupported-format` 并丢弃整条消息，因此降级是为了保证回复不会因能力不匹配而丢失。回答卡片保持内容优先：不额外加 header（飞书已在气泡上方显示机器人名称与头像，再加会重复），只用一个 `markdown` 组件承载正文，并通过 `wide_screen_mode` 避免 Markdown 表格在宽屏下折行。
- `messageId` 是稳定 inbound event id；delivery 的 `(channel, account, eventId)` 唯一约束承担跨重启去重。
- 单聊按 account/tenant/user/chat 绑定；群聊以根消息 id 作为显式 thread，避免不同发言人或话题串线。
- plain text 使用飞书文本消息；Markdown 使用 schema 2.0 卡片。请求携带由 delivery idempotency key 单向哈希得到的 provider UUID。
- `approval` intent 使用 schema 2.0 双按钮卡片。每个按钮值由 app secret 做 HMAC 签名并绑定 operation、proposal/version、expiry、binding、decision 与 chat；回调重新取 provider actor/chat 后交给 Delivery/Policy，篡改、过期、跨 chat 和重复决策均失败关闭。
- `model-picker` intent 使用 schema 2.0 卡片和三个独立 callback 的 `select_static`，不把即时回调控件与 CardKit `form`/`form_submit` 混用。provider、model、effort 每次变化都会通过 `card.action.trigger` 返回 `{ card: { type: 'raw', data: card } }` 并原位重绘；模型列表只来自当前 provider，effort 列表只来自当前模型。v3 签名 token 绑定 operation、expiry、binding、chat、动作、revision 以及当前 provider/model/effort，普通 callback 确认按钮直接提交该签名状态，不依赖 `form_value`；adapter 先拒绝篡改、过期、跨 chat 和级联错配，Delivery 再用持久 CAS 拒绝旧 revision，并核对 owner/Policy 与实时模型能力。确认操作先持久领取再快速响应飞书，最终选择、结算结果和 Outbox 回复在同一 SQLite 事务中提交；卡片 4xx 会自动降级为文字目录。三个下拉的当前项通过 `initial_index` 定位——飞书的 `initial_option` 按选项展示文本而非回传 `value` 匹配，直接写入 route 形态的 `value` 会静默回落到第一个选项；`initial_option` 仅在该文本唯一标识一个选项时附带，当前项不在选项列表内时两者都不下发，不伪造预选。卡片版式按飞书官方卡片风格规范组织：header 用 `title` + `subtitle` + `icon` 承载「这是什么 / 当前模型」，三个下拉各自放进带描边的 `interactive_container` 分块（而不是平铺 markdown 标签），每块含一行灰色 `notation` 说明，末尾只保留一个 `primary` 按钮作为唯一焦点。升级后应重新发送 `/model`，旧 v1/v2 卡片不会继续生效。
- 权限/格式错误是确定未发送；限流和未连接可以安全重试；网络超时或未知 SDK 错误进入 `unknown_after_send`，不会盲目重发。
- 当前飞书 API 没有为该发送 UUID 暴露可靠查询/对账接口，因此 adapter 明确声明 `reconcileUnknownSend: false`、无 delivered/read receipt。

官方长连接会自动重连，但不提供可持久化 replay cursor 或历史补拉接口。本包记录 `reconnecting` / `connected-with-gap` 与 `gapGeneration`；它依赖飞书 redelivery 和 delivery inbox 去重，不宣称断线期间零丢失。若未来出现官方 cursor/backfill contract，应先加入崩溃与重放测试再启用。

## 安全与权限

- **网络：**仅访问所选 `domain` 的飞书/Lark OpenAPI、token 服务和 WebSocket endpoint；没有通用 HTTP 工具。
- **凭据：**优先通过 `credentials-keychain` handle 获取；兼容模式只读取 `appSecretEnv` 指定的一项。值不写数据库、不进入 tool、health、route、日志或异常文本。`appId` 不是 secret。
- **文件系统：**运行时无业务文件读写；setup wizard 会原子更新所选 profile patch，通过 `assistant-delivery` 的本地控制面写入精确 owner，并以 `0600` 写入用户级 LaunchAgent plist、在 `$DSH_HOME/logs` 创建 Host 日志。官方 SDK 依赖的 `protobufjs` postinstall 只打印版本建议，仓库显式设为 `allowBuilds: false`，运行不需要安装脚本。
- **子进程：**运行时只使用 credential provider 的固定无 shell 命令。setup wizard 在 macOS 调用 `/usr/bin/security` 与 launchd，在 Linux 调用 `/usr/bin/secret-tool`、`/usr/bin/systemd-ask-password` 与 `systemctl --user`，Windows 调用固定 PowerShell DPAPI 命令与 Task Scheduler；自动生成的 Secret 只通过标准输入传递且缓冲区随后清零，不作为 argv 传递。所有平台都会调用 `dsh --dump-config` 验证 profile；常驻配置只包含解析后的程序路径和最小环境，不复制 ambient token/password。
- **浏览器：**setup wizard 会输出飞书官方的短期设备授权链接与二维码，但不会自动操控浏览器；由用户在飞书中选择已有应用或创建新应用，并查看、确认权限增量。
- **消息数据：**标准化文本、provider message id、chat/user/thread id，以及最多 10 个受限附件描述符会进入 delivery SQLite；raw 事件、token 和下载 URL 不保存，provider file key 只作为隔离账本中的不可信引用，不进入模型正文。
- **进度数据：**仅发送有长度上限的工具名、已定稿的步骤说明、显式待办文本和固定状态文案；不发送流式思维链片段、工具参数/结果、凭据或内部错误详情。原生进度 API 与 reaction API 失败均按展示降级处理。
- **群消息：**默认必须直接提及机器人；`@all` 不等于提及机器人。最终授权始终由 delivery/policy 决定。

## 当前边界

- v0.1 自动处理文本入站、文本/Markdown-card 出站、typed approval/model-picker card、`Get`/`DONE` 状态和脱敏原生执行进度；模型仍不能提交任意 card JSON，也不能直接控制 reaction 或进度载荷。
- 二进制资源只写入 Delivery 的 durable metadata quarantine，不自动下载。下载、病毒检查、内容大小/MIME/hash fence 和附件 outbox 仍保持关闭。
- 消息编辑和上传尚未实现；未来也必须先创建 Delivery 的持久 operation，不得从模型直接调用 SDK。
- 单个飞书应用的长连接是集群竞争消费，不提供广播或多节点 exactly-once。当前 suite 的可靠性目标是受 supervisor 管理的单机进程。
- setup wizard 在 macOS 和 Linux 受支持，Windows 为 best-effort；它需要交互式终端和一次 owner 私聊，不接受 `--app-secret` 一类参数。一键模式会在用户扫码确认后通过飞书官方流程选择或创建应用；企业管理员审批等租户控制面仍由飞书强制执行。

## 常见问题

- **提示凭据或 bot identity 错误：**重新核对 App ID/Secret、`feishu`/`lark` 域和机器人能力；重新运行向导会更新同一 Keychain 条目。
- **一键创建链接过期或被拒绝：**重新运行 `dsh-lark-setup --profile web --create-app`；链接仅在页面显示的期限内有效，且只能由一位用户确认。
- **长连接成功但一直等不到短语：**确认事件接收方式是长连接、已添加 `im.message.receive_v1`、应用版本已发布且你在可用范围内，并且是私聊机器人原样发送短语。
- **`assistant_health` 显示 `disabled`：**向导尚未成功写入 profile，或常驻服务仍在运行旧配置；重新执行 `--install-service`。
- **`launchd bootstrap failed: Bootstrap failed: 5: Input/output error`：**新版安装器会检查稳定 job 状态并对这个 macOS 瞬时竞态做有限重试；先重新 build 本项目的 `lark-channel`，再执行 `dsh-lark-setup --profile web --install-service`。若仍失败，用 `plutil -lint ~/Library/LaunchAgents/ai.deepseek.dsh.profile.web.plist` 校验配置，并查看 `~/.dsh/logs/web-host.error.log`。
- **`caller is not allowlisted for this credential handle`：**这是旧版默认导出丢失稳定 Cordis plugin identity 导致的错误；更新并重新 build `lark-channel`，再执行 `--install-service`，不要把 credential consumer allowlist 改宽。
- **显示 `connected-with-gap`：**连接曾中断；飞书没有可持久化 replay cursor，检查这段时间是否有漏处理消息。
- **收到消息但无回复：**先发送 `/model`，选择一个目录中可用且已登录的 route；再看 `assistant_health`。未授权身份会 fail-closed，不会自动成为 owner。
- **有最终回复但没有 `Get` / `DONE`：**旧应用通常缺少 `im:message.reactions:write_only`。重新运行 `dsh-lark-setup --profile web --create-app`，在官方页面选择当前 App ID，确认权限增量并发布应用版本。reaction 失败不会阻断回答。
- **看不到执行进度但能正常回答：**确认 profile 中 `showProgress: true`。原生进度接口是可降级能力，租户或应用类型不支持时最终回答仍会正常发送；查看 `assistant_health` 的 `larkChannel.lastErrorCode` 和 Host 错误日志定位权限/接口问题。
- **能看到模型卡片但下拉框不联动或确认后无回复：**确认应用已订阅 `card.action.trigger` 且回调方式是长连接；运行 `dsh-lark-setup --profile web --create-app --app-id <当前 App ID>` 会锁定该应用并以增量方式补齐回调。确认授权、发布应用版本、重启插件后，请重新发送一次 `/model`，不要继续使用升级前已打开的旧卡片。若实时目录已经变化或 effort 不受模型支持，机器人会要求重新发送 `/model`。

## 兼容性

- DeepSeek Harness：`>=0.1.0-rc.8 <0.2.0` 基线语义（通过 `assistant-delivery`）。
- `@dsh-enhanced/assistant-delivery`：`>=0.1.0 <0.2.0`。
- `@dsh-enhanced/credentials-keychain`：handle 模式为 `>=0.1.0 <0.2.0`；env fallback 不要求其激活。
- 官方 `@larksuiteoapi/node-sdk`：固定 `1.73.0`；使用 `WSClient`、`EventDispatcher`、`Client` 和 `normalize`，而不是高层 Channel 的内存 dedup/retry 状态机。

参见仓库的[兼容性基线](../../docs/compatibility.md)。
