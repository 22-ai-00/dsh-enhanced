# RSI 当前状态

更新：2026-11-10。完整成功条件见[验收合同](rsi-acceptance.md)，发行门见[发布协议](releasing.md)。原始日志保存在忽略的 `docs/evidence/`，历史实现与检查查 Git。

## 目标与开发基线

通过认证任务与反馈、原生 Agent、持久学习、独立验证、有界采用和版本回退，减少主人协调与返工。以后续真实任务的质量、成本和人工介入衡量改进；模型自评、安装成功与工具退出码不能替代任务验收。

以 Linux 当前源码及其未提交进展为开发来源，Mac 开发、Linux `/data00` 独立副本验证，运行前后核对源码摘要。只保留 `dev`、`main`；能力验证后提交、推送 `dev`，仅发布时合入 `main`。当前包版本 `0.1.67`；Host 兼容范围 `>=0.2.1-rc.2 <0.3.0`，候选 `0.2.2-rc.1`，工具链见[兼容说明](compatibility.md)。

## 本轮能力：结构化修订请求到独立证书

- `source revision-enqueue` 写入的请求由原生 Automations wake 只读发现，在预算约束的 continuation occurrence 中认领；空队列暂停，退出取消并等待在途工作。
- schema 40 保存递增认领代次和 instruction/job 关联，重试保持原始期限；旧认领不能结算新认领，登记中断不能误报已受理。`revision-show` 只读查询活 WAL，关联损坏显示 unknown；accepted 不代表作业或验证成功。
- 指令来源的 prepared 产物经过准确的 owner、父版本、文件与期限绑定，接入真实 Verifier 和 v3 签证。**v3 不承诺实际执行，也不授权自动采用。** 结构化补丁请求不等于从聊天文字自动取得修改授权。
- 冷构建先生成 Evaluation 公开 core，再构建 Delivery、Isolation 和完整 Evaluation。最近 GitHub CI 的共同首错是提前编译 benchmark 而缺少 Isolation 产物，该顺序修复覆盖此原因。远端验收以对应 `dev` 提交的全部 CI job 为准。

## 当前边界与阻断

- **普通任务与主动性**：Goals、WorkItems、事件跟随、认领、报告、恢复和 owner 反馈已有实现。inferred 自动准入尚未完整传递原目标与验收合同；`holdReport` 只持有已绑定验收的 ready 报告，不能保证所有完成通知已验收。首次明确委托还需受信来源准入及 Host worker 验收接线。
- **持久学习**：认证事实/经验、三份有限授权、更正撤回、有限召回已有实现。fresh supervised 默认 `digest` ceiling，不等于自动执行；首装预设与学习授权顺序仍需修复。长期真实召回和决策收益未验收。
- **工程成长**：原生隔离、源码构建、独立审查、有界动态采用、父版本 CAS 与回退已有实现。可选修订收益投影误走创建账本，采用前候选样本仍缺；不能据部署关联推断收益。修订审查从活 owner 路由解析模型并绑定到验证认领，未在 CLI 请求入队时冻结。
- **平台与渠道**：Linux namespace/cgroup v1 是当前原生执行方向；cgroup v2、arm64、活 Home 原地迁移及旧 opt-in E2E 的迁移尚未验收。Docker 执行后端已移除，旧配置只读解码并拒绝继续执行。provider 接受投递不等于用户已读或任务达成，长期通知收益仍待观察。
- **做梦与 Web**：做梦默认关闭，只生成私有 idea 与有界摘要，尚无自动晋升；owner-console 已有 GUI 冒烟，长期真实使用仍待观察。

## 下一交付与验收

1. 修复全新 supervised 的预设/学习授权顺序和 skip/decline 语义；实际编译配置，核对后置装配幂等、真实失败传播和必要的服务重启。
2. 打通一类明确委托：从认证 Inbox 冻结原目标、实际模型与验收要求，在首个 worker 模型调用前生成绑定本次来源的真实合同；按 item/occurrence/attempt 核对事实、产物与回执。错误事实、旧产物、旧回执必须被拒绝，不能仅通过固定格式检查。
3. 修复修订收益投影，以同输入、供应商和预算的独立配对验证取得采用前样本；缺样本明确阻断，再验证有限试用、退化和精确回退。
4. 修复 `check:quick` 的 Git 筛选假绿，迁移当前 Host/native 端到端场景；诊断分别显示配置、运行就绪和任务已验证。保留独有回归后再清理旧资料。

## 最新验证

- Linux、Node 24.7.0、pnpm 11.7.0，代码快照 `c5192b29`：标准 `pnpm check` **EXIT 0**，耗时 2318 秒。清单、零警告 lint、完整构建、类型检查通过；根测试 **1610 passed / 4 skipped**，39 包测试 **11244 passed / 271 skipped**，39 包 dry-run pack 通过。独立代码与证据复核 PASS；事实文档更新单独核对差量。
- 空 `lib` 的完整 Linux 构建通过。真实 CP/Automations/AgentLoop/Verifier 组合与签名双账本通过；模型供应和外部构建/runner 为 fixture，不证明线上模型、生产隔离执行或自动采用。
- 根跳过两项依赖本地发布标签的资产检查和两项 macOS 专项；包测试保留平台/opt-in 条件，额外 Linux runtime 归档未配置。此前一轮 release adapter 超时未稳定复现，已增加阶段诊断；不声称未知根因已修复。
- 2086 个源码文件在完整检查前后摘要、大小、模式一致。`TMPDIR=/data00/home/jiataorui/t` 避开已复现的 socket 路径限制。Mac 清理的生成物原分配量约 515 MiB，旧修改有备份；六个无独有提交的旧分支已删除。原 Linux 工作树及其活动进程保留。
- 本轮未升级生产 Home、调用真实模型或进行飞书投递，也未发布 npm 或验收长期普通使用收益。详见 `docs/evidence/code-review-2026-11-10/`；GitHub 检查结果随对应提交记录。
