# Coding subscription provider 详细参考

本文记录 `@dsh-enhanced/coding-subscription-provider` 的完整配置、认证门禁、传输协议、排查方法和已知限制。日常安装与最小配置见[插件 README](../plugins/coding-subscription-provider/README.md)。

## 默认值与完整配置

发布 bundle 的 `cordis.patch.yml` 显式选择 `codex.transport: direct-responses`，因此正常安装后的 Codex 默认直连 Responses，不启动 CLI/App Server。脱离 bundle 直接使用导出的裸 schema 时，`transport` 为了兼容旧调用仍默认 `cli`；这不是发布 bundle 的运行默认值。

Cordis patch 覆盖不是深合并。手工覆盖嵌套 provider 时，建议保留该 provider 的完整对象：

```yaml
- id: dsh-enhanced-coding-subscription-provider
  name: '@dsh-enhanced/coding-subscription-provider'
  config:
    cwd: !!js dshHomePath('assistant-workspace')
    timeoutMs: 600000
    authProbeTimeoutMs: 10000
    maxAuthProbeBytes: 32768
    killGraceMs: 3000
    maxLineBytes: 262144
    maxOutputBytes: 2097152
    maxStderrBytes: 32768
    maxPromptBytes: 4194304
    extraEnvNames: []
    logDiagnostics: false
    codex:
      enabled: true
      transport: direct-responses
      command: codex
      models: [default]
      maxTurns: 1
      contextWindow: 128000
      directModel: gpt-5.6-terra
      directReasoningEfforts: [low, medium, high, xhigh, max, ultra]
      directDefaultReasoningEffort: low
      maxRequestBytes: 33554432
      maxRequestImageBytes: 25165824
    claude:
      enabled: false
      command: claude
      models: [default]
      maxTurns: 1
      contextWindow: 128000
    cursor:
      enabled: true
      command: cursor-agent
      models: [default]
      maxTurns: 1
      contextWindow: 128000
    grok:
      enabled: false
      command: grok
      models: [default]
      maxTurns: 1
      contextWindow: 128000
      userVerifiedSubscription: false
```

### 配置语义

- `codex.directModel` 是 direct 模式选择 `default` 时发送给后端的具体模型 id，当前为 `gpt-5.6-terra`。选择显式模型 id 时发送所选 id。私有后端不承诺模型 id 永久稳定。
- `codex.directReasoningEfforts` 是 direct route 暴露给 DSH 的 effort 列表；`codex.directDefaultReasoningEffort` 必须属于该列表。私有 wire 会把 `ultra` 规范化为 `max`。
- `codex.maxRequestBytes` 限制完整 JSON 请求，包括 base64 图片；`codex.maxRequestImageBytes` 限制累计图片负载，且不能大于前者。
- `contextWindow` 是 Host 用于主动 compaction 的 route 容量，单位为 token。它不改变工具、skill、输出或审批能力，也不等于本地输入字节限制。
- `models` 是目录探针不可用时仍展示的静态别名。CLI route 会在安全刷新后合并动态目录；Codex direct 只读静态目录，不启动 CLI/App Server。
- `timeoutMs` 是单次调用总时限。取消或超时先发 `SIGINT`，经过 `killGraceMs` 再发 `SIGKILL`，并等待一个等长窗口确认关闭。
- `authProbeTimeoutMs` 与 `maxAuthProbeBytes` 限制 CLI 认证及模型目录探针。Codex direct 不运行这些探针。
- `maxLineBytes`、`maxOutputBytes`、`maxStderrBytes` 和 `maxPromptBytes` 都按 UTF-8 字节计算。`maxPromptBytes` 是本地序列化/输入内存边界，超过时返回 `CLI_PROMPT_LIMIT`，不是模型上下文错误。
- `maxTurns` 只映射到 Claude Code 和 Grok Build；Codex/Cursor 不接收不支持的参数。
- `command` 只能是一个命令名或路径，固定使用 `shell: false`，不能写 shell 片段；Codex direct 不使用该字段。
- `extraEnvNames` 只列出要额外继承的环境变量名，值必须来自启动 DSH 的环境，不能在配置里直接写 secret。
- `logDiagnostics` 默认只记录固定提示。启用后最多记录经过常见 key/token/邮箱规则脱敏的 stderr 尾部 2,000 字符；高敏环境仍应保持关闭。

