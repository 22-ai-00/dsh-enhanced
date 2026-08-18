# 新增插件

## 1. 生成骨架

插件名使用小写 kebab-case：

```sh
pnpm create:plugin my-plugin
```

命令从 `templates/plugin` 生成 `plugins/my-plugin`，复制根许可证，并提示后续步骤。不要手工复制现有插件；生成器是公共结构的单一来源。

## 2. 定义插件边界

一个插件包应对应一种用户可独立启用、升级和移除的能力。仅供多个插件 import 的代码放到 `packages/*`，且不声明 `dsh.bundle`。

在 `package.json` 中检查：

- `name` 是最终发布名；默认是 `@dsh-enhanced/<name>`。
- `dsh.bundle.patch` 固定指向 `./cordis.patch.yml`。
- `files` 包含 `lib`、patch、README 和许可证。
- DSH 宿主提供的 Cordis/service 包同时出现在 peer 与开发依赖中。
- 插件自己运行时必须携带的库放在 dependencies 中。

## 3. 实现 Cordis 插件

入口通常导出 `name`、`version`、可选的 `inject` / `Config`，以及 `apply(ctx, config)`。生成的 `src/version.ts` 由仓库发版命令同步维护，不要在其他源码中重复硬编码包版本。遵循以下约束：

- 用 `inject` 表达所需服务，让 Cordis 决定激活时机。
- 可能因部署不同而变化的值进入 Schemastery `Config`，并在加载时校验。
- 计时器、watcher、连接、外部进程等资源必须由 Cordis effect/disposer 释放，保证热重载和关闭可靠。
- 进入模型的内容必须沿 DSH 的持久事件/上下文 seam 注册，不能只保存在不可重放的进程内状态。
- Patch 覆盖已有行时会替换整段 `config`，不是深合并；必须重述该行需要保留的键。

## 4. 测试与文档

至少覆盖插件的核心行为和清理路径。插件 README 需要包含：用途、兼容性、安装、配置、使用、权限/数据边界和限制。随后把插件加入 [插件目录](../plugins/README.md)。

## 5. 验证

```sh
pnpm check
```

本地接入 DSH：

```sh
pnpm build
dsh plugin --profile web add ./plugins/my-plugin
dsh --profile web --dump-config
```

确认 dump 中出现插件层和 Cordis 行，再启动实际 profile 做冒烟测试。首次公开发布前还要检查 `pnpm --dir plugins/my-plugin pack --dry-run` 的文件清单。

## 6. 兼容性变化

DSH 仍处于预发布阶段。使用新的 service、event、tool 或 client slot 前，以当前目标版本源码为准；变更依赖范围时同步更新 [兼容性基线](compatibility.md) 和受影响插件 README。
