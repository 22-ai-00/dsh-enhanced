# 原生 Goal 策略评测

`strategy-v1` 是一个独立的公开开发集比较：`direct` 使用原生 Goal 和隔离产物验收，`adaptive-strategy` 在相同模型、persona、预算和非策略能力下额外获得真实 `goal_strategy`。它不复用旧的单次、无工具 native suite。

开发集有四道公开合成代码题：整数汇总、合并相交或接触区间、按频次再字典序输出词频，以及带无解标记的依赖拓扑排序。它们用于验证装配与比较流程，不是 holdout，也没有真实模型收益结论。模型只接收每题的公开 objective、提示和公开示例；私有 verifier vectors 只在独立隔离验证时使用。

## 配置与计划

从 [strategy-benchmark.config.json](examples/strategy-benchmark.config.json) 复制模板，替换所有路径、镜像和两个 SHA-256。零 SHA 是可解析占位值，不能作为可运行的真实配置。`image` 必须是不可变 `sha256:` digest；adapter 文件的实际 SHA-256 必须同时匹配 `adapterDigest` 和 `tokenCounterDigest`。

策略配置固定 `suite: "strategy-v1"`，包含任务 id、公共 persona、原生模型、每 cell 预算和 `execution` 的 model calls、单次输出及 Goal rounds。parser 在加载 adapter、创建目录或访问 Docker 前拒绝未知字段、accessor、非 plain snapshot、非公开 case、重复 case、非绝对/嵌套 state 根、可变镜像和不一致限额。

`inputLimitMode` 只能是 `upper-bound`，`outputLimitMode` 只能是 `provider`，且 `model.maxOutputTokens` 必须等于 `execution.maxOutputTokensPerCall`。有金额预算时四种 token 费率都必须存在。现有 Codex 订阅 adapter 所用的 estimate/observed 模式不能运行 strategy-v1。

```sh
dsh-benchmark corpus --suite strategy-v1
dsh-benchmark doctor --suite strategy-v1 --config ./docs/examples/strategy-benchmark.config.json
dsh-benchmark plan --config ./docs/examples/strategy-benchmark.config.json --output ./private/strategy-plan.json
dsh-benchmark run --config ./docs/examples/strategy-benchmark.config.json --adapter /absolute/trusted-adapter.mjs --database ./private/strategy.sqlite --output ./private/strategy-report.json
dsh-benchmark report --database ./private/strategy.sqlite --plan strategy-public-development --config ./docs/examples/strategy-benchmark.config.json --output ./private/strategy-report-copy.json
```

`doctor` resolves required Host packages and, with a config, performs a bounded offline Docker/image probe. It neither installs packages nor pulls images, and a ready response does not prove model access. `plan` does not invoke a model. `run` loads only the operator-selected trusted adapter and uses the configured fee schedule. No command installs or enables the strategy stack in a normal DSH profile.

## 执行、证据与报告

每个 cell 使用独立的 private workspace 和 runtime 目录；共用的私有 state 根位于全部候选 workspace 之外。执行安装真实 Goal、Goal round driver、Delivery owner、Policy、Isolation 和 Verifier；模型必须通过真实 `goal_create` 创建 exact objective，并经 `isolation_run` 导出固定 `answer.sh`。独立 verifier 在 immutable local image 中执行 artifact。每个验证向量有 5 秒完整作业期限，包含 Docker 装配和清理；它不是单纯 shell CPU 执行时间。冻结配置要求全部向量期限之和小于 step 窗口，两个分支使用相同限额。外层 meter 在首次模型请求前覆盖前台、父 Goal、child 和工具，使用预留与完整 usage 结算。

计划在开始前冻结公开语料摘要、完整私有任务摘要、模型、预算和当前已安装能力来源。运行时在每个实际父模型请求上对完整 persona、实际工具 schema 和 `assistantPolicy.inspectHostConfiguration()` 的完整 Policy 配置做核对。它也保存已解析安装源码的身份摘要。这些检查能发现普通配置或安装漂移；它们不承诺对同进程恶意 Host 代码、同 UID 文件系统攻击或远端 provider 实现作形式化 attestation。