## 模型、工具与会话语义

provider/model route 只生成 token，不是 DSH 的能力授权边界。同一 Agent/preset 的所有 route 接收同一套 system、工具 schema 与 skill catalog，共用 ToolRuntime、Policy、审批、预算和审计。route 的差别仅是文本/function call 的传输协议、上下文容量和推理质量。

Codex direct 声明 `toolCalls: native`，保留后端原始 tool name、arguments 与 `call_id`。CLI route 声明 `toolCalls: bridge`，只接受严格的 `dsh-tool-calls/v1` 信封。两条路径都把请求返回 Host，由同一个 Agent Loop 执行工具并回填 result；provider 不直接执行 DSH 工具。

普通对话必须从仍在运行的精确 Agent/registry/session 重建。唯一允许的辅助请求是同 route、能严格证明属于当前 turn 的 rc.8 compaction；它必须保留原 system/tools 与 live surface 前缀，只追加 canonical instruction。`session-title`、其他嵌套请求以及伪造、过期、空闲、变形或 symlink escape 均在生成前以 `LOCAL_SESSION_CWD_REQUIRED` 拒绝。

配置 `cwd` 与 live session cwd 的 `realpath` 必须完全相同。bundle 默认把它与 Delivery 的 `$DSH_HOME/assistant-workspace` 对齐；修改时必须同步 Delivery `defaultWorkspace` 并重启。

DSH skill catalog 更新是完整替换。CLI 兼容 prompt 遇到明确 replacement 标记时只发送最新目录，不重复已被替换的旧目录。durable session 历史不会被改写。

## 订阅认证门禁

CLI 子进程默认只继承客户端运行所需的最小环境，如 `PATH`、`HOME`、XDG、代理/CA、`CODEX_HOME`、`CLAUDE_CONFIG_DIR` 和 `GROK_HOME`。下列 API 凭据即使列入 `extraEnvNames` 也不会传递：

```text
CODEX_API_KEY
OPENAI_API_KEY
ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN
CLAUDE_CODE_OAUTH_TOKEN
CURSOR_API_KEY
XAI_API_KEY
```

已知自定义 base URL 与 Claude Bedrock/Vertex/Foundry 切换变量也会被排除。认证不满足时返回 `SUBSCRIPTION_AUTH_REQUIRED`，不会静默改走 API provider。

### Codex direct

- 从固定的绝对 `CODEX_HOME/auth.json` 读取；未设置 `CODEX_HOME` 时读取 `~/.codex/auth.json`。
- auth 文件的直接父目录必须是当前 POSIX 用户拥有、不能向 group/other 开放写权限；文件必须是当前用户拥有的单链接普通文件，不能是 symlink，也不能向 group/other 开放权限。稳定且安全的祖先 home alias 可以解析到其 canonical 目录。
- `auth_mode` 必须为 `chatgpt`。读取有字节上限，并校验前后元数据没有变化。
- 凭据只用于固定 Codex Responses endpoint；不会返回给调用方或写入日志。
- direct 请求把已经过 Host 证明的 DSH session id 做域分离哈希，只在 wire 上发送稳定的伪名 `session-id` / `thread-id`；原始 session id 不进入请求或日志。`x-client-request-id` 与 `thread-id` 对齐。originator/version/user-agent 是本插件的 reconstruction dialect 标识，不冒充官方二进制逐字节一致的 OS/终端标识。
- 请求 body 的 `prompt_cache_key` 由伪名 session scope、Harmony 中和后的 instructions 与 canonical/sorted tool schemas 做内容寻址派生；同一会话的普通 turn 和 tool-result continuation 保持稳定，system 或工具 surface 改变时自动轮换。它只是 cache/routing hint，不替代完整 transcript，也不发送 `prompt_cache_retention`。
- Responses 返回 401 时先重新读取磁盘，复用其他进程可能已刷新的 session；token 未变化时才向固定 OAuth endpoint 刷新一次，并只重试原请求一次。
- 同一进程内相同认证身份共享一次刷新。写回使用元数据 CAS、同目录 `0600` 临时文件、`fsync` 与原子 rename；无法约束不遵循相同 CAS 的外部写者，因此跨进程冲突只能 best-effort 避免覆盖。
- POSIX 所有权和权限语义是 fail-closed 门禁，因此 direct 当前不支持 Windows。

