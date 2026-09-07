# 自治智能体落地与验收账本

本账本落实 [2026-09-06 路线图](agent-intelligence-autonomy-roadmap-2026-09-06.md) 和 [成长专项审计](agent-growth-gap-evidence-2026-09-06.md)。目标是完整实现可验证的目标经营、任务上下文、独立验收、主动行动、高权限隔离和自主技能进化，并提供容易安装、诊断和升级的产品入口。实现起点为 `1b65852`。历史分析保留原始结论；当前进度与新证据记录在这里。

## 全局约束

- 复用 DSH 原生 Agent loop、goal、plan、subagent、workflow、skills 和持久 Session，不复制运行时。
- 每项能力必须接到真实执行入口；纯类型、内存模拟器、配置存在或测试替身不能单独证明产品能力完成。
- 执行成功、目标达成、送达和相对基线增益分别验收；无法验证的结果保持 unknown。
- 不缩小或重写用户目标来制造成功，不通过降低验收标准、改变留出答案或自动扩大权限来“进化”。
- 高自由执行发生在授权资源、成本、期限和可撤销 lease 内；信任根、通用凭据、隐藏评测与发布裁决在执行体无法写入的边界外。
- 用户安装 bundle 仍放在 `plugins/*`，纯共享契约放在 `packages/*`；新增插件使用生成器。部署值进入 Config，资源有 disposer，README 说明权限。
- 安装交互围绕用户目标和能力选择；复用现有安装器、profile 激活和 doctor，避免要求用户手拼插件依赖。有效配置、模型可用性和隔离就绪程度分别报告。
- 每个实现批次运行有意义的行为回归；最终必须通过根 `pnpm check`，并完成真实 profile、真实模型和实际隔离环境验证。长期收益仍需实际观察窗口，不能用压缩时间或模拟回执替代。

## 工作包与证据

状态说明：待做、实现中、待验证、已验证。每行覆盖独立交付要求，不因相邻模块已存在而自动完成。

| ID | 对应路线 | 工作包与落点 | 必须取得的验收证据 | 状态 |
| --- | --- | --- | --- | --- |
| 01 | P0 | Automations Canary 使用 Evaluation canonical projection，在激活提交时取得 writer fence；绑定任务版本、digest 和 scope watermark | 冲突前置、inspection 后纠正、并发纠正、重启重放均不能用旧成功升级；合法晋升与重试通过 | 已验证 |
| 02 | P0 | Delivery 提供 owner 任务评价修订与撤回；Evaluation 保留历史且每任务只一票 | 同值重试幂等、旧消息重放不覆盖新修订、冲突/撤回传到所有成长消费者和已推广版本 | 已验证 |
| 03 | P0/C | 不可变 TaskAcceptanceContract，独立代码、文档引用和目标系统回读 verifier；接入前台与 Automation AgentLoop 结果生产者 | 真实失败不能因为退出码或模型自评判成功；契约篡改、错 run、过期回执拒绝；unknown 触发验证下一步 | 已验证 |
| 04 | P0/F | 固定任务集、留出集、基线 runner 和版本化结果记录；包含代码、研究、跨日、主动性、注入和撤销 | 同输入同模型同预算可重跑；记录成功率、成本、延迟、返工、多次分布和消融；留出不参与候选生成 | 实现中 |
| 05 | P1/A | 业务目标编排 bundle：成功条件、期限、依赖、预算、授权、假设、阻塞、唤醒和证据；关联原生 goal/session/run | 跨会话与重启恢复，多步骤任务真实完成；过时假设重查，用户目标变化传播，无重复外部提交 | 实现中 |
| 06 | P1/A | 任务策略选择：直接执行、调查、实验、独立复核、候选比较和原生 subagent；route 结果归因 | 困难任务改变方法，工具故障与推理失败可区分；协调成本有记录；固定预算比较策略收益 | 待做 |
| 07 | P1/B | Memory 根据当前 goal/step/query 召回；来源、适用条件、反例、失效和冲突；有预算的工具证据压缩 | 对照任务发现相关记忆并改善决策；当前任务变化重查；恢复保留原始引用，owner/scope 边界不泄漏 | 实现中 |
| 08 | P2 | Policy 长期能力包与短期 lease：资源、动作、目的地、敏感度、期限、次数、费用、撤销；提交绑定 digest/前置版本/幂等键 | 正常预授权动作不用逐条审批；超范围、授权过期、撤销竞态、重放、重定向与数据外发被实际阻止 | 待做 |
| 09 | P2 | 独立动作/凭据 broker 与隔离 worker，先交付一个受支持生产平台 | worker 任意代码和子进程不能读取 token/信任根，不能绕过出网与动作代理；崩溃恢复不重复提交 | 待做 |
| 10 | P2 | 外部停止、不可由 worker 覆写的审计、版本回滚和不可逆动作补偿 | 实际终止 worker、撤 lease/凭据/出口；审计保留；部分失败有明确补偿结果 | 待做 |
| 11 | P3/D | 统一事件 envelope 与目标关联，代码库及任务/日历至少两个真实来源，复用已有连接器 | 来源/版本/时间/可信度/去重/授权可追溯；重复和乱序事件不会重复动作；目标完成后退订 | 待做 |
| 12 | P3/D | 机会排序、静默准备/提醒/预授权执行、静默时段、合并、冷却与每目标预算 | 收益/成功率/成本/打扰/损失可解释；拒绝后冷却；两个完整工作周衡量采纳、漏报、打扰和主动收益 | 待做 |
| 13 | P4/E | typed workflow/skill：输入、前置条件、依赖步骤、参数、工具、验收和失败补偿；从失败及重复轨迹生成候选 | 至少 3–5 类实际高频流程；提取与授权分离；候选绑定父版本、触发条件、失败原因、指标、权限差异及回滚目标 | 待做 |
| 14 | P4/F | 真正执行历史输入的 baseline/candidate replay 与有质量验收的 shadow，受限 canary 和自动晋升 | 独立验证通过、同预算留出增益、关键回归通过三个 gate；无副作用单独证明；失败候选不晋升 | 待做 |
| 15 | P4 | 推广后 deployment cohort 质量监控，涵盖 guidance/workflow/skill/plugin | 退化自动关闭 exact 版本；撤票回滚；新增正向证据不会误撤有效部署；重启仍能继续观察 | 待做 |
| 16 | P4 | 沿 Control Plane 接真实发布/启用 adapter，签名、不可变版本、有限实验生命周期与存储 | 真实受授权环境完成构建、发布、验签、启用、监测和回滚；完整证据可重放；隐藏评测不可读取或修改 | 待做 |
| 17 | 安装 | 安装场景/目录一致；提供自治能力入口、预检、预算与模型引导、隔离环境 bootstrap、诊断/升级/卸载 | 全新临时 profile 从安装到完成示例目标；缺依赖给出可操作修复；重复安装幂等，保留自定义配置和既有任务 | 实现中 |
| 18 | 综合 | 仓库维护纵向切片：一次授权→CI/issue→目标→隔离修复→独立验证→允许分支 PR→CI/评审跟进→复用策略 | 真实模型、目标仓库和授权系统的端到端证据；同类后续任务在同预算下有可测改进；停止和回滚有效 | 待做 |

## 实施顺序

先完成 01–04 的可信结果与比较基线，再以 05–07 接起自主任务闭环。08–10 建立实际高权限边界后，才把 11–12 的主动执行接到真实系统。13–16 扩大可执行技能与工具进化。17 贯穿每一批能力交付，18 用完整产品路径验收所有接线。

存在实现依赖时按工作包继续推进，不能把等待外部部署或长期观察当成整个开发停摆的理由。真实运行依赖的具体账号、目标资源或授权只在必要时询问；仓库实现与可复现的本地验证先完成。

