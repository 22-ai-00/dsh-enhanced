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

首个实用插件是原生优先的 ACP bridge：

```sh
dsh plugin --profile acp add @dsh-enhanced/acp
dsh --profile acp --dump-config
```

然后在 ACP 客户端中把 `dsh --profile acp` 配置为 stdio agent。客户端可在首轮前选择 DSH 的 `standard`、`code`、`minimal`、`cordis` Agent 模式，并使用 DSH 提供的模型、工具、权限和会话能力；原生 Windows 会隐藏依赖 `/bin/bash` 的 `minimal`。Windows 支持目前为实验性，尚未经过真实用户环境和主流 ACP 客户端的充分测试，遇到问题欢迎提交 issue 或 pull request。详见 [`@dsh-enhanced/acp`](plugins/acp)。

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
