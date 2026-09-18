import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import type { AssistantGoalsService, OwnerGoalExecutionSnapshotInput } from '@dsh-enhanced/assistant-goals'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { AssistantSkillsService } from '@dsh-enhanced/assistant-skills'
import { assertCurrentContract } from '@dsh-enhanced/assistant-super-relay-budget'
import { Config, normalizeConfig, type AssistantGrowthDriverConfig } from './config.js'
import { mintGrowthAuthority, type GrowthAuthority, type GrowthDeliveryPort } from './deposit.js'
import { runGrowthAgent, type GrowthAgentRunResult } from './growth-agent.js'
import { version } from './version.js'

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
 *   2. verifies the pinned super-relay contract is still current and that a
 *      credential reference resolves (never touching the network);
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
  #timer: ReturnType<typeof setInterval> | undefined
  #flight: Promise<void> | undefined
  #active = true
  #health: GrowthWakeHealth = { lastWakeAt: null, outcome: 'never-run', reason: null, run: null }

  constructor(ctx: Context, input: AssistantGrowthDriverConfig = {}) {
    super(ctx, 'assistantGrowthDriver')
    this.#config = normalizeConfig(input)
    if (!this.#config.enabled) {
      ctx.effect(() => async () => { this.#active = false }, 'assistant-growth-driver.runtime')
      return
    }
    if (this.#config.intervalMs > 0) {
      this.#timer = setInterval(() => this.#queueWake(), this.#config.intervalMs)
      this.#timer.unref?.()
    }
    ctx.effect(() => async () => {
      this.#active = false
      if (this.#timer !== undefined) clearInterval(this.#timer)
      await this.#flight
    }, 'assistant-growth-driver.runtime')
  }

  health(): GrowthWakeHealth { return this.#health }

  /** Run one wake immediately (also used by tests / an explicit Host trigger). */
  wake(): Promise<void> {
    if (!this.#active || !this.#config.enabled) return Promise.resolve()
    return this.#runWake()
  }

  #queueWake(): void {
    if (!this.#active) return
    // Serialize wakes: a long review must never overlap the next timer tick.
    this.#flight = (this.#flight ?? Promise.resolve()).catch(() => undefined).then(() => this.#runWake().catch(() => undefined))
  }

  async #resolveCredential(): Promise<boolean> {
    const env = this.#config.apiKeyEnv
    const credentials = this.ctx.get('credentials' as never, false) as CredentialService | undefined
    const resolved = credentials === undefined ? undefined : (await credentials.resolve(credentialRef(env)))?.value
    const key = resolved ?? process.env[env]
    return typeof key === 'string' && key.length > 0
  }

  async #runWake(): Promise<void> {
    const wakeId = `growth-wake-${Date.now()}-${randomUUID()}`
    const startedAt = Date.now()
    const config = this.#config
    if (!config.scope) {
      this.#health = { lastWakeAt: startedAt, outcome: 'skipped', reason: 'missing-scope', run: null }
      return
    }
    const delivery = unwrapService(this.ctx.get('assistantDelivery')) as Pick<AssistantDeliveryService, 'validateOwnerRoute' | 'commitOwnerAnchoredWorkflowTrace'>
    const policy = unwrapService(this.ctx.get('assistantPolicy' as never, false)) as Policy | undefined
    const goals = unwrapService(this.ctx.get('assistantGoals' as never)) as unknown as Pick<AssistantGoalsService, 'inspectOwnerGoals' | 'inspectOwnerVerifiedWorkflowSource'>
    const skills = unwrapService(this.ctx.get('assistantSkills' as never)) as unknown as Pick<AssistantSkillsService, 'inspectOwnerActiveSkills' | 'inspectOwnerSkillCandidates' | 'stageOwnerVerifiedSuccessCandidate'>

    // ---- preflight (no network, no agent) ----
    let authority
    try {
      authority = mintGrowthAuthority(delivery as unknown as GrowthDeliveryPort, config.scope, startedAt + config.maxDurationMs)
    } catch (error) {
      this.#health = { lastWakeAt: startedAt, outcome: 'skipped', reason: `missing-binding:${errorMessage(error)}`, run: null }
      return
    }
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
    try {
      assertCurrentContract()
    } catch (error) {
      this.#health = { lastWakeAt: startedAt, outcome: 'skipped', reason: `contract-expired:${errorMessage(error)}`, run: null, ownerAnchored }
      return
    }
    if (!await this.#resolveCredential()) {
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
    if (config.budgetId !== null && config.budgetAmount !== null) {
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
      const run = await runGrowthAgent(this.ctx, { wakeId, authority, config, goals, skills })
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

export default { name, Config, apply, version }