外部审查的逐项处理见 [外部审查吸纳与验证](external-audit-triage-2026-09-06.md)。在 03 开始前先修复已复现的凭据交付竞态、attestor 路径替换、安装版本混用、调度重叠语义、ACP 协议、Health 指标与 Lark 请求期限问题；这批基础修复不替代任何完整工作包。core 本地身份/审批、Memory retention 生产入口、Wiki 分区和 unknown-send 恢复仍须按真实产品路径验收。

## 当前证据与后续动作

- 起点：`dev`，工作区干净，基线 `1b65852`。已有 22 个插件和 2 个共享库（本轮以实际 package 清单复核，修正此前的 23 个误计）；安装器已有场景组合、真实 Host 激活检查和服务诊断，应该继续扩展这些入口。
- 01 已验证，提交 `6b82214`、`0c6e850`：exact-run canonical 查询，schema v11 保存任务版本/digest/inspection watermark，晋升在 Evaluation 写锁内复核并激活。保持任务身份不变时使用当前 scope watermark，避免其他任务的新证据卡住候选；与 Evolution 共用同一证据校验和锁，只由依赖 Evolution 投递的消费者等待其 outbox。历史 v10 proof 不授予晋升权限。
- 01 行为覆盖：owner 冲突、inspection 后纠正、取锁前纠正、持锁期间竞争写、旧成功冷恢复、合法回执重放、真实 promotion 版本迁移、旧 schema 升级、错误 scope/run、独立组合没有 Evolution、同 scope 的无关任务进展。Automations 209、Evaluation 36、Growth 14 项包测试通过；两轮独立审查修复了 promotion 后 replay 失效问题，最终规格与质量均通过。
- 安装诊断修复 `b6cb037`：区分端口冲突、权限拒绝和其他网络错误，避免把沙箱 `EPERM` 错报为端口占用；64 项安装器回归通过，新 profile 测试在允许本机监听后通过，独立复核通过。Growth Experiments 目录已与 supervised 安装场景对齐；完整安装工作包仍未完成。
- 初次根 `pnpm check`：manifest/lint/typecheck 通过，测试阶段 2,893 通过、81 跳过、1 失败（沙箱禁止本机端口监听）。没有把这次运行记为全套通过；代码定稿后需在允许本机监听的环境重新运行。
- 后续全仓检查发现独立组合缺少 Evolution 时的投递等待问题，已在 `0c6e850` 修复；另发现既有 Evolution 测试同毫秒记录依赖随机 ID 排序，`a670538` 使用注入时钟明确先后版本，保留业务断言，Evolution 157 项测试与类型检查通过并独立复核。
- 最终在 `a670538` 代码上执行根 `pnpm check`，退出码 0：manifest、零 lint 警告、所有包类型检查、主测试运行 200 文件/2,909 测试通过（4 文件/81 测试跳过）、递归包测试、完整构建、所有插件与共享库 dry-run pack 全部通过。跳过项和模拟模型不算真实外部部署或智能收益证据。之后仅更新此账本并取消跟踪本地代理临时报告。
- 纯 core/Web 的 Memory 身份接线待补：meta patch 默认 `approvalMode: delivery-required`，`PersonalMemoryService.agentContext()` 要求 Delivery owner；显式 headless principal 仅为程序化集成入口。当前 core 组合测试用 Host 测试 seam 提供 Delivery 身份，安装测试用替身 DSH，均不能证明纯 Web 用户可开箱完成记忆任务。工作包 17 要补实际本机 owner 身份与审批路径，不能以匿名 namespace 或模型自报 principal 绕过现有边界。
- 本机全局 `dsh --version` 为 `0.1.0-rc.8`，低于当前 `0.1.2-rc.1` 测试基线；真实 profile 验证须使用隔离安装的目标 Host，不能直接用全局旧 CLI 的结果作兼容性结论。
- 计划由 ChatGPT 参与方案与关键取舍评审；首次连接选择待用户确认。本批实际调用 Codex with ChatGPT 的 workspace-info 返回内部错误，尚未获得 ChatGPT 评审；未启用外部隧道。
- 07 第一切片 `37d1e06`：Personal Memory 用原生 SystemPrompt 动态 context，从当前 Session 有效输入提取有界 query，每模型步骤重新检查 owner、Policy 与记录状态；相关记忆优先，再补用户确认的偏好和约定，附来源、原始引用、版本与失效信息。敏感记录在 top-K 前排除，转义覆盖模板花括号。95 项 Memory 测试、类型检查和真实 AgentLoop 两步骤之间撤回的集成测试通过，独立审查通过；无 SystemPrompt 时保留旧启动快照兼容路径。
- 07 限制：目标 Host 追加新的 superseding runtime snapshot，保留已提供过的历史快照、工具结果和模型输出；当前切片只更新有效快照，不能证明历史擦除或跨 owner 会话迁移隔离。结构化 goal/step 检索、适用条件与反例、冲突决策、工具证据压缩和实测决策收益仍待实现与验证，完整工作包未完成。
- 02 已验证，提交 `2780fdf`：普通任务与 Automation 的 `/feedback status`、`correct`、`withdraw` 接入真实 Host 入口；Evaluation schema 8 和 Delivery schema 17 保存版本化 owner 判断及成功/失败命令回执。只有明确链接的旧判断被替代；独立矛盾继续隔离，撤回不复活旧成功。owner record+version、精确回复目标与 CAS 一起校验；旧 Evaluation 缺少修订协议时拒绝，旧 foreground 数据无法证明原 principal version 时拒绝跨版本继承。
- 02 推广后验证：实际 Coordinator 调度、Evaluation 变更/卸载、重启均重查 canonical canary；负向/未知/冲突证据暂停 exact 部署版本，新增正向证据保持有效部署。晋升、回滚及激活回执丢失恢复都原子保存 artifact 与 receipt。7 条真实服务栈回归覆盖撤回、纠正、失 ACK、服务缺失和提交后崩溃恢复；两轮独立审查发现并修复了 lineage、失败重放、升级与原子提交窗口问题，最终全部通过。
- 本批最终工程验证：在 `2780fdf` 代码上执行根 `pnpm check`，持久退出码为 0（本机日志 `/tmp/dsh-autonomy-check-v6.log`，退出码 `/tmp/dsh-autonomy-check-v6.exit`）。manifest、零 lint 警告、所有包类型检查、主测试 200 文件/2,928 测试通过（4 文件/81 测试跳过）、递归包测试、完整构建与全部 dry-run pack 通过。之后仅更新账本。此前 v5 已输出全部打包结果，但跨轮后句柄丢失，故未将它当作有明确退出码的最终证据。
- 下一项：03 的独立结果验证与 04 的比较基线。03 须覆盖执行前不可变契约、独立代码行为/文档引用/目标回读、前台及 Automation 生产入口和 unknown 后续验证；私有 Host capability 不能冒充 08–10 的操作系统隔离。其余工作包完整保留。
- 外部审查修复批次：凭据交付前重新检查 lease；Host attestor 绑定已验证文件描述符；调度取消及 queue-one 按 occurrence 时间与 preview/production 域处理；ACP code/ptc 与 stop reason 映射；Lark 操作级 deadline 贯穿 token 后资源请求；Evolution 完整性指标进入 Health；安装选定同一精确 npm cohort 并在修改 profile 前预检，远程 bootstrap 保持发布标签对应哈希。全仓检查另暴露并修复 Delivery 并发开库的 WAL 转换锁竞态。各项经独立复核，细节与限制见外部审查记录。
- 本批最终本机工程验证：冻结实现后执行根 `pnpm check`，退出码 0（`/tmp/dsh-autonomy-audit-check-v2.log` 与 `.exit`）。manifest 确认 22 个插件、2 个共享库；零 lint 警告、所有类型检查、主测试 201 文件/2,966 测试通过（4 文件/82 测试跳过）、递归包测试、完整构建与全部 dry-run pack 通过。首次检查的真实 WAL 锁失败已修复，未将失败运行当作最终证据。随后因 GitHub OAuth 缺少 `workflow` scope，移除本轮 CI 配置改动并保留既有 workflow，只更新文档说明；产品代码不变。本机 macOS 跳过的 Linux 实际进程验证、真实飞书/远端发布及长期收益仍未完成。

