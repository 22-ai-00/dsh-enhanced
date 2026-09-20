# 原生技能复用评测接线

Skills 提供同一可信 Host 进程内的受限委派接口：从原 owner 的已验证技能或待评测候选，挂载到一个全新评测 scope，供模型通过原生 `skill_run` 调用。Evaluation 的 `./benchmark/skills` Host 入口负责原生模型单元、冻结后独立任务、预算计量、结果验收和统计；导入本身不会启用插件或启动进程。

## Host 调用顺序

1. 保持来源 Goals/Skills 服务存活。调用 `source.inspectOwnerBenchmarkArm({ scope, ownerRouteId, skillName, version, candidateId? })`，它重新读取原 Session、Goal 和验收回执，返回规范化 definition、`definitionDigest`、`sourceDigest`、版本及有效期。活动技能使用当前版本；候选使用 `parentVersion + 1`，仍须保持 pending 且父版本有效。
2. 用这些摘要冻结 baseline/candidate、供应、预算和验收协议。每个 cell 必须先成功占用 Evaluation 的持久执行记录，再签发委派。未知或已完成 cell 不得重新派发，也不得通过换数据库绕过外层记录。
3. 创建拥有独立 workspace、状态目录和 Delivery owner route 的 recipient Skills 服务。来源和接收方 Policy 均须允许 background `compare`；接收方还须允许当前 Agent 的 `run` 及实际嵌套工具。
4. 来源调用 `mintBenchmarkArm({ selection, recipient, recipientScope, recipientOwnerRouteId, binding }, signal)`。`binding` 的完整字段如下：

   ```ts
   {
     protocol: 'assistant-skills/delegated-arm/v1',
     planDigest, cellId, variantId,
     definitionDigest, sourceDigest,
     recipientScopeDigest, skillName, version, expiresAt,
   }
   ```

   `recipientScopeDigest` 使用 `acceptanceDigest(recipientScope)`。有效期不得超过来源验收、候选有效期或签发后五分钟。返回值是不透明的进程内对象，不能序列化后恢复或发给模型。
5. 调用 `recipient.mountBenchmarkArm(capability, binding)`。它返回绑定摘要、技能名称/版本/输入以及 disposer。向模型提供这些公开调用信息，由模型在新的原生 Goal 中调用 `skill_run`；`skill_status` 可查看当前挂载和调用记录。
6. 关闭 cell 时调用 disposer 并等待原生运行时停止。委派调用的 `SkillRun.delegationDigest` 绑定完整 cell/arm 摘要；结果必须关联实际 run、native Goal、独立验收与真实用量。未调用技能的 Goal 不能作为技能复用证据。

## 生命周期与证据边界

- 定义只存在于当前 recipient 服务内存，不写入普通 active/candidate 表。持久 `skill_delegated_arms` 只保留绑定及一次性 scope/cell reservation；执行复用现有 `skill_runs`、checkpoint、finish 和 unknown 防重放逻辑。
- 同一 capability 只能挂载一次，来源服务生命周期内同一 plan/cell 只签发一次。同一 recipient 数据库的 reservation 在重启后仍拒绝重新挂载；没有 live capability 时不能恢复执行。全局重派约束仍依赖上层 Evaluation 记录。
- 来源版本、候选父版本、owner route、Policy 和原始验收在调用及每个嵌套步骤前后复核。来源服务或其 Goals/Policy/Delivery 依赖卸载会撤销 grant；到期、recipient 卸载、外部取消和 disposer 均传播 AbortSignal。
- 取消停止等待并抑制晚到结果；它不证明不合作的外部工具已停止。已派发但无法确认的调用保留 unknown，评测不能报告 quiescent 或成功。外部资源停机证据须由相应原生运行时提供。
- 此接口不授予候选激活、生产发布、密封任务或验收签名权限。recipient 工具表和 Policy 应只开放本次任务所需能力。

## Evaluation Host 入口

从 `@dsh-enhanced/assistant-evaluation/benchmark/skills` 导入：

- `createNativeSkillGoalRuntime(options)`：创建一个真实 DSH Goal 单元。`execute()` 返回独立 Goal 观察、Host usage、工具调用和技能执行记录。来源单元配置 `source: { name, description, validityMs }`；达成后调用 `captureVerifiedSkill()`，通过真实 SessionQuery/Goals 重新验证，沉淀 pending 候选。来源服务必须持续存活。
- `runNativeSkillBenchmark(config, captured, factory, signal)`：使用同一个可信模型工厂运行 baseline/candidate。`config` 固定 persona、model、budget、execution、公开 task、不可变 image、Docker 路径、步骤时限、repeats（2–4）、seed、expiresAt、独立 authority 和 verification。供应、预算、任务与 persona 必须匹配 captured.origin；训练用量单独返回，不混入复用单元。
- `nativeSkillBenchmarkReport(evidence, pinnedPublicKey, generatorDigest)`：离线重验 `completion.json`，重算报告；不启动模型、authority 或 Docker。

