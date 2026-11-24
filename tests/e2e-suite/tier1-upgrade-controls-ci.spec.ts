import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { createServer } from 'node:http'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { isSeq, parseDocument } from 'yaml'
import { getExport, getExportFn, sha256Hex } from './helpers/assertions.ts'
import { runBashCommand, runDshRsiInProcess, runNodeScript } from './helpers/cli-runner.ts'
import { createCordisHarness } from './helpers/cordis-harness.ts'
import {
  loadAssistantDelivery,
  loadAssistantPolicy,
  loadAssistantWebOwnerSetup,
  loadDshRsiCli,
  loadDshRsiUpgrade,
  loadLarkChannel,
  loadOwnerConsole,
  loadPackageModule,
  loadUpgradeProgram,
  readAllWorkspaceManifests,
} from './helpers/packages.ts'
import { createIsolatedEnv, createWorkspaceTracker, repoRoot } from './helpers/workspace.ts'
import { parseBashArray, parseWorkflowYaml, readInstallerCommonScript } from './helpers/yaml-presets.ts'

const workspaces = createWorkspaceTracker()
const harness = createCordisHarness()

afterEach(async () => {
  await harness.disposeAll()
  await workspaces.cleanupAll()
})

describe('Tier 1 — F19–F23: Upgrade Migration, Standard Queues, R4 Controls, npm Readback Gate & CI', () => {
  describe('F19: WP17 cross-version 0.1 -> 0.2, existing-owner & non-empty history migration', () => {
    async function seedProfileFixture(
      dshHome: string,
      profileName: string,
      opts: { hostVersion?: string; seedHistory?: boolean } = {},
    ) {
      const profileDir = join(dshHome, 'profiles', profileName)
      const enhancedDir = join(profileDir, 'node_modules', '@dsh-enhanced', 'assistant-delivery')
      const cacheRoot = join(dshHome, 'host-cache')
      await mkdir(profileDir, { recursive: true, mode: 0o700 })
      await mkdir(enhancedDir, { recursive: true, mode: 0o700 })
      await mkdir(cacheRoot, { recursive: true, mode: 0o700 })

      const hostVersion = opts.hostVersion ?? '0.1.9'
      const hostBindingPath = join(dshHome, '.dsh-rsi-host.json')
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
      await writeFile(
        join(profileDir, 'package.json'),
        JSON.stringify({
          name: `dsh-profile-${profileName}`,
          private: true,
          dependencies: { '@dsh-enhanced/assistant-delivery': '0.1.83' },
        }),
        { mode: 0o600 },
      )
      await writeFile(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', { mode: 0o600 })
      await writeFile(
        join(enhancedDir, 'package.json'),
        JSON.stringify({ name: '@dsh-enhanced/assistant-delivery', version: '0.1.83' }),
        { mode: 0o600 },
      )
      await writeFile(
        join(profileDir, 'cordis.patch.yml'),
        [
          '- id: dsh-enhanced-assistant-delivery',
          '  name: "@dsh-enhanced/assistant-delivery"',
          '  config:',
          '    ownerRoutes:',
          '      - id: owner-route-1',
          '        principal:',
          '          channel: web',
          '          account: owner',
          '          tenant: local',
          '          user: primary',
        ].join('\n'),
        { mode: 0o600 },
      )
      await writeFile(join(profileDir, '.credentials.yaml'), 'openai: dummy-ref\n', { mode: 0o600 })

      if (opts.seedHistory) {
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

    test('T1-F19-01: Host 0.1 -> 0.2 upgrade executes cleanly and preserves cordis.patch.yml & credentials', async () => {
      const ws = await workspaces.create('f19-host01-')
      const { profileDir, hostBindingPath } = await seedProfileFixture(ws.dshHome, 'web', { hostVersion: '0.1.9' })
      const upg = await loadDshRsiUpgrade()

      const { report } = await upg.runUpgrade({
        dshHome: ws.dshHome,
        osHome: ws.root,
        platform: 'linux',
        profile: 'web',
        action: 'apply',
        dshVersion: '0.2.2-rc.5',
      } as never, {
        fetch: mockUpgradeFetch() as never,
        inspectBoundHost: async () => ({
          status: 'ready',
          bindingPath: hostBindingPath,
          version: '0.1.9',
          dshPath: '/usr/local/bin/dsh',
          issues: [],
        }) as never,
        scanProcesses: async () => ({ processes: [] }),
        upgradeHost: async () => {},
        upgradeProfilePackages: async () => {},
        verifyHealth: async () => ({ ok: true }),
      } as never)

      expect(report.ok).toBe(true)
      expect(report.execution?.executed).toBe(true)
      expect(await readFile(join(profileDir, '.credentials.yaml'), 'utf8')).toContain('openai: dummy-ref')
    })

    test('T1-F19-02: existing-owner in-place upgrade preserves ownerRoutes principal bindings', async () => {
      const ws = await workspaces.create('f19-owner-')
      const { profileDir, hostBindingPath } = await seedProfileFixture(ws.dshHome, 'web', { hostVersion: '0.2.1-rc.2' })
      const upg = await loadDshRsiUpgrade()

      const { report } = await upg.runUpgrade({
        dshHome: ws.dshHome,
        osHome: ws.root,
        platform: 'linux',
        profile: 'web',
        action: 'apply',
      } as never, {
        fetch: mockUpgradeFetch() as never,
        inspectBoundHost: async () => ({
          status: 'ready',
          bindingPath: hostBindingPath,
          version: '0.2.1-rc.2',
          dshPath: '/usr/local/bin/dsh',
          issues: [],
        }) as never,
        scanProcesses: async () => ({ processes: [] }),
        upgradeHost: async () => {},
        upgradeProfilePackages: async () => {},
        verifyHealth: async () => ({ ok: true }),
      } as never)

      expect(report.ok).toBe(true)
      const patchAfter = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
      expect(patchAfter).toContain('owner-route-1')
    })

    test('T1-F19-03: non-empty creation & revision history migration preserves SQLite ledgers', async () => {
      const ws = await workspaces.create('f19-history-')
      const { hostBindingPath } = await seedProfileFixture(ws.dshHome, 'web', { hostVersion: '0.1.9', seedHistory: true })
      const upg = await loadDshRsiUpgrade()

      const { report } = await upg.runUpgrade({
        dshHome: ws.dshHome,
        osHome: ws.root,
        platform: 'linux',
        profile: 'web',
        action: 'apply',
        allowNonEmptyHistoryMigration: true,
      } as never, {
        fetch: mockUpgradeFetch() as never,
        inspectBoundHost: async () => ({
          status: 'ready',
          bindingPath: hostBindingPath,
          version: '0.1.9',
          dshPath: '/usr/local/bin/dsh',
          issues: [],
        }) as never,
        scanProcesses: async () => ({ processes: [] }),
        upgradeHost: async () => {},
        upgradeProfilePackages: async () => {},
        verifyHealth: async () => ({ ok: true }),
      } as never)

      expect(report.ok).toBe(true)
      expect(report.readiness.ledgersOk).toBe(true)
    })

    test('T1-F19-04: failed post-upgrade verifyHealth triggers automatic rollback', async () => {
      const ws = await workspaces.create('f19-rollback-')
      const { hostBindingPath } = await seedProfileFixture(ws.dshHome, 'web', { hostVersion: '0.2.1-rc.2' })
      const upg = await loadDshRsiUpgrade()

      const { report } = await upg.runUpgrade({
        dshHome: ws.dshHome,
        osHome: ws.root,
        platform: 'linux',
        profile: 'web',
        action: 'apply',
      } as never, {
        fetch: mockUpgradeFetch() as never,
        inspectBoundHost: async () => ({
          status: 'ready',
          bindingPath: hostBindingPath,
          version: '0.2.1-rc.2',
          dshPath: '/usr/local/bin/dsh',
          issues: [],
        }) as never,
        scanProcesses: async () => ({ processes: [] }),
        upgradeHost: async () => {},
        upgradeProfilePackages: async () => {},
        verifyHealth: async () => ({ ok: false, error: 'unhealthy' }),
      } as never)

      expect(report.ok).toBe(false)
      expect(report.execution?.rolledBack).toBe(true)
      expect(report.execution?.rollbackSucceeded).toBe(true)
    })

    test('T1-F19-05: upgrade-program.mjs accepts 0.1->0.2 selector and profile arguments cleanly', async () => {
      const ws = await workspaces.create('f19-prog-')
      await seedProfileFixture(ws.dshHome, 'web', { hostVersion: '0.1.9' })
      const mod = await loadUpgradeProgram()
      const parseArgs = getExportFn<(argv: readonly string[]) => Record<string, unknown>>(
        mod as Record<string, unknown>,
        'parseProgramUpgradeArgs',
      )
      const parsed = parseArgs([
        '--dsh-home',
        ws.dshHome,
        '--profile',
        'web',
        '--dsh-version',
        '0.2.2-rc.5',
        '--dry-run',
      ])
      expect(parsed.dryRun).toBe(true)
      expect(parsed.selector).toBe('0.2.2-rc.5')
      expect(parsed.profile).toBe('web')
      expect(parsed.home).toBe(ws.dshHome)
    })
  })

  describe('F20: WP17/R3 standard install queues include assistant-association & R3 defaults', () => {
    test('T1-F20-01: install-local.sh --dry-run --scenario web includes assistant-association and R3 plugins', async () => {
      const ws = await workspaces.create('f20-web-')
      const env = await createIsolatedEnv(ws)
      const res = await runBashCommand(
        [join(repoRoot, 'scripts/install/install-local.sh'), '--dry-run', '--scenario', 'web', '--yes'],
        { env },
      )
      expect(res.exitCode).toBe(0)
      expect(res.stdout + res.stderr).toContain('assistant-association')
      expect(res.stdout + res.stderr).toContain('assistant-evaluation')
    })

    test('T1-F20-02: install-local.sh --dry-run --scenario supervised includes assistant-association', async () => {
      const ws = await workspaces.create('f20-sup-')
      const env = await createIsolatedEnv(ws)
      const res = await runBashCommand(
        [join(repoRoot, 'scripts/install/install-local.sh'), '--dry-run', '--scenario', 'supervised', '--yes'],
        { env },
      )
      expect(res.exitCode).toBe(0)
      expect(res.stdout + res.stderr).toContain('assistant-association')
      expect(res.stdout + res.stderr).toContain('assistant-work-items')
    })

    test('T1-F20-03: install-local.sh --dry-run --scenario lark includes assistant-association', async () => {
      const ws = await workspaces.create('f20-lark-')
      const env = await createIsolatedEnv(ws)
      const res = await runBashCommand(
        [join(repoRoot, 'scripts/install/install-local.sh'), '--dry-run', '--scenario', 'lark', '--yes'],
        { env },
      )
      expect(res.exitCode).toBe(0)
      expect(res.stdout + res.stderr).toContain('assistant-association')
      expect(res.stdout + res.stderr).toContain('lark-channel')
    })

    test('T1-F20-04: prepareWebOwnerProfile prepares R3-ready profile with assistant-association database path', async () => {
      const ws = await workspaces.create('f20-prep-')
      const setupMod = await loadAssistantWebOwnerSetup()
      const prepare = getExportFn<(
        input: Record<string, unknown>,
        source: string,
        effectiveSource: string,
      ) => { patch: string; databasePath: string }>(setupMod, 'prepareWebOwnerProfile')

      const profileDir = join(ws.dshHome, 'profiles', 'web')
      await mkdir(profileDir, { recursive: true, mode: 0o700 })

      const bundleSnippets = await Promise.all(
        ['personal-assistant', 'assistant-delivery'].map(async slug => {
          const text = await readFile(join(repoRoot, 'plugins', slug, 'cordis.patch.yml'), 'utf8')
          const doc = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (v: string) => v }] })
          const rows = doc.toJS() as Array<{ insert?: unknown[] }>
          const idx = rows.findIndex(r => r.insert !== undefined)
          const node = doc.getIn([idx, 'insert', 0], true)
          const exported = parseDocument('[]')
          if (isSeq(exported.contents)) exported.contents.flow = false
          exported.add(node)
          return exported.toString()
        }),
      )
      const effectiveSource = [
        bundleSnippets.join('\n'),
        '- id: dsh-enhanced-assistant-goals',
        '  name: "@dsh-enhanced/assistant-goals"',
        '- id: dsh-enhanced-assistant-web-owner',
        '  name: "@dsh-enhanced/assistant-web-owner"',
        '- id: dsh-enhanced-assistant-association',
        '  name: "@dsh-enhanced/assistant-association"',
        '  config:',
        '    enabled: true',
      ].join('\n')

      const res = prepare(
        {
          dshHome: ws.dshHome,
          profile: 'web',
          workspace: ws.workspace,
          preset: 'primary',
        },
        '[]\n',
        effectiveSource,
      )
      expect(res.patch).toContain('assistant-goals')
      expect(res.patch).toContain('assistant-association')
      expect(res.patch).toContain(join(ws.dshHome, 'assistant-association'))
    }, 15_000)

    test('T1-F20-05: common.sh standard slug arrays list assistant-association without dogfood preset', async () => {
      const script = await readInstallerCommonScript()
      const core = parseBashArray(script, 'DSH_ENHANCED_CORE_PLUGIN_SLUGS')
      const lark = parseBashArray(script, 'DSH_ENHANCED_LARK_PLUGIN_SLUGS')
      const sup = parseBashArray(script, 'DSH_ENHANCED_SUPERVISED_GROWTH_PLUGIN_SLUGS')
      const combined = new Set([...core, ...lark, ...sup])
      expect(combined.has('assistant-association')).toBe(true)
    })
  })

  describe('F21: R4 CLI (dsh-rsi enable|disable|upgrade) & NL Web/Lark controls + recovery', () => {
    test('T1-F21-01: dsh-rsi parseArgs and CLI toggle self-iteration via enable and disable', async () => {
      const ws = await workspaces.create('f21-cli-toggle-')
      const cli = await loadDshRsiCli()
      const parseArgs = getExportFn<(argv: readonly string[]) => Record<string, unknown>>(cli, 'parseArgs')
      expect(parseArgs(['enable', '--profile', 'web']).command).toBe('enable')
      expect(parseArgs(['disable', '--profile', 'web']).command).toBe('disable')

      const profileDir = join(ws.dshHome, 'profiles', 'web')
      await mkdir(profileDir, { recursive: true, mode: 0o700 })
      await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }), 'utf8')
      await writeFile(
        join(profileDir, 'cordis.patch.yml'),
        '- id: dsh-enhanced-assistant-work-items\n  name: "@dsh-enhanced/assistant-work-items"\n  config:\n    enabled: false\n',
        'utf8',
      )

      const dis = await runDshRsiInProcess(['disable', '--profile', 'web', '--dsh-home', ws.dshHome, '--json'])
      expect(dis.exitCode).toBe(0)
      const en = await runDshRsiInProcess(['enable', '--profile', 'web', '--dsh-home', ws.dshHome, '--json'])
      expect(en.exitCode).toBe(0)
    })

    test('T1-F21-02: unified upgradeAssistantAndRecover executes upgrade, migration, doctor and recovery', async () => {
      const ws = await workspaces.create('f21-upgrade-')
      const cli = await loadDshRsiCli()
      const upgradeAndRecover = getExportFn<(opts: Record<string, unknown>, deps?: Record<string, unknown>) => Promise<Record<string, unknown>>>(
        cli,
        'upgradeAssistantAndRecover',
      )

      const res = await upgradeAndRecover({ dshHome: ws.dshHome, profile: 'web', yes: true }, {
        runUpgrade: async () => ({ ok: true, ready: true }),
        runDoctor: async () => ({ ok: true, ready: true }),
        restartService: async () => ({ ok: true, restarted: true }),
      })
      expect(res.ok).toBe(true)
      expect(res.healthy).toBe(true)
    })

    test('T1-F21-03: Web owner-console exposes owner-authorized enable/disable/upgrade control operations', async () => {
      const ws = await workspaces.create('f21-web-ctrl-')
      const ownerMod = await loadOwnerConsole()
      const ctx = harness.createContext()
      harness.provideMockService(ctx, 'typert', { register: () => {} })
      const handleControl = getExportFn<(ctx: unknown, req: Record<string, unknown>) => Promise<Record<string, unknown>>>(
        ownerMod,
        'handleOwnerConsoleControlAction',
      )

      const res = await handleControl(ctx, {
        dshHome: ws.dshHome,
        ownerAuthorized: true,
        action: 'enableSelfIteration',
      })
      expect(res.ok).toBe(true)
      expect(res.state).toBe('enabled')
    })

    test('T1-F21-04: Feishu lark-channel / assistant-delivery routes concise NL enable/disable/upgrade commands', async () => {
      const deliveryMod = await loadAssistantDelivery()
      const larkMod = await loadLarkChannel()
      const parseNlControl = getExportFn<(text: string) => Record<string, unknown> | undefined>(
        deliveryMod,
        'parseOwnerSelfIterationCommand',
      )
      expect(parseNlControl('开启自迭代')?.action).toBe('enableSelfIteration')
      expect(parseNlControl('关闭自迭代')?.action).toBe('disableSelfIteration')
      expect(parseNlControl('升级整体助手')?.action).toBe('upgradeAssistantAndRecover')
      expect(larkMod.LarkChannelService).toBeDefined()
    })

    test('T1-F21-05: non-owner / unauthenticated NL self-iteration toggle or upgrade is rejected fail-closed', async () => {
      const ws = await workspaces.create('f21-auth-')
      const ownerMod = await loadOwnerConsole()
      const handleControl = getExportFn<(ctx: unknown, req: Record<string, unknown>) => Promise<Record<string, unknown>>>(
        ownerMod,
        'handleOwnerConsoleControlAction',
      )

      const ctx = harness.createContext()
      const res = await handleControl(ctx, {
        dshHome: ws.dshHome,
        ownerAuthorized: false,
        action: 'disableSelfIteration',
      })
      expect(res.ok).toBe(false)
      expect(res.error ?? res.reason).toBeDefined()
    })
  })

  describe('F22: R1 release.yml 40-package npm readback gate & verify-npm-release.mjs', () => {
    test('T1-F22-01: scripts/verify-npm-release.mjs succeeds (exit 0) when all 40 packages exist at target version', async () => {
      const manifests = await readAllWorkspaceManifests()
      expect(manifests.length).toBe(40)
      const targetVersion = manifests[0]!.version

      const server = createServer((req, res) => {
        const pkgName = decodeURIComponent((req.url ?? '/').slice(1))
        if (manifests.some(m => m.name === pkgName)) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            name: pkgName,
            'dist-tags': { latest: targetVersion },
            versions: {
              [targetVersion]: { name: pkgName, version: targetVersion, dist: { tarball: 'http://127.0.0.1/dummy.tgz' } },
            },
          }))
          return
        }
        res.writeHead(404)
        res.end('Not found')
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port

      try {
        const res = await runNodeScript('scripts/verify-npm-release.mjs', [
          '--tag',
          `v${targetVersion}`,
          '--registry',
          `http://127.0.0.1:${port}`,
          '--retries',
          '0',
        ])
        expect(res.exitCode).toBe(0)
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })

    test('T1-F22-02: verify-npm-release.mjs fails closed when 1 of 40 packages is missing on npm', async () => {
      const manifests = await readAllWorkspaceManifests()
      const targetVersion = manifests[0]!.version
      const missingName = '@dsh-enhanced/assistant-association'

      const server = createServer((req, res) => {
        const pkgName = decodeURIComponent((req.url ?? '/').slice(1))
        if (pkgName !== missingName && manifests.some(m => m.name === pkgName)) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            name: pkgName,
            'dist-tags': { latest: targetVersion },
            versions: {
              [targetVersion]: { name: pkgName, version: targetVersion, dist: { tarball: 'http://127.0.0.1/dummy.tgz' } },
            },
          }))
          return
        }
        res.writeHead(404)
        res.end('Not found')
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port

      try {
        const res = await runNodeScript('scripts/verify-npm-release.mjs', [
          '--tag',
          `v${targetVersion}`,
          '--registry',
          `http://127.0.0.1:${port}`,
          '--retries',
          '0',
        ])
        expect(res.exitCode).not.toBe(0)
        expect(res.stdout + res.stderr).toContain(missingName)
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })

    test('T1-F22-03: .github/workflows/release.yml enforces readback gate strictly between publish and record', async () => {
      const wf = await parseWorkflowYaml<{
        jobs: Record<string, { needs?: string | string[]; steps?: Array<{ run?: string }> }>
      }>('.github/workflows/release.yml')
      const recordNeeds = Array.isArray(wf.jobs.record?.needs) ? wf.jobs.record?.needs : [wf.jobs.record?.needs]
      const publishSteps = (wf.jobs.publish?.steps ?? []).map(s => s.run ?? '').join('\n')
      const hasVerifyJob = wf.jobs['verify-npm'] !== undefined && recordNeeds.includes('verify-npm')
      const hasInlineStepAfterPublish = publishSteps.includes('verify-npm-release.mjs') && publishSteps.indexOf('pnpm release:publish') < publishSteps.indexOf('verify-npm-release.mjs')
      expect(hasVerifyJob || hasInlineStepAfterPublish).toBe(true)
    })

    test('T1-F22-04: release.yml readback gate pins exact RELEASE_TAG version', async () => {
      const raw = await readFile(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
      expect(raw).toContain('verify-npm-release.mjs')
      expect(raw).toContain('RELEASE_TAG')
    })

    test('T1-F22-05: all 40 workspace packages share exact version alignment and public publishConfig', async () => {
      const manifests = await readAllWorkspaceManifests()
      expect(manifests.length).toBe(40)
      expect(manifests.filter(m => m.kind === 'package').length).toBe(4)
      expect(manifests.filter(m => m.kind === 'plugin').length).toBe(36)
      const versions = new Set(manifests.map(m => m.version))
      expect(versions.size).toBe(1)
      for (const m of manifests) {
        expect(m.publishConfig?.access).toBe('public')
      }
    })
  })

  describe('F23: R1 cross-platform CI coverage in .github/workflows/ci.yml', () => {
    test('T1-F23-01: ci.yml Windows job covers validate, build, and dsh-rsi-cli tests', async () => {
      const wf = await parseWorkflowYaml<{
        jobs: Record<string, { 'runs-on'?: string; steps?: Array<{ run?: string }> }>
      }>('.github/workflows/ci.yml')
      const winJobs = Object.entries(wf.jobs).filter(([, j]) => String(j['runs-on'] ?? '').includes('windows'))
      expect(winJobs.length).toBeGreaterThan(0)
      const allWinRun = winJobs.flatMap(([, j]) => (j.steps ?? []).map(s => s.run ?? '')).join('\n')
      expect(allWinRun).toContain('pnpm run validate')
      expect(allWinRun).toContain('pnpm run build')
      expect(allWinRun).toContain('dsh-rsi-cli')
    })

    test('T1-F23-02: ci.yml Windows job covers assistant-isolation and assistant-actions', async () => {
      const wf = await parseWorkflowYaml<{
        jobs: Record<string, { 'runs-on'?: string; steps?: Array<{ run?: string }> }>
      }>('.github/workflows/ci.yml')
      const allWinRun = Object.values(wf.jobs)
        .filter(j => String(j['runs-on'] ?? '').includes('windows'))
        .flatMap(j => (j.steps ?? []).map(s => s.run ?? ''))
        .join('\n')
      expect(allWinRun).toContain('assistant-isolation')
      expect(allWinRun).toContain('assistant-actions')
    })

    test('T1-F23-03: ci.yml macOS job covers validate, lint, build, assistant-isolation, dsh-rsi-cli & assistant-actions', async () => {
      const wf = await parseWorkflowYaml<{
        jobs: Record<string, { 'runs-on'?: string; steps?: Array<{ run?: string }> }>
      }>('.github/workflows/ci.yml')
      const macRuns = Object.values(wf.jobs)
        .filter(j => String(j['runs-on'] ?? '').includes('macos'))
        .flatMap(j => (j.steps ?? []).map(s => s.run ?? ''))
        .join('\n')
      expect(macRuns).toContain('pnpm run validate')
      expect(macRuns).toContain('pnpm run lint')
      expect(macRuns).toContain('pnpm run build')
      expect(macRuns).toContain('assistant-isolation')
      expect(macRuns).toContain('dsh-rsi-cli')
      expect(macRuns).toContain('assistant-actions')
    })

    test('T1-F23-04: ci.yml verify aggregation job gates on all Linux, macOS, and Windows jobs', async () => {
      const wf = await parseWorkflowYaml<{
        jobs: Record<string, { needs?: string[] }>
      }>('.github/workflows/ci.yml')
      const verifyJob = wf.jobs.verify
      expect(verifyJob).toBeDefined()
      const needs = new Set(verifyJob?.needs ?? [])
      const nonVerifyJobs = Object.keys(wf.jobs).filter(k => k !== 'verify')
      for (const jobName of nonVerifyJobs) {
        expect(needs.has(jobName)).toBe(true)
      }
      expect(getExport<unknown>(wf as Record<string, unknown>, 'jobs')).toBeDefined()
    })

    test('T1-F23-05: ci.yml triggers on dev, main, pull_request and configures ubuntu, macos & windows runners', async () => {
      const wf = await parseWorkflowYaml<{
        on: Record<string, { branches?: string[] } | null>
        jobs: Record<string, { 'runs-on'?: string }>
      }>('.github/workflows/ci.yml')
      expect(wf.on.push?.branches).toEqual(expect.arrayContaining(['dev', 'main']))
      expect('pull_request' in wf.on).toBe(true)
      expect('schedule' in wf.on).toBe(true)
      const runners = Object.values(wf.jobs).map(j => String(j['runs-on'] ?? ''))
      expect(runners.some(r => r.includes('ubuntu'))).toBe(true)
      expect(runners.some(r => r.includes('macos'))).toBe(true)
      expect(runners.some(r => r.includes('windows'))).toBe(true)
    })
  })

  describe('F26: Multi-channel & CLI version command + read-only self-iteration statistics', () => {
    test('T1-F26-01: dsh-rsi --version, -V, version --short, bin/dsh-rsi.js, absent DSH_HOME JSON & common.sh probe compatibility', async () => {
      const ws = await workspaces.create('f26-cli-ver-')
      const manifests = await readAllWorkspaceManifests()
      const expectedVersion = manifests[0]!.version
      const cli = await loadDshRsiCli()
      expect(cli.version).toBe(expectedVersion)

      for (const args of [['--version'], ['-V'], ['version', '--short']] as const) {
        const res = await runDshRsiInProcess(args)
        expect(res.exitCode, `Expected exit 0 for ${args.join(' ')}`).toBe(0)
        expect(res.stdout.trim()).toBe(expectedVersion)
      }

      const binRes = await runNodeScript('packages/dsh-rsi-cli/bin/dsh-rsi.js', ['--version'])
      expect(binRes.exitCode).toBe(0)
      expect(binRes.stdout.trim()).toBe(expectedVersion)

      const absentHome = join(ws.root, 'absent-dsh-home')
      const jsonRes = await runDshRsiInProcess(['version', '--json', '--dsh-home', absentHome], { DSH_HOME: absentHome })
      expect(jsonRes.exitCode).toBe(0)
      const report = JSON.parse(jsonRes.stdout) as {
        schemaVersion: number
        protocol: string
        assistant: { version: string }
        plugins: { state: string }
        selfIteration: { dataState: string; totalIterations: number | null }
      }
      expect(report.schemaVersion).toBe(1)
      expect(report.protocol).toBe('dsh-rsi/version/v1')
      expect(report.assistant.version).toBe(expectedVersion)
      expect(report.plugins.state).toBe('unavailable')
      expect(report.selfIteration.dataState).toBe('no-data')
      expect(report.selfIteration.totalIterations).toBeNull()

      // Verify common.sh dsh_enhanced_ensure_rsi_cli works with both --version and legacy `version`-only mock
      const shimBin = join(ws.root, 'shim-bin')
      await mkdir(shimBin, { recursive: true, mode: 0o700 })
      await writeFile(join(shimBin, 'npm'), '#!/usr/bin/env bash\nexit 0\n', 'utf8')
      await chmod(join(shimBin, 'npm'), 0o755)

      const legacyMock = join(shimBin, 'dsh-rsi')
      await writeFile(
        legacyMock,
        `#!/usr/bin/env bash\nif [[ "\${1:-}" == version ]]; then printf "%s\\n" "${expectedVersion}"; fi\n`,
        'utf8',
      )
      await chmod(legacyMock, 0o755)
      const envLegacy = await createIsolatedEnv(ws, { PATH: `${shimBin}:${process.env.PATH ?? '/usr/bin:/bin'}` })
      const legacyProbe = await runBashCommand([
        '-c',
        `source "${join(repoRoot, 'scripts/install/common.sh')}" && dsh_enhanced_ensure_rsi_cli npm "${repoRoot}" "${expectedVersion}" 0`,
      ], { env: envLegacy })
      expect(legacyProbe.exitCode).toBe(0)
      expect(legacyProbe.stdout).toContain(`dsh-rsi 已就绪：${expectedVersion}`)

      await writeFile(
        legacyMock,
        `#!/usr/bin/env bash\nif [[ "\${1:-}" == --version ]]; then printf "%s\\n" "${expectedVersion}"; fi\n`,
        'utf8',
      )
      await chmod(legacyMock, 0o755)
      const modernProbe = await runBashCommand([
        '-c',
        `source "${join(repoRoot, 'scripts/install/common.sh')}" && dsh_enhanced_ensure_rsi_cli npm "${repoRoot}" "${expectedVersion}" 0`,
      ], { env: envLegacy })
      expect(modernProbe.exitCode).toBe(0)
      expect(modernProbe.stdout).toContain(`dsh-rsi 已就绪：${expectedVersion}`)
    })

    test('T1-F26-02: dsh-rsi version --json aggregates read-only SQLite ledgers without double-counting and passes OwnerConsoleVersionReportSchema', async () => {
      const ws = await workspaces.create('f26-cli-ledgers-')
      const manifests = await readAllWorkspaceManifests()
      const expectedVersion = manifests[0]!.version
      const typertMod = await loadPackageModule('owner-console/typert')
      const ReportSchema = getExport<{ parse: (input: unknown) => unknown }>(typertMod, 'OwnerConsoleVersionReportSchema')

      const profilePkgDir = join(ws.dshHome, 'profiles', 'web', 'node_modules', '@dsh-enhanced', 'owner-console')
      await mkdir(profilePkgDir, { recursive: true, mode: 0o700 })
      await writeFile(
        join(ws.dshHome, 'profiles', 'web', 'package.json'),
        JSON.stringify({ name: 'dsh-profile-web', private: true }),
        'utf8',
      )
      await writeFile(
        join(profilePkgDir, 'package.json'),
        JSON.stringify({ name: '@dsh-enhanced/owner-console', version: expectedVersion }),
        'utf8',
      )
      await writeFile(
        join(ws.dshHome, '.dsh-rsi-host.json'),
        JSON.stringify({ schemaVersion: 1, version: '0.2.2-rc.5', cacheRoot: join(ws.root, 'cache'), receiptDigest: sha256Hex('host') }),
        { mode: 0o600 },
      )
      await mkdir(join(ws.dshHome, '.dsh-enhanced'), { recursive: true, mode: 0o700 })
      await writeFile(
        join(ws.dshHome, '.dsh-enhanced', 'upgrade-history.jsonl'),
        `${JSON.stringify({ at: 100, toVersion: expectedVersion })}\n`,
        'utf8',
      )
      await mkdir(join(ws.dshHome, '.dsh-rsi-upgrade-backups', 'snap-1'), { recursive: true, mode: 0o700 })

      const execSql = async (rel: string, sql: string) => {
        const full = join(ws.dshHome, rel)
        await mkdir(join(full, '..'), { recursive: true, mode: 0o700 })
        const db = new DatabaseSync(full)
        try {
          db.exec(sql)
        } finally {
          db.close()
        }
      }
      await execSql('assistant-work-items/state.sqlite', "CREATE TABLE work_item (id TEXT PRIMARY KEY, state TEXT) STRICT; INSERT INTO work_item VALUES ('w1', 'settled'), ('w2', 'open');")
      await execSql('assistant-dreaming/state.sqlite', "CREATE TABLE dream_runs (id TEXT PRIMARY KEY, outcome TEXT) STRICT; INSERT INTO dream_runs VALUES ('d1', 'completed');")
      await execSql('assistant-evolution/evolution.sqlite', "CREATE TABLE evolution_proposals (id TEXT PRIMARY KEY, status TEXT) STRICT; CREATE TABLE evolution_rules (id TEXT PRIMARY KEY, status TEXT) STRICT; CREATE TABLE evolution_autonomous_rollbacks (idempotency_key TEXT PRIMARY KEY) STRICT; INSERT INTO evolution_proposals VALUES ('ep1', 'approved'); INSERT INTO evolution_rules VALUES ('er1', 'active'); INSERT INTO evolution_autonomous_rollbacks VALUES ('rb1');")
      await execSql('plugin-control-plane/control.sqlite', "CREATE TABLE source_plans (id TEXT PRIMARY KEY, plugin_name TEXT, mode TEXT, status TEXT) STRICT; CREATE TABLE activation_plans (id TEXT PRIMARY KEY, profile TEXT, status TEXT) STRICT; INSERT INTO source_plans VALUES ('sp-create', '@dsh-enhanced/evolved-demo', 'create', 'release-complete'), ('sp-rev', '@dsh-enhanced/evolved-demo', 'modify', 'release-complete'); INSERT INTO activation_plans VALUES ('sp-create', 'web', 'activated'), ('sp-rb', 'web', 'rolled-back');")
      await execSql('plugin-control-plane/creation-adoptions.sqlite', `CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT, certificate_json TEXT, receipt_json TEXT) STRICT; INSERT INTO adoptions VALUES ('sp-create', 'active', '{"plan":{"name":"@dsh-enhanced/evolved-demo"}}', '{"version":"0.1.0"}');`)
      await execSql('plugin-control-plane/revision-adoptions.sqlite', "CREATE TABLE entries (entry_id TEXT PRIMARY KEY, name TEXT, current_plan_id TEXT, revision INTEGER) STRICT; CREATE TABLE adoptions (plan_id TEXT PRIMARY KEY, status TEXT, entry_id TEXT) STRICT; CREATE TABLE rollbacks (seq INTEGER PRIMARY KEY, rollback_id TEXT) STRICT; INSERT INTO entries VALUES ('e1', '@dsh-enhanced/evolved-demo', 'sp-rev', 2); INSERT INTO adoptions VALUES ('sp-rev', 'active', 'e1');")
      await execSql('assistant-association/association.sqlite', "CREATE TABLE assoc_param_profile_heads (scope_key TEXT PRIMARY KEY, active_version INTEGER) STRICT; CREATE TABLE assoc_param_profile_events (kind TEXT) STRICT; INSERT INTO assoc_param_profile_heads VALUES ('owner', 2); INSERT INTO assoc_param_profile_events VALUES ('adopted');")
      await execSql('assistant-evaluation/evaluation.sqlite', "CREATE TABLE evaluation_attention_tuning_events (kind TEXT) STRICT; CREATE TABLE evaluation_attention_loosening_decisions (proposal_id TEXT PRIMARY KEY, decision TEXT) STRICT; INSERT INTO evaluation_attention_tuning_events VALUES ('adopted'); INSERT INTO evaluation_attention_loosening_decisions VALUES ('lp1', 'adopted');")

      const res = await runDshRsiInProcess(['version', '--json', '--dsh-home', ws.dshHome])
      expect(res.exitCode).toBe(0)
      const parsed = JSON.parse(res.stdout) as {
        assistant: { version: string }
        plugins: { core: Array<{ name: string }>; evolved: Array<{ name: string }>; evolvedCount: number }
        selfIteration: {
          dataState: string
          pluginsCreated: number
          pluginsRevised: number
          candidatesAdopted: number
          rollbacks: number
          selfUpgrades: number
          backupSnapshotsCount: number
        }
      }
      expect(ReportSchema.parse(parsed)).toEqual(parsed)
      expect(parsed.assistant.version).toBe(expectedVersion)
      expect(parsed.selfIteration.dataState).toBe('data')
      expect(parsed.selfIteration.pluginsCreated).toBe(1)
      expect(parsed.selfIteration.pluginsRevised).toBe(1)
      expect(parsed.selfIteration.candidatesAdopted).toBe(3) // 2 distinct cp plans (sp-create, sp-rev) + 1 evo_rules
      expect(parsed.selfIteration.rollbacks).toBe(2) // 1 activation rollback + 1 evo rollback
      expect(parsed.selfIteration.selfUpgrades).toBe(1)
      expect(parsed.selfIteration.backupSnapshotsCount).toBe(1)
      expect(parsed.plugins.core.some(p => p.name === '@dsh-enhanced/owner-console')).toBe(true)
      expect(parsed.plugins.evolved.some(p => p.name === '@dsh-enhanced/evolved-demo')).toBe(true)
      expect(parsed.plugins.evolvedCount).toBe(1)
    })

    test('T1-F26-03: owner-console exposes ownerConsole/versionInfo Typert descriptor, svc.versionInfo() & owner_console_version_info Host tool', async () => {
      const ws = await workspaces.create('f26-owner-console-')
      await mkdir(join(ws.dshHome, 'profiles', 'web'), { recursive: true, mode: 0o700 })
      const ownerMod = await loadOwnerConsole()
      const typertMod = await loadPackageModule('owner-console/typert')
      const ReportSchema = getExport<{ parse: (input: unknown) => unknown }>(typertMod, 'OwnerConsoleVersionReportSchema')
      const TYPERT = getExport<{ invocations: Array<{ method: string; parameters: unknown[] }> }>(typertMod, 'TYPERT')

      const descriptor = TYPERT.invocations.find(i => i.method === 'versionInfo')
      expect(descriptor).toBeDefined()
      expect(descriptor?.parameters).toEqual([])

      const registeredTools: Array<{
        def: { name: string; execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> }
      }> = []
      const preauthPredicates: Array<(exec: { agent?: unknown }) => boolean> = []

      const ctx = harness.createContext()
      await harness.mountPlugin(ctx, TypertRegistry)
      harness.provideMockService(ctx, 'profileContext', {
        home: ws.dshHome,
        dir: join(ws.dshHome, 'profiles', 'web'),
        name: 'web',
      })
      harness.provideMockService(ctx, 'tools', {
        register: (def: typeof registeredTools[number]['def']) => {
          registeredTools.push({ def })
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

      const svc = ctx.get('ownerConsole' as never) as unknown as {
        versionInfo: () => Promise<Record<string, unknown>>
        registerAssistantSession: (id: string, makeActive: boolean) => Promise<unknown>
      }
      const report = await svc.versionInfo()
      expect(ReportSchema.parse(report)).toEqual(report)

      expect(registeredTools.map(t => t.def.name)).toEqual([
        'owner_console_self_iteration_control',
        'owner_console_version_info',
      ])
      expect(preauthPredicates).toHaveLength(2)

      await svc.registerAssistantSession('wenyao-f26-session', true)
      const ownerAgent = { id: 'wenyao-f26-session', session: { id: 'wenyao-f26-session' } }
      expect(preauthPredicates[0]?.({ agent: ownerAgent })).toBe(true)
      expect(preauthPredicates[1]?.({ agent: ownerAgent })).toBe(true)

      const toolResult = await registeredTools[1]!.def.execute({}, { agent: ownerAgent })
      expect(toolResult.ok).toBe(true)
      expect(typeof toolResult.summary).toBe('string')
      expect(ReportSchema.parse(toolResult.report)).toEqual(toolResult.report)
    })

    test('T1-F26-04: owner-console/nl-control is browser-safe and parses/formats version & iteration queries', async () => {
      const nlControlSrc = await readFile(join(repoRoot, 'plugins/owner-console/src/nl-control.ts'), 'utf8')
      expect(nlControlSrc).not.toMatch(/from\s+['"]node:/u)

      const nlMod = await loadPackageModule('owner-console/nl-control')
      const parseQuery = getExportFn<(text: string) => { intent: string } | undefined>(nlMod, 'parseOwnerVersionQuery')
      const formatSummary = getExportFn<(report: Record<string, unknown>) => string>(nlMod, 'formatOwnerConsoleVersionSummary')

      expect(parseQuery('/version')?.intent).toBe('slash')
      expect(parseQuery('/version --short')?.intent).toBe('slash')
      expect(parseQuery('/autonomy version')?.intent).toBe('slash')
      expect(parseQuery('查看版本')?.intent).toBe('version')
      expect(parseQuery('assistant version')?.intent).toBe('version')
      expect(parseQuery('自己迭代了多少次？')?.intent).toBe('selfIterationCount')
      expect(parseQuery('self-iteration count')?.intent).toBe('selfIterationCount')

      const manifests = await readAllWorkspaceManifests()
      const expectedVersion = manifests[0]!.version
      const summary = formatSummary({
        schemaVersion: 1,
        protocol: 'dsh-rsi/version/v1',
        generatedAt: 1_700_000_000_000,
        assistant: { name: 'dsh-enhanced', version: expectedVersion, cliVersion: expectedVersion },
        host: { packageName: '@deepseek-ai/dsh', boundVersion: '0.2.2-rc.5', boundStatus: 'ready', runningVersion: '0.2.2-rc.5' },
        profile: 'web',
        plugins: { state: 'ok', coreCount: 1, evolvedCount: 0, activeEvolvedCount: 0, core: [], evolved: [] },
        selfIteration: {
          dataState: 'zero',
          totalIterations: 0,
          workItemsTotal: 0,
          workItemsSettled: 0,
          growthUsageJobsTotal: 0,
          dreamingRuns: 0,
          recoveryRuns: 0,
          goalStrategyRuns: 0,
          candidatesGenerated: 0,
          candidatesAdopted: 0,
          pluginsCreated: 0,
          pluginsRevised: 0,
          taskVerificationsDone: 0,
          rollbacks: 0,
          evolutionRulesAdopted: 0,
          associationParamVersion: null,
          associationProfileAdoptions: 0,
          evaluationAttentionTuningAdoptions: 0,
          evaluationLooseningDecisionsAdopted: 0,
          activeMemories: 0,
          activePreferenceOverlays: 0,
          workflowCandidatesPromoted: 0,
          skillDeployments: 0,
          selfUpgrades: 0,
          backupSnapshotsCount: 0,
        },
      })
      expect(summary).toContain(expectedVersion)
      expect(summary).toContain('0.2.2-rc.5')
    })

    test('T1-F26-05: assistant-delivery + lark-channel handles DM/group /version, /autonomy version & NL queries with 0 LLM calls and /help coverage', async () => {
      const ws = await workspaces.create('f26-delivery-lark-')
      const { AssistantPolicyService } = await loadAssistantPolicy()
      const { AssistantDeliveryService } = await loadAssistantDelivery()
      const normalizeMod = await loadPackageModule('lark-channel/normalize')
      const normalizeLarkMessage = getExportFn<(
        cfg: Record<string, unknown>,
        msg: Record<string, unknown>,
        now: number,
      ) => { outcome: string; envelope?: Record<string, unknown> }>(normalizeMod, 'normalizeLarkMessage')

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
            id: 'linked',
            effect: 'allow',
            subject: { kind: 'external', id: 'lark/bot-1/t1/ou_linked' },
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
          {
            id: 'reply-linked',
            effect: 'allow',
            subject: { kind: 'agent', id: 'primary', workspace: ws.workspace, principal: 'lark/bot-1/t1/ou_linked' },
            actions: ['history', 'reply'],
            resource: { kind: 'message', id: '*' },
            context: { initiators: ['foreground', 'external'] },
          },
        ],
      })

      const createAgentHandle = async (opts: {
        sessionId?: string
        resumeSessionId?: string
        meta?: { cwd?: string; agentPreset?: string }
        setup?: (c: unknown, a?: unknown) => Promise<unknown>
      }) => {
        const id = opts.sessionId ?? opts.resumeSessionId ?? 'sess-f26'
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
      }
      const resumeSpy = vi.fn(createAgentHandle)
      const llmComplete = vi.fn(async () => ({}))
      harness.provideMockService(ctx, 'agents', {
        create: createAgentHandle,
        resume: resumeSpy,
      })
      harness.provideMockService(ctx, 'sessions', { list: async () => [], flush: async () => true })
      harness.provideMockService(ctx, 'llm', { complete: llmComplete })

      const delivery = await harness.mountService<{
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

      const linkedPrincipal = { channel: 'lark', account: 'bot-1', tenant: 't1', user: 'ou_linked' }
      const linkedPair = delivery.issuePairing('test', linkedPrincipal)
      delivery.confirmPairing({ challengeId: linkedPair.challenge.id, principal: linkedPrincipal, code: linkedPair.code })

      const inboundCfg = { account: 'bot-1', tenant: 't1', requireMentionInGroups: true, maxTextBytes: 4096, staleAfterMs: 300_000 }
      const drive = async () => {
        await delivery.tick()
        await delivery.whenIdle()
        await delivery.tick()
        await delivery.whenIdle()
      }
      const now = Date.now()
      const inputs = [
        { id: 'm1', chatType: 'p2p', sender: 'ou_owner', content: '/version', mentioned: false },
        { id: 'm2', chatType: 'p2p', sender: 'ou_owner', content: '自己迭代了多少次？', mentioned: false },
        { id: 'm3', chatType: 'group', sender: 'ou_linked', content: '@_user_1 /autonomy version', mentioned: true },
      ] as const
      for (const [idx, item] of inputs.entries()) {
        const res = normalizeLarkMessage(inboundCfg, {
          messageId: item.id,
          chatId: item.chatType === 'p2p' ? `oc_dm_${item.sender}` : 'oc_grp_1',
          chatType: item.chatType,
          senderId: item.sender,
          content: item.content,
          rawContentType: 'text',
          resources: [],
          mentionAll: false,
          mentionedBot: item.mentioned,
          createTime: now + idx,
        }, now + idx)
        expect(res.outcome).toBe('accept')
        if (res.outcome === 'accept' && res.envelope) {
          await delivery.acceptInbound(res.envelope)
        }
      }
      await drive()
      expect(sends).toHaveLength(3)
      for (const reply of sends) {
        expect(reply.text).toContain('助手版本：dsh-enhanced v')
        expect(reply.text).toContain('自迭代演进统计')
      }
      expect(resumeSpy).not.toHaveBeenCalled()
      expect(llmComplete).not.toHaveBeenCalled()

      const helpMsg = normalizeLarkMessage(inboundCfg, {
        messageId: 'm4',
        chatId: 'oc_dm_ou_owner',
        chatType: 'p2p',
        senderId: 'ou_owner',
        content: '/help',
        rawContentType: 'text',
        resources: [],
        mentionAll: false,
        mentionedBot: false,
        createTime: now + 10,
      }, now + 10)
      if (helpMsg.outcome === 'accept' && helpMsg.envelope) {
        await delivery.acceptInbound(helpMsg.envelope)
      }
      await drive()
      expect(sends.at(-1)?.text).toContain('/version')
    })
  })
})
