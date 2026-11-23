# Linux 验证环境与完整门前提

更新：2026-11-15。本页记录在 Linux 独立副本上复跑完整门（`pnpm check`）和真实 namespace/cgroup 用例时的环境前提。Mac 可用于开发，但 Linux 验证必须与待验源码逐路径一致；本页不替代 [RSI 验收合同](rsi-acceptance.md) 与 [发版指南](releasing.md) 的证据要求。

## 验证约定

- 可在 Mac 开发、在 Linux 验证；两端必须使用同一 Git 提交，或逐路径核对过的源码快照。
- 源码、依赖缓存、构建产物与证据都放在 Linux 主机的大容量独立目录（如 `/data00/<user>` 下的副本）；不要写系统 `/tmp`，也不要覆盖仍有活动会话的原工作树。
- 新副本从 GitHub `dev` 创建，不复制旧 `.git`、DSH Home 或 `node_modules`；验证结束不用 `git clean -fdx` 清理运行数据。
- 同步到验证主机的只有源码、测试与文档；不复制凭据、用户配置或运行数据。
- 记录完整命令、环境、精确源码摘要、退出码、通过/跳过数量与 pack 结果；验证前后逐文件 hash/bytes/mode 一致（包含新增未跟踪源码，排除生成物与运行数据）。
- 原始日志、JSON 与逐次运行数据留在本地忽略目录或 CI artifacts，不提交仓库。

## 目录与工具链

