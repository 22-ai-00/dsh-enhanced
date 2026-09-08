import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SkillProviderControl } from '@deepseek-ai/dsh-skill'
import type { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { AssistantGoalsService, GoalScope } from '@dsh-enhanced/assistant-goals'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createDefinition, instantiate, type SkillBinding } from './definition.js'
import { validateComparisonProfiles, type SkillComparisonProfile, type SkillComparator } from './comparison.js'
import { watchObservation } from './watch-proof.js'
import { SkillStore, type SkillWatch, type SkillCandidate, type SkillRunStep, type StoredSkillDefinition } from './store.js'

export interface Config { databasePath?: string; allowedTools?: string[]; maxDurationMs?: number; candidateTtlMs?: number; comparisons?: SkillComparisonProfile[] }
export const Config: Schema<Config> = Schema.object({
  databasePath: Schema.string().default(join(homedir(), '.dsh', 'assistant-skills.sqlite')),
  allowedTools: Schema.array(Schema.string()).default(['read', 'write', 'edit']),
  comparisons: Schema.array(Schema.any()).default([]),
  candidateTtlMs: Schema.number().step(1).min(1000).max(604800000).default(86400000),
  maxDurationMs: Schema.number().step(1).min(1000).max(300000).default(60000),
})
declare module '@deepseek-ai/cordis' { interface Context { assistantSkills: AssistantSkillsService } }

const output = { schema: { type: 'object' as const, additionalProperties: false, properties: { context: { type: 'string' as const, required: true } } },
  render: (_args: unknown, value: { context: string }) => [{ type: 'text' as const, text: value.context }] } as const
type Action = 'inspect' | 'save' | 'run' | 'retire' | 'draft' | 'trial' | 'activate' | 'reject' | 'rollback' | 'compare' | 'watch'
const resource = { kind: 'evolution' as const, id: 'verified-workflows' }
function parse(value: string, array = false): any {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 262144) throw new Error('assistant-skills: bounded JSON required')
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) !== array) throw new Error('assistant-skills: invalid JSON shape')
  return parsed
}

