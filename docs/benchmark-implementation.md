# 固定任务与配对评测实施

工作包 04 延续自治实施账本的完整范围：固定任务集覆盖代码、研究、跨日、主动性、注入、撤销、目标变化和重复操作；同输入、同模型、同预算比较候选，多次运行并做记忆/规划/复核/成长消融。模型替换单列比较，不混入能力改进。最终必须取得真实 AgentLoop、云模型以及独立留出部署的结果，工程测试不能代替这些证据。

实现放在 Evaluation bundle 的 Host-only `benchmark` 子入口，不新增 Agent loop，也不把评测写入面暴露成模型工具。计划固定数据集、逐题输入/验收摘要、各变体模型/prompt/skills/tools/policy/runtime 版本和预算。计划开始后不可覆盖；每个任务/重复/变体形成唯一 cell，执行前持久记账，崩溃中断的 cell 保持 unknown，不能为得到好分数自动重跑。另建新计划才能重跑整组。

配对 seed 对同题同次的变体一致，执行顺序轮换，降低先后影响；当前 native executor 的 seed 用于配对与调度，不作为提供商采样参数发送。已验证成功率分母包含失败、未知和缺测；重复结果按任务聚类，避免把同题重复当独立样本。输出成功率与区间、配对胜负/差值、token/费用/延迟/返工/人工介入分布，缺失量明确标记。任一比较臂存在缺测或 unknown 时，不给出收益差值与区间；不能把基线未知当失败来制造增益。报告不授予晋升权限。

Host adapter 负责创建干净且等价的执行环境、载入确切变体、限制实际预算、调用原生 AgentLoop、收集真实计量、等待资源停止及调用独立验收。返回的版本和输入摘要必须与冻结计划一致。评测协调器额外限制墙钟期限并拒绝超预算、非静止或身份不符的结果；异步超时不会被描述成已强制终止 OS 进程。

开发集可以分发输入与验收供诊断。隐藏留出必须由独立 evaluator 保管，候选生成仅能拿到开发集；本仓库与执行用户同 UID 的文件不能提供该隔离。计划只带留出摘要，adapter 在评测时接收相应输入而不接收答案；报告只回传聚合数据。固定公开任务不能被重命名为隐藏留出。实际隔离仍与工作包 08–10/16 联合验收。

当前实施次序：冻结协议与统计 → 耐久运行账本与有界协调器 → 固定任务及原生 Host adapter → 操作入口/真实模型/独立留出验证。每一步记录真实进度，工作包 04 完整验收前保持实现中。


## 独立留出 provider 协议与 Host 生命周期

`@dsh-enhanced/assistant-evaluation/benchmark/holdout` 现在提供独立留出 provider 的实验性 Host SDK。该子入口是 inert module：import 不会挂载插件、启动子进程、打开数据库或注册模型工具；plain `runIndependentHoldout()` 也必须由可信 Host 显式传入 plan、stores、authority factory 与 delegate factory。插件内调用使用 `runIndependentHoldoutInContext(ctx, options)`，由当前 Cordis Fiber 的 `ctx.effect()` 持有 journal/evidence descriptors、authority/delegate session 和 AbortController。卸载时 effect abort 运行、等待有界清理并关闭两个 store；自然完成后同样释放资源和 effect。Cordis 只负责生命周期所有权，不提供 OS、凭据或隐藏数据隔离。

协议固定为 `dsh-benchmark/independent-holdout/v1`，operator 先固定 exact dataset `{id, version, digest}` 和 Ed25519 public key，Host 再验证有序的 signed `manifest → input → verdict → finish`：

- manifest 只携带公开 case identity、domain、input digest 与 acceptance digest，并把数据集 digest 绑定到这些 commitments；
- input 把临时 input bytes 绑定到 manifest、plan digest、exact cell 和 input digest，不携带 acceptance material；
- verdict 把 authority 判定绑定到同一个 case/cell、input/acceptance commitment 及 Host 提交的 exact output digest；
- finish 绑定完整 cell 数，以及按冻结计划顺序排列的 signed-verdict envelope digests。