全流程 deadline 覆盖装配、模型调用、隔离验证与关闭。缺少可信 usage、出现未结算预留、无法确认资源停止或无法读取完整证据时，cell 是 `unknown`。已保存的 unknown 不会被晚到结果升级，也不会被重放；串行运行不会继续下一个 cell。

详细 cell 观察与其内容摘要存储在配置的私有 state 目录，journal 只保存引用摘要。`report --config` 打开已保存观察，重建当前 strategy plan 并核对绑定后生成报告；它不重新激活已关闭 runtime、不调用 adapter，也不重放模型或 Docker 工作。报告将 unknown 和缺测单列，不能据此声称策略收益或推广资格。

## DeepSeek 生产模型入口

Evaluation 另外发布 `@dsh-enhanced/assistant-evaluation/benchmark/deepseek`，可直接作为 `--adapter` 的绝对文件路径。它复用 `assistant-deepseek-budget` 的固定官方请求、工具回放、完整 usage 校验与取消逻辑，不自动启用普通 profile 的任何插件。CLI 允许 pnpm 为这个受信 adapter 生成的硬链接，仍在导入前后核对内容摘要；配置文件继续要求单链接。先在评测安装目录显式安装同批 `@dsh-enhanced/assistant-deepseek-budget` 及其 Host peers；它是 Evaluation 的可选 peer，普通评测不必安装。

从 [DeepSeek 配置模板](examples/strategy-deepseek.config.json) 开始，在同一安装目录解析真实文件及摘要，然后填入模板的 `adapterDigest` / `tokenCounterDigest`：

```sh
node --input-type=module -e 'import { readFileSync, realpathSync } from "node:fs"; import { fileURLToPath } from "node:url"; import { createHash } from "node:crypto"; const path = realpathSync(fileURLToPath(import.meta.resolve("@dsh-enhanced/assistant-evaluation/benchmark/deepseek"))); console.log(JSON.stringify({path, sha256:createHash("sha256").update(readFileSync(path)).digest("hex")}));'
```

凭据由当前 Host `credentials` 服务解析 `DEEPSEEK_API_KEY` 引用；无该服务时读取同名环境变量。密钥不写入配置或报告。运行前由操作者在进程环境提供凭据，使用上文的 `doctor/plan/run/report` 命令并替换配置及 adapter 路径。doctor 检查所选模型包和隔离环境，不读取凭据、不调用模型；可运行的线路与模型效果需另外验证。

该入口固定 `deepseek-goal-metered` provider，支持现有生产契约的两个精确模型；契约到期后拒绝计数和派发。每次输入预留 **2,097,152 tokens**，完整响应后按含缓存的实际 usage 结算。这是保守上界，不是预估消耗。模板以最多 16 次调用给每 cell 保留 33,554,432 输入、65,536 输出 tokens；两个比较臂相同。每次输出上限 4,096，全部装配/模型/隔离/清理共 300 秒。金额预算及价格保持 `null`，不声称账户账单硬限。需要更紧预算时，不能用估算值替换上界。

计划和每次父请求的源码核对会额外覆盖实际解析的 DeepSeek 包与 credentials 包。模型线路、输出限制、温度、费用声明、生命周期或契约漂移均拒绝；更换包后需创建新计划，旧报告仍保留历史含义。该入口的本地 transport 替身验证不代表已调用真实供应商，也不证明策略优于直接执行。

## Super Relay Responses 入口（真实 token 计量）

Evaluation 还发布 `@dsh-enhanced/assistant-evaluation/benchmark/super-relay`，以绝对文件路径作为 `--adapter`，固定 `super-relay` provider 与单一 `auto_model/alwaysday1` 模型（网关侧自动路由）。它复用 `assistant-super-relay-budget` 生产 adapter 的 OpenAI **Responses** 请求/回放、完整 usage 校验与对每个不可信异步边界的硬竞速取消逻辑，不自动启用普通 profile 的任何插件。

