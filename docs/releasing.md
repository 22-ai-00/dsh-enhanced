# 发版指南

本文是 `dsh-ray` 的完整发布协议。仓库中的插件和共享包采用统一版本；发布安全依赖版本账本、稳定标签、fail-closed workflow 和受保护的 GitHub OIDC（npm Trusted Publishing）发布环境共同成立。

## 发布与效果验收

实验性版本可以先发布供用户安装，再通过真实普通任务持续验证学习、后续复用、质量、成本与回归收益。完整普通使用闭环尚未验收，不再单独阻止实验性 npm 发布；发行说明必须保留这一边界，不能把工程测试或服务就绪说成自迭代收益证明。

发布前仍须通过仓库完整检查、精确发布源码的跨平台 CI、安装器版本与摘要一致性检查，以及已实现能力的安装和运行就绪验证。CI 读取根目录 `.node-version` 并按各自 runner 规格显式固定 Vitest 并发上限（共享 lane 为 `2`，CI 专用慢包 runner 为 `3`，见 `.github/workflows/ci.yml`）；Release workflow（`.github/workflows/release.yml`）复用精确同一提交的跨平台 `ci.yml` 全量通过门禁（含 `verify` 汇总及 Linux/macOS/Windows 各 lane），并在发布节点立即前置校验 tag/账本一致性与 GitHub OIDC 发布上下文，随后重跑静态、构建、类型与打包校验（`validate`、`lint`、`build`、`typecheck:built`、`pack:check`）。身份校验、有限预算、独立验收与回滚保护不因实验性发布而放宽；已知的安装失败或安全问题不能留给用户探索。

Linux 原生隔离测试另使用固定的 Node `22.23.2`：CI 的 Linux 测试 job 先将该版本安装到只读 namespace 可见的 `/usr/bin/node`，再按 `.node-version` 切回工作区 Node，并分别校验两个版本。不能用工作区 Node 替代隔离运行时基线。跨平台测试继续验证可移植的源码准备契约；非 Linux Host 验证 Linux 专用执行入口在派发前拒绝。

开发与发布准备（包括版本变更和失败修复）都在 `dev` 提交并推送；独立复核和完整检查通过后，才在发布时合入 `main`。本地与远端只保留 `dev`、`main`，不新建 feature 或 release 分支。标签仍只从下述验证过的精确 `origin/main` 提交创建。

## 版本账本

仓库级版本记录在 [`release-manifest.json`](../release-manifest.json)。查看当前版本、待发布版本和下一个默认版本：

```sh
pnpm release:status
```

在 `dev` 准备下一次整体发版时，当 `release-manifest.json` 中 `pending` 为 `null`（如 `current: "0.1.83"`、`pending: null` 准备替代发布 `0.1.84`），默认读取已记录版本并把补丁位加一，例如 `0.1.83 → 0.1.84`：

```sh
pnpm release:prepare
```

若 `pending` 仍非 `null`（上一次待发布版本未完成记录），则须使用 `pnpm release:supersede <version>` 显式替换；需要主动升级主版本或次版本时也可向 `release:prepare` 显式指定更高版本：

```sh
pnpm release:prepare 0.2.0
```

`release:prepare` 会统一修改根包、所有 `plugins/*` / `packages/*` 的 `package.json` 和运行时 `src/version.ts`，并写入 `pending`，但不会把尚未发布的版本标记为成功。它还会把同一发布标签、精确 Host 版本及已验证范围，以及六个远端安装资产（`common.sh`、`lifecycle-config.mjs`、`lifecycle-profile.mjs`、`host-lifecycle.mjs`、`host-profile-update.mjs`、`host-rsi-update.mjs`）的独立 SHA-256 同步写入 `install-npm.sh`；`node scripts/release-version.mjs verify-tag vX.Y.Z` 和 `release:record` 会重新计算并逐项核验这些值。

## 校验、合入与创建标签

运行 `pnpm check` 并把版本变更提交、合入 `main` 后，确认精确发布提交的 Linux、macOS 和 Windows CI 已全部通过，再同步并确认本地 `main` 就是当前 `origin/main`，在这个提交上创建与 `pending` 完全一致的稳定版本标签：

```sh
git fetch origin +refs/heads/main:refs/remotes/origin/main
git switch main
git merge --ff-only origin/main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
pnpm release:status
git tag -a vX.Y.Z -m 'vX.Y.Z'
git push origin refs/tags/vX.Y.Z
```

