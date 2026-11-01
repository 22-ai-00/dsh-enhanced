# RSI 当前状态

更新：2026-11-01。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实现及验证查 Git。

## 当前交付与能力边界

- 去除 Linux 安装与自迭代的 Docker 依赖，保留隔离执行、完整源码修复、工具创建/修订、独立验收、有限采用、发布与回退；合同见[原生运行时](dockerless-runtime.md)。原生执行及这些能力已接线，实测范围为 Linux x64/cgroup v1；cgroup v2 明确拒绝，arm64 未实测。
- Linux 全新 `--install-owner` 已接入原双 Host 事务，五个 runner 在授权前固定账本身份。完整源码 prepare 已在原 1800 秒、8 CPU、16 GiB 限额内实测通过；签发真实 owner 授权并启动双 Host 的原生新装，以及原生修订、发布、采用、回退全链仍待实机验收。
- 普通成对升级已接入撤权扫描迁移：候选首次 Host 前，以冻结来源及 Delivery 撤权记录证明四类旧扫描的永久退休，通过正式 Policy/Automations 入口执行，保留原预算、history 与 unknown。原 source 不改写，只有精确完成证明允许候选状态变化；中断恢复拒绝复活旧扫描，成功后整体归档证明。专项、独立复核与冷全检已通过，尚未发布或生产部署。
- 已交付并接入 docker→linux-native 保权移交与原生 owner 升级事务：账本升到 schema 9，历史行以 `migrated=1` 退出活跃/预留/恢复/容量统计但继续计入已用额度；`prepareLinuxRepositoryHandoverState`/`prepareLinuxVerifierHandoverState` 在 stage 内发布随同文件系统 `rename(2)` 切换仍有效的 seal（记录逻辑 live 路径与 staging 物理 `dev/ino`），`migrateLinuxVerifierRunnerState` 在同一事务内把未完成任务结算为 unknown、退休创建见证与旧控制租约、按新 authority 重写 verification grant 并重新封存；seal 一经发布即一次性，恢复流程不会复用或重开。原生候选现在走**同一** owner program 升级事务：stage 侧拒绝原 Docker 树、重定位并重封原生家族、按 manifest 是否已带 `pluginRevision` 固定三个或五个 runner seal，其中无 Docker 历史账本的角色按全新空账本原位封存、由首次领取的 `syncGrants` 建立 grant、按 repository seal 编译 `sourceBuild` 授权、在 creation setup 之后重写 creation（及 revision）verifier grant，并以同一 creation build 与 `expiresAt` 重编修订授权（`pluginRevision`、`revisionVerifications`/`revisionRegressions` 及 verifier 两条修订评审道），最终仍由原 `verifyOwnerProgramUpdate`、journal 与回退点收尾。
- 原生家族重定位 `rsi-linux-native-relocation` 现已覆盖 base runtime、repository runtime、behavior runtime、完整源码 creation 构建物与 release build（重写其绝对 `pnpmRoot/storeRoot/cacheRoot` pin 并重算 `runtimeDigest`）：在候选 Home 与 stage 物理 Home 之间复制（不移动）并校验，记录每个元素 `dev/ino` 与树 `/ sha256`，切换前只以物理树校验，使同文件系统 `rename(2)` 后仍满足各 stock reader 的绝对 `dshHome`、`runtime.root.path` 与根身份断言。新增 `rsi-linux-native-resources`（prepare/stage/verify 三段）负责 stage 内的原生资源整理、Docker 树清理与 cohort receipt 重基，并作为 installer 唯一新增的 reviewed seam 模块。
- 新增可选工作项插件 `assistant-work-items`（`enabled: false`、observe 模式）：跨会话可认领工作项账本（SQLite）、去重准入与 `work_item_claim`/`work_item_report`/`work_item_status` 三个工具及服务接口，为无上下文自助任务提供外部可注入的工作队列基底。尚无真实外部信号源，Host 必须调用 `admit()` 注入；评估、学习与采用反馈未实现。
- Wiki 合法内容下次读取刷新，无需重启；前台等待、取消及进度收尾有界。同码维护重启只续办可证明无未知副作用的只读任务，保留原模型和剩余预算，每任务最多一次。任意硬崩溃续办、无句柄旧卡片回填、独立飞书连接及真实复杂任务最终回复尚未验收。

## 活跃阻碍与下一验收

