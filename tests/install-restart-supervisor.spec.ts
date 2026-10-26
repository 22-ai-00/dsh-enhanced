import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installRestartSupervisorPlan, planRestartSupervisorInstall } from '../scripts/install/restart-supervisor.mjs'

const sha = (source: string) => createHash('sha256').update(source).digest('hex')
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-restart-install-'))
  roots.push(root)
  const userHome = join(root, 'user'), home = join(root, 'dsh-home')
  await mkdir(userHome)
  const cohort = join(home, 'rsi-local-cohorts', 'assistant')
  const packageRoot = join(home, 'packages', 'assistant-delivery')
  const policyRoot = join(home, 'packages', 'assistant-policy')
  const wikiRoot = join(home, 'packages', 'personal-wiki')
  const packageLinkDir = join(home, 'profiles', 'assistant', 'node_modules', '@dsh-enhanced')
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
  const wikiManifest = JSON.stringify({ name: '@dsh-enhanced/personal-wiki', version: '0.1.62' })
  await writeFile(join(wikiRoot, 'lib', 'index.js'), wikiSource)
  await writeFile(join(wikiRoot, 'package.json'), wikiManifest)
  const deliveryManifest = JSON.stringify({ name: '@dsh-enhanced/assistant-delivery', version: '0.1.62' })
  const policyManifest = JSON.stringify({ name: '@dsh-enhanced/assistant-policy', version: '0.1.62', type: 'module' })
  await writeFile(join(packageRoot, 'package.json'), deliveryManifest)
  await writeFile(join(policyRoot, 'package.json'), policyManifest)
  await symlink(packageRoot, join(packageLinkDir, 'assistant-delivery'))
  await symlink(policyRoot, join(packageLinkDir, 'assistant-policy'))
  await symlink(wikiRoot, join(packageLinkDir, 'personal-wiki'))
  const sourceCommit = 'a'.repeat(40)
  await writeFile(join(cohort, 'receipt.json'), JSON.stringify({ root: cohort, sourceCommit,
    version: '0.1.62', packages: [{ name: '@dsh-enhanced/assistant-delivery', path: 'plugins/assistant-delivery',
      files: [...files.map(([path, source]) => ({ path, sha256: sha(source) })),
        { path: 'package.json', sha256: sha(deliveryManifest) }] },
    { name: '@dsh-enhanced/assistant-policy', path: 'plugins/assistant-policy',
      files: [...policyFiles.map(([path, source]) => ({ path, sha256: sha(source) })),
        { path: 'package.json', sha256: sha(policyManifest) }] },
    { name: '@dsh-enhanced/personal-wiki', path: 'plugins/personal-wiki', files: [
      { path: 'lib/index.js', sha256: sha(wikiSource) },
      { path: 'package.json', sha256: sha(wikiManifest) },
    ] }] }), { mode: 0o600 })
  await writeFile(join(home, 'profiles', 'assistant', 'cordis.patch.yml'),
    `- id: dsh-enhanced-personal-assistant\n  config:\n    assistantAutomations:\n      databasePath: !!js dshHomePath('assistant-automations/state.sqlite')\n    assistantPolicy:\n      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')\n      rules:\n        - id: exact-restart\n          effect: allow\n          actions: [maintenance.restart]\n- id: dsh-enhanced-assistant-delivery\n  config:\n    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')\n    ownerRoutes:\n      - id: owner-route-1\n    restart:\n      databasePath: ${join(home, 'assistant-delivery', 'restart.sqlite')}\n      ownerRouteId: owner-route-1\n`)
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
  await writeFile(join(home, '.dsh-rsi-host.json'), hostBinding, { mode: 0o600 })
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
    await writeFile(`${sample.home}.dsh-enhanced-transaction`, 'active')
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
      .rejects.toThrow('installed helper is not frozen by cohort: @dsh-enhanced/personal-wiki/lib/index.js')
    const host = await fixture()
    await writeFile(join(host.hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      'export const changed = true\n')
    await expect(planRestartSupervisorInstall(host.input,
      { userHome: host.userHome, showUnit: host.showUnit }))
      .rejects.toThrow('Host code differs from installed receipt')
  })
})
