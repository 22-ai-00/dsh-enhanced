# 自治目标接力（2026-09-09）

> 历史快照：截至 2026-09-12，`dev` 已推进到 `89751c3`，本文的提交、WIP 和“缺升级实现”等状态已经过时。接手请先读 `docs/autonomy-delivery-path-review-2026-09-08.md` 顶部 2026-09-12 基本 RSI 决定及当前实施账本，再核对实际 git/进程；下文只供追溯，不能作为当前待办重做。

## 目标与权威入口

完整目标：落实全部规划，打造高智能、高主动、能长期自主执行并持续自我改进的智能体，同时兼顾高权限、安全边界和安装使用便利。

保持全部 18 个工作包，不把目标改写为当前测试容易通过的子集。先读 `AGENTS.md`，再读：

1. `docs/agent-autonomy-implementation.md`：完整验收账本；当前仍为 3 已验证 / 13 实现中 / 2 待做，不按条目数计算完成百分比。
2. `docs/autonomy-delivery-path-review-2026-09-08.md`：顶部当前执行决定，历史章节不是新的待办。
3. 本文：更新于上述账本之后的本机未提交进展。
4. 需要追溯原始要求时读 `docs/autonomy-handoff-2026-09-06.md`、`docs/agent-intelligence-autonomy-roadmap-2026-09-06.md` 和 `docs/agent-growth-gap-evidence-2026-09-06.md`。

仓库 `/data00/home/jiataorui/work/github/dsh-enhanced`，分支 `dev`。本文编写时已交付基线为 `b7b4b160553af12570da29b0b72cae6fbe56930e`，已推送且远端核对一致。不要只依赖本文的快照：先检查当前 git、进程和文件，再决定是否拉取、继续或验证。保留本机 WIP，禁止 reset/clean 覆盖接力改动。

## 用户已经明确的执行偏好

- 开发速度按依赖和证据推进，不按人类日/周排期等待。两完整工作周的主动性观察要求已取消，长期效果在交付后使用中打磨。
- 一个主要完整用户能力，最多一个独立辅助任务。并行用于同一交付流程或互不依赖的文件；主协调负责接口和整合，独立 verifier 复核。
- 开发期间定向测试，冻结后运行规定的根 `pnpm check` 和相关安装检查，通过就提交交付；不把数千个测试通过当作全部目标完成。
- 提交并推送 `dev` 已获授权。外部业务消息、真实日历或 GitHub 业务操作仍需准确已有资源授权，配置/凭据存在不等于资源授权。
- **真实模型测试使用 TraeX 独立测试会话及其模型，不使用 Codex 订阅额度，不把 DeepSeek 凭据当共同前置。** 当前实际使用 `traex-agent / gpt-5.6-terra`。
- 合理使用 codex-with-chatgpt；此前所需内置浏览器不可用，未取得 ChatGPT 网页复核。不要伪称已咨询或因此停下实现；可用原生独立 verifier。
- 不反复重跑同一失败实验。保留环境，先定位确定性原因；只有具体修复或新可检验假设才追加模型调用。不得扩权限、降低增益门槛、挑样本或清除 unknown 制造通过。

## 已交付基线及当前 WIP

`b7b4b16` 已交付技能写前的原生文件观察、精确成功运行的捕获展开、TraeX E2E 路由和单层 JSON 参数兼容。基线根检查：352 文件 / 4,294 测试 / 0 跳过 / 33 个打包；证据 `docs/evidence/skill-runtime-traex-2026-09-09.json`。这是工程交付，完整真实 canary 当时未通过。

本机后续改动尚未提交，接手时以 `git diff` 为准：

1. `plugins/assistant-skills/src/definition.ts`、`capture-expansion.ts`、对应 `tests/capture-expansion.spec.ts`：允许同一技能两次不同 durable run 的内部步骤编号相同；按外层调用区分展开步骤，保留各自参数、顺序与文件观察。拒绝把同一个 durable invocation 的重复回执展开为两次执行。
2. `plugins/traex-acp-provider/src/prompt.ts`、`tests/prompt.spec.ts`、README：工具可用性不是授权；拒绝后不得重试/绕过，允许继续独立的已授权工作或如实报告阻断；保留已授权工作立即行动的引导。序列化测试保留准确 call ID、错误工具结果和后续用户指令。提示词不是权限硬边界。
3. `plugins/assistant-skills/src/service.ts`、`tests/external-holdout-service.spec.ts`、README：比较配置发现信息补充 `kind` 和 `executionTool`；本地配置指向 `skill_compare`，外部配置指向 `skill_qualify`，支持前瞻生成器的配置额外给出 `canaryExecutionTool: skill_canary`。工具说明明确 canary 先比较、所有门槛通过才部署。此项晚于真实 attempt8，尚无新真实模型验证。

