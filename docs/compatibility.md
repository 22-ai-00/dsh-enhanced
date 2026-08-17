# 兼容性基线

仓库初始化时对齐以下上游源码状态：

- DeepSeek Harness：`0.1.0-rc.5`
- `@deepseek-ai/cordis`：`4.0.1`
- Node.js：`^22.19.0 || >=24.0.0`
- pnpm：`11.7.0`

DSH 尚处于预发布阶段，插件机制可能发生破坏性变化。`pnpm-workspace.yaml` 的 catalog 和各插件 `peerDependencies` 是实际依赖范围的源；本页记录人工验证过的 DSH 基线。

升级基线时：

1. 阅读上游插件打包、profile、Cordis 生命周期和相关 subsystem 文档。
2. 更新 catalog 与所有受影响的 peer 范围。
3. 运行 `pnpm check`。
4. 用目标 DSH 的 `--dump-config` 验证每个 bundle，再做真实 profile 冒烟。
5. 在本页记录新的已验证版本，并在插件 README 中说明任何功能差异。
