# 自治智能体落地与验收账本

本账本落实 [2026-09-06 路线图](agent-intelligence-autonomy-roadmap-2026-09-06.md) 和 [成长专项审计](agent-growth-gap-evidence-2026-09-06.md)。目标是完整实现可验证的目标经营、任务上下文、独立验收、主动行动、高权限隔离和自主技能进化，并提供容易安装、诊断和升级的产品入口。实现起点为 `1b65852`。历史分析保留原始结论；当前进度与新证据记录在这里。

## 全局约束

- 按用户 2026-09-07 调整，计划中的天/周是人工工作量估算，不限制智能体执行速度，也不是最低工作时长。按依赖和证据连续推进，独立工作并行，前置条件满足即进入下一项；不为日历排期等待。功能本身的超时、冷却、租约和调度语义照常验证，适合的测试可用受控时钟加速。
- 复用 DSH 原生 Agent loop、goal、plan、subagent、workflow、skills 和持久 Session，不复制运行时。
- 每项能力必须接到真实执行入口；纯类型、内存模拟器、配置存在或测试替身不能单独证明产品能力完成。
- 执行成功、目标达成、送达和相对基线增益分别验收；无法验证的结果保持 unknown。
- 不缩小或重写用户目标来制造成功，不通过降低验收标准、改变留出答案或自动扩大权限来“进化”。
- 高自由执行发生在授权资源、成本、期限和可撤销 lease 内；信任根、通用凭据、隐藏评测与发布裁决在执行体无法写入的边界外。
- 用户安装 bundle 仍放在 `plugins/*`，纯共享契约放在 `packages/*`；新增插件使用生成器。部署值进入 Config，资源有 disposer，README 说明权限。
- 安装交互围绕用户目标和能力选择；复用现有安装器、profile 激活和 doctor，避免要求用户手拼插件依赖。有效配置、模型可用性和隔离就绪程度分别报告。
- 每个实现批次运行有意义的行为回归；最终必须通过根 `pnpm check`，并完成真实 profile、真实模型和实际隔离环境验证。主动性长期收益观察移至交付后的使用过程，不设最低日历周期、不阻塞交付；受控时钟或模拟回执只证明对应测试行为，不冒充长期收益。

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
| 08 | P2 | Policy 长期能力包与短期 lease：资源、动作、目的地、敏感度、期限、次数、费用、撤销；提交绑定 digest/前置版本/幂等键 | 正常预授权动作不用逐条审批；超范围、授权过期、撤销竞态、重放、重定向与数据外发被实际阻止 | 实现中 |
| 09 | P2 | 独立动作/凭据 broker 与隔离 worker，先交付一个受支持生产平台 | worker 任意代码和子进程不能读取 token/信任根，不能绕过出网与动作代理；崩溃恢复不重复提交 | 实现中 |
| 10 | P2 | 外部停止、不可由 worker 覆写的审计、版本回滚和不可逆动作补偿 | 实际终止 worker、撤 lease/凭据/出口；审计保留；部分失败有明确补偿结果 | 实现中 |
| 11 | P3/D | 统一事件 envelope 与目标关联，代码库及任务/日历至少两个真实来源，复用已有连接器 | 来源/版本/时间/可信度/去重/授权可追溯；重复和乱序事件不会重复动作；目标完成后退订 | 待做 |
| 12 | P3/D | 机会排序、静默准备/提醒/预授权执行、静默时段、合并、冷却与每目标预算 | 收益/成功率/成本/打扰/损失可解释；拒绝后冷却；交付前验证功能、指标记录与安全边界，采纳/漏报/打扰/主动收益在交付后持续观察打磨，无固定观察期 | 待做 |
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
- 07 限制：目标 Host 追加新的 superseding runtime snapshot，保留已提供过的历史快照、工具结果和模型输出；当前切片只更新有效快照，不能证明历史擦除或跨 owner 会话迁移隔离。第一切片尚无结构化 goal/step 检索；下述第二切片补齐该接线。适用条件与反例、冲突决策、工具证据压缩和实测决策收益仍待实现与验证，完整工作包未完成。
- 02 已验证，提交 `2780fdf`：普通任务与 Automation 的 `/feedback status`、`correct`、`withdraw` 接入真实 Host 入口；Evaluation schema 8 和 Delivery schema 17 保存版本化 owner 判断及成功/失败命令回执。只有明确链接的旧判断被替代；独立矛盾继续隔离，撤回不复活旧成功。owner record+version、精确回复目标与 CAS 一起校验；旧 Evaluation 缺少修订协议时拒绝，旧 foreground 数据无法证明原 principal version 时拒绝跨版本继承。
- 02 推广后验证：实际 Coordinator 调度、Evaluation 变更/卸载、重启均重查 canonical canary；负向/未知/冲突证据暂停 exact 部署版本，新增正向证据保持有效部署。晋升、回滚及激活回执丢失恢复都原子保存 artifact 与 receipt。7 条真实服务栈回归覆盖撤回、纠正、失 ACK、服务缺失和提交后崩溃恢复；两轮独立审查发现并修复了 lineage、失败重放、升级与原子提交窗口问题，最终全部通过。
- 本批最终工程验证：在 `2780fdf` 代码上执行根 `pnpm check`，持久退出码为 0（本机日志 `/tmp/dsh-autonomy-check-v6.log`，退出码 `/tmp/dsh-autonomy-check-v6.exit`）。manifest、零 lint 警告、所有包类型检查、主测试 200 文件/2,928 测试通过（4 文件/81 测试跳过）、递归包测试、完整构建与全部 dry-run pack 通过。之后仅更新账本。此前 v5 已输出全部打包结果，但跨轮后句柄丢失，故未将它当作有明确退出码的最终证据。
- 下一项：03 的独立结果验证与 04 的比较基线。03 须覆盖执行前不可变契约、独立代码行为/文档引用/目标回读、前台及 Automation 生产入口和 unknown 后续验证；私有 Host capability 不能冒充 08–10 的操作系统隔离。其余工作包完整保留。
- 外部审查修复批次：凭据交付前重新检查 lease；Host attestor 绑定已验证文件描述符；调度取消及 queue-one 按 occurrence 时间与 preview/production 域处理；ACP code/ptc 与 stop reason 映射；Lark 操作级 deadline 贯穿 token 后资源请求；Evolution 完整性指标进入 Health；安装选定同一精确 npm cohort 并在修改 profile 前预检，远程 bootstrap 保持发布标签对应哈希。全仓检查另暴露并修复 Delivery 并发开库的 WAL 转换锁竞态。各项经独立复核，细节与限制见外部审查记录。
- 本批最终本机工程验证：冻结实现后执行根 `pnpm check`，退出码 0（`/tmp/dsh-autonomy-audit-check-v2.log` 与 `.exit`）。manifest 确认 22 个插件、2 个共享库；零 lint 警告、所有类型检查、主测试 201 文件/2,966 测试通过（4 文件/82 测试跳过）、递归包测试、完整构建与全部 dry-run pack 通过。首次检查的真实 WAL 锁失败已修复，未将失败运行当作最终证据。随后因 GitHub OAuth 缺少 `workflow` scope，移除本轮 CI 配置改动并保留既有 workflow，只更新文档说明；产品代码不变。本机 macOS 跳过的 Linux 实际进程验证、真实飞书/远端发布及长期收益仍未完成。

## 完成审计

结束前逐行填写实现提交、测试命令及结果、真实运行证据和限制。只有以上工作包全部有充分证据时才宣称整体目标完成。`pnpm check` 的成功证明仓库工程检查通过；它不能单独证明智能增益、高权限隔离、外部系统发布或长期主动收益。按用户 2026-09-07 调整，主动性效果的固定观察期已取消，长期观察与打磨移至交付后，不阻塞交付；交付前仍验证主动性功能、指标记录和安全边界。

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

- 17 / 05 共享 Agent factory 生命周期（2026-09-07）：service 在有效运行时注入范围内构造唯一 Session lease manager，内置前台、construction、权限/compact 和原生 Goal wake 的 create/resume 均通过同一包装器。沿用上游唯一 AgentRegistry/factory，通过调用方 Context trace 保留独立 owner fiber；不另建 AgentLoop。setup 发布前附着确切 Agent，原生 setup commit 前后均重查当前租约，失败回滚只标记该次构造的 Agent，不按 Session ID 批量释放其他对象。
- 冷加载与清理：factory 尚未产生 Agent 的等待也计为在途，取消/卸载不能因空 Agent 集合而提前释放。调用方只保存 Agent、丢弃返回 handle 时，scope effect 仍取消/关闭租约并 await 原生 memoized disposer；真实清理结束才释放。正常显式 dispose 幂等，保留外层任务/验收的 close 边界；未合作操作继续 unknown。该内部原语尚未开放 Web owner capability、绑定新 Web 会话、原生人类输入许可或 idle Session 与后台 wake 的自动交接，不能把它作为完整 Web 安装交付。
- 独立复核发现上游 `raceAbortCall` 可在底层 preparation 尚未返回时先拒绝 resume；仅跟踪公开 factory Promise 不足以证明冷加载 quiescent。最初把所有 setup 前的 resume 失败保留 unknown，全仓检查发现这会破坏已有 `/status` 提示和权限恢复重试，未修改旧断言来掩盖。改为通过 Cordis 同步服务通知跟踪原生 factory 代次，结合当前 provider 可见性、owner fiber active 与组合 signal，排除全部三条原生取消路径后才释放已结束的普通加载失败；取消、provider 消失/替换或无法证明这些条件时保留 unknown。上游没有公开迟到 cleanup 回执，unknown 仍不能因迟到加载结束自动释放。
- 共享 factory 最终验收：根 `CI=true pnpm check` 退出 **0**（本机 `/tmp/dsh-owned-agent-check-v2.log` 与 `.exit`），24 插件/3 共享库，清单、零 lint 警告、全部类型检查、主 **235 文件 / 3,354 项** 全通过且无跳过，Delivery **31 文件 / 664 项**，完整构建与全部 dry-run pack 通过。Delivery 包包含 `lib/session-lease-runtime` 的 JS/声明/maps、patch、README、LICENSE，无测试或数据库。v1 主测试 3,348 通过、2 项恢复行为失败的记录保留，未作为最终成功证据。
- 本批定向 13 项通过（`/tmp/dsh-owned-controller-v9.log`、`.exit=0`）：真实 Controller 的冷恢复/Host notice 完成/独立 scope 清理/后续 Delivery 更高 fence，真实 AgentLoop 的 setup/commit 回滚与 owner/factory 取消后的迟到 preparation 清理，以及原 `/status`、权限恢复回归；其余单元用例覆盖 provider 代次替换、owner 重新 ACTIVE 后的取消锁存、挂起 native disposer 与 commit 授权变化。`-t` 排除的 205 项不计为全仓跳过；模型和附件为确定性夹具，未声称浏览器、HTTP/WS 或生产模型验证。
- 独立只读复核 **PASS**，主协调采纳；验证者直接读取当前实现、原生 Cordis/AgentLoop 时序、v9/v2 实际日志和退出码，没有另跑 pnpm。factory 代次证明仅覆盖官方 provider 的标准注册生命周期，不覆盖任意 Host 脱离它直接更换 registry factory。Codex with ChatGPT 本地任务 `c2c_owned_agent` 保存成功与失败输出；当前缺少技能要求的内置浏览器，未取得实际 ChatGPT 规划或评审。全部 18 工作包仍为 3 已验证、4 实现中、11 待做。

