# RSI 当前状态

更新：2026-11-10。完整成功条件见[验收合同](rsi-acceptance.md)，发行门见[发布协议](releasing.md)。原始日志留 ignored `docs/evidence/` 或 CI artifacts，历史查 Git。

## 目标与当前安排

通过认证任务与反馈、原生 Agent、持久学习、独立验证、有界采用和回退，减少主人的协调与返工；以后续真实任务的质量、成本和人工介入判断收益。

**用户已暂停本轮功能开发，转交另一工具。** 可移植入口是[接手方案](handover/README.md)，其中包含未验收源码补丁、具体剩余计划、CI 优化、真实失败结果及原 Linux 改动归属；新 clone 无需本地忽略目录。普通任务补丁尚未应用到提交的运行代码。

开发基线来自 Linux 进展，Mac 可开发、Linux `/data00` 独立副本验证，同一源码逐项核对。仅 dev/main，能力验证后推 dev，发布时才合 main。原 Linux 活跃工作树保留，12 个旧未提交文件已有可恢复历史 patch；新交接副本同步 GitHub dev。当前版本 0.1.67，工具链与 Host 范围见[兼容说明](compatibility.md)。

## 已有能力与边界

- Goals、WorkItems、原生执行、恢复、owner 反馈、独立验收与持久记忆已有实现；首次普通委托到动态准则仍未完整接通，现有 Verifier 依赖批准 profile。文件准则证明当前状态，尚不证明本次生成。
- 已提交 Control Plane 能通过有预算的原生 continuation 消费修订请求，带 generation/receipt 与恢复栅栏；v3 审查证书不授权自动采用。采用前配对收益与入队时供应者冻结仍需完善。
- fresh supervised 默认 digest ceiling；首装预设/学习授权顺序、skip/decline 语义与普通使用收益仍待验收。学习成功不等于后续任务改善。
- Linux namespace/cgroup v1 是当前原生执行方向；cgroup v2、arm64、活 Home 迁移与旧 opt-in E2E 尚待验收。Docker 执行后端已移除。
- 主动准入、通知反馈、Dream 与 Web 均保留原边界；provider 接受不等于用户已读，Dream 默认关闭，长期收益未证明。

## 下一交付

1. 恢复普通续办 39 路径 patch，补强 Isolation 续租测试的确定性前提，再跑完整 Linux 门与独立复核；严格绑定原目标、供应者/预算、当前 occurrence/attempt，验收前持有报告。
2. 交付 CI 八路径 patch：安装器拆组与根分片均衡，核对用例集合，测精确提交的根片、包 job 和总 run。四份旧资料已在交接中收敛。
3. 打通首次自然语言委托与受保护的动态准则，再修首装/学习、工程成长和主动性，按能力逐个提交；完整顺序及验收见[剩余方案](handover/remaining-work.md)。

## 最近验证

- 已提交运行基线 `8e608d4a`：[CI #819](https://github.com/22-ai-00/dsh-enhanced/actions/runs/42762151021) 六 job 成功；历史 Linux 全检 EXIT 0 / 2318s，根 1610 pass/4 skip、包 11244 pass/271 skip、39 packs，独立复核 PASS。仅属于已提交能力。
- 未验收普通快照 `b0628837`：最新 39 包诊断 EXIT 1 / 714s，38 包通过，11279 pass/1 fail/271 skip；唯一失败为 Isolation renewing lease 用例，未 pack、未新 full。此前两次标准 full 分别失败于 Delivery deadline 和 MemoryLearning 初始准入；两个夹具修复已保存在 patch，后续相应包通过，但不能拼成全检 PASS。
- 用户停止开发后仅做资料与恢复校验，未继续运行完整检查。没有发布 npm、升级生产 Home 或验证真实模型/外部渠道及长期收益。交接包独立复核 PASS，精确命令和限制见[核验与归属](handover/verification.md)。
