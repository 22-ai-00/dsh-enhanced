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

`a587b19d` 已提交空业务 owner Docker→Linux 安装器接线：已认证配置的只读历史检查、资源迁移前二查、签名迁移证明及启动前验收。Mac 根检查完整通过；Linux 根目录 1,395 项通过，但插件组的原生 Goal 持久化检查点测试失败；当前测试修复恢复生产默认租约，专项通过后仍须重跑根检查。能力专项不能代替根检查。

用户于 2026-11-02 明确延后飞书机器人实连和后续真实使用验收，当前先完成代码、单测及可离线核实项。依赖实连的临时双服务升级尚未验收；保留连接门，不以模拟连接替代。

临时真实 Host `0.2.1-rc.2` 已在 Mac/Linux 运行正式 pairing、原生 sessions/automations 及五个真实插件；独立 Home、凭据只读、活服务未改。两端使用现有 `super-relay / auto_model/alwaysday1`，Mac 为 completions、Linux 为 responses，不能视为同 API 性能比较或供应商切换验收。

- Mac 两轮 waiting→同 Home 重启→ready 独立 PASS，128.54/100.01 秒；新 occurrence/session、attempt 2、零审批、累计预算 2/2。六项库存结果和独立预期一致；真实 session 证明审计标识不在 resume/partial，首次通过 revision 1 的完整报告召回。
- Linux 两轮同样通过功能验收，126.75/75.11 秒，最终工件、预算 2/2、零审批及 Host 正常退出经独立复核。但等待报告重复了审计标识，512 字节 resume 已包含它，故“必须依赖摘要外召回”的前提 FAIL。已纠正父层初次检查遗漏，保留原始证据。
- 固定通用 prompt 后才生成独立输入；本批生产模型运行总上限 Mac 3 次（含保留的原审批超时失败）、Linux 2 次，已用尽。失败及预算未重置。合成输入不证明 ordinary-use 学习；Outbox pending 不证明外部送达；到期后重启不证明 idle 自动唤醒。

内置前台失败适配器要求 failed/timed-out，而真实 Delivery 将非成功归为 unknown；普通失败尚不能自动成为可执行工作项，原任务输入的受控召回也待补齐。

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

- 两端根命令均为 `CI=1 VITEST_MAX_WORKERS=2 pnpm check`。Mac `a587b19d` 完整 PASS，独立逐项核对 39 个测试组、38 个包及全部类型检查；9,354 passed / 1,872 skipped，658 文件通过 / 86 跳过，1277.47 秒，child/runner EXIT 0、源码稳定，日志 SHA-256 `25979a3ec441314e991ef32e9cbbc8536274f46b720b01725688e04021f79889`。
- Linux `a587b19d` 根检查 EXIT 1、源码稳定，1429.75 秒；Delivery `agent-runtime.spec.ts` 的原生 Goal 检查点用例在 5 秒内未进入 flush，1 failed。原始日志 SHA-256 `860ed04327bb7f86735fa25955356d8a888a2e8f0ce739f8c5806704471c010a`。同原用例 Linux 定向运行 EXIT 0（1 passed / 277 skipped、578ms），仅证明单独执行通过，未消除并发根失败。最新完整 Linux PASS 仍为 `40a405c6`，不能认证其后新增组件。
- Delivery 检查点测试移除人为 1 秒租约，使用生产默认 30 秒；5 秒等待、250ms 检查点阻塞和全部原生 Goal/数据库断言不变。确定性 1.1 秒事件循环停顿使原 fixture 合法丢失租约并重现 flush=0；默认租约下完成原断言，无 Goal 的对照仍在 144ms 主动释放。该对照解释可复现机制，不证明原全检的具体负载来源。实际 Linux 目标及相邻释放/撤销/到期四项通过，根检查待补。
- 此前回滚测试 15 秒预算失败已保留，`0f170381` 只将其预算与相邻事务统一为 20 秒、断言不变；本轮 Linux 根目录 1,395 passed / 5 skipped，包含修正后的该用例。
- v2 review 在 Mac Node 24.7/26.11、实际 Linux Node 22.23/24.7 各 100 项通过并独立复核；Mac verifier 整组 390 passed / 37 skipped。既往 WorkItems NUL 重放和 Delivery 跨预算窗口修复已被上述根检查覆盖，失败原始证据保留。
- 空业务采用 CAS 专项在 Mac Node 24.7/26.11、实际 Linux Node 22.23/24.7 各 53 项通过；覆盖原始 TEXT、隐藏 schema 对象、完整身份/额度、同事务审计、更新后失败回滚和不同事务重试。Mac 集成相关组 110 passed / 61 skipped，类型、零警告 lint、构建及独立复核 PASS；日志 SHA-256 `9e20985ed5d31d3805bd2b71e55f0c82ab7e376915e7c0f4b9265423353d362c`；已被 Mac 根检查覆盖，Linux 根验收尚待完成。
- 空历史检查在 Mac Node 24/26、实际 Linux Node 22/24 各 39 项通过，含独立发现并修复的异常 FD 清理；接线候选四端各 104 项通过。Mac 集成的准备/CAS/签名及恢复相关组 155 passed / 13 skipped，实际两个插件类型检查、零警告 lint、构建通过；Mac 完整根检查已通过，Linux 根检查及真实升级尚未通过。Linux 初次专项缺少已提交组件的编译产物而失败，补构建后的日志分别为 `78fcabe4a7a0ea95ed7440719c8eba5a8a6f9f9504881623dfd56be069a4f47c`、`fee7e883ad9a39bf6aaa3f6941d5d9afcbed90e9c3aca9c93f3c6176b62f394d`，原失败保留。
- 未发布、未合入 main、未执行 live 原生升级。冷安装/prepare、合成任务及条件跳过不替代普通使用与成长收益验收。