- 17 / 05 原生 Web owner 入口（2026-09-07）：通过生成器增加可选实验性 `assistant-web-owner` bundle，patch 禁用旧 Controller 行并插入受限原生 Controller；沿用实际 Typert、ApiRemotes、Goal UI 和 AgentLoop。可信安装配置固定已离线配对的 Web owner、workspace、preset 和最长激活时间，不能从客户端 payload 或 Session ID 推导 owner。Delivery 在现有运行时范围签发一个固定 capability，共用前台与后台 wake 的唯一 Session lease manager；新 Session 先 flush，再在同一事务中创建 binding 并提升确切 construction lease。
- 原生文本准入与清理：同一事务核对当前 owner record/version、binding、消息幂等性及同 lane 未完成任务，直接领取确切 native Inbox。随后以 requestId、确切文本内容和同一个 inserted/claimed 消息对象绑定一次实际人类 turn，接通业务 Goals 的 owner 证明；相同来源标签、文本和 rpcId 的第二个消息仍取消执行。native-admission / native-dispatch-started 崩溃记录均不转换为普通 Delivery 重试，即使内容像权限命令也不可重放。撤权、deadline、卸载、非法追加均取消 Agent，实际 handle 清理后才释放；无法证明停止保持 unknown。
- Web 读取与分发：Controller 的列表、搜索、历史、控制流、技能目录和 api-session 事件限制在当前 owner 绑定；真实 Goal RPC 的 Agent lookup 使用受限 facade。Cordis 需要独立激活的隔离 provider，不能 Proxy 原始 registry（trace 会解包）；SessionSkillCatalog 在原生构造时同步安装 gate，保留 Remote 原型标记。已打开的 follow 每帧返回前重查 owner，page 在异步读取结束后再查，防止撤权后继续交付已缓存历史。该边界针对受信同进程 Host 配置，不是任意 Host 插件或同 UID 进程的 OS 隔离。
- 本批真实组合证据：实际生产 bundle + SessionController + Typert Gateway + ApiRemotes 的两个事件订阅端 + AgentLoop + SQLite，验证原生文本创建业务 Goal、空闲释放、foreign Session 历史/技能/Goal RPC 拒绝以及无 foreign 事件。另有 revoke/timeout/unload/相同内容伪造消息四条取消路径、双连接 construction 提升和 native Inbox 崩溃恢复测试。v18 定向 20 项通过（其余 212 项因 `-t` 排除），v19 增强原生历史撤权断言通过。仅从编译产物移除每帧重查的受控红测在同一断言返回 buffered event 并失败，随后恢复产物；不把红测当作产品失败或成功验收。
- 交付限制：插件尚未发布，也未启用到真实 web profile。当前只接受文本，忙时拒绝，图片、排队/steer、fork、子 Agent 历史、跨渠道 owner 别名与完整安装引导仍待做。确定性模型及进程内 Gateway 不能证明 HTTP/WS、浏览器认证、真实模型、跨日执行或长期增益。全部 18 工作包及 3 已验证 / 4 实现中 / 11 待做的状态不变；下一步仍沿现有 Web 产品完成安装与端到端验收，并继续其他未完成工作包。
- 安装接线调查：`scripts/install/common.sh` 当前 core 只有 personal-assistant 与 plugin-control-plane，Delivery 由 Lark 场景引入；Goals/Web owner 尚未进入场景集合。安装顺序目前是 bundle add → dump-config → 临时 Host activation probe → 权限/渠道配置。后续不能只把需要固定 owner 配置的新 bundle 加入列表，否则会在 onboarding 前就激活失败；应先完成隔离测试 profile 中的 owner/Policy 配置提交，再探测运行时，并保留既有配置。复用 `assistant-delivery/src/operator.ts` 的本地交接语义，但不能借安装静默撤掉现有 Lark owner；安装回归落在 `tests/installers.spec.ts`、`installers-fresh-profile.spec.ts` 和 `installers-port-preflight.spec.ts`。
- 原生 Web owner 最终工程检查：冻结产品与测试后，根 `CI=true pnpm check` 退出 **0**（本机 `/tmp/dsh-native-web-check-v2.log` 与 `.exit`）。25 插件/3 共享库，清单、零 lint 警告、全部类型检查、主 **237 文件 / 3,370 项** 全通过且无跳过，Delivery **32 文件 / 678 项**、Web owner **2 项**，完整构建与全部 dry-run pack 通过。新插件包包含 lib/index、lib/version 的 JS/声明/maps、patch、README、LICENSE；Delivery 包包含 lib/native-web-owner，无测试或数据库。Schemastery 随新插件作为普通 runtime dependency 发布。v1 也退出 0，但早于历史订阅逐帧撤权检查，因此最终证据使用 v2。
- Codex with ChatGPT 本地任务 `c2c_native_web_owner` 保存 v18/v19 成功、先前真实 Gateway 技能服务失败、受控撤权红测及最终完整检查的独立记录。当前工具仍缺少技能要求的内置浏览器，未取得实际 ChatGPT 规划或评审；本地执行记录不等于 ChatGPT 复核。远端上下文 compact 出现模型 capacity 错误不会撤销仓库文件，本批以实际磁盘和测试退出码恢复进度。
- 本批独立只读复核 **PASS**：验证者直接核对实际源码、owner/lease/Inbox 事务、消息对象一次性准入、真实 Gateway 双订阅与 Goal 路径、取消清理，以及新增 page/follow 撤权检查的红绿证据和最终 v2 退出码/包清单；主协调采纳。验证者未重复运行 pnpm。真实浏览器、HTTP/WS、正式安装和模型行为仍未验收，不提升整个工作包为已验证。

- 17 原生 Web 安装入口（2026-09-07）：现有安装器新增显式 `--scenario web`，沿同一 local/npm cohort 安装 core、Delivery、Goals 与 Web owner；默认 core 不变。`--workspace` 和 `--agent-preset` 固定所选作用域，拒绝同 profile 启用的 Lark 与冲突参数。安装包后先运行本地 `dsh-web-owner-setup`，再做最终配置组合与 Host activation；CLI 内部先读取 effective config 是物化完整 Cordis replacement 的前置步骤，不启动模型或服务。
- Owner 初始化使用新增 `ensurePrincipalLocally` / Store `ensureOwner`：同一 SQLite 事务内仅空表创建，已有 exact sole active owner 原样返回。任何其他 owner、linked、revoked 或不匹配历史都拒绝，不借安装调用 handoff/复活旧身份；已配对 owner 的 ID/version、绑定和任务不变。复用 effective Delivery databasePath，默认 `$DSH_HOME/assistant-delivery/state.sqlite`，不是绕过共享数据库检查的新隐式数据库。不同 owner 的部署可用独立 `DSH_HOME`。
- 安装配置从实际 effective row 克隆，再按 YAML AST 叠加 profile 自定义配置，保留 Policy、Memory、Wiki、Automations 的完整 sibling、`!!js` 和自定义规则。新增精确 Web owner 的 ingest/external capability 可达性规则，原生 sandbox/审批和既有 deny 仍约束执行，不修改全局模型/权限默认值。不同 scope 或被用户修改的受管规则拒绝覆盖。setup 使用协作锁、源文件变化检查和原子 rename；owner DB 与 YAML 不存在跨资源事务，首次配对后写文件失败会留下未启用身份，同身份重试不轮换 lineage。
- 真实安装证据：全新临时 `DSH_HOME` + 实际 DSH `0.1.2-rc.1` 运行完整 `install-local.sh --scenario web --workspace … --yes --no-service --model skip --model-route skip --dsh-version 0.1.2-rc.1`，`/tmp/dsh-web-setup-fresh-v3.log` 与 `.exit=0`。配置组合、安装中 activation 和最终 doctor 的 activation 均通过；没有模型请求，也未改动真实用户 profile。较早 v1 的真实启动发现 YAML scalar.set 保留旧 `!!js` 标签，使所选路径被当成 JS，已改用新 scalar node，并以真实修复/重新全新安装和对应测试验证，未把该失败批次算成通过。
- 本批定向 21 项通过（`/tmp/dsh-web-setup-tests-v4.log` 与 `.exit=0`），含 SQLite owner 幂等/拒绝/双连接、真实 bundle YAML 标签与完整配置、以及实际 shell fixture 的 setup 成功/失败/缺 CLI 顺序。已安装临时 profile 再次运行真实 setup CLI 后，patch hash、owner 完整行、binding 行和全局 settings hash 均未改变（`/tmp/dsh-web-setup-repeat-cli.log` 与 `.exit=0`）。这些证据不代替真实浏览器消息、业务 Goal、模型、跨日或 OS 隔离验收；全部 18 项范围与状态不变。
- Web 安装最终工程检查：根 `CI=true pnpm check` 退出 **0**（`/tmp/dsh-web-setup-check-v1.log` 与 `.exit`），25 插件/3 共享库完成清单、零 lint 警告、全部类型检查、主 **239 文件 / 3,387 项** 全通过且无跳过，Delivery **683 项**、Web owner **8 项** 包测试，完整构建与全部 dry-run pack 通过。检查 Web owner 包包含 `bin/dsh-web-owner-setup.js`、`lib/setup` 的 JS/声明/maps、patch、README、LICENSE 和 YAML runtime dependency，无测试或数据库文件。产品与测试自本次检查开始后未改动。
- Codex with ChatGPT 本地任务 `c2c_web_setup` 分别保存早期类型错误、真实初装 JS 标签失败、21 项通过、修复后实际全新安装和最终完整检查。当前工具仍没有技能要求的内置浏览器，因此未取得实际 ChatGPT 规划或复审；本地记录与独立只读代码审查分别记账。
- 完整安装器重复运行同样退出 **0**（`/tmp/dsh-web-setup-repeat-installer-v4.log` 与 `.exit`），两次 Host activation 均通过。与重跑前快照比对，profile patch hash、完整 owner 行、binding 行及 settings hash 全部相同（`/tmp/dsh-web-setup-repeat-proof.log` 与 `.exit=0`）。独立只读复核 **PASS**，直接核对源码、最终检查/打包输出、实际 fresh/repeat 日志及 owner 初始化语义；主协调采纳。该验收限定于本批安装接线，浏览器 E2E 消息、真实模型和业务 Goal 实跑、完整预算/验收/隔离引导与全部 18 项目标仍未完成。

