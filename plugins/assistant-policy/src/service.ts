import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'
import type { Session } from '@deepseek-ai/dsh-session'
import Schema from '@deepseek-ai/schemastery'
import type { ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'
import { registerAutoReviewAnswerer, type AutoReviewConfig } from './auto-review.js'
import {
  approvalPermissionFingerprint,
  approvalPermissionStateOf,
  getApprovalReviewer,
  setApprovalReviewer,
} from './approval-reviewer.js'
import { registerApprovalReviewerSessionEvent } from './session-event-registration.js'
import {
  AUTO_REVIEW_APPROVAL_REASON,
  HUMAN_APPROVAL_REASON,
  classifyToolRisk,
} from './tool-risk.js'
import { compilePolicy, evaluatePolicy } from './evaluator.js'
import {
  PolicyLedger,
  PolicyLedgerError,
  type ApprovalDecisionInput,
  type ApprovalDispatchResult,
  type ApprovalDispatchSnapshot,
  type ApprovalProposalInput,
  type ApprovalProposalLookupInput,
  type ApprovalProposalRecoveryInput,
  type ApprovalProposalRecoveryResult,
  type ApprovalProposalResult,
  type AuditEvent,
  type BudgetReservationInput,
  type BudgetReservationResult,
  type ApprovalProposalSnapshot,
  type EmergencyStopState,
} from './ledger.js'
import type {
  CompiledPolicy,
  PolicyDecision,
  PolicyInitiator,
  PolicyRequest,
  PolicyResource,
  PolicyRule,
  PolicySubject,
} from './types.js'

export interface PolicyBudgetConfig {
  id: string
  metric: string
  limit: number
  periodMs: number
  scope: 'global' | 'subject' | 'workspace'
}

export interface Config {
  databasePath: string
  toolDefaultEffect?: 'deny' | 'allow'
  autoReview?: AutoReviewConfig
  rules?: PolicyRule[]
  budgets?: PolicyBudgetConfig[]
  proposalMaintenanceIntervalMs?: number
}

export interface PolicyBudgetReservationInput {
  budgetId: string
  subject: PolicySubject
  amount: number
  idempotencyKey: string
}

export interface AuthorizationOptions {
  idempotencyKey?: string
  auditDetails?: unknown
}

export interface AssistantPolicyServiceOptions {
  now?: () => number
}

const subjectKindSchema = Schema.union(['agent', 'background', 'external', '*'] as const)
const resourceKindSchema = Schema.union([
  'automation',
  'credential',
  'evolution',
  'filesystem',
  'memory',
  'message',
  'network',
  'preference',
  'tool',
  'wiki',
  '*',
] as const)
const initiatorSchema = Schema.union(['background', 'external', 'foreground'] as const)

const ruleSchema = Schema.object({
  id: Schema.string().min(1).required(),
  effect: Schema.union(['allow', 'deny'] as const).required(),
  subject: Schema.union([Schema.object({
    kind: subjectKindSchema,
    id: Schema.string(),
    workspace: Schema.string(),
    principal: Schema.string(),
  })]),
  actions: Schema.array(Schema.string().min(1)),
  resource: Schema.union([Schema.object({
    kind: resourceKindSchema,
    id: Schema.string(),
  })]),
  context: Schema.union([Schema.object({
    initiators: Schema.array(initiatorSchema),
  })]),
  budget: Schema.union([Schema.object({
    id: Schema.string().min(1).required(),
    amount: Schema.number().min(Number.MIN_VALUE).required(),
  })]),
})

const configSchema = Schema.object({
  databasePath: Schema.string().required(),
  toolDefaultEffect: Schema.union(['deny', 'allow'] as const).default('deny'),
  autoReview: Schema.union([Schema.object({
    enabled: Schema.boolean().default(true),
    provider: Schema.string().min(1),
    model: Schema.string().min(1),
    timeoutMs: Schema.number().step(1).min(1).max(300_000).default(30_000),
    maxTokens: Schema.number().step(1).min(1).max(4_096).default(512),
  })]),
  proposalMaintenanceIntervalMs: Schema.number().step(1).min(0).max(2_147_483_647).default(15_000),
  rules: Schema.array(ruleSchema).default([]),
  budgets: Schema.array(Schema.object({
    id: Schema.string().min(1).required(),
    metric: Schema.string().min(1).required(),
    limit: Schema.number().min(Number.MIN_VALUE).required(),
    periodMs: Schema.number().step(1).min(1).required(),
    scope: Schema.union(['global', 'subject', 'workspace'] as const).required(),
  })).default([]),
}) as Schema<Config>

declare module '@deepseek-ai/cordis' {
  interface Context {
    assistantPolicy: AssistantPolicyService
  }
}

interface BoundInitiator {
  readonly initiator: PolicyInitiator
  readonly principal?: string
  readonly token: symbol
}

export type NativeFullReviewerReconciliation = 'not-applicable' | 'ready' | 'unavailable'

const NATIVE_FULL_ADOPTIONS_GLOBAL_KEY = '__dshEnhancedAssistantPolicyNativeFullAdoptionsV1__'
const NATIVE_FULL_UNSETTLED_GLOBAL_KEY = '__dshEnhancedAssistantPolicyNativeFullUnsettledV1__'

interface NativeFullUnsettledState {
  readonly fingerprint: string
  readonly phase: 'compensating' | 'widened'
}

interface AssistantPolicySharedGlobal {
  [NATIVE_FULL_ADOPTIONS_GLOBAL_KEY]?: WeakMap<Session, Promise<NativeFullReviewerReconciliation>>
  [NATIVE_FULL_UNSETTLED_GLOBAL_KEY]?: WeakMap<Session, NativeFullUnsettledState>
}

/**
 * One process-wide barrier, including across HMR module copies. A service-local
 * map lets a replacement instance observe reviewer=none and execute before the
 * older instance's durability barrier settles.
 */
function sharedNativeFullAdoptions(): WeakMap<Session, Promise<NativeFullReviewerReconciliation>> {
  const shared = globalThis as unknown as AssistantPolicySharedGlobal
  const current = shared[NATIVE_FULL_ADOPTIONS_GLOBAL_KEY]
  if (current !== undefined) return current
  const created = new WeakMap<Session, Promise<NativeFullReviewerReconciliation>>()
  Object.defineProperty(shared, NATIVE_FULL_ADOPTIONS_GLOBAL_KEY, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: created,
  })
  return created
}

