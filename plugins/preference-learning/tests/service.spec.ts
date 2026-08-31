import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type {
  DeliveryPreferenceCompletion,
  DeliveryPreferenceFeedback,
  DeliveryPreferenceEvent,
  DeliveryPreferenceObservation,
  DeliveryPreferenceRegistration,
  DeliveryPreferenceTurnAttestation,
} from '@dsh-enhanced/assistant-delivery'
import {
  AssistantDeliveryService,
  DELIVERY_PREFERENCE_PROJECTION_PROTOCOL,
} from '@dsh-enhanced/assistant-delivery'
import { AssistantPolicyService, setApprovalReviewer } from '@dsh-enhanced/assistant-policy'
import { PersonalMemoryService } from '@dsh-enhanced/personal-memory'
import {
  PREFERENCE_MEMORY_PROMOTION_PROTOCOL,
  isTrustedPreferenceMemoryPromotionProducer,
  withPreferenceMemoryPromotionCancellationDigest,
  withPreferenceMemoryPromotionResultDigest,
  withPreferenceMemoryPromotionSubmissionDigest,
  type PreferenceMemoryPromotionRegistration,
  type PreferenceMemoryPromotionResultAck,
  type PreferenceMemoryPromotionRequest,
  type PreferenceMemoryPromotionResult,
} from '@dsh-enhanced/assistant-growth-contract'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  HOST_RECOVERY_BACKGROUND_ID,
  PreferenceLearningError,
  PreferenceLearningService,
  canonicalPreferenceHostScope,
} from '../src/service.ts'
import { preferencePromotionCancellationUpgradeBindingDigest } from '../src/sqlite.ts'

const roots: string[] = []
const contexts: Context[] = []
const OWNER_LINEAGE = Object.freeze({
  principalRecordId: 'delivery-principal-owner',
  principalVersion: 1,
})
const ADMISSION_EPOCH = '0123456789abcdef0123456789abcdef'
let nextAdmissionSequence = 0

