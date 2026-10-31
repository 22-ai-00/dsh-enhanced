# RSI 当前状态

更新：2026-10-30。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实现及验证查 Git。

## 当前交付与能力边界

- 去除 Linux 安装与自迭代的 Docker 依赖，保留隔离执行、完整源码修复、工具创建/修订、独立验收、有限采用、发布与回退；合同见[原生运行时](dockerless-runtime.md)。原生执行及这些能力已接线，实测范围为 Linux x64/cgroup v1；cgroup v2 明确拒绝，arm64 未实测。
- Linux 全新 `--install-owner` 已接入原双 Host 事务，五个 runner 在授权前固定账本身份。完整源码 prepare 已在原 1800 秒、8 CPU、16 GiB 限额内实测通过；签发真实 owner 授权并启动双 Host 的原生新装，以及原生修订、发布、采用、回退全链仍待实机验收。
- 普通成对升级已接入撤权扫描迁移：候选首次 Host 前，以冻结来源及 Delivery 撤权记录证明四类旧扫描的永久退休，通过正式 Policy/Automations 入口执行，保留原预算、history 与 unknown。原 source 不改写，只有精确完成证明允许候选状态变化；中断恢复拒绝复活旧扫描，成功后整体归档证明。专项、独立复核与冷全检已通过，尚未发布或生产部署。
- 已交付 docker→linux-native 保权移交原语，尚未接入生产升级事务：账本升到 schema 9，历史行以 `migrated=1` 退出活跃/预留/恢复/容量统计但继续计入已用额度；`migrateLinuxVerifierRunnerState` 在同一事务内把未完成任务结算为 unknown、退休创建见证与旧控制租约、按新 authority 重写 verification grant、按 staging 文件身份重封 seal；`prepareLinuxRepositoryHandoverState` 只接受全新空库。独立复核 PASS。真实升级仍缺脚本侧 schema 3 候选读取、原生 creation 构建物化、原生资源 staging 与事务接线，以及受控 Home 实机验证。
- 已交付原生家族重定位原语 `rsi-linux-native-relocation`（同为未接入升级事务的基础件）：在候选 Home 与 stage 物理 Home 之间复制并校验 base runtime、repository runtime、behavior runtime 与完整源码 creation 构建物，按逻辑路径重写 receipt 后重算并重封全部摘要，记录每个元素的 `dev/ino` 与树 `/ sha256` 证明；`verifyLinuxRsiNativeRelocation` 在切换前只以物理树校验证明，使同文件系统 `rename(2)` 切换后仍满足各 stock reader 的绝对 `dshHome`、`runtime.root.path` 与根身份断言。因原生 receipt 绑定绝对 Home 与根 `dev/ino`，直接复制 Home 到 stage 必然失效，此原语是该移交的可行形态。release build 家族、runner state seal 与 source-build 授权编译尚未覆盖。
- 新增可选工作项插件 `assistant-work-items`（`enabled: false`、observe 模式）：跨会话可认领工作项账本（SQLite）、去重准入与 `work_item_claim`/`work_item_report`/`work_item_status` 三个工具及服务接口，为无上下文自助任务提供外部可注入的工作队列基底。尚无真实外部信号源，Host 必须调用 `admit()` 注入；评估、学习与采用反馈未实现。
- Wiki 合法内容下次读取刷新，无需重启；前台等待、取消及进度收尾有界。同码维护重启只续办可证明无未知副作用的只读任务，保留原模型和剩余预算，每任务最多一次。任意硬崩溃续办、无句柄旧卡片回填、独立飞书连接及真实复杂任务最终回复尚未验收。

## 活跃阻碍与下一验收

