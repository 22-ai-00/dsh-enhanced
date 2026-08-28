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
  test('local installer defaults to the safe core scenario with capability discovery and excludes optional bundles', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('目标 profile：web')
    expect(result.stdout).toContain('部署场景：core')
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'personal-assistant'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'plugin-control-plane'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'lark-channel'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-health'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-heartbeat'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-policy'))
    expect(result.stdout).not.toContain('部署模式：')
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'acp'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'hello'))
    expect(result.stdout).toContain('Agent 工具授权：preserve')
    expect(result.stdout).toContain('权限默认值：保留现有 Settings')
    expect(result.stdout).toContain('立即使用：dsh --profile web')
    expect(result.stdout).not.toContain('dsh-lark-setup')
  })

  test('lark skip can explicitly disable managed foreground capability without touching channel onboarding', async () => {
    const dshHome = await temporaryDshHome()
    const result = runInstaller(localInstaller, [
      '--dry-run', '--scenario', 'lark', '--lark', 'skip', '--agent-tools', 'disable',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('部署场景：lark')
    expect(result.stdout).toContain('Agent 工具授权：disable')
    expect(result.stdout).toContain(
      `${join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-lark-setup')} `
      + '--profile web --refresh-agent-policy --disable-agent-tools',
    )
    expect(result.stdout).not.toContain('--install-service')
  })

  test('explicit standard is byte-for-byte the default dry-run and does not mount Evolution', async () => {
    const implicitHome = await temporaryDshHome()
    const explicitHome = await temporaryDshHome()

    const implicit = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], implicitHome)
    const explicit = runInstaller(localInstaller, ['--dry-run', '--mode', 'standard', '--lark', 'skip'], explicitHome)

    expect(implicit.status, implicit.stderr).toBe(0)
    expect(explicit.status, explicit.stderr).toBe(0)
    expect(explicit.stdout.replaceAll(explicitHome, '<DSH_HOME>')).toBe(
      implicit.stdout.replaceAll(implicitHome, '<DSH_HOME>'),
    )
    expect(explicit.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-evolution'))
    expect(explicit.stdout).not.toContain('dsh-supervised-growth-setup')
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
    expect(result.stdout).toContain('@dsh-enhanced/plugin-control-plane@0.2.0')
    expect(result.stdout).not.toContain('@dsh-enhanced/lark-channel@0.2.0')
    expect(result.stdout).not.toContain('@dsh-enhanced/acp@')
    expect(result.stdout).not.toContain('@dsh-enhanced/hello@')
  })

  test('refuses incompatible stored permission defaults before changing the installation', async () => {
    for (const preset of ['read-only', 'unrecognized-local-preset']) {
      const dshHome = await temporaryDshHome()
      const settingsPath = join(dshHome, 'settings.yaml')
      await writeFile(settingsPath, `permission:\n  defaultPreset: ${preset}\n`, 'utf8')
      const before = await readFile(settingsPath, 'utf8')

      const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome)

      expect(result.status).toBe(2)
      expect(result.stderr).toContain(`permission.defaultPreset=${preset}`)
      expect(result.stderr).toContain('不会覆盖用户设置')
      expect(result.stdout).not.toContain('dsh plugin')
      expect(await readFile(settingsPath, 'utf8')).toBe(before)
    }
  })

  test('preserves every supported stored permission default', async () => {
    for (const preset of ['workspace-write', 'auto', 'danger-full-access']) {
      const dshHome = await temporaryDshHome()
      const settingsPath = join(dshHome, 'settings.yaml')
      await writeFile(settingsPath, `permission:\n  defaultPreset: ${preset}\n`, 'utf8')
      const before = await readFile(settingsPath, 'utf8')

      const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome)

      expect(result.status, result.stderr).toBe(0)
      expect(await readFile(settingsPath, 'utf8')).toBe(before)
    }
  })

  test('supervised-growth explicitly installs Evolution then invokes the audited activator after Lark onboarding', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'supervised-growth', '--lark', 'configure',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('部署模式：supervised-growth')
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-evolution'))
    expect(result.stdout).toContain('dsh-lark-setup --profile web')
    expect(result.stdout).toContain('dsh-supervised-growth-setup --profile web --timeout-ms 300000')
    expect(result.stdout).not.toContain('overlay：未应用')
  })

  test('supervised-growth passes an explicit acknowledgement only to its activator', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'supervised-growth', '--lark', 'configure', '--ack-existing-automations',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('dsh-supervised-growth-setup --profile web --timeout-ms 300000 --ack-existing-automations')
  })

  test('supervised-growth refuses to run without an owner onboarding path', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'supervised-growth', '--lark', 'skip',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('supervised-growth 需要飞书 onboarding')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('rejects an unknown deployment mode before planning installation', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'unbounded', '--lark', 'skip',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--mode 只能是 standard 或 supervised-growth')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('local installer replaces an incompatible DSH and executes build, install, and validation', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    const setupDirectory = join(dshHome, 'profiles', 'web', 'node_modules', '.bin')
    await mkdir(setupDirectory, { recursive: true })
    await writeExecutable(join(setupDirectory, 'dsh-lark-setup'), `#!/bin/bash
printf 'lark-setup %s\n' "$*" >> "$INSTALL_LOG"
`)
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
    expect(log).not.toContain('lark-setup')
  })

  test('supervised-growth invokes the installed activator only after the installed Lark setup completes', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await configureExistingLark(dshHome)
    await writeExecutable(join(fakeBin, 'node'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf 'v24.7.0\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "\${1:-}" == 'prefix' ]]; then printf '%s\\n' "$FAKE_PREFIX"; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; exit 0; fi
printf 'pnpm %s\\n' "$*" >> "$INSTALL_LOG"
`)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.1.0-rc.8\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "\${1:-}" == 'plugin' ]]; then
  bin="$DSH_HOME/profiles/web/node_modules/.bin"
  mkdir -p "$bin"
  cat > "$bin/dsh-lark-setup" <<'EOF'
#!/bin/bash
printf 'lark-setup %s\\n' "$*" >> "$INSTALL_LOG"
EOF
  cat > "$bin/dsh-supervised-growth-setup" <<'EOF'
#!/bin/bash
printf 'supervised-setup %s\\n' "$*" >> "$INSTALL_LOG"
printf 'supervised growth activated\\n'
EOF
  chmod 755 "$bin/dsh-lark-setup" "$bin/dsh-supervised-growth-setup"
fi
`)

    const result = spawnSync('/bin/bash', [localInstaller, '--mode', 'supervised-growth', '--lark', 'keep', '--yes'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSH_HOME: dshHome,
        INSTALL_LOG: logPath,
        FAKE_PREFIX: root,
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('supervised growth activated')
    const log = await readFile(logPath, 'utf8')
    const larkSetup = log.indexOf('lark-setup --profile web --install-service')
    const activator = log.indexOf('supervised-setup --profile web --timeout-ms 300000')
    expect(larkSetup).toBeGreaterThanOrEqual(0)
    expect(activator).toBeGreaterThan(larkSetup)
  })

  test('auto mode keeps an existing enabled Feishu bot and only restarts its service', async () => {
    const dshHome = await temporaryDshHome()
    await configureExistingLark(dshHome)

    const result = runInstaller(localInstaller, ['--dry-run', '--yes'], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('飞书处理：保留当前应用配置')
    const larkSetup = join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-lark-setup')
    const installService = `${larkSetup} --profile web --install-service`
    expect(result.stdout).toContain(installService)
    expect(result.stdout).not.toContain('--refresh-agent-policy')
  })

  test('fresh configure mode preserves Agent tool reachability unless it is explicitly authorized', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'configure'], dshHome)

    expect(result.status, result.stderr).toBe(0)
    const larkSetup = join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-lark-setup')
    const setupCommands = result.stdout
      .split('\n')
      .filter(line => line.includes('dsh-lark-setup'))
    expect(setupCommands).toEqual([
      `  $ ${larkSetup} --profile web`,
    ])
  })

  test('requires explicit confirmation before planning a danger-full-access default', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--permission', 'danger-full-access',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--confirm-dangerous-full-access')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('prints the bounded headless model route check only when requested', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-route', 'verify',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("dsh --profile headless Reply\\ with\\ exactly\\ DSH_ROUTE_READY")
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

    const result = runRestart([], dshHome, 'darwin')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('pnpm build')
    expect(result.stdout).toContain('launchctl kickstart -k gui/')
    expect(result.stdout).toContain('/ai.deepseek.dsh.profile.web')
    expect(result.stdout).not.toContain('dsh plugin')
    expect(result.stdout).not.toContain('dsh-lark-setup')
  })

  test('restart command accepts the profile as its only optional argument', async () => {
    const dshHome = await temporaryDshHome()

    const result = runRestart(['personal-web'], dshHome, 'darwin')

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
