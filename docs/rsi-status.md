# RSI 当前状态

更新：2026-11-02。验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)；实现历史查 Git，原始运行证据位于忽略的 `docs/evidence/`。

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

普通 Linux autonomy 的安装、Web setup/doctor 已接通原生资源入口，等待实机与根检查。Isolation 发布不挂载服务的 `native-resources` 子入口，Lark RSI 保留原 schema 3 收据与来源复核；工具链准备和 cgroup 发现分开。setup 在配对前准备并探测，已有 native 配置只读复核；不续授权、不重置额度，不隐式切换 backend。doctor 不联网准备资源。

代码与 Mac 专项已独立 PASS：资源 28 passed / 5 skipped，Lark 6 passed / 12 skipped，Web owner 全组 92 passed，安装器参数 5 passed；build/noEmit/零警告 lint 均 EXIT 0。资源准备原有 pnpm 配置钩子、目录及工具版本穿透问题有 18 项修前失败和修后通过；源配置实行已审查字段准入，fetch/install 禁止 pnpmfile。真实 pnpm 离线对照确认原参数执行钩子、修正参数不执行。打包子入口导入无激活副作用；该探针复用现有依赖，不是全新 registry 安装证明。

Web 资源专项明确使用 mocks；Linux 的真实准备、旧收据跨入口、取消清理、native probe 和业务额度保持尚待执行。验收 harness 使用新建私有 Home、一个本地脚本模型任务，原五次真实模型额度不变。本片尚未通过 Mac/Linux 根检查，下表只覆盖上一诊断交付。

## 下一验收

先在 Linux 临时 Home 验证真实资源与普通隔离执行、重复 setup 保留已用额度，再做精确新源码两端根检查。随后补齐普通 Goal 独立隔离验收的 native 路径；当前 native Goal admission 明确拒绝，显式 Docker 路径保留原能力。诊断报告、固定脚本模型与一次执行均不代表自主修改采用或长期普通使用收益；跨信道 Router、订阅直通与成长反馈仍待逐项推进。

## 原生改造与延后验收

用户已明确延后飞书机器人实连及后续真实使用验收，当前先完成代码、单测与可离线验证项。连接门保留，模拟连接不能替代正式安装。活 Home、两个服务停启与原子切换未执行；全局 CLI 实际在 `~/.npm-global`，直接 upgrade 程序不做 CLI 自更新。

仍须完成的工程缺口：

1. 普通 autonomy native 安装接线已实现，实机与根检查待收齐；普通 Goal 的 `isolated-runner` authority/执行器仍仅 Docker。须补 native 独立验收后才能声称该路径能力等价。
2. 空业务采用 CAS 已接入安装器/签名 overlay，保留 owner、key、额度、期限与历史；完整临时双服务升级、就绪和回滚未验收。旧临时准备失败现场保留，修正版因正式机器人前提而延后。复制恢复、非空迁移及 native→native 尚不支持。
3. 非空 review 历史 CAS/封存组件已有专项及独立复核，installer、Host head、运行时消费者和非空 adoption 资格仍缺；旧 Docker 证书不能当作 Linux 执行资格。
4. pre-owner 最终候选依赖图、策略结果及真正断网安装证明待补齐。pnpm 应用闭包 pin 已双端专项验证，Node 共享库等系统依赖仍属 host toolchain 信任边界。

真实临时 Host 的两轮任务及重启续办已有 Mac/Linux 功能证据；Mac 摘要外报告召回前提 PASS，Linux 因审计标识已出现在 resume，该前提 FAIL。两端共五次生产模型运行额度已用尽，不重置失败和预算。合成任务不证明 ordinary-use 学习，到期后重启不证明 idle 自动完成，外部送达未验收。

远端同级 20 个及嵌套 8 个 worktree 已清理并独立 PASS，独有成果完整归档；归档候选未全部整合。未发布、未合入 main、未触碰活服务。

## 最新完整检查

上一诊断交付：两端命令 `CI=1 VITEST_MAX_WORKERS=2 pnpm check`，pnpm 11.7.0；manifest、零警告 lint、构建、类型检查、测试及 dry-run pack 全部完成，child/runner EXIT 0，源码稳定。

| 环境与精确源码 | 测试 passed / skipped | 文件 passed / skipped | 耗时 | 日志 SHA-256 |
| --- | --- | --- | --- | --- |
| Mac / Node 26.11.1 / `ac3ec0db` | 9,510 / 1,873 | 665 / 86 | 1085.51 秒 | `e027adb79ab3495d624f2ca71b4c00c853bc158a411768c4acfec8a27147e11c` |
| Linux / Node 24.7.0 / `4f7609ce` | 11,079 / 301 | 719 / 32 | 1935.67 秒 | `603f01d98d3f73c4a11f52addf8a909d97ec590505942a13654f9a44b5009b8c` |

每端 39 个测试组、38 个包和 38 个类型检查。Mac tree `3eacc8b124165e2a35c3a040d49d2b2f6e7a645b`，Linux tree `dad13a29928dadae8ad329284c2d7ac9091f9586`。两提交生产代码一致，唯一差异是 Delivery 跨页用例的两行说明及 30 秒单项 deadline；该调整另经 Mac service 全组 83/83 与独立复核。两端原始日志、退出码及各自独立核对见 `docs/evidence/verification-{ac3ec0db,4f7609ce}/`。

诊断真实组件集成另有 9/9 与 39 个冷 SQLite 文件独立回读证据；使用脚本模型，真实 Cordis、Agent Loop、Policy 与 Delivery outbox，只证明通知入队。原 Linux 超时失败、原 Mac 中断及本片资源修前失败全部保留，不被新结果覆盖。这些结果不代替跳过项、外部连接、活服务升级或长期普通使用验收。
