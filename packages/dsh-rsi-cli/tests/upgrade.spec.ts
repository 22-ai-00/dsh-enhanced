import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { main, parseArgs, runUpgrade, validateRegistryUrl, type UpgradeDeps } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createHomeFixture(options: {
  profile?: string
  enhancedVersion?: string
  hostVersion?: string
  withLaunchd?: boolean
  corruptHost?: boolean
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-rsi-upgrade-')))
  roots.push(root)
  const osHome = join(root, 'os-home')
  const dshHome = join(root, 'dsh-home')
  const profile = options.profile ?? 'web'
  const profileDir = join(dshHome, 'profiles', profile)
  const enhancedDir = join(profileDir, 'node_modules', '@dsh-enhanced', 'assistant-web-owner')
  await mkdir(osHome, { recursive: true, mode: 0o700 })
  await mkdir(enhancedDir, { recursive: true, mode: 0o700 })

  const patchOriginal = `- id: dsh-enhanced-assistant-web-owner\n  name: '@dsh-enhanced/assistant-web-owner'\n  config:\n    workspace: ${root}/ws\n`
  const pkgOriginal = JSON.stringify({ name: `dsh-profile-${profile}`, private: true, dependencies: { '@dsh-enhanced/assistant-web-owner': options.enhancedVersion ?? '0.1.73' } }, null, 2)
  const lockOriginal = 'lockfileVersion: 9.0\n'
  const pluginPkgOriginal = JSON.stringify({ name: '@dsh-enhanced/assistant-web-owner', version: options.enhancedVersion ?? '0.1.73' }, null, 2)

  await writeFile(join(profileDir, 'cordis.patch.yml'), patchOriginal, { mode: 0o600 })
  await writeFile(join(profileDir, 'package.json'), pkgOriginal, { mode: 0o600 })
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), lockOriginal, { mode: 0o600 })
  await writeFile(join(enhancedDir, 'package.json'), pluginPkgOriginal, { mode: 0o600 })

  const hostVersion = options.hostVersion ?? '0.2.2-rc.3'
  const hostPath = join(dshHome, '.dsh-rsi-host.json')
  const hostOriginal = options.corruptHost
    ? '{not-valid-json'
    : JSON.stringify({ schemaVersion: 1, cacheRoot: join(root, 'host-cache'), version: hostVersion, receiptDigest: 'a'.repeat(64) }, null, 2)
  await writeFile(hostPath, hostOriginal, { mode: 0o600 })

  if (options.withLaunchd) {
    const label = `ai.deepseek.dsh.profile.${profile}`
    await mkdir(join(osHome, 'Library', 'LaunchAgents'), { recursive: true })
    await writeFile(join(osHome, 'Library', 'LaunchAgents', `${label}.plist`), '<plist/>', { mode: 0o600 })
  }

  return {
    root,
    osHome,
    dshHome,
    profile,
    profileDir,
    enhancedDir,
    hostPath,
    hostVersion,
    patchOriginal,
    pkgOriginal,
    lockOriginal,
    pluginPkgOriginal,
    hostOriginal,
  }
}

