# RSI 当前状态

更新：2026-11-03。验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)；实现历史查 Git，原始运行证据位于忽略的 `docs/evidence/`。

## 目标与纪律

Linux 去除 Docker 依赖且保留能力；用持久任务、原生 Agent、独立证据和有限采用，减少用户管理上下文与逐步审批的负担。仅保留 `dev`、`main`：开发提交推送走 `dev`，通过发布验收后才合入 `main`。

## 已有能力与边界

- Linux 原生隔离、完整源码 prepare、工具创建/修订、独立验收与 owner 升级事务已有实现。Linux x64/cgroup v1 已实测；cgroup v2 拒绝、arm64 未验收。完整 live Docker→native 升级尚未通过。
- 可选 WorkItems 默认关闭、observe 模式；schema 8 持久记录准入授权、派发、认领、报告与有界续办。显式 diagnosis 配置可让原生 scheduler 在空闲时扫描已认证的终止来源，冻结原任务实际 supplier/effort、授权与独立有限预算，派发只读诊断；缺失或不一致的来源拒绝。没有新增 Agent Loop、表或 timer。
- 通用工作项保留 claim/report/status/read_report；诊断模式增加有界 read_source，原操作不自动重放。新 occurrence 通过 `resume` 找回旧尝试与报告；waiting 只在原报告对应的同一 production occurrence 确认 succeeded、预算 finalized 后续办。未知或报告后失败跨重启停驻，health 显示 interventionRequired；可信 Host 可显式减权释放该工作槽。
- Delivery schema 28 将可信终止观察与业务结果分开，非成功业务结果仍为 unknown。原输入可按 owner/sourceDigest 分页读取，Native Web 冻结实际 provider/model/effort。安装器支持已审查 schema 23–28，Web doctor 为 24–28，未知版本拒绝。
- Automations `runAgentForHostExecution` 已交付：真实生产 Host invocation、首次 attempt、never/0 重试合同与新预算预留，最多启动一次有界原生 Agent。复用原有 Loop，冻结供应商（包括 effort 缺省）、工具 schema、额度和绝对期限；私有执行收据保留真实 Session/使用量，唯一外层预算结算；撤权/回收不明保留 unknown 与已观察用量下界，Evaluation 不将下界当完整成本。同步授权围栏在首次 prompt、实际模型请求、工具与结果接受前复核；Host-only external 调度无日历空跑。接口自身不证明来源，WorkItems 诊断消费者负责重核 owner/source/mandate。
- 终态报告接入真实 Delivery outbox 和 Evaluation；worker ready 不等于独立成功，通知入队不等于送达。`follows` 仅支持线程关闭结算；Router 跨信道协调、订阅直通、普通使用成长反馈与长期收益尚未完整验收。

## 当前交付

普通 Goal 的 native 接线已提交 `dev@d6958beb`：Web admission 沿用持久 runtime/cgroup v1、原 grant 期限与有限预算，Verifier 严格区分 native/Docker authority 并复用 LinuxVerifierRunner；Docker digest 保持兼容。Mac 全根与 Linux 专项通过。

真实 Linux 联合验收发现：按时完成的 step 与四次独立 native 验证均成功，但整体 Goal 错误沿用旧 step 执行期限，收据被降为 unknown。当前修复将及时持久完成后的观察与执行截止分开，保留精确身份、撤权和原整体验收的 wall/monotonic 上限；不授予新执行。实际回归已红转绿，最终两个相关文件 40 项、类型检查、lint、构建通过；修后联合验收和最终双端全根待完成。

资源准备能力已提交 `dev@ec247725`，两项 Linux `/tmp` 挂载测试的 fixture 修正已提交 `b911ad12`。普通 autonomy 安装、Web setup/doctor 接通不激活服务的 `native-resources` 入口；重复配置只读复核，doctor 不联网准备资源。
Linux 临时 Home 已验证真实准备、跨入口旧收据复用、取消清理及全新 consumer 断网安装（10 passed / 1 Mac-only skipped）。真实 Cordis/Loader/NativeWeb/AgentLoop 下，一个本地脚本模型任务通过 native Isolation 执行，产物正确、作业 quiescent，重复 setup 保留已用额度、owner、期限和配置；冷 SQLite/Session/收据独立回读 PASS。准备阶段仍联网获取依赖，脚本模型不证明真实模型能力，业务执行不代替 Goal 独立验收。

