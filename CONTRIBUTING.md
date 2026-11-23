# 贡献指南

## 开发流程

开发需要 Node.js（`.node-version` 锁定 `24.9.0`，`package.json` 声明 `>=24.9.0`）和 `pnpm@11.7.0`；详细运行时与平台基线见[兼容性基线](docs/compatibility.md)，Linux 独立副本验证前提见[Linux 验证环境](docs/linux-validation.md)。本地和远端只保留 `dev` 与 `main` 分支：日常开发、提交和推送使用 `dev`，不新建 feature 或 release 分支，仅在发布验证通过后合入 `main`。

1. 运行 `pnpm install` 安装锁定依赖。
2. 用 `pnpm create:plugin <kebab-case-name>` 创建插件，或在现有插件/共享包内工作。
3. 为行为增加测试，并同步更新插件自己的 `README.md`（以及 `plugins/README.md` 或 `packages/README.md`）。
4. 运行 `pnpm check`。
5. 提交聚焦的变更；一个提交不要混入无关插件的重构。

新增插件前请完整阅读 [新增插件指南](docs/creating-a-plugin.md)。涉及仓库边界、共享库（见[共享包目录](packages/README.md)）或 Web 双端插件时，先阅读 [架构说明](docs/architecture.md)；涉及插件生命周期、注入、配置、资源归属或重载时，必读 [Cordis 运行时契约](docs/cordis-runtime-contracts.md)。

## Pull Request 要求

- 说明用户价值、启用方式和测试证据。
- 列出新增的文件系统、网络、子进程、凭据、浏览器或安装脚本权限（安全披露要求见[安全政策](SECURITY.md)）。
- 对 DSH/Cordis 的兼容范围有变化时更新 [兼容性基线](docs/compatibility.md)。
- 插件发布包必须包含构建后的 `lib/`、`cordis.patch.yml`、`README.md` 和 `LICENSE`；共享包不包含 `cordis.patch.yml`。