function sharedNativeFullUnsettled(): WeakMap<Session, NativeFullUnsettledState> {
  const shared = globalThis as unknown as AssistantPolicySharedGlobal
  const current = shared[NATIVE_FULL_UNSETTLED_GLOBAL_KEY]
  if (current !== undefined) return current
  const created = new WeakMap<Session, NativeFullUnsettledState>()
  Object.defineProperty(shared, NATIVE_FULL_UNSETTLED_GLOBAL_KEY, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: created,
  })
  return created
}

function denial(reasonCode: PolicyDecision['reasonCode']): PolicyDecision {
  return { effect: 'deny', reasonCode, ruleId: undefined }
}

function compileBudgets(configs: readonly PolicyBudgetConfig[]): ReadonlyMap<string, PolicyBudgetConfig> {
  const budgets = new Map<string, PolicyBudgetConfig>()
  for (const config of configs) {
    if (budgets.has(config.id)) throw new Error(`assistant-policy: duplicate budget id: ${config.id}`)
    budgets.set(config.id, Object.freeze({ ...config }))
  }
  return budgets
}

export class AssistantPolicyService extends Service {
  static Config = configSchema

  private readonly policy: CompiledPolicy
  private readonly ledger: PolicyLedger
  private readonly budgets: ReadonlyMap<string, PolicyBudgetConfig>
  private readonly toolDefaultEffect: 'deny' | 'allow'
  private readonly initiators = new WeakMap<Agent, BoundInitiator>()
  private readonly nativeFullAdoptions = sharedNativeFullAdoptions()
  private readonly nativeFullUnsettled = sharedNativeFullUnsettled()
  private readonly reviewerEventRegistration: ReturnType<typeof registerApprovalReviewerSessionEvent>
  private readonly policyContext: Context
  private active = true

