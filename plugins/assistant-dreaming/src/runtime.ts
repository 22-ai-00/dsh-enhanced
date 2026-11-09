import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AssistantAutomationsService, HostAutomationDefinition, HostAutomationExecutorInput,
  HostAutomationExecutorResult } from '@dsh-enhanced/assistant-automations'
import type { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import type { AssistantGoalsService } from '@dsh-enhanced/assistant-goals'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { AssistantSkillsService } from '@dsh-enhanced/assistant-skills'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { Config, normalizeConfig, type DreamingConfig, type NormalizedDreamingConfig } from './config.js'
import { DreamStore, type DreamIdea } from './store.js'
import { decideTrigger, localDayKey, assignTicket, rollLottery, matchTickets, type LotterySubject } from './trigger.js'
import { buildDreamMaterial, type DreamMaterial } from './projection.js'
import { runDreamAgent, type DreamAgentModel } from './dream-agent.js'
import { enqueueDreamNotification } from './notify.js'

/** Default circular window for a ticket match (roughly 1% of the modulus). */
const DREAM_TICKET_WINDOW = 5_000
/** Bounds how many recorded ideas may hold recall tickets per wake. */
const DREAM_RECORDED_TICKET_LIMIT = 100

const EXECUTOR = 'assistant-dreaming-v1'
const OWNER = 'assistant-dreaming'
const CATALOG = acceptanceDigest({ executor: EXECUTOR, version: 1 })

export interface DreamingHealth {
  enabled: boolean
  scheduler: 'active' | 'dormant' | 'unavailable'
  lastRunAt: number | null
  lastRunOutcome: string | null
  lastSkipReason: string | null
  counts: { runs: number; ideas: number; recorded: number }
}

interface DreamPorts {
  automations: AssistantAutomationsService
  policy: Pick<AssistantPolicyService, 'reserve' | 'finalize' | 'release'>
  delivery: Pick<AssistantDeliveryService, 'validateOwnerRoute' | 'inspectOwnerModelSelection'
    | 'resolveOwnerRoute' | 'enqueueOwnerNotification'>
  evaluation: Pick<AssistantEvaluationService, 'canonicalHostScope' | 'listTrustedTaskLearningProjections'>
  goals: Pick<AssistantGoalsService, 'inspectOwnerGoals'>
  skills: Pick<AssistantSkillsService, 'inspectOwnerActiveSkills' | 'inspectOwnerSkillCandidates'>
}

/**
 * The owner-enabled dreaming runtime. It registers exactly one system-owned
 * `every` automation and, per slot, re-derives the deterministic trigger, then
 * runs one frozen single-tool agent that may only record private ideas. It
 * never notifies, adopts, promotes, or writes goals/work-items; with
 * `enabled: false` it opens no database and registers nothing.
 */
export class AssistantDreamingService extends Service {
  static Config = Config
  static inject = ['assistantAutomations', 'assistantPolicy', 'assistantDelivery', 'assistantEvaluation',
    'assistantGoals', 'assistantSkills', 'agents', 'sessions', 'tools']

  readonly #config: NormalizedDreamingConfig
  readonly #lane: string
  #store: DreamStore | undefined
  #flight: Promise<HostAutomationExecutorResult> | undefined
  #active = true
  #scheduler: DreamingHealth['scheduler']
  #lastRunAt: number | null = null
  #lastRunOutcome: string | null = null
  #lastSkipReason: string | null = null
  #unregister: (() => void) | undefined

  constructor(ctx: Context, input: DreamingConfig = {}) {
    super(ctx, 'assistantDreaming')
    const config = normalizeConfig(input)
    this.#config = config
    this.#lane = config.scope === null ? 'inactive'
      : acceptanceDigest({ scope: config.scope, databasePath: config.databasePath }).slice(0, 40)
    if (!config.enabled) {
      this.#scheduler = 'dormant'
      return
    }
    const ports = this.#ports(ctx)
    this.#scheduler = 'active'
    this.#store = new DreamStore(config.databasePath!, this.#lane)
    this.#store.interrupt()
    this.#unregister = ports.automations.registerHostExecutor(this.#executor(ports))
    ports.automations.reconcileSystem({
      owner: OWNER,
      automationId: this.#automationId(),
      idempotencyKey: `${this.#automationId()}:${this.#configDigest()}`,
      desiredStatus: 'active',
      definition: this.#definition(),
    })
    ctx.effect(() => () => {
      this.#active = false
      this.#unregister?.()
      try { this.#store?.interrupt() } catch { /* store may already be closed */ }
      const closing = this.#flight
      this.#store?.close()
      return closing
    }, 'assistant-dreaming.runtime')
  }

  /**
   * Register a stable ticket for every recallable subject derived from the
   * current projected material and for this lane's unresolved recorded ideas.
   * Pure registration: no randomness here, the ticket value comes from the
   * HMAC seed in assignTicket.
   */
  #registerTickets(store: DreamStore, material: DreamMaterial, now: number, seedDigest: string): void {
    for (const item of material.items) {
      const subject: LotterySubject = { kind: item.kind, key: item.evidenceRef }
      const ticket = assignTicket({ seedDigest, lane: this.#lane, subject })
      store.upsertTicket({ subjectKind: subject.kind, subjectKey: subject.key,
        value: ticket.value, digest: ticket.digest, now })
    }
    // Recorded-but-unresolved ideas are recall subjects too, so a past dream
    // can be revisited; resolved ones (validated/rejected/withdrawn) stop
    // holding a ticket by never being re-registered.
    store.pruneResolvedIdeaTickets()
    for (const idea of store.listIdeas(DREAM_RECORDED_TICKET_LIMIT)) {
      if (idea.state !== 'recorded') continue
      const subject: LotterySubject = { kind: 'recorded-idea', key: idea.id }
      const ticket = assignTicket({ seedDigest, lane: this.#lane, subject })
      store.upsertTicket({ subjectKind: subject.kind, subjectKey: subject.key,
        value: ticket.value, digest: ticket.digest, now })
    }
  }

  /**
   * The "无事找事" lottery: roll one code-generated number and return the
   * tickets within the circular window. Runs without a model call; an empty
   * result means no subject is recalled this slot.
   */
  #drawRecallHits(store: DreamStore, occurrence: number, seedDigest: string) {
    const draw = rollLottery({ seedDigest, lane: this.#lane, occurrence })
    const tickets = store.listTickets().map(row => ({
      subject: { kind: row.subjectKind as LotterySubject['kind'], key: row.subjectKey },
      value: row.value, digest: row.digest,
    }))
    const hits = matchTickets({ draw, tickets, window: DREAM_TICKET_WINDOW })
    return { draw, hits }
  }

  #ports(ctx: Context): DreamPorts {
    const automations = ctx.get('assistantAutomations') as AssistantAutomationsService | undefined
    const policy = ctx.get('assistantPolicy') as AssistantPolicyService | undefined
    const delivery = ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
    const evaluation = ctx.get('assistantEvaluation') as AssistantEvaluationService | undefined
    const goals = ctx.get('assistantGoals') as AssistantGoalsService | undefined
    const skills = ctx.get('assistantSkills') as AssistantSkillsService | undefined
    if (!automations || !policy || !delivery || !evaluation || !goals || !skills
      || !ctx.get('agents') || !ctx.get('sessions') || !ctx.get('tools')) {
      throw new Error('assistant-dreaming: enabled dreaming requires automations, policy, delivery, evaluation, goals, skills, agents, sessions and tools')
    }
    return { automations, policy, delivery, evaluation, goals, skills }
  }

  #automationId(): string {
    return `dsh-enhanced-assistant-dreaming:${this.#lane}`
  }

  #configDigest(): string {
    return acceptanceDigest({ lane: this.#lane, config: this.#config }).slice(0, 40)
  }

  #definition(): HostAutomationDefinition {
    const scope = this.#config.scope!
    return {
      name: 'Bounded dreaming review',
      schedule: { kind: 'every', anchorAt: new Date(0).toISOString(), intervalMs: this.#config.baseIntervalMs },
      workspace: scope.workspace,
      agentPreset: scope.preset,
      timeoutMs: this.#config.maxDurationMs,
      misfire: { kind: 'latest' },
      overlap: 'skip',
      retrySafety: 'never',
      maxRetries: 0,
      principal: scope.principalId,
      budgetId: this.#config.budgetId!,
      budgetAmount: this.#config.budgetAmount!,
      execution: {
        kind: 'host', executorId: EXECUTOR, executorContractVersion: 1, runbookId: 'dream', runbookVersion: 1,
        catalogDigest: CATALOG,
        targetScope: { workspace: scope.workspace, preset: scope.preset },
        scopeDigest: acceptanceDigest([scope.workspace, scope.preset]),
        ownerRouteId: scope.ownerRouteId,
        activationNonce: this.#configDigest(),
      },
    }
  }

  #executor(ports: DreamPorts) {
    return {
      descriptor: { executorId: EXECUTOR, contractVersion: 1, catalogDigest: CATALOG },
      accepts: (spec: { executorId: string; executorContractVersion: number; catalogDigest: string; runbookId: string; runbookVersion: number }) =>
        spec.executorId === EXECUTOR && spec.executorContractVersion === 1 && spec.catalogDigest === CATALOG
        && spec.runbookId === 'dream' && spec.runbookVersion === 1,
      execute: (input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult> => {
        const flight = this.#runSlot(ports, input)
        this.#flight = flight
        void flight.finally(() => { if (this.#flight === flight) this.#flight = undefined }).catch(() => {})
        return flight
      },
    }
  }

  /** Latest trusted activity timestamp from Evaluation projections, or null. */
  #latestActivity(ports: DreamPorts, scope: ReturnType<AssistantEvaluationService['canonicalHostScope']>): number | null {
    const page = ports.evaluation.listTrustedTaskLearningProjections({ scope, limit: 1 })
    const item = page.items[0]
    const at = item?.receipt.objective?.occurredAt
    return typeof at === 'number' && Number.isFinite(at) ? at : null
  }

  async #runSlot(ports: DreamPorts, input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult> {
    const settled = (outcome: 'succeeded' | 'failed' | 'unknown', failureClass: HostAutomationExecutorResult['failureClass'],
      failurePhase: HostAutomationExecutorResult['failurePhase'], failureCode: string,
      sideEffectState: HostAutomationExecutorResult['sideEffectState'] = 'none'): HostAutomationExecutorResult =>
      ({ outcome, failureClass, failurePhase, failureCode, sideEffectState, retryability: 'unsafe' })
    if (!this.#active || this.#store === undefined) return settled('failed', 'cancelled', 'preflight', 'disposed')
    const store = this.#store
    const config = this.#config
    const scopeConfig = config.scope!
    const now = Date.now()
    const timezone = config.activeHours?.timezone ?? 'UTC'
    const dayKey = localDayKey(now, timezone)
    let latestActivityAt: number | null = null
    try {
      latestActivityAt = this.#latestActivity(ports, ports.evaluation.canonicalHostScope({
        workspace: scopeConfig.workspace, preset: scopeConfig.preset }))
    } catch { latestActivityAt = null }
    const occurrence = Number.parseInt(createHash('sha256')
      .update(`${input.definitionHash}\0${input.occurrenceId}`).digest('hex').slice(0, 12), 16)
    const seedDigest = config.seedDigest ?? createHash('sha256').update(`assistant-dreaming\0${this.#lane}`).digest('hex')
    const decision = decideTrigger({
      now,
      occurrence,
      lane: this.#lane,
      seedDigest,
      probabilityPpm: config.runProbabilityPpm,
      activeHours: config.activeHours,
      latestActivityAt,
      idleMinMs: config.idleMinMs,
      dreamsToday: store.countDreams(dayKey),
      maxDreamsPerDay: config.maxDreamsPerDay,
    })
    if (!decision.fire) {
      this.#lastSkipReason = decision.reason
      return settled('succeeded', 'none', 'none', `skip:${decision.reason}`)
    }
    // Per-subject lottery ("无事找事"): build material and tickets, then roll
    // one code-generated number. A miss is a normal no-thought slot and skips
    // the model entirely; a hit focuses the wake on the recalled subject.
    const seedMaterial = buildDreamMaterial({
      evaluation: ports.evaluation, delivery: ports.delivery, goals: ports.goals, skills: ports.skills,
      scope: scopeConfig, maxInputBytes: config.maxInputBytes,
    })
    this.#registerTickets(store, seedMaterial, now, seedDigest)
    const { draw, hits } = this.#drawRecallHits(store, occurrence, seedDigest)
    if (hits.length === 0) {
      this.#lastSkipReason = 'lottery-no-hit'
      return settled('succeeded', 'none', 'none', 'skip:lottery-no-hit')
    }
    for (const hit of hits) {
      store.recordRecall({ occurrence, drawDigest: draw.drawDigest, drawValue: draw.value,
        subjectKind: hit.subject.kind, subjectKey: hit.subject.key, ticketValue: hit.ticketValue,
        distance: hit.distance, at: now })
    }
    this.#lastSkipReason = null
    const runId = `dream-${input.occurrenceId}`
    let reserved: string | undefined
    let submitted = false
    try {
      const model = this.#resolveModel(ports, scopeConfig)
      const reservation = ports.policy.reserve({
        budgetId: config.budgetId!,
        subject: { kind: 'background', id: input.occurrenceId, workspace: scopeConfig.workspace, principal: scopeConfig.principalId },
        amount: config.budgetAmount!,
        idempotencyKey: `dream-budget:${input.occurrenceId}`,
      })
      if (reservation.status !== 'reserved') {
        this.#lastSkipReason = `budget:${reservation.status}`
        return settled('succeeded', 'budget', 'budget-reservation', `budget:${reservation.status}`)
      }
      reserved = reservation.reservationId
      store.beginDream(runId, occurrence, decision.dayKey, now, decision.drawDigest)
      submitted = true
      this.#lastRunAt = now
      const result = await runDreamAgent({
        ctx: this.ctx,
        wakeId: input.occurrenceId,
        config,
        model,
        scope: scopeConfig,
        material: seedMaterial,
        recallHits: hits.map(hit => {
          const focus = { kind: hit.subject.kind, key: hit.subject.key,
            ticketValue: hit.ticketValue, distance: hit.distance }
          // Recorded ideas live outside the projection material; carry their
          // own summary so the recalled subject is not just an opaque id.
          if (hit.subject.kind === 'recorded-idea') {
            const idea = store.idea(hit.subject.key)
            if (idea !== undefined) return { ...focus, summary: idea.summary }
          }
          return focus
        }),
        deadlineAt: Math.min(now + config.maxDurationMs, Date.now() + config.maxDurationMs),
        signal: input.signal,
        onSubmit: ideas => {
          let recorded = 0
          for (const idea of ideas) {
            store.recordIdea({
              id: createHash('sha256').update(`${runId}\0${recorded}\0${idea.summary}`).digest('hex').slice(0, 32),
              runId, createdAt: Date.now(), dayKey: decision.dayKey,
              summary: idea.summary, detail: idea.detail, evidenceRefs: idea.evidenceRefs,
            })
            recorded += 1
          }
          return recorded
        },
      })
      this.#lastRunOutcome = result.outcome
      if (result.outcome === 'succeeded') {
        store.completeDream(runId, Date.now(), result.ideaCount)
        this.#notifyOwner(store, runId, decision.dayKey, result.ideaCount, now)
        ports.policy.finalize(reserved, config.budgetAmount!)
        reserved = undefined
        return settled('succeeded', 'none', 'none', 'dreamed', 'possible')
      }
      if (submitted) store.markInterrupted(runId, Date.now())
      // The agent may already have spent budget: settle conservatively.
      ports.policy.finalize(reserved, config.budgetAmount!)
      reserved = undefined
      return settled(result.outcome === 'cancelled' ? 'unknown' : 'failed', 'execution', 'agent-setup',
        `dream-agent:${result.outcome}`, 'possible')
    } catch (error) {
      if (this.#store !== undefined) {
        try { store.markInterrupted(runId, Date.now()) } catch { /* closed */ }
      }
      this.#lastRunOutcome = 'failed'
      if (reserved !== undefined) {
        try {
          if (submitted) ports.policy.finalize(reserved, config.budgetAmount!)
          else ports.policy.release(reserved)
        } catch { /* ledger left visible */ }
      }
      const code = error instanceof Error ? error.message.slice(0, 120) : 'dream-failed'
      return settled('failed', 'execution', 'host-execution', code.startsWith('assistant-dreaming:') ? code : 'dream-failed', submitted ? 'possible' : 'none')
    }
  }

  #resolveModel(ports: DreamPorts, scope: { ownerRouteId: string; principalId: string; workspace: string; preset: string }): DreamAgentModel {
    const config = this.#config
    if (config.provider !== null && config.model !== null) {
      return { provider: config.provider, model: config.model,
        ...(config.reasoningEffort === null ? {} : { reasoningEffort: config.reasoningEffort }) }
    }
    const selected = ports.delivery.inspectOwnerModelSelection({
      authorityId: scope.ownerRouteId, principalId: scope.principalId,
      workspace: scope.workspace, agentPreset: scope.preset })
    if (!selected.provider || !selected.model) throw new Error('assistant-dreaming: owner model selection is unavailable')
    return { provider: selected.provider, model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) }
  }

  /**
   * L1 owner summary notification. Fails closed at every gate: the
   * notification flag, daily count and minimum interval must all allow it,
   * and the live route is re-validated by the enqueue helper. A failed
   * notification never changes the dream outcome.
   */
  #notifyOwner(store: DreamStore, runId: string, dayKey: string, ideaCount: number, now: number): void {
    const config = this.#config
    if (!config.notifyOwner || config.maxNotificationsPerDay === 0 || ideaCount === 0) return
    if (store.countNotifications(dayKey) >= config.maxNotificationsPerDay) return
    const lastAt = store.lastNotificationAt()
    if (lastAt !== null && now - lastAt < config.notifyMinIntervalMs) return
    const scope = config.scope!
    const delivery = this.ctx.get('assistantDelivery' as never, false) as AssistantDeliveryService | undefined
    if (delivery === undefined) return
    const sent = enqueueDreamNotification(
      {
        validateOwnerRoute: input => delivery.validateOwnerRoute({ authorityId: scope.ownerRouteId, principalId: input.principalId,
          workspace: input.workspace, agentPreset: input.preset }),
        resolveOwnerRoute: ownerRouteId => delivery.resolveOwnerRoute(ownerRouteId),
        enqueueOwnerNotification: input => delivery.enqueueOwnerNotification(input),
      },
      {
        owner: { ownerRouteId: scope.ownerRouteId, principalId: scope.principalId, workspace: scope.workspace, preset: scope.preset },
        runId,
        summaries: store.listIdeas(ideaCount).map(idea => ({ summary: idea.summary, detail: idea.detail })),
        dayKey, now, expiresAt: now + config.maxDurationMs,
      },
    )
    if (sent) store.incrementNotifications(dayKey, now)
  }

  health(): DreamingHealth {
    let counts = { runs: 0, ideas: 0, recorded: 0 }
    if (this.#store !== undefined) {
      try { counts = this.#store.counts() } catch { /* read failure keeps zeros */ }
    }
    return Object.freeze({
      enabled: this.#config.enabled,
      scheduler: this.#scheduler,
      lastRunAt: this.#lastRunAt,
      lastRunOutcome: this.#lastRunOutcome,
      lastSkipReason: this.#lastSkipReason,
      counts,
    })
  }

  /** Read-only access to recorded ideas for the owner-facing surfaces. */
  inspectIdeas(limit = 50): readonly DreamIdea[] {
    if (this.#store === undefined) return Object.freeze([])
    return Object.freeze([...this.#store.listIdeas(Math.min(Math.max(1, limit), 200))])
  }

  /** Owner-visible retirement: disable the automation without deleting ideas. */
  retire(): void {
    if (!this.#config.enabled || this.#store === undefined) return
    this.#unregister?.()
    this.#unregister = undefined
    this.#scheduler = 'dormant'
  }
}

export { Config }
