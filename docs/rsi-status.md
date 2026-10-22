# RSI 当前状态

更新：2026-10-22。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实施与证据查 Git。

## 当前交付

- `0.1.61` 已公开发布。修复 Responses 审查中将正常续接元数据误判为拒绝的问题；仍要求唯一且末尾的正常完成事件，拒绝工具调用、截断和畸形结果，并记录不含正文的回退原因。
- 本次代码支持认证主人明确要求时直接执行普通称呼、私有记忆新增/替换、本地 Wiki 创建/更新。助手自行提议、含糊要求、删除、敏感内容或明确“等我批准”继续审批；原授权、预算、版本冲突和幂等检查保留。此前已拒绝的提案不重放。
- 远程 Linux 为 `0.1.61`、Host 为 `0.2.1-rc.2`；真实 owner 免审批写入尚未通过。新消息未调用记忆工具，助手将已拒绝旧提案误称为待审批。开发分支已补当前 owner 绑定下的只读动态状态，拒绝/过期不再作为待审批依据，工具说明要求核实实际写入结果；待完整检查、发布升级及新消息验收。旧拒绝提案不重放。

## 最新验证

- 动态状态修复通过独立代码审查及局部检查：Policy 450 通过/2 跳过，Delivery 353 通过，Memory 192 通过，Wiki 70 通过。真实 Linux 当前 Responses 模型在一次隔离只读观察中选择了 `memory_search`，未输出旧审批说法；没有执行工具，不代表记忆已保存或端到端验收通过。新证据位于 `docs/evidence/approval-status-context-20261022/`。
- 发布源码 `146359d85aaee83b325641c860bc9f8d36c9711b`。[dev CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39711087764) 与 [main CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39716404846) 均 5/5 成功；[Release](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39716574584) 的 Publish、Record 均成功。发布完整 `pnpm check`：8950 通过、102 跳过、37 包 dry-run pack。首轮 Linux 用例超时及后续同源复测记录保留，未调整超时；跳过项不算实机通过。
- Mac arm64 与 Linux 的公开安装均独立复核 PASS：37/37 包的精确版本及 `latest` 为 `0.1.61`，七个安装资产匹配发布源码，7/7 验收命令成功，Policy 75/75 文件匹配修复构建。Host 为 `0.2.1-rc.2`。临时安装跳过真实 owner 配对、业务授权及受管服务；Mac 复用了下载缓存并在线刷新元数据，不是冷缓存验收。首次 registry 可见性延迟及缓存失败证据保留。
- Linux 程序升级的 15 条命令与前后四项保留审计均退出 0，核对 26 个运行包；owner、授权原期限与已用额度、会话、历史和非程序配置保留。62 份升级证据独立复核 PASS。两次健康采样相隔 140.5 秒，三个服务在采样间身份稳定、重启计数为 0，飞书已连接，未见所查关键错误。辅助监控由既有升级快捷脚本暂停约 31 分 41 秒后恢复。
- 原始命令、退出码、哈希及报告位于忽略目录 `docs/evidence/release-v0161-public/`，审查与兼容性复现在 `docs/evidence/owner-requested-20261021/`。

## 升级与边界

- Linux 程序升级入口为 `dsh-rsi update --all --yes`；当前实例已提供 `dsh-upgrade`。沿官方干净源码更新成对的 target/coordinator 与私有 Host，保留 owner 和既有授权。适用条件与恢复见[维护说明](../scripts/install/maintenance.md#现有-linux-冻结-owner-程序升级)。
- Mac arm64 生产仍为 `0.1.55`，本轮只做公开临时安装与代码验证；此前是完整备份后重装、重新配对并启动 supervised 服务。冻结 owner/source/cohort Home 的普通原地升级与跨版本私有 Host 更新仍不支持；Intel Mac 实机未验收。
- Mac 新工具创建与采用使用 `macos-seatbelt`，无需 Docker。沙箱禁止联网和子进程，工作目录只读，次数及累计时长有限；缺少内存、CPU、磁盘硬配额，不等同于 Linux 双进程隔离。任意 shell 的 `isolation_run` 仍需 Docker。

普通使用驱动持续自迭代的完整闭环尚未验收。工程测试、安装、服务就绪和升级保留不证明后续任务的质量、成本、延迟或回归收益。