  constructor(ctx: Context, input: Config, options: AssistantPolicyServiceOptions = {}) {
    super(ctx, 'assistantPolicy')
    this.policyContext = ctx
    this.reviewerEventRegistration = registerApprovalReviewerSessionEvent(ctx)
    let config: Config
    try {
      config = AssistantPolicyService.Config(input)
    } catch (error) {
      throw new Error(`assistant-policy: invalid configuration: ${String(error)}`, { cause: error })
    }
    this.policy = compilePolicy(config.rules ?? [])
    this.budgets = compileBudgets(config.budgets ?? [])
    this.toolDefaultEffect = config.toolDefaultEffect ?? 'deny'
    this.ledger = new PolicyLedger({
      path: config.databasePath,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    registerAutoReviewAnswerer(ctx, config.autoReview)

    // PermissionPresetService predates AssistantPolicy's third permission
    // dimension. Repair exact legacy native-full sessions at creation/resume,
    // and keep the same promise as a tool-dispatch barrier so concurrent calls
    // cannot observe reviewer=none before its durable flush settles.
    ctx.inject(['sessions', 'permissionPresets'], (permissionCtx) => {
      const adopt = (session: Session): void => {
        void this.ensureNativeFullReviewer(permissionCtx, session)
      }
      permissionCtx.on('session/created', adopt)
      for (const session of permissionCtx.sessions.list()) adopt(session)
    })

    ctx.effect(() => () => {
      this.active = false
      this.ledger.close()
    }, 'assistant-policy.database')
    if ((config.proposalMaintenanceIntervalMs ?? 15_000) > 0) {
      ctx.effect(() => {
        const timer = setInterval(() => {
          if (!this.active) return
          try {
            this.ledger.expireProposals(100)
          } catch {
            // Maintenance is conservative and retried on the next bounded tick.
          }
        }, config.proposalMaintenanceIntervalMs ?? 15_000)
        timer.unref()
        return () => clearInterval(timer)
      }, 'assistant-policy.proposal-maintenance')
    }
    ctx.inject(['tools'], (toolsCtx) => {
      toolsCtx.on('tools/pre-execute', async (execution, next) => {
        const agent = execution.agent
        const workspace = agent?.session.header.cwd
        if (agent === undefined || workspace === undefined || !isAbsolute(workspace)) return next()
        const adoption = await this.ensureNativeFullReviewer(toolsCtx, agent.session)
        if (adoption === 'unavailable') {
          return {
            kind: 'deny',
            reason: 'assistant-policy: full-access reviewer migration could not be persisted; no tool was executed',
          }
        }
        // `ready` only certifies the compatibility write's durability. A Web
        // permission change can win after that promise resolves but before
        // this continuation runs, so authorization must always fold the live
        // three-dimensional state again at the final synchronous boundary.
        if (getApprovalReviewer(agent.session) === 'none') return next()
        const risk = classifyToolRisk({
          name: execution.name,
          arguments: execution.arguments,
          workspace,
        })
        if (risk === 'allow') return next()
        const permission = approvalPermissionStateOf(agent.session.events)
        const configuredApproval = toolsCtx.get('approval')?.config.policy
        const approval = permission.approvalPolicyEvent
          ? permission.approvalPolicy
          : configuredApproval
        if (approval === 'never') {
          return {
            kind: 'deny',
            reason: 'assistant-policy: [approval-disabled] approval is disabled by session policy; '
              + 'no user approval was requested',
          }
        }
        if (risk === 'defer-native-approval') return next()
        return {
          kind: 'ask',
          reason: risk === 'ask-review' ? AUTO_REVIEW_APPROVAL_REASON : HUMAN_APPROVAL_REASON,
        }
      })
      toolsCtx.tools.guard(createPolicyToolGuard(this))
    })
  }

  /**
   * Join or initiate the one process-wide durability barrier for an exact
   * legacy native-full session. `ready` means its reviewer state crossed the
   * shared flush barrier; `not-applicable` means no compatibility event was
   * required; `unavailable` is fail-closed after persistence/compensation
   * could not establish a usable terminal state.
   */
  async reconcileNativeFullReviewer(session: Session): Promise<NativeFullReviewerReconciliation> {
    if (!this.active) return 'unavailable'
    return await this.ensureNativeFullReviewer(this.policyContext, session)
  }

  private nativeFullCandidate(ctx: Context, session: Session): boolean {
    const state = approvalPermissionStateOf(session.events)
    if (state.reviewerEvent
      || !state.sandboxModeEvent || state.sandboxMode !== 'danger-full-access'
      || !state.approvalPolicyEvent || state.approvalPolicy !== 'never') return false
    const selected = session.events.findLast(event => event.type === 'permission/preset')?.data.preset
    if (typeof selected !== 'string' || selected === '') return false
    const presets = ctx.get('permissionPresets') as PermissionPresetService | undefined
    if (presets === undefined) return false
    try {
      const spec = presets.resolve(selected)
      return spec.sandbox === 'danger-full-access'
        && spec.approval === 'never'
        && presets.current(session.events) === selected
    } catch {
      return false
    }
  }

  private async ensureNativeFullReviewer(
    ctx: Context,
    session: Session,
  ): Promise<NativeFullReviewerReconciliation> {
    const inFlight = this.nativeFullAdoptions.get(session)
    if (inFlight !== undefined) return await inFlight
    const unsettled = this.nativeFullUnsettled.get(session)
    if (unsettled !== undefined) {
      if (approvalPermissionFingerprint(session.events) !== unsettled.fingerprint) {
        // A later permission operation owns the session now. Never compensate
        // over its new state merely because an older migration was ambiguous.
        this.nativeFullUnsettled.delete(session)
      } else {
        const sessions = ctx.get('sessions')
        if (sessions === undefined) return 'unavailable'
        const recovery = Promise.resolve().then(async (): Promise<NativeFullReviewerReconciliation> => {
          try {
            await this.reviewerEventRegistration.assertReady()
            if (approvalPermissionFingerprint(session.events) !== unsettled.fingerprint) {
              this.nativeFullUnsettled.delete(session)
              return 'unavailable'
            }
            let compensation = unsettled
            if (unsettled.phase === 'widened') {
              setApprovalReviewer(session, 'user')
              compensation = {
                fingerprint: approvalPermissionFingerprint(session.events),
                phase: 'compensating',
              }
              this.nativeFullUnsettled.set(session, compensation)
            }
            if (await sessions.flush(session)
              && approvalPermissionFingerprint(session.events) === compensation.fingerprint
              && getApprovalReviewer(session) === 'user') {
              this.nativeFullUnsettled.delete(session)
            }
          } catch {
            // Keep the exact unsettled fingerprint for a later reader/flush retry.
          }
          // A caller that observed an ambiguous widening must retry after the
          // conservative terminal state is durably established.
          return 'unavailable'
        })
        this.nativeFullAdoptions.set(session, recovery)
        try {
          return await recovery
        } finally {
          if (this.nativeFullAdoptions.get(session) === recovery) {
            this.nativeFullAdoptions.delete(session)
          }
        }
      }
    }
    if (getApprovalReviewer(session) === 'none') return 'ready'
    if (!this.nativeFullCandidate(ctx, session)) return 'not-applicable'
    const sessions = ctx.get('sessions')
    if (sessions === undefined) return 'unavailable'

    const adoption = Promise.resolve().then(async (): Promise<NativeFullReviewerReconciliation> => {
      try {
        await this.reviewerEventRegistration.assertReady()
      } catch {
        return 'unavailable'
      }
      let expectedPermission: string | undefined
      try {
        if (!setApprovalReviewer(session, 'none') && getApprovalReviewer(session) !== 'none') {
          return 'unavailable'
        }
        expectedPermission = approvalPermissionFingerprint(session.events)
        this.nativeFullUnsettled.set(session, {
          fingerprint: expectedPermission,
          phase: 'widened',
        })
        if (await sessions.flush(session)) {
          // A Web permission change may race the durability barrier. Never let
          // the old full-state migration authorize a call after a newer
          // downgrade or reviewer selection has won.
          if (approvalPermissionFingerprint(session.events) === expectedPermission
            && getApprovalReviewer(session) === 'none') {
            this.nativeFullUnsettled.delete(session)
            return 'ready'
          }
          this.nativeFullUnsettled.delete(session)
          return 'not-applicable'
        }
      } catch {
        // Fall through to the conservative in-memory compensation below.
      }
      // A newer Web/picker choice owns the state now. The failed older
      // migration must deny its tool, but must not append reviewer=user over
      // that newer choice merely because its own flush acknowledgement failed.
      if (expectedPermission !== undefined
        && approvalPermissionFingerprint(session.events) !== expectedPermission) {
        this.nativeFullUnsettled.delete(session)
        return 'unavailable'
      }
      try {
        setApprovalReviewer(session, 'user')
        const compensation: NativeFullUnsettledState = {
          fingerprint: approvalPermissionFingerprint(session.events),
          phase: 'compensating',
        }
        this.nativeFullUnsettled.set(session, compensation)
        // The first flush may have thrown after committing reviewer=none.
        // Best-effort a second barrier so a cold resume cannot observe only
        // the widening half of this compatibility migration.
        if (await sessions.flush(session)
          && approvalPermissionFingerprint(session.events) === compensation.fingerprint
          && getApprovalReviewer(session) === 'user') {
          this.nativeFullUnsettled.delete(session)
        }
      } catch {}
      return 'unavailable'
    })
    this.nativeFullAdoptions.set(session, adoption)
    try {
      return await adoption
    } finally {
      if (this.nativeFullAdoptions.get(session) === adoption) this.nativeFullAdoptions.delete(session)
    }
  }

  private assertActive(): void {
    if (!this.active) throw new Error('assistant-policy service is disposed')
  }

  evaluate(request: PolicyRequest): PolicyDecision {
    this.assertActive()
    if (this.ledger.getEmergencyStop().enabled) return denial('emergency-stop')
    return evaluatePolicy(this.policy, request)
  }

  authorize(request: PolicyRequest, options: AuthorizationOptions = {}): PolicyDecision {
    let decision = this.evaluate(request)
    if (decision.effect === 'allow' && decision.budget !== undefined) {
      decision = this.consumeAuthorizationBudget(request.subject, decision, options.idempotencyKey)
    }
    this.ledger.appendAudit({
      actor: `${request.subject.kind}:${request.subject.id}`,
      action: request.action,
      resource: request.resource,
      outcome: decision.effect === 'allow' ? 'allowed' : 'denied',
      reasonCode: decision.reasonCode,
      details: options.auditDetails ?? {},
    })
    return decision
  }

  /** Read-only declaration lookup for consumers that must prove metric compatibility before reserving. */
  getBudgetConfig(budgetId: string): Readonly<PolicyBudgetConfig> | undefined {
    this.assertActive()
    return this.budgets.get(budgetId)
  }

  reserve(input: PolicyBudgetReservationInput): BudgetReservationResult {
    this.assertActive()
    const result = this.reserveConfiguredBudget(input)
    this.ledger.appendAudit({
      actor: `${input.subject.kind}:${input.subject.id}`,
      action: 'budget.reserve',
      resource: { kind: 'budget', id: input.budgetId },
      outcome: result.status,
      reasonCode: result.replayed ? 'idempotent-replay' : 'reserved',
      details: { amount: input.amount, remaining: result.remaining },
    })
    return result
  }

  finalize(reservationId: string, actualAmount: number): BudgetReservationResult {
    this.assertActive()
    const result = this.ledger.finalize(reservationId, actualAmount)
    this.ledger.appendAudit({
      actor: 'system',
      action: 'budget.finalize',
      resource: { kind: 'budget-reservation', id: reservationId },
      outcome: result.status,
      reasonCode: result.replayed ? 'idempotent-replay' : 'finalized',
      details: { actualAmount, remaining: result.remaining },
    })
    return result
  }

  release(reservationId: string): BudgetReservationResult {
    this.assertActive()
    const result = this.ledger.release(reservationId)
    this.ledger.appendAudit({
      actor: 'system',
      action: 'budget.release',
      resource: { kind: 'budget-reservation', id: reservationId },
      outcome: result.status,
      reasonCode: result.replayed ? 'idempotent-replay' : 'released',
      details: { remaining: result.remaining },
    })
    return result
  }

  propose(input: ApprovalProposalInput): ApprovalProposalResult {
    this.assertActive()
    const result = this.ledger.propose(input)
    this.ledger.appendAudit({
      actor: input.requester,
      action: 'approval.propose',
      resource: { kind: 'approval-proposal', id: result.proposalId },
      outcome: result.status,
      reasonCode: result.replayed ? 'idempotent-replay' : 'proposal-created',
      details: { diffHash: result.diffHash, expiresAt: result.expiresAt },
    })
    return result
  }

  decideProposal(input: ApprovalDecisionInput): ApprovalProposalResult {
    this.assertActive()
    const result = this.ledger.decideProposal(input)
    this.ledger.appendAudit({
      actor: input.principal,
      action: 'approval.decide',
      resource: { kind: 'approval-proposal', id: result.proposalId },
      outcome: result.status,
      reasonCode: result.replayed ? 'idempotent-replay' : 'principal-decision',
      details: { decision: input.decision, status: result.status },
    })
    return result
  }

  expireProposals(limit = 100): number {
    this.assertActive()
    return this.ledger.expireProposals(limit)
  }

  /**
   * Read one proposal's current status without deciding it. Policy deliberately
   * never calls back into a domain, so a domain reconciler polls this seam and
   * then commits the decided outcome through its own approval gate.
   */
  getProposal(proposalId: string): ApprovalProposalSnapshot | undefined {
    this.assertActive()
    return this.ledger.getProposal(proposalId)
  }

  /**
   * Read-only recovery for the cross-database window where Policy committed a
   * proposal but the owning domain did not persist its proposal ID.
   */
  getProposalByIdempotencyKey(input: ApprovalProposalLookupInput): ApprovalProposalSnapshot | undefined {
    this.assertActive()
    return this.ledger.getProposalByIdempotencyKey(input)
  }

  /**
   * Atomic cross-database recovery/creation under an absolute deadline. Once the
   * deadline passes without a proposal, Policy tombstones the idempotency key so
   * another process cannot create an orphan approval dispatch later.
   */
  recoverOrCreateProposal(input: ApprovalProposalRecoveryInput): ApprovalProposalRecoveryResult {
    this.assertActive()
    const result = this.ledger.recoverOrCreateProposal(input)
    this.ledger.appendAudit({
      actor: input.requester,
      action: 'approval.recover-or-create',
      resource: { kind: 'approval-idempotency', id: input.idempotencyKey },
      outcome: result.kind === 'proposal' ? result.proposal.status : 'abandoned',
      reasonCode: result.kind === 'proposal'
        ? (result.proposal.replayed ? 'idempotent-recovery' : 'proposal-created')
        : (result.replayed ? 'abandonment-replay' : 'deadline-elapsed'),
      details: result.kind === 'proposal'
        ? { proposalId: result.proposal.proposalId, expiresAt: result.proposal.expiresAt }
        : { notAfter: result.notAfter, abandonedAt: result.abandonedAt },
    })
    return result
  }

  listPendingApprovalDispatches(
    limit = 100,
    after?: Readonly<import('./ledger.js').ApprovalDispatchCursor>,
  ): ApprovalDispatchSnapshot[] {
    this.assertActive()
    return this.ledger.listPendingApprovalDispatches(limit, after)
  }

  markApprovalDispatchEnqueued(
    proposalId: string,
    expectedVersion: number,
  ): ApprovalDispatchResult {
    this.assertActive()
    const result = this.ledger.markApprovalDispatchEnqueued(proposalId, expectedVersion)
    this.ledger.appendAudit({
      actor: 'system:approval-dispatch',
      action: 'approval.dispatch.enqueue',
      resource: { kind: 'approval-proposal', id: proposalId },
      outcome: result.state,
      reasonCode: result.replayed ? 'idempotent-replay' : 'enqueued',
      details: { payloadHash: result.payloadHash, dispatchVersion: result.version },
    })
    return result
  }

  setEmergencyStop(input: { enabled: boolean; actor: string; reason: string }): EmergencyStopState {
    this.assertActive()
    const state = this.ledger.setEmergencyStop(input)
    this.ledger.appendAudit({
      actor: input.actor,
      action: 'policy.emergency-stop',
      resource: { kind: 'policy', id: 'emergency-stop' },
      outcome: input.enabled ? 'enabled' : 'disabled',
      reasonCode: 'owner-change',
      details: { enabled: input.enabled, reason: input.reason },
    })
    return state
  }

  getEmergencyStop(): EmergencyStopState {
    this.assertActive()
    return this.ledger.getEmergencyStop()
  }

  queryAudit(options: { afterSequence?: number; limit?: number } = {}): AuditEvent[] {
    this.assertActive()
    return this.ledger.queryAudit(options)
  }

  health(): { emergencyStop: boolean; lastAuditSequence: number } {
    this.assertActive()
    return {
      emergencyStop: this.ledger.getEmergencyStop().enabled,
      lastAuditSequence: this.ledger.health().lastAuditSequence,
    }
  }

  bindInitiator(agent: Agent, initiator: PolicyInitiator, principal?: string): () => void {
    this.assertActive()
    const previous = this.initiators.get(agent)
    const binding: BoundInitiator = {
      initiator,
      ...(principal === undefined ? {} : { principal }),
      token: Symbol('assistant-policy-initiator'),
    }
    this.initiators.set(agent, binding)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.initiators.get(agent)?.token !== binding.token) return
      if (previous === undefined) this.initiators.delete(agent)
      else this.initiators.set(agent, previous)
    }
  }