```sh
set -euo pipefail
: "${TASK_ROOT:?请先设置 /data00 下的独立工作根目录，其 src 子目录为 checkout}"
: "${TMPDIR:?请先设置同一文件系统上的短绝对临时目录}"
test -d "$TASK_ROOT/src" && test -d "$TMPDIR"
findmnt -T "$TMPDIR"
df -h "$TASK_ROOT" "$TMPDIR"
test "$(realpath "$TMPDIR")" = "$TMPDIR"
test "$(stat -c '%d' "$TMPDIR")" = "$(stat -c '%d' "$TASK_ROOT")"
test "$(stat -c '%u' "$TMPDIR")" = "$(id -u)"
test "$(stat -c '%a' "$TMPDIR")" = 700
ps -u "$(id -u)" -o pid,etime,args | rg '(pnpm|vitest)' || true
cd "$TASK_ROOT/src"
test "$(node -v)" = "v$(cat .node-version)"
test "$(pnpm -v)" = 11.7.0
# 安装器/namespace fixture 还会显式调用系统 Node（CI/Release 锁定为 v22.23.2）；两套 Node 都要核对，不能只验证一个。
test "$(/usr/bin/node --version)" = 'v22.23.2'
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

工具链版本以 `package.json` 的 `engines`、`packageManager`、`.node-version`、`pnpm-workspace.yaml` catalog 与当次锁文件为准；未来升级要与[兼容性基线](compatibility.md)和 CI 一起处理。若工具链不符，使用既有用户级安装或明确配置，不静默替换系统 Node。pnpm 的默认包并发与 GitHub runner 的分配不能直接等同，耗时对比须说明参数。

## 完整门的三条环境前提

缺任一项时标准 `pnpm check` 会 EXIT 1；这些失败看起来像代码回归，实际是环境前提缺失。以下命令在 Linux Bash 中执行，先设置实际路径，不能照抄占位符。

### 1. 原生 `@pnpm/exe` 工具链（`DSH_TEST_PNPM_ROOT`）

`tests/installers.spec.ts`、`tests/release-adapter.spec.ts` 等安装器/发布 fixture 需要本机原生 `@pnpm/exe` 工具链；缺少时 `release-adapter` 会在数毫秒内以 `release fixture requires a local native @pnpm/exe <version> toolchain; set DSH_TEST_PNPM_ROOT to its package root` 失败。它不接受下载兜底，也不能引用另一台机器的路径。

从当前 pnpm 安装解析、复制并收紧权限后再导出（fixture 会把工具链收紧为 owner-private，复制可避免改动共享安装）：

```sh
: "${TASK_ROOT:?}"
: "${PNPM_HOME_ACTUAL:?请设置当前 pnpm 的 home（含 .tools/@pnpm+exe）}"
native_pnpm_root=$(find "$PNPM_HOME_ACTUAL/.tools/@pnpm+exe" -maxdepth 4 -path '*/node_modules/@pnpm/exe' -type d | sort | tail -1)
test -n "$native_pnpm_root" && test "$("$native_pnpm_root/pnpm" --version)" = "$(pnpm -v)"
file -b "$native_pnpm_root/pnpm" | grep -q ELF
toolchain="$TASK_ROOT/toolchain/@pnpm-exe-$(pnpm -v)"
mkdir -p "$TASK_ROOT/toolchain" && cp -a "$native_pnpm_root" "$toolchain"
chmod -R go-w "$toolchain" && find "$toolchain" -type d -exec chmod 700 {} + && chmod 700 "$toolchain/pnpm"
export DSH_TEST_PNPM_ROOT="$toolchain"
```

pnpm 的 `_tmp_<pid>_0` 目录会被回收，因此要指向稳定副本而不是原目录。记录解析来源、版本、ELF 类型与最终路径。

### 2. 已填充的 pnpm store（`pnpm_config_store_dir`）

Host/lifecycle 类根测试（`tests/host-lifecycle.test.ts`、`tests/host-rsi-update.test.ts`、`tests/rsi-scanner-owner-source.spec.ts`、`tests/lifecycle-scanner-namespace.spec.ts`）会调用 `scripts/install/lifecycle-profile.mjs` 的 `resolvedPnpmStorePath()`：它执行 `pnpm store path`，要求返回已存在、当前用户拥有、非 group/other 可写、且不在 `DSH_HOME` 内的 store 目录，随后在同一 store 上复核 `store-dir` 精确绑定。

只把依赖装到自定义 `--store-dir` 而不让 `pnpm store path` 解析到它时，这些用例会以 `dsh-enhanced lifecycle: npm cohort pnpm store 不存在或不可解析；尚未创建事务或修改 DSH_HOME。`（后接 `bash failed with exit 1`）失败，看起来像实现缺陷。用环境变量把解析结果钉到已填充的 store；`pnpm_config_store_dir` 会被 pnpm 识别，`npm_config_store_dir` 不会改变 `pnpm store path` 的输出：

```sh
export pnpm_config_store_dir="$TASK_ROOT/store"
unset npm_config_store_dir
# 期望输出 $TASK_ROOT/store/v11，且目录已存在
test -d "$(pnpm store path)"
```

安装时就用同一条：`pnpm install --frozen-lockfile --store-dir "$pnpm_config_store_dir"`。

### 3. 短绝对 `TMPDIR`

`plugins/lark-channel` 的 RSI 夹具把 runtime observer 的 socket 放在 `<TMPDIR>/rsi-bootstrap-XXXXXX/home/rsi-authorities/<profile>/state/observer.sock`，而 `validateRuntimeObserverConfig()` 要求 `Buffer.byteLength(socketPath) <= 100`。

`TMPDIR` 设成 `$TASK_ROOT/tmp`（实测 51 字符）时该 socket 为 120 字符，四个根测试文件（同上）会以 `runtime observer: invalid configuration, authentication or runtime observation` 失败，看起来像实现缺陷。同一源码、同一主机实测：

| TMPDIR | 长度 | socket 路径 | 结果 |
| --- | ---: | ---: | --- |
| `$TASK_ROOT/tmp` | 51 | 120 | 上述四文件 21 failed |
| `/data00/tmp/jt` | 14 | 83 | 四文件 57 passed |

因此 `TMPDIR` 必须是与 `TASK_ROOT` 同一文件系统上的短绝对路径（建议 ≤16 字符、`0700`、owner 一致），不要放在 `TASK_ROOT` 的深层子目录里；长度不够时先算一遍上述 socket 路径。

## 标准完整门与记录

修复后先做定向检查，再做一次新的标准完整门。冷构建用新 clone 或只清空已核对的生成 `lib` 目录；不 `git clean -fdx`，不清运行数据。

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

失败必须保留首错；诊断用 `--no-bail` 收齐失败，不能替代标准 `pnpm check`。独立只读复核者给出 PASS/FAIL 后才能称本轮通过；不要重用旧执行句柄，也不要把曾经通过的别的快照当作本次通过。定向检查与真实外部行为验收的要求见 [RSI 验收合同](rsi-acceptance.md)；发布门见[发版指南](releasing.md)。
