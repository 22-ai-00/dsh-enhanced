# 仓库架构

涉及插件生命周期、注入、配置、资源归属或重载时，须同时遵守 [Cordis runtime contracts](cordis-runtime-contracts.md)。

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

普通插件只有 Node/Host 入口。需要改动 Web UI 时，一个包通常同时拥有 Host 与 browser 两半：Host 提供数据/Typert RPC，browser 入口通过 `dsh.client` 声明 `platform: web` 和依赖边，并从 `exports["./client"]` 发布预构建客户端产物（如 `owner-console` 产出 `./lib/client.js`，注册 `sidebar.panellist` / `main` 与 DSH 原生左栏设置槽位 `settings.section`、`settings.section.icon`、`settings.general.item`、`settings.models.footer`、`settings.models.provider-card` 及 `plugins.bundle.config`）。

双端模板尚未固化，因为它依赖具体 UI slot 和 Host contract。创建这类插件时应先在当前 DSH `0.2.2-rc.5` 源码中确认 client module manifest、目标 slot/service 及构建产物，再把可复用形态提炼成新模板，而不是扩张基础 Host 模板。

Web owner 适配通过内存 `EntryTree` 将宿主 Session Controller 的 client 元数据与 owner-scoped 的 Host 包装绑定，只在浏览器加载同源原生 client，不复制旧版 Session 协议；子树由 Cordis effect 释放，不回写 profile 或 `node_modules`。

此外，跨插件纯契约库放在 `packages/*`（如 `assistant-growth-contract`、`task-acceptance-contract`、`llm-route-capabilities`、`cli`（`@dsh-ray/cli`）），而 `assistant-dreaming`、`assistant-association` 等需要感知兄弟能力但不必强制装入的插件通过**可选 `peerDependencies`** 接入，保证独立包边界不被拉链锁定。

## 分发

本地开发可以把 `plugins/<name>` 目录链接进 profile。`--local --scenario supervised` 则从冻结的已提交 HEAD 构建独立 tarball，将选定插件及其运行依赖安装到 profile 内；协调器复用同一批制品。共享库作为依赖安装，不作为 bundle 启用。正式分发以独立 npm 包或预构建 tarball 为准。Git package 安装以仓库根为包边界，不适合作为多插件子目录的默认分发方式。

仓库级发布采用统一版本号（`release-manifest.json` 账本 + `vX.Y.Z` 不可变 tag 驱动的 `.github/workflows/release.yml`），在发布前以 `pnpm` 转换 workspace `catalog:` 依赖并执行 fail-closed 一致性核验；发布与记录权限隔离，失败按同 tag 重试或 `release:supersede` 推进，发布后须逐包核对 npm 读回。完整发布协议、TOCTOU 约束与凭据要求以[发版指南](releasing.md)为单一权威说明。

## 持续目标上下文

`assistant-goals` 是独立、可移除的业务 bundle，复用 DSH 原生 `goals` 与 `assistant-automations`（不复制 AgentLoop、调度器或 goal 状态机）：仅在真实 Delivery owner 当前人类 turn 创建目标时绑定不可变 owner lineage、scope（workspace/preset/principal）与目标原文；业务 focus 存在私有 SQLite，原生 `complete` 仅表示待验收，只有绑定当前定义与实际执行的独立验收才能确认 `achieved`。目标累计预算与可选后台唤醒由私有 `.budgets` / `Session lease` 排他门及 Automations Host executor 串行化，过期或 `unknown` 不自动重放。

### 自主协同与成长管线

日常闭环沿单向来源与锁序流转，全部可独立启停并保持未知不重放与撤回失效：

