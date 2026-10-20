# RSI 当前状态

更新：2026-10-20。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实施与证据查 Git。

## 当前版本与下一步

- **`0.1.57` 已公开发布，配套私有 Host `0.2.1-rc.2`。** 精确源码 `c77fa41941274d8bf104c403919f214f537e2a8b`；37/37 个包在 Mac/Linux 的独立公开 registry 回读中，精确版本和 `latest` 均为 `0.1.57`，七项安装资产与该源码匹配。[Release](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39403516762) 第二次运行的 Publish 与 Record 均成功。Mac 生产安装仍为 `0.1.55`，本轮未升级。
- Mac arm64 与 Linux 均使用公开 tag 和 npm 制品在全新私有临时 Home 完成七条命令（各 7/7 退出 0）：Host `0.2.1-rc.2` 版本核对、七个增强 bundle `0.1.57` 与 base 的组合配置、SDK 导入通过。临时安装未注册常驻服务，也未进行 owner 配对或业务授权。
- 下一步按验收合同继续验证真实普通任务的学习与后续复用；公开新装与服务就绪不证明真实模型任务或长期收益。

## Linux 保留 owner 升级

- 冻结 owner 的产品入口为 `dsh-rsi update --all --yes`：沿原收据绑定的官方干净源码，成对更新 target/coordinator 与私有 Host，事务内停启受管服务。原 Host 仅支持 `0.2.0-rc.2` / `0.2.1-rc.2` 到 `0.2.1-rc.2`；要求原授权有效、双服务活动、无已采用或未结的源码 activation。旧 CLI 首次须先单独自升级；适用条件与恢复见[维护说明](../scripts/install/maintenance.md#现有-linux-冻结-owner-程序升级)。
- Linux 生产 Home 普通升级退出 0，现为 CLI/cohort `0.1.57`、Host `0.2.1-rc.2`、上述精确源码。四项升级前后保留审计及独立复核均为 PASS：owner 未重绑，期限与累计已用额度未重置；97 项受保护的身份/期限/预算字段、6 项规范化 grants、54 个原非锁 Session 的字节及 14 项非程序配置行保留。模型配置与凭据引用按审计范围保留，不据此声称外部凭据已实际调用。
- 公开 CLI 的 80 个文件与 npm tar 包一致，刷新前后 Home 绑定与受检服务进程身份均未变。同一源码再次运行普通升级命令退出 0、提示无需停服；Home inode 和双 DSH 服务的 PID、InvocationID、NRestarts 均未变，监控恢复活动。原始记录在忽略目录 `docs/evidence/linux-upgrade-20261020-v0157/` 与 `docs/evidence/release-v0157-public/`。

## 精确源码验证

- 同源码 [dev CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39397180267) 与 [main CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/39403504417) 均 5/5 成功。正式 Release 再跑完整 `pnpm check`：38 组测试、8881 通过 / 99 跳过、37 包 dry-run pack；跳过项不算实机通过。

## 能力边界

普通使用驱动持续自迭代的目标是：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。**完整普通使用闭环尚未验收。** 工程测试、安装、服务就绪和升级保留不证明后续任务的质量、成本、延迟或回归收益。

- Mac arm64 生产 `0.1.55` 曾经完整备份后重装、重新配对 owner 并使 supervised 常驻就绪；这不是保留原 owner 的原地升级。冻结 owner/source/cohort Home 的普通原地升级与跨版本私有 Host 更新仍不支持；Intel Mac 实机未验收。
- Mac 原生新工具创建与采用使用 `macos-seatbelt`，无需 Docker；沙箱禁止联网和子进程、工作目录只读，次数与累计时长有限。候选及行为观察共享沙箱进程，缺少内存、CPU、磁盘硬配额，不等同于 Linux 双进程隔离；任意 shell 的 `isolation_run` 仍需 Docker。
