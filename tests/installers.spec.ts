import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'
import { parse, stringify } from 'yaml'
import { RECOVERY_CATALOG_DIGEST } from '@dsh-enhanced/assistant-recovery'
import {
  assertEffectiveSupervisedGrowthConfig,
  configureSupervisedGrowthProfilePatch,
} from '../plugins/lark-channel/src/supervised-growth-profile.ts'

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

const yamlOptions = {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
} as const

async function composeSelectedBundleRows(installerOutput: string): Promise<any[]> {
  const paths = [...new Set([...installerOutput.matchAll(new RegExp(`${repoRoot}/plugins/[a-z0-9-]+`, 'gu'))]
    .map(match => match[0]))]
  const rows: any[] = []
  for (const path of paths) {
    const patch = parse(await readFile(join(path, 'cordis.patch.yml'), 'utf8'), yamlOptions) as any[]
    for (const operation of patch) {
      if (Array.isArray(operation.insert)) rows.push(...operation.insert)
      else if (typeof operation.id === 'string') rows.push(operation)
    }
  }
  return rows
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

  test('standard Lark installs automatic preference learning without the supervised operations stack', async () => {
    const dshHome = await temporaryDshHome()
    const result = runInstaller(localInstaller, [
      '--dry-run', '--scenario', 'lark', '--lark', 'skip', '--agent-tools', 'disable',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('部署场景：lark')
    expect(result.stdout).toContain('Agent 工具授权：disable')
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'preference-learning'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-evaluation'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-evolution'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-heartbeat'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-health'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-recovery'))
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

  test('npm supervised install defaults every required bundle to the installer release', async () => {
    const dshHome = await temporaryDshHome()
    const installer = await readFile(npmInstaller, 'utf8')
    const release = installer.match(/^DSH_ENHANCED_PINNED_RELEASE_REF='v([^']+)'$/mu)?.[1]
    expect(release).toMatch(/^\d+\.\d+\.\d+$/u)

    const result = runInstaller(npmInstaller, [
      '--dry-run', '--scenario', 'supervised', '--lark', 'configure',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    const selected = [...result.stdout.matchAll(/@dsh-enhanced\/([a-z0-9-]+)@([^\s]+)/gu)]
    expect(selected.length).toBeGreaterThan(0)
    expect(new Set(selected.map(match => match[2]))).toEqual(new Set([release]))
    const slugs = new Set(selected.map(match => match[1]))
    for (const required of [
      'personal-assistant', 'assistant-delivery', 'assistant-evaluation',
      'assistant-evolution', 'assistant-growth-experiments', 'preference-learning', 'assistant-heartbeat',
      'assistant-health', 'assistant-recovery', 'lark-channel',
    ]) expect(slugs.has(required), `missing ${required}`).toBe(true)
    expect(result.stdout).toContain('dsh-supervised-growth-setup --profile web --timeout-ms 300000')
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

  test('Recovery README primary command installs every activator dependency then invokes it after Lark onboarding', async () => {
    const dshHome = await temporaryDshHome()
    const readme = await readFile(join(repoRoot, 'plugins', 'assistant-recovery', 'README.md'), 'utf8')
    const documentedCommand = readme.match(/^\.\/scripts\/install\/install-local\.sh --scenario supervised --lark configure$/mu)?.[0]
    expect(documentedCommand).toBeDefined()
    const [, ...documentedArgs] = documentedCommand!.split(/\s+/u)

    const result = runInstaller(localInstaller, [
      '--dry-run', ...documentedArgs,
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('部署模式：supervised-growth')
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'personal-assistant'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-delivery'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'lark-channel'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-evolution'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-evaluation'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-growth-experiments'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'preference-learning'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-heartbeat'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-health'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-recovery'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'traex-acp-provider'))
    expect(result.stdout).toContain('dsh-lark-setup --profile web')
    expect(result.stdout).toContain('dsh-supervised-growth-setup --profile web --timeout-ms 300000')
    expect(result.stdout).not.toContain('overlay：未应用')
  })

  test('supervised-growth installs TraeX only when explicitly requested', async () => {
    const dshHome = await temporaryDshHome()
    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'supervised-growth', '--lark', 'configure', '--with', 'traex',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'traex-acp-provider'))
  })

  test('selected supervised bundles compose into a real effective tree accepted by the activator', async () => {
    const dshHome = await temporaryDshHome()
    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'supervised-growth', '--lark', 'configure',
    ], dshHome)
    expect(result.status, result.stderr).toBe(0)

    const installedRows = await composeSelectedBundleRows(result.stdout)
    const lark = installedRows.find(row => row.id === 'dsh-enhanced-lark-channel')
    expect(lark).toBeDefined()
    lark.config = { ...lark.config, enabled: true, account: 'primary', tenant: 'personal' }
    const effectiveBefore = stringify(installedRows)
    const binding = {
      id: 'binding-owner-dm',
      conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_owner' },
      principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' },
      workspace: join(dshHome, 'assistant-workspace'),
      agentPreset: 'standard',
      sessionId: 'session-owner', generation: 1, policyRef: 'owner-dm', status: 'active',
      createdAt: 1, updatedAt: 1, version: 1,
    } as const
    const overlay = parse(configureSupervisedGrowthProfilePatch({
      profilePatch: '[]\n', effectiveConfig: effectiveBefore, dshHome, binding,
      activationState: 'preview',
      activationNonce: 'installer-compose-preview',
      recoveryCatalogDigest: RECOVERY_CATALOG_DIGEST,
    }), yamlOptions) as any[]
    const composed = new Map(installedRows.map(row => [row.id, row]))
    for (const row of overlay) composed.set(row.id, row)

    expect(assertEffectiveSupervisedGrowthConfig({
      effectiveConfig: stringify([...composed.values()]), dshHome, binding,
      activationState: 'preview',
      activationNonce: 'installer-compose-preview',
      recoveryCatalogDigest: RECOVERY_CATALOG_DIGEST,
    })).toMatchObject({
      workspace: join(dshHome, 'assistant-workspace'),
      agentPreset: 'standard',
      activationState: 'preview',
      automationId: 'recovery:supervised-growth',
    })
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
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "\${1:-}" == 'show-user' ]]; then printf 'yes\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\\n' "$*" >> "$INSTALL_LOG"
exit 0
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
    expect(log).toContain('systemctl --user show-environment')
    expect(log).toContain('systemctl --user is-active --quiet dsh-profile-web.service')
    expect(log).toContain('loginctl show-user')
    const larkSetup = log.indexOf('lark-setup --profile web --install-service')
    const activator = log.indexOf('supervised-setup --profile web --timeout-ms 300000')
    const serviceDoctor = log.indexOf('systemctl --user is-active --quiet dsh-profile-web.service')
    expect(larkSetup).toBeGreaterThanOrEqual(0)
    expect(activator).toBeGreaterThan(larkSetup)
    expect(serviceDoctor).toBeGreaterThan(activator)
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
    expect(result.stdout).toContain('将在飞书授权前验证 user manager')
    expect(result.stdout).toContain('常驻服务与 Linux logout persistence')
  })

  test('Linux service preflight enables lingering without sudo before checking the user manager', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    const lingerState = join(root, 'linger-enabled')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'id'), `#!/bin/bash
printf 'id %s\n' "$*" >> "$COMMAND_LOG"
printf '424242\n'
`)
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == 'show-user' ]]; then
  if [[ -f "$LINGER_STATE" ]]; then printf 'yes\n'; else printf 'no\n'; fi
  exit 0
fi
if [[ "\${1:-}" == '--no-ask-password' && "\${2:-}" == 'enable-linger' ]]; then
  touch "$LINGER_STATE"
  exit 0
fi
exit 2
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\n' "$*" >> "$COMMAND_LOG"
exit 0
`)

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_prepare_linux_resident_service 0',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        COMMAND_LOG: commandLog,
        LINGER_STATE: lingerState,
        DSH_ENHANCED_PLATFORM_OVERRIDE: 'linux',
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('已为当前用户启用 logout persistence')
    expect(result.stdout).toContain('user manager 与 logout persistence 已就绪')
    const log = await readFile(commandLog, 'utf8')
    expect(log).toContain(`loginctl show-user ${process.geteuid?.() ?? process.getuid?.()}`)
    expect(log).toContain('loginctl --no-ask-password enable-linger')
    expect(log).toContain('systemctl --user show-environment')
    expect(log).not.toContain('sudo')
    expect(log).not.toContain('id -u')
  })

  test('Linux service preflight stops before OAuth when lingering needs explicit administrator approval', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == 'show-user' ]]; then printf 'no\n'; exit 0; fi
exit 1
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\n' "$*" >> "$COMMAND_LOG"
exit 0
`)

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_prepare_linux_resident_service 0',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        COMMAND_LOG: commandLog,
        DSH_ENHANCED_PLATFORM_OVERRIDE: 'linux',
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('sudo loginctl enable-linger "$(id -u)"')
    expect(result.stderr).toContain('尚未开始飞书授权')
    const log = await readFile(commandLog, 'utf8')
    expect(log).not.toContain('systemctl')
  })

  test('interactive Linux preflight explains and runs exactly one fixed sudo action after confirmation', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    const lingerState = join(root, 'linger-enabled')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == 'show-user' ]]; then
  if [[ -f "$LINGER_STATE" ]]; then printf 'yes\n'; else printf 'no\n'; fi
  exit 0
