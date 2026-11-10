# RSI 当前状态

更新：2026-11-10。完整成功条件见[验收合同](rsi-acceptance.md)，发行门见[发布协议](releasing.md)。原始日志留 ignored `docs/evidence/` 或 CI artifacts，历史查 Git。

## 目标与当前安排

通过认证任务与反馈、原生 Agent、持久学习、独立验证、有界采用和回退，减少主人的协调与返工；以后续真实任务的质量、成本和人工介入判断收益。

本轮按[接手方案](handover/README.md)收束未验收补丁：能力 A（既有 owner 续办 + Isolation 续租测试前提）已通过 Linux 冷标准完整门与独立复核，单独提交。工作区不再保存该能力的未验收恢复补丁。

开发基线来自 Linux 进展，Mac 可开发、Linux `/data00` 独立副本验证，同一源码逐项核对。仅 dev/main，能力验证后推 dev，发布时才合 main。原 Linux 活跃工作树保留，12 个旧未提交文件已有可恢复历史 patch。当前版本 0.1.67，工具链与 Host 范围见[兼容说明](compatibility.md)。

## 已有能力与边界

- Goals、WorkItems、原生执行、恢复、owner 反馈、独立验收与持久记忆已有实现；首次普通委托到动态准则仍未完整接通，现有 Verifier 依赖批准 profile。文件准则证明当前状态，尚不证明本次生成。
- 已提交 Control Plane 能通过有预算的原生 continuation 消费修订请求，带 generation/receipt 与恢复栅栏；v3 审查证书不授权自动采用。采用前配对收益与入队时供应者冻结仍需完善。
- 非 diagnosis 的 active 部署中的既有 owner 续办已交付：从认证前台输入冻结原始目标/来源/供应者/有限预算，首个 worker 模型请求前准备验收；Host proof 绑定同一 occurrence/attempt、原生 outcome、不可变 run 与已结算预算（schema 18 可空 `host_proof_json`，旧行 NULL，旧 writer 拒绝 18）；未绑定验收时持有 `ready` 报告，晚绑定/重试/重启只认当前 worker/occurrence/receipt；timeout 保持未验证。仍不覆盖首次任意委托、动态准则与产物生成来源绑定。
- fresh supervised 默认 digest ceiling；首装预设/学习授权顺序、skip/decline 语义与普通使用收益仍待验收。学习成功不等于后续任务改善。
- Linux namespace/cgroup v1 是当前原生执行方向；cgroup v2、arm64、活 Home 迁移与旧 opt-in E2E 尚待验收。Docker 执行后端已移除。
- 主动准入、通知反馈、Dream 与 Web 均保留原边界；provider 接受不等于用户已读，Dream 默认关闭，长期收益未证明。

## 下一交付

1. 交付 CI 八路径 patch：安装器拆组与根分片均衡，核对用例集合，测精确提交的根片、包 job 和总 run。四份旧资料已在交接中收敛。
2. 打通首次自然语言委托与受保护的动态准则，再修首装/学习、工程成长和主动性，按能力逐个提交；完整顺序及验收见[剩余方案](handover/remaining-work.md)。

## 最近验证

- 能力 A 冷标准完整门（Linux，`timeout 5400 pnpm check`）：**EXIT 0 / 2521s**；根 98 文件 1613 passed / 2 skipped，39 包 11280 passed / 271 skipped，39 个 dry-run pack，lint 0 warning、0 error；验证前后 2098 个源文件 hash/bytes/mode 稳定。定向检查 isolation 6/6、work-items 187/187、automations 185/185、delivery 295/295、memory-learning 4/4、lark 176/176。独立只读复核 **PASS**（逐条 file:line 证据）。
- 完整门在本机需要三条前提：`DSH_TEST_PNPM_ROOT`（原生 `@pnpm/exe`）、`pnpm_config_store_dir`（已填充的 pnpm store）、**短** `TMPDIR`（RSI 夹具的 Unix socket 路径须 ≤100 字节）。缺失时分别表现为 `release-adapter` 快速失败、`npm cohort pnpm store 不存在`、`runtime observer: invalid configuration`，都不是代码缺陷；解析方法见[交接入口](handover/README.md)。
- 包测试曾因包并发 6 出现一次 load-induced flake（`assistant-goals` 的 event-wait 用例，单独 362/362 通过两次）；最终门改用 CI 同参 `VITEST_MAX_WORKERS=2`、`DSH_TEST_CONCURRENCY=4` 后 EXIT 0。
- 已提交运行基线 `8e608d4a`：[CI #819](https://github.com/22-ai-00/dsh-enhanced/actions/runs/42762151021) 六 job 成功；历史 Linux 全检 EXIT 0 / 2318s，根 1610 pass/4 skip、包 11244 pass/271 skip、39 packs。仅属于已提交能力。
- 未验收：CI 均衡与真实分片收益、首次自然语言委托、真实模型/外部渠道与长期使用收益。没有发布 npm、升级生产 Home 或发送用户渠道消息。
