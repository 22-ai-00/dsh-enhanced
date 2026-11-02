import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { AssistantWorkItemsService } from '../src/service.ts'
import { normalizeConfig, type Config } from '../src/config.ts'
import { DIAGNOSIS_OWNER, DIAGNOSIS_SOURCE, diagnosisDefinitionHash } from '../src/diagnosis-contract.ts'
import type { HostAutomationDefinition } from '@dsh-enhanced/assistant-automations'

// Unit boundary tests: real Cordis lifecycle and SQLite; owner/Policy/Automations are recorded stubs.
// No native Agent, real authorization decision, budget accounting or delivery is claimed here.
const roots: string[] = [], closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
interface Worker { owner: string; id: string; status: string; hash: string; version: number; definition: HostAutomationDefinition }
function peers() {
  const state: { worker?: Worker; allow: boolean; version: number } = { allow: true, version: 1 }
  const reconcile = vi.fn((input: { owner: string; automationId: string; definition: HostAutomationDefinition }) => {
    const definition = structuredClone(input.definition)
    state.worker = { owner: input.owner, id: input.automationId, status: 'active', hash: diagnosisDefinitionHash(definition), version: 1, definition }
    return { id: input.automationId, owner: input.owner, version: 1, status: 'active', definition }
  })
  const register = vi.fn(() => vi.fn()), runAgent = vi.fn(async () => { throw new Error('unit test must not create an Agent') }), ingest = vi.fn(() => { throw new Error('unit test has no source event') })
  const automations = { hostAgentAuthorizationVersion: () => state.version, runAgentForHostExecution: runAgent,
    registerHostExecutor: register, reconcileSystem: reconcile, onSchedulerWake: () => () => {}, ingestExternal: ingest,
    inspectSystemOwned: ({ owner, automationId }: { owner: string; automationId: string }) => {
      const row = state.worker
      if (!row) throw Object.assign(new Error('not found'), { code: 'not-found' })
      return { owner: row.owner, automationId: row.id, automationStatus: row.status, definitionHash: row.hash, definitionVersion: row.version,
        requestedOwner: owner, requestedAutomation: automationId }
    },
    inspectSystemOwnedActivation: () => state.worker?.definition.execution?.kind === 'host' ? { definitionHash: state.worker.hash,
      activationNonce: state.worker.definition.execution.activationNonce, ownerRouteId: state.worker.definition.execution.ownerRouteId } : undefined }
  const authorize = vi.fn(() => ({ effect: state.allow ? 'allow' : 'deny', reasonCode: 'unit-policy' }))
  const delivery = { validateOwnerRoute: (input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) => ({
    receiptVersion: 2, ...input, authorityHash: 'd'.repeat(64), principalRecordId: 'owner-record', principalVersion: 1, bindingVersion: 1, generation: 1 }),
    listOwnerForegroundTaskSources: () => ({ items: [], nextCursor: { protocol: 'unit', epoch: 'unit', scopeKey: 'unit', sequence: 0 }, watermark: 0, hasMore: false }),
    inspectOwnerForegroundTaskSource: () => undefined, readOwnerForegroundTaskInput: () => undefined,
    enqueueBackground: async () => ({ id: 'unit-outbox' }) }
  return { state, automations, delivery, authorize, reconcile, register, runAgent, ingest }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'work-items-activation-')); roots.push(root)
  const now = Date.now(), peer = peers()
  const config = { enabled: true, mode: 'active', databasePath: join(root, 'state.sqlite'), workRoot: join(root, 'work'),
    intakeSourceId: 'work-items/v1', workerAutomationId: 'diagnosis-worker',
    scope: { workspace: root, preset: 'primary', principalId: 'owner', ownerRouteId: 'owner-route', expiresAt: now + 86400000 },
    admission: { allowedKinds: ['diagnosis'] }, sources: { foregroundFailures: { enabled: true, kind: 'diagnosis', sweepIntervalMs: 60000 } },
    diagnosis: { enabled: true, budgetId: 'diagnosis-budget', budgetAmount: 1, maxModelCalls: 4, maxToolCalls: 4, maxOutputTokens: 256, timeoutMs: 15000, expiresAt: now + 3600000 } } satisfies Config
  const mount = async (input: Config = config) => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' } })
    ctx.provide('assistantPolicy', { authorize: peer.authorize } as never)
    ctx.provide('assistantAutomations', peer.automations as never)
    ctx.provide('assistantDelivery', peer.delivery as never)
    const fiber = ctx.plugin(AssistantWorkItemsService, input)
    let closed = false
    const close = async () => { if (!closed) { closed = true; await ctx.fiber.restart() } }
    closers.push(close)
    await fiber
    return { ctx, service: ctx.assistantWorkItems, close }
  }
  const meta = () => {
    const db = new DatabaseSync(config.databasePath!, { readOnly: true })
    try { return db.prepare("SELECT CAST(value AS BLOB) AS bytes FROM work_item_schema_meta WHERE key='diagnosis.activation/v1'").get() as { bytes: Uint8Array } | undefined } finally { db.close() }
  }
  return { root, peer, config, mount, meta }
}

