# RSI 当前状态

更新：2026-10-13。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，历史实施细节查 Git。

## 目标与边界

普通使用驱动持续自迭代：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。初始配置和授权后，主人不必逐次编排改进。

**完整普通使用闭环尚未验收，npm 发布门未满足。**

- 已有认证反馈、持久记忆学习、原生任务调度、源码发现、新工具独立验收、有限采用及动态加载；后续真实任务的质量、成本、延迟与回归收益仍待验收。
- 开发安装默认进入 supervised 学习配置，仍需可信配对、模型、有限预算、Linux systemd 和隔离构建。显式轻量安装与不启动选项保留；远程 npm 发布制品尚未更新。
- 当前锁及 peers 支持官方 npm latest **DSH `0.2.0-rc.2`**，该版本仍是预发布版，不称其为正式稳定版；安装先解析 latest，再固定受支持精确版本，不追踪 next。

## 当前交付与边界

生产 Home 已完成 DSH `0.1.5-rc.3` → `0.2.0-rc.2` 联合迁移，五个 profile 的依赖图已离线物化。受审源码 `c429e903` 的签名后继事务已提交，追加第二条 repair overlay；原失败事务、最老 Home 和 bootstrap 保留审计，未回退已运行 Home，待恢复意图已清除。[入口与恢复边界](../scripts/install/README.md#已运行但未就绪的修复后继)。

**生产学习已通过新鲜就绪验收，不等于完整自迭代收益已验收。** 双 Host、飞书、HMAC observer、记忆学习和独立账本协调器原生登记均通过；双服务正常运行，无重启。用户选择的 `danger-full-access` 不逐次审批；14 个签名身份、六项原授权及其期限与预算、三个暂停旧任务、会话模型与 fallback 均保留。未因本次修复清理旧聊天。

旧 settings 已按签名恢复许可完成导入对账；上游拒绝的三节 UI / 旧 preset 设置只归档，不宣称生效。Kaboo 按用户授权在迁移期间暂停，成功后已恢复，配置和开机启用状态未改。

本轮收尾为完整仓库检查及精确 dev HEAD 的远端 CI 验证。下一能力验收是普通任务驱动的记忆与工程进化：创建 → 独立验证 → 动态采用 → 后续真实任务复用，覆盖纠正、撤回和重启；事件主动跟进与 npm 发布不并列展开。

## 最新验证

- 正式后继 CLI 退出 0；独立验后检查退出 0，核对双服务 fresh readiness、seq2 签名链、14 个密钥摘要、六项授权、三个暂停任务及模型 / fallback。最大观察到的事务 manifest 为 2,039,610 字节，低于 2 MiB 限额。
- 后继路径与生命周期定向测试 36/36，语法、lint 及独立审查通过；真实 systemd 临时探针验证全 / 半暂存遮罩按原 inode 复装且无服务启动，临时 unit 已清理。协调器真实 Cordis 登记回归通过。
- Home 外完整演练通过；最终候选的 25 个包与演练版逐包字节、锁图及依赖一致。源码和安装器各自重新绑定，正式事务重新执行完整 pre-swap 校验，不以旧演练冒充新源码验收。
- 全检命令为 `VITEST_MAX_WORKERS=2 pnpm check`，包括根测试、全部包测试、构建、类型检查及 37 包 dry-run pack。远端以精确 dev HEAD 的[全部 CI 作业](https://github.com/22-ai-00/dsh-enhanced/actions/workflows/ci.yml?query=branch%3Adev)为准，不把仅汇总 Linux 的 verify 通过称为全绿。CI 拆分 Linux 根测试与包测试、移除重复构建；macOS 的 native ELF 正向测试限定 Linux，跨平台拒绝测试保留。
- 原 DeepSeek 固定合同于 2026-10-08 过期，未续期；保留 `super-relay/ark/seed-evolving` 模型及既有 fallback，未将配置或就绪检查当作 live 模型调用证明。

原始日志和私有证据位于忽略目录 `docs/evidence/ci-migration/`、`docs/evidence/runtime-observer-fix/` 与 `docs/evidence/owner-repair/`。满足普通使用闭环及[发布门](releasing.md)后才发布 npm。
