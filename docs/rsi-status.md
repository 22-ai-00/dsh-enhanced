# RSI 当前状态

更新：2026-10-21。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实施与证据查 Git。

## 当前修复与待验收

- Linux 的 Wiki 日期格式错误已修复，正文保留；与安装收据不一致的 SDK 已恢复。审批卡的 Card 2.0 按钮结构、Cordis 重复注册及停服时的 readiness 错误处理已修复并部署到 `0.1.59`。
- **待验收：新提案审批卡的实际投递和点击回调。** 已请 owner 在真实会话中发起新提案并点击拒绝；当前尚无升级后新提案。五条旧失败审批均已过期，六条旧收件状态结果不确定，均未重放。原中断任务不会因服务恢复而自动续跑。

## 当前版本与下一步

- **`0.1.59` 已公开发布并安装到远程 Linux，Host 为 `0.2.1-rc.2`。** 发布源码 `c0866530149fa032021a5e6c16b81094046ddac4`；[Release](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39583820771) 的 Publish 与 Record 均成功。Mac/Linux 分别回读公开 registry：37/37 个包的精确版本及 `latest` 均为 `0.1.59`，七项安装资产与发布源码匹配。
- Mac arm64 与 Linux 的公开制品全新临时安装各 7/7 命令退出 0，覆盖 Host 版本、七个增强 bundle 与 base 的组合配置及 SDK 导入。临时安装未注册服务或进行 owner 配对；Mac 生产安装仍为 `0.1.55`，本轮未升级。
- 下一步完成新审批卡投递与点击验收，再按合同验证真实普通任务的学习和后续复用。

## Linux 保留 owner 升级

- 冻结 owner 的产品入口为 `dsh-rsi update --all --yes`：沿原收据绑定的官方干净源码，成对更新 target/coordinator 与私有 Host，事务内停启受管服务。原 Host 仅支持 `0.2.0-rc.2` / `0.2.1-rc.2` 到 `0.2.1-rc.2`；要求原授权有效、双服务活动、无已采用或未结的源码 activation。旧 CLI 首次须先单独自升级；适用条件与恢复见[维护说明](../scripts/install/maintenance.md#现有-linux-冻结-owner-程序升级)。
- 该 Linux 实例的快捷命令 `dsh-upgrade` 已实际执行一次并退出 0：CLI 和生产 cohort 从旧版更新为 `0.1.59`，26 个运行包的源码、收据及实际文件均核对通过。升级兼容 pnpm 11.7 为新发布包添加的精确版本 `minimumReleaseAgeExclude`，只接受已验证候选闭包中的新增项。
- 四项升级后审计均退出 0：原 owner、97 项身份/期限/预算字段、6 项授权、54 个原会话文件及 14 项非程序配置行保留。模型配置与凭据引用保留不代表外部凭据已实际调用。双 DSH 服务及监控正常，间隔 79 秒的两次检查身份稳定、重启计数为 0；飞书已连接，未见本次事故的五类错误标记。
- 验收脚本曾错误要求原子升级前后 Home inode 相等；原失败记录保留，已用冻结事务的 original/staged 身份完成独立对账，再运行原四项内容审计。未重复执行升级。原始命令、退出码及报告在忽略目录 `docs/evidence/linux-upgrade-20261021-v0159/`。

## 精确源码验证

- `0.1.59` 发布源码的 [dev CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39577561069) 与 [main CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39582825989) 均 5/5 成功。正式 Release 完整 `pnpm check` 退出 0：38 组测试、8899 通过 / 102 跳过、37 包 dry-run pack；本地 Mac 同源码完整检查也通过。跳过项不算实机通过。公开安装证据在忽略目录 `docs/evidence/release-v0159-public/`。

## 能力边界

普通使用驱动持续自迭代的目标是：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。**完整普通使用闭环尚未验收。** 工程测试、安装、服务就绪和升级保留不证明后续任务的质量、成本、延迟或回归收益。

- Mac arm64 生产 `0.1.55` 曾经完整备份后重装、重新配对 owner 并使 supervised 常驻就绪；这不是保留原 owner 的原地升级。冻结 owner/source/cohort Home 的普通原地升级与跨版本私有 Host 更新仍不支持；Intel Mac 实机未验收。
- Mac 原生新工具创建与采用使用 `macos-seatbelt`，无需 Docker；沙箱禁止联网和子进程、工作目录只读，次数与累计时长有限。候选及行为观察共享沙箱进程，缺少内存、CPU、磁盘硬配额，不等同于 Linux 双进程隔离；任意 shell 的 `isolation_run` 仍需 Docker。
