# 安装 dsh-enhanced

当前是实验性版本；安装成功表示服务可用，不表示普通使用驱动的完整自迭代闭环已验收。进展见 [RSI 当前状态](../../docs/rsi-status.md)。以下是 macOS / Linux 新用户的默认路径。

## 准备

- 推荐安装 [Node.js 24 LTS](https://nodejs.org/en/download)（也支持 22.19 及以上的 22.x、24 以上版本），确保 `node`、`npm` 可在终端运行。安装器会检查和准备兼容的 DSH 与 pnpm。
- 默认安装需要飞书账号，以及已登录的 TraeX 或模型服务的 API Key。按向导选择机器人、发送验证码绑定本人；服务启动后再发送 `/model`，建立真实聊天会话。步骤见[连接飞书](../../plugins/lark-channel/docs/setup.md)。暂不接飞书可选下方[只用本机 Web](#只用本机-web)。
- 在信任的机器和账号上运行。新安装且没有既有权限设置时，后续新会话默认 **Full access**：可访问文件和网络，不逐次请求批准。已有权限设置和会话选择会保留。若需收紧新会话默认，安装时加 `--permission workspace-write`（人工批准）或 `--permission auto`（自动审核）。
- macOS 原生安装、新工具构建与验证无需 Docker。Linux 默认完整学习场景需要可用的 systemd 用户服务、Docker 与 bubblewrap（`bwrap`）来准备隔离构建和发布资源；缺失时可能只能完成普通助理安装，学习授权会报告未就绪。显式 `autonomy` 的 Docker 镜像要求见[维护说明](maintenance.md#实验性-web-与-autonomy)。

## 安装：默认 supervised

在**交互式终端**运行：

```sh
npm install --global @dsh-enhanced/dsh-rsi-cli
dsh-rsi install
```

默认 `supervised` 包含飞书常驻助理、持久学习、有限授权下的能力改进。安装器解析并固定兼容的 DSH Host 和同批插件版本；遇到未知 Host 版本会拒绝安装。第一次安装请按终端向导完成飞书应用、本人绑定、模型和授权步骤。`--yes` 只跳过场景菜单，**不能跳过首次本人绑定**，也不能确认已有 active/paused Automation；后者需要显式 `--ack-existing-automations`。

已有模型选择会保留；没有可用默认模型时须在引导中配置。API Key 不要写在命令参数中。授权有期限和预算，重试不会自动续期。事件来源、账号读取和主动提醒还需要单独配置与授权，见[事件来源](../../plugins/event-triggers/README.md)及[主动跟进](../../plugins/assistant-proactive/README.md)。

## 打开 Web 并验收

安装结束后先检查受管服务，再获取带 token 的 Web 地址：

```sh
dsh-rsi status
dsh-rsi web-url --profile web
dsh-rsi doctor
```

在浏览器打开 `web-url` 打印的完整地址；不要公开分享其中的 token。也可给已绑定的飞书机器人发一条本人私聊，确认实际回复。`doctor` 是诊断，不会代替一次真实对话或证明长期学习效果。服务没有运行时先看下文日志；`start` 只启动**已注册**的服务。

## 只用本机 Web

适合先体验聊天，暂不连接飞书、不启用后台学习；这一场景无需 Docker。以下路径适用于 CLI `0.1.57` 起新安装的 `0.2.1-rc.2` 私有 Host。旧 Home 或自定义缓存目录请先[查找绑定的 Host 入口](maintenance.md#查找私有-host-入口)：

```sh
dsh-rsi install --scenario core --model skip --yes
~/.local/share/dsh-enhanced/hosts/0.2.1-rc.2/node_modules/.bin/dsh --profile web
```

在浏览器打开前台命令打印的完整授权地址，按[模型指南](../../docs/models.md)配置并开始聊天。这个进程需要保持终端运行；按 Ctrl-C 停止。它没有注册常驻服务，因此不用 `dsh-rsi web-url` 或 `start`。

旧 Home、其他 Host 版本或自定义安装位置，按[查找私有 Host 入口](maintenance.md#查找私有-host-入口)读取 Home 绑定；不要用另一个全局 `dsh` 代替当前绑定。

## 常用命令

```sh
dsh-rsi status
dsh-rsi logs --profile web --lines 100
dsh-rsi restart --profile web
dsh-rsi install --help
```

只需升级全局 CLI：`dsh-rsi update`。从 CLI `0.1.57` 起，受支持的**现有 Linux 冻结 owner/cohort** 可先用 `dsh-rsi update --all --dry-run --yes` 看计划，再运行 `dsh-rsi update --all --yes`，从原绑定官方源码升级冻结插件与私有 Host，保留 owner、授权和历史；旧 CLI 须先单独自升级一次。完整条件与恢复步骤见[冻结 owner 升级](maintenance.md#现有-linux-冻结-owner-程序升级)及 [CLI 升级说明](../../packages/dsh-rsi-cli/README.md#升级与重装)。macOS 必须先停止整个 Home 并显式确认；**冻结了原生 owner/source/cohort 资源的 Mac Home 暂不支持普通原地升级。** `dsh-rsi reinstall` 会先备份、彻底清理再安装，属于破坏性重装，不是升级；先核对 [CLI 重装与 purge 说明](../../packages/dsh-rsi-cli/README.md#升级与重装) 和[维护说明](maintenance.md#彻底卸载purge)。

## 场景与参数入口

| 场景 | 适用情况 |
| --- | --- |
| 默认 `supervised` | 首次交互式安装；飞书常驻、学习与有限采用。 |
| `--scenario lark` | 飞书常驻与偏好学习，无 supervised 成长层。 |
| `--scenario core` | 本机轻量核心，无飞书渠道和后台学习。**不默认注册常驻服务**，不能直接使用上面的 `web-url` / `start` 步骤。 |
| `--scenario web` / `autonomy` | 实验性本机 owner/隔离执行；不默认注册常驻服务。见[维护说明](maintenance.md#实验性-web-与-autonomy)。 |

`core` / `web` 的前台启动方式见上方[只用本机 Web](#只用本机-web)。`dsh-rsi install --help` 显示当前安装器参数；[CLI 指南](../../packages/dsh-rsi-cli/README.md)说明 `install`、`update`、`reinstall`、`purge` 的边界。开发 checkout 的构建和本地安装命令见[维护说明](maintenance.md#本地-checkout-安装)。场景能力叠加为 `core ⊂ lark ⊂ supervised`；显式 `--lark skip` 或 `--no-service` 是有限安装，不等同于完整默认场景。

## 故障排查

- **`npm: command not found`**：先安装上面的 Node.js，重新打开终端，再运行安装命令。

- **提示需要交互式飞书引导 / 本人尚未绑定**：在真实终端运行 `dsh-rsi install`，按向导连接机器人；不要用管道或 `--yes` 绕过。
- **报 `exactly one current owner DM is required`**：先确认受管服务已启动，用本人账号给机器人私聊发送 `/model` 并完成卡片确认；保留已有绑定，再用相同的 `dsh-rsi install` 命令续跑。该步骤不要求重新授予业务权限。
- **没有 Web 地址或服务未运行**：先运行 `dsh-rsi status` 和 `dsh-rsi logs --profile web --lines 100`。仅对已注册服务使用 `dsh-rsi start --profile web`；若选了 `core` / `web` 或 `--no-service`，参照上文的私有 Host 前台命令及版本说明。
- **模型无法对话**：检查默认模型、登录或 API Key。安装时的模型设置会选择当前 profile 默认模型；参照[模型指南](../../docs/models.md)，勿把密钥贴入命令行或日志。
- **Linux 依赖构建被 pnpm 拒绝**：若报错明确指向 `koffi` 和 profile 目录，在该目录用相同 pnpm 版本运行 `pnpm approve-builds koffi`，再以同一 Home / profile 重试；不要批准全部待审脚本。更多首次安装依赖说明见[维护说明](maintenance.md#首次安装依赖审批)。
- **升级或恢复被拒绝**：保留报错与状态，查看[维护说明](maintenance.md)和 [CLI 指南](../../packages/dsh-rsi-cli/README.md)；不要通过删账本或重装掩盖未知结果。

<details>
<summary>高级维护入口（保留旧章节链接）</summary>

## 旧链接与维护入口

以下章节保留旧锚点，具体步骤已移到维护说明。

### 旧 Home 的联合 Host / 源码迁移

见[联合迁移](maintenance.md#旧-home-的联合-host--源码迁移)。

### 已 applied、未首次采用的 owner 修复

见[owner 修复](maintenance.md#已-applied未首次采用的-owner-修复)。

#### 已运行但未就绪的修复后继

见[修复后继](maintenance.md#已运行但未就绪的修复后继)。

### Checkout 内的 pre-owner 冻结源码维护

见[冻结源码维护](maintenance.md#checkout-内的-pre-owner-冻结源码维护)。

#### 未启用 owner 的旧行为镜像

见[旧行为镜像](maintenance.md#未启用-owner-的旧行为镜像)。

## 为已有 Web Session 配置有限 Goal admission

见[Goal admission](maintenance.md#为已有-web-session-配置有限-goal-admission)。

</details>

## 配置默认模型

见[模型指南](../../docs/models.md)。安装器配置模型会设置当前 profile 的默认模型；已有明确选择会保留。
