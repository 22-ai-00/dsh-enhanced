# dsh-enhanced

`dsh-enhanced` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的多插件仓库。`plugins/*` 中的每个目录都是可独立安装、测试和发布的 DSH bundle。

仓库目前包含两类能力：面向编码场景的 ACP/模型 provider，以及基于 DSH `0.1.0-rc.8` 自研的个人助理套件。个人助理提供审批与预算、长期记忆、Markdown Wiki、冷启动可恢复自动化、持久消息投递、飞书长连接和审批门控的行为 guidance 演化；这些包仍标记为实验性，适合先在受监督的单机 profile 中使用。

## 在 dsh 中使用

安装已发布插件：

```sh
dsh plugin --profile web add @dsh-enhanced/<plugin-name>
dsh --profile web --dump-config
dsh web
```

本地开发时把包名换成插件目录：

```sh
pnpm build
dsh plugin --profile web add ./plugins/hello
```

使用 DSH 源码版 CLI 时，把 `dsh` 换成 DSH 仓库根目录下的 `pnpm dsh`。

## 最快搭建个人助理

本地调试只需要一条命令，默认安装到 `web`、自动确保兼容的 DSH/pnpm、构建并链接本仓库插件，随后进入飞书保留或重新配置向导：

```sh
./scripts/install/install-local.sh
```

修改插件源码后，一键重建并纯重启当前 `web` 常驻服务，不更新任何配置：

```sh
./scripts/install/restart.sh
```

