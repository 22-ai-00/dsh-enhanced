import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AssistantAutomationsService, HostAutomationDefinition, HostAutomationExecutorInput,
  HostAutomationExecutorResult, SystemAutomationReconcileInput } from '@dsh-enhanced/assistant-automations'
import type { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import type { AssistantGoalsService } from '@dsh-enhanced/assistant-goals'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { AssistantSkillsService } from '@dsh-enhanced/assistant-skills'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { Config, normalizeConfig, type DreamingConfig, type NormalizedDreamingConfig } from './config.js'
import { DreamStore, ownData, type DreamIdea, type IdeaEvent, type IdeaState } from './store.js'
import { decideTrigger, localDayKey, assignTicket, rollLottery, matchTickets, type LotterySubject } from './trigger.js'
import { buildDreamMaterial, type DreamMaterial, type DreamPersonalMemoryPort } from './projection.js'
import { runDreamAgent, type DreamAgentModel } from './dream-agent.js'
import { enqueueDreamNotification } from './notify.js'

/** Bounds how many recorded ideas may hold recall tickets per wake. */
const DREAM_RECORDED_TICKET_LIMIT = 100

const EXECUTOR = 'assistant-dreaming-v1'
const OWNER = 'assistant-dreaming'
const CATALOG = acceptanceDigest({ executor: EXECUTOR, version: 1 })
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

function unwrapService<T>(service: T): T {
  return (service as { [CORDIS_ORIGINAL]?: T } | null | undefined)?.[CORDIS_ORIGINAL] ?? service
}

export type DreamIdeaTransition = 'validate' | 'reject' | 'retire'

export interface AcknowledgeIdeaInput {
  ideaId: string
  note?: string
  principalId?: string
}

export interface TransitionIdeaInput {
  ideaId: string
  transition: DreamIdeaTransition
  note?: string
  principalId?: string
}

export interface DreamIdeaTransitionResult {
  readonly idea: Readonly<DreamIdea>
  readonly event: Readonly<IdeaEvent>
}

export interface DreamingHealth {
  enabled: boolean
  scheduler: 'active' | 'dormant' | 'unavailable'
  lastRunAt: number | null
  lastRunOutcome: string | null
  lastSkipReason: string | null
  counts: { runs: number; ideas: number; recorded: number }
}

interface DreamPorts {
  automations: Pick<AssistantAutomationsService, 'registerHostExecutor' | 'reconcileSystem'>
    & Partial<Pick<AssistantAutomationsService, 'onSchedulerWake'>>
  delivery: Pick<AssistantDeliveryService, 'validateOwnerRoute' | 'resolveOwnerRoute' | 'enqueueOwnerNotification'>
    & Partial<Pick<AssistantDeliveryService, 'inspectOwnerRouteState'>>
  evaluation: Pick<AssistantEvaluationService, 'canonicalHostScope' | 'listTrustedTaskLearningProjections'>
  goals: Pick<AssistantGoalsService, 'inspectOwnerGoals'>
  skills: Pick<AssistantSkillsService, 'inspectOwnerActiveSkills' | 'inspectOwnerSkillCandidates'>
}

type PolicyPort = Partial<Pick<AssistantPolicyService, 'authorize' | 'evaluate' | 'getBudgetConfig' | 'getEmergencyStop'>>
type LlmReadPort = {
  listProviders?: () => readonly { id: string }[]
  resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<unknown>
}

type PrerequisiteCheck = { ok: true } | { ok: false; reason: string; failureClass: FailureClass; failureCode: string }

type FailureClass = HostAutomationExecutorResult['failureClass']
type FailurePhase = HostAutomationExecutorResult['failurePhase']

/**
 * Terminal outcomes for the Automations Host-executor contract. Success may
 * only carry the literal `none` tuple; a possible side effect must be
 * retryability-unsafe and a pure no-op success must be retryability-safe.
 * Budget reservation/settlement belongs to Automations, never to this
 * executor, so no result here reports a budget settlement.
 */
const NO_EFFECT: HostAutomationExecutorResult = Object.freeze({
  outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none',
  sideEffectState: 'none', retryability: 'safe',
})
const EFFECT_OK: HostAutomationExecutorResult = Object.freeze({
  outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none',
  sideEffectState: 'possible', retryability: 'unsafe',
})

function failed(
  failureClass: FailureClass,
  failurePhase: FailurePhase,
  failureCode: string,
  sideEffectState: HostAutomationExecutorResult['sideEffectState'],
): HostAutomationExecutorResult {
  const retryability = sideEffectState !== 'none' ? 'unsafe' as const
    : failureClass === 'configuration' || failureClass === 'policy' || failureClass === 'budget'
      ? 'after-intervention' as const : 'safe' as const
  return Object.freeze({
    outcome: failureClass === 'cancelled' || failureClass === 'unknown' ? 'unknown' : 'failed',
    failureClass, failurePhase, failureCode, sideEffectState, retryability,
  })
}

/**
 * The owner-enabled dreaming runtime. It registers exactly one system-owned
 * `every` automation and, per slot, re-derives the deterministic trigger, then
 * runs one frozen single-tool agent that may only record private ideas. It
 * never notifies unless L1 is explicitly enabled, never adopts, promotes, or
 * writes goals/work-items; with `enabled: false` it opens no database and
 * registers nothing.
 *
 * Scheduling and per-occurrence budget reservation/settlement belong to
 * `assistant-automations`; this executor is a pure consumer of the Host
 * executor contract and never reserves budget itself.
 */
export class AssistantDreamingService extends Service {
  static Config = Config
  static inject = ['assistantAutomations', 'assistantDelivery', 'assistantEvaluation',
    'assistantGoals', 'assistantSkills', 'agents', 'sessions', 'tools']

  readonly #config: NormalizedDreamingConfig
  readonly #lane: string
  #ports: DreamPorts | undefined
  #store: DreamStore | undefined
  #flight: Promise<HostAutomationExecutorResult> | undefined
  #active = true
  #scheduler: DreamingHealth['scheduler'] = 'dormant'
  #lastRunAt: number | null = null
  #lastRunOutcome: string | null = null
  #lastSkipReason: string | null = null
  #unregister: (() => void) | undefined
  #unsubscribeWake: (() => void) | undefined
  #unsubscribeLlm: (() => void) | undefined
  #coldStartAnchorAt: number
  /**
   * Fresh per-load reconcile nonce for the active transition. Automations
   * caches `automation_system_reconciles` by idempotency key and replays the
   * old receipt without touching the row, so a deterministic key would silently
   * skip reactivation after a retire/reload. A new key per load converges to
   * one active row (the store CAS is idempotent) and appends one audit receipt.
   */
  readonly #loadNonce = randomUUID()

  constructor(ctx: Context, input: DreamingConfig = {}) {
    super(ctx, 'assistantDreaming')
    const config = normalizeConfig(input)
    this.#config = config
    this.#coldStartAnchorAt = Date.now()
    this.#lane = config.scope === null ? 'inactive'
      : acceptanceDigest({ scope: config.scope, databasePath: config.databasePath }).slice(0, 40)
    if (!config.enabled) {
      this.#scheduler = 'dormant'
      return
    }
    const ports = this.#portsFor(ctx)
    this.#ports = ports
    this.#store = new DreamStore(config.databasePath!, this.#lane)
    try {
      this.#store.interrupt()
      this.#pruneStore(Date.now())
      this.#coldStartAnchorAt = this.#store.ensureColdStartAnchor(this.#coldStartAnchorAt)
      if (config.retired) {
        // Owner pause: keep the ledger and definition, make sure the system
        // automation is paused, and register no executor. This is the supported
        // way to stop dreaming before disabling/uninstalling the bundle.
        ports.automations.reconcileSystem(this.#reconcileInput('paused'))
        this.#scheduler = 'dormant'
      } else {
        const prereq = this.#evaluatePrerequisites(ports)
        if (prereq.ok) {
          this.#activateScheduler(ports)
        } else {
          this.#scheduler = 'dormant'
          this.#lastSkipReason = prereq.reason
          if (this.#canReconcilePolicy()) {
            try { ports.automations.reconcileSystem(this.#reconcileInput('paused')) } catch { /* stay dormant until ready */ }
          }
          if (typeof ports.automations.onSchedulerWake === 'function') {
            this.#unsubscribeWake = ports.automations.onSchedulerWake(() => { this.#tryActivateIfReady(ports) })
          }
          if (typeof ctx.on === 'function') {
            const disposeLlm = ctx.on('llm/adapters-updated' as never, (() => { this.#tryActivateIfReady(ports) }) as never)
            this.#unsubscribeLlm = () => { disposeLlm() }
          }
        }
      }
    } catch (error) {
      // Construction must not leak a registered executor or an open ledger:
      // the Loader keeps this process alive and a retry would otherwise fail
      // with a duplicate executor descriptor. This also covers a failed paused
      // reconcile while the owner is trying to retire.
      this.#active = false
      this.#scheduler = 'unavailable'
      try { this.#unsubscribeLlm?.() } catch { /* best-effort unload */ }
      this.#unsubscribeLlm = undefined
      try { this.#unsubscribeWake?.() } catch { /* best-effort unload */ }
      this.#unsubscribeWake = undefined
      try { this.#unregister?.() } catch { /* best-effort unload */ }
      this.#unregister = undefined
      try { this.#store.interrupt() } catch { /* store may already be closed */ }
      this.#store.close()
      this.#store = undefined
      throw error
    }
    ctx.effect(() => () => {
      this.#active = false
      this.#unsubscribeLlm?.()
      this.#unsubscribeLlm = undefined
      this.#unsubscribeWake?.()
      this.#unsubscribeWake = undefined
      this.#unregister?.()
      this.#unregister = undefined
      try { this.#store?.interrupt() } catch { /* store may already be closed */ }
      const closing = this.#flight
      this.#store?.close()
      return closing
    }, 'assistant-dreaming.runtime')
  }

  /**
   * Enforce the owner retention policy over the private idea ledger. Runs on
   * plugin load and after every completed dream so a long-lived Host cannot
   * keep expired ideas forever. Failure is observable but never fails a wake.
   */
  #pruneStore(now: number): void {
    try { this.#store?.prune(now, this.#config.retentionDays) } catch (error) {
      this.ctx.logger.warn(`assistant-dreaming: idea retention prune failed: ${error instanceof Error ? error.message : String(error)}`)
    }
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
    const hits = matchTickets({ draw, tickets, window: this.#config.lotteryWindow })
    return { draw, hits }
  }

  #portsFor(ctx: Context): DreamPorts {
    const automations = ctx.get('assistantAutomations') as AssistantAutomationsService | undefined
    const delivery = ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
    const evaluation = ctx.get('assistantEvaluation') as AssistantEvaluationService | undefined
    const goals = ctx.get('assistantGoals') as AssistantGoalsService | undefined
    const skills = ctx.get('assistantSkills') as AssistantSkillsService | undefined
    if (!automations || !delivery || !evaluation || !goals || !skills
      || !ctx.get('agents') || !ctx.get('sessions') || !ctx.get('tools')) {
      throw new Error('assistant-dreaming: enabled dreaming requires automations, delivery, evaluation, goals, skills, agents, sessions and tools')
    }
    return { automations, delivery, evaluation, goals, skills }
  }

  #automationId(): string {
    return `dsh-enhanced-assistant-dreaming:${this.#lane}`
  }

  #configDigest(): string {
    return acceptanceDigest({ lane: this.#lane, config: this.#config }).slice(0, 40)
  }

  #reconcileInput(desiredStatus: 'active' | 'paused'): SystemAutomationReconcileInput {
    // Both transitions are load-scoped. Automations replays a cached
    // `automation_system_reconciles` receipt for a repeated idempotency key
    // without touching the row, so a deterministic paused key would make a
    // second retire (or retire after resume) silently leave the row active
    // while this plugin is already dormant. Reconcile is a local CAS converge
    // operation: a fresh key per load is safe, and a repeated retire() in the
    // same load still just replays the same paused receipt.
    const key = `${this.#automationId()}:${this.#configDigest()}:${desiredStatus}:${this.#loadNonce}`
    return {
      owner: OWNER,
      automationId: this.#automationId(),
      idempotencyKey: key,
      desiredStatus,
      definition: this.#definition(),
    }
  }

  #definition(): HostAutomationDefinition {
    const scope = this.#config.scope!
    return {
      name: 'Bounded dreaming review',
      schedule: { kind: 'every', anchorAt: new Date(0).toISOString(), intervalMs: this.#config.baseIntervalMs },
      workspace: scope.workspace,
      agentPreset: scope.preset,
      timeoutMs: this.#config.maxDurationMs,
      // A missed slot is skipped, never replayed: dreaming must not catch up
      // with a burst of paid model calls after downtime.
      misfire: { kind: 'skip' },
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

  /** Check prerequisites (scope, owner route, policy/budget, model route) before reserving/spending budget. */
  #evaluatePrerequisites(ports: DreamPorts): PrerequisiteCheck {
    const scope = this.#config.scope
    if (scope === null || this.#config.provider === null || this.#config.model === null
      || this.#config.budgetId === null || this.#config.budgetAmount === null) {
      return { ok: false, reason: 'configuration-incomplete', failureClass: 'configuration', failureCode: 'dream-scope-unavailable' }
    }
    try {
      ports.delivery.validateOwnerRoute({
        authorityId: scope.ownerRouteId,
        principalId: scope.principalId,
        workspace: scope.workspace,
        agentPreset: scope.preset,
      })
      if (typeof ports.delivery.inspectOwnerRouteState === 'function') {
        const routeState = ports.delivery.inspectOwnerRouteState({
          authorityId: scope.ownerRouteId,
          principalId: scope.principalId,
          workspace: scope.workspace,
          agentPreset: scope.preset,
        })
        if (routeState.status !== 'active') {
          return { ok: false, reason: 'scope-unavailable', failureClass: 'configuration', failureCode: 'dream-scope-unavailable' }
        }
      }
    } catch {
      return { ok: false, reason: 'scope-unavailable', failureClass: 'configuration', failureCode: 'dream-scope-unavailable' }
    }
    const policy = unwrapService(this.ctx.get('assistantPolicy' as never, false)) as PolicyPort | undefined
    if (policy !== undefined) {
      if (typeof policy.getEmergencyStop === 'function' && policy.getEmergencyStop().enabled === true) {
        return { ok: false, reason: 'policy-emergency-stop', failureClass: 'policy', failureCode: 'dream-policy-denied' }
      }
      if (typeof policy.getBudgetConfig === 'function') {
        const budget = policy.getBudgetConfig(this.#config.budgetId)
        if (budget === undefined || budget.metric !== 'automation-runs' || budget.limit < this.#config.budgetAmount) {
          return { ok: false, reason: 'budget-unavailable', failureClass: 'budget', failureCode: 'dream-budget-unavailable' }
        }
      }
      if (typeof policy.evaluate === 'function') {
        const decision = policy.evaluate({
          subject: {
            kind: 'background',
            id: this.#automationId(),
            workspace: scope.workspace,
            principal: scope.principalId,
          },
          action: 'execute',
          resource: { kind: 'automation', id: this.#automationId() },
          context: { initiator: 'background' },
        })
        if (decision.effect !== 'allow') {
          return { ok: false, reason: 'policy-denied', failureClass: 'policy', failureCode: 'dream-policy-denied' }
        }
      }
    }
    const llm = unwrapService(this.ctx.get('llm' as never, false)) as LlmReadPort | undefined
    if (typeof llm?.listProviders === 'function') {
      try {
        const providers = llm.listProviders()
        if (!Array.isArray(providers) || !providers.some(provider => provider?.id === this.#config.provider)) {
          return { ok: false, reason: 'model-unavailable', failureClass: 'configuration', failureCode: 'dream-model-unavailable' }
        }
      } catch {
        return { ok: false, reason: 'model-unavailable', failureClass: 'configuration', failureCode: 'dream-model-unavailable' }
      }
    }
    return { ok: true }
  }

  #canReconcilePolicy(): boolean {
    const scope = this.#config.scope
    if (scope === null) return false
    const policy = unwrapService(this.ctx.get('assistantPolicy' as never, false)) as PolicyPort | undefined
    if (policy === undefined || typeof policy.evaluate !== 'function') return true
    if (typeof policy.getEmergencyStop === 'function' && policy.getEmergencyStop().enabled === true) return false
    return policy.evaluate({
      subject: { kind: 'background', id: OWNER, workspace: scope.workspace, principal: scope.principalId },
      action: 'reconcile',
      resource: { kind: 'automation', id: this.#automationId() },
      context: { initiator: 'background' },
    }).effect === 'allow'
  }

  #activateScheduler(ports: DreamPorts): void {
    this.#unregister = ports.automations.registerHostExecutor(this.#executor(ports))
    ports.automations.reconcileSystem(this.#reconcileInput('active'))
    this.#scheduler = 'active'
    this.#lastSkipReason = null
    this.#unsubscribeWake?.()
    this.#unsubscribeWake = undefined
    this.#unsubscribeLlm?.()
    this.#unsubscribeLlm = undefined
  }

  #tryActivateIfReady(ports: DreamPorts): void {
    if (!this.#active || this.#config.retired || this.#scheduler === 'active') return
    const prereq = this.#evaluatePrerequisites(ports)
    if (!prereq.ok) {
      this.#lastSkipReason = prereq.reason
      return
    }
    try {
      this.#activateScheduler(ports)
    } catch {
      try { this.#unregister?.() } catch { /* best-effort rollback */ }
      this.#unregister = undefined
      this.#scheduler = 'dormant'
    }
  }

  async #runSlot(ports: DreamPorts, input: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult> {
    if (!this.#active || this.#store === undefined) {
      return failed('cancelled', 'preflight', 'disposed', 'none')
    }
    const store = this.#store
    const config = this.#config
    const scopeConfig = config.scope!
    if (input.executionMode !== 'production') {
      // A dry-run/preview occurrence must never spend money or write ideas.
      this.#lastSkipReason = 'preview'
      return NO_EFFECT
    }
    if (input.targetScope?.workspace !== scopeConfig.workspace
      || input.targetScope?.preset !== scopeConfig.preset
      || input.principal !== scopeConfig.principalId
      || input.ownerRouteId !== scopeConfig.ownerRouteId) {
      this.#lastRunOutcome = 'failed'
      return failed('configuration', 'preflight', 'dream-scope-mismatch', 'none')
    }
    const prereq = this.#evaluatePrerequisites(ports)
    if (!prereq.ok) {
      this.#lastSkipReason = prereq.reason
      this.#lastRunOutcome = 'failed'
      return failed(prereq.failureClass, 'preflight', prereq.failureCode, 'none')
    }
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
      coldStartAnchorAt: this.#coldStartAnchorAt,
      idleMinMs: config.idleMinMs,
      dreamsToday: store.countDreams(dayKey),
      maxDreamsPerDay: config.maxDreamsPerDay,
    })
    if (!decision.fire) {
      this.#lastSkipReason = decision.reason
      return NO_EFFECT
    }
    // Per-subject lottery ("无事找事"): build material and tickets, then roll
    // one code-generated number. A miss is a normal no-thought slot and skips
    // the model entirely; a hit focuses the wake on the recalled subject.
    const personalMemory = unwrapService(this.ctx.get('personalMemory' as never, false)) as DreamPersonalMemoryPort | undefined
    let seedMaterial: DreamMaterial
    try {
      seedMaterial = buildDreamMaterial({
        evaluation: ports.evaluation,
        delivery: ports.delivery,
        goals: ports.goals,
        skills: ports.skills,
        ...(personalMemory === undefined ? {} : { personalMemory }),
        scope: scopeConfig,
        maxInputBytes: config.maxInputBytes,
      })
      if (seedMaterial.items.length === 0 && store.counts().recorded === 0) {
        this.#lastSkipReason = 'no-recallable-material'
        return NO_EFFECT
      }
      this.#registerTickets(store, seedMaterial, now, seedDigest)
    } catch (error) {
      // A revoked/missing owner route or projection failure is an owner
      // configuration problem, not a dreamed result: fail closed with no
      // model spend and no ledger write.
      this.#lastRunOutcome = 'failed'
      this.ctx.logger.warn(`assistant-dreaming: material unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return failed('configuration', 'preflight', 'dream-material-unavailable', 'none')
    }
    const { draw, hits } = this.#drawRecallHits(store, occurrence, seedDigest)
    if (hits.length === 0) {
      this.#lastSkipReason = 'lottery-no-hit'
      return NO_EFFECT
    }
    const llm = unwrapService(this.ctx.get('llm' as never, false)) as LlmReadPort | undefined
    if (typeof llm?.resolveModelInfo === 'function') {
      try {
        await llm.resolveModelInfo(config.provider!, config.model!, input.signal)
      } catch {
        this.#lastSkipReason = 'model-unavailable'
        this.#lastRunOutcome = 'failed'
        return failed('configuration', 'preflight', 'dream-model-unavailable', 'none')
      }
    }
    for (const hit of hits) {
      store.recordRecall({ occurrence, drawDigest: draw.drawDigest, drawValue: draw.value,
        subjectKind: hit.subject.kind, subjectKey: hit.subject.key, ticketValue: hit.ticketValue,
        distance: hit.distance, at: now })
    }
    this.#lastSkipReason = null
    const runId = `dream-${input.occurrenceId}`
    let submitted = false
    try {
      const model = this.#resolveModel()
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
        this.#pruneStore(Date.now())
        this.#notifyOwner(store, runId, decision.dayKey, result.ideaCount, now)
        return EFFECT_OK
      }
      store.markInterrupted(runId, Date.now())
      return result.outcome === 'cancelled'
        ? failed('cancelled', 'host-execution', 'dream-agent-cancelled', 'possible')
        : failed('execution', 'host-execution', 'dream-agent-failed', 'possible')
    } catch (error) {
      if (this.#store !== undefined) {
        try { store.markInterrupted(runId, Date.now()) } catch { /* closed */ }
      }
      this.#lastRunOutcome = 'failed'
      this.ctx.logger.warn(`assistant-dreaming: dream wake failed: ${error instanceof Error ? error.message : String(error)}`)
      return submitted
        ? failed('execution', 'host-execution', 'dream-execution-failed', 'possible')
        : failed('configuration', 'preflight', 'dream-preflight-failed', 'none')
    }
  }

  #resolveModel(): DreamAgentModel {
    const config = this.#config
    return { provider: config.provider!, model: config.model!,
      ...(config.reasoningEffort === null ? {} : { reasoningEffort: config.reasoningEffort }) }
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

  // Public surfaces are bound arrow properties: Cordis serves services through
  // a traceable proxy whose method calls would otherwise lose the private-field
  // receiver (the Loader and owner surfaces always read through that proxy).
  health = (): DreamingHealth => {
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
  inspectIdeas = (limit = 50): readonly DreamIdea[] => {
    if (this.#store === undefined) return Object.freeze([])
    return Object.freeze([...this.#store.listIdeas(normalizeLimit(limit))])
  }

  /** Read-only access to owner-validated ideas eligible for downstream intake. */
  inspectValidatedIdeas = (limit = 50): readonly DreamIdea[] => {
    if (this.#store === undefined) return Object.freeze([])
    return Object.freeze([...this.#store.listValidatedIdeas(normalizeLimit(limit))])
  }

  /** Read-only audit trail for one idea in this lane. */
  inspectIdeaEvents = (ideaId: string, limit = 50): readonly IdeaEvent[] => {
    if (this.#store === undefined) return Object.freeze([])
    const id = parseIdeaId(ideaId)
    return this.#store.listIdeaEvents(id, normalizeLimit(limit))
  }

  /** Owner-authorized transition from `recorded` -> `owner-acknowledged`. */
  acknowledgeIdea = (input: AcknowledgeIdeaInput): DreamIdeaTransitionResult =>
    this.#authorizeAndTransition(input, 'acknowledge', 'owner-acknowledged')

  /** Owner-authorized terminal lifecycle transition (`validate`, `reject`, or `retire`). */
  transitionIdea = (input: TransitionIdeaInput): DreamIdeaTransitionResult => {
    if (input === null || typeof input !== 'object') throw new Error('assistant-dreaming: transition input must be an object')
    const raw = ownData(input)
    const transitionMap: Readonly<Record<DreamIdeaTransition, Exclude<IdeaState, 'recorded'>>> = {
      validate: 'validated',
      reject: 'rejected',
      retire: 'withdrawn',
    }
    if (typeof raw.transition !== 'string' || !Object.hasOwn(transitionMap, raw.transition)) {
      throw new Error('assistant-dreaming: transition must be validate, reject, or retire')
    }
    return this.#authorizeAndTransition(raw, raw.transition, transitionMap[raw.transition])
  }

  #authorizeAndTransition(
    input: { ideaId: string; note?: string; principalId?: string },
    action: 'acknowledge' | DreamIdeaTransition,
    targetState: Exclude<IdeaState, 'recorded'>,
  ): DreamIdeaTransitionResult {
    if (!this.#active || !this.#config.enabled || this.#store === undefined || this.#config.scope === null || this.#ports === undefined) {
      throw new Error('assistant-dreaming: dreaming service is not enabled')
    }
    const raw = ownData(input)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('assistant-dreaming: transition input must be an object')
    }
    const ideaId = parseIdeaId(raw.ideaId)
    const scope = this.#config.scope
    if (raw.principalId !== undefined) {
      if (typeof raw.principalId !== 'string' || raw.principalId !== scope.principalId) {
        throw new Error('assistant-dreaming: principalId does not match the configured owner scope')
      }
    }
    // Re-validate the live owner route so a revoked owner cannot mutate ideas.
    this.#ports.delivery.validateOwnerRoute({
      authorityId: scope.ownerRouteId,
      principalId: scope.principalId,
      workspace: scope.workspace,
      agentPreset: scope.preset,
    })
    if (typeof this.#ports.delivery.inspectOwnerRouteState === 'function') {
      const state = this.#ports.delivery.inspectOwnerRouteState({
        authorityId: scope.ownerRouteId,
        principalId: scope.principalId,
        workspace: scope.workspace,
        agentPreset: scope.preset,
      })
      if (state.status !== 'active') throw new Error('assistant-dreaming: owner route is not active')
    }
    const policy = unwrapService(this.ctx.get('assistantPolicy' as never, false)) as PolicyPort | undefined
    if (policy === undefined || typeof policy.authorize !== 'function') {
      throw new Error('assistant-dreaming: assistantPolicy service is required for owner idea transitions')
    }
    if (typeof policy.getEmergencyStop === 'function' && policy.getEmergencyStop().enabled === true) {
      throw new Error('assistant-dreaming: emergency stop is active')
    }
    const decision = policy.authorize({
      subject: {
        kind: 'external',
        id: scope.principalId,
        workspace: scope.workspace,
        principal: scope.principalId,
      },
      action: `dream.${action}`,
      resource: { kind: 'evolution', id: `assistant-dreaming:idea:${ideaId}` },
      context: { initiator: 'foreground' },
    }, {
      idempotencyKey: `dream-idea:${this.#lane}:${ideaId}:${action}`,
      auditDetails: { lane: this.#lane, ideaId, action, targetState },
    })
    if (decision.effect !== 'allow') {
      throw new Error(`assistant-dreaming: owner authorization denied (${decision.reasonCode})`)
    }
    const result = this.#store.transitionIdea(ideaId, targetState, 'owner', Date.now(), raw.note)
    this.#store.pruneResolvedIdeaTickets()
    return result
  }

  /**
   * Owner-visible retirement: pause the system automation and unregister the
   * executor, keeping the private ledger (ideas are never deleted here).
   */
  retire = (): void => {
    if (!this.#config.enabled || this.#store === undefined) return
    this.#active = false
    this.#unsubscribeLlm?.()
    this.#unsubscribeLlm = undefined
    this.#unsubscribeWake?.()
    this.#unsubscribeWake = undefined
    this.#unregister?.()
    this.#unregister = undefined
    try { this.#ports?.automations.reconcileSystem(this.#reconcileInput('paused')) } catch { /* ledger stays readable */ }
    this.#scheduler = 'dormant'
  }
}

function normalizeLimit(limit: number): number {
  return Number.isSafeInteger(limit) ? Math.min(Math.max(1, limit), 200) : 50
}

function parseIdeaId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('assistant-dreaming: ideaId must be a string')
  const normalized = value.normalize('NFC').trim()
  if (normalized.length === 0 || normalized.length > 128 || !normalized.isWellFormed()
    || [...normalized].some(char => { const code = char.codePointAt(0)!; return code <= 0x1f || code === 0x7f })) {
    throw new Error('assistant-dreaming: invalid ideaId')
  }
  return normalized
}

export { Config }
