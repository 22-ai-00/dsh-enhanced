# 日常使用自迭代的双 Host 配置

`dsh-rsi-setup` 将已配置的 Lark owner 目标 profile 和独立采用协调器接入原生 Automations。目标 Host 从真实任务反馈形成源码修复，协调器在目标重启期间继续有限交接；目标恢复后重验当前 owner 和反馈，再完成采用。后续任务进入观察与回滚流程。

双 Host 配置入口要求 Linux、可用的 systemd user session、两个已安装的 profile，以及已配置的有限授权器和 release/Host adapters。独立的源码准备入口不启动 Host。它负责核对授权与配置、成对写入和启动服务；完整生产部署还需要独立行为观测与实际使用验收。源码发布轨使用授权的本地 registry，仓库公共 npm 发版仍走仓库发布流程。

## 1. 准备源码与两个 profile

新安装的 `supervised` 场景会自动准备私有源码仓库，并安装下述目标依赖。源码放在 `$DSH_HOME/rsi-sources/<profile>/`：`checkout` 为独立工作树，`release.git` 为本地 bare 发布仓库，`bootstrap.json` 保存来源与初始提交。npm 安装读取本工具版本对应的官方 `v<version>` tag；本地安装只复制 checkout 已提交的 HEAD，保留原工作区的未提交修改。

已有安装可单独运行：

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-rsi-setup \
  --prepare-source --profile web --dsh-home "$HOME/.dsh"
# 本地开发安装额外传 --source-repository /absolute/path/to/dsh-enhanced
```

输出 JSON 的 `repository` 与 `baseline` 可直接用于 `sourceJobs`；Growth 与相关授权须引用同一仓库。初始发布分支为 `repairs`，受管基准为 `refs/dsh-source/repairs`。重复执行会复用并核对已保存的来源和版本，保留已推进的发布分支及基准；它不会把日常修复回退到安装版本。不同版本或来源不能覆盖已有目录，须先完成部署迁移。准备过程需要 Git，官方来源还需要访问 GitHub；失败或中断不会被当成完成。

此步只准备源码与发布仓库。签名配置、registry、构建执行环境、协调器与 manifest 仍按后续步骤配置；源码存在不代表双 Host 自动采用已启用。

目标先完成 [Lark 配对](setup.md)与 [supervised 安装](supervised-growth.md)，已有唯一 active owner DM 和有效 owner route。旧安装若缺依赖，为目标补装同一构建的 Growth Driver、Goals、Skills、Verifier 与 Control Plane。开发版应使用本地构建的包；仅有相同版本号不能证明含有这些新增 API。

```sh
dsh plugin --profile web add \
  @dsh-enhanced/assistant-growth-driver \
  @dsh-enhanced/assistant-goals \
  @dsh-enhanced/assistant-skills \
  @dsh-enhanced/assistant-verifier \
  @dsh-enhanced/plugin-control-plane

dsh plugin --profile rsi-coordinator add \
  @dsh-enhanced/assistant-policy \
  @dsh-enhanced/assistant-automations \
  @dsh-enhanced/plugin-control-plane
```

协调器使用新的自定义 profile，默认从 DSH base 创建。勿从 `web` 模板复制：协调器不需要 Web 服务或第二个 Lark 入口。目标和协调器的 Policy/Automations 状态分开；协调器 Control Plane 的主库独立，专用采用连接按目标 trust 中的精确路径读取共享交接账本。

## 2. 准备一次性有限授权 manifest

manifest 是 owner 私有的 JSON（`chmod 600`），路径须 canonical，不含 symlink。它引用已存在的私有授权器配置、key、trust、catalog 和控制账本。配置器读取并验证这些文件，不生成授权或签名回执。

| 字段 | 要求 |
| --- | --- |
| `schemaVersion` | `1` |
| `targetProfile` / `coordinatorProfile` | 已安装且不同的 profile 名 |
| `controlPlane` | 目标的完整 Control Plane config；必需 `sourceBuild`、`sourceJobs`、`sourceApprovals`、`sourceReleases`、`sourceReleaseExecution`、`sourceAdoptions.handoff`、`runtimeObserver`、`foregroundDeployments`、`taskObservations` |
| `growthDriver` | 完整 Growth config；`enabled: true`、`intervalMs: 0`、启用 `usageLearning` 与 durable `pluginSourceProposals`，绑定同一 owner/workspace/preset/repository |
| `sourceReviews` | 有限独立审查授权；owner 精确匹配当前 Delivery 记录，decisionRoot 与发布轨一致 |
| `coordinator` | `{ "budgetId": "rsi-adoption", "budgetAmount": 1, "timeoutMs": 900000 }`，按实际约束设置 |
| `limits` | 例如 `{ "periodMs": 86400000, "reviews": 5, "discovery": 1440, "source": 1440, "observations": 1440, "coordinator": 1440 }`；均为显式有限额度 |

具体配置契约见 [Control Plane](../../plugin-control-plane/README.md)、[Growth Driver](../../assistant-growth-driver/README.md)、[Verifier](../../assistant-verifier/README.md)。四份签名授权必须使用相同 owner、目标 ledger 与插件白名单，并与 trust 登记的公钥一致。采用授权绑定 executor、profile、handoff；观察授权绑定包名单和观察策略。所有授权须在有效期内。

所有 owner 字段中的 `authorityId` 使用有效 Delivery 路由的 ID，即 `sourceJobs.ownerRouteId`。`sourceJobs.authorityId` 是源码作业的独立期限与额度标识，不能用作 owner 路由身份。

不填 Growth `provider/model` 和 Verifier `sourceReviews.model` 时继承来源任务的实际模型。需要固定修复或审查供应时显式配置；历史任务已冻结的模型不会跟随之后的会话切换。

扫描、源码作业、观察与协调器使用 `subject` scope 的 `automation-runs` budget；模型复盘使用 `global` scope 汇总。Policy 按 scope、metric、period 计量，改 budget ID 不会隔离同一计数池。源码额度按每个原生 automation identity 计量，总作业数另由有限 `sourceJobs.maxSubmissions` 限制。空扫描也消耗配置额度；额度应覆盖所需扫描频率。已有同周期全局规则的额度必须兼容。配置器不会打开 `allowUnbudgetedExecution`。

## 3. 校验、应用、启动

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-rsi-setup \
  --manifest /private/owner/rsi.json
```