fi
if [[ "\${1:-}" == '--no-ask-password' ]]; then exit 1; fi
if [[ "\${1:-}" == 'enable-linger' ]]; then touch "$LINGER_STATE"; exit 0; fi
exit 2
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\n' "$*" >> "$COMMAND_LOG"
exit 0
`)
    await writeExecutable(join(fakeBin, 'sudo'), `#!/bin/bash
printf 'sudo %s\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == '--' ]]; then shift; fi
"$@"
`)

    const result = spawnSync('/bin/bash', [
      '-c', `source "$1"
dsh_enhanced_trusted_system_command() { printf '%s/%s\\n' "$FAKE_BIN" "$1"; }
dsh_enhanced_prepare_linux_resident_service 0 force`,
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      input: '\n',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        COMMAND_LOG: commandLog,
        LINGER_STATE: lingerState,
        FAKE_BIN: fakeBin,
        DSH_ENHANCED_PLATFORM_OVERRIDE: 'linux',
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('唯一的提权动作')
    expect(result.stderr).toContain('现在通过 sudo 启用？[Y/n]')
    expect(result.stdout).toContain('密码由 sudo 直接读取，不会进入安装器')
    const log = await readFile(commandLog, 'utf8')
    expect(log).toContain(`sudo -- ${join(fakeBin, 'loginctl')} enable-linger`)
    expect(log.match(/^sudo /gmu)).toHaveLength(1)
    expect(log).toContain('systemctl --user show-environment')
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

  test('an agent-route default verifies structurally instead of a headless model call', async () => {
    const dshHome = await temporaryDshHome()
    // The runtime resolves the settings.yaml user-layer selection, which is what
    // the verifier reads; a real run would have just written it.
    await writeFile(join(dshHome, 'settings.yaml'),
      'agent-default-model:\n  provider: traex-agent\n  model: default\n', 'utf8')

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-route', 'verify',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('agent route traex-agent 不发送模型请求')
    expect(result.stdout).toContain('校验 profile web 已注册适配器并检查本机登录')
    // No headless model call is planned for an agent route.
    expect(result.stdout).not.toContain('DSH_ROUTE_READY')
  })

  test('the effective-default reader returns the settings.yaml user-layer provider', async () => {
    const dshHome = await temporaryDshHome()
    await writeFile(join(dshHome, 'settings.yaml'),
      'ui-theme:\n  preference: dark\nagent-default-model:\n  provider: traex-agent\n  model: default\nllm-pi-ai:\n  providers: {}\n', 'utf8')

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_effective_default_provider "$2"', 'installer-test', installerLibrary, dshHome,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('traex-agent')
  })

  test('non-interactive default keeps the composed model without configuring a route', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('模型配置：本次跳过；使用 profile 已组合的默认模型。')
    expect(result.stdout).not.toContain('dsh-model-setup')
  })

  test('configuring deepseek-official plans an env-only key store into settings and credentials', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'deepseek-official', '--model-name', 'deepseek-v4-flash',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('模型配置：provider=deepseek-official model=deepseek-v4-flash')
    expect(result.stdout).toContain(
      `${join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-model-setup')} `
      + `--dsh-home ${dshHome} --provider deepseek-official --model deepseek-v4-flash`,
    )
    // The key is never an argument; without one in the environment the plan
    // still writes the route and names the credential reference to set later.
    expect(result.stdout).toContain('未检测到 API Key，稍后请设置 DEEPSEEK_API_KEY')
    expect(result.stdout).not.toContain('--store-key')
  })

  test('an available key env var upgrades the deepseek plan to store the credential', async () => {
    const dshHome = await temporaryDshHome()

    const result = spawnSync('/bin/bash', [localInstaller,
      '--dry-run', '--lark', 'skip', '--model-provider', 'deepseek-official',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', DSH_HOME: dshHome, DSH_ENHANCED_MODEL_API_KEY: 'plat-secret' },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('把环境中的 API Key 存入 .credentials.yaml')
    expect(result.stdout).toContain('--provider deepseek-official --store-key')
  })

  test('a custom gateway route plans llm-pi-ai transport fields', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'super-relay', '--model-name', 'glm5.2',
      '--model-base-url', 'https://super-relay.example/v1', '--model-api', 'openai-completions',
      '--model-display-name', 'Super Relay',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      '--provider super-relay --model glm5.2 --base-url https://super-relay.example/v1'
      + ' --api openai-completions --display-name Super\\ Relay',
    )
  })

  test('rejects a custom gateway route without a base URL and deepseek with transport fields', async () => {
    const dshHome = await temporaryDshHome()

    const missingBaseUrl = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'super-relay', '--model-name', 'glm5.2',
    ], dshHome)
    expect(missingBaseUrl.status).toBe(2)
    expect(missingBaseUrl.stderr).toContain('自定义模型 provider 需要 --model-base-url')
    expect(missingBaseUrl.stdout).not.toContain('dsh plugin')

    const misplacedFields = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'deepseek-official', '--model-base-url', 'https://x/v1',
    ], dshHome)
    expect(misplacedFields.status).toBe(2)
    expect(misplacedFields.stderr).toContain('仅适用于自定义 provider')
    expect(misplacedFields.stdout).not.toContain('dsh plugin')
  })

  test('non-interactive configure without a provider guides the owner to the model flags', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model', 'configure',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('非交互配置模型需要 --model-provider')
  })

  test('model menu writes UI separately from its machine-readable selection', () => {
    const configured = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_choose_model_mode 1', 'installer-test', installerLibrary,
    ], { encoding: 'utf8', input: '2\n' })
    expect(configured.status, configured.stderr).toBe(0)
    expect(configured.stdout).toBe('configure')
    expect(configured.stderr).toContain('检测到当前 profile 已能解析默认模型')

    const unconfigured = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_choose_model_mode 0', 'installer-test', installerLibrary,
    ], { encoding: 'utf8', input: '\n' })
    expect(unconfigured.status, unconfigured.stderr).toBe(0)
    expect(unconfigured.stdout).toBe('configure')
    expect(unconfigured.stderr).toContain('尚未配置可用的默认模型')
  })

  test('selecting the local TraeX route plans bundle install, default selection, and profile enable', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'traex-agent',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    // The provider bundle is pulled into the top-level install set...
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'traex-acp-provider'))
    // ...and the default-model write enables the route in this profile's patch.
    expect(result.stdout).toContain('模型配置：provider=traex-agent')
    expect(result.stdout).toContain(
      `${join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-model-setup')} `
      + `--dsh-home ${dshHome} --provider traex-agent --enable-in-profile web`,
    )
    // Agent routes never touch an API key.
    expect(result.stdout).not.toContain('--store-key')
    expect(result.stdout).not.toContain('存入 .credentials.yaml')
    expect(result.stdout).toContain('无需 API Key')
  })

  test('rejects gateway transport fields on the TraeX agent route', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'traex-agent', '--model-base-url', 'https://x/v1',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('不适用于本机 agent route traex-agent')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('the model prompt offers TraeX only when a local traex command is present', () => {
    const scriptWithTraex = 'export PATH="$2:$PATH"; source "$1"; '
      + 'dsh_enhanced_prompt_model_route p m b a d >/dev/null; printf "provider=%s" "$p"'
    const fakeBin = join(tmpdir(), `dsh-fake-traex-${Date.now()}`)

    return (async () => {
      await mkdir(fakeBin, { recursive: true })
      await writeExecutable(join(fakeBin, 'traex'), '#!/bin/bash\nexit 0\n')

      const withTraex = spawnSync('/bin/bash', ['-c', scriptWithTraex, 'installer-test', installerLibrary, fakeBin], {
        encoding: 'utf8', input: '3\n',
      })
      expect(withTraex.status, withTraex.stderr).toBe(0)
      expect(withTraex.stderr).toContain('本机 TraeX')
      expect(withTraex.stdout).toBe('provider=traex-agent')

      // Without a traex command on PATH, option 3 is not offered and is invalid.
      const withoutTraex = spawnSync('/bin/bash', [
        '-c', 'export PATH="/nonexistent-only"; source "$1"; dsh_enhanced_prompt_model_route p m b a d; printf "rc=%s" "$?"',
        'installer-test', installerLibrary,
      ], { encoding: 'utf8', input: '3\n' })
      expect(withoutTraex.stderr).not.toContain('本机 TraeX')

      await rm(fakeBin, { recursive: true, force: true })
    })()
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