function makeRegistryFetch(enhancedLatest: string, hostLatest: string): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('%2F') || url.includes('@dsh-enhanced')) {
      return new Response(JSON.stringify({ 'dist-tags': { latest: enhancedLatest } }), { status: 200 })
    }
    if (url.includes('@deepseek-ai')) {
      return new Response(JSON.stringify({ 'dist-tags': { latest: hostLatest } }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof globalThis.fetch
}

describe('dsh-rsi upgrade CLI parsing and URL checks', () => {
  test('parses upgrade flags cleanly and rejects invalid combinations or untrusted registry URLs', () => {
    expect(parseArgs(['upgrade', '--check', '--json', '--profile', 'web', '--registry', 'https://registry.npmjs.org/', '--dsh-version', '0.2.2-rc.4'], { HOME: '/h' }))
      .toMatchObject({
        command: 'upgrade',
        check: true,
        json: true,
        profile: 'web',
        registry: 'https://registry.npmjs.org',
        dshVersion: '0.2.2-rc.4',
      })
    expect(parseArgs(['upgrade', '--yes', '--confirm-dsh-home-stopped', '--version', '0.1.74'], { HOME: '/h' }))
      .toMatchObject({
        command: 'upgrade',
        yes: true,
        confirmDshHomeStopped: true,
        targetVersion: '0.1.74',
      })

    expect(() => parseArgs(['upgrade', '--check', '--yes'], { HOME: '/h' })).toThrow(/不能同时使用/u)
    expect(() => parseArgs(['upgrade', '--check', '--dry-run'], { HOME: '/h' })).toThrow(/不能同时使用/u)
    expect(() => parseArgs(['status', '--check'], { HOME: '/h' })).toThrow(/仅适用于 upgrade/u)
    expect(() => parseArgs(['doctor', '--registry', 'https://registry.npmjs.org'], { HOME: '/h' })).toThrow(/仅适用于 upgrade/u)
    expect(() => parseArgs(['upgrade', '--registry', 'http://evil.example/npm'], { HOME: '/h' })).toThrow(/https/u)
    expect(() => parseArgs(['upgrade', '--registry', 'https://user:secret@registry.npmjs.org'], { HOME: '/h' })).toThrow(/凭据/u)
    expect(validateRegistryUrl('http://127.0.0.1:4873/')).toBe('http://127.0.0.1:4873')
  })
})

describe('dsh-rsi upgrade check, readiness, and transactional execution', () => {
  test('--check --json compares versions online and degrades cleanly when registry is offline without mutating disk', async () => {
    const f = await createHomeFixture()
    const okDeps: UpgradeDeps = {
      fetch: makeRegistryFetch('0.1.74', '0.2.2'),
      inspectBoundHost: async () => ({
        status: 'ready',
        bindingPath: f.hostPath,
        version: '0.2.2-rc.3',
        dshPath: join(f.root, 'host-cache', '0.2.2-rc.3', 'dsh'),
        issues: [],
      }),
    }

    const stdoutChunks: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk))
      return true
    })

    const code = await main(
      ['upgrade', '--check', '--json', '--dsh-home', f.dshHome, '--profile', f.profile],
      { DSH_HOME: f.dshHome },
      { upgradeDeps: okDeps, platform: 'linux' },
    )
    expect(code).toBe(0)
    const report = JSON.parse(stdoutChunks.join(''))
    expect(report).toMatchObject({
      schemaVersion: 1,
      command: 'upgrade',
      action: 'check',
      ok: true,
      ready: true,
      mode: 'standard-local',
      registry: { status: 'ok', latestEnhancedVersion: '0.1.74', latestDshHostVersion: '0.2.2' },
      packages: {
        installedEnhancedVersion: '0.1.73',
        targetEnhancedVersion: '0.1.74',
        upgradeAvailable: true,
        boundHost: { status: 'ready', installedVersion: '0.2.2-rc.3', targetVersion: '0.2.2', upgradeAvailable: true },
      },
      readiness: { ok: true, bindingOk: true, ledgersOk: true },
      plan: { canExecute: true, rollbackSupported: true },
    })
    expect(await readFile(join(f.profileDir, 'cordis.patch.yml'), 'utf8')).toBe(f.patchOriginal)

    // Offline registry timeout / network failure produces structured report cleanly.
    const offlineDeps: UpgradeDeps = {
      ...okDeps,
      fetch: async () => { throw new Error('network unreachable') },
    }
    const { report: offlineReport, exitCode: offlineExit } = await runUpgrade(
      { dshHome: f.dshHome, profile: f.profile, action: 'check', osHome: f.osHome, platform: 'linux' },
      offlineDeps,
    )
    expect(offlineExit).toBe(0)
    expect(offlineReport.ok).toBe(true)
    expect(offlineReport.ready).toBe(true)
    expect(offlineReport.registry).toMatchObject({ checked: true, status: 'unavailable', error: 'network unreachable' })
    expect(offlineReport.plan.canExecute).toBe(false)
  })

  test('fails closed on corrupt/symlink .dsh-rsi-host.json or non-empty creation/revision ledgers', async () => {
    // 1. Corrupt binding.
    const corrupt = await createHomeFixture({ corruptHost: true })
    const corruptCheck = await runUpgrade(
      { dshHome: corrupt.dshHome, action: 'check', osHome: corrupt.osHome, platform: 'linux' },
      { fetch: makeRegistryFetch('0.1.74', '0.2.2') },
    )
    expect(corruptCheck.exitCode).toBe(1)
    expect(corruptCheck.report.ok).toBe(false)
    expect(corruptCheck.report.readiness.bindingOk).toBe(false)
    expect(corruptCheck.report.packages.boundHost.status).toBe('corrupt')

    // 1b. Symlinked .dsh-rsi-host.json is refused cleanly.
    const linked = await createHomeFixture()
    const targetJson = join(linked.root, 'foreign.json')
    await rm(linked.hostPath)
    await writeFile(targetJson, linked.hostOriginal, { mode: 0o600 })
    await symlink(targetJson, linked.hostPath)
    const symlinkCheck = await runUpgrade(
      { dshHome: linked.dshHome, action: 'check', osHome: linked.osHome, platform: 'linux' },
      { fetch: makeRegistryFetch('0.1.74', '0.2.2') },
    )
    expect(symlinkCheck.exitCode).toBe(1)
    expect(symlinkCheck.report.packages.boundHost.status).toBe('corrupt')

    // 2. Empty ledger tables pass cleanly, non-empty creation/revision ledgers fail closed.
    const ledgerFixture = await createHomeFixture()
    const readyInspect: UpgradeDeps = {
      fetch: makeRegistryFetch('0.1.74', '0.2.2'),
      inspectBoundHost: async () => ({
        status: 'ready',
        bindingPath: ledgerFixture.hostPath,
        version: '0.2.2-rc.3',
        dshPath: '/bin/dsh',
        issues: [],
      }),
    }
    const cpDir = join(ledgerFixture.dshHome, 'plugin-control-plane')
    await mkdir(cpDir, { recursive: true })
    const cpDbPath = join(cpDir, `${ledgerFixture.profile}.sqlite`)
    const db = new DatabaseSync(cpDbPath)
    db.exec(`
      CREATE TABLE source_plans (id TEXT PRIMARY KEY);
      CREATE TABLE source_creation_verifications (plan_id TEXT PRIMARY KEY);
      CREATE TABLE source_revision_sources (plan_id TEXT PRIMARY KEY);
    `)
    db.close()

    const emptyRes = await runUpgrade(
      { dshHome: ledgerFixture.dshHome, profile: ledgerFixture.profile, action: 'check', osHome: ledgerFixture.osHome, platform: 'linux' },
      readyInspect,
    )
    expect(emptyRes.exitCode).toBe(0)
    expect(emptyRes.report.readiness.profiles[0]).toMatchObject({
      ledgerReady: true,
      creationLedgerStatus: 'empty',
      revisionLedgerStatus: 'empty',
    })

    const dbNonEmpty = new DatabaseSync(cpDbPath)
    dbNonEmpty.exec("INSERT INTO source_plans (id) VALUES ('plan-1'); INSERT INTO source_revision_sources (plan_id) VALUES ('plan-1');")
    dbNonEmpty.close()

    const blockedRes = await runUpgrade(
      { dshHome: ledgerFixture.dshHome, profile: ledgerFixture.profile, action: 'yes' in {} ? 'apply' : 'apply', osHome: ledgerFixture.osHome, platform: 'linux' },
      readyInspect,
    )
    expect(blockedRes.exitCode).toBe(1)
    expect(blockedRes.report.readiness.ledgersOk).toBe(false)
    expect(blockedRes.report.readiness.profiles[0]).toMatchObject({
      ledgerReady: false,
      creationLedgerStatus: 'non-empty',
      revisionLedgerStatus: 'non-empty',
    })
    expect(blockedRes.report.execution?.executed).toBe(false)
  })

  test('detects frozen Linux systemd profile and delegates --dry-run / --yes safely without breaking 0.2.2-rc.3 selector', async () => {
    const f = await createHomeFixture({ profile: 'owner' })
    const cohortDir = join(f.dshHome, 'rsi-local-cohorts', 'owner')
    const repoDir = join(f.root, 'repo')
    await mkdir(cohortDir, { recursive: true, mode: 0o700 })
    await mkdir(repoDir, { mode: 0o700 })
    await writeFile(join(cohortDir, 'receipt.json'), JSON.stringify({ schemaVersion: 1, root: cohortDir, sourceRepository: repoDir }), { mode: 0o600 })
    const markerHash = createHash('sha256').update('owner').digest('hex').slice(0, 16)
    await writeFile(join(f.dshHome, `.rsi-coordinator-${markerHash}.json`), JSON.stringify({
      schemaVersion: 1, targetProfile: 'owner', coordinatorProfile: 'coordinator', sourceRepository: repoDir,
    }), { mode: 0o600 })

    const frozenCalls: Array<{ dryRun: boolean; dshVersion?: string }> = []
    const frozenDeps: UpgradeDeps = {
      fetch: makeRegistryFetch('0.1.74', '0.2.2'),
      inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.3', dshPath: '/bin/dsh', issues: [] }),
      runFrozenOwnerUpdate: async (_owner, opts) => {
        frozenCalls.push(opts)
        return 0
      },
    }

    const dry = await runUpgrade(
      { dshHome: f.dshHome, action: 'dry-run', platform: 'linux', osHome: f.osHome },
      frozenDeps,
    )
    expect(dry.exitCode).toBe(0)
    expect(dry.report.mode).toBe('frozen-linux-systemd')
    expect(dry.report.frozenSystemd).toMatchObject({ detected: true, profiles: ['owner'], targetDshVersion: '0.2.2-rc.3' })
    expect(dry.report.execution).toMatchObject({ executed: false, dryRun: true, delegatedScript: 'scripts/install/upgrade-program.mjs' })
    expect(frozenCalls).toEqual([{ dryRun: true }])

    const applied = await runUpgrade(
      { dshHome: f.dshHome, action: 'apply', dshVersion: '0.2.2-rc.3', platform: 'linux', osHome: f.osHome },
      frozenDeps,
    )
    expect(applied.exitCode).toBe(0)
    expect(applied.report.execution).toMatchObject({ executed: true, dryRun: false, healthCheckPassed: true, rolledBack: false })
    expect(frozenCalls).toEqual([{ dryRun: true }, { dryRun: false, dshVersion: '0.2.2-rc.3' }])
  })

  test('executes transactional macOS launchd upgrade with backup & doctor check, and rolls back automatically on failure', async () => {
    const f = await createHomeFixture({ withLaunchd: true })
    const serviceEvents: string[] = []

    const baseDeps = (healthOk: boolean): UpgradeDeps => ({
      fetch: makeRegistryFetch('0.1.74', '0.2.2'),
      inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.3', dshPath: '/bin/dsh', issues: [] }),
      isServiceRunning: async () => true,
      inspectService: async () => ({ managed: true, definitionPath: join(f.osHome, 'Library', 'LaunchAgents', 'ai.deepseek.dsh.profile.web.plist'), foreign: false }),
      controlService: async (_plat, _home, profile, action) => {
        serviceEvents.push(`${profile}:${action}`)
        return { profile, actions: [action], messages: [], errors: [] }
      },
      scanProcesses: async () => ({ processes: [] }),
      upgradeHost: async ({ dshHome, targetVersion }) => {
        await writeFile(join(dshHome, '.dsh-rsi-host.json'), JSON.stringify({
          schemaVersion: 1, cacheRoot: join(f.root, 'host-cache'), version: targetVersion, receiptDigest: 'b'.repeat(64),
        }, null, 2), { mode: 0o600 })
      },
      upgradeProfilePackages: async ({ profile, targetVersion }) => {
        const dir = join(f.dshHome, 'profiles', profile)
        await writeFile(join(dir, 'cordis.patch.yml'), '# mutated-during-upgrade\n[]\n', { mode: 0o600 })
        await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'mutated', version: targetVersion }), { mode: 0o600 })
        await writeFile(join(dir, 'node_modules', '@dsh-enhanced', 'assistant-web-owner', 'package.json'),
          JSON.stringify({ name: '@dsh-enhanced/assistant-web-owner', version: targetVersion }), { mode: 0o600 })
      },
      verifyHealth: async () => healthOk ? { ok: true } : { ok: false, error: 'doctor readiness check failed' },
    })

    // 1. Failed health check triggers full automatic rollback of host binding, patch, package.json, and node_modules.
    const failed = await runUpgrade(
      { dshHome: f.dshHome, profile: f.profile, action: 'apply', platform: 'darwin', osHome: f.osHome },
      baseDeps(false),
    )
    expect(failed.exitCode).toBe(1)
    expect(failed.report.mode).toBe('macos-launchd')
    expect(failed.report.ok).toBe(false)
    expect(failed.report.execution).toMatchObject({
      executed: true,
      dryRun: false,
      healthCheckPassed: false,
      rolledBack: true,
      rollbackSucceeded: true,
      error: '升级后就绪诊断失败：doctor readiness check failed',
    })
    expect(await readFile(f.hostPath, 'utf8')).toBe(f.hostOriginal)
    expect(await readFile(join(f.profileDir, 'cordis.patch.yml'), 'utf8')).toBe(f.patchOriginal)
    expect(await readFile(join(f.profileDir, 'package.json'), 'utf8')).toBe(f.pkgOriginal)
    expect(await readFile(join(f.profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe(f.lockOriginal)
    expect(await readFile(join(f.enhancedDir, 'package.json'), 'utf8')).toBe(f.pluginPkgOriginal)
    expect(serviceEvents).toEqual(['web:stop', 'web:start'])

    // 2. Successful health check commits upgrade and restarts managed service.
    serviceEvents.length = 0
    const succeeded = await runUpgrade(
      { dshHome: f.dshHome, profile: f.profile, action: 'apply', platform: 'darwin', osHome: f.osHome },
      baseDeps(true),
    )
    expect(succeeded.exitCode).toBe(0)
    expect(succeeded.report.ok).toBe(true)
    expect(succeeded.report.execution).toMatchObject({
      executed: true,
      dryRun: false,
      healthCheckPassed: true,
      rolledBack: false,
    })
    expect(JSON.parse(await readFile(f.hostPath, 'utf8')).version).toBe('0.2.2')
    expect(JSON.parse(await readFile(join(f.enhancedDir, 'package.json'), 'utf8')).version).toBe('0.1.74')
    expect(serviceEvents).toEqual(['web:stop', 'web:start'])
  })
})
