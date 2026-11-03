# RSI 当前状态

更新：2026-11-03。验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)；实现历史查 Git，原始运行证据位于忽略的 `docs/evidence/`。

## 目标与纪律

Linux 去除 Docker 依赖且保留能力；通过持久任务、原生 Agent、独立验收和有限采用，减少用户管理上下文与逐步协调的负担。仅保留 `dev`、`main`：开发提交推送走 `dev`，发布验收通过后才合入 `main`。

## 已有能力与边界

- Linux 原生隔离、源码 prepare、工具创建/修订、独立验收与 owner 升级事务已有实现。普通 autonomy 的安装、Web setup/doctor 已接通 native 资源；重复 setup 保留 owner、原期限与已用额度。Linux x64/cgroup v1 已实测；cgroup v2 拒绝、arm64 未验收。pre-owner Docker→native/native→native 基础资源迁移已有双端根检查；保持原身份、额度与签名历史，并核对实际目录身份。完整 live Docker→native 升级尚未验收。
- 普通 native Goal 已打通真实 Cordis/Loader/NativeWeb/AgentLoop → 原生回合 → 自动绑定产物 → LinuxVerifierRunner → step/outcome v4 收据。正确产物得到 complete/achieved；退出码为零的错误产物得到 blocked/not-achieved。两场景的冷 SQLite、Session、产物、幂等键与实际资源清理已独立 PASS。这是固定脚本供应商集成证据，不证明真实模型或任意任务能力。
- WorkItems 默认关闭、observe 模式；schema 9 保存准入、派发、认领、报告与有界 resume。显式 diagnosis 冻结认证来源的实际 supplier/effort、授权和独立有限预算，由原生 scheduler 派发只读诊断。waiting 仅在同一 occurrence 的真实成功与预算结算后继续；未知与后续失败保留停驻，可信 Host 可显式减权释放工作槽。原操作不会自动重放。
- 主人前台召回已交付：显式开启的 `work_item_list` / `work_item_recall` 通过真实 Delivery 人类 turn 与独立 `inspect-work-items` 授权，按 owner lineage 在分页前过滤，支持新会话历史任务与报告分页读取；不恢复旧执行、授权或预算。
- Delivery 保留可信终止观察和工作项报告回复来源；终止观察仍与业务结果分开，非成功业务结果仍为 unknown；原输入按 owner/sourceDigest 分页召回。Automations Host 接口支持一次有界原生 Agent，冻结模型、工具、期限与额度；WorkItems 消费者负责重核来源与 owner。终态报告接入真实 outbox/Evaluation，ready 不代表独立成功，入队不代表送达。没有增加另一套 Agent Loop。
- 显式 `ownerReplyContinuation` 已交付：主人回复真实报告后，Delivery 持久转交原生续办 worker；子项继承父项冻结 supplier，等待精确 occurrence 静止，再接上前一子项结论。先保存子项、再 ACK，ACK 前不派发；重复消息、取消、冷恢复和未知派发不回到前台重复执行。同一 owner 新会话可回复旧报告，原 v1 前台续办与分页召回仍独立。精确代码 `595d14b0` 已通过双端根检查。
- 显式 `ownerReportFeedback` 已交付：后台报告的准确结果回复经当前 owner、provider 接受记录及独立 Policy 校验后进入 Evaluation；更正、撤回与丢 ACK 沿稳定操作 ID 对账，不启动模型或续办。Delivery schema 30、Evaluation schema 13、WorkItems schema 9 保留历史，主人 testimony 与独立技术成功分开。精确代码 `d418d1c1` 已通过双端根检查。

## 当前交付

当前交付为后台结果反馈 → 持久经验 → 后续召回；实现、专项检查与独立组合复核已完成，最终交付等待本次双端根检查。学习、独立审查、有限采用三份授权都显式开启 `workItemExperiences` 后，后台结果才可进入 v2 经验来源。默认授权与前台 v1 不变；原授权不能扩权或恢复额度，学习器启用新能力须保留旧库并配置新授权/新库。仅学习器迁移至 schema 2，其余相关账本 schema 不变。

任务简报与 worker 报告只作背景，经验引文来自认证主人反馈的可见原文。来源摘要、supplier、期限与额度冻结；Delivery → Evaluation → WorkItems 来源锁 → Memory 的整组复核保护采用及检索。更正、撤回或来源暂不可用时隐藏失效经验；已保存请求的 unknown 继续对账原操作，不重做付费提取或审查，也不返还额度。没有新增 Agent Loop 或 timer。