该路由走与 DeepSeek 平级的 **token 强制计量模式**（`model.observationMode` 用默认值，无需填写）：Responses 响应真实回传 `input_tokens`/`output_tokens`/`total_tokens`（含 cached/reasoning 明细），按完整响应后的实际 usage 结算 input/output token。网关没有公开定价，因此四档费率与 `budget.costUsdMicros` 恒为 `null`——token 如实计量，金钱成本**绝不估算、绝不伪造**；任何非空费率都会被拒绝（"Super Relay tariff is unverified"）。每次输入预留 **200,000 tokens**，这是远低于该网关其他模型百万级窗口的保守 fail-closed 上限，不是对任一请求实际消耗的估算；需要更紧预算时不能用估算值替换上界。

凭证只按引用解析，插件绝不接受明文 key：操作者在运行环境 `export SUPER_RELAY_API_KEY=<真实 key>`（或经 dsh-credentials 配置同名引用），adapter 在每次生产请求时经 `@deepseek-ai/dsh-credentials` 解析当前值，不保留被替换的凭证。

从 [Super Relay 配置模板](examples/strategy-super-relay.config.json) 开始，在同一安装目录解析真实文件及摘要，再填入模板的 `adapterDigest` / `tokenCounterDigest`：

```bash
node --input-type=module -e 'import { readFileSync, realpathSync } from "node:fs"; import { fileURLToPath } from "node:url"; import { createHash } from "node:crypto"; const path = realpathSync(fileURLToPath(import.meta.resolve("@dsh-enhanced/assistant-evaluation/benchmark/super-relay"))); console.log(JSON.stringify({path, sha256:createHash("sha256").update(readFileSync(path)).digest("hex")}));'
```

计划和每次父请求的源码核对会额外冻结实际解析的 `@dsh-enhanced/assistant-super-relay-budget` 生产 lib 与 `@deepseek-ai/dsh-credentials`。模型线路、输出限制、温度、费用声明、生命周期或协议契约漂移均拒绝；契约（`super-relay-responses-2026-09-14`，**2026-10-14 到期**）到期后拒绝计数和派发，须用真实、非合成探针复核后续期，再创建新计划，旧报告仍保留历史含义。该入口的注入式工程层测试（stub `fetch`、不触网）只验证请求契约与生命周期，**不构成真实供应商证据**；策略是否优于直接执行，只认 Docker 隔离 + 真实 `https://super-relay.byted.org/v1/responses` endpoint 跑出来的配对结果（允许如实记录"无收益/不确定"）。

## TraeX 本地 call-count 入口

Evaluation 还发布 `@dsh-enhanced/assistant-evaluation/benchmark/traex`，同样以绝对文件路径作为 `--adapter`，固定 `traex-agent` provider 与单一 `gpt-5.6-terra` 模型。它复用 WP14 验证过的本机 TraeX ACP 链：`traex` 可执行文件在 `PATH` 上（或经 `TRAEX_COMMAND` 覆盖），登录态来自操作者全局 `~/.trae`，不接 API key、endpoint 或任何凭据值，零外部账户花费。它不自动启用普通 profile 的任何插件。

TraeX 的 ACP 流从不返回 token usage，因此该入口只接受 `model.observationMode: "observed-call-count"` 计量模式，与 DeepSeek 的 token 强制模式平级：一次正常结束（finish reason ∈ `stop`/`tool-calls`/`max-tokens`）的模型请求计一次 `modelCalls`；reserved/聚合 input、output tokens 恒为 0，usage 与 `costUsdMicros` 恒为 `null`，**绝不估算**。若 provider 意外发出 usage chunk，meter 直接判该请求失败而不是静默丢弃可能计费的数据。协调成本只报告 strategy 臂的"额外 model calls"与独立 verifier 的行为结果；token/金钱字段保持 `null`。预算中的 `inputTokens: 0` 与等于单次输出上限的 `outputTokens` 只是满足结构约束的占位值，不代表任何实测 token。

从 [TraeX 配置模板](examples/strategy-traex.config.json) 开始。calls 模式没有费率、金额预算、`inputLimitMode`/`outputLimitMode` 或 token-counter 上界；`adapterDigest` 与 `tokenCounterDigest` 仍必须同时等于 adapter 文件的实际 SHA-256。在同一安装目录解析真实文件及摘要：

