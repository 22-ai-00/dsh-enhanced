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

pre-owner 源码维护新增最终候选准备：共用正式安装的 roots/peer/workspace 投影，在匿名临时 Home 解析、预取并重新校验候选依赖图；空 node_modules 副本实际断网调用原生 DSH 安装，首个服务操作前重核原 Home、外部准备产物、工具及缓存，停服后继续核对最终图和完整包清单。缓存 SQLite 使用在线 backup。native 候选资源激活仍不支持，会提前拒绝。

实现 `230d4807` 已提交到 dev，两端根检查均 EXIT 0、独立 PASS。源码、专项、真实 Linux pnpm/bubblewrap 新依赖与缺包/索引负例、真实 DSH 空 consumer 的断网安装和冷读取已获独立 PASS。新增 13 项入口用例已进入 Linux 完整安装器测试；实际 CLI 修复以显式 `plugin install` 初始化空依赖树，再执行 add 和 inventory 校验。原失败保留；合成包和服务替身不代表完整产品或活服务升级验收。

## 后续工程与延后验收

1. 非空 review 历史 CAS/封存组件已有专项，但 installer、Host head、运行时消费者和非空 adoption 资格仍缺；旧 Docker 证书不能当作 Linux 资格。
2. pre-owner native 候选资源激活仍缺；本次交付证明最终候选包的准备与断网安装。普通 native 资源已通过全新 consumer 断网安装，初始 prepare 仍联网；不能将两者混称。
3. Router 跨信道协调、订阅直通与普通使用成长反馈尚未完整验收。持久任务与诊断不代表自主修改采用或长期收益。两端此前五次真实模型运行额度已用尽，失败与预算不重置。既有真实 Host 合成续办的摘要外召回前提 Mac PASS、Linux FAIL（标识已在 resume 中）；不证明 idle 自动完成或外部送达。
4. 用户已明确延后飞书机器人实连与后续真实使用验收。正式连接门保留；完整临时双服务升级、就绪、回滚及活 Home 切换未验收。空业务采用 CAS 已实现，复制恢复、非空迁移及 native→native 尚不支持。

远端同级 20 个及嵌套 8 个目标 worktree 已清理并独立 PASS，独有成果保全，归档候选未全部整合。未发布、未合入 main、未触碰活服务；全局 CLI 实际在 `~/.npm-global`。

## 最新完整检查

命令 `CI=1 VITEST_MAX_WORKERS=2 pnpm_config_verify_deps_before_run=error pnpm check`，pnpm 11.7.0。两端均为精确实现提交 `230d4807`，tree `21626106bbbdfadd299046146bee3769c78506d2`。

| 环境与精确源码 | 结果 | 测试 passed / skipped | 文件 passed / skipped | 日志 SHA-256 |
| --- | --- | --- | --- | --- |
| Mac / Node 26.11.1 / `230d4807` | EXIT 0，独立 PASS，1106.98 秒 | 9,705 / 1,890 | 675 / 85 | `85fb834a9976d7730379ac1b5dd27d344d5b2382a860b9d2295fa07c9fd81ab0` |
| Linux / Node 24.7.0 / `230d4807` | EXIT 0，独立 PASS，2313.72 秒 | 11,289 / 303 | 728 / 32 | `58553b5af33cb5cc00ab88eaa67a31eea6b67294197013399c4d5bc94a265541` |

两端均已独立核对 manifest、零警告 lint、38 包构建、38 个类型检查、39 个测试组及 38 个唯一 dry-run pack；Lark 包含本次变更的两个安装模块的 JS、类型声明及 map。Linux 安装器文件 491 passed / 1 skipped。Linux 使用 `TMPDIR=/data00/home/jiataorui/t`，两端各自检查前后的提交一致，且 tracked 工作树干净。本轮原始日志和复核见 `docs/evidence/verification-230d4807/`；实际候选包安装证据见 `docs/evidence/pre-owner-candidate-proof/`。

历史失败均保留原始证据；修复后的检查按实际源码单独记录。上述检查不代替跳过项、外部连接、活服务升级或长期普通使用验收。