`stateRoot`、`workspaceRoot` 必须是独立的私有绝对目录，state 也不能位于来源 workspace 内。来源 runtime 的 workspace/stateRoot 由调用者预先创建为 `0700`。模型工厂负责装配凭据服务和适配器；模型仅见公开程序规格和允许的原生工具，不接收独立验收输入、答案、私钥或 authority 路径。

协调顺序是：

1. 重新验证 live 来源，冻结模型、预算、候选、训练证据和已部署模块摘要。
2. authority `begin` 持久冻结后生成随机任务；`manifest` 返回签名 case/cell 摘要，不暴露答案。核验生成器、公钥与完整调度顺序。
3. 在现有 `BenchmarkStore` 占用 cell 后，领取签名输入并启动全新 owner/Goal。baseline 不提供 Skills，candidate 临时挂载精确委派；两臂使用相同预算。
4. 独立 Goal smoke 验收后读回产物，关闭原 runtime，再由 `IsolatedVerifierRunner` 在独立容器执行隐藏输入。
5. 保存私有逐 cell 观察；未签名的 `record` 响应不能成为成功结论。执行账本保留 provisional unknown verdict，只有最终签名 receipt、观察摘要与原生计量均通过重验后，才计算质量报告。

`complete` 同时要求全部单元已记录、独立 authority 完整、执行已确认且没有 unknown。重跑同一实验不会重新派发；不要更换数据库、authority state 或 scope 绕过 reservation。`reuse` 只列出确实成功调用委派技能的单元；模型未使用技能不能算作复用。报告始终 `promotionAuthorized: false`。

当前 transport 复用 Skills 的受限 NDJSON 子进程协议；authority 是可信 Host 程序，继承该进程的环境和 cwd。私有文件目录隔离及候选的无 Host 挂载容器，不构成独立 UID/机器部署证明。插件内使用这些 Host API 时，须将整个实验的取消与 `close()` 绑定到调用方 Cordis effect。

## 真实 Day1 探针

先运行 `pnpm build`，准备已存在、包含 `/bin/sh` 与 `node` 的不可变本地 Docker 镜像。使用 [native-skill-day1.mjs](../scripts/e2e/native-skill-day1.mjs) 在全新私有目录运行；父目录须已存在，探针拒绝覆盖或恢复已有实验，不拉取镜像、不安装插件、不修改日常 profile。

```sh
DSH_NATIVE_SKILL_EVIDENCE_ROOT=/absolute/private/new-experiment \
DSH_NATIVE_SKILL_IMAGE=sha256:LOCAL_IMMUTABLE_IMAGE \
node scripts/e2e/native-skill-day1.mjs
```

凭据使用运行环境的 `SUPER_RELAY_API_KEY` 引用；若需已有 DSH 本地凭据服务，同时设置 `DSH_NATIVE_SKILL_CREDENTIALS_MODULE`（可信 provider 的绝对 JS 路径）与 `DSH_NATIVE_SKILL_CREDENTIALS_PATH`（凭据文件绝对路径）。文件内容不会写入证据。可用 `DSH_NATIVE_SKILL_DOCKER` 指定绝对 Docker 路径，默认 `/usr/bin/docker`。

探针固定同一 Day1 工厂，传输请求时限 180 秒、原生 step 240 秒、每 cell 总期限 900 秒，输出每次最多 4,096 tokens；来源训练与两臂使用相同预算。来源经原生 Goal 验收后才捕获候选，随后运行 3 种冻结后任务 × 2 次重复 × 2 臂。脚本、供应工件、传输配置和训练证据均纳入摘要；运行期间不要修改或重建不同版本的已部署模块。总运行上限 55 分钟，SIGINT/SIGTERM 触发已有取消与关闭路径。

`input.json`、`training.json`、`comparison/completion.json` 和 `summary.json` 保存在该私有目录；失败保存 `failure.json`，传输异常另存仅含错误码、时长和取消状态的 `transport-errors.jsonl`。未完整结算 usage 时保持 unknown 与预留，不自动重试；最终报告不完整则进程退出 1。新实验必须显式选择新目录并保留旧失败，不能把新实验当作对旧 unknown 的重放或结算。报告不授权激活或晋升，也不将请求次数或 fixture 成功冒充真实收益。

## 当前验收范围

真实 Docker 工程测试覆盖：来源 native Goal→独立验收→SessionQuery 捕获→12 个新 Goal 的双臂比较，候选 6 次实际技能复用；两臂各 6 次达成、质量平局。另覆盖 usage/输出/预算/训练证据篡改、unknown 报告、重跑拒绝与取消清理。这些使用确定性适配器，不证明真实模型收益。

```sh
DSH_ISOLATION_TEST_IMAGE=sha256:LOCAL_IMMUTABLE_IMAGE \
pnpm --filter @dsh-enhanced/assistant-evaluation exec vitest run \
  tests/benchmark/native-skills-runtime.spec.ts tests/benchmark/native-skills.spec.ts
```

真实 Day1 的同预算结果和剩余验收统一见 [RSI 当前状态](rsi-status.md)。任务在冻结后生成的证书只证明该次生成顺序，不证明模型训练数据独立；WP04/WP13/WP18 的任务广度和真实收益门槛仍保留。
