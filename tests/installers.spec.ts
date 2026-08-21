import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installDirectory = join(repoRoot, 'scripts', 'install')
const localInstaller = join(installDirectory, 'install-local.sh')
const npmInstaller = join(installDirectory, 'install-npm.sh')
const restartScript = join(installDirectory, 'restart.sh')
const installerLibrary = join(installDirectory, 'common.sh')
const temporaryRoots: string[] = []

function runInstaller(script: string, args: readonly string[], dshHome: string) {
  return spawnSync('/bin/bash', [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      DSH_HOME: dshHome,
    },
  })
}

function runRestart(args: readonly string[], dshHome: string, platform?: string) {
  return spawnSync('/bin/bash', [restartScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      DSH_HOME: dshHome,
      DSH_ENHANCED_DRY_RUN: '1',
      ...(platform === undefined ? {} : { DSH_ENHANCED_PLATFORM_OVERRIDE: platform }),
    },
  })
}

async function temporaryDshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-enhanced-installer-'))
  temporaryRoots.push(root)
  return root
}

async function configureExistingLark(dshHome: string, profile = 'web'): Promise<void> {
  const profileDirectory = join(dshHome, 'profiles', profile)
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(join(profileDirectory, 'cordis.patch.yml'), `- id: dsh-enhanced-lark-channel
  config:
    enabled: true
    appId: cli_0123456789abcdef
`, 'utf8')
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8')
  await chmod(path, 0o755)
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('one-click installers', () => {
  test('local installer defaults to web and links the non-duplicating assistant deployment set', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('目标 profile：web')
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'personal-assistant'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'lark-channel'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-health'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-policy'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'acp'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'hello'))
  })

  test('npm installer pins DSH and applies one release selector to every published bundle', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(npmInstaller, [
      '--dry-run', '--lark', 'skip', '--profile', 'personal-web', '--plugin-version', '0.2.0',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('目标 profile：personal-web')
    expect(result.stdout).toContain('@deepseek-ai/dsh@0.1.0-rc.8')
    expect(result.stdout).toContain('@dsh-enhanced/personal-assistant@0.2.0')
    expect(result.stdout).toContain('@dsh-enhanced/lark-channel@0.2.0')
    expect(result.stdout).not.toContain('@dsh-enhanced/acp@')
    expect(result.stdout).not.toContain('@dsh-enhanced/hello@')
  })

  test('local installer replaces an incompatible DSH and executes build, install, and validation', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'node'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf 'v24.7.0\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.0.0\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$INSTALL_LOG"
`)
    await writeExecutable(join(fakeBin, 'dsh-new'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.1.0-rc.8\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$INSTALL_LOG"
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf 'npm %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "\${1:-}" == 'prefix' ]]; then printf '%s\\n' "$FAKE_PREFIX"; exit 0; fi
if [[ "$*" == 'install --global @deepseek-ai/dsh@0.1.0-rc.8' ]]; then
  cp "$FAKE_BIN/dsh-new" "$FAKE_BIN/dsh"
  chmod 755 "$FAKE_BIN/dsh"
fi
`)
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; exit 0; fi
printf 'pnpm %s\\n' "$*" >> "$INSTALL_LOG"
`)

    const result = spawnSync('/bin/bash', [localInstaller, '--lark', 'skip'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSH_HOME: dshHome,
        INSTALL_LOG: logPath,
        FAKE_BIN: fakeBin,
        FAKE_PREFIX: root,
      },
    })

    expect(result.status, result.stderr).toBe(0)
    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('npm install --global @deepseek-ai/dsh@0.1.0-rc.8')
    expect(log).toContain('pnpm install')
    expect(log).toContain('pnpm build')
    expect(log).toContain('dsh plugin --profile web add')
    expect(log).toContain('dsh --profile web --dump-config')
  })

  test('auto mode keeps an existing enabled Feishu bot and only restarts its service', async () => {
    const dshHome = await temporaryDshHome()
    await configureExistingLark(dshHome)

    const result = runInstaller(localInstaller, ['--dry-run', '--yes'], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('飞书处理：保留当前应用配置')
    expect(result.stdout).toContain('dsh-lark-setup --profile web --install-service')
  })

  test('explicit configure mode reruns onboarding and can avoid installing a service', async () => {
    const dshHome = await temporaryDshHome()
    await configureExistingLark(dshHome)

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'configure', '--no-service',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('飞书处理：选择已有应用或创建新应用，并覆盖当前 channel 配置')
    expect(result.stdout).toContain('dsh-lark-setup --profile web --no-service')
  })

  test('Feishu menu writes UI separately from its machine-readable selection', () => {
    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_choose_lark_mode 1', 'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      input: '2\n',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('configure')
    expect(result.stderr).toContain('检测到当前 profile 已启用飞书 Bot')
  })

  test('rejects unsafe profile names before planning any installation', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--profile', '../web',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('profile 名称不合法')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('restart command rebuilds and kickstarts web without installation or onboarding', async () => {
    const dshHome = await temporaryDshHome()

    const result = runRestart([], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('pnpm build')
    expect(result.stdout).toContain('launchctl kickstart -k gui/')
    expect(result.stdout).toContain('/ai.deepseek.dsh.profile.web')
    expect(result.stdout).not.toContain('dsh plugin')
    expect(result.stdout).not.toContain('dsh-lark-setup')
  })

  test('restart command accepts the profile as its only optional argument', async () => {
    const dshHome = await temporaryDshHome()

    const result = runRestart(['personal-web'], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('pnpm build')
    expect(result.stdout).toContain('/ai.deepseek.dsh.profile.personal-web')
  })

  test('restart command rejects more than one argument', async () => {
    const dshHome = await temporaryDshHome()

    const result = runRestart(['web', 'extra'], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('只接受一个可选的 profile 参数')
  })

  test('restart command uses systemd on Linux and Task Scheduler on Windows', async () => {
    const dshHome = await temporaryDshHome()

    const linux = runRestart(['web'], dshHome, 'linux')
    expect(linux.status, linux.stderr).toBe(0)
    expect(linux.stdout).toContain('systemctl --user restart dsh-profile-web.service')

    const windows = runRestart(['web'], dshHome, 'windows')
    expect(windows.status, windows.stderr).toBe(0)
    expect(windows.stdout).toContain('schtasks.exe /End /TN DSH\\ profile\\ web')
    expect(windows.stdout).toContain('schtasks.exe /Run /TN DSH\\ profile\\ web')
  })
})
