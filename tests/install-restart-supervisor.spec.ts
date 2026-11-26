import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { installRestartSupervisorPlan, planRestartSupervisorInstall } from '../scripts/install/restart-supervisor.mjs'
import { KNOWN_ENHANCED_PACKAGES, runUpgrade } from '../packages/dsh-ray/src/upgrade.ts'
import { inspectRestartPolicyAndCode, validateRestartSupervisorConfig, type RestartSupervisorConfig } from '../plugins/assistant-delivery/src/restart-supervisor.ts'

const sha = (source: string | Uint8Array) => createHash('sha256').update(source).digest('hex')
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-restart-install-')))
  roots.push(root)
  const userHome = join(root, 'user'), home = join(root, 'dsh-home')
  await mkdir(userHome)
  const cohort = join(home, 'rsi-local-cohorts', 'assistant')
  const packageRoot = join(home, 'packages', 'assistant-delivery')
  const policyRoot = join(home, 'packages', 'assistant-policy')
  const wikiRoot = join(home, 'packages', 'personal-wiki')
  const packageLinkDir = join(home, 'profiles', 'assistant', 'node_modules', '@dsh-ray')
  await Promise.all([mkdir(cohort, { recursive: true }), mkdir(join(packageRoot, 'bin'), { recursive: true }),
    mkdir(join(packageRoot, 'lib'), { recursive: true }), mkdir(join(policyRoot, 'lib'), { recursive: true }),
    mkdir(join(wikiRoot, 'lib'), { recursive: true }),
    mkdir(packageLinkDir, { recursive: true })])
  const files = [
    ['bin/dsh-restart-supervisor.js', '#!/usr/bin/env node\n'],
    ['lib/restart-store.js', 'export const store = 1\n'],
    ['lib/restart-supervisor.js', 'export const supervisor = 1\n'],
  ] as const
  for (const [name, source] of files) await writeFile(join(packageRoot, name), source)
  const policyFiles = [
    ['lib/evaluator.js', 'export const compilePolicy = x => x; export const evaluatePolicy = () => ({effect:"allow"})\n'],
    ['lib/service.js', 'export const policy = 1\n'],
  ] as const
  for (const [name, source] of policyFiles) await writeFile(join(policyRoot, name), source)
  const wikiSource = 'export const wiki = 1\n'
  const wikiManifest = JSON.stringify({ name: '@dsh-ray/personal-wiki', version: '0.1.62' })
  await writeFile(join(wikiRoot, 'lib', 'index.js'), wikiSource)
  await writeFile(join(wikiRoot, 'package.json'), wikiManifest)
  const deliveryManifest = JSON.stringify({ name: '@dsh-ray/assistant-delivery', version: '0.1.62' })
  const policyManifest = JSON.stringify({ name: '@dsh-ray/assistant-policy', version: '0.1.62', type: 'module' })
  await writeFile(join(packageRoot, 'package.json'), deliveryManifest)
  await writeFile(join(policyRoot, 'package.json'), policyManifest)
  await symlink(packageRoot, join(packageLinkDir, 'assistant-delivery'))
  await symlink(policyRoot, join(packageLinkDir, 'assistant-policy'))
  await symlink(wikiRoot, join(packageLinkDir, 'personal-wiki'))
  const sourceCommit = 'a'.repeat(40)
  await writeFile(join(cohort, 'receipt.json'), JSON.stringify({ root: cohort, sourceCommit,
    version: '0.1.62', packages: [{ name: '@dsh-ray/assistant-delivery', path: 'plugins/assistant-delivery',
      files: [...files.map(([path, source]) => ({ path, sha256: sha(source) })),
        { path: 'package.json', sha256: sha(deliveryManifest) }] },
    { name: '@dsh-ray/assistant-policy', path: 'plugins/assistant-policy',
      files: [...policyFiles.map(([path, source]) => ({ path, sha256: sha(source) })),
        { path: 'package.json', sha256: sha(policyManifest) }] },
    { name: '@dsh-ray/personal-wiki', path: 'plugins/personal-wiki', files: [
      { path: 'lib/index.js', sha256: sha(wikiSource) },
      { path: 'package.json', sha256: sha(wikiManifest) },
    ] }] }), { mode: 0o600 })
  await writeFile(join(home, 'profiles', 'assistant', 'cordis.patch.yml'),
    `- id: dsh-ray-personal-assistant\n  config:\n    assistantAutomations:\n      databasePath: !!js dshHomePath('assistant-automations/state.sqlite')\n    assistantPolicy:\n      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')\n      rules:\n        - id: exact-restart\n          effect: allow\n          actions: [maintenance.restart]\n- id: dsh-ray-assistant-delivery\n  config:\n    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')\n    ownerRoutes:\n      - id: owner-route-1\n    restart:\n      databasePath: ${join(home, 'assistant-delivery', 'restart.sqlite')}\n      ownerRouteId: owner-route-1\n`)
  const hostRoot = join(userHome, 'hosts', '0.2.1-rc.2')
  const hostBin = join(hostRoot, 'node_modules', '.bin')
  const hostPackage = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh')
  await Promise.all([mkdir(hostBin, { recursive: true }), mkdir(join(hostPackage, 'lib'), { recursive: true })])
  const hostJs = '#!/usr/bin/env node\n'
  const hostManifest = JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' })
  await writeFile(join(hostPackage, 'lib', 'bin.js'), hostJs)
  await writeFile(join(hostPackage, 'package.json'), hostManifest)
  await symlink('../@deepseek-ai/dsh/lib/bin.js', join(hostBin, 'dsh'))
  const hostReceipt = JSON.stringify({ schemaVersion: 1, version: '0.2.1-rc.2', entries: [
    { path: 'node_modules/.bin/dsh', type: 'link', mode: 0o777, target: '../@deepseek-ai/dsh/lib/bin.js' },
    { path: 'node_modules/@deepseek-ai/dsh/lib/bin.js', type: 'file', mode: 0o644, sha256: sha(hostJs) },
    { path: 'node_modules/@deepseek-ai/dsh/package.json', type: 'file', mode: 0o644, sha256: sha(hostManifest) },
  ] })
  await writeFile(join(hostRoot, 'receipt.json'), hostReceipt)
  const hostBinding = JSON.stringify({ schemaVersion: 1, cacheRoot: join(userHome, 'hosts'),
    version: '0.2.1-rc.2', receiptDigest: sha(hostReceipt) })
  await writeFile(join(home, '.dsh-ray-host.json'), hostBinding, { mode: 0o600 })
  const fragment = join(root, 'dsh-profile-assistant.service')
  await writeFile(fragment, `[Unit]\nStartLimitIntervalSec=600\nStartLimitBurst=3\n\n[Service]\nWorkingDirectory=${join(home, 'profiles', 'assistant')}\n`
    + `Environment="DSH_HOME=${home}"\nExecStart=/usr/bin/node "${join(hostBin, 'dsh')}" --profile assistant --no-open\n`)
  const nodePath = await realpath(process.execPath)
  const input = { dshHome: home, profile: 'assistant', sourceCommit,
    databasePath: join(home, 'assistant-delivery', 'restart.sqlite'),
    deliveryDatabasePath: join(home, 'assistant-delivery', 'state.sqlite'),
    policyDatabasePath: join(home, 'assistant-policy', 'policy.sqlite'), nodePath }
  const showUnit = (unit: string) => `Id=${unit}\nLoadState=loaded\nActiveState=active\nSubState=running\nFragmentPath=${fragment}\nDropInPaths=\n`
  return { root, userHome, home, packageRoot, fragment, input, showUnit, hostBinding, hostReceipt, hostRoot }
}

