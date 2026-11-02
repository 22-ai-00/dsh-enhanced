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
- Delivery schema 28 持久记录可信终止观察，保留原有业务 unknown；当前 owner 可按来源摘要及 UTF-8 字节分页读取原输入，Native Web 记录实际 provider/model/effort。安装器/快照精确支持 schema 23–28，Web doctor 支持 24–28，均拒绝未审查版本；`fb36ac66` 双端完整根检查及独立复核 PASS。

## 当前交付与验证

当前交付是 Automations 拥有的有界原生 Agent 接口：真实生产 Host occurrence、首次 attempt、`never/0` 重试合同及新预算预留，才能使用同一个私有签发的 invocation 启动一次 Agent。复用既有 DSH Loop，冻结供应商、effort、工具 schema 和有限额度；原 occurrence 启动时间约束绝对期限。取消、卸载、提前返回及迟到创建均撤销能力，回收不明保持 unknown；外层唯一预算结算和真实 Session/使用量保留。接口不挂载 preset、不提供 caller setup，也不证明原用户任务来源或 owner 授权。

Mac 插件全套 359 PASS / 27 skipped，25 文件通过，其中新增 44 项全部通过；完整 noEmit、构建及零警告 lint 均 EXIT 0，独立复核 PASS。已保留并修复真实复现的 Cordis 代理接线、unknown 落库/副作用、同步重入和阻塞后越过期限问题；测试回调断言另有失败 canary，防止产品错误隔离吞掉测试失败。修后双端根检查待完成，不能沿用旧源码根检查作为本接口验收。

用户于 2026-11-02 明确延后飞书机器人实连和后续真实使用验收，当前先完成代码、单测及可离线核实项。依赖实连的临时双服务升级尚未验收；保留连接门，不以模拟连接替代。

临时真实 Host `0.2.1-rc.2` 已在 Mac/Linux 运行正式 pairing、原生 sessions/automations 及五个真实插件；独立 Home、凭据只读、活服务未改。两端使用现有 `super-relay / auto_model/alwaysday1`，Mac 为 completions、Linux 为 responses，不能视为同 API 性能比较或供应商切换验收。

- Mac 两轮 waiting→同 Home 重启→ready 独立 PASS，128.54/100.01 秒；新 occurrence/session、attempt 2、零审批、累计预算 2/2。六项库存结果和独立预期一致；真实 session 证明审计标识不在 resume/partial，首次通过 revision 1 的完整报告召回。
- Linux 两轮同样通过功能验收，126.75/75.11 秒，最终工件、预算 2/2、零审批及 Host 正常退出经独立复核。但等待报告重复了审计标识，512 字节 resume 已包含它，故“必须依赖摘要外召回”的前提 FAIL。已纠正父层初次检查遗漏，保留原始证据。
- 固定通用 prompt 后才生成独立输入；本批生产模型运行总上限 Mac 3 次（含保留的原审批超时失败）、Linux 2 次，已用尽。失败及预算未重置。合成输入不证明 ordinary-use 学习；Outbox pending 不证明外部送达；到期后重启不证明 idle 自动唤醒。

普通失败自动诊断尚未接通。下一交付接入 WorkItems 来源适配、准入时冻结诊断计划及原输入召回，并消费上述接口，打通真实失败信号到诊断报告。原任务 unknown 不得解释为失败重放；缺失或 inconsistent 的模型记录不得回退到默认供应商。独立诊断预算须有明确授权，不冒认原任务剩余额度。

## 原生升级剩余工作

2026-11-01 14:33 UTC 只读快照：live Home `/data00/home/jiataorui/.dsh`；assistant 与 rsi-assistant-a39a7ffad4a3 两个 unit active/running、NRestarts=0；增强包 `0.1.64`、Host `0.2.1-rc.2`。当前 owner active/version 1、唯一 active binding generation 8；历史 revoked binding 不等于 owner 撤销。

2026-11-02 私有副本盘点：实际 creation-review 库 grants/verifications 均为 0；采用库 schema 3，authority 为 1，adoptions/calls/source_archives 均为 0，完整 schema 摘要与当前组件一致。CP 保留 24 条 source maintenance，不能当作工具采用；两个创建 runner 账本路径不存在，revision 未配置。各库源内容/身份均未变；这不是跨库原子快照或签名配置验收，停服后仍须再次核实。

全局 CLI 实际在 `~/.npm-global`，直接 `upgrade-program.mjs` 不做 CLI 自更新。活 Home、两个服务停启与原子切换尚未执行；应先完成以下缺口，再提交具体维护方案和授权范围：