签名证明 envelope 来自 operator pinned key，digest 证明内容一致；二者都不证明数据集在候选生成前的历史冻结时间。`acceptanceDigest` 是 commitment，不是加密或保密边界，低熵答案仍可能被猜测。完整独立验收还需要外部只增透明 anchor 或等价的事前冻结证据，以及候选执行体无法读取/改写的 authority 部署。

每个 cell 的私有 input 只交给 delegate，raw output 只发送给 authority 的 verdict operation。Host 在请求结算后尽力清零其持有的 input/output arrays；journal、content-addressed evidence 和 report 只写 commitments、signed manifest/verdict/finish、Host metrics、execution evidence digest、quiescence 和 output digest，不写 signed input envelope 或 raw input/output。该“不持久化”只描述 SDK 自己的存储，不能约束外部 provider、delegate、模型端或同 UID 进程。

资源用量和停止状态由 Host delegate 返回并由 runner 按冻结 versions/budget 重验，elapsed latency 由 runner 计量；authority 不负责资源计量。当前没有独立于可信 Host adapter 的 meter，所以这些 metrics 仍是 Host 自计量证据。缺失 token/tool/cost（当金额预算存在）、版本漂移、超预算、非 quiescent、provider/协议错误、取消或清理无法确认都会产生 unknown，并阻止后续 cell。

恢复不隐式重放：完整 journal 与完整 completion marker 可以离线递归重验，且不会重新启动 authority 或 delegate；unknown 直接返回。completed prefix、stale running intent、无 finish marker 的 completed journal，以及 marker/plan/evidence 漂移均在 provider startup 前失败关闭。v1 没有 durable provider resume token。尤其在最后一个 cell，finish marker 先于 runner 的 SQLite `finish()` 发布；若进程在两者之间真实崩溃，重启会保留 running intent，operator 必须确认旧执行已经停止，再显式 `BenchmarkStore.interrupt()` 记为 unknown，不能把 marker 当作 SQLite 成功终态。

`openHoldoutProvider()` 使用一条串行 NDJSON stdio session，固定 child `cwd` 为 `/`，完全替换为 operator 显式 environment，不继承 Host environment，并对帧、stderr、ready/request/close/kill 设置上限。它要求 executable 是绝对 canonical pathname，但没有把 executable fd/inode 绑定到 `spawn`，无法抵抗校验后的 pathname 替换。当前集成测试的 authority 是仓库 fixture 启动的同 UID synthetic child；它证明真实子进程 transport、签名协议、持久化边界和重启重验行为，不证明独立 UID/账号/机器、真实 operator holdout、真实模型调用或线上收益。WP04 因此仍为实现中。


## 原生开发集入口

`./benchmark/native` 复用 `AgentRegistry.create()` 与生产 `AgentLoop`，每个 cell 使用新 Context、Session 与临时目录。直接接原生入口是因为 Automations 的 `reconcileSystem` 会修改自动化定义并注入 Growth 上下文，不适合此阶段冻结单次输入与空能力环境；日常 Automation 路径没有被复制或替换。首批是 8 道公开合成研究/注入题，答案由纯函数严格判断，模型不接收验收对象。引用必须覆盖用于计算、候选排除和规则判断的来源，规则已纳入输入摘要；只有正确答案与引用、完整成功终态、完整计量和资源释放同时满足，才记录 completed。

默认 `research-v1` 只比较 persona，四个能力开关均为 false。新增 `memory-v2` 将真实 PersonalMemory/Policy 接入同一原生 AgentLoop，见下节；SDK 的完整规划/复核/成长消融仍待接入与验证。配置示例（摘要需替换为可信适配器文件的实际 SHA-256）：

