import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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
    const dump = `- id: dsh-enhanced-traex-acp-provider
  name: "@dsh-enhanced/traex-acp-provider"
  config:
    enabled: true
    command: /usr/local/bin/traex
    agyEnabled: true
    agyCommand: /usr/local/bin/agy
- id: dsh-enhanced-assistant-dreaming
  name: "@dsh-enhanced/assistant-dreaming"
  config:
    enabled: false
    scope:
      workspace: /tmp/ws
      enabled: true
    databasePath: !js "dshHomePath('dreaming.sqlite')"
`
    const rows = parseDumpConfigRows(dump)
    const acp = rows.find(row => row.id === 'dsh-enhanced-traex-acp-provider')
    expect(acp?.config.enabled).toBe(true)
    expect(acp?.config.agyEnabled).toBe(true)
    expect(acp?.config.agyCommand).toBe('/usr/local/bin/agy')

    const dreaming = rows.find(row => row.id === 'dsh-enhanced-assistant-dreaming')
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
    await writeFile(join(home, '.dsh-rsi-host.json'), JSON.stringify({
      schemaVersion: 1, cacheRoot, version: '0.2.2-rc.3', receiptDigest: digest,
    }), { mode: 0o600 })

    const ready = await inspectBoundHostRuntime(home, {
      read: async () => ({
        version: '0.2.2-rc.3',
        root: join(cacheRoot, '0.2.2-rc.3'),
        dshPath: join(cacheRoot, '0.2.2-rc.3', 'node_modules', '.bin', 'dsh'),
        binDirectory: join(cacheRoot, '0.2.2-rc.3', 'node_modules', '.bin'),
        integrity: 'sha512-x',
        receiptDigest: digest,
      }),
    })
    expect(ready.status).toBe('ready')
    expect(ready.version).toBe('0.2.2-rc.3')

    const mismatch = await inspectBoundHostRuntime(home, {
      read: async () => ({
        version: '0.2.2-rc.3',
        root: join(cacheRoot, '0.2.2-rc.3'),
        dshPath: join(cacheRoot, '0.2.2-rc.3', 'node_modules', '.bin', 'dsh'),
        binDirectory: join(cacheRoot, '0.2.2-rc.3', 'node_modules', '.bin'),
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
    await mkdir(join(dshHome, '.dsh-enhanced'), { recursive: true, mode: 0o700 })
    await mkdir(join(dshHome, 'logs'), { recursive: true })
    await mkdir(join(userHome, '.config', 'systemd', 'user'), { recursive: true })
    await mkdir(binDir, { recursive: true })
    await mkdir(boundBinDir, { recursive: true })
    for (const slug of ['owner-console', 'assistant-proactive', 'assistant-dreaming', 'assistant-web-owner', 'assistant-isolation']) {
      await mkdir(join(profileDir, 'node_modules', '@dsh-enhanced', slug), { recursive: true })
    }
    await mkdir(join(profileDir, 'node_modules', '@dsh-enhanced', 'assistant-web-owner', 'bin'), { recursive: true })
    await writeFile(join(profileDir, 'node_modules', '@dsh-enhanced', 'assistant-web-owner', 'bin', 'dsh-autonomy-doctor.js'), '')
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web' }))
    await writeFile(join(dshHome, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-super-secret-value-999\n', { mode: 0o644 })
    await writeFile(join(dshHome, '.dsh-enhanced', 'install-intent.json'), JSON.stringify({
      schemaVersion: 1, scenario: 'web', learning: 'skip', pluginPreset: 'recommended', proactive: 'on', dreaming: 'on', at: 1700000000,
    }), { mode: 0o600 })
    await writeFile(join(dshHome, 'logs', 'web-host.log'), 'dsh web: http://127.0.0.1:3080/?token=REAL_LIVE_TOKEN\n')
    await writeFile(join(userHome, '.config', 'systemd', 'user', 'dsh-profile-web.service'), '# DeepSeek Harness profile web\nExecStart=/usr/bin/dsh --profile web --no-open\n')

    const digest = 'd'.repeat(64)
    await writeFile(join(dshHome, '.dsh-rsi-host.json'), JSON.stringify({
      schemaVersion: 1, cacheRoot: join(root, 'hosts'), version: '0.2.2-rc.3', receiptDigest: digest,
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
      if (command === 'dsh' && args[0] === '--version') return { status: 0, stdout: '0.2.2-rc.3\n', stderr: '' }
      if (command === join(boundBinDir, 'dsh') && args.includes('--dump-config')) {
        return {
          status: 0,
          stdout: `- id: agent-default-model
  config:
    provider: agy-agent
    model: default
- id: dsh-enhanced-traex-acp-provider
  name: "@dsh-enhanced/traex-acp-provider"
  config:
    enabled: true
    command: ${fakeTraex}
    agyEnabled: true
    agyCommand: ${fakeAgy}
- id: dsh-enhanced-owner-console
  name: "@dsh-enhanced/owner-console"
- id: dsh-enhanced-assistant-proactive
  name: "@dsh-enhanced/assistant-proactive"
- id: dsh-enhanced-assistant-dreaming
  name: "@dsh-enhanced/assistant-dreaming"
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
          stdout: 'Autonomy readiness: READY\n' + JSON.stringify({ protocol: 'dsh-enhanced/autonomy-readiness/v1', ready: true, checks: [] }) + '\n',
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
        version: '0.2.2-rc.3',
        root: join(root, 'hosts', '0.2.2-rc.3'),
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
    expect(rendered).toContain('dsh-rsi open --profile web')

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
            stdout: `- id: dsh-enhanced-assistant-dreaming
  name: "@dsh-enhanced/assistant-dreaming"
  config:
    enabled: true
    provider: agy-agent
`,
            stderr: '',
          }
        }
        return { status: 0, stdout: '0.2.2-rc.3\n', stderr: '' }
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
      runner: () => ({ status: 0, stdout: '0.2.2-rc.3\n', stderr: '' }),
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
      runner: () => ({ status: 0, stdout: '0.2.2-rc.3\n', stderr: '' }),
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
      runner: () => ({ status: 0, stdout: '0.2.2-rc.3\n', stderr: '' }),
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
      runner: () => ({ status: 0, stdout: '0.2.2-rc.3\n', stderr: '' }),
      linuxPaths: { cgroupRoot, uid: 1000 },
    })
    const frozenCheck = frozenReport.checks.find(c => c.id === 'platform.cgroup')
    expect(frozenCheck?.status).toBe('warn')
    expect(frozenCheck?.summary).toContain('cgroup v2')
  })
})
