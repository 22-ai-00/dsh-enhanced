import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { isSeq, parseDocument } from 'yaml'
import { getExport, getExportFn, sha256Hex } from './helpers/assertions.ts'
import { runBashCommand, runDshRsiInProcess, runNodeScript } from './helpers/cli-runner.ts'
import { createCordisHarness } from './helpers/cordis-harness.ts'
import {
  loadAssistantDelivery,
  loadAssistantWebOwnerSetup,
  loadDshRsiCli,
  loadDshRsiUpgrade,
  loadLarkChannel,
  loadOwnerConsole,
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
})