## 完成审计

结束前逐行填写实现提交、测试命令及结果、真实运行证据和限制。只有以上工作包全部有充分证据时才宣称整体目标完成。`pnpm check` 的成功证明仓库工程检查通过；它不能单独证明智能增益、高权限隔离、外部系统发布或两周主动收益。

- 03 已完成本机工程验收：新增 inert `task-acceptance-contract` 与 `assistant-verifier` bundle。真实 owner 的 scope、版本、原始目标、预期结果和资源摘要在模型提交前冻结；前台与 production Automation AgentLoop 的实际终态进入独立验证，再写入 Evaluation canonical。普通退出成功不会替代指定行为、文档引用或目标系统字段的实际观测。控制命令、preview 与独立 Host runbook 继续使用原协议；没有原始用户 prompt 的 Host runbook 不冒充 AgentLoop 目标，也不得作为行为学习样本。
- 03 生产入口证据：真实 Cordis/AgentLoop/SQLite，经 owner 配对、公开 Automation 提案审批及实际调度，验证模型调用前契约已经存在；相同正常模型回复分别得到 achieved/not-achieved。前台自动续写只使用同一契约；`/stop` 保留 unknown。真实 `/feedback` 经过精确 reply、owner lineage 和 CAS，支持纠正、撤回与旧消息重放；Evaluation 卸载时不报已记录，重新挂载后可以重试。模型和外部 transport 为确定性替身，不计作真实云模型或外部账号证据。
- 03 恢复与边界：已提交的任务重启后不重复原执行；验证最多三次，未知/过期保持待处理状态并进入 Health。等待执行及回执 outbox 分页轮转，100 条未完成或过期记录不会饿死后页。必需验收在 Host 服务生命周期内保持单调，卸载或可选配置替换不能绕过。异步 Host 回读、Evaluation 投递及卸载有界，卸载后迟到的验证不落库；旧库迁移保留历史水位 0，不伪造可信水位。
- 03 独立复核通过：共享契约、验证驱动、服务/持久化、两个生产入口、Evaluation owner 修订、Evolution 迁移及 Health 均经独立只读复核与实际测试日志核验。驱动执行捕获的单文件快照，超时关闭本方管道后返回 unknown；同 UID 对手、逃逸后代终止、可执行路径原子绑定及父目录恶意替换仍不属于其安全保证，详见插件 README。高权限隔离完整保留在 08–10。
- 03 最终根 `CI=true pnpm check` 退出码 **0**：`/tmp/dsh-task3-check-v4.log`、`.exit`。manifest 为 23 个插件、3 个共享库；零 lint 警告、全包类型检查、主测试 208 文件/3,038 测试通过（4 文件/82 测试跳过）、递归包测试、完整构建和全部 dry-run pack 通过。检查过两个新增包的实际打包清单，未包含测试或数据库。此前三次失败均为测试夹具的 lint/类型错误，已修复，未计为通过证据。随后仅更新文档进度。
- 下一项为 04 的固定任务集、真实可复跑基线与留出集。03 的结果是任务时刻的历史验收，不能作为无限期新鲜的外部状态证明；持续目标、能力提升和生产部署仍需后续新鲜度、比较基线及真实环境验证。整体自治目标尚未完成。
- 04 第一切片：Evaluation 新增 Host-only `./benchmark` 子入口，冻结数据集/题目/版本摘要、同模型与同预算配对计划，分离模型替换比较，并强制消融只关闭唯一候选的一项能力。相同输入不能换题号增加样本数；同题同次 seed 一致、顺序轮换。独立 SQLite 在调度前保存 intent，跨连接竞争与重启不重复原执行，unknown 生命周期状态停止后续 cell；显式 interrupt 只记账，不宣称停止 OS 进程。
- 04 统计口径：缺测不补零，已验证成功率保留完整计划分母；成功率和配对区间按任务聚类 bootstrap。任一比较臂 unknown/缺测时不报告收益差值或区间，避免把基线未知当失败制造增益。汇总费用、token、延迟、返工和人工介入分布；报告不授予晋升权限。SDK 只接受可信 Host adapter 的观察，没有模型写入工具，也没有把 `split: holdout` 标签当作独立隔离。
- 04 切片验证：30 项专项测试、Evaluation 全包 73 项测试及两项独立只读复核通过。最终冻结代码后 `CI=true pnpm check` 退出码 **0**（`/tmp/dsh-benchmark-check-v2.log`、`.exit`）：23 插件/3 共享库，零 lint 警告、类型检查、主测试 212 文件/3,068 通过（4 文件/82 跳过）、递归测试、完整构建和 dry-run pack 通过；确认 `lib/benchmark` 子入口已打包，未打包测试或数据库。v1 全仓检查碰到正在补充的 v0-only-view 红测而失败，修复后才冻结并执行 v2，不计失败运行作验收。
- 04 第二切片已实现公开合成开发集、独立判断器、原生 AgentLoop adapter 和命令入口。经代码复核，基线环境改用独立 Context 下的 `agents.create()`：Automations `reconcileSystem` 会修改持久定义并注入 Growth，不能保证本阶段的空能力对照环境。首批只覆盖研究与注入，persona 比较不冒充记忆/规划/复核/成长消融；其他任务域、真实模型、独立隐藏留出和生产 profile 安装仍分别验收。旧 Growth replay 只检查摘要，仍不能作为真实执行证据，完整 04 保持实现中。

- 04 第二切片工程验证：修复独立复核发现的浅冻结、未核对 totalTokens、清理中途失败与 SQLite 错误脱敏问题。54 项 benchmark 测试、Evaluation 全包 97 项测试通过。最终 `CI=true pnpm check` 退出码 **0**（`/tmp/dsh-native-benchmark-check-v3.log`、`.exit`）：23 插件/3 共享库，零 lint 警告、类型检查、主测试 215 文件/3,092 通过（4 文件/82 跳过）、递归测试、构建及 dry-run pack 通过；检查确认命令 bin、corpus/native 子入口已打包，没有数据库、测试或本机适配器。v2 的 no-unsafe-finally lint 失败已修复，不算通过证据。清理与执行同时失败时优先报告资源清理失败并记为 unknown，不报告成功；该组合下不额外保留原始执行错误。
- 04 真实模型首轮：复用用户现有 web 模型线路，通过本机可信桥接进入 `0.1.2-rc.1` 原生 AgentLoop。初次桥接方法名及新旧 LLM adapter API 不兼容导致 v1/v2 在网络 dispatch 前停止 unknown；保留原账本，修复后另建完整 v3 计划。v3 命令退出码 **0**，2 道公开开发题 × 2 persona × 2 重复，共 8 cell 全部取得完整观测，输入 2,084 / 输出 164 tokens，金额未知。两个方案各 achieved 2/4，配对增益为 0；研究计算题未满足完整验收，注入题通过。此结果只证明真实链路与首组小样本基线，不证明候选更聪明、完整任务集或生产 web 安装完成。脱敏计划/结果见 [首轮证据](evidence/benchmark-web-smoke-2026-09-06.json)。
- 04 下一步：增加可诊断的独立验收证据、其余任务域、真实能力组合和消融，再做独立留出与真实场景验证；05–18 的完整要求保持不变。web 提供商使用其匹配的旧版运行时桥接，新版 Host 安装/交互集成仍在 17 验收，不能将复用模型线路表述成已完成 profile 升级。

