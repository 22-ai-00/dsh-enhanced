# RSI 当前状态

更新：2026-10-22。本页是唯一进展入口；验收见[合同](rsi-acceptance.md)，发行见[发布协议](releasing.md)，历史实施与证据查 Git。

## 当前边界

- 公开发布 `0.1.62`（tag `v0.1.62`，CI 自动 record）：修复原生对话中 owner 审批状态不刷新。
- dev 已实现、待 owner 授权发布的能力（计划 `0.1.63`）：修复 pnpm 11.7.0 下 npm 安装在 `dsh plugin add` 阶段的双链缺陷——
  1. add 前向 profile `pnpm-workspace.yaml` 写入经评审决策表 `koffi: true`、`protobufjs: false`：未决占位收敛为表内决策，owner 显式布尔保留（`koffi: false` 单向警告），冲突值与表外未决占位 fail-fast，不替未评审脚本做决定。
  2. add 前自愈“半装 bundle”：本次目标包已在 `dependencies`、未注册 `dsh.profile.bundles` 且 node_modules 元数据声明 `dsh.bundle` 时，原子移除残留条目，使 Host reconcile 重新注册；避免仅 `pnpm approve-builds` 后重试 exit 0 却零 bundle 装入。畸形 `bundles` 字段 fail-closed 不写盘。
  - 同一裸 add 缺陷覆盖 macOS 已停止 Home 的 npm 升级：完整 profile 备份之后收敛，失败随整 profile 回滚。traex provider 补装的“已装”判据从 node_modules 目录改为注册名单（独立评审拦下：旧判据在半装现场会跳过重试）。Linux bwrap 事务升级全程 `ignore-scripts`，无此缺陷，不接入；本地 cohort 的 `allowBuilds` 由冻结收据合并。
- 触发来源：另一台 Linux（profile web / supervised-growth / Host 0.2.1-rc.2）首装报 `[ERR_PNPM_IGNORED_BUILDS] koffi@3.1.1`。

## 活跃阻塞与下次验收

- `0.1.63` 未发布，等待 owner 明确授权（仅 prepare + push tag，record 由 CI 完成）。
- 发布后首次验收：故障机以相同 `DSH_HOME`、profile、参数重跑安装器，add exit 0 且失败批次 bundle 完整注册；CI 安装/运行就绪/发布验证全绿。
- 故障机立即恢复：用 dev 安装器重跑；或先在报错 profile 执行 `pnpm approve-builds koffi`，再手工删除 `package.json` 中失败批次残留（在 `dependencies`、不在 `dsh.profile.bundles` 的目标包），再用相同参数重装。

## 最新验证

- 真实 pinned Host `0.2.1-rc.2` + pnpm 11.7.0 隔离 HOME 实验：复现未决策 koffi 退出 1 与依赖残留；证实仅 approve-builds 后重试为零 bundle 死安装、删残留后 reconcile 恢复注册；新安装器双函数全链路 exit 0（cnoke 自检一次、三 bundle 注册、`pendingBuilds: []`、健康幂等、dry-run 不写盘）。证据与限制见忽略目录 `docs/evidence/koffi-half-install-2026-10-22.md`。
- `tests/installers.spec.ts` 全文件 469 通过 / 1 跳过（评审修复后最终工作树）；新增 build-policy 决策表 9 例、幂等 1 例、半装自愈 4 例、provider 补装半装重试与畸形 `bundles` 拒绝 2 例、macOS npm 升级收敛与回滚 2 例，launchd fixture 修正为健康注册形态，koffi=false 警告断言收紧为独有文案。
- 独立只读对抗评审通过（MEDIUM 1、LOW 1 均已修复并回归）。
- 根 `pnpm check`（2026-10-22）：validate / lint / build / typecheck / test:root（76 文件 1168 通过、5 跳过）/ pack:check 全过；评审修复后 installers 全文件独占重跑 469/1 全绿（改动仅限安装脚本与该测试文件）。递归包测试中 plugin-control-plane 10 个真子进程文件与 assistant-evaluation 1 个时序用例在高负载下假失败（耗时齐刷刷停在 15s 超时、1261ms>1000ms），独占串行重跑 36/36 与 18/18 全过，与本改动无关。

普通使用驱动持续自迭代的完整闭环尚未验收。工程测试、安装、服务就绪和升级保留不证明后续任务的质量、成本、延迟或回归收益。
