# @dsh-enhanced/lark-channel

飞书/Lark 的薄协议适配器：把 WebSocket 长连接消息写入 `assistant-delivery` 的 typed Inbox，并把已经落盘的 Outbox intent 转成飞书发送或回复 API。本包不拥有配对、会话、重试或授权真源。

插件默认 `enabled: false`，安装后不会立即读取凭据或联网。启用后，合法新消息落盘时可添加 `Get`，最终答复发送成功后可添加 `DONE`；reaction 与原生执行进度都是 best-effort 展示，最终答复仍由 Delivery Outbox 保证。

默认进度策略为 `progressDetails: direct`：经 Delivery 授权的私聊可显示限长、常见凭据已脱敏的工具参数和结果；默认向导只授权 owner。群聊只显示工具名、状态、步骤与待办。`progressDetails: off` 可在所有会话隐藏参数和结果。任何 reasoning/thinking 内容都不外发；飞书 `message_cot` 不可用时只降级展示，不影响任务或最终回复。

## 文档

- [安装、凭据与常驻服务](docs/setup.md)
- [会话命令、卡片、可靠性与排障](docs/operations.md)
- [分级自治成长激活器](docs/supervised-growth.md)
- [进度展示、安全与权限边界](docs/progress-security.md)

## 兼容性

- DeepSeek Harness：`>=0.1.0-rc.8 <0.2.0` 基线语义（通过 `assistant-delivery`）。
- `@dsh-enhanced/assistant-delivery`：`>=0.1.0 <0.2.0`。
- `@dsh-enhanced/credentials-keychain`：handle 模式为 `>=0.1.0 <0.2.0`；env fallback 不要求其激活。
- 分级自治成长激活器要求有效 profile 同时启用 `@dsh-enhanced/assistant-automations`、`@dsh-enhanced/assistant-evaluation`、`@dsh-enhanced/preference-learning`、`@dsh-enhanced/assistant-evolution` 与 `@dsh-enhanced/assistant-heartbeat`；它复用 Delivery 的 provider/model，不要求 TraeX 成为当前 route。T1 偏好采用和已验证退化回滚可自动执行，自由文本 guidance 与高影响动作继续走 owner proposal。
- 官方 `@larksuiteoapi/node-sdk`：固定 `1.73.0`。
- Node.js：`^22.19.0 || >=24.0.0`。

仓库级基线见[兼容性说明](../../docs/compatibility.md)。

## 安装

先配置 `@dsh-enhanced/assistant-policy` 与 `@dsh-enhanced/assistant-delivery`，再安装本包：

```sh
dsh plugin --profile web add @dsh-enhanced/lark-channel
dsh --profile web --dump-config
```

推荐使用跨平台向导完成飞书应用授权、凭据保存、owner 绑定、最小 Policy 和用户级常驻服务：

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-lark-setup \
  --profile web \
  --create-app \
  --allow-agent-tools
```

源码工作区也可运行：

```sh
pnpm --filter @dsh-enhanced/lark-channel build
pnpm --filter @dsh-enhanced/lark-channel run onboard --profile web --create-app --allow-agent-tools
```

向导不会把 App Secret 放进 argv、profile 或日志。macOS 使用 Keychain，Linux 优先 Secret Service、无桌面环境降级为严格权限的 protected-file，Windows 使用 best-effort DPAPI。完整流程、已有应用接入和平台排障见[安装文档](docs/setup.md)。

## 最小配置

不使用向导时，可在 profile patch 中配置：

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
  progressDetails: direct
  statusReactions: true
  imageDownloadTimeoutMs: 30000
```

`credentialHandle` 应由 `@dsh-enhanced/credentials-keychain` 提供，并只允许 consumer `dsh-enhanced-lark-channel`、purpose `connect`。兼容部署可改用 `appSecretEnv`，两者只能选一个；配置不接受 `appSecret` 等明文字段。

飞书应用至少需要机器人身份读取、单聊/群内 @ 消息接收、机器人发消息、`im.message.receive_v1`；`Get`/`DONE` 需要 `im:message.reactions:write_only`，图片需要 `im:resource`，审批和选择卡片需要 `card.action.trigger`。事件与回调使用 WebSocket 长连接，不需要公网 callback URL。

## 常用命令

在飞书会话中使用：

```text
/status             # 当前 session 代次与上下文统计；/session 同义
/stop               # 停止当前任务，保留 session
/new                # 停止旧任务并切换到空白 session；/clear 同义
/compact            # 宿主支持时压缩当前上下文
/model              # 打开 provider/model/effort 选择卡片
/model use <route>  # 文字方式切换模型
/model reset        # 恢复部署默认模型
/permissions        # 查看并选择权限档位
/permission ask
/permission auto
/permission full confirm
```

未知 slash 命令不会进入模型。模型卡片、权限卡片和会话 lane 语义见[操作文档](docs/operations.md)。

运维常用：

```sh
# 重新安装或重启用户级常驻服务
dsh-lark-setup --profile web --install-service

# 刷新 setup 托管的 Agent Policy，不重走 onboarding
dsh-lark-setup --profile web --refresh-agent-policy --allow-agent-tools
```

## 权限与数据边界

- `--allow-agent-tools` 是高权限显式开关：为本地 `foreground` 与精确 owner Delivery 主体建立 capability/工具可达性；不授权 `background`，也不绕过显式 deny、紧急停止、身份、预算及插件业务硬门。
- `ask` 和 `auto` 中需要人工确认的工具调用只向 active owner 私聊发送一次性审批卡；`full` 关闭逐次审批并放开 sandbox，应保持 owner 与应用可用范围最小。
- 网络仅访问所选飞书/Lark OpenAPI、token 与 WebSocket endpoint；图片读取使用固定消息资源端点，不接受消息或模型提供的 URL，并关闭重定向。
- App Secret 不写 Delivery 数据库、工具参数、health、route、日志或异常；Linux protected-file 没有额外静态加密，同 UID、root 和可读备份仍能取得内容。
- Delivery SQLite 保存标准化文本、路由 id 和最多 10 个受限附件描述符；不保存 raw 事件、token 或下载 URL。图片字节只交给 AttachmentStore。
- 私聊详细进度只使用 Delivery 生成的限长、常见凭据脱敏 preview；它不是秘密扫描器。群聊始终不发送参数或结果，reasoning/thinking 内容在任何会话都不外发。
- 群消息默认必须直接提及机器人；`@all` 不等于提及。最终授权始终由 Delivery/Policy 决定。

完整的文件系统、子进程、浏览器、审批签名和 Policy 说明见[进度与安全文档](docs/progress-security.md)。

## 当前限制

- v0.1 支持文本、受限图片描述符、文本/Markdown-card 出站、durable proposal、owner-DM 一次性工具审批、模型/权限卡片、reaction 和原生进度；模型不能提交任意 card JSON，也不能直接控制 reaction 或进度载荷。
- 只有图片资源具备受限下载能力，且依赖 AttachmentStore 与模型图片能力；文件、音频、视频和 sticker 只进入 metadata quarantine。没有病毒扫描、附件上传或消息编辑。
- 单应用长连接是集群竞争消费，不提供广播、多节点 exactly-once 或断线历史补拉；目标部署是受 supervisor 管理的单机进程。
- setup wizard 正式支持 macOS 与 Linux；Windows 为 best-effort。企业管理员审批和应用可用范围仍由飞书控制。
- `message_cot` 与 reaction 都可能因租户、应用类型或接口能力而降级；它们失败不会重跑任务，也不会阻断最终回复。

更细的传输可靠性和故障处理见[操作文档](docs/operations.md)。

## License

MIT
