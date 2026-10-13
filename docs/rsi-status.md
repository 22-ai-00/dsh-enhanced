# RSI 当前状态

更新：2026-10-13。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，历史实施细节查 Git。

## 目标与边界

普通使用驱动持续自迭代：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。初始配置和授权后，主人不必逐次编排改进。

**完整普通使用闭环尚未验收，npm 发布门未满足。**

- 已有认证反馈、持久记忆学习、原生任务调度、源码发现、新工具独立验收、有限采用及动态加载；后续真实任务的质量、成本、延迟与回归收益仍待验收。
- 开发安装默认进入 supervised 学习配置，仍需可信配对、模型、有限预算、Linux systemd 和隔离构建。显式轻量安装与不启动选项保留；远程 npm 发布制品尚未更新。
- 当前锁及 peers 支持官方 npm latest **DSH `0.2.0-rc.2`**，该版本仍是预发布版，不称其为正式稳定版；安装先解析 latest，再固定受支持精确版本，不追踪 next。

## 当前交付与阻塞

修复 CI、迁移旧 Home、启用生产学习并验证远端 CI。事件主动跟进和 npm 新版本等待这一部署及普通使用验收，不并列展开新主任务。

生产 Home 已完成 DSH `0.1.5-rc.3` → `0.2.0-rc.2` 联合迁移，五个 profile 的依赖图已离线物化，签名源码维护链指向 `35360f69`。14 个签名身份、三个暂停且无下次运行时间的旧任务、会话模型与 fallback 保留。旧 settings 异步导入已用精确签名恢复许可完成对账；三节被上游拒绝的 UI / 旧 preset 设置只归档，不宣称生效。

**生产学习仍未通过就绪验收。** owner 首次配置已经 applied；原生安装器在双 Host readiness 失败后按合同保留配置和 journal，不能把两个 active 进程当成学习成功。33 份 owner 配置及五份冻结资源收据未被救援重试改写，原授权期限和预算不续期。

已修复并独立审查的启动问题包括：合法 executor 标识、失败 SQLite sidecar 的精确身份清理、OS Home 别名、原生 YAML 序列化固定点误判、协调器路径继承 `!!js` 标签、运行时观察器对 native Include 子项的错误解析。新预检在停服及 owner 配置前拒绝已不受支持的持久 `permission.defaultPreset: auto`，不自动放宽用户权限。开发源码修复不等于已经部署到冻结生产 cohort。

当前生产安装属于“owner 已 applied、尚未 ready”的冻结双 Host；已有本地源码更新入口仅接通 pre-owner，普通 Host 更新对同版本直接 no-op，不能用于部署上述运行时代码修复。下一验收是显式、受审的失败首启修复迁移：保留旧收据、身份、账本、期限与预算，追加真实签名维护记录，处理旧权限预设，再通过双 Host 原生观察及新鲜注册验证；禁止虚构 activation plan 或绕过 observer。

## 最新验证

- 临时真实 DSH `0.2.0-rc.2` / systemd fixture 退出 0：裸 entry ID 的认证观察、活跃与禁用状态、PID / InvocationID、socket 与临时环境清理均通过；不涉及生产或模型调用。observer 24 项、编译器 3 项、采集器 7 项、setup / installer 58 项定向检查以及相关类型检查、lint 和独立审查通过。
- `umask 022; VITEST_MAX_WORKERS=2 pnpm check` 退出 0：8520 项通过、61 项跳过、37 包 dry-run pack，清单无依赖目录或私有证据。14 个身份、三个暂停任务和 33 份 owner 配置的生产保全复核退出 0；这些检查不代替学习就绪或外部场景验收。
- CI 已移除根检查重复构建，并将 Linux 根测试与包测试 / 打包分为独立作业；原 verify 门要求两者都成功，macOS 与 Windows 门保留。最终远端验收以推送的精确 dev HEAD 的[全部 CI 作业](https://github.com/22-ai-00/dsh-enhanced/actions/workflows/ci.yml?query=branch%3Adev)为准，不以本地结果代替。
- 原 DeepSeek 固定合同于 2026-10-08 过期，未续期；保留 `super-relay/ark/seed-evolving` 会话模型及既有 fallback，静态配置不代表 live 模型调用通过。

原始日志和私有证据位于忽略目录 `docs/evidence/ci-migration/` 与 `docs/evidence/runtime-observer-fix/`。生产启用之后，仍须通过真实普通任务的创建 → 独立验证 → 动态采用 → 后续复用与纠正 / 撤回 / 重启边界，满足[发布门](releasing.md)后才发布 npm。
