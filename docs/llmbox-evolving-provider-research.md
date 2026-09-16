# 从 LLMBox 指南定位 Evolving，并独立接入 Hermes / DSH

调研日期：2026-09-14。范围：指定飞书文档、文档发布的安装脚本、本机已安装启动器与客户端源码，以及少量合成 API 请求。本文不包含鉴权值，不修改现有客户端配置。

## 结论与证据边界

可以找到并直接配置这个 provider。入口是 [《在 ClaudeCode / codex-cli 爽用 Seed-Evolving 模型指南》](https://bytedance.larkoffice.com/wiki/QggnwvibGiVBbpk5Ptoc8C9qnZc)，本次读取 revision 277。严格说，**文档正文不是完整的 provider API 规范**：它给出了安装入口、source 参数、SSO 流程和凭据文件位置；实际 endpoint、token 转换和请求头来自它发布的脚本及本地安装结果，再由真实请求确认。

无需通过 Claude Code / Codex 子进程调用模型，也无需为基本接入新建 HTTP 代理。Hermes 和 DSH 可以各自新增 `llmbox-evolving` provider，共用现有 LLMBox 鉴权来源。推荐两端先统一使用已完成工具往返验证的 OpenAI Chat Completions 接口。

这里的“独立”指独立 provider 名称、路由与模型选择；SSO 身份、上游权限和额度仍属于 LLMBox。文档没有给出 Hermes / DSH 的官方支持承诺，本文证明的是本机版本和当前网关的技术兼容性。

## 确认的连接参数

| 项目 | 本次确认值 | 证据 |
| --- | --- | --- |
| Gateway | `https://llmbox-global.byteintl.net` | 本地 `_common.sh:5`；真实请求 |
| 模型 ID | `doubao-seed-evolving` | 实时 `GET /models` 与 `/v1/models` |
| 来源头 | `x-source: doubao_model_dogfooding` | 指南安装命令；`_common.sh:23`、`:533` |
| Chat Completions base URL | `https://llmbox-global.byteintl.net/v1` | `POST /v1/chat/completions` 返回 200 |
| Responses 请求路径 | `/responses` | `POST /responses` 返回 200 |
| Anthropic 请求路径 | `/v1/messages` | Bearer 与 `x-api-key` 两种鉴权分别返回 200 |
| 凭据来源 | `~/.llmbox/cache/accesstoken` | 指南；`_common.sh:65` |
| 当前本机 token 转换 | 第二行原始 token 前加 `at-` | `_common.sh:485`，本机 `USTTP_MODE=0` |

当前账号携带该 source 获取的实时列表只有这个模型。目录将其 `protocol` 标为 `anthropic`，但网关实测也提供 Chat Completions 和 Responses 转换；不能据目录字段断言另外两个接口不可用。返回的模型名称带 `-latest-version`，配置时使用目录给出的稳定 ID，不自行绑定响应里的内部名称。

目录声明上下文窗口 `200000`、输入模态仅 `text`，并提供 reasoning level 等元数据。这些是目录声明，**本次没有用 200k 输入、图片或所有 reasoning 档位验证**。不应据此给节点声明图片输入能力或擅自推导最大输出 token 数。

源码引用：[本地 LLMBox 公共库](/home/jiataorui/.llmbox/lib/_common.sh:5)、[模型列表请求](/home/jiataorui/.llmbox/lib/_common.sh:533)、[文档发布的安装脚本](https://llmbox-global.byteintl.net/api/v1/tool/llmgw_setup/install.sh)。安装脚本本次只下载检查，未执行。

## 本地鉴权文件如何引用

文件格式为两行：第一行保存时间戳，第二行是 token。本次仅记录它存在、权限为 `0600`、符合该结构，以及真实 API 接受它；不记录 token 原文。不能将文件路径、整个文件内容或第一行时间戳作为 API key。

本机 `_common.sh` 的 `get_api_key()` 在普通 SSO 模式返回 `at-<token>`，在 US-TTP 模式使用另一种分支，也支持 `LLMGW_SERVICE_SECRET`。因此稳妥方式是复用本地已安装的 `ensure_token` / `get_api_key`，而不是把所有地区硬编码成同一种 token 格式。[token 读取](/home/jiataorui/.llmbox/lib/_common.sh:65)、[启动鉴权](/home/jiataorui/.llmbox/lib/_common.sh:438)、[API key 转换](/home/jiataorui/.llmbox/lib/_common.sh:485)

下面是一个**可自行保存为本地启动脚本的示例**，它将凭据装载进子进程环境，不打印凭据，也不把它复制进客户端 YAML：

```bash
#!/usr/bin/env bash
set -euo pipefail
set +x
export LLMGW_SOURCE=doubao_model_dogfooding
source "$HOME/.llmbox/lib/_common.sh"
ensure_token
export LLMBOX_EVOLVING_API_KEY="$(get_api_key)"
exec "$@"
```

例如保存为 `~/.local/bin/llmbox-env` 并赋执行权限后，用它启动后文的 Hermes / DSH 命令。代码里的命令替换只在本机进程内传递值，不应改成 `echo` 或写入日志。

两端这里引用的都是 **`LLMBOX_EVOLVING_API_KEY` 的值**，并不原生理解 `accesstoken` 的两行格式。Hermes 的 `key_env` 和 DSH 的 `apiKeyEnv` 也都不是 `apiKeyFile`，不能直接填写文件路径。

生命周期限制需要明确：公共库在启动时检查本地缓存，按 29 天阈值决定是否发起 SSO 登录；源码没有给已运行的 Hermes / DSH 自动更新环境变量的机制。文档的“自动续期”不能扩展理解为任意独立客户端可长期免登录。重新登录更新文件后，采用上述方案的客户端需要重启以装载新 token；遇到服务端撤销、权限或额度变化也不能靠本地缓存年龄证明可用。[缓存阈值](/home/jiataorui/.llmbox/lib/_common.sh:16)、[登录分支](/home/jiataorui/.llmbox/lib/_common.sh:438)

## Hermes 独立节点

本机 Hermes CLI 报 `v0.20.0 (2026.8.3)`，源码 HEAD 为 `1be70d635`。已有的 `byted-llm`、`bytedance-gpt`、`byted-trae` 条目连接 Codebase LLMProxy，使用另一套鉴权引用；它们不是这个 LLMBox 节点，不应复用其 JWT 作为 LLMBox key。

将以下条目合并到 `~/.hermes/config.yaml` 已有的 `providers` 映射，保留其他 provider：

```yaml
providers:
  llmbox-evolving:
    name: LLMBox Evolving
    base_url: https://llmbox-global.byteintl.net/v1
    key_env: LLMBOX_EVOLVING_API_KEY
    default_model: doubao-seed-evolving
    api_mode: chat_completions
    extra_headers:
      x-source: doubao_model_dogfooding
```

临时选择这个节点，无需改变全局默认模型：

```bash
~/.local/bin/llmbox-env hermes chat \
  --provider custom:llmbox-evolving \
  --model doubao-seed-evolving
```

`custom:llmbox-evolving` 是 Hermes 的命名 provider 选择形式，不能照抄 DSH 的裸 provider 名。确需更改默认时，才合并 `model.provider: custom:llmbox-evolving`、`model.default: doubao-seed-evolving`、`model.api_mode: chat_completions`；`model.supports_vision: false` 可明确限制原生图片投递。[provider 身份](/home/jiataorui/.hermes/hermes-agent/hermes_cli/providers.py:736)、[CLI 参数](/home/jiataorui/.hermes/hermes-agent/hermes_cli/_parser.py:303)、[图片能力覆盖](/home/jiataorui/.hermes/hermes-agent/agent/image_routing.py:180)

选择 Chat Completions 有具体版本依据：Hermes 当前 `anthropic_messages` 路径明确跳过 provider `extra_headers`，Anthropic client builder 也没有对应参数。因此无法仅用上述 provider 字段保留 `x-source`。问题不是网关不接受 `x-api-key`，因为这个鉴权形式已实测成功。Responses 在 Hermes 中的模式名则是 `codex_responses`，不是 `responses`；其工具循环在本次没有实测，所以不作为首选。[请求头应用](/home/jiataorui/.hermes/hermes-agent/run_agent.py:5829)、[Anthropic client](/home/jiataorui/.hermes/hermes-agent/agent/anthropic_adapter.py:777)、[模式枚举](/home/jiataorui/.hermes/hermes-agent/hermes_cli/runtime_provider.py:380)

Hermes 新式 named provider 先解析 `key_env`，无法解析才回退 inline `api_key`。另外 `~/.hermes/.env` 优先于继承的 shell 环境：如果以后在其中写入同名静态 token，会覆盖启动脚本装载的新值。本机检查时 `.env` 没有 LLMBox / LLMGW 命名的变量。[解析优先级](/home/jiataorui/.hermes/hermes-agent/hermes_cli/runtime_provider.py:718)、[dotenv 优先级](/home/jiataorui/.hermes/hermes-agent/hermes_cli/env_loader.py:462)

## DSH 独立节点

向 `~/.dsh/settings.yaml` 已有的 `llm-pi-ai.providers` 合并一个 route：

```yaml
llm-pi-ai:
  providers:
    llmbox-evolving:
      displayName: LLMBox Evolving
      apiKeyEnv: LLMBOX_EVOLVING_API_KEY
      api: openai-completions
      baseURL: https://llmbox-global.byteintl.net/v1
      headers:
        x-source: doubao_model_dogfooding
      models:
        - id: doubao-seed-evolving
          name: Doubao Seed Evolving
          contextWindow: 200000
          input: [text]
```

启动方式示例：

```bash
~/.local/bin/llmbox-env dsh --profile web
```

本机 web profile 已挂载 `llm-pi-ai`，所以这是新增 provider route，不是再挂载一个同名 LLM 服务或新增 Cordis 插件。其他 profile 需要先确认也包含此 bundle。模型选择为 provider `llmbox-evolving`、model `doubao-seed-evolving`；确需改默认时，再单独设置：

```yaml
agent-default-model:
  provider: llmbox-evolving
  model: doubao-seed-evolving
```

DSH 的精确协议名是 `openai-completions`，与 Hermes 的 `chat_completions` 不同；base URL 字段也分别是 `baseURL` 和 `base_url`。DSH 另支持 `anthropic-messages`，在此网关可配根 URL `https://llmbox-global.byteintl.net`，由 adapter 请求 `/v1/messages`；它支持所需的 `headers.x-source`，故可以作为保留 Anthropic 消息语义的备选路线。

`apiKeyEnv` 经 DSH credentials service 解析，引用缺失会在发请求前失败。也可使用 DSH 的 `.credentials.yaml` 中 `refs` 存储这个引用，但那是复制一份 token，仍需处理续期；不应将密钥放进普通 `settings.yaml` 或 `headers.Authorization`。credentials-local 默认通过 watcher 更新内存 map，并非逐请求读取 LLMBox 文件；受控同步更新 `refs` 可支持后续请求拾取新值，但继承环境中的同名值优先，不能同时遗留静态环境值。

已核对实际安装版本：全局 DSH launcher 为 `0.1.5-rc.1`，它解析到的 `dsh-llm-pi-ai`、`dsh-llm`、`dsh-credentials-local` 都是 `0.1.5-rc.2`，pi-ai 为 `0.82.1`。使用该全局安装包导出的 `Config` 对上述 Chat route 做离线 schema 校验，结果 PASS、退出码 0；本机 `dsh --profile web --dump-config` 亦退出 0。这补充了邻近源码调查，避免把不同 checkout 的配置形状直接当成已装版本事实。

DSH 配置形状、源码与版本差异的详细证据见 [DSH 专项笔记](llmbox-dsh-provider-source-notes.md)。本次未将节点写入现有运行配置，也没有宣称已完成整个 DSH Host / Web 端到端验收。

## 已运行的验证

请求仅携带合成提示与合成工具 schema / 返回值，未上传仓库内容。凭据从本地文件在 Python 内存中读取，仅发送到文档指明的 LLMBox HTTPS 域名，未放进命令行参数或报告。

| 验证 | 实际结果 |
| --- | --- |
| `GET /models`，Bearer + source | HTTP 200；当前仅 `doubao-seed-evolving` |
| `GET /v1/models`，Bearer + source | HTTP 200；同一模型 ID |
| `POST /v1/chat/completions`，合成短问答 | HTTP 200；回复 `OK` |
| `POST /responses`，合成短问答 | HTTP 200；`status: completed`，回复 `OK` |
| `POST /v1/messages`，Bearer，合成短问答 | HTTP 200；`stop_reason: end_turn`，回复 `OK` |
| Chat 流式强制工具调用 | HTTP 200；23 个 JSON chunks，收到 `[DONE]`；`finish_reason: tool_calls`；函数 `lookup` 参数 `{"key":"ping"}` |
| Chat 工具结果回填 | 回填合成结果 `PONG`，HTTP 200；模型回复 `PONG`，`finish_reason: stop` |
| Anthropic，`x-api-key`，流式强制工具调用 | HTTP 200；包含 `thinking` / `tool_use` block，最终 `message_stop` |

以上请求的执行命令均退出 0。协议探测共 6 次模型请求，其中 Chat 工具验证包含调用和回填两次请求。它证明基本鉴权、URL、流式解析与简单工具往返可行；不证明复杂 JSON schema、多模态、长上下文、并行工具、取消、重试、负载和自动续期完整兼容。没有通过实际 Hermes / DSH Agent 运行完整工具循环。

## 来源快照

- 飞书文档 revision：277。
- 文档发布安装脚本 SHA-256：`8eca5a6c9f206dfdce29d66e064e9e9a5ed247de46762666caf746daa9db11e2`。
- 本地 `_common.sh` SHA-256：`16ec0b0d24968f2db102b246a35bb9b9bc1364496c259a82e1f37d008b27fb81`。
- 本地 `claude-w` 通过 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_CUSTOM_HEADERS` 启动 Claude：[claude-w:62](/home/jiataorui/.local/bin/claude-w:62)。这些变量是其实现线索，不是 Hermes / DSH 应照抄的配置格式。
- 本地 `codex-w` 还包含 OpenAI 订阅兼容分支：[codex-w:34](/home/jiataorui/.local/bin/codex-w:34)。本次独立调用只使用 LLMBox 鉴权成功，没有使用 `~/.codex/auth.json` 或复制订阅账号 headers。

本调研新增分析文档；未改插件源码、现有 provider、默认模型或鉴权文件。仓库已有其他未提交变更不属于本次调研。