- **入站与主动跟进（`assistant-work-items` / `assistant-proactive` / `assistant-delivery`）**：Delivery 在受认证人类回复上落盘独占入站、自然结果反馈及续办序（不把模型自报或 `role:user` Host notice 当作授权）；WorkItems 以 `observe` 模式记录 intake 台账、受控召回（owner recall）与显式 continuation；Proactive 对已授权事件做收益评估（`intakeEvaluation`）、去重提醒与主人注意力调节提问。
- **记忆与经验学习（`assistant-memory-learning` / `personal-memory`）**：在三份独立签名授权齐备后通过 canonical 游标提取前台或 WorkItem 经验，并在查询与模型组装边界按当前 owner 实时复核/隐藏已撤回条目。
- **联想记忆层（`assistant-association`）**：通过可选 `peerDependencies` 聚合 `personal-memory`、`assistant-goals`、`assistant-work-items`、`assistant-automations`、`personal-wiki`、`assistant-skills`、`event-triggers`、`assistant-dreaming` 与任务片段，在本地 SQLite（Schema v4）与进程内存双缓冲索引上执行 ≤5ms 同步联想召回（`<association>` 与 `assoc_read(id)`），支持撤回级联、10–15% 密封留出、Hebbian 更新与 WP22 参数自调参；`dogfood` 预设安装并开启本地联想，S3 空闲做梦/observe 信号与 S4 隔离子进程（无凭据环境，非 OS 沙箱）只读 Web 学习均默认关闭。
- **做梦奇想与成长驱动（`assistant-dreaming` / `assistant-growth-driver` / `assistant-growth-contract`）**：`assistant-dreaming` 默认休眠（fail-closed），启用后经确定性 HMAC 抽签与空闲/冷启动门由单工具冻结 Agent 仅写入私有 idea 账本（L0）；只有经 owner 受策略验证的 idea，才允许可选 `assistant-growth-driver` 结合前台真实反馈或认证后台失败（`workItemFailures`）在冻结模型路由与预算下形成持久成长作业，再交 Control Plane 与 Verifier 独立审查、有限采用或物理回退。
- **多 ACP 编码 Agent 与控制台（`traex-acp-provider` / `owner-console`）**：同时提供 `traex-agent` 与 Antigravity `agy-agent` 本机 ACP 接入并支持配置热重载；`owner-console` 聚合各插件的脱敏健康与概览（经 `assistant-health` / 服务读写端），写入全部走 Host `settings`/`pluginManager` 或受授权服务方法，浏览器端不持密钥、不发模型请求。

## 离线隔离执行与独立验收

`assistant-isolation` 作为独立 bundle 接入原生 ToolRuntime，Host 仍拥有 AgentLoop、Delivery owner、Policy 与 SQLite 授权账本：Linux 唯一支持 `backend: 'linux-native'`（bubblewrap、user/mount/PID/network namespace、tmpfs 与已委派 cgroup v1 控制器或统一 cgroup v2 子树，Docker 后端已移除，旧账本只读留存）；macOS 的 `macos-seatbelt` 仅用于 `plugin-control-plane` 的受限 `create`/`revise-created` 构建与行为验收路径（`assistant-isolation` 普通离线执行为 Linux 专用）。每条 Isolation grant 精确绑定 owner lineage、scope、期限与有限次数/时长，按 `unknown` 保留资源占位、不自动重放。

`assistant-verifier`、`assistant-goals`、`assistant-skills` 与 `plugin-control-plane` 通过共享非激活契约库（`task-acceptance-contract`、`assistant-growth-contract`）解耦：候选源码在无网离线环境构造，独立评测/回归使用私有 held-out 用例与冻结父基线比对；动态采用的新工具、技能与有限修订（`creationCapabilities.retention` / Control Plane 签名证书与物理回退）均保留独立创建/审查/采用账本，详见各包 README 与 [Control Plane 有限试用合同](bounded-live-adoption.md)。

## 受限外部提交 broker

`assistant-actions` 将 Cordis Host facade 与独立守护进程 `dsh-actions-broker` 分离：`external-unix-v1` 模式经角色分离、双向 Ed25519 签名与 Linux `SO_PEERCRED` 校验的 action/admin Unix sockets 通信，GitHub 凭据与动作账本由 broker 独占（Host 与模型均不接触 token）；支持 expected-head commit、有限 repository/branch/file 检视及经独立 `verifiedDelivery` 验收后的 PR 提交，并在发送窗口发生未知结果时保守记为 `unknown`、禁止重放（`embedded-compat` 保留兼容回滚路径）。

## 固定模型路由的目标预算

`assistant-deepseek-budget` 持有独立的 `deepseek-goal-metered` provider 与保守输入预留计量器（不改变其他普通模型路由），面向有限 Goals 回合执行按次/输出/时长限制；Web 场景下由 `assistant-web-owner` 的离线 `--goal-admission` 编译私有任务规格与固定路由绑定，并保留与原生 Session/UI 模型选择一致的运行前核对。