局部验证与独立复核已通过：共享合同 12 passed；学习器 83 passed；WorkItems 403 passed；Delivery 1130 passed / 6 skipped；Verifier 429 passed / 37 skipped；Memory 203 passed。各包静态检查及构建通过。新增真实组件组合 4 passed，旧前台关键回归 6 passed（其余 10 项未选择，已在此前完整包检查覆盖）。真实报告、owner 反馈、独立审查账本、采用及新会话 owner turn 的 Memory.search 已贯通；更正/撤回和丢 ACK 后卸载重挂 Memory/Verifier/学习器保持原额度与操作身份。供应商为本地脚本，组件重挂不是全进程重启，Host 调用 search 不证明模型会自主选择召回。此次精确代码的双端根检查待完成；以下完整检查仅覆盖上一交付。证据见 `docs/evidence/work-item-memory-learning/`，后台工程 Growth 与长期质量收益仍待验收。

## 后续工程与延后验收

1. 当前交付固定实现提交到 `dev` 后完成双端根检查，再收口交付。下一工程交付才扩展后台结果的工程 Growth 来源与候选产生；不以 Memory 采用代替插件独立验证及有限采用。
2. 非空 review 历史 CAS/封存组件已有专项，但 installer、Host head、运行时消费者和非空 adoption 资格仍缺；旧 Docker 证书不能当作 Linux 资格。
3. Router 跨信道协调、订阅直通与普通使用成长反馈尚未完整验收。持久任务与诊断不代表自主修改采用或长期收益。两端此前五次真实模型运行额度已用尽，失败与预算不重置。既有真实 Host 合成续办的摘要外召回前提 Mac PASS、Linux FAIL（标识已在 resume 中）；不证明 idle 自动完成或外部送达。
4. 用户已明确延后飞书机器人实连与后续真实使用验收。正式连接门保留；完整临时双服务升级、就绪、回滚及活 Home 切换未验收。owner 升级的空业务采用 CAS 已实现；其非空迁移、复制恢复及 native→native 尚不支持，不能以 pre-owner 迁移代替。

远端同级 20 个及嵌套 8 个目标 worktree 已清理并独立 PASS，独有成果保全，归档候选未全部整合。未发布、未合入 main、未触碰活服务；全局 CLI 实际在 `~/.npm-global`。

## 最新完整检查

命令 `CI=1 VITEST_MAX_WORKERS=2 pnpm_config_verify_deps_before_run=error pnpm check`，pnpm 11.7.0。两端验证精确实现提交 `d418d1c1674ab8090009be74cac0f39b5c23bf0d`，tree `f6d0957e75d157e510f4910b20bab6e2b534f8f6`；先核对并清理 38 个包的生成目录，再执行默认完整检查。根脚本原有的 15 秒测试超时保持不变。

| 环境与精确源码 | 结果 | 测试 passed / skipped | 文件 passed / skipped | 日志 SHA-256 |
| --- | --- | --- | --- | --- |
| Mac / Node 26.11.1 / `d418d1c1` | EXIT 0，独立 PASS，1172.56 秒 | 9,985 / 1,920 | 692 / 85 | `658fd33f103c39da5a1bf88763d1853e521c190eb78a0c185d22220b0ab6b0a0` |
| Linux / Node 24.7.0 / `d418d1c1` | EXIT 0，独立 PASS，2415.51 秒 | 11,598 / 304 | 745 / 32 | `7348858301b362f96d6f07cdcd9a8ece35613276bd862499583ddf69c40d48b4` |

两端均核对 manifest、零警告 lint、38 包构建范围、38 个类型检查、39 个测试组及 38 个唯一 dry-run pack。新增 WorkItems feedback-targets、Delivery 三个反馈模块、Evaluation work-item-owner-proof 的 20 个 JS、类型声明和 map 文件各入包一次，原续办模块仍齐全；未混入测试或原始证据。源码检查前后均为同一提交且工作树干净。Linux 使用 `TMPDIR=/data00/home/jiataorui/t`。

原始日志、准确命令、源码身份及独立复核见 `docs/evidence/verification-d418d1c1/`，专项与真实组件组合证据见 `docs/evidence/work-item-owner-feedback/`。检查只证明工程边界；跳过项、真实模型/Bot、活服务升级和长期普通使用仍按前述范围保留，未发布或合入 main。
