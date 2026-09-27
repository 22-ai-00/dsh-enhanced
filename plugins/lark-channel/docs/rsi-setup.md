# 日常使用自迭代的双 Host 配置

`dsh-rsi-setup` 将已配置的 Lark owner 目标 profile 和独立采用协调器接入原生 Automations。目标 Host 从真实任务反馈形成源码修复，协调器在目标重启期间继续有限交接；目标恢复后重验当前 owner 和反馈，再完成采用。后续任务进入观察与回滚流程。

双 Host 配置入口要求 Linux、可用的 systemd user session、两个已安装的 profile，以及已配置的有限授权器和 release/Host adapters。独立的源码准备入口不启动 Host。它负责核对授权与配置、成对写入和启动服务；完整生产部署还需要独立行为观测与实际使用验收。源码发布轨使用授权的本地 registry，仓库公共 npm 发版仍走仓库发布流程。

## 1. 准备源码、构建环境与两个 profile

新安装的 `supervised` 场景会自动准备私有源码仓库，并安装下述目标依赖。源码放在 `$DSH_HOME/rsi-sources/<profile>/`：`checkout` 为独立工作树，`release.git` 为本地 bare 发布仓库，`bootstrap.json` 保存来源与初始提交。npm 安装读取本工具版本对应的官方 `v<version>` tag；本地安装只复制 checkout 已提交的 HEAD，保留原工作区的未提交修改。

已有安装可单独运行：

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-rsi-setup \
  --prepare-source --profile web --dsh-home "$HOME/.dsh"
# 本地开发安装额外传 --source-repository /absolute/path/to/dsh-enhanced
```

输出 JSON 的 `repository` 与 `baseline` 可直接用于 `sourceJobs`；Growth 与相关授权须引用同一仓库。初始发布分支为 `repairs`，受管基准为 `refs/dsh-source/repairs`。重复执行会复用并核对已保存的来源和版本，保留已推进的发布分支及基准；它不会把日常修复回退到安装版本。不同版本或来源不能覆盖已有目录，须先完成部署迁移。准备过程需要 Git，官方来源还需要访问 GitHub；失败或中断不会被当成完成。

新安装还会尝试准备离线构建镜像。当前完整仓库检查沿用已验证的 Linux x64、Docker Server `29.4.1/linux/amd64` 与嵌套 sandbox 配置；不满足这些前置条件时，安装器保留源码并报告 `buildUnavailable`，普通 Agent 安装继续，但不声称源码修复构建已经可用。实际镜像构建失败或已有资源不一致会停止安装。

支持的环境可单独运行严格构建准备：

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-rsi-setup \
  --prepare-build --profile web --dsh-home "$HOME/.dsh"
```

输出中的 `sourceBuild` 可用于 Control Plane manifest。安装器还自动从同一不可变镜像导出原生 Node、pnpm、离线 store 和供应链策略缓存，输出 `releaseBuild` 可直接用于本地发布 adapter 的 `build` 配置；无需手填工具链路径和摘要。资源保存在 `$DSH_HOME/rsi-release-builds/<profile>`，回执固定所有文件内容与模式。导出只创建未启动的容器，复制固定路径后删除容器，不执行其中的源码。发布仍使用本机 `/usr/bin/bwrap` 和 `/usr/bin/tar`；`--optional-build` 在缺少这些前置条件时报告 `releaseBuildUnavailable`，保留已准备的源码验证镜像。实际复制、工具链版本校验或已有回执漂移失败仍会停止安装。配置使用不可变镜像 ID，并将私有回执与 seccomp 保存到 `$DSH_HOME/rsi-builds/<profile>`。重新执行会核对来源、构建输入与本地镜像；不会静默换镜像或重新构建丢失的已登记镜像。Docker 构建脚本、Dockerfile 与 seccomp 必须匹配安装包内登记的摘要，只把 lock、workspace 配置及包清单放入构建上下文；不复制源码、主机包缓存或凭据。首次镜像准备需要网络，随后候选构建离线运行。