- 17 / 05 原生 Web 浏览器链路（2026-09-07）：真实浏览器暴露三个仅 Host activation / 进程内 Gateway 未覆盖的缺口：禁用旧 Controller 同时移除了其 client graph row；UI 使用的 workspaceId 被 owner 拒绝；空闲 Agent 回收触发 session/disposed，经原生 Controller 转成 api-session/removed 后清空界面选择。现由 owner 包发布原生 browser factory 的精确 ID 改写副本与完整 MIT 文本；运行期在已证明 owner 后注册固定 canonical workspace，并沿原生 Controller 关联 Session；只抑制已有 owner 持久会话的内存 detach 移除通知。没有另写聊天 UI、AgentLoop 或放开外部 workspace/preset。
- 浏览器验收命令 `CI=true PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:web-owner --repeat-each=3` 在实际 DSH 0.1.2-rc.1 / Chromium 146 上三次通过（本机 `/tmp/dsh-web-owner-e2e-v15.log`、`.exit=0`）。每次重新安装到空临时 DSH_HOME，调用已发布形状的 setup bin，以启动链接完成真实认证，未认证 API 为 401、错误 Origin 为 403；原生界面发送文本并点击 Allow once，真实 HTTP/WS、Inbox、业务 Goal 与 Session lease 相互核对。关闭 Host 后用同一临时 home 重启，fresh BrowserContext 重新认证并从侧栏选原会话，再发送第二条消息；owner/binding/GoalId/原文不变、两个 Inbox processed、租约释放，原生轮次只允许在原上限内递增。结构化三次证据及代码哈希见 `docs/evidence/web-owner-browser-2026-09-07.json`。
- 验收边界：仅模型使用最多六调用的确定性 adapter，没有 mock HTTP/WS、手造 owner/Goal 行或禁用原生审批；默认 workspace-write + ask 仍生效。该命令独立于 pnpm check，缺 DSH/Chromium 会失败。三次浏览器成功不证明真实模型质量、任务验收或长期自治；全部 18 项仍为 3 已验证 / 4 实现中 / 11 待做。下一步继续真实模型目标实跑、完整自治预算/验收/隔离引导与其余工作包。
- 浏览器链路最终工程检查：根 `CI=true pnpm check` 退出 **0**（`/tmp/dsh-web-client-check-v1.log` 与 `.exit`），25 插件/3 共享库，清单、零 lint 警告、全部类型检查、主 **239 文件 / 3,388 项** 全通过且无跳过，Delivery **683 项**、Web owner **9 项** 包测试，完整构建与全部 dry-run pack 通过。Web owner 包包含 `lib/client.js`、`lib/client.d.ts`、完整 `lib/THIRD_PARTY_LICENSES`、setup bin、Host lib、patch、README、LICENSE，无测试或数据库。证据文件的六个源码哈希与最终实现一致；此后仅补充文档。
- 实际 Gateway 冷恢复定向测试通过（`/tmp/dsh-web-client-gateway-v3.log`、`.exit=0`）；只从编译产物恢复旧的 idle removed 通知后，同一测试失败（`/tmp/dsh-web-client-removed-red.log`、`.exit=1`），随后逐字节恢复产物。独立只读复核 **PASS**，直接核对作用域、失败清理、上游 browser factory/许可证、三次浏览器证明及完整检查/打包输出；主协调采纳。重启后的 fresh 浏览器会额外创建一个空白 owner 会话，本批证明原会话可恢复续聊，不声称没有额外空会话。
- Codex with ChatGPT 本地任务 `c2c_web_browser` 保存真实浏览器失败、三次成功、受控回归失败与最终全仓检查。当前工具没有技能要求的内置浏览器，未取得实际 ChatGPT 规划或评审；独立代码代理复核不冒充 ChatGPT 评审。完整 18 项目标保持进行中。


- 05 / 17 真实 Web Goal 实验（2026-09-07）：新增独立命令 `CI=true PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:web-owner:real`。全新临时 profile 安装实际 bundle、运行 Web owner setup，使用既有 Codex subscription 登录与 `gpt-5.6-terra`；模型先创建限两轮的 Goal 并结束前台，再由原生 GoalRoundDriver 在同一 Session 写入订单汇总程序。真实实验 v7 退出 **0**（`/tmp/dsh-web-real-goal-v7.log`、`.exit`），31 秒内 4 次真实 dispatch/usage，原生目标在第 1 轮后 complete。独立 v2 步骤回执与 v3 整体回执均 achieved，执行 succeeded/quiescent；整体覆盖多币种累加、键排序、取消订单、负数和空输入三组固定行为用例，最终 Session lease released。完整关联、捕获源码、SHA256、审计与先前失败原因保存在 `docs/evidence/web-owner-real-goal-2026-09-07.json`。
- 此次真实实验发现 Web owner 生命周期竞态：原生驱动在前台 idle 后先等待 `sessions.flush()`，而 100ms 空闲回收可能先销毁同一个 Agent，留下 active/round0。修复仅在原生 Goal active+armed 时保留 Agent/lease，不增加第二驱动，不延长原有 maxExecutionMs；每 tick 仍重查 owner、binding、lease、Inbox claim 和期限，终态/disarm 后正常释放。缺 driver 时最多保留到原期限，不能声称自动补装调度器。实际 composed Web config 包含原生 driver，不能从 raw profile 缺少该行推断服务不存在。
- 运行时回归使用真实 GoalRoundDriver、真实 PersistenceCoordinator 与既有内存持久化 backend，在实际 `sessions.flush` 前设置共享 gate，跨 250ms 保留同 Agent、dispatched lease 且没有第二模型请求；放行后实际下一轮执行并终态/disarm、释放。专项 6 项通过（`/tmp/dsh-web-idle-tests-v7.log`、`.exit=0`），包含既有 Web 准入与撤权/期限/卸载/伪造输入清理。只去掉产品 hold 后，同一测试在 Agent 身份断言失败（`/tmp/dsh-web-idle-red-v2.log`、`.exit=1`），随后源码逐字节恢复。初始 fixture 的非法 leaseMs、缺少 reply 权限导致 owner turn 不成立、把持久 lease 状态误写 active 等失败均已明确修复，不将失败批次当作通过。专项名称过滤排除的测试不算全仓跳过；原有真实浏览器认证/重启回归也退出0（`/tmp/dsh-web-idle-browser-v1.log`）。
- 实验保留 workspace-write + ask，浏览器仅对匹配当前 Session/tool call/精确参数的请求点击 Allow once，并核对压缩 Session 中真实 `goal_create → approval/asked → allowed-once` 链。测试 guard 限精确 Goal、单个程序文件、Goal 查询和 todo notes；拒绝 shell、其他文件、显式 complete 和提权字段。只有模型写产物，Verifier 独立执行；测试提示明确引导直接写入，不能将一次可见用例 smoke 当作隐藏评测、模型比较收益或长期自治。执行 verifier 与宿主同 OS 用户，不构成隔离 worker/凭据 broker。
- 当前 subscription direct route 丢弃 maxTokens，CLI/TraeX 路由也没有可供可信累计预算使用的完整 token cap/usage 保证；本批不伪造生产 Goal meter。测试 guard 仅限制十次实际 dispatch 和首调用起五分钟绝对期限，缺失 usage 不猜测，取消不证明远端停止计费或所有 OS 后代退出。完整生产预算/验收/隔离引导、跨日主动任务与其余工作包继续推进，18 项仍保持 **3 已验证 / 4 实现中 / 11 待做**。
- 本批最终工程检查：产品与测试冻结后根 `CI=true pnpm check` 退出 **0**（`/tmp/dsh-web-real-check-v1.log` 与 `.exit`）：25 插件/3 共享库，清单、零 lint 警告、全部类型检查、主 **240 文件 / 3,393 项** 全通过且无跳过，Delivery **684 项**、Goals **72 项**、Verifier **51 项**、Web owner **9 项** 包测试通过，完整构建和全部 dry-run pack 成功。Delivery 包包含更新后的 `lib/native-web-owner` JS/声明/maps，Web owner 包仍保留 client、完整第三方许可证、setup bin、Host lib/patch/README/LICENSE；实验脚本、测试和数据库未进入包。最终全仓运行也覆盖了改为布尔身份比较的回归断言；此后只补充文档与证据。
- Codex with ChatGPT 本地任务 `c2c_real_goal` / `c2c_web_idle` 分别记录真实模型成功/失败、测试装配失败、实际运行时红绿对照、既有浏览器与最终全仓检查。当前工具仍缺少技能要求的内置浏览器，未取得 ChatGPT 规划或复审；这些本地记录与独立代理审查分别记账，不冒充 ChatGPT 评审。远端 compact 的模型 capacity 报错属于会话压缩请求失败；本次以磁盘、持久证据与实际命令退出码恢复工作，未因此回滚仓库。
- 本批独立只读复核 **PASS**：直接核对最终源码、v7 真实调用与持久审批、v2/v3 回执、产物哈希、受控红测与最终全仓日志/退出码，主协调采纳。checkpoint 阻塞窗口未单独注入撤权/期限，现有 drain 测试与定时器检查顺序覆盖相关路径；畸形 provider usage chunk 降级仍非本次专门验收范围。上述非阻断覆盖限制与完整 18 项目标继续保留。


## 07 第二切片：当前目标与步骤驱动的 Memory（2026-09-07）

- 原问题：原生 Goal 自主续跑时，Memory 只使用最近有效人类输入；即使 checkpoint 已切换到具体修复步骤，仍优先召回宽泛目标的旧清单。现在 Goals 提供只读 `goal-task-context/v1`，Memory 每次原生上下文组装重新获取当前目标或同 owner 的显式 focus，以 nextStep → human query → objective 顺序检索、去重，再补确认的偏好/约定。各 query 有界，合并结果共用原有 top-K、字节和 token 预算。
- 身份与权限：Goals 每次复核 live Agent、Delivery owner 和 Policy snapshot；同会话目标还须匹配 live native ID/revision/active。Memory 再绑定 principal record/version/digest、workspace/preset。跨会话 focus 仅提供检索上下文，不迁移执行权；checkpoint 仅作关键词，不提升规划文本的可信度。可选 Goals 服务不存在、旧版本无方法、协议不符、异常或 scope 不匹配时保留原 human-query 路径。
- 原生运行时证据：实际 DSH `AgentLoop`、`GoalService`、`goal-round-driver`、SystemPrompt、Session persistence 和 Delivery Web owner lease 运行前台及两个原生 Goal 回合，检查真实 adapter 请求的最新有效 memory snapshot。步骤由 citrus 改为 orchid 后召回随之改变；中途撤回 orchid 时下一请求改为剩余可用记忆，并保留原始 evidence URI 和预算约束。模型是确定性 adapter，记忆经公开 Store 审批提交 API 播种；该实验不代表真实模型能力或浏览器审批验收。
- 正向与反向测试：四个相关测试文件 270 项通过。仅将构建产物中 Goal context 的读取替换为 `undefined` 后，两项原生回归均实际失败，得到泛化清单而非 citrus 经验；随后恢复产物原字节。失败记录保留，不以跳过其他测试的反向实验冒充全套成功。
- 工程验收记录与源码/日志 hash 保存在 [Goal Memory 证据](evidence/goal-task-memory-2026-09-07.json)。首轮全量检查在测试夹具的严格可选属性类型检查失败，已修复。最终 `CI=true pnpm check` 退出码 0：25 插件/3 共享库、lint 无警告、全量 typecheck、根 240 文件/3,400 测试、各包测试（Delivery 686、Goals 74、Memory 98）、clean build 与全部 28 dry-run pack 通过；已检查两个受影响插件的打包文件列表。另清空全部 28 个包的生成 lib 后执行 `CI=true pnpm build`，退出码 0；重建的 Memory service 与通过运行时测试的产物 hash 相同。独立 verifier 只读审查 PASS，主代理核对实际命令、退出码和源码后接受此切片。独立安装范围按 Goals 实际包版本 `0.1.0` 校正为可选 peer `>=0.1.0 <0.2.0`，冻结锁文件安装通过；没有发布包或启用真实用户 profile。
- 完整工作包 07 仍为实现中。仍缺适用条件/反例的真实检索决策、语义冲突处理、保留原始引用的工具证据压缩、恢复时旧知识重新验证，以及同模型/同预算的实测决策收益。有效快照刷新也不等于删除历史 Session 内容。其他工作包状态不变，完整 18 项目标继续。


