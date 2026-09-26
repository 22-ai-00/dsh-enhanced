import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 创建一个注入假系统命令（pgrep/systemctl/launchctl/security/secret-tool/npm/dsh/tar）的 bin 目录。
 * 对齐仓库根 tests/installers.spec.ts 的 fakeBin 思路：shell 脚本记录被调用参数，
 * 行为由临时目录中的标记文件/环境变量控制。
 */
export interface FakeBin {
  root: string
  bin: string
  state: string
  calls: (name: string) => Promise<string[]>
  write: (name: string, body: string) => Promise<void>
  cleanup: () => Promise<void>
}

export async function createFakeBin(): Promise<FakeBin> {
  const root = await mkdtemp(join(tmpdir(), 'rsi-cli-fakebin-'))
  const bin = join(root, 'bin')
  const state = join(root, 'state')
  await mkdir(bin, { recursive: true })
  await mkdir(state, { recursive: true })

  const write = async (name: string, body: string): Promise<void> => {
    const path = join(bin, name)
    await writeFile(path, `#!/usr/bin/env bash\nset -eu\nSTATE_DIR="${state}"\n${body}\n`, { mode: 0o700 })
    await chmod(path, 0o700)
  }

  // 无匹配时退出 1；$FAKE_PGREP_ACTIVE 指向存在文件时打印一个假活动进程 PID（退出 0）。
  await write('pgrep', `
if [ -n "\${FAKE_PGREP_ACTIVE:-}" ] && [ -f "\${FAKE_PGREP_ACTIVE}" ]; then
  printf '%s\\n' "4321"
  exit 0
fi
exit 1
`)
  // 为假活动进程返回完整命令行；其它 PID 退出非零。
  await write('ps', `
if [ "\${1:-}" = "-p" ] && [ "\${2:-}" = "4321" ]; then
  printf '%s\\n' 'node /x/dsh --profile web --no-open'
  exit 0
fi
exit 1
`)
  // 记录全部调用并成功返回。
  for (const name of ['systemctl', 'launchctl', 'secret-tool', 'security', 'npm']) {
    await write(name, `
printf '%s\\n' "\${FAKE_CALL_SIGNATURE:-$*}" >> "$STATE_DIR/${name}.log"
case "$1" in
  bootout)
    # 未注册 label 时模拟 No such process；标记文件存在才成功。
    if [ -f "$STATE_DIR/launchctl-bootout-fail" ]; then exit 3; fi
    exit 0 ;;
  uninstall) exit 0 ;;
  prefix) printf '%s\\n' "${join(root, 'global')}" ;;
  *) exit 0 ;;
esac
`)
  }
  // 假 dsh --version。
  await write('dsh', `
if [ "$*" = "--version" ]; then printf '%s\\n' '0.1.5'; else exit 0; fi
`)

  const calls = async (name: string): Promise<string[]> => {
    const text = await readFile(join(state, `${name}.log`), 'utf8').catch(() => '')
    return text.split('\n').filter(line => line.length > 0)
  }
  const cleanup = async (): Promise<void> => { await rm(root, { recursive: true, force: true }) }
  return { root, bin, state, calls, write, cleanup }
}

export function withFakePath(fakeBin: FakeBin): string {
  return `${fakeBin.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`
}