## 下一验收

用新临时 Home 重验 native Goal round → 自动绑定产物 → 独立 held-out runner → step/outcome receipt，并验证错误产物拒绝；保留先前失败与预算。随后完成最终源码双端全根。诊断报告、固定脚本模型与一次执行均不代表自主修改采用或长期收益；跨信道 Router、订阅直通与普通使用成长反馈仍待推进。

## 原生改造与延后验收

用户已明确延后飞书机器人实连及后续真实使用验收，当前先完成代码、单测与可离线验证项。连接门保留，模拟连接不能替代正式安装。活 Home、两个服务停启与原子切换未执行；全局 CLI 实际在 `~/.npm-global`，直接 upgrade 程序不做 CLI 自更新。

仍须完成的工程缺口：

1. 普通 autonomy native 资源与真实业务执行已验收；Linux 根检查待收齐。普通 Goal 的 native authority/执行器已接线，须修复并通过真实整体 Goal 验收后才能声称该路径能力等价。
2. 空业务采用 CAS 已接入安装器/签名 overlay，保留 owner、key、额度、期限与历史；完整临时双服务升级、就绪和回滚未验收。旧临时准备失败现场保留，修正版因正式机器人前提而延后。复制恢复、非空迁移及 native→native 尚不支持。
3. 非空 review 历史 CAS/封存组件已有专项及独立复核，installer、Host head、运行时消费者和非空 adoption 资格仍缺；旧 Docker 证书不能当作 Linux 执行资格。
4. pre-owner 最终候选依赖图、策略结果及真正断网安装证明待补齐。pnpm 应用闭包 pin 已双端专项验证，Node 共享库等系统依赖仍属 host toolchain 信任边界。

真实临时 Host 的两轮任务及重启续办已有 Mac/Linux 功能证据；Mac 摘要外报告召回前提 PASS，Linux 因审计标识已出现在 resume，该前提 FAIL。两端共五次生产模型运行额度已用尽，不重置失败和预算。合成任务不证明 ordinary-use 学习，到期后重启不证明 idle 自动完成，外部送达未验收。

远端同级 20 个及嵌套 8 个 worktree 已清理并独立 PASS，独有成果完整归档；归档候选未全部整合。未发布、未合入 main、未触碰活服务。

## 最新完整检查

命令 `CI=1 VITEST_MAX_WORKERS=2 pnpm check`，pnpm 11.7.0。以下均为精确历史源码结果，不覆盖当前观察期限修复。

| 环境与精确源码 | 结果 | 测试 passed / skipped | 文件 passed / skipped | 日志 SHA-256 |
| --- | --- | --- | --- | --- |
| Mac / Node 26.11.1 / `d6958beb` | EXIT 0，独立 PASS，1041.29 秒 | 9,565 / 1,875 | 668 / 85 | `46407d171497a95551a12d36dac49653f93e32ef3b555c1af4ba905dacb13c29` |
| Linux / Node 24.7.0 / `ec247725` | EXIT 1，4 项 ENOSPC，1292.61 秒 | 1,394 / 5 | 83 / 3，另 2 失败 | `075e32ca70a287150f0e78ed6251da6ed5e103342cb1f14471135d10e5ea2dc6` |

Mac 完成 manifest、零警告 lint、构建、38 个类型检查、39 个测试组及 38 个 dry-run pack。Linux 已改用容量充足且短路径的 `/data00/home/jiataorui/t`；原四项 ENOSPC 对照恢复，两项 `/tmp` 专用 fixture 修正也双路径实测通过。最终根检查尚未运行，原失败保留。原始日志与独立核对位于 `docs/evidence/verification-*/`、`docs/evidence/goal-settled-deadline/` 和 `docs/evidence/native-goal-live/`。

这些检查不代替跳过项、外部连接、活服务升级或长期普通使用验收。
