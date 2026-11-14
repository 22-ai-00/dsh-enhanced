# RSI 当前状态

更新：2026-11-12。完整成功条件见[验收合同](rsi-acceptance.md)，发行门见[发布协议](releasing.md)。原始日志留 ignored `docs/evidence/` 或 CI artifacts，历史查 Git。

## 目标与当前安排

通过认证任务与反馈、原生 Agent、持久学习、独立验证、有界采用和回退，减少主人的协调与返工；以后续真实任务的质量、成本和人工介入判断收益。

本轮按[接手方案](handover/README.md)交付：A 普通续办、CI 均衡（两阶段）、B1 认证意图冻结、B2 受保护准则封存、B3 自然语言委托与真实 Delivery 端到端、C1a 显式学习决策、D1a 审查供应者冻结、E1 agreement 快照落库均已在 `dev` 且各有 Linux 冷完整门与独立复核。D1b 收益投影、D2 holdout 守卫、E2 inferred 合同准入、E3a read 回执与 Web notice ack、C1b/C1c 安装 readiness 与学习链、D3a 真实 release/activation 链也已交付，做梦机制按当前 Host 执行器合同复活；B3 真实渠道验收、E3b、D3a-1/D5 与 F 仍待推进。

开发基线来自 Linux 进展，Mac 可开发、Linux `/data00` 独立副本验证，同一源码逐项核对。仅 dev/main，能力验证后推 dev，发布时才合 main。当前 npm 已发布版本 0.1.68（39 包含 assistant-dreaming，dev=main=00ddb715），工具链与 Host 范围见[兼容说明](compatibility.md)。

## 已有能力与边界

