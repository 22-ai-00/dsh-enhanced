# RSI 当前状态

更新：2026-10-22。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实施与证据查 Git。

## 当前交付与阻塞

- **`0.1.60` 已公开发布并完成远程 Linux 保留 owner 升级，但明确记忆请求的免审批实机验收失败。** owner 的真实“请记住”消息已进入当前绑定会话，调用普通私有记忆新增工具，仍生成审批卡；用户随后拒绝，提案保持 rejected。不会把这条已拒绝提案自动转为批准。
- Responses 审查兼容性修复已通过独立代码复核，尚未发布和部署：正常响应的续接元数据不再导致误拒；必须收到唯一、末尾的正常完成事件，仍拒绝工具调用、截断或畸形结果。每次审查增加不含正文的回退原因记录。远程同路由隔离请求对原文及工具参数返回 `execute`，同时携带旧版会误拒的元数据；此复现不等于生产端到端验收。
- 主人明确要求的普通称呼、记忆新增/替换、本地 Wiki 创建/更新是目标范围；助手自行提议、含糊要求、删除、敏感内容或明确“等我批准”仍走审批。现有授权、预算、幂等与版本冲突检查保留。

## 发布与验证

- 当前补丁：`pnpm --filter @dsh-enhanced/assistant-policy test` 为 17 文件、446 通过 / 2 跳过，类型检查、构建、lint、diff 检查均退出 0；旧版本正常续接元数据回归失败。独立审查 PASS，精确发布源码的完整检查和跨平台 CI 待运行。原始输出及隔离模型验证位于忽略目录 `docs/evidence/owner-requested-20261021/`。
- 发布源码为 `0e2e684e4ed1997c66d7a2369f443158060f3a53`。[dev CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39604968985) 与 [main CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39617310441) 均 5/5 成功；[Release](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39618528513) 的 Publish 与 Record 均成功。正式发布完整 `pnpm check`：38 组测试、8939 通过 / 102 跳过、37 包 dry-run pack。跳过项不算实机通过。
- Mac arm64 与 Linux 各回读公开 registry，37/37 个包的精确版本与 `latest` 均为 `0.1.60`；七项安装资产与发布源码匹配。两个平台的官方临时安装均 7/7 命令退出 0，覆盖 Host `0.2.1-rc.2`、七个增强 bundle 加 base 的组合配置、飞书 SDK 导入。独立审查均 PASS；临时安装不进行 owner 配对、业务授权或服务注册。
- Mac 公开安装通过的是复制既有下载缓存、降低下载并发后的独立临时安装；前两次下载超时的失败证据保留。本机全量检查曾因超时失败；同源 macOS CI 的完整检查通过，本机四个失败测试文件保持原超时配置复测为 68 通过 / 7 跳过，37 包 pack 通过。原始命令、退出码及报告在忽略目录 `docs/evidence/release-v0160-public/`。

## Linux 保留 owner 升级

- 产品入口为 `dsh-rsi update --all --yes`，该实例已提供快捷命令 `dsh-upgrade`。沿原收据绑定的官方干净源码，成对更新 target/coordinator 与私有 Host，事务内停启受管服务。适用条件与恢复见[维护说明](../scripts/install/maintenance.md#现有-linux-冻结-owner-程序升级)。
- 生产版本已为 `0.1.60`、Host `0.2.1-rc.2`，源码 `0e2e684e`。升级 15 条命令及前后四项保留审计均退出 0，owner、原授权、会话及非程序配置保留；26 个运行包已核对。两次健康采样相隔 131.7 秒，服务身份稳定、重启计数为 0，飞书已连接。公开 CLI 与安装内容 80/80 文件字节一致；85 份升级证据哈希及独立审查 PASS。此结论只覆盖程序升级和保留审计，不代表免审批行为验收通过。
- 此前新审批卡已真实投递并由 owner 点击拒绝：单次发送受理、Policy `rejected`、回调结算 `completed`，Memory 无结果写入。仅验证拒绝路径；五条旧失败审批及六条旧不确定收件未重放。本轮核对准备位于 `docs/evidence/owner-requested-20261021/upgrade/`。

## 能力边界

普通使用驱动持续自迭代的目标是：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。**完整普通使用闭环尚未验收。** 工程测试、安装、服务就绪和升级保留不证明后续任务的质量、成本、延迟或回归收益。

- Mac arm64 生产仍为 `0.1.55`，本轮未升级；此前是完整备份后重装、重新配对 owner 并使 supervised 常驻就绪，不是保留原 owner 的原地升级。冻结 owner/source/cohort Home 的普通原地升级与跨版本私有 Host 更新仍不支持；Intel Mac 实机未验收。
- Mac 原生新工具创建与采用使用 `macos-seatbelt`，无需 Docker；沙箱禁止联网和子进程、工作目录只读，次数与累计时长有限。候选及行为观察共享沙箱进程，缺少内存、CPU、磁盘硬配额，不等同于 Linux 双进程隔离；任意 shell 的 `isolation_run` 仍需 Docker。
