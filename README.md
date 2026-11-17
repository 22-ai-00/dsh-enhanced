<p align="center">
  <img src="plugins/owner-console/assets/icon-128.webp" width="88" height="88" alt="文鳐 Ray icon">
</p>

<h1 align="center">dsh-enhanced · 文鳐 Ray</h1>

<p align="center">
  <img src="plugins/owner-console/assets/hero.webp" width="720" alt="文鳐 Ray logo">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dsh-enhanced/dsh-rsi-cli"><img alt="npm" src="https://img.shields.io/npm/v/@dsh-enhanced/dsh-rsi-cli?color=2f6f6f"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933">
  <img alt="status" src="https://img.shields.io/badge/status-experimental-orange">
</p>

在本机运行的个人 AI 助手，通过 **Web 控制台 / 左栏原生设置与飞书** 聊天、处理任务、积累经验与记忆，可接入模型 API 或本机 **TraeX / Antigravity (`agy`)** ACP 编程 Agent，并支持受控的主动提醒（Proactive）、突发奇想（Dreaming）与成长驱动（Growth）。基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

助手名叫 **文鳐**（英文 Ray，小名小鳐）。文鳐出自《山海经》，是鱼身有翼、夜间飞行的祥瑞之鱼；
定位是突破型、创造力型助手，口号「小鳐小鳐，游而化飞」。包名与插件 id 仍沿用 `dsh-enhanced` / `@dsh-enhanced/*`。

项目希望让助手从日常使用和纠正中持续改进。**目前是实验版，完整的自动改进闭环仍在验证中。** 已支持的能力与限制见[当前状态](docs/rsi-status.md)。

## 架构一览

<p align="center"><img src="docs/assets/architecture-overview.jpg" width="880" alt="文鳐 Ray 工作方式与自我成长架构图"></p>

- **随时连接**：通过飞书或本机网页控制台随时对话与调整设置，也可按需接入飞书日历、文件或外部通知提醒。
- **懂你办事**：自由接入常用大模型或本机 TraeX / Antigravity 编程助手，把复杂工作拆解为可持续推进的长任务，并在合适时机主动提醒。
- **自我成长闭环**：在日常使用与纠偏中记住你的习惯与经验，空闲时酝酿新技能或改进方案，先在沙箱中独立验收通过后再启用。
- **本机安全护航**：记忆与凭据默认留在本机，敏感操作与自主权限需经你明确授权，实验改动在原生沙箱中隔离验证，异常时可一键回滚。

开发者可查阅[架构说明](docs/architecture.md)与[插件目录](plugins/README.md)了解完整包清单与各自边界；共享库在 `packages/*`，不自动启用。当前主线另集成三项默认关闭、需显式开启（opt-in）的主动与通知增强（实际长期效果仍在真实宿主观测中，见[当前状态](docs/rsi-status.md)与[验收合同](docs/rsi-acceptance.md)）：

- **受控事件源与目标退订**：`event-triggers` 5 类 sensor（GitHub 仓库、飞书日历、文件、HTTPS/JSON、Webhook）可按触发器开启 `intake` 适配器桥接至 `assistant-work-items`，并在 `assistant-proactive` / Goal 终态时无轮询自动退订。
- **超限文本附件与注意力边界**：`assistant-delivery`（`attentionAttachOverCap`）配合 `assistant-web-owner` 与 `lark-channel` 支持把超长后台/owner 通知转为短摘要加 UTF-8 文本附件，同时保持目的审计与可选强制门禁（`attentionEnforce` 默认关闭）。
- **Inferred 规则预设与吻合度闭环**：`assistant-policy`（`conservative` / `balanced`）与 `assistant-proactive` 提供 opt-in `inferred` intake 规则预设；`assistant-work-items` 只读 `listIntakeEvaluationFeed` 供 `assistant-evaluation` 记录 `would-accept` 吻合度，用于密封留出重放与一次性授权内的有界调优。

## 开始使用

