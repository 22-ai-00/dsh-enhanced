# RSI 当前状态

更新：2026-11-03。验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)；实现历史查 Git，原始运行证据位于忽略的 `docs/evidence/`。

## 目标与纪律

Linux 去除 Docker 依赖且保留能力；通过持久任务、原生 Agent、独立验收和有限采用，减少用户管理上下文与逐步协调的负担。仅保留 `dev`、`main`：开发提交推送走 `dev`，发布验收通过后才合入 `main`。

## 已有能力与边界

- Linux 原生隔离、源码 prepare、工具创建/修订、独立验收与 owner 升级事务已有实现。普通 autonomy 的安装、Web setup/doctor 已接通 native 资源；重复 setup 保留 owner、原期限与已用额度。Linux x64/cgroup v1 已实测；cgroup v2 拒绝、arm64 未验收。完整 live Docker→native 升级尚未验收。
- 普通 native Goal 已打通真实 Cordis/Loader/NativeWeb/AgentLoop → 原生回合 → 自动绑定产物 → LinuxVerifierRunner → step/outcome v4 收据。正确产物得到 complete/achieved；退出码为零的错误产物得到 blocked/not-achieved。两场景的冷 SQLite、Session、产物、幂等键与实际资源清理已独立 PASS。这是固定脚本供应商集成证据，不证明真实模型或任意任务能力。
- WorkItems 默认关闭、observe 模式；schema 8 保存准入、派发、认领、报告与有界 resume。显式 diagnosis 冻结认证来源的实际 supplier/effort、授权和独立有限预算，由原生 scheduler 派发只读诊断。waiting 仅在同一 occurrence 的真实成功与预算结算后继续；未知与后续失败保留停驻，可信 Host 可显式减权释放工作槽。原操作不会自动重放。
- 主人前台召回已交付：显式开启的 `work_item_list` / `work_item_recall` 通过真实 Delivery 人类 turn 与独立 `inspect-work-items` 授权，按 owner lineage 在分页前过滤，支持新会话历史任务与报告分页读取；不恢复旧执行、授权或预算。
- Delivery schema 28 区分可信终止观察和业务结果，非成功业务结果仍为 unknown；原输入按 owner/sourceDigest 分页召回。Automations Host 接口支持一次有界原生 Agent，冻结模型、工具、期限与额度；WorkItems 消费者负责重核来源与 owner。终态报告接入真实 outbox/Evaluation，ready 不代表独立成功，入队不代表送达。没有增加另一套 Agent Loop。

## 当前交付

pre-owner 源码维护接入原生基础资源迁移：Docker→native 和 native→native 使用独立 v3 证明，阶段内替换 runtime、release 工具链/store/cache 与 cohort；初始身份、授权资源与签名源码历史保留，维护记录仍为 `host:null`。不创建 owner/runner、不刷新额度。原生降级回 Docker、混合后端和 owner 专用资源拒绝。

配置预览只核对已冻结内容；正式停服阶段重新迁移并绑定实际 inode，切换/恢复重验同一目录身份，拒绝同内容复制品。阶段失败恢复原资源；备份清理开始后失败保留候选并报错。独立复核发现的目标祖先 symlink 外写问题已在 Linux 以同一负例完成修前 3 FAIL、修后无外部变化的验证。

原有最终候选依赖准备与断网原生安装证明继续保留。当前专项：Linux 基础迁移 42 passed / 1 平台 skipped，资源事务 35 passed，安装辅助 201 passed；Mac 对应 8/38、29/6、185/16（passed/skipped）。资源事务和安装入口含明确替身边界，不代表完整活服务升级。入口首轮暴露的两项改名恢复失败已修复：仅指定原备份可用事务冻结摘要验证完整源码身份，普通 reader 仍核对活 Home。真实 Git/签名专项两端各 17 passed，Linux 恢复入口重跑 2 passed；入口其余 10 项已通过。精确提交的两端根检查待完成；下方完整检查仍为上一交付基线。

## 后续工程与延后验收

1. 非空 review 历史 CAS/封存组件已有专项，但 installer、Host head、运行时消费者和非空 adoption 资格仍缺；旧 Docker 证书不能当作 Linux 资格。
2. Router 跨信道协调、订阅直通与普通使用成长反馈尚未完整验收。持久任务与诊断不代表自主修改采用或长期收益。两端此前五次真实模型运行额度已用尽，失败与预算不重置。既有真实 Host 合成续办的摘要外召回前提 Mac PASS、Linux FAIL（标识已在 resume 中）；不证明 idle 自动完成或外部送达。
3. 用户已明确延后飞书机器人实连与后续真实使用验收。正式连接门保留；完整临时双服务升级、就绪、回滚及活 Home 切换未验收。owner 升级的空业务采用 CAS 已实现；其非空迁移、复制恢复及 native→native 尚不支持，不能以 pre-owner 迁移代替。

远端同级 20 个及嵌套 8 个目标 worktree 已清理并独立 PASS，独有成果保全，归档候选未全部整合。未发布、未合入 main、未触碰活服务；全局 CLI 实际在 `~/.npm-global`。

## 最新完整检查

命令 `CI=1 VITEST_MAX_WORKERS=2 pnpm_config_verify_deps_before_run=error pnpm check`，pnpm 11.7.0。两端均为精确实现提交 `230d4807`，tree `21626106bbbdfadd299046146bee3769c78506d2`。

| 环境与精确源码 | 结果 | 测试 passed / skipped | 文件 passed / skipped | 日志 SHA-256 |
| --- | --- | --- | --- | --- |
| Mac / Node 26.11.1 / `230d4807` | EXIT 0，独立 PASS，1106.98 秒 | 9,705 / 1,890 | 675 / 85 | `85fb834a9976d7730379ac1b5dd27d344d5b2382a860b9d2295fa07c9fd81ab0` |
| Linux / Node 24.7.0 / `230d4807` | EXIT 0，独立 PASS，2313.72 秒 | 11,289 / 303 | 728 / 32 | `58553b5af33cb5cc00ab88eaa67a31eea6b67294197013399c4d5bc94a265541` |

两端均已独立核对 manifest、零警告 lint、38 包构建、38 个类型检查、39 个测试组及 38 个唯一 dry-run pack；Lark 包含本次变更的两个安装模块的 JS、类型声明及 map。Linux 安装器文件 491 passed / 1 skipped。Linux 使用 `TMPDIR=/data00/home/jiataorui/t`，两端各自检查前后的提交一致，且 tracked 工作树干净。本轮原始日志和复核见 `docs/evidence/verification-230d4807/`；实际候选包安装证据见 `docs/evidence/pre-owner-candidate-proof/`。

历史失败均保留原始证据；修复后的检查按实际源码单独记录。上述检查不代替跳过项、外部连接、活服务升级或长期普通使用验收。