- 05 第一切片：新增独立 `assistant-goals` bundle，绑定当前真实 Delivery owner turn 新建的原生 goal，保存不可变原始目标、native revision/phase、下一步、阻塞、到期假设、证据引用和同 scope 无环依赖；SQLite CAS 和追加历史防止并发覆盖。focus 可以跨会话读取上下文，但不迁移、创建或重启原生 goal。SystemPrompt 每模型步骤重新核对 live Agent、owner lineage 与 Policy，过期假设标记 stale；原生 complete 仅记 awaiting-verification。
- 05 范围：本切片不是完整业务目标编排。成功条件绑定独立验收、期限/预算/授权 lease、自动唤醒、原生 Session 执行恢复、多步骤推进、假设主动重查、目标修改对依赖传播和外部提交幂等仍待完成。全新 Web owner 配对入口与自治能力安装仍归 17；没有把复用 Web 模型线路当作完成 Web 产品安装。

- 05 入口复核纠正：原生 `create_goal` 拒绝 Delivery 的 `delivery` 消息来源；因此新增 `goal_create`，用真实 owner 当前回合与 Policy create/observe 授权桥接原生 GoalService，不伪造 `user` 来源。验收须实际调用该工具，不能只凭 Host pre-step 直接创建来证明聊天入口可用。首次全仓检查 v1 的跨包测试 source 导入/rootDir 和缺少插件 config 参数已修复，失败运行不计作通过。
- 05 首切片工程验收：18 项 Goals 测试、真实 Delivery 的工具创建/原生 direct-human 拒绝/重启恢复与 owner handoff 两项集成测试、Policy 明确授权回归均通过；存储与服务分别经独立只读复核通过。历史截断/当前投影不一致、错误 focus、非私有 WAL/SHM/目录被拒绝；合法原生 objective 编辑后可恢复。原生 complete 后创建新 GoalId 时，旧业务记录仍保留 awaiting-verification。
- 05 最终根 `CI=true pnpm check` 退出码 **0**（`/tmp/dsh-goals-check-v2.log`、`.exit`）：24 插件/3 共享库，零 lint 警告、全包类型检查、主测试 218 文件/3,113 通过（4 文件/82 跳过）、递归测试、完整构建及全部 dry-run pack 通过。检查新增 bundle 清单含 lib、patch、README、LICENSE，不含测试/数据库。本批没有新增云模型调用；这些是工程与实际 Host 链路证据，不是智能收益或完整 Web 部署验收。
- 下一步继续 05 的目标生命周期：Delivery owner 的原生 edit/pause/resume 等控制桥接、成功条件与独立验收绑定、期限/预算/授权，以及复用 Automations 的持久唤醒与原生 Session 续跑。04 的其余任务域/消融/独立留出和 17 的 Web 身份及一键安装仍保留。当前 18 个工作包为 3 项已验证、4 项实现中，其余待做；工作量不等，不能把该比例当作智能能力完成度。

- 05 生命周期切片：增加 `goal_control` 的 edit/pause/resume/clear，使用当前 owner 回合、独立 Policy action、同 Session/GoalId 绑定及原生 revision CAS。输入冻结，原生提交后再检查授权与业务读回；失败显式报告部分完成。clear 保留 tombstone；控制不声称完成目标或终止 OS 进程。设计与后续契约边界见 [目标编排接线](goal-orchestration-design.md)。
- 05 验收接线决策：保留普通前台任务的 byte-exact 入站要求，不把当前活动目标自动替换到该任务契约中。后续通过显式 Host 目标步骤生产入口冻结目标定义/step/run 的关联；历史任务成功、当前目标达成和当前执行权限分别判断。仅靠模型提交 goalId/contractId 或复用过往成功不能建立可信目标验收。
- 用户要求跨设备暂时收尾：本次全部修改以 WIP 保存，完整目标未完成。生命周期包当前 24 项测试通过、独立静态审查 PASS；Delivery 续跑仅类型检查通过，实际驱动与超时/停止/撤权验收尚未完成，存在护栏清理顺序与终态授权复核待修项。未执行本次完整 `pnpm check`。接手以 [跨设备交接](autonomy-handoff-2026-09-06.md) 的已知缺口和命令为准，保持续跑配置默认关闭。

- 05 接手续跑修复：原始前台回答先持久入队，再等待原生 goal-round-driver；保持 owning Session、GoalId 和轮次累计。固定目标后的每个 pre-step、模型请求构造前后以及工具执行前重查授权，包含工具结果后没有新 goal 消息的步骤。自然结束及 teardown 后再次核对授权和 signal；续跑剩余 deadline 同时约束清理。停止等待不表示不合作工具或子进程已经终止，无法证明 quiescent 的执行保留 unknown。
- 05 teardown 验证：护栏不再在 handle.dispose 前拆除，异步 handle 完成或可观察地拒绝后才释放；超时、`/stop`、真实 inbox lease 心跳丢失触发的外部 abort 均能在不合作工具未完成时结束前台等待，使用新 signal 的迟到工具仍被拒绝。真实 Verifier/Evaluation 记录 `unknown / quiescent:false`，原前台契约仍保留 byte-exact 入站 objective。自然目标结束后，真实 scope disposer 挂起或 owner 撤销也不会形成成功验收；handle rejection 在真实 teardown 后注入测试。Cordis 会容纳并记录单独 scope effect 的异常，本层不能声称识别所有被上游吞掉的资源错误。
- 05 本机证据：Goals 3 文件/24 测试通过；Delivery 运行时全文件 175 项通过，随后追加的 lease 丢失用例与两个取消分支共 3 项通过；专项 8 项覆盖默认 0、真实驱动暂停后恢复、第三次冷恢复读回同 GoalId/2 轮累计、耗尽后 resume 不重置上限、工具结果后真实撤权，以及自然 teardown timeout/revoke/reject。类型检查和独立只读复核 PASS。首次测试因新包缺少 lib 未能执行，补齐构建后重跑；调试中修正了读取已释放 Agent、配对前读取 owner 和只等待 tick 调度而未等待 whenIdle 终态的测试夹具，不将这些无效失败当作产品漏洞证据。
- 05 接手完整工程检查：根 `CI=true pnpm check` 退出码 **0**（本机 `/tmp/dsh-continuation-check-v1.log`、`.exit`）：24 插件/3 共享库，manifest、零 lint 警告、全部类型检查、主测试 222 文件/3,210 项通过且无跳过、递归包测试、完整构建和全部 dry-run pack 通过；其中 Delivery 27 文件/603 项、Goals 3 文件/24 项通过。最后追加的 lease-loss 测试已包含在递归 Delivery 测试中，并再次通过最终 lint 和 Delivery 类型检查。独立复核确认支持基线下的 teardown 语义；确定性模型与测试 transport 仍不构成真实云模型、外部部署、智能收益或 OS 强隔离验收。本批之后只更新文档证据，默认续跑配置未启用。
- 本机环境重新核实：全局 `dsh --version` 为 `0.1.2-rc.1`，Node `24.7.0`、pnpm `11.7.0`。这不代表 web profile 已安装或验收。Codex with ChatGPT 的 workspace-info 本次可调用但指向 `codex-with-chatgpt` 仓库，本会话没有可用的内置浏览器入口；未取得本项目 ChatGPT 评审，也未启用新连接。
- 下一批继续完整 WP05：在原 Session 执行目标步骤前冻结独立定义/step/run 契约，接 Verifier 注册代际和真实回读，再以 Automations Host executor 复用持久 `at` 唤醒。普通 Automation Agent runner 会创建新 Session，不能直接替代原目标恢复。具体文件与崩溃窗口协议见目标编排设计。18 项仍为 3 已验证、4 实现中、11 待做；真实智能增益、高权限隔离、长期主动收益和完整 Web 安装均保留原验收要求。


