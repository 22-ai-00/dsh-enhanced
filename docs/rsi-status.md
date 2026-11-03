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

## 当前交付

后台报告的主人结果反馈已交付到 `dev`。默认关闭的 `ownerReportFeedback` 与回复续办独立：对准确报告回复完整的结果短句，或显式 `/feedback` 查询、更正、撤回时，Delivery 核对当前 owner、真实 provider 接受记录及独立 `feedback-work-items` Policy，持久保存反馈，不启动模型或续办任务。包含额外执行指令的自然回复仍走原有路径。

Delivery schema 30 保存独占反馈来源、原报告目标、稳定操作 ID 与冻结 CAS；Evaluation schema 13 按原 `itemId` 维护一份当前 owner 结果。WorkItems 仍为 schema 9，使用进程内 capability 重核准确报告、冻结 supplier、实际静止及预算结算；报告元数据可在执行结束前入队，结果反馈必须等待静止。历史读取不续期执行授权，同一 owner 新会话可评价旧报告。丢 ACK 后对账同一操作，更正与撤回保留历史；取消不是外部效果已撤销的证明。

源事务最后重核当前授权再写结果；同毫秒的报告按报告版本取值，矛盾证据不能进入学习。新主体的 Evolution 投影显式为 `not-required`，Recovery 按 no-op 处理，避免无效重试。独立 Host reader 返回有界展示和完整来源摘要；主人评价是 testimony，不是独立 verifier 成功。已有 worker settlement 仍为 unknown，历史数据不重解释。

本轮专项检查：WorkItems 385 passed / 27 files；Delivery 1118 passed / 6 skipped；Evaluation 355 passed / 36 skipped；最终组件组合 13 passed / 2 files，均 EXIT 0。源码、真实旧库迁移、最终 writer 边界与组合证据已独立复核；精确实现提交 `d418d1c1` 的 Mac、Linux 冷构建根检查均 EXIT 0、独立 PASS。原始命令、输出与摘要见 `docs/evidence/work-item-owner-feedback/`。这次交付只补齐后台任务结果及可信来源；Growth/Memory 消费这类结果、候选产生、独立验证与有限采用仍待后续接线，不声称自主成长闭环完成。

## 后续工程与延后验收

1. 下一工程交付：让后台结果反馈形成可撤回的持久经验，并供后续任务检索。需补有版本的来源类型和提交时来源复核；保持原 supplier、额度及独立审查/采用授权，不伪装前台来源。随后再扩展工程 Growth。
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
