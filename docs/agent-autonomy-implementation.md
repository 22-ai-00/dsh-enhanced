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
