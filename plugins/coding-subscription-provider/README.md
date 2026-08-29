# @dsh-enhanced/coding-subscription-provider

把同一台机器、同一 OS 用户已经登录的 Codex、Claude Code、Cursor Agent 与 Grok Build 注册为 DeepSeek Harness provider。发布 bundle 默认让 Codex 直接使用本机 ChatGPT/Codex 订阅的 Responses 通道；Codex CLI 是显式 fallback，其他 provider 使用各自的官方 CLI。

这是实验性的订阅兼容层。实际消耗哪个套餐、是否允许额外用量，仍由对应账号和上游服务决定。

## 能力契约

模型 route 只负责提供推理 token，不是能力授权边界。同一 Agent/preset 下，所有模型都获得完全相同的 DSH 工具和 skill catalog，并共用 ToolRuntime、Policy、审批与审计；切换模型不会增删能力。

Codex direct 使用原生 function call，CLI route 使用严格的 `dsh-tool-calls/v1` 信封，但两者都只把工具请求交还 DSH Host。provider 自身不执行工具，也不能绕过策略。

## Provider

| DSH provider | 发布 bundle 默认 transport | 默认模型 | 状态 |
|---|---|---|---|
| `codex-subscription` | `direct-responses`（CLI fallback: `codex`） | `default` → `gpt-5.6-terra` | route stable；private wire 实验性 |
| `claude-subscription` | `claude` CLI | `default` | experimental，默认关闭 |
| `cursor-subscription` | `cursor-agent` CLI | `default` | beta |
| `grok-subscription` | `grok` CLI | `default` | beta，默认关闭 |

安全默认值只启用 Codex 与 Cursor。Claude 存在第三方分发政策边界；Grok 需要用户先确认没有 per-model API Key 覆盖订阅登录，再显式启用。

## 快速开始

1. 在运行 DSH 的同一 OS 用户下完成 ChatGPT/Codex 登录。Codex direct 需要安全的 `CODEX_HOME/auth.json`，未设置 `CODEX_HOME` 时读取 `~/.codex/auth.json`。
2. 安装并检查 bundle：

```sh
dsh plugin --profile web add @dsh-enhanced/coding-subscription-provider
dsh --profile web --dump-config
```

3. 在 provider/model 选择器中选择 `codex-subscription` / `default`；它会使用 `gpt-5.6-terra`。真实调用会消耗订阅额度。

发布 bundle 已配置 `codex.transport: direct-responses`，不要求 `codex` 可执行文件，也不会启动 CLI 或 App Server。插件不提供登录 UI；需要重新登录时可单独使用官方客户端。

## 最小配置

通常无需覆盖默认配置。若要显式固定 Codex direct：

```yaml
codex:
  enabled: true
  transport: direct-responses
  directModel: gpt-5.6-terra
```

若私有 Responses 协议漂移或当前平台不支持 direct，可显式回退到 CLI：

```yaml
codex:
  enabled: true
  transport: cli
  command: codex
  models: [default]
```

CLI fallback 要求同一 OS 用户已经执行 `codex login`，且 `codex login status` 精确报告 ChatGPT 登录。Windows 当前必须使用 CLI，因为 direct auth 的所有权、链接数和权限检查依赖 POSIX 语义。

Cordis patch 覆盖不是深合并；手工覆盖嵌套 provider 时，请保留该 provider 所需的完整对象。完整配置、认证门禁、模型目录、超时、输入上限和协议说明见[详细参考](../../docs/coding-subscription-provider-reference.md)。

## 权限与数据边界

