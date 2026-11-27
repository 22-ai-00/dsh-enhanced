# 添加与切换模型

日常模型配置可在终端直接通过 **`dsh-ray provider`** 引导完成，或在 **Web → 设置 → 模型**完成。添加内置三方服务或自定义 OpenAI / Anthropic / Gemini 兼容 API 不需要修改项目代码，也不需要重新安装；配置和 API Key 保存在本机。

## 终端引导配置（`dsh-ray provider`，推荐）

如果未安装/未绑定 `traex-agent` 或 `agy-agent`，或需要接入第三方 API：

```sh
dsh-ray provider                                       # 交互式引导选择 DSH 内置 40+ 三方 Provider 或自定义 API
dsh-ray provider list --profile web                    # 查看当前配置与 DSH Host 内置支持的 Provider 目录
dsh-ray provider --profile web --provider openrouter --model anthropic/claude-sonnet-4 --prompt-key
dsh-ray provider --profile web --provider my-gateway --custom --base-url https://gateway.example/v1 --api openai-completions --discover --prompt-key
dsh-ray provider remove openrouter --profile web --yes # 移除三方路由及对应凭据引用
```

`dsh-ray provider` 直接复用当前已安装 DSH Host 自带的 `@deepseek-ai/dsh-llm-pi-ai` 目录、Wire 协议列表、配置校验（`internal/config`）与端点模型探测（`discoverModels`），把 API Key 安全写入 `$DSH_HOME/.credentials.yaml` (`0600`, `version: 1` `refs:`)，在 `cordis.patch.yml` 更新 `llm-pi-ai` 与 `agent-default-model`（更新已有三方配置时保留原有的 `headers` / `compat` / 模型元信息；切换到 `traex-agent` / `agy-agent` 时同步启用 `traex-acp-provider` 的 `enabled` / `agyEnabled`），并用 `dsh --dump-config` 复核最终合成结果（如被 `$DSH_HOME/cordis.patch.yml` 覆盖或校验失败则自动回滚）。

## 打开模型设置（Web UI）

默认安装或轻量 `core` / `web` 安装完成后，可直接打开本地 Web 并前往左侧栏 **Settings → Models**（或在 **Settings → 文鳐助手** 中查看本机 ACP Agent）：

```sh
dsh-ray open --profile web          # 自动接通受管服务或前台启动并打开浏览器
dsh-ray web-url --profile web       # 仅查看已运行受管服务的 Web 地址
```

