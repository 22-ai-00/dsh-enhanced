# 外部审查吸纳与验证

本记录对照用户提供的审查与当前实现。外部审查注明基线为 `c60b41e`；本轮复核起点为 `e1a48f9`。不能把旧版本的问题、主观成熟度评分或未来能力建议直接当成当前缺陷。本轮保留 [完整自治实施账本](agent-autonomy-implementation.md) 的 18 个工作包，并将可复现的缺陷先纳入修复。

## 本轮接受的具体缺陷

| 项目 | 当前证据与修复要求 | 对应工作包 |
| --- | --- | --- |
| 凭据读取期间撤销、过期或停止服务仍可能交付 secret | `credentials-keychain/src/service.ts` 在 provider 返回与 callback 进入之间必须同步检查当前 lease；测试使用挂起 provider、真实账本和可控时钟，终态不得复活 | 08–10 |
| Host attestor 校验路径后再启动的替换窗口 | `plugin-control-plane/src/host-attestor.ts` 须保留已验证的 executable/interpreter 文件描述符跨越版本探测与 attest 启动；替换 pathname 的回归不能执行替换文件。此能力有 Linux/procfs 平台条件，不能宣称防止同 UID 修改 inode 内容 | 09、16 |
| npm 对每个包分别解析 latest，可能装入不同发布版本 | 安装前解析一次锚点版本并检查所有选中 bundle 的精确版本可用，再修改 profile；部分发布须明确失败。离线 dry-run 不能伪装已查询 registry | 17 |
| cancel-previous 在默认单并发下不能取消前一个运行 | 调度器容量满时仍需发出持久取消请求；必须等旧执行释放 lease/slot 后再启动新运行，不能靠提高并发数掩盖 | 05 |
| queue-one 仅推迟领取，最终逐个执行无限积压 | 同 definition 的周期调度只能保留约定的一个待执行 occurrence；合并必须保留审计终态，重启不恢复被合并任务，独立定义和重试不误伤 | 05 |
| ACP mode 与上游 preset 不一致、完成入口误报 max-tokens | 对照已安装上游的 `ptc` preset；修正真实完成入口的 stop reason，不能只测试映射 helper | 06、17 |
| Health 未包含 Evolution 的 taskLearningProjectionIntegrityErrors | 保留已有 quality projection 原子性检查，补充真实 store 指标和非零告警。外审“完全没有完整性检查”的泛化不成立 | 15、17 |
| Lark 常规请求缺少硬 deadline | send/reply/reaction/progress/identity 等挂起请求须有界返回；可能已经提交的发送超时保持不确定状态，不自动重发。已有 image 请求的超时保护不应重复替换 | 10、17 |

工程验收要求：定向行为回归、独立复核、最终根 `pnpm check`。本节列出接受范围，实际通过情况在下方验证记录更新；列入表格本身不表示修复或产品能力已完成。

集成检查另外发现 Delivery 多进程打开数据库时，迁移后的 `PRAGMA journal_mode = WAL` 仍可能发生锁竞争。它不在外审原始清单中，但属于同一批运行可靠性修复；需要真实并发进程和有界锁等待测试，测试失败时也须等待子进程退出再清理目录。

安装发布边界：本轮只更新开发分支。远程 bootstrap 保持已发布标签与该标签内容的 SHA-256 配对，新 cohort 逻辑进入下一次正式发布后才会被远程安装入口加载；不移动旧标签或把工作树文件哈希套在旧标签上。当前 tag asset 已在本机以真实 Git 内容核对，缺少该标签的浅克隆会跳过此项。

CI 边界：GitHub 因当前 OAuth 凭据缺少 `workflow` scope，拒绝了包含 CI 配置改动的推送。本轮因此保留既有 CI 配置，只推送产品代码与文档；`dev` 推送不会自动触发目前仅监听 `main`/PR 的 CI。为 `dev` 启用 CI、让 Linux checkout 拉取完整历史，以及新 attestor 的真实 Linux 进程验证仍待完成。

## 接受并并入后续工作包

