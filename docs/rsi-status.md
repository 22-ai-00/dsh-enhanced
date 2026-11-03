# RSI 当前状态

更新：2026-11-03。验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)；实现历史查 Git，原始证据在忽略的 `docs/evidence/`。

当前未提交现场的唯一接手入口：`docs/evidence/handover/CURRENT.md`。开发写入及测试已停止；先核对该入口的源码清单，再续做下一步。

## 目标与纪律

Linux 去除 Docker 依赖且保留能力；通过持久任务、原生 Agent、独立验收和有限采用，减少用户管理上下文与逐步协调的负担。仅保留 `dev`、`main`：开发提交推送走 `dev`，发布验收通过后才合入 `main`。

## 已交付能力与边界

- Linux 原生隔离、源码 prepare、工具创建/修订、独立验收及 owner 升级事务已有实现。普通 autonomy 安装、Web setup/doctor 已接通 native 资源；重复 setup 保留身份、原期限和已用额度。Linux x64/cgroup v1 已实测；cgroup v2 拒绝，arm64 未验收。pre-owner 资源迁移已有双端根检查，不能代替 live owner 升级。
- 原生 Goal 已贯通真实 Cordis/Loader/NativeWeb/AgentLoop、产物绑定及独立 Linux 验收。正确产物得到 achieved，退出码为零的错误产物被拒绝；冷账本和资源清理已独立核验。供应商为本地脚本，不证明真实模型或任意任务能力。
- WorkItems 默认关闭、observe 模式；持久准入、认领、报告和有界 resume 已实现。显式 diagnosis 使用冻结 supplier、权限和有限预算执行只读诊断；只在准确 occurrence 成功且结算后续办，unknown 不自动重放。主人前台 `work_item_list` / `work_item_recall` 按 owner lineage 过滤并支持跨会话分页召回，不恢复旧授权或额度。
- 显式 `ownerReplyContinuation` 接通真实报告回复、持久子项与原生续办；先保存子项再 ACK，ACK 前不派发。显式 `ownerReportFeedback` 将准确 owner 结果回复接入 Evaluation，更正、撤回及丢 ACK 按原操作对账。Delivery schema 30、Evaluation schema 13、WorkItems schema 9；报告入队不代表外部送达，owner testimony 不等于独立技术成功。
- 后台反馈 → 持久经验 → 后续召回已交付至 `dev`（实现 `9d515afc`）。学习、独立审查、有限采用三份授权须分别启用 `workItemExperiences`；默认及前台 v1 不变。认证主人原文提供经验引文，worker 报告只作背景；更正、撤回或来源不可用时隐藏失效经验，unknown 不重复付费或返还额度。真实组件和新会话 Memory.search 已贯通；组件重挂不等于全进程重启，Host 调用不证明模型自主召回。

## 当前交付：后台反馈驱动工程成长

尚未提交交付。完整、可验证的原始主人任务沿父链进入既有工程 Growth，执行候选创建、独立验收、有限采用及后续调用；空白、附件或历史来源不完整时拒绝，不用 worker 简报或结果短句替代工程目标。后台作者使用精确预授权；前台工具调用保留原审批边界。没有新增 Agent Loop 或 timer。

相关组件专项、manifest 和零警告 lint 已通过。Mac 已分别通过并独立复核四个真实原生场景：创建→独立验收→采用→新会话调用，错误候选拒绝，更正/撤回，以及采用提交后丢 ACK 的组件重挂恢复。恢复沿用原身份、授权、证书与额度，没有重复作者或审查；不代表未知采用事务或全进程恢复。供应商均为本地脚本，Mac 编译打包不等于候选自测。