/** Fixed tool compositions run in the original native Goal; no new AgentLoop or scheduler. */
export class AssistantSkillsService extends Service {
  static Config = Config
  readonly #store: SkillStore
  readonly #allowed: readonly string[]
  readonly #duration: number
  readonly #candidateTtl: number
  readonly #comparisons: readonly SkillComparisonProfile[]
  readonly #comparators = new Map<string, Promise<SkillComparator>>()
  readonly #comparing = new Set<Promise<unknown>>()
  readonly #lifecycle = new AbortController()
  readonly #providers = new Set<SkillProviderControl>()
  #reconcileQueued = false
  #active = true
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'assistantSkills')
    this.#allowed = Object.freeze([...(config.allowedTools ?? ['read', 'write', 'edit'])])
    this.#duration = config.maxDurationMs ?? 60000
    this.#candidateTtl = config.candidateTtlMs ?? 86400000
    if (!Number.isSafeInteger(this.#duration) || this.#duration < 1000 || this.#duration > 300000
      || !Number.isSafeInteger(this.#candidateTtl) || this.#candidateTtl < 1000 || this.#candidateTtl > 604800000
      || this.#allowed.length > 32 || this.#allowed.some(name => typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/u.test(name))) throw new Error('assistant-skills: invalid configuration')
    this.#comparisons = validateComparisonProfiles(config.comparisons ?? [])
    this.#store = new SkillStore(config.databasePath ?? join(homedir(), '.dsh', 'assistant-skills.sqlite'))
    ctx.effect(() => async () => { this.#active = false; this.#lifecycle.abort(); await Promise.allSettled(this.#comparing); await Promise.allSettled([...this.#comparators.values()].map(async value => (await value).close())); this.#store.close() }, 'assistant-skills.store')
    ctx.inject(['tools', 'agents', 'assistantGoals', 'assistantPolicy', 'assistantDelivery'], runtime => {
      runtime.tools.register(defineTool({ name: 'skill_save', description: 'Save the exact successful tool trace of this owner session’s independently achieved Goal as a private versioned skill. Requires the current human request. Historical acceptance is provenance, never permission or acceptance for a future run.',
        parameters: { goal_id: { type: 'string', required: true }, name: { type: 'string', required: true }, description: { type: 'string', required: true }, bindings_json: { type: 'string', description: 'JSON array of {name,stepId,path}; path is a scalar argument JSON pointer. Empty array keeps the original arguments.' }, expected_version: { type: 'integer' } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.save(exec.agent, args.goal_id, { name: args.name, description: args.description, bindings: parse(args.bindings_json ?? '[]', true) as SkillBinding[] }, args.expected_version ?? 0)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_run', description: 'Replay a saved skill’s fixed tool steps in the current newly admitted native Goal. Every nested call retains native permissions, approvals, cancellation and budgets. Use one stable invocation_id; interrupted or duplicate invocations never replay. Tool success still requires fresh independent Goal acceptance.',
        parameters: { goal_id: { type: 'string', required: true }, name: { type: 'string', required: true }, version: { type: 'integer', required: true }, inputs_json: { type: 'string', description: 'JSON object with only declared typed input parameters.' }, invocation_id: { type: 'string', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(await this.run(exec, args.goal_id, args.name, args.version, parse(args.inputs_json ?? '{}'), args.invocation_id)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_status', description: 'Read this owner’s active saved skill definitions, typed inputs and source acceptance, or inspect a specific durable invocation. Success means steps executed, not Goal achievement.', parameters: { run_id: { type: 'string' } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.inspect(exec.agent, args.run_id)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_retire', description: 'Retire the current saved skill version following the current authenticated owner request. Pending steps recheck retirement; past effects remain and require explicit repair.', parameters: { name: { type: 'string', required: true }, expected_version: { type: 'integer', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.retire(exec.agent, args.name, args.expected_version)) }) }))
    })
    ctx.inject(['tools', 'agents', 'assistantGoals', 'assistantPolicy', 'assistantDelivery'], runtime => {
      runtime.tools.register(defineTool({ name: 'skill_compare', description: 'Compare this pending candidate with its current parent by executing the same configured inputs through native file tools and independent isolated artifact checks. Requires the current owner request and a configured finite comparison profile. Stable invocation_id never repeats unknown work. Returns measured quality, never promotion permission.',
        parameters: { candidate_id: { type: 'string', required: true }, profile_id: { type: 'string', required: true }, invocation_id: { type: 'string', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(await this.compare(exec, args.candidate_id, args.profile_id, args.invocation_id)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_comparison_status', description: 'Read a private comparison receipt or available comparison profile summaries. Test inputs and expected answers are not included.', parameters: { comparison_id: { type: 'string' } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.comparisonStatus(exec.agent, args.comparison_id)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_candidate', description: 'Draft a private candidate from an independently achieved Goal following the current owner request. The current active skill stays unchanged. Review the stored trace and structural delta; no performance gain is inferred.',
        parameters: { goal_id: { type: 'string', required: true }, name: { type: 'string', required: true }, description: { type: 'string', required: true }, bindings_json: { type: 'string' }, parent_version: { type: 'integer', required: true }, reason: { type: 'string', required: true }, trigger: { type: 'string', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.stage(exec.agent, args.goal_id, { name: args.name, description: args.description, bindings: parse(args.bindings_json ?? '[]', true) as SkillBinding[] }, args.parent_version, args.reason, args.trigger)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_candidates', description: 'Inspect private candidate definitions, expiry, structural differences and trial references. Pending candidates are not active native skills.', parameters: { candidate_id: { type: 'string' } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.candidates(exec.agent, args.candidate_id)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_trial', description: 'Run a pending candidate in a fresh native Goal using the ordinary tool permissions and budgets. This can have real effects. It never changes the active skill. Use one stable invocation_id. Independent Goal acceptance and a current owner request are required for later activation.',
        parameters: { candidate_id: { type: 'string', required: true }, goal_id: { type: 'string', required: true }, inputs_json: { type: 'string' }, invocation_id: { type: 'string', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(await this.trial(exec, args.candidate_id, args.goal_id, parse(args.inputs_json ?? '{}'), args.invocation_id)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_activate', description: 'Activate a candidate following the current owner request, only after its exact sole trial call has independently achieved its fresh Goal. This is owner-approved activation, not automatic promotion or proof of improvement.',
        parameters: { candidate_id: { type: 'string', required: true }, trial_run_id: { type: 'string', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.activate(exec.agent, args.candidate_id, args.trial_run_id)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_reject', description: 'Reject a pending candidate following the current owner request; the active skill stays unchanged.', parameters: { candidate_id: { type: 'string', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.reject(exec.agent, args.candidate_id)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_rollback', description: 'Restore the current skill’s immediate parent as a new immutable version following the current owner request. Historical runs and effects remain recorded.',
        parameters: { name: { type: 'string', required: true }, expected_version: { type: 'integer', required: true }, target_version: { type: 'integer', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.rollback(exec.agent, args.name, args.expected_version, args.target_version)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_watch', description: 'Explicitly authorize a finite rollback watch for one exact active skill version. It observes only later successful skill_run calls bound to independently verified native Goal outcomes. Reaching the not-achieved threshold appends the named immediate-parent fallback once; it never promotes a candidate.',
        parameters: { owner_route_id: { type: 'string', required: true }, name: { type: 'string', required: true }, version: { type: 'integer', required: true }, fallback_version: { type: 'integer', required: true }, expires_at: { type: 'integer', required: true }, max_runs: { type: 'integer', required: true }, failure_threshold: { type: 'integer', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.watch(exec.agent, { ownerRouteId: args.owner_route_id, skillName: args.name, version: args.version, fallbackVersion: args.fallback_version, expiresAt: args.expires_at, maxRuns: args.max_runs, failureThreshold: args.failure_threshold })) }) }))
      runtime.tools.register(defineTool({ name: 'skill_watches', description: 'Inspect this owner’s finite rollback watches and their independently verified outcome observations.', parameters: {}, output,
        execute: async (_args, exec) => ({ context: JSON.stringify(this.#store.listWatches(this.#scope(exec.agent, 'inspect'))) }) }))
    })
    ctx.inject(['assistantGoals', 'assistantPolicy', 'assistantDelivery', 'assistantVerifier'], () => { this.#queueReconcile() })
    ctx.on('assistant-verifier/receipt', notice => { if (notice.taskKind === 'goal-outcome') this.#queueReconcile() })
    ctx.inject(['skills', 'agents'], runtime => {
      const registered = new WeakSet<Agent>()
      const install = (agent: Agent) => {
        if (registered.has(agent)) return
        registered.add(agent)
        runtime.effect(() => agent.ctx.get('skills')!.registerProvider(control => {
          this.#providers.add(control)
          control.signal.addEventListener('abort', () => this.#providers.delete(control), { once: true })
          const summary = (value: StoredSkillDefinition) => ({ name: value.name, description: value.description,
            invocation: { modelInvocable: true, userInvocable: true }, provider: 'assistant-skills', source: 'runtime' as const })
          return { name: 'assistant-skills', list: async options => {
            if (options.signal?.aborted || control.signal.aborted) return []
            try {
              // Do not cache an owner/Policy observation across turns or revocation.
              return { complete: false, candidates: this.#store.list(this.#scope(agent, 'inspect')).map(value => ({ ...summary(value), rank: 600, locator: { version: value.version } })) }
            } catch { return [] }
          }, get: async (candidate, options) => {
            if (options.signal?.aborted || control.signal.aborted) return undefined
            try {
              const value = this.#store.get(this.#scope(agent, 'inspect'), candidate.name)
              if (!value || value.retired || acceptanceDigest(candidate.locator) !== acceptanceDigest({ version: value.version })) return undefined
              return { ...summary(value), content: this.#body(value) }
            } catch { return undefined }
          } }
        }), 'assistant-skills.provider')
      }
      runtime.on('agent/created', ({ agent }) => install(agent))
      for (const agent of runtime.agents.list()) install(agent)
    })
  }
  #body(value: StoredSkillDefinition): string {
    return `# ${value.name}\n${value.description}\n\nSaved tool workflow, version ${value.version}. Source acceptance is historical; it grants no future authority. Run only in a new native Goal with its own independent acceptance conditions. Call skill_run with goal_id, name, version, inputs_json and a stable invocation_id. Do not regenerate the stored tool steps or replay an unknown invocation. Failure stops remaining steps; compensation is explicit owner-directed repair.\n\n${JSON.stringify({ name: value.name, version: value.version, inputs: value.inputs, tools: value.steps.map(step => step.toolName), source: value.source.acceptance })}`
  }
  #scope(agent: Agent | undefined, action: Action): GoalScope {
    if (!this.#active || !agent || this.ctx.get('agents')?.get(agent.id) !== agent) throw new Error('assistant-skills: exact live agent required')
    const delivery = this.ctx.get('assistantDelivery', false) as AssistantDeliveryService | undefined
    const owner = delivery?.preferencePrincipalForAgent(agent)
    if (!owner || owner.scope.workspace !== agent.session.header.cwd || owner.scope.preset !== agent.session.header.agentPreset) throw new Error('assistant-skills: authenticated owner required')
    const scope = { principalId: owner.principalId, ...owner.principalLineage, workspace: owner.scope.workspace, preset: owner.scope.preset }
    if (['save', 'retire', 'draft', 'activate', 'reject', 'rollback', 'compare', 'watch'].includes(action)) {
      const current = delivery?.currentPreferenceTurn(agent)
      if (!current || acceptanceDigest({ principalId: current.principalId, ...current.principalLineage, workspace: current.scope.workspace, preset: current.scope.preset }) !== acceptanceDigest(scope)) throw new Error('assistant-skills: current owner request required')
    }
    const policy = this.ctx.get('assistantPolicy', false) as AssistantPolicyService | undefined
    if (policy?.evaluateAgent(agent, action, resource).effect !== 'allow') throw new Error('assistant-skills: policy denied')
    return scope
  }
  #goals(): AssistantGoalsService {
    const goals = this.ctx.get('assistantGoals', false) as AssistantGoalsService | undefined
    if (!goals) throw new Error('assistant-skills: Goals unavailable')
    return goals
  }
  #authorize(agent: Agent | undefined, action: Exclude<Action, 'inspect'>, key: unknown): void {
    const policy = this.ctx.get('assistantPolicy', false) as AssistantPolicyService | undefined
    if (policy?.authorizeAgent(agent, action, resource, { idempotencyKey: `skill-${acceptanceDigest([action, key])}` }).effect !== 'allow') throw new Error('assistant-skills: policy authorization denied')
  }
  #changed(): void { for (const control of this.#providers) control.invalidate() }
  save(agent: Agent | undefined, goalId: string, options: { name: string; description: string; bindings?: readonly SkillBinding[] }, expectedVersion = 0) {
    const scope = this.#scope(agent, 'save')
    const source = this.#goals().inspectVerifiedWorkflowSource(agent, goalId)
    if (acceptanceDigest(source.scope) !== acceptanceDigest(scope)) throw new Error('assistant-skills: source owner mismatch')
    const definition = createDefinition(source, options, this.#allowed)
    this.#authorize(agent, 'save', [scope, definition, expectedVersion])
    const saved = this.#store.save(scope, definition, expectedVersion)
    this.#changed(); return saved
  }
  inspect(agent: Agent | undefined, runId?: string) {
    const scope = this.#scope(agent, 'inspect')
    return runId ? this.#store.getRun(scope, runId) : this.#store.list(scope)
  }
  retire(agent: Agent | undefined, name: string, expectedVersion: number) {
    const scope = this.#scope(agent, 'retire')
    this.#authorize(agent, 'retire', [scope, name, expectedVersion])
    const result = this.#store.retire(scope, name, expectedVersion)
    this.#changed(); return result
  }
  comparisonStatus(agent: Agent | undefined, id?: string) {
    const scope = this.#scope(agent, 'inspect')
    return id ? this.#store.getComparison(scope, id) ?? null : this.#comparisons.filter(profile => acceptanceDigest(profile.scope) === acceptanceDigest(scope)).map(profile => ({ id: profile.id, version: profile.version, expiresAt: profile.expiresAt, cases: profile.cases.length, repeats: profile.repeats, maxComparisons: profile.maxComparisons }))
  }
  async compare(exec: ToolRunContext, candidateId: string, profileId: string, invocationId: string) {
    const scope = this.#scope(exec.agent, 'compare')
    const profile = this.#comparisons.find(value => value.id === profileId && acceptanceDigest(value.scope) === acceptanceDigest(scope))
    if (!profile || profile.expiresAt <= Date.now()) throw new Error('assistant-skills: current comparison profile required')
    const candidate = this.#store.getCandidate(scope, candidateId)
    if (!candidate?.parentDigest) throw new Error('assistant-skills: comparison requires an existing parent')
    const claim = this.#store.claimComparison(scope, { sessionId: String(exec.agent!.session.id), candidateId, parentDigest: candidate.parentDigest, profileId, profileDigest: acceptanceDigest(profile), invocationId }, profile.maxComparisons)
    if (!claim.claimed) return claim.comparison
    const operation = (async () => {
      try {
        this.#authorize(exec.agent, 'compare', claim.comparison.id)
        const current = () => {
          exec.signal.throwIfAborted(); this.#lifecycle.signal.throwIfAborted()
          if (Date.now() >= profile.expiresAt || acceptanceDigest(this.#scope(exec.agent, 'compare')) !== acceptanceDigest(scope)
            || this.#store.getComparison(scope, claim.comparison.id)?.state !== 'running') throw new Error('assistant-skills: comparison authority changed')
          this.#pending(scope, candidateId)
        }
        current()
        const baseline = this.#store.get(scope, candidate.definition.name, candidate.parentVersion)!
        let pending = this.#comparators.get(profile.id)
        if (!pending) { pending = import('./comparison.js').then(({ SkillComparator }) => new SkillComparator(profile)); this.#comparators.set(profile.id, pending) }
        const result = await (await pending).compare(claim.comparison.id, baseline, candidate.definition, AbortSignal.any([exec.signal, this.#lifecycle.signal]), current)
        current()
        return this.#store.finishComparison(scope, claim.comparison.id, result.report.complete && result.report.variants.every(value => value.unknown === 0) ? 'complete' : 'unknown', result)
      } catch {
        this.#store.finishComparison(scope, claim.comparison.id, 'unknown', { reason: 'comparison-failed-or-authority-changed', promotionAuthorized: false })
        throw new Error(`assistant-skills: comparison ${claim.comparison.id} is unknown; inspect status, do not replay`)
      }
    })()
    this.#comparing.add(operation)
    try { return await operation } finally { this.#comparing.delete(operation) }
  }
  stage(agent: Agent | undefined, goalId: string, options: { name: string; description: string; bindings?: readonly SkillBinding[] }, parentVersion: number, reason: string, trigger: string) {
    const scope = this.#scope(agent, 'draft')
    const source = this.#goals().inspectVerifiedWorkflowSource(agent, goalId)
    if (acceptanceDigest(source.scope) !== acceptanceDigest(scope)) throw new Error('assistant-skills: source owner mismatch')
    const definition = createDefinition(source, options, this.#allowed)
    this.#authorize(agent, 'draft', [scope, definition, parentVersion, reason, trigger])
    return this.#preview(scope, this.#store.stageCandidate(scope, definition, { expectedVersion: parentVersion, reason, trigger, expiresAt: Date.now() + this.#candidateTtl }))
  }
  #preview(scope: GoalScope, candidate: SkillCandidate) {
    const parent = candidate.parentVersion ? this.#store.get(scope, candidate.definition.name, candidate.parentVersion) : undefined
    const before = new Set(parent?.steps.map(step => step.toolName) ?? [])
    const after = new Set(candidate.definition.steps.map(step => step.toolName))
    return { ...candidate, comparison: { kind: 'structural-only', improvement: 'unmeasured',
      toolsAdded: [...after].filter(tool => !before.has(tool)), toolsRemoved: [...before].filter(tool => !after.has(tool)),
      inputsChanged: acceptanceDigest(parent?.inputs ?? []) !== acceptanceDigest(candidate.definition.inputs),
      changedSteps: Array.from({ length: Math.max(parent?.steps.length ?? 0, candidate.definition.steps.length) }, (_, index) => ({ index,
        before: parent?.steps[index] ? acceptanceDigest(parent.steps[index]) : null,
        after: candidate.definition.steps[index] ? acceptanceDigest(candidate.definition.steps[index]) : null })).filter(step => step.before !== step.after) } }
  }
  candidates(agent: Agent | undefined, id?: string) {
    const scope = this.#scope(agent, 'inspect')
    if (!id) return this.#store.listCandidates(scope).map(candidate => this.#preview(scope, candidate))
    const candidate = this.#store.getCandidate(scope, id)
    return candidate ? this.#preview(scope, candidate) : null
  }
  #pending(scope: GoalScope, id: string): SkillCandidate {
    const candidate = this.#store.getCandidate(scope, id)
    if (!candidate || candidate.state !== 'pending' || candidate.expiresAt <= Date.now()) throw new Error('assistant-skills: candidate unavailable')
    const current = this.#store.get(scope, candidate.definition.name)
    if ((current?.version ?? 0) !== candidate.parentVersion || (current ? acceptanceDigest(current) : null) !== candidate.parentDigest) throw new Error('assistant-skills: candidate parent changed')
    return candidate
  }
  async trial(exec: ToolRunContext, candidateId: string, goalId: string, inputs: Record<string, unknown>, invocationId: string) {
    const scope = this.#scope(exec.agent, 'trial'), candidate = this.#pending(scope, candidateId)
    return this.#run(exec, goalId, { ...candidate.definition, version: candidate.parentVersion + 1, parentVersion: candidate.parentVersion || null, retired: false, createdAt: candidate.createdAt, updatedAt: candidate.updatedAt }, inputs, invocationId, candidateId)
  }
  activate(agent: Agent | undefined, candidateId: string, trialRunId: string) {
    const scope = this.#scope(agent, 'activate')
    const candidate = this.#store.getCandidate(scope, candidateId), run = this.#store.getRun(scope, trialRunId)
    if (!candidate || !run || run.candidateId !== candidateId || run.state !== 'succeeded' || !run.goalExecutionRunId || run.sessionId !== String(agent!.session.id)) throw new Error('assistant-skills: successful exact trial required')
    // A lost activation response can be recovered without renewing proof or changing a later version.
    if (candidate.state === 'activated' && candidate.trialRunId === trialRunId && candidate.acceptanceDigest) {
      return { activated: this.#store.activateCandidate(scope, candidateId, trialRunId, candidate.acceptanceDigest), activeVersion: this.#store.get(scope, candidate.definition.name)?.version ?? null, replayed: false, improvement: 'unmeasured' }
    }
    this.#pending(scope, candidateId)
    const verify = () => {
      const proof = this.#goals().inspectVerifiedWorkflowRun(agent, run.goalId, run.goalExecutionRunId!)
      const step = proof.steps[0], args = step?.arguments as Record<string, unknown> | undefined
      if (acceptanceDigest(proof.scope) !== acceptanceDigest(scope) || proof.goal.sessionId !== run.sessionId || proof.runId !== run.goalExecutionRunId
        || proof.steps.length !== 1 || step?.toolName !== 'skill_trial' || !args || args.candidate_id !== candidateId || args.goal_id !== run.goalId || args.invocation_id !== run.invocationId
        || acceptanceDigest(parse(args.inputs_json === undefined ? '{}' : args.inputs_json as string)) !== acceptanceDigest(run.inputs)) throw new Error('assistant-skills: independent exact trial acceptance required')
      return acceptanceDigest(proof.acceptance)
    }
    const receipt = verify()
    this.#authorize(agent, 'activate', [scope, candidateId, trialRunId])
    if (acceptanceDigest(this.#scope(agent, 'activate')) !== acceptanceDigest(scope) || verify() !== receipt) throw new Error('assistant-skills: trial authority changed')
    const activated = this.#store.activateCandidate(scope, candidateId, trialRunId, receipt)
    this.#changed()
    return { activated, activeVersion: activated.version, replayed: false, improvement: 'unmeasured' }
  }
  reject(agent: Agent | undefined, candidateId: string) {
    const scope = this.#scope(agent, 'reject')
    this.#authorize(agent, 'reject', [scope, candidateId])
    return this.#store.rejectCandidate(scope, candidateId)
  }
  rollback(agent: Agent | undefined, name: string, expectedVersion: number, targetVersion: number) {
    const scope = this.#scope(agent, 'rollback')
    this.#authorize(agent, 'rollback', [scope, name, expectedVersion, targetVersion])
    const restored = this.#store.rollback(scope, name, expectedVersion, targetVersion)
    this.#changed(); return restored
  }
  #watchPolicy(scope: GoalScope, action: 'watch' | 'rollback') {
    return { subject: { kind: 'background' as const, id: 'dsh-enhanced-assistant-skills', workspace: scope.workspace, principal: scope.principalId },
      action, resource, context: { initiator: 'background' as const } }
  }
  #watchRoute(scope: GoalScope, ownerRouteId: string, expected?: unknown) {
    const route = this.ctx.get('assistantDelivery', false)?.validateOwnerRoute({ authorityId: ownerRouteId, principalId: scope.principalId, workspace: scope.workspace, agentPreset: scope.preset })
    if (!route || route.principalRecordId !== scope.principalRecordId || route.principalVersion !== scope.principalVersion
      || expected !== undefined && acceptanceDigest(route) !== acceptanceDigest(expected)) throw new Error('assistant-skills: owner route changed')
    return route
  }
  #watchAuthorized(watch: SkillWatch): void {
    const scope = watch.scope as GoalScope
    this.#watchRoute(scope, watch.ownerRouteId, watch.routeReceipt)
    const policy = this.ctx.get('assistantPolicy', false)
    if (!watch.routeReceipt || !this.#active || Date.now() >= watch.expiresAt || !policy
      || ['watch', 'rollback'].some(action => policy.evaluate(this.#watchPolicy(scope, action as 'watch' | 'rollback')).effect !== 'allow')) throw new Error('assistant-skills: watch authority ended')
  }
  watch(agent: Agent | undefined, input: { ownerRouteId: string; skillName: string; version: number; fallbackVersion: number; expiresAt: number; maxRuns: number; failureThreshold: number }) {
    const scope = this.#scope(agent, 'watch'), route = this.#watchRoute(scope, input.ownerRouteId)
    const policy = this.ctx.get('assistantPolicy', false)
    if (!policy || ['watch', 'rollback'].some(action => policy.evaluate(this.#watchPolicy(scope, action as 'watch' | 'rollback')).effect !== 'allow')) throw new Error('assistant-skills: configure finite background watch and rollback permission')
    this.#authorize(agent, 'watch', [scope, input])
    this.#watchRoute(scope, input.ownerRouteId, route)
    return this.#store.createWatch(scope, input, route)
  }
  #queueReconcile(): void {
    if (!this.#active || this.#reconcileQueued) return
    this.#reconcileQueued = true
    queueMicrotask(() => { this.#reconcileQueued = false; if (!this.#active) return; try { this.#reconcile() } catch { /* Durable watches are retried on the next nudge or dependency activation. */ } })
  }
  #reconcile(): void {
    if (!this.#active || !this.ctx.get('assistantGoals', false) || !this.ctx.get('assistantPolicy', false)
      || !this.ctx.get('assistantDelivery', false) || !this.ctx.get('assistantVerifier', false)) return
    for (const watch of this.#store.listWatches()) {
      const scope = watch.scope as GoalScope
      if (watch.expiresAt <= Date.now()) { this.#store.stopWatch(scope, watch.id, 'expired'); continue }
      const current = this.#store.get(scope, watch.skillName)
      if (!current || current.version !== watch.version || acceptanceDigest(current) !== watch.definitionDigest) { this.#store.stopWatch(scope, watch.id, 'superseded'); continue }
      try { this.#watchAuthorized(watch) } catch { this.#store.stopWatch(scope, watch.id, 'revoked'); continue }
      for (const runId of watch.runIds) {
        const run = this.#store.getRun(scope, runId)
        if (!run || run.skillName !== watch.skillName || run.version !== watch.version) continue
        try {
          const read = () => this.#goals().inspectOwnerGoalExecution({ ownerRouteId: watch.ownerRouteId, principalId: scope.principalId, workspace: scope.workspace, preset: scope.preset, sessionId: run.sessionId, goalId: run.goalId })
          const observation = watchObservation(read(), scope, run, Date.now())
          if (!observation) continue
          this.#watchAuthorized(watch)
          if (acceptanceDigest(watchObservation(read(), scope, run, Date.now()) ?? null) !== acceptanceDigest(observation)) continue
          const observed = this.#store.observeWatch(scope, watch.id, observation)
          if (observed?.state !== 'watching') continue
          if (observed.observations.filter(value => value.objectiveStatus === 'not-achieved').length >= observed.failureThreshold) {
            const policy = this.ctx.get('assistantPolicy', false)!
            if (policy.authorize(this.#watchPolicy(scope, 'rollback'), { idempotencyKey: `${watch.id}:rollback` }).effect !== 'allow') { this.#store.stopWatch(scope, watch.id, 'revoked'); break }
            this.#watchAuthorized(watch)
            if (this.#store.rollbackWatch(scope, watch.id)?.state === 'rolled-back') this.#changed()
            break
          }
          if (observed.observations.length >= observed.maxRuns) { this.#store.stopWatch(scope, watch.id, 'exhausted'); break }
        } catch { /* Changed or unavailable evidence supplies no rollback authority. */ }
      }
    }
  }
  async run(exec: ToolRunContext, goalId: string, name: string, version: number, inputs: Record<string, unknown>, invocationId: string) {
    const scope = this.#scope(exec.agent, 'run')
    const skill = this.#store.get(scope, name)
    if (!skill || skill.retired || skill.version !== version) throw new Error('assistant-skills: active skill version required')
    return this.#run(exec, goalId, skill, inputs, invocationId)
  }
  async #run(exec: ToolRunContext, goalId: string, skill: StoredSkillDefinition, inputs: Record<string, unknown>, invocationId: string, candidateId?: string) {
    const action = candidateId ? 'trial' : 'run'
    const scope = this.#scope(exec.agent, action), { name, version } = skill
    const steps = instantiate(skill, inputs).steps
    const current = this.#goals().inspectWorkflowRunContext(exec.agent, goalId)
    if (acceptanceDigest(scope) !== acceptanceDigest(current.scope) || goalId === skill.source.goal.id) throw new Error('assistant-skills: fresh owner Goal required')
    const identity = acceptanceDigest(current)
    const goalContext = current as typeof current & { nativeGoalId?: string }
    const claim = this.#store.claim(scope, { invocationId, goalId, sessionId: current.sessionId, skillName: name, version, inputs, goalExecutionRunId: current.goalExecutionRunId, goalDefinitionDigest: current.definition.digest, ...(typeof goalContext.nativeGoalId === 'string' ? { nativeGoalId: goalContext.nativeGoalId } : {}), ...(candidateId ? { candidateId } : {}) })
    if (!claim.claimed) {
      if (claim.run.state !== 'succeeded') throw new Error(`assistant-skills: invocation ${claim.run.id} is ${claim.run.state}; inspect skill_status, do not replay`)
      return { ...claim.run, replayed: false, acceptance: 'requires-fresh-goal-verification' }
    }
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), this.#duration); timer.unref?.()
    const signal = AbortSignal.any([exec.signal, timeout.signal, this.#lifecycle.signal])
    const completed: SkillRunStep[] = []
    let state: 'succeeded' | 'failed' | 'unknown' = 'unknown'
    let dispatched = false
    const revalidate = () => {
      signal.throwIfAborted()
      if (acceptanceDigest(this.#scope(exec.agent, action)) !== acceptanceDigest(scope)
        || acceptanceDigest(this.#goals().inspectWorkflowRunContext(exec.agent, goalId)) !== identity) throw new Error('assistant-skills: current authority changed')
      if (this.#store.getRun(scope, claim.run.id)?.state !== 'running') throw new Error('assistant-skills: invocation no longer owns dispatch')
      if (candidateId) this.#pending(scope, candidateId)
      else {
        const live = this.#store.get(scope, name)
        if (!live || live.retired || live.version !== version) throw new Error('assistant-skills: skill retired or superseded')
      }
    }
    try {
      this.#authorize(exec.agent, action, claim.run.id)
      for (const [index, step] of steps.entries()) {
        revalidate()
        if (!this.#allowed.includes(step.toolName)) throw new Error('assistant-skills: current tool allowlist denied')
        dispatched = true
        const result = await exec.agent!.ctx.get('tools')!.execute({ callId: ToolCallId(`${exec.callId}:skill:${index + 1}`), rootCallId: exec.rootCallId, parent: exec.token, agent: exec.agent!, name: step.toolName, arguments: step.arguments, signal })
        for (const context of result.additionalContexts ?? []) exec.deferContext(context)
        const interrupted = signal.aborted || result.isError && ['ABORTED', 'ABORTED_BEFORE_DISPATCH'].includes(result.error.info?.code ?? '')
        completed.push({ id: step.id, state: interrupted ? 'unknown' : result.isError ? 'failed' : 'succeeded', detail: result.isError ? result.error.info?.code ?? 'tool-rejected' : `result:${acceptanceDigest(result.content)}` })
        this.#store.checkpoint(scope, claim.run.id, completed)
        if (result.isError || interrupted) { state = interrupted ? 'unknown' : 'failed'; break }
        if (result.concludesTurn) exec.concludeTurn()
        revalidate()
        dispatched = false
        if (index === steps.length - 1) state = 'succeeded'
      }
    } catch { state = dispatched || signal.aborted ? 'unknown' : 'failed' }
    finally { clearTimeout(timer) }
    if (!this.#active) throw new Error('assistant-skills: runtime disposed; invocation will recover as unknown')
    const saved = this.#store.finish(scope, claim.run.id, state, completed)
    if (saved.state !== 'succeeded') throw new Error(`assistant-skills: invocation ${saved.id} is ${saved.state}; inspect skill_status, do not replay`)
    this.#queueReconcile()
    return { ...saved, replayed: false, acceptance: 'requires-fresh-goal-verification' }
  }
}
