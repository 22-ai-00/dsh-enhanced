# RSI 当前状态

更新：2026-11-02。验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实现和验证查 Git；原始日志位于忽略的 `docs/evidence/`。

## 目标与交付纪律

Linux 去除 Docker 依赖且保留能力；用持久任务、原生 Agent、独立证据和有限采用，减少用户管理上下文与逐步审批的负担。仅保留 `dev`、`main`：开发提交推送走 `dev`，通过发布验收后才合入 `main`。

## 当前能力边界

- Linux 原生隔离、完整源码 prepare、工具创建/修订、独立验收及 owner 升级事务已有实现；runner schema 9 保留 staging、seal、累计额度和 unknown。Linux x64/cgroup v1 已有 prepare 与隔离实测；cgroup v2 拒绝、arm64 未验收。完整 live Docker→native 升级尚未通过。
- 可选 `assistant-work-items` 默认关闭、observe 模式。持久准入、派发、认领、报告、等待续办及 owner/Policy/撤回围栏已交付；schema 8 增加到期派发索引和公平游标，没有新增 Agent Loop。
- claim 的 `resume` 包含先前尝试、最多五条有界报告摘要和结算；`work_item_read_report` 按 UTF-8 字节分页召回当前工作项完整报告及相邻 revision。四个工具均受 exact-definition、owning-Fiber 和当前 owner/参数复核约束；预授权消除范围内的重复审批，实际 execute 再校验，deny/急停不被旁路。
- active intake 复用原生 `onSchedulerWake`，每轮最多检查十个到期 waiting-resume；晚绑定、替换、关闭有生命周期保护，scheduler callback 不自动重投 unknown 派发，旧 peer 保留启动/claim 惰性恢复。真实调度组件证明到期入队，执行处于 maintenance pause，尚未证明 idle Host 的真实模型完成。
- 终态报告进入真实 Delivery outbox 和 Evaluation；worker ready 不是独立成功证明，通知排队不是送达。`follows` 仅支持线程关闭结算，尚非事件订阅直通；Router 跨信道协调、普通任务成长反馈及长期收益待完成。

## 当前交付与验证

本轮先收齐 pnpm 执行文件校验及 Mac/Linux 根全检，再推进 owner 升级的历史授权连续性。根全检期间冻结源提交；能力专项不能代替根检查。

临时真实 Host `0.2.1-rc.2` 已在 Mac/Linux 运行正式 pairing、原生 sessions/automations 及五个真实插件；独立 Home、凭据只读、活服务未改。两端使用现有 `super-relay / auto_model/alwaysday1`，Mac 为 completions、Linux 为 responses，不能视为同 API 性能比较或供应商切换验收。

- Mac 两轮 waiting→同 Home 重启→ready 独立 PASS，128.54/100.01 秒；新 occurrence/session、attempt 2、零审批、累计预算 2/2。六项库存结果和独立预期一致；真实 session 证明审计标识不在 resume/partial，首次通过 revision 1 的完整报告召回。
- Linux 两轮同样通过功能验收，126.75/75.11 秒，最终工件、预算 2/2、零审批及 Host 正常退出经独立复核。但等待报告重复了审计标识，512 字节 resume 已包含它，故“必须依赖摘要外召回”的前提 FAIL。已纠正父层初次检查遗漏，保留原始证据。
- 固定通用 prompt 后才生成独立输入；本批生产模型运行总上限 Mac 3 次（含保留的原审批超时失败）、Linux 2 次，已用尽。失败及预算未重置。合成输入不证明 ordinary-use 学习；Outbox pending 不证明外部送达；到期后重启不证明 idle 自动唤醒。

内置前台失败适配器要求 failed/timed-out，而真实 Delivery 将非成功归为 unknown；普通失败尚不能自动成为可执行工作项，原任务输入的受控召回也待补齐。

## 原生升级剩余工作

2026-11-01 14:33 UTC 只读快照：live Home `/data00/home/jiataorui/.dsh`；assistant 与 rsi-assistant-a39a7ffad4a3 两个 unit active/running、NRestarts=0；增强包 `0.1.64`、Host `0.2.1-rc.2`。当前 owner active/version 1、唯一 active binding generation 8；历史 revoked binding 不等于 owner 撤销。

全局 CLI 实际在 `~/.npm-global`，直接 `upgrade-program.mjs` 不做 CLI 自更新。活 Home、两个服务停启与原子切换尚未执行；应先完成以下缺口，再提交具体维护方案和授权范围：

1. `eaf835dc` 已实现 review store existing-only 离线 CAS：冻结文件、业务及维护审计，只变更 grant digest，保持 used/maximum/history，拒绝旧事务 ABA。三个 review lane 的 installer 接线、可信旧证书身份，以及 `creation-adoptions.sqlite` 的采用收据连续性仍待完成。旧 Docker 证书不能冒认 Linux 验收资格。
2. `ac3671fa` pnpm 应用文件 pin 专项及独立复核 PASS（Mac 44、Linux 41）：覆盖实际 native target 或标准 JS package、完整 dist/bin/包内 node_modules、实际 Node 可执行入口与选择；managed launcher 直接运行冻结 target，禁止 packageManager 自动换版本。Node 共享库（包括 libnode）及其他系统依赖仍属 host toolchain 信任边界，不是完整 Node runtime seal。
3. pre-owner 离线预热当前绑定旧 profile metadata/lock；停服前最终候选依赖图、策略结果和真正断网安装证明待补齐，停服后原校验须保留。旧 scoped-token 候选被真实 pnpm 的 `(protected)` 输出证伪，不能恢复旧支持声明。

远端同级 20 个 worktree 及 8 个嵌套验收 worktree 已清理，独立复核 PASS；完整 tar、patch、index、清单及独有成果保留。513 个改动文件全部在 archive，257 在审计时与 `dev@011595b7` 内容一致、126 已在 dev 历史；其余为合成证据、中间版本和上述待整合候选。“备份完成”不代表所有候选逻辑已合入。

## 最新检查

- Mac `d6e1cdc2` 根 `CI=1 VITEST_MAX_WORKERS=2 pnpm check` EXIT 0：9,176 passed / 1,872 skipped，654 文件通过 / 86 条件跳过，39 组测试、38 包 dry-run pack，1244.65 秒。源提交稳定、无中止记录；日志 SHA-256 `4b1d6d793d1697d1b7f1693f38cef325cff35601e9c01baec4c75fe74d541cdc`。条件跳过不建立 Linux 行为证据。
- `6dab65f2`：WorkItems 226 项、Policy 459 passed / 2 skipped；`eaf835dc`：review grant 62 项；`c2b21905`：WorkItems 239 项。相关类型、lint、构建和各自独立复核 PASS。
- `d6e1cdc2` Linux 根 EXIT 1：根测试 1,321 passed / 5 skipped / 14 failed，失败均为 `local-source-policy-cache` 旧自定义 pnpm launcher 被新 pin 拒绝，未进入递归插件测试及打包；Host 收据导入回归已修复，Host/rollback 31 项通过。失败日志 SHA-256 `fa04c2dcf86f4dcdb72aca787a96e8a5722e59b53c8235e65342760218a2e46f`。
- Linux-only 夹具改为真实支持的 pnpm package/bin/dist 布局，保留全部 14 个策略场景及漂移负例，新增固定 manager 配置检查。候选 Linux 14 项 EXIT 0、45.67 秒，独立复核 PASS；生产代码未改。集成后 Linux 根全检待完成。
- 未发布、未合入 main、未执行 live 原生升级。冷安装/prepare、合成任务及条件跳过不替代普通使用与成长收益验收。
