# @dsh-enhanced/assistant-association

面向 DeepSeek Harness 的亚 5ms 进程内存双缓冲关联图与联想召回层（Slice S1）：将 `personal-memory`、`assistant-goals`、`assistant-work-items`、`assistant-automations` 与确定性任务片段（Delivery + Evaluation 混合账本）统一建图并持久保存在本地 SQLite 中，在每步模型调用前完成同步 Aho-Corasick 实体匹配、CJK bigram BM25 回退与 ≤2 跳邻接表扩散，注入单段滞回 `<association>` 上下文块并提供 `assoc_read(id)` 按需读取工具。

## 安装

本插件依赖 `@dsh-enhanced/assistant-policy`（通过 `inject: ['assistantPolicy']` 门控）。其余可选 Host peers（`personalMemory`、`assistantGoals`、`assistantWorkItems`、`assistantAutomations`、`assistantDelivery`、`assistantEvaluation`、`systemPrompt`、`tools`）均通过 `peerDependenciesMeta.*.optional = true` 延迟绑定，缺失时按可用来源优雅降级：

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-policy
dsh plugin --profile web add @dsh-enhanced/assistant-association
dsh --profile web --dump-config
```

在 `dogfood` 预设中，本插件默认开启本地联想召回（`enabled: true`, `localOnly: true`），不额外触发审批弹窗；`dreaming`、`intakeSignal` 与 `webLearning` 在 S1 保持显式关闭（`enabled: false`）。

## 配置项

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 是否启用本地关联图与上下文注入。 |
| `localOnly` | `boolean` | `true` | S1 本地联想模式标记。 |
| `databasePath` | `string` | `$DSH_HOME/assistant-association/state.sqlite` | SQLite 绝对路径（测试支持 `:memory:`）。 |
| `holdoutSeedPath` | `string?` | `<dirname(databasePath)>/holdout.seed` | HMAC 留出种子文件路径（`0o600`）。 |
| `holdoutSeed` | `string?` | — | 可选显式留出种子（16–512 字符，派生 32 字节密钥；不写入 SQLite）。 |
| `holdoutRateBps` | `integer` | `1250` | 密封留出比例，范围 `[1000, 1500]` bps（10%–15%）。 |
| `hotPathBudgetMs` | `number` | `4.5` | 同步热路径时间预算（ms），超时立即降级为空注入并记录 `assoc-timeout`。 |
| `maxItems` / `minItems` | `integer` | `8` / `5` | 每次注入条数上限（`5..8`）与最小滞回保持窗口（`1..8`）。 |
| `maxContextTokens` | `integer` | `400` | `<association>` 上下文块 token 预算上限。 |
| `maxHops` | `integer` | `2` | 最大图扩散跳数（`1..2`）。 |
| `hopTopN` | `integer` | `32` | 每跳裁剪保留的最高分节点数（`4..128`）。 |
| `maxFanoutPerNode` | `integer` | `128` | 按边权降序截断的单节点最大邻接展开数。 |
| `hysteresisDelta` | `number` | `0.15` | 滞回阈值 `δ`：无显著超越且无撤回/失效时保持已注入条目稳定。 |
| `decayHalfLifeMs` | `integer` | `1209600000` (14d) | 节点时间衰减半衰期（ms）。 |
| `syncIntervalMs` | `integer` | `15000` | 周期对账同步间隔（ms）。 |
| `allowHeadlessScope` | `boolean` | `false` | 无 `assistantDelivery` 时是否允许确定性 headless scope（默认 fail closed）。 |
| `allowLowTrust` | `boolean` | `true` | 是否允许召回低信任（`low`，如 `external` 记忆）条目；在 `<association>` 中以 `| low |` 标注，且 `assoc_read` 附带不可信数据边界封装。 |
| `allowSensitive` | `boolean` | `false` | 是否允许召回或经 `assoc_read` 读取 `sensitive` 条目（默认 fail closed 过滤）。 |
| `dreaming.enabled` | `boolean` | `false` | S3 做梦建边开关（S1 保持关闭）。 |
| `intakeSignal.enabled` | `boolean` | `false` | S3 work-items 观察态信号开关（S1 保持关闭）。 |
| `webLearning.enabled` | `boolean` | `false` | S4 隔离网页学习开关（S1 保持关闭）。 |

## 架构与行为边界

1. **同步热路径与双缓冲索引**：`systemPrompt.context` 为严格同步回调。插件在内存中维护不可变双缓冲结构化数组（Structure-of-Arrays）+ 权重降序 CSR 邻接表 + 扁平混合 BMP/CSR Aho-Corasick 自动机 + CJK bigram BM25 索引；冷启动超过 2,000 行时分片异步构建索引，构建完成前自动回退至 `personal-memory` 原有关键词召回。
2. **撤回级联（`derivedFrom`）与实时墓碑**：当记忆删除/替换、目标清除、工作项/定时任务删除或 Evaluation 记录 `revision.action === 'withdraw'` 时，立即在内存活跃索引翻置节点墓碑位并清理会话缓存，同时在单个 SQLite 事务中沿 `assoc_derived_from` BFS 级联删除所有派生节点、边与同义词。
3. **密封留出（10–15% `HMAC(seed, taskId)`）**：使用 `HMAC-SHA256(seed, "assistant-association/holdout/v1\0" + taskId) mod 10000` 确定性划分留出任务；留出任务不注入 `<association>`，种子文件权限固定 `0o600`，且不写入 SQLite 或暴露给模型。
4. **`assoc_read(id)` 安全重校验**：模型按需调用 `assoc_read(id)` 读取完整正文时，实时重查当前 `owner` 血缘、`workspace`/`preset` 作用域、敏感度与来源有效性，并以不可信数据边界 `<association_item>` 包裹输出；越权与不存在统一 fail closed。

## 权限与数据

- **文件系统**：读写 `databasePath`（及其 `-wal` / `-shm` 伴随文件）与同目录 `holdout.seed`；父目录权限强制 `0o700`，数据库与种子文件权限强制 `0o600`（拒绝符号链接与非当前 UID 文件）。
- **网络**：无（S1 仅本地内存索引与 SQLite 持久化；`webLearning.enabled` 默认 `false`）。
- **子进程**：无。
- **凭据**：无（`holdout.seed` 为本地匿名分区 HMAC 密钥，不访问用户账号或外部 API 凭据）。
- **浏览器**：无。
- **安装脚本**：无。

## 兼容性

详见仓库 [兼容性基线](../../docs/compatibility.md)。