```sh
node --input-type=module -e 'import { readFileSync, realpathSync } from "node:fs"; import { fileURLToPath } from "node:url"; import { createHash } from "node:crypto"; const path = realpathSync(fileURLToPath(import.meta.resolve("@dsh-enhanced/assistant-evaluation/benchmark/traex"))); console.log(JSON.stringify({path, sha256:createHash("sha256").update(readFileSync(path)).digest("hex")}));'
```

运行前确认 TraeX 登录态有效（`probeTraexReadiness`），再使用上文的 `doctor/plan/run/report` 命令并替换配置及 adapter 路径。`plan` 在该模式输出 `observationMode: "observed-call-count"`、`maximumModelCalls`、`maximumToolCalls`，并把所有 token/limit/cost 汇总字段置为 `null`。Goal 侧使用原生 calls 预算（按 `{provider, model}` 精确路由白名单），父 Goal 与两个 advice-only persona 子会话全部落在同一 TraeX 路由上，不重复注册 token meter。

计划与每次父请求的源码核对会额外覆盖实际解析的 `@dsh-enhanced/traex-acp-provider` 生产 lib。计量模式在三处绑定：operator 只在 `model.observationMode` 写一次，executor 派生明文 `plan.execution.observationMode` 进入 plan digest，evidence 解析时交叉断言 meter 自报与冻结计划一致；事后篡改任一副本都会被 digest 或交叉断言捕获。该入口的注入式工程层测试（假 `runText`/`discoverModels`/`verifyAuth`，不触网）只验证请求契约与生命周期，不代表已驱动真实 TraeX 子进程，也不构成策略增益或生产供应商证据。

### 2026-09-15 真实配对 run：persona 零触发的根因终审

在 Docker 隔离 + 真实 TraeX `gpt-5.6-terra`、120s/450s 时间预算下跑完整 16-cell 同预算配对（4 case × 2 repeat × 2 臂），16/16 achieved、零 retained、零伪造 token/cost、`promotionAuthorized=false`，但 **8 ties、Δ0、CI [0,0]，且 advice persona 0/16 触发**，因此该 run **不构成策略增益证据**。证据与对抗复核见 [strategy-traex-real-paired-2026-09-15.json](evidence/strategy-traex-real-paired-2026-09-15.json)。

零触发经代码与真实 transcript 双侧钉死为**模型在天花板 corpus 下自主选择不调用，而非接线/预授权缺陷**：

- `goal_strategy` 是纯模型自主工具，代码无任何自动 spawn 路径；仅 adaptive 臂注册（`tools.ts:21-33` 的 `service.strategyEnabled` 门，`strategy-goal-runtime.ts:149/154/250`），direct 臂从不装配。
- calls 模式预授权闸放行：`preauthorizeStrategy` 要求 `budget.hasMeter(options)===true`（`service.ts:1001-1008`），而 calls 模式 `hasMeter` 只返回 `#active && #routeAllowed(route)`、不查 meter map（`budget.ts:253-254`），route 对 `{traex-agent,gpt-5.6-terra}` 精确命中白名单（`budget.ts:303`），`#active` 整 run 恒 true（`budget.ts:94/144`，仅 teardown 翻 false）。
- 真实 transcript 铁证：`cal-state` 下恰好 8 个 adaptive 会话的每个 `request/header.header.tools` 都字面含 `goal_strategy`（每一轮请求都下发），但 8 个会话的 `tool/call` 序列只有 `goal_create -> isolation_run [-> goal_context|goal_checkpoint]`，`goal_strategy` 实际调用 **0/8**；同一活动 native goal round 内其它 goal 工具成功调用，证明 round 活跃、预授权管线正常。
- 触发语义：工具描述写明"on uncertain reasoning or repeated failed criteria"，而四个 `strategy-v1` 任务首轮 `isolation_run` 即被独立 verifier 接受，从未出现失败判据或真实不确定性，故无咨询动机——这是 **corpus 难度/触发语义天花板**。

