# 兼容性基线

仓库初始化时对齐以下上游源码状态：

- DeepSeek Harness 运行时与 npm 测试依赖：`0.1.0-rc.6`
- 官方 ACP 行为复查基线：`@deepseek-ai/dsh-acp@0.1.0-rc.5`（上游源码提交 `47f943859bef60e4160492346772ded9b24f765a`）
- `@deepseek-ai/cordis`：`4.0.1`
- Node.js：`^22.19.0 || >=24.0.0`
- pnpm：`11.7.0`
- Codex App Server 协议：Codex CLI `0.147.0`（`initialize` + `model/list`，用于 `coding-subscription-provider` 的无 prompt 模型目录发现）
- Claude Agent SDK 控制协议：Claude Code `2.1.218`（`initialize.models` 与逐模型 `supportedEffortLevels`）
- Grok 协议：Grok Build `1.0.5`（目录使用 `initialize._meta.modelState`；headless 生成使用 `--verbatim`、显式空工具集过滤，以及原生 `streaming-json` 的 `text.data` / `end` / `error` 事件）
- Cursor CLI 模型目录：官方 `--list-models` 接口（本机未安装，以有界 fixture 验证；未宣称支持 headless effort）

DSH 尚处于预发布阶段，插件机制可能发生破坏性变化。`pnpm-workspace.yaml` 的 catalog 和各插件 `peerDependencies` 是实际依赖范围的源；本页记录人工验证过的 DSH 基线。

升级基线时：

1. 阅读上游插件打包、profile、Cordis 生命周期和相关 subsystem 文档。
2. 更新 catalog 与所有受影响的 peer 范围。
3. 运行 `pnpm check`。
4. 用目标 DSH 的 `--dump-config` 验证每个 bundle，再做真实 profile 冒烟。
5. 在本页记录新的已验证版本，并在插件 README 中说明任何功能差异。
