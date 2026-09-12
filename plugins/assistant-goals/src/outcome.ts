import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { acceptanceDigest, validateTaskAcceptanceContract, validateTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import type { TaskAcceptanceContract, AcceptanceTaskIdentity, AcceptanceCriterion } from '@dsh-enhanced/task-acceptance-contract'
import type { AcceptanceHandle, AcceptedExecution, TaskAcceptanceRegistration } from '@dsh-enhanced/assistant-verifier'
import { GoalOutcomeStore } from './outcome-store.js'
import type { GoalExecutionRun, GoalRecord, GoalScope } from './types.js'
import type { GoalOutcomeAssessment } from './outcome-store.js'

export interface GoalOutcomeView {
  status: 'unverified' | 'pending' | 'achieved' | 'not-achieved' | 'unknown' | 'expired' | 'unavailable'
  definitionVersion: number
  conditions?: { contractId: string; profileId: string; profileVersion: number; digest: string; expiresAt: number; criteria: readonly AcceptanceCriterion[] }
  assessmentId?: string
  criteria?: readonly { id: string; status: string; reason: string }[]
  verifiedAt?: number
  nativeCompletion?: 'complete' | 'pending'
}

export interface VerifiedWakeOutcome {
  readonly assessmentId: string
  readonly runId: string
  readonly objectiveStatus: 'achieved' | 'not-achieved'
}

const same = (a: unknown, b: unknown): boolean => acceptanceDigest(a) === acceptanceDigest(b)
const handle = (contract: TaskAcceptanceContract): AcceptanceHandle => ({ contractId: contract.id, contractDigest: contract.digest })

/** Independent observations of one immutable whole-goal specification. */
export class GoalOutcomeRuntime {
  readonly #store: GoalOutcomeStore
  #registration: TaskAcceptanceRegistration | undefined
  #active = true
  readonly #handles = new Map<string, { accepted: AcceptanceHandle; agent: Agent }>()
  readonly #fences = new Map<string, { agent: Agent; check(): void }>()
  readonly #settling = new Set<string>()
  constructor(private readonly ctx: Context, path: string,
    private readonly current: (agent: Agent) => GoalRecord,
    private readonly runs: (scope: GoalScope, goalId: string) => readonly GoalExecutionRun[],
    private readonly stepMaxDurationMs: number,
    private readonly assertDependencies: (record: GoalRecord) => void) {
    this.#store = new GoalOutcomeStore(path)
    this.#store.recoverIncomplete()
    ctx.on('assistant-verifier/receipt', notice => {
      if (notice.taskKind !== 'goal-outcome' || this.#settling.has(notice.contractId)) return
      queueMicrotask(() => {
        if (!this.#active || this.#settling.has(notice.contractId)) return
        try {
          const fence = this.#fences.get(notice.contractId)
          const assessment = this.#store.getByContract(notice.contractId)
          if (!fence || assessment?.contract.digest !== notice.contractDigest) return
          fence.check()
          this.reconcileCompletion(fence.agent)
        } catch { /* A nudge grants no authority; changed or disposed runs stay unchanged. */ }
      })
    })
    ctx.on('agent/disposed', ({ agent }) => {
      if (!this.#active) return
      for (const [runId, entry] of this.#handles) {
        if (entry.agent !== agent) continue
        const pending = this.#store.getByContract(entry.accepted.contractId)
        if (pending?.dispatchedAt !== undefined && pending.execution === undefined) {
          this.#store.finish(pending.contract.task.ref, { status: 'unknown', quiescent: false, completedAt: Date.now() })
        }
        this.#handles.delete(runId)
      }
      for (const [id, fence] of this.#fences) if (fence.agent === agent) this.#fences.delete(id)
    })
    ctx.effect(() => () => { this.#active = false; this.#registration = undefined; this.#handles.clear(); this.#fences.clear(); this.#store.recoverIncomplete(); this.#store.close() }, 'assistant-goals.outcomes')
  }
  register(registration: TaskAcceptanceRegistration): () => void {
    if (!this.#active) throw new Error('assistant-goals: whole-goal runtime inactive')
    if (this.#registration !== undefined) throw new Error('assistant-goals: whole-goal verifier already registered')
    if (registration.prepareGoalAssessment === undefined) throw new Error('assistant-goals: whole-goal verifier lacks assessment capability')
    if (!this.ctx.get('assistantVerifier', false)?.ownsTaskAcceptanceRegistration(registration)) throw new Error('assistant-goals: whole-goal verifier registration is foreign')
    this.#registration = registration
    return () => { if (this.#registration === registration) { this.#registration = undefined; this.#handles.clear(); this.#fences.clear(); this.#store.recoverIncomplete() } }
  }
  #ready(): TaskAcceptanceRegistration {
    if (!this.#active || this.#registration === undefined
      || !this.ctx.get('assistantVerifier', false)?.ownsTaskAcceptanceRegistration(this.#registration)) throw new Error('assistant-goals: whole-goal verifier unavailable')
    return this.#registration
  }
  #task(record: GoalRecord, assessmentId: string): AcceptanceTaskIdentity {
    return { kind: 'goal-outcome', ref: assessmentId, goal: { id: record.id,
      definitionVersion: record.definition.version, definitionDigest: record.definition.digest, assessmentId,
      sessionId: record.native.sessionId, nativeGoalId: record.native.goalId } }
  }
  #input(record: GoalRecord, assessmentId: string) {
    return { scope: { workspace: record.scope.workspace, preset: record.scope.preset },
      owner: { principalRecordId: record.scope.principalRecordId, principalVersion: record.scope.principalVersion },
      objective: record.definition.objective, task: this.#task(record, assessmentId) }
  }
  /** Configuration-only check before the owner bridge mutates a native goal. */
  preflight(scope: GoalScope, objective: string, record?: GoalRecord): void {
    this.#ready()
    const verifier = this.ctx.get('assistantVerifier', false)!
    const selection = { scope: { workspace: scope.workspace, preset: scope.preset },
      owner: { principalRecordId: scope.principalRecordId, principalVersion: scope.principalVersion }, objective }
    const step = verifier.inspectAcceptanceProfile({ ...selection, taskKind: 'goal-step' })
    const whole = verifier.inspectAcceptanceProfile({ ...selection, taskKind: 'goal-outcome' })
    if (step === null) throw new Error('assistant-goals: configure an exact goal-step acceptance profile before creating or editing this goal')
    if (whole === null) throw new Error('assistant-goals: configure an exact whole-goal success specification before creating or editing this goal')
    const stepWindow = this.stepMaxDurationMs + step.profile.bounds.maxDurationMs
    // Step verification precedes whole-goal verification. This is a minimum
    // configuration window, not a promise that queueing or later work will fit.
    const wholeWindow = stepWindow + whole.profile.bounds.maxDurationMs
    if (step.profile.validityMs <= stepWindow || whole.profile.validityMs <= wholeWindow) {
      throw new Error('assistant-goals: acceptance validity cannot cover the configured native round and verification')
    }
    if (record === undefined || objective !== record.definition.objective) return
    const existing = this.#store.getDefinition(scope, record.id, record.definition.version)
    if (existing === undefined) return
    const template = existing.template
    if (!same(existing.definition, record.definition) || !same(record.scope, scope)
      || existing.sessionId !== record.native.sessionId || existing.nativeGoalId !== record.native.goalId) {
      throw new Error('assistant-goals: whole-goal definition changed')
    }
    if (template.profile.id !== whole.profile.id || template.profile.version !== whole.profile.version
      || template.profile.digest !== whole.digest) throw new Error('assistant-goals: configured whole-goal profile differs from the frozen success specification')
    if (Date.now() + wholeWindow >= template.expiresAt) {
      throw new Error('assistant-goals: frozen whole-goal deadline cannot cover another native round and verification')
    }
  }
  /** Called only while the owner creates/edits the definition, before native work. */
  bind(record: GoalRecord): void {
    const registration = this.#ready()
    const existing = this.#store.getDefinition(record.scope, record.id, record.definition.version)
    if (existing !== undefined) {
      if (!same(existing.definition, record.definition) || existing.sessionId !== record.native.sessionId
        || existing.nativeGoalId !== record.native.goalId) throw new Error('assistant-goals: whole-goal definition changed')
      return
    }
    const assessmentId = `goal-assessment-${acceptanceDigest([record.scope, record.id, record.definition, 'initial'])}`
    const accepted = registration.prepare(this.#input(record, assessmentId))
    const contract = accepted === null ? undefined : this.ctx.get('assistantVerifier', false)?.inspectAcceptedTask(accepted.contractId)?.contract
    if (accepted === null || contract === undefined || contract.digest !== accepted.contractDigest
      || contract.task.kind !== 'goal-outcome') throw new Error('assistant-goals: no exact whole-goal success specification')
    this.#store.bind({ scope: record.scope, goalId: record.id, definition: record.definition,
      sessionId: record.native.sessionId, nativeGoalId: record.native.goalId, template: contract })
  }
  /** Enrol a real native run in an assessment before its dispatch. */
  prepare(agent: Agent, run: GoalExecutionRun): void {
    const registration = this.#ready()
    const record = this.current(agent)
    const definition = this.#store.getDefinition(record.scope, record.id, record.definition.version)
    if (definition === undefined || !same(definition.definition, record.definition)) throw new Error('assistant-goals: whole-goal conditions were not frozen by the owner')
    const prior = this.#store.list(record.scope, record.id, 100).filter(item => item.definition.definition.version === record.definition.version)
    const replay = this.#store.getByTriggerRun(record.scope, record.id, record.definition.version, run.intent.runId)
    if (replay !== undefined) throw new Error('assistant-goals: prior assessment requires reconciliation')
    const assessmentId = prior.length === 0 ? definition.template.task.ref
      : `goal-assessment-${acceptanceDigest([record.scope, record.id, record.definition, run.intent.runId])}`
    const accepted = registration.prepareGoalAssessment!(this.#input(record, assessmentId), handle(definition.template))
    const contract = this.ctx.get('assistantVerifier', false)?.inspectAcceptedTask(accepted.contractId)?.contract
    if (contract === undefined || contract.digest !== accepted.contractDigest) throw new Error('assistant-goals: whole-goal acceptance readback failed')
    if (run.intent.admission.expiresAt + contract.bounds.maxDurationMs >= contract.expiresAt) throw new Error('assistant-goals: whole-goal deadline cannot cover the native round and verification')
    this.#store.prepare(definition, contract, run.intent.runId)
    this.#store.markDispatched(assessmentId, Date.now())
    this.#handles.set(run.intent.runId, { accepted, agent })
  }
  async settled(agent: Agent, run: GoalExecutionRun, assertCurrent: () => void): Promise<void> {
    const id = this.#handles.get(run.intent.runId)?.accepted.contractId
    if (id !== undefined) this.#settling.add(id)
    try { await this.#settle(agent, run, assertCurrent) }
    finally { if (id !== undefined) this.#settling.delete(id) }
  }
  async #settle(agent: Agent, run: GoalExecutionRun, assertCurrent: () => void): Promise<void> {
    if (!this.#active) return
    const registration = this.#ready()
    const accepted = this.#handles.get(run.intent.runId)?.accepted
    if (accepted === undefined) return
    this.#handles.delete(run.intent.runId)
    const assessment = this.#store.getByContract(accepted.contractId)
    if (assessment === undefined) throw new Error('assistant-goals: assessment intent missing')
    const check = () => {
      assertCurrent()
      if (this.current(agent).native.roundsStarted !== run.intent.admission.round) throw new Error('assistant-goals: whole-goal assessment round changed')
    }
    let valid = run.execution?.status === 'succeeded' && run.execution.quiescent
    try {
      check()
      const record = this.current(agent)
      valid = valid && same(record.scope, assessment.definition.scope)
        && record.id === assessment.definition.goalId && same(record.definition, assessment.definition.definition)
        && record.native.sessionId === assessment.definition.sessionId && record.native.goalId === assessment.definition.nativeGoalId
    } catch { valid = false }
    this.#store.finish(assessment.contract.task.ref, { status: valid ? 'succeeded' : 'unknown', quiescent: valid, completedAt: Date.now() })
    if (valid) this.#fences.set(accepted.contractId, { agent, check })
    await registration.completed(accepted)
    if (this.#registration !== registration) throw new Error('assistant-goals: assessment verifier changed')
    const verifier = this.ctx.get('assistantVerifier', false)!
    // The first call can join a tick that selected its one job before this
    // assessment was admitted. The verifier registers its slot-clearing
    // finally before returning the promise, so awaiting it lets the second
    // call start or join a bounded post-admission cycle.
    await verifier.tick()
    if (this.#registration !== registration || this.#ready() !== registration) throw new Error('assistant-goals: assessment verifier changed')
    if (valid) check()
    if (this.#registration !== registration || this.#ready() !== registration) throw new Error('assistant-goals: assessment verifier changed')
    await verifier.tick()
    if (!valid) return
    check()
    if (this.#ready() !== registration) throw new Error('assistant-goals: assessment verifier changed')
    const record = this.current(agent)
    const outcome = this.view(record)
    if (outcome.status !== 'achieved' || outcome.assessmentId !== assessment.contract.task.ref) return
    this.reconcileCompletion(agent)
  }
  /** Reconcile a durable achieved receipt before another model step, including after reload. */
  reconcileCompletion(agent: Agent): boolean {
    this.#ready()
    const record = this.current(agent)
    const result = this.view(record)
    if (result.status !== 'achieved' || result.assessmentId === undefined || record.native.phase === 'complete') return false
    const assessment = this.#store.get(result.assessmentId)
    const run = this.runs(record.scope, record.id).find(item => item.intent.runId === assessment?.triggerRunId)
    if (run === undefined || assessment === undefined || run.execution?.status !== 'succeeded' || !run.execution.quiescent
      || !same(assessment.definition.definition, record.definition) || !same(run.intent.scope, record.scope)
      || run.intent.task.goal.definitionVersion !== record.definition.version || run.intent.task.goal.definitionDigest !== record.definition.digest
      || run.intent.task.goal.nativeGoalId !== record.native.goalId || run.intent.task.goal.sessionId !== record.native.sessionId
      || run.intent.admission.maxGoalRounds !== record.native.maxGoalRounds) return false
    const exact = record.native.revision === run.intent.task.goal.nativeRevision && record.native.phase === 'active'
      && record.native.roundsStarted === run.intent.admission.round
    const exhausted = record.native.revision === run.intent.task.goal.nativeRevision + 1 && record.native.phase === 'blocked'
      && record.native.roundsStarted === run.intent.admission.maxGoalRounds
    // Pre-step runs before newly claimed goal messages are appended. A later
    // admitted round requires its own assessment; revision alone cannot prove it.
    if (!exact && !exhausted) return false
    const goals = this.ctx.get('goals', false)
    const native = goals?.get(agent)
    if (goals === undefined || native === undefined || String(native.id) !== record.native.goalId || native.revision !== record.native.revision) return false
    try {
      const parent = this.current(agent)
      if (parent.id !== record.id || !same(parent.scope, record.scope) || !same(parent.definition, record.definition)
        || !same(parent.native, record.native) || run.intent.dependencies === undefined
        || (parent.checkpoint.dependencies.length > 0 && parent.checkpoint.dependencyBindings === undefined)
        || !same(parent.checkpoint.dependencyBindings ?? [], run.intent.dependencies)) return false
      this.assertDependencies(parent)
    } catch { return false }
    goals.complete(agent, { id: native.id, revision: native.revision })
    return true
  }
  /** Resolve only the assessment produced by this wake's exact terminal round. */
  verifiedWakeOutcome(record: GoalRecord, wake: Readonly<{ sessionId: string; goalId: string; revision: number; roundsStarted: number; maxGoalRounds: number }>): Readonly<VerifiedWakeOutcome> | undefined {
    try {
      const phase = record.native.phase
      const expectedOutcome = phase === 'complete' ? 'achieved' : phase === 'blocked' ? 'not-achieved' : undefined
      const directTerminal = record.native.revision === wake.revision + 2
      const verifiedAfterBlocked = phase === 'complete' && record.native.revision === wake.revision + 3
      if (expectedOutcome === undefined || record.native.sessionId !== wake.sessionId || record.native.goalId !== wake.goalId
        || record.native.maxGoalRounds !== wake.maxGoalRounds || record.native.roundsStarted <= wake.roundsStarted
        || record.native.roundsStarted > wake.maxGoalRounds || !directTerminal && !verifiedAfterBlocked
        || (phase === 'blocked' || verifiedAfterBlocked) && record.native.roundsStarted !== wake.maxGoalRounds
        || record.checkpoint.dependencies.length > 0 && record.checkpoint.dependencyBindings === undefined) return undefined
      const runs = this.runs(record.scope, record.id).filter(item => item.execution?.status === 'succeeded' && item.execution.quiescent
        && item.dispatchedAt !== undefined && same(item.intent.scope, record.scope)
        && same(item.intent.dependencies ?? [], record.checkpoint.dependencyBindings ?? [])
        && item.intent.task.goal.id === record.id && item.intent.task.goal.definitionVersion === record.definition.version
        && item.intent.task.goal.definitionDigest === record.definition.digest && item.intent.task.goal.sessionId === wake.sessionId
        && item.intent.task.goal.nativeGoalId === wake.goalId && item.intent.task.goal.nativeRevision === wake.revision + 1
        && item.intent.admission.round === record.native.roundsStarted && item.intent.admission.maxGoalRounds === wake.maxGoalRounds)
      if (runs.length !== 1) return undefined
      const run = runs[0]!
      const assessment = this.#store.getByTriggerRun(record.scope, record.id, record.definition.version, run.intent.runId)
      if (assessment === undefined || assessment.execution?.status !== 'succeeded' || !assessment.execution.quiescent
        || !same(assessment.definition.scope, record.scope) || assessment.definition.goalId !== record.id
        || !same(assessment.definition.definition, record.definition) || assessment.definition.sessionId !== wake.sessionId
        || assessment.definition.nativeGoalId !== wake.goalId || assessment.contract.task.kind !== 'goal-outcome'
        || assessment.contract.task.goal.id !== record.id || assessment.contract.task.goal.definitionVersion !== record.definition.version
        || assessment.contract.task.goal.definitionDigest !== record.definition.digest
        || assessment.contract.task.goal.sessionId !== wake.sessionId || assessment.contract.task.goal.nativeGoalId !== wake.goalId) return undefined
      this.#ready()
      const readback = this.ctx.get('assistantVerifier', false)!.inspectAcceptedTask(assessment.contract.id)
      if (readback?.receipt === null || readback === null || !same(readback.contract, assessment.contract)
        || !same(readback.execution, { ...assessment.execution, executionRef: assessment.contract.task.ref })) return undefined
      const receipt = validateTaskVerificationReceipt(assessment.contract, readback.receipt)
      if (receipt.objectiveStatus !== expectedOutcome || receipt.completedAt > Date.now() || receipt.validUntil <= Date.now()) return undefined
      return Object.freeze({ assessmentId: assessment.contract.task.ref, runId: run.intent.runId, objectiveStatus: expectedOutcome })
    } catch { return undefined }
  }
  /** Read-only proof that this exact wake's final native completion follows its verified last round. */
  verifiedWakeCompletion(record: GoalRecord, wake: Readonly<{ sessionId: string; goalId: string; revision: number; roundsStarted: number; maxGoalRounds: number }>): boolean {
    const outcome = this.verifiedWakeOutcome(record, wake)
    return outcome?.objectiveStatus === 'achieved' && record.native.phase === 'complete'
      && record.native.revision === wake.revision + 3
  }
  inspect = async (input: TaskAcceptanceContract): Promise<AcceptedExecution | null> => {
    this.#ready()
    const contract = validateTaskAcceptanceContract(input)
    if (contract.task.kind !== 'goal-outcome') throw new Error('assistant-goals: foreign whole-goal task')
    const assessment = this.#store.getByContract(contract.id)
    if (assessment === undefined || !same(assessment.contract, contract)
      || assessment.dispatchedAt === undefined || assessment.execution === undefined) return null
    if (assessment.execution.quiescent) {
      try {
        const fence = this.#fences.get(contract.id)
        if (fence === undefined) throw new Error('live assessment fence unavailable')
        fence.check()
        if (this.#fences.get(contract.id) !== fence) throw new Error('live assessment fence changed')
      } catch {
        return Object.freeze({ ...handle(contract), dispatchedAt: assessment.dispatchedAt, completedAt: assessment.execution.completedAt, executionRef: contract.task.ref, status: 'unknown', quiescent: false })
      }
    }
    const trigger = this.runs(assessment.definition.scope, assessment.definition.goalId)
      .find(run => run.intent.runId === assessment.triggerRunId)
    if (assessment.execution.quiescent && (trigger?.execution?.quiescent !== true
      || trigger.execution.status !== 'succeeded' || trigger.dispatchedAt === undefined
      || trigger.intent.task.goal.definitionVersion !== contract.task.goal.definitionVersion
      || trigger.intent.task.goal.definitionDigest !== contract.task.goal.definitionDigest)) {
      throw new Error('assistant-goals: whole-goal assessment lacks actual settled work')
    }
    return Object.freeze({ ...assessment.execution, ...handle(contract), dispatchedAt: assessment.dispatchedAt, executionRef: contract.task.ref })
  }
  artifactSource = async (input: TaskAcceptanceContract): Promise<AcceptanceHandle | null> => {
    const contract = validateTaskAcceptanceContract(input)
    const proof = await this.inspect(contract)
    if (proof?.status !== 'succeeded' || !proof.quiescent) return null
    const assessment = this.#store.getByContract(contract.id)!
    const run = this.runs(assessment.definition.scope, assessment.definition.goalId).find(entry => entry.intent.runId === assessment.triggerRunId)
    return run?.acceptance ?? null
  }
  view(record: GoalRecord): GoalOutcomeView {
    const base: GoalOutcomeView = { status: 'unverified', definitionVersion: record.definition.version }
    if (!this.#active) return { ...base, status: 'unavailable' }
    const definition = this.#store.getDefinition(record.scope, record.id, record.definition.version)
    if (definition === undefined || !same(definition.definition, record.definition)) return base
    const template = definition.template
    base.conditions = { contractId: template.id, profileId: template.profile.id, profileVersion: template.profile.version,
      digest: acceptanceDigest(template.criteria), expiresAt: template.expiresAt, criteria: template.criteria }
    if (Date.now() >= template.expiresAt) return { ...base, status: 'expired' }
    const latest = this.#store.list(record.scope, record.id, 100).find(item => item.definition.definition.version === record.definition.version)
    if (latest === undefined) return base
    base.assessmentId = latest.contract.task.ref
    if (latest.execution === undefined) return { ...base, status: 'pending' }
    if (!latest.execution.quiescent || latest.execution.status !== 'succeeded') return { ...base, status: 'unknown' }
    try {
      this.#ready()
      const readback = this.ctx.get('assistantVerifier', false)!.inspectAcceptedTask(latest.contract.id)
      if (readback?.receipt === null || readback === null) return { ...base, status: 'pending' }
      const contract = validateTaskAcceptanceContract(readback.contract)
      if (!same(contract, latest.contract)) throw new Error('assessment contract differs')
      if (same(readback.execution, { status: 'unknown', quiescent: false, completedAt: latest.execution.completedAt, executionRef: contract.task.ref })) return { ...base, status: 'unknown' }
      if (!same(readback.execution, { ...latest.execution, executionRef: contract.task.ref })) throw new Error('assessment readback differs')
      const receipt = validateTaskVerificationReceipt(contract, readback.receipt)
      if (receipt.validUntil <= Date.now() || receipt.completedAt > Date.now()) return { ...base, status: 'expired' }
      return { ...base, status: receipt.objectiveStatus, verifiedAt: receipt.completedAt,
        ...(receipt.objectiveStatus === 'achieved' ? { nativeCompletion: record.native.phase === 'complete' ? 'complete' as const : 'pending' as const } : {}),
        criteria: receipt.results.map(result => ({ id: result.criterionId, status: result.status, reason: result.reason.slice(0, 256) })) }
    } catch { return { ...base, status: 'unavailable' } }
  }
  /** Durable Host evidence only. Returned entries are constrained to the current semantic definition. */
  inspectAssessments(record: GoalRecord): readonly GoalOutcomeAssessment[] {
    if (!this.#active) return Object.freeze([])
    return Object.freeze(this.#store.list(record.scope, record.id, 100).filter(item =>
      same(item.definition.scope, record.scope) && item.definition.goalId === record.id
      && same(item.definition.definition, record.definition) && item.definition.sessionId === record.native.sessionId
      && item.definition.nativeGoalId === record.native.goalId).map(item => Object.freeze({ ...item })))
  }
  health = () => ({ enabled: true, connected: this.#registration !== undefined })
}
