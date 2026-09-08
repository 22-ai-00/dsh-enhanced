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
