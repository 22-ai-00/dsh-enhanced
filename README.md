# dsh-enhanced：在使用中自迭代的智能工具

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，目标是让助手从日常任务的失败、纠正和重复需求中形成技能/工具/插件改进，经独立验证后在既有授权和预算内采用，并通过后续任务观察收益、发现退化和回滚。用户只需正常使用，无需逐次编排改进。

**当前仍为实验性实现：基础组件和局部链路已有验证，普通使用驱动的完整自迭代闭环尚未验收。** 当前阻塞与下一步只维护在 [RSI 当前状态](docs/rsi-status.md)。

`plugins/*` 是可独立安装、测试和发布的 DSH bundle，`packages/*` 是不会自动启用的共享库。`0.1.49` 起，新安装解析 DSH 官方 npm `latest` 并固定已验证的精确 Host 版本；当前兼容版本为 `0.2.0-rc.2`，仍是预发布版。后续 `latest` 超出已验证范围时安装器会拒绝安装，等待适配。

## 安装

支持 macOS / Linux，需要 Node.js `^22.19 || >=24`。

**方式一：Linux 上全局安装 `dsh-rsi`（零运行时依赖，仅用 Node 内置模块），在交互式终端完成飞书引导并安装自迭代助理**

```sh
npm install --global @dsh-enhanced/dsh-rsi-cli
dsh-rsi install
```

**方式二：curl 引导安装（Linux，默认开启学习；无需先 clone 仓库）**

```sh
installer_directory="$(mktemp -d)"
curl -fsSLo "$installer_directory/install-npm.sh" https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/install-npm.sh &&
  bash "$installer_directory/install-npm.sh" --scenario supervised
install_status=$?
rm -rf -- "$installer_directory"
test "$install_status" -eq 0
```

首次启用 `supervised` 须在终端完成飞书 onboarding。只需无后台学习的轻量 `core` 时可以使用管道执行：

```sh
curl -fsSL https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/install-npm.sh | bash -s -- --scenario core
```

引导器虽从 `main` 拉取，但实际安装逻辑与生命周期 helper 全部从**固定发布 tag** 下载、通过内嵌 SHA-256 自校验后才执行，不从 mutable `main` 运行任何安装代码。完整场景选项、凭据存储与平台差异见[安装脚本文档](scripts/install/README.md)。

**方式三：本地 checkout 开发**

```sh
pnpm install
pnpm build
./scripts/install/install-local.sh
```

安装后最常用的三条 `dsh-rsi` 命令（完整命令、升级与卸载见 [`packages/dsh-rsi-cli/README.md`](packages/dsh-rsi-cli/README.md)）：

```sh
dsh-rsi status                         # 只读：各 profile、host 版本、受管服务与凭据状态
dsh-rsi web-url --profile web          # 受管服务当前带 token 的 Web 授权 URL（不关闭认证）
dsh-rsi logs --profile web --lines 100 # 查看受管服务日志尾部
dsh-rsi restart --profile web          # 改配置后重启（只动运行状态，不动服务定义）
```

升级（`update` / `update --all`）、干净重装（`reinstall`）、彻底卸载（`purge`）、崩溃救机脚本与全部安装器参数分别见 [`packages/dsh-rsi-cli/README.md`](packages/dsh-rsi-cli/README.md) 和[安装脚本文档](scripts/install/README.md)。

`0.1.49` 起，Linux 的 `dsh-rsi install/reinstall` 和 shell 默认安装 `supervised`，组合持久记忆学习、普通任务成长、独立验收与有限采用。首次安装须在终端完成飞书身份授权并配置可用模型；已有模型选择保留，必要路径和有限预算由安装器生成。未配对的全新 Home 使用 `--yes` 或管道运行时会停止并提示完成 onboarding。显式 `--scenario core` 可安装无渠道、无后台学习的本机核心；`--mode standard`、`--lark skip` 或 `--no-service` 保留有限场景。非 Linux 不支持完整 RSI，可显式选用 `core` 等轻量场景。

