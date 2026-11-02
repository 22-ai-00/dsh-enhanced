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

`2fe7fc92` 交付前台任务的可信终止观察：Delivery schema 28 原子保存完成、异常、超时、owner 取消或中断的固定事实；原有业务结果与未知副作用保持原语义，观察不授权重放。当前 owner 可按来源摘要及 UTF-8 字节分页读取原始输入；Native Web 记录实际请求的 provider/model/effort，供应商变化永久标记 inconsistent。安装器和只读快照消费者精确支持 schema 23–28；本次补齐 Web owner doctor 的 24–28 检查，各自拒绝未审查版本。修复后的完整根检查待完成。

用户于 2026-11-02 明确延后飞书机器人实连和后续真实使用验收，当前先完成代码、单测及可离线核实项。依赖实连的临时双服务升级尚未验收；保留连接门，不以模拟连接替代。

临时真实 Host `0.2.1-rc.2` 已在 Mac/Linux 运行正式 pairing、原生 sessions/automations 及五个真实插件；独立 Home、凭据只读、活服务未改。两端使用现有 `super-relay / auto_model/alwaysday1`，Mac 为 completions、Linux 为 responses，不能视为同 API 性能比较或供应商切换验收。

- Mac 两轮 waiting→同 Home 重启→ready 独立 PASS，128.54/100.01 秒；新 occurrence/session、attempt 2、零审批、累计预算 2/2。六项库存结果和独立预期一致；真实 session 证明审计标识不在 resume/partial，首次通过 revision 1 的完整报告召回。
- Linux 两轮同样通过功能验收，126.75/75.11 秒，最终工件、预算 2/2、零审批及 Host 正常退出经独立复核。但等待报告重复了审计标识，512 字节 resume 已包含它，故“必须依赖摘要外召回”的前提 FAIL。已纠正父层初次检查遗漏，保留原始证据。
- 固定通用 prompt 后才生成独立输入；本批生产模型运行总上限 Mac 3 次（含保留的原审批超时失败）、Linux 2 次，已用尽。失败及预算未重置。合成输入不证明 ordinary-use 学习；Outbox pending 不证明外部送达；到期后重启不证明 idle 自动唤醒。

普通失败自动诊断尚未接通：新终止观察和原输入 reader 已补齐来源基础，但 WorkItems 适配、准入时冻结原供应商/独立诊断预算/只读工具契约，以及 Automations 拥有的原生 Agent 执行接口仍待实现。原任务 unknown 不得解释为失败重放；缺失或 inconsistent 的模型记录不得回退到默认供应商。下一交付应在这一边界内打通真实失败信号到有界诊断报告。

## 原生升级剩余工作

2026-11-01 14:33 UTC 只读快照：live Home `/data00/home/jiataorui/.dsh`；assistant 与 rsi-assistant-a39a7ffad4a3 两个 unit active/running、NRestarts=0；增强包 `0.1.64`、Host `0.2.1-rc.2`。当前 owner active/version 1、唯一 active binding generation 8；历史 revoked binding 不等于 owner 撤销。

2026-11-02 私有副本盘点：实际 creation-review 库 grants/verifications 均为 0；采用库 schema 3，authority 为 1，adoptions/calls/source_archives 均为 0，完整 schema 摘要与当前组件一致。CP 保留 24 条 source maintenance，不能当作工具采用；两个创建 runner 账本路径不存在，revision 未配置。各库源内容/身份均未变；这不是跨库原子快照或签名配置验收，停服后仍须再次核实。

全局 CLI 实际在 `~/.npm-global`，直接 `upgrade-program.mjs` 不做 CLI 自更新。活 Home、两个服务停启与原子切换尚未执行；应先完成以下缺口，再提交具体维护方案和授权范围：

1. 空业务采用 CAS 已接入安装器及签名 overlay。只读副本核对实际配置、完整旧授权与 schema；任何 review grant/verification 或 adoption/call/archive 历史、已配置但缺失的库都拒绝。资源迁移前和 finalizer 重查，实际维护时间不超五分钟及原期限，owner/key/额度/期限/retention 不变；两个启动前点验证同 inode 与空表，正常运行后允许新业务。仍须跑完整临时 Home 升级、就绪和回滚；复制恢复、非空迁移及 native→native 不支持。旧版临时准备在配置组合阶段失败，原始现场保留。修正版未执行：还需官方 fresh Host 绑定、独立完整源码仓库、短 observer socket 路径及真实测试机器人；这些是验收脚本前提，未改变产品准入门。
2. 非空历史路径仍待接线：review v1 CAS 保持 used/maximum/history；v2 冻结三 lane 公开身份、最多 1,000 历史成员与 64 步精确证书封存，依赖外部可信 head。原始 TEXT、旧未知成员重新签名、审计漂移与删除历史负例已独立复核；installer、Host head、运行时消费者及非空 adoption 资格仍缺。同 digest copy-only 未支持；旧 Docker 证书不能冒认 Linux 执行资格。
3. `ac3671fa` pnpm 应用文件 pin 专项及独立复核 PASS（Mac 44、Linux 41）：覆盖实际 native target 或标准 JS package、完整 dist/bin/包内 node_modules、实际 Node 可执行入口与选择；managed launcher 直接运行冻结 target，禁止 packageManager 自动换版本。Node 共享库（包括 libnode）及其他系统依赖仍属 host toolchain 信任边界，不是完整 Node runtime seal。
4. pre-owner 离线预热当前绑定旧 profile metadata/lock；停服前最终候选依赖图、策略结果和真正断网安装证明待补齐，停服后原校验须保留。旧 scoped-token 候选被真实 pnpm 的 `(protected)` 输出证伪，不能恢复旧支持声明。

