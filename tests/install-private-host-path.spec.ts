import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const common = join(repoRoot, 'scripts', 'install', 'common.sh')
const roots: string[] = []

async function executable(path: string, content: string): Promise<void> {
  await writeFile(path, content)
  await chmod(path, 0o755)
}

async function fixture(initialPnpm: 'missing' | 'wrong') {
  const root = await mkdtemp(join(tmpdir(), 'dsh private host path '))
  roots.push(root)
  const fakeBin = join(root, 'fake bin')
  const globalPrefix = join(root, 'fake npm global')
  const globalBin = join(globalPrefix, 'bin')
  const hostBin = join(root, 'private host', 'node_modules', '.bin')
  const npmLog = join(root, 'npm.log')
  await Promise.all([mkdir(fakeBin, { recursive: true }), mkdir(globalBin, { recursive: true }), mkdir(hostBin, { recursive: true })])
  await executable(join(hostBin, 'dsh'), '#!/bin/bash\nprintf "private-0.1.5-rc.3\\n"\n')
  await executable(join(globalBin, 'dsh'), '#!/bin/bash\nprintf "global-0.1.7\\n"\n')
  if (initialPnpm === 'wrong') {
    await executable(join(fakeBin, 'pnpm'), '#!/bin/bash\nprintf "10.0.0\\n"\n')
  }
  await executable(join(fakeBin, 'npm'), `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == 'prefix' && "\${2:-}" == '--global' ]]; then
  printf '%s\\n' "$FAKE_GLOBAL_PREFIX"
  exit 0
fi
if [[ "\${1:-}" == 'install' && "\${2:-}" == '--global' && "\${3:-}" == 'pnpm@11.7.0' ]]; then
  printf '%s\\n' "$*" >> "$FAKE_NPM_LOG"
  printf '#!/bin/bash\\nif [[ "\${1:-}" == "--version" ]]; then printf "11.7.0\\\\n"; else exit 2; fi\\n' > "$FAKE_GLOBAL_PREFIX/bin/pnpm"
  /bin/chmod 755 "$FAKE_GLOBAL_PREFIX/bin/pnpm"
  exit 0
fi
printf 'unexpected npm command: %s\\n' "$*" >&2
exit 91
`)
  return { fakeBin, globalBin, globalPrefix, hostBin, npmLog }
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function ensurePnpm(f: Awaited<ReturnType<typeof fixture>>, privateHost: boolean, privateInitiallyOnPath: boolean) {
  const path = privateInitiallyOnPath ? `${f.hostBin}:${f.fakeBin}` : f.fakeBin
  return spawnSync('/bin/bash', [
    '-c',
    'set -euo pipefail; source "$1"; dsh_enhanced_ensure_pnpm 0; printf "RESULT_PATH=%s\\n" "$PATH"; printf "RESULT_PNPM=%s\\n" "$(pnpm --version)"; printf "RESULT_DSH=%s\\n" "$(dsh --version)"; printf "RESULT_DSH_PATH=%s\\n" "$(command -v dsh)"',
    'private-host-path-test', common,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: path,
      FAKE_GLOBAL_PREFIX: f.globalPrefix,
      FAKE_NPM_LOG: f.npmLog,
      ...(privateHost ? { DSH_ENHANCED_HOST_BIN: f.hostBin } : {}),
    },
  })
}

describe('installer pnpm bootstrap preserves private DSH command', () => {
  test.each([
    ['missing', true],
    ['wrong', true],
  ] as const)('pnpm %s: npm global bin is added, but bound private Host wins', async (initialPnpm, privateInitiallyOnPath) => {
    const f = await fixture(initialPnpm)
    const result = ensurePnpm(f, true, privateInitiallyOnPath)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('pnpm 目标：11.7.0')
    expect(result.stdout).toContain('RESULT_PNPM=11.7.0')
    expect(result.stdout).toContain('RESULT_DSH=private-0.1.5-rc.3')
    expect(result.stdout).toContain(`RESULT_DSH_PATH=${join(f.hostBin, 'dsh')}`)
    expect(result.stdout).toContain(`RESULT_PATH=${f.hostBin}:${f.globalBin}:`)
    expect(await readFile(f.npmLog, 'utf8')).toBe('install --global pnpm@11.7.0\n')
  })

  test('without private Host binding, the existing global helper discovery remains effective', async () => {
    const f = await fixture('missing')
    const result = ensurePnpm(f, false, false)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('RESULT_PNPM=11.7.0')
    expect(result.stdout).toContain('RESULT_DSH=global-0.1.7')
    expect(result.stdout).toContain(`RESULT_DSH_PATH=${join(f.globalBin, 'dsh')}`)
    expect(result.stdout).toContain(`RESULT_PATH=${f.globalBin}:${f.fakeBin}`)
    expect(await readFile(f.npmLog, 'utf8')).toBe('install --global pnpm@11.7.0\n')
  })

  test('an inherited private Host marker cannot replace an unselected dsh', async () => {
    const f = await fixture('wrong')
    const result = ensurePnpm(f, true, false)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('RESULT_PNPM=11.7.0')
    expect(result.stdout).toContain('RESULT_DSH=global-0.1.7')
    expect(result.stdout).toContain(`RESULT_DSH_PATH=${join(f.globalBin, 'dsh')}`)
    expect(result.stdout).toContain(`RESULT_PATH=${f.globalBin}:${f.fakeBin}`)
    expect(result.stdout).not.toContain(`RESULT_PATH=${f.hostBin}:`)
    expect(await readFile(f.npmLog, 'utf8')).toBe('install --global pnpm@11.7.0\n')
  })
})