`direct-responses` 使用 ChatGPT/Codex 当前的非公开协议；endpoint、认证文件、header、模型 id 与事件格式都可能改变。CLI fallback 不依赖该私有 wire。

### CLI providers

- Codex 只有 `codex login status` 精确报告 `Logged in using ChatGPT` 才执行，并用 `--ignore-user-config` 避免本机配置把请求改路由到其他 API。
- Claude 只有 `auth status --json` 报告 first-party `claude.ai` / `oauth_token` 才执行。这是订阅 OAuth 来源的强启发式，不等于证明具体套餐 entitlement。
- Cursor 先要求 `status` 成功；生成时还要求 `stream-json` 的 `system/init.apiKeySource` 为 `login`，`env`、`flag` 或缺失都会中止。
- Grok headless 目前不能独立证明 effective credential。启用前须完成 `grok login`，确认 `grok models` 已登录，再用 `grok inspect` 确认模型没有 `api_key` / `env_key` override，最后同时设置 `enabled: true` 与 `userVerifiedSubscription: true`。

CLI 模型目录发现都使用无 prompt、有界探针，不创建生成 turn；相同 provider 并发请求共享一次 in-flight 刷新，失败降级为静态 `models`。`resolveModel` 永远只读配置或缓存，不执行认证、目录发现或子进程。

## 传输与执行策略

### Codex direct

插件固定请求 `https://chatgpt.com/backend-api/codex/responses`，发送有界流式请求。DSH tool schema 映射为原生 function tools；tool result 使用同一个后端 `call_id` 进入下一轮。attachment service 可用时可以投影 DSH image block；否则 route 只声明 text。

direct 不支持把 `temperature` 或非空 `stop` 静默丢弃：显式提供时 fail closed。当前私有 request schema 不发送 `max_output_tokens`；DSH `maxTokens` 只用于宿主预算。成功响应若缺少 `Content-Type`，仍必须通过有界 SSE framing、事件白名单与完整终态校验；显式非 SSE media type 继续拒绝。

### Codex CLI fallback

固定命令形态为：

```text
codex exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check [固定禁用参数] --sandbox read-only ... -
```

末尾 `-` 明确从 stdin 读取 prompt。固定禁用清单关闭已知 shell/JS REPL/apply-patch、view-image、hooks、code-mode host、goals/memory、multi-agent、apps/plugins、browser/computer/image、web-search、skills/MCP 发现及交互控制面，并禁止 AGENTS/内建 skill 注入。`--skip-git-repo-check` 只绕过仓库存在性检查；live Host session、canonical cwd、read-only sandbox 与 DSH Policy 仍然有效。

这些 CLI 参数是减少原生能力暴露面的启动边界，不是 OS 级强隔离。已验证版本没有关闭模型目录声明 `apply_patch` 的独立总开关，因此 parser fail-closed 与 read-only sandbox 仍是兜底。

### 其他 CLI

- Claude Code：`-p --output-format stream-json --include-partial-messages --safe-mode --permission-mode dontAsk --tools "" --no-session-persistence`；prompt 经 stdin，effort 使用 `--effort`。
- Cursor Agent：`--print --output-format stream-json --mode=ask`；prompt 经 stdin且不传 `--force`。Ask 模式可能允许只读搜索，不是纯 token endpoint 或强沙箱。
- Grok Build：使用 `--output-format streaming-json --permission-mode dontAsk --no-auto-update --no-memory --no-subagents --disable-web-search --verbatim`，并用 allowlist + denylist 收敛原生工具集。Linux、macOS、Windows 都通过 OS 用户临时目录内独占创建的私有 prompt 文件传入正文，关闭后清理；不重新打开 `/dev/stdin`。

