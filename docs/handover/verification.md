# 验证记录与历史归属

更新：2026-11-10。本页记录本轮（能力 A 与 CI 均衡）的验证事实、真实失败与历史 Linux 改动归属。原始日志与 JSON 留在本地 `docs/evidence/`（ignored）或 CI artifact，不入库。

## 源码与结果一一对应

| 能力 | 提交 | CI（精确 SHA） | 结论 |
| --- | --- | --- | --- |
| A 普通续办 + Isolation 前提 | `f1bb28a4` | [run 42820235962](https://github.com/22-ai-00/dsh-enhanced/actions/runs/42820235962) attempt 3 六 job 全绿 | 冷标准 `pnpm check` EXIT 0 / 2521s |
| CI 均衡 | `135ee06f` | [run 42836374150](https://github.com/22-ai-00/dsh-enhanced/actions/runs/42836374150) attempt 1 六 job 全绿 | 冷标准 `pnpm check` EXIT 0 / 2281s |

两者均在 Mac 开发、Linux `/data00` 独立副本验证；验证前后逐文件 hash/bytes/mode 稳定（A：2098 文件；CI：2103 文件），Mac 与 Linux 两端逐条比对 0 差异。

## 能力 A 的定向与完整门

- 定向：isolation `controller-startup.spec.ts` 6/6、work-items 187/187、automations 185/185、delivery `agent-runtime.spec.ts` 295/295、memory-learning 4/4、lark 176/176。
- 冷标准门：根 98 文件 1613 passed / 2 skipped；39 包 11280 passed / 271 skipped；39 个 dry-run pack；lint 0 warning、0 error。
- Isolation 用例修复只改夹具：受控时钟驱动启动截止、重试睡眠与竞争续租；断言 7 次真实续租全为 true、500ms 到期后竞争者仍被拒、owner/fence 不变、释放后才接管、dispose 后 fence+2。真实 SQLite 事务与 500/100/750ms 阈值保留，无 skip、无重试、无加长超时。

## CI 均衡的等价性与测量

- AST：358/358 声明映射，describe 链、timeout 多重集、测试体一致（唯一差异是 A 提交的 schema 断言）；52 个 helper 全保留。
- 运行：(name, status) 多重集拆分前后一致（498 = 216 + 240 + 42）。
- 分片：CI artifact 两片并集 = 102 文件、交集空、lifecycle 只在片 1、local-source 只在片 2。
- 测量：慢片 979s→674s；两片比 6.20→1.03；root job 1102s→876s；linux-packages job 1781s→1689s；整条 run 1789s→1696s。包测试仍是关键路径（约 28 分钟），本补丁不声称改善它。

## 真实失败（已保留并解释，未被掩盖）

1. 首次冷标准门（A）根测试 4 个 `release-adapter` 失败：缺少 `DSH_TEST_PNPM_ROOT`，2–9ms 内报 `release fixture requires a local native @pnpm/exe`。补齐本机原生工具链后 5/5 通过。
2. 第二次冷标准门（A）4 个 Host/lifecycle 文件 21 个失败：`pnpm_config_store_dir` 未指向已填充 store，报 `npm cohort pnpm store 不存在或不可解析`。补齐后 57/57 通过。
3. 第三次冷标准门（A）同 4 文件仍失败：`TMPDIR` 51 字符使 RSI 夹具 socket 路径达 120 字节（上限 100），报 `runtime observer: invalid configuration`。改用 14 字符 `/data00/tmp/jt` 后通过。
4. 包测试一次 load-induced flake：`assistant-goals` 的 event-wait 用例在包并发 6 下失败，单独 362/362 通过两次；最终门改用 CI 同参 `VITEST_MAX_WORKERS=2`、`DSH_TEST_CONCURRENCY=4` 后通过。
5. `f1bb28a4` 的 CI 前两次尝试分别在 `plugin-control-plane`（2 例）与 `assistant-delivery`（1 例）时间敏感用例失败，两处均不在 A 的改动路径且本地重复通过；同 SHA 第 3 次尝试六 job 全绿。保留为已知 CI flake，未通过放宽门槛掩盖。

三条环境前提的解析方法见 [交接入口](README.md)；缺任一项标准 `pnpm check` 会 EXIT 1。

## 原 Linux 未上传内容的归属

| 内容 | 处理和后续责任 |
| --- | --- |
| 原 dev `d2a1e0da682484c88dd41a656b42e2a1174b4375` | 8e6 的严格祖先，相差四次提交；新副本从 GitHub 最新 dev 获取，不把旧 HEAD 当开发基线 |
| 12 个未提交 CP 文件 | 保存在 `patches/linux-original-recovery.patch` 与 `linux-original-files.tsv`；历史参照，勿默认套入新 dev |
| `goal-offline-20261106` 等原引用 | 相对原 cached dev 无独有提交或已 patch 等价；原引用原地保留，未推送 origin |
| 原依赖、lib、缓存与受保护 Home/配置 | 未纳入公共交接，未读取或打包凭据/运行数据 |

12 文件的主要语义已有后续实现（claimed_at/schema 39 迁移、pending/claim/accept/reject、瞬态 requeue、孤儿 reclaim、坏行隔离等），8e6 之后又增加 generation、receipt、取消/到期栅栏。存在刻意不同的旧行为（内部 setInterval drain 被 budgeted native continuation 替代；pending 不再可直接 reject），因此不把旧文件原样覆盖新实现。

## 未验收范围

首次自然语言委托到独立结果验收（工作包 B）、首装/学习、工程成长、主动性，以及真实模型/外部渠道与长期使用收益均未验收。未发布 npm、未升级生产 Home、未发送用户渠道消息。
