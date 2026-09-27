import { createHash } from 'node:crypto'
import { chmod, link, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { parse, stringify } from 'yaml'
import { readRsiCoordinatorReceipt, validateRsiCoordinatorPair } from '../scripts/install/lifecycle-config.mjs'

const targetProfile = 'owner'
const coordinatorProfile = 'rsi-owner-123456789abc'
const base = `- insert:
    - id: tool-web
      name: '@deepseek-ai/tool-web'
      disabled: !!js "!ctx.get('profileContext')"
    - id: agent-loop
      name: '@deepseek-ai/agent-loop'
`
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'lifecycle-rsi-pair-')))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'rsi-coordinators', coordinatorProfile)
  const scope = { ownerRouteId: 'owner-route', principalId: 'lark/account/tenant/owner', workspace: join(home, 'workspace'), preset: 'primary' }
  const target = [{ id: 'dsh-enhanced-plugin-control-plane', name: '@dsh-enhanced/plugin-control-plane', config: {
    catalogPath: join(home, 'catalog.json'), trustPath: join(home, 'trust.json'),
    sourceJobs: { ...scope, budgetId: 'source', budgetAmount: 1 },
    sourceAdoptions: { profile: targetProfile, handoff: { coordinatorId: 'adoption-coordinator' } },
  } }]
  const coordinator = [
    { id: 'tool-web', name: '@deepseek-ai/tool-web', config: {} },
    { id: 'agent-loop', name: '@deepseek-ai/agent-loop', config: { agents: [] } },
    { id: 'dsh-enhanced-assistant-policy', name: '@dsh-enhanced/assistant-policy', config: {
      databasePath: join(root, 'policy.sqlite'), budgets: [{ id: 'coordinator-budget', metric: 'automation-runs', limit: 3, periodMs: 60_000, scope: 'subject' }], rules: [],
    } },
    { id: 'dsh-enhanced-assistant-automations', name: '@dsh-enhanced/assistant-automations', config: {
      schedulerEnabled: true, allowUnbudgetedExecution: false, databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'),
    } },
    { id: 'dsh-enhanced-plugin-control-plane', name: '@dsh-enhanced/plugin-control-plane', config: {
      catalogPath: join(home, 'catalog.json'), trustPath: join(home, 'trust.json'), statePath: root,
      adoptionCoordinator: { coordinatorId: 'adoption-coordinator', scope, timeoutMs: 30_000, budgetId: 'coordinator-budget', budgetAmount: 1 },
    } },
  ]
  const options = { dshHome: home, targetProfile, coordinatorProfile, coordinatorBaseSource: base }
  return { home, target, coordinator, options }
}

function copy<T>(value: T): T { return structuredClone(value) }

describe('readRsiCoordinatorReceipt', () => {
  test('reads the installer schema without changing its bytes; missing receipt stays optional', async () => {
    const { home } = await fixture()
    expect(await readRsiCoordinatorReceipt({ homePath: home, profile: targetProfile })).toBeUndefined()
    const relativePath = `.rsi-coordinator-${createHash('sha256').update(targetProfile).digest('hex').slice(0, 16)}.json`
    const source = JSON.stringify({ schemaVersion: 1, targetProfile, coordinatorProfile, version: '0.1.32-rc.1+local', sourceRepository: home })
    await writeFile(join(home, relativePath), source, { mode: 0o600 })
    expect(await readRsiCoordinatorReceipt({ homePath: home, profile: targetProfile })).toEqual({
      relativePath, source, coordinatorProfile, version: '0.1.32-rc.1+local', sourceRepository: home,
    })
  })

  test('rejects malformed identity, SemVer, path, mode, links and symlinks', async () => {
    const { home } = await fixture()
    const path = join(home, `.rsi-coordinator-${createHash('sha256').update(targetProfile).digest('hex').slice(0, 16)}.json`)
    const valid = { schemaVersion: 1, targetProfile, coordinatorProfile, version: '0.1.32', sourceRepository: null }
    const read = () => readRsiCoordinatorReceipt({ homePath: home, profile: targetProfile })
    for (const changed of [
      { ...valid, targetProfile: 'another' }, { ...valid, coordinatorProfile: targetProfile },
      { ...valid, version: '^0.1.32' }, { ...valid, version: '1.2.3-01' },
      { ...valid, sourceRepository: 'relative/repo' }, { ...valid, sourceRepository: join(home, '..', 'repo') + '/..' },
      { ...valid, unexpected: true },
    ]) {
      await writeFile(path, JSON.stringify(changed), { mode: 0o600 })
      await expect(read()).rejects.toThrow()
    }
    await writeFile(path, JSON.stringify(valid), { mode: 0o600 })
    await chmod(path, 0o644)
    await expect(read()).rejects.toThrow('unsafe receipt file')
    await chmod(path, 0o600)
    const other = join(home, 'other.json')
    await link(path, other)
    await expect(read()).rejects.toThrow('unsafe receipt file')
    await rm(other)
    await rm(path)
    await writeFile(other, JSON.stringify(valid), { mode: 0o600 })
    await symlink(other, path)
    await expect(read()).rejects.toThrow('unsafe receipt')
  })
})