- Goals、WorkItems、原生执行、恢复、owner 反馈、独立验收与持久记忆已有实现。
- 既有 owner 续办（非 diagnosis active 部署）：认证前台输入冻结原始目标/来源/供应者/有限预算，首个 worker 模型调用前准备验收；Host proof 绑定同一 occurrence/attempt、原生 outcome、不可变 run 与已结算预算（schema 18）。
- B1（默认关）：`goal_create` 经 Delivery 的 agent 作用域只读证明冻结 owner 原文（分页+全文摘要）、identity、binding、调用身份与 supplier；objective 必须逐字出现在原文中；supplier 对该 goal 内所有真实模型请求逐一校验；`.owner-intents` 私库、edit 拒绝、记录失败回滚。
- B2（默认关）：Verifier 接受 Host 准备的准则并封为自描述 `owner-prepared` profile（digest 仅由 criteria+bounds 派生），重启/配置变化后可复用；封存前用共享的 `assertCriteriaDecidable` 拒绝不可判定准则；Goals 的 outcome 每目标封一次、step 每 run 在派发前封存；`.owner-acceptance` 私库；definition 变更即 stale、失败回滚原生目标。
- B3（默认关）：`goal_create` 可带 `acceptance{criteria,bounds,validity_ms}`；prepared 模式下同一 owner turn 内完成证明→创建→封存→返回，失败回滚；只读 `goal_acceptance_catalog`（不含 URL/凭据）让模型构造可判定候选准则；B1+B2 可同时开启。真实 Delivery+Goals+Verifier 端到端证明 achieved/not-achieved、重启复用同合同、重复事件不建第二目标（`f223870d`）。边界：criteria 是模型候选，Verifier 只保证可判定性与不可变性，不保证语义充分；真实模型/渠道与 owner 更正/撤回仍未验收。
- C1a：普通使用学习成为安装期显式 `--learning authorize|skip` 决策，原子持久化到 `install-intent.json`（0700/0600），retry 必须重放同一决策；skip 不产生任何学习授权/配置，既有授权不可被 skip 撤销，坏 marker fail-closed，macOS 必须 authorize（`55f335e5`）。
- D1a：owner-instruction 修订入队时冻结 review supplier+budget（schema 41，自摘要、write-once），旧行 NULL 一律 fail closed，审查只读冻结值、恢复每次重验，改活 owner route 不影响在途审查（`37e3fc95`）。残留：continuation 外层 wall-clock 仍用活窗口（只可能提前截断为 unknown，不扩大内层预算），按次收窄预算需 verifier 协议 v2。
- E1（默认关）：intake would-admit 与 owner 结果的 canonical agreement 以 append-only 快照落库（Evaluation schema 18，immutable trigger、digest 重放幂等、drift fail-closed），owner console 经 TYPERT 只读 counts-only 历史，`causal:false` 不得作为授权依据（`9d18a395`）。
- D1b：修订收益投影改读 revision journal（journal v1→v2 记录 foreground/task 归属，参数摘要与 Delivery 归一化统一）；等长相邻窗口（父 [adoptedAt-W,adoptedAt]、候选 [adoptedAt,adoptedAt+W]）跨创建账本与修订父调用合并，不配对窗口被拒绝；采用默认严格（无同 digest non-inferior 不采用），allowReviewOnlyFirstAdoption 为显式例外，观察到期写 observation-expired-unverified 并精确回退父版本，配置删除 fail closed；修复 adoption runtime 父子证书 source 相等检查（对真实创建父证书恒不成立、此前是休眠代码）。
- E2：inferred 自动准入必须携带真实 objective（2048 字节上限、digest 绑定认证 contentDigest、拒绝不截断）与真实 verifier acceptance handle；服务恒注入 hint provider，缺失即 observe、digest 不符即 refused，新增 acceptance-required 终态拒绝；内存 hint 重启 fail-closed。生产方（Delivery/Proactive）尚未签发 handle，故生产保持 observe。
- C1b/C1c：RSI owner 安装新增只读 readiness preflight（pinned bwrap/tar 字节哈希、delegated cgroup 可访问性、observer 私有路径、纯形状 manifest 校验），在停止 Host/写 grant 之前运行，失败 not-ready 可重试；fresh 与 retry 语义分开。真实 createRsiMemoryLearningSetup 产出的三份 grant 经真实 Delivery/Evaluation/WorkItems/Verifier/Memory 验证学习闭环与撤回（`e495c3f1`）。
- D2：候选生成入口（growth-driver runGrowthAgent 第一行）与 SkillComparator（含 sealed Host-attested plan）都强制 holdout split 证明，evaluation peer 动态导入、缺失/版本偏斜 fail closed；native sealed 用例在 DSH_ISOLATION_TEST_NATIVE_RUNTIME 下真跑通过（`4ace12e7`）。
- E3a：Lark im.message.message_read_v1 回执（best-effort、去重、不伪造 delivered）+ Evaluation classifier v2 的 read/ignored/missed 投影（missed 仅 complete coverage；不改 schema 18、主 7 态不变、v1 record 字节兼容）（`816afebb`）。
- E3a-W：Web native notice 的 delivered/read ack（`acknowledgeNotices` 经绑定 owner session；整批经同一 native notice guard（过期/授权漂移/撤回）校验后才写 receipt；read 后迟到 delivered 不回退不写行；严格 TYPERT `deliveryNotices/ack`；client 渲染 ack delivered、点击 ack read 并明示不代表已读正文）（`06b3d50e`）。
- D3a-0a：真实本地 release 八阶段 opt-in 集成测试——shipped `dsh-local-release-adapter.js`（shebang 固定 canonical interpreter）+ 真实 pinned bwrap/pnpm toolchain + file: registry，逐阶段真实 Ed25519 回执验签、tarball/catalog 校验，两条篡改 fail-closed；opt-in 缺省时 skip（`e9d94eb6`）。
- D3a-0b：真实 activation 链 opt-in 集成测试（真实 `dsh plugin add` staging + 原子 profile swap + 真实 `dsh --profile` 进程 + shipped observer 采样真实 Loader Fiber + 测试 schema-2 host attestor 签 reload/readiness），断言停在 `awaiting-effect-blocked-replay` 且不进 `awaiting-live-tasks`（无独立效果证据不放行），含篡改样本被 readiness 拒绝的负例（`5058218d`）。同时修复一个真实生产缺陷：本地构建产物激活曾把无后缀 `/proc/<pid>/fd/N` 作为安装 spec 传给 pnpm 导致必然失败，改为稳定 `.tgz` cache 路径，pinned fd 封存校验与安装后 lockfile integrity fail-closed 保留（`a2ec42a1`）。
- 做梦机制（`assistant-dreaming`，默认关闭）：按当前 Automations Host-executor 合同复活——终态改为合同化结果（原先每个 wake 都在 registry 边界被拒）、删除重复预算扣减、misfire 跳过而非补跑、preview 零模型零账本、成功路径与加载时执行保留期清理（同事务删事件行避免外键静默失效）、dream Agent 绑定 background initiator、owner 读取面改绑定箭头属性以穿过 Cordis service proxy、reconcile key 每次加载唯一使暂停/恢复收敛、`retired` 与 `disabled` 组合 fail-closed；README 补真实启用步骤（Policy reconcile/execute/tool/send、budgets、scheduler、Delivery route）与 retired-first 关闭顺序（`0e15295a`）。- 发布账本：pending 集合补入 `assistant-dreaming`（38→39 与 workspace 对齐），否则 `release:prepare/record` 会拒绝；`install-npm.sh` 的既有 installer pin 漂移仍需在发布流程中重签（`4c454b0c`）。- 部署现状：Mac 桌面 profile 已装本仓库 dev 构建（37 包重打包、27 个内容更新，标记已验证，需重启 App 生效）；Linux 线上 `assistant` profile 仍为已发布 0.1.67——该 Home 是冻结本地 cohort owner 安装，receipt 0.1.64 与已装 0.1.67 不一致，普通/受管 upgrade 在 mutation 前被结构性拒绝，未绕过安装器手工改线上（详见交接证据）。
- 发布 0.1.68（tag v0.1.68，Release workflow success）：重签漂移的 installer pin，supersede 过期 pending 0.1.67 到 0.1.68 并把 39 包（含 dreaming）统一 bump；npm 全 39 包 latest=0.1.68（654ac496/64e9215e，CI 全绿）。
- CI 第二阶段提速（00ddb715，CI 8 job 全绿）：测量显示 linux-packages 的包测试占 job 81-83%，其中 plugin-control-plane（约 1254s）与 lark-channel（约 1082s）两个包占 62-64%；新增 linux-slow-package-tests matrix 把这两个包各放一台独占 runner（3 worker），共享 lane 只跑其余 37 包与全部仓库级门；同一套 pnpm 测试脚本、无 shard/exclude，39 包覆盖不变，release-version 契约测试同步改写，无断言弱化。
- 桌面 App 两处异常定性（非 dsh-enhanced 缺陷）：assistant-isolation 报 only the linux-native backend is supported 是平台门（bwrap/cgroup 仅 Linux，Mac 预期拒绝）；agentPresets 重复注册来自 0.2.2-rc.1 Host 内部组件，重装前后 acp 包字节一致、全仓库无任何插件注册该服务，Linux 0.2.1-rc.2 无此错。
- 柳七月 Home 升级 0.1.68 阻塞决策（见 evidence/liuyue-upgrade-decision.md）：根因修复已在 dev 落地（d0ef04f9，CI 八 job 全绿）——新增 stableInstalledFile 仅用于 profile node_modules 读取，pnpm store 硬链接（nlink=2）在保留 realpath  containment+sha256 收据校验+owner/模式+读时稳定性的前提下通过；rsi-local-cohorts 私有制品仍强制 nlink===1；新增硬链接通过/篡改 fail/symlink 拒绝/cohort 硬链接仍拒 4 个用例（rsi-local-cohort 9/9）。待 0.1.69 发布后该 Home 可走标准 update --all。：该 Home 是 registry 硬链接布局（8590 文件中 5383 个 nlink>=2）却注册为冻结本地 cohort（receipt 0.1.64），冻结升级器要求 nlink===1 而 fail-closed；去硬链接/手工 plugin add/purge 均否决，结论是先在 0.1.69 修安装器（store 后端硬链接改用内容哈希+权限校验，cohort 制品保留 nlink===1），发布后再标准 update，线上 0.1.67 保持不动、服务健康。
- Linux namespace/cgroup v1 是当前原生执行方向；cgroup v2、arm64、活 Home 迁移与旧 opt-in E2E 尚待验收。Docker 执行后端已移除。
- Dream 默认关闭，长期收益未证明；provider 接受不等于用户已读。

