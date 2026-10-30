# RSI 当前状态

更新：2026-10-30。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实施与证据查 Git。

## 当前交付

- 去除 Linux 安装与自迭代的 Docker 依赖，保留普通隔离执行、完整源码修复、工具创建/修订、独立验收、有限采用、发布与回退，不能关闭功能或改用受限创建路径。范围见[原生运行时](dockerless-runtime.md)。
- 原生执行、全仓 prepare、父/候选独立观察及创建 v3 已接入有限工具采用。原账本和回执保留完整证书绑定、已用额度、缓存及 unknown；首次采用复核原构建，后续调用及冷恢复复核保留观察器和当前 owner/来源。retained v2 不依赖过期构建授权、旧基底或编译器，不退款或重派。
- Linux 修订 v2 与配对回归 v2 已接通同一原生观察器：修订重开双 UID 全仓构建、复核完整构建证据与保留准备回执后签 revision-verification/v2（execution 绑定边界与四项摘要）；回归强制 creation v3 父证书 + revision v2 候选证书同族（边界/观察器运行时/构建基底/准备回执全等），复用部署共享观察器只读重开 `<root>/behavior.json` 锚定后签 revision-regression/v2；准入前漂移为 stale-source 不派不扣，准入后 unknown 持久不重放。linux-native 同一 schema 3 仓库边界现已接通修改计划的独立源码审批、发布、发布执行、有限采用及采用后物理回退，不再要求任何 Docker 命令证据；schema 2 macOS 单进程证据永不支撑全仓修改，历史 schema 1 Docker 证据按原版本读取、不改写不重跑。修订的外层等待预算和持久证书来源校验已补齐。下一验收先为完整检查留出可靠的构建时间余量，再接无 Docker 安装器与 docker→linux-native 保权迁移、进程内热加载。生产实例尚未经无 Docker 安装迁移；当前实机仅证明 Linux x64/cgroup v1，cgroup v2 明确拒绝，arm64 未实测。首次采用约 38 秒、冷恢复约 13 秒、简单工具调用约 25 秒，完整运行时重复校验仍有明显开销，不能称为完全无感。

## 已有部署与未完成边界

- Linux `--prepare-build` 和本地更新候选构建已默认使用原生运行时；创建环境准备器已有实现但尚未接入正式入口。`--install-owner` 仍走 Docker，原生候选激活尚未支持。不能把这些准备步骤描述为完整无 Docker 安装或无感更新。

- 公开版本 `0.1.65`；本机 CLI/owner 仍为 `0.1.64`，Host `0.2.1-rc.2`。远端已恢复备份并安装 `0.1.65`，目标与协调器在原授权内就绪，未新增创建授权；SSH 已恢复，远端目标与协调器服务已再次核实为运行中；服务存活不等于复杂任务完成。迁移必须保留主人、会话、凭据、授权范围/期限、已用额度、未知记录及回退点，不重新解释旧后端或实现摘要。
- Wiki 合法内容下次读取刷新，无需重启；前台等待、取消和进度收尾有界。外部监督器的同码维护重启只续办可证明无未知副作用的只读任务，保留原模型和剩余预算，每任务最多一次。任意硬崩溃续办、无句柄旧卡片回填及独立飞书连接尚未交付；监督器与 Host 同 UID，不隔离恶意 Host 插件。
- provider 迁移保留三个 API provider，三条自定义路线已验证，官方 DeepSeek 返回 401；旧私聊保留原 TraeX 选择。尚未验收升级后的真实复杂任务、维护重启后的原会话续办和最终回复；完整 Hermes 历史及 75 项技能迁移未完成。
- 早期旧协议一次 lost-resource-ack 清理未确认，根因尚未确定。公开 core 安装保留既存 `llm-route-capabilities` Host peer 提示；精确 Host 激活已验证，不等于真实任务完成。

## 最新验证

- 根 `VITEST_MAX_WORKERS=4 pnpm_config_workspace_concurrency=4 pnpm check` 退出 0：9696 项测试通过、298 项条件跳过、0 失败，清单/lint/typecheck/构建及 37 包 dry-run pack 全通过。检查期间 1801 个文件摘要未变；日志 SHA-256 `cbfe47a90c66f69ab02fa7f26276fa08cad18de6890a34a1f64793e1d93292fb`。原始日志及前后快照位于忽略目录 `docs/evidence/linux-revision-integration/attempt-2/`。
- 本轮覆盖 Linux 修订串行审核的外层时限、原期限与取消、Docker/macOS 原定义、真签名但错误构建/观察器来源、持久记录篡改及过期 GC 后的历史读取。修订服务整合 103 项、SourceJobs 65 项均通过；隔离断管和 Broker 授权超时测试保留真实 I/O，修正内核错误码/握手竞态，未改生产 Broker 客户端。整合仍使用受控来源和隔离端口，不能替代实际 Linux 修订全链。
- 全检耗时 1792.27 秒，接近单轮原生构建的 1800 秒上限；完整 prepare 另有安装与产物步骤，不能据此保证原授权内稳定完成。下一步保留全部验收项，减少检查的串行等待和重复开销，不延长已用授权或重派旧 unknown。
- 历史 Linux 创建/有限采用已在真实 Delivery、Session、AgentLoop/ToolRuntime 路径验证，但使用脚本供应商、内存渠道和受控 Growth 来源。新修订及发布/物理回退全链、真实 provider/Lark 复杂任务和长期学习收益尚未验收。旧工作区两次修订试验在 prepare 阶段终止，不能用于最新源码验收，也不自动重跑。
