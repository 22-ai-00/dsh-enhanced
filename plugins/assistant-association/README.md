# @dsh-enhanced/assistant-association

面向 DeepSeek Harness 的亚 5ms 进程内存双缓冲关联图与联想召回层（Slice S1–S4）：将 `personal-memory`、`assistant-goals`、`assistant-work-items`、`assistant-automations`、`personal-wiki`、`assistant-skills`、`event-triggers`、`assistant-dreaming`、受限隔离 Web 学习产物与确定性任务片段（Delivery + Evaluation 混合账本）统一建图并持久保存在本地 SQLite（Schema v4）中，在每步模型调用前完成同步 Aho-Corasick 实体匹配、CJK bigram BM25 回退与 ≤2 跳邻接表扩散，注入单段滞回 `<association>` 上下文块并提供 `assoc_read(id)` 按需读取工具（对 `'web'` 节点附带 `sourceUrl` 与 `fetchedAt`  provenance）；同时支持基于隐式使用信号的有界 Hebbian 边权更新、WP22 版本化参数档案自调参与精确回退、独立授权的空闲做梦建边（`low` 信任与双端失效级联）、`observe` 态 `work-items` 信号发射、通过 WP04 守卫的非留出片段聚类、隐式低可信信号与生产评估池馈送，以及默认关闭、独立授权的隔离只读兴趣驱动 Web 学习（S4）。

## 安装