| 权限 | 插件行为 |
|---|---|
| 文件系统 | Codex direct 读取安全的 auth 文件，并可能在 401 刷新后以 CAS + 同目录原子替换写回；图片仅经宿主 attachment service 读取。CLI 模式校验 live session 与 canonical cwd 后把该 cwd 交给外部客户端；Codex CLI 使用 read-only sandbox。 |
| 网络 | Codex direct 固定请求 `https://chatgpt.com/backend-api/codex/responses`，仅在 401 刷新时请求 `https://auth.openai.com/oauth/token`。CLI 模式由官方客户端连接其登录、推理、更新或遥测服务。 |
| 子进程 | direct 不启动 Codex CLI/App Server。CLI 模式使用 `shell: false` 启动配置的单个客户端；模型目录探针不会提交 prompt。POSIX 取消整个进程组，Windows 只能 best-effort 终止直接子进程。 |
| 凭据 | direct 只接受本机 ChatGPT session，不回退 API Key，也不向响应或日志暴露 token。CLI 凭据由官方客户端管理；已知 API Key、第三方 base URL 和云路由变量不会传给子进程。 |
| 浏览器 | 插件不会打开浏览器；用户单独执行官方 login 时可能打开。 |
| DSH 工具 | 所有 route 接收相同工具/skill catalog，并共用 Host 执行器、Policy、审批和审计。provider 只返回工具请求，不在本机直接执行。 |
| 安装脚本 | npm 包没有 install/postinstall 脚本，也不会安装或更新任何官方 CLI。 |
| 日志 | 插件不主动记录 prompt 或 argv；目录探针 stderr 原文不进入诊断。可选 stderr 诊断有界并按常见规则脱敏，但无法识别任意业务秘密，高敏环境应保持关闭。 |

Codex direct 会把对话、tool schema、tool result，以及 attachment service 提供的图片发送到固定私有后端。CLI transport 会把任务正文写入 stdin 或私有 prompt 文件，不写入 argv；同机高权限用户仍可能检查进程内存、管道或文件，敏感多用户主机应使用容器或独立 OS 账号隔离。

## 排查

| 错误码 | 常见原因 | 处理 |
|---|---|---|
| `SUBSCRIPTION_AUTH_REQUIRED` | 未登录、登录来源不符或 auth 文件权限不安全 | 用运行 DSH 的同一 OS 用户重新登录；direct 检查 auth 文件所有者与权限。 |
| `LOCAL_SESSION_CWD_REQUIRED` | 请求不属于 live Agent Loop，或 cwd 的 canonical path 不一致 | 对齐 provider `cwd` 与 Delivery `defaultWorkspace`，重启后从真实会话重试。 |
| `CLI_NOT_FOUND` | CLI fallback 找不到客户端 | 检查 `command` 和 DSH 进程的 `PATH`。 |
| `CLI_WORKING_DIRECTORY` | CLI 仍拒绝当前非 Git 工作目录 | 检查 Codex 版本与脱敏诊断，确认固定 fallback 参数生效。 |
| `CLI_PROMPT_LIMIT` / `CONTEXT_WINDOW_EXCEEDED` | 本地序列化上限或模型上下文容量不足 | 先确认 `contextWindow` 与 Host compaction，再缩短历史或 schema。 |
| `CLI_TIMEOUT` | direct 或 CLI 调用超过总时限 | 检查网络/交互阻塞，必要时调整 `timeoutMs`。 |
| `CLI_PROTOCOL_ERROR` | CLI 输出或 Codex private Responses 事件发生协议漂移 | 采集脱敏 fixture；direct 可暂时切换到 CLI fallback。 |
| `CLI_FAILED` | CLI 非零退出且未命中专用分类 | 开启有界脱敏诊断，并在同一 OS 用户下单独复现官方 CLI。 |
| `QUOTA` / `CODEX_DIRECT_PROVIDER_HTTP` | 订阅额度不足或上游服务错误 | 检查账号额度、HTTP 状态和服务状态；插件不会自动切换 provider。 |

完整错误码、CLI fixture 采集方法和已知限制见[详细参考](../../docs/coding-subscription-provider-reference.md#排查参考)。

## 文档

- [详细配置、认证、协议与限制](../../docs/coding-subscription-provider-reference.md)
- [兼容基线](../../docs/compatibility.md)
- [Codex 路由调研](../../docs/grok-bot-codex-router-research.md)
- [插件生态与 Hermes/OpenClaw 对比](../../docs/dsh-personal-assistant-plugin-landscape.md)

运行与发布验证统一使用仓库根目录的 `pnpm check`。
