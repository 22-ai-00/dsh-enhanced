# 贡献指南

## 开发流程

1. 运行 `pnpm install` 安装锁定依赖。
2. 用 `pnpm create:plugin <kebab-case-name>` 创建插件，或在现有插件内工作。
3. 为行为增加测试，并同步更新插件自己的 `README.md`。
4. 运行 `pnpm check`。
5. 提交聚焦的变更；一个提交不要混入无关插件的重构。

新增插件前请完整阅读 [新增插件指南](docs/creating-a-plugin.md)。涉及仓库边界、共享库或 Web 双端插件时，先阅读 [架构说明](docs/architecture.md)。

## Pull Request 要求

- 说明用户价值、启用方式和测试证据。
- 列出新增的文件系统、网络、进程、凭据或浏览器权限。
- 对 DSH/Cordis 的兼容范围有变化时更新 [兼容性基线](docs/compatibility.md)。
- 发布包必须包含构建后的 `lib/`、`cordis.patch.yml`、README 和许可证。
