# 添加与切换模型

日常模型配置在 **Web → 设置 → 模型**完成。添加普通 OpenAI / Anthropic 兼容 API 不需要修改项目代码，也不需要重新安装；配置和 API Key 保存在本机。

## 打开模型设置

默认安装完成后运行：

```sh
dsh-rsi web-url --profile web
```

在本机浏览器打开输出的完整地址，进入「设置 → 模型」。`web` 是默认配置名称；使用其他 profile 时替换命令中的名称。轻量 `core` 安装的启动方式见[安装指南](../scripts/install/README.md#场景与参数入口)。

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

## 使用 TraeX

在本机完成 TraeX 登录后，安装器会自动发现 `traex` 或 `trae-cli` 并启用接入，无需 API Key。打开模型选择器，选择 `traex-agent` 下的具体模型；`default` 表示沿用 TraeX 自己的默认模型。

模型目录来自当前 TraeX 账号，首次打开可能需要短暂等待。只有 `default` 或发现失败时，先确认本机 CLI 已登录、支持 ACP，再看[TraeX 帮助](../plugins/traex-acp-provider/README.md)。

## 常见问题

| 现象 | 先检查什么 |
| --- | --- |
| 没有模型列表 | 服务可能不支持列表查询；手填服务给出的准确模型 ID。TraeX 则先检查登录。 |
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

这是提供商内部的字段片段，不是完整配置文件。请求头值是固定字符串，不会自动替换为每次会话的 ID；API Key 继续由 Web 凭据输入框管理。修改后回到模型选择器验证，错误日志可用 `dsh-rsi logs --profile web --errors-only` 查看。
