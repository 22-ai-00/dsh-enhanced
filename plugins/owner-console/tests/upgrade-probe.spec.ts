import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OwnerConsoleService } from '../src/service.js'
import {
  buildUpgradeProbeEnv, compareSemver, discoverDshRayBinary, discoverToolRuntimeBinary,
  readBoundHostMetadata, SelfUpgradeProber,
} from '../src/upgrade-probe.js'

function makeHost(dshHome: string, profileName = 'web') {
  const profileDir = join(dshHome, 'profiles', profileName)
  mkdirSync(profileDir, { recursive: true })
  const services = new Map<string, unknown>([
    ['profileContext', { dir: profileDir, home: dshHome, name: profileName }],
  ])
  return {
    get: (name: string) => services.get(name),
  }
}

describe('upgrade-probe & SelfUpgradeProber', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('compares SemVer including prerelease tags accurately', () => {
    expect(compareSemver('0.1.74', '0.1.73')).toBe(1)
    expect(compareSemver('0.1.73', '0.1.74')).toBe(-1)
    expect(compareSemver('0.1.74', '0.1.74')).toBe(0)
    expect(compareSemver('0.1.74', '0.1.74-rc.1')).toBe(1)
    expect(compareSemver('0.1.74-rc.2', '0.1.74-rc.1')).toBe(1)
  })

  it('reads .dsh-ray-host.json safely and rejects world-readable or symlinked files', () => {
    const root = mkdtempSync(join(tmpdir(), 'owner-console-upg-meta-'))
    dirs.push(root)
    const metaPath = join(root, '.dsh-ray-host.json')

    expect(readBoundHostMetadata(root).status).toBe('missing')

    writeFileSync(metaPath, JSON.stringify({
      schemaVersion: 1,
      cacheRoot: join(root, 'cache'),
      version: '0.2.99',
      receiptDigest: 'a'.repeat(64),
    }), { encoding: 'utf8', mode: 0o600 })
    const valid = readBoundHostMetadata(root)
    expect(valid.status).toBe('ready')
    expect(valid.version).toBe('0.2.99')

    chmodSync(metaPath, 0o644)
    expect(readBoundHostMetadata(root).status).toBe('corrupt')

    rmSync(metaPath)
    const outside = join(root, 'outside.json')
    writeFileSync(outside, '{}', { encoding: 'utf8', mode: 0o600 })
    symlinkSync(outside, metaPath)
    expect(readBoundHostMetadata(root).status).toBe('unreadable')
  })

  it('parses dsh-ray upgrade --check --json, caches within TTL, deduplicates inflight calls, and bypasses cache when forced', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'owner-console-upg-check-'))
    dirs.push(dshHome)
    const host = makeHost(dshHome)
    let nowMs = 1_760_000_000_000
    let execCount = 0

    const prober = new SelfUpgradeProber({
      currentVersion: '0.1.73',
      platform: 'darwin',
      now: () => nowMs,
      ttlMs: 60_000,
      execFn: async () => {
        execCount++
        await new Promise(r => setTimeout(r, 15))
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            command: 'upgrade',
            action: 'check',
            ok: true,
            ready: true,
            dshHome,
            selectedProfile: 'web',
            mode: 'macos-launchd',
            frozenSystemd: { detected: false, profiles: [] },
            packages: {
              cliPackageVersion: '0.1.74',
              installedEnhancedVersion: '0.1.73',
              targetEnhancedVersion: '0.1.75',
              upgradeAvailable: true,
              boundHost: { status: 'ready', installedVersion: '0.2.10', targetVersion: '0.2.11', upgradeAvailable: true },
              profiles: [],
            },
            registry: { url: 'https://registry.npmjs.org', checked: true, status: 'ok', latestEnhancedVersion: '0.1.75', latestDshHostVersion: '0.2.11' },
            readiness: { ok: true, bindingOk: true, ledgersOk: true, profiles: [], blockedReasons: [] },
            plan: { canExecute: true, steps: ['backup', 'npm install', 'verify'], rollbackSupported: true, backupFiles: ['cordis.patch.yml'] },
          }),
          stderr: '',
          exitCode: 0,
        }
      },
    })

    const [a, b] = await Promise.all([prober.check(host), prober.check(host)])
    expect(execCount).toBe(1)
    expect(a.enhancedUpdateAvailable).toBe(true)
    expect(a.latestEnhancedVersion).toBe('0.1.75')
    expect(a.boundHostVersion).toBe('0.2.10')
    expect(a.targetHostVersion).toBe('0.2.11')
    expect(a.canTriggerDetached).toBe(true)
    expect(b.cached).toBe(false)

    nowMs += 10_000
    const cached = await prober.check(host, false)
    expect(cached.cached).toBe(true)
    expect(execCount).toBe(1)

    const forced = await prober.check(host, true)
    expect(forced.cached).toBe(false)
    expect(execCount).toBe(2)
  })

  it('falls back cleanly to npm registry or offline mode when dsh-ray CLI is absent', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'owner-console-upg-offline-'))
    dirs.push(dshHome)
    writeFileSync(join(dshHome, '.dsh-ray-host.json'), JSON.stringify({
      schemaVersion: 1,
      cacheRoot: join(dshHome, 'cache'),
      version: '0.2.12',
      receiptDigest: 'b'.repeat(64),
    }), { encoding: 'utf8', mode: 0o600 })
    const host = makeHost(dshHome)

    const registryProber = new SelfUpgradeProber({
      currentVersion: '0.1.73',
      platform: 'darwin',
      execFn: async () => ({ stdout: '', stderr: 'spawn dsh-ray ENOENT', exitCode: 127, errorCode: 'ENOENT' }),
      fetchFn: async () => new Response(JSON.stringify({ version: '0.1.76' }), { status: 200 }),
    })
    const reg = await registryProber.check(host, true)
    expect(reg.checkSource).toBe('npm-registry')
    expect(reg.offline).toBe(false)
    expect(reg.latestEnhancedVersion).toBe('0.1.76')
    expect(reg.enhancedUpdateAvailable).toBe(true)
    expect(reg.boundHostVersion).toBe('0.2.12')
    expect(reg.canTriggerDetached).toBe(false)

    const offlineProber = new SelfUpgradeProber({
      currentVersion: '0.1.73',
      platform: 'darwin',
      execFn: async () => ({ stdout: '', stderr: 'ENOENT', exitCode: 127, errorCode: 'ENOENT' }),
      fetchFn: async () => { throw new Error('ETIMEDOUT') },
    })
    const off = await offlineProber.check(host, true)
    expect(off.checkSource).toBe('offline')
    expect(off.offline).toBe(true)
    expect(off.boundHostVersion).toBe('0.2.12')
  })

  it('refuses detached self-upgrade on frozen Linux systemd profiles and surfaces out-of-band CLI guide', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'owner-console-upg-frozen-'))
    dirs.push(dshHome)
    mkdirSync(join(dshHome, 'rsi-local-cohorts', 'web'), { recursive: true })
    writeFileSync(join(dshHome, 'rsi-local-cohorts', 'web', 'receipt.json'), '{"profile":"web"}', { encoding: 'utf8', mode: 0o600 })
    const host = makeHost(dshHome, 'web')

    const spawnSpy = vi.fn()
    const prober = new SelfUpgradeProber({
      currentVersion: '0.1.73',
      platform: 'linux',
      spawnFn: spawnSpy,
      execFn: async (_cmd, args) => ({
        stdout: JSON.stringify({
          schemaVersion: 1,
          command: 'upgrade',
          action: args.includes('--dry-run') ? 'dry-run' : 'check',
          ok: true,
          ready: true,
          mode: 'frozen-linux-systemd',
          frozenSystemd: { detected: true, profiles: ['web'], targetDshVersion: '0.2.15' },
          packages: {
            cliPackageVersion: '0.1.74',
            installedEnhancedVersion: '0.1.73',
            targetEnhancedVersion: '0.1.74',
            upgradeAvailable: true,
            boundHost: { status: 'ready', installedVersion: '0.2.14', targetVersion: '0.2.15', upgradeAvailable: true },
            profiles: [],
          },
          registry: { url: 'https://registry.npmjs.org', checked: true, status: 'ok', latestEnhancedVersion: '0.1.74', latestDshHostVersion: '0.2.15' },
          readiness: { ok: true, bindingOk: true, ledgersOk: true, profiles: [], blockedReasons: [] },
          plan: { canExecute: false, steps: ['stop systemd unit', 'run upgrade-program.mjs'], rollbackSupported: true, backupFiles: [] },
        }),
        stderr: '',
        exitCode: 0,
      }),
    })

    const status = await prober.check(host)
    expect(status.frozenSystemdProfile).toBe(true)
    expect(status.canTriggerDetached).toBe(false)
    expect(status.upgradeCommand).toContain('upgrade-program.mjs')

    const preview = await prober.dryRun(host)
    expect(preview.frozenSystemdProfile).toBe(true)
    expect(preview.requiresOutOfBandCli).toBe(true)
    expect(preview.supported).toBe(false)

    const triggered = await prober.trigger(host, true)
    expect(triggered.applied).toBe(false)
    expect(triggered.note).toContain('systemd')
    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it('requires explicit confirmation, runs preflight dry-run, and spawns detached dsh-ray upgrade --yes cleanly', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'owner-console-upg-spawn-'))
    dirs.push(dshHome)
    const host = makeHost(dshHome, 'web')
    const unrefSpy = vi.fn()
    const spawnSpy = vi.fn(() => ({ pid: 42424, unref: unrefSpy }))

    const prober = new SelfUpgradeProber({
      currentVersion: '0.1.73',
      platform: 'darwin',
      now: () => 1_760_000_000_123,
      env: { HOME: '/Users/test', PATH: '/usr/bin:/bin', DEEPSEEK_API_KEY: 'sk-never-leak' },
      spawnFn: spawnSpy,
      execFn: async (_cmd, args) => ({
        stdout: JSON.stringify({
          schemaVersion: 1,
          command: 'upgrade',
          action: args.includes('--dry-run') ? 'dry-run' : 'check',
          ok: true,
          ready: true,
          mode: 'macos-launchd',
          frozenSystemd: { detected: false, profiles: [] },
          packages: {
            cliPackageVersion: '0.1.74',
            installedEnhancedVersion: '0.1.73',
            targetEnhancedVersion: '0.1.74',
            upgradeAvailable: true,
            boundHost: { status: 'ready', installedVersion: '0.2.10', targetVersion: '0.2.11', upgradeAvailable: true },
            profiles: [],
          },
          registry: { url: 'https://registry.npmjs.org', checked: true, status: 'ok', latestEnhancedVersion: '0.1.74' },
          readiness: { ok: true, bindingOk: true, ledgersOk: true, profiles: [], blockedReasons: [] },
          plan: { canExecute: true, steps: ['backup patch', 'upgrade packages'], rollbackSupported: true, backupFiles: ['cordis.patch.yml'] },
        }),
        stderr: '',
        exitCode: 0,
      }),
    })

    const unconfirmed = await prober.trigger(host, false)
    expect(unconfirmed.applied).toBe(false)
    expect(spawnSpy).not.toHaveBeenCalled()

    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    ctx.provide('profileContext' as never, { dir: join(dshHome, 'profiles', 'web'), home: dshHome, name: 'web' } as never)
    const svc = new OwnerConsoleService(ctx, { feishuAppId: '' }, undefined, prober)
    try {
      const confirmed = await svc.runSelfUpgrade(true)
      expect(confirmed.applied).toBe(true)
      expect(confirmed.note).toContain('42424')
    } finally {
      await ctx.fiber.dispose()
    }
    expect(unrefSpy).toHaveBeenCalledOnce()
    expect(spawnSpy).toHaveBeenCalledOnce()

    const [cmd, argv, spawnOpts] = spawnSpy.mock.calls[0]! as unknown as [string, string[], { shell: boolean; detached: boolean; env: NodeJS.ProcessEnv }]
    expect(cmd).toBe('dsh-ray')
    expect(argv).toEqual(['upgrade', '--yes', '--json', '--dsh-home', dshHome, '--profile', 'web'])
    expect(spawnOpts.shell).toBe(false)
    expect(spawnOpts.detached).toBe(true)
    expect(spawnOpts.env['DEEPSEEK_API_KEY']).toBeUndefined()

    const logFile = join(dshHome, 'logs', 'owner-console-upgrade-1760000000123.log')
    expect(statSync(logFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(logFile, 'utf8')).toBe('')
  })

  it('builds sanitized upgrade env with DSH_HOME, valid desktop node executable, and deduplicated user bin dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 'owner-console-upg-env-'))
    dirs.push(root)
    const home = join(root, 'home')
    const localBin = join(home, '.local', 'bin')
    const npmGlobalBin = join(home, '.npm-global', 'bin')
    const dshHome = join(root, 'dsh-home')
    mkdirSync(localBin, { recursive: true })
    mkdirSync(npmGlobalBin, { recursive: true })

    const desktopNode = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
    const env = buildUpgradeProbeEnv({
      HOME: home,
      PATH: `/usr/bin:${localBin}/`,
      DSH_DESKTOP_NODE_EXECUTABLE: desktopNode,
      DEEPSEEK_API_KEY: 'sk-never-leak',
    }, 'darwin', dshHome)

    expect(env['DSH_HOME']).toBe(dshHome)
    expect(env['DSH_DESKTOP_NODE_EXECUTABLE']).toBe(desktopNode)
    expect(env['DEEPSEEK_API_KEY']).toBeUndefined()
    const pathParts = (env['PATH'] ?? '').split(':')
    expect(pathParts.filter(p => p.replace(/\/+$/u, '') === localBin)).toHaveLength(1)
    expect(pathParts).toContain(npmGlobalBin)

    const winAppData = join(root, 'appdata')
    const winNpm = join(winAppData, 'npm')
    mkdirSync(winNpm, { recursive: true })
    const winEnv = buildUpgradeProbeEnv({ APPDATA: winAppData, PATH: 'C:\\Windows\\System32' }, 'win32', dshHome)
    expect((winEnv['PATH'] ?? '').split(';')).toContain(winNpm)
  })

  it('falls back to executable dsh-ray in user bin dirs on ENOENT and caches resolved path across dryRun and trigger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owner-console-upg-discover-'))
    dirs.push(root)
    const dshHome = join(root, 'dsh-home')
    const home = join(root, 'home')
    const localBin = join(home, '.local', 'bin')
    mkdirSync(localBin, { recursive: true })
    const discoveredBin = join(localBin, 'dsh-ray')
    writeFileSync(discoveredBin, '#!/bin/sh\nexit 0\n', { encoding: 'utf8', mode: 0o755 })

    const host = makeHost(dshHome, 'desktop')
    const execCalls: Array<{ cmd: string; args: readonly string[]; timeoutMs: number }> = []
    const spawnSpy = vi.fn(() => ({ pid: 51515, unref: vi.fn() }))

    const prober = new SelfUpgradeProber({
      currentVersion: '0.1.80',
      platform: 'darwin',
      now: () => 1_760_000_001_000,
      env: { HOME: home, PATH: '/usr/bin:/bin' },
      spawnFn: spawnSpy,
      execFn: async (cmd, args, opts) => {
        execCalls.push({ cmd, args, timeoutMs: opts.timeoutMs })
        if (cmd === 'dsh-ray') {
          return { stdout: '', stderr: 'spawn dsh-ray ENOENT', exitCode: 127, errorCode: 'ENOENT' }
        }
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            command: 'upgrade',
            action: args.includes('--dry-run') ? 'dry-run' : 'check',
            ok: true,
            ready: true,
            mode: 'standard-local',
            frozenSystemd: { detected: false, profiles: [] },
            packages: {
              cliPackageVersion: '0.1.81',
              installedEnhancedVersion: '0.1.80',
              targetEnhancedVersion: '0.1.81',
              upgradeAvailable: true,
              boundHost: { status: 'ready', installedVersion: '0.2.2-rc.1', targetVersion: '0.2.2-rc.3', upgradeAvailable: true },
              profiles: [],
            },
            registry: { url: 'https://registry.npmjs.org', checked: true, status: 'ok', latestEnhancedVersion: '0.1.81' },
            readiness: { ok: true, bindingOk: true, ledgersOk: true, profiles: [], blockedReasons: [] },
            plan: { canExecute: true, steps: ['backup', 'upgrade'], rollbackSupported: true, backupFiles: ['cordis.patch.yml'] },
          }),
          stderr: '',
          exitCode: 0,
        }
      },
    })

    const status = await prober.check(host, true)
    expect(status.checkSource).toBe('dsh-ray')
    expect(status.canTriggerDetached).toBe(true)
    expect(execCalls.map(c => c.cmd)).toEqual(['dsh-ray', discoveredBin])
    expect(execCalls[0]!.timeoutMs).toBe(25_000)

    const preview = await prober.dryRun(host)
    expect(preview.supported).toBe(true)
    expect(execCalls).toHaveLength(3)
    expect(execCalls[2]!.cmd).toBe(discoveredBin)
    expect(execCalls[2]!.timeoutMs).toBe(30_000)

    const triggered = await prober.trigger(host, true)
    expect(triggered.applied).toBe(true)
    expect(spawnSpy).toHaveBeenCalledOnce()
    const [spawnCmd, spawnArgs] = spawnSpy.mock.calls[0]! as unknown as [string, string[]]
    expect(spawnCmd).toBe(discoveredBin)
    expect(spawnArgs).toEqual(['upgrade', '--yes', '--json', '--dsh-home', dshHome, '--profile', 'desktop', '--confirm-dsh-home-stopped'])
  })

  it('surfaces timeout, redacted stderr, and non-zero JSON execution/offline diagnostics, and invalidates stale failed cache after dryRun succeeds', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'owner-console-upg-diag-'))
    dirs.push(dshHome)
    const host = makeHost(dshHome, 'web')

    // 1. ETIMEDOUT during check caches canTriggerDetached: false, then dryRun reports clear timeout warning.
    let mode: 'timeout' | 'stderr' | 'offline-json' | 'recover' = 'timeout'
    let checkCalls = 0
    const prober = new SelfUpgradeProber({
      currentVersion: '0.1.80',
      platform: 'darwin',
      env: { HOME: '/Users/test', PATH: '/usr/bin:/bin' },
      fetchFn: async () => new Response(JSON.stringify({ version: '0.1.81' }), { status: 200 }),
      execFn: async (_cmd, args) => {
        if (args.includes('--check')) checkCalls += 1
        if (mode === 'timeout') {
          return { stdout: '', stderr: 'timed out after 25000ms', exitCode: 1, errorCode: 'ETIMEDOUT' }
        }
        if (mode === 'stderr') {
          return { stdout: '', stderr: 'fatal: token: super-secret-tok failed to verify receipt', exitCode: 1 }
        }
        if (mode === 'offline-json') {
          return {
            stdout: JSON.stringify({
              schemaVersion: 1,
              command: 'upgrade',
              action: args.includes('--dry-run') ? 'dry-run' : 'check',
              ok: false,
              ready: false,
              mode: 'standard-local',
              frozenSystemd: { detected: false, profiles: [] },
              packages: {
                cliPackageVersion: '0.1.81',
                installedEnhancedVersion: '0.1.80',
                upgradeAvailable: false,
                boundHost: { status: 'ready', installedVersion: '0.2.2-rc.3', upgradeAvailable: false },
                profiles: [],
              },
              registry: { url: 'https://registry.npmjs.org', checked: true, status: 'unavailable' },
              readiness: { ok: true, bindingOk: true, ledgersOk: true, profiles: [], blockedReasons: [] },
              plan: { canExecute: false, steps: [], rollbackSupported: true, backupFiles: [] },
            }),
            stderr: '',
            exitCode: 1,
          }
        }
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            command: 'upgrade',
            action: args.includes('--dry-run') ? 'dry-run' : 'check',
            ok: true,
            ready: true,
            mode: 'standard-local',
            frozenSystemd: { detected: false, profiles: [] },
            packages: {
              cliPackageVersion: '0.1.81',
              installedEnhancedVersion: '0.1.80',
              targetEnhancedVersion: '0.1.81',
              upgradeAvailable: true,
              boundHost: { status: 'ready', installedVersion: '0.2.2-rc.1', targetVersion: '0.2.2-rc.3', upgradeAvailable: true },
              profiles: [],
            },
            registry: { url: 'https://registry.npmjs.org', checked: true, status: 'ok', latestEnhancedVersion: '0.1.81' },
            readiness: { ok: true, bindingOk: true, ledgersOk: true, profiles: [], blockedReasons: [] },
            plan: { canExecute: true, steps: ['backup', 'upgrade'], rollbackSupported: true, backupFiles: [] },
          }),
          stderr: '',
          exitCode: 0,
        }
      },
    })

    const timedOutStatus = await prober.check(host, true)
    expect(timedOutStatus.canTriggerDetached).toBe(false)
    expect(timedOutStatus.note).toContain('执行超时')

    const timedOutPreview = await prober.dryRun(host)
    expect(timedOutPreview.supported).toBe(false)
    expect(timedOutPreview.warnings[0]).toContain('本地 dsh-ray CLI 执行超时（私有 Host 收据校验或网络较慢）')
    expect(timedOutPreview.summary).toContain('本地 dsh-ray CLI 执行超时')

    // 2. Non-zero exit with stderr redacts secrets and surfaces detail in warnings & summary.
    mode = 'stderr'
    const stderrStatus = await prober.check(host, true)
    expect(stderrStatus.note).toContain('token: [redacted]')
    expect(stderrStatus.note).not.toContain('super-secret-tok')
    const stderrPreview = await prober.dryRun(host)
    expect(stderrPreview.supported).toBe(false)
    expect(stderrPreview.warnings[0]).toContain('token: [redacted]')
    expect(stderrPreview.warnings[0]).not.toContain('super-secret-tok')
    expect(stderrPreview.summary).toContain('token: [redacted]')
    expect(stderrPreview.summary).not.toContain('super-secret-tok')

    // 3. Non-zero exit with valid JSON and empty blockedReasons populates offline/execution diagnostic.
    mode = 'offline-json'
    const offlineJsonStatus = await prober.check(host, true)
    expect(offlineJsonStatus.canTriggerDetached).toBe(false)
    expect(offlineJsonStatus.note).toContain('当前无法连接 npm registry 解析目标版本')
    const offlineJsonPreview = await prober.dryRun(host)
    expect(offlineJsonPreview.supported).toBe(false)
    expect(offlineJsonPreview.warnings[0]).toContain('当前无法连接 npm registry 解析目标版本')

    // 4. When check cached canTriggerDetached: false and dryRun succeeds, dryRun invalidates stale status cache.
    mode = 'recover'
    const callsBeforeDryRun = checkCalls
    const recoveredPreview = await prober.dryRun(host)
    expect(recoveredPreview.supported).toBe(true)
    const refreshedAfterDryRun = await prober.check(host, false)
    expect(refreshedAfterDryRun.cached).toBe(false)
    expect(refreshedAfterDryRun.canTriggerDetached).toBe(true)
    expect(checkCalls).toBe(callsBeforeDryRun + 1)
  })

  it('appends --confirm-dsh-home-stopped for standard-local mode but omits it for macos-launchd', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'owner-console-upg-modes-'))
    dirs.push(dshHome)
    const host = makeHost(dshHome, 'web')

    const makeProber = (mode: 'standard-local' | 'macos-launchd') => {
      const spawnSpy = vi.fn(() => ({ pid: 61616, unref: vi.fn() }))
      const prober = new SelfUpgradeProber({
        currentVersion: '0.1.80',
        platform: 'darwin',
        env: { HOME: '/Users/test', PATH: '/usr/bin:/bin' },
        spawnFn: spawnSpy,
        execFn: async (_cmd, args) => ({
          stdout: JSON.stringify({
            schemaVersion: 1,
            command: 'upgrade',
            action: args.includes('--dry-run') ? 'dry-run' : 'check',
            ok: true,
            ready: true,
            mode,
            frozenSystemd: { detected: false, profiles: [] },
            packages: {
              cliPackageVersion: '0.1.81',
              installedEnhancedVersion: '0.1.80',
              targetEnhancedVersion: '0.1.81',
              upgradeAvailable: true,
              boundHost: { status: 'ready', installedVersion: '0.2.2-rc.1', targetVersion: '0.2.2-rc.3', upgradeAvailable: true },
              profiles: [],
            },
            registry: { url: 'https://registry.npmjs.org', checked: true, status: 'ok', latestEnhancedVersion: '0.1.81' },
            readiness: { ok: true, bindingOk: true, ledgersOk: true, profiles: [], blockedReasons: [] },
            plan: { canExecute: true, steps: ['backup', 'upgrade'], rollbackSupported: true, backupFiles: ['cordis.patch.yml'] },
          }),
          stderr: '',
          exitCode: 0,
        }),
      })
      return { prober, spawnSpy }
    }

    const local = makeProber('standard-local')
    expect((await local.prober.trigger(host, true)).applied).toBe(true)
    const localArgs = (local.spawnSpy.mock.calls[0]! as unknown as [string, string[]])[1]
    expect(localArgs).toEqual(['upgrade', '--yes', '--json', '--dsh-home', dshHome, '--profile', 'web', '--confirm-dsh-home-stopped'])

    const launchd = makeProber('macos-launchd')
    expect((await launchd.prober.trigger(host, true)).applied).toBe(true)
    const launchdArgs = (launchd.spawnSpy.mock.calls[0]! as unknown as [string, string[]])[1]
    expect(launchdArgs).toEqual(['upgrade', '--yes', '--json', '--dsh-home', dshHome, '--profile', 'web'])
  })

  it('sets CI=true and discovers dsh-ray, node, and pnpm across nvm, fnm, volta, and execPath for macOS desktop GUI', () => {
    const root = mkdtempSync(join(tmpdir(), 'owner-console-upg-nvm-fnm-'))
    dirs.push(root)
    const home = join(root, 'home')
    const dshHome = join(root, 'dsh-home')
    const nvmBin = join(home, '.nvm', 'versions', 'node', 'v22.15.0', 'bin')
    const fnmNodeBin = join(home, 'Library', 'Application Support', 'fnm', 'node-versions', 'v24.1.0', 'installation', 'bin')
    const voltaBin = join(home, '.volta', 'bin')
    const appExecDir = join(root, 'app', 'bin')
    mkdirSync(nvmBin, { recursive: true })
    mkdirSync(fnmNodeBin, { recursive: true })
    mkdirSync(voltaBin, { recursive: true })
    mkdirSync(appExecDir, { recursive: true })

    const dshRayBin = join(nvmBin, 'dsh-ray')
    const fnmPnpmBin = join(fnmNodeBin, 'pnpm')
    const appNodeBin = join(appExecDir, 'node')
    writeFileSync(dshRayBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(fnmPnpmBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(appNodeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    const emptySysBin = join(root, 'empty-sys-bin')
    mkdirSync(emptySysBin, { recursive: true })
    const guiEnv = { HOME: home, PATH: emptySysBin }
    const env = buildUpgradeProbeEnv(guiEnv, 'darwin', dshHome, { execPath: appNodeBin })
    expect(env['CI']).toBe('true')
    const parts = (env['PATH'] ?? '').split(':')
    expect(parts).toContain(appExecDir)
    expect(parts).toContain(voltaBin)
    expect(parts).toContain(nvmBin)
    expect(parts).toContain(fnmNodeBin)

    expect(discoverDshRayBinary(guiEnv, 'darwin', [], appNodeBin)).toBe(dshRayBin)
    expect(discoverToolRuntimeBinary('node', guiEnv, 'darwin', [], appNodeBin)).toBe(appNodeBin)
    expect(discoverToolRuntimeBinary('node', { HOME: home, PATH: '/usr/bin:/bin', DSH_DESKTOP_NODE_EXECUTABLE: appNodeBin }, 'darwin')).toBe(appNodeBin)
    expect(discoverToolRuntimeBinary('pnpm', guiEnv, 'darwin', [], appNodeBin)).toBe(fnmPnpmBin)
  })

  it('tracks detached upgrade progress, immediate spawn/no-TTY failures, and redacted log tails in check()', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'owner-console-upg-logs-'))
    dirs.push(dshHome)
    const host = makeHost(dshHome, 'desktop')
    const checkJson = (action: 'check' | 'dry-run') => JSON.stringify({
      schemaVersion: 1,
      command: 'upgrade',
      action,
      ok: true,
      ready: true,
      mode: 'standard-local',
      frozenSystemd: { detected: false, profiles: [] },
      packages: {
        cliPackageVersion: '0.2.1',
        installedEnhancedVersion: '0.2.0',
        targetEnhancedVersion: '0.2.1',
        upgradeAvailable: true,
        boundHost: { status: 'missing', installedVersion: null, targetVersion: null, upgradeAvailable: false },
        profiles: [],
      },
      registry: { url: 'https://registry.npmjs.org', checked: true, status: 'ok', latestEnhancedVersion: '0.2.1' },
      readiness: { ok: true, bindingOk: true, ledgersOk: true, profiles: [], blockedReasons: [] },
      plan: { canExecute: true, steps: ['backup', 'upgrade'], rollbackSupported: true, backupFiles: [] },
    })

    // Case 1: immediate non-zero exit (e.g. ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) fails trigger() & surfaces failure tail
    {
      let seqTs = 1_760_000_900_000
      const proberFail = new SelfUpgradeProber({
        currentVersion: '0.2.0',
        platform: 'darwin',
        now: () => seqTs,
        env: { HOME: '/Users/test', PATH: '/usr/bin:/bin' },
        execFn: async (_cmd, args) => ({ stdout: checkJson(args.includes('--dry-run') ? 'dry-run' : 'check'), stderr: '', exitCode: 0 }),
        spawnFn: (_cmd, _args, opts) => {
          const emitter = new EventEmitter() as EventEmitter & { pid?: number; unref: () => void }
          emitter.pid = 91919
          emitter.unref = vi.fn()
          expect(opts.env['CI']).toBe('true')
          const fd = Array.isArray(opts.stdio) ? opts.stdio[1] : undefined
          if (typeof fd === 'number') {
            writeFileSync(join(dshHome, 'logs', `owner-console-upgrade-${seqTs}.log`), 'step 1 ok\ntoken: secret-val ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY\n')
          }
          queueMicrotask(() => emitter.emit('exit', 1))
          return emitter
        },
      })
      const triggered = await proberFail.trigger(host, true)
      expect(triggered.applied).toBe(false)
      expect(triggered.note).toContain('ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY')
      expect(triggered.note).not.toContain('secret-val')

      const afterFail = await proberFail.check(host, true)
      expect(afterFail.latestRun?.state).toBe('failed')
      expect(afterFail.latestRun?.logTail).toContain('ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY')
      expect(afterFail.latestRun?.logTail).not.toContain('secret-val')
    }

    // Case 2: running process shows running progress then succeeded once exited cleanly
    {
      const dshHome2 = mkdtempSync(join(tmpdir(), 'owner-console-upg-live-'))
      dirs.push(dshHome2)
      const host2 = makeHost(dshHome2, 'desktop')
      let alive = true
      let upgradedVersion = '0.2.0'
      const child = new EventEmitter() as EventEmitter & { pid?: number; unref: () => void }
      child.pid = 92929
      child.unref = vi.fn()
      const logTs = 1_760_000_950_000

      const proberLive = new SelfUpgradeProber({
        currentVersion: '0.2.0',
        platform: 'darwin',
        now: () => logTs,
        env: { HOME: '/Users/test', PATH: '/usr/bin:/bin' },
        isPidAlive: pid => pid === 92929 && alive,
        execFn: async (_cmd, args) => ({
          stdout: JSON.stringify({
            ...JSON.parse(checkJson(args.includes('--dry-run') ? 'dry-run' : 'check')),
            packages: {
              cliPackageVersion: '0.2.1',
              installedEnhancedVersion: upgradedVersion,
              targetEnhancedVersion: '0.2.1',
              upgradeAvailable: upgradedVersion !== '0.2.1',
              boundHost: { status: 'missing', installedVersion: null, targetVersion: null, upgradeAvailable: false },
              profiles: [],
            },
          }),
          stderr: '',
          exitCode: 0,
        }),
        spawnFn: () => child,
      })

      const started = await proberLive.trigger(host2, true)
      expect(started.applied).toBe(true)
      const logPath = join(dshHome2, 'logs', `owner-console-upgrade-${logTs}.log`)
      writeFileSync(logPath, 'installing @dsh-ray/owner-console@0.2.1...\n', 'utf8')

      const runningCheck = await proberLive.check(host2, false)
      expect(runningCheck.latestRun?.state).toBe('running')
      expect(runningCheck.latestRun?.pid).toBe(92929)
      expect(runningCheck.latestRun?.logTail).toContain('installing @dsh-ray/owner-console@0.2.1')

      alive = false
      upgradedVersion = '0.2.1'
      writeFileSync(logPath, 'installing @dsh-ray/owner-console@0.2.1...\n{"ok":true,"version":"0.2.1"}\n', 'utf8')
      child.emit('exit', 0)

      const doneCheck = await proberLive.check(host2, false)
      expect(doneCheck.latestRun?.state).toBe('succeeded')
      expect(doneCheck.latestRun?.summary).toContain('重启 Host')
    }

    // Case 3: parses pretty-printed multi-line JSON report (>1.8KB) on immediate failure AND on recreated prober
    {
      const dshHome3 = mkdtempSync(join(tmpdir(), 'owner-console-upg-multiline-'))
      dirs.push(dshHome3)
      const host3 = makeHost(dshHome3, 'desktop')
      const prettyFailedReport = JSON.stringify({
        schemaVersion: 1,
        command: 'upgrade',
        action: 'yes',
        ok: false,
        mode: 'standard-local',
        frozenSystemd: { detected: false, profiles: [] },
        packages: {
          cliPackageVersion: '0.2.1',
          installedEnhancedVersion: '0.2.0',
          targetEnhancedVersion: '0.2.1',
          upgradeAvailable: true,
          profiles: Array.from({ length: 24 }, (_, idx) => ({
            profile: `p-${idx}`,
            padding: 'x'.repeat(80),
          })),
        },
        readiness: { ok: false, blockedReasons: ['blocked fallback reason'] },
        execution: { error: 'token: tok-hide-me pnpm install exited with 1 during modules check' },
      }, null, 2)
      expect(prettyFailedReport.length).toBeGreaterThan(2_400)

      const ts3 = 1_760_000_980_000
      const proberPretty = new SelfUpgradeProber({
        currentVersion: '0.2.0',
        platform: 'darwin',
        now: () => ts3,
        env: { HOME: '/Users/test', PATH: '/usr/bin:/bin' },
        execFn: async (_cmd, args) => ({ stdout: checkJson(args.includes('--dry-run') ? 'dry-run' : 'check'), stderr: '', exitCode: 0 }),
        spawnFn: () => {
          const emitter = new EventEmitter() as EventEmitter & { pid?: number; unref: () => void }
          emitter.pid = 93939
          emitter.unref = vi.fn()
          writeFileSync(join(dshHome3, 'logs', `owner-console-upgrade-${ts3}.log`), `starting upgrade...\n${prettyFailedReport}\n`, 'utf8')
          queueMicrotask(() => emitter.emit('exit', 1))
          return emitter
        },
      })

      const failedTrigger = await proberPretty.trigger(host3, true)
      expect(failedTrigger.applied).toBe(false)
      expect(failedTrigger.note).toContain('pnpm install exited with 1 during modules check')
      expect(failedTrigger.note).not.toContain('tok-hide-me')
      expect(failedTrigger.note).not.toContain('退出码 1')

      // Recreated prober (simulating Host restart where latestRuns Map is empty) still classifies multi-line ok:false log as failed
      const recreatedProber = new SelfUpgradeProber({
        currentVersion: '0.2.0',
        platform: 'darwin',
        now: () => ts3 + 1_000,
        env: { HOME: '/Users/test', PATH: '/usr/bin:/bin' },
        execFn: async (_cmd, args) => ({ stdout: checkJson(args.includes('--dry-run') ? 'dry-run' : 'check'), stderr: '', exitCode: 0 }),
      })
      const diskCheck = await recreatedProber.check(host3, true)
      expect(diskCheck.latestRun?.state).toBe('failed')
      expect(diskCheck.latestRun?.error).toContain('pnpm install exited with 1 during modules check')
      expect(diskCheck.latestRun?.error).not.toContain('tok-hide-me')
    }
  })
})
