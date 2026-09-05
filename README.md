# dsh-enhanced

`dsh-enhanced` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的社区增强插件仓库。`plugins/*` 中的每个目录都是可独立安装、测试和发布的 DSH bundle；`packages/*` 只存放不会自动启用的共享库。

仓库提供两类能力：面向编码场景的 ACP/模型 provider，以及基于 DSH `0.1.2-rc.1` 自研的实验性个人助理套件。个人助理适合先在受监督的单机 profile 中使用。

## 快速开始

要求 Node.js 22.19+（或 24+）和 pnpm 11.7.0。安装已发布插件：

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

希望通过飞书日常对话自动学习语言等有界偏好时，使用普通 Lark 场景即可；它不要求 Evaluation、Heartbeat、Health 或 Recovery：

```sh
./scripts/install/install-local.sh --scenario lark --lark configure
```

安装后可直接用 `/learning status|explain|export|pause|resume|rollback <key> confirm|forget confirm` 管理当前 workspace + preset 的学习；这些命令由 Host 本地处理，不进入模型。`explain` 只显示闭集 key/value、状态、版本和证据计数；`export` 返回版本化、稳定排序的 current-scope T1 JSON，两者都不回显历史对话。导出不写文件，也不包含 workspace、owner/lineage、generation、session、event、Inbox/Outbox、cursor、幂等键或 exposure 等内部标识；`rollback` 只撤回当前 owner lineage 的一个 exact active T1 key。持续偏好可用“以后用中文回答”等闭集表达，一次性的“这次请简短回答”只作用于当前请求，不会被固化。

需要跨任务评测、演化提案、恢复账本和受限主动巡检时，再显式启用分级自治成长模式（命令名为兼容旧版仍保留 `supervised-growth`）：

```sh
./scripts/install/install-local.sh --mode supervised-growth --lark configure
```

不便先 clone 仓库时，可一键远程安装（始终拉取 npm `latest` 的 `@dsh-enhanced/*` 插件与 DSH host；已安装的更新 host 不会被降级）。安装器会按发布账本中的已验证 host 范围进行检查，显式指定范围外版本时必须同时传 `--ack-unverified-host`：

```sh
curl -fsSL https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/install-npm.sh | bash
```

需要指定场景或其它选项时，把参数跟在 `--` 之后：

```sh
curl -fsSL https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/install-npm.sh | bash -s -- --scenario lark --lark configure
```

引导器 `install-npm.sh` 虽从 `main` 拉取，但实际安装逻辑（`common.sh`）从一个固定 `vX.Y.Z` 发布标签拉取并经内嵌 SHA-256 校验后才执行，不从 mutable `main` 执行代码。完整场景选项、凭据存储和平台差异见[安装脚本文档](scripts/install)；飞书授权、模型选择、进度展示与常驻服务见 [`lark-channel` 文档](plugins/lark-channel)。

个人助理默认采用 `workspace-write + ask`；可显式传 `--permission auto`，让确定性低风险动作和隔离 reviewer 认可的局部可逆动作自动继续，而网络、凭据、破坏性操作、提权和复杂 shell 仍交人工。工具可达性和执行权限是两层控制；即使选择 `full`，显式 Policy deny、紧急停止、身份校验和预算硬门仍然生效。完整边界以各插件 README 为准。

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