- 本机 target/coordinator 仍为 `0.1.64`、active/running、NRestarts=0，Host 为 `0.2.1-rc.2`。14:18 UTC 只读 Delivery 快照确认唯一 active owner 与冻结 record 一致，均为 version 1；未改原数据库。此安装绑定原源码仓库，应走 owner/program 升级，不能套用普通 npm 成对升级，也不能改历史 `0.1.48` marker 绕过准入。
- 原生升级事务已接线；真实 Docker 时代 Home 副本（`cp -a`、9.50 GB/157,338 项）上的五角色 seam 演练已通过（无 Docker 历史账本的角色走 `fresh`、空 schema 9 账本 + seal 经 `inspectLinuxRunnerState`、staging 不写副本 live 树、一次性拒绝 3/3、真实 Home 的 manifest 与 runner 目录未变），但完整 installer 事务（manifest 改写、grant 重编、journal/回退点）尚未在受控 Home 实机跑通一次真实的 docker→linux-native 升级：原生primitives 只在非 root Linux 可执行，macOS 只能做结构验证，需在 Linux Host 上继续验收（含 owning 授权、账本额度、unknown 与回退点连续性）。移交要求调用方传入与升级后 owner 配置完全一致的 `expiresAt/maxRuns/maxTotalDurationMs`（grant 固定 revision 1，不一致会在切换后首次 `syncGrants` 才失败，另有过大额度以独立错误拒绝）；`after-finalize` 复核尚未重新检查 staged seal 与重写后的 grant 行（C2-F 后为五个角色）。schema 8 原生 seal 没有升级路径，需显式 `resealLinuxRunnerState({ requireEmpty: false })` 或弃用重装；已带 `pluginRevision` 的 manifest 现已解禁：原生升级会固定五个 runner 角色并重编修订授权，Docker 候选后端则明确拒绝，但同样尚未实机跑通。
- 公开版本仍为 `0.1.65`，已修复受管 hoisted 安装的依赖解析。远端最后成功检查为 10:52 UTC：target/coordinator `0.1.65`、运行中、Host `0.2.1-rc.2`；当前 SSH 认证失败，未刷新状态。远端此前已补齐 uidmap/libsubid4、映射 helper 和四个 cgroup v1 资源根，11 项隔离边界检查通过。
- 远端旧 owner 已 revoked/version 2（冻结 version 1），当前 Lark DM owner 是不同 record，四份旧扫描仍 active；当时近 30 分钟 usage/task-observation 共 60 次 failed、live-qualification 30 次 unknown。永久退休后仍需明确的新 owner 代次与原累计额度连续性；不能恢复撤销身份、转移旧 grant 或以新 ID 重置额度。profile 虽名 `web`，此次恢复不需要新增 Web 接入。
- 工程进化要求的进程内热加载仍未交付：控制平面只把 profile 原子换入并停在 `awaiting-reload`，生效依赖整服务 systemd 重启；`docs/rsi-acceptance.md` 的工程进化通道明确“整 Host 重启不能证明此通道完成”。它不是去 Docker 的回归项（Docker 时代 Host 同样只重启），单独按该通道验收。
- 尚不能称为无感：既有首次采用约 38 秒、冷恢复约 13 秒、简单工具调用约 25 秒。旧 pending/unknown 与一次 lost-resource-ack 清理未确认记录继续保留；同 UID 监督器不隔离恶意 Host 插件。三个 API provider 已迁移并验证自定义路线，官方 DeepSeek 返回 401；旧私聊保留 TraeX 选择。完整 Hermes 历史及 75 项技能迁移、真实普通任务的长期学习收益未完成。

## 最新验证

- 原生移交/全新封存事务所在的 `dev` 提交 `ce1c1837` 在远端 Linux 同树根 `pnpm check` 退出 0：10408 项通过、301 项条件跳过、0 失败，清单/lint/typecheck/构建及 38 包 dry-run pack 全通过，日志 SHA-256 `170fb39d8fd22c725507aefd8bafa7d6c0fa2af3af1c1791435262395ced4b01`；此前 `5ee79b43` 基线为 10375 通过/301 跳过/38 包，日志 SHA-256 `62ec0ac4b14ff0d7f24f2610cad788e4259ad1b460b92668095f427c4f4e72c0`。Linux 门控的移交/切换用例（`linux-runner-state-migration.spec.ts`）与原生重定位 13 项真机用例在此次 Linux 全检中真实执行，macOS 本地跳过，故 Linux 结果为准；既有 `personal-memory` 预算窗口用例仍靠 60 秒 wall-clock 取整，需改为注入确定时钟。
- 本轮扫描迁移在无既有 `lib/node_modules` 的独立副本完成 frozen 安装及根 `pnpm check`，均退出 0：10298 项通过、301 项条件跳过、0 失败，清单/lint/typecheck/构建及 37 包 dry-run pack 全通过，四个新增退休模块的 JS/声明文件入包。两树 1831 项源码内容与权限前后一致，用时 1661.33 秒，日志 SHA-256 `bb559613d59ff1363b014372347c7082e1b494768d13ff6fc9fb530e1ab30974`；独立最终复核 PASS。102 项组合、22 项父层升级回归及实际 namespace 的 v15/v16 迁移、四处 SIGKILL、超时后子进程清理另有通过记录。证据在忽略目录 `docs/evidence/retirement-upgrade/`；检查后仅更新本页。替身覆盖不等于真实双 Host 升级，条件跳过不提供实机证据。
- 基线提交 `2d192f10` 的 [CI 41054405419](https://github.com/22-ai-00/dsh-enhanced/actions/runs/41054405419) 已全部通过，含 Linux root/packages、Windows smoke 与 macOS 全检；本轮迁移仍需精确提交的跨平台 CI 及安装/运行就绪验证才能发行。
- 已有原生准备实测：独立 Home 中 19 bundles/27 包安装、正式 `--prepare-build` 和已安装 `rsiInstallPorts.prepare` 通过；完整源码 prepare 单次 1649.50 秒，退出 0，原源码及五账本不变、资源及 namespace 已清理，独立复核 PASS。原始证据在忽略目录 `docs/evidence/native-install-live/attempt-2/` 与 `docs/evidence/native-full-source-prepare/attempt-1/`；这些结果不替代生产 owner 授权、双 Host 启动或学习收益验收。
