import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  autoUpdateLogPath,
  autoUpdateNotifyPath,
  autoUpdateStatusPath,
  checkUnattendedAutoUpgrade,
  clearAutoUpdateNotifyMarker,
  detectAutoUpdateSourceState,
  inspectPendingAutoUpdateNotification,
  launchUnattendedAutoUpgrade,
  parseAutoUpdateWorkerArgs,
  redactAutoUpdateText,
  runAutoUpdateWorker,
} from '../src/auto-update.ts'
import type { LiveDoctorReport } from '../src/doctor-live.ts'
import type { UpgradeReport } from '../src/upgrade.ts'
import { version as CLI_VERSION } from '../src/version.ts'

const cleanupDirs: string[] = []

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeHome(profile = 'web'): { root: string; dshHome: string; osHome: string; binDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cli-auto-update-'))
  cleanupDirs.push(root)
  const dshHome = join(root, 'dsh-home')
  const osHome = join(root, 'user-home')
  const binDir = join(root, 'bin')
  mkdirSync(join(dshHome, 'profiles', profile), { recursive: true })
  mkdirSync(osHome, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(dshHome, 'profiles', profile, 'package.json'), JSON.stringify({
    name: `dsh-profile-${profile}`,
    dependencies: {
      '@dsh-ray/assistant-delivery': CLI_VERSION,
    },
  }))
  return { root, dshHome, osHome, binDir }
}

function makeUpgradeReport(dshHome: string, overrides: Partial<{
  installedEnhancedVersion: string
  targetEnhancedVersion: string
  upgradeAvailable: boolean
  registryStatus: 'ok' | 'unavailable'
  boundUpgradeAvailable: boolean
  mode: UpgradeReport['mode']
}> = {}): { report: UpgradeReport; exitCode: number } {
  const installed = overrides.installedEnhancedVersion ?? CLI_VERSION
  const target = overrides.targetEnhancedVersion ?? CLI_VERSION
  return {
    exitCode: 0,
    report: {
      schemaVersion: 1,
      command: 'upgrade',
      action: 'check',
      ok: true,
      ready: true,
      dshHome,
      mode: overrides.mode ?? 'standard-local',
      frozenSystemd: { detected: false, profiles: [] },
      packages: {
        cliPackageVersion: CLI_VERSION,
        installedEnhancedVersion: installed,
        targetEnhancedVersion: target,
        upgradeAvailable: overrides.upgradeAvailable ?? false,
        boundHost: {
          status: 'ready',
          installedVersion: '0.2.2',
          targetVersion: '0.2.2',
          upgradeAvailable: overrides.boundUpgradeAvailable ?? false,
        },
        profiles: [],
      },
      registry: {
        url: 'https://registry.npmjs.org',
        checked: true,
        status: overrides.registryStatus ?? 'ok',
        latestEnhancedVersion: target,
        latestDshHostVersion: '0.2.2',
      },
      readiness: {
        ok: true,
        bindingOk: true,
        ledgersOk: true,
        profiles: [],
        blockedReasons: [],
      },
      plan: {
        canExecute: true,
        steps: [],
        rollbackSupported: true,
        backupFiles: [],
      },
    },
  }
}

function makeDoctorReport(dshHome: string, ok = true, serviceActive = true): LiveDoctorReport {
  return {
    schemaVersion: 1,
    checkedAt: '2026-11-27T12:00:00.000Z',
    ok,
    platform: 'linux',
    dshHome,
    summary: { ok: ok ? 5 : 4, warn: 0, fail: ok ? 0 : 1, skip: 0 },
    status: {
      dshHome,
      exists: true,
      profileCount: 1,
      profiles: [],
      serviceCount: 1,
      runningHostCount: serviceActive ? 1 : 0,
      pendingRecoveryCount: 0,
      installIntent: undefined,
    } as unknown as LiveDoctorReport['status'],
    boundHost: { status: 'ready', bindingPath: join(dshHome, '.dsh-ray-host.json'), issues: [] } as unknown as LiveDoctorReport['boundHost'],
    credentials: {
      filePath: join(dshHome, '.credentials.yaml'),
      fileExists: true,
      keyNames: ['DEEPSEEK_API_KEY'],
      envVariablesPresent: [],
      externalLocatorsCount: 0,
      insecurePermissions: false,
    },
    agentTools: {
      traex: { found: true, detail: 'ok' },
      agy: { found: false, detail: 'missing' },
    },
    prerequisites: [],
    profiles: [
      {
        profile: 'web',
        pluginsCount: 10,
        serviceInstalled: true,
        serviceActive,
        configDumpOk: true,
        providers: { traexConfigured: false, traexEnabled: false, agyConfigured: false, agyEnabled: false },
        capabilities: {
          ownerConsoleInstalled: true,
          proactiveInstalled: true,
          dreamingInstalled: true,
          dreamingMissingPrerequisites: [],
          growthInstalled: true,
          memoryLearningInstalled: true,
        },
        webUrl: {},
      },
    ],
    logFindings: [],
    checks: ok ? [] : [{ id: 'profile.web', category: 'profile', status: 'fail', summary: 'web service down' }],
  }
}