describe('external restart supervisor installer', () => {
  it('rejects a symlink alias for an otherwise valid Home', async () => {
    const sample = await fixture()
    const alias = join(sample.root, 'dsh-home-alias')
    await symlink(sample.home, alias)
    await expect(planRestartSupervisorInstall({ ...sample.input, dshHome: alias },
      { userHome: sample.userHome, showUnit: sample.showUnit }))
      .rejects.toThrow('Home must be canonical')
  })

  it('pins the frozen cohort helper and generates an external one-shot timer', async () => {
    const sample = await fixture()
    const plan = await planRestartSupervisorInstall(sample.input,
      { userHome: sample.userHome, showUnit: sample.showUnit })
    expect(plan.helper).toBe(join(sample.packageRoot, 'bin', 'dsh-restart-supervisor.js'))
    expect(plan.configPath.startsWith(sample.home)).toBe(false)
    expect(plan.serviceSource).toContain(`ExecStart=${sample.input.nodePath} --disable-warning=ExperimentalWarning ${plan.helper} --config ${plan.configPath} --once`)
    expect(plan.serviceSource).toContain('UnsetEnvironment=DSH_HOME')
    expect(plan.serviceSource).not.toContain(`WorkingDirectory=${sample.home}`)
    expect(plan.timerSource).toContain(`Unit=${plan.serviceName}`)
    expect(JSON.parse(plan.configSource).trustedFiles).toEqual(expect.arrayContaining([
      { path: join(sample.home, 'packages', 'personal-wiki', 'lib', 'index.js'),
        digest: sha('export const wiki = 1\n') },
    ]))
    expect(JSON.parse(plan.configSource)).toEqual({ dshHome: sample.home, profile: 'assistant',
      databasePath: sample.input.databasePath, deliveryDatabasePath: sample.input.deliveryDatabasePath,
      policyDatabasePath: sample.input.policyDatabasePath,
      automationDatabasePath: join(sample.home, 'assistant-automations', 'state.sqlite'),
      policyEvaluatorPath: join(sample.home, 'packages', 'assistant-policy', 'lib', 'evaluator.js'),
      profilePatchDigest: sha(await readFile(join(sample.home, 'profiles', 'assistant', 'cordis.patch.yml'))),
      cohortReceiptDigest: sha(await readFile(join(sample.home, 'rsi-local-cohorts', 'assistant', 'receipt.json'))),
      sourceCommit: sample.input.sourceCommit,
      restartOwnerRouteId: 'owner-route-1',
      hostBindingDigest: sha(sample.hostBinding),
      hostReceiptPath: join(sample.hostRoot, 'receipt.json'),
      hostReceiptSourceDigest: sha(sample.hostReceipt),
      trustedFiles: expect.any(Array), policyRules: expect.any(Array),
      unit: 'dsh-profile-assistant.service', expectedUnitDigest: sha(await readFile(sample.fragment)),
      readyTimeoutMs: 120_000, stableWindowMs: 12_000, maxRestarts: 3, windowMs: 600_000 })
    const calls: string[][] = []
    await installRestartSupervisorPlan(plan, { systemctl: (...args: string[]) => { calls.push(args) } })
    expect(calls).toEqual([['daemon-reload'], ['enable', '--now', plan.timerName]])
    expect((await stat(plan.configPath)).mode & 0o777).toBe(0o600)
    expect((await stat(plan.stateDir)).mode & 0o777).toBe(0o700)
    expect(await readFile(plan.servicePath, 'utf8')).toBe(plan.serviceSource)
  })

  it('suppresses SQLite experimental warnings without hiding ordinary warnings or errors', () => {
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e',
      "require('node:sqlite'); process.emitWarning('ordinary-warning-marker'); setImmediate(() => { throw new Error('real-error-marker') })"],
    { encoding: 'utf8', timeout: 10_000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).not.toContain('ExperimentalWarning')
    expect(result.stderr).toContain('ordinary-warning-marker')
    expect(result.stderr).toContain('real-error-marker')
  })

  it('updates an installed supervisor without changing or restarting the Host', async () => {
    const sample = await fixture()
    const plan = await planRestartSupervisorInstall(sample.input,
      { userHome: sample.userHome, showUnit: sample.showUnit })
    const hostSource = await readFile(sample.fragment, 'utf8')
    await installRestartSupervisorPlan({ ...plan,
      serviceSource: plan.serviceSource.replace(' --disable-warning=ExperimentalWarning', ''),
    }, { systemctl: () => {} })
    expect(await readFile(plan.servicePath, 'utf8')).not.toContain('--disable-warning')
    const calls: string[][] = []
    await installRestartSupervisorPlan(plan, { systemctl: (...args: string[]) => { calls.push(args) } })
    expect(calls).toEqual([['daemon-reload'], ['enable', '--now', plan.timerName]])
    expect(await readFile(plan.servicePath, 'utf8')).toBe(plan.serviceSource)
    expect(await readFile(plan.timerPath, 'utf8')).toBe(plan.timerSource)
    expect((await stat(plan.configPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(sample.fragment, 'utf8')).toBe(hostSource)
  })

  it('rejects cohort drift, missing frozen helper, and Home upgrade transaction', async () => {
    const sample = await fixture()
    const deps = { userHome: sample.userHome, showUnit: sample.showUnit }
    await expect(planRestartSupervisorInstall({ ...sample.input, sourceCommit: 'b'.repeat(40) }, deps))
      .rejects.toThrow('cohort receipt does not match expected source')
    await writeFile(join(sample.packageRoot, 'lib', 'restart-supervisor.js'), 'drift')
    await expect(planRestartSupervisorInstall(sample.input, deps)).rejects.toThrow('installed helper is not frozen')
    await writeFile(`${sample.home}.dsh-ray-transaction`, 'active')
    await expect(planRestartSupervisorInstall(sample.input, deps)).rejects.toThrow('Home upgrade transaction exists')
  })

  it('refuses a profile without an exact managed Delivery restart route', async () => {
    const sample = await fixture()
    const patchPath = join(sample.home, 'profiles', 'assistant', 'cordis.patch.yml')
    const patch = await readFile(patchPath, 'utf8')
    await writeFile(patchPath, patch.replace(/    restart:\n      databasePath: .*\n      ownerRouteId: owner-route-1\n/u, ''))
    await expect(planRestartSupervisorInstall(sample.input,
      { userHome: sample.userHome, showUnit: sample.showUnit }))
      .rejects.toThrow('Delivery restart database or owner route is not frozen by profile')
  })

  it('rejects code drift in another cohort plugin and the external Host', async () => {
    const wiki = await fixture()
    await writeFile(join(wiki.home, 'packages', 'personal-wiki', 'lib', 'index.js'), 'export const wiki = 2\n')
    await expect(planRestartSupervisorInstall(wiki.input,
      { userHome: wiki.userHome, showUnit: wiki.showUnit }))
      .rejects.toThrow('installed helper is not frozen by cohort: @dsh-ray/personal-wiki/lib/index.js')
    const host = await fixture()
    await writeFile(join(host.hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      'export const changed = true\n')
    await expect(planRestartSupervisorInstall(host.input,
      { userHome: host.userHome, showUnit: host.showUnit }))
      .rejects.toThrow('Host code differs from installed receipt')
  })

  it('F28: KNOWN_ENHANCED_PACKAGES matches workspace non-CLI packages & release-manifest.json and runUpgrade produces config verified by validateRestartSupervisorConfig & inspectRestartPolicyAndCode', async () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const workspaceNonCli: string[] = []
    for (const parent of ['plugins', 'packages']) {
      for (const entry of await readdir(join(repoRoot, parent), { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const manifestText = await readFile(join(repoRoot, parent, entry.name, 'package.json'), 'utf8')
        const pkg = JSON.parse(manifestText) as { name?: string }
        if (pkg.name && pkg.name !== 'dsh-ray') workspaceNonCli.push(pkg.name)
      }
    }
    expect([...KNOWN_ENHANCED_PACKAGES].sort()).toEqual(workspaceNonCli.sort())

    const manifest = JSON.parse(await readFile(join(repoRoot, 'release-manifest.json'), 'utf8')) as {
      current: { packages: Record<string, string> }
    }
    if ('dsh-ray' in manifest.current.packages) {
      const expectedNonCli = Object.keys(manifest.current.packages)
        .filter(name => name !== 'dsh-ray')
        .sort()
      expect([...KNOWN_ENHANCED_PACKAGES].sort()).toEqual(expectedNonCli)
    } else {
      // Pre-first-dsh-ray-release historical 0.1.88 ledger: verify package-slug parity without touching release-manifest.json.
      const manifestSlugs = Object.keys(manifest.current.packages)
        .map(name => (name === 'dsh-ray' || name.endsWith('-cli') ? 'dsh-ray' : name.slice(name.indexOf('/') + 1)))
        .sort()
      const knownSlugs = ['dsh-ray', ...KNOWN_ENHANCED_PACKAGES.map(name => name.slice(name.indexOf('/') + 1))].sort()
      expect(knownSlugs).toEqual(manifestSlugs)
    }

    const sample = await fixture()
    // Seed profile package.json + coordinator marker + .pnpm layout with 0.1.82 and upgrade to 0.1.85
    const coordProfile = 'rsi-assistant-0123456789ab'
    const coordMarker = join(sample.home, `.rsi-coordinator-${sha('assistant').slice(0, 16)}.json`)
    await writeFile(coordMarker, JSON.stringify({
      schemaVersion: 1,
      targetProfile: 'assistant',
      coordinatorProfile: coordProfile,
      version: '0.1.62',
      sourceRepository: join(sample.root, 'repo-deleted'),
    }), { mode: 0o600 })
    const coordDir = join(sample.home, 'profiles', coordProfile)
    await mkdir(coordDir, { recursive: true, mode: 0o700 })
    await writeFile(join(coordDir, 'package.json'), JSON.stringify({
      name: `dsh-profile-${coordProfile}`,
      private: true,
      dependencies: { '@dsh-ray/assistant-automations': '0.1.82', '@dsh-ray/plugin-control-plane': '0.1.82' },
    }), { mode: 0o644 })

    const profileDir = join(sample.home, 'profiles', 'assistant')
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-assistant',
      private: true,
      dependencies: { '@dsh-ray/assistant-delivery': '0.1.82', '@dsh-ray/personal-wiki': '0.1.82' },
    }), { mode: 0o600 })
    await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'nodeLinker: isolated\n', { mode: 0o600 })
    await writeFile(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', { mode: 0o600 })

    // Move fragment into user systemd dir as dsh-profile-assistant.service
    const systemdDir = join(sample.userHome, '.config', 'systemd', 'user')
    await mkdir(systemdDir, { recursive: true, mode: 0o700 })
    const unitPath = join(systemdDir, 'dsh-profile-assistant.service')
    await writeFile(unitPath, await readFile(sample.fragment, 'utf8'), { mode: 0o600 })

    // 1. Install restart supervisor originally against frozen 0.1.62 cohort
    const plan = await planRestartSupervisorInstall(sample.input, {
      userHome: sample.userHome,
      showUnit: (unit: string) => `Id=${unit}\nLoadState=loaded\nActiveState=active\nSubState=running\nFragmentPath=${unitPath}\nDropInPaths=\n`,
    })
    await installRestartSupervisorPlan(plan, { systemctl: () => {} })

    // 2. Simulate migrated npm profile at 0.1.82 (.pnpm virtual store, transitive assistant-policy)
    const mkStorePkg = async (ver: string, slug: string, files: Record<string, string>) => {
      const storePkg = join(profileDir, 'node_modules', '.pnpm', `@dsh-ray+${slug}@${ver}_cordis`, 'node_modules', '@dsh-ray', slug)
      await mkdir(join(storePkg, 'lib'), { recursive: true })
      await mkdir(join(storePkg, 'bin'), { recursive: true })
      await writeFile(join(storePkg, 'package.json'), JSON.stringify({ name: `@dsh-ray/${slug}`, version: ver }), { mode: 0o644 })
      for (const [rel, content] of Object.entries(files)) {
        await writeFile(join(storePkg, rel), content, { mode: 0o644 })
      }
      return storePkg
    }

    const delivery082 = await mkStorePkg('0.1.82', 'assistant-delivery', {
      'bin/dsh-restart-supervisor.js': '#!/usr/bin/env node\n',
      'lib/restart-store.js': 'export const store = 1\n',
      'lib/restart-supervisor.js': 'export const supervisor = 1\n',
    })
    await mkStorePkg('0.1.82', 'assistant-policy', {
      'lib/evaluator.js': 'export const compilePolicy = x => x; export const evaluatePolicy = () => ({ effect: "allow" })\n',
      'lib/service.js': 'export const policy = 1\n',
    })
    const wiki082 = await mkStorePkg('0.1.82', 'personal-wiki', {
      'lib/index.js': 'export const wiki = 1\n',
    })
    await rm(join(profileDir, 'node_modules', '@dsh-ray'), { recursive: true, force: true })
    await mkdir(join(profileDir, 'node_modules', '@dsh-ray'), { recursive: true })
    await symlink(delivery082, join(profileDir, 'node_modules', '@dsh-ray', 'assistant-delivery'))
    await symlink(wiki082, join(profileDir, 'node_modules', '@dsh-ray', 'personal-wiki'))

    const res = await runUpgrade({
      dshHome: sample.home,
      profile: 'assistant',
      action: 'apply',
      targetVersion: '0.1.85',
      confirmDshHomeStopped: true,
      platform: 'linux',
      osHome: sample.userHome,
    }, {
      fetch: (async () => new Response(JSON.stringify({ 'dist-tags': { latest: '0.1.85' } }), { status: 200 })) as typeof globalThis.fetch,
      inspectBoundHost: async () => ({ status: 'ready', bindingPath: join(sample.home, '.dsh-ray-host.json'), version: '0.2.1-rc.2', dshPath: '/bin/dsh', issues: [] }),
      runner: () => ({ status: 0, stdout: 'inactive\n', stderr: '' }),
      upgradeProfilePackages: async () => {
        const delivery085 = await mkStorePkg('0.1.85', 'assistant-delivery', {
          'bin/dsh-restart-supervisor.js': '#!/usr/bin/env node\n',
          'lib/restart-store.js': 'export const store = 2\n',
          'lib/restart-supervisor.js': 'export const supervisor = 2\n',
        })
        await mkStorePkg('0.1.85', 'assistant-policy', {
          'lib/evaluator.js': 'export const compilePolicy = x => x; export const evaluatePolicy = () => ({ effect: "allow" })\n',
          'lib/service.js': 'export const policy = 2\n',
        })
        const wiki085 = await mkStorePkg('0.1.85', 'personal-wiki', {
          'lib/index.js': 'export const wiki = 2\n',
        })
        await rm(join(profileDir, 'node_modules', '@dsh-ray'), { recursive: true, force: true })
        await mkdir(join(profileDir, 'node_modules', '@dsh-ray'), { recursive: true })
        await symlink(delivery085, join(profileDir, 'node_modules', '@dsh-ray', 'assistant-delivery'))
        await symlink(wiki085, join(profileDir, 'node_modules', '@dsh-ray', 'personal-wiki'))
      },
      verifyHealth: async () => ({ ok: true }),
    })
    expect(res.exitCode, res.report.execution?.error).toBe(0)

    const refreshedRaw = JSON.parse(await readFile(plan.configPath, 'utf8')) as RestartSupervisorConfig
    const validated = validateRestartSupervisorConfig(refreshedRaw)
    expect(validated.policyEvaluatorPath).toContain('@dsh-ray+assistant-policy@0.1.85_cordis')
    await mkdir(dirname(sample.input.policyDatabasePath), { recursive: true, mode: 0o700 })
    const policyDb = new DatabaseSync(sample.input.policyDatabasePath)
    try {
      policyDb.exec('CREATE TABLE IF NOT EXISTS emergency_state (singleton INTEGER PRIMARY KEY, enabled INTEGER NOT NULL); INSERT OR REPLACE INTO emergency_state (singleton, enabled) VALUES (1, 0);')
    } finally {
      policyDb.close()
    }
    const ok = await inspectRestartPolicyAndCode(validated, {
      id: 'task-1',
      updatedAt: 1,
      binding: {
        preset: 'assistant',
        workspace: join(sample.home, 'ws'),
        principal: { channel: 'lark', account: 'acc', tenant: 't', user: 'u' },
      },
    })
    expect(ok).toBe(true)
  })
})
