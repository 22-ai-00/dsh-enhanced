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

`personal-assistant` bundle 自带本地 Web/direct `foreground` capability grant，直接安装后即可使用 profile 中**已经挂载**的技能、工具和插件动作。安装器默认 `--agent-tools allow`，会把该规则物化为可管理的 profile override，并为 Delivery 当前/兼容的精确外部身份补齐独立规则；除了动态 `tool: *`，它们也覆盖 memory、wiki、automation 等插件工具内部的二次 Policy 动作。规则不会安装或挂载新能力，也不会放宽 `background` 任务；显式 deny、紧急停止、sandbox、reviewer 和预算硬门仍独立生效。需要更严格隔离时用 `--agent-tools disable` 撤销受管 grant，或用 `--agent-tools preserve` 保留当前配置。

owner 可在飞书中发送 `/permissions` 打开三档权限卡片（不支持卡片时显示等价文字），也可用 `/permission ask`、`/permission auto` 或二次确认的 `/permission full confirm` 切换。工具可达性与这三档执行权限是两层独立控制：`full` 关闭逐次审批并放开 sandbox，但仍受显式 Policy deny、紧急停止、身份校验和预算硬门约束。

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

默认配置面向本机单用户：没有既有用户设置时选择 `danger-full-access`，并允许 `foreground` Agent 访问 profile 已挂载的能力；后台 scheduler 仍默认关闭，`background` 与外部身份仍默认拒绝。该默认值权限很高，请按 [`personal-assistant` 文档](plugins/personal-assistant)和四个核心插件的 README，在不需要完全控制时切回 `workspace-write`/`auto`，或用显式 Policy deny、精确身份与预算进一步收窄。

需要通过飞书聊天时，再追加 Delivery、系统 Keychain 和 Lark adapter：

```sh
dsh plugin --profile web add ./plugins/assistant-delivery
dsh plugin --profile web add ./plugins/credentials-keychain
dsh plugin --profile web add ./plugins/lark-channel
pnpm --filter @dsh-enhanced/lark-channel run onboard --profile web --create-app
```

最后一个命令使用飞书官方设备授权流程，输出确认链接和终端二维码。确认页允许选择已有应用或创建新应用；选择已有应用时只展示并添加本 channel 所需的最小权限、消息事件和卡片回调，不删除原有权限。若要锁定更新某个已有应用（例如补齐 `card.action.trigger`），可追加 `--app-id cli_...`。App Secret 自动写入 macOS Keychain、Linux Secret Service 或当前用户的 Windows DPAPI 文件，不进入命令参数或 profile。向导还会通过一次 owner 私聊完成精确身份绑定、启用 Web profile，并通过 launchd、systemd user service 或 Windows Task Scheduler 保持常驻；Windows 路径为 best-effort。详细步骤见 [`lark-channel` 文档](plugins/lark-channel)。

连接后，合法的新消息持久入队会收到 `Get` reaction，普通 Agent 任务会显示不含原始 CoT/工具敏感数据的执行进度，最终回复发送成功后原消息再收到 `DONE`。同一私聊或群聊稳定 lane 会持续 resume 同一个 DSH session；`/status` 可核对代次与上下文，`/stop` 只停止当前任务并保留上下文，`/new` 才原子切换到空白的下一代 session。私聊发送 `/model`，机器人会返回带“分组、模型、effort”三个下拉框的选择卡片；点击确认后，选择按聊天持久化，下一条消息生效且保留上下文。`/model use <provider/model>` 仍是文字后备。即使原默认模型 route 已失效，`/model` 也不依赖 LLM 生成，可以直接完成恢复。

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

`release:prepare` 会统一修改根包、所有 `plugins/*` / `packages/*` 的 `package.json` 和运行时 `src/version.ts`，并写入 `pending`，但不会把尚未发布的版本标记为成功。运行 `pnpm check` 并把版本变更提交、合入 `main` 后，先同步并确认本地 `main` 就是当前 `origin/main`，再在这个提交上创建与 `pending` 完全一致的稳定版本标签：

```sh
git fetch origin +refs/heads/main:refs/remotes/origin/main
git switch main
git merge --ff-only origin/main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
pnpm release:status
git tag vX.Y.Z
git push origin refs/tags/vX.Y.Z
```

推送 `v*` 标签会触发 GitHub Actions（[`.github/workflows/release.yml`](.github/workflows/release.yml)）。workflow 检出标签本身，并在任何发布动作之前 fail closed：标签必须严格为 `vX.Y.Z`、peeled commit 必须等于当前 `origin/main` HEAD，且标签版本、`pending`、根版本、完整的 `plugins/*` / `packages/*` 包集合、各包 `package.json` 与 `src/version.ts` 必须全部一致。通过 `pnpm check` 和上述校验后，才会从标签所指源码提交用 pnpm 发布：

```sh
pnpm release:publish
```

不要在插件目录运行 `npm publish`：npm 不会把 workspace 的 `catalog:` 依赖转换成实际版本，最终包将无法在 DSH profile 中安装。每个插件的 `prepublishOnly` 会拦截这种误操作。发布成功后，同一 workflow 会执行：

```sh
pnpm release:record
```

该命令复用发布前的完整一致性校验，然后更新 `current`、追加 `history` 并清空 `pending`。CI 的 publish job 只有 `contents: read`，账本 job 才有 `contents: write` 且不接触 `NPM_TOKEN`、不安装依赖；它只提交 `release-manifest.json`，并且在 npm 发布前和账本推送前都会重新确认 `origin/main` 未前进。按下述 immutable tag ruleset 部署后，release tag 会稳定指向实际发布的源码提交；workflow 自身不会创建或移动 tag，账本记录位于其后的独立提交。

若发版中途出现暂时性失败，`pending` 会保留。请在 GitHub Actions 中 rerun 原 run，或手动运行 Release workflow 并输入同一个现有 tag；不要为重试创建或移动标签。仓库应通过 immutable tag ruleset 禁止删除或强制移动发布标签，并用 protected release environment 限制 `NPM_TOKEN` 的可用范围和审批人。递归发布不是原子事务，重试可能发生在部分包已经发布之后，但只能继续使用同一个版本和源码提交。

workflow 的多次远端检查会缩小竞态窗口，但不能从技术上完全消除“最后一次检查结束后、npm 请求发出前 `main` 又前进”的 TOCTOU。发版期间应冻结 `main` 合入，或让所有能更新 `main` 的流程共享一个会实际阻塞写入的互斥机制。protected environment 的审批只控制发布 job 和 secret 的使用，不能单独锁定 `main`。若 `origin/main` 已前进或版本一致性校验失败，workflow 会拒绝继续；不得移动原 tag 来绕过。

当前首次发布采用 GitHub Environment `npm-release` 中的 Secret `NPM_TOKEN`：在 npmjs.com 创建有期限、最小权限且仅覆盖所需 `@dsh-enhanced/*` 包的 **granular access token**，为该 environment 配置 required reviewers 和允许的部署分支/标签。workflow 会先检查 secret 非空并执行 `npm whoami`，通过后才发布。包完成首次发布和 npm 侧配置后，可迁移到 trusted publishing/OIDC，以移除长期 npm 写入 token；本流程暂不启用 OIDC。

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
