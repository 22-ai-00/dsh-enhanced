# dsh-enhanced

`dsh-enhanced` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的多插件仓库。`plugins/*` 中的每个目录都是可独立安装、测试和发布的 DSH bundle。

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

## 插件一览

每个插件都是独立发布的 npm 包，只安装需要的能力即可：

| 插件 | 简要说明 | 快速安装 |
|---|---|---|
| [`@dsh-enhanced/acp`](plugins/acp) | 将 DSH 暴露为 ACP stdio agent，让支持 ACP 的编辑器使用 DSH 的 Agent、模型、工具、权限与会话能力。 | `dsh plugin --profile acp add @dsh-enhanced/acp` |
| [`@dsh-enhanced/coding-subscription-provider`](plugins/coding-subscription-provider) | 接入本机已登录的 Codex、Claude Code、Cursor Agent 和 Grok Build；自动发现模型，并为 Codex、Claude、Grok 展示 reasoning effort。 | `dsh plugin --profile web add @dsh-enhanced/coding-subscription-provider` |
| [`@dsh-enhanced/traex-acp-provider`](plugins/traex-acp-provider) | 通过 ACP 调用本机已登录的 TraeX，并动态展示其模型与逐模型 reasoning effort。 | `dsh plugin --profile web add @dsh-enhanced/traex-acp-provider` |
| [`@dsh-enhanced/hello`](plugins/hello) | 最小示例插件，用于验证 bundle 安装、Cordis patch、构建与日志链路。 | `dsh plugin --profile web add @dsh-enhanced/hello` |

安装 Web provider 后运行 `dsh --profile web --dump-config` 检查最终配置，再执行 `dsh web`。Coding Subscription Provider 需要先安装并登录准备使用的官方 CLI；TraeX provider 还需要在配置中显式设置 `enabled: true`。各插件的完整配置、权限边界和排错方法见表内链接。

ACP 插件使用独立的 `acp` profile。安装后运行 `dsh --profile acp --dump-config`，再在 ACP 客户端中把 `dsh --profile acp` 配置为 stdio agent。原生 Windows 支持目前为实验性，详见插件文档。

新增、重命名、弃用或移除插件时，应同时维护本表和 [`plugins/README.md`](plugins/README.md) 的完整目录。

## 开发

要求 Node.js 22.19+（或 24+）和 pnpm 11.7.0。

```sh
pnpm install
pnpm create:plugin my-plugin
pnpm check
```

## 目录

```text
plugins/   独立发布的 DSH bundle
packages/  多插件复用的普通库
templates/ 新插件模板
scripts/   创建与校验脚本
docs/      开发文档
```

- [插件目录](plugins/README.md) · [新增插件](docs/creating-a-plugin.md) · [架构](docs/architecture.md) · [兼容性](docs/compatibility.md)

## License

[MIT](LICENSE)