- 05 原生回合独立验收切片：Goals 增加默认关闭的 `verifyNativeRounds` 与 `stepMaxDurationMs`（1–300000ms，默认60000）。真实 native round 在模型调用前保存 owner/scope、目标定义、原 Session/GoalId/revision、step/run、轮次上限、授权摘要、期限及不可变 v2 验收绑定；Session flush 成功后才记录 dispatch 并放行。普通前台/Automation 保留原始 v1 语义和 digest，不将活动目标替换成普通入站要求。
- 05 语义定义与恢复：目标库 schema 2 从 native 历史重建 definition；只有 objective 改变才递增定义版本，pause/resume、轮次上限和检查点不冒充语义编辑。私有 `.executions` sidecar 保存步骤意图与终态，CAS 防止跨连接重绑/重复 dispatch；启动恢复把已 dispatch 未终态的 run 记 unknown，禁止自动重放。两套 SQLite 与 Session 没有原子事务承诺；未 dispatch 的准备意图也不自动恢复执行。
- 05 运行边界：每模型请求和工具执行前重查实时 owner/Policy、定义、原生 revision、轮次上限与期限；完成前再次检查并 checkpoint。取消、到期或无法证实终态时保留 `unknown / quiescent:false`，旧 Agent handle 保留拒绝护栏，不能通过新 signal 调用迟到工具；下次真实 Delivery 入站从原 Session 获取新 handle。scope 权限与期限摘要不是费用/token 预留或 OS 隔离，不能冒充 08–10 已完成。
- 05 下游完整接线：Verifier 注册新增明确 Goals producer，独立回读真实执行终态。Evaluation schema 10 与 Evolution schema 14 显式支持 `goal-step`，按目标定义归因并保留任务身份、canonical writer fence、历史 revision 和重放语义；同 ref 的前台任务不合并。旧约束表迁移保留历史与外键，owner 反馈修订入口仍只支持原有前台/Automation。步骤成功不会自动完成整个业务目标，历史旧定义成功也不构成新执行授权。
- 05 本批工程证据：根 `CI=true pnpm check` 退出码 **0**（`/tmp/dsh-goal-step-check-v3.log` 与 `.exit`），24 插件/3 共享库，零 lint 警告、全包类型检查、主测试224文件/3233项通过且无跳过、递归包测试、完整构建和所有 dry-run pack 通过。递归 Goals30、Verifier37、Evaluation99、Evolution160、Delivery609；检查 Goals 实际包清单含 execution/execution-store 的 lib、patch、README、LICENSE，不含测试/数据库。首次全仓检查因无用 spread lint 失败，第二次因 Evolution 未接 goal-step 联合类型而失败，均修复后再跑第三次，不计失败运行为通过。
- 05 追加边界验证：全仓检查后新增了一个真实步骤 deadline 用例，产品代码未改变；7项专项（pass/fail、无匹配profile、objective/轮次上限/complete变化、timeout）退出0（`/tmp/dsh-goal-step-integration-v3.log`）。其中 timeout 等待真实原生signal取消，迟到工具用新signal仍被拒绝，模型不续调，Verifier读回 unknown/quiescent:false；随后 Delivery 类型检查和根 lint 退出0。专项因 `-t` 未选176项不计为全仓跳过。独立只读复核 PASS；确定性模型/transport不构成真实模型收益、生产部署或OS隔离证据。
- Codex with ChatGPT：按用户提醒再次核对并采用该技能；现有连接 workspace_info 仍指向工具仓库，本项目没有已绑定对话，本会话缺少技能要求的内置浏览器。未新建外部连接、未发送评审、未取得 ChatGPT 结论；已用 `c2c record` 为本项目保存本批成功/失败检查及7项专项的可读取执行记录（任务 `c2c_0506`），方便连接恢复后实际评审。独立子代理复核与 ChatGPT 评审分别记录，不混称。
- 下一批继续完整 WP05：将可信步骤结果带回当前目标与下一步规划，补跨步骤预算/授权、复用 Automations Host executor 的持久 at 唤醒与原 Session 恢复，覆盖 crash/lease/重复外部提交窗口。完整成功条件、跨日目标闭环、过时假设主动重查与依赖变化传播仍未验收。18项保持3已验证、4实现中、11待做；04真实能力比较、08–10高权限隔离、长期主动收益和17完整Web安装继续保留。


- 05 步骤反馈闭环：启用原有 `verifyNativeRounds` 后，Goals 的 `goal_context` 和每步 SystemPrompt 提供独立 `stepFeedback`。Verifier 新增 Host 只读 `inspectAcceptedTask`，消费者重新核对完整 v2 合同、run/task、scope/owner、定义、执行终态和时间/回执有效期；缺失、过期、未来或绑定不符不显示成功。当前已结算结果与 pending 分列，旧定义保留有限历史，单个步骤 achieved 不写业务目标 complete。失败条件和所需产物摘要用于修订方案，反馈不授予工具或外部动作权限。
- 05 回合时序：DSH 基线先组装上下文再执行 pre-step，因此在 `system-prompt/assemble` 有界等待同一 Agent 的上一终态结算，再重读本插件已有 context；保留 context suppression 和实时 owner/Policy 检查。终态保存后调用现有 Verifier 的一次有界检查周期，繁忙队列仍可能 pending。该调用可间接使用 Verifier 已批准的程序/网络 authority，权限说明已补齐；没有增加第二个定时调度器。
- 05 不确定性：本地执行账本的 `unknown / quiescent:false` 独立于 Verifier 可用性，改定义、卸载 Verifier 或新 pending 均不能清除先对账的建议；不缓存历史成功。私有执行 sidecar 升至 schema 2，事务迁移派生 owner/goal/time 键，查询先按完整 scope+goal 过滤再 LIMIT，读取重算键以拒绝损坏记录；最多读取 50 条、展示 3 条历史，不是全历史审计入口。
- 05 工程证据：根 `CI=true pnpm check` 退出 **0**（本机 `/tmp/dsh-goal-feedback-check-v1.log`、`.exit`）：24 插件/3 共享库，主测试 225 文件/3244 项通过且无跳过，递归 Goals38、Verifier38、Delivery611，通过 manifest、全包 typecheck、lint、build 和全部 dry-run pack。最后 unknown 优先修订发生在主测试前的构建之前，之后额外根 lint 和 Goals typecheck 均退出0；独立只读复核 PASS。包清单含 `lib/feedback` 的 JS、声明与 maps、patch、README、LICENSE，不含测试或数据库。
- 05 真实原生驱动证据：8项专项退出0（`/tmp/dsh-goal-feedback-integration-v2.log`），含两轮失败→反馈→修订：确定性模型夹具从第二轮实际请求读取首轮独立失败条件后修正产物；两轮之间不手工 tick，最终回执分别 not-achieved/achieved，原生和业务目标没有自动 complete。专项 `-t` 排除176项不计为全仓跳过。服务测试覆盖等待后撤权和卸载后不保留旧成功，纯反馈测试覆盖重签异主/异任务、future/expiry、unknown/pending；真实 v1 SQLite 迁移保留绑定和终态。初次类型检查、旧双重转义测试断言和 unknown 读取顺序的失败均修复后通过，不把失败运行计作通过。
- Codex with ChatGPT：本会话仍缺少技能要求的内置浏览器，未取得本项目 ChatGPT 评审。已按技能为本项目保存本批成功/失败命令输出（任务 `c2c_fb05`，迭代1–5），供连接恢复后读取；这些本地记录不等同于 ChatGPT 已阅读或认可。当前工程证据仍来自实际命令和独立子代理复核。
- 下一批继续完整 WP05 的跨步骤预算/授权、复用 Automations Host executor 的持久 at 唤醒与原 Session 恢复。反馈可引导决策，但独立调查执行器、整体目标成功条件、跨日闭环、依赖变化传播和外部提交补偿仍未实现；确定性夹具不构成真实模型收益、生产部署或 OS 隔离验收。18项保持3已验证、4实现中、11待做，04能力比较、08–10高权限隔离、长期主动收益及17完整Web安装不缩减。