| 建议 | 处理与验收边界 |
| --- | --- |
| core 的本地 owner 身份和审批缺口 | 工作包 17 的已知产品断点。默认 `delivery-required` 与 core 无 Delivery 的组合不能用测试 seam 证明可用。需要真实本地 owner/approval provider 和空 profile 安装验收；禁止用匿名或模型自报 principal 绕过 |
| memory.retention 缺少生产反馈入口 | 接入经身份验证的 typed Delivery producer，再验证到 Preference T2 proposal 和 owner 批准的全链路；保持信号数量、多来源门槛和重放隔离。仅扩大内部类型不算完成 |
| Wiki 数据分区 | 当前是 profile 共享 vault。调用时 Policy 不等于 owner/workspace 数据分区；在工作包 07、17 明确单 owner 安装不变量或实现命名空间迁移后，才能承诺多 owner 共用 profile |
| 长期目标、计划、验收、重规划 | 工作包 03–06 已完整要求；复用原生 goal/plan/session/worker，增加持久控制与生产入口，不再建一套重复 Agent loop |
| 真实 replay、留出集、配对基线和推广后质量监控 | 工作包 04、13–15 已要求。摘要核对和执行退出码不能代替质量证明；评价成功率、成本、返工、人工介入与非劣化，隐藏留出不得用于候选生成 |
| 自动经验提取与语义记忆 | 工作包 07、13；先生成有来源、有效期和适用范围的提案，以任务收益验收。是否使用向量检索取决于基线比较，增加 embedding 本身不是智能增益 |
| 独立权限、凭据、发布 broker 与隔离 worker | 工作包 08–10、16；实际 UID/进程/文件/网络边界、短期授权、外部停止和不可覆写审计。给执行器授权范围内的高权限，同时把信任根和裁决权放在它无法写入的位置 |
| 真实远端发布、生产启用、长时间故障演练 | 工作包 16–18；远程账号、真实模型和观察窗口须有实际证据，mock、虚拟时钟和本地 registry 不能替代 |
| unknown_after_send 对账与 lane 恢复 | 当前已有 operator cancel，不能称为永远无法恢复；自动对账须先证明目标平台提供可靠的查询/幂等凭证。保留未知状态与重复提交防护，补强诊断和人工恢复入口 |
| 跨数据库 generation、水位与重投影恢复 | 在结果生产、成长消费者及部署监控工作包 03、14、15 验证；修订后缺失服务、旧水位和重启不能重新使用失效证据 |

## 不作为当前结论采纳

- 各项 `x/10`、综合分、人数与月份估算没有共同量表、生产数据或成本测算，不写成验收承诺。
- “新增正向证据必然撤销已推广 workflow”已在 `2780fdf` 覆盖的 exact canonical owner-proof 路径修复；保留相关回归。它不代表通用 deployment cohort 已完成。
- “TraeX 完全没有 compaction 路径”需要真实 profile、上游协议和上下文溢出样本证实；已有本地预检及溢出路径。输出 `max_tokens` 和未知协议错误不能一概当作上下文溢出重试。
- 同 UID 内增加 CLI 确认框并不能提供“不可绕过”的 owner-presence 安全根。可以改善误操作，但不能替代工作包 08–10 的独立权限边界。
- 不把外审的 22 个插件与测试总数直接移植为当前库存或验证结果；以本轮实际工作树和命令为准。

## 验证记录

本轮表中缺陷及集成检查发现的 WAL 锁竞态已完成仓库修复与独立复核。冻结代码后执行根 `pnpm check`，退出码 **0**（本机 `/tmp/dsh-autonomy-audit-check-v2.log`，持久退出码 `.exit`）：manifest、零 lint 警告、类型检查、主测试 **201 文件/2,966 测试通过**（4 文件/82 测试跳过）、递归包测试、完整构建和全部 dry-run pack 通过。当前实际清单为 22 个插件和 2 个共享库。

- 凭据 27 项、Control Plane 77 项通过；后者在本机跳过 78 个 Linux-only 用例。新增测试覆盖 inode 替换、解释器描述符、句柄释放及不支持平台的拒绝路径；真实 Linux 进程回归已有测试，当前尚未执行。
- Automations 217 项通过；同时覆盖单槽/多槽、直接 claim、时间倒序、同刻 occurrence、preview/production 隔离、精确 paused Growth canary 与重启。取消仍是合作式 AbortSignal 与 lease/fence 协议，不能当成远端不可逆副作用的撤回证明。
- ACP 31 项、Health 35 项、Lark 397 项通过（Lark 1 项跳过）。Lark 的真实 SDK 对照用例证明：缺少操作级 signal 的旧路径在 token 晚到后会调用 Axios adapter；修复路径让资源请求带已取消 signal，Axios adapter 调用数为零。外部 Lark 服务未被调用。
- Delivery 580 项通过，其中 SQLite 16 项。WAL 真实读锁集成先完成迁移再切 DELETE；受控注入单独验证瞬时锁重试和非锁错误不重试。旧路径红测是受控 seam，不宣称真实读锁测试能稳定重现旧版本的并发竞争。
- 安装与发布定向测试 132 项通过，完整检查也覆盖 fresh-profile 及当前 pinned tag 的真实 Git 内容。registry/Host 部分仍使用替身；cohort 改进对远程安装入口生效需要后续正式发布。

未取得真实远端或长期运行证据的能力继续保持未完成；本批没有完成整个自治路线图，也没有把同 UID 内的机制称为操作系统隔离。