**当前待验收：** Linux 正常创建→独立验收→采用→新会话调用、错误候选拒绝、更正撤回及丢 ACK 冷恢复四个原生场景已通过并独立复核。丢 ACK 场景在组件重挂后恢复原 alias，只发生一次主人调用（`allowed-once`），未再付费生成作者或审查，adoption 仍为同一 `plan_id`。该场景曾因预算快照断言接连失败（`ack-r1`、`ack-r2`）；现改为在 automations 空闲后取一致快照，新增预留只能是绑定当前扫描定义 digest、`amount=actual_amount=1` 的 finalized 结算，既有预留的不可变字段逐字段不变（仅允许仓内 `reserved` 行首次结算为 `finalized`/`released`），保留失败尝试。原始 Policy 预留行未纳入归档，预算归属由该次通过运行的测试断言及复核代码证明。新后台任务的 Host 期限修复、读取取消竞态修复均已独立通过，旧 v1 定义不迁移。Linux 采用场景的测试总时限按实测多阶段耗时设为 600 秒，Mac 保持 300 秒；生产各阶段限额及根默认超时不变。本轮双端根检查仍待执行。证据入口：`docs/evidence/work-item-engineering-growth/integration-current-checkpoint.json`。

## 待办与延后验收

1. 提交 `dev` 后，对精确提交跑双端完整检查（含上述四个 Linux 原生场景）。Linux 大测试、缓存和证据使用 `/data00`，启动前核对实际文件系统；旧系统盘测试数据已校验归档迁出，运行服务未变。
2. 非空 review 历史 CAS/封存已有组件专项；installer、Host head、运行时消费者及非空 adoption 迁移资格仍缺。旧 Docker 证书不能作为 Linux 资格；owner 升级的空业务采用 CAS 不代表非空迁移、复制恢复或 native→native 已支持。
3. Router 跨信道协调、订阅直通和长期普通使用收益尚未完整验收。现有持久任务不代表完整自主工程成长；两端此前五次真实模型运行额度已用尽，不重置失败或预算。
4. 用户已延后飞书机器人实连和后续真实使用验收；正式连接门保留。完整临时双服务升级、就绪、回滚及活 Home 切换未验收，暂不操作活服务。

本地与远端项目均只保留主 `dev` checkout，`main` 分支保留；旧 worktree 的修改、暂存成果和证据已保全，归档候选未全部整合。未发布、未合入 main；全局 CLI 实际在 `~/.npm-global`。

## 最新完整检查

以下结果仅覆盖此前经验学习交付：精确实现 `9d515afc890224ca52dd3e1c4737f1d4979b7b24`，tree `37690b629f1aab1800df06daf6bfc3b6cfe67b11`，不覆盖当前未提交工程成长切片。

命令 `CI=1 VITEST_MAX_WORKERS=2 pnpm_config_verify_deps_before_run=error pnpm check`，pnpm 11.7.0；先核对并清理 38 包生成目录，保留根脚本默认 15 秒测试超时。

| 环境 | 结果 | 测试 passed / skipped | 文件 passed / skipped | 日志 SHA-256 |
| --- | --- | --- | --- | --- |
| Mac / Node 26.11.1 | EXIT 0，独立 PASS，1245.73 秒 | 10,089 / 1,920 | 696 / 85 | `54e1ab2438506da56cdd4f4253361b1a071b26e563c4f726bf26e300ed426da4` |
| Linux / Node 24.7.0 | EXIT 0，独立 PASS，2392.43 秒 | 11,702 / 304 | 749 / 32 | `387bb6924db95919d35d385d9f1e0befea3d8e455765c912f19d1905a3b728f1` |

两端覆盖 manifest、零警告 lint、38 包构建和类型检查、39 测试组及 38 个唯一 dry-run pack；修改涉及的公开产物逐项核对入包，源码前后同一提交且工作树干净。Linux `TMPDIR=/data00/home/jiataorui/t`。准确命令与独立复核见 `docs/evidence/verification-9d515afc/`；Mac 原始日志在本地，Linux 原始日志留在远端同路径。跳过项、真实模型/Bot、活服务升级和长期收益不计为已验收。