```json
{
  "id": "my-plan",
  "cases": ["calculate-reagent-mass", "injection-fabricated-citation-bait"],
  "variants": [
    { "id": "baseline", "role": "baseline", "persona": "按用户任务作答。" },
    { "id": "candidate", "role": "candidate", "persona": "核对事实、单位及来源后作答，并复核引用。" }
  ],
  "model": {
    "provider": "your-provider", "model": "your-model", "temperature": 0,
    "maxOutputTokens": 1000,
    "inputUsdMicrosPerMillionTokens": null, "outputUsdMicrosPerMillionTokens": null,
    "adapterDigest": "REPLACE_WITH_ADAPTER_SHA256",
    "tokenCounterDigest": "REPLACE_WITH_ADAPTER_SHA256"
  },
  "budget": { "durationMs": 90000, "inputTokens": 12000, "outputTokens": 1000, "costUsdMicros": null, "toolCalls": 0 },
  "repeats": 2, "seed": 60906
}
```

本例为 8 个 cell，计划最多输入 96,000 / 输出 8,000 tokens，金额未知。配置不包含密钥；可信模块自行通过宿主凭据服务解析。每次请求固定 provider/model/temperature/maxTokens/system 与空工具，执行前预留最大输入输出预算，完成后对真实 usage 再核验。提供商可能忽略 seed 或采样参数，不能宣称确定性复现；固定模型别名也不能阻止远端悄悄替换权重。

`inputTokenUpperBound` 属于可信 Host 合约，不是本 SDK 内置的模型 tokenizer。适配器应提供与其序列化一致的可靠上界，关闭提供商内部重试，并遵循 DSH 的计量：非缓存输入、cache read、cache write 为互斥分项，三者之和为总输入；reasoning 是 output 的子集。总输入、输出、各分项、totalTokens 的一致性与整数溢出均被核验。若只使用字节估算，必须显式选择 `inputLimitMode: "estimate"`；该模式不声称输入上界，不接受金额预算。返回量超过预留值时记录 unknown 并停止，不能回溯撤销该次远端消费。运行时版本摘要包含协议与安装包版本，不是完整可执行文件供应链证明。


## 首轮真实模型证据

2026-09-06 使用用户 web 现有模型配置，执行两题、两 persona、各两次的完整配对计划。8 次均取得完整观测，共输入 2,084 / 输出 164 tokens，金额未知；两方案均通过 2/4，配对收益为 0。计算题未满足完整答案/引用验收，注入题通过。首轮只保存答案摘要，无法从报告进一步区分答案计算错误与引用缺漏；后续需要增加不泄露隐藏答案的独立判定诊断，不能猜测失败原因或修改判定器将这批失败改成成功。

[脱敏计划与结果](evidence/benchmark-web-smoke-2026-09-06.json) 包含逐 cell 计量、验收摘要和完整报告；无密钥、模型原始答案或私有提供商地址。前两次适配器接线失败均按 unknown 保留，修复后另建完整计划。提供商仍使用匹配的旧版 runtime，尚未验证 web profile 的新版安装与交互路径。小样本公开开发题的零差异区间不代表没有泛化差异，也不能作为推广或高权限自治授权依据。


## Memory 的真实检索对照

使用 `suite: "memory-v2"` 与以下两个变体；两组 persona 必须完全相同，baseline 的 memory 为 false、candidate 为 true。任务列表由 `dsh-benchmark corpus --suite memory-v2` 给出。公开输入摘要覆盖当前任务、资料、全部记忆 fixture（包括不可见和撤回项）与快照预算，验收对象单独绑定，模型输入不含 oracle。

```json
{
  "suite": "memory-v2",
  "variants": [
    { "id": "baseline", "role": "baseline", "persona": "核对当前证据后回答。", "memory": false },
    { "id": "candidate", "role": "candidate", "persona": "核对当前证据后回答。", "memory": true }
  ]
}
```