每次调用都是独立任务，不恢复外部 CLI session。插件不在普通失败后自动切换 provider 或模型，也不做通用重试；唯一例外是 direct 401 刷新后的原请求单次重试。

### 输入、输出与诊断

CLI prompt 不进入 argv，因此不受单个 argv 的约 128 KiB 平台限制。Codex、Claude、Cursor 使用 stdin；Grok 使用上述 prompt file。Codex direct 使用独立请求字节限制。

CLI JSONL 采用事件白名单。未知/畸形事件、缺少 assistant 内容或终态、provider 原生工具生命周期、混合或越权工具信封都会返回 `CLI_PROTOCOL_ERROR`，不会被拼接为成功文本。工具模式会缓冲本轮 CLI 文本，直到终态和信封校验通过。

每次调用结算都会产生一条无凭据生命周期诊断，包括阶段、prompt 是否提交、结果分类、teardown、exit/signal，以及能可靠测得的毫秒级延迟；不含 prompt、argv、stderr 原文或认证凭据。成功走 `debug`，非成功走 `info`。

## 排查参考

| 错误码 | 含义 | 处理 |
|---|---|---|
| `SUBSCRIPTION_AUTH_REQUIRED` | 登录门禁失败、检测到 API Key/非订阅来源，或 direct auth 文件不安全 | 用运行 DSH 的同一 OS 用户重新登录；检查 auth 所有者/权限；Grok 还需明确确认配置。 |
| `LOCAL_SESSION_CWD_REQUIRED` | 不匹配 live loop session，或 canonical cwd 不一致 | 从真实 Agent Loop 发起；同步 provider `cwd` 与 Delivery `defaultWorkspace` 并重启。 |
| `CLI_NOT_FOUND` | `ENOENT`，找不到客户端 | 核对 `command` 与 DSH 进程的 `PATH`。 |
| `CLI_WORKING_DIRECTORY` | Codex/wrapper 拒绝非 Git cwd | 检查 Codex 版本和脱敏诊断，确认 `--skip-git-repo-check` 生效；必要时使用目标 Git 仓库。 |
| `CLI_PROMPT_LIMIT` | 序列化 CLI 输入超过本地 `maxPromptBytes` | 先修正 `contextWindow`/compaction，再缩短历史、skill 或 tool schema；核对资源后才调大上限。 |
| `CONTEXT_WINDOW_EXCEEDED` | 模型明确报告上下文不足 | 让 Host compaction 后重试，或缩短历史；不要用增大字节上限掩盖。 |
| `CLI_TIMEOUT` | 调用超过 `timeoutMs` | 简化请求、检查网络或 CLI 交互阻塞，必要时调整时限。 |
| `CLI_PROTOCOL_ERROR` | CLI 输出或 private Responses 事件不符合有界协议 | 检查上游版本/私有协议漂移，采集脱敏 fixture；direct 可手动切到 CLI。 |
| `CLI_FAILED` | CLI 非零退出或其他未分类失败 | 开启有界脱敏诊断，在相同环境单独复现官方 CLI。 |
| `QUOTA` | direct 明确返回 `insufficient_quota` | 检查当前订阅额度；插件不自动切换 provider。 |
| `EMPTY_RESPONSE` | direct 成功终止但没有文本、reasoning 或可执行 tool call | 检查私有协议漂移后再重试。 |
| `CODEX_DIRECT_PROVIDER_HTTP` | Responses 或 refresh 返回非认证类 HTTP 错误 | 根据 `failure.status` 与服务状态处理；不会通用重试。 |
| `CODEX_DIRECT_PROVIDER_FAILURE` | 私有事件报告未细分 provider failure | 查看固定无凭据诊断，不会透传 provider message。 |
| `CODEX_DIRECT_CONTENT_FILTER` | 私有事件报告内容过滤 | 调整输入；不会伪装成空成功。 |
| `CODEX_DIRECT_TRANSPORT_ERROR` | 固定 endpoint 的 fetch/连接失败 | 检查网络、代理和 TLS。 |
| `CODEX_DIRECT_RESPONSES_FAILED` | 其他未分类 direct 失败 | 确认有意使用 direct，并检查私有协议变化。 |
| `INVALID_PROVIDER` | provider id 不存在 | 使用 README 表内的四个 `*-subscription` route。 |