Skills 前两文件的定向证据：`/tmp/dsh-skill-multi-run-check.log`，2 文件 / 30 测试，`.exit=0`；`/tmp/dsh-skill-multi-run-types.log`、`/tmp/dsh-skill-multi-run-build.log` 各对应 `.exit=0`。

TraeX 定向证据：`/tmp/traex-acp-provider-prompt-vitest.log`，8 文件 / 161 测试，`/tmp/traex-acp-provider-prompt-vitest.exit=0`；类型检查 `/tmp/traex-acp-provider-typecheck.log` 与 `.exit=0`；构建 `/tmp/dsh-traex-authority-build.log` 与 `.exit=0`。

前两项代码/定向测试已获独立 verifier PASS；比较发现信息的后续改动需要补审。根检查日志 `/tmp/dsh-traex-authority-delivery-check.log`，退出文件 `/tmp/dsh-traex-authority-delivery-check.exit`。该检查开始后才追加比较发现信息改动，所以即使退出 0，也不能声称冻结后的完整最终检查已完成。接手后先确认检查是否终态，再对最终版本执行所需验证。不得与尚在运行的构建或原代理同时改写同一构建产物。

## 最新真实运行：attempt8

命令：

```sh
CI=true PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
DSH_WEB_REAL_PROVIDER=traex-agent DSH_WEB_REAL_MODEL=gpt-5.6-terra \
DSH_HOLDOUT_TEST_IMAGE=sha256:321f72f637710ad1a69425cd0915a7a8a6101f325080ab5eefc19f244eeaefc8 \
DSH_CAPTURE_RETAIN_FAILURE=1 \
pnpm exec playwright test --config scripts/e2e/playwright-real-canary.config.mjs
```

- 日志 `/tmp/dsh-real-canary-traex-attempt8.log`，退出码 1，约 5 分钟，23 次模型 dispatch。
- 保留环境 `/tmp/dsh-real-capture-WKEGs6`，Session `session-1e0e4805-c345-4ae4-90c8-efe11959b75f`；有界摘要 `/tmp/dsh-traex-attempt8-summary.json`。这些 `/tmp` 文件仅在同机存在。
- 4 次 Host 启动、3 个 Goal、2 个已捕获候选、1 次成功技能试跑、1 个已启用版本。首次捕获、重启后恢复已删除产物、新鲜独立验收、主人显式启用和第二候选捕获通过了当次前序断言。没有 bash 请求。
- 最后在 `skill_compare` 批准前停止：请求 `profile_id=real-order-summary-v2`，但该配置只存在于 `externalHoldouts`，`compare()` 只查询本地 `comparisons`。真实状态查询此前只返回 id/version/expiry/maxComparisons，没有区别或执行工具提示；这是第三项 WIP 的直接依据。
- 比较未执行，0 comparison / 0 deployment。没有正向收益、canary 晋升、回滚或本次最终结果回读的完成证明。不得将前序通过描述为完整 E2E 通过。
- 当前实验终态，没有继续中的真实模型/浏览器/Host。不要重放旧未知调用或清除旧状态。

此前 attempt7 的 bash 请求被测试挡在批准之前；原生拒绝结果本身没有丢失。已失败的非只读调用不能作为可复用成功轨迹，因此不要把“拒绝后继续”改成同一失败轨迹也能成功捕获。

## 接手后的最短路径

1. 接管并收口上述已有 WIP：核对比较发现信息的定向测试、独立复核和最终冻结检查；通过后提交推送，不重写已完成模块。
2. 新比较元数据有确定性证据后，再用 TraeX 做有界真实验证。普通请求由模型选择工具；不要让测试规定步骤顺序。零/负增益候选拒绝部署是正确结果，不追求必然晋升。
3. 不把完整 canary 的成功作为其他 18 项共同前置。独立推进正式安装的升级/卸载、配置和任务状态保留、迁移失败恢复；当前 `dsh plugin add` 加 activation 没有通用事务恢复，重复安装不是可靠升级。复用已有 Control Plane 和安装器，不再建第二套生命周期。
4. 真实 GitHub 与 Calendar 有具体测试资源和权限时分别验收。当前 Calendar exact-ID 来源已实现（`bf04c89`），真实来源仍未验收；GitHub 场景入口 `docs/live-repository-e2e.md`、`scripts/e2e/repo-live-input.mjs`，过去传输替身不能算真实远端完成。不要重复询问已未答复的资源问题或访问私人资源来代替授权。
5. 保留所有余下要求：3–5 类真实技能、失败/重复轨迹自动提案、Memory/策略同预算收益、多域评测/消融、各部署类型监控回滚、高权限隔离/停止/补偿、签名发布和完整安装体验。没有固定日历观察门槛。

最终完成必须逐项对照完整账本及真实用户结果验收。测试数量、组件数量、已有提交或漂亮文档都不能单独证明完整目标已完成。
