import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { formatUpgradeReport, main, parseArgs, runUpgrade, validateRegistryUrl, type UpgradeDeps } from '../src/index.ts'
import { defaultUpgradeProfilePackages } from '../src/upgrade.ts'

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

  const hostVersion = options.hostVersion ?? '0.2.2-rc.5'
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
    const f = await createHomeFixture({ hostVersion: '0.2.2-rc.1' })
    const okDeps: UpgradeDeps = {
      fetch: makeRegistryFetch('0.1.74', '0.2.2-rc.5'),
      inspectBoundHost: async () => ({
        status: 'ready',
        bindingPath: f.hostPath,
        version: '0.2.2-rc.1',
        dshPath: join(f.root, 'host-cache', '0.2.2-rc.1', 'dsh'),
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
      registry: { status: 'ok', latestEnhancedVersion: '0.1.74', latestDshHostVersion: '0.2.2-rc.5' },
      packages: {
        installedEnhancedVersion: '0.1.73',
        targetEnhancedVersion: '0.1.74',
        upgradeAvailable: true,
        boundHost: { status: 'ready', installedVersion: '0.2.2-rc.1', targetVersion: '0.2.2-rc.5', upgradeAvailable: true },
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
      { fetch: makeRegistryFetch('0.1.74', '0.2.2-rc.5') },
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
      { fetch: makeRegistryFetch('0.1.74', '0.2.2-rc.5') },
    )
    expect(symlinkCheck.exitCode).toBe(1)
    expect(symlinkCheck.report.packages.boundHost.status).toBe('corrupt')

    // 2. Empty ledger tables pass cleanly, non-empty creation/revision ledgers fail closed.
    const ledgerFixture = await createHomeFixture()
    const readyInspect: UpgradeDeps = {
      fetch: makeRegistryFetch('0.1.74', '0.2.2-rc.5'),
      inspectBoundHost: async () => ({
        status: 'ready',
        bindingPath: ledgerFixture.hostPath,
        version: '0.2.2-rc.5',
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

  test('detects frozen Linux systemd profile and delegates --dry-run / --yes safely without breaking 0.2.2-rc.5 selector', async () => {
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
      fetch: makeRegistryFetch('0.1.74', '0.2.2-rc.5'),
      inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.5', dshPath: '/bin/dsh', issues: [] }),
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
    expect(dry.report.frozenSystemd).toMatchObject({ detected: true, profiles: ['owner'], targetDshVersion: '0.2.2-rc.5' })
    expect(dry.report.execution).toMatchObject({ executed: false, dryRun: true, delegatedScript: 'scripts/install/upgrade-program.mjs' })
    expect(frozenCalls).toEqual([{ dryRun: true }])

    const applied = await runUpgrade(
      { dshHome: f.dshHome, action: 'apply', dshVersion: '0.2.2-rc.5', platform: 'linux', osHome: f.osHome },
      frozenDeps,
    )
    expect(applied.exitCode).toBe(0)
    expect(applied.report.execution).toMatchObject({ executed: true, dryRun: false, healthCheckPassed: true, rolledBack: false })
    expect(frozenCalls).toEqual([{ dryRun: true }, { dryRun: false, dshVersion: '0.2.2-rc.5' }])
  })

  test('executes transactional macOS launchd upgrade with backup & doctor check, and rolls back automatically on failure', async () => {
    const f = await createHomeFixture({ withLaunchd: true, hostVersion: '0.2.2-rc.1' })
    const serviceEvents: string[] = []

    const baseDeps = (healthOk: boolean): UpgradeDeps => ({
      fetch: makeRegistryFetch('0.1.74', '0.2.2-rc.5'),
      inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.1', dshPath: '/bin/dsh', issues: [] }),
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
    expect(JSON.parse(await readFile(f.hostPath, 'utf8')).version).toBe('0.2.2-rc.5')
    expect(JSON.parse(await readFile(join(f.enhancedDir, 'package.json'), 'utf8')).version).toBe('0.1.74')
    expect(serviceEvents).toEqual(['web:stop', 'web:start'])
  })

  test('clamps newer upstream @deepseek-ai/dsh (0.2.2-rc.9) to validated baseline 0.2.2-rc.5, supports /latest fallback, blocks explicit unvalidated --dsh-version, and warns on older CLI', async () => {
    const f = await createHomeFixture({ hostVersion: '0.2.2-rc.1' })
    const requestedUrls: string[] = []
    const fetchStub = (async (input: string | URL | Request) => {
      const url = String(input)
      requestedUrls.push(url)
      if (url.endsWith('/@dsh-enhanced/dsh-rsi-cli/latest')) {
        return new Response('{}', { status: 404 })
      }
      if (url.endsWith('/@dsh-enhanced/dsh-rsi-cli')) {
        return new Response(JSON.stringify({ 'dist-tags': { latest: '99.0.0' } }), { status: 200 })
      }
      if (url.endsWith('/@deepseek-ai/dsh/latest')) {
        return new Response(JSON.stringify({ version: '0.2.2-rc.9' }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }) as typeof globalThis.fetch

    const clamped = await runUpgrade(
      { dshHome: f.dshHome, profile: f.profile, action: 'check', osHome: f.osHome, platform: 'linux' },
      {
        fetch: fetchStub,
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.1', dshPath: '/bin/dsh', issues: [] }),
      },
    )
    expect(clamped.exitCode).toBe(0)
    expect(requestedUrls).toEqual(expect.arrayContaining([
      'https://registry.npmjs.org/@dsh-enhanced/dsh-rsi-cli/latest',
      'https://registry.npmjs.org/@dsh-enhanced/dsh-rsi-cli',
      'https://registry.npmjs.org/@deepseek-ai/dsh/latest',
    ]))
    expect(requestedUrls.some(url => url.includes('%2F'))).toBe(false)
    expect(clamped.report.registry.latestDshHostVersion).toBe('0.2.2-rc.9')
    expect(clamped.report.packages.boundHost).toMatchObject({
      installedVersion: '0.2.2-rc.1',
      targetVersion: '0.2.2-rc.5',
      upgradeAvailable: true,
    })

    const formatted = formatUpgradeReport(clamped.report)
    expect(formatted).toContain(`提示：全局 dsh-rsi CLI 当前为 ${clamped.report.packages.cliPackageVersion}，可运行 dsh-rsi update 同步升级至 99.0.0`)

    // Already on validated baseline 0.2.2-rc.5 -> no host upgrade needed despite upstream 0.2.2-rc.9.
    const alreadyBaseline = await runUpgrade(
      { dshHome: f.dshHome, profile: f.profile, action: 'check', osHome: f.osHome, platform: 'linux' },
      {
        fetch: fetchStub,
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.5', dshPath: '/bin/dsh', issues: [] }),
      },
    )
    expect(alreadyBaseline.report.packages.boundHost).toMatchObject({
      installedVersion: '0.2.2-rc.5',
      targetVersion: '0.2.2-rc.5',
      upgradeAvailable: false,
    })

    // Explicit unvalidated --dsh-version without custom upgradeHost fails closed in blockedReasons.
    const blocked = await runUpgrade(
      { dshHome: f.dshHome, profile: f.profile, action: 'check', dshVersion: '0.2.2-rc.9', osHome: f.osHome, platform: 'linux' },
      {
        fetch: fetchStub,
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.5', dshPath: '/bin/dsh', issues: [] }),
      },
    )
    expect(blocked.exitCode).toBe(1)
    expect(blocked.report.readiness.ok).toBe(false)
    expect(blocked.report.readiness.blockedReasons.join('\n')).toContain('0.2.2-rc.5')
  })

  test('upgrades pnpm profile (package.json + pnpm-workspace.yaml overrides + .pnpm symlink) and rolls back pnpm-workspace.yaml on health failure', async () => {
    const f = await createHomeFixture({ profile: 'desktop', hostVersion: '0.2.2-rc.5' })
    const fakeBinDir = join(f.root, 'fake-pnpm-bin')
    await mkdir(fakeBinDir, { recursive: true })
    const fakePnpmPath = join(fakeBinDir, 'pnpm')
    await writeFile(fakePnpmPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    // Replace entity dir with standard pnpm virtual-store symlink + pnpm-workspace.yaml overrides.
    await rm(f.enhancedDir, { recursive: true, force: true })
    const pnpmTarget = join(
      f.profileDir,
      'node_modules',
      '.pnpm',
      '@dsh-enhanced+assistant-web-owner@0.1.73',
      'node_modules',
      '@dsh-enhanced',
      'assistant-web-owner',
    )
    await mkdir(pnpmTarget, { recursive: true })
    await writeFile(join(pnpmTarget, 'package.json'), f.pluginPkgOriginal, { mode: 0o600 })
    await symlink(
      '../.pnpm/@dsh-enhanced+assistant-web-owner@0.1.73/node_modules/@dsh-enhanced/assistant-web-owner',
      f.enhancedDir,
    )

    const pkgPath = join(f.profileDir, 'package.json')
    const pkgInitial = JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {
        '@dsh-enhanced/assistant-web-owner': '0.1.73',
        '@dsh-enhanced/vendor-local': 'file:./vendor/local.tgz',
        lodash: '4.17.21',
      },
      optionalDependencies: {
        '@dsh-enhanced/lark-channel': '^0.1.73',
      },
    }, null, 2) + '\n'
    await writeFile(pkgPath, pkgInitial, { mode: 0o640 })
    await chmod(pkgPath, 0o640)

    const wsPath = join(f.profileDir, 'pnpm-workspace.yaml')
    const wsOriginal = `# preserve workspace comments
nodeLinker: hoisted
autoInstallPeers: true
allowBuilds:
  better-sqlite3: true
minimumReleaseAgeExclude:
  - "@dsh-enhanced/*"
overrides:
  # keep vendor local override untouched
  "@dsh-enhanced/vendor-local": "file:./vendor/local.tgz"
  "@dsh-enhanced/assistant-web-owner": "0.1.73"
  "@dsh-enhanced/lark-channel": ^0.1.73
  "@dsh-enhanced/a>@dsh-enhanced/b": "0.1.70"
`
    await writeFile(wsPath, wsOriginal, { mode: 0o640 })
    await chmod(wsPath, 0o640)

    const runnerCalls: Array<{ command: string; args: readonly string[] }> = []
    const makeDeps = (healthOk: boolean): UpgradeDeps => ({
      fetch: makeRegistryFetch('0.1.74', '0.2.2-rc.5'),
      inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.5', dshPath: '/bin/dsh', issues: [] }),
      runner: (command, args) => {
        runnerCalls.push({ command, args })
        return { status: 0, stdout: '', stderr: '' }
      },
      verifyHealth: async () => healthOk ? { ok: true } : { ok: false, error: 'desktop health check failed' },
    })

    // 1. Health check failure rolls back package.json AND pnpm-workspace.yaml cleanly.
    const failed = await runUpgrade(
      {
        dshHome: f.dshHome,
        profile: f.profile,
        action: 'apply',
        confirmDshHomeStopped: true,
        platform: 'linux',
        osHome: f.osHome,
        env: { PATH: fakeBinDir },
      },
      makeDeps(false),
    )
    expect(failed.exitCode).toBe(1)
    expect(failed.report.execution).toMatchObject({
      executed: true,
      rolledBack: true,
      rollbackSucceeded: true,
    })
    expect(failed.report.plan.backupFiles).toContain(wsPath)
    expect(await readFile(pkgPath, 'utf8')).toBe(pkgInitial)
    expect(await readFile(wsPath, 'utf8')).toBe(wsOriginal)

    // 2. Successful upgrade updates package.json & pnpm-workspace.yaml overrides while preserving local protocols & comments.
    runnerCalls.length = 0
    const succeeded = await runUpgrade(
      {
        dshHome: f.dshHome,
        profile: f.profile,
        action: 'apply',
        confirmDshHomeStopped: true,
        platform: 'linux',
        osHome: f.osHome,
        env: { PATH: fakeBinDir },
      },
      makeDeps(true),
    )
    expect(succeeded.exitCode).toBe(0)
    expect(runnerCalls).toEqual([
      {
        command: fakePnpmPath,
        args: ['install', '--dir', f.profileDir, '--no-frozen-lockfile', '--ignore-scripts', '--registry', 'https://registry.npmjs.org'],
      },
    ])

    const updatedPkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    expect(updatedPkg.dependencies).toEqual({
      '@dsh-enhanced/assistant-web-owner': '0.1.74',
      '@dsh-enhanced/vendor-local': 'file:./vendor/local.tgz',
      lodash: '4.17.21',
    })
    expect(updatedPkg.optionalDependencies).toEqual({
      '@dsh-enhanced/lark-channel': '0.1.74',
    })
    expect((await stat(pkgPath)).mode & 0o777).toBe(0o640)

    const updatedWs = await readFile(wsPath, 'utf8')
    expect(updatedWs).toContain('# preserve workspace comments')
    expect(updatedWs).toContain('nodeLinker: hoisted')
    expect(updatedWs).toContain('autoInstallPeers: true')
    expect(updatedWs).toContain('better-sqlite3: true')
    expect(updatedWs).toContain('minimumReleaseAgeExclude:')
    expect(updatedWs).toContain('"@dsh-enhanced/vendor-local": "file:./vendor/local.tgz"')
    expect(updatedWs).toContain('"@dsh-enhanced/assistant-web-owner": "0.1.74"')
    expect(updatedWs).toContain('"@dsh-enhanced/lark-channel": 0.1.74')
    expect(updatedWs).toContain('"@dsh-enhanced/a>@dsh-enhanced/b": "0.1.70"')
    expect((await stat(wsPath)).mode & 0o777).toBe(0o640)
  })

  test('defaultUpgradeProfilePackages injects npmPlugins when package.json lacks @dsh-enhanced/* and passes --legacy-peer-deps for pure npm profiles', async () => {
    const f = await createHomeFixture({ profile: 'npm-only' })
    await rm(join(f.profileDir, 'pnpm-lock.yaml'))
    const npmCalls: Array<{ command: string; args: readonly string[] }> = []

    await defaultUpgradeProfilePackages({
      dshHome: f.dshHome,
      profile: f.profile,
      targetVersion: '0.1.75',
      registryUrl: 'https://registry.npmjs.org',
      npmPlugins: ['@dsh-enhanced/assistant-web-owner'],
      runner: (command, args) => {
        npmCalls.push({ command, args })
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    expect(npmCalls).toEqual([
      {
        command: 'npm',
        args: [
          'install',
          '--prefix', f.profileDir,
          '--legacy-peer-deps',
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
          '--registry', 'https://registry.npmjs.org',
          '@dsh-enhanced/assistant-web-owner@0.1.75',
        ],
      },
    ])

    // Empty dependencies in pnpm profile -> populate dependencies with npmPlugins.
    const pkgPath = join(f.profileDir, 'package.json')
    await writeFile(join(f.profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    await writeFile(pkgPath, JSON.stringify({ name: 'dsh-profile-npm-only', dependencies: {} }, null, 2))
    const pnpmCalls: Array<{ command: string; args: readonly string[] }> = []
    await defaultUpgradeProfilePackages({
      dshHome: f.dshHome,
      profile: f.profile,
      targetVersion: '0.1.75',
      registryUrl: 'https://registry.npmjs.org',
      npmPlugins: ['@dsh-enhanced/assistant-web-owner'],
      osHome: f.osHome,
      platform: 'linux',
      env: { PATH: '' },
      runner: (command, args) => {
        pnpmCalls.push({ command, args })
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    const populatedPkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    expect(populatedPkg.dependencies).toEqual({ '@dsh-enhanced/assistant-web-owner': '0.1.75' })
    expect(pnpmCalls[0]?.args).toEqual([
      'install',
      '--dir', f.profileDir,
      '--no-frozen-lockfile',
      '--ignore-scripts',
      '--registry', 'https://registry.npmjs.org',
    ])
  })

  test('migrates non-empty SQLite creation/revision ledgers when allowNonEmptyHistoryMigration=true, backs up and rolls back ledgers, and rejects corrupt DB or relative dshHome', async () => {
    const f = await createHomeFixture({ hostVersion: '0.1.9', enhancedVersion: '0.1.73' })
    const cpDir = join(f.dshHome, 'plugin-control-plane')
    await mkdir(cpDir, { recursive: true })
    const dbPath = join(cpDir, `${f.profile}.sqlite`)
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE source_plans (id TEXT PRIMARY KEY);
      CREATE TABLE source_creation_verifications (plan_id TEXT PRIMARY KEY);
      CREATE TABLE source_revision_sources (plan_id TEXT PRIMARY KEY);
      INSERT INTO source_plans (id) VALUES ('plan-1');
      INSERT INTO source_creation_verifications (plan_id) VALUES ('plan-1');
      INSERT INTO source_revision_sources (plan_id) VALUES ('plan-1');
    `)
    db.close()

    const baseDeps = (healthOk: boolean, mutateDb = false): UpgradeDeps => ({
      fetch: makeRegistryFetch('0.1.84', '0.2.2-rc.5'),
      inspectBoundHost: async () => ({
        status: 'ready',
        bindingPath: f.hostPath,
        version: '0.1.9',
        dshPath: '/bin/dsh',
        issues: [],
      }),
      scanProcesses: async () => ({ processes: [] }),
      upgradeHost: async ({ dshHome, targetVersion }) => {
        await writeFile(join(dshHome, '.dsh-rsi-host.json'), JSON.stringify({
          schemaVersion: 1, cacheRoot: join(f.root, 'host-cache'), version: targetVersion, receiptDigest: 'b'.repeat(64),
        }, null, 2), { mode: 0o600 })
      },
      upgradeProfilePackages: async () => {
        if (mutateDb) {
          const mutDb = new DatabaseSync(dbPath)
          mutDb.exec("DELETE FROM source_plans; INSERT INTO source_plans (id) VALUES ('corrupted-mid-upgrade');")
          mutDb.close()
        }
      },
      verifyHealth: async () => healthOk ? { ok: true } : { ok: false, error: 'post-upgrade doctor failed' },
    })

    // 1. Relative dshHome fails closed cleanly without inspecting relative disk paths.
    const relRes = await runUpgrade(
      { dshHome: 'relative/dsh-home', profile: f.profile, action: 'check', osHome: f.osHome, platform: 'linux' },
      baseDeps(true),
    )
    expect(relRes.exitCode).toBe(1)
    expect(relRes.report.ok).toBe(false)
    expect(relRes.report.ready).toBe(false)
    expect(relRes.report.readiness.blockedReasons.join('\n')).toContain('绝对路径')

    // 2. Failed health check restores SQLite ledger rows byte-for-byte on rollback.
    const rbRes = await runUpgrade(
      {
        dshHome: f.dshHome,
        profile: f.profile,
        action: 'apply',
        allowNonEmptyHistoryMigration: true,
        confirmDshHomeStopped: true,
        osHome: f.osHome,
        platform: 'linux',
      },
      baseDeps(false, true),
    )
    expect(rbRes.exitCode).toBe(1)
    expect(rbRes.report.execution?.rolledBack).toBe(true)
    expect(rbRes.report.execution?.rollbackSucceeded).toBe(true)
    const verifyRbDb = new DatabaseSync(dbPath, { readOnly: true })
    try {
      expect((verifyRbDb.prepare('SELECT id FROM source_plans').all() as Array<{ id: string }>).map(r => r.id)).toEqual(['plan-1'])
    } finally {
      verifyRbDb.close()
    }

    // 3. Successful migration preserves all rows intact.
    const okRes = await runUpgrade(
      {
        dshHome: f.dshHome,
        profile: f.profile,
        action: 'apply',
        allowNonEmptyHistoryMigration: true,
        confirmDshHomeStopped: true,
        osHome: f.osHome,
        platform: 'linux',
      },
      baseDeps(true, false),
    )
    expect(okRes.exitCode).toBe(0)
    expect(okRes.report.ok).toBe(true)
    expect(okRes.report.readiness.ledgersOk).toBe(true)
    const verifyOkDb = new DatabaseSync(dbPath, { readOnly: true })
    try {
      expect((verifyOkDb.prepare('SELECT COUNT(*) AS n FROM source_plans').get() as { n: number }).n).toBe(1)
      expect((verifyOkDb.prepare('SELECT COUNT(*) AS n FROM source_creation_verifications').get() as { n: number }).n).toBe(1)
      expect((verifyOkDb.prepare('SELECT COUNT(*) AS n FROM source_revision_sources').get() as { n: number }).n).toBe(1)
    } finally {
      verifyOkDb.close()
    }

    // 4. Corrupt SQLite ledger still fails closed even with allowNonEmptyHistoryMigration=true.
    await writeFile(dbPath, 'not-a-valid-sqlite-database', { mode: 0o600 })
    const corruptRes = await runUpgrade(
      {
        dshHome: f.dshHome,
        profile: f.profile,
        action: 'check',
        allowNonEmptyHistoryMigration: true,
        osHome: f.osHome,
        platform: 'linux',
      },
      baseDeps(true),
    )
    expect(corruptRes.exitCode).toBe(1)
    expect(corruptRes.report.readiness.ledgersOk).toBe(false)
  })

  test('unbound Home (boundHostStatus=missing) upgrades packages online without calling defaultUpgradeHost and blocks explicit --dsh-version', async () => {
    const f = await createHomeFixture({ enhancedVersion: '0.1.73' })
    await rm(f.hostPath, { force: true })

    let pkgUpgradedTo: string | undefined
    const res = await runUpgrade(
      {
        dshHome: f.dshHome,
        profile: f.profile,
        action: 'apply',
        confirmDshHomeStopped: true,
        osHome: f.osHome,
        platform: 'linux',
      },
      {
        fetch: makeRegistryFetch('0.1.84', '0.2.2-rc.5'),
        inspectBoundHost: async () => ({
          status: 'missing',
          bindingPath: f.hostPath,
          issues: [],
        }),
        upgradeProfilePackages: async ({ targetVersion }) => {
          pkgUpgradedTo = targetVersion
        },
        verifyHealth: async () => ({ ok: true }),
      },
    )
    expect(res.exitCode).toBe(0)
    expect(res.report.ok).toBe(true)
    expect(res.report.packages.boundHost.status).toBe('missing')
    expect(res.report.packages.boundHost.upgradeAvailable).toBe(false)
    expect(pkgUpgradedTo).toBe('0.1.84')

    const explicitDshRes = await runUpgrade(
      {
        dshHome: f.dshHome,
        profile: f.profile,
        action: 'apply',
        dshVersion: '0.2.2-rc.5',
        osHome: f.osHome,
        platform: 'linux',
      },
      {
        fetch: makeRegistryFetch('0.1.84', '0.2.2-rc.5'),
        inspectBoundHost: async () => ({
          status: 'missing',
          bindingPath: f.hostPath,
          issues: [],
        }),
      },
    )
    expect(explicitDshRes.exitCode).toBe(1)
    expect(explicitDshRes.report.readiness.ok).toBe(false)
    expect(explicitDshRes.report.readiness.blockedReasons.join('\n')).toContain('没有私有 Host 绑定')
  })

  test('resolves custom !js dshHomePath(...) and name-only plugin-control-plane/assistant-verifier ledger rows, and rejects escaping dshHomePath', async () => {
    const f = await createHomeFixture({ hostVersion: '0.2.2-rc.5', enhancedVersion: '0.1.73' })
    const customDir = join(f.dshHome, 'custom-ledgers')
    await mkdir(customDir, { recursive: true })
    const customDbPath = join(customDir, 'cp-custom.sqlite')
    const db = new DatabaseSync(customDbPath)
    db.exec(`
      CREATE TABLE source_plans (id TEXT PRIMARY KEY);
      INSERT INTO source_plans (id) VALUES ('plan-custom-1');
    `)
    db.close()

    await writeFile(
      join(f.profileDir, 'cordis.patch.yml'),
      `- name: "@dsh-enhanced/plugin-control-plane"\n  config:\n    databasePath: !js dshHomePath('custom-ledgers', 'cp-custom.sqlite')\n`,
      { mode: 0o600 },
    )

    const deps = (healthOk: boolean, mutateDb = false): UpgradeDeps => ({
      fetch: makeRegistryFetch('0.1.84', '0.2.2-rc.5'),
      inspectBoundHost: async () => ({
        status: 'ready',
        bindingPath: f.hostPath,
        version: '0.2.2-rc.5',
        dshPath: '/bin/dsh',
        issues: [],
      }),
      scanProcesses: async () => ({ processes: [] }),
      upgradeProfilePackages: async () => {
        if (mutateDb) {
          const mut = new DatabaseSync(customDbPath)
          mut.exec("DELETE FROM source_plans; INSERT INTO source_plans (id) VALUES ('mutated');")
          mut.close()
        }
      },
      verifyHealth: async () => healthOk ? { ok: true } : { ok: false, error: 'custom ledger doctor fail' },
    })

    // 1. Blocked when allowNonEmptyHistoryMigration is false.
    const blocked = await runUpgrade(
      {
        dshHome: f.dshHome,
        profile: f.profile,
        action: 'check',
        allowNonEmptyHistoryMigration: false,
        osHome: f.osHome,
        platform: 'linux',
      },
      deps(true),
    )
    expect(blocked.exitCode).toBe(1)
    expect(blocked.report.readiness.ledgersOk).toBe(false)
    expect(blocked.report.readiness.profiles[0]?.creationLedgerStatus).toBe('non-empty')

    // 2. Backed up and rolled back when allowNonEmptyHistoryMigration is true and verifyHealth fails.
    const rb = await runUpgrade(
      {
        dshHome: f.dshHome,
        profile: f.profile,
        action: 'apply',
        allowNonEmptyHistoryMigration: true,
        confirmDshHomeStopped: true,
        osHome: f.osHome,
        platform: 'linux',
      },
      deps(false, true),
    )
    expect(rb.exitCode).toBe(1)
    expect(rb.report.execution?.rolledBack).toBe(true)
    const verifyDb = new DatabaseSync(customDbPath, { readOnly: true })
    try {
      expect((verifyDb.prepare('SELECT id FROM source_plans').all() as Array<{ id: string }>).map(r => r.id)).toEqual(['plan-custom-1'])
    } finally {
      verifyDb.close()
    }

    // 3. Path traversal in dshHomePath fails closed.
    await writeFile(
      join(f.profileDir, 'cordis.patch.yml'),
      `- name: "@dsh-enhanced/assistant-verifier"\n  config:\n    databasePath: !js dshHomePath('..', 'outside.sqlite')\n`,
      { mode: 0o600 },
    )
    const traversal = await runUpgrade(
      {
        dshHome: f.dshHome,
        profile: f.profile,
        action: 'check',
        allowNonEmptyHistoryMigration: true,
        osHome: f.osHome,
        platform: 'linux',
      },
      deps(true),
    )
    expect(traversal.exitCode).toBe(1)
    expect(traversal.report.readiness.ledgersOk).toBe(false)
  })

  test('dsh-rsi upgrade --yes recovers stopped/confirm-stopped/already-current managed services and runs post-start doctor (fail-closed on failure)', async () => {
    const f = await createHomeFixture({ hostVersion: '0.2.2-rc.5', enhancedVersion: '0.1.84' })
    const runUpgradeCli = async (argv: string[], upgradeDeps: UpgradeDeps) => {
      const chunks: string[] = []
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        chunks.push(String(chunk))
        return true
      })
      try {
        const code = await main(argv, { DSH_HOME: f.dshHome }, {
          platform: 'linux',
          osHome: f.osHome,
          upgradeDeps,
        })
        return { code, report: JSON.parse(chunks.join('')) as { ok: boolean; ready: boolean; execution?: { error?: string; healthCheckPassed?: boolean } } }
      } finally {
        spy.mockRestore()
      }
    }

    // 1. Already current (0.1.84 -> 0.1.84) with stopped managed service -> starts service & runs post-start doctor.
    const events1: string[] = []
    const res1 = await runUpgradeCli(
      ['upgrade', '--yes', '--json', '--dsh-home', f.dshHome, '--profile', f.profile],
      {
        fetch: makeRegistryFetch('0.1.84', '0.2.2-rc.5'),
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.5', dshPath: '/bin/dsh', issues: [] }),
        inspectService: async () => ({ managed: true, definitionPath: join(f.osHome, '.config/systemd/user/dsh-profile-web.service'), foreign: false }),
        isServiceRunning: async () => false,
        controlService: async (_plat, _home, profile, action) => {
          events1.push(`control:${profile}:${action}`)
          return { profile, actions: [action], messages: [], errors: [] }
        },
        verifyHealth: async () => {
          events1.push('verifyHealth')
          return { ok: true }
        },
        doctor: async () => {
          events1.push('doctor')
          return { ok: true }
        },
      },
    )
    expect(res1.code).toBe(0)
    expect(res1.report.ok).toBe(true)
    expect(events1).toEqual(['verifyHealth', 'control:web:start', 'doctor'])

    // 2. Newer version with --confirm-dsh-home-stopped -> upgrades, starts service, and runs post-start doctor.
    await writeFile(join(f.enhancedDir, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/assistant-web-owner', version: '0.1.83' }), { mode: 0o600 })
    const events2: string[] = []
    const res2 = await runUpgradeCli(
      ['upgrade', '--yes', '--confirm-dsh-home-stopped', '--json', '--dsh-home', f.dshHome, '--profile', f.profile],
      {
        fetch: makeRegistryFetch('0.1.84', '0.2.2-rc.5'),
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.5', dshPath: '/bin/dsh', issues: [] }),
        inspectService: async () => ({ managed: true, definitionPath: join(f.osHome, '.config/systemd/user/dsh-profile-web.service'), foreign: false }),
        isServiceRunning: async () => false,
        upgradeProfilePackages: async () => { events2.push('upgradePkg') },
        controlService: async (_plat, _home, profile, action) => {
          events2.push(`control:${profile}:${action}`)
          return { profile, actions: [action], messages: [], errors: [] }
        },
        verifyHealth: async () => {
          events2.push('verifyHealth')
          return { ok: true }
        },
        doctor: async () => {
          events2.push('doctor')
          return { ok: true }
        },
      },
    )
    expect(res2.code).toBe(0)
    expect(res2.report.ok).toBe(true)
    expect(events2).toEqual(['upgradePkg', 'verifyHealth', 'control:web:start', 'doctor'])

    // 3. Post-start doctor failure fails closed (exit 1, report.ok=false).
    const res3 = await runUpgradeCli(
      ['upgrade', '--yes', '--confirm-dsh-home-stopped', '--json', '--dsh-home', f.dshHome, '--profile', f.profile],
      {
        fetch: makeRegistryFetch('0.1.84', '0.2.2-rc.5'),
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.5', dshPath: '/bin/dsh', issues: [] }),
        inspectService: async () => ({ managed: true, definitionPath: join(f.osHome, '.config/systemd/user/dsh-profile-web.service'), foreign: false }),
        isServiceRunning: async () => false,
        upgradeProfilePackages: async () => {},
        controlService: async (_plat, _home, profile, action) => ({ profile, actions: [action], messages: [], errors: [] }),
        verifyHealth: async () => ({ ok: true }),
        doctor: async () => ({ ok: false, error: 'post-start doctor unhealthy' }),
      },
    )
    expect(res3.code).toBe(1)
    expect(res3.report.ok).toBe(false)
    expect(res3.report.execution?.healthCheckPassed).toBe(false)
    expect(res3.report.execution?.error).toContain('post-start doctor unhealthy')

    // 4. Service start error fails closed (exit 1, report.ok=false).
    const res4 = await runUpgradeCli(
      ['upgrade', '--yes', '--confirm-dsh-home-stopped', '--json', '--dsh-home', f.dshHome, '--profile', f.profile],
      {
        fetch: makeRegistryFetch('0.1.84', '0.2.2-rc.5'),
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.5', dshPath: '/bin/dsh', issues: [] }),
        inspectService: async () => ({ managed: true, definitionPath: join(f.osHome, '.config/systemd/user/dsh-profile-web.service'), foreign: false }),
        isServiceRunning: async () => false,
        upgradeProfilePackages: async () => {},
        controlService: async (_plat, _home, profile, action) => ({ profile, actions: [action], messages: [], errors: ['systemctl failed'] }),
        verifyHealth: async () => ({ ok: true }),
      },
    )
    expect(res4.code).toBe(1)
    expect(res4.report.ok).toBe(false)
    expect(res4.report.execution?.error).toContain('systemctl failed')
  })

  test('rejects symlink dshHome in runUpgrade without traversing symlink target', async () => {
    const f = await createHomeFixture()
    const symHome = join(f.root, 'sym-dsh-home')
    await symlink(f.dshHome, symHome)

    for (const action of ['check', 'dry-run', 'apply'] as const) {
      const res = await runUpgrade(
        {
          dshHome: symHome,
          profile: f.profile,
          action,
          targetVersion: '0.2.0',
          confirmDshHomeStopped: true,
          osHome: f.osHome,
          platform: 'linux',
        },
        {
          fetch: makeRegistryFetch('0.2.0', '0.2.2-rc.5'),
          scanProcesses: async () => ({ processes: [] }),
        },
      )
      expect(res.exitCode).toBe(1)
      expect(res.report.ok).toBe(false)
      expect(res.report.ready).toBe(false)
      expect(res.report.dshHome).toBe(symHome)
      expect(res.report.readiness.blockedReasons.join('\n')).toContain('symlink')
    }
  })
})