默认只读组合 profile、核对当前 owner 与有限授权，不修改 profile 或启动服务。`DSH_HOME` 可由环境变量或 `--dsh-home /absolute/path` 指定。

应用前停止两个 Host（包括手工启动的进程），并确认没有其他 writer。命令同时检查对应 systemd unit 处于 stopped 状态；系统服务状态不能证明手工进程已停止。

```sh
systemctl --user stop dsh-profile-web.service dsh-profile-rsi-coordinator.service
~/.dsh/profiles/web/node_modules/.bin/dsh-rsi-setup \
  --manifest /private/owner/rsi.json --apply --confirm-hosts-stopped --start
```

使用同一 DSH_HOME lifecycle lock；写入前重查 manifest、owner snapshot 和两个原始 patch，保留有效配置中的其他字段与 `!!js`。成对写入后再次运行 `dsh --dump-config` 检查。`--start` 复用已有常驻服务安装器，先启动协调器，再启动目标；省略该参数只保存配置。

## 恢复与停止

配置 journal 存在 `DSH_HOME/.rsi-setup-journal.json`，为私有文件，含上次变更前后的两个 patch。写入或最终组合失败时自动恢复；崩溃留下 prepared journal 时先执行回滚。重复应用相同配置不会覆盖原回滚点。只有最近一次变更可由此入口恢复。

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-rsi-setup \
  --manifest /private/owner/rsi.json --rollback --confirm-hosts-stopped
```

回滚前仍须停止两个 Host。恢复不要求前向授权仍未过期；若任一 patch 被外部改过，会保留 journal 并拒绝覆盖。服务启动失败时保留已应用配置，先排查/停止服务再决定恢复，避免改写活跃 Host。

暂停自迭代可停止协调器及目标的相关 Automations，或撤销有限授权；重启不重置额度，也不重放 unknown 外部动作。授权续期需要新的合法授权标识与配置。配置 journal 只恢复 profile；已发布或已采用能力的回退仍由 Control Plane 的签名恢复链负责。

此 CLI 读取 owner 数据库与私有配置；默认检查也会使用本地 lifecycle 锁和临时 WAL 快照，但不改变 profile 或业务状态。显式应用写两个 profile patch 和 journal；校验会执行本地 `dsh --dump-config`、`systemctl show`，显式启动会安装/启用/restart 用户级服务。它不向其他人发送消息。原始授权、私钥、数据库、journal 与运行日志留本地，不提交 GitHub。

## 使用普通任务资格合同

可按[有限试用采用指南](../../../docs/bounded-live-adoption.md)配置 `sourceAdoptions.liveQualification` 与 `controlPlane.liveQualification`，并设置 `limits.qualification` 和独立预算 ID。配置器核对第五份独立签名授权及公钥，生成资格扫描的原生 Policy/Automations 规则。该模式以限时真实 owner 任务替代严格 replay/shadow 等验收合同，不声称这些严格阶段已通过；已有未配置此模式的 manifest 保持原行为。实际部署端到端验收仍见当前状态。

Host 可通过 [systemd schema4](../../../docs/systemd-host-attestor.md#automatic-authorization-within-an-installation-grant) 自动解析已批准操作的逐次授权。配置器核对 `sourceAdoptions.hostDeploymentInputs` 与采用授权的同名列表；Host 授权配置与原始/候选 observer 仍须预先准备，配置器不会生成它们。