推送 `v*` 标签会触发 GitHub Actions（[`.github/workflows/release.yml`](../.github/workflows/release.yml)）。workflow 检出标签本身，并在任何发布动作之前 fail closed：标签必须严格为 `vX.Y.Z`、peeled commit 必须等于当前 `origin/main` HEAD，首先在数秒内校验标签版本、`pending`、根版本、完整的 `plugins/*` / `packages/*` 包集合、各包 `package.json`、`src/version.ts` 一致性与纯 GitHub OIDC 上下文（`ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN`，不依赖静态 npm token）；接着校验该精确提交 `RELEASE_SOURCE_COMMIT` 的全平台 `.github/workflows/ci.yml`（含 `verify` 及全部 Linux/macOS/Windows lane）已全部 `success`，再执行 `pnpm install --frozen-lockfile` 与 `validate`、`lint`、`build`、`typecheck:built`、`pack:check` 产出干净的发布产物与打包清单。

确认上述 CI 门禁与发布产物构建/打包校验全部通过后，才会从标签所指源码提交用 pnpm 发布：

```sh
pnpm release:publish
```

不要在插件目录运行 `npm publish`：npm 不会把 workspace 的 `catalog:` 依赖转换成实际版本，最终包将无法在 DSH profile 中安装。每个插件的 `prepublishOnly` 会拦截这种误操作。

## 发布后记录

发布成功后，同一 workflow 会执行：

```sh
pnpm release:record
```

该命令复用发布前的完整一致性校验，然后更新 `current`、追加 `history` 并清空 `pending`。CI 的 `publish` job 只有 `contents: read`（加上 `actions: read` 与 `id-token: write`）；在 `publish` 与 `record` 之间，[`.github/workflows/release.yml`](../.github/workflows/release.yml) 内置了无特权的 `verify-npm` 门禁 job（`needs: publish`，且 `record` 声明 `needs: [publish, verify-npm]`），它会检出精确 tag 提交、校验 `HEAD` 等于 `needs.publish.outputs.source_commit`，并执行 `node ./scripts/verify-npm-release.mjs --tag "${RELEASE_TAG}" --verify-tarball` 对全部 40 个可发布包逐一校验 npm packument 版本、`dist-tags.latest` 与 `dist.tarball` 可达性（`HEAD`/`GET` 带指数退避重试）；只有全部 40 个包读回通过后，`record` job（`contents: write`，不具备 `id-token: write` 或 `npm-release` 发布环境权限、不安装依赖，仅提交 `release-manifest.json` 并在发布前与推送前重检 `origin/main` 未前进）才会更新账本并推送 `main`。

按下述 immutable tag ruleset 部署后，release tag 会稳定指向实际发布的源码提交；workflow 自身不会创建或移动 tag，账本记录位于其后的独立提交。

虽然 `verify-npm` 已在记账前强制完成全量 40 包 npm 读回与 tarball 探测，发布后仍须从公开 tag 下载安装资产并核对摘要；若任何发布步骤中途失败或出现部分发布，不得宣称发布完成，也不可移动/删除旧 tag 重试，须按下方失败协议修复后以更高版本替代（如用 `0.1.84` 取代不完整的 `0.1.83`）。在隔离的临时 Home 验证公开包安装与配置加载，不修改现有生产 Home；完整 supervised 安装仍须完成真实身份配对及必要的模型、预算和构建环境设置，轻量安装测试不替代该授权流程。发布完成后，最终用户可通过 CLI（`dsh-ray upgrade [--check|--dry-run|--yes]`、`dsh-ray enable|disable`、`dsh-ray version [--json]`）或 Web（`owner-console`）/飞书（`lark-channel`）`/version` 与自然语言指令查看版本与只读自迭代统计，或触发 `upgradeAssistantAndRecover` 完成全量核心/插件升级（默认开启 `allowNonEmptyHistoryMigration: true`）、`doctor` 健康检查与受管服务重启恢复。最后将 `main` 的发布账本记录同步回 `dev`。

涉及 Linux supervised 安装或依赖布局的修改，还须在安装器实际生成的 hoisted profile 上验证私有授权运行时准备，覆盖支持的 Node 22 和当前开发 Node。使用完整 supervised 包集合、真实安装元数据与锁文件，通过安装器的 Host peer 解析入口执行 `--prepare-authorities`，或在同一解析上下文中分别调用运行时与资源准备函数；核验独立程序可运行、重复准备不更换内容或身份。此检查不绑定 owner、不签发任务授权、不启动 Host，也不替代所选隔离后端的完整源码构建及 supervised 就绪验收。仅通过 core 激活或模拟 setup 返回值，不能证明该准备步骤可用。

## 失败重试与不可变标签

若发版中途出现暂时性失败，`pending` 会保留。请在 GitHub Actions 中 rerun 原 run，或手动运行 Release workflow 并输入同一个现有 tag；不要为重试创建或移动标签。

若失败原因必须修改源码，旧标签就不能再满足“标签等于当前 `origin/main`”的发布门。先确认旧 workflow 已停止，并检查该版本是否发生部分发布；在 `dev` 修复并完成验证，再合入 `main`；合入前用显式更高版本替换 `pending`，例如：

