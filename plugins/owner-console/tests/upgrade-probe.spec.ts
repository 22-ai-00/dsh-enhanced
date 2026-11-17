import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OwnerConsoleService } from '../src/service.js'
import { compareSemver, readBoundHostMetadata, SelfUpgradeProber } from '../src/upgrade-probe.js'

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

  it('reads .dsh-rsi-host.json safely and rejects world-readable or symlinked files', () => {
    const root = mkdtempSync(join(tmpdir(), 'owner-console-upg-meta-'))
    dirs.push(root)
    const metaPath = join(root, '.dsh-rsi-host.json')

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

  it('parses dsh-rsi upgrade --check --json, caches within TTL, deduplicates inflight calls, and bypasses cache when forced', async () => {
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

  it('falls back cleanly to npm registry or offline mode when dsh-rsi CLI is absent', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'owner-console-upg-offline-'))
    dirs.push(dshHome)
    writeFileSync(join(dshHome, '.dsh-rsi-host.json'), JSON.stringify({
      schemaVersion: 1,
      cacheRoot: join(dshHome, 'cache'),
      version: '0.2.12',
      receiptDigest: 'b'.repeat(64),
    }), { encoding: 'utf8', mode: 0o600 })
    const host = makeHost(dshHome)

    const registryProber = new SelfUpgradeProber({
      currentVersion: '0.1.73',
      platform: 'darwin',
      execFn: async () => ({ stdout: '', stderr: 'spawn dsh-rsi ENOENT', exitCode: 127, errorCode: 'ENOENT' }),
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

  it('requires explicit confirmation, runs preflight dry-run, and spawns detached dsh-rsi upgrade --yes cleanly', async () => {
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
    expect(cmd).toBe('dsh-rsi')
    expect(argv).toEqual(['upgrade', '--yes', '--json', '--dsh-home', dshHome, '--profile', 'web'])
    expect(spawnOpts.shell).toBe(false)
    expect(spawnOpts.detached).toBe(true)
    expect(spawnOpts.env['DEEPSEEK_API_KEY']).toBeUndefined()

    const logFile = join(dshHome, 'logs', 'owner-console-upgrade-1760000000123.log')
    expect(statSync(logFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(logFile, 'utf8')).toBe('')
  })
})