test('disabled/default and observe modes do not activate; explicitly enabled diagnosis rejects observe configuration', async () => {
  const f = await fixture()
  const disabled = await f.mount({ databasePath: f.config.databasePath, workRoot: f.config.workRoot })
  expect(disabled.service.health()).not.toHaveProperty('diagnosis'); await disabled.close()
  const { diagnosis: _diagnosis, ...generic } = f.config
  const observed = await f.mount({ ...generic, mode: 'observe' })
  expect(observed.service.health()).not.toHaveProperty('diagnosis')
  expect(f.peer.reconcile).not.toHaveBeenCalled(); expect(f.peer.runAgent).not.toHaveBeenCalled()
  expect(() => normalizeConfig({ ...f.config, mode: 'observe' }, Date.now())).toThrow(/active enabled/u)
})

test('denied activation does not create a worker or persist an activation intent', async () => {
  const f = await fixture(); f.peer.state.allow = false
  const mounted = await f.mount()
  expect(mounted.service.health().diagnosis).toMatchObject({ ready: false })
  expect(f.peer.reconcile).not.toHaveBeenCalled(); expect(f.peer.register).not.toHaveBeenCalled()
  expect(f.meta()).toBeUndefined(); expect(f.peer.runAgent).not.toHaveBeenCalled()
})

test('first explicit activation creates once; identical restart reuses the sealed activation without renewing expiry or budget', async () => {
  const f = await fixture(), first = await f.mount()
  expect(first.service.health().diagnosis).toMatchObject({ ready: true }); expect(f.peer.reconcile).toHaveBeenCalledTimes(1)
  expect(f.peer.state.worker).toMatchObject({ owner: DIAGNOSIS_OWNER, definition: { schedule: { kind: 'external' }, budgetId: 'diagnosis-budget', budgetAmount: 1 } })
  const before = Buffer.from(f.meta()!.bytes), worker = structuredClone(f.peer.state.worker)
  await first.close(); const restarted = await f.mount()
  expect(restarted.service.health().diagnosis).toMatchObject({ ready: true })
  expect(f.peer.reconcile).toHaveBeenCalledTimes(1); expect(Buffer.from(f.meta()!.bytes)).toEqual(before)
  expect(f.peer.state.worker).toEqual(worker); expect(f.peer.runAgent).not.toHaveBeenCalled(); expect(f.peer.ingest).not.toHaveBeenCalled()
})

test('paused, deleted and established-but-missing workers are never reactivated during restart', async () => {
  for (const status of ['paused','deleted','missing']) {
    const f = await fixture(), first = await f.mount(); expect(first.service.health().diagnosis?.ready).toBe(true)
    const before = Buffer.from(f.meta()!.bytes)
    await first.close()
    if (status === 'missing') delete f.peer.state.worker; else f.peer.state.worker!.status = status
    const restarted = await f.mount()
    expect(restarted.service.health().diagnosis, status).toMatchObject({ ready: false })
    expect(f.peer.reconcile, status).toHaveBeenCalledTimes(1); expect(Buffer.from(f.meta()!.bytes)).toEqual(before)
    expect(f.peer.runAgent).not.toHaveBeenCalled(); expect(f.peer.ingest).not.toHaveBeenCalled()
  }
})