上述片段并入完整配置，不能单独作为配置文件。每 cell 创建自己的 Memory/Policy SQLite、workspace、Session 和 headless principal。Host 按真实 `propose → decideProposal` 审批公开种子，两臂都有相同知识库；baseline 的 snapshot 授权关闭，candidate 由 PersonalMemory 的每步 context 自动召回。所有 memory_* 工具按 agent scope 禁用，persona 不直接拼接记忆。实际模型输入包括候选的 runtime snapshot，计量必须涵盖它。其他 owner/workspace、敏感、过期、撤回数据不会因此变成可见记录。

六题是同步的公开开发集，涵盖 journal 适用条件/反例、预算不足的 claim 分歧、不可见记录、已撤回经验与记忆中的注入。它们不证明跨日自主执行或任意自然语言矛盾识别；检索收益包含额外信息可用性的贡献，不应解释为基础模型的推理能力提高，也不能代替独立留出。

## 订阅线路的观测预算

[Codex 适配器](../scripts/benchmark/codex-subscription-adapter.mjs) 使用真实 CodingSubscriptionAdapter、live SessionStore 与 AgentRegistry attestation，复用现有登录，不启动外部编码 CLI，不自动重试。配置 `provider: "codex-subscription"`、指定实际 model，使用 `temperature: null`、`inputLimitMode: "estimate"`、`outputLimitMode: "observed"`，价格与 cost budget 为 null。工厂在原生服务初始化之后接收 `{ ctx, workspace }`，确保 cwd 和 live Session 身份一致。

该线路不支持远端 max-output 参数，因此 `maxOutputTokens` 在 observed 模式只参与完成后核验，不发送为提供商控制。输入估算不是 tokenizer；actual usage 超过估算但仍在预算内可记录，超过预算则 unknown 并停止后续样本。计划将 `maximumInputTokens`/`maximumOutputTokens` 标为 null，另列观测核验阈值。此模式不能保证硬性 token/费用上限。

需要硬性金额预留时，选择支持 provider output limit 的线路与可靠输入上界，提供 input/cacheRead/cacheWrite/output 四类费率；缺任一项会在初始化适配器前拒绝。输入按三类价格的最大值预留，实际金额按互斥类别计价，一次向上舍入到 USD micros。即便预检通过，远端超出协议或计量缺失仍可能产生无法追回的费用，unknown 不会被当作零成本成功。


`memory-v1` 保留首轮公开试验的原始题目与判定，可按原计划复现。`memory-v2` 是单独版本，明确当前资料 ID、Memory provenance URI 与 `claim:<key>` 的引用约定；改进题目说明后必须建立新计划，不会重写 v1 的失败结果。


## Memory 真实模型开发试验

2026-09-07 使用同一 `codex-subscription/gpt-5.6-terra`，两个冻结版本各执行 24 次无工具请求。v1 的严格答案与引用验收为 baseline 2/12、candidate 1/12；候选核心答案正确但引用格式多不满足要求，保留原判定。v2 在新题目版本中明确来源 ID/URI/claim marker 约定，得到 baseline 2/12、candidate 12/12（10 对改善、2 对持平，无未知）。完整计划、逐 cell 答案与计量见 [原始试验证据](evidence/memory-benchmark-2026-09-07.json)。这只是公开开发题中的检索可用性收益，不是隐藏留出或基础模型智能提升证据。

本切片最终工程验证（2026-09-12）：Evaluation 36 files / 293 passed，根 `pnpm check` 退出 0，合计 5,154 passed / 1 skipped，33 个 dry-run pack。provider startup 取消、迟到资源清理、POSIX 同组后代清理、独立 Node 清理等待及 startup cleanup 错误传播已补回归；进程组数值复用和脱组后代不属于强 OS containment 保证。完整命令、源码哈希、TraeX 审查处理和限制见[本批证据](evidence/wp04-independent-holdout-provider-2026-09-12.json)。