- 05 累计预算切片：可选 `executionBudget` 要求 `verifyNativeRounds`，在原生回合的实际 `llm/stream` 调用前持久预留模型次数、完整输入上界、受剩余额度约束的输出上限与可选费用；工具执行体前累计次数。独立 `.budgets` SQLite 按完整 owner scope + 业务目标 ID 保存不可变上限和创建时起算的绝对期限，跨目标定义编辑、pause/resume 和重启不重置。完整流与有效 usage 才结算；取消、缺失 usage、异常与崩溃保留全额预留，没有自动退款或重放。
- 05 计量边界：可信 Host 为精确 provider/model 注册输入上界和保守费率；包内不预装生产计量器。缺少 meter，或启用费用约束但费率未知时，在提供商调用前拒绝。缓存输入计入完整输入，reasoning 不重复计入 output。预算仅覆盖已绑定原生回合，是每业务目标额度；普通前台、账户总额和提供商真实账单均不由此独立保证。默认不开启，不能代替独立动作 broker 或 OS 隔离。
- 05 持久唤醒接线仍未实现：只复用 Automations 已有 Host executor、at occurrence 和 task lease 不足以排他同 Session 的前台入站。还需 Delivery 受保护的后台 owner 恢复入口、共享持久 Session fence、原 Session/GoalId/revision 与 run intent CAS；普通 Automation runner 创建新 Session，不能直接用于恢复。跨日实跑、自动调查与整体目标结果保持待做，完整 18 项目标状态不变。
- 05 累计预算最终工程验证：冻结代码后根 `CI=true pnpm check` 退出码 **0**（`/tmp/dsh-goal-budget-check-v2.log` 与 `.exit`）：24 插件/3 共享库，零 lint 警告、全部类型检查、主测试 226 文件/3,263 通过、Goals 46、Delivery 622、Verifier 38 项包测试通过，完整构建与全部 dry-run pack 成功。检查 Goals 打包清单含 `lib/budget`、`lib/budget-store`，未包含测试或数据库。11 个真实原生驱动专项用例覆盖调用/input/cost/tool 拒绝、缺失 meter/费率、缺失 usage 保留全额、cache+total 结算、剩余输出上限、挂起计量期限，以及 token-only 不受无关费用数值上限影响；8 个预算存储用例覆盖不可变上限、跨连接竞争、重启 held、重复结算和损坏数据。最终复核补了 token-only 边界，并重新冻结运行 v2，前轮结果不作为最终证据。确定性模型不代表生产路由计量、真实账单或跨日任务已经验收。
- 本轮 Codex with ChatGPT 已保存失败/成功检查记录（本地任务 `c2c_bd05`），本地检查可用；当前工具没有技能要求的内置浏览器，未取得实际 ChatGPT 规划或评审，未启用公开连接。不能把本地记录称作外部评审。
- 05 累计预算独立只读复核 **PASS**：逐项核对预留事务、完整 usage 结算、取消/撤销护栏、token-only 修正、权限文档与 v2 实际退出码和打包清单。主协调复核采纳；上述生产计量、跨日唤醒和完整目标限制仍保留。

- 05 Session 排他基础：Delivery schema 19 用 Session ID 主键覆盖普通前台、权限/compact 和 binding 创建前的 construction；自动补全及 native goal rounds 不重复 claim。每次模型/工具 gate 和续约检查 live token、binding 与主体。prepared 过期仅在同一会话身份重新授权；dispatched 过期转 unknown，不自动接管。原 handle 正常清理且跟踪的流/工具结束才释放，提前返回不会假报 quiescent。cold unknown 给 owner 核对提示，/new 可以开始不同 Session 而保留旧未知记录。
- 05 排他复核修正：续约以数据库当前期限核对同一 token；authority 与 mutation 在同一写事务。创建完成到 binding 保存之间的 orphan 仍固定原主体/工作区等身份，不因 released 而跨主体接管。Inbox 等待活跃 Session 时退回队列且不耗业务重试，领取 fence 从历史最大 token 递增，不因退回额度复用 fence。当前范围为使用同一私有 Delivery 数据库的新版内置 Host，升级前须排空旧 writer；不宣称 OS 隔离或自定义 runtime 自动受控。
- 05 下一步仍是受保护的 Goals 后台恢复入口、Automations 持久 wake 物化、原目标语义/授权/预算与 run intent 的提交绑定和跨日实跑。Session 排他不是调度器，完整 18 项范围与状态保持不变。
- 05 Session 排他最终工程证据：冻结产品和测试后根 `CI=true pnpm check` 退出码 **0**（本机 `/tmp/dsh-session-lease-check-v2.log` 与 `.exit`）：24 插件/3 共享库，manifest、零 lint 警告、全部类型检查、主测试 228 文件/3,275 项通过且无跳过、递归 Delivery 29 文件/634 项、Goals 46、Verifier 38 项通过，完整构建和全部 dry-run pack 成功。Delivery 清单包含 `lib/session-lease-runtime` 与 `lib/session-lease-types` 的 JS/声明/maps、patch、README、LICENSE，不含测试或数据库。v1 虽退出 0，但早于最后的 disposed-Agent 修正，因此只作中间证据。
- 05 Session 排他定向证据：8 项持久存储测试覆盖 v18 迁移、双连接竞争、prepared 过期/旧 fence 拒绝、dispatched unknown、重复续约、归属与版本重查及 Inbox 不耗重试；5 项真实 AgentLoop 用例覆盖正常连续入站、超时/停止/Session lease 丢失、不合作工具迟到拒绝与实际清理后释放，以及未知记录提示和 `/new`。另 2 项生命周期测试证明 Agent 已 disposed 而外层验收仍在结算时立即拒绝，并等待在途操作完成才释放。定向运行均退出 0；`-t` 排除的用例不算全仓跳过。崩溃窗口通过真实 Store 与持久行过期模拟，未声称操作系统 kill/restart、生产模型或跨日实跑通过。
- 本批 Codex with ChatGPT 使用本地任务 `c2c_sl05` 保存定向与最终完整检查记录；当前工具没有技能要求的内置浏览器，未取得 ChatGPT 规划/评审，未启用公开连接。本地记录与独立子代理复核分别记账。
- 05 Session 排他独立只读复核 **PASS**：复核事务、不可变会话身份、实际 teardown/在途操作结算、disposed-Agent gate、Inbox 单调 fence、迁移与文档，并直接读取 v2 退出码、测试计数和包清单；主协调采纳。验证者未重复运行 pnpm，测试均由根代理执行。真实多进程 Host 故障注入、后台 wake 与跨日验收保持待做。


