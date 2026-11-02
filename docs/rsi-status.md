# RSI 当前状态

更新：2026-11-03。验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)；实现历史查 Git，原始运行证据位于忽略的 `docs/evidence/`。

## 目标与纪律

Linux 去除 Docker 依赖且保留能力；通过持久任务、原生 Agent、独立验收和有限采用，减少用户管理上下文与逐步协调的负担。仅保留 `dev`、`main`：开发提交推送走 `dev`，发布验收通过后才合入 `main`。

## 已有能力与边界

- Linux 原生隔离、源码 prepare、工具创建/修订、独立验收与 owner 升级事务已有实现。普通 autonomy 的安装、Web setup/doctor 已接通 native 资源；重复 setup 保留 owner、原期限与已用额度。Linux x64/cgroup v1 已实测；cgroup v2 拒绝、arm64 未验收。完整 live Docker→native 升级尚未验收。
- 普通 native Goal 已打通真实 Cordis/Loader/NativeWeb/AgentLoop → 原生回合 → 自动绑定产物 → LinuxVerifierRunner → step/outcome v4 收据。正确产物得到 complete/achieved；退出码为零的错误产物得到 blocked/not-achieved。两场景的冷 SQLite、Session、产物、幂等键与实际资源清理已独立 PASS。这是固定脚本供应商集成证据，不证明真实模型或任意任务能力。
- WorkItems 默认关闭、observe 模式；schema 8 保存准入、派发、认领、报告与有界 resume。显式 diagnosis 冻结认证来源的实际 supplier/effort、授权和独立有限预算，由原生 scheduler 派发只读诊断。waiting 仅在同一 occurrence 的真实成功与预算结算后继续；未知与后续失败保留停驻，可信 Host 可显式减权释放工作槽。原操作不会自动重放。
- Delivery schema 28 区分可信终止观察和业务结果，非成功业务结果仍为 unknown；原输入按 owner/sourceDigest 分页召回。Automations Host 接口支持一次有界原生 Agent，冻结模型、工具、期限与额度；WorkItems 消费者负责重核来源与 owner。终态报告接入真实 outbox/Evaluation，ready 不代表独立成功，入队不代表送达。没有增加另一套 Agent Loop。

## 本轮交付

`241e2c2e` 修复及时持久完成的 step 被旧执行截止误阻整体验收的问题。完成后的观察重读准确的成功/静止执行记录，保留当前身份、目标、依赖与撤权检查；原执行截止不变，整体验收继续受固定合同/派生期限及单调时钟约束。新观察门不授予后续执行，也不重置预算。原生 Goal 正反例各仅使用三次脚本模型响应、两次工具，独立复核 PASS。

`f689ceb6` 仅修复安装器测试夹具对 TMPDIR 的信任与 `/tmp` 隐藏挂载前提，生产 guard、断言、skip 与源码 timeout 不变。Linux 完整定向对照 28 passed，Mac 24 passed；四项 Linux 专用用例在 Mac 按原规则跳过。

## 后续工程与延后验收

1. 非空 review 历史 CAS/封存组件已有专项，但 installer、Host head、运行时消费者和非空 adoption 资格仍缺；旧 Docker 证书不能当作 Linux 资格。
2. pre-owner 最终候选依赖图、策略结果及其真正断网安装证明待补齐。普通 native 资源已通过全新 consumer 断网安装，初始 prepare 仍联网；不能将两者混称。
3. Router 跨信道协调、订阅直通与普通使用成长反馈尚未完整验收。持久任务与诊断不代表自主修改采用或长期收益。两端此前五次真实模型运行额度已用尽，失败与预算不重置。既有真实 Host 合成续办的摘要外召回前提 Mac PASS、Linux FAIL（标识已在 resume 中）；不证明 idle 自动完成或外部送达。
4. 用户已明确延后飞书机器人实连与后续真实使用验收。正式连接门保留；完整临时双服务升级、就绪、回滚及活 Home 切换未验收。空业务采用 CAS 已实现，复制恢复、非空迁移及 native→native 尚不支持。

远端同级 20 个及嵌套 8 个目标 worktree 已清理并独立 PASS，独有成果保全，归档候选未全部整合。未发布、未合入 main、未触碰活服务；全局 CLI 实际在 `~/.npm-global`。

## 最新完整检查

命令 `CI=1 VITEST_MAX_WORKERS=2 pnpm check`，pnpm 11.7.0。后续仅测试夹具修正不改变 `241e2c2e` 的生产代码；Mac 额外完成修后专项，不将旧全根结果改标为新提交。

| 环境与精确源码 | 结果 | 测试 passed / skipped | 文件 passed / skipped | 日志 SHA-256 |
| --- | --- | --- | --- | --- |
| Mac / Node 26.11.1 / `241e2c2e` | EXIT 0，独立 PASS，1049.28 秒 | 9,578 / 1,875 | 668 / 85 | `80cfa1e7e8d5200b2655f6994e3643ad644b00a7e098e0393a870e624a9d4b45` |
| Linux / Node 24.7.0 / `f689ceb6` | EXIT 0，独立 PASS，2063.51 秒 | 11,147 / 303 | 721 / 32 | `25f8cc949804bd9f148c6ed8ef2f353ba7e5417158c1897b7751c8b93657e019` |

两端均已独立核对 manifest、零警告 lint、38 包构建、38 个类型检查、39 个测试组及 38 个唯一 dry-run pack。Linux 使用 `TMPDIR=/data00/home/jiataorui/t`，两端各自检查前后的提交一致，且 tracked 工作树干净。原始日志和独立复核见 `docs/evidence/verification-*/`；原生 Goal 的冷证据见 `docs/evidence/native-goal-live/`。

此前 ENOSPC、TMPDIR 夹具失败和 Goal 截止失败均保留原始证据；专项通过不覆盖旧失败。上述检查不代替跳过项、外部连接、活服务升级或长期普通使用验收。