  authorizeAgent(
    agent: Agent | undefined,
    action: string,
    resource: PolicyResource,
    options: AuthorizationOptions = {},
  ): PolicyDecision {
    this.assertActive()
    if (agent === undefined) return this.auditAgentIdentityFailure(action, resource, 'missing-agent')
    const workspace = agent.session.header.cwd
    if (workspace === undefined || !isAbsolute(workspace)) {
      return this.auditAgentIdentityFailure(action, resource, 'missing-workspace')
    }
    const preset = agent.session.header.agentPreset
    if (preset === undefined || preset === '') {
      return this.auditAgentIdentityFailure(action, resource, 'missing-agent-preset')
    }
    const authority = this.initiators.get(agent)
    return this.authorize({
      subject: {
        kind: 'agent',
        id: preset,
        workspace,
        ...(authority?.principal === undefined ? {} : { principal: authority.principal }),
      },
      action,
      resource,
      context: { initiator: authority?.initiator ?? 'foreground' },
    }, options)
  }

  authorizeToolExecution(execution: Readonly<ToolExecution>): PolicyDecision {
    this.assertActive()
    const agent = execution.agent
    if (agent === undefined) return this.auditToolIdentityFailure(execution, 'missing-agent')
    const workspace = agent.session.header.cwd
    if (workspace === undefined || !isAbsolute(workspace)) {
      return this.auditToolIdentityFailure(execution, 'missing-workspace')
    }
    const preset = agent.session.header.agentPreset
    if (preset === undefined || preset === '') {
      return this.auditToolIdentityFailure(execution, 'missing-agent-preset')
    }
    const authority = this.initiators.get(agent)
    const request: PolicyRequest = {
      subject: {
        kind: 'agent',
        id: preset,
        workspace,
        ...(authority?.principal === undefined ? {} : { principal: authority.principal }),
      },
      action: 'execute',
      resource: { kind: 'tool', id: execution.name },
      context: { initiator: authority?.initiator ?? 'foreground' },
    }
    let decision = this.evaluate(request)
    if (decision.reasonCode === 'default-deny' && this.toolDefaultEffect === 'allow') {
      decision = { effect: 'allow', reasonCode: 'tool-default-allow', ruleId: undefined }
    }
    if (decision.effect === 'allow' && decision.budget !== undefined) {
      decision = this.consumeAuthorizationBudget(
        request.subject,
        decision,
        `tool:${String(execution.rootCallId)}:${String(execution.callId)}`,
      )
    }
    this.ledger.appendAudit({
      actor: `${request.subject.kind}:${request.subject.id}`,
      action: request.action,
      resource: request.resource,
      outcome: decision.effect === 'allow' ? 'allowed' : 'denied',
      reasonCode: decision.reasonCode,
      details: {
        callId: execution.callId,
        rootCallId: execution.rootCallId,
        arguments: execution.arguments,
      },
    })
    return decision
  }

