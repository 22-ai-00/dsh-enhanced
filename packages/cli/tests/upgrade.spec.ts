import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { parseDocument } from 'yaml'
import { formatUpgradeReport, main, parseArgs, runUpgrade, validateRegistryUrl, type UpgradeDeps } from '../src/index.ts'
import { defaultUpgradeProfilePackages, defaultVerifyHealth, KNOWN_ENHANCED_PACKAGES } from '../src/upgrade.ts'

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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ray-upgrade-')))
  roots.push(root)
  const osHome = join(root, 'os-home')
  const dshHome = join(root, 'dsh-home')
  const profile = options.profile ?? 'web'
  const profileDir = join(dshHome, 'profiles', profile)
  const enhancedDir = join(profileDir, 'node_modules', '@dsh-ray', 'assistant-web-owner')
  await mkdir(osHome, { recursive: true, mode: 0o700 })
  await mkdir(enhancedDir, { recursive: true, mode: 0o700 })

  const patchOriginal = `- id: dsh-ray-assistant-web-owner\n  name: '@dsh-ray/assistant-web-owner'\n  config:\n    workspace: ${root}/ws\n`
  const pkgOriginal = JSON.stringify({ name: `dsh-profile-${profile}`, private: true, dependencies: { '@dsh-ray/assistant-web-owner': options.enhancedVersion ?? '0.1.73' } }, null, 2)
  const lockOriginal = 'lockfileVersion: 9.0\n'
  const pluginPkgOriginal = JSON.stringify({ name: '@dsh-ray/assistant-web-owner', version: options.enhancedVersion ?? '0.1.73' }, null, 2)

  await writeFile(join(profileDir, 'cordis.patch.yml'), patchOriginal, { mode: 0o600 })
  await writeFile(join(profileDir, 'package.json'), pkgOriginal, { mode: 0o600 })
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), lockOriginal, { mode: 0o600 })
  await writeFile(join(enhancedDir, 'package.json'), pluginPkgOriginal, { mode: 0o600 })

  const hostVersion = options.hostVersion ?? '0.2.2-rc.5'
  const hostPath = join(dshHome, '.dsh-ray-host.json')
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
    if (url.includes('@dsh-ray/cli')) {
      return new Response(JSON.stringify({ 'dist-tags': { latest: enhancedLatest } }), { status: 200 })
    }
    if (url.includes('@deepseek-ai')) {
      return new Response(JSON.stringify({ 'dist-tags': { latest: hostLatest } }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof globalThis.fetch
}

describe('dsh-ray upgrade CLI parsing and URL checks', () => {
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

describe('dsh-ray upgrade check, readiness, and transactional execution', () => {
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

  test('fails closed on corrupt/symlink .dsh-ray-host.json or non-empty creation/revision ledgers', async () => {
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

    // 1b. Symlinked .dsh-ray-host.json is refused cleanly.
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
        await writeFile(join(dshHome, '.dsh-ray-host.json'), JSON.stringify({
          schemaVersion: 1, cacheRoot: join(f.root, 'host-cache'), version: targetVersion, receiptDigest: 'b'.repeat(64),
        }, null, 2), { mode: 0o600 })
      },
      upgradeProfilePackages: async ({ profile, targetVersion }) => {
        const dir = join(f.dshHome, 'profiles', profile)
        await writeFile(join(dir, 'cordis.patch.yml'), '# mutated-during-upgrade\n[]\n', { mode: 0o600 })
        await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'mutated', version: targetVersion }), { mode: 0o600 })
        await writeFile(join(dir, 'node_modules', '@dsh-ray', 'assistant-web-owner', 'package.json'),
          JSON.stringify({ name: '@dsh-ray/assistant-web-owner', version: targetVersion }), { mode: 0o600 })
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
      if (url.endsWith('/@dsh-ray/cli/latest')) {
        return new Response('{}', { status: 404 })
      }
      if (url.endsWith('/@dsh-ray/cli')) {
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
      'https://registry.npmjs.org/@dsh-ray/cli/latest',
      'https://registry.npmjs.org/@dsh-ray/cli',
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
    expect(formatted).toContain(`提示：全局 dsh-ray CLI 当前为 ${clamped.report.packages.cliPackageVersion}，可运行 dsh-ray update 同步升级至 99.0.0`)

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
      '@dsh-ray+assistant-web-owner@0.1.73',
      'node_modules',
      '@dsh-ray',
      'assistant-web-owner',
    )
    await mkdir(pnpmTarget, { recursive: true })
    await writeFile(join(pnpmTarget, 'package.json'), f.pluginPkgOriginal, { mode: 0o600 })
    await symlink(
      '../.pnpm/@dsh-ray+assistant-web-owner@0.1.73/node_modules/@dsh-ray/assistant-web-owner',
      f.enhancedDir,
    )

    const pkgPath = join(f.profileDir, 'package.json')
    const pkgInitial = JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {
        '@dsh-ray/assistant-web-owner': '0.1.73',
        '@dsh-ray/vendor-local': 'file:./vendor/local.tgz',
        lodash: '4.17.21',
      },
      optionalDependencies: {
        '@dsh-ray/lark-channel': '^0.1.73',
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
  - "@dsh-ray/*"
overrides:
  # keep vendor local override untouched
  "@dsh-ray/vendor-local": "file:./vendor/local.tgz"
  "@dsh-ray/assistant-web-owner": "0.1.73"
  "@dsh-ray/lark-channel": ^0.1.73
  "@dsh-ray/a>@dsh-ray/b": "0.1.70"
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
        args: ['install', '--dir', f.profileDir, '--no-frozen-lockfile', '--ignore-scripts', '--config.confirmModulesPurge=false', '--registry', 'https://registry.npmjs.org'],
      },
    ])

    const updatedPkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    expect(updatedPkg.dependencies).toEqual({
      '@dsh-ray/assistant-web-owner': '0.1.74',
      '@dsh-ray/vendor-local': 'file:./vendor/local.tgz',
      lodash: '4.17.21',
    })
    expect(updatedPkg.optionalDependencies).toEqual({
      '@dsh-ray/lark-channel': '0.1.74',
    })
    expect((await stat(pkgPath)).mode & 0o777).toBe(0o640)

    const updatedWs = await readFile(wsPath, 'utf8')
    expect(updatedWs).toContain('# preserve workspace comments')
    expect(updatedWs).toContain('nodeLinker: hoisted')
    expect(updatedWs).toContain('autoInstallPeers: true')
    expect(updatedWs).toContain('better-sqlite3: true')
    expect(updatedWs).toContain('minimumReleaseAgeExclude:')
    expect(updatedWs).toContain('"@dsh-ray/vendor-local": "file:./vendor/local.tgz"')
    expect(updatedWs).toContain('"@dsh-ray/assistant-web-owner": "0.1.74"')
    expect(updatedWs).toContain('"@dsh-ray/lark-channel": 0.1.74')
    expect(updatedWs).toContain('"@dsh-ray/a>@dsh-ray/b": "0.1.70"')
    expect((await stat(wsPath)).mode & 0o777).toBe(0o640)
  })

  test('defaultUpgradeProfilePackages injects npmPlugins when package.json lacks @dsh-ray/* and passes --legacy-peer-deps for pure npm profiles', async () => {
    const f = await createHomeFixture({ profile: 'npm-only' })
    await rm(join(f.profileDir, 'pnpm-lock.yaml'))
    const npmCalls: Array<{ command: string; args: readonly string[] }> = []

    await defaultUpgradeProfilePackages({
      dshHome: f.dshHome,
      profile: f.profile,
      targetVersion: '0.1.75',
      registryUrl: 'https://registry.npmjs.org',
      npmPlugins: ['@dsh-ray/assistant-web-owner'],
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
          '@dsh-ray/assistant-web-owner@0.1.75',
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
      npmPlugins: ['@dsh-ray/assistant-web-owner'],
      osHome: f.osHome,
      platform: 'linux',
      env: { PATH: '' },
      runner: (command, args) => {
        pnpmCalls.push({ command, args })
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    const populatedPkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    expect(populatedPkg.dependencies).toEqual({ '@dsh-ray/assistant-web-owner': '0.1.75' })
    expect(pnpmCalls[0]?.args).toEqual([
      'install',
      '--dir', f.profileDir,
      '--no-frozen-lockfile',
      '--ignore-scripts',
      '--config.confirmModulesPurge=false',
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
        await writeFile(join(dshHome, '.dsh-ray-host.json'), JSON.stringify({
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
      `- name: "@dsh-ray/plugin-control-plane"\n  config:\n    databasePath: !js dshHomePath('custom-ledgers', 'cp-custom.sqlite')\n`,
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
      `- name: "@dsh-ray/assistant-verifier"\n  config:\n    databasePath: !js dshHomePath('..', 'outside.sqlite')\n`,
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

  test('dsh-ray upgrade --yes recovers stopped/confirm-stopped/already-current managed services and runs post-start doctor (fail-closed on failure)', async () => {
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
    await writeFile(join(f.enhancedDir, 'package.json'), JSON.stringify({ name: '@dsh-ray/assistant-web-owner', version: '0.1.83' }), { mode: 0o600 })
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

  test('F28: merges minimumReleaseAgeExclude versions onto first rule without duplicates and respects minimumReleaseAgeStrict', async () => {
    const f = await createHomeFixture({ profile: 'assistant', enhancedVersion: '0.1.82' })
    const wsPath = join(f.profileDir, 'pnpm-workspace.yaml')
    const fakeBinDir = join(f.root, 'fake-bin-f28-exclude')
    await mkdir(fakeBinDir, { recursive: true })
    const fakePnpm = join(fakeBinDir, 'pnpm')
    await writeFile(fakePnpm, '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 })
    await chmod(fakePnpm, 0o755)

    // 1. Workspace WITHOUT overrides: preserves comments, merges versions onto first entry with `||`, removes duplicates, appends @0.1.85 for all KNOWN_ENHANCED_PACKAGES
    const wsWithoutOverrides = `# assistant workspace
nodeLinker: isolated
autoInstallPeers: false
minimumReleaseAgeExclude:
  - '@dsh-ray/assistant-delivery@0.1.82'
  - '@dsh-ray/assistant-policy@0.1.82'
  - '@dsh-ray/assistant-delivery@0.1.85'
`
    await writeFile(wsPath, wsWithoutOverrides, { mode: 0o600 })
    await defaultUpgradeProfilePackages({
      dshHome: f.dshHome,
      profile: 'assistant',
      targetVersion: '0.1.85',
      registryUrl: 'https://registry.npmjs.org',
      npmPlugins: ['@dsh-ray/assistant-web-owner'],
      runner: () => ({ status: 0, stdout: '', stderr: '' }),
      env: { PATH: fakeBinDir },
      osHome: f.osHome,
    })

    const updatedRaw = await readFile(wsPath, 'utf8')
    expect(updatedRaw).toContain('# assistant workspace')
    expect(updatedRaw).toContain('nodeLinker: isolated')
    const parsed = parseDocument(updatedRaw).toJS() as { minimumReleaseAgeExclude: string[] }
    expect(parsed.minimumReleaseAgeExclude.slice(0, 2)).toEqual([
      '@dsh-ray/assistant-delivery@0.1.82 || 0.1.85',
      '@dsh-ray/assistant-policy@0.1.82 || 0.1.85',
    ])
    // Deduplicated: delivery appears only once with merged semver OR versions
    expect(parsed.minimumReleaseAgeExclude.filter(x => x.startsWith('@dsh-ray/assistant-delivery@'))).toHaveLength(1)
    expect(parsed.minimumReleaseAgeExclude.filter(x => x.startsWith('@dsh-ray/assistant-policy@'))).toHaveLength(1)
    for (const pkg of KNOWN_ENHANCED_PACKAGES) {
      if (pkg === '@dsh-ray/assistant-delivery' || pkg === '@dsh-ray/assistant-policy') continue
      expect(parsed.minimumReleaseAgeExclude).toContain(`${pkg}@0.1.85`)
    }

    // 2. minimumReleaseAgeStrict: true forbids adding exclusions
    const strictWs = 'nodeLinker: isolated\nminimumReleaseAgeStrict: true\nminimumReleaseAgeExclude:\n  - "@dsh-ray/assistant-delivery@0.1.82"\n'
    await writeFile(wsPath, strictWs, { mode: 0o600 })
    await defaultUpgradeProfilePackages({
      dshHome: f.dshHome,
      profile: 'assistant',
      targetVersion: '0.1.85',
      registryUrl: 'https://registry.npmjs.org',
      npmPlugins: ['@dsh-ray/assistant-web-owner'],
      runner: () => ({ status: 0, stdout: '', stderr: '' }),
      env: { PATH: fakeBinDir },
      osHome: f.osHome,
    })
    expect(await readFile(wsPath, 'utf8')).toBe(strictWs)
  })

  test('F28: Linux restart-supervisor stop, backup, .pnpm digest/ExecStart refresh, daemon-reload, timer restart, rollback, and dshHome guard', async () => {
    const f = await createHomeFixture({ profile: 'assistant', enhancedVersion: '0.1.82' })
    const sha = (source: string | Uint8Array) => createHash('sha256').update(source).digest('hex')
    await writeFile(join(f.profileDir, 'pnpm-workspace.yaml'), 'nodeLinker: isolated\n', { mode: 0o600 })

    // Create a valid bound host directory matching hostReceipt
    const hostRoot = join(f.root, 'host-cache', '0.2.2-rc.5')
    await mkdir(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    await writeFile(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '#!/usr/bin/env node\n', { mode: 0o644 })
    const hostReceiptRaw = JSON.stringify({ schemaVersion: 1, version: '0.2.2-rc.5', entries: [] })
    await writeFile(join(hostRoot, 'receipt.json'), hostReceiptRaw, { mode: 0o600 })
    const hostBindingRaw = JSON.stringify({
      schemaVersion: 1,
      cacheRoot: join(f.root, 'host-cache'),
      version: '0.2.2-rc.5',
      receiptDigest: sha(hostReceiptRaw),
    }, null, 2)
    await writeFile(f.hostPath, hostBindingRaw, { mode: 0o600 })

    // Seed .pnpm virtual store at 0.1.82 (direct assistant-delivery + transitive assistant-policy)
    const mkPnpmPkg = async (ver: string, slug: string, files: Record<string, string>) => {
      const storePkg = join(f.profileDir, 'node_modules', '.pnpm', `@dsh-ray+${slug}@${ver}_cordis`, 'node_modules', '@dsh-ray', slug)
      await mkdir(join(storePkg, 'lib'), { recursive: true })
      await mkdir(join(storePkg, 'bin'), { recursive: true })
      await writeFile(join(storePkg, 'package.json'), JSON.stringify({ name: `@dsh-ray/${slug}`, version: ver }), { mode: 0o644 })
      for (const [rel, content] of Object.entries(files)) {
        await writeFile(join(storePkg, rel), content, { mode: 0o644 })
      }
      return storePkg
    }

    const oldDeliveryRoot = await mkPnpmPkg('0.1.82', 'assistant-delivery', {
      'bin/dsh-restart-supervisor.js': '#!/usr/bin/env node\n// old\n',
      'lib/restart-supervisor.js': 'export const v = "0.1.82"\n',
    })
    await mkPnpmPkg('0.1.82', 'assistant-policy', {
      'lib/evaluator.js': 'export const compilePolicy = x => x; export const evaluatePolicy = () => ({ effect: "allow" })\n',
    })
    await rm(join(f.profileDir, 'node_modules', '@dsh-ray'), { recursive: true, force: true })
    await mkdir(join(f.profileDir, 'node_modules', '@dsh-ray'), { recursive: true })
    await symlink(oldDeliveryRoot, join(f.profileDir, 'node_modules', '@dsh-ray', 'assistant-delivery'))

    // Seed restart-supervisor config + systemd units
    const supStateDir = join(f.osHome, '.local', 'state', 'dsh-ray', 'restart-supervisor', 'assistant')
    const systemdDir = join(f.osHome, '.config', 'systemd', 'user')
    await mkdir(supStateDir, { recursive: true, mode: 0o700 })
    await mkdir(systemdDir, { recursive: true, mode: 0o700 })
    const profileServicePath = join(systemdDir, 'dsh-profile-assistant.service')
    const profileServiceRaw = `[Unit]\nDescription=assistant\n[Service]\nWorkingDirectory=${f.profileDir}\nEnvironment="DSH_HOME=${f.dshHome}"\n`
    await writeFile(profileServicePath, profileServiceRaw, { mode: 0o600 })

    const supConfigPath = join(supStateDir, 'config.json')
    const supServicePath = join(systemdDir, 'dsh-restart-supervisor-assistant.service')
    const initialSupConfig = {
      dshHome: f.dshHome,
      profile: 'assistant',
      databasePath: join(f.dshHome, 'assistant-delivery', 'restart.sqlite'),
      deliveryDatabasePath: join(f.dshHome, 'assistant-delivery', 'state.sqlite'),
      policyDatabasePath: join(f.dshHome, 'assistant-policy', 'policy.sqlite'),
      automationDatabasePath: join(f.dshHome, 'assistant-automations', 'state.sqlite'),
      policyEvaluatorPath: join(f.profileDir, 'node_modules', '.pnpm', '@dsh-ray+assistant-policy@0.1.82_cordis', 'node_modules', '@dsh-ray', 'assistant-policy', 'lib', 'evaluator.js'),
      profilePatchDigest: '0'.repeat(64),
      cohortReceiptDigest: '1'.repeat(64),
      sourceCommit: 'a'.repeat(40),
      restartOwnerRouteId: 'owner-route-1',
      hostBindingDigest: '2'.repeat(64),
      hostReceiptPath: join(hostRoot, 'receipt.json'),
      hostReceiptSourceDigest: '3'.repeat(64),
      trustedFiles: [{ path: join(oldDeliveryRoot, 'package.json'), digest: '4'.repeat(64) }],
      policyRules: [],
      unit: 'dsh-profile-assistant.service',
      expectedUnitDigest: '5'.repeat(64),
      readyTimeoutMs: 120_000,
      stableWindowMs: 12_000,
      maxRestarts: 3,
      windowMs: 600_000,
    }
    const initialSupConfigText = `${JSON.stringify(initialSupConfig, null, 2)}\n`
    const initialSupServiceText = `[Unit]\nDescription=supervisor\n[Service]\nExecStart=/usr/bin/node --disable-warning=ExperimentalWarning ${join(oldDeliveryRoot, 'bin/dsh-restart-supervisor.js')} --config ${supConfigPath} --once\n`
    await writeFile(supConfigPath, initialSupConfigText, { mode: 0o600 })
    await writeFile(supServicePath, initialSupServiceText, { mode: 0o600 })

    // Also seed a DIFFERENT Home's supervisor to verify isolation guard
    const otherSupDir = join(f.osHome, '.local', 'state', 'dsh-ray', 'restart-supervisor', 'other')
    await mkdir(otherSupDir, { recursive: true, mode: 0o700 })
    const otherConfigText = JSON.stringify({ ...initialSupConfig, profile: 'other', dshHome: '/some/other/dsh-home' })
    await writeFile(join(otherSupDir, 'config.json'), otherConfigText, { mode: 0o600 })

    // Dry-run plan includes supervisor config & service
    const dryRes = await runUpgrade({
      dshHome: f.dshHome,
      profile: 'assistant',
      action: 'dry-run',
      targetVersion: '0.1.85',
      platform: 'linux',
      osHome: f.osHome,
    }, {
      fetch: makeRegistryFetch('0.1.85', '0.2.2-rc.5'),
      inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.5', dshPath: '/bin/dsh', issues: [] }),
    })
    expect(dryRes.exitCode).toBe(0)
    expect(dryRes.report.plan.backupFiles).toContain(supConfigPath)
    expect(dryRes.report.plan.backupFiles).toContain(supServicePath)

    const systemctlCalls: string[] = []
    const makeDeps = (healthOk: boolean): UpgradeDeps => ({
      fetch: makeRegistryFetch('0.1.85', '0.2.2-rc.5'),
      inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.5', dshPath: '/bin/dsh', issues: [] }),
      inspectService: async () => ({ managed: false, definitionPath: profileServicePath, foreign: false }),
      scanProcesses: async () => ({ processes: [] }),
      runner: (command, args) => {
        if (command === 'systemctl') {
          systemctlCalls.push(args.join(' '))
          return { status: 0, stdout: 'active\n', stderr: '' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
      upgradeProfilePackages: async () => {
        const newDelivery = await mkPnpmPkg('0.1.85', 'assistant-delivery', {
          'bin/dsh-restart-supervisor.js': '#!/usr/bin/env node\n// new 0.1.85\n',
          'lib/restart-supervisor.js': 'export const v = "0.1.85"\n',
        })
        await mkPnpmPkg('0.1.85', 'assistant-policy', {
          'lib/evaluator.js': 'export const compilePolicy = x => x; export const evaluatePolicy = () => ({ effect: "allow", v: "0.1.85" })\n',
        })
        await rm(join(f.profileDir, 'node_modules', '@dsh-ray', 'assistant-delivery'), { force: true })
        await symlink(newDelivery, join(f.profileDir, 'node_modules', '@dsh-ray', 'assistant-delivery'))
      },
      verifyHealth: async () => healthOk ? { ok: true } : { ok: false, error: 'post-upgrade failed' },
    })

    // 1. Rollback restores config.json, .service, runs daemon-reload, and restarts stopped timer
    const failed = await runUpgrade({
      dshHome: f.dshHome,
      profile: 'assistant',
      action: 'apply',
      targetVersion: '0.1.85',
      confirmDshHomeStopped: true,
      platform: 'linux',
      osHome: f.osHome,
    }, makeDeps(false))
    expect(failed.exitCode).toBe(1)
    expect(failed.report.execution?.rolledBack).toBe(true)
    expect(failed.report.execution?.rollbackSucceeded).toBe(true)
    expect(await readFile(supConfigPath, 'utf8')).toBe(initialSupConfigText)
    expect(await readFile(supServicePath, 'utf8')).toBe(initialSupServiceText)
    expect(systemctlCalls).toEqual([
      '--user is-active dsh-restart-supervisor-assistant.timer',
      '--user is-active dsh-restart-supervisor-assistant.service',
      '--user stop dsh-restart-supervisor-assistant.timer dsh-restart-supervisor-assistant.service',
      '--user daemon-reload',
      '--user daemon-reload',
      '--user start dsh-restart-supervisor-assistant.timer',
    ])

    // 2. Success refreshes config.json digests, ExecStart, runs daemon-reload, restarts timer, and never touches otherHome
    systemctlCalls.length = 0
    const succeeded = await runUpgrade({
      dshHome: f.dshHome,
      profile: 'assistant',
      action: 'apply',
      targetVersion: '0.1.85',
      confirmDshHomeStopped: true,
      platform: 'linux',
      osHome: f.osHome,
    }, makeDeps(true))
    expect(succeeded.exitCode).toBe(0)
    const refreshedConfig = JSON.parse(await readFile(supConfigPath, 'utf8')) as typeof initialSupConfig
    expect(refreshedConfig.cohortReceiptDigest).toBe('1'.repeat(64))
    expect(refreshedConfig.sourceCommit).toBe('a'.repeat(40))
    expect(refreshedConfig.policyEvaluatorPath).toContain('@dsh-ray+assistant-policy@0.1.85_cordis')
    expect(refreshedConfig.profilePatchDigest).toBe(sha(await readFile(join(f.profileDir, 'cordis.patch.yml'))))
    expect(refreshedConfig.expectedUnitDigest).toBe(sha(profileServiceRaw))
    expect(refreshedConfig.hostBindingDigest).toBe(sha(hostBindingRaw))
    expect(refreshedConfig.hostReceiptSourceDigest).toBe(sha(hostReceiptRaw))
    expect(refreshedConfig.trustedFiles.some(item => item.path === refreshedConfig.policyEvaluatorPath)).toBe(true)
    expect(refreshedConfig.trustedFiles.some(item => item.path.includes('@dsh-ray+assistant-delivery@0.1.85_cordis') && item.path.endsWith('dsh-restart-supervisor.js'))).toBe(true)
    const refreshedService = await readFile(supServicePath, 'utf8')
    expect(refreshedService).toContain('@dsh-ray+assistant-delivery@0.1.85_cordis/node_modules/@dsh-ray/assistant-delivery/bin/dsh-restart-supervisor.js')
    expect(await readFile(join(otherSupDir, 'config.json'), 'utf8')).toBe(otherConfigText)
    expect(systemctlCalls).toEqual([
      '--user is-active dsh-restart-supervisor-assistant.timer',
      '--user is-active dsh-restart-supervisor-assistant.service',
      '--user stop dsh-restart-supervisor-assistant.timer dsh-restart-supervisor-assistant.service',
      '--user daemon-reload',
      '--user start dsh-restart-supervisor-assistant.timer',
    ])

    // 3. Large Host receipt.json (>16 MiB, <=32 MiB — matching real 0.2.2-rc.5 receipt ~18.9 MiB) succeeds; >32 MiB fails closed & rolls back.
    const largeReceiptRaw = JSON.stringify({
      schemaVersion: 1,
      version: '0.2.2-rc.5',
      entries: [],
      pad: 'x'.repeat(18 * 1024 * 1024),
    })
    await writeFile(join(hostRoot, 'receipt.json'), largeReceiptRaw, { mode: 0o600 })
    const largeHostBindingRaw = JSON.stringify({
      schemaVersion: 1,
      cacheRoot: join(f.root, 'host-cache'),
      version: '0.2.2-rc.5',
      receiptDigest: sha(largeReceiptRaw),
    }, null, 2)
    await writeFile(f.hostPath, largeHostBindingRaw, { mode: 0o600 })
    systemctlCalls.length = 0
    const largeSucceeded = await runUpgrade({
      dshHome: f.dshHome,
      profile: 'assistant',
      action: 'apply',
      targetVersion: '0.1.86',
      confirmDshHomeStopped: true,
      platform: 'linux',
      osHome: f.osHome,
    }, {
      ...makeDeps(true),
      fetch: makeRegistryFetch('0.1.86', '0.2.2-rc.5'),
    })
    expect(largeSucceeded.exitCode).toBe(0)
    expect(JSON.parse(await readFile(supConfigPath, 'utf8')).hostReceiptSourceDigest).toBe(sha(largeReceiptRaw))

    const oversizedReceiptRaw = JSON.stringify({
      schemaVersion: 1,
      version: '0.2.2-rc.5',
      entries: [],
      pad: 'x'.repeat(33 * 1024 * 1024),
    })
    await writeFile(join(hostRoot, 'receipt.json'), oversizedReceiptRaw, { mode: 0o600 })
    const oversizedRejected = await runUpgrade({
      dshHome: f.dshHome,
      profile: 'assistant',
      action: 'apply',
      targetVersion: '0.1.87',
      confirmDshHomeStopped: true,
      platform: 'linux',
      osHome: f.osHome,
    }, {
      ...makeDeps(true),
      fetch: makeRegistryFetch('0.1.87', '0.2.2-rc.5'),
    })
    expect(oversizedRejected.exitCode).toBe(1)
    expect(oversizedRejected.report.execution?.rolledBack).toBe(true)
    expect(oversizedRejected.report.execution?.error).toContain('host receipt.json文件不安全')
  })

  test('skips Linux frozen-owner detection on win32 and darwin so standard-local checks succeed cross-platform', async () => {
    const f = await createHomeFixture()
    let frozenChecked = 0
    for (const plat of ['win32', 'darwin'] as const) {
      const check = await runUpgrade(
        { dshHome: f.dshHome, profile: f.profile, action: 'check', osHome: f.osHome, platform: plat },
        {
          fetch: makeRegistryFetch('0.1.85', '0.2.2-rc.5'),
          inspectBoundHost: async () => ({ status: 'missing', bindingPath: f.hostPath, issues: [] }),
          detectFrozenOwner: async () => {
            frozenChecked++
            throw new Error(`unexpected frozen-owner check on ${plat}`)
          },
        },
      )
      expect(check.exitCode).toBe(0)
      expect(check.report.readiness.ok).toBe(true)
      expect(check.report.mode).toBe('standard-local')
      expect(check.report.frozenSystemd).toEqual({ detected: false, profiles: [] })

      const dry = await runUpgrade(
        { dshHome: f.dshHome, profile: f.profile, action: 'dry-run', osHome: f.osHome, platform: plat },
        {
          fetch: makeRegistryFetch('0.1.85', '0.2.2-rc.5'),
          inspectBoundHost: async () => ({ status: 'missing', bindingPath: f.hostPath, issues: [] }),
          detectFrozenOwner: async () => {
            frozenChecked++
            throw new Error(`unexpected frozen-owner check on ${plat}`)
          },
        },
      )
      expect(dry.exitCode).toBe(0)
      expect(dry.report.ok).toBe(true)
      expect(dry.report.mode).toBe('standard-local')
    }
    expect(frozenChecked).toBe(0)
  })

  test('real pnpm@11.7.0 non-TTY ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY regression via defaultUpgradeProfilePackages', async () => {
    const f = await createHomeFixture({ profile: 'desktop', enhancedVersion: '0.2.0' })
    const buildPkgTgz = async (ver: string) => {
      const srcDir = join(f.root, `src-hello-${ver}`)
      await mkdir(srcDir, { recursive: true })
      await writeFile(join(srcDir, 'package.json'), JSON.stringify({ name: '@dsh-ray/hello', version: ver, main: 'index.js' }))
      await writeFile(join(srcDir, 'index.js'), `export const version = ${JSON.stringify(ver)};\n`)
      const packed = spawnSync('npm', ['pack', '--pack-destination', f.root], { cwd: srcDir, encoding: 'utf8' })
      expect(packed.status).toBe(0)
      const tgzName = packed.stdout.trim().split('\n').pop()!
      const tgzBytes = await readFile(join(f.root, tgzName))
      return {
        tgzName,
        tgzPath: join(f.root, tgzName),
        shasum: createHash('sha1').update(tgzBytes).digest('hex'),
        integrity: `sha512-${createHash('sha512').update(tgzBytes).digest('base64')}`,
      }
    }

    const tgz21 = await buildPkgTgz('0.2.1')
    const tgz22 = await buildPkgTgz('0.2.2')
    // Run the mock npm registry in a separate child process so spawnSync('pnpm', ...) inside
    // defaultUpgradeProfilePackages does not block the HTTP server's event loop.
    const serverScriptPath = join(f.root, 'registry-server.mjs')
    await writeFile(serverScriptPath, [
      "import { createServer } from 'node:http';",
      "import { readFileSync } from 'node:fs';",
      `const tgz21 = { name: ${JSON.stringify(tgz21.tgzName)}, bytes: readFileSync(${JSON.stringify(tgz21.tgzPath)}), shasum: ${JSON.stringify(tgz21.shasum)}, integrity: ${JSON.stringify(tgz21.integrity)} };`,
      `const tgz22 = { name: ${JSON.stringify(tgz22.tgzName)}, bytes: readFileSync(${JSON.stringify(tgz22.tgzPath)}), shasum: ${JSON.stringify(tgz22.shasum)}, integrity: ${JSON.stringify(tgz22.integrity)} };`,
      'let port = 0;',
      'const server = createServer((req, res) => {',
      "  const reqUrl = (req.url || '/').split('?')[0];",
      '  if (reqUrl === `/tarballs/${tgz21.name}`) { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(tgz21.bytes); return; }',
      '  if (reqUrl === `/tarballs/${tgz22.name}`) { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(tgz22.bytes); return; }',
      '  if (reqUrl === "/@dsh-ray%2fhello" || reqUrl === "/@dsh-ray%2Fhello" || reqUrl === "/@dsh-ray/hello") {',
      '    const mk = (ver, t) => ({ name: "@dsh-ray/hello", version: ver, main: "index.js", dist: { tarball: `http://127.0.0.1:${port}/tarballs/${t.name}`, shasum: t.shasum, integrity: t.integrity } });',
      '    res.writeHead(200, { "content-type": "application/json" });',
      '    res.end(JSON.stringify({ name: "@dsh-ray/hello", "dist-tags": { latest: "0.2.2" }, versions: { "0.2.1": mk("0.2.1", tgz21), "0.2.2": mk("0.2.2", tgz22) } }));',
      '    return;',
      '  }',
      '  res.writeHead(404); res.end();',
      '});',
      'server.listen(0, "127.0.0.1", () => {',
      '  port = server.address().port;',
      '  process.stdout.write(`READY:${port}\\n`);',
      '});',
    ].join('\n'))
    const srvProc = spawn(process.execPath, [serverScriptPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      let buf = ''
      const timer = setTimeout(() => rejectPort(new Error('registry child server timeout')), 5000)
      srvProc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        const m = /READY:(\d+)/u.exec(buf)
        if (m) {
          clearTimeout(timer)
          resolvePort(Number(m[1]))
        }
      })
      srvProc.once('error', err => { clearTimeout(timer); rejectPort(err) })
      srvProc.once('exit', code => { clearTimeout(timer); rejectPort(new Error(`registry child exited early: ${code}`)) })
    })

    try {
      const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
      delete cleanEnv.CI
      delete cleanEnv.CONTINUOUS_INTEGRATION
      delete cleanEnv.GITHUB_ACTIONS
      cleanEnv.HOME = f.osHome
      cleanEnv.XDG_DATA_HOME = join(f.root, 'xdg-data')
      cleanEnv.XDG_CACHE_HOME = join(f.root, 'xdg-cache')
      cleanEnv.XDG_STATE_HOME = join(f.root, 'xdg-state')
      cleanEnv.npm_config_store_dir = join(f.root, 'pnpm-store')

      await rm(join(f.profileDir, 'node_modules'), { recursive: true, force: true })
      await writeFile(join(f.profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-desktop',
        private: true,
        dependencies: { '@dsh-ray/hello': '0.2.1' },
      }, null, 2), { mode: 0o600 })
      await writeFile(join(f.profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: isolated\n', { mode: 0o600 })

      const initRes = spawnSync('pnpm', [
        'install', '--dir', f.profileDir, '--no-frozen-lockfile', '--ignore-scripts', '--registry', `http://127.0.0.1:${port}`,
      ], { env: { ...cleanEnv, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
      expect(initRes.status, initRes.stdout + initRes.stderr).toBe(0)

      // Force a modules purge condition on next non-TTY pnpm run (stale storeDir in .modules.yaml)
      await writeFile(join(f.profileDir, 'node_modules', '.modules.yaml'), 'hoistPattern:\n  - "*"\nstoreDir: /nonexistent/store-dir\n')
      await writeFile(join(f.profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-desktop',
        private: true,
        dependencies: { '@dsh-ray/hello': '0.2.2' },
      }, null, 2), { mode: 0o600 })

      // Baseline check: bare pnpm WITHOUT CI=true / confirmModulesPurge=false aborts on non-TTY
      const bareNonTty = spawnSync('pnpm', [
        'install', '--dir', f.profileDir, '--no-frozen-lockfile', '--ignore-scripts', '--registry', `http://127.0.0.1:${port}`,
      ], { env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
      expect(bareNonTty.status).toBe(1)
      expect(`${bareNonTty.stdout}\n${bareNonTty.stderr}`).toContain('ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY')

      // Reset package.json back to 0.2.1 and run defaultUpgradeProfilePackages with cleanEnv (NO CI)
      await writeFile(join(f.profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-desktop',
        private: true,
        dependencies: { '@dsh-ray/hello': '0.2.1' },
      }, null, 2), { mode: 0o600 })
      const { defaultRunner } = await import('../src/run.ts')
      await defaultUpgradeProfilePackages({
        dshHome: f.dshHome,
        profile: 'desktop',
        targetVersion: '0.2.2',
        registryUrl: `http://127.0.0.1:${port}`,
        npmPlugins: ['@dsh-ray/hello'],
        runner: defaultRunner,
        platform: 'linux',
        osHome: f.osHome,
        env: cleanEnv,
      })

      const installedHello = JSON.parse(await readFile(join(f.profileDir, 'node_modules', '@dsh-ray', 'hello', 'package.json'), 'utf8')) as { version: string }
      expect(installedHello.version).toBe('0.2.2')
    } finally {
      srvProc.kill('SIGKILL')
    }
  })

  test('resolves nvm/bundled Electron pnpm.mjs & npm fallbacks with stripped PATH and allows desktop unready autonomy while enforcing explicit readiness', async () => {
    const f = await createHomeFixture({ profile: 'desktop', enhancedVersion: '0.2.0' })

    // 1. NVM bin discovery picks newest SemVer & bundled DeepSeek Harness.app pnpm.mjs uses Electron node override cleanly
    const nvmOld = join(f.osHome, '.nvm', 'versions', 'node', 'v20.10.0', 'bin')
    const nvmNew = join(f.osHome, '.nvm', 'versions', 'node', 'v24.22.3', 'bin')
    await mkdir(nvmOld, { recursive: true })
    await mkdir(nvmNew, { recursive: true })
    await writeFile(join(nvmOld, 'pnpm'), '#!/bin/sh\necho old\nexit 1\n', { mode: 0o755 })
    const capturedPath = join(f.root, 'nvm-captured.json')
    await writeFile(join(nvmNew, 'pnpm'), [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(capturedPath)}, JSON.stringify({ CI: process.env.CI ?? null, isTTY: Boolean(process.stdin.isTTY), PATH: process.env.PATH ?? '' }));`,
    ].join('\n'), { mode: 0o755 })
    await chmod(join(nvmNew, 'pnpm'), 0o755)
    await writeFile(join(f.profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')

    const { defaultRunner } = await import('../src/run.ts')
    await defaultUpgradeProfilePackages({
      dshHome: f.dshHome,
      profile: 'desktop',
      targetVersion: '0.2.2',
      registryUrl: 'https://registry.npmjs.org',
      npmPlugins: ['@dsh-ray/assistant-web-owner'],
      runner: defaultRunner,
      platform: 'darwin',
      osHome: f.osHome,
      env: { PATH: '', HOME: f.osHome },
    })
    const nvmCaptured = JSON.parse(await readFile(capturedPath, 'utf8')) as { CI: string | null; isTTY: boolean; PATH: string }
    expect(nvmCaptured.CI).toBe('true')
    expect(nvmCaptured.isTTY).toBe(false)
    expect(nvmCaptured.PATH).toContain(nvmNew)

    // 2. Bundled DeepSeek Harness.app pnpm.mjs + non-node DSH_DESKTOP_NODE_EXECUTABLE sets ELECTRON_RUN_AS_NODE=1
    await rm(join(f.osHome, '.nvm'), { recursive: true, force: true })
    const appContents = join(f.root, 'Applications', 'DeepSeek Harness.app', 'Contents')
    const bundledPnpm = join(appContents, 'Resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
    const electronExec = join(appContents, 'MacOS', 'DeepSeek Harness')
    await mkdir(join(appContents, 'Resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin'), { recursive: true })
    await mkdir(join(appContents, 'MacOS'), { recursive: true })
    await writeFile(bundledPnpm, '// bundled pnpm\n', { mode: 0o644 })
    await writeFile(electronExec, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await chmod(electronExec, 0o755)
    const detailedCalls: Array<{ cmd: string; args: readonly string[]; electronNode: string | undefined; ci: string | undefined }> = []
    await defaultUpgradeProfilePackages({
      dshHome: f.dshHome,
      profile: 'desktop',
      targetVersion: '0.2.2',
      registryUrl: 'https://registry.npmjs.org',
      npmPlugins: ['@dsh-ray/assistant-web-owner'],
      runner: defaultRunner,
      detailedRunner: (cmd, args, opts) => {
        detailedCalls.push({
          cmd,
          args,
          electronNode: opts?.env?.ELECTRON_RUN_AS_NODE,
          ci: opts?.env?.CI,
        })
        return { status: 0, stdout: '', stderr: '' }
      },
      platform: 'darwin',
      osHome: f.osHome,
      env: { PATH: '', HOME: f.osHome, DSH_DESKTOP_NODE_EXECUTABLE: electronExec },
    })
    expect(detailedCalls).toEqual([{
      cmd: electronExec,
      args: [bundledPnpm, 'install', '--dir', f.profileDir, '--no-frozen-lockfile', '--ignore-scripts', '--config.confirmModulesPurge=false', '--registry', 'https://registry.npmjs.org'],
      electronNode: '1',
      ci: 'true',
    }])

    // 3. Pure npm profile on stripped GUI PATH resolves ~/.local/bin/npm fallback cleanly
    await rm(join(f.profileDir, 'pnpm-lock.yaml'), { force: true })
    const localBin = join(f.osHome, '.local', 'bin')
    await mkdir(localBin, { recursive: true })
    const fallbackNpm = join(localBin, 'npm')
    await writeFile(fallbackNpm, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await chmod(fallbackNpm, 0o755)
    const npmDetailedCalls: string[] = []
    await defaultUpgradeProfilePackages({
      dshHome: f.dshHome,
      profile: 'desktop',
      targetVersion: '0.2.2',
      registryUrl: 'https://registry.npmjs.org',
      npmPlugins: ['@dsh-ray/assistant-web-owner'],
      runner: defaultRunner,
      detailedRunner: (cmd) => {
        npmDetailedCalls.push(cmd)
        return { status: 0, stdout: '', stderr: '' }
      },
      platform: 'darwin',
      osHome: f.osHome,
      env: { PATH: '', HOME: f.osHome },
    })
    expect(npmDetailedCalls).toEqual([fallbackNpm])

    // 4. defaultVerifyHealth on macOS desktop without .dsh-ray-host.json or global `dsh` handles unready autonomy
    await rm(f.hostPath, { force: true })
    await mkdir(join(f.profileDir, 'node_modules', '@dsh-ray', 'assistant-web-owner', 'bin'), { recursive: true })
    await mkdir(join(f.profileDir, 'node_modules', '@dsh-ray', 'assistant-policy'), { recursive: true })
    await writeFile(join(f.profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', dependencies: { '@dsh-ray/assistant-web-owner': '0.2.2' } }), { mode: 0o600 })
    await writeFile(
      join(f.profileDir, 'node_modules', '@dsh-ray', 'assistant-web-owner', 'bin', 'dsh-autonomy-doctor.js'),
      `console.log(JSON.stringify({ protocol: 'dsh-ray/autonomy-readiness/v1', ready: false, checks: [{ id: 'owner-route', status: 'not-ready' }] }))\nprocess.exit(1)\n`,
      { mode: 0o755 },
    )
    const { defaultDetailedRunner } = await import('../src/run.ts')
    const health = await defaultVerifyHealth({
      dshHome: f.dshHome,
      profile: 'desktop',
      profiles: ['desktop'],
      runner: (cmd, args) => cmd === 'dsh'
        ? { status: null, stdout: '', stderr: 'spawnSync dsh ENOENT' }
        : defaultDetailedRunner(cmd, args),
      platform: 'darwin',
      osHome: f.osHome,
      env: { PATH: '' },
    })
    expect(health.ok).toBe(true)
    expect(health.report?.profiles[0]?.autonomyReadiness?.ok).toBe(false)

    const strictHealth = await defaultVerifyHealth({
      dshHome: f.dshHome,
      profile: 'desktop',
      profiles: ['desktop'],
      runner: (cmd, args) => cmd === 'dsh'
        ? { status: null, stdout: '', stderr: 'spawnSync dsh ENOENT' }
        : defaultDetailedRunner(cmd, args),
      platform: 'darwin',
      osHome: f.osHome,
      env: { PATH: '' },
      requireAutonomyReadinessProfiles: ['desktop'],
    })
    expect(strictHealth.ok).toBe(false)
    expect(strictHealth.error).toContain('autonomy readiness 未就绪')
  })

  test('prefers macOS desktop bundled DeepSeek Harness.app pnpm over ~/Library/pnpm/pnpm for profile desktop while non-desktop keeps user pnpm', async () => {
    const f = await createHomeFixture({ profile: 'desktop', enhancedVersion: '0.2.0' })
    await writeFile(join(f.profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')

    // Seed both ~/Library/pnpm/pnpm (v10 system pnpm) and ~/Applications/DeepSeek Harness.app/.../pnpm.cjs
    const libPnpmDir = join(f.osHome, 'Library', 'pnpm')
    await mkdir(libPnpmDir, { recursive: true })
    const libPnpm = join(libPnpmDir, 'pnpm')
    await writeFile(libPnpm, '#!/bin/sh\necho v10\nexit 0\n', { mode: 0o755 })
    await chmod(libPnpm, 0o755)

    const appBinDir = join(
      f.osHome,
      'Applications',
      'DeepSeek Harness.app',
      'Contents',
      'Resources',
      'runtime',
      'primary-runtime',
      'dependencies',
      'pnpm',
      'bin',
    )
    await mkdir(appBinDir, { recursive: true })
    const bundledCjs = join(appBinDir, 'pnpm.cjs')
    await writeFile(bundledCjs, '// bundled v11 pnpm.cjs\n', { mode: 0o644 })

    const { defaultRunner } = await import('../src/run.ts')
    const desktopCalls: Array<{ cmd: string; args: readonly string[] }> = []
    await defaultUpgradeProfilePackages({
      dshHome: f.dshHome,
      profile: 'desktop',
      targetVersion: '0.2.2',
      registryUrl: 'https://registry.npmjs.org',
      npmPlugins: ['@dsh-ray/assistant-web-owner'],
      runner: defaultRunner,
      detailedRunner: (cmd, args) => {
        desktopCalls.push({ cmd, args })
        return { status: 0, stdout: '', stderr: '' }
      },
      platform: 'darwin',
      osHome: f.osHome,
      env: { PATH: '', HOME: f.osHome },
    })

    expect(desktopCalls).toEqual([{
      cmd: process.execPath,
      args: [
        bundledCjs,
        'install',
        '--dir', f.profileDir,
        '--no-frozen-lockfile',
        '--ignore-scripts',
        '--config.confirmModulesPurge=false',
        '--registry', 'https://registry.npmjs.org',
      ],
    }])

    // Non-desktop profile without DSH_DESKTOP_NODE_EXECUTABLE still resolves ~/Library/pnpm/pnpm first
    const webDir = join(f.dshHome, 'profiles', 'web')
    await mkdir(webDir, { recursive: true })
    await writeFile(join(webDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { '@dsh-ray/assistant-web-owner': '0.2.0' } }), { mode: 0o600 })
    await writeFile(join(webDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    const webCalls: Array<{ cmd: string; args: readonly string[] }> = []
    await defaultUpgradeProfilePackages({
      dshHome: f.dshHome,
      profile: 'web',
      targetVersion: '0.2.2',
      registryUrl: 'https://registry.npmjs.org',
      npmPlugins: ['@dsh-ray/assistant-web-owner'],
      runner: defaultRunner,
      detailedRunner: (cmd, args) => {
        webCalls.push({ cmd, args })
        return { status: 0, stdout: '', stderr: '' }
      },
      platform: 'darwin',
      osHome: f.osHome,
      env: { PATH: '', HOME: f.osHome },
    })

    expect(webCalls).toEqual([{
      cmd: libPnpm,
      args: [
        'install',
        '--dir', webDir,
        '--no-frozen-lockfile',
        '--ignore-scripts',
        '--config.confirmModulesPurge=false',
        '--registry', 'https://registry.npmjs.org',
      ],
    }])
  })

  test('rolls back node_modules/.pnpm/@dsh-ray+* virtual store and .modules.yaml so restored symlinks are never dangling', async () => {
    const f = await createHomeFixture({ profile: 'desktop', hostVersion: '0.2.2-rc.5', enhancedVersion: '0.2.0' })
    await rm(f.enhancedDir, { recursive: true, force: true })
    const oldStorePkg = join(f.profileDir, 'node_modules', '.pnpm', '@dsh-ray+assistant-web-owner@0.2.0', 'node_modules', '@dsh-ray', 'assistant-web-owner')
    await mkdir(oldStorePkg, { recursive: true })
    await writeFile(join(oldStorePkg, 'package.json'), JSON.stringify({ name: '@dsh-ray/assistant-web-owner', version: '0.2.0' }), { mode: 0o600 })
    await symlink('../.pnpm/@dsh-ray+assistant-web-owner@0.2.0/node_modules/@dsh-ray/assistant-web-owner', f.enhancedDir)
    const modulesYamlOriginal = 'storeDir: /old/store\n'
    await writeFile(join(f.profileDir, 'node_modules', '.modules.yaml'), modulesYamlOriginal, { mode: 0o600 })

    const failed = await runUpgrade(
      { dshHome: f.dshHome, profile: 'desktop', action: 'apply', confirmDshHomeStopped: true, platform: 'darwin', osHome: f.osHome },
      {
        fetch: makeRegistryFetch('0.2.2', '0.2.2-rc.5'),
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.5', dshPath: '/bin/dsh', issues: [] }),
        upgradeProfilePackages: async () => {
          // Simulate pnpm deleting the old .pnpm store entry and creating a new 0.2.2 store entry
          await rm(join(f.profileDir, 'node_modules', '.pnpm', '@dsh-ray+assistant-web-owner@0.2.0'), { recursive: true, force: true })
          const newStorePkg = join(f.profileDir, 'node_modules', '.pnpm', '@dsh-ray+assistant-web-owner@0.2.2', 'node_modules', '@dsh-ray', 'assistant-web-owner')
          await mkdir(newStorePkg, { recursive: true })
          await writeFile(join(newStorePkg, 'package.json'), JSON.stringify({ name: '@dsh-ray/assistant-web-owner', version: '0.2.2' }))
          await rm(f.enhancedDir, { force: true })
          await symlink('../.pnpm/@dsh-ray+assistant-web-owner@0.2.2/node_modules/@dsh-ray/assistant-web-owner', f.enhancedDir)
          await writeFile(join(f.profileDir, 'node_modules', '.modules.yaml'), 'storeDir: /new/store\n')
        },
        verifyHealth: async () => ({ ok: false, error: 'post-upgrade desktop check failed' }),
      },
    )

    expect(failed.exitCode).toBe(1)
    expect(failed.report.execution?.rolledBack).toBe(true)
    expect(failed.report.execution?.rollbackSucceeded).toBe(true)
    expect(await readFile(join(f.profileDir, 'node_modules', '.modules.yaml'), 'utf8')).toBe(modulesYamlOriginal)
    expect((await lstat(f.enhancedDir)).isSymbolicLink()).toBe(true)
    expect(JSON.parse(await readFile(join(f.enhancedDir, 'package.json'), 'utf8')).version).toBe('0.2.0')
    expect(await readdir(join(f.profileDir, 'node_modules', '.pnpm'))).toEqual(['@dsh-ray+assistant-web-owner@0.2.0'])
  })

  test('migrates source-bound Linux RSI Home (target + coordinator) via --to-npm, supports rollback, preserves rsi-authorities/credentials, and keeps paired upgrades working later', async () => {
    const f = await createHomeFixture({ profile: 'web', hostVersion: '0.2.2-rc.5', enhancedVersion: '0.2.0' })
    const coordProfile = 'rsi-web-coord01'
    const coordDir = join(f.dshHome, 'profiles', coordProfile)
    await mkdir(join(coordDir, 'node_modules', '.pnpm'), { recursive: true })
    await mkdir(join(f.dshHome, 'rsi-local-cohorts', 'web', 'artifacts'), { recursive: true, mode: 0o700 })
    const repoDir = join(f.root, 'repo-src')
    await mkdir(repoDir, { recursive: true, mode: 0o700 })

    // Seed preserved rsi-authorities & credentials
    const authorityCfgDir = join(f.dshHome, 'rsi-authorities', 'web', 'config')
    await mkdir(authorityCfgDir, { recursive: true, mode: 0o700 })
    const authorityManifestRaw = JSON.stringify({ schemaVersion: 1, targetProfile: 'web', coordinatorProfile: coordProfile }, null, 2)
    await writeFile(join(authorityCfgDir, 'manifest.json'), authorityManifestRaw, { mode: 0o600 })
    const credsRaw = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-preserve-me\n'
    await writeFile(join(f.dshHome, '.credentials.yaml'), credsRaw, { mode: 0o600 })

    const markerHash = createHash('sha256').update('web').digest('hex').slice(0, 16)
    const markerPath = join(f.dshHome, `.rsi-coordinator-${markerHash}.json`)
    const initialMarkerRaw = JSON.stringify({
      schemaVersion: 1, targetProfile: 'web', coordinatorProfile: coordProfile, version: '0.2.0', sourceRepository: repoDir,
    })
    await writeFile(markerPath, initialMarkerRaw, { mode: 0o600 })
    const cohortReceiptRaw = JSON.stringify({
      schemaVersion: 1,
      root: join(f.dshHome, 'rsi-local-cohorts', 'web'),
      sourceRepository: repoDir,
    })
    await writeFile(join(f.dshHome, 'rsi-local-cohorts', 'web', 'receipt.json'), cohortReceiptRaw, { mode: 0o600 })

    const targetTgz = join(f.dshHome, 'rsi-local-cohorts', 'web', 'artifacts', 'assistant-web-owner.tgz')
    const coordTgz = join(f.dshHome, 'rsi-local-cohorts', 'web', 'artifacts', 'assistant-policy.tgz')
    await writeFile(join(f.profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { '@dsh-ray/assistant-web-owner': `file:${targetTgz}` },
    }, null, 2), { mode: 0o600 })
    await writeFile(join(coordDir, 'package.json'), JSON.stringify({
      name: `dsh-profile-${coordProfile}`,
      private: true,
      dependencies: { '@dsh-ray/assistant-policy': `file:${coordTgz}` },
    }, null, 2), { mode: 0o600 })
    await writeFile(join(coordDir, 'cordis.patch.yml'), '- id: dsh-ray-assistant-policy\n  name: "@dsh-ray/assistant-policy"\n', { mode: 0o600 })

    const wsTargetRaw = [
      'nodeLinker: isolated',
      'allowBuilds:',
      '  koffi: true',
      'overrides:',
      `  "@dsh-ray/assistant-web-owner@0.2.0>@dsh-ray/assistant-policy": file:${coordTgz}`,
      '',
    ].join('\n')
    await writeFile(join(f.profileDir, 'pnpm-workspace.yaml'), wsTargetRaw, { mode: 0o600 })
    await writeFile(join(coordDir, 'pnpm-workspace.yaml'), `nodeLinker: isolated\noverrides:\n  "@dsh-ray/assistant-policy": file:${coordTgz}\n`, { mode: 0o600 })

    const fakeBinDir = join(f.root, 'fake-pnpm-to-npm')
    await mkdir(fakeBinDir, { recursive: true })
    await writeFile(join(fakeBinDir, 'pnpm'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 })

    // 1. Dry-run upgrade --to-npm plans conversion for both web + coordinator + marker sync
    const dryRes = await runUpgrade(
      { dshHome: f.dshHome, profile: 'web', action: 'dry-run', toNpm: true, targetVersion: '0.2.2', osHome: f.osHome, platform: 'linux' },
      {
        fetch: makeRegistryFetch('0.2.2', '0.2.2-rc.5'),
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.5', dshPath: '/bin/dsh', issues: [] }),
        detectFrozenOwner: async () => ({ home: f.dshHome, profile: 'web', repository: repoDir }),
      },
    )
    expect(dryRes.exitCode).toBe(0)
    expect(dryRes.report.mode).toBe('standard-local')
    expect(dryRes.report.plan.steps.some(s => s.includes('web') && s.includes('npm'))).toBe(true)
    expect(dryRes.report.plan.steps.some(s => s.includes(coordProfile) && s.includes('npm'))).toBe(true)
    expect(dryRes.report.plan.backupFiles).toContain(markerPath)

    // 2. Failed health check during --to-npm rolls back marker, cohorts, package.json, and workspace overrides cleanly
    const failedMig = await runUpgrade(
      { dshHome: f.dshHome, profile: 'web', action: 'apply', toNpm: true, targetVersion: '0.2.2', confirmDshHomeStopped: true, osHome: f.osHome, platform: 'linux', env: { PATH: fakeBinDir } },
      {
        fetch: makeRegistryFetch('0.2.2', '0.2.2-rc.5'),
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.5', dshPath: '/bin/dsh', issues: [] }),
        detectFrozenOwner: async () => ({ home: f.dshHome, profile: 'web', repository: repoDir }),
        detailedRunner: () => ({ status: 0, stdout: '', stderr: '' }),
        verifyHealth: async () => ({ ok: false, error: 'post-migration health fail' }),
      },
    )
    expect(failedMig.exitCode).toBe(1)
    expect(failedMig.report.execution?.rolledBack).toBe(true)
    expect(failedMig.report.execution?.rollbackSucceeded).toBe(true)
    expect(await readFile(markerPath, 'utf8')).toBe(initialMarkerRaw)
    expect(await readFile(join(f.dshHome, 'rsi-local-cohorts', 'web', 'receipt.json'), 'utf8')).toBe(cohortReceiptRaw)
    expect(JSON.parse(await readFile(join(f.profileDir, 'package.json'), 'utf8')).dependencies['@dsh-ray/assistant-web-owner']).toBe(`file:${targetTgz}`)

    const { detectFrozenOwner: realDetectFrozen } = await import('../src/program-update.ts')
    expect(await realDetectFrozen(f.dshHome)).toEqual({ home: f.dshHome, profile: 'web', repository: repoDir })

    // 3. Apply via main(['update', '--all', '--yes', '--to-npm']) converts BOTH profiles, updates marker, removes cohorts, preserves rsi-authorities & credentials
    const frozenUpdateSpy = vi.fn(async () => 0)
    const stdoutChunks: string[] = []
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdoutChunks.push(String(chunk)); return true })
    try {
      const code = await main(
        ['update', '--all', '--yes', '--to-npm', '--profile', 'web', '--dsh-home', f.dshHome],
        { DSH_HOME: f.dshHome, PATH: fakeBinDir },
        {
          platform: 'linux',
          osHome: f.osHome,
          selfUpdate: async () => ({
            fromVersion: '0.2.1', selector: 'latest', installedVersion: '0.2.2', resolvedVersion: '0.2.2', alreadyCurrent: true, actions: [],
          }),
          detectFrozenOwner: async () => ({ home: f.dshHome, profile: 'web', repository: repoDir }),
          frozenUpdate: frozenUpdateSpy,
          upgradeDeps: {
            fetch: makeRegistryFetch('0.2.2', '0.2.2-rc.5'),
            inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.5', dshPath: '/bin/dsh', issues: [] }),
            detectFrozenOwner: async () => ({ home: f.dshHome, profile: 'web', repository: repoDir }),
            inspectService: async () => ({ managed: false, definitionPath: '', foreign: false }),
            scanProcesses: async () => ({ processes: [] }),
            verifyHealth: async () => ({ ok: true }),
            detailedRunner: () => ({ status: 0, stdout: '', stderr: '' }),
          },
        },
      )
      expect(code).toBe(0)
    } finally {
      writeSpy.mockRestore()
    }
    expect(frozenUpdateSpy).not.toHaveBeenCalled()

    const updatedTargetPkg = JSON.parse(await readFile(join(f.profileDir, 'package.json'), 'utf8'))
    const updatedCoordPkg = JSON.parse(await readFile(join(coordDir, 'package.json'), 'utf8'))
    expect(updatedTargetPkg.dependencies['@dsh-ray/assistant-web-owner']).toBe('0.2.2')
    expect(updatedCoordPkg.dependencies['@dsh-ray/assistant-policy']).toBe('0.2.2')

    const updatedTargetWs = parseDocument(await readFile(join(f.profileDir, 'pnpm-workspace.yaml'), 'utf8')).toJS() as Record<string, unknown>
    expect(updatedTargetWs.overrides).toBeUndefined()
    expect(updatedTargetWs.allowBuilds).toEqual({ koffi: true })
    expect(Array.isArray(updatedTargetWs.minimumReleaseAgeExclude)).toBe(true)

    const updatedCoordWs = parseDocument(await readFile(join(coordDir, 'pnpm-workspace.yaml'), 'utf8')).toJS() as Record<string, unknown>
    expect((updatedCoordWs.overrides as Record<string, string>)['@dsh-ray/assistant-policy']).toBe('0.2.2')

    // .rsi-coordinator-<hash>.json updated cleanly; rsi-local-cohorts cleaned; rsi-authorities & credentials preserved untouched
    const updatedMarker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>
    expect(updatedMarker).toEqual({
      schemaVersion: 1,
      targetProfile: 'web',
      coordinatorProfile: coordProfile,
      version: '0.2.2',
      sourceRepository: null,
    })
    await expect(lstat(join(f.dshHome, 'rsi-local-cohorts'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(authorityCfgDir, 'manifest.json'), 'utf8')).toBe(authorityManifestRaw)
    expect(await readFile(join(f.dshHome, '.credentials.yaml'), 'utf8')).toBe(credsRaw)

    // Real detectFrozenOwner now sees migrated pure-npm profiles and returns undefined
    expect(await realDetectFrozen(f.dshHome)).toBeUndefined()

    // 4. Subsequent `dsh-ray upgrade --profile web` WITHOUT `--to-npm` STILL pairs target + coordinator and bumps coordinator marker version
    await mkdir(join(coordDir, 'node_modules', '@dsh-ray', 'assistant-policy'), { recursive: true })
    await writeFile(join(coordDir, 'node_modules', '@dsh-ray', 'assistant-policy', 'package.json'), JSON.stringify({ name: '@dsh-ray/assistant-policy', version: '0.2.2' }), { mode: 0o600 })
    await writeFile(join(f.profileDir, 'node_modules', '@dsh-ray', 'assistant-web-owner', 'package.json'), JSON.stringify({ name: '@dsh-ray/assistant-web-owner', version: '0.2.2' }), { mode: 0o600 })
    const postMigRes = await runUpgrade(
      { dshHome: f.dshHome, profile: 'web', action: 'apply', targetVersion: '0.2.3', confirmDshHomeStopped: true, osHome: f.osHome, platform: 'linux', env: { PATH: fakeBinDir } },
      {
        fetch: makeRegistryFetch('0.2.3', '0.2.2-rc.5'),
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: f.hostPath, version: '0.2.2-rc.5', dshPath: '/bin/dsh', issues: [] }),
        verifyHealth: async () => ({ ok: true }),
        detailedRunner: () => ({ status: 0, stdout: '', stderr: '' }),
      },
    )
    expect(postMigRes.exitCode).toBe(0)
    expect(JSON.parse(await readFile(join(f.profileDir, 'package.json'), 'utf8')).dependencies['@dsh-ray/assistant-web-owner']).toBe('0.2.3')
    expect(JSON.parse(await readFile(join(coordDir, 'package.json'), 'utf8')).dependencies['@dsh-ray/assistant-policy']).toBe('0.2.3')
    expect(JSON.parse(await readFile(markerPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      targetProfile: 'web',
      coordinatorProfile: coordProfile,
      version: '0.2.3',
      sourceRepository: null,
    })
  })
})