function admissionCursor(sequence = ++nextAdmissionSequence, epoch = ADMISSION_EPOCH) {
  return Object.freeze({ epoch, sequence })
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function agent(workspace = '/work/alpha', preset = 'primary'): Agent {
  const id = SessionId(`preference-agent-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd: workspace,
    agentPreset: preset,
  })
  setApprovalReviewer(session, 'none')
  session.append('approval/policy', { policy: 'never' })
  const append = session.append as unknown as (type: string, data: unknown) => unknown
  append.call(session, 'sandbox/mode', { mode: 'danger-full-access' })
  const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
  return {
    id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    status: 'idle',
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
}

async function harness(options: {
  enabled?: boolean
  allow?: boolean
  allowHost?: boolean
  now?: () => number
  signalTtlMs?: number
  autonomousT1Enabled?: boolean
  deliveryInstall?: 'before' | 'after' | 'none'
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'preference-learning-service-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  const turns = new WeakMap<Agent, Readonly<DeliveryPreferenceTurnAttestation>>()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: options.allow === false ? [] : [
      {
        id: 'allow-preference-domain',
        effect: 'allow',
        subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
        actions: ['review', 'activate', 'rollback', 'snapshot'],
        resource: { kind: '*', id: '*' },
      },
      ...(options.allowHost === false ? [] : [{
        id: 'allow-preference-recovery-host',
        effect: 'allow' as const,
        subject: {
          kind: 'background' as const,
          id: HOST_RECOVERY_BACKGROUND_ID,
          workspace: '/work/alpha',
          principal: 'owner:lark:123',
        },
        actions: ['inspect', 'activate', 'rollback', 'maintain'],
        resource: { kind: 'preference' as const, id: '*' },
        context: { initiators: ['background' as const] },
      }]),
      {
        id: 'allow-preference-tools',
        effect: 'allow',
        subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
        actions: ['execute'],
        resource: { kind: 'tool', id: 'preference_*' },
      },
    ],
  })
  let deliveryService: AssistantDeliveryService | undefined
  let deliveryFiber: Awaited<ReturnType<Context['plugin']>> | undefined
  const mountDelivery = async () => {
    deliveryFiber = await ctx.plugin(AssistantDeliveryService, {
      databasePath: join(root, `delivery-${crypto.randomUUID()}.sqlite`),
      spoolPath: join(root, `spool-${crypto.randomUUID()}`),
      schedulerEnabled: false,
      defaultWorkspace: '/work/alpha',
      defaultAgentPreset: 'primary',
      agentProvider: 'test',
      agentModel: 'test',
    })
    deliveryService = ctx.get('assistantDelivery') as AssistantDeliveryService
    vi.spyOn(deliveryService, 'currentPreferenceTurn').mockImplementation(target => turns.get(target))
    vi.spyOn(deliveryService, 'preferencePrincipalForAgent').mockImplementation(target => Object.freeze({
      scope: Object.freeze({
        workspace: target.session.header.cwd ?? '/work/alpha',
        preset: target.session.header.agentPreset ?? 'primary',
      }),
      principalId: 'owner:lark:123',
      principalLineage: OWNER_LINEAGE,
      bindingId: 'binding-owner',
      bindingVersion: 1,
      bindingGeneration: 1,
      sessionId: String(target.session.id),
    }))
    return deliveryService
  }
  if (options.deliveryInstall !== 'after' && options.deliveryInstall !== 'none') await mountDelivery()
  const databasePath = join(root, 'preferences.sqlite')
  const service = new PreferenceLearningService(ctx, {
    enabled: options.enabled ?? true,
    databasePath,
    minSignalsForActivation: 2,
    autonomousT1Enabled: options.autonomousT1Enabled ?? false,
    ...(options.signalTtlMs === undefined ? {} : { signalTtlMs: options.signalTtlMs }),
  }, options.now === undefined ? {} : { now: options.now })
  if (options.deliveryInstall === 'after') await mountDelivery()
  const currentRegistration = () => (deliveryService as unknown as {
    preferenceFeedbackSink?: { registration: Readonly<DeliveryPreferenceRegistration> }
  } | undefined)?.preferenceFeedbackSink?.registration
  return {
    ctx,
    root,
    databasePath,
    agent: agent(),
    feedback(event: Readonly<DeliveryPreferenceEvent>) {
      const registration = currentRegistration()
      if (registration === undefined) throw new Error('preference feedback listener is unavailable')
      return registration.append([event])
    },
    attestTurn(target: Agent, input: Omit<
      DeliveryPreferenceTurnAttestation,
      'principalId' | 'principalLineage' | 'scope' | 'sessionId'
    > & {
      principalId?: string
      principalLineage?: DeliveryPreferenceTurnAttestation['principalLineage']
    }) {
      turns.set(target, Object.freeze({
        ...input,
        scope: Object.freeze({ workspace: '/work/alpha', preset: 'primary' }),
        principalId: input.principalId ?? 'owner:lark:123',
        principalLineage: input.principalLineage ?? OWNER_LINEAGE,
        sessionId: String(target.session.id),
      }))
    },
    delivery: { currentRegistration },
    actualDelivery: deliveryService,
    async disposeDelivery() { await deliveryFiber?.dispose() },
    async reloadDelivery() { return mountDelivery() },
    service,
  }
}

function call(name: string, args: Record<string, unknown>, withAgent?: Agent) {
  return {
    callId: CallId(`call-${name}-${Math.random()}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
    ...(withAgent === undefined ? {} : { agent: withAgent }),
  }
}

type StructureFeedback = Extract<DeliveryPreferenceFeedback, { preferenceKey: 'response.structure' }>
type MemoryRetentionFeedback = DeliveryPreferenceFeedback & Readonly<{
  preferenceKey: 'memory.retention'
  candidateValue: 'long-term'
}>

function feedbackEvent(
  idempotencyKey: string,
  overrides: Partial<StructureFeedback> = {},
): StructureFeedback {
  return {
    scope: { workspace: '/work/alpha', preset: 'primary' },
    principalId: 'owner:lark:123',
    principalLineage: OWNER_LINEAGE,
    admissionCursor: admissionCursor(),
    preferenceKey: 'response.structure',
    candidateValue: 'bullets',
    stance: 'support',
    actorTrust: 'owner-authenticated',
    interpretationTrust: 'typed-feedback',
    source: 'direct-owner-feedback',
    occurredAt: Date.now(),
    idempotencyKey,
    ...overrides,
  }
}

function appendReady(
  feedback: (event: DeliveryPreferenceEvent) => unknown,
  prefix = 'structure',
): void {
  const occurredAt = Date.now()
  for (let index = 1; index <= 2; index += 1) {
    feedback(feedbackEvent(`${prefix}-${index}`, { occurredAt }))
  }
}

function memoryRetentionFeedback(
  idempotencyKey: string,
  interpretationTrust: 'explicit-selection' | 'typed-feedback',
  occurredAt = Date.now(),
): MemoryRetentionFeedback {
  return {
    scope: { workspace: '/work/alpha', preset: 'primary' },
    principalId: 'owner:lark:123',
    principalLineage: OWNER_LINEAGE,
    admissionCursor: admissionCursor(),
    preferenceKey: 'memory.retention',
    candidateValue: 'long-term',
    stance: 'support',
    actorTrust: 'owner-authenticated',
    interpretationTrust,
    source: 'direct-owner-feedback',
    occurredAt,
    idempotencyKey,
  } as unknown as MemoryRetentionFeedback
}

function observationEvent(
  index: number,
  candidateValue: 'zh-CN' | 'en',
): DeliveryPreferenceObservation {
  return {
    scope: { workspace: '/work/alpha', preset: 'primary' },
    principalId: 'owner:lark:123',
    principalLineage: OWNER_LINEAGE,
    admissionCursor: admissionCursor(),
    preferenceKey: 'response.language',
    candidateValue,
    stance: 'support',
    actorTrust: 'owner-authenticated',
    interpretationTrust: 'behavioral-inference',
    source: 'delivery-observation',
    occurredAt: Date.now(),
    idempotencyKey: `completed-turn-${candidateValue}-${index}`,
    completion: {
      bindingId: 'binding-owner',
      bindingVersion: 1,
      sessionId: 'session-owner',
      sourceEventId: `event-${candidateValue}-${index}`,
      sourceInboxId: `inbox-${candidateValue}-${index}`,
      replyOutboxId: `outbox-${candidateValue}-${index}`,
    },
  }
}

function completionEvent(
  index: number,
  overrides: Partial<DeliveryPreferenceCompletion['completion']> = {},
): DeliveryPreferenceCompletion {
  return {
    scope: { workspace: '/work/alpha', preset: 'primary' },
    principalId: 'owner:lark:123',
    principalLineage: OWNER_LINEAGE,
    admissionCursor: admissionCursor(),
    actorTrust: 'owner-authenticated',
    source: 'delivery-completion',
    occurredAt: Date.now(),
    idempotencyKey: `completed-binding-${index}`,
    completion: {
      bindingId: 'binding-owner', bindingVersion: 1, sessionId: 'session-owner',
      sourceEventId: `event-binding-${index}`, sourceInboxId: `inbox-binding-${index}`,
      replyOutboxId: `outbox-binding-${index}`,
      ...overrides,
    },
  }
}

describe('preference learning service', () => {
  test('compensates confirmed Memory after lost ACK, then reconciles cancellation before result', async () => {
    let clock = Date.now() + 1_000
    const fixture = await harness({ now: () => clock })
    const delivery = fixture.actualDelivery!
    vi.spyOn(delivery, 'prepareOwnerApprovalForPreference').mockImplementation(input => Object.freeze({
      routeVersion: 2 as const,
      sourceId: input.sourceId,
      bindingId: 'binding-owner',
      bindingVersion: input.ownerGeneration,
      bindingGeneration: input.ownerGeneration,
      workspace: input.scope.workspace,
      principal: input.principalId,
      principalRecordId: input.principalLineage.principalRecordId,
      principalVersion: input.principalLineage.principalVersion,
    }))
    const memoryPath = join(fixture.root, 'memory.sqlite')
    const memory = new PersonalMemoryService(fixture.ctx, {
      databasePath: memoryPath, approvalMode: 'delivery-required', reconcileIntervalMs: 0,
    })
    const memoryStore = (memory as unknown as {
      memoryStore: {
        listPendingProposals(limit: number): readonly Readonly<{
          proposalId: string
          principal: string
          version: number
        }>[]
        listPendingPromotionResults(limit: number): readonly unknown[]
      }
    }).memoryStore

    fixture.feedback(memoryRetentionFeedback('memory-compensation-1', 'typed-feedback', clock))
    fixture.feedback(memoryRetentionFeedback('memory-compensation-2', 'explicit-selection', clock))
    fixture.feedback(memoryRetentionFeedback('memory-compensation-3', 'typed-feedback', clock))
    await new Promise(resolve => setImmediate(resolve))
    const pending = memoryStore.listPendingProposals(10)[0]!
    const confirmed = memory.decideProposal({
      proposalId: pending.proposalId, principal: pending.principal,
      expectedVersion: pending.version, decision: 'approved',
      reason: 'confirmed before Preference result acknowledgement',
    })
    expect(confirmed.record).toBeDefined()
    const pendingResults = memoryStore.listPendingPromotionResults(10) as readonly Readonly<{ occurredAt: number }>[]
    expect(pendingResults).toHaveLength(1)
    clock = Math.max(clock, pendingResults[0]!.occurredAt)

    // Simulate a crash/lost result ACK: Preference has not projected the
    // confirmed result when the owner forgets the scope. The next drain must
    // compensate Memory first, persist that cancellation receipt, and only
    // then consume the stale terminal result.
    fixture.service.forgetScope({ workspace: '/work/alpha', preset: 'primary' }, 'forget-after-ack-loss')
    expect(fixture.service.reconcileMemoryPromotions())
      .toEqual({ submitted: 0, cancelled: 1, projected: 1 })
    expect(memoryStore.listPendingPromotionResults(10)).toEqual([])
    expect(fixture.service.reconcileMemoryPromotions())
      .toEqual({ submitted: 0, cancelled: 0, projected: 0 })

    await fixture.ctx.fiber.restart()
    contexts.splice(contexts.indexOf(fixture.ctx), 1)
    const memoryAudit = new DatabaseSync(memoryPath, { readOnly: true })
    expect(memoryAudit.prepare('SELECT status, version FROM memory_records WHERE id = ?')
      .get(confirmed.record!.id)).toEqual({ status: 'removed', version: 2 })
    expect(memoryAudit.prepare(`
      SELECT COUNT(*) AS count FROM memory_tokens WHERE memory_id = ?
    `).get(confirmed.record!.id)).toEqual({ count: 0 })
    expect(memoryAudit.prepare('SELECT COUNT(*) AS count FROM memory_promotion_compensations')
      .get()).toEqual({ count: 1 })
    expect(memoryAudit.prepare('SELECT state FROM memory_promotion_results')
      .get()).toEqual({ state: 'completed' })
    memoryAudit.close()
    const preferenceAudit = new DatabaseSync(fixture.databasePath, { readOnly: true })
    expect(preferenceAudit.prepare('SELECT state FROM preference_memory_promotion_cancellations')
      .get()).toEqual({ state: 'cancelled' })
    preferenceAudit.close()
  })

  test('upgrades an ACKed supersede into a forget and compensates confirmed Memory', async () => {
    let clock = Date.now() + 1_000
    const fixture = await harness({ now: () => clock })
    const delivery = fixture.actualDelivery!
    vi.spyOn(delivery, 'prepareOwnerApprovalForPreference').mockImplementation(input => Object.freeze({
      routeVersion: 2 as const, sourceId: input.sourceId, bindingId: 'binding-owner',
      bindingVersion: input.ownerGeneration, bindingGeneration: input.ownerGeneration,
      workspace: input.scope.workspace, principal: input.principalId,
      principalRecordId: input.principalLineage.principalRecordId,
      principalVersion: input.principalLineage.principalVersion,
    }))
    const memoryPath = join(fixture.root, 'memory-supersede-forget.sqlite')
    const memory = new PersonalMemoryService(fixture.ctx, {
      databasePath: memoryPath, approvalMode: 'delivery-required', reconcileIntervalMs: 0,
    })
    const memoryStore = (memory as unknown as { memoryStore: {
      listPendingProposals(limit: number): readonly Readonly<{
        proposalId: string
        principal: string
        version: number
      }>[]
      listPendingPromotionResults(limit: number): readonly Readonly<{ occurredAt: number }>[]
    } }).memoryStore
    fixture.feedback(memoryRetentionFeedback('memory-supersede-forget-1', 'typed-feedback', clock))
    fixture.feedback(memoryRetentionFeedback('memory-supersede-forget-2', 'explicit-selection', clock))
    fixture.feedback(memoryRetentionFeedback('memory-supersede-forget-3', 'typed-feedback', clock))
    await new Promise(resolve => setImmediate(resolve))
    const pending = memoryStore.listPendingProposals(10)[0]!
    const confirmed = memory.decideProposal({
      proposalId: pending.proposalId, principal: pending.principal, expectedVersion: pending.version,
      decision: 'approved', reason: 'confirmed before stale supersede',
    })
    const [result] = memoryStore.listPendingPromotionResults(10)
    clock = Math.max(clock, result!.occurredAt)

    const preferenceDb = new DatabaseSync(fixture.databasePath)
    const promotion = preferenceDb.prepare(`
      SELECT * FROM preference_memory_promotions
    `).get() as Record<string, string | number>
    const superseded = withPreferenceMemoryPromotionCancellationDigest({
      contractVersion: 1 as const, promotionId: String(promotion['promotion_id']),
      promotionGeneration: Number(promotion['promotion_generation']),
      requestDigest: String(promotion['request_digest']), principalLineage: OWNER_LINEAGE,
      ownerGeneration: Number(promotion['owner_generation']), reason: 'superseded' as const,
      occurredAt: clock,
    })
    preferenceDb.prepare(`
      INSERT INTO preference_memory_promotion_cancellations(
        promotion_id, promotion_generation, request_digest, principal_lineage_id,
        principal_lineage_version, owner_generation, reason, cancelled_at, cancellation_digest,
        state, attempt_count, next_attempt_at, upgrade_binding_digest, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'superseded', ?, ?, 'pending', 0, ?, ?, ?)
    `).run(
      superseded.promotionId, superseded.promotionGeneration, superseded.requestDigest,
      superseded.principalLineage.principalRecordId, superseded.principalLineage.principalVersion,
      superseded.ownerGeneration, superseded.occurredAt, superseded.cancellationDigest, clock,
      preferencePromotionCancellationUpgradeBindingDigest({
        promotionId: superseded.promotionId, promotionGeneration: superseded.promotionGeneration,
        requestDigest: superseded.requestDigest,
        principalLineageId: superseded.principalLineage.principalRecordId,
        principalLineageVersion: superseded.principalLineage.principalVersion,
        ownerGeneration: superseded.ownerGeneration,
      }), clock,
    )
    preferenceDb.close()
    expect(fixture.service.reconcileMemoryPromotions())
      .toEqual({ submitted: 0, cancelled: 1, projected: 1 })
    const redacted = new DatabaseSync(fixture.databasePath)
    expect(redacted.prepare(`
      SELECT reason, state, principal_lineage_id, principal_lineage_version, owner_generation
      FROM preference_memory_promotion_cancellations
    `).get()).toEqual(expect.objectContaining({
      reason: 'superseded', state: 'already-confirmed',
      principal_lineage_version: 1, owner_generation: 1,
      principal_lineage_id: expect.stringMatching(/^redacted-/u),
    }))
    redacted.close()

    fixture.service.forgetScope({ workspace: '/work/alpha', preset: 'primary' }, 'forget-after-supersede-ack')
    expect(fixture.service.reconcileMemoryPromotions())
      .toEqual({ submitted: 0, cancelled: 1, projected: 0 })
    await fixture.ctx.fiber.restart()
    contexts.splice(contexts.indexOf(fixture.ctx), 1)
    const memoryAudit = new DatabaseSync(memoryPath, { readOnly: true })
    expect(memoryAudit.prepare('SELECT status, version FROM memory_records WHERE id = ?')
      .get(confirmed.record!.id)).toEqual({ status: 'removed', version: 2 })
    expect(memoryAudit.prepare('SELECT COUNT(*) AS count FROM memory_tokens WHERE memory_id = ?')
      .get(confirmed.record!.id)).toEqual({ count: 0 })
    expect(memoryAudit.prepare('SELECT COUNT(*) AS count FROM memory_promotion_compensations')
      .get()).toEqual({ count: 1 })
    memoryAudit.close()
    const finalPreference = new DatabaseSync(fixture.databasePath, { readOnly: true })
    expect(finalPreference.prepare(`
      SELECT reason, state, principal_lineage_version, owner_generation
      FROM preference_memory_promotion_cancellations
    `).get()).toEqual({
      reason: 'forget', state: 'cancelled', principal_lineage_version: 1, owner_generation: 1,
    })
    finalPreference.close()
  })

  test('uses one branded Memory registration for durable submission and terminal projection', async () => {
    let clock = Date.now() + 1_000
    const { ctx, feedback, service } = await harness({ now: () => clock })
    expect(isTrustedPreferenceMemoryPromotionProducer(service)).toBe(true)
    expect(isTrustedPreferenceMemoryPromotionProducer({ ...service })).toBe(false)
    let registration: Readonly<PreferenceMemoryPromotionRegistration> | undefined
    const requests: PreferenceMemoryPromotionRequest[] = []
    const results: PreferenceMemoryPromotionResult[] = []
    const acknowledgements: unknown[] = []
    let failFirst = true
    const owner = {
      ownsPreferencePromotionSourceRegistration(value: Readonly<PreferenceMemoryPromotionRegistration>) {
        return value === registration
      },
    }
    registration = Object.freeze({
      protocol: PREFERENCE_MEMORY_PROMOTION_PROTOCOL,
      producer: 'personal-memory' as const,
      sourceGeneration: service.trustedMemoryPromotionProducerGeneration(),
      sinkGeneration: 'memory-generation-1',
      owner,
      propose(request: Readonly<PreferenceMemoryPromotionRequest>) {
        if (failFirst) {
          failFirst = false
          throw new Error('transient Memory outage')
        }
        requests.push(request)
        return withPreferenceMemoryPromotionSubmissionDigest({
          contractVersion: 1 as const, promotionId: request.promotionId,
          promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
          outcome: 'accepted' as const, memoryProposalId: 'memory-proposal-service-1',
        })
      },
      cancelPromotion() { throw new Error('unexpected cancellation') },
      listTerminalResults() { return results.splice(0) },
      acknowledgeTerminalResult(ack: Readonly<PreferenceMemoryPromotionResultAck>) {
        acknowledgements.push(ack)
      },
    })
    const dispose = service.registerTrustedMemoryPromotionResultSink(registration)
    expect(() => service.registerTrustedMemoryPromotionResultSink({ ...registration! }))
      .toThrow(/registration is invalid|already registered/iu)

    feedback(memoryRetentionFeedback('memory-retention-1', 'typed-feedback'))
    feedback(memoryRetentionFeedback('memory-retention-2', 'explicit-selection'))
    feedback(memoryRetentionFeedback('memory-retention-3', 'typed-feedback'))
    await new Promise(resolve => setImmediate(resolve))
    expect(requests).toHaveLength(0)
    // The first automatic drain failed and is durable retry_wait. Re-open it
    // after the fixed 250ms first backoff without reaching into the Store.
    clock += 250
    expect(service.reconcileMemoryPromotions()).toMatchObject({ submitted: 1 })
    expect(requests[0]).toMatchObject({
      hypothesis: { key: 'memory.retention', value: 'long-term',
        supportingSignals: 3, distinctSignalSources: 2 },
      rendererId: 'memory.retention.long-term/v1',
    })
    const request = requests[0]!
    results.push(withPreferenceMemoryPromotionResultDigest({
      contractVersion: 1 as const, promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration, requestDigest: request.requestDigest,
      resultVersion: 1, status: 'confirmed' as const,
      memoryProposalId: 'memory-proposal-service-1', memoryProposalVersion: 2,
      memoryRecordId: 'memory-record-service-1', memoryRecordVersion: 1,
      memoryRecordDigest: 'a'.repeat(64), occurredAt: Date.now(),
    }))
    expect(service.reconcileMemoryPromotions()).toMatchObject({ projected: 1 })
    expect(acknowledgements).toEqual([expect.objectContaining({ outcome: 'applied' })])

    dispose()
    expect(service.reconcileMemoryPromotions()).toEqual({ submitted: 0, cancelled: 0, projected: 0 })
    await ctx.fiber.restart()
    expect(isTrustedPreferenceMemoryPromotionProducer(service)).toBe(false)
    expect(() => service.trustedMemoryPromotionProducerGeneration()).toThrow(/disposed/iu)
    contexts.splice(contexts.indexOf(ctx), 1)
  })

  test.each(['before', 'after'] as const)(
    'binds an exact owned Delivery registration when Delivery installs %s Preference',
    async deliveryInstall => {
      const { delivery, feedback, service } = await harness({ deliveryInstall })
      const registration = delivery.currentRegistration()!
      expect(service.ownsDeliveryPreferenceRegistration(registration)).toBe(true)
      expect(service.ownsDeliveryPreferenceRegistration({ ...registration })).toBe(false)
      expect(feedback(feedbackEvent(`install-${deliveryInstall}`))).toEqual([
        { idempotencyKey: `install-${deliveryInstall}`, status: 'recorded' },
      ])
    },
  )

  test('never gives a genuine owner registration to a shape-compatible fake Delivery', async () => {
    const fixture = await harness({ deliveryInstall: 'none', autonomousT1Enabled: true })
    const register = vi.fn()
    const disposeFake = fixture.ctx.provide('assistantDelivery' as never, {
      trustedPreferenceProducerGeneration: () => 'fake-delivery-generation',
      registerTrustedPreferenceSink: register,
      currentPreferenceTurn: () => undefined,
      protocol: DELIVERY_PREFERENCE_PROJECTION_PROTOCOL,
    } as never)

    expect(register).not.toHaveBeenCalled()
    expect(() => fixture.service.review(fixture.agent)).toThrowError(/exact owner Delivery binding/iu)
    await disposeFake()
  })

  test('reuses the exact same-generation disposer across Cordis wrappers and rebinds after unload', async () => {
    const fixture = await harness({ deliveryInstall: 'before' })
    const first = fixture.delivery.currentRegistration()!
    expect(fixture.service.ownsDeliveryPreferenceRegistration(first)).toBe(true)

    await fixture.disposeDelivery()
    expect(fixture.delivery.currentRegistration()).toBeUndefined()
    expect(fixture.service.ownsDeliveryPreferenceRegistration(first)).toBe(false)

    await fixture.reloadDelivery()
    const reloaded = fixture.delivery.currentRegistration()!
    expect(reloaded).not.toBe(first)
    expect(fixture.service.ownsDeliveryPreferenceRegistration(reloaded)).toBe(true)
    await fixture.disposeDelivery()
    expect(fixture.service.ownsDeliveryPreferenceRegistration(reloaded)).toBe(false)
  })

  test('automatically applies repeated completed-turn language use without a command', async () => {
    const { ctx, agent: target, feedback } = await harness({ autonomousT1Enabled: true })
    for (let index = 1; index <= 5; index += 1) feedback(observationEvent(index, 'zh-CN'))
    expect(ctx.assistantPreferenceLearning.review(target).hypotheses[0]).toMatchObject({
      candidateValue: 'zh-CN', effectState: 'shadow', supportingSignals: 5,
    })
    feedback(observationEvent(6, 'zh-CN'))
    expect(ctx.assistantPreferenceLearning.review(target)).toMatchObject({
      activeOverlay: expect.stringContaining('Simplified Chinese'),
      hypotheses: expect.arrayContaining([expect.objectContaining({
        candidateValue: 'zh-CN', effectState: 'active',
      })]),
    })

    feedback(observationEvent(7, 'en'))
    expect(ctx.assistantPreferenceLearning.review(target).activeOverlay).toContain('Simplified Chinese')
    for (let index = 8; index <= 12; index += 1) feedback(observationEvent(index, 'en'))
    const adapted = ctx.assistantPreferenceLearning.review(target)
    expect(adapted.activeOverlay).toContain('Respond in English')
    expect(adapted.hypotheses).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateValue: 'zh-CN', effectState: 'rolled-back' }),
      expect.objectContaining({ candidateValue: 'en', effectState: 'active' }),
    ]))
  })

  test('replays an exact committed batch after a lost Delivery ACK without duplicate evidence', async () => {
    const { databasePath, feedback } = await harness({ autonomousT1Enabled: true })
    const event = feedbackEvent('ack-lost-explicit', {
      interpretationTrust: 'explicit-selection',
      occurredAt: Date.now(),
    })
    expect(feedback(event)).toEqual([{ idempotencyKey: event.idempotencyKey, status: 'recorded' }])
    // Simulate Preference commit followed by process/transport loss before Delivery
    // durably deletes its projection row: the same authoritative batch is replayed.
    expect(feedback(event)).toEqual([{ idempotencyKey: event.idempotencyKey, status: 'recorded' }])

    const database = new DatabaseSync(databasePath, { readOnly: true })
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM preference_signals
    `).get()).toEqual({ count: 1 })
    expect(database.prepare(`
      SELECT supporting_signals FROM preference_hypotheses
      WHERE preference_key = 'response.structure' AND candidate_value = 'bullets'
    `).get()).toEqual({ supporting_signals: 1 })
    database.close()
  })

  test('fails closed on owner switch and ignores an older deferred principal replay monotonically', async () => {
    const { agent: target, attestTurn, databasePath, feedback, ctx } =
      await harness({ autonomousT1Enabled: true })
    const ownerA = 'owner:lark:A'
    const ownerB = 'owner:lark:B'
    const base = Date.now() - 200
    feedback(feedbackEvent('owner-a-active', {
      principalId: ownerA,
      admissionCursor: admissionCursor(10),
      interpretationTrust: 'explicit-selection',
      occurredAt: base,
    }))
    attestTurn(target, {
      principalId: ownerA,
      bindingId: 'binding-a', bindingVersion: 1,
      sourceEventId: 'owner-a-turn', sourceInboxId: 'owner-a-inbox', turn: 1,
    })
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target })))
      .toContain('Prefer bullet lists')

    // The replacement owner sees no inherited overlay before their first
    // authenticated completion/selection claims and resets the scope.
    attestTurn(target, {
      principalId: ownerB,
      bindingId: 'binding-b', bindingVersion: 1,
      sourceEventId: 'owner-b-first-turn', sourceInboxId: 'owner-b-first-inbox', turn: 2,
    })
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target }))).toBe('')
    feedback(feedbackEvent('owner-b-current', {
      principalId: ownerB,
      admissionCursor: admissionCursor(30),
      candidateValue: 'prose',
      interpretationTrust: 'explicit-selection',
      occurredAt: base + 100,
    }))
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target })))
      .toContain('Prefer prose over lists')
    expect(ctx.assistantPreferenceLearning.review(target).hypotheses).toEqual([])
    expect(() => ctx.assistantPreferenceLearning.hostReview({
      scope: canonicalPreferenceHostScope({ workspace: '/work/alpha', preset: 'primary' }),
      principal: 'owner:lark:123',
      principalLineage: OWNER_LINEAGE,
      ownerGeneration: 2,
      operationId: 'owner-switch-old-host-review',
    })).toThrowError(/owner lineage|principal/iu)

    const delayed = feedbackEvent('owner-a-delayed', {
      principalId: ownerA,
      admissionCursor: admissionCursor(20),
      interpretationTrust: 'explicit-selection',
      occurredAt: base + 50,
    })
    expect(feedback(delayed)).toEqual([{
      idempotencyKey: delayed.idempotencyKey,
      status: 'recorded',
    }])
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target })))
      .toContain('Prefer prose over lists')

    const database = new DatabaseSync(databasePath, { readOnly: true })
    expect(database.prepare(`
      SELECT candidate_value, COUNT(*) AS count FROM preference_signals
      GROUP BY candidate_value ORDER BY candidate_value
    `).all()).toEqual([{ candidate_value: 'prose', count: 1 }])
    expect(database.prepare(`
      SELECT generation, claimed_at, purge_pending FROM preference_scope_principals
    `).get()).toEqual({ generation: 2, claimed_at: base + 100, purge_pending: 0 })
    database.close()
  })

  test('ignores a delayed A1 projection after A1 to B2 to A3 owner-lineage rotation', async () => {
    const { databasePath, feedback } = await harness({ autonomousT1Enabled: true })
    const base = Date.now() - 1_000
    const lineageA1 = Object.freeze({ principalRecordId: 'principal-a', principalVersion: 1 })
    const lineageB2 = Object.freeze({ principalRecordId: 'principal-b', principalVersion: 2 })
    const lineageA3 = Object.freeze({ principalRecordId: 'principal-a', principalVersion: 3 })

    feedback(feedbackEvent('lineage-a1', {
      principalId: 'owner:lark:A',
      principalLineage: lineageA1,
      admissionCursor: admissionCursor(100),
      interpretationTrust: 'explicit-selection',
      occurredAt: base + 100,
    }))
    feedback(feedbackEvent('lineage-b2', {
      principalId: 'owner:lark:B',
      principalLineage: lineageB2,
      admissionCursor: admissionCursor(200),
      candidateValue: 'prose',
      interpretationTrust: 'explicit-selection',
      occurredAt: base + 200,
    }))
    feedback(feedbackEvent('lineage-a3', {
      principalId: 'owner:lark:A',
      principalLineage: lineageA3,
      admissionCursor: admissionCursor(300),
      interpretationTrust: 'explicit-selection',
      occurredAt: base + 300,
    }))
    const delayedA1 = feedbackEvent('lineage-a1-delayed', {
      principalId: 'owner:lark:A',
      principalLineage: lineageA1,
      admissionCursor: admissionCursor(150),
      candidateValue: 'prose',
      interpretationTrust: 'explicit-selection',
      occurredAt: base + 150,
    })
    expect(feedback(delayedA1)).toEqual([{
      idempotencyKey: delayedA1.idempotencyKey,
      status: 'recorded',
    }])

    const database = new DatabaseSync(databasePath, { readOnly: true })
    expect(database.prepare(`
      SELECT candidate_value, COUNT(*) AS count FROM preference_signals
      GROUP BY candidate_value ORDER BY candidate_value
    `).all()).toEqual([{ candidate_value: 'bullets', count: 1 }])
    expect(database.prepare(`
      SELECT generation, principal_lineage_id, principal_lineage_version
      FROM preference_scope_principals
    `).get()).toEqual({
      generation: 3,
      principal_lineage_id: lineageA3.principalRecordId,
      principal_lineage_version: lineageA3.principalVersion,
    })
    database.close()
  })

  test('does not reveal A1 hypotheses to a returning A3 before its first projection arrives', async () => {
    const { ctx, agent: target, feedback } = await harness({ autonomousT1Enabled: true })
    feedback(feedbackEvent('same-external-owner-a1', {
      interpretationTrust: 'explicit-selection',
    }))
    expect(ctx.assistantPreferenceLearning.review(target).hypotheses).toHaveLength(1)

    vi.mocked(ctx.assistantDelivery.preferencePrincipalForAgent).mockImplementation(agent => Object.freeze({
      scope: Object.freeze({ workspace: '/work/alpha', preset: 'primary' }),
      principalId: 'owner:lark:123',
      principalLineage: Object.freeze({
        principalRecordId: OWNER_LINEAGE.principalRecordId,
        principalVersion: OWNER_LINEAGE.principalVersion + 2,
      }),
      bindingId: 'binding-owner-a3',
      bindingVersion: 3,
      bindingGeneration: 3,
      sessionId: String(agent!.session.id),
    }))

    expect(ctx.assistantPreferenceLearning.review(target)).toEqual({
      hypotheses: [],
      activeOverlay: undefined,
    })
  })

  test('automatically applies one exact owner selection but never a public observation', async () => {
    const { ctx, agent: target, feedback } = await harness({ autonomousT1Enabled: true })
    for (let index = 1; index <= 20; index += 1) {
      ctx.assistantPreferenceLearning.appendObservation({
        scope: { workspace: '/work/alpha', preset: 'primary' },
        preferenceKey: 'response.structure', candidateValue: 'bullets', stance: 'support',
        interpretationTrust: 'behavioral-inference', source: 'delivery-observation',
        occurredAt: Date.now(), idempotencyKey: `public-${index}`,
      })
    }
    expect(ctx.assistantPreferenceLearning.review(target).activeOverlay).toBeUndefined()
    feedback(feedbackEvent('one-explicit', { interpretationTrust: 'explicit-selection' }))
    expect(ctx.assistantPreferenceLearning.review(target).activeOverlay).toContain('bullet lists')
  })

  test('owner controls pause projection/injection, resume after a cutoff, and forget without unpausing', async () => {
    let now = 10_000
    const { ctx, agent: target, attestTurn, delivery, feedback } = await harness({
      autonomousT1Enabled: true,
      now: () => now,
    })
    feedback(feedbackEvent('control-initial', {
      interpretationTrust: 'explicit-selection',
      occurredAt: 9_500,
    }))
    attestTurn(target, {
      bindingId: 'binding-owner', bindingVersion: 1,
      sourceEventId: 'control-turn', sourceInboxId: 'control-inbox', turn: 1,
    })
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target })))
      .toContain('bullet lists')

    const control = delivery.currentRegistration()!.control!
    expect(await control({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      principalId: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      admissionCursor: admissionCursor(),
      action: 'pause', occurredAt: now, idempotencyKey: 'control-pause',
    })).toMatchObject({ outcome: 'applied', state: { mode: 'paused' } })
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target }))).toBe('')

    now = 10_100
    const queued = feedbackEvent('control-queued-while-paused', {
      candidateValue: 'prose',
      interpretationTrust: 'explicit-selection',
      occurredAt: 10_050,
    })
    expect(feedback(queued)).toEqual([{ idempotencyKey: queued.idempotencyKey, status: 'recorded' }])
    expect(ctx.assistantPreferenceLearning.health().signals).toBe(1)
    expect(await control({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      principalId: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      admissionCursor: admissionCursor(),
      action: 'resume', occurredAt: now, idempotencyKey: 'control-resume',
    })).toMatchObject({ outcome: 'applied', state: { mode: 'active' } })
    expect(feedback({ ...queued, idempotencyKey: 'control-queued-after-resume' }))
      .toEqual([{ idempotencyKey: 'control-queued-after-resume', status: 'recorded' }])
    expect(ctx.assistantPreferenceLearning.health().signals).toBe(1)

    now = 10_101
    feedback(feedbackEvent('control-new-after-resume', {
      candidateValue: 'prose',
      interpretationTrust: 'explicit-selection',
      occurredAt: now,
    }))
    expect(ctx.assistantPreferenceLearning.health().signals).toBe(2)
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target })))
      .toContain('prose over lists')

    now = 10_200
    await control({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      principalId: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      admissionCursor: admissionCursor(),
      action: 'pause', occurredAt: now, idempotencyKey: 'control-pause-before-forget',
    })
    now = 10_201
    expect(await control({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      principalId: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      admissionCursor: admissionCursor(),
      action: 'forget', occurredAt: now, idempotencyKey: 'control-forget-confirmed',
    })).toMatchObject({
      outcome: 'applied', deletedSignals: 2, deletedHypotheses: 2,
      state: { mode: 'paused', signals: 0, hypotheses: 0 },
    })
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target }))).toBe('')
  })

  test('replays the exact historical pause receipt after resume and new evidence', async () => {
    const { delivery, feedback } = await harness({ autonomousT1Enabled: true })
    feedback(feedbackEvent('receipt-initial', { interpretationTrust: 'explicit-selection' }))
    const control = delivery.currentRegistration()!.control!
    const pause = Object.freeze({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      principalId: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      admissionCursor: admissionCursor(),
      action: 'pause' as const, occurredAt: Date.now(), idempotencyKey: 'receipt-pause',
    })
    const first = await control(pause)
    expect(first).toMatchObject({
      outcome: 'applied', replayed: false, state: { mode: 'paused', signals: 1 },
    })
    await control({
      ...pause,
      admissionCursor: admissionCursor(),
      action: 'resume',
      idempotencyKey: 'receipt-resume',
    })
    feedback(feedbackEvent('receipt-later-evidence', {
      candidateValue: 'prose', interpretationTrust: 'explicit-selection',
    }))
    const replay = await control(pause)
    expect(replay).toMatchObject({ outcome: 'applied', replayed: true })
    if (first.outcome !== 'applied' || replay.outcome !== 'applied') throw new Error('expected applied receipts')
    expect(replay.state).toEqual(first.state)
  })

  test('explains content-free T1 state and rolls back one exact key through owner control', async () => {
    const { ctx, databasePath, delivery, feedback } = await harness({ autonomousT1Enabled: true })
    feedback(feedbackEvent('owner-control-explain-active', {
      interpretationTrust: 'explicit-selection',
    }))
    const control = delivery.currentRegistration()!.control!
    const explainRequest = Object.freeze({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      principalId: 'owner:lark:123',
      principalLineage: OWNER_LINEAGE,
      admissionCursor: admissionCursor(),
      action: 'explain' as const,
      occurredAt: Date.now(),
      idempotencyKey: 'owner-control-explain',
    })
    const explained = await control(explainRequest)
    expect(explained).toMatchObject({
      outcome: 'applied', replayed: false,
      explanation: [{
        key: 'response.structure', value: 'bullets', state: 'active',
        supportingSignals: 1, contradictingSignals: 0,
      }],
    })
    expect(JSON.stringify(explained)).not.toContain('owner:lark:123')
    expect(await control(explainRequest)).toEqual({ ...explained, replayed: true })

    const rollbackRequest = Object.freeze({
      ...explainRequest,
      admissionCursor: admissionCursor(),
      action: 'rollback' as const,
      preferenceKey: 'response.structure',
      idempotencyKey: 'owner-control-rollback',
    })
    const rolledBack = await control(rollbackRequest)
    expect(rolledBack).toMatchObject({
      outcome: 'applied', replayed: false, rolledBack: true,
      state: { storedActiveOverlays: 0, effectiveActiveOverlays: 0 },
    })
    expect(ctx.assistantPreferenceLearning.overlayForAgent(agent())).toBeUndefined()
    expect(await control(rollbackRequest)).toEqual({ ...rolledBack, replayed: true })

    const noActive = await control({
      ...rollbackRequest,
      admissionCursor: admissionCursor(),
      idempotencyKey: 'owner-control-rollback-no-active',
    })
    expect(noActive).toMatchObject({ outcome: 'applied', rolledBack: false })

    await control({
      ...explainRequest,
      admissionCursor: admissionCursor(),
      action: 'forget',
      idempotencyKey: 'owner-control-forget-after-explain',
    })
    const database = new DatabaseSync(databasePath, { readOnly: true })
    expect(database.prepare('SELECT action FROM preference_owner_control_receipts').all())
      .toEqual([{ action: 'forget' }])
    database.close()
  })

  test('exports a versioned content-free T1 snapshot through the trusted owner control', async () => {
    const { delivery, feedback } = await harness({ autonomousT1Enabled: true })
    feedback(feedbackEvent('owner-control-export-active', {
      interpretationTrust: 'explicit-selection',
    }))
    const control = delivery.currentRegistration()!.control!
    const request = Object.freeze({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      principalId: 'owner:lark:123',
      principalLineage: OWNER_LINEAGE,
      admissionCursor: admissionCursor(),
      action: 'export' as const,
      occurredAt: Date.now(),
      idempotencyKey: 'owner-control-export',
    })
    const exported = await control(request)
    expect(exported).toMatchObject({
      outcome: 'applied', replayed: false,
      exportDocument: {
        format: 'dsh-preference-learning', version: 1,
        records: [{ key: 'response.structure', value: 'bullets', state: 'active' }],
      },
    })
    const json = JSON.stringify(exported.outcome === 'applied' ? exported.exportDocument : {})
    expect(json).not.toMatch(/owner:lark|work\/alpha|principal|lineage|admission|idempot|inbox|outbox/iu)
    expect(await control(request)).toEqual({ ...exported, replayed: true })
  })

  test('ACK-ignores legacy projections and marks a cursorless control stale', async () => {
    const { ctx, databasePath, delivery, feedback } = await harness()
    const modern = feedbackEvent('legacy-without-cursor')
    const { admissionCursor: _cursor, ...legacy } = modern
    expect(feedback(legacy)).toEqual([{
      idempotencyKey: legacy.idempotencyKey,
      status: 'recorded',
    }])
    const control = delivery.currentRegistration()!.control!
    const legacyControl = {
      scope: { workspace: '/work/alpha', preset: 'primary' },
      principalId: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      action: 'pause', occurredAt: Date.now(), idempotencyKey: 'legacy-control-without-cursor',
    } as unknown as Parameters<typeof control>[0]
    expect(await control(legacyControl)).toEqual({
      outcome: 'stale', action: 'pause', idempotencyKey: legacyControl.idempotencyKey,
    })
    expect(ctx.assistantPreferenceLearning.health()).toMatchObject({ signals: 0, hypotheses: 0 })
    const database = new DatabaseSync(databasePath, { readOnly: true })
    expect(database.prepare('SELECT COUNT(*) AS count FROM preference_scope_principals').get())
      .toEqual({ count: 0 })
    database.close()
  })

  test('binds the exact injected hypothesis version to a completed reply and corrects that exposure', async () => {
    const { ctx, agent: target, attestTurn, databasePath, feedback } =
      await harness({ autonomousT1Enabled: true })
    feedback(feedbackEvent('initial-explicit', { interpretationTrust: 'explicit-selection' }))
    target.session.append('turn/start', { turn: 1 })
    target.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Please format this response.' }],
      source: {
        kind: 'delivery', channel: 'lark', account: 'bot', eventId: 'event-exposed', trust: 'untrusted',
      } as never,
    }), { surfaceOp: 'append' })
    attestTurn(target, {
      bindingId: 'binding-owner', bindingVersion: 1, sourceEventId: 'event-exposed',
      sourceInboxId: 'inbox-exposed', turn: 1,
    })
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target })))
      .toContain('bullet lists')

    feedback(completionEvent(30, {
      sessionId: String(target.session.id), sourceEventId: 'event-exposed',
      sourceInboxId: 'inbox-exposed', replyOutboxId: 'outbox-exposed',
    }))
    feedback(feedbackEvent('exact-exposure-correction', {
      candidateValue: 'prose',
      interpretationTrust: 'explicit-selection',
      exposureTarget: { sourceInboxId: 'inbox-exposed', sourceOutboxId: 'outbox-exposed' },
    }))
    const review = ctx.assistantPreferenceLearning.review(target)
    expect(review.activeOverlay).toContain('prose over lists')
    expect(review.hypotheses).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateValue: 'bullets', effectState: 'rolled-back' }),
      expect.objectContaining({ candidateValue: 'prose', effectState: 'active' }),
    ]))
    const database = new DatabaseSync(databasePath, { readOnly: true })
    expect((database.prepare(`
      SELECT COUNT(*) AS count FROM preference_exposure_corrections
      WHERE source_inbox_id = 'inbox-exposed' AND reply_outbox_id = 'outbox-exposed'
    `).get() as { count: number }).count).toBe(1)
    database.close()
  })

  test('Host recovery uses an immutable explicit scope and background Policy identity without an Agent', async () => {
    const { ctx, feedback } = await harness()
    appendReady(feedback)
    const scope = canonicalPreferenceHostScope({ workspace: '/work/alpha', preset: 'primary' })
    expect(Object.isFrozen(scope)).toBe(true)

    const authorize = vi.spyOn(ctx.assistantPolicy, 'authorize')
    const review = ctx.assistantPreferenceLearning.hostReview({
      scope,
      principal: 'owner:lark:123',
      principalLineage: OWNER_LINEAGE,
      ownerGeneration: 1,
      operationId: 'growth-run:review:1',
      limit: 2,
    })
    expect(review.hypotheses).toHaveLength(1)
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      subject: {
        kind: 'background', id: HOST_RECOVERY_BACKGROUND_ID,
        workspace: '/work/alpha', principal: 'owner:lark:123',
      },
      action: 'inspect',
      resource: { kind: 'preference', id: 'hypotheses' },
      context: { initiator: 'background' },
    }), expect.objectContaining({ idempotencyKey: expect.stringMatching(/^preference-host:[a-f0-9]{64}$/u) }))

    expect(() => ctx.assistantPreferenceLearning.hostReview({
      scope: { ...scope } as typeof scope,
      principal: 'owner:lark:123',
      principalLineage: OWNER_LINEAGE,
      ownerGeneration: 1,
      operationId: 'growth-run:review:forged',
    })).toThrowError(expect.objectContaining<Partial<PreferenceLearningError>>({ code: 'invalid-scope' }))
    expect(() => ctx.assistantPreferenceLearning.hostReview({
      scope,
      principal: 'owner:lark:other',
      principalLineage: OWNER_LINEAGE,
      ownerGeneration: 1,
      operationId: 'growth-run:review:wrong-owner',
    })).toThrowError(expect.objectContaining<Partial<PreferenceLearningError>>({ code: 'policy-denied' }))
  })

  test('Host activation is singular, owner-attested, T1-only and exact-version CAS', async () => {
    const { ctx, feedback } = await harness()
    const scope = canonicalPreferenceHostScope({ workspace: '/work/alpha', preset: 'primary' })
    for (let index = 1; index <= 2; index += 1) {
      ctx.assistantPreferenceLearning.appendObservation({
        scope,
        preferenceKey: 'response.structure', candidateValue: 'bullets', stance: 'support',
        interpretationTrust: 'behavioral-inference', source: 'system-observation',
        occurredAt: Date.now(), idempotencyKey: `host-unattested:${index}`,
      })
    }
    expect(() => ctx.assistantPreferenceLearning.hostReview({
      scope, principal: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      ownerGeneration: 1, operationId: 'growth-run:unattested-review',
    })).toThrowError(/owner lineage|principal fence/iu)
    expect(() => ctx.assistantPreferenceLearning.hostActivationCandidate({
      scope, principal: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      ownerGeneration: 1, operationId: 'growth-run:unattested-candidate',
    })).toThrowError(/owner lineage|principal fence/iu)
    appendReady(feedback, 'host-owner')
    expect(ctx.assistantPreferenceLearning.hostOwnerFence({
      scope, principal: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      operationId: 'growth-run:owner-fence',
    })).toEqual({
      ownerGeneration: 1,
      principalLineage: OWNER_LINEAGE,
    })
    const candidate = ctx.assistantPreferenceLearning.hostActivationCandidate({
      scope, principal: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      ownerGeneration: 1, operationId: 'growth-run:ready-candidate',
    })!
    const ready = ctx.assistantPreferenceLearning.hostReview({
      scope, principal: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      ownerGeneration: 1, operationId: 'growth-run:ready-review',
    }).hypotheses.find(item => item.id === candidate.hypothesisId)!
    expect(candidate).toEqual({
      hypothesisId: ready.id,
      expectedVersion: ready.version,
      ownerGeneration: 1,
      principalLineage: OWNER_LINEAGE,
    })
    const activation = ctx.assistantPreferenceLearning.hostActivateOne({
      scope, principal: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      ownerGeneration: 1, operationId: 'growth-run:activate-one',
      hypothesisId: ready.id, expectedVersion: ready.version,
    })
    expect(activation).toEqual({
      hypothesisId: ready.id, expectedVersion: ready.version,
      resultVersion: ready.version + 1, ownerGeneration: 1,
      principalLineageId: OWNER_LINEAGE.principalRecordId,
      principalLineageVersion: OWNER_LINEAGE.principalVersion,
      replayed: false,
    })
    expect(ctx.assistantPreferenceLearning.hostActivateOne({
      scope, principal: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      ownerGeneration: 1, operationId: 'growth-run:activate-one',
      hypothesisId: ready.id, expectedVersion: ready.version,
    })).toEqual({ ...activation, replayed: true })
    const active = ctx.assistantPreferenceLearning.hostReview({
      scope, principal: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      ownerGeneration: 1, operationId: 'growth-run:active-review',
    }).hypotheses.find(item => item.id === ready.id)!
    expect(active).toMatchObject({ riskTier: 'T1', effectState: 'active', version: ready.version + 1 })
    expect(ctx.assistantPreferenceLearning.hostActivationCandidate({
      scope, principal: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      ownerGeneration: 1, operationId: 'growth-run:post-active-candidate',
    })).toBeUndefined()
    expect(() => ctx.assistantPreferenceLearning.hostActivateOne({
      scope, principal: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      ownerGeneration: 1, operationId: 'growth-run:activate-stale',
      hypothesisId: ready.id, expectedVersion: ready.version,
    })).toThrowError(/version|conflict|activatable/iu)

    const rolledBack = ctx.assistantPreferenceLearning.hostRollbackOne({
      scope, principal: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      ownerGeneration: 1, operationId: 'growth-run:rollback-one',
      hypothesisId: active.id, expectedVersion: active.version,
    })
    expect(rolledBack).toMatchObject({ effectState: 'rolled-back', version: active.version + 1 })
  })

  test('Host retention deletes at most one expired exact-scope signal and replays durably', async () => {
    let now = 3_000_000_000
    const ttl = 2_592_000_000
    const { ctx, feedback } = await harness({ now: () => now, signalTtlMs: ttl })
    for (const workspace of ['/work/alpha', '/work/beta']) {
      for (let index = 1; index <= 2; index += 1) {
        feedback(feedbackEvent(`retention:${workspace}:${index}`, {
          scope: { workspace, preset: 'primary' }, occurredAt: now,
        }))
      }
    }
    expect(ctx.assistantPreferenceLearning.health().signals).toBe(4)
    now += ttl + 1
    const scope = canonicalPreferenceHostScope({ workspace: '/work/alpha', preset: 'primary' })

    expect(ctx.assistantPreferenceLearning.hostMaintainOne({
      scope, principal: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      ownerGeneration: 1, operationId: 'growth-run:retention:1',
    })).toEqual({
      deletedSignals: 1, replayed: false, ownerGeneration: 1,
      principalLineageId: OWNER_LINEAGE.principalRecordId,
      principalLineageVersion: OWNER_LINEAGE.principalVersion,
    })
    expect(ctx.assistantPreferenceLearning.health().signals).toBe(3)
    expect(ctx.assistantPreferenceLearning.hostMaintainOne({
      scope, principal: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      ownerGeneration: 1, operationId: 'growth-run:retention:1',
    })).toEqual({
      deletedSignals: 1, replayed: true, ownerGeneration: 1,
      principalLineageId: OWNER_LINEAGE.principalRecordId,
      principalLineageVersion: OWNER_LINEAGE.principalVersion,
    })
    expect(ctx.assistantPreferenceLearning.health().signals).toBe(3)
    expect(ctx.assistantPreferenceLearning.hostMaintainOne({
      scope, principal: 'owner:lark:123', principalLineage: OWNER_LINEAGE,
      ownerGeneration: 1, operationId: 'growth-run:retention:2',
    })).toEqual({
      deletedSignals: 1, replayed: false, ownerGeneration: 1,
      principalLineageId: OWNER_LINEAGE.principalRecordId,
      principalLineageVersion: OWNER_LINEAGE.principalVersion,
    })
    expect(ctx.assistantPreferenceLearning.health().signals).toBe(2)
  })
  test('registers exactly three tools and accepts owner feedback only through Delivery attestation', async () => {
    const { ctx, agent: target, feedback } = await harness()
    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('preference_')).sort())
      .toEqual(['preference_activate', 'preference_review', 'preference_rollback'])
    appendReady(feedback)
    expect(ctx.assistantPreferenceLearning.review(target).hypotheses[0]).toMatchObject({
      preferenceKey: 'response.structure', candidateValue: 'bullets', effectState: 'shadow',
    })
    expect((ctx.assistantPreferenceLearning as unknown as Record<string, unknown>).appendSignal).toBeUndefined()
    expect(() => ctx.assistantPreferenceLearning.appendObservation({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      preferenceKey: 'response.structure', candidateValue: 'bullets', stance: 'support',
      interpretationTrust: 'typed-feedback', source: 'direct-owner-feedback',
      occurredAt: Date.now(), idempotencyKey: 'forged-owner',
    } as never)).toThrowError(expect.objectContaining<Partial<PreferenceLearningError>>({
      code: 'unattested-signal',
    }))
  })

  test('domain authorization fails closed for missing, cross-scope, or denied Agents', async () => {
    const { ctx, agent: target } = await harness({ allow: false })
    expect(() => ctx.assistantPreferenceLearning.review(undefined))
      .toThrowError(expect.objectContaining<Partial<PreferenceLearningError>>({ code: 'missing-agent' }))
    expect(() => ctx.assistantPreferenceLearning.review(target))
      .toThrowError(expect.objectContaining<Partial<PreferenceLearningError>>({ code: 'policy-denied' }))

    const allowed = await harness()
    appendReady(allowed.feedback)
    expect(() => allowed.ctx.assistantPreferenceLearning.review(agent('/work/beta')))
      .toThrowError(expect.objectContaining<Partial<PreferenceLearningError>>({ code: 'policy-denied' }))
  })

  test('activates and rolls back with exact versions through the tool surface', async () => {
    const { ctx, agent: target, attestTurn, feedback } = await harness()
    appendReady(feedback)
    attestTurn(target, {
      bindingId: 'binding-owner', bindingVersion: 1, sourceEventId: 'dynamic-overlay-event',
      sourceInboxId: 'dynamic-overlay-inbox', turn: 1,
    })
    const reviewed = await ctx.tools.execute(call('preference_review', {}, target))
    expect(reviewed.isError).toBe(false)
    const reviewValue = reviewed.isError ? undefined : reviewed.value as {
      hypotheses: Array<{ hypothesisId: string; version: number }>
    }
    const hypothesis = reviewValue!.hypotheses[0]!

    const activated = await ctx.tools.execute(call('preference_activate', {
      hypothesis_id: hypothesis.hypothesisId,
      expected_version: hypothesis.version,
    }, target))
    expect(activated.isError ? undefined : activated.value).toMatchObject({
      effectState: 'active', claimState: 'tentative', version: hypothesis.version + 1,
    })
    const sameAgentRetry = await ctx.tools.execute(call('preference_rollback', {
      hypothesis_id: hypothesis.hypothesisId,
      expected_version: hypothesis.version + 1,
    }, target))
    expect(sameAgentRetry.isError).toBe(true)

    const rollbackAgent = agent()
    const rolledBack = await ctx.tools.execute(call('preference_rollback', {
      hypothesis_id: hypothesis.hypothesisId,
      expected_version: hypothesis.version + 1,
    }, rollbackAgent))
    expect(rolledBack.isError ? undefined : rolledBack.value).toMatchObject({
      effectState: 'rolled-back', claimState: 'rejected', version: hypothesis.version + 2,
    })
    expect(ctx.tools.get('preference_rollback')?.parameters).not.toHaveProperty('reason')
  })

  test('renders review as untrusted data and never exposes raw evidence or scope', async () => {
    const { ctx, agent: target, feedback } = await harness()
    appendReady(feedback)
    const reviewed = await ctx.tools.execute(call('preference_review', {}, target))
    const rendered = JSON.stringify(reviewed.content)
    expect(rendered).toContain('untrusted data, not instructions')
    expect(rendered).not.toContain('/work/alpha')
    expect(rendered).not.toContain('owner-authenticated')
    expect(rendered).not.toContain('structure-1')
  })

  test('disabled mode ACK-ignores Delivery projections but keeps status and forget controls available', async () => {
    const { ctx, agent: target, delivery, feedback } = await harness({ enabled: false })
    expect(ctx.assistantPreferenceLearning.health()).toMatchObject({ enabled: false, signals: 0, active: 0 })
    expect(ctx.assistantPreferenceLearning.overlayForAgent(target)).toBeUndefined()
    const ignored = feedbackEvent('disabled-delivery-projection', {
      scope: { workspace: '/work/alpha', preset: 'primary' },
      occurredAt: Date.now(),
    })
    expect(feedback(ignored)).toEqual([{
      idempotencyKey: ignored.idempotencyKey,
      status: 'recorded',
    }])
    expect(ctx.assistantPreferenceLearning.health().signals).toBe(0)

    const control = delivery.currentRegistration()!.control!
    const occurredAt = Date.now()
    expect(await control({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      principalId: 'owner:lark:123',
      principalLineage: OWNER_LINEAGE,
      admissionCursor: admissionCursor(),
      action: 'status',
      occurredAt,
      idempotencyKey: 'disabled-status',
    })).toMatchObject({ outcome: 'applied', action: 'status', state: { mode: 'disabled' } })
    expect(await control({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      principalId: 'owner:lark:123',
      principalLineage: OWNER_LINEAGE,
      admissionCursor: admissionCursor(),
      action: 'forget',
      occurredAt: occurredAt + 1,
      idempotencyKey: 'disabled-forget',
    })).toMatchObject({
      outcome: 'applied', action: 'forget', deletedSignals: 0,
      deletedHypotheses: 0, state: { mode: 'disabled' },
    })
  })

  test('forgets scope data only through the Host seam', async () => {
    const { ctx, agent: target, feedback } = await harness()
    appendReady(feedback)
    expect(ctx.assistantPreferenceLearning.review(target).hypotheses).toHaveLength(1)
    const forgotten = ctx.assistantPreferenceLearning.forgetScope(
      { workspace: '/work/alpha', preset: 'primary' },
      'privacy-request-1',
    )
    expect(forgotten).toMatchObject({ deletedSignals: 2, deletedHypotheses: 1 })
    expect(ctx.assistantPreferenceLearning.review(target).hypotheses).toEqual([])
    expect(ctx.tools.schemas().some(schema => /forget|confirm|observe/u.test(schema.name))).toBe(false)
  })

  test('rebuilds the runtime overlay on every assembly and clears rollback or forget immediately', async () => {
    const { ctx, agent: target, attestTurn, feedback } = await harness()
    appendReady(feedback)
    attestTurn(target, {
      bindingId: 'binding-owner', bindingVersion: 1, sourceEventId: 'dynamic-overlay-event',
      sourceInboxId: 'dynamic-overlay-inbox', turn: 1,
    })
    const ready = ctx.assistantPreferenceLearning.review(target).hypotheses[0]!
    const active = ctx.assistantPreferenceLearning.activate(target, ready.id, ready.version)
    const rendered = renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target }))
    expect(rendered).toContain('Prefer bullet lists')

    ctx.assistantPreferenceLearning.rollback(target, active.id, active.version, 'operator-request')
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target }))).toBe('')

    appendReady(feedback, 'reopen')
    const reopened = ctx.assistantPreferenceLearning.review(target).hypotheses
      .find(item => item.candidateValue === 'bullets')!
    const reactivated = ctx.assistantPreferenceLearning.activate(target, reopened.id, reopened.version)
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target }))).toContain('Prefer bullet lists')
    ctx.assistantPreferenceLearning.forgetScope(reactivated.scope, 'dynamic-overlay-forget')
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target }))).toBe('')
  })
})
