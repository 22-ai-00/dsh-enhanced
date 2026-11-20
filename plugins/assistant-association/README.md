# @dsh-enhanced/assistant-association

面向 DeepSeek Harness 的亚 5ms 进程内存双缓冲关联图与联想召回层（Slice S1–S2）：将 `personal-memory`、`assistant-goals`、`assistant-work-items`、`assistant-automations` 与确定性任务片段（Delivery + Evaluation 混合账本）统一建图并持久保存在本地 SQLite（Schema v2）中，在每步模型调用前完成同步 Aho-Corasick 实体匹配、CJK bigram BM25 回退与 ≤2 跳邻接表扩散，注入单段滞回 `<association>` 上下文块并提供 `assoc_read(id)` 按需读取工具；同时基于隐式使用信号进行有界 Hebbian 边权更新，并通过 WP22 版本化参数档案与留出重放门控实现有界自调参与退化精确回退。

## 安装

本插件依赖 `@dsh-enhanced/assistant-policy`（通过 `inject: ['assistantPolicy']` 门控）。其余可选 Host peers（`personalMemory`、`assistantGoals`、`assistantWorkItems`、`assistantAutomations`、`assistantDelivery`、`assistantEvaluation`、`systemPrompt`、`tools`）均通过 `peerDependenciesMeta.*.optional = true` 延迟绑定，缺失时按可用来源优雅降级：

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-policy
dsh plugin --profile web add @dsh-enhanced/assistant-association
dsh --profile web --dump-config
```

在 `dogfood` 预设中，本插件默认开启本地联想召回（`enabled: true`, `localOnly: true`），不额外触发审批弹窗；S2 的 Hebbian 更新与 WP22 参数自调参均在本地有限界限内运行，`dreaming`、`intakeSignal` 与 `webLearning` 在 S1–S2 保持显式关闭（`enabled: false`）。

## 配置项

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 是否启用本地关联图与上下文注入。 |
| `localOnly` | `boolean` | `true` | 本地联想模式标记。 |
| `databasePath` | `string` | `$DSH_HOME/assistant-association/state.sqlite` | SQLite 绝对路径（测试支持 `:memory:`）。 |
| `holdoutSeedPath` | `string?` | `<dirname(databasePath)>/holdout.seed` | HMAC 留出种子文件路径（`0o600`；`dsh-plugin-setup` 支持修改此路径）。 |
| `holdoutSeed` | `string?` | — | 可选显式留出种子（16–512 字符，派生 32 字节密钥；不写入 SQLite，亦不经 `dsh-plugin-setup` 写入 `cordis.patch.yml`）。 |
| `holdoutRateBps` | `integer` | `1250` | 密封留出比例，范围 `[1000, 1500]` bps（10%–15%）。 |
| `hotPathBudgetMs` | `number` | `4.5` | 同步热路径时间预算（ms），超时立即降级为空注入并记录 `assoc-timeout`。 |
| `maxItems` / `minItems` | `integer` | `8` / `5` | 每次注入条数上限（`5..8`）与最小滞回保持窗口（`1..8`）。 |
| `maxContextTokens` | `integer` | `400` | `<association>` 上下文块 token 预算上限。 |
| `maxHops` | `integer` | `2` | 最大图扩散跳数（`1..2`）。 |
| `hopTopN` | `integer` | `32` | 每跳裁剪保留的最高分节点数（`4..128`）。 |
| `maxFanoutPerNode` | `integer` | `128` | 按边权降序截断的单节点最大邻接展开数。 |
| `hysteresisDelta` | `number` | `0.15` | 滞回阈值 `δ`：无显著超越且无撤回/失效时保持已注入条目稳定。 |
| `decayHalfLifeMs` | `integer` | `1209600000` (14d) | 节点时间衰减半衰期（ms）。 |
| `syncIntervalMs` | `integer` | `15000` | 周期对账与 S2 调参/衰减检查间隔（ms）。 |
| `allowHeadlessScope` | `boolean` | `false` | 无 `assistantDelivery` 时是否允许确定性 headless scope（默认 fail closed）。 |
| `allowLowTrust` | `boolean` | `true` | 是否允许召回低信任（`low`，如 `external` 记忆）条目；在 `<association>` 中以 `| low |` 标注，且 `assoc_read` 附带不可信数据边界封装。 |
| `allowSensitive` | `boolean` | `false` | 是否允许召回或经 `assoc_read` 读取 `sensitive` 条目（默认 fail closed 过滤）。 |
| `hebbian.enabled` | `boolean` | `true` | S2 隐式使用检测与 Hebbian 边权更新开关。 |
| `hebbian.alpha` | `number` | `0.25` | 强使用（`assoc_read` 命中）边权增强步长 `α`。 |
| `hebbian.weakRatio` | `number` | `0.3333...` (`1/3`) | 弱使用相对强使用的比例（`+α/3`）。 |
| `hebbian.beta` | `number` | `0.35` | Owner 纠正/撤回触发的边权惩罚步长 `-β`。 |
| `hebbian.weightMin` / `hebbian.weightMax` | `number` | `0.05` / `3.0` | 边权硬上下界 `[weightMin, weightMax]`。 |
| `hebbian.initialHebbianWeight` | `number` | `0.35` | 共激活新建 Hop-0 `'hebbian'` 边的初始权重。 |
| `hebbian.decayHalfLifeMs` / `hebbian.nonUseGraceMs` | `integer` | `2592000000` (30d) / `604800000` (7d) | 长期未用指数衰减半衰期与宽限期；按 `max(last_decayed_at, anchor + nonUseGraceMs)` 幂等计算。 |
| `hebbian.decayIntervalMs` / `hebbian.correctionLookbackMs` | `integer` | `3600000` (1h) / `86400000` (24h) | 批量衰减周期与纠正溯源回看窗口。 |
| `paramTuning.enabled` | `boolean` | `true` | S2 WP22 版本化参数档案与自调参开关。 |
| `paramTuning.minSample` / `minStepSample` / `minHoldoutSamples` / `minSourceSample` | `integer` | `20` / `20` / `20` / `10` | 自动收紧、步数、留出重放与分来源噪声判定的最小样本门槛。 |
| `paramTuning.maxTimeoutRatePpm` / `lowUsageRatePpm` / `healthyUsageRatePpm` / `highCorrectionRatePpm` / `noisySourceRatePpm` | `integer` | `50000` / `100000` / `250000` / `250000` / `850000` | 触发收紧或噪声降权的百万分比（ppm）阈值。 |
| `paramTuning.regressionMarginPpm` / `timeoutMarginPpm` / `maxTimeoutMarginPpm` / `usageDropMarginPpm` | `integer` | `100000` / `25000` / `25000` / `100000` | 观察期退化精确回退判定的容忍边界（ppm）。 |
| `paramTuning.observationMs` / `evaluationWindowMs` / `relaxationReplayWindowMs` / `rollbackCooldownMs` | `integer` | `7d` / `7d` / `30d` / `7d` | 收紧/放宽后观察窗口、统计窗口、放宽重放窗口与回滚冷却时间（ms）。 |
| `paramTuning.relaxationReplayEnabled` | `boolean` | `true` | 是否允许经 `assoc_replay_episodes` 密封留出重放门控的参数放宽。 |
| `dreaming.enabled` | `boolean` | `false` | S3 做梦建边开关（S1–S2 保持关闭）。 |
| `intakeSignal.enabled` | `boolean` | `false` | S3 work-items 观察态信号开关（S1–S2 保持关闭）。 |
| `webLearning.enabled` | `boolean` | `false` | S4 隔离网页学习开关（S1–S2 保持关闭）。 |

## 架构与行为边界

1. **同步热路径与双缓冲索引**：`systemPrompt.context` 为严格同步回调。插件在内存中维护不可变双缓冲结构化数组（Structure-of-Arrays）+ 权重降序 CSR 邻接表 + 扁平混合 BMP/CSR Aho-Corasick 自动机 + CJK bigram BM25 索引；冷启动超过 2,000 行时分片异步构建索引，构建完成前自动回退至 `personal-memory` 原有关键词召回。
2. **撤回级联（`derivedFrom`）与实时墓碑**：当记忆删除/替换、目标清除、工作项/定时任务删除或 Evaluation 记录 `revision.action === 'withdraw'` 时，立即在内存活跃索引翻置节点墓碑位并清理会话缓存，同时在单个 SQLite 事务中沿 `assoc_derived_from` BFS 级联删除所有派生节点、边（含 Hop-0 `'hebbian'` 边）与同义词。
3. **密封留出（10–15% `HMAC(seed, taskId)`）**：使用 `HMAC-SHA256(seed, "assistant-association/holdout/v1\0" + taskId) mod 10000` 确定性划分留出任务；留出任务不注入 `<association>`，种子文件权限固定 `0o600`，且不写入 SQLite 或暴露给模型。
4. **`assoc_read(id)` 安全重校验**：模型按需调用 `assoc_read(id)` 读取完整正文时，实时重查当前 `owner` 血缘、`workspace`/`preset` 作用域、敏感度与来源有效性，并以不可信数据边界 `<association_item>` 包裹输出；越权与不存在统一 fail closed，命中与拒绝均写入 `assoc_read_events` 供命中率统计。
5. **隐式使用检测与有界 Hebbian 更新（Slice S2）**：
   - **强使用（`+α`）**：`assoc_read(id)` 命中时，沿被暴露项的溯源边（`provenanceEdges`）增强权重，并建立或增强指向活跃目标/片段/共暴露节点的 Hop-0 `'hebbian'` 共激活边（在 `assoc_derived_from` 中登记两端依赖）。
   - **弱使用（`+α/3`）**：未触发 `assoc_read` 时，若暴露节点的**唯一实体**（排除当轮 prompt 已出现的实体以及多个暴露节点共享的实体）在模型输出文本中复现，记为弱使用（`+α * weakRatio`）；同一任务随后若再触发 `assoc_read`，仅补足差额至 `+α`。
   - **指数衰减与纠正降权（`-β`）**：超过 `nonUseGraceMs` 宽限期未被使用的边按 `hebbian.decayHalfLifeMs` 分片幂等指数衰减；当 Evaluation 记录 `withdraw` / `retract` / 非 `achieved` 纠正或 `user-feedback:not-achieved` 时，对 lookback 窗口内最近暴露或会话关联边施加 `-β` 惩罚。所有边权严格夹逼在 `[weightMin, weightMax]` 并追加审计记录到 `assoc_hebbian_events`。
6. **WP22 版本化参数档案与自调参（Slice S2）**：
   - 将 `{decayHalfLifeMs, maxHops, maxItems, hysteresisDeltaMilli, sourceWeightsPct}` 持久保存在不可变版本链 `assoc_param_profile_versions` / `assoc_param_profile_heads` / `assoc_param_profile_events` 中（基于 `@dsh-enhanced/assistant-growth-contract` 规范 JSON 与 SHA-256 digest 验真；若活跃行校验失败则逐级回退到经核验的父版本）。
   - **自动收紧**：当窗口样本达到 `minSample` 且超时率、纠正率、低使用率或单来源噪声率超标时，按有界离散阶梯单步收紧（如降 `maxHops`/`maxItems`、缩 `decayHalfLifeMs`、升 `hysteresisDeltaMilli` 或下调高噪声来源权重）并自动进入 `observing` 观察期。
   - **放宽重放门控**：任何参数放宽（含混合收紧与放宽）均禁止直接自动采用，必须绑定不可变 `holdoutSeal`（`assoc_param_relax_proposals`）并通过 `assoc_replay_episodes` 同步热路径重放与留出健康核验（`timeouts <= parent`、`p99Ms <= hotPathBudgetMs`、`usedHits >= parent` 且 `usedHitsGain > noiseExposedGain`），决策记入 `assoc_param_relax_decisions`。
   - **精确版本回退与防震荡黑名单**：观察期内若超时率、纠正率或使用率出现显著退化，立即回退至精确 `parent_version` 并将退化配置 `params_digest` 写入 `assoc_param_rolled_back_digests`，防止后续周期重复震荡采用。
7. **S2 遥测账本（Schema v2）**：在既有 `assoc_step_metrics`、`assoc_exposures` 与 `assoc_holdout_assignments` 基础上新增 `assoc_read_events`、`assoc_task_telemetry`（对称记录注入组与留出组的轮数/步数/token/成本）与 `assoc_replay_episodes`，供 `dsh-rsi growth-report` 第 6 节输出在线指标与密封留出对照。

## 权限与数据

- **文件系统**：仅读写 `databasePath`（及其 `-wal` / `-shm` 伴随文件，Schema v2 本地 SQLite 账本）与同目录 `holdout.seed`；父目录权限强制 `0o700`，数据库与种子文件权限强制 `0o600`（拒绝符号链接与非当前 UID 文件）。
- **网络**：无（S1–S2 仅本地内存索引与 SQLite 持久化；`webLearning.enabled` 默认 `false`）。
- **子进程**：无。
- **凭据**：无（`holdout.seed` 为本地匿名分区 HMAC 密钥，不访问用户账号、模型 API 或外部凭据）。
- **浏览器**：无。
- **安装脚本**：无。

## 兼容性

详见仓库 [兼容性基线](../../docs/compatibility.md)。
