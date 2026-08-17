# @dsh-enhanced/acp

把 DSH 作为 [ACP](https://agentclientprotocol.com) stdio agent 使用，并保留 DSH 原生会话语义。

## 在 dsh 中使用

```sh
pnpm build
dsh plugin --profile acp add ./plugins/acp
dsh --profile acp --dump-config
```

然后让 ACP 客户端启动：

```sh
dsh --profile acp
```

发布后把 `./plugins/acp` 换成 `@dsh-enhanced/acp`。使用 DSH 源码 CLI 时，在 DSH 仓库执行 `pnpm --silent dsh --profile acp`；`--silent` 可避免 pnpm 的脚本提示污染 ACP stdout。

## 能力

- `default` / `plan` 模式直接映射 DSH `planMode`。
- 模型与推理等级来自 DSH 实时 provider 目录；目录变化会推送新选择器。
- 切换写入 DSH 原生会话选择引用，同一对话的下一个安全组装步骤立即生效；不会把一次步骤的 prompt 与 request 切到两个模型。
- 输出文本、推理、工具调用/结果、Todo 计划、标题和 token 用量；默认还在 `_meta.dsh.event` 携带未映射的完整 DSH 持久事件。
- 沿用 DSH 的权限请求、取消、工具、沙箱、模型配置与会话日志。

可在 profile 的 `cordis.patch.yml` 覆盖初始值：

```yaml
- id: dsh-enhanced-acp
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
    reasoningEffort: high
    includeRawEvents: true
```

`config` 是整段替换；关闭原始事件时设置 `includeRawEvents: false`。

## 边界

ACP 占用 stdout，诊断应走 stderr；同一 profile 不要再挂载其他 ACP stdio server。输入仅支持 text 与 resource link，后者作为文本引用进入模型；会话级 MCP server 请通过 DSH 配置，不从 ACP 请求动态注入。

权限与数据：插件自身不额外访问网络或凭据，但 ACP 客户端获得该 DSH profile 已组合的 agent 能力。stdio 可包含提示词、推理、工具参数/结果、标题、用量、workspace 路径及原始会话事件；只连接可信客户端，敏感场景可关闭 `includeRawEvents`。