describe('packages/cli auto-update shared runtime', () => {
  test('redacts tokens, bearer secrets, and API keys cleanly', () => {
    const raw = 'https://host/?token=secret123 Bearer abc.def.ghi apiKey=sk-1234567890abcd appSecret="fooSecret"'
    const redacted = redactAutoUpdateText(raw)
    expect(redacted).not.toContain('secret123')
    expect(redacted).not.toContain('abc.def.ghi')
    expect(redacted).not.toContain('sk-1234567890abcd')
    expect(redacted).not.toContain('fooSecret')
    expect(redacted).toContain('<redacted>')
  })

  test('returns immediate up-to-date message when latest version, clean cohorts, and healthy doctor all pass', async () => {
    const { dshHome, osHome, binDir } = makeHome('web')
    const spawnDetached = vi.fn(() => 999)

    const check = await checkUnattendedAutoUpgrade({
      dshHome,
      profile: 'web',
      platform: 'linux',
      osHome,
      env: { HOME: osHome, PATH: binDir },
    }, {
      runUpgrade: async () => makeUpgradeReport(dshHome, {
        installedEnhancedVersion: '0.2.2',
        targetEnhancedVersion: '0.2.2',
        upgradeAvailable: false,
      }),
      collectDoctor: async () => makeDoctorReport(dshHome, true, true),
    })
    expect(check.upToDateAndHealthy).toBe(true)

    const result = await launchUnattendedAutoUpgrade({
      dshHome,
      profile: 'web',
      platform: 'linux',
      osHome,
      env: { HOME: osHome, PATH: binDir },
    }, {
      runUpgrade: async () => makeUpgradeReport(dshHome, {
        installedEnhancedVersion: '0.2.2',
        targetEnhancedVersion: '0.2.2',
        upgradeAvailable: false,
      }),
      collectDoctor: async () => makeDoctorReport(dshHome, true, true),
      spawnDetached,
    })

    expect(result.ok).toBe(true)
    expect(result.alreadyCurrent).toBe(true)
    expect(result.started).toBe(false)
    expect(result.message).toBe('当前已是最新版本 v0.2.2 且服务运行正常，无需升级。')
    expect(spawnDetached).not.toHaveBeenCalled()
  })

  test('detects rsi-local-cohorts/<profile> and non-null .rsi-coordinator-*.json sourceRepository and launches out-of-cgroup systemd-run with --to-npm', async () => {
    const { dshHome, osHome, binDir } = makeHome('web')
    mkdirSync(join(dshHome, 'rsi-local-cohorts', 'web'), { recursive: true })
    writeFileSync(join(dshHome, '.rsi-coordinator-4b5e57f6eb2f42b9.json'), JSON.stringify({
      schemaVersion: 1,
      targetProfile: 'web',
      coordinatorProfile: 'rsi-web-4b5e57f6eb2f42b9',
      version: '0.2.0',
      sourceRepository: '/data00/repo/dsh-ray',
    }))

    const sourceState = await detectAutoUpdateSourceState(dshHome, 'web')
    expect(sourceState.needsToNpm).toBe(true)
    expect(sourceState.hasCohortDir).toBe(true)
    expect(sourceState.hasSourceBoundCoordinator).toBe(true)

    const systemdCalls: Array<{ cmd: string; args: readonly string[] }> = []
    const detailedRunner = vi.fn((cmd: string, args: readonly string[]) => {
      if (cmd.endsWith('systemd-run')) {
        systemdCalls.push({ cmd, args })
        return { status: 0, stdout: '', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    })

    const result = await launchUnattendedAutoUpgrade({
      dshHome,
      profile: 'web',
      platform: 'linux',
      osHome,
      env: { HOME: osHome, PATH: binDir, XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
      notify: {
        channel: 'lark',
        account: 'primary',
        chatId: 'oc_chat_1',
        conversation: { kind: 'dm', chat: 'oc_chat_1' },
        principal: { channel: 'lark', account: 'primary', tenant: 't1', user: 'ou_1' },
        ownerPrincipal: 'lark:primary:t1:ou_1',
      },
    }, {
      now: () => 1_760_000_000_000,
      runUpgrade: async () => makeUpgradeReport(dshHome, {
        installedEnhancedVersion: '0.2.0',
        targetEnhancedVersion: '0.2.2',
        upgradeAvailable: true,
      }),
      collectDoctor: async () => makeDoctorReport(dshHome, true, true),
      inspectService: async () => ({ managed: true, definitionPath: join(osHome, '.config/systemd/user/dsh-profile-web.service'), foreign: false }),
      resolveTargets: async () => ['web'],
      detailedRunner,
      nodeExecutable: '/usr/bin/node',
      runnerScriptPath: '/opt/dsh-ray/lib/auto-update-runner.js',
    })

    expect(result.ok).toBe(true)
    expect(result.started).toBe(true)
    expect(result.background).toBe(true)
    expect(result.launcher).toBe('systemd-run')
    expect(result.toNpm).toBe(true)
    expect(result.unitName).toBe('dsh-ray-auto-update-1760000000000')
    expect(result.message).toBe('🔄 已启动后台自动升级与服务恢复（v0.2.0 -> v0.2.2），完成后服务将自动重启恢复并通知结果，全程无需人工干预。')

    expect(systemdCalls).toHaveLength(1)
    const runArgs = systemdCalls[0]!.args
    expect(runArgs).toContain('--user')
    expect(runArgs).toContain('--collect')
    expect(runArgs).toContain('--no-block')
    expect(runArgs).toContain('--unit=dsh-ray-auto-update-1760000000000')
    expect(runArgs).toContain('--setenv=CI=true')
    expect(runArgs).toContain(`--setenv=DSH_HOME=${dshHome}`)
    expect(runArgs).toContain('/usr/bin/node')
    expect(runArgs).toContain('/opt/dsh-ray/lib/auto-update-runner.js')
    expect(runArgs).toContain('--to-npm')

    const notifyPath = autoUpdateNotifyPath(dshHome)
    expect(statSync(notifyPath).mode & 0o777).toBe(0o600)
    const notifyJson = JSON.parse(readFileSync(notifyPath, 'utf8')) as Record<string, unknown>
    expect(notifyJson).toMatchObject({
      schemaVersion: 1,
      channel: 'lark',
      account: 'primary',
      chatId: 'oc_chat_1',
      ownerPrincipal: 'lark:primary:t1:ou_1',
      profile: 'web',
      fromVersion: '0.2.0',
      targetVersion: '0.2.2',
    })

    const statusJson = JSON.parse(readFileSync(autoUpdateStatusPath(dshHome), 'utf8')) as Record<string, unknown>
    expect(statusJson.status).toBe('pending')
    expect(statusJson.launcher).toBe('systemd-run')
    expect(statSync(autoUpdateStatusPath(dshHome)).mode & 0o777).toBe(0o600)
  })

  test('falls back to detached spawn on macOS/non-systemd when upgrade or doctor recovery is needed', async () => {
    const { dshHome, osHome, binDir } = makeHome('web')
    const detachedCalls: Array<{ cmd: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = []

    const result = await launchUnattendedAutoUpgrade({
      dshHome,
      profile: 'web',
      platform: 'darwin',
      osHome,
      env: { HOME: osHome, PATH: binDir },
    }, {
      now: () => 1_760_000_001_000,
      runUpgrade: async () => makeUpgradeReport(dshHome, {
        installedEnhancedVersion: '0.2.2',
        targetEnhancedVersion: '0.2.2',
        upgradeAvailable: false,
      }),
      // Doctor reports unhealthy service even though versions match -> triggers service recovery!
      collectDoctor: async () => makeDoctorReport(dshHome, false, false),
      spawnDetached: (cmd, args, spawnEnv) => {
        detachedCalls.push({ cmd, args, env: spawnEnv })
        return 4242
      },
      nodeExecutable: '/usr/local/bin/node',
      runnerScriptPath: '/opt/dsh-ray/lib/auto-update-runner.js',
    })

    expect(result.ok).toBe(true)
    expect(result.started).toBe(true)
    expect(result.launcher).toBe('detached')
    expect(result.pid).toBe(4242)
    expect(detachedCalls).toHaveLength(1)
    expect(detachedCalls[0]!.env.CI).toBe('true')
    expect(detachedCalls[0]!.args).not.toContain('--to-npm')
  })

  test('runAutoUpdateWorker waits before stop, runs npm/update --all --yes --to-npm, verifies doctor + service restart, writes 0600 status/log, and reconciles completion/failure', async () => {
    const { dshHome, osHome, binDir } = makeHome('web')
    mkdirSync(join(dshHome, 'rsi-local-cohorts', 'web'), { recursive: true })
    writeFileSync(join(dshHome, '.rsi-coordinator-4b5e57f6eb2f42b9.json'), JSON.stringify({
      schemaVersion: 1,
      targetProfile: 'web',
      coordinatorProfile: 'rsi-web-4b5e57f6eb2f42b9',
      version: '0.2.0',
      sourceRepository: '/data00/repo/dsh-ray',
    }))

    const sleepCalls: number[] = []
    const invokedCmds: Array<{ cmd: string; args: readonly string[] }> = []
    const controlCalls: Array<{ prof: string; action: string }> = []
    let slept = false
    const runId = 'auto-update-1760000002000-deadbeef'

    mkdirSync(join(dshHome, '.dsh-ray'), { recursive: true, mode: 0o700 })
    writeFileSync(autoUpdateNotifyPath(dshHome), JSON.stringify({
      schemaVersion: 1,
      runId,
      channel: 'lark',
      account: 'primary',
      chatId: 'oc_123',
      requestedAt: '2026-11-27T12:00:00.000Z',
    }), { mode: 0o600 })

    // Create a fake dsh-ray in binDir returning older version 0.2.0 first, then 0.2.2 after npm install -g
    const fakeDshRay = join(binDir, 'dsh-ray')
    writeFileSync(fakeDshRay, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    let installedUpdated = false

    const exitCode = await runAutoUpdateWorker(parseAutoUpdateWorkerArgs([
      '--dsh-home', dshHome,
      '--run-id', runId,
      '--profile', 'web',
      '--to-npm',
      '--target-version', '0.2.2',
      '--delay-ms', '2500',
    ], { HOME: osHome, PATH: binDir }), {
      sleep: async (ms) => {
        sleepCalls.push(ms)
        slept = true
      },
      detailedRunner: (cmd, args, opts) => {
        invokedCmds.push({ cmd, args })
        expect(slept).toBe(true)
        if (cmd.endsWith('npm') && args[0] === 'install') {
          installedUpdated = true
          return { status: 0, stdout: '+ @dsh-ray/cli@0.2.2', stderr: '' }
        }
        if (cmd === fakeDshRay && args[0] === '--version') {
          return { status: 0, stdout: installedUpdated ? '0.2.2' : '0.2.0', stderr: '' }
        }
        if (cmd === fakeDshRay && args[0] === 'update') {
          expect(opts?.env?.CI).toBe('true')
          expect(args).toContain('--all')
          expect(args).toContain('--yes')
          expect(args).toContain('--to-npm')
          // Simulate profile upgraded to 0.2.2
          mkdirSync(join(dshHome, 'profiles', 'web', 'node_modules', '@dsh-ray', 'assistant-delivery'), { recursive: true })
          writeFileSync(join(dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({
            name: 'dsh-profile-web',
            dependencies: { '@dsh-ray/assistant-delivery': '0.2.2' },
          }))
          writeFileSync(join(dshHome, 'profiles', 'web', 'node_modules', '@dsh-ray', 'assistant-delivery', 'package.json'), JSON.stringify({
            name: '@dsh-ray/assistant-delivery',
            version: '0.2.2',
          }))
          return { status: 0, stdout: 'upgraded token=topsecret', stderr: '' }
        }
        if (cmd === fakeDshRay && args[0] === 'doctor') {
          return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: '' }
        }
        if (cmd === 'systemctl' && args[1] === 'is-active') {
          return { status: 0, stdout: 'active\n', stderr: '' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
      runner: (cmd, args) => {
        if (cmd === 'systemctl' && args[1] === 'is-active') {
          return { status: 0, stdout: 'active\n', stderr: '' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
      inspectService: async () => ({ managed: true, definitionPath: '/tmp/u', foreign: false }),
      controlService: async (_plat, _home, prof, action) => {
        controlCalls.push({ prof, action })
        return { profile: prof, actions: [action], messages: ['ok'], errors: [] }
      },
      resolveTargets: async () => ['web'],
    })

    // Ensure profile package version file wasn't overwritten by empty string above; check status/log & reconcile
    expect(sleepCalls).toEqual([2500])
    expect(invokedCmds.some(c => c.cmd.endsWith('npm') && c.args.includes('@dsh-ray/cli@0.2.2'))).toBe(true)
    expect(invokedCmds.some(c => c.cmd === fakeDshRay && c.args[0] === 'update' && c.args.includes('--to-npm'))).toBe(true)
    expect(invokedCmds.some(c => c.cmd === fakeDshRay && c.args[0] === 'doctor' && c.args.includes('web'))).toBe(true)
    expect(controlCalls).toContainEqual({ prof: 'web', action: 'restart' })
    expect(exitCode).toBe(0)

    const status = JSON.parse(readFileSync(autoUpdateStatusPath(dshHome), 'utf8')) as {
      status: string
      version: string
    }
    expect(status.status).toBe('succeeded')
    expect(statSync(autoUpdateLogPath(dshHome)).mode & 0o777).toBe(0o600)
    const logContent = readFileSync(autoUpdateLogPath(dshHome), 'utf8')
    expect(logContent).not.toContain('topsecret')
    expect(logContent).toContain('<redacted>')

    const notice = await inspectPendingAutoUpdateNotification(dshHome)
    expect(notice?.ready).toBe(true)
    expect(notice?.status).toBe('succeeded')
    expect(notice?.message).toMatch(/^✅ 自动升级完成：当前版本 v.*，服务已恢复运行。$/u)
    expect(await clearAutoUpdateNotifyMarker(dshHome, runId)).toBe(true)
    expect(await inspectPendingAutoUpdateNotification(dshHome)).toBeUndefined()
  })

  test('records redacted failed status and recovers service when update fails & rolls back, and rejects symlinked marker', async () => {
    const { root, dshHome, binDir } = makeHome('web')
    const fakeDshRay = join(binDir, 'dsh-ray')
    writeFileSync(fakeDshRay, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const runId = 'auto-update-fail-1'
    mkdirSync(join(dshHome, '.dsh-ray'), { recursive: true, mode: 0o700 })
    writeFileSync(autoUpdateNotifyPath(dshHome), JSON.stringify({
      schemaVersion: 1,
      runId,
      requestedAt: '2026-11-27T12:00:00.000Z',
    }), { mode: 0o600 })

    const startCalls: string[] = []
    let activeNow = false
    const code = await runAutoUpdateWorker({
      dshHome,
      runId,
      profile: 'web',
      delayMs: 0,
      env: { HOME: root, PATH: binDir },
    }, {
      detailedRunner: (cmd, args) => {
        if (cmd === fakeDshRay && args[0] === '--version') return { status: 0, stdout: CLI_VERSION, stderr: '' }
        if (cmd === fakeDshRay && args[0] === 'update') {
          return { status: 1, stdout: '', stderr: 'rollback applied: Bearer secretTok999' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
      runner: () => ({ status: activeNow ? 0 : 3, stdout: activeNow ? 'active\n' : 'inactive\n', stderr: '' }),
      inspectService: async () => ({ managed: true, definitionPath: '/tmp/u', foreign: false }),
      controlService: async (_p, _h, prof, action) => {
        startCalls.push(`${prof}:${action}`)
        activeNow = true
        return { profile: prof, actions: [action], messages: [], errors: [] }
      },
      resolveTargets: async () => ['web'],
    })

    expect(code).toBe(1)
    expect(startCalls).toContain('web:start')

    const notice = await inspectPendingAutoUpdateNotification(dshHome)
    expect(notice?.ready).toBe(true)
    expect(notice?.status).toBe('failed')
    expect(notice?.message).toContain('⚠️ 自动升级失败并已回滚保护：')
    expect(notice?.message).not.toContain('secretTok999')

    // Symlinked notify marker is rejected safely.
    const symlinkTarget = join(root, 'outside.json')
    writeFileSync(symlinkTarget, '{}', { mode: 0o600 })
    rmSync(autoUpdateNotifyPath(dshHome), { force: true })
    symlinkSync(symlinkTarget, autoUpdateNotifyPath(dshHome))
    expect(await inspectPendingAutoUpdateNotification(dshHome)).toBeUndefined()
  })

  test('pure-npm runAutoUpdateWorker omits --allow-non-empty-history-migration when updating', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const os = await import('node:os')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auto-update-pure-npm-'))
    try {
      const dshHome = path.join(root, 'dsh-home')
      const osHome = path.join(root, 'os-home')
      const binDir = path.join(root, 'bin')
      fs.mkdirSync(path.join(dshHome, 'profiles', 'web', '.dsh'), { recursive: true })
      fs.mkdirSync(osHome, { recursive: true })
      fs.mkdirSync(binDir, { recursive: true })
      const fakeBin = path.join(binDir, 'dsh-ray')
      fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

      const invocations: Array<{ cmd: string; args: readonly string[] }> = []
      const code = await runAutoUpdateWorker({
        dshHome,
        profile: 'web',
        runId: 'pure-npm-run',
        toNpm: false,
        delayMs: 0,
        platform: 'linux',
        osHome,
        env: { PATH: `${binDir}:/usr/bin:/bin` },
      }, {
        sleep: async () => {},
        detailedRunner: (cmd, args) => {
          invocations.push({ cmd, args })
          if (args.includes('--version')) return { status: 0, stdout: '0.2.2\n', stderr: '', signal: null }
          if (args.includes('doctor')) return { status: 0, stdout: JSON.stringify({ ok: true, checks: [] }), stderr: '', signal: null }
          return { status: 0, stdout: 'updated\n', stderr: '', signal: null }
        },
        inspectService: async () => ({ managed: false, definitionPath: '/tmp/none.service', foreign: false }),
        controlService: async () => ({ ok: true, skipped: [] }) as never,
        resolveTargets: async () => ['web'],
      })

      expect(code).toBe(0)
      const updateCall = invocations.find(call => call.args.includes('update'))
      expect(updateCall).toBeDefined()
      expect(updateCall?.args).toContain('--all')
      expect(updateCall?.args).toContain('--yes')
      expect(updateCall?.args).not.toContain('--to-npm')
      expect(updateCall?.args).not.toContain('--allow-non-empty-history-migration')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('launchUnattendedAutoUpgrade repairs Linux session env for runner/inspectService and skips non-chat notify markers', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const os = await import('node:os')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auto-update-linux-env-'))
    try {
      const dshHome = path.join(root, 'dsh-home')
      const osHome = path.join(root, 'os-home')
      fs.mkdirSync(path.join(dshHome, 'profiles', 'web', '.dsh'), { recursive: true })
      fs.mkdirSync(osHome, { recursive: true })
      const uid = process.getuid?.() ?? 1000
      const expectedRuntimeDir = `/run/user/${uid}`
      const expectedDbusAddr = `unix:path=${expectedRuntimeDir}/bus`

      const detailedEnvs: Array<{ cmd: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = []
      const inspectEnvs: Array<string | undefined> = []
      const spawnEnvs: Array<NodeJS.ProcessEnv | undefined> = []

      const makeCheckResult = () => ({
        exitCode: 0,
        report: {
          schemaVersion: 1 as const,
          command: 'upgrade' as const,
          action: 'check' as const,
          ok: true,
          ready: true,
          dshHome,
          mode: 'standard-local' as const,
          frozenSystemd: { detected: false, profiles: [] },
          packages: {
            cliPackageVersion: '0.2.2',
            installedEnhancedVersion: '0.2.0',
            targetEnhancedVersion: '0.2.2',
            upgradeAvailable: true,
            boundHost: { status: 'ready' as const, upgradeAvailable: false },
            profiles: [],
          },
          registry: { url: 'https://registry.npmjs.org', checked: true, status: 'ok' as const, latestEnhancedVersion: '0.2.2' },
          readiness: { ok: true, bindingOk: true, ledgersOk: true, profiles: [], blockedReasons: [] },
          plan: { canExecute: true, steps: [], rollbackSupported: true, backupFiles: [] },
        },
      })

      // 1. Omitted notify + omitted XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS
      const resNoNotify = await launchUnattendedAutoUpgrade({
        dshHome,
        profile: 'web',
        platform: 'linux',
        osHome,
        env: { PATH: '/usr/bin:/bin' },
      }, {
        runUpgrade: async () => makeCheckResult(),
        collectDoctor: async () => ({ ok: true, profiles: [] }) as never,
        checkPathExists: target => target === expectedRuntimeDir || target === `${expectedRuntimeDir}/bus`,
        detailedRunner: (cmd, args, opts) => {
          detailedEnvs.push({ cmd, args, env: opts?.env })
          return { status: 0, stdout: 'active\n', stderr: '', signal: null }
        },
        inspectService: async (_platform, _home, _profile, _dsh, svcRunner) => {
          inspectEnvs.push(svcRunner?.('systemctl', ['--user', 'show-environment']).stdout)
          return {
            managed: true,
            definitionPath: path.join(osHome, '.config/systemd/user/dsh-profile-web.service'),
            foreign: false,
          }
        },
        spawnDetached: (_cmd, _args, spawnEnv) => {
          spawnEnvs.push(spawnEnv)
          return 43210
        },
        runnerScriptPath: '/opt/dsh-ray/lib/auto-update-runner.js',
        nodeExecutable: '/usr/bin/node',
      })

      expect(resNoNotify.ok).toBe(true)
      expect(resNoNotify.started).toBe(true)
      expect(resNoNotify.launcher).toBe('systemd-run')
      expect(fs.existsSync(autoUpdateNotifyPath(dshHome))).toBe(false)
      expect(inspectEnvs).toHaveLength(1)
      expect(detailedEnvs.length).toBeGreaterThanOrEqual(3)
      for (const call of detailedEnvs) {
        expect(call.env?.XDG_RUNTIME_DIR).toBe(expectedRuntimeDir)
        expect(call.env?.DBUS_SESSION_BUS_ADDRESS).toBe(expectedDbusAddr)
      }
      const systemdRunCall = detailedEnvs.find(call => call.cmd.endsWith('systemd-run'))
      expect(systemdRunCall?.args).toContain(`--setenv=XDG_RUNTIME_DIR=${expectedRuntimeDir}`)
      expect(systemdRunCall?.args).toContain(`--setenv=DBUS_SESSION_BUS_ADDRESS=${expectedDbusAddr}`)

      // 2. Web notify without chat target also skips writing auto-update-notify.json
      const dshHomeWebOnly = path.join(root, 'dsh-home-web-only')
      fs.mkdirSync(path.join(dshHomeWebOnly, 'profiles', 'web', '.dsh'), { recursive: true })
      const resWebOnly = await launchUnattendedAutoUpgrade({
        dshHome: dshHomeWebOnly,
        profile: 'web',
        platform: 'linux',
        osHome,
        env: { PATH: '/usr/bin:/bin' },
        notify: { channel: 'web', account: 'owner-console' },
      }, {
        runUpgrade: async () => makeCheckResult(),
        collectDoctor: async () => ({ ok: true, profiles: [] }) as never,
        checkPathExists: () => false,
        detailedRunner: () => ({ status: 1, stdout: '', stderr: '', signal: null }),
        inspectService: async () => ({ managed: false, definitionPath: '/tmp/none.service', foreign: false }),
        spawnDetached: (_cmd, _args, spawnEnv) => {
          spawnEnvs.push(spawnEnv)
          return 43211
        },
        runnerScriptPath: '/opt/dsh-ray/lib/auto-update-runner.js',
        nodeExecutable: '/usr/bin/node',
      })
      expect(resWebOnly.ok).toBe(true)
      expect(resWebOnly.started).toBe(true)
      expect(resWebOnly.launcher).toBe('detached')
      expect(fs.existsSync(autoUpdateNotifyPath(dshHomeWebOnly))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