远端同级 20 个 worktree 及 8 个嵌套验收 worktree 已清理，独立复核 PASS；完整 tar、patch、index、清单及独有成果保留。513 个改动文件全部在 archive，257 在审计时与 `dev@011595b7` 内容一致、126 已在 dev 历史；其余为合成证据、中间版本和上述待整合候选。“备份完成”不代表所有候选逻辑已合入。

## 最新检查

来源基础的定向验证：Store/source-feed/foreground-execution 在 Mac Node 24.7.0 和 26.11.1 各 53 PASS，快照 69 PASS / 3 skipped，Lark schema 消费者 93 PASS，安装器纯契约 3 PASS。真实原生 Agent 的模拟模型回归覆盖两种入口和延迟创建后的同一 deadline；复核发现的原始 Inbox 字节校验与 deadline 分类问题已修正并保留红绿证据。Delivery 构建、完整 noEmit 类型检查和变更生产文件零警告 lint 均 EXIT 0；原始材料在 `docs/evidence/foreground-termination-{store,producers,compat,integration}/`。

`2fe7fc92` Mac 根检查 FAIL：Web doctor 漏接 schema 28，两个 owner 读取测试得到 unavailable；331.01 秒，EXIT 1，日志 SHA `0b5ce06c459fc8b1ab0ce63de73f92e641c3ab3eb576f29f1e4bdd0261802b1e`。Linux 同提交在确认该兼容问题后主动中止，479.16 秒、EXIT 130，不视为 PASS 或测试 FAIL。两端源码稳定、原始结果及中止原因保留在 `docs/evidence/verification-2fe7fc92/`。修复只补充已审查的 Web doctor 版本及只读回归；Mac 完整 Web owner 80 项、构建、类型检查和 lint 均 EXIT 0，证据在 `docs/evidence/foreground-termination-doctor/`。修后双端根检查和 Linux schema 28 生命周期实例待完成。最新完整通过仍为以下基线。

精确源码提交 `7b90d8dce9b4af4753dd78c5e284612332760ef0`、tree `de3c16d2a6ba32cb4e38f3ec8fb18f1258cae34b`；两端命令均为 `CI=1 VITEST_MAX_WORKERS=2 pnpm check`，pnpm 11.7.0。manifest、零警告 lint、构建、类型检查、测试及 dry-run pack 全部完成；child/runner 均 EXIT 0、源码稳定、无中断。

| 环境 | 测试 passed / skipped | 文件 passed / skipped | 耗时 | 日志 SHA-256 |
| --- | --- | --- | --- | --- |
| Mac / Node 26.11.1 | 9,354 / 1,872 | 658 / 86 | 1153.58 秒 | `08821168632d02021e5b9415355ceb720a6bef2bf564cb35b2be11e90645b6d6` |
| Linux / Node 24.7.0 | 10,922 / 301 | 712 / 32 | 1924.47 秒 | `4b1f1b4ea8978417d8d278382465dc43915a399c1a6f77fcda7dfc2aa93d0022` |

- 每端均有 39 个测试组、38 个包及 38 个类型检查完成记录；两端已按精确 Git manifests 独立逐项核对，结论均为 PASS。原始日志、结果与复核记录位于 `docs/evidence/verification-7b90d8dc/`。
- 检查点测试恢复生产默认 30 秒租约，5 秒等待、250ms 检查点阻塞及全部原生 Goal/数据库断言不变；生产代码未改。定向负例证明 1.1 秒事件循环停顿足以使旧 1 秒 fixture 合法丢失租约，默认租约下完成原断言，无 Goal 对照仍主动释放；这不追认此前根检查的具体负载原因。Linux 本次完整 Delivery 组 1,023 项全部通过，原 `a587b19d` 失败日志保留。
- 非根基线专项另覆盖 Mac Node 24/26 与 Linux Node 22/24：v2 review 各 100 项、空业务采用 CAS 各 53 项、空历史检查各 39 项、安装接线各 104 项通过并独立复核。它们不等于四种环境都完成根检查。
- 未发布、未合入 main、未执行 live 原生升级。平台或外部前提导致的跳过、冷安装/prepare 与合成任务，不替代真实连接、普通使用和成长收益验收。
