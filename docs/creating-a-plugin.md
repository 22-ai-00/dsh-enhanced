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

默认模板为原生 Tools 声明可选 Host peer 与固定 catalog 开发依赖，便于自动创建的候选在受限 `src/` 中实现工具；无工具的默认入口仍不需要 Tools 服务。工具实现与输出合同示例见生成包的 README。依赖由 Host 模板决定，自动创建候选不能修改 manifest 或 lockfile。

## 3. 实现 Cordis 插件

涉及生命周期、服务注入、配置校验、资源释放、隔离或热重载时，须先阅读 [Cordis 运行时契约](cordis-runtime-contracts.md)。入口通常导出 `name`、`version`、可选的 `inject` / `Config`，以及 `apply(ctx, config)`。生成的 `src/version.ts` 由仓库发版命令同步维护，不要在其他源码中重复硬编码包版本。遵循以下约束：

- 用 `inject` 表达所需服务，让 Cordis 决定激活时机。
- 可能因部署不同而变化的值进入同步 Standard-Schema `Config`，并在加载时校验。
- 计时器、watcher、连接、外部进程等资源必须由 Cordis effect/disposer 释放，保证热重载和关闭可靠。
- 进入模型的内容必须沿 DSH 的持久事件/上下文 seam 注册，不能只保存在不可重放的进程内状态。
- Patch 覆盖已有行时会替换整段 `config`，不是深合并；必须重述该行需要保留的键。

### 客户端 UI 与原生 Settings 槽位

带 Web 界面的插件可在 `package.json` 的 `dsh.client` 声明预构建浏览器入口（如 `owner-console` 产出 `./lib/client.js`），并在客户端通过 Host `slots` 扩展 DSH 原生界面：除 `sidebar.panellist` / `main` 外，还可注册 `settings.section`、`settings.section.icon`、`settings.general.item`、`settings.models.footer`、`settings.models.provider-card`（出现在左侧栏原生设置中），以及按包名 `key` 注册的 `plugins.bundle.config` 摘要/详情卡片（由插件自有 Typert `remote` 提供脱敏状态与受控操作，不在浏览器直接持有密钥或模型调用）。

## 4. 测试与文档

至少覆盖插件的核心行为和清理路径。插件 README 需要包含：用途、兼容性（指向 [兼容性基线](compatibility.md)）、安装、配置、使用、权限/数据边界（分别说明**文件系统、网络、子进程、凭据、浏览器与安装脚本**六项权限，未使用写“无”）和限制。随后把插件加入 [插件目录](../plugins/README.md)。

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
