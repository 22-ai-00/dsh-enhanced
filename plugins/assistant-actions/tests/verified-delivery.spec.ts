import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VerifiedDeliveryRuntime } from '../src/verified-delivery.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const request = { grantId: 'grant', idempotencyKey: 'key', expectedHeadOid: 'a'.repeat(40), headline: 'Deliver', paths: ['artifacts/release.txt'] }
function fixture(options: { inspect?: () => any; deliver?: (signal: AbortSignal) => Promise<any>; notify?: (value: unknown) => void; expiresAt?: number } = {}) {
  return mkdtemp(join(tmpdir(), 'verified-delivery-')).then(async root => {
    const ctx = new Context(), executors: any[] = [], reconciles: any[] = []
    const automations = {
      registerHostExecutor: vi.fn((executor: any) => { executors.push(executor); return () => {} }),
      reconcileSystem: vi.fn((input: any) => { reconciles.push(input); return { definition: input.definition } }),
    }
    ctx.provide('assistantAutomations' as never, automations as never)
    ctx.provide('assistantGoals' as never, {} as never); ctx.provide('assistantDelivery' as never, {} as never); ctx.provide('assistantPolicy' as never, {} as never)
    const inspect = vi.fn(options.inspect ?? (() => undefined)); const notify = vi.fn((intent, value) => options.notify?.({ intent, value })); const deliver = vi.fn(async (_intent, _files, signal) => options.deliver ? await options.deliver(signal) : { commit: { actionId: 'commit', status: 'succeeded', commitOid: 'b'.repeat(40) } })
    const runtime = new VerifiedDeliveryRuntime(ctx, root, {
      capture: () => ({ principalId: 'owner', identity: { principalDigest: 'p'.repeat(64), principalRecordId: 'record', principalVersion: 1, workspace: '/workspace', agentPreset: 'primary' }, sessionId: 'session', goalId: 'goal', runId: 'run', definitionDigest: 'd'.repeat(64), definitionVersion: 1, grantId: 'grant', grantRevision: 1, ownerRouteId: 'route', budgetId: 'budget', expiresAt: options.expiresAt ?? Date.now() + 60_000, routeReceipt: { route: 1 } }),
      inspect, deliver, notify,
    })
    let closed = false
    const close = async () => { if (closed) return; closed = true; try { await runtime.close() } catch (error) { if (!(error instanceof Error) || error.message !== 'database is not open') throw error }; await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
    cleanups.push(close)
    return { root, ctx, runtime, inspect, deliver, notify, executors, reconciles, close }
  })
}
function snapshot() { return { acceptance: { validUntil: Date.now() + 50_000 }, files: [{ path: 'artifacts/release.txt', content: 'verified bytes', sha256: 'c'.repeat(64), jobId: 'job' }] } }
function input(f: any, id: string) {
  const definition = f.reconciles.find((entry: any) => entry.desiredStatus === 'active')!.definition
  return { occurrenceId: 'occurrence', automationId: id, definitionHash: digest(definition), executionMode: 'production', targetScope: { workspace: '/workspace', preset: 'primary' }, principal: 'owner', ownerRouteId: 'route', activationNonce: id, catalogDigest: f.executors[0].descriptor.catalogDigest, signal: new AbortController().signal }
}

describe('verified delivery runtime', () => {
  it('keeps prepare awaiting verification, then materializes fixed host definition without storing source bytes', async () => {
    const f = await fixture(); const pending = f.runtime.prepare(undefined, request)
    expect(pending.status).toBe('awaiting-verification'); expect(f.reconciles).toHaveLength(0)
    f.runtime.reconcile(); expect(f.reconciles).toHaveLength(0)
    f.inspect.mockReturnValue(snapshot()); f.runtime.reconcile()
    expect(f.reconciles.map((entry: any) => entry.desiredStatus)).toEqual(['paused', 'active'])
    const row = f.runtime.get('session', 'grant', 'key')!; expect(row.status).toBe('scheduled')
    const db = new DatabaseSync(join(f.root, 'verified-delivery.sqlite')); try { expect(JSON.stringify(db.prepare('SELECT * FROM deliveries').all())).not.toContain('verified bytes') } finally { db.close() }
  })

  it('does not reveal an existing same-session delivery to a changed principal record or version', async () => {
    const f = await fixture(); f.runtime.prepare(undefined, request)
    const original = { principalDigest: 'p'.repeat(64), principalRecordId: 'record', principalVersion: 1, workspace: '/workspace', agentPreset: 'primary' }
    expect(f.runtime.get('session', 'grant', 'key', original)).toMatchObject({ status: 'awaiting-verification' })
    expect(f.runtime.get('session', 'grant', 'key', { ...original, principalRecordId: 'rebound' })).toBeUndefined()
    expect(f.runtime.get('session', 'grant', 'key', { ...original, principalVersion: 2 })).toBeUndefined()
    expect(f.runtime.get('session', 'grant', 'missing', original)).toBeUndefined()
  })

  it('delivers exact inspected files once and rejects a foreign Host executor input', async () => {
    const f = await fixture({ inspect: snapshot }); const queued = f.runtime.prepare(undefined, request); f.runtime.reconcile()
    const executor = f.executors[0]!; const foreign = await executor.execute({ ...input(f, queued.deliveryId), principal: 'foreign' })
    expect(foreign.failureCode).toBe('delivery-identity-denied'); expect(f.deliver).not.toHaveBeenCalled()
    expect((await executor.execute(input(f, queued.deliveryId))).outcome).toBe('succeeded')
    expect(f.deliver).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ files: [{ path: 'artifacts/release.txt', content: 'verified bytes', sha256: 'c'.repeat(64), jobId: 'job' }] }), expect.any(AbortSignal))
    await executor.execute(input(f, queued.deliveryId)); expect(f.deliver).toHaveBeenCalledTimes(1)
    expect(f.notify).toHaveBeenCalledOnce(); expect(f.notify.mock.calls[0]?.[1]).toMatchObject({ idempotencyKey: `verified-delivery-result:${queued.deliveryId}`, text: expect.stringContaining('b'.repeat(40)) })
  })

  it.each(['failed', 'unknown'])('persists a partial %s before retrying a failed notification once', async status => {
    let attempts = 0; const f = await fixture({ inspect: snapshot, notify: () => { attempts++; if (attempts === 1) throw new Error('outbox unavailable') }, deliver: async () => ({ commit: { actionId: 'commit', status: 'succeeded', commitOid: 'b'.repeat(40) }, pullRequest: { actionId: 'pr', status, reason: 'rejected' } }) })
    const queued = f.runtime.prepare(undefined, request); f.runtime.reconcile(); expect((await f.executors[0]!.execute(input(f, queued.deliveryId))).outcome).toBe('unknown')
    expect(f.runtime.get('session', 'grant', 'key')).toMatchObject({ status: 'unknown' }); expect(attempts).toBe(1)
    expect(f.notify.mock.calls[0]?.[1].text).toContain(status === 'unknown' ? 'PR 结果待确认' : 'PR 未完成')
    f.runtime.reconcile(); expect(attempts).toBe(2); f.runtime.reconcile(); expect(attempts).toBe(2)
  })

  it('does not dispatch on expired or throwing evidence inspection', async () => {
    const expired = await fixture({ inspect: snapshot, expiresAt: Date.now() - 1 }); expired.runtime.prepare(undefined, request); expired.runtime.reconcile()
    expect(expired.runtime.get('session', 'grant', 'key')?.status).toBe('failed'); expect(expired.reconciles).toHaveLength(0)
    const broken = await fixture({ inspect: () => { throw new Error('denied') } }); broken.runtime.prepare(undefined, request); broken.runtime.reconcile()
    expect(broken.runtime.get('session', 'grant', 'key')?.status).toBe('failed'); expect(broken.reconciles).toHaveLength(0)
  })

  it('preserves an awaiting-verification intent across restart without dispatching it', async () => {
    const f = await fixture(); f.runtime.prepare(undefined, request); await f.runtime.close()
    const ctx = new Context(), automations = { registerHostExecutor: () => () => {}, reconcileSystem: vi.fn((value: any) => ({ definition: value.definition })) }
    ctx.provide('assistantAutomations' as never, automations as never); ctx.provide('assistantGoals' as never, {} as never); ctx.provide('assistantDelivery' as never, {} as never); ctx.provide('assistantPolicy' as never, {} as never)
    const restored = new VerifiedDeliveryRuntime(ctx, f.root, { capture: () => { throw new Error('unused') }, inspect: () => undefined, deliver: async () => { throw new Error('unused') }, notify: () => {} })
    expect(restored.get('session', 'grant', 'key')).toMatchObject({ status: 'awaiting-verification' }); expect(automations.reconcileSystem).not.toHaveBeenCalled()
    await restored.close(); await ctx.fiber.dispose()
  })

  it('preserves a scheduled intent across restart but marks an executing handoff unknown', async () => {
    const f = await fixture({ inspect: snapshot }); f.runtime.prepare(undefined, request); f.runtime.reconcile(); await f.runtime.close()
    const pendingDb = new DatabaseSync(join(f.root, 'verified-delivery.sqlite')); expect((pendingDb.prepare('SELECT state FROM deliveries').get() as any).state).toBe('scheduled'); pendingDb.close()
    const ctx = new Context(), automations = { registerHostExecutor: () => () => {}, reconcileSystem: (value: any) => ({ definition: value.definition }) }
    ctx.provide('assistantAutomations' as never, automations as never); ctx.provide('assistantGoals' as never, {} as never); ctx.provide('assistantDelivery' as never, {} as never); ctx.provide('assistantPolicy' as never, {} as never)
    const restored = new VerifiedDeliveryRuntime(ctx, f.root, { capture: () => { throw new Error('unused') }, inspect: () => undefined, deliver: async () => { throw new Error('unused') }, notify: () => {} }); restored.reconcile()
    expect(restored.get('session', 'grant', 'key')).toMatchObject({ status: 'scheduled' })
    await restored.close(); await ctx.fiber.dispose()
    const db = new DatabaseSync(join(f.root, 'verified-delivery.sqlite')); db.prepare("UPDATE deliveries SET state='executing'").run(); db.close()
    const ctx2 = new Context(); ctx2.provide('assistantAutomations' as never, automations as never); ctx2.provide('assistantGoals' as never, {} as never); ctx2.provide('assistantDelivery' as never, {} as never); ctx2.provide('assistantPolicy' as never, {} as never)
    const interrupted = new VerifiedDeliveryRuntime(ctx2, f.root, { capture: () => { throw new Error('unused') }, inspect: () => undefined, deliver: async () => { throw new Error('unused') }, notify: () => {} })
    expect(interrupted.get('session', 'grant', 'key')).toMatchObject({ status: 'unknown', result: { reason: 'interrupted-delivery-no-replay' } })
    await interrupted.close(); await ctx2.fiber.dispose()
  })

  it('aborts a live Host delivery on dispose and records unknown', async () => {
    const entered = Promise.withResolvers<void>(); const f = await fixture({ inspect: snapshot, deliver: async signal => { entered.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { commit: { actionId: 'commit', status: 'unknown' } } } })
    const queued = f.runtime.prepare(undefined, request); f.runtime.reconcile(); const pending = f.executors[0]!.execute(input(f, queued.deliveryId))
    await entered.promise; await f.runtime.close(); expect((await pending).outcome).toBe('unknown')
  })
})