三档部署场景能力逐级叠加：`core ⊂ lark ⊂ supervised`——`lark` 含全部 `core` 能力并加飞书常驻与偏好学习，`supervised` 再追加评测、演化与恢复。安装时检测到本机 `traex` 或 `trae-cli` 会自动安装并启用 TraeX 插件，复用本机登录；已登录且没有显式默认模型时，为当前 profile 配置 TraeX 默认模型。已有模型选择保持不变。其它模型可在安装引导中配置，API Key 只从环境读取。实验性离线执行入口 `autonomy` 需显式指定本机固定隔离镜像，详见[安装文档](scripts/install/README.md)。

### 默认权限：Full access

新安装在用户未设置权限时默认 **Full access**（`danger-full-access + never`，reviewer 为 `none`）：工具可访问任意文件与网络、不逐次请求批准，包括凭据读取和破坏性命令，请仅在信任的运行环境使用。需要收紧可在安装时传 `--permission workspace-write`（人工批准）或 `--permission auto`（自动审核）。Full access 不会绕过显式 Policy deny、紧急停止、身份校验、预算硬门或操作系统自身权限；已有 `settings.yaml` 设置和已记录的会话档位优先，升级或重启不会改写用户已选的档位。

首次绑定飞书 owner 也默认开放已安装的 Agent 工具能力；重复安装保留现有授权和显式限制。飞书向导默认接入官方 `lark-cli` 与动态业务技能，在安装阶段申请用户业务授权；实际可用范围仍由飞书应用和用户批准的权限决定。

## 能力概览

| 类别 | 入口 |
| --- | --- |
| ACP 与编码模型 | [`acp`](plugins/acp)、[`coding-subscription-provider`](plugins/coding-subscription-provider)、[`traex-acp-provider`](plugins/traex-acp-provider) |
| 个人助理核心 | [`personal-assistant`](plugins/personal-assistant) 组合 Policy、Memory、Wiki 与 Automations |
| 消息与凭据 | [`assistant-delivery`](plugins/assistant-delivery)、[`lark-channel`](plugins/lark-channel)、[`credentials-keychain`](plugins/credentials-keychain) |
| 主动成长 | Evaluation、Preference Learning、Growth Experiments、Recovery、受限 adoption analyst、Memory/Wiki Bridge 与可自动回滚的 Evolution |
| 运维与扩展 | Health、Plugin Control Plane 与最小示例 `hello` |

全部包、用途和安装命令见[插件目录](plugins/README.md)。

## 开发与检查

需要 Node.js 22.19+（或 24+）与 pnpm 11.7.0。新增插件前读[新增插件指南](docs/creating-a-plugin.md)；调整包边界读[架构说明](docs/architecture.md)；变更 DSH/Cordis 依赖读[兼容性基线](docs/compatibility.md)。

```sh
pnpm install
pnpm create:plugin my-plugin
pnpm check
```

`pnpm check` 覆盖 manifest 校验、零警告 lint、类型检查、测试、构建与全部插件 dry-run pack。每个插件必须可独立发布，并包含 `lib/`、`cordis.patch.yml`、`README.md` 和 `LICENSE`；单独试用某个插件可用 `dsh plugin --profile web add @dsh-enhanced/<plugin-name>`。

## 发版入口

统一版本记录在 [`release-manifest.json`](release-manifest.json)：`pnpm release:status` → `pnpm release:prepare` → `pnpm check`，合入 `main` 后在与 `origin/main`、`pending` 一致的提交上打稳定标签 `vX.Y.Z`，推送标签触发 [Release workflow](.github/workflows/release.yml)。完整协议见[发版指南](docs/releasing.md)。

## 文档与目录

- [文档索引](docs/README.md)
- [`dsh-rsi` 完整命令参考](packages/dsh-rsi-cli/README.md)
- [安装器完整选项与故障排查](scripts/install/README.md)
- [插件目录](plugins/README.md) ・ [仓库架构](docs/architecture.md) ・ [兼容性基线](docs/compatibility.md) ・ [RSI 当前状态](docs/rsi-status.md)

```text
plugins/   独立发布的 DSH bundle
packages/  多插件复用的普通库
templates/ 新插件模板
scripts/   创建、安装、重启与校验脚本
docs/      开发指南与历史研究
```

## License

[MIT](LICENSE)
