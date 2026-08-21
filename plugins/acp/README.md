# @dsh-enhanced/acp

让支持 [Agent Client Protocol（ACP）](https://agentclientprotocol.com) 的编辑器和客户端直接使用 DeepSeek Harness（DSH）。插件通过 stdio 提供 ACP 服务，并沿用 DSH 的 Agent、模型、工具、权限和会话能力。

## 安装

需要先安装 DSH `0.1.0-rc.8` 或兼容版本。然后创建一个独立的 `acp` profile 并安装插件：

```sh
dsh plugin --profile acp add @dsh-enhanced/acp
dsh --profile acp --dump-config
```

第二条命令用于确认插件已经进入最终配置，不会启动 ACP 会话。

DSH/Cordis 服务以及 patch 中使用的 `agent-presets`、`cordis-host-runner` 均由 DSH 安装闭包提供，插件不会在 profile 中重复安装这些宿主包。它们在 npm 清单中声明为可选 peer，仅表示需要由 DSH 运行时提供，并不代表相应能力可缺失。

## 连接 ACP 客户端

在 ACP 客户端中添加一个 stdio agent：

```json
{
  "command": "dsh",
  "args": ["--profile", "acp"]
}
```

具体配置入口和字段名由 ACP 客户端决定。DSH 启动后会占用 stdout 传输协议消息，因此不要在启动命令外再包装会向 stdout 输出内容的脚本。

在 Windows 上，如果 ACP 客户端不能自动解析 npm 生成的命令 shim，请按该客户端的配置方式把命令改为 `dsh.cmd`。不要使用会向 stdout 输出额外文字的启动脚本。

Windows 支持目前为实验性，尚未在真实 Windows 用户环境和主流 ACP 客户端上完成充分测试。如果遇到问题，欢迎在 [GitHub 仓库](https://github.com/22-ai-00/dsh-enhanced)提交 issue 或 pull request。

## 功能

- Linux 和 macOS 提供 `standard`、`code`、`minimal` 和 `cordis` 四种 DSH Agent 模式。原生 Windows 提供 `standard`、`code` 和 `cordis`；依赖 persistent Bash 与 `/bin/bash` 的 `minimal` 会被隐藏并拒绝启用。
- 使用 DSH 当前可用的模型和推理等级，并将它们提供给支持选择器的 ACP 客户端。
- 向客户端传输回复、推理、工具调用与结果、计划、会话标题和 token 用量。
- 沿用 DSH 的工具、沙箱、权限确认、取消和会话持久化机制。
- 可选择通过 `_meta.dsh.event` 保留尚未映射为标准 ACP 消息的 DSH 会话事件；为减少默认数据暴露，此能力默认关闭。

Agent 模式只能在会话第一条消息发送前选择，首轮开始后不能切换。Plan 是 DSH Agent 模式内部的能力，不会显示为单独的 ACP 模式。模型或推理等级的变更从下一次模型请求开始生效，不会修改正在执行的请求。

## 配置

插件默认使用 DSH profile 的模型设置。需要覆盖初始配置时，编辑 `~/.dsh/profiles/acp/cordis.patch.yml`：

```yaml
- id: dsh-enhanced-acp
  config:
    includeRawEvents: false
```

可用配置：

- `provider` 和 `model`：指定初始模型，必须同时设置；省略时使用 DSH 默认模型。
- `reasoningEffort`：指定初始推理等级。
- `includeRawEvents`：是否在 `_meta.dsh.event` 中发送未映射的 DSH 会话事件，默认为 `false`。

Cordis 的 `config` 是整段替换。覆盖配置时，请在同一段中保留所有需要的字段。

## 限制

- 每个 profile 只能挂载一个占用 stdio 的 ACP server。
- 输入支持文本和 resource link；resource link 会作为文本引用传给 DSH。
- 不支持在单个 ACP 会话中动态注入 MCP server，请通过 DSH profile 配置 MCP。
- 当前只提供内置 DSH Agent 模式，暂不暴露自定义预设；原生 Windows 不提供 Bash-only 的 `minimal`。
- 裸 ACP 环境没有 DSH 浏览器页面，因此 `cordis` 模式只能使用 Host 侧能力，不能使用 Client half。

## 权限与数据

插件本身不额外读取文件或凭据，不主动访问网络、启动子进程或控制浏览器，也没有面向安装者执行的 install/postinstall 脚本。ACP 会话能够使用哪些资源，取决于 `acp` profile 中启用的 DSH 工具及其沙箱和授权配置；`cordis` 模式还可以定义并运行进程内 Host 插件代码。

stdio 消息可能包含提示词、推理、工具参数与结果、会话标题、token 用量和 workspace 路径；启用 `includeRawEvents` 后还可能包含原始 DSH 会话事件。只连接可信的 ACP 客户端，只在确有调试或兼容需要时启用原始事件。

连接与会话生命周期实现参考了 DeepSeek Harness 官方 [`@deepseek-ai/dsh-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp/acp)，并保留其 MIT 许可归属。本插件在此基础上提供面向编辑器客户端的模式、模型、推理等级和富事件映射。

## 本地开发

在本仓库中测试未发布代码时，可以改为安装插件目录：

```sh
pnpm --filter @dsh-enhanced/acp build
dsh plugin --profile acp add ./plugins/acp
```

使用 DSH 源码版 CLI 时，请在 DSH 仓库中使用 `pnpm --silent dsh --profile acp`，避免 pnpm 的提示信息污染 ACP stdout。
