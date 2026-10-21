# RSI 当前状态

更新：2026-10-21。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实施与证据查 Git。

## 当前修复

- Linux 主服务因一页 Wiki 的日期字段不符合 canonical ISO 格式而启动失败，随后凭据释放错误遮蔽原始错误。已备份并规范化该页日期、保持正文不变，恢复与原收据一致的 SDK；主服务、协调器和监控已运行，飞书连接就绪。原 owner、97 项身份/期限/预算字段、6 项授权及 54 个原会话文件保留。
- 提案审批卡的 Card 2.0 按钮结构、Cordis 代理导致的重复工具/技能注册、停服时的 readiness 拒绝处理已随 `0.1.58` 发布。线上五条失败审批均已过期，不能据此补发或批准；新版本部署后须用新提案验收实际投递和点击回调。
- Linux 普通升级在切换前被 workspace 元数据校验拦截：pnpm 11.7 会给刚发布的包追加精确版本的 `minimumReleaseAgeExclude`。兼容性修复仅接受已验证、属于当前 profile 闭包的候选精确版本，保留原规则并拒绝其他配置变化；完整检查及下一补丁版本发布待完成。

## 当前版本与下一步

- **`0.1.58` 已公开发布，配套私有 Host `0.2.1-rc.2`。** 精确源码 `5349850a9f9153ea9738ebeb8002e755af64a536`；37/37 个包在 Mac/Linux 的独立公开 registry 回读中，精确版本和 `latest` 均为 `0.1.58`，七项安装资产与该源码匹配。[Release](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39561115296) 的 Publish 与 Record 均成功。Mac 生产安装仍为 `0.1.55`，本轮未升级。
- Mac arm64 与 Linux 均使用公开 tag 和 npm 制品在全新私有临时 Home 完成七条命令（各 7/7 退出 0）：Host `0.2.1-rc.2` 版本核对、七个增强 bundle `0.1.58` 与 base 的组合配置、SDK 导入通过。临时安装未注册常驻服务，也未进行 owner 配对或业务授权。
- 下一步完成升级兼容性修复、保留 owner 的生产升级及新审批卡投递/点击验收；再按合同验证真实普通任务的学习与后续复用。

## Linux 保留 owner 升级

- 冻结 owner 的产品入口为 `dsh-rsi update --all --yes`：沿原收据绑定的官方干净源码，成对更新 target/coordinator 与私有 Host，事务内停启受管服务。原 Host 仅支持 `0.2.0-rc.2` / `0.2.1-rc.2` 到 `0.2.1-rc.2`；要求原授权有效、双服务活动、无已采用或未结的源码 activation。旧 CLI 首次须先单独自升级；适用条件与恢复见[维护说明](../scripts/install/maintenance.md#现有-linux-冻结-owner-程序升级)。
- Linux 当前 CLI 为 `0.1.58`，生产 cohort 仍为 `0.1.57` / `c77fa41941274d8bf104c403919f214f537e2a8b`，Host 为 `0.2.1-rc.2`。本次普通升级退出 1、停在切换前；Home inode 与双 DSH 服务的 PID、InvocationID、NRestarts 未变，监控已恢复活动，失败事务归档保留。
- 失败后保留复核三项均 PASS：97 项身份/期限/预算字段、6 项规范化 grants、54 个原会话文件、14 项非程序配置行以及旧提案/投递状态均保留，未重绑 owner。模型配置与凭据引用按审计范围保留，不据此声称外部凭据已实际调用。原始记录在忽略目录 `docs/evidence/linux-upgrade-20261021-v0158/` 与 `docs/evidence/release-v0158-public/`。

## 精确源码验证

- `0.1.58` 同源码 [dev CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39556678252) 与 [main CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39561108319) 均 5/5 成功。正式 Release 再跑完整 `pnpm check`：38 组测试、8889 通过 / 99 跳过、37 包 dry-run pack；跳过项不算实机通过。新增升级兼容性修复尚待精确源码的完整检查。

## 能力边界

普通使用驱动持续自迭代的目标是：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。**完整普通使用闭环尚未验收。** 工程测试、安装、服务就绪和升级保留不证明后续任务的质量、成本、延迟或回归收益。

- Mac arm64 生产 `0.1.55` 曾经完整备份后重装、重新配对 owner 并使 supervised 常驻就绪；这不是保留原 owner 的原地升级。冻结 owner/source/cohort Home 的普通原地升级与跨版本私有 Host 更新仍不支持；Intel Mac 实机未验收。
- Mac 原生新工具创建与采用使用 `macos-seatbelt`，无需 Docker；沙箱禁止联网和子进程、工作目录只读，次数与累计时长有限。候选及行为观察共享沙箱进程，缺少内存、CPU、磁盘硬配额，不等同于 Linux 双进程隔离；任意 shell 的 `isolation_run` 仍需 Docker。