## 07 第三切片：有条件的经验与分歧证据（2026-09-07）

- 基线 `15f32d6` 已能按 goal/step/query 召回；本切片在同一 Memory 库增加有界 knowledge（适用条件、反例、显式 claim key/value），并打通 `memory_manage` → 完整审批 diff/幂等指纹 → 版本 CAS → 保存/搜索/快照/导出/导入。条件改变不复用原审批，同文不同条件不被正文去重吞掉。自然语言条件只作为有来源的待核对笔记，不靠词法匹配判真。
- 元数据进入检索 token 和实际原生上下文；模型可在当前步骤找到相关反例，并看到 owner/scope、原始 provenance、适用条件和未核验标记。同一显式 claim key 的不同值在查询/top-K 前被识别，完整组能装下时一起呈现；装不下时给有界分歧提示和原记录 ID，不仅留下某一侧正文。普通搜索和 confirmed 搜索也返回有界 disagreement 信息，自动关联只来自当前有效 scope 内非敏感记录。
- 一致性修复：查询命中与最终冲突汇总共用 deferred SQLite read savepoint。跨连接回归在首次排名后立即从另一连接撤回首条记录，本次仍看到完整旧组、下一次看到新态；移除外层 read wrapper 的反向实验实际返回被撤回的单侧正文而失败。该读视图不等于历史擦除，也不声称当前读取能看到开始之后的所有提交。
- 性能修复：同一 claim 组按原有精确 key 使用 Set 去重，避免反复序列化已有记录；组内排序与分歧判断保持不变。1000 条同 key 的合成记录、每版 3 次快照，本机均值从 5237.308 ms 降至 106.697 ms，每次均保留完整记录数与“不选择单侧值”提示。证据文件保留脚本和原始采样；该结果只描述本地快照耗时，不代表模型决策收益或生产延迟承诺。
- schema 4→5 只增加可空 knowledge 列，旧 content hash、proposal/intent/audit JSON 和回执不改写；实际迁移回归保持 pending 审批幂等与旧 mutation 重放，随后可继续批准。无 knowledge 的导出保留版本 1，有 knowledge 的导出使用版本 2 防止旧 reader 悄悄丢条件；两种文档均经实际提案与批准完成导入。升级前需停止旧 Host writer。
- 定向证据：Memory 8 文件/119 测试通过，原生 AgentLoop 的三个 Goal 回合场景通过；它们检查真实 adapter 请求里的反例、来源和 snapshotLimit=1 下的分歧提示。关闭 conflict grouping 后原生冲突场景实际失败（另外两项通过）；关闭跨连接读视图后单独回归实际失败。所有变体均 finally 恢复原字节，失败历史保留。完整命令、源码/日志 hash 和最终全量检查见 [Memory knowledge 证据](evidence/memory-knowledge-2026-09-07.json)。
- 独立审查已促成对 promotion compensation SQL 参数与自动关联敏感记录边界的修复。首轮全量检查在测试 schema 访问的严格类型检查失败，修正后第二轮通过；完成 Set 优化后再次清空全部 28 个包的 lib，最终 `CI=true pnpm check`（check-v3）退出码 0：零 lint 警告、类型检查、主测试 240 文件/3422 项、全部递归包测试、构建和 28 个 dry-run pack 均通过。已核对 Memory 打包清单含新增 knowledge 实现与声明、README、LICENSE 和 patch，未包含测试或数据库。
- 工作包 07 仍为实现中：显式 claim 分歧保护不等于任意自然语言矛盾识别，条件仍须结合当前系统验证；语义工具证据压缩、恢复时知识重新核验、同模型/同预算的真实决策收益和独立留出仍未完成。下一步沿已有 Evaluation benchmark 补真实 Memory variant/开发任务与 Codex cache/reasoning usage 计量，不能用 persona 替身或单次成功代替收益对照。18 个工作包的完整目标和状态保持不变。


## 04 / 07 第四切片：真实 Memory 配对开发基准（2026-09-07）

- 原生 Benchmark 增加独立版本 `memory-v1` / `memory-v2` 的 6 道公开开发题，覆盖适用条件、反例、显式 claim 分歧、owner/workspace/敏感/过期可见性、撤回与记忆注入。两臂同模型、persona、任务、种子库与预算，每 cell 使用独立真实 AgentLoop/Policy/Memory/Session，记忆经公开提案与 Host 审批播种；只有候选获准读取自动 Memory snapshot。模型没有工具，也不能读取判定答案。
- 原生协议升级为 v2，适配器工厂得到当前 Context 与独立 workspace，使 Codex subscription 路线能够使用真实 Session/Agent attestation。输入上界与启发式估计、provider 输出上限与事后观测上限分别声明；估计模式不宣称硬输入上限，观测模式不宣称 provider 输出 cap。需要金额上限时必须具备真实输入上界、provider 输出上限和四类已知费率。
- DSH usage 按未缓存输入、cache read、cache write、输出分别计量；reasoning 已包含在输出中，不重复相加。缓存未知价格保持 unknown，不以普通输入价替代。两次实际调用均报告 reasoning，但没有 cache read/write 字段；真实缓存命中尚无运行证据，分类和金额规则由定向测试覆盖。
- 使用 `codex-subscription/gpt-5.6-terra` 完成两个独立冻结计划，各 24 次调用（6 题 × 2 臂 × 2 重复），无未知样本。v1 的严格答案加引用验收为 baseline 2/12、candidate 1/12；候选核心答案为 12/12，但多用随机记忆 UUID 或漏当前资料引用，原始失败完整保留。v2 明确来源引用约定并增加分歧 marker 引用要求，使用新 dataset/plan，结果 baseline 2/12、candidate 12/12，10 对改善、2 对持平，任务聚类 95% 差值区间 [0.5, 1]。该收益只比较 v2 内同一标准下的两臂，不以修改题目后的成绩覆盖 v1。
- 实际 v1 输入 8899、输出 2509（其中 reasoning 1749）；v2 输入 12415、输出 1489（其中 reasoning 967），价格未知。随机种子只控制调度配对，不声称固定远端采样。该公开、小样本实验支持检索可用性带来的完整作答收益，不证明基础模型智能、独立隐藏留出泛化或跨日自主能力。
- Evaluation 定向测试 17 文件/132 项通过。受控反向实验关闭候选 snapshot 权限后，v1/v2 两个原生 journal 场景均实际失败；finally 恢复源文件原字节。完整计划、逐 cell 实际答案/usage、判定、失败历史和日志 hash 见 [Memory benchmark 证据](evidence/memory-benchmark-2026-09-07.json)。最终工程检查见下一项。
- 工作包 04 / 07 保持实现中；完整 18 项仍为 3 已验证、4 实现中、11 待做。仍需隐藏留出、跨日实跑、工具证据压缩与冷恢复时旧知识重核验，以及其他工作包的生产闭环。Codex with ChatGPT 本轮只保留本地执行记录；所需内置浏览器不可用，没有宣称 ChatGPT 已规划或审核。

- 最终 `CI=true pnpm check`（check-v4）退出码 0：25 插件/3 共享库、零 lint 警告、全量类型检查、根 243 文件/3452 测试、全部包测试、构建及 28 个 dry-run pack 通过。已检查 Evaluation 包含新增 Memory corpus/runtime/usage 的 JS 与声明、命令入口、README、LICENSE 和 patch，未包含测试或数据库。失败历史保留：空产物构建暴露 Memory→Goals 类型依赖，沿既有 bootstrap 补 Verifier→Automations→Goals；同步更新发布测试中的构建顺序断言；去掉含真实 SQLite 操作的既有超时回归额外 2 秒墙钟时限，保留 1 秒虚拟业务超时及迟到结果拦截断言，相关 108 项定向测试通过。check-v3 从全部 28 个 lib 清空后的构建已通过，唯一失败是上述测试墙钟时限；最终 check-v4 验证修复后的全套。
- 独立只读 verifier 最终 **PASS**：复算 16 个源码、10 个真实试验 artifact 和 20 个执行日志的 hash，核对实际退出码、版本内对照、源码边界与打包文件。主协调复核后接受本切片；完整 18 项仍未完成。用户最新执行约束已同步至规划与交接：按依赖和证据连续推进，不为按天/周的人工估算等待；主动性长期观察移至交付后。


### 2026-09-07：压缩后的原始文件证据与冷恢复（WP07 切片）

- PersonalMemory schema 6 增加 metadata-only 工具证据索引。成功的原生 `read` 必须与实时 `fs/observed`、exact owner/version、workspace/preset、Session 与 call/result 配对；引用摘要绑定原始参数、模型可见正文及原始 FS 目标身份。正常 AgentLoop 的 append result 可以引用其 `tool/call`，但复制旧 result、replacement、摘要、Memory 工具与未经观察的冷日志不会创建新原始证据。
- 原生压缩把结果移出当前 surface 后，每步注入有界原始引用。`memory_read_evidence` 支持中间关键词定位与分页；先核对 append 原文和摘要，再经当前 FS 解析、精确文件 Policy 与原生 ToolRuntime `read` 管线重查，返回前复核 owner、服务代际、工具限制、原始文件身份及读取期间的版本。符号链接改指另一份已授权文件也不能授予旧正文访问。
- 正文仍标记 historical-unverified；digest matched 不等于当前事实，模型需显式重读当前文件再作决定。仅支持原生文件 read，shell、图片、网络及任意自定义工具不通用回放。预算规则缺少独立预留凭证时审计并保守拒绝，不扣减预算。两个存储无原子事务承诺，缺失任一侧都不会伪造匹配或把旧数据归给新 owner。
- 定向回归 11 文件/153 项通过，其中 15 个真实 AgentLoop + LocalFileSystem/tool-fs + pruner + JSONL 关闭/重建场景覆盖正常旧原文定位后读出当前 v3、owner 换代/撤销、工具/文件 Policy、作用域限制/卸载、正常 pipeline deny、原始正文篡改、文件丢失、索引/Session 半提交、预算拒绝与符号链接改指。模型为确定性适配器，Delivery owner attestation 为限定测试夹具，不冒充真实云模型、实际用户 profile 或 OS 隔离验收。
- 实现中失败保留在证据清单：类型/夹具/schema 断言修正、JSONL 配置下限、审批 reviewer 的完整三维状态、原生 result 的 call provenance，以及 Cordis 服务查询返回新 trace proxy 导致的误拒绝；不能把这些失败运行计作通过。最终全仓检查、反向测试与独立复核结果附后。
- WP07 保持实现中，18 项仍为 3 已验证、4 实现中、11 待做。该切片不代表隐藏留出、真实跨日目标闭环、任意来源权限适配、完整自治安装或剩余工作包已完成。按用户要求持续按依赖推进，不为人工天/周排期等待；主动性长期观察在交付后持续打磨。

