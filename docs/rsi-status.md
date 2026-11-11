# RSI 当前状态

更新：2026-11-11。完整成功条件见[验收合同](rsi-acceptance.md)，发行门见[发布协议](releasing.md)。原始日志留 ignored `docs/evidence/` 或 CI artifacts，历史查 Git。

## 目标与当前安排

通过认证任务与反馈、原生 Agent、持久学习、独立验证、有界采用和回退，减少主人的协调与返工；以后续真实任务的质量、成本和人工介入判断收益。

本轮按[接手方案](handover/README.md)依次交付：A 普通续办、CI 均衡、B1 认证意图冻结已完成并有精确提交的 CI 证据；接下来是 B2/B3（受保护准则准备与真实路径验收）与 CI 第二阶段剩余项。

开发基线来自 Linux 进展，Mac 可开发、Linux `/data00` 独立副本验证，同一源码逐项核对。仅 dev/main，能力验证后推 dev，发布时才合 main。当前版本 0.1.67，工具链与 Host 范围见[兼容说明](compatibility.md)。

## 已有能力与边界

- Goals、WorkItems、原生执行、恢复、owner 反馈、独立验收与持久记忆已有实现；首次普通委托到动态准则仍未完整接通，现有 Verifier 依赖批准 profile。
- 已提交 Control Plane 能通过有预算的原生 continuation 消费修订请求，带 generation/receipt 与恢复栅栏；v3 审查证书不授权自动采用。
- 非 diagnosis 的 active 部署中的既有 owner 续办已交付：认证前台输入冻结原始目标/来源/供应者/有限预算，首个 worker 模型调用前准备验收；Host proof 绑定同一 occurrence/attempt、原生 outcome、不可变 run 与已结算预算（schema 18）。
- B1 已交付（开关默认关）：`goal_create` 可经 Delivery 的 agent 作用域只读证明冻结 owner 原文（分页+全文摘要）、owner 身份、binding、调用身份与 supplier；objective 必须逐字出现在原文中；冻结 supplier 对该 goal 内所有真实模型请求逐一校验；意图存私有 `.owner-intents` 侧库，edit 绑定目标被拒、记录失败回滚原生目标。仍缺 B2（受保护准则准备）与 B3（真实路径验收）。
- fresh supervised 默认 digest ceiling；首装预设/学习授权顺序、skip/decline 语义与普通使用收益仍待验收。
- Linux namespace/cgroup v1 是当前原生执行方向；cgroup v2、arm64、活 Home 迁移与旧 opt-in E2E 尚待验收。Docker 执行后端已移除。
- 主动准入、通知反馈、Dream 与 Web 均保留原边界；provider 接受不等于用户已读，Dream 默认关闭，长期收益未证明。

## 下一交付

1. B2：把"准备验收准则"做成受限、可审查的 Host 阶段（候选准则 → 独立 Verifier 校验并封存 contract/digest → worker 只读），复用现有 task-acceptance-contract 与 Verifier，不新建并行任务循环。
2. B3：至少两种普通自然语言任务从空账本跑到独立结果验收，覆盖错误/陈旧状态拒绝、零 worker 请求的不可判定准则、跨会话重启与 owner 更正。
3. CI 第二阶段剩余项：`plugin-control-plane` 单文件 `source-create-service.spec.ts`（约 1046s）仍是包测试硬下限；按测量拆分该文件并只对该包提高 worker 数，不删用例。

## 最近验证

- B1 + CI 第二阶段（提交 `5785f536`）：Linux 冷标准 `pnpm check` **EXIT 0 / 2130s**；根 102 文件 1619 passed / 2 skipped，39 包 11298 passed / 271 skipped（Goals 379），39 dry-run packs，lint 0 warning；验证前后 2102 个文件 hash/bytes/mode 稳定，Mac 与 Linux 逐文件 0 差异；[CI 六 job 全绿](https://github.com/22-ai-00/dsh-enhanced/actions/runs/42958695745)。
- CI 实测（同 runner 类别）：linux-packages job 1638s → **1434s**，包测试 step 1349s → **1113s**（−17.5%）；根分片 554s / 715s（比值 1.29，基线 979s/158s=6.2）。包测试仍是关键路径，且新的硬下限是 `source-create-service.spec.ts` 单文件约 1046s。
- 新调度暴露并修复了三处既有脆弱点：pcp 一个集成用例历史 24–27s 贴近默认 30s（改为 90s，与同文件兄弟一致）；`owner-recall` 夹具两次 `Date.now()` 可能跨毫秒（改为一次读取）；`dsh-rsi-cli` 托管运行时锁在 EEXIST 与 stat 之间被释放时报 ENOENT（生产代码改为重试）。
- 完整门在本机需要三条前提：`DSH_TEST_PNPM_ROOT`、`pnpm_config_store_dir`、**短** `TMPDIR`；解析方法见[交接入口](handover/README.md)。
- 未验收：B2/B3 的真实委托路径、首装/学习、工程成长、主动性、真实模型/外部渠道与长期使用收益。没有发布 npm、升级生产 Home 或发送用户渠道消息。
