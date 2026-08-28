# @dsh-enhanced/plugin-control-plane

用于按能力发现、审批、隔离验证和原子启用 DSH bundle 的控制面。它把“Agent 发现缺口”与“修改正在运行的 profile / 源码”严格分开。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/plugin-control-plane
dsh --profile web --dump-config
```

## 配置与使用

首次使用无需先下载目录：若默认路径 `~/.dsh/plugin-control/catalog.json` 不存在，运行时会使用包内的首方、只读、完整性固定目录（coding provider、health、heartbeat、event triggers、Memory/Wiki bridge、Lark 与 supervised evolution）。该目录固定到已发布的 npm `0.1.3` tarball，不是浮动的 latest 查询，也不会由 Agent 更新。

owner 可在默认路径放置自己的 catalog；它会完全取代首方目录。每条记录都需要精确 npm 版本、`sha512-...` 完整性、精确 DSH baseline、能力标签和权限摘要。`requires` 可声明必须一同启用的顶层 bundle，例如 Lark channel 的 Delivery 与 credential bundle：

```json
{
  "schemaVersion": 1,
  "entries": [{
    "id": "memory-wiki-bridge",
    "capabilities": ["memory knowledge promotion"],
    "package": "@dsh-enhanced/memory-wiki-bridge",
    "version": "0.1.3",
    "integrity": "sha512-REPLACE_WITH_NPM_DIST_INTEGRITY",
    "requires": [],
    "authorities": ["filesystem: DSH home only"],
    "dshBaseline": "0.1.0-rc.8"
  }]
}
```

Agent 可调用 `plugin_discover` 自动查找候选项，或用 `plugin_activation_plan` 生成**只读待审批计划**。两个工具都不会下载、安装、修改或重启任何东西。

owner 在审阅完整 package/version/integrity/authority 后，才可使用不向 Agent 注册的本地 CLI：

```sh
dsh-plugin-control discover --capability 'knowledge promotion'
dsh-plugin-control approve --plan ~/.dsh/plugin-control/plans/plugin-....json --approved-by owner@example
dsh-plugin-control activate --plan ~/.dsh/plugin-control/plans/plugin-....json --dsh-home ~/.dsh
```

`activate` 先核对当前 DSH 精确版本，再复制 profile 到隔离 staging profile，安装候选和全部 `requires` 的精确版本、核对 pnpm lock 中每个完整性、执行 `dsh --dump-config`，然后通过同一父目录内的 rename 原子替换目标 profile。替换后的最终组合校验失败会自动恢复原 profile；成功后仍由 owner 使用 `scripts/install/restart.sh` 重启常驻服务。

新建或修改插件绝不在生产 checkout 中进行：

```sh
dsh-plugin-control scaffold --owner-approved --repository ../dsh-enhanced-feature-worktree --name my-plugin
dsh-plugin-control verify-worktree --owner-approved --repository ../dsh-enhanced-feature-worktree
```

两者只接受 linked Git worktree，创建要求干净 worktree；验证运行 `git diff --check` 与 `pnpm check`。之后仍需正常 code review、PR、发布和上述启用流程。

## 权限与数据

- 运行时 plugin 只读取 owner 配置的本地 catalog，并在 `statePath` 写入受限的待审批 plan；无网络、凭据、浏览器或子进程权限。
- 本地 CLI 的 `activate` 才会调用 `dsh`、复制/rename profile；它需要 owner 明确执行，且不暴露为 Agent tool。CLI 不读取或输出凭据。
- `scaffold` / `verify-worktree` 只在 owner 传入 `--owner-approved` 的 linked Git worktree 中运行 pnpm/git；它们不会改动主 checkout、生产 profile 或已发布包。

## 兼容性

See the repository [compatibility baseline](../../docs/compatibility.md).