describe('validateRsiCoordinatorPair', () => {
  test('accepts the installer-shaped target and sparse coordinator', async () => {
    const { target, coordinator, options } = await fixture()
    const result = await validateRsiCoordinatorPair(stringify(target), stringify(coordinator), options)
    expect(result.scope).toEqual((coordinator[4]!.config as Record<string, any>).adoptionCoordinator.scope)
    expect(result.coordinatorId).toBe('adoption-coordinator')
    const preview = parse(result.previewPatch) as Array<{ id: string, config: Record<string, any> }>
    expect(preview).toHaveLength(1)
    expect(preview[0]!.id).toBe('dsh-enhanced-assistant-automations')
    expect(preview[0]!.config).toEqual({ ...(coordinator[3]!.config as Record<string, any>), schedulerEnabled: false })
  })

  test('accepts disabled unrelated target rows and optional base rows', async () => {
    const { target, coordinator, options } = await fixture()
    target.push({ id: 'owner-optional', name: '@dsh-enhanced/assistant-goals', disabled: true } as never)
    ;(coordinator[0] as Record<string, unknown>).disabled = true
    await expect(validateRsiCoordinatorPair(stringify(target), stringify(coordinator), options)).resolves.toHaveProperty('coordinatorId')
    coordinator.shift()
    await expect(validateRsiCoordinatorPair(stringify(target), stringify(coordinator), options)).resolves.toHaveProperty('coordinatorId')
  })

  test('preview keeps known YAML tags while replacing the whole Automations config', async () => {
    const { target, coordinator, options } = await fixture()
    ;(coordinator[3]!.config as Record<string, unknown>).note = 'tagged-expression'
    const source = stringify(coordinator).replace('note: tagged-expression', "note: !!js dshHomePath('note')")
    const { previewPatch } = await validateRsiCoordinatorPair(stringify(target), source, options)
    expect(previewPatch).toContain("note: !!js dshHomePath('note')")
    expect(previewPatch).toContain('schedulerEnabled: false')
    expect(previewPatch).not.toContain('sourceJobs:')
  })

  test('rejects mismatched handoff, scope, catalog and dedicated storage', async () => {
    const { target, coordinator, options } = await fixture()
    for (const change of [
      (rows: typeof coordinator) => { (rows[4]!.config as Record<string, any>).adoptionCoordinator.coordinatorId = 'other' },
      (rows: typeof coordinator) => { (rows[4]!.config as Record<string, any>).adoptionCoordinator.scope.preset = 'other' },
      (rows: typeof coordinator) => { (rows[4]!.config as Record<string, any>).catalogPath = '/tmp/other-catalog.json' },
      (rows: typeof coordinator) => { (rows[4]!.config as Record<string, any>).statePath = '/tmp/other-state' },
      (rows: typeof coordinator) => { (rows[2]!.config as Record<string, any>).databasePath = '/tmp/other-policy.sqlite' },
    ]) {
      const candidate = copy(coordinator)
      change(candidate)
      await expect(validateRsiCoordinatorPair(stringify(target), stringify(candidate), options)).rejects.toThrow()
    }
    const targetChanged = copy(target)
    ;(targetChanged[0]!.config.sourceAdoptions as Record<string, any>).profile = 'other'
    await expect(validateRsiCoordinatorPair(stringify(targetChanged), stringify(coordinator), options)).rejects.toThrow('handoff')
    const disabledTarget = copy(target)
    ;(disabledTarget[0] as Record<string, unknown>).disabled = true
    await expect(validateRsiCoordinatorPair(stringify(disabledTarget), stringify(coordinator), options)).rejects.toThrow('target control plane')
    const renamedTarget = copy(target)
    renamedTarget[0]!.name = '@dsh-enhanced/assistant-goals'
    await expect(validateRsiCoordinatorPair(stringify(renamedTarget), stringify(coordinator), options)).rejects.toThrow('target control plane')
  })

  test('rejects extra, disabled, duplicate, alias, unknown-tag and nested-agent rows', async () => {
    const { target, coordinator, options } = await fixture()
    const source = stringify(coordinator)
    const targetSource = stringify(target)
    const extra = [...coordinator, { id: 'dsh-enhanced-lark-channel', name: '@dsh-enhanced/lark-channel', config: {} }]
    await expect(validateRsiCoordinatorPair(targetSource, stringify(extra), options)).rejects.toThrow('forbidden row')
    const disabled = copy(coordinator)
    ;(disabled[3] as Record<string, unknown>).disabled = true
    await expect(validateRsiCoordinatorPair(targetSource, stringify(disabled), options)).rejects.toThrow('disabled')
    await expect(validateRsiCoordinatorPair(targetSource, source + source, options)).rejects.toThrow('duplicate')
    await expect(validateRsiCoordinatorPair(targetSource, source.replace('agents: []', 'agents: &agents []\n    plugins: *agents'), options)).rejects.toThrow('structurally valid YAML')
    await expect(validateRsiCoordinatorPair(targetSource, source.replace('agents: []', 'agents: !foreign []'), options)).rejects.toThrow('structurally valid YAML')
    const nested = copy(coordinator)
    ;(nested[1]!.config as Record<string, any>).agents = [{ id: 'unexpected' }]
    await expect(validateRsiCoordinatorPair(targetSource, stringify(nested), options)).rejects.toThrow('agent-loop.agents')
    ;(nested[1]!.config as Record<string, any>).agents = []
    ;(nested[0]!.config as Record<string, any>).plugins = [{ name: '@evil/peer' }]
    await expect(validateRsiCoordinatorPair(targetSource, stringify(nested), options)).rejects.toThrow('nested plugins')
  })

  test('rejects unsafe coordinator modules, scheduler and budgets', async () => {
    const { target, coordinator, options } = await fixture()
    const targetSource = stringify(target)
    const check = (rows: typeof coordinator) => validateRsiCoordinatorPair(targetSource, stringify(rows), options)
    for (const key of ['sourceJobs', 'foregroundDeployments', 'runtimeObserver']) {
      const candidate = copy(coordinator)
      ;(candidate[4]!.config as Record<string, any>)[key] = {}
      await expect(check(candidate)).rejects.toThrow(key)
    }
    const automations = coordinator[3]!.config as Record<string, any>
    automations.allowUnbudgetedExecution = true
    await expect(check(coordinator)).rejects.toThrow('budget admission')
    automations.allowUnbudgetedExecution = false
    automations.schedulerEnabled = false
    await expect(check(coordinator)).rejects.toThrow('scheduler')
    automations.schedulerEnabled = true
    ;(coordinator[4]!.config as Record<string, any>).adoptionCoordinator.budgetAmount = Number.MAX_SAFE_INTEGER + 1
    await expect(check(coordinator)).rejects.toThrow('finite positive integer')
    ;(coordinator[4]!.config as Record<string, any>).adoptionCoordinator.budgetAmount = 4
    await expect(check(coordinator)).rejects.toThrow('unique finite automation budget')
    ;(coordinator[4]!.config as Record<string, any>).adoptionCoordinator.budgetAmount = 1
    const policy = coordinator[2]!.config as Record<string, any>
    policy.budgets.push(copy(policy.budgets[0]))
    await expect(check(coordinator)).rejects.toThrow('unique finite automation budget')
  })
})
