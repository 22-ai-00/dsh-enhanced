# 接手续办、CI 与资料整理

更新：2026-11-10。能力 A（普通续办 + Isolation 测试前提）与 CI 均衡已交付 `dev` 并通过精确提交的 CI，本目录保留交接说明、环境前提与历史恢复件。下一位 Agent 从这里开始，不需要上一会话、旧代理、执行句柄或被忽略的本地文件。

## 先完成什么

优先完成**普通任务从委托、执行到独立验收、报告和后续学习的完整路径**。先收束已有续办补丁和唯一已知测试阻断，再交付 CI 分片优化，随后推进首次自然语言委托；不要重写已有底层框架。

| 顺序 | 工作 | 可交付结果 | 操作说明 |
| --- | --- | --- | --- |
| 1 | ~~恢复并验收普通续办补丁，修复 Isolation 续租测试前提~~ | 已交付 `f1bb28a4`，CI 六 job 全绿 | [功能计划 A](remaining-work.md#A) |
| 2 | ~~恢复 CI 补丁，测量新分片和整条流水线~~ | 已交付 `135ee06f`，慢片 979s→674s、两片比 1.03 | [CI 交付与测量](ci-and-docs.md) |
| 3 | 首次普通委托与受保护的任务准则 | 从真实 owner 请求到可核实结果，不要求每任务手配 profile | [功能计划 B](remaining-work.md#B) |
| 4 | 首装、学习、工程成长及普通使用收益 | 按能力逐个交付，保留授权、预算、独立验收和回退 | [后续 C–F](remaining-work.md#C) |

开发只在 `dev`，发布验证后才合入 `main`。每项完成检查与独立复核后单独提交并推送，再开始下一主能力。能力 A 与 CI 均衡的恢复补丁在合入后已删除，实现与验证历史见 Git。

## 带走了什么

交接包起点为 `8e608d4ab6ef0bd4bc015292fd15002801690589`；此后 `dev` 已包含能力 A（`f1bb28a4`）与 CI 均衡（`135ee06f`），两份恢复补丁随合入删除。

| 文件 | 范围与用法 |
| --- | --- |
| ~~ordinary-acceptance.patch~~ | 39 个路径，已合入 `f1bb28a4` 后删除 |
| ~~ci-balance.patch~~ | 8 个路径，已合入 `135ee06f` 后删除 |
| [linux-original-recovery.patch](patches/linux-original-recovery.patch) | 原 Linux 12 个源文件的历史恢复件；仅适用于 `d2a1e0da682484c88dd41a656b42e2a1174b4375`，**不要应用到新 dev** |
| [patches.tsv](patches.tsv) | 现存恢复件的 SHA-256、字节数、权限和路径 |
| [linux-original-files.tsv](linux-original-files.tsv) | 历史 Linux 恢复件的 12 个目标文件 |
| [验证与归属记录](verification.md) | 真实通过/失败边界、历史 Linux 改动的处理与剩余清理条件 |

原 40 文件现场中的 `docs/rsi-status.md` 已收敛到当前状态页及本交接，不重新应用过期进度文字。原 CI 12 文件中的四份资料清理已并入交接，八份代码已合入 `dev`。原始日志、JSON、源码 tar 和全部 refs 不上传到本目录。

## 新电脑启动

```sh
umask 022
git clone --branch dev https://github.com/22-ai-00/dsh-enhanced.git
cd dsh-enhanced
git status --short --branch
git fetch origin dev main
git log -1 --oneline
python3 docs/handover/verify-files.py docs/handover/patches.tsv
```

先读本文件、[当前状态](../rsi-status.md)与[剩余方案](remaining-work.md)。检查工作区无别人的改动、HEAD 与 `origin/dev` 一致，记录 `origin/main`。**不要重新应用已删除的 ordinary/CI 补丁**：它们已在 `f1bb28a4` / `135ee06f` 合入，历史从 Git 查。

`verify-files.py` 使用 Python 3.9+，只读文件，不修改仓库或执行 patch。清单包含精确文件权限；clone 或恢复历史件时用 `umask 022`。补丁原字节应保留；不要清理 unified diff 的上下文前缀空格。若哈希不符，检查最新 dev 的真实差量，不能强行覆盖或继续引用旧快照的测试结论。

本轮已实测：基线临时副本应用普通补丁匹配 39 项；继续应用 CI 补丁匹配 8 项，普通能力新增的 schema 15–18 接受、19 拒绝断言仍在。后续修复 Isolation 或修改其他路径会产生新源码快照，必须重新记录和验证。

## Linux 开发验证约定

可在 Mac 开发，Linux 验证；两边必须使用同一 Git 提交或逐路径核对的源码快照。用户已授权本项目源码、测试和文档同步到指定 Linux 主机的 `/data00` 独立目录，授权不包含凭据、用户配置或运行数据。主机连接信息保留在用户环境，不写入公共仓库。

运行目录、依赖缓存、证据全部位于 `/data00`；先检查磁盘、权限、原有进程，再使用短绝对 `TMPDIR`，历史长 socket 路径已失败。不要覆盖仍有活动会话的原 Linux 工作树。交接的新副本从 GitHub dev 创建，不复制旧 `.git`、Home 或 node_modules。

下面在 Linux **Bash** 中执行；先设置实际路径，不能照抄占位符：

```sh
set -euo pipefail
: "${TASK_ROOT:?请先设置实际的 /data00 交接根目录，其 src 子目录为 checkout}"
: "${TMPDIR:?请先设置实际的短绝对 /data00 临时目录}"
export TASK_ROOT TMPDIR
test -d "$TASK_ROOT/src" && test -d "$TMPDIR"
findmnt -T "$TMPDIR"
df -h "$TASK_ROOT" "$TMPDIR"
test "$(realpath "$TMPDIR")" = "$TMPDIR"
test "$(stat -c '%d' "$TMPDIR")" = "$(stat -c '%d' "$TASK_ROOT")"
test "$(stat -c '%u' "$TMPDIR")" = "$(id -u)"
test "$(stat -c '%a' "$TMPDIR")" = 700
ps -u "$(id -u)" -o pid,etime,args | rg '(pnpm|vitest)' || true
cd "$TASK_ROOT/src"
test "$(node -v)" = v24.7.0
test "$(pnpm -v)" = 11.7.0
test "$(/usr/bin/node -v)" = v22.23.2
export XDG_CACHE_HOME="$TASK_ROOT/cache" XDG_DATA_HOME="$TASK_ROOT/data"
export XDG_STATE_HOME="$TASK_ROOT/state" COREPACK_HOME="$TASK_ROOT/cache/corepack"
export npm_config_cache="$TASK_ROOT/cache/npm" PNPM_HOME="$TASK_ROOT/pnpm-home"
export DSH_HOME="$TASK_ROOT/dsh-home" CI=true VITEST_MAX_WORKERS=4
unset NO_COLOR FORCE_COLOR DSH_TEST_CONCURRENCY
umask 077
mkdir -p "$TASK_ROOT/evidence" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"
pnpm install --frozen-lockfile --store-dir "$TASK_ROOT/store"
pnpm run build
```

这些版本是本轮实测基线；未来升级要与兼容说明、锁文件和 CI 一起处理。namespace 的 Node 与工作区 Node 不同，不能只验证一个。若工具链不符，使用既有用户级安装或明确配置，不静默替换系统 Node。安装器 fixture 若需要 `DSH_TEST_PNPM_ROOT`，从当前 pnpm 安装解析并验证，不能引用另一台机器的路径。pnpm package 默认并发 6；GitHub runner 当前为 4 包、每包 2 worker，两者的耗时不能直接等同。

### 完整门的原生 pnpm 前提（`DSH_TEST_PNPM_ROOT`）

`tests/installers.spec.ts`、`tests/release-adapter.spec.ts` 这类安装器/发布 fixture 需要一个**本机原生** `@pnpm/exe` 工具链；缺少时 `tests/release-adapter.spec.ts` 会在 2–9ms 内以
`release fixture requires a local native @pnpm/exe <version> toolchain; set DSH_TEST_PNPM_ROOT to its package root` 失败，看起来像代码回归，实际是环境前提缺失。它不接受下载兜底，也不能引用另一台机器的路径。

从当前正在使用的 pnpm 安装解析、复制并验证后再导出（fixture 会把工具链收紧成 owner-private，复制可避免改动共享安装）：

```sh
: "${TASK_ROOT:?}"
# PNPM_HOME_ACTUAL = 当前 pnpm 的 home（含 .tools/@pnpm+exe）
native_pnpm_root=$(find "$PNPM_HOME_ACTUAL/.tools/@pnpm+exe" -maxdepth 4 -path '*/node_modules/@pnpm/exe' -type d | sort | tail -1)
test -n "$native_pnpm_root" && test "$("$native_pnpm_root/pnpm" --version)" = "$(pnpm -v)"
file -b "$native_pnpm_root/pnpm" | grep -q ELF
toolchain="$TASK_ROOT/toolchain/@pnpm-exe-$(pnpm -v)"
mkdir -p "$TASK_ROOT/toolchain" && cp -a "$native_pnpm_root" "$toolchain"
chmod -R go-w "$toolchain" && find "$toolchain" -type d -exec chmod 700 {} + && chmod 700 "$toolchain/pnpm"
export DSH_TEST_PNPM_ROOT="$toolchain"
```

记录解析来源、版本、ELF 类型与最终路径。pnpm 的 `_tmp_<pid>_0` 目录会被回收，因此指向稳定副本而不是该原目录。缺少该变量只影响安装器/发布 fixture，不影响其他包测试；但标准 `pnpm check` 会因此 EXIT 1，不能算通过。

### 完整门的已验证 pnpm store 前提（`pnpm_config_store_dir`）

Host/lifecycle 类根测试（`tests/host-lifecycle.test.ts`、`tests/host-rsi-update.test.ts`、`tests/rsi-scanner-owner-source.spec.ts`、`tests/lifecycle-scanner-namespace.spec.ts`）会调用 `scripts/install/lifecycle-profile.mjs` 的 `resolvedPnpmStorePath()`：它执行 `pnpm store path`，要求返回**已存在、当前用户拥有、非 group/other 可写、且不在 DSH_HOME 内**的 store 目录，随后在同一 store 上复核 `store-dir` 精确绑定。

只把依赖装到自定义 `--store-dir` 而不让 `pnpm store path` 解析到它时，这些用例会以
`dsh-enhanced lifecycle: npm cohort pnpm store 不存在或不可解析；尚未创建事务或修改 DSH_HOME。`（后接 `bash failed with exit 1`）失败，看起来像实现缺陷。

用环境变量把解析结果钉到本 TASK_ROOT 已填充的 store；`pnpm_config_store_dir` 会被 pnpm 识别（`npm_config_store_dir` 不会改变 `pnpm store path` 的输出）：

```sh
export pnpm_config_store_dir="$TASK_ROOT/store"
unset npm_config_store_dir
# 期望输出 $TASK_ROOT/store/v11，且目录已存在
test -d "$(pnpm store path)"
```

安装时就用同一条：`pnpm install --frozen-lockfile --store-dir "$pnpm_config_store_dir"`。缺它时标准 `pnpm check` 会 EXIT 1。

### 根测试的 Unix socket 路径上限（`TMPDIR` 必须短）

`plugins/lark-channel` 的 RSI 夹具把 runtime observer 的 socket 放在
`<TMPDIR>/rsi-bootstrap-XXXXXX/home/rsi-authorities/<profile>/state/observer.sock`，而 `validateRuntimeObserverConfig()` 要求 `Buffer.byteLength(socketPath) <= 100`。

把 `TMPDIR` 设成 `$TASK_ROOT/tmp`（实测 51 字符）时该 socket 为 120 字符，四个根测试文件
（`tests/host-lifecycle.test.ts`、`tests/host-rsi-update.test.ts`、`tests/rsi-scanner-owner-source.spec.ts`、`tests/lifecycle-scanner-namespace.spec.ts`）会以
`runtime observer: invalid configuration, authentication or runtime observation` 失败，看起来像实现缺陷。

实测对比（同一源码、同一主机）：

| TMPDIR | 长度 | socket 路径 | 结果 |
| --- | ---: | ---: | --- |
| `$TASK_ROOT/tmp` | 51 | 120 | 上述四文件 21 failed |
| `/data00/tmp/jt` | 14 | 83 | 四文件 57 passed |

因此 `TMPDIR` 必须是与 `TASK_ROOT` 同一文件系统上的**短**绝对路径（建议 ≤16 字符、`0700`、owner 一致），不要放在 `TASK_ROOT` 的深层子目录里；长度不够时先算一遍上面那个 socket 路径。



修复后先做工作包 A 的定向检查，再做一次新的标准完整门。冷构建用新 clone 或只清空已核对的生成 `lib` 目录；不 `git clean -fdx`，不清运行数据：

```sh
started_at=$(date -Is)
set +e
timeout 5400 pnpm check 2>&1 | tee "$TASK_ROOT/evidence/pnpm-check.log"
check_exit=${PIPESTATUS[0]}
set -e
printf 'started=%s finished=%s exit=%s\n' "$started_at" "$(date -Is)" "$check_exit" \
  | tee "$TASK_ROOT/evidence/pnpm-check-exit.txt"
test "$check_exit" = 0
```

记录完整命令、环境、精确源码、退出码、通过/跳过数量与打包结果。验证前后逐文件 hash/bytes/mode 一致；包含新增未跟踪源码，排除生成物和运行数据。失败必须保留首错；诊断 `--no-bail` 用于收齐失败，不能替代标准 `pnpm check`。独立只读复核者给出 PASS/FAIL 后，显式暂存能力相关路径、正常执行 hooks、推送 dev，等待该精确 SHA 的 CI。不要重用旧句柄，也不要把曾经通过的别的快照当作本次通过。

## 下一位 Agent 的一句话

> 请在 GitHub 22-ai-00/dsh-enhanced 的最新 dev 上先读 AGENTS.md、docs/handover/README.md 和 docs/rsi-status.md；能力 A 与 CI 均衡已交付并有精确提交的 CI 证据，接下来推进首次自然语言委托到独立结果验收（工作包 B），再做首装/学习、工程成长与主动性；以 Linux /data00 验证、保持两端源码一致，注意完整门的三条环境前提（原生 @pnpm/exe、已填充 pnpm store、短 TMPDIR），每个能力通过完整检查与独立复核后单独提交推送 dev。