## 真实 CLI fixture

解析器按 `decode → provider decoder → 归一化事件 → reducer` 分层。真实回归样本必须记录明确 CLI 版本：

```sh
node plugins/coding-subscription-provider/scripts/capture-cli-fixtures.mjs --help
```

脚本默认脱敏，并要求显式确认会消耗订阅额度。产物写入 `plugins/coding-subscription-provider/tests/fixtures/<provider>/<version>/<scenario>.json`，测试会在样本落地后自动激活。脱敏清单见[fixture 说明](../plugins/coding-subscription-provider/tests/fixtures/README.md)。

## 已知限制

- DSH `0.1.0-rc.8` 只提供 `LlmAdapter` provider 接缝，因此这是兼容适配，不是完整 Agent Runtime。
- 模型 route 的工具/skill 权限完全一致，但模型的工具选择质量、上下文容量和各 CLI 的沙箱实现可能不同。
- Codex direct 使用私有协议，不是 OpenAI 对第三方承诺的公开 API；auth、header、endpoint、模型、事件和 usage 都可能变化。
- Codex direct 只在 attachment service 可用时声明图片输入；不支持音频、视频和任意文件。图片与完整 JSON 请求有独立字节上限。
- direct auth 当前不支持 Windows；Windows 必须覆盖为 `transport: cli`。
- CLI route 不提供供应商 token usage。Codex direct 可以读取私有终态 usage，但该字段也不稳定。
- CLI 的 `temperature`、`stop`、`maxTokens` 等只能进入任务约束，不能保证等价于模型 API 参数。
- Codex read-only sandbox、Claude/Grok 空工具集、Cursor Ask 模式和兼容 prompt 都不是 OS 级隔离。不可信仓库应在容器、只读挂载或独立 OS 用户中运行。
- 插件没有远程共享、公共 HTTP 代理、token 导入或浏览器抓取能力。direct 只封装固定 Responses 与 refresh endpoint，不是通用认证代理。
- Cursor 目前只自动发现模型；当前生成路径缺少目标版本真实脱敏 fixture，且官方 headless CLI 没有可验证的 effort 控制面。
- Codex CLI App Server、Claude SDK control 与 Grok ACP 只用于模型目录发现；生成仍是一轮一个外部进程。Codex direct 不做动态模型发现。

### Claude 合规边界

Anthropic 技术文档允许 `claude -p` 使用订阅登录，但其法律与合规页面限制第三方产品代用户提供 Claude.ai 登录或路由 Free/Pro/Max 凭据。因此 Claude connector 默认关闭，只适用于同机、同 OS 用户的 experimental 委托，不提供登录、token 托管或多租户能力。公开或商业部署前应取得适用授权；否则使用 DSH 已有的官方 API Key provider。

## 已验证基线

- Node.js `^22.19.0 || >=24.0.0`
- DeepSeek Harness / `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-session` `>=0.1.0-rc.8 <0.2.0`
- Cordis `^4.0.1`
- Codex CLI `0.147.0`–`0.150.1`（显式 fallback；模型目录基于 App Server `model/list`）
- Codex direct（发布 bundle 默认；私有实验协议）
- `@deepseek-ai/dsh-attachment` `>=0.1.0-rc.8 <0.2.0`（可选图片输入）
- Claude Code `2.1.218`
- Grok Build `1.0.5`
- Cursor CLI 目录入口 `--list-models`；生成仍不列入已验证基线

仓库级依赖与 clean-room 快照见[兼容基线](compatibility.md)，协议设计背景见[Codex 路由调研](grok-bot-codex-router-research.md)。