- 最终工程检查：`CI=true pnpm check`（`/tmp/dsh-tool-evidence-check-v2.log`、`.exit=0`）通过，25 插件/3 共享库，零 lint 警告、全量类型检查、根 246 文件/3486 测试、Memory 包 138 测试、全部包测试与构建，以及 28 个 dry-run pack。Memory 实际 64 个打包文件含四个 evidence 模块的 JS/声明、patch、README 与 LICENSE，不含测试或数据库。首轮全仓唯一失败是新增 4 个 DSH catalog 包漏了对应的 minimumReleaseAgeExclude 精确版本；已补清单并完整重跑，未改弱测试。
- 受控反向测试：只去除历史 FS source path/target digest 两处绑定检查，保留当前文件授权和读取期间版本复核，实际 `retargeted-file` 场景因模型读到旧 `NEEDLE=journal-v2` 而失败（退出 1）。finally 恢复原始文件字节，恢复 hash 与最终源码一致；最终完整检查覆盖恢复后的正向代码。[证据文件](evidence/tool-evidence-recovery-2026-09-07.json) 保存 18 个源码/配置和 20 个终态命令日志 hash、失败历史、恢复证明及打包清单。Codex with ChatGPT 任务 `c2c_76d1` 保存 21 条本地记录（含一条命令元数据顺序校正）；本会话无内置浏览器，未取得 ChatGPT 规划或评审。
- 独立只读 verifier 最终 **PASS**：复算全部 18 个源码/配置与 20 个日志 hash，核对真实退出码、原生 provenance、owner/source 身份绑定、当前授权回读、反向失败与恢复以及包文件；主协调据此接受本 WP07 文件证据切片。完整 18 项目标保持未完成。

- 08–10 第一批实际隔离接线：新增独立 `assistant-isolation` bundle，原生 `isolation_run` 将任意离线 shell 与显式输入送入 Linux Docker；只挂载新建工作区，Host 的 owner、Policy、SQLite 授权/审计与监督器不进入 worker。有限 grant 绑定 owner record/version/digest、workspace/preset、Session、镜像/限制/请求摘要及幂等键；额度预留、单 Controller lease/fence、撤销后同 revision 不复活、unknown 不重放已接生产路径。配置范围内禁止改走 Host bash/run_code/subagent，普通 native approval 仍保留，不能据此把完整 08 标为完成。
- 实际停止证据：原生 Agent 取消、独立 `dsh-isolation revoke` 进程、Host 整个进程组 `SIGKILL` 后的 detached supervisor，均用真实容器验证。后代通过 `setsid` 独立会话仍随容器终止；启动前崩溃预留在重开后记录 unknown/quiescent，不重放命令。外部 CLI 与监督器并发删除时，删除/等待失败不直接当作清理结论；有界重试后仅以成功删除或 inspect 明确不存在确认 quiescence。无法证明仍保持 unknown/false。修复后真实 revoke 综合场景连续三次通过。
- 隔离验证包含 Host 文件、`/proc`、环境与 Docker socket canary、真实 Host HTTP 端点、Docker 配置的 CPU/内存/PID/只读/能力检查、伪造 stdout 控制 JSON、超时与输出字节限制、链接/路径/类型/字节受限 artifact 导出和 1001 条恢复分页。网络负控暂时移除 `--network none` 后实际访问 Host canary 一次，断言如预期失败，代码字节恢复；后续正常运行仍阻止访问。模型和 Delivery/Policy 身份在 focused AgentLoop 测试中是明确夹具，不能冒充真实模型、账号或完整 profile 验收。
- 全仓检查暴露成功唤醒夹具的 5 秒绝对窗口在并发 Host 重载中耗尽；未改代码定向复跑通过，源路径确认已 dispatch 的超时应保留 unknown。只给这个成功 case 的两个 harness 调用 15 秒及 test 总 30 秒，保留默认值、生产期限、撤销/超时 case 与全部成功断言。64 核主机的高并发 SQLite 写入还触发既有 verifier fixture 超时；最终执行环境显式 `VITEST_MAX_WORKERS=8`，不修改该用例或生产语义。早期失败日志保留，不计作通过。
- 08–10 仍为实现中：当前 scratch bind mount 没有自动总磁盘/inode 配额，审计保留与持续 unknown 清理、独立动作/凭据 broker、真正无逐条审批的短期动作 lease、版本回滚/不可逆补偿、生产 bootstrap 及真实 profile/模型尚待后续实现。下一步先实测有界工作卷的生命周期与输入/产物通道；tmpfs 卷停止时可能卸载丢数据，不能先假定 stopped-container 的 `docker cp` 方案可用。全部 18 项目标保持不变，按依赖/证据推进，无按天等待或两周观察门槛。

- 本批最终工程验收与证据：[isolation-runtime-2026-09-07.json](evidence/isolation-runtime-2026-09-07.json)。根 `CI=true VITEST_MAX_WORKERS=8 DSH_ISOLATION_TEST_IMAGE=<记录的本地镜像 ID> pnpm check` 明确退出 **0**（`/tmp/dsh-isolation-check-v4.log`、`.exit`）；清单/零 lint 警告/类型检查、主测试 **253 文件/3,507 项**、各包测试、完整构建与 **26 插件 + 3 共享库** dry-run pack 通过。Isolation 独立包 7 文件/21 项，Delivery 687 项；已核对新增包实际包含 `runtime/supervisor.mjs`、`lib/cli.js`，没有测试、数据库或源码目录。独立只读复核 PASS 限于本批实现；C2C 保存本地执行证据，未获得 ChatGPT 网页复审。

- WP08–10 工作卷配额切片（2026-09-07，基线 `c60fcba`）：`assistant-isolation` 改用每任务 Linux Docker local tmpfs volume，配置 `workspaceMiB` / `workspaceInodes` 硬限制；worker/keeper 都不挂载 Host 目录。固定 BusyBox keeper 保持卷挂载，输入经 Docker 复制，worker 删除后由可信 `stat` / `cat` 检查父路径、文件类型、链接数、总字节与 UTF-8，再删除 keeper 和卷。配置镜像声明额外 VOLUME 时拒绝执行，Docker 日志存储关闭，`/tmp` 有 inode 限制；镜像仍须本地不可变 ID，不自动拉取。
- 实际存储探测证实 4 MiB / 64 inode 达到 `ENOSPC`，keeper 存活时 worker 删除后仍可导出；最后挂载卸载后数据消失，因此不声称 keeper 重启后能保留 tmpfs。受控反向测试仅放宽工作卷为 32 MiB / 4096 inode，两项真实配额测试均失败；finally 恢复 supervisor 原始字节及哈希。
- Ledger schema v2 原子迁移 v1，不擦除旧作业；同事务预留 worker memory + workspace capacity + 32 MiB keeper 和工作卷 inode，双连接不能超卖。prepared/running/unknown 未静止作业继续占用；旧活动行用量未知时拒绝新增预留。服务请求摘要绑定新限额，模型不能配置资源池或撤销记录。普通清理失败可在下一任 controller 确认 worker、keeper、卷全部删除后释放；create 回执超时的 `docker-creation-unconfirmed` 即使重启后当前资源不存在也保持未知和占用，不以快照冒充 daemon 请求完成。
- 新增实际 Docker 证据覆盖：keeper 导出中的父 symlink、最终 symlink/hardlink、目录/FIFO、单文件和累计字节、畸形 UTF-8 拒绝；真实镜像 VOLUME 拒绝；真实卷创建后 CLI 回执超时、跨 Host 恢复仍不释放且阻止后续超额任务；普通残留卷先删除失败、后续恢复清理；真实 AgentLoop 取消、外部 CLI 撤销、Host 进程组 SIGKILL 后 worker/keeper/volume 均消失。新路径已移除旧 Host bind 的产物读取实现，旧辅助函数单测不用于证明容器导出边界。
- 本切片不等于完整 08–10：仍需 daemon epoch/可信运维对账来处理创建回执不明的作业、持续 unknown 清理、审计/结果保留、独立动作/凭据 broker、无逐条审批的短期动作 lease、补偿/回滚、生产 bootstrap 和真实 profile/模型闭环。同 ledger 资源池不是全机 Docker/kernel 开销或不同 stateRoot 的统一硬约束。全部 18 项仍为 3 已验证 / 7 实现中 / 8 待做，按依赖和证据继续，无按天等待或两周观察门槛。
- 本批最终根 `CI=true VITEST_MAX_WORKERS=8 DSH_ISOLATION_TEST_IMAGE=sha256:3a13e5da38baa575985778cd09ce8ac736d4b4dafc91a430e71271f6e5311b89 pnpm check` 退出 **0**（`/tmp/dsh-quota-check-v2.log` / `.exit`）：26 插件/3 共享库、零 lint 警告、所有类型检查、主测试 **256 文件 / 3520 项通过**、Isolation **10 文件 / 34 项通过**、递归包测试、完整构建与 **29 个 dry-run pack** 均通过。已检查 Isolation 包含编译后的 CLI、runtime supervisor、patch/README/LICENSE，不含测试/源码/数据库。此前测试字符串转义/optional 字段类型错误与一次 lint 失败分别记录，未当作最终通过。
- [配额证据](evidence/isolation-quota-2026-09-07.json) 保存实际存储探测、反向失败/恢复、13 条完整终态命令日志和最终源文件哈希。Codex with ChatGPT 任务 `c2c_6a42` 记录 13 条本地执行结果；所需内置浏览器仍不可用，未取得 ChatGPT 网页规划或评审。独立 verifier 已检查实现并发现创建歧义恢复漏洞，随后确认修复条件；最后证据/hash/pack 复核因子代理 usage limit 中断，**不声称最终独立 PASS**。主协调自行核对最终全仓退出码与证据接受当前实现；独立终审及完整 18 项目标继续保留。


### 2026-09-07：隔离启动前持久记录与重启诊断（WP08–10 切片，基线 `8c215cb`）