  private auditAgentIdentityFailure(
    action: string,
    resource: PolicyResource,
    reasonCode: Extract<PolicyDecision['reasonCode'], 'missing-agent' | 'missing-agent-preset' | 'missing-workspace'>,
  ): PolicyDecision {
    const decision = denial(reasonCode)
    this.ledger.appendAudit({
      actor: 'unknown-agent',
      action,
      resource,
      outcome: 'denied',
      reasonCode,
      details: {},
    })
    return decision
  }

  private consumeAuthorizationBudget(
    subject: PolicySubject,
    decision: PolicyDecision,
    idempotencyKey: string | undefined,
  ): PolicyDecision {
    const charge = decision.budget
    if (charge === undefined) return decision
    if (idempotencyKey === undefined || idempotencyKey.trim() === '') {
      return denial('budget-idempotency-required')
    }
    try {
      const reservation = this.reserveConfiguredBudget({
        budgetId: charge.id,
        subject,
        amount: charge.amount,
        idempotencyKey,
      })
      this.ledger.finalize(reservation.reservationId, charge.amount)
      return decision
    } catch (error) {
      if (error instanceof PolicyLedgerError && error.code === 'budget-exhausted') {
        return denial('budget-exhausted')
      }
      if (error instanceof AssistantPolicyError && error.code === 'budget-not-configured') {
        return denial('budget-not-configured')
      }
      throw error
    }
  }