本插件依赖 `@dsh-enhanced/assistant-policy`（通过 `inject: ['assistantPolicy']` 门控）。其余可选 Host peers（`personalMemory`、`assistantGoals`、`assistantWorkItems`、`assistantAutomations`、`assistantDelivery`、`assistantEvaluation`、`personalWiki`、`assistantSkills`、`eventTriggers`、`assistantDreaming`、`assistantVerifier`、`systemPrompt`、`tools`）均通过 `peerDependenciesMeta.*.optional = true` 延迟绑定，缺失时按可用来源优雅降级：

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-policy
dsh plugin --profile web add @dsh-enhanced/assistant-association
dsh --profile web --dump-config
```

在 `dogfood` 预设中，本插件默认开启本地联想召回（`enabled: true`, `localOnly: true`），不额外触发审批弹窗；S2 的 Hebbian 更新与 WP22 参数自调参均在本地有限界限内运行，而 S3 独立授权轨道（`dreaming.enabled`、`intakeSignal.enabled`）与 S4（`webLearning.enabled`）在 `dogfood` 预设中保持显式关闭（`false`）。

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
| `dreaming.enabled` | `boolean` | `false` | S3 空闲做梦建边总开关（默认关闭，需独立 Policy `evolution` / `dream.build` 授权）。 |
| `dreaming.intervalMs` | `integer` | `3600000` (1h) | 同一 owner scope 两次做梦运行的最小间隔（ms）。 |
| `dreaming.idleMinMs` | `integer` | `1800000` (30m) | 触发做梦前要求距离最近活动的最小空闲时长（ms）。 |
| `dreaming.maxPairsPerRun` / `maxAbstractionsPerRun` / `maxSynonymsPerRun` | `integer` | `16` / `4` / `16` | 单轮最多生成的长程 `'dream'` 边、`'abstraction'` 桥接节点与 AC 同义词上限（`0..1000`）。 |
| `dreaming.nodeTtlMs` | `integer` | `2592000000` (30d) | 做梦派生节点/同义词的默认过期 TTL（ms；`0` 表示不过期）。 |
| `dreaming.allowModelSynthesis` | `boolean` | `false` | 是否允许模型辅助合成标记（默认关闭，仅本地确定性建边）。 |
| `dreaming.budgetId` / `dreaming.budgetAmount` | `string?` / `number?` | — | 可选关联 Policy 预算标识与单次额度（`> 0`）。 |
| `intakeSignal.enabled` | `boolean` | `false` | S3 `work-items` 观察态信号发射开关（默认关闭，需独立 Policy `automation` / `intake-observe` 授权）。 |
| `intakeSignal.minScore` | `number` | `0.75` | 活跃目标关联项触发 `observe` 信号的最小分值阈值。 |
| `intakeSignal.maxSignalsPerHour` | `integer` | `10` | 同一 owner scope 每小时最多发射的观察态信号条数。 |
| `intakeSignal.cooldownMs` | `integer` | `3600000` (1h) | 同一 `(goalNode, targetNode)` 对的信号冷却间隔（ms）。 |
| `intakeSignal.maxSummaryBytes` | `integer` | `1024` | 脱敏摘要 UTF-8 字节上限（`64..65536`）。 |
| `intakeSignal.sourceId` | `string` | `'assistant-association'` | 写入 `WorkItemIntakeInput.source` 的来源标识（`/^[a-z][a-z0-9-]{0,63}$/u`）。 |
| `intakeSignal.budgetId` / `intakeSignal.budgetAmount` | `string?` / `number?` | — | 可选关联 Policy 预算标识与单次额度（`> 0`）。 |
| `clustering.entityWeight` / `toolWeight` | `number` | `0.4` / `0.6` | S3 片段聚类的实体 Jaccard 与工具名序列 LCS 权重。 |
| `clustering.minSimilarity` / `minClusterSize` | `number` / `integer` | `0.55` / `3` | 片段聚类最小相似度与最小成簇片段数（`>= 2`）。 |
| `clustering.reAskWindowMs` / `reAskMinEntityJaccard` | `integer` / `number` | `3600000` (1h) / `0.5` | 隐式重问（`re-ask`）检测回看窗口（ms）与最小实体 Jaccard 阈值。 |
| `webLearning.enabled` | `boolean` | `false` | S4 受限兴趣驱动 Web 学习总开关（默认关闭，需独立 Policy `web.learn` 授权与非空 `allowedDomains`）。 |
| `webLearning.allowedDomains` | `string[]` | `[]` | 允许抓取的 HTTPS 域名白名单（拒绝 IP、通配符、`localhost`、`.local`/`.internal`/`.arpa`；空名单失败关闭）。 |
| `webLearning.seedUrls` | `string[]` | `[]` | 允许的 `https:` 检索/种子 URL 模板（支持 `{query}` URL 编码替换，主机须命中 `allowedDomains`）。 |
| `webLearning.allowSubdomains` / `allowIpv6` | `boolean` / `boolean` | `false` / `false` | 是否允许白名单子域名匹配及 IPv6 公网地址。 |
| `webLearning.isolationMode` | `'subprocess' \| 'in-process'` | `'subprocess'` | 抓取隔离模式（默认在空 `0o700` 沙箱目录和剥离凭据环境的子进程中执行）。 |
| `webLearning.intervalMs` / `idleMinMs` / `cooldownMs` | `integer` | `3600000` (1h) / `900000` (15m) / `86400000` (24h) | 运行最小间隔、最近活动空闲门槛与同 URL 重复抓取冷却期（ms）。 |
| `webLearning.maxInterestsPerRun` / `maxRequestsPerRun` / `maxPagesPerRun` | `integer` | `3` / `5` / `3` | 单轮最多提取的兴趣主题数、HTTP 请求次数与成功页面上限。 |
| `webLearning.maxBytesPerRequest` / `maxTotalBytesPerRun` | `integer` | `524288` (512 KiB) / `1048576` (1 MiB) | 单次请求与单轮总响应字节上限。 |
| `webLearning.maxRequestsPerDay` / `maxBytesPerDay` | `integer` | `20` / `5242880` (5 MiB) | 按 UTC 日持久化的每日请求与字节硬上限（跨进程重启保留）。 |
| `webLearning.maxDurationMs` / `requestTimeoutMs` / `maxRedirects` | `integer` | `30000` / `10000` / `2` | 单轮总时长上限（ms）、单次请求超时（ms）与最大重定向跳数（`0..10`）。 |
| `webLearning.discoverLinks` / `nodeTtlMs` | `boolean` / `integer` | `false` / `1209600000` (14d) | 是否发现同白名单页内链接与 `'web'` 节点默认过期 TTL（ms；`0` 表示不过期）。 |
| `webLearning.budgetId` / `webLearning.budgetAmount` | `string?` / `number?` | — | 可选关联 Policy 预算标识与单次额度（`> 0`）。 |

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
7. **S2–S4 遥测与成长反馈账本（Schema v4）**：在既有 `assoc_step_metrics`、`assoc_exposures` 与 `assoc_holdout_assignments` 基础上提供 `assoc_read_events`、`assoc_task_telemetry` 与 `assoc_replay_episodes`（S2），Schema v3 新增 `assoc_dream_runs`、`assoc_intake_signals`、`assoc_skill_candidates`、`assoc_implicit_signals` 与 `assoc_eval_pool`，Schema v4 新增 `assoc_web_learning_runs`、`assoc_web_learning_budget_usage` 与 `assoc_web_learning_fetches`（支持 `v0/v1/v2/v3 -> v4` 幂等迁移）；供 `dsh-rsi growth-report` 第 6 节输出在线指标、跨窗口留出对照及 S3/S4 计数。
8. **空闲做梦建边与双端失效级联（Slice S3）**：`dreaming.enabled: true` 时（默认 `false`），在空闲门（`idleMinMs`、`intervalMs`、无运行中 Agent）、Policy `evolution`（`dream.build`）与可选预算及 Delivery active route 全部通过后，确定性生成 `trust: 'low'` 的长程 `'dream'` 边、桥接 `'abstraction'` 节点/边与绑定 `ownerScopeKey` / `trust` 的 AC 同义词（`assoc_synonyms`），并可投影可选 `assistant-dreaming` idea。所有派生节点、边与同义词均在 `assoc_derived_from` 登记全部支撑端点，任一端点被撤回（`withdrawSource`）、冲突抑制（`suppressNodeConflict`）、版本更新或 TTL 过期清理（`sweepExpiredNodesNow`）时立即级联硬删除。
9. **扩展来源接入（Slice S3）**：
   - `personal-wiki`：通过 `inspectHostPages` 与 `onPageChange` 投影页面（`draft` 为 `low` 信任，其余为 `trusted`），归档或删除即撤回；`assoc_read` 实时校验 `wiki` 读取策略与有效状态。
   - `assistant-skills`：通过 `inspectOwnerActiveSkills` 与 `onSkillChange` 投影同 owner 活跃未退役技能（`trusted`），退役即撤回。
   - `event-triggers`：通过 `inspectOwnerSources`、`inspectOwnerOutboxEvents`、`subscribeSourceChanges` 与 `registerIntakeObserver` 投影经凭据/token 脱敏的 `low` 信任事件摘要与可选 TTL，来源失效或过期即撤回。
   - `assistant-dreaming`：通过 `inspectIdeas` 与 `onIdeaChange` 投影 `low` 信任 idea，拒绝或撤回即清理。
10. **观察态 `work-items` 信号发射（Slice S3）**：`intakeSignal.enabled: true` 时（默认 `false`），在严格排除留出任务、校验活跃 `goal` 节点与目标节点均非敏感且分值 ≥ `minScore`、通过 Policy `automation`（`intake-observe`）及冷却/每小时上限门控后，构造仅含 10 个闭集字段（不含 `objective`、`acceptance` 或 `groupMessage`）的 `WorkItemIntakeInput`，仅调用 `assistantWorkItems.recordIntake` 写入严格 `observe` 态，绝不调用 `admit` 或 `admitDecision`，并记录到 `assoc_intake_signals`。
11. **片段聚类、隐式低可信信号与生产评估池（Slice S3）**：
    - `runClusteringNow` 基于实体 Jaccard 与工具名序列 LCS 相似度（`clustering.*`）对非留出任务片段聚类，经 WP04 守卫（`assertWp04CandidateOrigin` / `assertCandidateGenerationInput`，强制拒绝任何留出任务或缺失种子）生成类型化技能候选存入 `assoc_skill_candidates`（仅候选，不自动激活）。
    - 从重复/重问（`re-ask`）、重做（`redo`）与 owner 纠正（`owner-correction`）聚类记录 `low` 信任隐式信号到 `assoc_implicit_signals`（仅作候选/报告输入；向 `assistantEvaluation.append` 上报时强制标记 `self-reported`）。
    - 仅当 Evaluation `upsert` 回执同时携带 `acceptance-contract` 与 `verification-receipt` 证据且通过 `assistantVerifier` 溯源核验时，按留出分区写入 `assoc_eval_pool`（`replay` / `holdout`），并在 `retract` / `withdraw` 时立即标记撤回。
12. **受限兴趣驱动 Web 学习（Slice S4）**：
    - 默认关闭（`webLearning.enabled: false`）；启用后必须依次通过非空 `allowedDomains` 白名单、紧急停止、间隔/空闲门、持久化 UTC 日预算（`assoc_web_learning_budget_usage`）、Delivery active route、可选 Policy 预算与 `Policy.authorize({ action: 'web.learn', resource: { kind: 'network', id: 'assistant-association:web-learning' } })`，任何门控拒绝均产生 0 次抓取与 0 节点。
    - 兴趣提取（`extractWebLearningInterests`）仅消费同 owner 非留出、非敏感（`sensitivity !== 'private'`）目标/工作项/做梦节点/低覆盖片段；`extractWebLearningInterests` / `scrubInterestText` 的脱敏（剥离路径、邮箱、IP、UUID、工作区/身份片段与常见凭据模式，并截断为 ≤3 词 / ≤64 字符查询）仅作为启发式纵深防御（defense-in-depth），与显式 opt-in 授权（`webLearning.enabled` + Policy `web.learn`）、非私有敏感度过滤（排除 `sensitivity = 'private'`）、非空域名白名单（`allowedDomains`）及无凭据隔离子进程共同生效。
    - 默认以 `isolationMode: 'subprocess'` 在空 `0o700` 临时工作目录和无凭据环境（仅 `PATH`/`LANG`/`LC_ALL`/`TZ`）中执行只读 HTTPS `GET`（强制域名白名单、公网 IP DNS 钉扎、禁止私网/本地/元数据 SSRF、禁用写工具与凭据头、流式字节上限与单轮/每日预算耗尽即停并保留已成功页面）。
    - 生成的节点统一标注 `kind: 'web'`、`trust: 'low'`、`sourcePlugin: 'assistant-association:web'`、`metadata.sourceUrl`、`metadata.fetchedAt` 与 `expiresAt`（TTL 过期或 `withdrawWebSource` 均沿 `assoc_derived_from` 级联删除节点与共现 `'entity'` 边）；`assoc_read(id)` 返回 `sourceUrl`、`fetchedAt` 与 `<association_item trust="low" ...>` 不可信边界，且 `allowLowTrust: false` 时对热路径与 `assoc_read` 完全隐藏。

## 服务接口概览

- 热路径与读取：`contextSnapshot`、`shouldSuppressMemoryKeywordHits`、`readById`、`isTaskInHoldout`、`bindHeadlessPrincipal`、`syncAll` / `syncScope` / `flush` / `refreshIndex`。
- S2 自调参与衰减：`currentParamProfile`、`paramTuningStatus`、`requestParamTuning`、`reconcileParamTuning`、`runHebbianDecayPass`。
- S3 扩展方法：`runDreamingNow`、`listDreamRuns`、`sweepExpiredNodesNow`、`emitIntakeSignalNow`、`listIntakeSignals`、`runClusteringNow`、`listSkillCandidates`、`listImplicitSignals`、`listEvalPool`。
- S4 Web 学习方法：`runWebLearningNow`、`listWebLearningRuns`、`listWebLearningFetches`、`getWebLearningBudgetUsage`、`withdrawWebSource`。

## 权限与数据

- **文件系统**：仅读写 `databasePath`（及其 `-wal` / `-shm` 伴随文件，Schema v4 本地 SQLite 账本）与同目录 `holdout.seed`；父目录权限强制 `0o700`，数据库与种子文件权限强制 `0o600`（拒绝符号链接与非当前 UID 文件）。当启用 `webLearning.enabled` 且处于默认 `isolationMode: 'subprocess'` 时，每轮创建并立即清理独立的空 `0o700` 临时沙箱工作目录。
- **网络**：S1–S3 无网络请求。S4 仅在显式开启 `webLearning.enabled: true`、配置非空 `allowedDomains` 且通过 Policy `web.learn` 授权时发起只读 HTTPS `GET` 请求（固定 443 端口、公网 IP DNS 钉扎、SSRF 防护、手动重定向校验、禁止写入与凭据请求头、到达请求/字节/时长预算即停）。
- **子进程**：S1–S3 无子进程。S4 默认 `isolationMode: 'subprocess'` 在空 `0o700` 沙箱目录派生独立只读 `web-learning-worker` 子进程，仅透传 `{ PATH, LANG, LC_ALL, TZ }`，无写工具或凭据，超时执行 `SIGTERM` → `SIGKILL`。
- **凭据**：不读取、传递或存储用户账号、Cookie、API 密钥或 OAuth token（`holdout.seed` 仅为本地匿名分区 HMAC 密钥；S3 做梦/信号受 Policy `evolution`/`automation` 门控，`wiki` 读取校验 `wiki` 规则，S4 Web 学习剥离全部凭据环境变量并在提取兴趣前脱敏私有上下文）。
- **浏览器**：无。
- **安装脚本**：无。

## 兼容性

详见仓库 [兼容性基线](../../docs/compatibility.md)。
