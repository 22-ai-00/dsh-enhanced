# 兼容性基线

仓库初始化时对齐以下上游源码状态：

- DeepSeek Harness 运行时与 npm 测试依赖：`0.1.0-rc.8`（上游源码提交 `141eb6fef83422698aef7a981029e843e8161534`）
- 官方 ACP 行为复查基线：`@deepseek-ai/dsh-acp@0.1.0-rc.5`（上游源码提交 `47f943859bef60e4160492346772ded9b24f765a`）
- `@deepseek-ai/cordis`：`4.0.1`
- Node.js：`^22.19.0 || >=24.0.0`
- pnpm：`11.7.0`
- Codex CLI `0.147.0`：`coding-subscription-provider` 默认 `transport: cli`；App Server 的 `initialize` + `model/list` 用于无 prompt 模型目录发现，生成走 JSONL。工作目录诊断仅在进程以 code `1` 退出、没有 stdout 协议输出，且 stderr 含完整行 `Not inside a trusted directory and --skip-git-repo-check was not specified.`（可伴随 stdin 提示）时专门映射，其他退出保持通用分类。
- Codex private Responses（实验性、未承诺兼容）：只有显式设置 `transport: direct-responses` 才启用。该路径绕过 Codex CLI / App Server，从当前 OS 用户的 `CODEX_HOME/auth.json`（未设置时为 `~/.codex/auth.json`）读取 ChatGPT session，并固定请求 `https://chatgpt.com/backend-api/codex/responses`；401 时至多刷新一次。插件自身的写回使用变更检测和同目录原子替换，但与不遵循同一 CAS 约定的外部进程（包括未来版本的官方 Codex）并发写同一文件时只能 best-effort 避免覆盖。auth 安全检查依赖 POSIX 所有权、链接数和权限位，当前不支持 Windows。请求/事件形状、认证文件布局、OAuth client、header、endpoint 与模型 id 都是对当前私有实现的观测，不属于 OpenAI 对第三方集成公开承诺的稳定 API，可能随时变化或失效，不应宣传为官方支持。升级本路径时必须重新核对 auth 安全约束、SSE 终态、原始 `call_id`、并行 function calls、encrypted reasoning replay、usage 记账与 request/response 字节上限。
- Codex private wire 的 clean-room 核验快照：OpenAI `openai/codex` 提交 `d52478c52ef09f001142a4b82339467c3880877f`（2026-08-25），重点核对 request shape、`session-id` / `thread-id` / `x-client-request-id` 请求头、lean SSE、`output_item.done`、即时 `response.completed`、`ultra`→`max`、失败码与 refresh body；外部参考仓库固定为 `b-nnett/grok-bot-0.18-reconstructed` 提交 `a9f633e09d49a85829b8236331b9e21f7e612634`。本插件 user-agent 是固定 reconstruction dialect 标识，不声称与官方二进制包含 OS/架构/终端信息的值逐字节一致；这两个快照也都不是对未来兼容性的保证。
- `@deepseek-ai/dsh-attachment@0.1.0-rc.8`：是 `coding-subscription-provider` 的可选 peer，并与 `dsh-llm@0.1.0-rc.8` 的 attachment peer 基线一致。只有该服务可用时，Codex direct 模式才声明并接受 `text + image` 输入；不支持音频、视频或任意文件。
- `@deepseek-ai/dsh-attachment-local@0.1.0-rc.8`：标准 DSH base 的 `attachment-local` row 默认挂载该持久、内容寻址的图片存储。`assistant-delivery` 的飞书图片桥在 owner/Policy 授权和模型图片能力校验之后下载，保存不可变 ref，再把 `ImageBlock` 交给 Agent；自定义 profile 若没有 `ctx.attachments` 会以 `attachment-store-unavailable` 失败关闭，不会把飞书 resource key 或临时 URL 降级进 prompt。该桥当前只支持 PNG/JPEG/WebP/GIF，并受下载层与 AttachmentStore 双重字节、数量、尺寸和像素上限约束。
- `@deepseek-ai/dsh-permission-presets@0.1.0-rc.8`、`@deepseek-ai/dsh-sandbox-policy@0.1.0-rc.8` 与 `@deepseek-ai/dsh-user-approval@0.1.0-rc.8`：personal-assistant 用三个 distinct 官方 preset id 暴露原生 selector，并为 fresh/no-user-setting 部署默认 `danger-full-access`；Settings 用户层仍优先。AssistantPolicy 让最新 canonical `permission/preset` 直接映射 reviewer，同时保留 custom event registry 读取旧日志和动态 bundle。切换命令显式物化 sandbox/approval；Direct Codex、TraeX 等 provider 最终都经同一 ToolRuntime / approval / sandbox / Policy 管线。rc.8 的 required-event registry 兼容层仍必须覆盖插件与 Host 两份 session 包，升级 format/registry 时需验证 persistence 冷恢复。
- Claude Agent SDK 控制协议：Claude Code `2.1.218`（`initialize.models` 与逐模型 `supportedEffortLevels`）
- Grok 协议：Grok Build `1.0.5`（目录使用 `initialize._meta.modelState`；headless 生成使用 `--verbatim`、显式空工具集过滤，以及原生 `streaming-json` 的 `text.data` / `end` / `error` 事件）
- Cursor CLI 模型目录：官方 `--list-models` 接口（本机未安装，以有界 fixture 验证；未宣称支持 headless effort）
- 飞书官方 Node SDK `@larksuiteoapi/node-sdk@1.73.0`：该版本原生 `WSClient` 只分发 `type=event`，会丢弃飞书长连接送达的 `type=card` callback；插件安装了一个有边界测试的兼容桥，将完整分片交给同一 `EventDispatcher` 并按官方帧格式 ACK。schema 2.0 整卡更新包装为 `{ card: { type: 'raw', data: card } }`。`normalizeCardAction()` 提供 `action.option`，provider→model→effort 级联的三个 `select_static` 均使用独立 callback，并在每次回调后原位重绘；不能把这些即时 callback 控件嵌进 CardKit `form` 再用 `form_submit`，也不依赖 raw `action.form_value`。v3 HMAC token 绑定 operation、binding、chat、expiry、动作、revision 与 provider/model/effort；Delivery 以 schema v5 CAS 拒绝旧 revision，并原子提交确认结算、选择与 Outbox 回复。确认 handler 在持久领取 operation 后立即响应，带租约和 fencing token 的 worker 可在重启后恢复实时模型解析，并在提交前重新核对 principal 与 Policy。图片使用独立的 bounded SDK client；总 deadline 覆盖 tenant token cache miss 和资源 GET，底层 token HTTP 也有硬超时。卡片固定使用 `config.update_multi: true`。这些约束和回调返回链路均有边界测试；升级 SDK 或本协议后必须新发 `/model` 做真实飞书卡片冒烟，旧 v1/v2 卡片不可复用。

DSH 尚处于预发布阶段，插件机制可能发生破坏性变化。`pnpm-workspace.yaml` 的 catalog 和各插件 `peerDependencies` 是实际依赖范围的源；本页记录人工验证过的 DSH 基线。

升级基线时：

1. 阅读上游插件打包、profile、Cordis 生命周期和相关 subsystem 文档。
2. 更新 catalog 与所有受影响的 peer 范围。
3. 运行 `pnpm check`。
4. 用目标 DSH 的 `--dump-config` 验证每个 bundle，再做真实 profile 冒烟。
5. 在本页记录新的已验证版本，并在插件 README 中说明任何功能差异。