1. 空业务采用 CAS 已接入安装器及签名 overlay。只读副本核对实际配置、完整旧授权与 schema；任何 review grant/verification 或 adoption/call/archive 历史、已配置但缺失的库都拒绝。资源迁移前和 finalizer 重查，实际维护时间不超五分钟及原期限，owner/key/额度/期限/retention 不变；两个启动前点验证同 inode 与空表，正常运行后允许新业务。仍须跑完整临时 Home 升级、就绪和回滚；复制恢复、非空迁移及 native→native 不支持。旧版临时准备在配置组合阶段失败，原始现场保留。修正版未执行：还需官方 fresh Host 绑定、独立完整源码仓库、短 observer socket 路径及真实测试机器人；这些是验收脚本前提，未改变产品准入门。
2. 非空历史路径仍待接线：review v1 CAS 保持 used/maximum/history；v2 冻结三 lane 公开身份、最多 1,000 历史成员与 64 步精确证书封存，依赖外部可信 head。原始 TEXT、旧未知成员重新签名、审计漂移与删除历史负例已独立复核；installer、Host head、运行时消费者及非空 adoption 资格仍缺。同 digest copy-only 未支持；旧 Docker 证书不能冒认 Linux 执行资格。
3. `ac3671fa` pnpm 应用文件 pin 专项及独立复核 PASS（Mac 44、Linux 41）：覆盖实际 native target 或标准 JS package、完整 dist/bin/包内 node_modules、实际 Node 可执行入口与选择；managed launcher 直接运行冻结 target，禁止 packageManager 自动换版本。Node 共享库（包括 libnode）及其他系统依赖仍属 host toolchain 信任边界，不是完整 Node runtime seal。
4. pre-owner 离线预热当前绑定旧 profile metadata/lock；停服前最终候选依赖图、策略结果和真正断网安装证明待补齐，停服后原校验须保留。旧 scoped-token 候选被真实 pnpm 的 `(protected)` 输出证伪，不能恢复旧支持声明。
5. 实验性 `--scenario autonomy` 的新安装、Web setup 和 doctor 入口仍要求 Docker image/probe；现有 supervised native prepare 只配置 CP 构建/验收 runner，没有配置 `assistantIsolation`。原生隔离已有 runtime/cgroup 探测，但纯资源准备目前为 Lark 私有入口；需公开非激活资源接口并接通 native 配置、准备和探测链。仅修 doctor 不能完成去 Docker 安装，也不能借资源准备启动服务或扩展 owner 授权。

远端同级 20 个 worktree 及 8 个嵌套验收 worktree 已清理，独立复核 PASS；完整 tar、patch、index、清单及独有成果保留。513 个改动文件全部在 archive，257 在审计时与 `dev@011595b7` 内容一致、126 已在 dev 历史；其余为合成证据、中间版本和上述待整合候选。“备份完成”不代表所有候选逻辑已合入。

## 最新检查

当前接口专项：`docs/evidence/host-agent-execution-integration/mac-plugin-r3.json` 记录实际全插件命令、源码摘要、EXIT 0 与 17.52 秒耗时，日志 SHA `604d5a7849ce1977531af805046b4db84bd4a45bb439e6441282fd06d93cd339`。`host-agent-execution-tests/` 保留重入创建 2→1、1000ms 合同下真实阻塞 ≥1100ms 后模型请求 2→0，以及断言 canary 的红绿证据；均为真实组件加脚本模型，不是真实供应商调用。以下是最新完整根检查基线。

精确源码提交 `fb36ac666cd1dc1285df50a7efbf07d816bc0598`、tree `241286b62d4026e47a2af7a8d30e6df6e6ea3620`；两端命令均为 `CI=1 VITEST_MAX_WORKERS=2 pnpm check`，pnpm 11.7.0。manifest、零警告 lint、构建、类型检查、测试及 dry-run pack 全部完成；child/runner 均 EXIT 0、源码稳定、无中断。

| 环境 | 测试 passed / skipped | 文件 passed / skipped | 耗时 | 日志 SHA-256 |
| --- | --- | --- | --- | --- |
| Mac / Node 26.11.1 | 9,404 / 1,873 | 659 / 86 | 1085.01 秒 | `ab0ada489d5fe4afa21408fabbcfab8c9d2ae392f0695397a488b4937cfd5f30` |
| Linux / Node 24.7.0 | 10,973 / 301 | 713 / 32 | 1932.18 秒 | `54b0b0765a7b3ad573e9c2e6ec69b8153865a98e4b8a8f2b8a03aa008e459a6a` |

- 每端均有 39 个测试组、38 个包及 38 个类型检查完成记录；两端已按精确 Git manifests 独立逐项核对，结论均为 PASS。原始日志、结果与复核记录位于 `docs/evidence/verification-fb36ac66/`。Linux Delivery 组 1,067 项全部通过；schema 28 临时服务升级生命周期用例实际通过（2563ms），不等于活服务升级验收。
- `2fe7fc92` Mac 根检查因 doctor 漏接 schema 28 而 FAIL（EXIT 1）；Linux 在确认同源兼容问题后主动中止（EXIT 130），不视为 PASS 或测试 FAIL。原始结果与原因保留在 `docs/evidence/verification-2fe7fc92/`。修复的 Web owner 80 项及只读数据库/配置不变检查独立 PASS，见 `docs/evidence/foreground-termination-doctor/`。
- 来源基础专项覆盖 Mac Node 24/26 各 53 项、快照 69 项、Lark 消费者 93 项及原生 Agent 模拟模型回归；复核发现的 Inbox 原始字节校验与同一 deadline 问题已修正，红绿证据位于 `docs/evidence/foreground-termination-{store,producers,compat,integration}/`。
- 非根基线专项另覆盖 Mac Node 24/26 与 Linux Node 22/24：v2 review 各 100 项、空业务采用 CAS 各 53 项、空历史检查各 39 项、安装接线各 104 项通过并独立复核。它们不等于四种环境都完成根检查。
- 未发布、未合入 main、未执行 live 原生升级。平台或外部前提导致的跳过、冷安装/prepare 与合成任务，不替代真实连接、普通使用和成长收益验收。