自动配置沿用完整仓库检查的 30 分钟、16 GiB 内存、8 CPU、1024 PID、4 GiB 工作区和 2 GiB 临时目录上限；宿主需提供相应资源。嵌套 sandbox 的系统路径与 seccomp 边界见[构建镜像指南](../../../scripts/isolation/README.md#nested-sandbox-profile)。源码、镜像、发布工具链及配置已准备不代表双 Host 自动采用已启用；签名配置、registry、协调器与完整 manifest 仍按后续步骤配置。

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
| `serviceEnvironment` | 可选 `{ "target": { ... }, "coordinator": { ... } }`，显式替换两个服务的配置路径绑定；通常无需填写，见下文 |

具体配置契约见 [Control Plane](../../plugin-control-plane/README.md)、[Growth Driver](../../assistant-growth-driver/README.md)、[Verifier](../../assistant-verifier/README.md)。四份签名授权必须使用相同 owner、目标 ledger 与插件白名单，并与 trust 登记的公钥一致。采用授权绑定 executor、profile、handoff；观察授权绑定包名单和观察策略。所有授权须在有效期内。

所有 owner 字段中的 `authorityId` 使用有效 Delivery 路由的 ID，即 `sourceJobs.ownerRouteId`。`sourceJobs.authorityId` 是源码作业的独立期限与额度标识，不能用作 owner 路由身份。

不填 Growth `provider/model` 和 Verifier `sourceReviews.model` 时继承来源任务的实际模型。需要固定修复或审查供应时显式配置；历史任务已冻结的模型不会跟随之后的会话切换。

配置器自动保存 trust 所选择的标准 adapter 配置路径：`DSH_SYSTEMD_HOST_ATTESTOR_CONFIG` 和 `DSH_RELEASE_{PR,REVIEW,MERGE,BUILD,SIGN,PUBLISH,REGISTRY_VERIFY,CATALOG_ADMISSION}_CONFIG`。首次配置从当前进程读取；之后优先复用 `$DSH_HOME/rsi-service-environments/<profile>.json`，重装服务或退出 shell 后无需重新 export。目标接收所选发布与 Host 路径，协调器只接收相同的 Host 路径。若要替换已有路径，可在 `serviceEnvironment` 明确给出两个映射；字段集合须与 trust 所选标准变量一致。引用的配置必须是当前用户私有、canonical、单链接普通文件，且位于 `profiles/` 之外。这里只保存配置路径，不复制 token、私钥或任意 shell 环境变量。

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

使用同一 DSH_HOME lifecycle lock；写入前重查 manifest、owner snapshot、两个原始 patch 以及服务绑定和 unit，保留有效配置中的其他字段与 `!!js`。成对写入后再次运行 `dsh --dump-config` 检查。存在受管服务环境时，同一事务保存两个绑定和 systemd unit，并执行 `daemon-reload`；schema4 Host grant 中的 `template.unitProperties.Environment` 必须与目标 unit 的实际 `systemctl show` 输出一致，否则自动恢复。准备 grant 时应使用最终计划的服务环境。`--start` 复用已有常驻服务安装器，先启动协调器，再启动目标；省略该参数仍保存并加载服务定义，但不启动服务。

## 恢复与停止

配置 journal 存在 `DSH_HOME/.rsi-setup-journal.json`，为私有文件，含上次变更前后的两个 patch。新 schema2 还保存两个环境绑定和 unit 的原始及新内容，原先不存在的文件回滚时删除；仍支持旧 schema1 journal。写入、最终组合或服务环境读回失败时自动恢复；崩溃留下 prepared journal 时先执行回滚。重复应用相同配置不会覆盖原回滚点。只有最近一次变更可由此入口恢复。

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-rsi-setup \
  --manifest /private/owner/rsi.json --rollback --confirm-hosts-stopped
```

回滚前仍须停止两个 Host。恢复不要求前向授权仍未过期；若任一 patch、服务绑定或 unit 被外部改过，会保留 journal 并在恢复任何文件前拒绝覆盖。服务启动失败时保留已应用配置，先排查/停止服务再决定恢复，避免改写活跃 Host。受管升级会同时校验绑定、unit 与有效环境，并在复制、切换和恢复时检查绑定内容未漂移。

暂停自迭代可停止协调器及目标的相关 Automations，或撤销有限授权；重启不重置额度，也不重放 unknown 外部动作。授权续期需要新的合法授权标识与配置。配置 journal 恢复 profile 及上述服务配置；已发布或已采用能力的回退仍由 Control Plane 的签名恢复链负责。

此 CLI 读取 owner 数据库与私有配置；默认检查也会使用本地 lifecycle 锁和临时 WAL 快照，但不改变 profile 或业务状态。显式应用写两个 profile patch、受管服务绑定/unit 和 journal；校验会执行本地 `dsh --dump-config`、`systemctl show`，服务定义变更会执行 `daemon-reload`，显式启动会安装/启用/restart 用户级服务。它不向其他人发送消息。原始授权、私钥、数据库、journal 与运行日志留本地，不提交 GitHub。

## 使用普通任务资格合同

可按[有限试用采用指南](../../../docs/bounded-live-adoption.md)配置 `sourceAdoptions.liveQualification` 与 `controlPlane.liveQualification`，并设置 `limits.qualification` 和独立预算 ID。配置器核对第五份独立签名授权及公钥，生成资格扫描的原生 Policy/Automations 规则。该模式以限时真实 owner 任务替代严格 replay/shadow 等验收合同，不声称这些严格阶段已通过；已有未配置此模式的 manifest 保持原行为。实际部署端到端验收仍见当前状态。

Host 可通过 [systemd schema4](../../../docs/systemd-host-attestor.md#automatic-authorization-within-an-installation-grant) 自动解析已批准操作的逐次授权。配置器核对 `sourceAdoptions.hostDeploymentInputs` 与采用授权的同名列表；当 trust 选择 `DSH_SYSTEMD_HOST_ATTESTOR_CONFIG` 时，还读取已解析的服务绑定所指向的私有配置，预检 schema4 wrapper、resolver/config 摘要、固定解释器及 Host 签名身份，并核对 owner、ledger、目标 profile、协调器 handoff 和有限试用条款。预检仅执行已固定 attestor 的版本查询和已选官方 resolver 的语法检查，不签发逐次授权或重启服务。Host 授权配置与原始/候选 observer 仍须预先准备，配置器不会生成它们；路径的持久传递由上述服务绑定负责。预检通过不等于实际 reload/readiness 已验收。