## 下一交付

1. B3 真实模型/渠道验收（含 owner 更正/撤回、跨会话与重复消息的投递事实）。
2. D1b：修订收益投影改读 revision journal、给 revision 调用证据补 foreground/task 归属、补采用前 parent/candidate 配对样本；D2 holdout 守卫接入生产候选入口。
3. E2：inferred 准入携带真实 objective 与 acceptance handle；E3/E4：真实通道回执与 read/adopted/ignored/missed 状态。
4. C1b/C1c：owner setup 先 readiness 再授权；安装器 grants → 真实学习运行时（反馈→采用→撤回）集成。
5. F：用 C/D/E 的真实后续任务做 parent/candidate 长期收益对比。

## 最近验证

- 提交 `f223870d`（B3 端到端）、`37e3fc95`（D1a）、`55f335e5`（C1a）、`9d18a395`（E1）、`68b91301`（E2）、`0eab022b`（D1b）均为 Linux 冷 `pnpm check` EXIT 0、39 dry-run packs、lint 干净、manifest 稳定（2110–2112 文件）；每个都有独立只读复核 PASS，复核发现的缺陷（C1a marker/flag 死锁与 0755、D1a 文档/漂移测试、E1 dead-code/毒行/跨包 worker 清单）均在提交前修复。
- CI：`05957ae2`、`55f335e5` 六 job 全绿；`f223870d`、`37e3fc95` 的失败已确认为 GitHub runner DNS 故障（apt 解析 azure.archive.ubuntu.com 失败），非代码问题。
- CI 均衡实测：根慢片 979s→674s、两片比 1.03；包测试 step 1349s→1113s；1046s 单文件已拆 74+35（2 worker，用例数不变）。
- 做梦机制、D3a-0b 与发布账本修复均通过 Linux 冷 `pnpm check` EXIT 0 / 2161s（39 packs、manifest 稳定）；`assistant-dreaming` 包 54 用例、独立复核两轮（拦截泄漏的 executor 注册、reconcile key 回放、缺 reconcile 规则、prune 外键）。CI 在 `0e15295a` 暴露一处 delivery 既有测试时序 flake（慢机上 `whenIdle()` 先于子 Agent 的 adapter 请求落账），已改为有界等待精确计数（不放宽断言）。
- 完整门在本机需要三条前提：`DSH_TEST_PNPM_ROOT`、`pnpm_config_store_dir`、**短** `TMPDIR`；解析方法见[交接入口](handover/README.md)。
- 未验收：B3 真实模型/渠道、E3b 真实飞书联调（受 Linux 线上 Home 冻结 cohort 登记不一致阻塞，需先按发布流程发新版后 `dsh-rsi update --all`）、D3a-1/D5 真实外部执行链与第二事件源、F；没有发布 npm、升级生产 Home 或发送用户渠道消息。
