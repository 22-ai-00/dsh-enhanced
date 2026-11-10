# CI 均衡：已交付与测量

更新：2026-11-10。安装器拆组与根测试排序器已合入 `dev`（提交 `135ee06f`，CI 六 job 全绿），本页记录测量结果与仍待完成的部分。原先的八路径恢复补丁在合入后删除，历史见 Git。

## 已交付内容

- `tests/installers.spec.ts` 拆出 Linux lifecycle（176 声明 / 240 用例）与 pre-owner local-source（25 声明 / 42 用例），共享 fixture 工厂移到 `tests/helpers/installer-fixtures.ts`；每个 spec 拥有独立临时目录注册表与 `afterEach` 清理。
- `tests/root-test-sequencer.ts`：两个重文件强制落在不同片，其余文件沿用默认 BaseSequencer 分配。
- root job 使用 default + JSON reporter，把最慢 15 个文件写进 step summary，并按 attempt 上传三个有界诊断文件（7 天，`upload-artifact` 固定 `cf430e03`）。
- 未改 worker、超时、fail-fast 与任何断言，未删除或跳过用例。

## 等价性证据

- AST 对照：基线 `installers.spec.ts` 与拆分后三文件 + fixture 工厂比较，358/358 声明一一映射，describe 祖先链、每测试 timeout 多重集与测试体完全一致（唯一差异是上一提交的 schema 断言）；52 个顶层 helper 全保留，仅 2 个函数体因动态 import 路径深度 `../plugins`→`../../plugins` 变化。
- 运行对照：三个拆分 spec 单跑的 (name, status) 多重集与拆分前完全一致（498 = 216 + 240 + 42）。
- 分片集合：CI artifact 的两个 `root-tests.json` 并集 = 全部 102 个文件、交集为空、`installers-linux-lifecycle.spec.ts` 只在片 1、`installers-local-source.spec.ts` 只在片 2。预测脚本对 1/2/3 片给出同样的覆盖与唯一性结论。
- 注意：当前 102 文件布局下，2 片的排序器分配与默认分配逐文件相同，均衡收益来自拆文件后**文件级并行**，不是排序器重排；排序器是文件集变化时的保底。若 `config.root` 与 moduleId 的 realpath 不一致或分组文件被改名/过滤，它会静默退回默认分片——后续可加告警。

## 测量（同一 runner 类别、同日）

| 指标 | 基线 `8e608d4a`（#819，未拆） | 交付 `135ee06f` | 变化 |
| --- | ---: | ---: | --- |
| root 片 1 测试 step | 979 s | 674 s | −31% |
| root 片 2 测试 step | 158 s | 653 s | 两片拉平 |
| 两片最大/最小 | 6.20 | 1.03 | 目标 ≤1.5 达成 |
| root job（较慢一侧） | 1102 s | 876 s | −20% |
| linux-packages job | 1781 s | 1689 s | −5% |
| 包测试 step | 1423 s | 1357 s | −5% |
| 整条 run 墙钟 | 1789 s | 1696 s | −5% |

结论：根测试不再是关键路径。整条 run 现在由 `linux-packages`（约 28 分钟）决定，与历史判断一致；本补丁没有、也不声称改善包测试关键路径。

## 阶段二：按测量优化包测试关键路径（尚未开始）

1. 收集各包开始/结束、最慢文件、worker、实际 pass/skip；raw JSON 放限时 artifact。识别关键路径，不能把并行各包耗时相加当总耗时。
2. 区分单文件过重与包批次不均。单文件按独立资源/fixture 拆；批次按已测时长分配，并保留 filter、依赖构建和失败退出码。
3. 核对 SQLite、cgroup、端口、临时目录、全局资源与 CPU/I/O 争用。保持已有资源上限，只有测量证明余量和隔离后才提高并发。
4. 同条件比较 package test step、package job 与整条 run，报告基线和新结果；缓存命中、runner 或测试集合变化要说明，避免错误归因。

## 已知限制

- CI 的 shallow checkout 缺少 `v0.1.67` tag，使 `installers.spec.ts` 的 pinned-asset 用例多 skip 两个（CI 侧 3 skip、本地全 clone 1 skip），root 汇总相应为 4 skip / 2 skip；这不是删用例。
- 拆开后三个 installer 文件可在同一片并行（此前单文件串行），CPU/子进程/SQLite 争用可能带来超时 flake；已用 CI 参数重复验证，仍需继续观察。
- Summarize 步骤的 `JSON.parse` 若遇到损坏的 `root-tests.json` 会让原本通过的 job 变红；概率极低，后续可加保护。
