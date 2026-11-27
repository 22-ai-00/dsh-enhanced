import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { collectStatus, formatStatus } from '../src/diagnose.ts'
import {
  collectLiveDoctorReport,
  formatLiveDoctorReport,
  parseDumpConfigRows,
  redactUrlToken,
} from '../src/doctor-live.ts'
import { inspectBoundHostRuntime } from '../src/install-host.ts'
import type { DetailedCommandRunner } from '../src/run.ts'

const roots: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  while (roots.length > 0) {
    const dir = roots.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

describe('parseDumpConfigRows & redactUrlToken', () => {
  test('redactUrlToken 脱敏 URL 中的 token 而保留其余部分', () => {
    expect(redactUrlToken('http://127.0.0.1:3080/?token=secret_123&tab=ray'))
      .toBe('http://127.0.0.1:3080/?token=<redacted>&tab=ray')
  })

  test('parseDumpConfigRows 正确解析嵌套 scope 而不覆盖外层 dreaming enabled 字段', () => {
    const dump = `- id: dsh-ray-traex-acp-provider
  name: "@dsh-ray/traex-acp-provider"
  config:
    enabled: true
    command: /usr/local/bin/traex
    agyEnabled: true
    agyCommand: /usr/local/bin/agy
- id: dsh-ray-assistant-dreaming
  name: "@dsh-ray/assistant-dreaming"
  config:
    enabled: false
    scope:
      workspace: /tmp/ws
      enabled: true
    databasePath: !js "dshHomePath('dreaming.sqlite')"
`
    const rows = parseDumpConfigRows(dump)
    const acp = rows.find(row => row.id === 'dsh-ray-traex-acp-provider')
    expect(acp?.config.enabled).toBe(true)
    expect(acp?.config.agyEnabled).toBe(true)
    expect(acp?.config.agyCommand).toBe('/usr/local/bin/agy')

    const dreaming = rows.find(row => row.id === 'dsh-ray-assistant-dreaming')
    expect(dreaming?.config.enabled).toBe(false)
    expect(dreaming?.config.scope).toBe('[nested]')
    expect(dreaming?.config.databasePath).toBe("dshHomePath('dreaming.sqlite')")
  })
})

describe('inspectBoundHostRuntime', () => {
  test('覆盖 missing / ready / unready 摘要不一致三种状态', async () => {
    const home = await makeTempDir('dsh-bound-host-')
    expect((await inspectBoundHostRuntime(home)).status).toBe('missing')

    const cacheRoot = join(home, 'hosts')
    const digest = 'b'.repeat(64)
    await writeFile(join(home, '.dsh-ray-host.json'), JSON.stringify({
      schemaVersion: 1, cacheRoot, version: '0.2.2-rc.5', receiptDigest: digest,
    }), { mode: 0o600 })

    const ready = await inspectBoundHostRuntime(home, {
      read: async () => ({
        version: '0.2.2-rc.5',
        root: join(cacheRoot, '0.2.2-rc.5'),
        dshPath: join(cacheRoot, '0.2.2-rc.5', 'node_modules', '.bin', 'dsh'),
        binDirectory: join(cacheRoot, '0.2.2-rc.5', 'node_modules', '.bin'),
        integrity: 'sha512-x',
        receiptDigest: digest,
      }),
    })
    expect(ready.status).toBe('ready')
    expect(ready.version).toBe('0.2.2-rc.5')

    const mismatch = await inspectBoundHostRuntime(home, {
      read: async () => ({
        version: '0.2.2-rc.5',
        root: join(cacheRoot, '0.2.2-rc.5'),
        dshPath: join(cacheRoot, '0.2.2-rc.5', 'node_modules', '.bin', 'dsh'),
        binDirectory: join(cacheRoot, '0.2.2-rc.5', 'node_modules', '.bin'),
        integrity: 'sha512-x',
        receiptDigest: 'c'.repeat(64),
      }),
    })
    expect(mismatch.status).toBe('unready')
    expect(mismatch.issues.join('\n')).toContain('不一致')
  })
})

describe('collectLiveDoctorReport & enriched collectStatus', () => {
  test('全面聚合私有 Host、凭据键名（不泄密）、traex/agy 登录、autonomy readiness、端口与 Linux 前提', async () => {
    const root = await makeTempDir('dsh-live-doc-')
    const dshHome = join(root, 'dsh-home')
    const userHome = join(root, 'user-home')
    const binDir = join(root, 'bin')
    const boundBinDir = join(root, 'bound-bin')
    const profileDir = join(dshHome, 'profiles', 'web')
    await mkdir(join(dshHome, '.dsh-ray'), { recursive: true, mode: 0o700 })
    await mkdir(join(dshHome, 'logs'), { recursive: true })
    await mkdir(join(userHome, '.config', 'systemd', 'user'), { recursive: true })
    await mkdir(binDir, { recursive: true })
    await mkdir(boundBinDir, { recursive: true })
    for (const slug of ['owner-console', 'assistant-proactive', 'assistant-dreaming', 'assistant-web-owner', 'assistant-isolation']) {
      await mkdir(join(profileDir, 'node_modules', '@dsh-ray', slug), { recursive: true })
    }
    await mkdir(join(profileDir, 'node_modules', '@dsh-ray', 'assistant-web-owner', 'bin'), { recursive: true })
    await writeFile(join(profileDir, 'node_modules', '@dsh-ray', 'assistant-web-owner', 'bin', 'dsh-autonomy-doctor.js'), '')
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web' }))
    await writeFile(join(dshHome, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-super-secret-value-999\n', { mode: 0o644 })
    await writeFile(join(dshHome, '.dsh-ray', 'install-intent.json'), JSON.stringify({
      schemaVersion: 1, scenario: 'web', learning: 'skip', pluginPreset: 'recommended', proactive: 'on', dreaming: 'on', at: 1700000000,
    }), { mode: 0o600 })
    await writeFile(join(dshHome, 'logs', 'web-host.log'), 'dsh web: http://127.0.0.1:3080/?token=REAL_LIVE_TOKEN\n')
    await writeFile(join(userHome, '.config', 'systemd', 'user', 'dsh-profile-web.service'), '# DeepSeek Harness profile web\nExecStart=/usr/bin/dsh --profile web --no-open\n')

    const digest = 'd'.repeat(64)
    await writeFile(join(dshHome, '.dsh-ray-host.json'), JSON.stringify({
      schemaVersion: 1, cacheRoot: join(root, 'hosts'), version: '0.2.2-rc.5', receiptDigest: digest,
    }), { mode: 0o600 })

    const fakeTraex = join(binDir, 'traex')
    const fakeAgy = join(binDir, 'agy')
    const fakeBwrap = join(binDir, 'bwrap')
    for (const exe of [fakeTraex, fakeAgy, fakeBwrap]) await writeFile(exe, '#!/bin/sh\n', { mode: 0o755 })

    // Pure cgroup v2 fixture without v1 freezer/pids
    const cgroupRoot = join(root, 'sys-fs-cgroup')
    await mkdir(cgroupRoot, { recursive: true })
    await writeFile(join(cgroupRoot, 'cgroup.controllers'), 'cpu memory pids\n')

    const runner: DetailedCommandRunner = (command, args) => {
      if (command === 'dsh' && args[0] === '--version') return { status: 0, stdout: '0.2.2-rc.5\n', stderr: '' }
      if (command === join(boundBinDir, 'dsh') && args.includes('--dump-config')) {
        return {
          status: 0,
          stdout: `- id: agent-default-model
  config:
    provider: agy-agent
    model: default
- id: dsh-ray-traex-acp-provider
  name: "@dsh-ray/traex-acp-provider"
  config:
    enabled: true
    command: ${fakeTraex}
    agyEnabled: true
    agyCommand: ${fakeAgy}
- id: dsh-ray-owner-console
  name: "@dsh-ray/owner-console"
- id: dsh-ray-assistant-proactive
  name: "@dsh-ray/assistant-proactive"
- id: dsh-ray-assistant-dreaming
  name: "@dsh-ray/assistant-dreaming"
  config:
    enabled: false
`,
          stderr: '',
        }
      }
      if (command === fakeTraex && args[0] === 'login') return { status: 0, stdout: 'Logged in using Trae\n', stderr: '' }
      if (command === fakeAgy && args[0] === 'models') return { status: 0, stdout: 'gemini-3\n', stderr: '' }
      if (command === 'systemctl' && args[1] === 'is-active') return { status: 0, stdout: 'active\n', stderr: '' }
      if (command === 'systemctl' && args[1] === 'show-environment') return { status: 0, stdout: 'PATH=/usr/bin\n', stderr: '' }
      if (command === 'loginctl') return { status: 0, stdout: 'yes\n', stderr: '' }
      if (args.some(arg => arg.includes('dsh-autonomy-doctor.js'))) {
        return {
          status: 0,
          stdout: 'Autonomy readiness: READY\n' + JSON.stringify({ protocol: 'dsh-ray/autonomy-readiness/v1', ready: true, checks: [] }) + '\n',
          stderr: '',
        }
      }
      return { status: 1, stdout: '', stderr: '' }
    }

    const report = await collectLiveDoctorReport({
      dshHome,
      home: userHome,
      platform: 'linux',
      env: { PATH: binDir, USER: 'alice', DEEPSEEK_API_KEY: 'env-secret-value-999' },
      runner,
      readHostRuntime: async () => ({
        version: '0.2.2-rc.5',
        root: join(root, 'hosts', '0.2.2-rc.5'),
        dshPath: join(boundBinDir, 'dsh'),
        binDirectory: boundBinDir,
        integrity: 'sha512-x',
        receiptDigest: digest,
      }),
      probePort: async port => port === 3080,
      linuxPaths: { cgroupRoot },
    })

    expect(report.ok).toBe(true)
    expect(report.boundHost.status).toBe('ready')
    expect(report.agentTools.traex.loginReady).toBe(true)
    expect(report.agentTools.agy.loginReady).toBe(true)
    expect(report.credentials.insecurePermissions).toBe(true)
    expect(report.credentials.keyNames).toEqual(['DEEPSEEK_API_KEY'])
    expect(report.credentials.envVariablesPresent).toEqual(['DEEPSEEK_API_KEY'])
    expect(report.profiles[0]?.defaultModelRoute).toEqual({ provider: 'agy-agent', model: 'default' })
    expect(report.profiles[0]?.capabilities.ownerConsoleInstalled).toBe(true)
    expect(report.profiles[0]?.capabilities.dreamingEnabled).toBe(false)
    expect(report.profiles[0]?.capabilities.dreamingMissingPrerequisites.length).toBe(6)
    expect(report.profiles[0]?.autonomyReadiness).toEqual({ checked: true, ok: true, summary: 'autonomy readiness 就绪' })
    expect(report.profiles[0]?.webUrl).toEqual({
      configuredPort: 3080,
      redactedLogUrl: 'http://127.0.0.1:3080/?token=<redacted>',
      portListening: true,
    })

    const cgroupCheck = report.checks.find(c => c.id === 'platform.cgroup')
    expect(cgroupCheck?.status).toBe('warn')
    expect(cgroupCheck?.summary).toContain('cgroup v2')
    expect(report.checks.find(c => c.id === 'port.web')?.status).toBe('ok')
    expect(report.checks.find(c => c.id === 'credentials.permissions')?.status).toBe('warn')

    const serialized = JSON.stringify(report)
    const rendered = formatLiveDoctorReport(report)
    expect(serialized).not.toContain('sk-super-secret-value-999')
    expect(serialized).not.toContain('env-secret-value-999')
    expect(serialized).not.toContain('REAL_LIVE_TOKEN')
    expect(rendered).not.toContain('sk-super-secret-value-999')
    expect(rendered).not.toContain('REAL_LIVE_TOKEN')
    expect(rendered).toContain('Antigravity (agy)')
    expect(rendered).toContain('dsh-ray open --profile web')

    // status snapshot also includes installIntent and credential key names safely
    const snap = await collectStatus(dshHome, userHome, 'linux', runner)
    expect(snap.installIntent?.proactive).toBe('on')
    expect(snap.credentialKeys).toEqual(['DEEPSEEK_API_KEY'])
    const statusText = formatStatus(snap)
    expect(statusText).toContain('DEEPSEEK_API_KEY')
    expect(statusText).not.toContain('sk-super-secret-value-999')
  })

  test('dreaming enabled 但缺少必需字段时标记 fail（fail-closed）', async () => {
    const root = await makeTempDir('dsh-live-dream-')
    const dshHome = join(root, 'dsh')
    const profileDir = join(dshHome, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web' }))

    const report = await collectLiveDoctorReport({
      dshHome,
      home: root,
      platform: 'darwin',
      env: { PATH: '' },
      fileExists: path => path === '/usr/bin/sandbox-exec',
      runner: (command, args) => {
        if (command === 'dsh' && args.includes('--dump-config')) {
          return {
            status: 0,
            stdout: `- id: dsh-ray-assistant-dreaming
  name: "@dsh-ray/assistant-dreaming"
  config:
    enabled: true
    provider: agy-agent
`,
            stderr: '',
          }
        }
        return { status: 0, stdout: '0.2.2-rc.5\n', stderr: '' }
      },
    })

    expect(report.ok).toBe(false)
    const dreamCheck = report.checks.find(c => c.id === 'profile.web.dreaming')
    expect(dreamCheck?.status).toBe('fail')
    expect(dreamCheck?.summary).toContain('scope')
    expect(dreamCheck?.summary).toContain('budgetId')
  })

  test('纯 cgroup v2 已完成 dsh-native/uid-<uid> 委派时返回 ok，冻结或缺少控制器时保持 warn', async () => {
    const root = await makeTempDir('dsh-live-cgroup-v2-')
    const dshHome = join(root, 'dsh')
    const cgroupRoot = join(root, 'sys-fs-cgroup')
    const leaf = join(cgroupRoot, 'dsh-native', 'uid-1000')
    await mkdir(leaf, { recursive: true })
    await writeFile(join(cgroupRoot, 'cgroup.controllers'), 'cpu memory pids\n')
    await writeFile(join(leaf, 'cgroup.controllers'), 'cpu memory pids\n')
    await writeFile(join(leaf, 'cgroup.subtree_control'), 'cpu memory pids\n')
    await writeFile(join(leaf, 'cgroup.freeze'), '0\n')

    const okReport = await collectLiveDoctorReport({
      dshHome,
      home: root,
      platform: 'linux',
      env: { PATH: '' },
      runner: () => ({ status: 0, stdout: '0.2.2-rc.5\n', stderr: '' }),
      linuxPaths: { cgroupRoot, uid: 1000 },
    })
    const okCheck = okReport.checks.find(c => c.id === 'platform.cgroup')
    expect(okCheck?.status).toBe('ok')
    expect(okCheck?.summary).toContain('dsh-native/uid-1000')

    const explicitHostLeafReport = await collectLiveDoctorReport({
      dshHome,
      home: root,
      platform: 'linux',
      env: { PATH: '' },
      runner: () => ({ status: 0, stdout: '0.2.2-rc.5\n', stderr: '' }),
      linuxPaths: { cgroupRoot, uid: 1000, procSelfCgroup: '0::/dsh-native/uid-1000/host\n' },
    })
    const explicitHostLeafCheck = explicitHostLeafReport.checks.find(c => c.id === 'platform.cgroup')
    expect(explicitHostLeafCheck?.status).toBe('ok')
    expect(explicitHostLeafCheck?.summary).toContain('dsh-native/uid-1000')

    // When caller sits in an SSH session scope (`0::/user.slice/user-1000.slice/session-7.scope`) and only root-level standalone leaf exists without user@1000.service/dsh-native/uid-1000, warn honestly
    const sshStandaloneOnlyReport = await collectLiveDoctorReport({
      dshHome,
      home: root,
      platform: 'linux',
      env: { PATH: '' },
      runner: () => ({ status: 0, stdout: '0.2.2-rc.5\n', stderr: '' }),
      linuxPaths: { cgroupRoot, uid: 1000, procSelfCgroup: '0::/user.slice/user-1000.slice/session-7.scope\n' },
    })
    const sshStandaloneCheck = sshStandaloneOnlyReport.checks.find(c => c.id === 'platform.cgroup')
    expect(sshStandaloneCheck?.status).toBe('warn')
    expect(sshStandaloneCheck?.advice).toContain('prepare-linux-cgroups.mjs --uid 1000 --auto')

    await writeFile(join(leaf, 'cgroup.freeze'), '1\n')
    const frozenReport = await collectLiveDoctorReport({
      dshHome,
      home: root,
      platform: 'linux',
      env: { PATH: '' },
      runner: () => ({ status: 0, stdout: '0.2.2-rc.5\n', stderr: '' }),
      linuxPaths: { cgroupRoot, uid: 1000 },
    })
    const frozenCheck = frozenReport.checks.find(c => c.id === 'platform.cgroup')
    expect(frozenCheck?.status).toBe('warn')
    expect(frozenCheck?.summary).toContain('cgroup v2')
  })

  test('Electron 独占 desktop profile 直读校验 cordis.patch.yml 与 package.json 通过（含无 patch 情况）', async () => {
    const root = await makeTempDir('dsh-live-desktop-ok-')
    const dshHome = join(root, 'dsh')
    const profileDir = join(dshHome, 'profiles', 'desktop')
    await mkdir(join(profileDir, 'node_modules', '@dsh-ray', 'owner-console'), { recursive: true })
    await mkdir(join(profileDir, 'node_modules', '@dsh-ray', 'assistant-dreaming'), { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', dependencies: {} }))
    await writeFile(join(profileDir, 'cordis.patch.yml'), `- id: agent-default-model
  config:
    provider: agy-agent
    model: default
- id: dsh-ray-owner-console
  name: "@dsh-ray/owner-console"
- id: dsh-ray-assistant-dreaming
  name: "@dsh-ray/assistant-dreaming"
  config:
    enabled: false
    databasePath: !js "dshHomePath('dreaming.sqlite')"
`)

    const runner: DetailedCommandRunner = (command, args) => {
      if (command === 'dsh' && args.includes('--dump-config')) {
        return {
          status: 1,
          stdout: '',
          stderr: 'error: profile "desktop" is managed exclusively by the Electron application\n',
        }
      }
      return { status: 0, stdout: '0.2.2-rc.5\n', stderr: '' }
    }

    const report = await collectLiveDoctorReport({
      dshHome,
      home: root,
      platform: 'darwin',
      env: { PATH: '' },
      fileExists: path => path === '/usr/bin/sandbox-exec',
      runner,
    })

    expect(report.ok).toBe(true)
    expect(report.profiles[0]).toMatchObject({
      profile: 'desktop',
      configDumpOk: true,
      defaultModelRoute: { provider: 'agy-agent', model: 'default' },
      capabilities: {
        ownerConsoleInstalled: true,
        ownerConsoleEnabled: true,
        dreamingInstalled: true,
        dreamingEnabled: false,
      },
    })
    expect(report.profiles[0]?.configDumpError).toBeUndefined()
    const dumpCheck = report.checks.find(c => c.id === 'profile.desktop.dump')
    expect(dumpCheck).toMatchObject({
      status: 'ok',
      summary: 'profile desktop 由桌面端 Electron 独占托管；已直接校验 cordis.patch.yml 与 package.json',
    })

    // Missing cordis.patch.yml with valid package.json also succeeds cleanly.
    await rm(join(profileDir, 'cordis.patch.yml'))
    const noPatchReport = await collectLiveDoctorReport({
      dshHome,
      home: root,
      platform: 'darwin',
      env: { PATH: '' },
      fileExists: path => path === '/usr/bin/sandbox-exec',
      runner,
    })
    expect(noPatchReport.ok).toBe(true)
    expect(noPatchReport.profiles[0]?.configDumpOk).toBe(true)
  })

  test('Electron 独占 desktop profile 的 cordis.patch.yml / package.json 损坏、非序列或为符号链接时 fail-closed', async () => {
    const root = await makeTempDir('dsh-live-desktop-fail-')
    const dshHome = join(root, 'dsh')
    const profileDir = join(dshHome, 'profiles', 'desktop')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop' }))
    await writeFile(join(profileDir, 'cordis.patch.yml'), '- id: broken\n  config: [\n')

    const runner: DetailedCommandRunner = (command, args) => {
      if (command === 'dsh' && args.includes('--dump-config')) {
        return {
          status: 1,
          stdout: '',
          stderr: 'error: profile "desktop" is managed exclusively by the Electron application\n',
        }
      }
      return { status: 0, stdout: '0.2.2-rc.5\n', stderr: '' }
    }
    const run = () => collectLiveDoctorReport({
      dshHome,
      home: root,
      platform: 'darwin',
      env: { PATH: '' },
      fileExists: path => path === '/usr/bin/sandbox-exec',
      runner,
    })

    const badYaml = await run()
    expect(badYaml.ok).toBe(false)
    expect(badYaml.profiles[0]?.configDumpOk).toBe(false)
    expect(badYaml.checks.find(c => c.id === 'profile.desktop.dump')?.status).toBe('fail')

    await writeFile(join(profileDir, 'cordis.patch.yml'), 'notASequence: true\n')
    const badRoot = await run()
    expect(badRoot.ok).toBe(false)
    expect(badRoot.profiles[0]?.configDumpOk).toBe(false)
    expect(badRoot.checks.find(c => c.id === 'profile.desktop.dump')?.status).toBe('fail')

    const externalPatch = join(root, 'external-patch.yml')
    await writeFile(externalPatch, '[]\n')
    await rm(join(profileDir, 'cordis.patch.yml'))
    await symlink(externalPatch, join(profileDir, 'cordis.patch.yml'))
    const symlinkPatch = await run()
    expect(symlinkPatch.ok).toBe(false)
    expect(symlinkPatch.profiles[0]?.configDumpOk).toBe(false)
    expect(symlinkPatch.checks.find(c => c.id === 'profile.desktop.dump')?.status).toBe('fail')
  })

  test('读取 DSH v1 .credentials.yaml (version: 1 + refs:) 时只返回 refs 键名且绝不泄漏密钥', async () => {
    const root = await makeTempDir('dsh-live-v1-creds-')
    const dshHome = join(root, 'dsh')
    const profileDir = join(dshHome, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web' }))
    await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n')
    await writeFile(join(dshHome, '.credentials.yaml'), [
      'version: 1',
      'refs:',
      '  OPENROUTER_API_KEY: sk-or-v1-secret-value-888',
      '  DEEPSEEK_API_KEY: sk-ds-v1-secret-value-999',
      'records:',
      '  "llm-pi-ai:anthropic":',
      '    access: sk-oauth-secret-000',
      '',
    ].join('\n'), { mode: 0o600 })

    const runner: DetailedCommandRunner = () => ({ status: 0, stdout: '0.2.2-rc.5\n', stderr: '' })
    const report = await collectLiveDoctorReport({
      dshHome,
      home: root,
      platform: 'linux',
      env: { PATH: '' },
      runner,
    })

    expect(report.credentials.keyNames).toEqual(['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY'])
    expect(report.credentials.keyNames).not.toContain('version')
    expect(report.credentials.keyNames).not.toContain('refs')
    expect(report.credentials.keyNames).not.toContain('records')

    const snap = await collectStatus(dshHome, root, 'linux', runner)
    expect(snap.credentialKeys).toEqual(['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY'])
    expect(JSON.stringify(report)).not.toContain('sk-or-v1-secret-value-888')
    expect(JSON.stringify(snap)).not.toContain('sk-ds-v1-secret-value-999')
    expect(JSON.stringify(report)).not.toContain('sk-oauth-secret-000')
  })

  test('macOS desktop Electron profile 在无 .dsh-ray-host.json 与无全局 dsh (ENOENT) 时直读校验通过，并在 patch/manifest 损坏时 fail-closed', async () => {
    const root = await makeTempDir('dsh-live-electron-enoent-')
    const dshHome = join(root, 'dsh')
    const profileDir = join(dshHome, 'profiles', 'desktop')
    await mkdir(join(profileDir, 'node_modules', '@dsh-ray', 'owner-console'), { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', dependencies: {} }))
    await writeFile(join(profileDir, 'cordis.patch.yml'), `- id: dsh-ray-owner-console
  name: "@dsh-ray/owner-console"
`)

    const runner: DetailedCommandRunner = (command) => {
      if (command === 'dsh') {
        return { status: null, stdout: '', stderr: 'spawnSync dsh ENOENT' }
      }
      return { status: 0, stdout: '', stderr: '' }
    }

    const report = await collectLiveDoctorReport({
      dshHome,
      home: root,
      profile: 'desktop',
      platform: 'darwin',
      env: { PATH: '' },
      fileExists: path => path === '/usr/bin/sandbox-exec' || path === '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      runner,
    })

    expect(report.ok).toBe(true)
    expect(report.checks.find(c => c.id === 'host.bound')?.status).toBe('ok')
    expect(report.profiles[0]?.configDumpOk).toBe(true)

    // Corrupt cordis.patch.yml MUST still fail-closed even without global `dsh`.
    await writeFile(join(profileDir, 'cordis.patch.yml'), '- id: broken\n  config: [\n')
    const badReport = await collectLiveDoctorReport({
      dshHome,
      home: root,
      profile: 'desktop',
      platform: 'darwin',
      env: { PATH: '' },
      fileExists: path => path === '/usr/bin/sandbox-exec' || path === '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      runner,
    })
    expect(badReport.ok).toBe(false)
    expect(badReport.profiles[0]?.configDumpOk).toBe(false)
    expect(badReport.checks.find(c => c.id === 'profile.desktop.dump')?.status).toBe('fail')

    // Symlinked package.json MUST fail-closed even with valid cordis.patch.yml.
    await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n')
    const outsidePkg = join(root, 'outside-pkg.json')
    await writeFile(outsidePkg, JSON.stringify({ name: 'dsh-profile-desktop' }))
    await rm(join(profileDir, 'package.json'))
    await symlink(outsidePkg, join(profileDir, 'package.json'))
    const symReport = await collectLiveDoctorReport({
      dshHome,
      home: root,
      profile: 'desktop',
      platform: 'darwin',
      env: { PATH: '', DSH_DESKTOP_NODE_EXECUTABLE: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' },
      fileExists: path => path === '/usr/bin/sandbox-exec' || path === '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      runner,
    })
    expect(symReport.ok).toBe(false)
    expect(symReport.checks.some(c => c.status === 'fail' && c.id === 'profile.desktop')).toBe(true)
  })
})
