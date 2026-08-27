# 仓库架构

## 为什么采用多包仓库

DSH 当前把可安装插件定义为 profile bundle：包的 `dsh.bundle.patch` 指向一个 patch 层，用户通过 `dsh plugin --profile <name> add <package>` 安装后，该层进入 profile 的有序 bundle 列表。由此，本仓库以“一个用户可启用能力对应一个 npm 包”为发布边界。

这一边界带来三个结果：

- 插件可以独立安装、回滚和审计；当前仓库级 release 会统一推进所有包的版本。
- 每个插件保持独立 npm 包边界，但一次整体发版仍会校验并发布全部包；中途失败按下文的同 tag 重试协议恢复。
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

发布由 tag 驱动的 CI 自动完成。维护者先用根目录的 `release:prepare` 统一更新仓库版本和 `release-manifest.json` 的 `pending`，验证后合入 `main`；发布标签必须严格为 `vX.Y.Z`，必须从当时的 `origin/main` HEAD 创建，而且版本必须等于 `pending`。GitHub Actions（`.github/workflows/release.yml`）检出这个精确 tag，而不是移动中的分支，并在发布前要求 tag peeled commit 仍等于当前 `origin/main` HEAD。它还会验证 current/history/pending 的账本顺序、根版本、pending 包集合与全部 `plugins/*` / `packages/*` 目录一一对应，且每个包的 manifest 和运行时版本都一致；`src/version.ts` 只允许单一稳定字面量导出。任一条件不满足都会 fail closed。

发布阶段必须使用 pnpm，让 workspace `catalog:` 依赖在上传前转换为实际版本；插件的 `prepublishOnly` 会拒绝直接使用 npm 发布。当前新包首次发布以 GitHub Environment `npm-release` 中的 `NPM_TOKEN` 作为 bootstrap 凭据，该 secret 应是有期限、最小包范围的 granular access token；environment 必须配置 required reviewers 和允许的部署分支/标签。workflow 在发布前验证 token 非空并执行 `npm whoami`。新包完成首次发布和 npm 侧配置后，可以迁移到 trusted publishing/OIDC，但当前流程不擅自启用 OIDC。publish job 只有仓库只读权限，持有写权限的 record job 不安装依赖且拿不到 npm token；本地 record 脚本执行步骤也不注入仓库写 token。

`release:publish` 紧前会再次检查 tag、`origin/main` 和 tracked index/worktree；未跟踪构建产物不影响发布，但任何 staged/unstaged tracked 改动都会拒绝。发布成功后，`release:record` 复用同一套版本与包集合校验，只更新 `release-manifest.json`：提升 `current`、追加 `history` 并清空 `pending`。workflow 只提交这个账本文件，并在推送前再次确认 `origin/main` 没有从发布源码提交前进。按下述 immutable tag ruleset 部署后，tag 会稳定指向发布源码，而账本记录位于其后的独立提交；workflow 自身不创建也不移动 tag。

这些远端复核只能缩小 TOCTOU 窗口，不能证明检查与 npm registry 写入之间具有原子性。仓库必须为 `v*` 配置 immutable tag ruleset（禁止删除和 force-update），发布期间冻结 `main` 合入，或让所有 main 写入者共享一个会实际阻塞写入的互斥机制；protected environment 的审批只能约束 job/secret 使用，不能单独锁定分支。递归 npm 发布也不是原子事务；暂时性失败应通过 Actions rerun，或用 `workflow_dispatch` 输入同一个现有 tag 重试，不能创建替代 tag 或改变 pending/source。整体发版统一推进版本，同时仍保留每个包作为独立 npm 安装、回滚和审计边界。