```sh
pnpm release:supersede 0.1.9
```

该命令只推进待发布版本，不会把失败版本写入成功历史。旧标签必须保留且不得移动；修复和新版本变更通过完整校验、合入 `main` 后，再从新的 `origin/main` HEAD 创建新标签。如果旧 run 已部分发布，旧版本应视为不完整版本，不再重试，并确保替代版本包含完整包集合。

仓库应通过 immutable tag ruleset 禁止删除或强制移动发布标签，并用 protected release environment（`npm-release`）限制 OIDC 发布权限（`id-token: write`）的部署分支/标签策略与审批人。递归发布不是原子事务，重试可能发生在部分包已经发布之后，但只能继续使用同一个版本和源码提交。

## `main` 并发与 TOCTOU

workflow 的多次远端检查会缩小竞态窗口，但不能从技术上完全消除“最后一次检查结束后、npm 请求发出前 `main` 又前进”的 TOCTOU。发版期间应冻结 `main` 合入，或让所有能更新 `main` 的流程共享一个会实际阻塞写入的互斥机制。

protected environment 的审批只控制发布 job 与 OIDC 凭据签发的触发，不能单独锁定 `main`。若 `origin/main` 已前进或版本一致性校验失败，workflow 会拒绝继续；不得移动原 tag 来绕过。

远端 `install-npm.sh` 本身仍从 mutable `main` 获取；其内嵌摘要把随后执行的六个资产绑定到不可变发布 tag，但不能认证最外层引导器本身。仓库管理员权限和 immutable tag ruleset 因此仍属于发布信任根。

## npm Trusted Publishing（GitHub OIDC）

正式发布完全使用 **npm Trusted Publishing（GitHub OIDC）**，`.github/workflows/release.yml` 中**不包含任何静态 `NPM_TOKEN` 或 `secrets.NPM_TOKEN`**：

1. **工具链与自动 Provenance**：发布 runner 使用 `ubuntu-24.04`、`.node-version` 指定的 Node `>=24.9.0`（当前 `24.9.0`，内置 npm `>=11.5.1`）以及 `pnpm@11.7.0`。`pnpm release:publish` 原生支持在 GitHub Actions 中通过 `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN` 向 npm 交换短期 OIDC 发布令牌，并为公开仓库 `22-ai-00/dsh-ray`（各包 `package.json` 需声明 `repository.url = "git+https://github.com/22-ai-00/dsh-ray.git"` 与 `publishConfig.access = "public"`）自动附加 npm provenance 证明。
2. **Workflow 权限与凭据隔离**：`publish` job 绑定受保护的 GitHub Environment `npm-release`（配置 required reviewers 与仅允许 `main` / `v*` 的部署策略）并声明 `permissions: { contents: read, actions: read, id-token: write }`。`Verify npm credentials` 步骤会在缺少 OIDC 环境变量或存在 `NODE_AUTH_TOKEN` 时立即 fail closed；`Publish packages` 步骤在执行 `pnpm release:publish` 前会显式 `unset NODE_AUTH_TOKEN` 并剥离 `${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}` / `$HOME/.npmrc` 中的 `_authToken=` 行，避免回退到静态 token。
3. **新包首次创建与逐包绑定（40 个 `@dsh-ray/*` 作用域包）**：
   - npm Trusted Publishing 必须在包**已存在于 npm registry 后**按**单个包**维度配置，OIDC 无法直接完成全新包名的首次创建发布（未注册包名在 OIDC token 交换阶段会返回 HTTP 404）。
   - 全部 40 个发布包均位于 `@dsh-ray/*` 作用域下（36 个 `plugins/*` 与 4 个 `packages/*`，包含 `packages/cli` 的 `@dsh-ray/cli`，仍暴露 `"bin": { "dsh-ray": "./bin/dsh-ray.js" }`），在首次 OIDC 发布前需由维护者先完成初始 seed 包创建，再为全部 40 个包逐一绑定 Trusted Publisher。
   - 每个包的 Trusted Publisher（GitHub Actions）需绑定为：Organization/User `22-ai-00`、Repository `dsh-ray`、Workflow filename `release.yml`、Environment name `npm-release`（可在 npmjs.com 包设置页完成；若本地使用 CLI 批量绑定，可执行 `npx -y npm@11 trust github "$pkg" --repo 22-ai-00/dsh-ray --file release.yml --env npm-release --allow-publish --yes`，Node `24.9.0` 内置的 `npm@11.6.0` 尚不含 `npm trust` 子命令，而 `npm@latest` 12.x 要求更高 Node）。
4. **2 天绑定过期规则**：在 npmjs.com 上为包新建 Trusted Publisher 绑定后，若 **2 天内**未成功完成一次 OIDC 发布，该绑定会自动过期失效；请在完成逐包绑定后及时触发 `release.yml` 完成发布验证。
