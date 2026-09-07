import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installer = join(repoRoot, 'scripts', 'install', 'install-local.sh')
const roots: string[] = []

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-enhanced-web-installer-'))
  roots.push(root)
  return root
}

function run(args: readonly string[], dshHome: string) {
  return spawnSync('/bin/bash', [installer, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', DSH_HOME: dshHome },
  })
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source, 'utf8')
  await chmod(path, 0o755)
}

async function actualFixture(setupExit: number | 'missing') {
  const root = await temporaryHome()
  const dshHome = join(root, 'dsh-home')
  const fakeBin = join(root, 'bin')
  const log = join(root, 'order.log')
  const profileBin = join(dshHome, 'profiles', 'web', 'node_modules', '.bin')
  await mkdir(fakeBin, { recursive: true })
  await mkdir(profileBin, { recursive: true })
  await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; fi
exit 0
`)
  await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == '--version' ]]; then printf '0.1.2-rc.1\\n'; exit 0; fi
if [[ " $* " == *' plugin '* ]]; then
  mkdir -p "$DSH_HOME/profiles/web/node_modules/.bin"
  printf 'plugin-add\\n' >> "$INSTALL_LOG"
  exit 0
fi
if [[ " $* " == *' --dump-config '* ]]; then
  printf 'dump\\n' >> "$INSTALL_LOG"
  exit 0
fi
if [[ " $* " == *' --no-open --port 0 '* ]]; then
  printf 'probe\\n' >> "$INSTALL_LOG"
  printf 'dsh web: http://127.0.0.1:43210\\n'
  exit 0
fi
exit 0
`)
  if (setupExit !== 'missing') {
    await writeExecutable(join(profileBin, 'dsh-web-owner-setup'), `#!/bin/bash
printf 'setup\\n' >> "$INSTALL_LOG"
exit ${setupExit}
`)
  }
  const result = spawnSync('/bin/bash', [installer,
    '--scenario', 'web', '--workspace', join(root, 'workspace'), '--dsh-version', '0.1.2-rc.1',
    '--no-service', '--model', 'skip', '--model-route', 'skip',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      DSH_HOME: dshHome,
      INSTALL_LOG: log,
    },
  })
  return { result, log }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('experimental Web owner installer scenario', () => {
  test('dry-run installs the Web owner bundle closure and plans setup before composition probes', async () => {
    const dshHome = await temporaryHome()
    const workspace = join(dshHome, 'workspace')
    const result = run([
      '--dry-run', '--scenario', 'web', '--workspace', workspace, '--agent-preset', 'reviewer', '--yes',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    for (const slug of ['personal-assistant', 'plugin-control-plane', 'assistant-delivery', 'assistant-goals', 'assistant-web-owner']) {
      expect(result.stdout).toContain(join(repoRoot, 'plugins', slug))
    }
    for (const slug of ['lark-channel', 'credentials-keychain', 'preference-learning', 'assistant-heartbeat']) {
      expect(result.stdout).not.toContain(join(repoRoot, 'plugins', slug))
    }
    const setup = `${join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-web-owner-setup')} --dsh-home ${dshHome} --profile web --workspace ${workspace} --preset reviewer`
    expect(result.stdout).toContain(setup)
    expect(result.stdout.indexOf(setup)).toBeLessThan(result.stdout.indexOf('dsh --profile web --dump-config'))
  })

  test('rejects Web-only parameters and fixed-owner conflicts before installation', async () => {
    const dshHome = await temporaryHome()
    const relativeWorkspace = run(['--dry-run', '--scenario', 'web', '--workspace', 'relative'], dshHome)
    expect(relativeWorkspace.status).toBe(2)
    expect(relativeWorkspace.stderr).toContain('--workspace 必须是绝对路径')

    const tools = run(['--dry-run', '--scenario', 'web', '--agent-tools', 'allow'], dshHome)
    expect(tools.status).toBe(2)
    expect(tools.stderr).toContain('--agent-tools 必须为 preserve')

    const otherScenario = run(['--dry-run', '--scenario', 'core', '--agent-preset', 'reviewer'], dshHome)
    expect(otherScenario.status).toBe(2)
    expect(otherScenario.stderr).toContain('仅适用于 --scenario web')

    const invalidPreset = run(['--dry-run', '--scenario', 'web', '--agent-preset', 'Not-valid'], dshHome)
    expect(invalidPreset.status).toBe(2)
    expect(invalidPreset.stderr).toContain('--agent-preset 必须匹配')

    const wildcardWorkspace = run(['--dry-run', '--scenario', 'web', '--workspace', '/tmp/*'], dshHome)
    expect(wildcardWorkspace.status).toBe(2)
    expect(wildcardWorkspace.stderr).toContain('--workspace 不能包含通配符或换行')
  })

  test('rejects an existing enabled Lark channel instead of silently changing the owner', async () => {
    const dshHome = await temporaryHome()
    const profile = join(dshHome, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'cordis.patch.yml'), `- id: dsh-enhanced-lark-channel
  config:
    enabled: true
    appId: cli_0123456789abcdef
`, 'utf8')

    const result = run(['--dry-run', '--scenario', 'web'], dshHome)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('已有启用的 Lark channel')
  })

  test('runs the real profile setup command before dump-config and activation probing', async () => {
    const { result, log } = await actualFixture(0)

    expect(result.status, result.stderr).toBe(0)
    const order = await readFile(log, 'utf8')
    const installed = order.slice(order.indexOf('plugin-add'))
    expect(installed).toMatch(/^plugin-add\nsetup\n/u)
    expect(installed.indexOf('setup')).toBeLessThan(installed.indexOf('dump'))
    expect(installed.indexOf('dump')).toBeLessThan(installed.indexOf('probe'))
  }, 30_000)

  test.each([23, 'missing'] as const)('does not dump or probe when Web owner setup %s', async outcome => {
    const { result, log } = await actualFixture(outcome)

    expect(result.status).not.toBe(0)
    if (outcome === 'missing') expect(result.stderr).toContain('找不到安装后的 dsh-web-owner-setup')
    else expect((await readFile(log, 'utf8'))).toContain('setup')
    const order = await readFile(log, 'utf8')
    const installed = order.slice(order.indexOf('plugin-add'))
    expect(installed).not.toContain('dump')
    expect(installed).not.toContain('probe')
  }, 30_000)
})