- 修复真实恢复窗口：Host 在 fork 监督器后、`start` CAS 前崩溃时，旧 `prepared` 作业仍可能发送晚到 Docker create。现在 fork 前用当前 controller fence/version 持久提交 `supervisor-spawn-intent`；`start` 同样设置已派发标记。schema v3 原子迁移 v1/v2，旧行缺少未派发证明时统一按已尝试处理，新 prepare 显式写未派发，不沿用迁移列的保守默认值。
- Service 恢复与 Ledger settle 双层阻止已派发 unknown 变为 quiescent；覆盖 IPC 关闭、监督器退出、异常清理和创建回执超时，而非仅按某一 reason 判断。实际清理仍尝试执行，未知结果与资源预留保留、不重放。仅能证明尚未派发的新作业继续允许普通恢复清理后释放。该规则有明确可用性代价；完整安全对账尚未启用，不能删除账本来释放配额。
- 新的私有运行时见证记录 Linux boot ID、PID/start ticks、Docker Engine ID 和规范化路径。读取失败、boot ID 缺失、PID 文件/套接字替换均保守拒绝；有界 Docker info 前后重查元数据，PID 文件非阻塞打开并关闭句柄。只有收到监督器最终 IPC 且前后 daemon 相同时才保存诊断见证；它单独入库，模型结果中移除该字段。Host 在最终回执前崩溃时不会伪造见证。
- 真实崩溃回归使用可控 CLI 屏障：Host 进程组被 SIGKILL，继任 controller 已检查当前资源不存在，随后旧监督器的真实 volume create 才发生。修复后仍占用；暂时去掉两个 hold 条件时实际得到错误 quiescent:true，测试退出 1，finally 逐字节恢复源码。未以固定观察时长代替这个因果窗口。
- 可复现的 `scripts/isolation/daemon-witness-probe.py` 在独立 rootless Docker 中验证：旧 supervisor/daemon 存活拒绝、daemon 离线拒绝、同数据目录重启后 Engine ID 相同且 PID/start ticks 改变、不同 Engine ID 拒绝，以及真实卷跨重启保留后被删除。私有进程组全部停止，共享 daemon 未重启。该探针仅验证候选诊断，不证明其无 cgroup 委派的运行环境可承担 worker 隔离。
- 自动释放未接入：本机 socket activation 使 SO_PEERCRED 对端为 systemd PID 1，受保护 PID 文件与当前 Engine ID 还不足以单独证明套接字属于该 daemon；仍需可信绑定、旧请求停止屏障及清理后持久 CAS。`eligibleRestartWitness` 无生产调用，不把诊断候选当作放行凭证。持续清理、审计保留、动作/凭据 broker、补偿/回滚、安装 bootstrap 及真实 profile/模型闭环继续待做。18 项状态保持 3 已验证 / 7 实现中 / 8 待做，不受人工天/周估算限制，也无两周观察交付门槛。
- 全仓首轮主测试 258 文件 / 3531 项中，新增隔离回归全部通过；唯一失败为既有 Delivery 重载成功夹具的 1 秒独立文件验收出现 unknown。未改代码单独复跑该用例通过。仅给该成功夹具两个调用的 verifier 期限显式 5 秒，保留其他用例默认 1 秒及所有生产超时/撤权语义，补完整 receipt 失败诊断；最终全仓与独立复核结果附后。

- 最终根 `CI=true VITEST_MAX_WORKERS=8 DSH_ISOLATION_TEST_IMAGE=<记录的本地镜像 ID> pnpm check`（`/tmp/dsh-dispatch-check-v2.log` / `.exit`）退出 **0**：26 插件/3 共享库、零 lint 警告、全量类型检查、主 **258 文件 / 3531 测试**、Isolation **12 文件 / 45 测试**、全部递归包测试/构建及 **29 个 dry-run pack** 通过；Isolation 49 个文件包含新增 witness JS/声明、CLI、监督器、patch/README/LICENSE，不含源码/测试/数据库。
- 全量测试阶段之后，仅纠正 service 撤销回归的旧预期：已派发 unknown 应保留占用，并追加实际持久结果/恢复列表检查。生产文件未再改动。随后单独执行 Isolation typecheck、4 文件/22 测试及全仓 lint 全部退出 0；不把全仓检查冒称为覆盖这次后续测试断言修改。
- [结构化证据](evidence/isolation-dispatch-2026-09-07.json) 保存 12 个源码/脚本哈希、12 条终态命令日志/退出码、真实反向失败与逐字节恢复、独立 daemon 重启及 systemd 只读观测。C2C `c2c_6671` 已记录逐命令输出；所需内置浏览器不可用，未取得 ChatGPT 网页审查。独立 verifier 最终 **PASS** 限于本批安全修复与诊断基础，主协调复算全部源码/日志哈希与退出码后接受。完整 18 项目标保持未完成，下一步验证 systemd 服务/监听关系能否形成可信绑定，再完成安全释放协议与动作 broker。


## 2026-09-07：完整请求回执下的隔离配额回收

WP08–10 的下一切片已接入 Host 后台恢复与独立 `dsh-isolation reconcile` 运维入口。Schema v4 保留旧记录，supervisor 在所有 CLI 关闭后记录 create/start/copy/exec 是否正常结束；缺失、超时、输出溢出和信号中断不能获得已完成请求证明。已完成请求还必须证明原 supervisor 退出、原 Docker 代次不变、三个专属资源删除后复查不存在，随后凭不可伪造的清理回执、原 witness、当前 controller fence 和 job version 原子释放资源。原 unknown 业务结果、输出、已消耗次数与时长继续保留，不重放命令，也不退款累计预算。

真实 Docker 测试通过：包装器只阻止删除，原创建/启动/复制均取得正常回执；阻止期间保持占用，解除后分别由实际编译 CLI 子进程和 live Host 后台完成回收。竞争运维控制器被拒绝，审计保存三个精确资源及删除/缺失观测。真实 supervisor 配合假 Docker 的协议测试覆盖 mutation 非零、spawn 失败、信号、溢出和超时，并补充 artifact exec 的迟到执行风险；这些协议夹具不冒充真实 daemon 故障证明。

全仓检查发现既有 Web Goal checkpoint 测试在正确 teardown 后轮询 live-only `goals.get` 的竞态。原样单测复跑通过；测试改为在释放 checkpoint gate 前保存原生 `goal/changed` 的 detached snapshot，仍断言阻塞期间 registry/lease、终态、实际卸载和持久 lease 释放。未改变 Delivery 产品行为，修复后的单测、类型检查与独立复核通过。另一既有 Lark 并发安装成功用例的 1 秒锁等待在持久事务完成前耗尽；原样复跑通过，仅将该用例等待上限延长到 10 秒，保留并发、屏障与全部归属冲突断言，经独立复核。

最终冻结代码的 `CI=true VITEST_MAX_WORKERS=4 DSH_ISOLATION_TEST_IMAGE=sha256:3a13e5da38baa575985778cd09ce8ac736d4b4dafc91a430e71271f6e5311b89 pnpm check` 退出 0（`/tmp/dsh-reconcile-check-v4.log` / `.exit`）：主 263 文件/3560 测试、Isolation 17 文件/74 测试通过，26 插件与 3 共享库全部 lint/typecheck/build 和 29 份 dry-run pack 通过。Isolation 包含 61 个发布文件，已检查新清理/诊断/恢复模块均在包内、无源码测试或运行状态。19 份源码哈希及全部 16 条成功/失败执行记录见[结构化证据](evidence/isolation-reconciliation-2026-09-07.json)。临时日志不随 Git 同步；C2C c2c_fc42 只有本地执行记录，没有实际 ChatGPT 网页评审。最终独立 verifier 结论以结构化证据为准。

仍未完成：回执缺失、被中断的 mutation 与 Docker 代次变化均继续占用；systemd InvocationID 只是诊断，不能证明 containerd/shim 或迟到请求已经停止，因此未开放 daemon 重启后的自动释放。动作/凭据 broker、审计与结果 retention、完整自治安装及综合业务闭环继续推进。全部 18 项仍为 **3 项已验证、7 项实现中、8 项待做**；没有按天/周等待，也不以交付后长期观察阻塞当前开发。


### WP08–10：隔离结果保留与存储准入（2026-09-07）

本切片基于 `8b31916`：schema v5 保留 v1–v4 的 job、身份、请求摘要、witness 和累计 grant 用量，增加每任务存储预留。新请求先观测私有状态目录的 DB/WAL/SHM/staging 等占用，再在事务中核对记录数与活动预留；观测缺失、过期、异常路径或超过上限时拒绝新 key，旧 key 仍能读取。默认 256 MiB / 10,000 条记录；这是实际占用的准入保护，不能声称对整个文件系统实现硬配额。SQLite freelist 仅报告，不抵扣数据库外的暂存增长。

正文清理默认关闭（`resultRetentionMs=0`），显式正年龄启用后，每次最多处理 16 个已确认停止的已知终态；unknown 即使 quiescent 也保留。清理保留状态、exit code、reason 和原正文/各 artifact 的 SHA-256、UTF-8 字节数及明确的 `retention.kind=pruned`，不伪装原始空输出，不重新执行命令，也不删除幂等凭证或退款。较小正文及旧格式 artifact 元数据无法安全转换时保留原文。周期续租不再无限追加心跳审计，生命周期审计继续保留。

Host 后台和独立运维 `dsh-isolation maintain` 共用 controller fence/CAS 和有限页维护；活跃 Host 拒绝竞争 CLI。只清理已知停止 job 的精确暂存路径，保留 unknown/live/orphan；新库 incremental vacuum、旧库 page reuse，WAL reader pin 返回 busy 而不打断读者。逻辑正文减少不等于物理空间已释放，无法据此声称安全擦除。

定向验证包含真实 Docker→持久结果→记录数拒绝→停止 Host→CLI 剪裁→恢复同请求的完整路径，实际只出现一次 supervisor 派发且累计次数/时长不变；观测失败时原请求仍可回读。另有真实 WAL pinned reader、跨连接存储预留、旧库迁移、过期 fence、CAS、forged retention 和大 freelist 不抵扣的回归。最终全仓结果和独立结论记录于 [结构化证据](evidence/isolation-storage-2026-09-07.json)。早期失败与修复保留，不计为通过。

剩余范围：硬状态根配额、历史审计归档策略、被中断/缺失回执的 unknown 与 daemon 换代对账、独立动作/凭据 broker、补偿/回滚、完整自治安装及真实综合闭环。全部 18 项仍为 **3 已验证 / 7 实现中 / 8 待做**，不受按天/周估算或已取消的两周观察门槛限制。Codex with ChatGPT 本轮任务 `c2c_8e31` 只有本地执行记录；内置浏览器不可用，未取得 ChatGPT 网页规划或评审。


