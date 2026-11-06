# dsh-enhanced

在本机运行的个人 AI 助手，通过 **Web 或飞书**聊天、处理任务、积累记忆，也可接入你自己的模型。基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

助手名叫 **文鳐**（英文 Ray，小名小鳐）。文鳐出自《山海经》，是鱼身有翼、夜间飞行的祥瑞之鱼；
定位是突破型、创造力型助手，口号「小鳐小鳐，游而化飞」。包名与插件 id 仍沿用 `dsh-enhanced` / `@dsh-enhanced/*`。

项目希望让助手从日常使用和纠正中持续改进。**目前是实验版，完整的自动改进闭环仍在验证中。** 已支持的能力与限制见[当前状态](docs/rsi-status.md)。

## 开始使用

准备好 [Node.js 24 LTS](https://nodejs.org/en/download)、飞书账号，以及一个可用模型（已登录的 TraeX 或模型服务的 API Key）。也支持 Node.js 22.19 及以上的 22.x，以及 24 以上版本。

- **macOS**：原生运行，无需 Docker；已在 Apple Silicon Mac 验证，Intel Mac 尚未实机验收。
- **Linux**：新安装的默认学习场景采用原生隔离，需要 bubblewrap、systemd 用户服务与已委派给当前用户的 cgroup v1 资源；当前拒绝 cgroup v2，旧部署不会自动迁移。详见[安装准备](scripts/install/README.md)。

暂不接飞书、只想先体验聊天，可直接看[只用本机 Web](scripts/install/README.md#只用本机-web)。

### 1. 安装

在终端执行，无需下载源码：

```sh
npm install --global @dsh-enhanced/dsh-rsi-cli
dsh-rsi install
```

安装器先问一次是否“按推荐配置一路继续”，直接回车即可：默认使用 DeepSeek 官方模型，只在缺少 API Key 时隐藏输入一次（Key 存入 `0600` 的 `.credentials.yaml`，不出现在命令行和输出中）。提前 `export DEEPSEEK_API_KEY=...` 并加 `--yes` 时，模型步骤无需任何输入。检测到本机 TraeX 时会复用其登录；已有模型选择会保留。默认使用名为 `web` 的配置，首次使用保持默认即可。

新安装默认 **Full access**：助手可读写文件、访问网络、执行命令，不逐次请求批准。希望限制工作区外的写入并启用人工批准时，将第二条命令改为 `dsh-rsi install --permission workspace-write`。

### 2. 完成首次连接

1. 打开终端给出的飞书授权链接，选择或创建机器人。
2. 给机器人私聊发送终端显示的最新 `DSH-CONNECT-…` 验证码，以终端显示绑定成功为准；这一步不会收到聊天回复。
3. 终端提示“最后一步”时，私聊发送 `/model`，选择模型并确认；安装器检测到这条私聊后自动继续，无需重新运行。之后只有已绑定的你可以操作和授权。

如果等待超时或终端提示缺少主人私聊会话，先完成第 3 步，再按[安装排障](scripts/install/README.md)继续。飞书消息接入与文档、邮件等业务权限是分开的，详见[飞书接入](plugins/lark-channel/docs/setup.md)。

### 3. 打开 Web

```sh
dsh-rsi web-url --profile web
```

在浏览器打开输出的地址，即可使用同一套本机服务。地址包含登录令牌，请勿公开分享。模型配置见[添加与切换模型](docs/models.md)。

## 日常使用

直接在聊天里说“以后叫你柳神”“记住我喜欢简短回复”或“把这段内容保存到 Wiki”。明确要求的普通记忆和 Wiki 更新会保存并反馈结果，无需再点一次批准；助手自行提出的修改、删除或敏感记忆，以及你要求先确认的操作，仍会询问。

| 想做什么 | 命令 |
| --- | --- |
| 查看运行状态 | `dsh-rsi status` |
| 打开 Web | `dsh-rsi web-url --profile web` |
| 查看最近日志 | `dsh-rsi logs --profile web --lines 100` |
| 重启服务 | `dsh-rsi restart --profile web` |

浏览器关闭后，默认安装的服务仍会在后台运行。只升级命令本身用 `dsh-rsi update`。对于 Linux 冻结 owner/cohort，`dsh-rsi update --all --yes` 仅接纳原安装为 Docker 后端且满足严格前提的 Home；切到 native 时，创建/修订审查、修订回归与采用业务记录必须为空。原生 owner 的原地程序升级和非空创建历史迁移尚不支持；尚未建立 owner 的 Home 有独立维护入口。旧 CLI 须先单独运行一次 `dsh-rsi update`。普通安装的升级路径、恢复和 macOS 限制见 [CLI 帮助](packages/dsh-rsi-cli/README.md#升级与重装)。`reinstall` 会删除旧配置和历史后重新安装，请勿当作普通升级使用。

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