- 05 单次持久 wake 切片：默认关闭的 `backgroundWake` 在当前 owner 人类回合通过 `goal_schedule` 暂停原生目标、flush 原 Session，并保存固定 owner lineage/业务定义/Session/GoalId/revision/期限的单次 at 意图。复用 Automations Host executor，不建立第二个调度器；先提交 paused 定义，再写 Goals 的 definition-hash 绑定，最后 activate。原 Session 加载后，在原生 resume 前以 occurrence CAS 标记 dispatched。后台使用 background Policy identity，没有伪造当前人类回合；原生 goal-round-driver 仍是后续目标回合的生产者。
- 05 wake 的边界：每个请求、工具、恢复和终态重新核对 live capability、owner、定义、期限和共享 Session fence；原生回合继续经过独立步骤验收与累计预算。DSH 将合法上下文 snapshot 保存为 user/message，恢复检查只豁免确切 system-prompt snapshot，仍要求唯一当前原生 goal source 与实际轮次。已派发但无法证明终止时为 unknown；进程崩溃留下的 dispatched 同样不可重放，不在重启时推断成功或允许接管。调度器在 Goals CAS 前产生的确切 production 终态可对账为 denied；调度器 unknown 和预算结算仍保留，不能推断退款。Session 忙碌或前置授权失败会使本次 wake 拒绝，没有自动延期重试。
- 05 wake 定向证据：实际 `agent-runtime.spec.ts -t 'scheduled goal'` 六项通过（本机 `/tmp/dsh-goal-wake-integration-v15.log`、`.exit=0`），包括 Host reload 后原 Session/GoalId 恢复且仅一次模型回合、v2 独立步骤回执 achieved、重复 tick 不重放、撤销 owner 不派发、持久旧 Inbox 和错误 revision/round 恢复不触发模型/工具，以及不响应取消的工具在 deadline 和 /stop 后保持 unknown、迟到调用拒绝和真实 teardown 后释放。模型为确定性夹具，不是跨日生产模型实跑。Goals 八项存储/协议测试通过（`/tmp/dsh-goal-wake-protocol-v3.log`），涵盖双连接 CAS、重启保留 dispatched、私有文件/损坏拒绝、两阶段发布，以及真实 Automations materialize/claim/start/recoverExpired 的 CAS 前崩溃对账；终态 hash 不匹配、preview 和无可验证上下文不能结算本地 wake。
- 本批失败记录保留：Cordis service proxy 对象比较误拒绝合法 capability、上下文 snapshot 被误算额外输入均已在真实恢复中定位并修正；最初验收测试误用仅返回 needs-attention 的 continuations，改读真实 acceptance contract 并检查 v2 回执。挂起工具夹具缺少 usage 曾在工具启动前被预算拒绝，补真实 usage 及启动 race 后才证明实际工具取消边界。未将这些失败运行计作通过，也未削弱运行或验收断言。 全仓 v1 暴露 1 秒测试窗口在并发负载下提前结束，后改为 5 秒 wake 授权、6 秒有界等待并保留工具启动断言；v2 的测试参数替换误改四处旧夹具导致 typecheck 失败，已恢复旧用例并通过专项类型检查。最终完整验收单独记录，不复用失败批次。
- 本批 Codex with ChatGPT 本地任务 `c2c_wk05` 保存失败/成功运行记录，当前工具仍缺少技能要求的内置浏览器，未取得实际 ChatGPT 规划或评审；本地执行记录不等于外部审查。
- 完整范围保持 18 项，仍为 3 项已验证、4 项实现中、11 项待做。该批仅建立 owner 明确授权的一次性恢复；自动多步骤持久编排、真实多进程故障注入、跨日生产执行、业务目标整体验收、长期主动选择和自我改进收益继续待做。单次 wake succeeded 表示该次恢复有界完成，不代表整个业务目标已达成。

- 05 单次 wake 最终工程证据：冻结产品与测试后，根 `CI=true pnpm check` 退出码 **0**（本机 `/tmp/dsh-goal-wake-check-v3.log` 与 `.exit`）。24 插件/3 共享库完成 manifest、零 lint 警告、全部类型检查；主测试 231 文件/3,290 项全部通过且无跳过，递归 Delivery 30 文件/641 项、Goals 8 文件/54 项、Verifier 38 项通过，完整构建和所有 dry-run pack 成功。Goals 包包含 `lib/wake`、`lib/wake-store`，Delivery 包包含 `lib/goal-wake-types` 的 JS/声明/maps，并各自包含 patch、README、LICENSE；无测试或数据库文件。完整成功和此前失败分别保存在 C2C 本地任务 `c2c_wk05` 的迭代 1–5，未宣称 ChatGPT 已评审。此结果不包含真实跨日模型运行或多进程 Host kill/restart 故障注入。
- 05 单次 wake 独立只读复核 **PASS**：验证者直接读取最终源码、测试、v3 全仓退出码和包清单，确认两阶段发布、一次 CAS、owner/定义/期限/Session 绑定、旧 Inbox 拒绝以及 late-tool fence，未发现遗留 P0/P1；主协调复核采纳。验证者未重复运行 pnpm，所有测试由根代理执行。完整 18 项目标继续保持未完成。


- 05 整体目标独立验收：新增显式 `task-acceptance/v3` / `task-verification/v3` 与 `goal-outcome`，绑定 owner/scope、目标定义、原 Session/GoalId 和独立 assessment ID。owner 创建/编辑时冻结精确 Host profile 的条件；后续真实回合沿用同一 criteria/profile/bounds/绝对截止时间，不能看到失败后换标准或续期。完整原生回合及验证必须落在期限内。默认关闭，并要求持久库与 `verifyNativeRounds`。
- 05 整体结果推进：当前上下文同时提供冻结整体条件、独立整体失败和 v2 步骤反馈。真实原生两轮测试证明第一步 achieved 而整体 not-achieved，第二轮接收失败条件并修复产物后整体 achieved，Host 以当前 owner/Policy、定义、Session/GoalId、revision 和实际轮次 CAS 完成原生目标，不执行第三次模型调用。模型与外部 transport 是确定性替身，不计真实模型能力增益。
- 05 整体验收恢复：私有 `.outcomes` schema 2 保存冻结定义和 assessment，v1 迁移保留旧数据；同毫秒按创建顺序查询，同触发 run 唯一且重启可查。已派发但未结算在恢复/Agent 释放时为 unknown；丢失或失效现场 fence 的成功 execution 仅返回 unknown proof。Verifier 在独立条件读取后再次核对同一生产者注册和 execution，较晚原生轮次（即使 revision 相同）、撤销或释放不能签发旧 achieved。已保存回执但尚未完成原生目标时暴露 `nativeCompletion: pending`，在后续 pre-step 按准确绑定收敛。
- 05 接线与限制：Evaluation schema 11、Evolution schema 15 分别迁移历史投影/修订/撤回，并独立接收 v3 整体目标 subject；不将步骤成绩合并成整体成功。回执、Goals 投影和 Session 分别提交；原生 complete 追加本身不等待独立 Session flush，不能声称跨库原子完成、OS kill/restart exactly-once、跨日实跑或完整 WP05 达成。恢复测试使用真实 SQLite/Verifier/本机 readback 与窄原生 Host 投影；另有真实 AgentLoop 正常两轮闭环。
- 17 安装缺口已按当前生产源码核对：默认场景和 personal-assistant 尚未安装 Goals/Verifier，纯 Web 缺少 Delivery owner 建立路径，生产代码尚无可信 GoalBudgetMeter 注册，Health 未接 Goals。下一步必须一起完成显式自治安装、真实 owner/验收规格建立、计量与诊断，不能仅增加 bundle 名或开关就宣称可用。18 个工作包仍为 3 已验证、4 实现中、11 待做。
- 05 整体验收最终工程证据：冻结产品和测试后根 `CI=true pnpm check` 退出码 **0**（本机 `/tmp/dsh-goal-outcome-check-v5.log`、`.exit`）：24 插件/3 共享库，manifest、零 lint 警告、全部类型检查，主测试 234 文件/3,320 项全部通过；Delivery 30 文件/642、Goals 10 文件/68、Verifier 5 文件/47、Evaluation 14 文件/102、Evolution 10 文件/162 项通过，完整构建与所有 dry-run pack 成功。已检查 Goals 包包含 `lib/outcome` 和 `lib/outcome-store` 的 JS/声明/maps，不包含测试或数据库。最终独立只读复核 **PASS**，主协调采纳；验证者未另跑 pnpm，直接读取实际源码、日志、退出码与限制。
- 本批失败和中间证据保留：初始测试时钟、严格契约夹具、旧 schema 版本断言、锁文件与测试语法/lint 缺口均已修复；未用降低断言或跳过测试消除失败。v4 全仓虽退出 0，但在最终旧轮次与 Agent 释放 fence 修复前，仅作中间证据。Codex with ChatGPT 本地任务 `c2c_goal_outcome_v3` 已记录成功/失败执行输出；当前缺少技能要求的内置浏览器，未取得 ChatGPT 评审，不能将本地记录或子代理复核写成 ChatGPT 结论。完整规划保持未完成。