- 本机 target/coordinator 仍为 `0.1.64`、active/running、NRestarts=0，Host 为 `0.2.1-rc.2`。14:18 UTC 只读 Delivery 快照确认唯一 active owner 与冻结 record 一致，均为 version 1；未改原数据库。此安装绑定原源码仓库，应走 owner/program 升级，不能套用普通 npm 成对升级，也不能改历史 `0.1.48` marker 绕过准入。
- 本机程序升级仍使用 Docker build reader、creation 与 staging，明确拒绝 schema 3 原生候选。下一步把已交付的账本移交与原生家族重定位原语接入同 owner 原生候选的升级事务，在受控 Home 副本验证后再生产升级；不能只删除拒绝分支。接线还缺四段：release build 家族随 Home 重定位（其 pin 含绝对 `pnpmRoot/storeRoot/cacheRoot` 路径，须重写并重算 `runtimeDigest`）、候选侧原生 repository runtime 与 creation build 准备、stage 侧 native `sourceBuild` 授权编译所需的 runner state seal（须按逻辑路径在 stage 准备随切换生效）、以及 `host-rsi-update`/恢复路径按 backend 读取 creation receipt。必须保留身份、会话、模型/凭据、授权范围/期限、各原账本已用额度、unknown 及回退点，不重装重签额度。移交要求调用方传入与升级后 owner 配置完全一致的 `expiresAt/maxRuns/maxTotalDurationMs`（grant 固定 revision 1，不一致会在切换后首次 `syncGrants` 才失败）；schema 8 原生 seal 没有升级路径，需显式 `resealLinuxRunnerState({ requireEmpty: false })` 或弃用重装。本机 owner 有效，撤权退休属于 no-op，无需为此扩展退休事务。
- 公开版本仍为 `0.1.65`，已修复受管 hoisted 安装的依赖解析。远端最后成功检查为 10:52 UTC：target/coordinator `0.1.65`、运行中、Host `0.2.1-rc.2`；当前 SSH 认证失败，未刷新状态。远端此前已补齐 uidmap/libsubid4、映射 helper 和四个 cgroup v1 资源根，11 项隔离边界检查通过。
- 远端旧 owner 已 revoked/version 2（冻结 version 1），当前 Lark DM owner 是不同 record，四份旧扫描仍 active；当时近 30 分钟 usage/task-observation 共 60 次 failed、live-qualification 30 次 unknown。永久退休后仍需明确的新 owner 代次与原累计额度连续性；不能恢复撤销身份、转移旧 grant 或以新 ID 重置额度。profile 虽名 `web`，此次恢复不需要新增 Web 接入。
- 尚不能称为无感：既有首次采用约 38 秒、冷恢复约 13 秒、简单工具调用约 25 秒。旧 pending/unknown 与一次 lost-resource-ack 清理未确认记录继续保留；同 UID 监督器不隔离恶意 Host 插件。三个 API provider 已迁移并验证自定义路线，官方 DeepSeek 返回 401；旧私聊保留 TraeX 选择。完整 Hermes 历史及 75 项技能迁移、真实普通任务的长期学习收益未完成。

## 最新验证

- 本轮原生重定位原语与 `assistant-work-items` 在远端 Linux 的同树全量检查退出 0：10355 项通过、301 项条件跳过、0 失败，清单/lint/typecheck/构建及 38 包 dry-run pack 全通过，用时 2772 秒，日志 SHA-256 `d8864cf32b02a6936bc4aeb6663ca8502a2bad1e6cd69d6184db3a4ea6a2ebca`；两树待提交内容逐文件摘要一致。首轮全检因既有 `personal-memory` 预算窗口测试跨 60 秒 wall-clock 边界失败一次（`periodStart` 取整），同树重跑通过，该测试需改为注入确定时钟。重定位原语 13 项真机用例只在 Linux 执行，macOS 本地跳过，故 Linux 结果为准。
- 本轮扫描迁移在无既有 `lib/node_modules` 的独立副本完成 frozen 安装及根 `pnpm check`，均退出 0：10298 项通过、301 项条件跳过、0 失败，清单/lint/typecheck/构建及 37 包 dry-run pack 全通过，四个新增退休模块的 JS/声明文件入包。两树 1831 项源码内容与权限前后一致，用时 1661.33 秒，日志 SHA-256 `bb559613d59ff1363b014372347c7082e1b494768d13ff6fc9fb530e1ab30974`；独立最终复核 PASS。102 项组合、22 项父层升级回归及实际 namespace 的 v15/v16 迁移、四处 SIGKILL、超时后子进程清理另有通过记录。证据在忽略目录 `docs/evidence/retirement-upgrade/`；检查后仅更新本页。替身覆盖不等于真实双 Host 升级，条件跳过不提供实机证据。
- 基线提交 `2d192f10` 的 [CI 41054405419](https://github.com/22-ai-00/dsh-enhanced/actions/runs/41054405419) 已全部通过，含 Linux root/packages、Windows smoke 与 macOS 全检；本轮迁移仍需精确提交的跨平台 CI 及安装/运行就绪验证才能发行。
- 已有原生准备实测：独立 Home 中 19 bundles/27 包安装、正式 `--prepare-build` 和已安装 `rsiInstallPorts.prepare` 通过；完整源码 prepare 单次 1649.50 秒，退出 0，原源码及五账本不变、资源及 namespace 已清理，独立复核 PASS。原始证据在忽略目录 `docs/evidence/native-install-live/attempt-2/` 与 `docs/evidence/native-full-source-prepare/attempt-1/`；这些结果不替代生产 owner 授权、双 Host 启动或学习收益验收。
