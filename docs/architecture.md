# 仓库架构

## 为什么采用多包仓库

DSH 当前把可安装插件定义为 profile bundle：包的 `dsh.bundle.patch` 指向一个 patch 层，用户通过 `dsh plugin --profile <name> add <package>` 安装后，该层进入 profile 的有序 bundle 列表。由此，本仓库以“一个用户可启用能力对应一个 npm 包”为发布边界。

这一边界带来三个结果：

- 插件可以独立版本化、安装、回滚和审计。
- 一个插件失败不会要求发布所有其他插件。
- 共享实现可以进入 `packages/*`，但共享库没有 `dsh.bundle`，不会意外激活。

## 层次

```text
DSH profile
  -> 已安装 bundle 的 cordis.patch.yml
    -> plugins/<name> 的 Host/Cordis 入口
      -> 可选 packages/<name> 共享库
      -> 可选 Web client 入口
```

`plugins/*` 是产品层，`packages/*` 是复用层，`templates/plugin` 和 `scripts/*` 是工程层。根脚本只负责编排，不包含插件业务逻辑。

## 插件包最小契约

每个插件至少包含：

```text
plugins/<name>/
  src/index.ts
  src/version.ts
  tests/index.spec.ts
  package.json
  cordis.patch.yml
  tsconfig.json
  tsconfig.build.json
  README.md
  LICENSE
```

`package.json` 的 `dsh.bundle.patch`、`files` 和 `exports` 必须覆盖 patch 与构建产物。`cordis.patch.yml` 使用稳定 `id`，并通过发布后的包名挂载入口；加载顺序由 Cordis service injection 决定，而不是 YAML 行序。

## Host 与 Web 双端插件

普通插件只有 Node/Host 入口。需要改动 Web UI 时，一个包通常同时拥有 Host 与 browser 两半：Host 提供数据/RPC，browser 入口通过 `dsh.client` 声明 `platform: web` 和依赖边，并从 `exports["./client"]` 发布已构建的客户端文件。

双端模板尚未固化，因为它依赖具体 UI slot 和 Host contract。创建这类插件时应先在当前 DSH 源码中确认 client module manifest、目标 slot/service 及构建产物，再把可复用形态提炼成新模板，而不是扩张基础 Host 模板。

## 分发

本地开发可以把 `plugins/<name>` 目录链接进 profile。正式分发以独立 npm 包或预构建 tarball 为准。Git package 安装以仓库根为包边界，不适合作为多插件子目录的默认分发方式。

仓库不由 CI 自动发布到 npm；维护者使用根目录的 `release:prepare`、npm 发布和 `release:record` 三阶段流程。`release-manifest.json` 记录当前成功版本、待发布版本、每个插件包版本和历史记录。整体发版默认递增已记录版本的补丁位，同时仍保留每个插件作为独立 npm 包安装、回滚和审计的边界。