- 05/17 验收配置预检：Verifier 增加 Host 只读 `inspectAcceptanceProfile`，精确匹配 scope、owner record/version、objective 和 task kind，返回独立深冻结配置及摘要；不创建任务身份或契约，不调用 producer/driver。非法输入和已卸载服务拒绝。实际 v1/v2/v3 服务测试用只读 SQLite 合同计数证明查询不产生任务。
- 05 创建/编辑桥接：开启整体验收后，`goal_create` 和 edit 在原生修改之前检查精确 step/whole profiles，按原生规则去掉 objective 首尾空白；有效期必须覆盖单步骤与对应验证预算。仅改轮数或提交同一 objective 保留原整体条件、profile 摘要和绝对期限，配置被替换或原期限不足会提前拒绝。v2 步骤仍按新 run 独立冻结，可由管理员调整后续步骤检查，不能重写旧 run 或整体标准。预检不是执行授权，原生/业务/验收库仍非原子事务，后续写入失败仍明确报告部分结果。
- 17 Goals 健康诊断：增加扁平能力字段，Health 区分上下文可用、已启用步骤/整体结果/预算/唤醒与依赖连接；只采集明确允许的字段，不暴露 owner、目标、路由或路径。根协调在真实服务组合中发现 Verifier 已报告 Goals，但 Health 仍只允许两个生产者，新增回归复现失败后修复为三个已知生产者，保留未知、重复、乱序和稀疏条目拒绝。旧诊断测试夹具不能单独证明真实接线。
- 05/17 本批定向证据：Goals 72 项包测试与实际 Delivery owner 工具/原生两轮 v3 专项通过；缺少整体 profile 时原生目标、业务行与契约均未创建，配置匹配后正常冻结并完成两轮。Health 组合缺陷的修复前日志 `/tmp/dsh-goal-health-regression-before.log` 退出 1；修复后实际 Host 接线、Goals service、Health service 三文件 63 项测试退出 0，见 `/tmp/dsh-goal-health-regression-after.log`。测试模型仍为确定性替身。
- 17 当前剩余安装依赖：生产 `registerBudgetMeter` 仍只有 Host API 定义，没有真实路由注册；订阅适配器的 `contextWindow` 配置不提供完整请求 token 上界或价格。默认安装场景和 personal-assistant 仍未接自治组合，纯 Web owner/验收规格建立和生产计量仍待实现。组件 health ready、profile 查询成功和本批工程检查均不表示完整自治安装已完成；18 项状态保持不变。
- 05/17 最终工程证据：根 `CI=true pnpm check` 退出码 **0**（本机 `/tmp/dsh-goal-readiness-check-v2.log`、`.exit`），manifest、零 lint 警告、全部类型检查、主测试 234 文件/3,332 项全通过，递归 Goals 72、Health 45、Verifier 51、Delivery 642 项通过，完整构建与所有 dry-run pack 成功。v1 虽退出 0，但早于最终三生产者 Health 修复，只作中间证据；v2 后仅文档与一处过时注释修正，无产品行为变更。Codex with ChatGPT 本地任务 `c2c_goal_readiness` 保存实际成功/失败日志，当前无技能要求的内置浏览器，未取得 ChatGPT 规划或评审。
- 17 实际 Web 版本审计修正：从本机 `/data00/home/jiataorui/.dsh/profiles/web/package.json` 解析，当前 Web app、client connection、goal 等依赖实际为 `0.1.2-rc.1`，来自全局 DSH 安装，而仓库中残留的 Web `0.1.0-rc.8` 缓存不能代表它。当前 Connection 确实先做 Host/Origin fence 和浏览器认证，再分发 `/api`；RPC 回调不携带每请求 owner subject。Web bundle 已有目标/审批界面，下一步应核对并复用它们，建立已认证控制面到 Delivery 固定 owner route、配对/权限、当前人类 turn 的关联。不能从 payload、Session ID 或模型自报内容推导 owner；单 owner 安装与多用户部署的身份要求需要分别落实。此项为源与安装版本调查，尚未建立新的 Web owner 入口或完成浏览器实跑。
- 05/17 本批独立只读复核 **PASS**：核对 preflight 的真实调用位置、v3 条件与绝对期限、v2 每 run 独立接纳、严格只读配置查询、最小健康字段与真实三个生产者组合，并直接读取 v2 全仓日志和红→绿退出码。主协调采纳；验证者未重复执行测试。检查 Goals、Health、Verifier 的 dry-run 清单包含编译后的 service JS/声明、patch、README、LICENSE，不含测试或 SQLite。完整目标与未验收项不变。


- 17 / 05 的 Web 执行边界切片（2026-09-07）：实际 Web Controller 有两条 Session 借用路径：cold follow 在首个快照后恢复 Agent，live prompt 直接借用已运行的 Agent。Delivery 新增持久归属检查（全部 binding 与 construction lease 状态，不随释放或撤销消失），未持有本地凭证的 Agent 不能执行模型或工具；native direct-user 消息进入已接管 Agent 时取消其租约，避免同对象绕过。已派发任务仍使用原协议 `dead_letter / processor-ambiguous`，不重放、不记成功。
- 本切片真实 Host 证据：生产 `SessionController@0.1.2-rc.1`、SessionQuery 的实际 observation 实现、持久 coordinator、AgentLoop 与 SQLite 组合验证冷恢复拒绝、热会话取消且下次调度不重放、普通未托管 Web 会话仍可创建和执行。模型是确定性 adapter；未运行浏览器认证或 HTTP/WS 传输，不把 Controller 测试当作完整产品安装。独立复核发现的同一 live Agent 借用问题已经补入实现和回归。仅恢复旧 runtime 源码的受控红测在 cold/live 两项均失败，随后完整恢复当前实现。
- Web owner 接线仍需解决：原生历史恢复、Typert Agent lookup、运行中会话独占、当前人类输入证明及 Policy 必须共同接入。模型/工具护栏不拦截全部原生 Session/Goal 写入，也不提供 arbitrary Host plugin 或同 UID 进程的 OS 隔离；不通过另建聊天界面、给匿名主体 owner 权限或仅覆盖 create/prompt/cancel 来代替完整入口。全部 18 工作包和状态保持不变。
- 本切片最终工程检查：根 `CI=true pnpm check` 退出 **0**（`/tmp/dsh-web-lease-check-v3.log` 与 `.exit`）。24 插件/3 共享库，零 lint 警告、所有类型检查、主测试 **234 文件 / 3,343 项全部通过且无跳过**，Delivery **653**、Policy **186** 项包测试，完整构建和全部 dry-run pack 通过；Delivery 打包包含执行护栏 JS/声明，无测试或数据库。前次失败暴露的新依赖版本例外、预算测试跨分钟和旧 direct-user 测试语义均已修正，未降低断言或更改生产预算；Host notice 的必需 summary 类型错误也已修正。失败日志保留，不作为成功证据。
- Codex with ChatGPT 已保存本地执行记录及红/绿测试输出；当前工具没有技能要求的内置浏览器，因此未取得实际 ChatGPT 规划或复审，不把独立代码代理复核冒充 ChatGPT 评审。
- 独立只读复核 **PASS**：复核当前实现、真实 Controller 回归、最终退出码及打包输出；再次明确未验收浏览器认证/传输、完整 Web owner admission、可伪造 Host 来源标签或 OS 隔离。下一批以现有 Web 产品入口的统一身份与会话生命周期为主线继续推进。
