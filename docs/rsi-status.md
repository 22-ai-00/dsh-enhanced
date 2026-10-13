# RSI 当前状态

更新：2026-10-13。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，历史实施细节查 Git。

## 目标

普通使用驱动持续自迭代：认证任务与反馈 → 持久学习 → 能力候选 → 独立验证 → 有限采用 → 后续任务 → 观察与回滚。初始配置和授权后，主人不必逐次编排改进。

**完整普通使用闭环尚未验收，npm 发布门未满足。**

## 能力边界

- 已有原生任务调度、认证反馈及持久记忆学习；后续真实任务的质量、成本、延迟与回归收益仍待验收。
- 已有源码发现、失败任务复盘、新工具独立验收、有限签名采用和动态加载。有限修订候选有独立父行为回归门，但不包含父版本 / slot 替换授权；unknown 不自动重放。
- 开发安装默认进入 supervised 学习配置，仍需可信配对、模型、有限预算、Linux systemd 和隔离构建前提。显式轻量安装与不启动选项保留；远程发布制品尚未更新。
- 开发锁及 peers 已适配官方 npm latest **DSH `0.2.0-rc.2`**；上游尚无正式稳定版。安装先解析 latest，再固定受支持的精确版本，不追踪 next。

## 当前交付

修复 CI，完成旧 Home 的联合 Host / 源码迁移，再启用生产学习并验证远端 CI。事件主动跟进和 npm 新版本等待这一部署及普通使用验收，不并列展开新主任务。

生产 canonical Home 为 `/data00/home/jiataorui/.dsh`，活动目标为 `assistant`，仍运行 DSH `0.1.5-rc.3` 与冻结源码 `6a8dce4`。14 个签名身份保持不变；预备协调器没有 service，owner 配置 / registry 尚为空，学习 scheduler 仍关闭。三个旧 Heartbeat / Recovery 定义均暂停、下一运行时间为空；用户已同意现有自动化确认。未确认有独立运行的用量监控服务。

联合迁移实现尚未交付：显式认证未绑定 Home 的旧私有 Host，整个 Home 的 assistant、预备协调器、ACP、Web、headless 一起迁移；候选在 Home 外准备，停服后重新复制并离线物化，沿用 v4 收容 / 恢复。保留生产 fail-closed 断言、原身份和授权，不通过删除部分安装或伪造绑定绕过预检。真实隔离副本及只读 mount namespace 换位校验均通过；尚未停服、切换生产或启用学习。

## 最新验证与阻塞

- CI 修复 `db54e533` 已推送 dev：原 macOS evaluation 失败已消失，但远端运行 [38323695472](https://github.com/22-ai-00/dsh-enhanced/actions/runs/38323695472) 又暴露目录 setgid 夹具及三个 Git 修订测试超时；修复提交 `2d20a4d1` 尚未推送。Windows 已通过；Linux 全部测试通过后触及 35 分钟上限。新配置移除根检查的重复构建，将 Linux 根测试与包测试 / 37 包 prepack / dry-run pack 分为两个独立作业，原 `verify` 必须等两者成功；未减少验收门，新配置尚待最终完整检查及远端验证。
- 最终集成代码 `VITEST_MAX_WORKERS=2 pnpm check` 退出 0：8461 项通过、61 项跳过、37 包 dry-run pack；独立只读审查通过。跳过的外部场景不代表 live 行为已验证。
- 联合迁移定向测试与独立静态审查覆盖预备协调器、认证制品 / peer 闭包、hoisted → isolated、旧 fallback cache 退役及改名后恢复拒绝篡改。真实五 profile 副本完成锁解析、预取、离线物化、dump-config、源码签名和运行时复核；只读 namespace 模拟换位后的源码 / profile 校验通过。修正 Node 解析缓存及 FD 锚定路径的 canonical 适配，保留底层锁 / inode 防护。生产迁移及远端 CI 尚待执行。
- 原 DeepSeek 固定合同已于 2026-10-08 过期；不延长合同或旧授权。保留 `super-relay/ark/seed-evolving` 会话模型及既有 fallback，静态配置不代表 live 模型调用通过。

证据存放于忽略目录 `docs/evidence/ci-migration/`。生产启用后，仍需新的真实普通任务证明创建 → 独立验证 → 动态采用 → 后续复用及纠正 / 撤回 / 重启边界，满足[发布门](releasing.md)后才发布 npm。