全量 `CI=true VITEST_MAX_WORKERS=4 DSH_ISOLATION_TEST_IMAGE=sha256:3a13e5da38baa575985778cd09ce8ac736d4b4dafc91a430e71271f6e5311b89 pnpm check` 退出 0（`/tmp/dsh-storage-check-v1.log` / `.log.exit`）：主 266 文件/3,577 测试、Isolation 20 文件/92 测试通过，26 插件/3 共享库全构建及 29 个 dry-run pack 通过。Isolation 69 个发布文件已检查包含两组新 storage 模块、CLI、README/patch/LICENSE，无测试或状态数据。主测试完成后新增的后台维护用例由后续包级测试覆盖；检查启动后加入的旧格式保护和该用例，另经最终全仓 lint 与 Isolation typecheck 退出 0（`/tmp/dsh-storage-final-static.log` / `.log.exit`）。14 个生产/测试/包文档哈希和 6 条根执行命令的成功失败记录见结构化证据；独立最终复核状态以证据为准。

独立 verifier 最终 **PASS**：14 份源文件哈希无差异，复核最终退出码、后置检查、真实 Docker/后台维护与 pack 清单及限制。主协调接受本存储切片；完整 18 项仍保持未完成。


### WP08–10：有限 GitHub 动作与短期凭据 broker（2026-09-07）

本切片基于 `5a6f0c3`，新增独立可安装的实验性 `assistant-actions`。operator 的有限 grant 绑定 Delivery owner lineage、workspace/preset、精确仓库/分支/文件、凭据 handle、过期时间和累计次数/字节；模型不能自授 grant、选择任意 URL 或任意 GraphQL。可信 Host 固定调用 GitHub `createCommitOnBranch`，同时要求 expected head，不提供分支创建、删除文件、合并、发布或 force push。worker 保持无网络、无 Host 凭据挂载；可信同进程 Host 插件不属于此 OS 隔离边界。

新私有 SQLite 动作账本先原子预留，再在凭据回调内写入 dispatched 后发送请求；短期操作最长 30 秒，双连接 controller fence/CAS 防止旧控制器结算。相同身份、Session、grant 和 key 只能读取同一请求；冲突摘要拒绝。dispatched/unknown 对同仓库、分支、expected head 阻止新 key，跨 grant/revision 也不能绕过。unknown 保持占用，最多两个 prepared/dispatched/unknown 和 10,000 条永久动作记录；累计用量不退还。重启把未定动作保留为 unknown，不自动重放、读回或释放。启动及读取校验持久 JSON、身份/授权/目的地绑定、结果和行状态，损坏时拒绝服务；这不是抵抗同 Host 恶意篡改的密码学证明。

Policy 的 `evaluateAgent` 供授权轮询，只读且不扣预算；稳定 action ID 的 `authorizeAgent` 在获取凭据前只计一次，随后再检查当前授权和 fence 才 dispatch。测试中 Keychain 只将合成令牌交给可信回调，产品固定 HTTPS 请求禁用共享全局 agent 的代理配置、不跟随重定向、不重试，响应最多 16 KiB，只返回通过绑定校验的 commit OID 或固定不确定结果。令牌不进入动作账本、模型输出或错误文字。独立 `dsh-actions revoke ROOT GRANT REV` 可撤销当前 revision，但取消 HTTP 不等于远端回滚；已发送结果保守保留 unknown。

预授权只对可信 broker 的精确 `action_github_commit` 工具对象生效，不让同名 scoped shadow 借用。Policy 的强制拒绝和其他中间件继续执行；Isolation 仅开放这个通过验证的 broker 例外，actions 自身也对有 grant 的 scope 拦截通用 Host 命令。测试已实际加载原生 ToolRuntime、Isolation、Policy 与受保护文件 Keychain，用本地 HTTP 服务器验证成功、同 key 重读、ACK 丢失后重启、新 key 拒绝、外部 CLI 撤权与有限预算；Host bash 即使单次审批允许仍无法执行。服务器夹具不等于真实 GitHub 部署；没有读取真实凭据或激活真实用户 profile。

早期类型、测试装配、账本边界和 lint 失败均保留在 [结构化证据](evidence/action-broker-2026-09-07.json)，最终工程验收与独立复核附后。C2C `c2c_a937` 只有本地执行记录；所需内置浏览器不可用，未取得 ChatGPT 网页规划或评审。剩余：可信 GitHub 读回/unknown 对账、版本回滚及不可逆补偿、动作审计保留、更多 provider、完整自治安装、业务及真实模型闭环，以及其他工作包。全部 18 项仍为 **3 已验证 / 7 实现中 / 8 待做**；按依赖与验收证据推进，无按天等待或两周观察门槛。

后续对账设计约束：公开 action marker、相同文件和当前 branch head 只能证明状态等价，不能单独证明原 HTTP mutation 已结束；其他写者重置分支后，晚到请求仍可能产生效果。因此不会仅凭状态等价把 unknown 改成功或释放占用，需另有可信请求完成/停止屏障。只读探索中的 API 字段、权限和分页语义尚待官方资料核实，不计为实现或验收。

最终根 `CI=true VITEST_MAX_WORKERS=4 DSH_ISOLATION_TEST_IMAGE=<记录的本地镜像 ID> pnpm check` 退出 **0**（`/tmp/dsh-actions-check-v1.log` / `.log.exit`）：主 272 文件 / 3,612 测试、Policy 192 项、Isolation 20 文件 / 92 项通过，27 插件 / 3 共享库完整构建及 30 份 dry-run pack 通过。主检查后追加撤销标记一致性修复，并补成实际编译 CLI 子进程撤权测试；最终 `/tmp/dsh-actions-final-v2.log` / `.log.exit` 退出 **0**，涵盖最新 Actions build/typecheck、5 文件 / 29 测试、全仓零 lint 警告与新包 dry-run pack。已检查 Actions 的 36 个发布文件含 CLI、broker、ledger、patch/README/LICENSE，不含源码、测试或状态数据。26 份源码/包文件哈希、13 条终态执行记录及独立结论保存在结构化证据中，不把早期失败或主检查后的改动冒称已被先前全仓检查覆盖。

独立 verifier 最终 **PASS**：复算 26 个源码哈希与 13 条日志/退出码均无差异，确认撤销标记一致性、预算先于凭据、原生工具精确预授权、unknown 不重放及后置测试/pack 证据。主协调接受本批变更；完整 18 项目标继续保持未完成。


- WP17 有限离线安装入口（2026-09-07，基线 `fc11237`）：新增显式 `--scenario autonomy`，沿 Web owner 安装十个顶层 bundle。setup 合并并验证 Isolation/Actions/Keychain 配置、使用最终 Docker 路径运行生产 supervisor 的固定任务探测，再绑定精确 owner lineage/workspace/preset 写入有限 grant；默认 20 次、60 分钟期限、10 分钟累计预留时长。重复 setup 保留 owner、grant 过期时间、撤销与已用预算，不因再次安装续权；默认无外部 Actions grant 或凭据。
- 真实安装发现并修复 Loader 入口缺陷：仅导出具名插件 `name` 不够，Loader 会优先取 default。Isolation/Actions 先前的 default Service class 丢失可信插件名，导致 Policy 拒绝预授权注册、注入 fiber 回滚工具注册，尽管安装激活探测显示成功。现在 default 保留插件 name/Config/apply（Actions 另保留 inject），Service 类继续具名导出；实际服务测试使用交付 default，浏览器检查两个工具均可见。
- WP08-10 接线修复：Isolation 的严格 owner/grant predicate 可为 exact `isolation_run` 免除重复风险审批，原生 Policy guard/deny 与显式工具调用预算仍有效。grant-operation Policy 仅在新 job 以 `isolation:<jobId>` 扣预算；身份轮询与原 key 取结果只读评估。失败保守保留累计 Isolation reservation，不退款。Cordis trace proxy 下公开 predicate 使用实例绑定。
- 本批根 `CI=true VITEST_MAX_WORKERS=4 DSH_ISOLATION_TEST_IMAGE=<本机固定镜像> pnpm check` 退出码 0：主测试 274 文件/3623 项，Policy 193 项、Isolation 20 文件/92 项、Web owner 16 项、Actions 29 项；manifest、零 lint 警告、类型、构建和 27 插件/3 共享包的全部 30 次 dry-run pack 通过。已检查包内 `lib/probe.js`、`runtime/supervisor.mjs`、`lib/autonomy.js` 与 setup CLI 均存在。
- 本批验收详情与所有失败/修复后的命令记录见 [结构化证据](evidence/autonomy-install-2026-09-07.json)。真实临时 profile 的安装→重复 setup→浏览器原生工具→Docker→artifact 回传链路，不点击逐条审批，两个 prompt 只产生一个成功 job、一次 20000ms 预留与 `answer.txt=42`。模型为最多六次调用的确定性 fixture，不能作为真实模型智能、业务目标达成或全自治证明。
- 后续优先把 WP05/17 接到当前 Web owner 的 `goal_create` 与同 Session native 下一轮，保留 exact tool/owner-turn/Policy gate；不直接放开 `goal_*`。Isolation artifact 目前仅为不可信工具输出，需提供 Host 冻结并复读的 job/request/scope/session/round/artifact digest 证据，接 Goals/Verifier 的不可变契约与独立裁决，不能靠模型 checkpoint 自证成功。后台 wake/owner route、外部目标/凭据、补偿、真实模型收益及完整 18 包继续推进；状态仍为 **3 已验证、7 实现中、8 待做**，无按天等待或固定观察期。

## 2026-09-07：隔离产物到原生目标的独立验收

本批从 `6c8524b` 继续 WP05/08/17 接线；全部 18 项仍为 **3 已验证、7 实现中、8 待做**。规划中的天/周只是原先估算，不作为执行节拍；已取消的两个工作周观察不再阻塞交付。

- 共享 v4 契约只允许 Goals step/outcome 的全 isolated criteria，旧 v1/v2/v3 保持兼容。模型只见 artifactPath、authority 摘要和 testSet 引用；测试输入/预期结果保存在 Host Verifier authority，容器每次仅收到产物和当前输入，反馈不回传私有向量。
- Isolation schema v6 在派发前记录真实 admitted native round 的 acceptance ID/digest、run、turn、声明路径；同 key 不重绑，最新同路径失败/unknown 遮蔽旧成功。Verifier 通过实时 Goals producer、持久 trigger run 和精确 step contract 核验 owner/scope/Session/定义，再读取成功、已静止、有效期内的未清理产物；运行中 admission 改变会取消。
- 独立 `IsolatedVerifierRunner` 使用私有有限预算/控制器/资源账本，复用生产 Docker supervisor。来源 job 和验收 job 明确分离；相同验证 key 复读既有结果，未知派发不重放。预期结果留在 Host；不调用旧的 Host process-behavior runner 执行隔离产物。Host 插件和同 UID 管理者仍在可信控制面内。
- 默认关闭的 `preauthorizedCreateMaxRounds` 仅为 exact `goal_create` 提供有限例外。开启要求 verified native rounds、whole outcome、累计预算和当前精确模型线路 meter；实时 owner 人类 turn、两个精确 isolated profiles、参数和轮数上限、只读 Policy preflight 均须通过。实际执行仍受 Policy deny；未授权其他 goal 控制或 Host shell。Goals default 保留 Loader 所需插件名；默认 0 不尝试预授权注册。
- 实际 browser2 通过了一次请求、两轮原生 Goal、两个 source job、六个 independent verification job、四个已结算预算预留。step/outcome 都先 not-achieved 后 achieved，下一轮确实收到 independent failure feedback，最终原生 phase=complete，零逐条审批。测试先使用真实 autonomy installer，再显式追加任务 profiles、budget 与确定性模型/meter；不声称安装器能通用生成可信验收条件或生产 tokenizer/价格。
- 静态审查及真实执行修复了不同 job ID 被错误要求相等、Goals v4 persistence/feedback 未接通、默认 0 预授权导致工具注册回滚、构建 bootstrap 顺序断言未更新等问题。实际 Docker 测试还暴露旧预算夹具恰跨分钟边界，现只固定该测试的 Policy 时钟，生产预算周期不变。

