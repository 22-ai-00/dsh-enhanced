# 发版指南

本文是 `dsh-enhanced` 的完整发布协议。仓库中的插件和共享包采用统一版本；发布安全依赖版本账本、稳定标签、fail-closed workflow 和受保护的 npm 凭据共同成立。

## 版本账本

仓库级版本记录在 [`release-manifest.json`](../release-manifest.json)。查看当前版本、待发布版本和下一个默认版本：

```sh
pnpm release:status
```

准备下一次整体发版时，默认读取已记录版本并把补丁位加一，例如 `0.1.0 → 0.1.1`：

```sh
pnpm release:prepare
```

需要主动升级主版本或次版本时可以显式指定，而且指定值必须高于当前记录：

```sh
pnpm release:prepare 0.2.0
```

`release:prepare` 会统一修改根包、所有 `plugins/*` / `packages/*` 的 `package.json` 和运行时 `src/version.ts`，并写入 `pending`，但不会把尚未发布的版本标记为成功。

## 校验、合入与创建标签

运行 `pnpm check` 并把版本变更提交、合入 `main` 后，先同步并确认本地 `main` 就是当前 `origin/main`，再在这个提交上创建与 `pending` 完全一致的稳定版本标签：

```sh
git fetch origin +refs/heads/main:refs/remotes/origin/main
git switch main
git merge --ff-only origin/main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
pnpm release:status
git tag -a vX.Y.Z -m 'vX.Y.Z'
git push origin refs/tags/vX.Y.Z
```

推送 `v*` 标签会触发 GitHub Actions（[`.github/workflows/release.yml`](../.github/workflows/release.yml)）。workflow 检出标签本身，并在任何发布动作之前 fail closed：标签必须严格为 `vX.Y.Z`、peeled commit 必须等于当前 `origin/main` HEAD，且标签版本、`pending`、根版本、完整的 `plugins/*` / `packages/*` 包集合、各包 `package.json` 与 `src/version.ts` 必须全部一致。

通过 `pnpm check` 和上述校验后，才会从标签所指源码提交用 pnpm 发布：

```sh
pnpm release:publish
```

不要在插件目录运行 `npm publish`：npm 不会把 workspace 的 `catalog:` 依赖转换成实际版本，最终包将无法在 DSH profile 中安装。每个插件的 `prepublishOnly` 会拦截这种误操作。

## 发布后记录

发布成功后，同一 workflow 会执行：

```sh
pnpm release:record
```

该命令复用发布前的完整一致性校验，然后更新 `current`、追加 `history` 并清空 `pending`。CI 的 publish job 只有 `contents: read`，账本 job 才有 `contents: write` 且不接触 `NPM_TOKEN`、不安装依赖；它只提交 `release-manifest.json`，并且在 npm 发布前和账本推送前都会重新确认 `origin/main` 未前进。

按下述 immutable tag ruleset 部署后，release tag 会稳定指向实际发布的源码提交；workflow 自身不会创建或移动 tag，账本记录位于其后的独立提交。

## 失败重试与不可变标签

若发版中途出现暂时性失败，`pending` 会保留。请在 GitHub Actions 中 rerun 原 run，或手动运行 Release workflow 并输入同一个现有 tag；不要为重试创建或移动标签。

仓库应通过 immutable tag ruleset 禁止删除或强制移动发布标签，并用 protected release environment 限制 `NPM_TOKEN` 的可用范围和审批人。递归发布不是原子事务，重试可能发生在部分包已经发布之后，但只能继续使用同一个版本和源码提交。

## `main` 并发与 TOCTOU

workflow 的多次远端检查会缩小竞态窗口，但不能从技术上完全消除“最后一次检查结束后、npm 请求发出前 `main` 又前进”的 TOCTOU。发版期间应冻结 `main` 合入，或让所有能更新 `main` 的流程共享一个会实际阻塞写入的互斥机制。

protected environment 的审批只控制发布 job 和 secret 的使用，不能单独锁定 `main`。若 `origin/main` 已前进或版本一致性校验失败，workflow 会拒绝继续；不得移动原 tag 来绕过。

## npm 凭据

当前首次发布采用 GitHub Environment `npm-release` 中的 Secret `NPM_TOKEN`：在 npmjs.com 创建有期限、最小权限且仅覆盖所需 `@dsh-enhanced/*` 包的 **granular access token**，为该 environment 配置 required reviewers 和允许的部署分支/标签。

workflow 会先检查 secret 非空并执行 `npm whoami`，通过后才发布。包完成首次发布和 npm 侧配置后，可迁移到 trusted publishing/OIDC，以移除长期 npm 写入 token；本流程暂不启用 OIDC。
