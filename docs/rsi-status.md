# RSI 当前状态

更新：2026-10-23。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实施与证据查 Git。

## 当前边界

- 公开发布 `0.1.62`；本机冻结 owner 安装已受管升级至源码提交 `adb73935`（增强包版本仍为 `0.1.62`），目标和协调器使用私有 Host `0.2.1-rc.2`。
- dev 已有安装器修复：add 前按已审查决策收敛 koffi/protobufjs build policy，并清理未注册 bundle 的半装依赖；覆盖首装及 macOS npm 升级。尚未发布。
- 本轮修复：记忆提取与独立记忆/源码/创建/修订审查兼容 Host 必需的工作目录快照，只接受与冻结 owner workspace 精确匹配的来源、唯一 section 和正文；保留模型、零工具、输入/输出限额与未知操作不重放边界。

## 活跃交付与下次验收

- 本机近期 3 次记忆提取在模型调用前被旧两消息校验误拒绝；修复已通过工程验证、独立评审并在本机启用，下一次验收是新鲜普通任务触发后的实际提取与审查。
- 另有 2 次前台任务在服务重启后成为 `dispatch-ambiguous`；Session lease 已释放，历史结果仍不确定，不自动重跑或改为成功。
- 下一次公开发布仍待授权；本轮本地修复不等于 npm 发布。新鲜普通任务的学习与后续收益仍需观察。

## 最新验证

- pinned 真实 WorkingDirectory + AgentLoop 复现旧提取/审查失败；修后 Memory Learning 49、Verifier 185、共享合同 82 例通过，包含额外 required context 在模型派发前被拒绝；独立只读评审 PASS。
- 根 `pnpm check` 的 validate / lint / build / typecheck / test:root 通过（1170 通过、5 跳过）；首次高并发递归包测试出现超时及调度失败，以 `VITEST_MAX_WORKERS=2`、workspace concurrency 2 全量重跑 37 包 exit 0（7809 通过、96 跳过），随后 `pnpm pack:check` exit 0，新共享实现与声明文件已包含。
- 本地受管升级 exit 0，自带安装与就绪检查完成；两服务于 14:11 UTC 启动，均 active/running、NRestarts=0，事务已关闭，临时停止的 Kaboo 采样服务已恢复。收据绑定 `adb73935`；收尾阶段未启动额外部署后校验脚本或真实模型任务。日志、回滚留证及结果保留在忽略目录 `docs/evidence/native-context-20261023/`。

普通使用驱动持续自迭代的完整闭环尚未验收。工程测试、安装、服务就绪和升级保留不证明后续任务的质量、成本、延迟或回归收益。
