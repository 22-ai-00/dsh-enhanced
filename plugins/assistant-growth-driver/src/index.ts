import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { AssistantDeliveryService, OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import type { AssistantGoalsService, OwnerGoalExecutionSnapshotInput } from '@dsh-enhanced/assistant-goals'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { AssistantSkillsService } from '@dsh-enhanced/assistant-skills'
import { Config, DEFAULT_API_KEY_ENV, normalizeConfig, type AssistantGrowthDriverConfig } from './config.js'
import { mintGrowthAuthority, type GrowthAuthority, type GrowthDeliveryPort } from './deposit.js'
import { runGrowthAgent, type GrowthAgentRunResult } from './growth-agent.js'
import { version } from './version.js'
import type { GrowthSourceGap, GrowthSourcePlanePort } from './source-port.js'
import { UsageLearningRuntime, type UsageReviewInput, type UsageReviewResult } from './usage-runtime.js'

export const name = 'dsh-enhanced-assistant-growth-driver'
export { version, Config, normalizeConfig }
export type { AssistantGrowthDriverConfig } from './config.js'
export type { GrowthAuthority } from './deposit.js'

/**
 * Outcome of the owner-anchored workflow track in one wake. This track is
 * purely Host-local (Delivery re-reads Goals and writes a paused candidate; no
 * model call), so it is reported separately from the model-driven skill track.
 * `stopped` is non-null when a fail-closed Delivery/Goals condition halted the
 * track before the rate limit was reached.
 */
export interface OwnerAnchoredWakeSummary {
  readonly considered: number
  readonly attempted: number
  readonly recorded: number
  readonly replayed: number
  readonly abstained: number
  readonly stopped: string | null
}

export interface GrowthWakeHealth {
  readonly lastWakeAt: number | null
  readonly outcome: 'never-run' | 'ran' | 'skipped' | 'failed'
  readonly reason: string | null
  readonly run: GrowthAgentRunResult | null
  // Explicit `| undefined` (not just `?`): health writes spread this field even
  // when the opt-in owner-anchored track never ran, and exactOptionalPropertyTypes
  // rejects assigning an implicit-undefined optional property otherwise.
  readonly ownerAnchored?: OwnerAnchoredWakeSummary | undefined
}

type InspectedOwnerGoal = ReturnType<AssistantGoalsService['inspectOwnerGoals']>[number]

interface CredentialService {
  resolve(ref: ReturnType<typeof credentialRef>): Promise<{ value: string } | undefined>
}

type Policy = Pick<AssistantPolicyService, 'bindInitiator' | 'reserve' | 'finalize' | 'release'>

/**
 * cordis 4.0.2 hands cross-plugin service consumers a traceable Proxy whose
 * shadow-method trap rebinds `this` to a second Proxy; ES #private brand
 * checks then throw ("Cannot read private member … from an object whose class
 * did not declare it").  The library exposes the raw instance through
 * Symbol.for('cordis.original') on every traceable Proxy; plain-object mocks
 * have no such marker and pass through unchanged.
 */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')
function unwrapService<T>(service: T): T {
  return (service as { [CORDIS_ORIGINAL]?: T } | null | undefined)?.[CORDIS_ORIGINAL] ?? service
}

/**
 * Opt-in, fail-closed periodic growth driver.  Every wake:
 *   1. re-anchors the frozen configured owner scope against Delivery;
 *   2. freezes the conversation's model (or explicit fixed override), applying
 *      supplier-specific credential/contract checks only to that supplier;
 *   3. optionally reserves an owner-configured background budget;
 *   4. runs ONE bounded background agent that may only read history and
 *      propose a paused skill candidate through Host re-verification.
 * Any failed precondition skips the wake with a health reason: the driver
 * never changes route, never falls back to another model and never self-enables.
 */
export class AssistantGrowthDriverService extends Service {
  static Config = Config
  static inject = ['assistantGoals', 'assistantSkills', 'assistantPolicy', 'assistantDelivery', 'agents', 'sessions', 'tools', 'llm']

  readonly #config: ReturnType<typeof normalizeConfig>
  #flight: Promise<void> | undefined
  #active = true
  readonly #abort = new AbortController()
  #sourceBinding: { port: GrowthSourcePlanePort; signal: AbortSignal; available: () => boolean; recordTaskFailure: (source: OwnerForegroundLearningTask) => GrowthSourceGap } | undefined
  #health: GrowthWakeHealth = { lastWakeAt: null, outcome: 'never-run', reason: null, run: null }
  #usage: UsageLearningRuntime | undefined

  constructor(ctx: Context, input: AssistantGrowthDriverConfig = {}) {
    super(ctx, 'assistantGrowthDriver')
    this.#config = normalizeConfig(input)
    ctx.effect(() => {
      const timer = this.#config.enabled && this.#config.intervalMs > 0
        ? setInterval(() => { void this.wake().catch(() => undefined) }, this.#config.intervalMs) : undefined
      timer?.unref?.()
      return async () => {
        this.#active = false
        if (timer !== undefined) clearInterval(timer)
        this.#abort.abort(new Error('assistant-growth-driver: disposed'))
        await this.#flight
      }
    }, 'assistant-growth-driver.runtime')
    if (this.#config.usageLearning.enabled) {
      ctx.inject(['assistantEvaluation', 'assistantAutomations'], usageCtx => {
        const usage = new UsageLearningRuntime(this.#config, {
          evaluation: usageCtx.assistantEvaluation, automations: usageCtx.assistantAutomations,
          delivery: usageCtx.assistantDelivery, review: input => this.#reviewUsage(input),
        })
        usageCtx.effect(() => async () => {
          if (this.#usage === usage) this.#usage = undefined
          await usage.close()
        }, 'assistant-growth-driver.usage-learning')
        this.#usage = usage
        usage.start()
      })
    }
    if (this.#config.pluginSourceProposals.enabled) {
      // Optional provider lives in a nested injection. Its generation owns the
      // source capability and cancellation; the outer driver remains usable
      // when the control plane is absent or is being replaced.
      ctx.inject(['pluginControlPlane' as never], sourceCtx => {
        const abort = new AbortController()
        type SourceService = Pick<GrowthSourcePlanePort, 'prepareModifySourcePlan' | 'inspectSource' | 'enqueueSourceJob' | 'inspectSourceJob'> & {
          gaps(limit: number): readonly GrowthSourceGap[]
          recordOwnerTaskFailureGap?: (source: OwnerForegroundLearningTask) => GrowthSourceGap
          canPrepareSource?: () => boolean
          canEnqueueSource?: () => boolean
        }
        const current = (): SourceService => {
          abort.signal.throwIfAborted()
          return sourceCtx.get('pluginControlPlane' as never) as unknown as SourceService
        }
        const provider = current()
        const durable = this.#config.pluginSourceProposals.preparationMode === 'durable'
        // Bind API seams, not this generation's availability. Automations can
        // appear after the control plane: canEnqueueSource then changes from
        // false to true without a control-plane reload.
        const seamsPresent = durable
          ? typeof provider.canEnqueueSource === 'function' && typeof provider.enqueueSourceJob === 'function' && typeof provider.inspectSourceJob === 'function'
          : typeof provider.canPrepareSource === 'function' && typeof provider.prepareModifySourcePlan === 'function'
        if (!seamsPresent || typeof provider.inspectSource !== 'function') return
        const binding = {
          signal: abort.signal,
          recordTaskFailure: (source: OwnerForegroundLearningTask) => {
            const live = current()
            if (typeof live.recordOwnerTaskFailureGap !== 'function') throw new Error('control plane owner task gap API unavailable')
            return live.recordOwnerTaskFailureGap(source)
          },
          available: () => {
            try {
              const live = current()
              return durable ? live.canEnqueueSource?.() === true : live.canPrepareSource?.() === true
            } catch { return false }
          },
          port: {
            listOpenGaps: () => current().gaps(50),
            inspectSource: async (input: Parameters<GrowthSourcePlanePort['inspectSource']>[0]) => {
              const signal = AbortSignal.any([input.signal, abort.signal, this.#abort.signal])
              return current().inspectSource({ ...input, signal,
                assertCurrent: () => { signal.throwIfAborted(); current(); input.assertCurrent() },
              })
            },
            prepareModifySourcePlan: async (input: Parameters<GrowthSourcePlanePort['prepareModifySourcePlan']>[0]) => {
              const signal = AbortSignal.any([input.signal, abort.signal, this.#abort.signal])
              return current().prepareModifySourcePlan({ ...input, signal,
                assertCurrent: () => { signal.throwIfAborted(); current(); input.assertCurrent() },
              })
            },
            enqueueSourceJob: async (input: Parameters<GrowthSourcePlanePort['enqueueSourceJob']>[0]) => {
              const signal = AbortSignal.any([input.signal, abort.signal, this.#abort.signal])
              // Do not add route/configuration/timeout fields here. The
              // control-plane durable authority owns those independently.
              return current().enqueueSourceJob({ ...input, signal,
                assertCurrent: () => { signal.throwIfAborted(); current(); input.assertCurrent() },
              })
            },
            inspectSourceJob: (input: Parameters<GrowthSourcePlanePort['inspectSourceJob']>[0]) =>
              current().inspectSourceJob(input),
          } satisfies GrowthSourcePlanePort,
        }
        this.#sourceBinding = binding
        sourceCtx.effect(() => () => {
          abort.abort(new Error('assistant-growth-driver: source provider changed'))
          if (this.#sourceBinding === binding) this.#sourceBinding = undefined
        }, 'assistant-growth-driver.source-provider')
      })
    }
  }

  // Cordis traces public service calls through a proxy. Bind these entry points
  // to the owning instance so private state and the wake's Fiber stay intact.
  health = (): GrowthWakeHealth => this.#health
  usageHealth = () => this.#usage?.health() ?? { enabled: this.#config.usageLearning.enabled, connected: false }

  async #reviewUsage(input: UsageReviewInput): Promise<UsageReviewResult> {
    // Unlike timer nudges, a durable job must run its own frozen source, never
    // coalesce onto an unrelated manual wake and report that wake as its result.
    while (this.#flight !== undefined) { await this.#flight; input.assertCurrent() }
    input.assertCurrent()
    let outcome: UsageReviewResult = 'unknown'
    const flight = this.#runWake({ usage: input }).then(() => {
      outcome = this.#health.outcome === 'ran' && this.#health.run?.outcome === 'succeeded' ? 'reviewed' : 'unknown'
    }).finally(() => { if (this.#flight === flight) this.#flight = undefined })
    this.#flight = flight
    await flight
    return outcome
  }

  /** Run one wake immediately (also used by tests / an explicit Host trigger). */
  wake = (input: { sourceAgent?: Agent } = {}): Promise<void> => {
    if (!this.#active || !this.#config.enabled) return Promise.resolve()
    // Coalesce explicit and timer wakes onto the same bounded run. Queueing
    // timer ticks would build an unbounded backlog when a build is slow.
    if (this.#flight !== undefined) return this.#flight
    const flight = this.#runWake(input).finally(() => { if (this.#flight === flight) this.#flight = undefined })
    this.#flight = flight
    return flight
  }

  async #resolveCredential(provider: string): Promise<boolean> {
    const env = this.#config.apiKeyEnv ?? (provider === 'super-relay' ? DEFAULT_API_KEY_ENV : null)
    // Other adapters own their credentials; do not require a Super Relay key
    // merely because the growth plugin happens to be installed.
    if (env === null) return true
    const credentials = this.ctx.get('credentials' as never, false) as CredentialService | undefined
    const resolved = credentials === undefined ? undefined : (await credentials.resolve(credentialRef(env)))?.value
    const key = resolved ?? process.env[env]
    return typeof key === 'string' && key.length > 0
  }

  async #runWake(input: { sourceAgent?: Agent; usage?: UsageReviewInput }): Promise<void> {
    const wakeId = input.usage?.id ?? `growth-wake-${Date.now()}-${randomUUID()}`
    const startedAt = Date.now()
    const config = this.#config
    if (!config.scope) {
      this.#health = { lastWakeAt: startedAt, outcome: 'skipped', reason: 'missing-scope', run: null }
      return
    }
    const delivery = unwrapService(this.ctx.get('assistantDelivery')) as Pick<AssistantDeliveryService, 'validateOwnerRoute' | 'commitOwnerAnchoredWorkflowTrace' | 'inspectOwnerModelSelection'>
    const policy = unwrapService(this.ctx.get('assistantPolicy' as never, false)) as Policy | undefined
    const goals = unwrapService(this.ctx.get('assistantGoals' as never)) as unknown as Pick<AssistantGoalsService, 'inspectOwnerGoals' | 'inspectOwnerVerifiedWorkflowSource'>
    const skills = unwrapService(this.ctx.get('assistantSkills' as never)) as unknown as Pick<AssistantSkillsService, 'inspectOwnerActiveSkills' | 'inspectOwnerSkillCandidates' | 'stageOwnerVerifiedSuccessCandidate'>

    // ---- preflight (no network, no agent) ----
    let authority
    try {
      authority = mintGrowthAuthority(delivery as unknown as GrowthDeliveryPort, config.scope, startedAt + config.maxDurationMs)
      if (input.usage) {
        const base = authority, usage = input.usage
        authority = Object.freeze({ ...base, assertCurrent() { base.assertCurrent(); usage.assertCurrent() } })
        authority.assertCurrent()
      }
    } catch (error) {
      this.#health = { lastWakeAt: startedAt, outcome: 'skipped', reason: `missing-binding:${errorMessage(error)}`, run: null }
      return
    }
    let model: Readonly<ModelSelection> | undefined
    let modelFailure: string | undefined
    try {
      const selected = input.usage?.model ?? (config.provider !== null && config.model !== null
        ? { provider: config.provider, model: config.model,
          ...(config.reasoningEffort === null ? {} : { reasoningEffort: config.reasoningEffort }) }
        : delivery.inspectOwnerModelSelection({ authorityId: config.scope.ownerRouteId,
          principalId: config.scope.principalId, workspace: config.scope.workspace,
          agentPreset: config.scope.preset,
          ...(input.sourceAgent === undefined ? {} : { sourceAgent: input.sourceAgent }) }))
      if (!selected.provider || !selected.model) throw new Error('owner model selection is unavailable')
      model = Object.freeze({ provider: selected.provider, model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selected.reasoningEffort) }) })
      authority.assertCurrent()
    } catch (error) { modelFailure = errorMessage(error) }
    // Owner-anchored workflow learning is a separate, purely Host-local track.
    // It needs only the anchored owner authority and performs no model/network
    // call, so it runs before the super-relay credential/budget gates. Failure
    // here never blocks the model-driven skill track below.
    let ownerAnchored: OwnerAnchoredWakeSummary | undefined
    if (config.workflowOwnerAnchored.enabled) {
      ownerAnchored = await this.#runOwnerAnchoredTrack({
        startedAt, authority, goals, delivery: delivery as unknown as GrowthDeliveryPort,
      })
    }
    if (model === undefined || modelFailure !== undefined) {
      this.#health = { lastWakeAt: startedAt, outcome: 'skipped', reason: `missing-model:${modelFailure ?? 'unavailable'}`, run: null, ownerAnchored }
      return
    }
    try {
      if (model.provider === 'super-relay') {
        const { assertCurrentContract } = await import('@dsh-enhanced/assistant-super-relay-budget')
        assertCurrentContract()
      }
    } catch (error) {
      this.#health = { lastWakeAt: startedAt, outcome: 'skipped', reason: `contract-expired:${errorMessage(error)}`, run: null, ownerAnchored }
      return
    }
    if (!await this.#resolveCredential(model.provider)) {
      this.#health = { lastWakeAt: startedAt, outcome: 'skipped', reason: 'missing-credential', run: null, ownerAnchored }
      return
    }
    if (policy === undefined) {
      this.#health = { lastWakeAt: startedAt, outcome: 'skipped', reason: 'missing-policy', run: null, ownerAnchored }
      return
    }

    let reservationId: string | undefined
    let reservationSettled = false
    let agentSubmitted = false
    if (input.usage === undefined && config.budgetId !== null && config.budgetAmount !== null) {
      try {
        const reservation = policy.reserve({
          budgetId: config.budgetId,
          subject: { kind: 'background' as const, id: wakeId, workspace: config.scope.workspace, principal: config.scope.principalId },
          amount: config.budgetAmount,
          idempotencyKey: `growth-budget:${wakeId}`,
        })
        if (reservation.status !== 'reserved') {
          this.#health = { lastWakeAt: startedAt, outcome: 'skipped', reason: `budget:${reservation.status}`, run: null, ownerAnchored }
          return
        }
        reservationId = reservation.reservationId
      } catch (error) {
        this.#health = { lastWakeAt: startedAt, outcome: 'skipped', reason: `budget:${errorMessage(error)}`, run: null, ownerAnchored }
        return
      }
    }

    try {
      agentSubmitted = true
      const bound = this.#sourceBinding
      const source = bound !== undefined && bound.available() ? bound : undefined
      let sourcePort = source?.port
      if (source && input.usage) {
        const usage = input.usage
        const ownGaps = (): readonly GrowthSourceGap[] => {
          usage.assertCurrent()
          return usage.source.canonical.objective?.status === 'not-achieved'
            ? [source.recordTaskFailure(usage.source)] : []
        }
        // Persist the exact failure before submitting the model; neither a
        // model assertion nor an operator's global gap is a prerequisite.
        ownGaps()
        const assertGap = (gapId: string): void => {
          if (!ownGaps().some(gap => gap.id === gapId && gap.status === 'open' && gap.candidateId === undefined)) {
            throw new Error('source gap is not the current task failure')
          }
        }
        sourcePort = { ...source.port, listOpenGaps: ownGaps,
          prepareModifySourcePlan: request => { assertGap(request.gapId); return source.port.prepareModifySourcePlan(request) },
          enqueueSourceJob: request => { assertGap(request.gapId); return source.port.enqueueSourceJob(request) },
        }
      }
      const run = await runGrowthAgent(this.ctx, { wakeId, authority, config, model, goals, skills,
        ...(sourcePort === undefined ? {} : { sourcePlane: sourcePort }),
        ...(input.usage === undefined ? {} : { feedback: input.usage.source }),
        signal: AbortSignal.any([this.#abort.signal, ...(source === undefined ? [] : [source.signal]),
          ...(input.usage === undefined ? [] : [input.usage.signal])]),
      })
      if (reservationId !== undefined) { policy.finalize(reservationId, config.budgetAmount!); reservationSettled = true }
      this.#health = { lastWakeAt: startedAt, outcome: 'ran', reason: run.outcome, run, ownerAnchored }
    } catch (error) {
      if (reservationId !== undefined && !reservationSettled) {
        // The agent factory may already have submitted a request: charge the
        // reservation conservatively rather than release potentially-spent budget.
        try {
          if (agentSubmitted) policy.finalize(reservationId, config.budgetAmount!)
          else policy.release(reservationId)
        } catch { /* leave the reservation ledger state visible for the owner */ }
      }
      this.#health = { lastWakeAt: startedAt, outcome: 'failed', reason: errorMessage(error), run: null, ownerAnchored }
      this.ctx.logger.warn(`assistant-growth-driver: wake ${wakeId} failed: ${errorMessage(error)}`)
    }
  }

  /**
   * The owner-anchored workflow track. It only enumerates recently completed
   * owner goals and asks Delivery to independently re-verify and (if the goal
   * honestly reduces to one no-tool agent turn) record a paused candidate. The
   * driver passes ONLY a locator plus the bounded authority — never a prompt,
   * steps or an acceptance verdict — and it never approves, activates or
   * installs anything. A goal that fails the owner-root/achieved evidence bar
   * is skipped; an infrastructure, policy, authority or live-route mismatch
   * fails closed and halts the track for this wake.
   */
  async #runOwnerAnchoredTrack(input: {
    startedAt: number
    authority: GrowthAuthority
    goals: Pick<AssistantGoalsService, 'inspectOwnerGoals'>
    delivery: GrowthDeliveryPort
  }): Promise<OwnerAnchoredWakeSummary> {
    const trackConfig = this.#config.workflowOwnerAnchored
    const summary: OwnerAnchoredWakeSummary = {
      considered: 0, attempted: 0, recorded: 0, replayed: 0, abstained: 0, stopped: null,
    }
    let records: readonly InspectedOwnerGoal[]
    try {
      records = input.goals.inspectOwnerGoals(input.authority.scope, 50)
    } catch (error) {
      return { ...summary, stopped: `inspect:${errorMessage(error)}` }
    }
    const cutoff = input.startedAt - trackConfig.lookbackMs
    // Coarse discovery filter only; the whole-goal succeeded/quiescent/achieved
    // and owner-root checks are Delivery's single source of truth at commit.
    const candidates = records.filter(record =>
      record.native.phase === 'complete' && record.updatedAt >= cutoff)
    const mutable = { ...summary }
    mutable.considered = candidates.length
    for (const record of candidates) {
      if (mutable.attempted >= trackConfig.maxCommitsPerWake) break
      try {
        // Re-anchor before every commit: a revoked/rebound owner route or a
        // principal generation change aborts the rest of the track.
        input.authority.assertCurrent()
      } catch (error) {
        mutable.stopped = `authority:${errorMessage(error)}`
        break
      }
      // Every locator field comes from the anchored authority (never from the
      // enumerated record or a caller-supplied prompt); only the per-goal
      // sessionId/goalId identify which owner success to re-verify.
      const { principalId, workspace, preset } = input.authority.scope
      const locator: OwnerGoalExecutionSnapshotInput = {
        ownerRouteId: input.authority.ownerRouteId,
        principalId,
        workspace,
        preset,
        sessionId: record.native.sessionId,
        goalId: record.id,
      }
      mutable.attempted += 1
      try {
        const result = await input.delivery.commitOwnerAnchoredWorkflowTrace({ locator, authority: input.authority })
        if (result.outcome === 'abstained') mutable.abstained += 1
        else if (result.replayed) mutable.replayed += 1
        else mutable.recorded += 1
      } catch (error) {
        const code = (error as { code?: unknown })?.code
        const message = errorMessage(error)
        if (code === 'runtime-unavailable' || code === 'policy-denied' || code === 'runtime-conflict'
          || /live owner route|owner route changed|authority expired/u.test(message)) {
          mutable.stopped = `${typeof code === 'string' ? code : 'error'}:${message}`
          break
        }
        // Otherwise this completed goal is merely not learnable right now
        // (no current achieved receipt, not owner-root, etc.); keep scanning.
      }
    }
    return Object.freeze(mutable)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx: Context, input: AssistantGrowthDriverConfig = {}): void {
  new AssistantGrowthDriverService(ctx, input)
}

export default { name, Config, inject: AssistantGrowthDriverService.inject, apply, version }
