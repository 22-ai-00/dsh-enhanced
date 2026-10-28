# RSI 当前状态

更新：2026-10-28。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实施与证据查 Git。

## 当前交付

- 去除 Linux 安装与自迭代的 Docker 依赖，保留普通隔离执行、完整源码修复、工具创建/修订、独立验收、发布采用与回退；不能关闭功能或用 macOS 受限创建路径代替。实现边界见[原生运行时](dockerless-runtime.md)。
- Linux x64 原生底座、持久执行及私有 Verifier、显式配置的 `isolation_run`、operator 恢复/探针和原生结果保留已提交。本轮增加仓库归档与二进制产物的持久执行接口；下一能力是完整源码构建与持久 source job，随后接通行为验收、发布和保权安装迁移。生产仍使用 Docker，cgroup v2 准入明确拒绝，arm64 尚未实测。

## 已有能力与生产边界

- 公开版本 `0.1.65`（发布源码 `e9513c92`）；本机 CLI/owner 仍为 `0.1.64`，Host `0.2.1-rc.2`。远端恢复用户备份并安装 `0.1.65`，目标与协调器已在原授权内就绪，未新增插件创建授权。
- Wiki 合法内容在下次授权读取时刷新，无需重启。前台等待、取消和进度收尾有界，Delivery 持久保存新任务卡片和终态；重连后校验 owner/凭据再有限重试。旧气泡无持久句柄时不能回填，未知副作用不自动重跑。
- 同码维护重启保存任务与 Session，由 Home 外监督器执行；仅续办能证明无未知副作用的只读任务，保留原模型和剩余预算，每任务最多一次。程序升级保留持久 pnpm store 与切换事务；既有活动 profile 无遗留升级事务。
- 原生普通任务有 worker/keeper 分组硬限额、持久 intent、私有收据和资源消失证明。临时清理故障可同 Host 重试；释放容量不改变 unknown 正文、不退还预算、不重派命令。正结果保留策略先提交账本摘要，再删除私有证据的正文副本；默认保留正文。

## 下次验收与限制

- 完整源码路径必须保留精确 Git tree、全新冻结离线安装、根 `pnpm check`、打包及前后输入/产物复核；完整 source job、独立行为证书、发布采用/物理回退和安装默认值尚未完成原生接线。
- 迁移必须保留主人、会话、凭据、授权范围/期限、已用额度、未知记录与回退点。远端工作区使用 `/home` 符号链接别名，新插件创建仍需受管工作区迁移；不能重建 owner 或靠 `/new` 绕过。后续远端部署还需恢复 SSH 认证。
- provider 迁移保留三个 API provider；三条自定义路线调用成功，官方 DeepSeek 返回 401。远端默认使用已验证的自定义模型，旧私聊保留 TraeX 选择；尚未收到升级后的真实复杂任务结果，也未验收主动维护重启后的原会话续办与最终回复。
- 任意硬崩溃续办与独立飞书连接尚未交付，维护切换仍中断连接。监督器与 Host 同 UID，不隔离恶意 Host 插件。完整 Hermes 历史库和 75 项技能迁移未完成；普通使用驱动长期学习收益的完整闭环仍待实证。
- 公开 core 安装仍有既存 `llm-route-capabilities` 的 Host peer 提示；Host 提供精确 `dsh-llm` 版本，已验证插件激活与配置加载。

## 最新验证

- 公开工具提交 `85815e36` 的 `VITEST_MAX_WORKERS=4 pnpm_config_workspace_concurrency=4 pnpm check` 退出 0：9208 通过、203 跳过，含零警告 lint、构建、类型检查与 37 包 dry-run pack。该冻结提交不包含本轮仓库二进制接口。
- 本轮仓库接口最终整包实测：`DSH_NATIVE_CGROUP_REAL=1 VITEST_MAX_WORKERS=4 pnpm --filter @dsh-enhanced/assistant-isolation test --testTimeout=15000` 退出 0，372 通过、52 跳过；构建、隔离及 3 个消费者包类型检查、零警告 lint 和 dry-run pack 全过，86 个文件摘要前后一致。namespace 与持久层经过独立审查。此前失败日志保留：退出观测及授权期限测试竞态已修正，一次 lost-resource-ack 清理未确认尚未复现、根因未确定；不宣称这次失败已修复。完整根检查和完整源码 prepare 尚未验收。
- 原生证据位于忽略目录 `docs/evidence/dockerless-20261028/`、`dockerless-execution-20261028/`、`dockerless-public-20261028/` 与 `dockerless-repository-20261028/`。真实 cgroup v1、namespace、固定工具链及保留 store/cache 的无网络冻结安装均有证据；pnpm 小型 fixture、Docker 路由 fixture 与真实全仓源码构建不混同。
- 已发布 `0.1.65` 的跨平台 [CI](https://github.com/22-ai-00/dsh-enhanced/actions/runs/40508948330)、[Release](https://github.com/22-ai-00/dsh-enhanced/actions/runs/40508965179)、37 包 npm 元数据与公开安装资产核对通过。全新 hoisted profile 的 core 激活及 Node 22/24 授权准备通过，远端两个 Host 就绪且原 Inbox/Outbox、owner 和会话文件保留；安装就绪不证明真实任务完成或长期收益。
