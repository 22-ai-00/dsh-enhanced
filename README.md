# dsh-enhanced：RSI 智能助手插件集合

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 **RSI 智能助手插件集合**：围绕 RSI（Recursive Self-Improvement，递归自我改进）提供任务执行、独立验收、反馈学习、技能复用与有限连续改进，让助手在明确授权和预算内完成任务，并把成功经验用于后续任务。`plugins/*` 中每个目录都是可独立安装、测试和发布的 DSH bundle；`packages/*` 只存放不会自动启用的共享库。当前为实验性能力，DSH 兼容范围 `>=0.1.2-rc.1 <0.2.0`。当前进展见 [RSI 当前状态](docs/rsi-status.md)。

## 安装

支持 macOS / Linux，需要 Node.js `^22.19 || >=24`。

**方式一：npm 全局安装 `dsh-rsi`（零运行时依赖，仅用 Node 内置模块），再安装个人助理**

```sh
npm install --global @dsh-enhanced/dsh-rsi-cli
dsh-rsi install --scenario core --yes
```

**方式二：curl 一键安装（默认 `core` 场景，无需先 clone 仓库）**

```sh
curl -fsSL https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/install-npm.sh | bash
```

指定场景或其它选项时，参数跟在 `--` 之后：

```sh
curl -fsSL https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/install-npm.sh | bash -s -- --scenario lark --lark configure
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

三档部署场景能力逐级叠加：`core ⊂ lark ⊂ supervised`——`lark` 含全部 `core` 能力并加飞书常驻与偏好学习，`supervised` 再追加评测、演化与恢复。安装过程会引导配置默认模型（DeepSeek 官方或自定义 OpenAI 兼容网关），API Key 只从环境读取。实验性离线执行入口 `autonomy` 需显式指定本机固定隔离镜像，详见[安装文档](scripts/install/README.md)。

### 默认权限：Full access

新安装在用户未设置权限时默认 **Full access**（`danger-full-access + never`，reviewer 为 `none`）：工具可访问任意文件与网络、不逐次请求批准，包括凭据读取和破坏性命令，请仅在信任的运行环境使用。需要收紧可在安装时传 `--permission workspace-write`（人工批准）或 `--permission auto`（自动审核）。Full access 不会绕过显式 Policy deny、紧急停止、身份校验、预算硬门或操作系统自身权限；已有 `settings.yaml` 设置和已记录的会话档位优先，升级或重启不会改写用户已选的档位。

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
