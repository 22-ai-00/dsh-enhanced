# dsh-enhanced：RSI 智能助手插件集合

`dsh-enhanced` 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 **RSI 智能助手插件集合**，围绕 RSI（Recursive Self-Improvement，递归自我改进）提供任务执行、独立验收、反馈学习、技能复用和有限连续改进能力，让助手在明确授权和预算内完成任务，并将成功经验用于后续任务。

插件覆盖目标管理、主动行动、记忆、消息交付、隔离执行、评测与恢复，并通过 ACP 和模型 provider 接入编码工具及现有模型线路。`plugins/*` 中的每个目录都是可独立安装、测试和发布的 DSH bundle；`packages/*` 只存放不会自动启用的共享库。当前基本 RSI 首版基于 DSH `0.1.2-rc.1`，面向 Linux 上受监督的单机 profile，仍属实验性能力。

基本 RSI 首版支持同一任务族的有限连续改进：独立确认失败后自主修复，生成技能候选，经过独立比较和后续实际任务验证后晋升，再继续下一轮，并把结果送回原会话。模板渲染任务已取得连续两轮的真实 TraeX 组合验收证据。使用入口见[有限 repair admission](plugins/assistant-web-owner/README.md#有限-repair-admission)，证据和限制见[两轮验收记录](docs/evidence/basic-rsi-two-round-2026-09-12.json)。中途修复进程崩溃仍报告 `unknown`，不自动重放；完整 RSI 规划继续保留。

## 快速开始

要求 Node.js 22.19+（或 24+）、pnpm 11.7.0 和精确的 DSH `0.1.2-rc.1`。首版不兼容 DSH `0.1.5` 的会话持久化接口；已有其它版本时请为本套件使用独立的匹配 CLI，不要覆盖日常环境。安装已发布插件：

```sh
dsh plugin --profile web add @dsh-enhanced/<plugin-name>
dsh --profile web --dump-config
dsh web
```

本地开发时把包名换成插件目录：

```sh
pnpm install
pnpm build
dsh plugin --profile web add ./plugins/hello
```

使用 DSH 源码版 CLI 时，把 `dsh` 换成 DSH 仓库根目录下的 `pnpm dsh`。

## 快速搭建个人助理

默认安装到 `web` profile，并选择安全的本机核心场景：

```sh
./scripts/install/install-local.sh
```

三档部署场景能力逐级叠加：`core ⊂ lark ⊂ supervised`——`lark` 含全部 `core` 能力并加飞书常驻与偏好学习，`supervised` 再在 `lark` 之上追加评测、演化与恢复。安装过程中会引导配置一个可解析的默认模型（DeepSeek 官方或自定义 OpenAI 兼容网关）；API Key 只从环境读取，命中后写入 `$DSH_HOME/.credentials.yaml`（`0600`）。

修改源码后可重建并纯重启当前服务；命令不会更新配置：

```sh
./scripts/install/restart.sh
```

需要试用有限离线执行时，可显式使用 `--scenario autonomy --isolation-image sha256:<本机固定镜像ID>`。安装器会实际探测 Docker 并为本机 Web owner 配置有次数、期限和累计时长的隔离授权；参数与前置条件见[安装文档](scripts/install/README.md)。这是基本 RSI 首版的实验入口；有限修复使用下述 repair admission，外部动作需要单独配置范围明确的授权和凭据，完整自治规划继续推进。

希望通过飞书日常对话自动学习语言等有界偏好时，使用普通 Lark 场景即可；它不要求 Evaluation、Heartbeat、Health 或 Recovery：

```sh
./scripts/install/install-local.sh --scenario lark --lark configure
```

安装后可直接用 `/learning status|explain|export|pause|resume|rollback <key> confirm|forget confirm` 管理当前 workspace + preset 的学习；这些命令由 Host 本地处理，不进入模型。`explain` 只显示闭集 key/value、状态、版本和证据计数；`export` 返回版本化、稳定排序的 current-scope T1 JSON，两者都不回显历史对话。导出不写文件，也不包含 workspace、owner/lineage、generation、session、event、Inbox/Outbox、cursor、幂等键或 exposure 等内部标识；`rollback` 只撤回当前 owner lineage 的一个 exact active T1 key。持续偏好可用“以后用中文回答”等闭集表达，一次性的“这次请简短回答”只作用于当前请求，不会被固化。

需要跨任务评测、演化提案、恢复账本和受限主动巡检时，再显式启用分级自治成长模式（命令名为兼容旧版仍保留 `supervised-growth`）：

```sh
./scripts/install/install-local.sh --mode supervised-growth --lark configure
```

不便先 clone 仓库时，可一键远程安装。远程引导器会从固定发布 tag 下载并校验 `common.sh`；请求 `--operation upgrade|uninstall` 时，还会从同一个 tag 下载 `lifecycle-config.mjs` 和 `lifecycle-profile.mjs`，三个资产全部通过各自内嵌的 SHA-256 后才允许任何安装代码执行。旧 `v0.1.24` 的 lifecycle helper 摘要为全零，因此它不支持远程 upgrade/uninstall；新发布由 `release:prepare` 为三个实际资产生成独立摘要。DSH host 固定到首版已验证的 `0.1.2-rc.1`，不同版本在修改 profile 前拒绝，不自动保留较新但不兼容的 Host。插件安装会先把 `@dsh-enhanced/personal-assistant@latest` 解析为精确版本，再以该版本安装整套选中的 `@dsh-enhanced/*` bundle，避免跨包 `latest` 混装：

```sh
curl -fsSL https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/install-npm.sh | bash
```

需要指定场景或其它选项时，把参数跟在 `--` 之后：

```sh
curl -fsSL https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/install-npm.sh | bash -s -- --scenario lark --lark configure
```

引导器 `install-npm.sh` 虽从 `main` 拉取，但实际安装逻辑及按操作需要的生命周期 helper 从同一个固定 `vX.Y.Z` 发布标签拉取并全部通过内嵌 SHA-256 校验后才执行，不从 mutable `main` 执行代码。完整场景选项、凭据存储和平台差异见[安装脚本文档](scripts/install)；飞书授权、模型选择、进度展示与常驻服务见 [`lark-channel` 文档](plugins/lark-channel)。

个人助理默认采用 `workspace-write + ask`；可显式传 `--permission auto`，让确定性低风险动作和隔离 reviewer 认可的局部可逆动作自动继续，而网络、凭据、破坏性操作、提权和复杂 shell 仍交人工。需要最低打扰时可传 `--permission danger-full-access --confirm-dangerous-full-access`，此时 reviewer 为 `none`，工具风险分类被整体跳过（网络、凭据读取、破坏性命令和提权都不再询问），只应在完全信任当前 workspace 时使用。注意两套名称不同：安装器 `--permission` 取 `preserve|workspace-write|auto|danger-full-access`，而运行时在飞书里用 `/permission ask|auto|full confirm` 切换（`full` 需二次确认）。工具可达性和执行权限是两层控制；即使选择 `danger-full-access`，显式 Policy deny、紧急停止、身份校验和预算硬门仍然生效。完整边界以各插件 README 为准。

## 能力概览

| 类别 | 入口 |
| --- | --- |
| ACP 与编码模型 | [`acp`](plugins/acp)、[`coding-subscription-provider`](plugins/coding-subscription-provider)、[`traex-acp-provider`](plugins/traex-acp-provider) |
| 个人助理核心 | [`personal-assistant`](plugins/personal-assistant) 组合 Policy、Memory、Wiki 与 Automations |
| 消息与凭据 | [`assistant-delivery`](plugins/assistant-delivery)、[`lark-channel`](plugins/lark-channel)、[`credentials-keychain`](plugins/credentials-keychain) |
| 主动成长 | Evaluation、Preference Learning、Growth Experiments、Recovery、受限 adoption analyst、Memory/Wiki Bridge 与可自动回滚的 Evolution |
| 运维与扩展 | Health、Plugin Control Plane 与最小示例 `hello` |

全部包、用途和安装命令见[插件目录](plugins/README.md)。新增、重命名、弃用或移除插件时，同时更新该目录。

## 开发与检查

创建插件前先读[新增插件指南](docs/creating-a-plugin.md)；调整包边界或 Host/Web 双面插件时读[架构说明](docs/architecture.md)；修改 DSH/Cordis 依赖或使用新上游 API 时读[兼容性基线](docs/compatibility.md)。

```sh
pnpm install
pnpm create:plugin my-plugin
pnpm check
```

`pnpm check` 会依次执行 manifest 校验、零警告 lint、类型检查、测试、构建，以及所有插件和共享包的 dry-run pack。涉及 package 边界或 `files` 时，还应检查打包文件列表；生成的 `lib/`、coverage、tarball 和缓存不提交。

每个插件必须保持可独立发布，并包含 `lib/`、`cordis.patch.yml`、`README.md` 和 `LICENSE`。部署相关值进入校验过的 `Config`，外部资源使用 Cordis effect/disposer 管理；权限与外部 authority 必须写入插件 README。

## 发版入口

仓库使用 [`release-manifest.json`](release-manifest.json) 记录统一版本：

```sh
pnpm release:status
pnpm release:prepare
pnpm check
```

版本变更合入 `main` 后，只能在与当前 `origin/main` 完全一致、且与 `pending` 一致的提交上创建稳定标签 `vX.Y.Z`。推送标签触发 [Release workflow](.github/workflows/release.yml)。不要在插件目录直接运行 `npm publish`，不要为重试创建或移动标签。

准备版本、校验 main/tag、发布、失败重试、immutable tag ruleset、竞态控制和 npm 凭据的完整协议见[发版指南](docs/releasing.md)。

## 文档与目录

- [文档索引](docs/README.md)
- [插件目录](plugins/README.md)
- [仓库架构](docs/architecture.md)
- [兼容性基线](docs/compatibility.md)
- [个人助理路线图](docs/dsh-personal-assistant-self-built-plugin-roadmap.md)

```text
plugins/   独立发布的 DSH bundle
packages/  多插件复用的普通库
templates/ 新插件模板
scripts/   创建、安装、重启与校验脚本
docs/      开发指南与历史研究
```

## License

[MIT](LICENSE)
