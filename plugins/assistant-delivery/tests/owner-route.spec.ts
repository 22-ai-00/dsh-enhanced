import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AssistantDeliveryService,
  type DeliveryPresentationUpdate,
  type OwnerRouteAuthority,
  type OwnerRouteStateInspection,
  ownerRouteAuthorityHash,
} from '../src/index.ts'
import { deliverySchemaVersion } from '../src/sqlite.ts'
import { DeliveryStore } from '../src/store.ts'

const roots: string[] = []
const contexts = new Set<Context>()

const principal = {
  channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner',
}
const conversation = {
  channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner',
}
const authority: OwnerRouteAuthority = {
  id: 'supervised-growth-owner',
  conversation,
  principal,
  workspace: '/work/alpha',
  agentPreset: 'primary',
  policyRef: 'owner-dm',
  minimumGeneration: 1,
}

afterEach(async () => {
  await Promise.all([...contexts].map(async ctx => {
    await ctx.fiber.restart()
    contexts.delete(ctx)
  }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface Fixture {
  ctx: Context
  root: string
  service: AssistantDeliveryService
  store: DeliveryStore
}

async function mount(
  root: string,
  ownerRoutes: readonly OwnerRouteAuthority[] = [authority],
  routePolicy = true,
): Promise<Fixture> {
  const ctx = new Context()
  contexts.add(ctx)
  try {
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [
        { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
          actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' },
          context: { initiators: ['foreground'] } },
        { id: 'owner-pair', effect: 'allow',
          subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
          actions: ['pair.confirm'], resource: { kind: 'message', id: 'pairing' },
          context: { initiators: ['external'] } },
        { id: 'other-pair', effect: 'allow',
          subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_other' },
          actions: ['pair.confirm'], resource: { kind: 'message', id: 'pairing' },
          context: { initiators: ['external'] } },
        ...(routePolicy ? [{ id: 'exact-owner-route-send', effect: 'allow' as const, subject: {
          kind: 'background' as const, id: 'growth-supervisor', workspace: '/work/alpha',
          principal: 'lark/bot-1/tenant-a/ou_owner',
        }, actions: ['send' as const], resource: { kind: 'message' as const, id: 'route:supervised-growth-owner' },
        context: { initiators: ['background' as const] } }] : []),
      ],
    })
    await ctx.plugin(AssistantDeliveryService, {
      databasePath: join(root, 'delivery.sqlite'),
      spoolPath: join(root, 'spool'),
      schedulerEnabled: false,
      retryBaseMs: 1,
      retryMaxMs: 1,
      ownerRoutes,
    })
  } catch (error) {
    await ctx.fiber.restart()
    contexts.delete(ctx)
    throw error
  }
  return {
    ctx,
    root,
    service: ctx.assistantDelivery,
    store: (ctx.assistantDelivery as unknown as { deliveryStore: DeliveryStore }).deliveryStore,
  }
}

async function fixture(ownerRoutes: readonly OwnerRouteAuthority[] = [authority]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-owner-route-'))
  roots.push(root)
  return mount(root, ownerRoutes)
}

function pairAndBind(fixture: Fixture, input: {
  principal?: typeof principal
  workspace?: string
  agentPreset?: string
  policyRef?: string
  sessionId?: string
} = {}) {
  const boundPrincipal = input.principal ?? principal
  const challenge = fixture.service.issuePairing('test', boundPrincipal)
  fixture.service.confirmPairing({ challengeId: challenge.challenge.id, principal: boundPrincipal, code: challenge.code })
  return fixture.store.createBinding({
    conversation,
    principal: boundPrincipal,
    workspace: input.workspace ?? '/work/alpha',
    agentPreset: input.agentPreset ?? 'primary',
    sessionId: input.sessionId ?? 'delivery-session-1',
    policyRef: input.policyRef ?? 'owner-dm',
  })
}

function incidentUpdate(
  incidentId: string,
  revision: number,
  state: 'open' | 'recovering' | 'resolved',
): DeliveryPresentationUpdate {
  const lifecycleKey = `automation-incident:${incidentId}:g1`
  return {
    presentationKey: lifecycleKey,
    originalOutboxIdempotencyKey: lifecycleKey,
    revision,
    presentation: {
      kind: 'automation-incident', incidentId, automationId: 'heartbeat:supervised-growth',
      definitionHash: 'a'.repeat(64), stage: 'terminal', state,
      failureClass: 'configuration', failurePhase: 'host-execution', failureCode: 'catalog-mismatch',
      sideEffectState: 'none', retryability: 'after-intervention', lifecycleGeneration: 1,
      incidentRevision: revision, openedAt: 1_000, updatedAt: 1_000 + revision,
      ...(state === 'resolved' ? { resolvedAt: 1_000 + revision } : {}),
    },
  }
}

async function dispose(fixture: Fixture): Promise<void> {
  await fixture.ctx.fiber.restart()
  contexts.delete(fixture.ctx)
}

const ownerScope = { authorityId: authority.id, principalId: 'lark/bot-1/tenant-a/ou_owner',
  workspace: '/work/alpha', agentPreset: 'primary' }

function deliveryRows(fixture: Fixture): unknown {
  const database = new DatabaseSync(join(fixture.root, 'delivery.sqlite'), { readOnly: true })
  try {
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
    return tables.map(({ name }) => ({ name,
      rows: database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() }))
  } finally {
    database.close()
  }
}

function inspectWithoutChanges(fixture: Fixture, input = ownerScope): OwnerRouteStateInspection {
  const before = deliveryRows(fixture)
  const inspection = fixture.service.inspectOwnerRouteState(input)
  expect(deliveryRows(fixture)).toEqual(before)
  return inspection
}

describe('read-only owner route state inspection', () => {
  test('returns the existing active receipt without changing owner, binding or message history', async () => {
    const f = await fixture()
    pairAndBind(f)
    f.store.acceptInbound({ channel: principal.channel, account: principal.account,
      eventId: 'state-inspection-history', occurredAt: 1, principal, conversation,
      kind: 'text', text: 'Private owner message must stay in the ledger.' })
    f.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: 'state-inspection-history', text: 'Private historical response.' })
    const receipt = f.service.validateOwnerRoute(ownerScope)
    const inspection = inspectWithoutChanges(f)
    expect(inspection).toEqual({ status: 'active', receipt })
    expect(Object.isFrozen(inspection)).toBe(true)
    if (inspection.status === 'active') expect(Object.isFrozen(inspection.receipt)).toBe(true)
    expect(inspectWithoutChanges(f, { authorityId: ` ${authority.id} `,
      principalId: ` ${ownerScope.principalId} `, workspace: ' /work/alpha ', agentPreset: ' primary ' }))
      .toEqual({ status: 'active', receipt })
  })

  test('proves exact durable owner revocation without requiring an active binding, including after restart', async () => {
    const f = await fixture()
    pairAndBind(f)
    const owner = f.store.getPrincipal(principal)!
    const revoked = f.store.revokePrincipal(owner.id, owner.version)
    expect(f.store.getActiveBinding(conversation)).toBeUndefined()
    const resolve = vi.spyOn(f.service, 'resolveOwnerRoute')
    const expected = { status: 'revoked', authorityId: authority.id,
      authorityHash: ownerRouteAuthorityHash(authority), principalId: ownerScope.principalId,
      principalRecordId: revoked.id, principalVersion: revoked.version }
    expect(inspectWithoutChanges(f)).toEqual(expected)
    expect(resolve).not.toHaveBeenCalled()
    expect(() => f.service.validateOwnerRoute(ownerScope))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    await dispose(f)
    const restarted = await mount(f.root)
    expect(inspectWithoutChanges(restarted)).toEqual(expected)
  })

  test.each([
    ['unknown authority', { authorityId: 'unconfigured' }, 'authority-unconfigured'],
    ['invalid authority', { authorityId: 'invalid\nauthority' }, 'authority-invalid'],
    ['principal', { principalId: 'lark/bot-1/tenant-a/ou_other' }, 'scope-mismatch'],
    ['workspace', { workspace: '/work/other' }, 'scope-mismatch'],
    ['preset', { agentPreset: 'other' }, 'scope-mismatch'],
    ['invalid scope', { workspace: '/work/alpha\u0000' }, 'scope-mismatch'],
  ] as const)('does not expose revoked owner state for %s', async (_label, change, reason) => {
    const f = await fixture()
    pairAndBind(f)
    const owner = f.store.getPrincipal(principal)!
    f.store.revokePrincipal(owner.id, owner.version)
    const read = vi.spyOn(f.store, 'getPrincipal')
    expect(inspectWithoutChanges(f, { ...ownerScope, ...change })).toEqual({ status: 'unavailable', reason })
    expect(read).not.toHaveBeenCalled()
  })

  test('does not create a missing owner or binding, or treat them as revocation', async () => {
    const f = await fixture()
    expect(inspectWithoutChanges(f)).toEqual({ status: 'unavailable', reason: 'owner-unavailable' })
    f.store.ensureOwner(principal)
    expect(inspectWithoutChanges(f)).toEqual({ status: 'unavailable', reason: 'route-unavailable' })
    expect(f.store.getPrincipal(principal)).toMatchObject({ status: 'active', version: 1 })
    expect(f.store.listBindings(conversation)).toEqual([])
  })

  test('does not treat a revoked linked principal as revoked owner authority', async () => {
    const linked = { ...principal, user: 'ou_other' }
    const f = await fixture([{ ...authority, principal: linked }])
    f.store.ensureOwner(principal)
    const challenge = f.service.issuePairing('test', linked)
    f.service.confirmPairing({ challengeId: challenge.challenge.id, principal: linked, code: challenge.code })
    const row = f.store.getPrincipal(linked)!
    expect(row).toMatchObject({ role: 'linked', status: 'active' })
    f.store.revokePrincipal(row.id, row.version)
    expect(inspectWithoutChanges(f, { ...ownerScope, principalId: 'lark/bot-1/tenant-a/ou_other' }))
      .toEqual({ status: 'unavailable', reason: 'owner-unavailable' })
  })

  test.each([
    ['conversation', { conversation: { ...conversation, chat: 'other' } }],
    ['workspace', { workspace: '/work/other' }],
    ['preset', { agentPreset: 'other' }],
    ['policy', { policyRef: 'other' }],
    ['generation', { minimumGeneration: 2 }],
  ] as const)('keeps active owner route %s drift unavailable', async (_label, change) => {
    const configured = { ...authority, ...change }
    const f = await fixture([configured])
    pairAndBind(f)
    expect(inspectWithoutChanges(f, { ...ownerScope,
      workspace: configured.workspace, agentPreset: configured.agentPreset }))
      .toEqual({ status: 'unavailable', reason: 'route-unavailable' })
  })

  test('follows ordinary /new binding replacement without revoking the durable owner', async () => {
    const f = await fixture()
    const first = pairAndBind(f)
    const owner = f.store.getPrincipal(principal)!
    const second = f.store.rotateBinding({ bindingId: first.id, expectedVersion: first.version,
      sessionId: 'state-inspection-new-session' })
    expect(f.store.getBinding(first.id)).toMatchObject({ status: 'revoked' })
    expect(inspectWithoutChanges(f)).toEqual({ status: 'active', receipt: {
      ...f.service.validateOwnerRoute(ownerScope), principalRecordId: owner.id,
      principalVersion: owner.version, generation: second.generation, bindingVersion: second.version,
    } })
  })

  test.each(['principal', 'binding'] as const)('keeps a transient %s read failure unavailable without exposing its error', async stage => {
    const f = await fixture()
    pairAndBind(f)
    const read = stage === 'principal' ? 'getPrincipal' : 'getActiveBinding'
    vi.spyOn(f.store, read).mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY private path /secret/owner.sqlite and private principal')
    })
    expect(inspectWithoutChanges(f)).toEqual({ status: 'unavailable', reason: 'inspection-unavailable' })
    expect(inspectWithoutChanges(f)).toEqual({ status: 'active', receipt: f.service.validateOwnerRoute(ownerScope) })
  })

  test('keeps a closed database unavailable without interpreting the missing binding as revocation', async () => {
    const f = await fixture()
    pairAndBind(f)
    f.store.close()
    expect(inspectWithoutChanges(f)).toEqual({ status: 'unavailable', reason: 'inspection-unavailable' })
  })

  test('observes explicit A to B to A handoff as a new owner version while retaining all history', async () => {
    const f = await fixture()
    pairAndBind(f)
    const ownerA = f.store.getPrincipal(principal)!
    const principalB = { ...principal, user: 'ou_other' }
    f.store.handoffOwner(principalB)
    const revoked = inspectWithoutChanges(f)
    expect(revoked).toEqual({ status: 'revoked', authorityId: authority.id,
      authorityHash: ownerRouteAuthorityHash(authority), principalId: ownerScope.principalId,
      principalRecordId: ownerA.id, principalVersion: ownerA.version + 1 })
    const returned = f.store.handoffOwner(principal)
    expect(returned).toMatchObject({ id: ownerA.id, status: 'active', version: ownerA.version + 2 })
    expect(inspectWithoutChanges(f)).toEqual({ status: 'unavailable', reason: 'route-unavailable' })
    const binding = f.store.createBinding({ conversation, principal, workspace: authority.workspace,
      agentPreset: authority.agentPreset, policyRef: authority.policyRef, sessionId: 'state-inspection-returned-A' })
    expect(inspectWithoutChanges(f)).toEqual({ status: 'active', receipt: {
      ...f.service.validateOwnerRoute(ownerScope), principalRecordId: ownerA.id,
      principalVersion: returned.version, generation: binding.generation,
    } })
    expect(f.store.getPrincipal(principalB)).toMatchObject({ role: 'owner', status: 'revoked' })
    await dispose(f)
    const restarted = await mount(f.root)
    expect(inspectWithoutChanges(restarted)).toEqual({ status: 'active', receipt: restarted.service.validateOwnerRoute(ownerScope) })
  })
})