  private reserveConfiguredBudget(input: PolicyBudgetReservationInput): BudgetReservationResult {
    const budget = this.budgets.get(input.budgetId)
    if (budget === undefined) {
      throw new AssistantPolicyError('budget-not-configured', `budget is not configured: ${input.budgetId}`)
    }
    let scope: string
    switch (budget.scope) {
      case 'global':
        scope = 'global'
        break
      case 'subject':
        scope = `${input.subject.kind}:${input.subject.id}`
        break
      case 'workspace':
        if (input.subject.workspace === undefined || input.subject.workspace === '') {
          throw new AssistantPolicyError('missing-workspace', 'workspace-scoped budget requires a workspace')
        }
        scope = `workspace:${input.subject.workspace}`
        break
    }
    const ledgerInput: BudgetReservationInput = {
      scope,
      metric: budget.metric,
      limit: budget.limit,
      amount: input.amount,
      periodMs: budget.periodMs,
      idempotencyKey: input.idempotencyKey,
    }
    return this.ledger.reserve(ledgerInput)
  }

  private auditToolIdentityFailure(
    execution: Readonly<ToolExecution>,
    reasonCode: 'missing-agent' | 'missing-agent-preset' | 'missing-workspace',
  ): PolicyDecision {
    const decision = denial(reasonCode)
    this.ledger.appendAudit({
      actor: 'unknown',
      action: 'execute',
      resource: { kind: 'tool', id: execution.name },
      outcome: 'denied',
      reasonCode,
      details: {
        callId: execution.callId,
        rootCallId: execution.rootCallId,
        arguments: execution.arguments,
      },
    })
    return decision
  }
}

export function createPolicyToolGuard(service: AssistantPolicyService): ToolGuard {
  return (execution) => {
    try {
      const decision = service.authorizeToolExecution(execution)
      if (decision.effect === 'allow') return undefined
      return `assistant-policy: ${decision.reasonCode}${decision.ruleId === undefined ? '' : ` (${decision.ruleId})`}`
    } catch {
      return 'assistant-policy: policy-error'
    }
  }
}

export class AssistantPolicyError extends Error {
  constructor(
    readonly code: 'budget-not-configured' | 'missing-workspace',
    message: string,
  ) {
    super(message)
    this.name = 'AssistantPolicyError'
  }
}

export const Config = AssistantPolicyService.Config