准备好 [Node.js 24 LTS](https://nodejs.org/en/download)、飞书账号，以及一个可用模型（已登录的 TraeX 或模型服务的 API Key）。也支持 Node.js 22.19 及以上的 22.x，以及 24 以上版本。

- **macOS**：原生运行，无需 Docker；已在 Apple Silicon Mac 验证，Intel Mac 尚未实机验收。
- **Linux**：新安装的默认学习场景采用原生隔离，需要 bubblewrap、systemd 用户服务与已委派给当前用户的 cgroup v1 资源；当前拒绝 cgroup v2。详见[安装准备](scripts/install/README.md)。

暂不接飞书、只想先体验聊天与本地控制台，可直接看[只用本机 Web](scripts/install/README.md#只用本机-web)。

### 1. 安装

在终端执行，无需下载源码：

```sh
npm install --global @dsh-enhanced/dsh-rsi-cli
dsh-rsi install
```

安装器先问一次“按推荐配置一路继续”还是“逐项自定义”：默认推荐会接入本机已登录的 **TraeX (`traex`) / Antigravity (`agy`)** 或 DeepSeek 官方模型（只在缺少 API Key 时隐藏输入一次并存入 `0600` 的 `.credentials.yaml`）；提前 `export DEEPSEEK_API_KEY=...` 并加 `--yes` 时模型步骤无需输入。引导自定义或通过 `--proactive` / `--dreaming` / `--growth` / `--with` 可按白话开关组合自主能力（`assistant-dreaming` 仅在显式授权齐备后脱离休眠）。默认 profile 名为 `web`。

新安装默认 **Full access**：助手可读写文件、访问网络、执行命令，不逐次请求批准。希望限制工作区外的写入并启用人工批准时，将第二条命令改为 `dsh-rsi install --permission workspace-write`。

### 2. 完成首次连接

1. 打开终端给出的飞书授权链接，选择或创建机器人。
2. 给机器人私聊发送终端显示的最新 `DSH-CONNECT-…` 验证码，以终端显示绑定成功为准；这一步不会收到聊天回复。
3. 终端提示“最后一步”时，私聊发送 `/model`，选择模型并确认；安装器检测到这条私聊后自动继续，无需重新运行。之后只有已绑定的你可以操作和授权。

如果等待超时或终端提示缺少主人私聊会话，先完成第 3 步，再按[安装排障](scripts/install/README.md)继续。飞书消息接入与文档、邮件等业务权限是分开的，详见[飞书接入](plugins/lark-channel/docs/setup.md)。

### 3. 打开 Web 与控制台

```sh
dsh-rsi open --profile web
```

`dsh-rsi open` 会读取受管服务地址（或前台拉起轻量场景）并在桌面环境自动打开浏览器（含 `--wait`、`--no-browser`）。进入后可在左侧栏打开 **文鳐** 面板或 **Settings → 文鳐助手**（`owner-console`）：使用 **自主能力一键开启向导**（基于已激活 owner 路由生成三权分立授权或安全暂停/停用）、**版本与自助升级卡片**（版本检查、预演及本地二次确认升级；受控 Linux systemd 会提示带外终端升级命令），以及查看飞书连接、一键检测/切换 `traex` 与 `agy`，并管理 Proactive、Dreaming、WorkItems、Memory Learning 与 Growth 等自主模块。不打开 UI 时也可通过 `dsh-web-owner-setup --autonomy-setup` 在 CLI 完成 Web-owner 自主授权；仅需打印受管地址时改用 `dsh-rsi web-url --profile web`。地址包含登录令牌，请勿公开分享；模型配置见[添加与切换模型](docs/models.md)。

## 日常使用

直接在聊天里说“以后叫你柳神”“记住我喜欢简短回复”或“把这段内容保存到 Wiki”。明确要求的普通记忆和 Wiki 更新会保存并反馈结果，无需再点一次批准；助手自行提出的修改、删除或敏感记忆，以及你要求先确认的操作，仍会询问。

| 想做什么 | 命令 |
| --- | --- |
| 打开 Web 与文鳐控制台 | `dsh-rsi open --profile web` |
| 检查或执行自助升级 | `dsh-rsi upgrade --check` / `dsh-rsi upgrade --dry-run` / `dsh-rsi upgrade --yes` |
| 一键配置 Web-owner 自主授权 | `dsh-web-owner-setup --profile web --autonomy-setup --enable-memory-learning --enable-dreaming --enable-growth --dry-run` |
| 查看运行状态（含 JSON） | `dsh-rsi status [--json]` |
| 只读体检（含 `traex`/`agy` 与前提） | `dsh-rsi doctor [--profile web] [--json]` |
| 仅获取已运行 Web 地址 | `dsh-rsi web-url --profile web` |
| 查看最近日志 | `dsh-rsi logs --profile web --lines 100` |
| 重启服务 | `dsh-rsi restart --profile web` |

浏览器关闭后，默认安装的服务仍会在后台运行。日常常用命令：`dsh-rsi open --profile web`（直接打开本地 Web 与「文鳐」控制台）、`dsh-rsi upgrade --dry-run`（预演用户向就地升级与自动回滚保护）、`dsh-rsi status --json`（查看状态与 `.dsh-rsi-host.json` 绑定）及 `dsh-rsi doctor --json`（只读诊断 `traex`/`agy` 登录、配置与运行前提）。注意安装或向导授权成功不代表真实宿主上的长期普通任务效果已通过验收（见[当前状态](docs/rsi-status.md)）。只升级 CLI 命令本身用 `dsh-rsi update`；Docker 迁移边界与 macOS 限制见 [CLI 帮助](packages/dsh-rsi-cli/README.md#升级与重装) 和[维护说明](scripts/install/maintenance.md)。`reinstall` 会删除旧配置和历史后重新安装，请勿当作普通升级使用。

## 按需阅读

| 需要帮助 | 文档 |
| --- | --- |
| 首次安装、只用本机 Web、安装失败 | [安装指南](scripts/install/README.md) |
| 添加自己的模型、切换模型 | [模型配置](docs/models.md) |
| 飞书绑定、权限、没有回复 | [飞书接入](plugins/lark-channel/docs/setup.md) |
| 升级、重装、卸载 | [命令参考](packages/dsh-rsi-cli/README.md) |
| 已支持什么、还有哪些限制 | [当前状态](docs/rsi-status.md) |
| 选择额外插件 | [插件目录](plugins/README.md) |

## 参与开发

开发需要 Node.js（版本范围同上）和 pnpm 11.7.0。本地和远端只保留 `dev`、`main`；开发、版本准备、提交与推送使用 `dev`，仅在发布验证通过后合入 `main`。克隆仓库后：

```sh
pnpm install
pnpm check
```

`pnpm check` 包含校验、lint、构建、类型检查、测试和打包检查。新增插件见[开发指南](docs/creating-a-plugin.md)，包边界见[架构说明](docs/architecture.md)，发布见[发版指南](docs/releasing.md)。更多资料见[文档索引](docs/README.md)。

[MIT License](LICENSE)
