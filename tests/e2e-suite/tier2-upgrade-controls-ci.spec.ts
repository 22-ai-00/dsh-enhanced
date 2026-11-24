import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { createServer } from 'node:http'
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { getExport, getExportFn, sha256Hex } from './helpers/assertions.ts'
import { runBashCommand, runDshRsiInProcess, runNodeScript, runPluginSetupInProcess } from './helpers/cli-runner.ts'
import { createCordisHarness } from './helpers/cordis-harness.ts'
import {
  loadAssistantDelivery,
  loadAssistantPolicy,
  loadAssistantWebOwnerSetup,
  loadDshRsiCli,
  loadDshRsiUpgrade,
  loadOwnerConsole,
  loadPackageModule,
  loadUpgradeProgram,
  readAllWorkspaceManifests,
} from './helpers/packages.ts'
import { createIsolatedEnv, createWorkspaceTracker, repoRoot } from './helpers/workspace.ts'
import { parseWorkflowYaml } from './helpers/yaml-presets.ts'

const workspaces = createWorkspaceTracker()
const harness = createCordisHarness()

afterEach(async () => {
  await harness.disposeAll()
  await workspaces.cleanupAll()
})

async function seedUpgradeProfileFixture(
  dshHome: string,
  profileName: string,
  opts: { hostVersion?: string; seedHistory?: boolean; corruptHost?: boolean; corruptLedger?: boolean; enhancedVersion?: string } = {},
) {
  const profileDir = join(dshHome, 'profiles', profileName)
  const enhancedVersion = opts.enhancedVersion ?? '0.1.83'
  const enhancedDir = join(profileDir, 'node_modules', '@dsh-enhanced', 'assistant-delivery')
  const cacheRoot = join(dshHome, 'host-cache')
  await mkdir(profileDir, { recursive: true, mode: 0o700 })
  await mkdir(enhancedDir, { recursive: true, mode: 0o700 })
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })

  const hostVersion = opts.hostVersion ?? '0.1.9'
  const hostBindingPath = join(dshHome, '.dsh-rsi-host.json')
  if (opts.corruptHost) {
    await writeFile(hostBindingPath, '{broken json', { mode: 0o600 })
  } else {
    await writeFile(
      hostBindingPath,
      JSON.stringify({
        schemaVersion: 1,
        version: hostVersion,
        cacheRoot,
        receiptDigest: sha256Hex(`host-receipt:${hostVersion}`),
      }),
      { mode: 0o600 },
    )
  }
  await writeFile(
    join(profileDir, 'package.json'),
    JSON.stringify({
      name: `dsh-profile-${profileName}`,
      private: true,
      dependencies: { '@dsh-enhanced/assistant-delivery': enhancedVersion },
    }),
    { mode: 0o600 },
  )
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', { mode: 0o600 })
  await writeFile(
    join(enhancedDir, 'package.json'),
    JSON.stringify({ name: '@dsh-enhanced/assistant-delivery', version: enhancedVersion }),
    { mode: 0o600 },
  )
  await writeFile(
    join(profileDir, 'cordis.patch.yml'),
    '- id: dsh-enhanced-assistant-delivery\n  name: "@dsh-enhanced/assistant-delivery"\n  config:\n    ownerRoutes:\n      - id: owner-route-1\n',
    { mode: 0o600 },
  )
  await writeFile(join(profileDir, '.credentials.yaml'), 'openai: dummy-ref\n', { mode: 0o600 })

  if (opts.corruptLedger) {
    const cpDir = join(dshHome, 'plugin-control-plane')
    await mkdir(cpDir, { recursive: true, mode: 0o700 })
    await writeFile(join(cpDir, `${profileName}.sqlite`), 'not-a-sqlite-header-at-all', { mode: 0o600 })
  } else if (opts.seedHistory) {
    const cpDir = join(dshHome, 'plugin-control-plane')
    await mkdir(cpDir, { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(join(cpDir, `${profileName}.sqlite`))
    db.exec(`
      CREATE TABLE IF NOT EXISTS source_plans (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS source_creation_verifications (plan_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS source_revision_sources (plan_id TEXT PRIMARY KEY);
      INSERT INTO source_plans (id) VALUES ('plan-c1');
      INSERT INTO source_creation_verifications (plan_id) VALUES ('plan-c1');
      INSERT INTO source_revision_sources (plan_id) VALUES ('plan-r1');
    `)
    db.close()
  }
  return { profileDir, hostBindingPath, hostVersion }
}

function mockUpgradeFetch(targetEnhanced = '0.1.84', targetDsh = '0.2.2-rc.5') {
  return async (url: string | URL) => {
    const str = String(url)
    const latest = str.includes('@dsh-enhanced') || str.includes('dsh-rsi-cli') ? targetEnhanced : targetDsh
    return new Response(JSON.stringify({ 'dist-tags': { latest } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

describe('Tier 2 — F19–F23: Upgrade Migration, Setup, Controls, Release Gate & CI Boundaries', () => {
  describe('F19: WP17 corrupt state, running process, lock & history migration boundaries', () => {
    test('T2-F19-01: runUpgrade rejects corrupt .dsh-rsi-host.json, symlinked host binding, missing profile & corrupt SQLite ledger', async () => {
      const ws = await workspaces.create('f19-corrupt-')
      const upg = await loadDshRsiUpgrade()

      // 1) Corrupt .dsh-rsi-host.json
      const f1 = await seedUpgradeProfileFixture(ws.dshHome, 'web', { corruptHost: true })
      const badHost = await upg.runUpgrade({
        dshHome: ws.dshHome,
        osHome: ws.root,
        platform: 'linux',
        profile: 'web',
        action: 'apply',
      } as never, {
        fetch: mockUpgradeFetch() as never,
        scanProcesses: async () => ({ processes: [] }),
      } as never)
      expect(badHost.exitCode).toBe(1)
      expect(badHost.report.readiness.bindingOk).toBe(false)

      // 2) Missing --profile
      await writeFile(f1.hostBindingPath, JSON.stringify({ schemaVersion: 1, version: '0.2.2-rc.5' }), { mode: 0o600 })
      const missingProf = await upg.runUpgrade({
        dshHome: ws.dshHome,
        osHome: ws.root,
        platform: 'linux',
        profile: 'nonexistent-profile',
        action: 'apply',
      } as never, {
        fetch: mockUpgradeFetch() as never,
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: f1.hostBindingPath, version: '0.2.2-rc.5', dshPath: '/usr/local/bin/dsh', issues: [] }) as never,
        scanProcesses: async () => ({ processes: [] }),
      } as never)
      expect(missingProf.exitCode).toBe(1)
      expect(missingProf.report.ok).toBe(false)

      // 3) Corrupt SQLite ledger
      await seedUpgradeProfileFixture(ws.dshHome, 'corrupt-db', { corruptLedger: true })
      const corruptDbRes = await upg.runUpgrade({
        dshHome: ws.dshHome,
        osHome: ws.root,
        platform: 'linux',
        profile: 'corrupt-db',
        action: 'apply',
      } as never, {
        fetch: mockUpgradeFetch() as never,
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: f1.hostBindingPath, version: '0.2.2-rc.5', dshPath: '/usr/local/bin/dsh', issues: [] }) as never,
        scanProcesses: async () => ({ processes: [] }),
      } as never)
      expect(corruptDbRes.exitCode).toBe(1)
      expect(corruptDbRes.report.readiness.ledgersOk).toBe(false)

      // 4) Symlinked .dsh-rsi-host.json
      const symlinkTarget = join(ws.root, 'real-host.json')
      await writeFile(symlinkTarget, '{}', 'utf8')
      await rm(f1.hostBindingPath)
      await symlink(symlinkTarget, f1.hostBindingPath)
      const symRes = await upg.runUpgrade({
        dshHome: ws.dshHome,
        osHome: ws.root,
        platform: 'linux',
        profile: 'web',
        action: 'check',
      } as never, {
        fetch: mockUpgradeFetch() as never,
        scanProcesses: async () => ({ processes: [] }),
      } as never)
      expect(symRes.exitCode).toBe(1)
      expect(symRes.report.readiness.bindingOk).toBe(false)
    })

    test('T2-F19-02: runUpgrade blocks active DSH processes without confirmDshHomeStopped, invalid dshVersion & unsafe registry URL', async () => {
      const ws = await workspaces.create('f19-proc-block-')
      const { hostBindingPath } = await seedUpgradeProfileFixture(ws.dshHome, 'web', { hostVersion: '0.2.1-rc.2' })
      const upg = await loadDshRsiUpgrade()

      expect(() => upg.validateRegistryUrl('http://user:pass@evil.example.com')).toThrow()
      expect(() => upg.validateRegistryUrl('http://remote-insecure.example.com')).toThrow()

      const activeProcRes = await upg.runUpgrade({
        dshHome: ws.dshHome,
        osHome: ws.root,
        platform: 'linux',
        profile: 'web',
        action: 'apply',
      } as never, {
        fetch: mockUpgradeFetch() as never,
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: hostBindingPath, version: '0.2.1-rc.2', dshPath: '/usr/local/bin/dsh', issues: [] }) as never,
        scanProcesses: async () => ({ processes: [{ pid: 99999, command: 'dsh' }] }),
      } as never)
      expect(activeProcRes.exitCode).toBe(1)
      expect(activeProcRes.report.execution?.executed).toBeFalsy()

      const badDshVer = await upg.runUpgrade({
        dshHome: ws.dshHome,
        osHome: ws.root,
        platform: 'linux',
        profile: 'web',
        action: 'apply',
        dshVersion: '0.1.0-unsupported',
      } as never, {
        fetch: mockUpgradeFetch() as never,
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: hostBindingPath, version: '0.2.1-rc.2', dshPath: '/usr/local/bin/dsh', issues: [] }) as never,
        scanProcesses: async () => ({ processes: [] }),
      } as never)
      expect(badDshVer.exitCode).toBe(1)
    })

    test('T2-F19-03: runUpgrade re-run on already current 0.2.2-rc.5 + 0.1.84 is idempotent without mutating disk', async () => {
      const ws = await workspaces.create('f19-idem-')
      const { hostBindingPath } = await seedUpgradeProfileFixture(ws.dshHome, 'web', {
        hostVersion: '0.2.2-rc.5',
        enhancedVersion: '0.1.84',
      })
      const upg = await loadDshRsiUpgrade()

      let pkgUpgrades = 0
      const res = await upg.runUpgrade({
        dshHome: ws.dshHome,
        osHome: ws.root,
        platform: 'linux',
        profile: 'web',
        action: 'apply',
        dshVersion: '0.2.2-rc.5',
        targetVersion: '0.1.84',
      } as never, {
        fetch: mockUpgradeFetch('0.1.84', '0.2.2-rc.5') as never,
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: hostBindingPath, version: '0.2.2-rc.5', dshPath: '/usr/local/bin/dsh', issues: [] }) as never,
        scanProcesses: async () => ({ processes: [] }),
        upgradeHost: async () => {},
        upgradeProfilePackages: async () => { pkgUpgrades += 1 },
        verifyHealth: async () => ({ ok: true }),
      } as never)
      expect(res.exitCode).toBe(0)
      expect(res.report.ok).toBe(true)
      expect(res.report.execution?.executed).toBe(false)
      expect(pkgUpgrades).toBe(0)
    })

    test('T2-F19-04: withDshHomeLifecycleLock rejects concurrent lock acquisition and parseProgramUpgradeArgs rejects invalid flags', async () => {
      const ws = await workspaces.create('f19-lock-')
      const lockMod = (await loadPackageModule('dsh-rsi-cli/home-lifecycle-lock')) as {
        withDshHomeLifecycleLock: <T>(dshHome: string, op: () => Promise<T>) => Promise<T>
        dshHomeLifecycleRendezvousPath: (dshHome: string) => string
      }
      const mod = await loadUpgradeProgram()
      const parseArgs = getExportFn<(argv: readonly string[]) => unknown>(mod as Record<string, unknown>, 'parseProgramUpgradeArgs')

      expect(() => parseArgs(['--dsh-home', 'relative/home', '--profile', 'web'])).toThrow(/Program upgrade/)
      expect(() => parseArgs(['--dsh-home', ws.dshHome, '--profile', 'web', '--dsh-version', '0.1.9'])).toThrow(/Program upgrade/)
      expect(() => parseArgs(['--dsh-home', ws.dshHome, '--profile', 'web', '--unknown-opt'])).toThrow(/Program upgrade/)
      expect(() => parseArgs(['--dsh-home', ws.dshHome, '--profile', 'web', '--dry-run', '--dry-run'])).toThrow(/Program upgrade/)
      expect(() => parseArgs(['--dsh-home', ws.dshHome, '--profile', 'web', '--recover-readiness', '--dsh-version', '0.2.2-rc.5'])).toThrow(/Program upgrade/)

      const lockFile = lockMod.dshHomeLifecycleRendezvousPath(ws.dshHome)
      try {
        await lockMod.withDshHomeLifecycleLock(ws.dshHome, async () => {
          await expect(lockMod.withDshHomeLifecycleLock(ws.dshHome, async () => 'nested')).rejects.toThrow(/DSH_HOME 正忙/)
        })
      } finally {
        await rm(lockFile, { force: true })
      }
    })

    test('T2-F19-05: upgrade failure or unhealthy verifyHealth rolls back profile patch and credentials byte-for-byte', async () => {
      const ws = await workspaces.create('f19-rb-bytes-')
      const { profileDir, hostBindingPath } = await seedUpgradeProfileFixture(ws.dshHome, 'web', { hostVersion: '0.2.1-rc.2' })
      const patchBefore = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
      const credBefore = await readFile(join(profileDir, '.credentials.yaml'), 'utf8')
      const upg = await loadDshRsiUpgrade()

      const res = await upg.runUpgrade({
        dshHome: ws.dshHome,
        osHome: ws.root,
        platform: 'linux',
        profile: 'web',
        action: 'apply',
      } as never, {
        fetch: mockUpgradeFetch() as never,
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: hostBindingPath, version: '0.2.1-rc.2', dshPath: '/usr/local/bin/dsh', issues: [] }) as never,
        scanProcesses: async () => ({ processes: [] }),
        upgradeHost: async () => {},
        upgradeProfilePackages: async () => {
          await writeFile(join(profileDir, 'cordis.patch.yml'), '# corrupted mid-upgrade\n', 'utf8')
        },
        verifyHealth: async () => ({ ok: false, error: 'post-upgrade healthcheck failed' }),
      } as never)

      expect(res.exitCode).toBe(1)
      expect(res.report.execution?.rolledBack).toBe(true)
      expect(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(patchBefore)
      expect(await readFile(join(profileDir, '.credentials.yaml'), 'utf8')).toBe(credBefore)
    })

    test('T2-F19-06: WP17 non-empty history migration fails closed without opt-in and fails closed on corrupt ledger even with opt-in', async () => {
      const ws = await workspaces.create('f19-hist-edge-')
      const { hostBindingPath } = await seedUpgradeProfileFixture(ws.dshHome, 'web', { hostVersion: '0.1.9', seedHistory: true })
      const upg = await loadDshRsiUpgrade()

      const blockedNoFlag = await upg.runUpgrade({
        dshHome: ws.dshHome,
        osHome: ws.root,
        platform: 'linux',
        profile: 'web',
        action: 'apply',
        allowNonEmptyHistoryMigration: false,
      } as never, {
        fetch: mockUpgradeFetch() as never,
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: hostBindingPath, version: '0.1.9', dshPath: '/usr/local/bin/dsh', issues: [] }) as never,
        scanProcesses: async () => ({ processes: [] }),
      } as never)
      expect(blockedNoFlag.exitCode).toBe(1)

      await seedUpgradeProfileFixture(ws.dshHome, 'bad-hist', { hostVersion: '0.1.9', corruptLedger: true })
      const corruptWithFlag = await upg.runUpgrade({
        dshHome: ws.dshHome,
        osHome: ws.root,
        platform: 'linux',
        profile: 'bad-hist',
        action: 'apply',
        allowNonEmptyHistoryMigration: true,
      } as never, {
        fetch: mockUpgradeFetch() as never,
        inspectBoundHost: async () => ({ status: 'ready', bindingPath: hostBindingPath, version: '0.1.9', dshPath: '/usr/local/bin/dsh', issues: [] }) as never,
        scanProcesses: async () => ({ processes: [] }),
      } as never)
      expect(corruptWithFlag.exitCode).toBe(1)
      expect(corruptWithFlag.report.readiness.ledgersOk).toBe(false)
    })
  })

  describe('F20: WP17/R3 installer flags, plugin-setup & web-owner lock/boundary rejections', () => {
    test('T2-F20-01: install-local.sh rejects invalid --scenario, incompatible --operation/--workspace/--isolation/--lark combinations with exit 2', async () => {
      const ws = await workspaces.create('f20-install-err-')
      const env = await createIsolatedEnv(ws)
      const script = join(repoRoot, 'scripts/install/install-local.sh')

      const badCombos: string[][] = [
        ['--dry-run', '--scenario', 'nonexistent'],
        ['--dry-run', '--operation', 'upgrade', '--scenario', 'core'],
        ['--dry-run', '--scenario', 'web', '--lark', 'configure'],
        ['--dry-run', '--scenario', 'core', '--workspace', ws.workspace],
        ['--dry-run', '--scenario', 'web', '--isolation-backend', 'linux-native'],
      ]
      for (const args of badCombos) {
        const res = await runBashCommand([script, ...args], { env })
        expect(res.exitCode, `Expected exit 2 for ${args.join(' ')}`).toBe(2)
      }
    })

    test('T2-F20-02: runPluginSetupInProcess rejects relative --dsh-home, invalid --profile, unknown subcommand & wrong arity', async () => {
      const ws = await workspaces.create('f20-setup-cli-')
      const cases: string[][] = [
        ['unknown-subcmd', '--dsh-home', ws.dshHome],
        ['enable', '--dsh-home', ws.dshHome],
        ['enable', 'assistant-work-items', '--dsh-home', 'relative/home'],
        ['enable', 'assistant-work-items', '--dsh-home', ws.dshHome, '--profile', '../escape'],
        ['enable', 'assistant-work-items', '--dsh-home', ws.dshHome, '--bogus-flag'],
      ]
      for (const args of cases) {
        const res = await runPluginSetupInProcess(args, { readDump: async () => [] })
        expect(res.exitCode, `Expected exitCode 1 for ${args.join(' ')}`).toBe(1)
      }
    })

    test('T2-F20-03: prepareWebOwnerProfile rejects relative workspace/dshHome, missing required rows & principal mismatch', async () => {
      const ws = await workspaces.create('f20-prep-err-')
      const setupMod = await loadAssistantWebOwnerSetup()
      const prepare = getExportFn<(
        input: Record<string, unknown>,
        source: string,
        effectiveSource: string,
      ) => unknown>(setupMod, 'prepareWebOwnerProfile')

      expect(() => prepare({
        dshHome: 'relative/home',
        profile: 'web',
        workspace: ws.workspace,
        preset: 'primary',
      }, '[]\n', '[]\n')).toThrow(/assistant-web-owner setup/)

      expect(() => prepare({
        dshHome: ws.dshHome,
        profile: 'web',
        workspace: 'relative/ws',
        preset: 'primary',
      }, '[]\n', '[]\n')).toThrow(/assistant-web-owner setup/)

      // Missing personal-assistant / assistant-delivery / assistant-goals rows in effectiveSource
      expect(() => prepare({
        dshHome: ws.dshHome,
        profile: 'web',
        workspace: ws.workspace,
        preset: 'primary',
      }, '[]\n', '- id: only-other\n  name: "@dsh-enhanced/other"\n')).toThrow(/assistant-web-owner setup/)
    }, 15_000)

    test('T2-F20-04: configureWebOwner fails closed when .assistant-web-owner-setup.lock is held', async () => {
      const ws = await workspaces.create('f20-lock-')
      const setupMod = await loadAssistantWebOwnerSetup()
      const configure = getExportFn<(input: Record<string, unknown>) => Promise<unknown>>(setupMod, 'configureWebOwner')

      const profileDir = join(ws.dshHome, 'profiles', 'web')
      await mkdir(profileDir, { recursive: true, mode: 0o700 })
      await mkdir(join(profileDir, '.assistant-web-owner-setup.lock'), { recursive: true, mode: 0o700 })

      await expect(configure({
        dshHome: ws.dshHome,
        profile: 'web',
        workspace: ws.workspace,
        preset: 'primary',
      })).rejects.toThrow(/holds the profile lock/i)
    })

    test('T2-F20-05: install-local.sh --dry-run resolves assistant-association in web/lark/supervised without dogfood while keeping core minimal', async () => {
      const ws = await workspaces.create('f20-queue-boundary-')
      const env = await createIsolatedEnv(ws)
      const script = join(repoRoot, 'scripts/install/install-local.sh')
      const extractDryRunPluginSlugs = (output: string): Set<string> => {
        const slugs = new Set<string>()
        for (const match of output.matchAll(/^\s*-\s+\S+\/plugins\/([a-z0-9-]+)\s*$/gmu)) {
          slugs.add(match[1]!)
        }
        return slugs
      }

      const coreRes = await runBashCommand([script, '--dry-run', '--scenario', 'core', '--yes'], { env })
      expect(coreRes.exitCode).toBe(0)
      const coreSlugs = extractDryRunPluginSlugs(coreRes.stdout + coreRes.stderr)
      expect(coreSlugs.has('personal-assistant')).toBe(true)
      expect(coreSlugs.has('plugin-control-plane')).toBe(true)
      for (const excluded of [
        'assistant-association',
        'assistant-growth-driver',
        'assistant-work-items',
        'assistant-proactive',
        'assistant-evaluation',
        'assistant-evolution',
        'assistant-memory-learning',
        'lark-channel',
      ]) {
        expect(coreSlugs.has(excluded), `Expected core scenario to exclude ${excluded}`).toBe(false)
      }

      for (const scenario of ['web', 'lark', 'supervised'] as const) {
        const res = await runBashCommand([script, '--dry-run', '--scenario', scenario, '--yes'], { env })
        expect(res.exitCode, `Expected exit 0 for --scenario ${scenario}`).toBe(0)
        const slugs = extractDryRunPluginSlugs(res.stdout + res.stderr)
        expect(
          slugs.has('assistant-association'),
          `Expected --scenario ${scenario} without --plugin-preset dogfood to resolve assistant-association`,
        ).toBe(true)
      }
    })
  })

  describe('F21: R4 CLI invalid flags, degraded doctor & unauthorized NL control boundaries', () => {
    test('T2-F21-01: dsh-rsi CLI returns exit code 2 on unknown commands, unknown flags, --check --yes conflict & unsafe --registry', async () => {
      const ws = await workspaces.create('f21-bad-cli-')
      const invalidInvocations: string[][] = [
        ['not-a-valid-command'],
        ['status', '--unknown-flag-xyz'],
        ['upgrade', '--check', '--yes', '--dsh-home', ws.dshHome],
        ['upgrade', '--registry', 'http://user:pass@evil.test', '--dsh-home', ws.dshHome],
        ['logs', '--lines', '0', '--dsh-home', ws.dshHome],
      ]
      for (const args of invalidInvocations) {
        const res = await runDshRsiInProcess(args, { DSH_HOME: ws.dshHome })
        expect(res.exitCode, `Expected exitCode 2 for ${args.join(' ')}`).toBe(2)
        expect(res.stderr.length).toBeGreaterThan(0)
      }
    })

    test('T2-F21-02: collectLiveDoctorReport reports ok=false & fail checks on missing host/profile and corrupt host binding', async () => {
      const ws = await workspaces.create('f21-doctor-bad-')
      const cli = await loadDshRsiCli()
      const collectDoctor = getExportFn<(opts: Record<string, unknown>) => Promise<{
        ok: boolean
        boundHost: { status: string }
        summary: { ok: number; warn: number; fail: number; skip: number }
        checks: readonly { id: string; status: string }[]
      }>>(
        cli,
        'collectLiveDoctorReport',
      )

      const emptyReport = await collectDoctor({
        dshHome: ws.dshHome,
        home: ws.root,
        platform: 'linux',
        env: { PATH: '', HOME: ws.root },
        findExecutable: () => undefined,
        fileExists: () => false,
        runner: () => ({ status: 1, stdout: '', stderr: 'unavailable' }),
      })
      expect(emptyReport.ok).toBe(false)
      expect(emptyReport.boundHost.status).toBe('missing')
      expect(emptyReport.summary.fail).toBeGreaterThanOrEqual(1)
      expect(emptyReport.checks.find(c => c.id === 'host.bound')?.status).toBe('fail')
      expect(emptyReport.checks.some(c => c.status === 'warn' || c.status === 'fail')).toBe(true)

      const missingProfileReport = await collectDoctor({ dshHome: ws.dshHome, profile: 'nonexistent', home: ws.root, platform: 'linux' })
      expect(missingProfileReport.ok).toBe(false)
      expect(missingProfileReport.checks.some(c => c.status === 'fail')).toBe(true)

      await writeFile(join(ws.dshHome, '.dsh-rsi-host.json'), '{broken json', { mode: 0o600 })
      const corruptReport = await collectDoctor({ dshHome: ws.dshHome, home: ws.root, platform: 'linux' })
      expect(corruptReport.ok).toBe(false)
      expect(corruptReport.boundHost.status).toBe('invalid')
    }, 15_000)

    test('T2-F21-03: R4 dsh-rsi enable|disable|upgrade fails closed on nonexistent profile or relative --dsh-home', async () => {
      const ws = await workspaces.create('f21-r4-cli-err-')
      const cli = await loadDshRsiCli()
      const parseArgs = getExportFn<(argv: readonly string[]) => Record<string, unknown>>(cli, 'parseArgs')
      expect(parseArgs(['upgrade', '--profile', 'web']).command).toBe('upgrade')
      expect(parseArgs(['enable', '--profile', 'web']).command).toBe('enable')
      expect(parseArgs(['disable', '--profile', 'web']).command).toBe('disable')

      const offlineUpgradeDeps = { upgradeDeps: { fetch: async () => new Response('{}', { status: 404 }) } }
      const upgMissingProf = await runDshRsiInProcess(
        ['upgrade', '--profile', 'does-not-exist', '--dsh-home', ws.dshHome, '--json'],
        { DSH_HOME: ws.dshHome },
        offlineUpgradeDeps,
      )
      expect(upgMissingProf.exitCode).toBe(1)
      const upgMissingJson = JSON.parse(upgMissingProf.stdout) as { ok: boolean; ready: boolean; readiness: { blockedReasons: string[] } }
      expect(upgMissingJson.ok).toBe(false)
      expect(upgMissingJson.ready).toBe(false)
      expect(upgMissingJson.readiness.blockedReasons.join('\n')).toContain('does-not-exist')

      const upgRelativeHome = await runDshRsiInProcess(
        ['upgrade', '--profile', 'web', '--dsh-home', 'relative/dsh-home', '--check', '--json'],
        { DSH_HOME: ws.dshHome },
        offlineUpgradeDeps,
      )
      expect(upgRelativeHome.exitCode).toBe(1)
      expect((JSON.parse(upgRelativeHome.stdout) as { ok: boolean }).ok).toBe(false)

      for (const cmd of ['enable', 'disable'] as const) {
        const missingProf = await runDshRsiInProcess([cmd, '--profile', 'does-not-exist', '--dsh-home', ws.dshHome, '--json'], { DSH_HOME: ws.dshHome })
        expect(missingProf.exitCode, `Expected exitCode 1 for ${cmd} on missing profile`).toBe(1)
        const combinedMissing = missingProf.stdout + missingProf.stderr
        expect(combinedMissing).toMatch(/does-not-exist|不存在|not found|profile/i)
        if (missingProf.stdout.trim().startsWith('{')) {
          expect((JSON.parse(missingProf.stdout) as { ok: boolean }).ok).toBe(false)
        }

        const relHome = await runDshRsiInProcess([cmd, '--profile', 'web', '--dsh-home', 'relative/dsh-home', '--json'], { DSH_HOME: ws.dshHome })
        expect([1, 2]).toContain(relHome.exitCode)
        const combinedRel = relHome.stdout + relHome.stderr
        expect(combinedRel).toMatch(/relative|absolute|dsh-home|web|不存在|not found|profile/i)
        if (relHome.stdout.trim().startsWith('{')) {
          expect((JSON.parse(relHome.stdout) as { ok: boolean }).ok).toBe(false)
        }
      }
    })

    test('T2-F21-04: upgradeAssistantAndRecover fails closed when runUpgrade or doctor readiness fails', async () => {
      const ws = await workspaces.create('f21-recover-fail-')
      const cli = await loadDshRsiCli()
      const upgradeAndRecover = getExportFn<(opts: Record<string, unknown>, deps?: Record<string, unknown>) => Promise<{ ok: boolean; healthy?: boolean }>>(
        cli,
        'upgradeAssistantAndRecover',
      )

      const upgradeFail = await upgradeAndRecover({ dshHome: ws.dshHome, profile: 'web', yes: true }, {
        runUpgrade: async () => ({ ok: false, ready: false, error: 'upgrade rejected' }),
        runDoctor: async () => ({ ok: true, ready: true }),
        restartService: async () => ({ ok: true }),
      })
      expect(upgradeFail.ok).toBe(false)

      const doctorFail = await upgradeAndRecover({ dshHome: ws.dshHome, profile: 'web', yes: true }, {
        runUpgrade: async () => ({ ok: true, ready: true }),
        runDoctor: async () => ({ ok: false, ready: false, error: 'port unhealthy' }),
        restartService: async () => ({ ok: true }),
      })
      expect(doctorFail.ok).toBe(false)
      expect(doctorFail.healthy).toBe(false)
    })

    test('T2-F21-05: owner-console rejects unknown control action even when authorized and parseOwnerSelfIterationCommand returns undefined on normal chat', async () => {
      const ws = await workspaces.create('f21-nl-neg-')
      const ownerMod = await loadOwnerConsole()
      const deliveryMod = await loadAssistantDelivery()
      const handleControl = getExportFn<(ctx: unknown, req: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; reason?: string }>>(
        ownerMod,
        'handleOwnerConsoleControlAction',
      )
      const parseNl = getExportFn<(text: string) => unknown>(deliveryMod, 'parseOwnerSelfIterationCommand')

      expect(parseNl('今天北京天气怎么样？')).toBeUndefined()
      expect(parseNl('')).toBeUndefined()

      const ctx = harness.createContext()
      const badAction = await handleControl(ctx, {
        dshHome: ws.dshHome,
        ownerAuthorized: true,
        action: 'deleteEverything',
      })
      expect(badAction.ok).toBe(false)
      expect(badAction.error ?? badAction.reason).toBeDefined()
    })
  })

  describe('F22: R1 verify-npm-release.mjs CLI bounds & release.yml pinning/privilege boundaries', () => {
    test('T2-F22-01: verify-npm-release.mjs CLI rejects invalid numeric bounds and malformed semver tags with exit code 1', async () => {
      const badArgsList: string[][] = [
        ['--retries', '-1'],
        ['--concurrency', '0'],
        ['--timeout-ms', '0'],
        ['--retry-delay-ms', '-5'],
        ['--tag', 'v1.2'],
      ]
      for (const args of badArgsList) {
        const res = await runNodeScript('scripts/verify-npm-release.mjs', args)
        expect(res.exitCode, `Expected exit 1 for ${args.join(' ')}`).toBe(1)
      }
    })

    test('T2-F22-02: verify-npm-release.mjs CLI enforces --version > --tag > RELEASE_TAG precedence and --no-dist-tag behavior', async () => {
      const manifests = await readAllWorkspaceManifests()
      const seenVersions = new Set<string>()
      const server = createServer((req, res) => {
        const pkgName = decodeURIComponent((req.url ?? '/').slice(1))
        if (!manifests.some(m => m.name === pkgName)) {
          res.writeHead(404)
          res.end()
          return
        }
        seenVersions.add(pkgName)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          name: pkgName,
          'dist-tags': { latest: '0.1.83' }, // lags behind 0.1.84
          versions: {
            '0.1.84': { name: pkgName, version: '0.1.84', dist: { tarball: 'http://127.0.0.1/pkg.tgz' } },
          },
        }))
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port

      try {
        // Without --no-dist-tag, lagging latest=0.1.83 must fail closed when verifying 0.1.84
        const failLag = await runNodeScript('scripts/verify-npm-release.mjs', [
          '--root', repoRoot,
          '--registry', `http://127.0.0.1:${port}`,
          '--version', '0.1.84',
          '--tag', 'v0.1.83',
          '--retries', '0',
        ], { env: { ...process.env, RELEASE_TAG: 'v0.1.82' } })
        expect(failLag.exitCode).toBe(1)
        expect(seenVersions.size).toBe(40)

        // With --no-dist-tag and --version overriding --tag/RELEASE_TAG, succeeds
        const passNoTag = await runNodeScript('scripts/verify-npm-release.mjs', [
          '--root', repoRoot,
          '--registry', `http://127.0.0.1:${port}`,
          '--version', '0.1.84',
          '--tag', 'v0.1.83',
          '--no-dist-tag',
          '--retries', '0',
        ], { env: { ...process.env, RELEASE_TAG: 'v0.1.82' } })
        expect(passNoTag.exitCode).toBe(0)
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })

    test('T2-F22-03: verify-npm-release.mjs fails 39/40 when 1 package returns malformed JSON or null packument', async () => {
      const manifests = await readAllWorkspaceManifests()
      const targetVersion = manifests[0]!.version
      const badPkg = '@dsh-enhanced/acp'
      let mode: 'bad-json' | 'null-body' = 'bad-json'

      const server = createServer((req, res) => {
        const pkgName = decodeURIComponent((req.url ?? '/').slice(1))
        if (!manifests.some(m => m.name === pkgName)) {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        if (pkgName === badPkg) {
          res.end(mode === 'bad-json' ? '{truncated' : 'null')
          return
        }
        res.end(JSON.stringify({
          name: pkgName,
          'dist-tags': { latest: targetVersion },
          versions: {
            [targetVersion]: { name: pkgName, version: targetVersion, dist: { tarball: 'http://127.0.0.1/pkg.tgz' } },
          },
        }))
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port

      try {
        const r1 = await runNodeScript('scripts/verify-npm-release.mjs', [
          '--root', repoRoot, '--registry', `http://127.0.0.1:${port}`, '--version', targetVersion, '--retries', '0', '--json',
        ])
        expect(r1.exitCode).toBe(1)
        expect((JSON.parse(r1.stdout) as { passed: number; failed: Array<{ name: string }> }).passed).toBe(39)

        mode = 'null-body'
        const r2 = await runNodeScript('scripts/verify-npm-release.mjs', [
          '--root', repoRoot, '--registry', `http://127.0.0.1:${port}`, '--version', targetVersion, '--retries', '0', '--json',
        ])
        expect(r2.exitCode).toBe(1)
        const parsed = JSON.parse(r2.stdout) as { passed: number; failed: Array<{ name: string }> }
        expect(parsed.passed).toBe(39)
        expect(parsed.failed[0]?.name).toBe(badPkg)
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })

    test('T2-F22-04: verify-npm-release.mjs fails 39/40 when 1 package has mismatched packument name or missing dist.tarball', async () => {
      const manifests = await readAllWorkspaceManifests()
      const targetVersion = manifests[0]!.version
      const targetBad = '@dsh-enhanced/dsh-rsi-cli'
      let badMode: 'name-mismatch' | 'no-tarball' = 'name-mismatch'

      const server = createServer((req, res) => {
        if (req.url === '/pkg.tgz') {
          res.writeHead(200, { 'content-type': 'application/octet-stream' })
          res.end(Buffer.from('fake-tgz'))
          return
        }
        const tarballUrl = `http://${req.headers.host ?? '127.0.0.1'}/pkg.tgz`
        const pkgName = decodeURIComponent((req.url ?? '/').slice(1))
        if (!manifests.some(m => m.name === pkgName)) {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        if (pkgName === targetBad) {
          res.end(JSON.stringify({
            name: badMode === 'name-mismatch' ? '@dsh-enhanced/wrong-pkg' : pkgName,
            'dist-tags': { latest: targetVersion },
            versions: {
              [targetVersion]: {
                name: pkgName,
                version: targetVersion,
                dist: badMode === 'no-tarball' ? {} : { tarball: tarballUrl },
              },
            },
          }))
          return
        }
        res.end(JSON.stringify({
          name: pkgName,
          'dist-tags': { latest: targetVersion },
          versions: {
            [targetVersion]: { name: pkgName, version: targetVersion, dist: { tarball: tarballUrl } },
          },
        }))
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port

      try {
        const resName = await runNodeScript('scripts/verify-npm-release.mjs', [
          '--root', repoRoot, '--registry', `http://127.0.0.1:${port}`, '--version', targetVersion, '--retries', '0', '--json',
        ])
        expect(resName.exitCode).toBe(1)
        expect((JSON.parse(resName.stdout) as { failed: Array<{ name: string }> }).failed[0]?.name).toBe(targetBad)

        badMode = 'no-tarball'
        const resTar = await runNodeScript('scripts/verify-npm-release.mjs', [
          '--root', repoRoot, '--registry', `http://127.0.0.1:${port}`, '--version', targetVersion, '--verify-tarball', '--retries', '0', '--json',
        ])
        expect(resTar.exitCode).toBe(1)
        expect((JSON.parse(resTar.stdout) as { failed: Array<{ name: string }> }).failed[0]?.name).toBe(targetBad)
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })

    test('T2-F22-05: release.yml verify-npm gate runs unprivileged without NPM_TOKEN/secrets and record has no if:always bypass', async () => {
      const wf = await parseWorkflowYaml<{
        jobs: Record<string, {
          environment?: unknown
          permissions?: Record<string, string>
          if?: string
          needs?: string | string[]
          steps?: Array<{ env?: Record<string, unknown>; run?: string; uses?: string }>
        }>
      }>('.github/workflows/release.yml')

      const verifyNpm = wf.jobs['verify-npm']
      const record = wf.jobs.record
      expect(verifyNpm).toBeDefined()
      expect(verifyNpm?.environment).toBeUndefined()
      expect(verifyNpm?.permissions).toEqual({ contents: 'read' })
      expect(JSON.stringify(verifyNpm?.steps ?? [])).not.toContain('NPM_TOKEN')
      expect(JSON.stringify(verifyNpm?.steps ?? [])).not.toContain('secrets.')

      const recordNeeds = Array.isArray(record?.needs) ? record.needs : [record?.needs]
      expect(recordNeeds).toEqual(expect.arrayContaining(['publish', 'verify-npm']))
      expect(String(record?.if ?? '')).not.toContain('always()')
    })
  })

  describe('F23: R1 ci.yml matrix bounds, Bash 3.2, fail-fast & verify failure propagation boundaries', () => {
    test('T2-F23-01: ci.yml macos-verify probes /bin/bash --version for Bash 3.2 compatibility and avoids overriding TMPDIR', async () => {
      const wf = await parseWorkflowYaml<{
        jobs: Record<string, {
          env?: Record<string, string>
          steps?: Array<{ run?: string }>
        }>
      }>('.github/workflows/ci.yml')

      const macos = wf.jobs['macos-verify']
      expect(macos).toBeDefined()
      expect(macos?.env?.TMPDIR).toBeUndefined()
      const macScript = (macos?.steps ?? []).map(s => s.run ?? '').join('\n')
      expect(macScript).toContain('/bin/bash --version')
      expect(macScript).not.toContain('TMPDIR=/tmp')
    })

    test('T2-F23-02: ci.yml Linux lanes pin node v22.23.2, pnpm 11.7.0 & verify /usr/bin/bwrap --unshare-all availability', async () => {
      const wf = await parseWorkflowYaml<{
        jobs: Record<string, { steps?: Array<{ run?: string }> }>
      }>('.github/workflows/ci.yml')

      for (const jobName of ['linux-packages', 'linux-slow-package-tests', 'linux-root-tests']) {
        const script = (wf.jobs[jobName]?.steps ?? []).map(s => s.run ?? '').join('\n')
        expect(script, `${jobName} missing node v22.23.2 pin`).toContain('v22.23.2')
        expect(script, `${jobName} missing pnpm 11.7.0 pin`).toContain('11.7.0')
        expect(script, `${jobName} missing /usr/bin/bwrap check`).toContain('/usr/bin/bwrap')
        expect(script, `${jobName} missing --unshare-all check`).toContain('--unshare-all')
      }
    })

    test('T2-F23-03: ci.yml linux-slow-package-tests and linux-root-tests set fail-fast: false and bounded matrix/worker caps', async () => {
      const wf = await parseWorkflowYaml<{
        jobs: Record<string, {
          env?: Record<string, string>
          strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, unknown> }
          steps?: Array<{ run?: string }>
        }>
      }>('.github/workflows/ci.yml')

      expect(wf.jobs['linux-slow-package-tests']?.strategy?.['fail-fast']).toBe(false)
      expect(wf.jobs['linux-slow-package-tests']?.env?.VITEST_MAX_WORKERS).toBeDefined()
      expect(wf.jobs['linux-root-tests']?.strategy?.['fail-fast']).toBe(false)
      expect(Array.isArray(wf.jobs['linux-root-tests']?.strategy?.matrix?.shard)).toBe(true)
    })

    test('T2-F23-04: ci.yml verify job uses if: always() and explicitly checks every required lane result = success', async () => {
      const wf = await parseWorkflowYaml<{
        jobs: Record<string, {
          if?: string
          needs?: string[]
          steps?: Array<{ run?: string; env?: Record<string, string> }>
        }>
      }>('.github/workflows/ci.yml')

      const verify = wf.jobs.verify
      expect(verify?.if).toContain('always()')
      const verifyText = (verify?.steps ?? []).map(s => `${JSON.stringify(s.env ?? {})}\n${s.run ?? ''}`).join('\n')
      for (const lane of ['linux-packages', 'linux-slow-package-tests', 'linux-root-tests', 'macos-verify', 'windows-acp-smoke']) {
        expect(verify?.needs).toContain(lane)
        expect(verifyText).toContain(`needs.${lane}.result`)
      }
      expect(verifyText).toContain('= success')
    })

    test('T2-F23-05: ci.yml windows-acp-smoke enforces pwsh $LASTEXITCODE guards on multi-command steps and DSH_NIGHTLY_FULL_MATRIX schedule toggle', async () => {
      const wf = await parseWorkflowYaml<{
        env?: Record<string, string>
        jobs: Record<string, {
          defaults?: { run?: { shell?: string } }
          steps?: Array<{ shell?: string; run?: string }>
        }>
      }>('.github/workflows/ci.yml')

      expect(wf.env?.DSH_NIGHTLY_FULL_MATRIX).toContain('schedule')
      const win = wf.jobs['windows-acp-smoke']
      expect(win).toBeDefined()
      const pwshSteps = (win?.steps ?? []).filter(s => (s.shell ?? win?.defaults?.run?.shell) === 'pwsh' && typeof s.run === 'string')
      expect(pwshSteps.length).toBeGreaterThan(0)
      const guardedSteps = pwshSteps.filter(s => s.run!.includes('$LASTEXITCODE -ne 0'))
      expect(guardedSteps.length).toBeGreaterThanOrEqual(2)
      for (const step of pwshSteps) {
        if (step.run!.includes('\n') && step.run!.includes('pnpm ')) {
          expect(step.run).toContain('$LASTEXITCODE -ne 0')
        }
      }
    })
  })

  describe('F26: Version command & read-only self-iteration stats error, security & delegation boundaries', () => {
    test('T2-F26-01: CLI flag conflicts fail with exitCode 2 / PurgeError while preserving start --json & update/upgrade --version', async () => {
      const cli = await loadDshRsiCli()
      const parseArgs = getExportFn<(argv: readonly string[]) => Record<string, unknown>>(cli, 'parseArgs')

      const badFlagCombos: string[][] = [
        ['--version', '--json'],
        ['--version', '--short'],
        ['status', '--short'],
        ['status', '-V'],
        ['version', '--short', '--json'],
      ]
      for (const args of badFlagCombos) {
        expect(() => parseArgs(args), `Expected parseArgs to throw for ${args.join(' ')}`).toThrow()
        const res = await runDshRsiInProcess(args)
        expect(res.exitCode, `Expected exitCode 2 for ${args.join(' ')}`).toBe(2)
      }

      expect(() => parseArgs(['start', '--json'])).toThrow(/仅适用于 status 与 doctor/)

      const upd = parseArgs(['update', '--version', '0.1.84'])
      expect(upd.command).toBe('update')
      expect(upd.targetVersion).toBe('0.1.84')

      const upg = parseArgs(['upgrade', '--version', '0.1.84'])
      expect(upg.command).toBe('upgrade')
      expect(upg.targetVersion).toBe('0.1.84')
    })

    test('T2-F26-02: Read-only SQLite safety enforces symlink boundary, mode=ro&immutable=1, zero sidecars, corrupt DB isolation & dataState=zero', async () => {
      const ws = await workspaces.create('f26-sqlite-sec-')
      const cli = await loadDshRsiCli()
      const ownerMod = await loadOwnerConsole()
      const collectCli = getExportFn<(opts: Record<string, unknown>) => Promise<{
        selfIteration: { dataState: string; totalIterations: number | null; workItemsTotal: number | null; dreamingRuns: number | null }
        diagnostics?: readonly string[]
      }>>(cli, 'collectVersionReport')
      const collectOwner = getExportFn<(ctx: unknown, opts?: Record<string, unknown>) => Promise<{
        selfIteration: { dataState: string; totalIterations: number | null; workItemsTotal: number | null; dreamingRuns: number | null }
        diagnostics?: readonly string[]
      }>>(ownerMod, 'collectOwnerConsoleVersionInfo')

      // 1. Empty tables -> dataState='zero' & totalIterations=0
      const zeroHome = join(ws.root, 'zero-home')
      await mkdir(join(zeroHome, 'assistant-work-items'), { recursive: true, mode: 0o700 })
      const zeroDb = new DatabaseSync(join(zeroHome, 'assistant-work-items', 'state.sqlite'))
      zeroDb.exec('CREATE TABLE work_item (id TEXT PRIMARY KEY, state TEXT) STRICT;')
      zeroDb.close()
      const zeroCli = await collectCli({ dshHome: zeroHome })
      expect(zeroCli.selfIteration.dataState).toBe('zero')
      expect(zeroCli.selfIteration.totalIterations).toBe(0)

      // 2. Symlink escape, chmod 0555 WAL DB (no -wal/-shm sidecars), and corrupt sibling DB
      const wiDir = join(ws.dshHome, 'assistant-work-items')
      await mkdir(wiDir, { recursive: true, mode: 0o700 })
      const wiDb = new DatabaseSync(join(wiDir, 'state.sqlite'))
      wiDb.exec("PRAGMA journal_mode = WAL; CREATE TABLE work_item (id TEXT PRIMARY KEY, state TEXT) STRICT; INSERT INTO work_item VALUES ('w1', 'settled');")
      wiDb.close()

      const outsideDb = join(ws.root, 'outside-evil.sqlite')
      const outConn = new DatabaseSync(outsideDb)
      outConn.exec("CREATE TABLE dream_runs (id TEXT PRIMARY KEY, outcome TEXT) STRICT; INSERT INTO dream_runs VALUES ('evil', 'completed');")
      outConn.close()
      await mkdir(join(ws.dshHome, 'assistant-dreaming'), { recursive: true, mode: 0o700 })
      await symlink(outsideDb, join(ws.dshHome, 'assistant-dreaming', 'state.sqlite'))

      await mkdir(join(ws.dshHome, 'assistant-recovery'), { recursive: true, mode: 0o700 })
      await writeFile(join(ws.dshHome, 'assistant-recovery', 'recovery.sqlite'), 'not-a-valid-sqlite-file', { mode: 0o600 })

      const wiFilesBefore = (await readdir(wiDir)).sort()
      await chmod(wiDir, 0o555)
      try {
        const cliReport = await collectCli({ dshHome: ws.dshHome })
        expect(cliReport.selfIteration.workItemsTotal).toBe(1)
        expect(cliReport.selfIteration.dreamingRuns).toBeNull()
        expect((cliReport.diagnostics ?? []).length).toBeGreaterThanOrEqual(2)

        const ctx = harness.createContext()
        harness.provideMockService(ctx, 'profileContext', { home: ws.dshHome, name: 'web' })
        const ownerReport = await collectOwner(ctx)
        expect(ownerReport.selfIteration.workItemsTotal).toBe(1)
        expect(ownerReport.selfIteration.dreamingRuns).toBeNull()
        expect((ownerReport.diagnostics ?? []).length).toBeGreaterThanOrEqual(2)
      } finally {
        await chmod(wiDir, 0o700)
      }
      const wiFilesAfter = (await readdir(wiDir)).sort()
      expect(wiFilesAfter).toEqual(wiFilesBefore)
      expect(wiFilesAfter.some(f => f.endsWith('-wal') || f.endsWith('-shm'))).toBe(false)
    })

    test('T2-F26-03: owner_console_version_info enforces fail-closed owner authorization & strict Typert schema bounds', async () => {
      const ws = await workspaces.create('f26-owner-bounds-')
      const profileDir = join(ws.dshHome, 'profiles', 'web')
      await mkdir(profileDir, { recursive: true, mode: 0o700 })
      const typertMod = await loadPackageModule('owner-console/typert')
      const ownerMod = await loadOwnerConsole()
      const ReportSchema = getExport<{ safeParse: (v: unknown) => { success: boolean } }>(typertMod, 'OwnerConsoleVersionReportSchema')
      const TYPERT = getExport<{ invocations: Array<{ method: string; result: { create: () => { safeParse: (v: unknown) => { success: boolean } } } }> }>(typertMod, 'TYPERT')

      const registeredTools: Array<{
        def: { name: string; execute: (args: unknown, exec: unknown) => Promise<{ ok: boolean; error?: string }> }
        opts?: { when?: (a: { agent?: unknown }) => boolean }
      }> = []
      const preauthPredicates: Array<(exec: { agent?: unknown }) => boolean> = []

      const ctx = harness.createContext()
      await harness.mountPlugin(ctx, TypertRegistry)
      harness.provideMockService(ctx, 'profileContext', { home: ws.dshHome, dir: profileDir, name: 'web' })
      harness.provideMockService(ctx, 'tools', {
        register: (def: typeof registeredTools[number]['def'], opts?: typeof registeredTools[number]['opts']) => {
          registeredTools.push({ def, opts })
          return () => {}
        },
      })
      harness.provideMockService(ctx, 'assistantPolicy', {
        registerPreauthorizedTool: (_c: unknown, _d: unknown, pred: (exec: { agent?: unknown }) => boolean) => {
          preauthPredicates.push(pred)
          return () => {}
        },
      })

      const applyFn = getExportFn<(c: unknown, cfg: unknown) => void>(ownerMod, 'apply')
      const configFn = getExportFn<(input: Record<string, unknown>) => unknown>(ownerMod, 'Config')
      applyFn(ctx, configFn({ feishuAppId: '' }))
      await Promise.resolve()

      const versionTool = registeredTools.find(t => t.def.name === 'owner_console_version_info')!
      expect(versionTool).toBeDefined()
      const foreignAgent = { id: 'foreign-session', session: { id: 'foreign-session' } }
      expect(versionTool.opts?.when?.({ agent: foreignAgent })).toBe(false)
      expect(preauthPredicates[1]?.({ agent: foreignAgent })).toBe(false)
      const denied = await versionTool.def.execute({}, { agent: foreignAgent })
      expect(denied.ok).toBe(false)

      // Oversized diagnostics, plugin names, host version, and negative now must satisfy strict Typert bounds
      await writeFile(
        join(ws.dshHome, '.dsh-rsi-host.json'),
        JSON.stringify({ schemaVersion: 1, version: `0.2.2-${'v'.repeat(200)}`, cacheRoot: ws.root, receiptDigest: 'a'.repeat(64) }),
        { mode: 0o600 },
      )
      const ctxBounds = harness.createContext()
      harness.provideMockService(ctxBounds, 'profileContext', { home: ws.dshHome, dir: profileDir, name: 'web' })
      harness.provideMockService(ctxBounds, 'pluginManager', {
        listBundles: async () => [{
          name: `@dsh-enhanced/${'long-plugin-'.repeat(25)}`,
          version: `1.0.0-${'b'.repeat(200)}`,
          enabled: true,
          installed: true,
          removable: false,
          optional: false,
        }],
        listPlugins: async () => [],
      })
      harness.provideMockService(ctxBounds, 'loader', {
        entries: () => {
          throw new Error(`E_FAIL: ${'x'.repeat(1_500)}`)
        },
      })
      const collectOwner = getExportFn<(c: unknown, opts?: Record<string, unknown>) => Promise<Record<string, unknown>>>(
        ownerMod,
        'collectOwnerConsoleVersionInfo',
      )
      const boundedReport = await collectOwner(ctxBounds, { now: -10 })
      const typertCodec = TYPERT.invocations.find(i => i.method === 'versionInfo')!.result.create()
      expect(ReportSchema.safeParse(boundedReport).success).toBe(true)
      expect(typertCodec.safeParse(boundedReport).success).toBe(true)
    })

    test('T2-F26-04: assistant-delivery & lark-channel reject invalid /version forms, attachments & unauthorized principals', async () => {
      const ws = await workspaces.create('f26-delivery-neg-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const deliveryMod = await loadAssistantDelivery()
      const parseVersionQuery = getExportFn<(text: string) => unknown>(deliveryMod, 'parseOwnerVersionQuery')
      const normalizeMod = await loadPackageModule('lark-channel/normalize')
      const normalizeLarkMessage = getExportFn<(
        cfg: Record<string, unknown>,
        msg: Record<string, unknown>,
        now: number,
      ) => { outcome: string; envelope?: Record<string, unknown> }>(normalizeMod, 'normalizeLarkMessage')

      expect(parseVersionQuery('/VERSION')).toBeUndefined()
      expect(parseVersionQuery('查看版本？？')).toBeUndefined()
      expect(parseVersionQuery('如果查看版本会有什么影响？')).toBeUndefined()

      const ctx = harness.createContext()
      ctx.baseUrl = pathToFileURL(`${ws.root}/`).href
      await mountAgentLoopTestDependencies(ctx as never, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
      harness.provideMockService(ctx, 'fileUploads', {
        registerAgentResolver: () => () => {},
        resolve: () => { throw new Error('unexpected file receipt') },
        bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }),
      })
      const llmRequests: GenerateOptions[] = []
      class EchoLlmAdapter extends LlmAdapter {
        override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          llmRequests.push(options)
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'model-ok' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'model-ok' } }
          yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
      ;(ctx as unknown as { llm: { registerAdapter: (p: string[], a: LlmAdapter) => void } }).llm.registerAdapter(
        ['mock'],
        new EchoLlmAdapter('mock', ['delivery-model'], ['text']),
      )
      await harness.mountPlugin(ctx, AgentLoop, { agents: [] })

      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
        databasePath: ws.sqlitePath('policy'),
        rules: [
          {
            id: 'pair',
            effect: 'allow',
            subject: { kind: 'external', id: 'local:test' },
            actions: ['pair.issue'],
            resource: { kind: 'message', id: 'pairing' },
            context: { initiators: ['foreground'] },
          },
          {
            id: 'owner',
            effect: 'allow',
            subject: { kind: 'external', id: 'lark/bot-1/t1/ou_owner' },
            actions: ['pair.confirm', 'ingest'],
            resource: { kind: 'message', id: '*' },
            context: { initiators: ['external'] },
          },
          {
            id: 'reply-owner',
            effect: 'allow',
            subject: { kind: 'agent', id: 'primary', workspace: ws.workspace, principal: 'lark/bot-1/t1/ou_owner' },
            actions: ['history', 'reply'],
            resource: { kind: 'message', id: '*' },
            context: { initiators: ['foreground', 'external'] },
          },
        ],
      })

      const savedSessions = new Map<string, { header: Record<string, unknown>; events: unknown[]; inheritedEventCount: number }>()
      const activeWriters = new Map<string, { append: (events: readonly unknown[]) => Promise<void>; flush: () => Promise<void>; close: () => Promise<void> }>()
      harness.provideMockService(ctx, 'sessionPersistence', {
        coordinator: { assertEventsSupported() {} },
        create: async (header: { id: string }, opts?: { inheritedEventCount?: number }) => {
          const id = String(header.id)
          savedSessions.set(id, { header: structuredClone(header), events: [], inheritedEventCount: opts?.inheritedEventCount ?? 0 })
          const pending: unknown[] = []
          const handle = {
            id: header.id,
            access: 'write' as const,
            header: structuredClone(header),
            inheritedEventCount: opts?.inheritedEventCount ?? 0,
            read: async () => ({ eventState: 'detached' as const, events: [...savedSessions.get(id)!.events, ...pending] }),
            append: async (events: readonly unknown[]) => { pending.push(...structuredClone(events)) },
            flush: async () => {
              const cur = savedSessions.get(id)!
              savedSessions.set(id, { ...cur, events: [...cur.events, ...pending.splice(0)] })
            },
            close: async () => { activeWriters.delete(id) },
            [Symbol.asyncDispose]: async () => { activeWriters.delete(id) },
          }
          activeWriters.set(id, handle)
          return handle
        },
        open: async (id: string) => {
          const cur = savedSessions.get(String(id))
          if (!cur) throw Object.assign(new Error(`session ${id} not found`), { name: 'SessionPersistenceNotFoundError' })
          const pending: unknown[] = []
          const handle = {
            id,
            access: 'write' as const,
            header: structuredClone(cur.header),
            inheritedEventCount: cur.inheritedEventCount,
            read: async () => ({ eventState: 'detached' as const, events: [...savedSessions.get(String(id))!.events, ...pending] }),
            append: async (events: readonly unknown[]) => { pending.push(...structuredClone(events)) },
            flush: async () => {
              const latest = savedSessions.get(String(id))!
              savedSessions.set(String(id), { ...latest, events: [...latest.events, ...pending.splice(0)] })
            },
            close: async () => { activeWriters.delete(String(id)) },
            [Symbol.asyncDispose]: async () => { activeWriters.delete(String(id)) },
          }
          activeWriters.set(String(id), handle)
          return handle
        },
        flush: async () => { await Promise.all([...activeWriters.values()].map(h => h.flush())) },
        stat: async (id: string) => {
          const cur = savedSessions.get(String(id))
          return cur ? { header: structuredClone(cur.header), revision: `r-${cur.events.length}` } : undefined
        },
        list: async () => [...savedSessions.values()].map(v => ({ header: structuredClone(v.header), revision: `r-${v.events.length}` })),
      })
      ctx.on('session/event' as never, ((session: { id: string }, event: unknown) => {
        void activeWriters.get(String(session.id))?.append([event])
      }) as never)
      ctx.on('session/flush' as never, ((session: { id: string }) => activeWriters.get(String(session.id))?.flush()) as never)
      ctx.on('session/disposed' as never, ((session: { id: string }) => { void activeWriters.get(String(session.id))?.close() }) as never)

      const delivery = await harness.mountService<{
        registerAdapter: (a: Record<string, unknown>) => Promise<() => void>
        issuePairing: (by: string, p: Record<string, unknown>) => { challenge: { id: string }; code: string }
        confirmPairing: (req: Record<string, unknown>) => unknown
        acceptInbound: (env: Record<string, unknown>) => Promise<unknown>
        tick: () => Promise<void>
        whenIdle: () => Promise<void>
      }>(ctx, deliveryMod.AssistantDeliveryService, 'assistantDelivery', {
        databasePath: ws.sqlitePath('delivery'),
        spoolPath: join(ws.stateDir, 'spool'),
        defaultWorkspace: ws.workspace,
        defaultAgentPreset: 'primary',
        agentProvider: 'mock',
        agentModel: 'delivery-model',
        schedulerEnabled: false,
      })

      const sends: Array<{ text: string }> = []
      await delivery.registerAdapter({
        channel: 'lark',
        account: 'bot-1',
        capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain', 'model-picker', 'permission-picker'] },
        start: async () => {},
        send: async (input: { text?: string }) => {
          sends.push({ text: input.text ?? '' })
          return { outcome: 'accepted', providerMessageId: `om_out_${sends.length}` }
        },
      })

      const ownerPrincipal = { channel: 'lark', account: 'bot-1', tenant: 't1', user: 'ou_owner' }
      const ownerPair = delivery.issuePairing('test', ownerPrincipal)
      delivery.confirmPairing({ challengeId: ownerPair.challenge.id, principal: ownerPrincipal, code: ownerPair.code })

      const drive = async () => {
        await delivery.tick()
        await delivery.whenIdle()
        await delivery.tick()
        await delivery.whenIdle()
      }
      const mkEnv = (eventId: string, kind: 'command' | 'text', text: string, attachments?: unknown[], chat = 'oc_dm_owner') => ({
        channel: 'lark',
        account: 'bot-1',
        eventId,
        occurredAt: Date.now(),
        principal: ownerPrincipal,
        conversation: { channel: 'lark', account: 'bot-1', tenant: 't1', kind: 'dm', chat },
        kind,
        text,
        ...(attachments === undefined ? {} : { attachments }),
      })

      await delivery.acceptInbound(mkEnv('e-extra', 'command', '/version extra'))
      await drive()
      expect(sends.at(-1)?.text).toContain('/version 不接受参数')

      await delivery.acceptInbound(mkEnv('e-cmd-att', 'command', '/version', [{ resourceType: 'file', providerRef: 'f1', fileName: 'a.txt' }]))
      await drive()
      expect(sends.at(-1)?.text).toContain('不接受文件、图片或其他附件')
      expect(llmRequests).toHaveLength(0)

      // NL with attachment & conversational prose & double punctuation skip pre-LLM shortcut and reach the model
      await delivery.acceptInbound(mkEnv('e-nl-att', 'text', '查看版本', [{ resourceType: 'file', providerRef: 'f2', fileName: 'b.txt' }], 'oc_dm_att'))
      await drive()
      await delivery.acceptInbound(mkEnv('e-punct', 'text', '查看版本？？', undefined, 'oc_dm_punct'))
      await drive()
      await delivery.acceptInbound(mkEnv('e-prose', 'text', '如果查看版本会有什么影响？', undefined, 'oc_dm_prose'))
      await drive()
      expect(llmRequests).toHaveLength(3)

      // Unauthorized / unpaired Lark principal produces 0 outbound sends
      const sendsBeforeStranger = sends.length
      const inboundCfg = { account: 'bot-1', tenant: 't1', requireMentionInGroups: true, maxTextBytes: 4096, staleAfterMs: 300_000 }
      const stranger = normalizeLarkMessage(inboundCfg, {
        messageId: 'om_stranger',
        chatId: 'oc_dm_stranger',
        chatType: 'p2p',
        senderId: 'ou_stranger',
        content: '/version',
        rawContentType: 'text',
        resources: [],
        mentionAll: false,
        mentionedBot: false,
        createTime: Date.now(),
      }, Date.now())
      if (stranger.outcome === 'accept' && stranger.envelope) {
        await delivery.acceptInbound(stranger.envelope).catch(() => {})
      }
      await drive()
      expect(sends.length).toBe(sendsBeforeStranger)
    })

    test('T2-F26-05: AssistantDeliveryService falls back cleanly without ownerConsole, when versionInfo throws, or on malformed payload', async () => {
      const ws = await workspaces.create('f26-fallback-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantDeliveryService } = await loadAssistantDelivery()

      const ctx = harness.createContext()
      await harness.mountService(ctx, AssistantPolicyService, 'assistantPolicy', {
        databasePath: ws.sqlitePath('policy'),
        rules: [
          {
            id: 'pair',
            effect: 'allow',
            subject: { kind: 'external', id: 'local:test' },
            actions: ['pair.issue'],
            resource: { kind: 'message', id: 'pairing' },
            context: { initiators: ['foreground'] },
          },
          {
            id: 'owner',
            effect: 'allow',
            subject: { kind: 'external', id: 'lark/bot-1/t1/ou_owner' },
            actions: ['pair.confirm', 'ingest'],
            resource: { kind: 'message', id: '*' },
            context: { initiators: ['external'] },
          },
          {
            id: 'reply-owner',
            effect: 'allow',
            subject: { kind: 'agent', id: 'primary', workspace: ws.workspace, principal: 'lark/bot-1/t1/ou_owner' },
            actions: ['history', 'reply'],
            resource: { kind: 'message', id: '*' },
            context: { initiators: ['foreground', 'external'] },
          },
        ],
      })
      harness.provideMockService(ctx, 'agents', {
        create: async (opts: { sessionId: string; meta?: { cwd?: string; agentPreset?: string }; setup?: (c: unknown, a?: unknown) => Promise<unknown> }) => {
          const id = opts.sessionId
          const session = {
            id,
            header: { id, cwd: opts.meta?.cwd ?? ws.workspace, agentPreset: opts.meta?.agentPreset ?? 'primary' },
            append: () => {},
            snapshotEvents: () => [],
            deriveMessages: () => [],
          }
          const agent = {
            id,
            ctx,
            session,
            model: { select: () => {}, current: () => ({ provider: 'fixture', model: 'fixture' }) },
            status: 'idle',
            whenIdle: async () => {},
            runMaintenance: (fn: (signal: AbortSignal) => unknown) => fn(new AbortController().signal),
            cancel: () => {},
          }
          await opts.setup?.(ctx, agent)
          return { agent, dispose: async () => {} }
        },
        resume: vi.fn(async () => ({})),
      })
      harness.provideMockService(ctx, 'sessions', { list: async () => [], flush: async () => true })
      harness.provideMockService(ctx, 'llm', { complete: async () => ({}) })

      const delivery = await harness.mountService<{
        dispatchVersionQuery: () => Promise<{
          schemaVersion: number
          protocol: string
          selfIteration: { dataState: string }
          diagnostics?: readonly string[]
        }>
        registerAdapter: (a: Record<string, unknown>) => Promise<() => void>
        issuePairing: (by: string, p: Record<string, unknown>) => { challenge: { id: string }; code: string }
        confirmPairing: (req: Record<string, unknown>) => unknown
        acceptInbound: (env: Record<string, unknown>) => Promise<unknown>
        tick: () => Promise<void>
        whenIdle: () => Promise<void>
      }>(ctx, AssistantDeliveryService, 'assistantDelivery', {
        databasePath: ws.sqlitePath('delivery'),
        spoolPath: join(ws.stateDir, 'spool'),
        defaultWorkspace: ws.workspace,
        defaultAgentPreset: 'primary',
        schedulerEnabled: false,
      })

      const sends: string[] = []
      await delivery.registerAdapter({
        channel: 'lark',
        account: 'bot-1',
        capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain', 'model-picker', 'permission-picker'] },
        start: async () => {},
        send: async (input: { text?: string }) => {
          sends.push(input.text ?? '')
          return { outcome: 'accepted', providerMessageId: `om_${sends.length}` }
        },
      })
      const ownerPrincipal = { channel: 'lark', account: 'bot-1', tenant: 't1', user: 'ou_owner' }
      const pair = delivery.issuePairing('test', ownerPrincipal)
      delivery.confirmPairing({ challengeId: pair.challenge.id, principal: ownerPrincipal, code: pair.code })

      // 1. Absent ownerConsole
      const noConsoleReport = await delivery.dispatchVersionQuery()
      expect(noConsoleReport.protocol).toBe('dsh-rsi/version/v1')
      expect(noConsoleReport.selfIteration.dataState).toBe('no-data')

      // 2. Throwing ownerConsole.versionInfo()
      let currentVersionInfo: () => Promise<unknown> = async () => {
        throw new Error('console unavailable')
      }
      harness.provideMockService(ctx, 'ownerConsole', {
        versionInfo: () => currentVersionInfo(),
      })
      const throwReport = await delivery.dispatchVersionQuery()
      expect(throwReport.protocol).toBe('dsh-rsi/version/v1')
      expect(throwReport.diagnostics?.some(d => d.includes('ownerConsole.versionInfo failed'))).toBe(true)

      // 3. Malformed ownerConsole.versionInfo() matching protocol string but missing required objects
      currentVersionInfo = async () => ({ schemaVersion: 1, protocol: 'dsh-rsi/version/v1' })
      const malformedReport = await delivery.dispatchVersionQuery()
      expect(malformedReport.protocol).toBe('dsh-rsi/version/v1')
      expect(malformedReport.selfIteration.dataState).toBe('no-data')
      expect(malformedReport.diagnostics?.some(d => d.includes('ownerConsole.versionInfo returned unexpected payload'))).toBe(true)

      await delivery.acceptInbound({
        channel: 'lark',
        account: 'bot-1',
        eventId: 'evt-malformed-reply',
        occurredAt: Date.now(),
        principal: ownerPrincipal,
        conversation: { channel: 'lark', account: 'bot-1', tenant: 't1', kind: 'dm', chat: 'oc_dm_owner' },
        kind: 'command',
        text: '/version',
      })
      await delivery.tick()
      await delivery.whenIdle()
      await delivery.tick()
      await delivery.whenIdle()

      expect(sends.at(-1)).toContain('助手版本：dsh-enhanced v')
      expect(sends.at(-1)).not.toContain('自迭代控制服务尚未启用')
    })
  })
})