describe('stable owner route authority', () => {
  test('inherits the exact owner conversation model selection, including after restart', async () => {
    const f = await fixture()
    pairAndBind(f)
    const input = { authorityId: authority.id, principalId: 'lark/bot-1/tenant-a/ou_owner',
      workspace: '/work/alpha', agentPreset: 'primary' }
    expect(f.service.inspectOwnerModelSelection(input)).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    f.store.setModelSelection(conversation, { provider: 'chosen-provider', model: 'chosen-model', reasoningEffort: 'high' })
    const selected = f.service.inspectOwnerModelSelection(input)
    expect(selected).toEqual({ provider: 'chosen-provider', model: 'chosen-model', reasoningEffort: 'high' })
    expect(Object.isFrozen(selected)).toBe(true)
    expect(() => f.service.inspectOwnerModelSelection({ ...input, principalId: 'another-owner' })).toThrow(/scope/)
    await f.ctx.fiber.restart()
    contexts.delete(f.ctx)
    const restarted = await mount(f.root)
    expect(restarted.service.inspectOwnerModelSelection(input)).toEqual(selected)
  })

  test('inherits a source session request header instead of stale Agent creation options', async () => {
    const f = await fixture()
    pairAndBind(f)
    const input = { authorityId: authority.id, principalId: 'lark/bot-1/tenant-a/ou_owner',
      workspace: '/work/alpha', agentPreset: 'primary' }
    const sourceAgent = { options: { provider: 'initial', model: 'old' }, session: {
      id: 'delivery-session-1', header: { cwd: '/work/alpha', agentPreset: 'primary' },
      snapshotEvents: () => [{ type: 'request/header', data: { header: {
        config: { provider: 'actual', model: 'selected', reasoningEffort: 'high' },
      } } }],
    } } as unknown as Agent
    expect(f.service.inspectOwnerModelSelection({ ...input, sourceAgent })).toEqual({
      provider: 'actual', model: 'selected', reasoningEffort: 'high',
    })
    const wrong = { ...sourceAgent, session: { ...sourceAgent.session, id: 'another-session' } } as unknown as Agent
    expect(() => f.service.inspectOwnerModelSelection({ ...input, sourceAgent: wrong })).toThrow(/source session/)
    const empty = { ...sourceAgent, session: { ...sourceAgent.session, snapshotEvents: () => [] } } as unknown as Agent
    expect(() => f.service.inspectOwnerModelSelection({ ...input, sourceAgent: empty })).toThrow(/no resolved model/)
  })

  test('resolves the current exact owner binding and follows monotonic /new generations', async () => {
    const f = await fixture()
    const first = pairAndBind(f)
    expect(f.service.resolveOwnerRoute(authority.id)).toMatchObject({
      authorityId: authority.id,
      binding: { id: first.id, generation: 1, status: 'active' },
    })

    const second = f.store.rotateBinding({ bindingId: first.id, expectedVersion: first.version,
      sessionId: 'delivery-session-2' })
    expect(f.service.resolveOwnerRoute(authority.id)).toMatchObject({
      authorityId: authority.id,
      binding: { id: second.id, generation: 2, status: 'active' },
      snapshot: { bindingId: second.id, bindingVersion: second.version, generation: 2,
        minimumGeneration: 1, receiptVersion: 2 },
    })
    const validation = f.service.validateOwnerRoute({
      authorityId: authority.id,
      principalId: 'lark/bot-1/tenant-a/ou_owner',
      workspace: '/work/alpha',
      agentPreset: 'primary',
    })
    expect(validation).toMatchObject({
      receiptVersion: 2,
      authorityId: authority.id,
      principalId: 'lark/bot-1/tenant-a/ou_owner',
      principalRecordId: f.store.getPrincipal(principal)?.id,
      principalVersion: f.store.getPrincipal(principal)?.version,
      workspace: '/work/alpha',
      agentPreset: 'primary',
      bindingVersion: second.version,
      generation: 2,
      authorityHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    expect(validation).not.toHaveProperty('bindingId')
    expect(validation).not.toHaveProperty('conversation')
    expect(() => f.service.validateOwnerRoute({
      authorityId: authority.id,
      principalId: 'lark/bot-1/tenant-a/ou_other',
      workspace: '/work/alpha',
      agentPreset: 'primary',
    })).toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    const authorize = vi.spyOn(f.ctx.assistantPolicy, 'authorize')
    const queued = f.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: 'growth-alert:1', text: 'Growth run failed.' })
    expect(queued).toMatchObject({
      status: 'pending',
      intent: { bindingId: second.id, target: { conversation, principal } },
    })
    expect(queued.intent.metadata).toMatchObject({
      'dsh.route.authority': authority.id,
      'dsh.route.bindingVersion': String(second.version),
      'dsh.route.generation': '2',
      'dsh.route.minimumGeneration': '1',
      'dsh.route.receiptVersion': '2',
    })
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      action: 'send', resource: { kind: 'message', id: `route:${authority.id}` },
    }), expect.any(Object))
  })

  test('fails closed when the configured conversation has no exact active binding', async () => {
    const f = await fixture([{ ...authority, conversation: { ...conversation, chat: 'oc_other' } }])
    pairAndBind(f)
    expect(() => f.service.resolveOwnerRoute(authority.id))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
  })

  test.each([
    ['principal', { principal: { ...principal, user: 'ou_other' } }],
    ['workspace', { workspace: '/work/other' }],
    ['preset', { agentPreset: 'forged' }],
    ['policyRef', { policyRef: 'different-policy' }],
  ] as const)('fails closed when the active binding drifts in %s', async (_label, drift) => {
    const f = await fixture()
    pairAndBind(f, drift)
    expect(() => f.service.resolveOwnerRoute(authority.id))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    expect(() => f.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: `drift:${_label}`, text: 'must not send' }))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
  })

  test('enforces the configured minimum generation without accepting a stale predecessor', async () => {
    const f = await fixture([{ ...authority, minimumGeneration: 2 }])
    const first = pairAndBind(f)
    expect(() => f.service.resolveOwnerRoute(authority.id))
      .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    const second = f.store.rotateBinding({ bindingId: first.id, expectedVersion: first.version,
      sessionId: 'delivery-session-2' })
    expect(f.service.resolveOwnerRoute(authority.id).binding.id).toBe(second.id)
  })

  test('re-resolves atomically when /new wins between initial resolution and Policy authorization', async () => {
    const f = await fixture()
    const first = pairAndBind(f)
    const original = f.ctx.assistantPolicy.authorize.bind(f.ctx.assistantPolicy)
    let rotated = false
    vi.spyOn(f.ctx.assistantPolicy, 'authorize').mockImplementation((request, options) => {
      const decision = original(request, options)
      if (!rotated && request.action === 'send' && request.resource.id === `route:${authority.id}`) {
        rotated = true
        f.store.rotateBinding({ bindingId: first.id, expectedVersion: first.version,
          sessionId: 'delivery-session-race-winner' })
      }
      return decision
    })

    const queued = f.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: 'growth-alert:race', text: 'Growth run failed.' })
    expect(queued.intent.bindingId).toBe(f.store.getActiveBinding(conversation)!.id)
    expect(queued.intent.bindingId).not.toBe(first.id)
  })

  test('replays one immutable Outbox across generation rotation and rejects changed content', async () => {
    const f = await fixture()
    const first = pairAndBind(f)
    const input = { sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: 'growth-alert:stable', text: 'Growth run failed.' }
    const queued = f.service.enqueueBackgroundRoute(input)
    f.store.rotateBinding({ bindingId: first.id, expectedVersion: first.version,
      sessionId: 'delivery-session-2' })

    expect(f.service.enqueueBackgroundRoute({ ...input, idempotencyKey: ` ${input.idempotencyKey} ` })).toEqual(queued)
    expect(() => f.service.enqueueBackgroundRoute({ ...input, text: 'Changed message.' }))
      .toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    expect(f.store.listOutbox({ bindingId: first.id })).toHaveLength(1)
  })

  test('survives Host restart with the configured authority and existing idempotency receipt', async () => {
    const first = await fixture()
    pairAndBind(first)
    const input = { sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: 'growth-alert:restart', text: 'Growth run failed.' }
    const queued = first.service.enqueueBackgroundRoute(input)
    const root = first.root
    await dispose(first)

    const restarted = await mount(root)
    expect(restarted.service.resolveOwnerRoute(authority.id).binding.generation).toBe(1)
    expect(restarted.service.enqueueBackgroundRoute(input)).toEqual(queued)
  })

  test('keeps an ambiguous send terminal on route idempotency replay', async () => {
    const f = await fixture()
    pairAndBind(f)
    const send = vi.fn(async () => ({ outcome: 'unknown' as const, failureCode: 'response-lost' }))
    await f.service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] },
      start: async () => {}, send })
    const input = { sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: 'growth-alert:ambiguous', text: 'Growth run failed.' }
    f.service.enqueueBackgroundRoute(input)
    await f.service.tick()
    await f.service.whenIdle()

    expect(f.service.enqueueBackgroundRoute(input)).toMatchObject({ status: 'unknown_after_send', attemptCount: 1 })
    await f.service.tick()
    await f.service.whenIdle()
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('waits through unknown send reconciliation and patches only the coalesced resolved incident', async () => {
    const f = await fixture()
    pairAndBind(f)
    const incidentId = `incident-${'1'.repeat(64)}`
    const open = incidentUpdate(incidentId, 1, 'open')
    const send = vi.fn(async () => ({ outcome: 'unknown' as const, failureCode: 'response-lost' }))
    const reconcileUnknownSend = vi.fn(async () => ({
      outcome: 'accepted' as const, providerMessageId: 'om_incident_unknown',
    }))
    const updatePresentation = vi.fn(async () => {})
    await f.service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: true, receipts: [], formats: ['plain'] },
      start: async () => {}, send, reconcileUnknownSend, updatePresentation })
    f.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: open.originalOutboxIdempotencyKey, text: `Automation incident ${incidentId}` })
    f.store.publishDeliveryPresentation(open)
    f.store.publishDeliveryPresentation(incidentUpdate(incidentId, 2, 'resolved'))

    await f.service.tick()
    await f.service.whenIdle()
    expect(send).toHaveBeenCalledOnce()
    expect(updatePresentation).not.toHaveBeenCalled()
    const ambiguous = f.store.getOutboxByIdempotencyKey(open.originalOutboxIdempotencyKey)!
    expect(ambiguous).toMatchObject({ status: 'unknown_after_send' })
    expect(ambiguous).not.toHaveProperty('providerMessageId')

    await new Promise(resolve => setTimeout(resolve, 5))
    await f.service.tick()
    await f.service.whenIdle()
    expect(reconcileUnknownSend).toHaveBeenCalledOnce()
    await new Promise(resolve => setTimeout(resolve, 5))
    await f.service.tick()
    await f.service.whenIdle()
    expect(updatePresentation).toHaveBeenCalledOnce()
    expect(updatePresentation).toHaveBeenCalledWith(
      'om_incident_unknown',
      expect.objectContaining({ kind: 'automation-incident', state: 'resolved', incidentRevision: 2 }),
      expect.any(AbortSignal),
    )
    expect(f.service.getDeliveryPresentation(open.presentationKey)).toMatchObject({
      status: 'presented', revision: 2, presentedRevision: 2, providerMessageId: 'om_incident_unknown',
    })
  })

  test('revalidates the exact owner route on every incident patch and fences a revoked update', async () => {
    const f = await fixture()
    pairAndBind(f)
    const incidentId = `incident-${'2'.repeat(64)}`
    const open = incidentUpdate(incidentId, 1, 'open')
    const updatePresentation = vi.fn(async () => {})
    await f.service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] },
      start: async () => {},
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_incident_route' }),
      updatePresentation })
    f.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: open.originalOutboxIdempotencyKey, text: `Automation incident ${incidentId}` })
    f.store.publishDeliveryPresentation(open)
    await f.service.tick()
    await f.service.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 5))
    await f.service.tick()
    await f.service.whenIdle()
    expect(updatePresentation).toHaveBeenCalledOnce()

    vi.spyOn(f.ctx.assistantPolicy, 'authorize').mockReturnValue({
      effect: 'deny', reasonCode: 'default-deny', ruleId: undefined,
    })
    f.store.publishDeliveryPresentation(incidentUpdate(incidentId, 2, 'recovering'))
    await f.service.tick()
    await f.service.whenIdle()
    expect(updatePresentation).toHaveBeenCalledOnce()
    expect(f.service.getDeliveryPresentation(open.presentationKey)).toMatchObject({
      status: 'dead', revision: 2, failureCode: 'owner-route-policy-revoked',
    })
  })

  test('recovers an ambiguous provider update across Host restart without sending a second message', async () => {
    const first = await fixture()
    pairAndBind(first)
    const incidentId = `incident-${'3'.repeat(64)}`
    const open = incidentUpdate(incidentId, 1, 'open')
    const failedUpdate = vi.fn(async () => { throw new Error('provider response lost after update') })
    await first.service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] },
      start: async () => {},
      send: async () => ({ outcome: 'accepted', providerMessageId: 'om_incident_restart' }),
      updatePresentation: failedUpdate })
    first.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: open.originalOutboxIdempotencyKey, text: `Automation incident ${incidentId}` })
    first.store.publishDeliveryPresentation(open)
    await first.service.tick()
    await first.service.whenIdle()
    if (failedUpdate.mock.calls.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 5))
      await first.service.tick()
      await first.service.whenIdle()
    }
    expect(failedUpdate).toHaveBeenCalledOnce()
    expect(first.service.getDeliveryPresentation(open.presentationKey)).toMatchObject({
      status: 'retry_wait', revision: 1,
    })
    const root = first.root
    await dispose(first)

    const restarted = await mount(root)
    const sendAgain = vi.fn(async () => ({ outcome: 'accepted' as const, providerMessageId: 'must-not-send-again' }))
    const recoveredUpdate = vi.fn(async () => {})
    await restarted.service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] },
      start: async () => {}, send: sendAgain, updatePresentation: recoveredUpdate })
    await new Promise(resolve => setTimeout(resolve, 5))
    await restarted.service.tick()
    await restarted.service.whenIdle()
    expect(sendAgain).not.toHaveBeenCalled()
    expect(recoveredUpdate).toHaveBeenCalledWith(
      'om_incident_restart', expect.objectContaining({ kind: 'automation-incident', state: 'open' }),
      expect.any(AbortSignal),
    )
    expect(restarted.service.getDeliveryPresentation(open.presentationKey)).toMatchObject({
      status: 'presented', presentedRevision: 1, providerMessageId: 'om_incident_restart',
    })
  })

  test('loads the same route contract from both v8 migration and native v9 databases', async () => {
    const first = await fixture()
    pairAndBind(first)
    const root = first.root
    await dispose(first)

    const raw = new DatabaseSync(join(root, 'delivery.sqlite'))
    raw.exec(`
      DROP TABLE IF EXISTS delivery_preference_projection_outbox;
      DROP TABLE IF EXISTS trusted_delivery_evaluation_outbox;
      DROP TABLE IF EXISTS workflow_trace_commands;
      DROP TABLE IF EXISTS workflow_trace_outbox;
      DROP TABLE IF EXISTS workflow_trace_current;
      DROP TABLE IF EXISTS workflow_trace_revisions;
      DROP TABLE IF EXISTS workflow_template_registry;
      DROP TABLE IF EXISTS workflow_trace_source;
      DROP TABLE IF EXISTS delivery_presentations;
      DROP TRIGGER IF EXISTS dead_letter_inbox_resolution_fence;
      DROP TRIGGER IF EXISTS dead_letter_outbox_resolution_fence;
      DROP TRIGGER IF EXISTS dead_letter_outbox_cancelled_unknown_fence;
      DROP INDEX IF EXISTS dead_letter_resolution_projection;
      DROP TABLE dead_letter_resolutions;
      DROP TABLE IF EXISTS delivery_owner_objective_commands;
      PRAGMA user_version = 8;
    `)
    raw.close()

    const migrated = await mount(root)
    expect(migrated.service.resolveOwnerRoute(authority.id).binding).toMatchObject({ generation: 1, status: 'active' })
    expect(migrated.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: 'growth-alert:migrated-v8', text: 'Migration still routes.' })).toMatchObject({ status: 'pending' })
    const version = new DatabaseSync(join(root, 'delivery.sqlite'), { readOnly: true })
    expect(version.prepare('PRAGMA user_version').get()).toEqual({ user_version: deliverySchemaVersion })
    version.close()
  })

  test('rejects duplicate or namespace-mismatched Host authority configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-owner-route-invalid-'))
    roots.push(root)
    await expect(mount(root, [authority, authority])).rejects.toThrow(/owner route authority/i)

    const secondRoot = await mkdtemp(join(tmpdir(), 'assistant-delivery-owner-route-invalid-'))
    roots.push(secondRoot)
    await expect(mount(secondRoot, [{ ...authority,
      principal: { ...principal, account: 'different-account' } }])).rejects.toThrow(/owner route authority/i)
  })

  test('rejects malformed route operations before creating a Policy audit entry', async () => {
    const f = await fixture()
    pairAndBind(f)
    const before = f.ctx.assistantPolicy.health().lastAuditSequence
    expect(() => f.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: 'bad\nkey', text: 'must not send' }))
      .toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    expect(f.ctx.assistantPolicy.health().lastAuditSequence).toBe(before)
  })

  test('rebinds a provably-unsent pending route after /new before its first claim', async () => {
    const f = await fixture()
    const first = pairAndBind(f)
    const queued = f.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: 'growth-alert:pending-rotation', text: 'Growth run failed.' })
    const second = f.store.rotateBinding({ bindingId: first.id, expectedVersion: first.version,
      sessionId: 'delivery-session-pending-rotation' })
    const send = vi.fn(async () => ({ outcome: 'accepted' as const, providerMessageId: 'om_pending_rotation' }))
    await f.service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] },
      start: async () => {}, send })

    await f.service.tick()
    await f.service.whenIdle()
    expect(send).toHaveBeenCalledTimes(1)
    expect(f.store.getOutbox(queued.id)).toMatchObject({
      status: 'accepted', intent: { bindingId: second.id, metadata: {
        'dsh.route.generation': '2', 'dsh.route.initialBindingId': first.id,
      } },
    })
  })

  test('rebinds retry_wait only after a provider proved the previous attempt was not sent', async () => {
    const f = await fixture()
    const first = pairAndBind(f)
    const queued = f.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: 'growth-alert:retry-rotation', text: 'Growth run failed.' })
    const send = vi.fn()
      .mockResolvedValueOnce({ outcome: 'not-sent' as const, failureCode: 'provider-unavailable', retryable: true })
      .mockResolvedValueOnce({ outcome: 'accepted' as const, providerMessageId: 'om_retry_rotation' })
    await f.service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] },
      start: async () => {}, send })
    await f.service.tick()
    await f.service.whenIdle()
    expect(f.store.getOutbox(queued.id)).toMatchObject({ status: 'retry_wait', attemptCount: 1 })

    const second = f.store.rotateBinding({ bindingId: first.id, expectedVersion: first.version,
      sessionId: 'delivery-session-retry-rotation' })
    await new Promise(resolve => setTimeout(resolve, 5))
    await f.service.tick()
    await f.service.whenIdle()
    expect(send).toHaveBeenCalledTimes(2)
    expect(f.store.getOutbox(queued.id)).toMatchObject({
      status: 'accepted', attemptCount: 2, intent: { bindingId: second.id },
    })
  })

  test('allows a claimed route to finish when an exact /new rotation commits immediately after claim', async () => {
    const f = await fixture()
    const first = pairAndBind(f)
    const queued = f.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: 'growth-alert:claim-race', text: 'Growth run failed.' })
    const original = DeliveryStore.prototype.claimOutbox
    vi.spyOn(DeliveryStore.prototype, 'claimOutbox').mockImplementationOnce(function (this: DeliveryStore, input) {
      const claims = original.call(this, input)
      f.store.rotateBinding({ bindingId: first.id, expectedVersion: first.version,
        sessionId: 'delivery-session-after-claim' })
      return claims
    })
    const send = vi.fn(async () => ({ outcome: 'accepted' as const, providerMessageId: 'om_claim_race' }))
    await f.service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] },
      start: async () => {}, send })

    await f.service.tick()
    await f.service.whenIdle()
    expect(send).toHaveBeenCalledTimes(1)
    expect(f.store.getOutbox(queued.id)).toMatchObject({ status: 'accepted' })
  })

  test('rechecks exact Policy after claim and fails closed before adapter I/O', async () => {
    const f = await fixture()
    pairAndBind(f)
    const queued = f.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: 'growth-alert:policy-after-claim', text: 'Growth run failed.' })
    const original = DeliveryStore.prototype.claimOutbox
    vi.spyOn(DeliveryStore.prototype, 'claimOutbox').mockImplementationOnce(function (this: DeliveryStore, input) {
      const claims = original.call(this, input)
      vi.spyOn(f.ctx.assistantPolicy, 'authorize').mockReturnValue({
        effect: 'deny', reasonCode: 'default-deny', ruleId: undefined,
      })
      return claims
    })
    const send = vi.fn(async () => ({ outcome: 'accepted' as const, providerMessageId: 'must-not-send' }))
    await f.service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] },
      start: async () => {}, send })

    await f.service.tick()
    await f.service.whenIdle()
    expect(send).not.toHaveBeenCalled()
    expect(f.store.getOutbox(queued.id)).toMatchObject({
      status: 'dead', failureCode: 'owner-route-policy-revoked', attemptCount: 1,
    })
  })

  test('defers a claim-time Policy check exception without consuming the unsent alert', async () => {
    const f = await fixture()
    pairAndBind(f)
    const queued = f.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: 'growth-alert:policy-check-busy-before-claim', text: 'Growth run failed.' })
    vi.spyOn(f.ctx.assistantPolicy, 'authorize').mockImplementationOnce(() => {
      throw new Error('simulated Policy SQLite busy')
    })
    const send = vi.fn(async () => ({ outcome: 'accepted' as const, providerMessageId: 'must-not-send-yet' }))
    await f.service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] },
      start: async () => {}, send })

    await f.service.tick()
    await f.service.whenIdle()
    expect(send).not.toHaveBeenCalled()
    expect(f.store.getOutbox(queued.id)).toMatchObject({
      status: 'retry_wait', failureCode: 'owner-route-policy-check-failed', attemptCount: 0,
    })
  })

  test('retries without provider I/O when the dispatch-time Policy check transiently throws', async () => {
    const f = await fixture()
    pairAndBind(f)
    const queued = f.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: 'growth-alert:policy-check-busy-after-claim', text: 'Growth run failed.' })
    const original = DeliveryStore.prototype.claimOutbox
    vi.spyOn(DeliveryStore.prototype, 'claimOutbox').mockImplementationOnce(function (this: DeliveryStore, input) {
      const claims = original.call(this, input)
      vi.spyOn(f.ctx.assistantPolicy, 'authorize').mockImplementationOnce(() => {
        throw new Error('simulated Policy SQLite busy')
      })
      return claims
    })
    const send = vi.fn(async () => ({ outcome: 'accepted' as const, providerMessageId: 'om_policy_recovered' }))
    await f.service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] },
      start: async () => {}, send })

    await f.service.tick()
    await f.service.whenIdle()
    expect(send).not.toHaveBeenCalled()
    expect(f.store.getOutbox(queued.id)).toMatchObject({
      status: 'retry_wait', failureCode: 'owner-route-policy-check-failed', attemptCount: 1,
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    await f.service.tick()
    await f.service.whenIdle()
    expect(send).toHaveBeenCalledTimes(1)
    expect(f.store.getOutbox(queued.id)).toMatchObject({ status: 'accepted', attemptCount: 2 })
  })

  test.each([
    ['route authority deletion', [] as readonly OwnerRouteAuthority[], true, 'owner-route-authority-revoked'],
    ['Policy revocation', [authority] as readonly OwnerRouteAuthority[], false, 'owner-route-policy-revoked'],
  ] as const)('fails closed with an auditable dead attempt after %s', async (
    _label,
    restartedRoutes,
    routePolicy,
    failureCode,
  ) => {
    const first = await fixture()
    pairAndBind(first)
    const queued = first.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: `growth-alert:t3-revocation:${_label}`, text: 'Growth run failed.' })
    const root = first.root
    await dispose(first)

    const restarted = await mount(root, restartedRoutes, routePolicy)
    const send = vi.fn(async () => ({ outcome: 'accepted' as const, providerMessageId: 'must-not-send' }))
    await restarted.service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] },
      start: async () => {}, send })
    await restarted.service.tick()
    await restarted.service.whenIdle()
    expect(send).not.toHaveBeenCalled()
    expect(restarted.store.getOutbox(queued.id)).toMatchObject({ status: 'dead', failureCode, attemptCount: 1 })
    const audit = new DatabaseSync(join(root, 'delivery.sqlite'), { readOnly: true })
    expect(audit.prepare(`
      SELECT operation, status, failure_code FROM outbox_attempts
      WHERE outbox_id = ? AND attempt_number = 1
    `).get(queued.id)).toEqual({ operation: 'send', status: 'dead', failure_code: failureCode })
    audit.close()
  })

  test.each([
    ['principal', { ...authority, principal: { ...authority.principal, user: 'ou_other' } }],
    ['workspace', { ...authority, workspace: '/work/beta' }],
    ['agent preset', { ...authority, agentPreset: 'secondary' }],
    ['policy ref', { ...authority, policyRef: 'different-owner-policy' }],
  ] as const)('fails closed when the Host-owned route %s drifts across restart', async (_field, changed) => {
    const first = await fixture()
    pairAndBind(first)
    const queued = first.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: `growth-alert:authority-drift:${_field}`, text: 'Growth run failed.' })
    const root = first.root
    await dispose(first)

    const restarted = await mount(root, [changed])
    const send = vi.fn(async () => ({ outcome: 'accepted' as const, providerMessageId: 'must-not-send' }))
    await restarted.service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] },
      start: async () => {}, send })
    await restarted.service.tick()
    await restarted.service.whenIdle()
    expect(send).not.toHaveBeenCalled()
    expect(restarted.store.getOutbox(queued.id)).toMatchObject({
      status: 'dead', failureCode: 'owner-route-authority-changed', attemptCount: 1,
    })
  })

  test('rejects a non-monotonic active generation even when every route scope field still matches', async () => {
    const f = await fixture()
    const first = pairAndBind(f)
    const second = f.store.rotateBinding({ bindingId: first.id, expectedVersion: first.version,
      sessionId: 'delivery-session-generation-2' })
    const queued = f.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: 'growth-alert:generation-regression', text: 'Growth run failed.' })

    // Fault injection models corrupt/rolled-back Host state that public APIs cannot create.
    const database = new DatabaseSync(join(f.root, 'delivery.sqlite'))
    database.exec('BEGIN IMMEDIATE')
    database.prepare(`
      UPDATE conversation_bindings SET status = 'revoked', version = version + 1 WHERE id = ?
    `).run(second.id)
    database.prepare(`
      UPDATE conversation_bindings SET status = 'active', version = version + 1 WHERE id = ?
    `).run(first.id)
    database.exec('COMMIT')
    database.close()

    const send = vi.fn(async () => ({ outcome: 'accepted' as const, providerMessageId: 'must-not-send' }))
    await f.service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] },
      start: async () => {}, send })
    await f.service.tick()
    await f.service.whenIdle()
    expect(send).not.toHaveBeenCalled()
    expect(f.store.getOutbox(queued.id)).toMatchObject({
      status: 'dead', failureCode: 'owner-route-generation-below-floor', attemptCount: 1,
    })
  })

  test('parks an unknown route on its original lineage after /new and never sends it again', async () => {
    const f = await fixture()
    const first = pairAndBind(f)
    const send = vi.fn(async () => ({ outcome: 'unknown' as const, failureCode: 'response-lost' }))
    await f.service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] },
      start: async () => {}, send })
    const queued = f.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: 'growth-alert:unknown-rotation', text: 'Growth run failed.' })
    await f.service.tick()
    await f.service.whenIdle()
    f.store.rotateBinding({ bindingId: first.id, expectedVersion: first.version,
      sessionId: 'delivery-session-after-unknown' })

    await f.service.tick()
    await f.service.whenIdle()
    expect(send).toHaveBeenCalledTimes(1)
    expect(f.store.getOutbox(queued.id)).toMatchObject({
      status: 'unknown_after_send', attemptCount: 1, intent: { bindingId: first.id },
    })
    expect(() => f.store.resolveOutbox({ outboxId: queued.id, expectedAttemptCount: 1,
      resolution: 'retry', operatorId: 'owner-operator' }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
  })

  test('parks a reconciled-not-sent route instead of converting ambiguity into a replay', async () => {
    const f = await fixture()
    pairAndBind(f)
    const send = vi.fn(async () => ({ outcome: 'unknown' as const, failureCode: 'response-lost' }))
    const reconcileUnknownSend = vi.fn(async () => ({ outcome: 'not-sent' as const }))
    await f.service.registerAdapter({ channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: true, receipts: [], formats: ['plain'] },
      start: async () => {}, send, reconcileUnknownSend })
    const queued = f.service.enqueueBackgroundRoute({ sourceId: 'growth-supervisor', authorityId: authority.id,
      idempotencyKey: 'growth-alert:unknown-proved-not-sent', text: 'Growth run failed.' })

    await f.service.tick()
    await f.service.whenIdle()
    await f.service.tick()
    await f.service.whenIdle()
    expect(send).toHaveBeenCalledTimes(1)
    expect(reconcileUnknownSend).toHaveBeenCalledTimes(1)
    expect(f.store.getOutbox(queued.id)).toMatchObject({
      status: 'dead', failureCode: 'owner-route-reconciled-not-sent', attemptCount: 2,
    })
  })
})