`web` 是默认配置名称；使用其他 profile 时替换命令中的名称。各场景参数详见[安装指南](../scripts/install/README.md#场景与参数入口)。

## 添加 API 模型

已有 DeepSeek 等提供商时，直接点该行的「编辑」填写 API 密钥。新增内置目录里的服务可选「添加模型提供商 → 第三方模型提供商」。

接入自己的网关或自部署服务，选择 **添加模型提供商 → 自定义模型 API**：

| 页面字段 | 怎么填 |
| --- | --- |
| Provider ID | 自定一个不重复的名称，如 `my-gateway`；小写字母开头，可含数字和短横线。 |
| 显示名称 | 可选，填容易辨认的名字。 |
| API 地址 | 服务提供的基础地址，例如 `https://gateway.example/v1`。 |
| API 协议 | 按服务提供的接口选择，见下表。 |
| API 密钥 | 只填 Key 本身，不带 `Bearer `、引号或 `KEY=`。 |
| 模型 ID | 服务提供的准确模型名；可以包含 `/`，不要用显示名称代替。 |

| 服务给出的请求地址 | API 地址 | API 协议 |
| --- | --- | --- |
| `https://gateway.example/v1/chat/completions` | `https://gateway.example/v1` | OpenAI Chat Completions |
| `https://gateway.example/v1/responses` | `https://gateway.example/v1` | OpenAI Responses |
| `https://gateway.example/v1/messages` | `https://gateway.example` | Anthropic Messages |

可以点「获取可用模型」，勾选后「添加所选」；服务不支持模型列表时，直接手填模型 ID 即可。至少添加一个模型，再点「创建提供商」。修改已有提供商时点「保存」。

API Key 通过专门的凭据接口保存，页面不会回显密钥，也不会把它写进 `cordis.patch.yml`。不要把本机配置或凭据提交到项目仓库。

## 选模型并验证

- **Web**：回到聊天，在输入框附近的模型选择器中选刚添加的模型。
- **飞书**：私聊机器人发送 `/model`，选择提供商、模型和可用的推理档位，最后确认。

发一句简单消息，确认能收到回复。模型出现在列表中只说明配置已加载；一次实际回复才能验证本次调用成功。

**添加模型不会切换当前选择。** 聊天里的模型选择作用于该会话；安装引导中的默认模型用于后续新会话，已有会话不会随之统一切换。

## 使用本机 ACP Coding Agent（TraeX 与 Antigravity `agy`）

`traex-acp-provider` 同时支持本机 TraeX（provider `traex-agent`）与 Antigravity CLI（provider `agy-agent`），无需 API Key，且可在左侧栏 **Settings → 文鳐助手**（或 **Settings → Models** 底部）实时检测、启用与热切换：

1. **TraeX（`traex-agent`）**：安装器或控制台检测到 `traex` / `trae-cli` 且 `traex login status` 通过时自动启用；默认以 `traex --sandbox read-only --ask-for-approval never acp serve` 运行，可在模型选择器中选 `traex-agent` 下的模型（`default` 沿用 TraeX 默认模型）。
2. **Antigravity CLI（`agy-agent`）**：检测到 `agy` 可用后（安装器与控制台以 `agy models` 做无交互检测；未登录时在终端交互运行 `agy` 或 `agy acp --login`），启用 `agyEnabled` 后通过 `agy acp --sandbox --include-default-customizations=false --disable-telemetry --stdio` 启动，可在模型选择器中选择 `agy-agent` 下发现的模型或 `default`。
   - **沙盒与信任边界**：`agy acp --sandbox` 仅约束终端命令执行，且 `agy acp` 不支持 `--ask-for-approval never`。不要在 `~/.gemini/antigravity-cli/settings.json` 中为不可信仓库启用自动批准（auto-approve）；仅需只读规划时可在 `traex-acp-provider` 配置中设置 `agyMode: 'plan'`。
3. **CLI 手工注册或切换**：安装可传 `--model-provider traex-agent` 或 `--model-provider agy-agent`；已有 profile 可运行：

```sh
dsh-model-setup --profile web --provider traex-agent --enable-in-profile web --default-if-absent
dsh-model-setup --profile web --provider agy-agent   --enable-in-profile web --default-if-absent
```

模型目录来自当前本机 CLI 账号，首次打开可能需要短暂等待。只出现 `default` 或发现失败时，先用 `dsh-ray doctor --profile web` 检查登录与 CLI 可执行文件状态，详见[ACP Provider 帮助](../plugins/traex-acp-provider/README.md)。

## 常见问题

| 现象 | 先检查什么 |
| --- | --- |
| 没有模型列表 | 服务可能不支持列表查询；手填服务给出的准确模型 ID。TraeX / Antigravity 则先运行 `traex login status` 或 `agy models`（或 `dsh-ray doctor`）确认登录。 |
| 401 / 403 或密钥缺失 | API Key、模型访问权限，以及当前机器是否能访问该服务。 |
| 404 或协议错误 | API 地址是否误填了完整请求路径，协议是否与服务一致。 |
| 页面只读或无法保存 | 用本机 `localhost` / `127.0.0.1` 的授权地址访问；当前 Host 不允许从非本机页面持久化设置。 |
| 设置发生冲突 | 关闭编辑卡片后重新打开，再基于最新配置保存。 |

## 需要额外请求头时

Web 目前不提供自定义请求头编辑器。这类高级设置仍属于本机配置：编辑 `~/.dsh/profiles/web/cordis.patch.yml` 中 `llm-pi-ai` 对应提供商的配置，保留原有的其他提供商和字段，无需修改仓库源码。

例如，**仅在服务要求时**，在目标提供商内部增加：

```yaml
headers:
  x-client-name: dsh
compat:
  maxTokensField: max_tokens
```

这是提供商内部的字段片段，不是完整配置文件。请求头值是固定字符串，不会自动替换为每次会话的 ID；API Key 继续由 Web 凭据输入框管理。修改后回到模型选择器验证，错误日志可用 `dsh-ray logs --profile web --errors-only` 查看。