test('configuration, nonce and definition drift cannot reconcile or rewrite established authorization', async () => {
  for (const drift of ['configuration','nonce','hash','version','owner']) {
    const f = await fixture(), first = await f.mount(); expect(first.service.health().diagnosis?.ready).toBe(true)
    const before = Buffer.from(f.meta()!.bytes); await first.close()
    if (drift === 'nonce') f.peer.state.worker!.definition.execution.activationNonce = 'e'.repeat(64)
    if (drift === 'hash') f.peer.state.worker!.hash = 'e'.repeat(64)
    if (drift === 'version') f.peer.state.worker!.version++
    if (drift === 'owner') f.peer.state.worker!.owner = 'other-owner'
    const input = drift === 'configuration' ? { ...f.config, diagnosis: { ...f.config.diagnosis, budgetId: 'another-budget' } } : f.config
    const restarted = await f.mount(input)
    expect(restarted.service.health().diagnosis, drift).toMatchObject({ ready: false })
    expect(f.peer.reconcile, drift).toHaveBeenCalledTimes(1); expect(Buffer.from(f.meta()!.bytes)).toEqual(before)
    expect(f.peer.runAgent).not.toHaveBeenCalled()
  }
})

test('an existing unrelated worker or a peer lacking the fence version is never taken over', async () => {
  for (const incompatible of ['ordinary-worker','old-peer']) {
    const f = await fixture()
    if (incompatible === 'old-peer') f.peer.state.version = 0
    else f.peer.state.worker = { owner: DIAGNOSIS_OWNER, id: 'diagnosis-worker', status: 'active', hash: 'f'.repeat(64), version: 1,
      definition: {} as HostAutomationDefinition }
    const mounted = await f.mount()
    expect(mounted.service.health().diagnosis).toMatchObject({ ready: false })
    expect(f.peer.reconcile).not.toHaveBeenCalled(); expect(f.peer.runAgent).not.toHaveBeenCalled()
  }
})

test('public admissions and same-ID extension source shadowing cannot mint plans or create an Agent', async () => {
  const f = await fixture(), mounted = await f.mount(); expect(mounted.service.health().diagnosis?.ready).toBe(true)
  expect(() => mounted.service.admit({ kind: 'diagnosis', externalId: 'forged', title: 'forged', brief: 'not a Host source', originBindingId: 'source-binding',
    provenance: { source: DIAGNOSIS_SOURCE, sourceVersion: 'assistant-work-items/owner-foreground-failures/v1', signalDigest: 'a'.repeat(64), observedAt: Date.now(), evidence: {} } })).toThrow(/private builtin/u)
  const sweep = vi.fn(() => ({ candidates: [], cursor: undefined }))
  expect(() => mounted.service.registerSignalSource({ source: { id: DIAGNOSIS_SOURCE, sourceVersion: 'forged/v1', sweep } })).toThrow(/exclusive private/u)
  expect(sweep).not.toHaveBeenCalled()
  const db = new DatabaseSync(f.config.databasePath!, { readOnly: true })
  try { expect(db.prepare('SELECT COUNT(*) AS n FROM work_item').get()).toMatchObject({ n: 0 }) } finally { db.close() }
  expect(f.peer.ingest).not.toHaveBeenCalled(); expect(f.peer.runAgent).not.toHaveBeenCalled()
})

test('optional disabled scope does not relax provided scope validation or active scope requirements', async () => {
  const f = await fixture()
  await expect(f.mount({ databasePath: f.config.databasePath, workRoot: f.config.workRoot, scope: {} })).rejects.toThrow(/scope/u)
  const { scope: _scope, diagnosis: _diagnosis, ...withoutScope } = f.config
  await expect(f.mount(withoutScope)).rejects.toThrow(/scope/u)
  expect(f.peer.reconcile).not.toHaveBeenCalled(); expect(f.peer.runAgent).not.toHaveBeenCalled()
})
