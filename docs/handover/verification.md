# 交接核验与历史改动归属

更新：2026-11-10。本页记录交接所需的简短事实和限制；不是新一轮运行流水。功能目标已按用户要求暂停，未继续修复 Isolation 或启动完整检查。

## 源码与结果必须一一对应

最后已提交运行基线为 `8e608d4ab6ef0bd4bc015292fd15002801690589`，其 [CI #819](https://github.com/22-ai-00/dsh-enhanced/actions/runs/42762151021) 六 job 成功。历史 Linux 标准 `pnpm check` 在该能力源码快照 `c5192b29` 上 EXIT 0 / 2318s：根 1610 passed / 4 skipped、包 11244 passed / 271 skipped、39 dry-run packs。独立复核 PASS；真实模型、实际渠道及长期收益未由该检查证明。

本轮普通能力最后冻结快照为 `b0628837c7796cad961e778db4288dee374e36ba85afbb59e02e899f446b519e`，2086 源文件；归档 SHA-256 `327e8a96723c147e08e5a21b25ffba68565ae45fac7f69e1d2eb6b213f1eab56`。Mac 与 Linux 曾逐文件核对 SHA/bytes/mode，前后稳定。该快照包含当时状态页，恢复 patch 排除旧状态页，改由当前交接维护；新增交接文档后不能仍把整个 checkout 称为 b062。

| 源码/检查 | 命令与结果 | 能证明什么、不能证明什么 |
| --- | --- | --- |
| b17a1b77 标准全检 | `timeout 5400 pnpm check`，EXIT 1 / 1780s | 根 1611 pass/4 skip；Delivery 1407 pass/1 fail，deadline 用例在工具开始前结束；并发包被 first-fail 截断，未 pack |
| 414ae6a2 冷标准全检 | `timeout 5400 pnpm check`，EXIT 1 / 1750s | manifest/lint/build/typecheck、根 1611 pass/4 skip 通过；MemoryLearning 86 pass/1 fail，lost-ACK 用例在初始 WorkItem 准入前超时；未 pack |
| b0628837 定向夹具检查 | MemoryLearning typecheck EXIT 0 / 3s；完整 feedback integration EXIT 0 / 18s，4/4 | 修复后的夹具通过该组合；不是完整门 |
| b0628837 包诊断 | `timeout 5400 pnpm --recursive --no-sort --no-bail --if-present --workspace-concurrency=6 run test --testTimeout=15000`，EXIT 1 / 714s | 39/39 包结算：38 包成功、Isolation 1 包失败；11279 pass / 1 fail / 271 skip；未启动 pack，未启动新标准 full |

最新唯一失败：Isolation `tests/controller-startup.spec.ts:125`，用例 `does not steal a renewing live controller lease`，预期 previous-host/fence 1，实际 UUID/fence 2；该包 337 pass/1 fail/198 skip。已提供[前提修复方案](remaining-work.md#A)，尚未实施，不能断言生产抢锁或简单称为 flaky。

最新包诊断中 Delivery 1408/1408（agent-runtime 295/295）、WorkItems 709/709（native composition 10/10）、MemoryLearning 87/87（feedback integration 4/4）通过，Lark 与 Control Plane 均已收齐终态。所有上述运行都已自然结束，检查后的进程清单没有遗留该验证副本的 pnpm/Vitest；下一位不能复用历史 session id。

两个已包含在 ordinary patch 的测试夹具修复：

- Delivery `agent-runtime.spec.ts`：等真实 tool 开始后，deadline 变体推进受控时钟，stop 变体使用真实 `/stop`；保留 5s/6s/15s 限值、unknown、迟到工具拒绝与清理。SHA-256 `5dd462f5a652c6022c5592ccef8c92f3718e1658d13a6a3982ad2b5d1f156404`；414a 定向 2/2、全 runtime 295/295 与类型检查通过。
- MemoryLearning `work-item-feedback.fixture.ts`：真实 Delivery accept/tick/idle 与同 Inbox 的终态、供应者、disposal 证明完成后才挂 WorkItems；保留自然调度、60s 下限/等待与原 lost-ACK 断言，没有 force 或 SQL 造 item。SHA-256 `935586943fa77095e75320c7e4202f44edaea306dddb4e9c442eb5f722892ef4`。

旧日志不足以确认当时具体卡在哪次扫查/启动关口；夹具前提已经改善，不伪造旧失败的完整时序根因。

## 可恢复性检查

交接前完整 40 路径差量在私有证据目录留档；基线临时副本 forward apply 后逐路径 SHA/bytes/mode 与冻结工作区一致。公开 ordinary patch 为其中 39 路径，实测 forward apply 与清单 39/39 一致；继续应用 CI 八路径后匹配合并清单，schema 18 断言保留。四文档清理另行 apply，匹配原 CI 文档目标。

三份补丁的完整 SHA/字节/mode 见 [patches.tsv](patches.tsv)，可用只读脚本再次验证。独立复核已检查 ordinary 与原差量字节一致、CI 为原 12 段中的八段原字节、历史 Linux patch 为原归档字节；公开文件扫描未发现私钥/token/带密码 URL 或具体原 Mac/SSH 地址模式。扫描不替代逐项检查上传范围。

独立只读交接复核 **PASS**：普通/CI `git apply --check --whitespace=error` 均 EXIT 0；实际恢复 39/8 路径及 CI 后其余 38 个普通路径逐项校验通过；历史恢复 12/12。24 个交接相对链接/锚点、七段 Bash 语法及 `git diff --check` 通过。提交范围为 17 路径：五份维护文档、四份手册、四份 TSV、三份 patch、一份只读 Python 校验工具。

当前收尾只交付资料和可恢复源码，不宣称 pending 功能 PASS。用户明确停止继续开发，因此没有再跑 `pnpm check`；下一位在恢复、修复后必须跑新的完整门。四份维护资料的清理不改变运行代码，未发布 npm、升级生产 Home、调用真实模型或发送用户渠道消息。

## 原 Linux 未上传内容的归属

原 Linux 工作树仍有活跃用户/工具进程，不能在其脚下 reset、切分支、覆盖或删除。现已把可明确归属本项目的 10 个已跟踪改动和两个未跟踪源/测试保存为 **12 路径恢复补丁**；源 snapshot 前后 HEAD、状态、引用和文件 hash/mode 稳定，按旧基线实际 apply 后 12/12 相同。该恢复件随 dev 拉取，不再只存在于原机器。

| 内容 | 处理和后续责任 |
| --- | --- |
| 原 dev `d2a1e0da682484c88dd41a656b42e2a1174b4375` | 是 8e6 的严格祖先，相差四次提交；新交接副本从 GitHub 最新 dev 获取，不把旧 HEAD 当开发基线 |
| 12 个未提交 CP 文件 | 已保存到 `linux-original-recovery.patch` 与清单；历史参照，勿默认套入新 dev；仅在旧基线的隔离副本恢复 |
| `goal-offline-20261106` | 相对原 cached dev 有 11 个拓扑独有提交，`git cherry` 的 11 项均为 patch 等价；不是严格祖先证明。原引用保留，待活跃会话退出后核对并处置，未推送 origin |
| `goal-offline-20261106b` 与原 main | 相对原 cached dev 无独有提交；因同一活跃工作树仍保留，待维护窗口清理；新交接副本只使用 dev/main |
| 原依赖、lib、缓存与受保护 Home/配置 | 未纳入公共交接，未读取或打包凭据/运行数据；继续归属原运行环境，确认无进程使用且不含唯一数据后才清生成物 |
| 独立验证目录与原始日志 | 保留为本地诊断证据，运行已结束；不再作为最新开发入口，验收后按本地保留策略清理 |

12 文件的主要语义已有后续实现：claimed_at/schema 39 迁移、pending/claim/accept/reject、瞬态 requeue、孤儿 reclaim、坏行隔离等，在 8e6 增加 generation、receipt、取消/到期栅栏。`source-workspace.spec.ts` 已与 8e6 字节一致。

存在刻意不同的旧行为：原内部 setInterval drain 被 budgeted native continuation 替代；原 pending 可直接 reject，新实现要求 claim generation，expiry/quarantine 走专门路径。不能把旧文件原样覆盖新实现，也未穷尽证明所有旧异常时序等价，故保留恢复件供未来审阅。

全部本地 refs 的历史 bundle 未生成：自动审批拒绝其范围可能超出本轮项目补丁并包含历史/敏感数据，因此改为明确的 12 路径补丁和本地引用清单。原 Git 历史和引用原地保留；没有绕过拒绝上传全历史。

新 Linux 交接 checkout 以最终 GitHub dev 精确 SHA 同步，Mac 同步同一 SHA。机器路径由本轮收尾结果和 Linux 本地归属说明提供；换电脑只依赖本目录，不依赖那些路径。