完整命令和失败记录、最终源码/浏览器证据与独立复核保存在 [结构化证据](evidence/isolated-goal-2026-09-07.json)。C2C `c2c_a939` 只有本地执行记录；当前没有可用内置浏览器，未获得 ChatGPT 网页规划/评审。

剩余优先项：生产精确模型 meter、可信任务验收输入与安装引导、Web 后台 wake/owner route、外部效果读回与 unknown 对账、补偿/回滚、真实模型收益，以及其余工作包。此次有限闭环不等于完整 18 包验收。

最终 `CI=true VITEST_MAX_WORKERS=4 DSH_ISOLATION_TEST_IMAGE=<证据中的本地 immutable image> pnpm check` 退出 **0**：主 277 文件 / 3,643 测试，Policy 194、Isolation 97、Goals 76、Verifier 60 项通过，27 插件 / 3 共享库完成 lint/typecheck/build 与 30 份 dry-run pack。已检查 Isolation 77 个发布文件含独立 verifier runner 与生产 supervisor，Verifier 32 个、共享任务协议 19 个发布文件均无源码、测试或状态数据。最终两条 `pnpm test:autonomy` 浏览器场景退出 **0**，覆盖默认有限执行及显式目标配置的两轮修正闭环。独立源码与浏览器证据审查 PASS；最终哈希/命令复核以结构化证据为准。

### WP17 持久授权与隔离运行诊断（2026-09-07，基线 `22fccd5`）

本批按依赖与证据继续，全部 18 项仍为 **3 已验证 / 7 实现中 / 8 待做**；人工天/周估算和已取消的两周观察期均不作为等待条件。

- 新增已安装 CLI `dsh-autonomy-doctor` 与 `doctor.sh --require-isolation`；autonomy 安装在正常 Host 激活检查后自动调用。独立诊断只组合配置，不启动第二个 Host。它核验固定 Web owner、真实工作区路径、精确 grant scope、Delivery owner lineage/version，以及 schema 6 Isolation 持久授权；撤销、过期、预算耗尽、配置漂移或缺失/旧状态均失败，不以再次安装恢复授权。
- Isolation 的新 Host-only API 用只读 SQLite 事务读取同一快照，累计所有历史 revision 的次数/预留时长；unknown 不退费。目录真实路径、当前 UID、私有权限和文件类型不合格时直接返回 unavailable，不 chmod、不迁移、不取得 controller，也不读取命令/产物。`available` 只表示 grant 快照满足这些检查。
- 探测使用最终配置的 immutable image/Docker executable 和现有生产 supervisor，在独立临时目录执行有界任务并回读 artifact；不占业务 grant。完成后再次核验配置、owner 和授权。输出明确排除动态 Policy、实时资源准入、模型硬预算、Goal 独立验收和外部 Actions，不能把一次诊断解释成完整自治已就绪。
- 浏览器回归在实际安装的临时 profile/运行中 Host 上调用诊断，核对原 controller、业务 jobs/grant、patch、模型调用数均保留；随后停止 Host，在临时账本种入撤销状态，再验证失败且不恢复授权。种入撤销用于验证诊断，不冒充外部停止 CLI 集成。原有两轮原生 Goal/独立隔离验收场景继续作为回归。
- 生产 meter 核对：本机 DSH 0.1.2-rc.1 的 DeepSeek adapter 确实写出 `max_tokens` 并请求 usage，但上下文容量来自可配置目录值，当前没有可信的请求前 `inputTokenUpperBound`。private Codex adapter 明确移除 Host 的 `maxTokens` hint。没有把二者登记成未经证明的严格 meter；外部供应商契约、输入上界及真实生产计量仍待完成。
- 后续 WP05 应复用已有 `goal_schedule`/Automations 持久 wake/Delivery 同 Session 恢复链，补实际安装 DSH 进程与磁盘 Session 的重启验收；已有 harness reload 不是该环境证明。后台默认仍关闭，生产模型、任务验收配置、外部效果读回/补偿和其他工作包继续推进。

本批完整命令（含失败）、最终源码与浏览器 artifact hash 保存在 [结构化证据](evidence/autonomy-doctor-2026-09-07.json)。C2C `c2c_a940` 只有本地执行记录；所需内置浏览器不可用，未取得 ChatGPT 网页规划/评审。

最终根 `CI=true VITEST_MAX_WORKERS=4 DSH_ISOLATION_TEST_IMAGE=<证据中的本机镜像> pnpm check` 退出 **0**：主 279 文件 / 3,654 测试，Isolation 22 文件 / 102 项、Web owner 4 文件 / 21 项；manifest、零 lint 警告、typecheck、build 和 30 份 dry-run pack 全部通过。已检查 Isolation 81 个文件包含 `lib/diagnostics.*`，Web owner 29 个文件包含 `bin/dsh-autonomy-doctor.js` 和 `lib/doctor.*`，无源码、测试或数据库。最终两条 `pnpm test:autonomy` 场景退出 **0**；诊断时原有 1 job、20,000ms 预留、19 次/580,000ms 剩余预算及 4 次模型调用均保留，临时撤销后返回 exit 1 且不续权。独立源码复核 PASS；最终命令/artifact 哈希复核记录在结构化证据中。

## 2026-09-07：真实进程重启后的目标验收与有限计划预授权

- WP05 本批以 `5e116b9` 为基线，继续按依赖和证据推进，不设置按天配额或长期观察等待期；完整 18 项状态仍为 **3 已验证 / 7 实现中 / 8 待做**。
- `preauthorizedSchedule` 默认关闭；显式开启时只预授权精确 `goal_schedule`，要求当前 owner 人类回合、原 Session/Goal/revision、累计预算与精确路由 meter、有效 owner route，以及覆盖唤醒期限的冻结隔离验收条件。只读预算 preview 不创建限制、预留或验收任务；原生 Policy guard 与实际调度 CAS 仍执行。保留原有工具默认注册和省略 `wake_at` 的查询行为，不开放 `goal_control`。
- 真实安装与独立进程恢复暴露了此前 harness 未捕获的生命周期竞态：末轮先进入原生 `blocked`，后台流程在 step verifier 仍 verifying、whole awaiting 且没有回执时已释放 Agent/报告 wake succeeded。现在 Delivery 必须等待这个 Agent 的步骤和全目标结算，前后重查授权、Session fence、期限和状态；超时或撤权不能把迟到回执变成成功。版本化等待能力拒绝旧 Delivery 的提前释放语义。
- 末轮可以经过 paused r2 → active r3 → round-limit blocked r4 → 独立全目标验收 complete r5。新增 r+3 例外只接受同 owner、定义、Session、Goal、实际最后一轮执行和 achieved 整体回执的证明，不以较大 revision 或普通模型回答推断达成。
- 根定向测试通过：52 项（46 项预算/配置/预授权/持久 wake，加 6 项原生恢复）；补充后原生恢复共 8 项通过，其中两个 controlled-verifier gate 验证等待期间 deadline 与 owner revocation 都保持 unknown，释放 gate 后不变成功、不新发模型请求。
- 根 `CI=true VITEST_MAX_WORKERS=4 DSH_ISOLATION_TEST_IMAGE=<本机已有镜像> pnpm check` 退出 **0**：主 279 文件 / 3,663 测试；Goals 82、Delivery 689、Policy 195、Isolation 102、Verifier 60 项包测试通过；manifest、零 lint 警告、typecheck、build 和 30 份 dry-run pack 成功。已检查 Goals 64、Delivery 92、Policy 66、Isolation 81 个文件，Delivery 含更新后的 `lib/goal-wake-types.*`，没有打入源码、测试或数据库。
- 浏览器测试入口为 `pnpm test:autonomy:wake`：实际 autonomy 安装到临时 profile，配置精确已有会话 owner route，停止进程后由持久 Automations 恢复原 Session。安装后验收条件、后台 Policy 与模型 meter 均为显式测试 overlay，确定性模型不证明生产模型智能或账单上限。撤权使用停止后临时 owner 库种子，并关闭固定 owner Web UI，以单独验证后台拒绝；中断在真实 source job running 后请求 SIGINT（辅助停止器有 10 秒强制终止后备），dispatched/unknown 保持不重放。

最终命令、失败现场、源码与浏览器 artifact 哈希见 [结构化证据](evidence/goal-wake-runtime-2026-09-07.json)。C2C `c2c_a941` 仅为本地执行记录；内置浏览器不可用，没有取得 ChatGPT 网页评审。生产模型计量、默认 owner route/目标配置引导、跨来源主动性收益与其他工作包继续推进。

最终 `pnpm test:autonomy:wake` 退出 **0**，三条真实安装/进程场景通过：正例使用 4 个 Host 进程，原 Session 的单个原生回合得到 step/outcome 两份 achieved v4 回执，1 个 source job 与 4 个独立 verification jobs；paused r2 → active r3 → blocked r4 → complete r5，Session lease fence 从 4 递增至 6，最终 Automations duty fence 为 4，再重启没有新增调用或任务。撤权场景保持 denied、未 dispatch、模型仍为前台的 4 次调用；运行中断场景在再重启后仍为 dispatched 未确认，仅有一次后台工具调用，无自动重放。8 项原生恢复回归和最终静态检查也通过。独立 verifier 已核实源码、实际命令退出码和三条浏览器 artifact，给出本切片 **PASS**；这不是完整 18 项验收。

原有 `pnpm test:autonomy` 两条真实安装前台回归退出 **0**：普通有限离线工具及原生目标“错误产物→独立反馈→修正→整体验收”保持通过。本批共 5 条浏览器场景，最终诊断/定位修改另经仓库实际 Oxlint 检查退出 0；早先误调用未安装的 ESLint 返回 1，也保留在命令证据中。

复核操作记录：verifier 的一次未转义 shell 查询意外执行了未配置 Chromium 路径的浏览器命令，三条用例均在启动浏览器前失败，覆盖了临时 live 输出。此前已单独保存的最终通过证据和源码未变，哈希复核通过；这次额外误执行单独记录，不替代最终通过命令，也不声称复核过程完全只读。
