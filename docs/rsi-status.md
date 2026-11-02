# RSI 当前状态

更新：2026-11-02。验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)；实现历史查 Git，原始运行证据位于忽略的 `docs/evidence/`。

## 目标与纪律

Linux 去除 Docker 依赖且保留能力；用持久任务、原生 Agent、独立证据和有限采用，减少用户管理上下文与逐步审批的负担。仅保留 `dev`、`main`：开发提交推送走 `dev`，通过发布验收后才合入 `main`。

## 已有能力与边界

- Linux 原生隔离、完整源码 prepare、工具创建/修订、独立验收与 owner 升级事务已有实现。Linux x64/cgroup v1 已实测；cgroup v2 拒绝、arm64 未验收。完整 live Docker→native 升级尚未通过。
- 可选 WorkItems 默认关闭、observe 模式；schema 8 持久记录准入授权、派发、认领、报告与有界续办。原生 scheduler 已接到期 waiting-resume，尚未扫描空闲 Host 的新失败来源。没有新增 Agent Loop。
- 四个工作项工具支持 claim/report/status/read_report。新 occurrence 可从有界 `resume` 找回先前尝试与报告，并按 UTF-8 字节分页召回摘要外正文；授权和实际执行均检查 exact production occurrence、owning Fiber、当前 owner 与原准入 mandate。
- Delivery schema 28 将可信终止观察与业务结果分开，非成功业务结果仍为 unknown。原输入可按 owner/sourceDigest 分页读取，Native Web 冻结实际 provider/model/effort。安装器支持已审查 schema 23–28，Web doctor 为 24–28，未知版本拒绝。
- Automations `runAgentForHostExecution` 已交付：真实生产 Host invocation、首次 attempt、never/0 重试合同与新预算预留，最多启动一次有界原生 Agent。复用原有 Loop，冻结供应商（包括 effort 缺省）、工具 schema、额度和绝对期限；私有执行收据保留真实 Session/使用量，唯一外层预算结算，取消或回收不明保持 unknown。接口本身不证明原用户任务来源或 owner 授权。
- 终态报告接入真实 Delivery outbox 和 Evaluation；worker ready 不等于独立成功，通知入队不等于送达。`follows` 仅支持线程关闭结算；Router 跨信道协调、订阅直通、普通使用成长反馈与长期收益尚未完整验收。

## 当前交付

`dev@db076203` 的 Automations 接口专项已独立 PASS：Mac 全插件 359 passed / 27 skipped，其中新增 44 项全部通过；noEmit、构建和零警告 lint 均 EXIT 0。真实复现并修复了 Cordis 代理接线、unknown 落库/副作用、同步重入和阻塞后越过期限问题，红绿证据与断言失败 canary 保留在 `host-agent-execution{,-tests,-integration}/`。

同一源码的 Mac/Linux 完整根检查均 EXIT 0，且均经独立核验 PASS；具体证据见下表。

## 下一交付

接通普通终止信号到有限只读诊断报告：WorkItems 来源适配、准入时冻结诊断计划、原输入召回及固定 Host executor，空闲准入复用原生 scheduler。模型必须继承原任务实际供应商；缺失/inconsistent 记录不得回退默认。诊断使用明确授权的独立有限预算，不冒认原任务剩余额度，不重放 unknown 原操作。

当前接口还缺诊断消费者的持续授权围栏：必须在异步创建完成后的首次 prompt、每次真实模型请求及工具动作前复核 owner/source/mandate；不能只在调用 API 前检查一次。需要同步 Host-only 检查，不开放 caller setup，不另建 Loop。当前 schedule 只有 at/every/cron；下一片将增加 Host-only external 调度，避免固定 worker 空跑消耗预算。上述接线设计已独立复核，尚未实现。

## 原生改造与延后验收

用户已明确延后飞书机器人实连及后续真实使用验收，当前先完成代码、单测与可离线验证项。连接门保留，模拟连接不能替代正式安装。活 Home、两个服务停启与原子切换未执行；全局 CLI 实际在 `~/.npm-global`，直接 upgrade 程序不做 CLI 自更新。

仍须完成的工程缺口：

1. 实验性 autonomy 新安装/Web setup/doctor 仍要求 Docker；supervised native prepare 只配置 CP 构建/验收 runner，没有配置普通 `assistantIsolation`。需公开非激活资源接口并接通 native 配置、准备和探测，不能借资源准备启动服务或扩展 owner 授权。
2. 空业务采用 CAS 已接入安装器/签名 overlay，保留 owner、key、额度、期限与历史；完整临时双服务升级、就绪和回滚未验收。旧临时准备失败现场保留，修正版因正式机器人前提而延后。复制恢复、非空迁移及 native→native 尚不支持。
3. 非空 review 历史 CAS/封存组件已有专项及独立复核，installer、Host head、运行时消费者和非空 adoption 资格仍缺；旧 Docker 证书不能当作 Linux 执行资格。
4. pre-owner 最终候选依赖图、策略结果及真正断网安装证明待补齐。pnpm 应用闭包 pin 已双端专项验证，Node 共享库等系统依赖仍属 host toolchain 信任边界。

真实临时 Host 的两轮任务及重启续办已有 Mac/Linux 功能证据；Mac 摘要外报告召回前提 PASS，Linux 因审计标识已出现在 resume，该前提 FAIL。两端共五次生产模型运行额度已用尽，不重置失败和预算。合成任务不证明 ordinary-use 学习，到期后重启不证明 idle 自动完成，外部送达未验收。

远端同级 20 个及嵌套 8 个 worktree 已清理并独立 PASS，独有成果完整归档；归档候选未全部整合。未发布、未合入 main、未触碰活服务。

## 最新完整检查

精确源码 `db076203582df71daad5a7048519e6e3ea8f8adc`，tree `7ca3cb4bc8bd6efc9a91f56f30281a99a5063827`；两端命令均为 `CI=1 VITEST_MAX_WORKERS=2 pnpm check`，pnpm 11.7.0。manifest、零警告 lint、构建、类型检查、测试及 dry-run pack 全部完成；child/runner 均 EXIT 0、源码稳定、无中断。

| 环境 | 测试 passed / skipped | 文件 passed / skipped | 耗时 | 日志 SHA-256 |
| --- | --- | --- | --- | --- |
| Mac / Node 26.11.1 | 9,448 / 1,873 | 660 / 86 | 1046.32 秒 | `b400f79c30b10b776112838bf4894578ae38c81992e9d35edfda7554c6f2531f` |
| Linux / Node 24.7.0 | 11,017 / 301 | 714 / 32 | 1944.65 秒 | `241db88bc41e292a24b338ef34ad2c1040afe19df376e12d76bc6190e6fff71a` |

每端完成 39 个测试组、38 个包和 38 个类型检查。两端均按精确 Git manifests 独立逐项核对 PASS。原始日志、退出码、命令及复核位于 `docs/evidence/verification-db076203/`。Automations 根组 Mac 为 359 passed / 27 skipped、25 文件通过；Linux 为 379 passed / 7 skipped、24 文件通过 / 1 跳过，原始日志明确新增文件 44 项通过。Mac dot reporter 未逐项列出新增用例，专项 verbose 日志保留全部通过行。

这些结果不替代跳过项、外部连接、活服务升级或长期普通使用验收；修前失败和中断证据保留，未被新结果覆盖。
