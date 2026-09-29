import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { stringify } from 'yaml'
import { assertRsiSchedulerActivation, captureRsiAutomationInventories, resolveRsiOwnerRoute,
  rsiAutomationInventory, rsiDatabasePaths, rsiOwnerBindingQuery, type RsiAutomationInventory } from '../src/rsi-owner-profile.js'

const owner = {
  id: 'binding', conversation: { channel: 'lark', account: 'account', tenant: 'tenant', kind: 'dm' as const, chat: 'chat' },
  principal: { channel: 'lark', account: 'account', tenant: 'tenant', user: 'owner' }, workspace: '/private/workspace',
  agentPreset: 'primary', sessionId: 'session', generation: 3, policyRef: 'owner-policy', status: 'active' as const,
  createdAt: 1, updatedAt: 1, version: 2,
  owner: { id: 'owner-lineage', principal: { channel: 'lark', account: 'account', tenant: 'tenant', user: 'owner' },
    role: 'owner' as const, status: 'active' as const, createdAt: 1, updatedAt: 1, version: 2 },
}
const delivery = () => ({ defaultWorkspace: owner.workspace, defaultAgentPreset: owner.agentPreset, ownerRoutes: [] as Record<string, any>[] })
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('ordinary-use owner authority and scheduler inventory', () => {
  test('creates a stable route from authenticated owner lineage and retains existing lower generations', () => {
    const original = delivery(), resolved = resolveRsiOwnerRoute(original, owner, '/private')
    expect(original.ownerRoutes).toEqual([])
    expect(resolved.authority).toMatchObject({ conversation: owner.conversation, principal: owner.principal,
      workspace: owner.workspace, agentPreset: owner.agentPreset, policyRef: owner.policyRef, minimumGeneration: 3 })
    const nextOwner = { ...owner, generation: 4, version: 3, sessionId: 'new-session' }
    expect(resolveRsiOwnerRoute(delivery(), nextOwner, '/private').route.id).toBe(resolved.route.id)
    const existing = { ...resolved.authority, id: 'supervised-growth-owner', minimumGeneration: 1 }
    const unrelated = { ...existing, id: 'other', conversation: { ...owner.conversation, chat: 'other' } }
    const reused = resolveRsiOwnerRoute({ ...original, ownerRoutes: [unrelated, existing] }, nextOwner, '/private')
    expect(reused.created).toBe(false)
    expect(reused.authority).toBe(existing)
    expect(reused.authority.minimumGeneration).toBe(1)
  })
  test('rejects duplicate identities, conflicting scope and unauthenticated receipts', () => {
    const route = resolveRsiOwnerRoute(delivery(), owner, '/private').authority
    expect(() => resolveRsiOwnerRoute({ ...delivery(), ownerRoutes: [route, route] }, owner, '/private')).toThrow('duplicated')
    expect(() => resolveRsiOwnerRoute({ ...delivery(), ownerRoutes: [route, { ...route, id: 'other' }] }, owner, '/private')).toThrow('no unique effective route')
    for (const change of [{ principal: { ...owner.principal, user: 'other' } }, { workspace: '/other' },
      { agentPreset: 'other' }, { policyRef: 'other' }, { minimumGeneration: 4 }]) {
      expect(() => resolveRsiOwnerRoute({ ...delivery(), ownerRoutes: [{ ...route, ...change }] }, owner, '/private')).toThrow('conflicts')
    }
    expect(() => resolveRsiOwnerRoute(delivery(), { ...owner, owner: { ...owner.owner, status: 'revoked' } }, '/private')).toThrow('receipt')
    expect(() => resolveRsiOwnerRoute(delivery(), owner, '/private', 'different')).toThrow('frozen manifest')
  })
  test('resolves real lookup scope and bounded !!js database paths without Recovery', () => {
    const effective = `
- id: dsh-enhanced-assistant-delivery
  config: { defaultWorkspace: !!js dshHomePath('assistant-workspace'), defaultAgentPreset: primary, databasePath: !!js dshHomePath('delivery/state.sqlite') }
- id: dsh-enhanced-lark-channel
  config: { account: account, tenant: tenant }
- id: dsh-enhanced-personal-assistant
  config: { assistantAutomations: { databasePath: !!js dshHomePath('automations/state.sqlite'), schedulerEnabled: false } }
`
    expect(rsiOwnerBindingQuery(effective, '/private')).toEqual({ account: 'account', tenant: 'tenant', workspace: '/private/assistant-workspace', agentPreset: 'primary' })
    expect(rsiDatabasePaths(effective, '/private')).toEqual({ deliveryDatabasePath: '/private/delivery/state.sqlite', automationsDatabasePath: '/private/automations/state.sqlite' })
    expect(() => rsiDatabasePaths(effective.replace('automations/state.sqlite', '../escape'), '/private')).toThrow('bounded dshHomePath')
    expect(() => rsiDatabasePaths(effective + '- id: dsh-enhanced-assistant-automations\n  config: { databasePath: /private/other.sqlite }\n', '/private')).toThrow('ambiguous')
  })
  test('reads actual active durable tasks without creating absent storage or changing existing data', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'rsi-inventory-'))); roots.push(home)
    const databasePath = join(home, 'state', 'automations.sqlite')
    const effective = stringify([{ id: 'dsh-enhanced-assistant-automations', config: { databasePath, schedulerEnabled: false } }])
    expect(rsiAutomationInventory(effective, home).records).toEqual([])
    await expect(readFile(databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
    const require = createRequire(import.meta.url)
    const { AutomationStore } = await import(pathToFileURL(join(dirname(require.resolve('@dsh-enhanced/assistant-automations/package.json')), 'lib/store.js')).href) as {
      AutomationStore: new (options: { path: string }) => { createApproved(input: Record<string, unknown>): {id:string;version:number};
        changeApproved(input: Record<string, unknown>): unknown; reconcileSystemOwned(input: Record<string, unknown>): unknown; close(): void }
    }
    const store = new AutomationStore({ path: databasePath })
    try {
      const definition = {
        name: 'existing', prompt: 'Existing owner task', schedule: { kind: 'every', anchorAt: '2026-09-11T00:00:00.000Z', intervalMs: 900_000 },
        workspace: home, agentPreset: 'primary', provider: 'mock', model: 'mock-model', principal: 'owner:test', allowedTools: [],
        timeoutMs: 60_000, maxOutputTokens: 2_048, maxToolCalls: 4, misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
      }
      store.createApproved({automationId:'existing-user-task',idempotencyKey:'existing',definition})
      const paused = store.createApproved({automationId:'paused-user-task',idempotencyKey:'paused',definition})
      store.changeApproved({automationId:paused.id,operation:'pause',expectedVersion:paused.version,idempotencyKey:'pause-existing'})
      store.reconcileSystemOwned({owner:'assistant-growth-experiments',automationId:'paused-growth',idempotencyKey:'growth',definition,desiredStatus:'paused'})
    } finally { store.close() }
    const before = await readFile(databasePath)
    const inventory = rsiAutomationInventory(effective, home)
    expect(inventory.records.map(record => record.id)).toEqual(['existing-user-task','paused-growth','paused-user-task'])
    expect(inventory.records.filter(record => record.status === 'paused').map(record => record.id)).toEqual(['paused-growth','paused-user-task'])
    expect(await readFile(databasePath)).toEqual(before)
    const capture = await captureRsiAutomationInventories(async value => rsiAutomationInventory(value, home), effective, effective, home, 'coordinator')
    expect(capture[3].records).toEqual([])
    expect(() => assertRsiSchedulerActivation(capture, false)).toThrow('--ack-existing-automations')
    expect(() => assertRsiSchedulerActivation(capture, true)).not.toThrow()
    for (const record of inventory.records.filter(record => record.status === 'paused')) {
      const paused = {...inventory,records:[record]}
      expect(() => assertRsiSchedulerActivation([paused,paused,{...paused,schedulerEnabled:true},{...paused,schedulerEnabled:true}],false)).toThrow('--ack-existing-automations')
    }
    const empty = {...inventory,records:[]}
    const destination = {...empty,databasePath:join(home,'other.sqlite'),schedulerEnabled:true,records:inventory.records}
    expect(() => assertRsiSchedulerActivation([empty,empty,{...empty,schedulerEnabled:true},destination],false)).toThrow('--ack-existing-automations')
    const linked = join(home, 'linked'); await symlink(join(home, 'state'), linked)
    expect(() => rsiAutomationInventory(effective.replace(databasePath, join(linked, 'missing.sqlite')), home)).toThrow('unsafe parent')
    await mkdir(join(home, 'public'), { mode: 0o755 })
    expect(() => rsiAutomationInventory(effective.replace(databasePath, join(home, 'public', 'missing.sqlite')), home)).toThrow('unsafe parent')
  })
  test('acknowledgement is unnecessary for an already running scheduler in the same ledger', () => {
    const inventory = { databasePath: '/private/tasks.sqlite', schedulerEnabled: true, records: [{ id: 'existing' }] } as unknown as RsiAutomationInventory
    expect(() => assertRsiSchedulerActivation([inventory, inventory, inventory, inventory], false)).not.toThrow()
  })
})
