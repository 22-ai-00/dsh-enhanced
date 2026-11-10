# CI 均衡与资料整理操作方案

先读[交接入口](README.md)并完成普通任务与共用 Isolation 阻断。CI 代码已保存为八路径 patch，未启用、未完整验收；四份资料清理在本次交接中直接完成。后续开发仍在 dev，每项独立提交，不混入发布版本变化。

## 已有证据与优化目标

历史 GitHub Jobs API 的 root 测试 step 墙钟（不含安装和构建）：

| Run | root 1 | root 2 |
| --- | ---: | ---: |
| #819 | 16:19 | 2:38 |
| #760 | 25:17 | 2:42 |
| #755 | 17:49 | 3:09 |
| #747 | 25:18 | 2:43 |
| #746 | 25:29 | 2:44 |

[#755 直接日志](https://github.com/22-ai-00/dsh-enhanced/actions/runs/42454090273/job/128649358540) 中 `installers.spec.ts` 用时 1065.825s，占该片测试 step 约 99.7%。#760/#819 的成功输出被重定向，不从缺少明细的 job log 推导文件耗时。

锁定的 [Vitest 4.1.8 BaseSequencer](https://github.com/vitest-dev/vitest/blob/v4.1.8/packages/vitest/src/node/sequencers/BaseSequencer.ts) 按相对路径 SHA1 排序和文件数量分片，历史耗时只影响片内排序。大文件无法自行跨片，所以持续失衡。补丁先拆文件，再固定两个重组分处不同片。

但 [#819](https://github.com/22-ai-00/dsh-enhanced/actions/runs/42762151021) 的 linux-packages job 为 29:41，包测试 step 为 23:43，已成为另一条关键路径。分别报告两个根片、包 job、整条 run 的前后时长，不承诺未经测量的百分比收益。

## 阶段一：恢复现有八文件实现

路径：`.github/workflows/ci.yml`、`tests/installers.spec.ts`、`tests/vitest.config.ts`、`tests/helpers/installer-fixtures.ts`、`tests/installers-linux-lifecycle.spec.ts`、`tests/installers-local-source.spec.ts`、`tests/root-test-sequencer.ts`、`tests/root-test-sequencer.spec.ts`。

实现内容：

1. 拆出 Linux lifecycle 与 local-source 两重组，每个 spec 使用独立 fixture factory/临时目录注册表。保留原串行语义，358 个测试声明及测试体、describe、参数表、skip、timeout 原样迁移；三处动态 import 相对路径已经修复。
2. `RootTestSequencer` 让两个重文件处于不同片，其他文件使用默认分片，片内仍继承原排序。五项回归覆盖 1/2/3 片、过滤选择、无遗漏和无重复。
3. root job 使用 default + JSON reporter，输出最慢 15 文件和真实测试数量。raw log/JSON 放 RUNNER_TEMP，上传绑定 run/attempt 的七天 artifact。固定 upload-artifact v7.0.2 commit `cf430e030ddbb5b0abf93d22962f4752f3646cd9`。
4. 不改 worker、timeout、fail-fast，不删用例。没有通过放宽门槛换速度。

普通任务补丁必须先应用并完成交付，再应用 CI。两份 patch 都改 installers；合并后保留 schema 15–18 接受、19 拒绝，不能用 CI 旧文件覆盖普通任务改动。

```sh
python3 docs/handover/verify-files.py docs/handover/patches.tsv
umask 022
git apply --check --whitespace=error docs/handover/patches/ci-balance.patch
git apply --whitespace=error docs/handover/patches/ci-balance.patch
python3 docs/handover/verify-files.py docs/handover/ci-files.tsv
git diff --check
```

`ci-files.tsv` 描述 ordinary→CI 的八目标文件；若期间新 dev 合理修改这些文件，人工整合并生成新清单，不能倒退到旧目标 hash。CI 独立候选 `bfdfef4f` 曾完整检查失败于同一 Isolation 续租断言，根 1615 passed / 4 skipped，不证明 CI 已验收；更不证明 GitHub 提速。

## 检查用例集合与实际分片

Linux 环境按交接入口配置，`TASK_ROOT` 指向自己的独立目录。不要与另一完整测试竞争同一主机资源或终止他人进程。两边使用同一源码、固定工具链和缓存条件。

**vitest 4.1.8 的 `vitest list` 不受 `--shard` 影响**（分片只在 `createPool`/`executeTests` 里调用 sequencer，list 只做 collect），所以不能用 list 证明分片，`list --json` 也不含 skipped 用例。正确做法：

```sh
# 1) 应用前/后的全量集合与文件集（名字并集、文件增删）
pnpm exec vitest list --no-cache --maxWorkers=4 --config ./tests/vitest.config.ts \
  --dir tests --testTimeout=15000 --includeTaskLocation --json="$TASK_ROOT/evidence/after/list.json"
pnpm exec vitest list --no-cache --maxWorkers=4 --config ./tests/vitest.config.ts \
  --dir tests --testTimeout=15000 --filesOnly --json="$TASK_ROOT/evidence/after/files.json"
# 2) 分片归属：按锁定算法的预测 + 真实 --shard 运行 + CI artifact 三证
node scripts/shard-partition.mjs "$(pwd -P)" "$TASK_ROOT/evidence/after/files.json" 2
pnpm exec vitest run --no-cache --config ./tests/vitest.config.ts --dir tests \
  --testTimeout=15000 --shard=1/2 --reporter=json --outputFile.json="$TASK_ROOT/evidence/shard-1.json"
python3 scripts/shard-set.py "$(pwd -P)" "$TASK_ROOT/evidence/shard-1.json" "$TASK_ROOT/evidence/shard-2.json" "$TASK_ROOT/evidence/after/files.json"
```

两个分片并集必须等于全量、交集为空、两重组不在同片；CLI list 未包含的元数据（timeout、修饰链）用锁定 TypeScript AST 对照，不从数量相等推断测试体等价。CI 上以精确 run 的 `root-tests.json` artifact 为权威。

导出的预测/集合脚本在本地 `scripts/`（`shard-partition.mjs`、`shard-set.py`、`ast-compare.mjs`、`compare-list.py`、`compare-run-status.py`），不随仓库提交。

历史纯 CI 候选：基线 99 文件/1614 用例，候选 102 文件/1619 用例，仅新增 sequencer 五项；其中 installers 留存 213 passed/3 skipped，lifecycle 240 passed，local-source 42 passed，合计与原来一致。普通任务补丁增加了根回归，当前联合集合不应照抄这些旧总数，必须现场重采。

## 完整验收与提交

1. 新鲜或准确清空生成 lib 的 Linux 副本运行标准 `timeout 5400 pnpm check`，按入口保留真实退出码。manifest、零 warning lint、构建、类型、根/包测试和每包 dry-run pack 全通过。
2. 独立只读复核者核对源码前后稳定、358 声明迁移、fixture 资源归属、分片无遗漏、安装兼容、实际 pack、跳过项和真实日志，给出 PASS/FAIL。
3. 仅显式暂存上述八路径及本能力必需文档，正常 hooks、能力提交、推送 dev；不推 main、不强推。最新 dev 前进时先整合新改动并验证受影响行为。
4. 等待**精确新 SHA** 对应的六 job：linux-packages、两个 linux-root-tests、macos-verify、windows-acp-smoke、verify。保留 run URL、attempt、SHA、job/step 时长和结果；重跑旧 run 不能验收新代码。
5. 同级 runner/cache 条件下，较慢根片应明显下降，两个根测试 step 最大/最小比建议 ≤1.5。若不达标，用新文件耗时继续拆瓶颈；不靠删用例满足指标。总 run 提速单独测量和报告。

可将 fixture 与普通任务先各自交付，再交 CI；不要把诊断 no-bail、多个定向 PASS 和历史全绿拼成一次新的完整门。CI patch 被吸收后删除其恢复件和清单，保留简短结果与 Git 历史。

## 阶段二：按测量优化包测试关键路径

第一阶段精确 CI 全绿后再开此项，一次只改一个调度层。

1. 收集各包开始/结束、最慢文件、worker、实际 pass/skip；raw JSON 放限时 artifact。识别关键路径，不能把并行各包耗时相加当总耗时。
2. 区分单文件过重与包批次不均。单文件按独立资源/fixture 拆；批次按已测时长分配，并保留 filter、依赖构建和失败退出码。
3. 核对 SQLite、cgroup、端口、临时目录、全局资源与 CPU/I/O 争用，先解释 lease 失败。保持已有资源上限，只有测量证明余量和隔离后才考虑提高并发。
4. 同条件比较 package test step、package job、整条 run，报告基线和新结果。缓存命中、runner 或测试集合变化要说明，避免错误归因。

## 资料整理的归属与保留规则

本次直接整理四份维护资料：`docs/README.md`、`docs/live-durable-source-proposal.md`、`docs/live-repository-e2e.md`、`scripts/e2e/README.md`。删减单次旧运行复盘和重复退役叙述，标明旧 Docker-era repo E2E 尚需迁移，撤下失效命令；保留独有验收合同、输入边界和恢复约定。

已核查基线 dev/main 的 raw log/jsonl/evidence 跟踪项为 0；本次没有进行 Git 历史清洗。交接 patch 是可恢复的未完成源码，验收合入后即删除工作树中的恢复副本，历史交给 Git。

后续每份资料按以下处理：维护指南/架构/兼容/验收合同更新正文与入口；独有历史设计理由保留并标为历史；过期执行流水删除；原始终端输出、JSON 与临时分析留 ignored `docs/evidence/` 或七天 CI artifact。必要 fixture、Golden JSON、SRI、release-manifest 是产品/测试数据，不按扩展名全局删除或忽略。

artifact 只包含明确列举的测试输出，不上传用户 Home、凭据或整份运行目录。不要删除全部 GitHub runs/artifacts，不改写历史；若发现具体敏感数据，单独核实和处理，不能以“资料清理”为由扩大操作。

最终报告：提交与 CI URL、完整门真实结果、两个根片/包 job/总 run 前后耗时、独立复核、实际资料变化、未验收平台与外部场景。没有测到收益就明确写未证明。