重启其他 profile 时只传一个参数，例如 `./scripts/install/restart.sh personal-web`。全部插件发布到 npm 后，可以在远程机器运行：

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/install-npm.sh)"
```

两个安装器、飞书复用/覆盖选项、实际安装清单和 macOS/Linux/Windows 差异见[安装脚本文档](scripts/install)。

默认 `standard` 模式仍保持 scheduler 和成长行为关闭。需要显式启用有 owner 飞书审批、每日预算和受限主动巡检的部署时使用：

```sh
./scripts/install/install-local.sh --mode supervised-growth --lark configure
```

该模式默认把带工具的 Agent 固定到声明 `bridge` 能力的 TraeX route。默认 Codex CLI transport 仍是 text-only；只有显式切换到实验性的 `direct-responses` transport，Codex subscription route 才声明原生工具调用，并在 attachment service 可用时声明图片输入。成长结果只形成按 workspace/preset 隔离的顾问性 guidance，采用和退役都必须经 owner 审批，不会自行改写代码、凭据、Policy 或部署配置。

如果希望逐项控制，CLI/Web 个人助理可以先安装核心 meta-bundle，它会组合 Policy、Memory、Wiki 和 Automations：

```sh
pnpm install
pnpm build
dsh plugin --profile web add ./plugins/personal-assistant
dsh --profile web --dump-config
```

默认配置是安全关闭状态：Policy 没有规则时拒绝受控写操作，后台 scheduler 也默认关闭。请按 [`personal-assistant` 文档](plugins/personal-assistant)和四个核心插件的 README，把 agent preset、绝对 workspace、工具范围与预算收窄到自己的真实环境后再开启无人值守任务。

需要通过飞书聊天时，再追加 Delivery、系统 Keychain 和 Lark adapter：

```sh
dsh plugin --profile web add ./plugins/assistant-delivery
dsh plugin --profile web add ./plugins/credentials-keychain
dsh plugin --profile web add ./plugins/lark-channel
pnpm --filter @dsh-enhanced/lark-channel run onboard --profile web --create-app
```

最后一个命令使用飞书官方设备授权流程，输出确认链接和终端二维码。确认页允许选择已有应用或创建新应用；选择已有应用时只展示并添加本 channel 所需的最小权限、消息事件和卡片回调，不删除原有权限。若要锁定更新某个已有应用（例如补齐 `card.action.trigger`），可追加 `--app-id cli_...`。App Secret 自动写入 macOS Keychain、Linux Secret Service 或当前用户的 Windows DPAPI 文件，不进入命令参数或 profile。向导还会通过一次 owner 私聊完成精确身份绑定、启用 Web profile，并通过 launchd、systemd user service 或 Windows Task Scheduler 保持常驻；Windows 路径为 best-effort。详细步骤见 [`lark-channel` 文档](plugins/lark-channel)。

连接后，合法的新消息持久入队会收到 `Get` reaction，普通 Agent 任务会显示不含原始 CoT/工具敏感数据的执行进度，最终回复发送成功后原消息再收到 `DONE`。私聊发送 `/model`，机器人会返回带“分组、模型、effort”三个下拉框的选择卡片；点击确认后，选择按聊天持久化，下一条消息生效且保留上下文。`/model use <provider/model>` 仍是文字后备。即使原默认模型 route 已失效，`/model` 也不依赖 LLM 生成，可以直接完成恢复。

## 插件一览

每个插件都是独立发布的 npm 包，只安装需要的能力即可。个人助理实验包在本地开发阶段可把表中的包名换成对应的 `./plugins/<name>`：

| 插件 | 简要说明 | 快速安装 |
|---|---|---|
| [`@dsh-enhanced/acp`](plugins/acp) | 将 DSH 暴露为 ACP stdio agent，让支持 ACP 的编辑器使用 DSH 的 Agent、模型、工具、权限与会话能力。 | `dsh plugin --profile acp add @dsh-enhanced/acp` |
| [`@dsh-enhanced/coding-subscription-provider`](plugins/coding-subscription-provider) | 接入本机已登录的 Codex、Claude Code、Cursor Agent 和 Grok Build；Codex 另有显式 opt-in 的私有 Responses 直连，可原生返回工具调用并消费图片。 | `dsh plugin --profile web add @dsh-enhanced/coding-subscription-provider` |
| [`@dsh-enhanced/traex-acp-provider`](plugins/traex-acp-provider) | 通过 ACP 调用本机已登录的 TraeX，并动态展示其模型与逐模型 reasoning effort。 | `dsh plugin --profile web add @dsh-enhanced/traex-acp-provider` |
| [`@dsh-enhanced/personal-assistant`](plugins/personal-assistant) | 个人助理核心 meta-bundle，一次组合 Policy、Memory、Wiki 和 Automations，不包含消息通道。 | `dsh plugin --profile web add @dsh-enhanced/personal-assistant` |
| [`@dsh-enhanced/assistant-policy`](plugins/assistant-policy) | 默认拒绝的授权、审批提案、硬预算和脱敏审计边界。 | 通常由 `personal-assistant` 安装 |
| [`@dsh-enhanced/personal-memory`](plugins/personal-memory) | 有界、分域、审批写入的长期事实与偏好记忆。 | 通常由 `personal-assistant` 安装 |
| [`@dsh-enhanced/personal-wiki`](plugins/personal-wiki) | Markdown 为真源、支持中文检索和审批写入的个人知识库。 | 通常由 `personal-assistant` 安装 |
| [`@dsh-enhanced/assistant-automations`](plugins/assistant-automations) | 带 occurrence/run 账本、租约 fencing 和隔离 Agent 的持久调度器。 | 通常由 `personal-assistant` 安装 |
| [`@dsh-enhanced/assistant-delivery`](plugins/assistant-delivery) | 与厂商无关的持久 inbox/outbox、身份配对、会话绑定和投递恢复核心。 | `dsh plugin --profile web add @dsh-enhanced/assistant-delivery` |
| [`@dsh-enhanced/credentials-keychain`](plugins/credentials-keychain) | 通过 OS Keychain/Secret Service 提供受 Policy 限制的凭据 handle。 | `dsh plugin --profile web add @dsh-enhanced/credentials-keychain` |
| [`@dsh-enhanced/lark-channel`](plugins/lark-channel) | 飞书/Lark WebSocket 薄适配器，带官方一键选建应用、`Get`/`DONE` 状态、脱敏执行进度、模型卡片和跨平台常驻服务。 | `dsh plugin --profile web add @dsh-enhanced/lark-channel` |
| [`@dsh-enhanced/assistant-heartbeat`](plugins/assistant-heartbeat) | 复用 Automations 的 active-hours 主动巡检和成本硬停止。 | 按需安装 |
| [`@dsh-enhanced/event-triggers`](plugins/event-triggers) | 持久化 file、受限 HTTPS/JSON 和 HMAC webhook 事件触发。 | 按需安装 |
| [`@dsh-enhanced/memory-wiki-bridge`](plugins/memory-wiki-bridge) | 在 Memory 与 Wiki 之间生成可追溯、需审批的晋升提案。 | 按需安装 |
| [`@dsh-enhanced/assistant-evolution`](plugins/assistant-evolution) | 基于可信 automation 结果提出按作用域隔离的行为 guidance，经飞书 owner 审批后注入后续 session；不自我扩权或修改代码。 | `supervised-growth` 模式安装 |
| [`@dsh-enhanced/assistant-health`](plugins/assistant-health) | 聚合各 provider 的脱敏 liveness/readiness 与运维诊断。 | 按需安装 |
| [`@dsh-enhanced/hello`](plugins/hello) | 最小示例插件，用于验证 bundle 安装、Cordis patch、构建与日志链路。 | `dsh plugin --profile web add @dsh-enhanced/hello` |

安装 Web provider 后运行 `dsh --profile web --dump-config` 检查最终配置，再执行 `dsh web`。Coding Subscription Provider 的 CLI transport 需要先安装并登录相应官方客户端；显式启用 Codex `direct-responses` 时，生成不需要 Codex 可执行文件，但要求同一 POSIX 用户已有符合安全权限约束的 `CODEX_HOME/auth.json` 或 `~/.codex/auth.json`。TraeX provider 还需要在配置中显式设置 `enabled: true`。各插件的完整配置、权限边界和排错方法见表内链接。

ACP 插件使用独立的 `acp` profile。安装后运行 `dsh --profile acp --dump-config`，再在 ACP 客户端中把 `dsh --profile acp` 配置为 stdio agent。原生 Windows 支持目前为实验性，详见插件文档。

个人助理为什么这样拆分、哪些社区实现只作为设计参考，以及目前仍未实现的浏览器/RPA、非图片附件下载/上传和资料 ingest，见[自研插件路线图](docs/dsh-personal-assistant-self-built-plugin-roadmap.md)。新增、重命名、弃用或移除插件时，应同时维护本表和 [`plugins/README.md`](plugins/README.md) 的完整目录。

## 开发

要求 Node.js 22.19+（或 24+）和 pnpm 11.7.0。

```sh
pnpm install
pnpm create:plugin my-plugin
pnpm check
```

## 发版与版本记录

仓库级版本记录在 [`release-manifest.json`](release-manifest.json)。查看当前版本、待发布版本和下一个默认版本：

```sh
pnpm release:status
```

准备下一次整体发版时，默认读取已记录版本并把补丁位加一，例如 `0.1.0 → 0.1.1`：

```sh
pnpm release:prepare
```

需要主动升级主版本或次版本时可以显式指定，而且指定值必须高于当前记录：

```sh
pnpm release:prepare -- 0.2.0
```

`release:prepare` 会统一修改根包、所有 `plugins/*` / `packages/*` 的 `package.json` 和运行时 `src/version.ts`，并写入 `pending`，但不会把尚未发布的版本标记为成功。运行 `pnpm check` 并提交版本变更后，只能从仓库根目录使用 pnpm 发布：

```sh
pnpm release:publish
```

不要在插件目录运行 `npm publish`：npm 不会把 workspace 的 `catalog:` 依赖转换成实际版本，最终包将无法在 DSH profile 中安装。每个插件的 `prepublishOnly` 会拦截这种误操作。确认所有包都已发布后，再执行：

```sh
pnpm release:record
```

该命令会校验所有插件仍与 pending 版本一致，然后更新 `current`、追加 `history` 并清空 `pending`。最后提交账本变更并在同一提交上创建对应 Git tag。若发版中途失败，保留 pending，修复后重新运行 `pnpm release:publish`；pnpm 会跳过注册表中已有的同版本包。不要提前执行 `release:record`。

## 目录

```text
plugins/   独立发布的 DSH bundle
packages/  多插件复用的普通库
templates/ 新插件模板
scripts/   创建、安装、重启与校验脚本
docs/      开发文档
```

- [插件目录](plugins/README.md) · [新增插件](docs/creating-a-plugin.md) · [架构](docs/architecture.md) · [兼容性](docs/compatibility.md)

## License

[MIT](LICENSE)
