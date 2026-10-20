# RSI 当前状态

更新：2026-10-20。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实施与证据查 Git。

## 当前版本与下一步

- **公开 npm 仍为 `0.1.55`，对应私有 Host 基线 `0.2.0-rc.2`。** Linux 生产 owner 安装已独立升级至程序 `0.1.56`、私有 Host `0.2.1-rc.2`、精确源码 `46551fe8c34d03a23b3f1c063f8612c33991bcb7`；这不代表 `0.1.56` 已公开发布。Mac 生产仍为公开 `0.1.55`，本轮未升级。
- 已将 `operator.spec.ts` 的测试计数改为原子发布和有界同步；Linux 目标用例连续 20 次通过，完整文件 34/34 通过。**`0.1.57` 是下一候选，尚未完成跨平台 CI 或发布。** 下一步是完整跨平台 CI、正式发布与 Mac/Linux 公开制品新装。

## Linux 升级验收

- 冻结 owner 的升级入口为 `dsh-rsi update --all --yes`：沿原收据绑定的官方干净源码，成对升级 target/coordinator 与私有 Host，事务内停启服务。支持原 Host `0.2.0-rc.2` 或 `0.2.1-rc.2` 到 `0.2.1-rc.2`；要求原授权有效、双服务活动、无已采用或未结的源码 activation。旧 CLI 首次须先单独自升级；恢复边界见[维护说明](../scripts/install/maintenance.md#现有-linux-冻结-owner-程序升级)。
- Linux 原机普通升级至上述精确源码退出 0，当前双服务由新 Host 启动且没有待恢复事务。四项独立保留审计 preservation、authority、profiles、runtime 均退出 0：owner 未重绑，授权期限及累计额度保持；97 项受保护的身份、期限与预算字段保持；47 个原 Session 保留（46 个摘要相同、1 个追加记录），14 项非程序配置行保留。adoption grant 仅按目标 Host executor 与 11 项 policy baseline 精确重基；模型配置、凭据引用和业务历史按审计范围保留，外部 Keychain 凭据未实际调用。
- 同版再次运行退出 0、提示无需停服；Home inode 以及双服务 PID、InvocationID、NRestarts 均未变。原始记录在忽略目录 `docs/evidence/linux-upgrade-20261019/`；独立复核为 PASS。上述升级和 no-op 不证明真实模型任务或长期收益。

## 验证与发行阻断

- 精确源码 `46551fe8` 的 [dev CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39385404553) 5/5 成功：Mac `pnpm check` 为 38 组、7903 通过 / 1077 跳过、37 包 dry-run pack；Linux 两条 lane 为 38 组、8879 通过 / 101 跳过、37 包 dry-run pack。跳过项不算实机通过。
- 同 SHA 的 [main CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39390522779) 与首次 [Release](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39390551680) 均因测试计数文件空读失败，已隔离复现并修复；Release 重试已取消，Publish 被跳过。`0.1.57` 的整仓跨平台复核和公开发布仍待完成，不能将定向回归或旧 dev CI 成功外推为发行成功。

## 能力边界

普通使用驱动持续自迭代的目标是：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。**完整普通使用闭环尚未验收。** 工程测试、安装、服务就绪和升级保留不证明后续任务的质量、成本、延迟或回归收益。

- Mac arm64 生产 `0.1.55` 曾经完整备份后重装、重新配对原 owner 并使 supervised 常驻就绪；这不是保留原 owner 的原地升级。冻结 owner/source/cohort Home 的普通原地升级与跨版本私有 Host 更新仍不支持；Intel Mac 实机未验收。
- Mac 原生新工具创建与采用使用 `macos-seatbelt`，无需 Docker；沙箱禁止联网和子进程、工作目录只读，次数与累计时长有限。候选及行为观察共享沙箱进程，缺少内存、CPU、磁盘硬配额，不等同于 Linux 双进程隔离；任意 shell 的 `isolation_run` 仍需 Docker。