下一步要测目标机制，必须换更难 corpus（多约束/对抗 verifier，首轮无法过验收）或注入首轮拒绝，使 goal 进入驱动 persona 咨询的状态，再用同一 call-count 配对 harness 复跑，先确认 `native.strategies>0` 与稳定的非 `-g1` 子调用块，才谈得上判断增益；不得靠调 prompt 制造增益。

## strategy-v2 难题开发集

`strategy-v2` 是与 v1 平级的独立公开开发集（dataset id `dsh-strategy-development-v2`），专门用于上一节的下一步：四道多约束、含精确边界陷阱的 POSIX shell 题，使首轮 artifact 有合理概率过不了独立逐字节验收，从而真正驱动失败判据与 persona 咨询。四题为：

1. `session-gap-split`：按相邻事件绝对时间差**严格大于** 300 秒切分会话（恰 300 秒不切）；原始值回退即跨恰好一个午夜（后续比较加 86400）；跨午夜时间戳按 mod 86400 渲染；输出 `start-end count`。
2. `closed-range-intersection`：按名累积闭区间交集（下界取 max、上界取 min）；`lo === hi` 的单点仍可行，仅 `max(lo) > min(hi)` 才对**任一**名输出唯一一行 `NONE`；否则按名 ASCII 字节序输出。
3. `greedy-paragraph-wrap`：空行分段、纯空白段忽略；段内所有空白折叠；宽度恰 40 的 greedy 填充（`长度 + 1 + 词长 <= 40` 才同行）；超长词独占不截断；段间恰好一个空行。
4. `quoted-csv-account-totals`：跳固定表头；双引号列状态机（列内逗号是数据、`""` 是字面引号）；按 (jurisdiction, account) 求整数分和，`-0` 视为 0、恰好归零仍输出；TAB 分隔、整行 ASCII 字节序。

每题只向模型公开 objective、提示和**一个**只演示格式与主规则、不暴露任何陷阱的公开示例；8 个私有验证向量（逐字节 stdin/stdout/exit）只在独立隔离验证时使用。全部 32 个私有向量的期望字节均由 POSIX-sh 参考实现产生，并在冻结 verifier image（dash + busybox awk）内逐字节比对锚定，不是手算结果。v2 的加入不改变 v1 dataset 的任何字节（测试钉死 v1 digest `b9e5dc4d…`），两个 suite 共用同一套 config/executor/runtime/evidence/projection，只在 config 层以 `suite: "strategy-v2"` 选择独立语料与 dataset 身份；私有 verifier 窗口仍须满足全部向量期限之和小于 step 窗口（每题 8×5000ms = 40000ms，故 v2 配置 `stepMaxDurationMs` 必须大于 40000）。

从 [strategy-v2 TraeX 配置模板](examples/strategy-v2-traex.config.json) 开始，命令与 v1 完全对称，只把 `--suite` 换成 `strategy-v2`：

```sh
dsh-benchmark corpus --suite strategy-v2
dsh-benchmark doctor --suite strategy-v2 --config ./docs/examples/strategy-v2-traex.config.json
dsh-benchmark plan --config ./docs/examples/strategy-v2-traex.config.json --output ./private/strategy-v2-plan.json
dsh-benchmark run --config ./docs/examples/strategy-v2-traex.config.json --adapter /absolute/traex.js --database ./private/strategy-v2.sqlite --output ./private/strategy-v2-report.json
dsh-benchmark report --database ./private/strategy-v2.sqlite --plan strategy-traex-development-v2 --config ./docs/examples/strategy-v2-traex.config.json --output ./private/strategy-v2-report-copy.json
```

真实重跑使用与 2026-09-15 完全相同的 call-count 配对 harness（Docker 隔离、`gpt-5.6-terra`、120s/450s、两 repeats、零外部花费），但必须用新的 plan id 与独立 state 根（同 id 不同 dataset/limits 会被 BenchmarkStore 拒绝）。首发只观测两件事：`native.strategies > 0`（strategy 工具被模型真实调用）以及稳定的非 `-g1` persona 子调用块；在此之前不声称任何策略增益，也不得通过修改 prompt 人为制造调用。

