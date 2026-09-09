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
import { validateComparisonProfiles, SkillComparator, type SkillComparisonProfile } from './comparison.js'
import { watchObservation } from './watch-proof.js'
import { sealedPlan, type SealedSkillHoldoutProvider } from './sealed-holdout.js'
import { openHoldoutProcess, validateExternalHoldoutProfiles, type ExternalHoldoutProfile } from './external-holdout.js'
import { inspectProspectiveQualification, qualifyHoldout } from './holdout-qualification.js'
import { SkillStore, type SkillWatch, type SkillCandidate, type SkillRunStep, type StoredSkillDefinition, type SkillCapture, type SkillDeployment, type SkillDeploymentInput } from './store.js'

export interface Config { databasePath?: string; allowedTools?: string[]; maxDurationMs?: number; candidateTtlMs?: number; comparisons?: SkillComparisonProfile[]; externalHoldouts?: ExternalHoldoutProfile[] }
export const Config: Schema<Config> = Schema.object({
  databasePath: Schema.string().default(join(homedir(), '.dsh', 'assistant-skills.sqlite')),
  allowedTools: Schema.array(Schema.string()).default(['read', 'write', 'edit']),
  comparisons: Schema.array(Schema.any()).default([]),
  externalHoldouts: Schema.array(Schema.any()).default([]),
  candidateTtlMs: Schema.number().step(1).min(1000).max(604800000).default(86400000),
  maxDurationMs: Schema.number().step(1).min(1000).max(300000).default(60000),
})
declare module '@deepseek-ai/cordis' { interface Context { assistantSkills: AssistantSkillsService } }

const output = { schema: { type: 'object' as const, additionalProperties: false, properties: { context: { type: 'string' as const, required: true } } },
  render: (_args: unknown, value: { context: string }) => [{ type: 'text' as const, text: value.context }] } as const
const businessGoalId = 'Business Goal ID returned by goal_create or goal_context (the goal_id label), not the native get_goal ID.'
type Action = 'inspect' | 'save' | 'run' | 'retire' | 'draft' | 'trial' | 'activate' | 'reject' | 'rollback' | 'compare' | 'watch' | 'capture' | 'canary'
const resource = { kind: 'evolution' as const, id: 'verified-workflows' }
function parse(value: string, array = false): any {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 262144) throw new Error('assistant-skills: bounded JSON required')
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) !== array) throw new Error('assistant-skills: invalid JSON shape')
  return parsed
}
function plainArguments(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (!Object.values(descriptors).every(descriptor => descriptor.enumerable && 'value' in descriptor)) return undefined
  return value as Record<string, unknown>
}
function exactArguments(value: unknown, allowed: readonly string[]): Record<string, unknown> | undefined {
  const args = plainArguments(value); if (!args || Object.keys(args).some(key => !allowed.includes(key))) return undefined
  return args
}
function trialProofSteps(steps: readonly { toolName: string; arguments: unknown }[], candidateId: string, trialRunId: string, goalId: string, invocationId: string, inputs: Record<string, unknown>): boolean {
  let trials = 0
  for (const step of steps) {
    const args = plainArguments(step.arguments)
    if (!args) return false
    if (step.toolName === 'skill_trial') {
      trials++
      const trial = exactArguments(args, ['candidate_id', 'goal_id', 'inputs_json', 'invocation_id'])
      if (!trial || trials !== 1 || trial.candidate_id !== candidateId || trial.goal_id !== goalId || trial.invocation_id !== invocationId
        || acceptanceDigest(parse(trial.inputs_json === undefined ? '{}' : trial.inputs_json as string)) !== acceptanceDigest(inputs)) return false
      continue
    }
    if (step.toolName === 'get_goal' && exactArguments(args, [])) continue
    if (step.toolName === 'skill_candidates') {
      const candidate = exactArguments(args, ['candidate_id']); if (candidate && (Object.keys(candidate).length === 0 || candidate.candidate_id === candidateId)) continue
    }
    if (step.toolName === 'skill_status') {
      const status = exactArguments(args, ['run_id']); if (status && (Object.keys(status).length === 0 || status.run_id === trialRunId)) continue
    }
    if (step.toolName === 'goal_context') {
      const context = exactArguments(args, ['goal_id', 'focus']); if (context && (Object.keys(context).length === 0 || context.goal_id === goalId && (context.focus === undefined || context.focus === false))) continue
    }
    return false
  }
  return trials === 1
}

/** Fixed tool compositions run in the original native Goal; no new AgentLoop or scheduler. */
export class AssistantSkillsService extends Service {
  static Config = Config
  readonly #store: SkillStore
  readonly #allowed: readonly string[]
  readonly #duration: number
  readonly #candidateTtl: number
  readonly #comparisons: readonly SkillComparisonProfile[]
  readonly #externalHoldouts: readonly ExternalHoldoutProfile[]
  readonly #comparators = new Map<string, Promise<SkillComparator>>()
  readonly #comparing = new Set<Promise<unknown>>()
  readonly #lifecycle = new AbortController()
  readonly #providers = new Set<SkillProviderControl>()
  #sealedHoldout: SealedSkillHoldoutProvider | undefined
  #sealedGeneration: string | undefined
  #reconcileQueued = false
  readonly #captureInflight = new Set<string>()
  readonly #captureDirty = new Set<string>()
  readonly #captureTasks = new Set<Promise<void>>()
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
    this.#externalHoldouts = validateExternalHoldoutProfiles(config.externalHoldouts ?? [])
    this.#store = new SkillStore(config.databasePath ?? join(homedir(), '.dsh', 'assistant-skills.sqlite'))
    ctx.effect(() => async () => { this.#active = false; this.#lifecycle.abort(); await Promise.allSettled(this.#comparing); await Promise.allSettled(this.#captureTasks); await Promise.allSettled([...this.#comparators.values()].map(async value => (await value).close())); this.#store.close() }, 'assistant-skills.store')
    ctx.inject(['tools', 'agents', 'assistantGoals', 'assistantPolicy', 'assistantDelivery'], runtime => {
      runtime.tools.register(defineTool({ name: 'skill_save', description: 'Save the exact successful tool trace of this owner session’s independently achieved Goal as a private versioned skill. Requires the current human request. Historical acceptance is provenance, never permission or acceptance for a future run.',
        parameters: { goal_id: { type: 'string', required: true, description: businessGoalId }, name: { type: 'string', required: true }, description: { type: 'string', required: true }, bindings_json: { type: 'string', description: 'JSON array of {name,stepId,path}; path is a scalar argument JSON pointer. Empty array keeps the original arguments.' }, expected_version: { type: 'integer' } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.save(exec.agent, args.goal_id, { name: args.name, description: args.description, bindings: parse(args.bindings_json ?? '[]', true) as SkillBinding[] }, args.expected_version ?? 0)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_run', description: 'Replay a saved skill’s fixed tool steps in a fresh native Goal. If the current owner Goal is active but has no admitted native round, this returns awaiting-native-round with no steps or durable run, ends the turn, and the next native round must repeat the same invocation_id. Every nested call retains native permissions, approvals, cancellation and budgets. Tool success still requires fresh independent Goal acceptance.',
        parameters: { goal_id: { type: 'string', required: true, description: businessGoalId }, name: { type: 'string', required: true }, version: { type: 'integer', required: true }, inputs_json: { type: 'string', description: 'JSON object with only declared typed input parameters.' }, invocation_id: { type: 'string', required: true } }, output,
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
      runtime.tools.register(defineTool({ name: 'skill_qualify', description: 'Submit a pending candidate and its current parent to one configured external independent holdout authority. The authority keeps holdout questions and keys private. Requires the current owner request. A stable invocation_id never repeats an unknown or completed qualification. It returns measurement only and never activates or promotes a skill.',
        parameters: { candidate_id: { type: 'string', required: true }, profile_id: { type: 'string', required: true }, invocation_id: { type: 'string', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(await this.qualifyExternalHoldout(exec, args.candidate_id, args.profile_id, args.invocation_id)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_canary', description: 'Owner-authorize one finite canary deployment only after the configured external authority supplies a fresh prospective qualification bound to this exact candidate and parent. It runs a finite exact-version watch, automatically promotes after fresh independent successes, and blocks then rolls back after a verified failure.',
        parameters: { candidate_id: { type: 'string', required: true }, profile_id: { type: 'string', required: true }, invocation_id: { type: 'string', required: true }, owner_route_id: { type: 'string', required: true }, expires_at: { type: 'integer', required: true }, max_runs: { type: 'integer', required: true }, canary_runs: { type: 'integer', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(await this.canary(exec, args.candidate_id, args.profile_id, args.invocation_id, { ownerRouteId: args.owner_route_id, expiresAt: args.expires_at, maxRuns: args.max_runs, canaryRuns: args.canary_runs })) }) }))
      runtime.tools.register(defineTool({ name: 'skill_comparison_status', description: 'Read a private comparison receipt or available comparison profile summaries. Test inputs and expected answers are not included.', parameters: { comparison_id: { type: 'string' } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.comparisonStatus(exec.agent, args.comparison_id)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_candidate', description: 'Draft a private candidate from an independently achieved Goal following the current owner request. The current active skill stays unchanged. Review the stored trace and structural delta; no performance gain is inferred.',
        parameters: { goal_id: { type: 'string', required: true, description: businessGoalId }, name: { type: 'string', required: true }, description: { type: 'string', required: true }, bindings_json: { type: 'string' }, parent_version: { type: 'integer', required: true }, reason: { type: 'string', required: true }, trigger: { type: 'string', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.stage(exec.agent, args.goal_id, { name: args.name, description: args.description, bindings: parse(args.bindings_json ?? '[]', true) as SkillBinding[] }, args.parent_version, args.reason, args.trigger)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_candidates', description: 'Inspect private candidate definitions, expiry, structural differences and trial references. Pending candidates are not active native skills.', parameters: { candidate_id: { type: 'string' } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.candidates(exec.agent, args.candidate_id)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_trial', description: 'Run a pending candidate in a fresh native Goal using ordinary tool permissions and budgets. If the current owner Goal has no admitted native round, it returns awaiting-native-round without steps or durable work and the next native round must repeat the same invocation_id. This can have real effects once admitted and never changes the active skill. Independent Goal acceptance and a current owner request are required for later activation.',
        parameters: { candidate_id: { type: 'string', required: true }, goal_id: { type: 'string', required: true, description: businessGoalId }, inputs_json: { type: 'string' }, invocation_id: { type: 'string', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(await this.trial(exec, args.candidate_id, args.goal_id, parse(args.inputs_json ?? '{}'), args.invocation_id)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_activate', description: 'Activate a candidate following the current owner request only after a fresh independently accepted Goal has one exact successful skill_trial as its sole business execution. The accepted round may also contain only validated read-only metadata inspection. This is owner-approved activation, not automatic promotion or proof of improvement.',
        parameters: { candidate_id: { type: 'string', required: true }, trial_run_id: { type: 'string', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.activate(exec.agent, args.candidate_id, args.trial_run_id)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_activate_watched', description: 'Following the current owner request, activate an independently accepted candidate and register its finite exact-version rollback watch in one atomic commit. Requires an existing parent and current activation, watch and background rollback authority. Failure leaves the parent active. This is owner-approved activation, not automatic promotion or evidence of improvement.',
        parameters: { candidate_id: { type: 'string', required: true }, trial_run_id: { type: 'string', required: true }, owner_route_id: { type: 'string', required: true }, expires_at: { type: 'integer', required: true }, max_runs: { type: 'integer', required: true }, failure_threshold: { type: 'integer', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.activate(exec.agent, args.candidate_id, args.trial_run_id,
          { ownerRouteId: args.owner_route_id, expiresAt: args.expires_at, maxRuns: args.max_runs, failureThreshold: args.failure_threshold })) }) }))
      runtime.tools.register(defineTool({ name: 'skill_reject', description: 'Reject a pending candidate following the current owner request; the active skill stays unchanged.', parameters: { candidate_id: { type: 'string', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.reject(exec.agent, args.candidate_id)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_rollback', description: 'Restore the current skill’s immediate parent as a new immutable version following the current owner request. Historical runs and effects remain recorded.',
        parameters: { name: { type: 'string', required: true }, expected_version: { type: 'integer', required: true }, target_version: { type: 'integer', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.rollback(exec.agent, args.name, args.expected_version, args.target_version)) }) }))
      runtime.tools.register(defineTool({ name: 'skill_watch', description: 'Explicitly authorize a finite rollback watch for one exact active skill version. It observes only later successful skill_run calls bound to independently verified native Goal outcomes. Reaching the not-achieved threshold appends the named immediate-parent fallback once; it never promotes a candidate.',
        parameters: { owner_route_id: { type: 'string', required: true }, name: { type: 'string', required: true }, version: { type: 'integer', required: true }, fallback_version: { type: 'integer', required: true }, expires_at: { type: 'integer', required: true }, max_runs: { type: 'integer', required: true }, failure_threshold: { type: 'integer', required: true } }, output,
        execute: async (args, exec) => ({ context: JSON.stringify(this.watch(exec.agent, { ownerRouteId: args.owner_route_id, skillName: args.name, version: args.version, fallbackVersion: args.fallback_version, expiresAt: args.expires_at, maxRuns: args.max_runs, failureThreshold: args.failure_threshold })) }) }))
      runtime.tools.register(defineTool({ name: 'skill_capture', description: 'During the owner turn that created the current active Goal, preauthorize one finite automatic pending candidate after that Goal independently achieves and naturally ends. Supply the configured public owner_route_id, business Goal ID, name and expiry. Set start_native_rounds=true only when capture should immediately hand the Goal to Host-native execution and extraction; after successful registration the owner turn must not continue business work. Leave it false to continue composing authorized schedule or wait work. If registration fails, correct the ID and retry while still in the owner turn; failure is not authorization. It never activates, compares, runs, or expands a skill.',
        parameters: { owner_route_id: { type: 'string', required: true }, goal_id: { type: 'string', required: true, description: businessGoalId }, name: { type: 'string', required: true }, description: { type: 'string', required: true }, parent_version: { type: 'integer', required: true }, expires_at: { type: 'integer', required: true }, start_native_rounds: { type: 'boolean', description: 'When explicitly true and registration succeeds, conclude this owner turn so the Host may start native Goal rounds.' } }, output,
        execute: async (args, exec) => { const saved = this.capture(exec.agent, { ownerRouteId: args.owner_route_id, goalId: args.goal_id, name: args.name, description: args.description, parentVersion: args.parent_version, expiresAt: args.expires_at }); if (args.start_native_rounds === true) exec.concludeTurn(); return { context: JSON.stringify(saved) } } }))
      runtime.tools.register(defineTool({ name: 'skill_captures', description: 'Inspect owner-preauthorized automatic capture records and their pending, captured, revoked, expired, unsupported, or unknown terminal state.', parameters: {}, output,
        execute: async (_args, exec) => ({ context: JSON.stringify(this.#store.listCaptures(this.#scope(exec.agent, 'inspect'))) }) }))
      runtime.tools.register(defineTool({ name: 'skill_watches', description: 'Inspect this owner’s finite rollback watches and their independently verified outcome observations.', parameters: {}, output,
        execute: async (_args, exec) => ({ context: JSON.stringify(this.#store.listWatches(this.#scope(exec.agent, 'inspect'))) }) }))
      runtime.tools.register(defineTool({ name: 'skill_deployment_status', description: 'Inspect this owner’s finite canary deployments, their exact version, quota, and terminal promotion or rollback state.', parameters: { deployment_id: { type: 'string' } }, output,
        execute: async (args, exec) => { const scope = this.#scope(exec.agent, 'inspect'); return { context: JSON.stringify(args.deployment_id === undefined ? this.#store.listDeployments(scope) : this.#store.getDeployment(scope, args.deployment_id) ?? null) } } }))
    })
    ctx.inject(['assistantGoals', 'assistantPolicy', 'assistantDelivery', 'assistantVerifier'], () => { this.#queueReconcile() })
    // SessionQuery is optional for ordinary manual skills. When it becomes
    // available, retry durable preauthorized captures that previously received
    // the typed `unavailable` bridge result.
    ctx.inject(['sessionQuery' as never], () => { this.#queueReconcile() })
    ctx.on('assistant-verifier/receipt', notice => { if (notice.taskKind === 'goal-outcome') this.#queueReconcile() })
    // A native goal change is only a durable-evidence reread nudge. It carries no
    // authority and capture still revalidates route, Policy, parent and definition.
    ;(ctx as unknown as { on: (event: string, listener: () => void) => unknown }).on('goal/changed', () => this.#queueReconcile())
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
    if (['save', 'retire', 'draft', 'activate', 'reject', 'rollback', 'compare', 'watch', 'capture', 'canary'].includes(action)) {
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
  /** Host-only registration; there is intentionally no model tool for sealed inputs or attestations. */
  registerSealedHoldoutProvider = (provider: SealedSkillHoldoutProvider): (() => void) => {
    if (!this.#active || this.#sealedHoldout !== undefined || !provider || typeof provider.read !== 'function' || typeof provider.generation !== 'string' || !provider.generation) throw new Error('assistant-skills: sealed holdout provider unavailable')
    this.#sealedHoldout = provider; this.#sealedGeneration = provider.generation
    return () => { if (this.#sealedHoldout === provider) { this.#sealedHoldout = undefined; this.#sealedGeneration = undefined } }
  }
  inspectSealedHoldout = (planId: string, scope: GoalScope) => {
    if (!this.#active || !this.#sealedHoldout) throw new Error('assistant-skills: sealed holdout provider unavailable')
    const plan = sealedPlan(this.#sealedHoldout, planId, scope)
    // The opaque plan is deliberately not returned. This is only a Host-attested binding.
    return Object.freeze({ protocol: 'assistant-skills/sealed-holdout-binding/v1' as const, planId, bindingDigest: plan.bindingDigest, attestationDigest: plan.attestationDigest })
  }
  /** Host entrypoint: consumes opaque provider cases through the same native replay and isolated verifier as compare. */
  qualifySealedHoldout = async (exec: ToolRunContext, candidateId: string, planId: string, invocationId: string) => {
    const scope = this.#scope(exec.agent, 'compare'), provider = this.#sealedHoldout, generation = this.#sealedGeneration, plan = provider && generation === provider.generation && sealedPlan(provider, planId, scope)
    if (!plan || plan.profile.expiresAt <= Date.now() || acceptanceDigest(plan.profile.scope) !== acceptanceDigest(scope)) throw new Error('assistant-skills: sealed holdout plan unavailable')
    const candidate = this.#store.getCandidate(scope, candidateId)
    if (!candidate?.parentDigest) throw new Error('assistant-skills: sealed qualification requires an existing parent')
    const claim = this.#store.claimComparison(scope, { sessionId: String(exec.agent!.session.id), candidateId, parentDigest: candidate.parentDigest, profileId: `sealed-${planId}`, profileDigest: plan.bindingDigest, invocationId }, plan.profile.maxComparisons)
    const current = (running = true) => {
      exec.signal.throwIfAborted(); this.#lifecycle.signal.throwIfAborted()
      const fresh = this.#sealedHoldout === provider && this.#sealedGeneration === generation && provider?.generation === generation ? sealedPlan(provider, planId, scope) : undefined
      if (!fresh || fresh.bindingDigest !== plan.bindingDigest || Date.now() >= plan.profile.expiresAt || acceptanceDigest(this.#scope(exec.agent, 'compare')) !== acceptanceDigest(scope) || running && this.#store.getComparison(scope, claim.comparison.id)?.state !== 'running') throw new Error('assistant-skills: sealed qualification authority changed')
      this.#pending(scope, candidateId)
    }
    if (!claim.claimed) { current(false); return claim.comparison }
    const operation = (async () => {
    try {
      this.#authorize(exec.agent, 'compare', claim.comparison.id)
      current(); const baseline = this.#store.get(scope, candidate.definition.name, candidate.parentVersion)!
      const comparator = new SkillComparator(plan.profile)
      try { const result = await comparator.compare(claim.comparison.id, baseline, candidate.definition, AbortSignal.any([exec.signal, this.#lifecycle.signal]), current); current(); return this.#store.finishComparison(scope, claim.comparison.id, result.report.complete && result.report.variants.every(value => value.unknown === 0) ? 'complete' : 'unknown', { ...result, hostAttestedHoldout: { bindingDigest: plan.bindingDigest }, promotionAuthorized: false }) } finally { await comparator.close() }
    } catch {
      this.#store.finishComparison(scope, claim.comparison.id, 'unknown', { reason: 'sealed-qualification-failed-or-authority-changed', promotionAuthorized: false }); throw new Error(`assistant-skills: sealed qualification ${claim.comparison.id} is unknown; inspect status, do not replay`)
    } })()
    this.#comparing.add(operation)
    try { return await operation } finally { this.#comparing.delete(operation) }
  }
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
    return id ? this.#store.getComparison(scope, id) ?? null : [
      ...this.#comparisons.filter(profile => acceptanceDigest(profile.scope) === acceptanceDigest(scope)).map(profile => ({ id: profile.id, version: profile.version, expiresAt: profile.expiresAt, cases: profile.cases.length, repeats: profile.repeats, maxComparisons: profile.maxComparisons })),
      ...this.#externalHoldouts.filter(profile => acceptanceDigest(profile.scope) === acceptanceDigest(scope)).map(profile => ({ id: profile.id, version: profile.version, expiresAt: profile.execution.expiresAt, maxComparisons: profile.maxComparisons })),
    ]
  }
  /** Fixed external authority qualification. Private cells, authority keys and operator configuration never become tool arguments or status data. */
  async qualifyExternalHoldout(exec: ToolRunContext, candidateId: string, profileId: string, invocationId: string, action: 'compare' | 'canary' = 'compare', currentAuthority?: () => void) {
    const scope = this.#scope(exec.agent, action)
    const profile = this.#externalHoldouts.find(value => value.id === profileId && acceptanceDigest(value.scope) === acceptanceDigest(scope))
    if (!profile || profile.execution.expiresAt <= Date.now()) throw new Error('assistant-skills: current external holdout profile required')
    const profileDigest = acceptanceDigest(profile)
    const candidate = this.#store.getCandidate(scope, candidateId)
    if (!candidate?.parentDigest) throw new Error('assistant-skills: external qualification requires an existing parent')
    const candidateDigest = acceptanceDigest(candidate)
    const claim = this.#store.claimComparison(scope, { sessionId: String(exec.agent!.session.id), candidateId, parentDigest: candidate.parentDigest, profileId: `external:${profile.id}:${profile.version}`, profileDigest, invocationId }, 1)
    const current = (running = true) => {
      exec.signal.throwIfAborted(); this.#lifecycle.signal.throwIfAborted()
      currentAuthority?.()
      const fresh = this.#externalHoldouts.find(value => value.id === profile.id && value.version === profile.version && acceptanceDigest(value.scope) === acceptanceDigest(scope))
      if (!fresh || acceptanceDigest(fresh) !== profileDigest || Date.now() >= profile.execution.expiresAt
        || acceptanceDigest(this.#scope(exec.agent, action)) !== acceptanceDigest(scope)
        || acceptanceDigest(this.#store.getCandidate(scope, candidateId)) !== candidateDigest
        || running && this.#store.getComparison(scope, claim.comparison.id)?.state !== 'running') throw new Error('assistant-skills: external qualification authority changed')
      this.#pending(scope, candidateId)
    }
    if (!claim.claimed) { current(false); return claim.comparison }
    const operation = (async () => {
      try {
        this.#authorize(exec.agent, 'compare', claim.comparison.id)
        current()
        const baseline = this.#store.get(scope, candidate.definition.name, candidate.parentVersion)
        if (!baseline || acceptanceDigest(baseline) !== candidate.parentDigest) throw new Error('assistant-skills: candidate parent changed')
        const opened = await openHoldoutProcess(profile.authority, AbortSignal.any([exec.signal, this.#lifecycle.signal]))
        let result: Awaited<ReturnType<typeof qualifyHoldout>>
        try {
          result = await qualifyHoldout({ baseline, candidate: candidate.definition, scope,
            execution: { ...profile.execution, stateRoot: join(profile.execution.stateRoot, claim.comparison.id) }, ...(profile.inputs === undefined ? {} : { inputs: profile.inputs }), ...(profile.files === undefined ? {} : { files: profile.files }),
            pinnedPublicKey: profile.authority.publicKey, ...(profile.authority.datasetDigest === undefined ? {} : { expectedDatasetDigest: profile.authority.datasetDigest }), ...(profile.authority.generatorDigest === undefined ? {} : { expectedGeneratorDigest: profile.authority.generatorDigest }), transport: opened.transport,
            signal: AbortSignal.any([exec.signal, this.#lifecycle.signal]), authorize: current })
        } finally { await opened.close() }
        current()
        return this.#store.finishComparison(scope, claim.comparison.id, result.receipt.complete && result.receipt.cellVerdicts.every(value => value.verdict !== 'unknown') ? 'complete' : 'unknown', result)
      } catch {
        this.#store.finishComparison(scope, claim.comparison.id, 'unknown', { reason: 'external-qualification-failed-or-authority-changed', promotionAuthorized: false })
        throw new Error(`assistant-skills: external qualification ${claim.comparison.id} is unknown; inspect status, do not replay`)
      }
    })()
    this.#comparing.add(operation)
    try { return await operation } finally { this.#comparing.delete(operation) }
  }
  #promotePolicy(scope: GoalScope) {
    return { subject: { kind: 'background' as const, id: 'dsh-enhanced-assistant-skills', workspace: scope.workspace, principal: scope.principalId },
      action: 'promote', resource, context: { initiator: 'background' as const } }
  }
  #deploymentCurrent(deployment: SkillDeployment): void {
    const scope = deployment.scope as GoalScope
    if (!this.#active || deployment.expiresAt <= Date.now() || deployment.state !== 'canary' && deployment.state !== 'promoted') throw new Error('assistant-skills: deployment authority ended')
    const watch = this.#store.listWatches(scope).find(value => value.id === deployment.watchId)
    if (!watch || watch.ownerRouteId.length === 0 || acceptanceDigest(watch.routeReceipt) !== acceptanceDigest(deployment.routeReceipt)) throw new Error('assistant-skills: deployment route changed')
    this.#watchRoute(scope, watch.ownerRouteId, deployment.routeReceipt)
    this.#watchAuthorized(watch)
    const current = this.#store.get(scope, deployment.skillName)
    if (!current || current.retired || current.version !== deployment.version || acceptanceDigest(current) !== deployment.definitionDigest) throw new Error('assistant-skills: deployment superseded')
    const comparison = this.#store.getComparison(scope, deployment.comparisonId)
    if (!comparison || comparison.state !== 'complete' || acceptanceDigest(comparison.result) !== deployment.qualificationDigest) throw new Error('assistant-skills: deployment qualification changed')
    const profile = this.#externalHoldouts.find(value => `external:${value.id}:${value.version}` === comparison.profileId && acceptanceDigest(value.scope) === acceptanceDigest(scope))
    if (!profile || acceptanceDigest(profile) !== comparison.profileDigest || profile.execution.expiresAt < deployment.expiresAt) throw new Error('assistant-skills: deployment profile changed')
  }
  #deploymentAuthorized(deployment: SkillDeployment, authorize = false): void {
    this.#deploymentCurrent(deployment)
    const policy = this.ctx.get('assistantPolicy', false)
    if (!policy || policy.evaluate(this.#promotePolicy(deployment.scope as GoalScope)).effect !== 'allow') throw new Error('assistant-skills: deployment promotion authority ended')
    if (authorize && policy.authorize(this.#promotePolicy(deployment.scope as GoalScope), { idempotencyKey: `${deployment.id}:promote` }).effect !== 'allow') throw new Error('assistant-skills: deployment promotion authorization denied')
  }
  #canaryCurrent(exec: ToolRunContext, scope: GoalScope, profile: ExternalHoldoutProfile, input: SkillDeploymentInput, receipt?: unknown): unknown {
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > profile.execution.expiresAt || input.expiresAt > Date.now() + 7 * 86400000
      || !Number.isSafeInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 100 || !Number.isSafeInteger(input.canaryRuns) || input.canaryRuns < 1 || input.canaryRuns > input.maxRuns) throw new Error('assistant-skills: invalid canary authorization')
    if (acceptanceDigest(this.#scope(exec.agent, 'canary')) !== acceptanceDigest(scope) || acceptanceDigest(this.#scope(exec.agent, 'compare')) !== acceptanceDigest(scope) || acceptanceDigest(this.#scope(exec.agent, 'watch')) !== acceptanceDigest(scope)) throw new Error('assistant-skills: canary authority changed')
    const route = this.#watchRoute(scope, input.ownerRouteId, receipt)
    const policy = this.ctx.get('assistantPolicy', false)
    if (!policy || policy.evaluate(this.#promotePolicy(scope)).effect !== 'allow'
      || ['watch', 'rollback'].some(action => policy.evaluate(this.#watchPolicy(scope, action as 'watch' | 'rollback')).effect !== 'allow')) throw new Error('assistant-skills: configure finite promotion and rollback authority')
    return route
  }
  async canary(exec: ToolRunContext, candidateId: string, profileId: string, invocationId: string, input: SkillDeploymentInput) {
    input = Object.freeze({ ...input })
    const scope = this.#scope(exec.agent, 'canary')
    const candidate = this.#store.getCandidate(scope, candidateId)
    if (!candidate) throw new Error('assistant-skills: candidate unavailable')
    const profile = this.#externalHoldouts.find(value => value.id === profileId && acceptanceDigest(value.scope) === acceptanceDigest(scope))
    if (!profile) throw new Error('assistant-skills: prospective external holdout profile required')
    const route = this.#canaryCurrent(exec, scope, profile, input)
    // A candidate can only ever receive one deployment.  A retry must match the
    // original finite authorization exactly; it cannot renew or mutate it.
    if (candidate.state === 'activated') {
      const existing = candidate.deploymentId ? this.#store.getDeployment(scope, candidate.deploymentId) : undefined
      const watch = existing && this.#store.listWatches(scope).find(value => value.id === existing.watchId)
      if (!existing || !watch || existing.comparisonId === '' || existing.expiresAt !== input.expiresAt || existing.maxRuns !== input.maxRuns || existing.canaryRuns !== input.canaryRuns || watch.ownerRouteId !== input.ownerRouteId) throw new Error('assistant-skills: canary authorization conflict')
      const comparison = this.#store.getComparison(scope, existing.comparisonId)
      if (!comparison || comparison.profileId !== `external:${profile.id}:${profile.version}` || comparison.invocationId !== invocationId) throw new Error('assistant-skills: canary authorization conflict')
      this.#watchRoute(scope, input.ownerRouteId, existing.routeReceipt)
      return { definition: this.#store.get(scope, existing.skillName, existing.version), deployment: existing, replayed: true }
    }
    if (!profile.authority.generatorDigest) throw new Error('assistant-skills: prospective external holdout profile required')
    this.#pending(scope, candidateId)
    this.#authorize(exec.agent, 'canary', [scope, candidateId, profileId, invocationId, input, route])
    const qualified = await this.qualifyExternalHoldout(exec, candidateId, profileId, invocationId, 'canary', () => { this.#canaryCurrent(exec, scope, profile, input, route) })
    const comparison = this.#store.getComparison(scope, qualified.id)
    const baseline = this.#store.get(scope, candidate.definition.name, candidate.parentVersion)
    if (!comparison || !baseline || candidate.state !== 'pending') throw new Error('assistant-skills: canary qualification unavailable')
    const prospective = inspectProspectiveQualification(comparison.result, { scope, baseline, candidate: candidate.definition, execution: profile.execution,
      ...(profile.inputs === undefined ? {} : { inputs: profile.inputs }), ...(profile.files === undefined ? {} : { files: profile.files }), pinnedPublicKey: profile.authority.publicKey, expectedGeneratorDigest: profile.authority.generatorDigest })
    if (!prospective || prospective.prospectiveHoldout !== 'authority-attested-after-freeze' || prospective.quality.candidateChecksPassed !== true || prospective.quality.evaluationGainObserved !== true || prospective.quality.criticalRegressionsPassed !== true) throw new Error('assistant-skills: prospective qualification gates failed')
    this.#canaryCurrent(exec, scope, profile, input, route)
    this.#authorize(exec.agent, 'watch', [scope, candidateId, comparison.id, input, route])
    this.#canaryCurrent(exec, scope, profile, input, route)
    const activated = this.#store.activateQualifiedCandidate(scope, candidateId, comparison.id, acceptanceDigest(comparison.result), input, route)
    this.#changed(); this.#queueReconcile()
    return { ...activated, replayed: false }
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
  activate(agent: Agent | undefined, candidateId: string, trialRunId: string, observation?: { ownerRouteId: string; expiresAt: number; maxRuns: number; failureThreshold: number }) {
    const scope = this.#scope(agent, 'activate')
    const candidate = this.#store.getCandidate(scope, candidateId), run = this.#store.getRun(scope, trialRunId)
    if (!candidate || !run || run.candidateId !== candidateId || run.state !== 'succeeded' || !run.goalExecutionRunId || run.sessionId !== String(agent!.session.id)) throw new Error('assistant-skills: successful exact trial required')
    const watch = observation && { input: { ...observation, skillName: candidate.definition.name, version: candidate.parentVersion + 1, fallbackVersion: candidate.parentVersion }, routeReceipt: this.#watchRoute(scope, observation.ownerRouteId) }
    const watchAuthority = () => {
      if (!watch) return
      const policy = this.ctx.get('assistantPolicy', false)
      if (candidate.parentVersion < 1 || acceptanceDigest(this.#scope(agent, 'watch')) !== acceptanceDigest(scope) || !policy
        || ['watch', 'rollback'].some(action => policy.evaluate(this.#watchPolicy(scope, action as 'watch' | 'rollback')).effect !== 'allow')) throw new Error('assistant-skills: current activation watch authority required')
      this.#watchRoute(scope, watch.input.ownerRouteId, watch.routeReceipt)
    }
    const result = (activated: ReturnType<SkillStore['activateCandidate']>, activeVersion: number | null) => ({ activated, activeVersion, replayed: false, improvement: 'unmeasured',
      ...(watch ? { watch: this.#store.listWatches(scope).find(value => value.id === this.#store.getCandidate(scope, candidateId)?.activationWatchId) } : {}) })
    watchAuthority()
    // A lost activation response can be recovered without renewing proof or changing a later version.
    if (candidate.state === 'activated' && candidate.trialRunId === trialRunId && candidate.acceptanceDigest) {
      return result(this.#store.activateCandidate(scope, candidateId, trialRunId, candidate.acceptanceDigest, watch), this.#store.get(scope, candidate.definition.name)?.version ?? null)
    }
    this.#pending(scope, candidateId)
    const verify = () => {
      const proof = this.#goals().inspectVerifiedWorkflowRun(agent, run.goalId, run.goalExecutionRunId!)
      if (acceptanceDigest(proof.scope) !== acceptanceDigest(scope) || proof.goal.sessionId !== run.sessionId || proof.runId !== run.goalExecutionRunId
        || !trialProofSteps(proof.steps, candidateId, trialRunId, run.goalId, run.invocationId, run.inputs)) throw new Error('assistant-skills: independent exact trial acceptance required')
      return acceptanceDigest(proof.acceptance)
    }
    const receipt = verify()
    this.#authorize(agent, 'activate', [scope, candidateId, trialRunId])
    if (watch) this.#authorize(agent, 'watch', [scope, candidateId, trialRunId, watch.input])
    if (acceptanceDigest(this.#scope(agent, 'activate')) !== acceptanceDigest(scope) || verify() !== receipt) throw new Error('assistant-skills: trial authority changed')
    watchAuthority()
    const activated = this.#store.activateCandidate(scope, candidateId, trialRunId, receipt, watch)
    this.#changed()
    return result(activated, activated.version)
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
  capture(agent: Agent | undefined, input: { ownerRouteId: string; goalId: string; name: string; description: string; parentVersion: number; expiresAt: number }) {
    const scope = this.#scope(agent, 'capture'), route = this.#watchRoute(scope, input.ownerRouteId)
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 7 * 86400000) throw new Error('assistant-skills: invalid capture expiry')
    const policy = this.ctx.get('assistantPolicy', false)
    if (!policy || policy.evaluate(this.#capturePolicy(scope)).effect !== 'allow') throw new Error('assistant-skills: configure background capture permission')
    this.#authorize(agent, 'capture', [scope, input]); this.#watchRoute(scope, input.ownerRouteId, route)
    const goals = this.#goals() as AssistantGoalsService & { inspectActiveWorkflowCaptureContext?: (agent: Agent | undefined, goalId: string) => { scope: GoalScope; goalId: string; sessionId: string; nativeGoalId: string; definition: { digest: string } } }
    if (typeof goals.inspectActiveWorkflowCaptureContext !== 'function') throw new Error('assistant-skills: Goals active capture bridge unavailable')
    const active = goals.inspectActiveWorkflowCaptureContext(agent, input.goalId)
    const sessionId = String(agent!.session.id)
    const goal = goals.inspectOwnerGoalExecution({ ownerRouteId: input.ownerRouteId, principalId: scope.principalId, workspace: scope.workspace, preset: scope.preset, sessionId, goalId: input.goalId }) as { storedGoal?: { definition?: { digest?: string }; nativeAtLastObservation?: { sessionId?: string; goalId?: string; phase?: string } } }
    const digest = goal.storedGoal?.definition?.digest, native = goal.storedGoal?.nativeAtLastObservation
    if (acceptanceDigest(active.scope) !== acceptanceDigest(scope) || active.goalId !== input.goalId || active.sessionId !== sessionId
      || typeof active.nativeGoalId !== 'string' || typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)
      || active.definition.digest !== digest || native?.phase !== 'active' || native.sessionId !== active.sessionId || native.goalId !== active.nativeGoalId) throw new Error('assistant-skills: exact active goal required')
    this.#watchRoute(scope, input.ownerRouteId, route)
    const saved = this.#store.createCapture(scope, { ...input, sessionId, nativeGoalId: active.nativeGoalId }, route, digest); this.#queueReconcile(); return saved
  }
  #capturePolicy(scope: GoalScope) { return { subject: { kind: 'background' as const, id: 'dsh-enhanced-assistant-skills', workspace: scope.workspace, principal: scope.principalId }, action: 'capture', resource, context: { initiator: 'background' as const } } }
  #captureAuthorized(capture: SkillCapture): void {
    const scope = capture.scope as GoalScope; this.#watchRoute(scope, capture.ownerRouteId, capture.routeReceipt)
    const policy = this.ctx.get('assistantPolicy', false)
    if (!this.#active || Date.now() >= capture.expiresAt || !policy || policy.evaluate(this.#capturePolicy(scope)).effect !== 'allow'
      || policy.authorize(this.#capturePolicy(scope), { idempotencyKey: `${capture.id}:capture` }).effect !== 'allow') throw new Error('assistant-skills: capture authority ended')
  }
  #captureCurrent(capture: SkillCapture): void {
    const scope = capture.scope as GoalScope
    this.#captureAuthorized(capture)
    const parent = this.#store.get(scope, capture.name)
    if ((parent?.version ?? 0) !== capture.parentVersion || (parent ? acceptanceDigest(parent) : null) !== capture.parentDigest) throw new Error('assistant-skills: capture changed')
    const snapshot = this.#goals().inspectOwnerGoalExecution({ ownerRouteId: capture.ownerRouteId, principalId: scope.principalId, workspace: scope.workspace, preset: scope.preset, sessionId: capture.sessionId, goalId: capture.goalId }) as { storedGoal?: { definition?: { digest?: string }; nativeAtLastObservation?: { sessionId?: string; goalId?: string } } }
    const goal = snapshot.storedGoal
    if (goal?.definition?.digest !== capture.definitionDigest || goal.nativeAtLastObservation?.sessionId !== capture.sessionId || goal.nativeAtLastObservation?.goalId !== capture.nativeGoalId) throw new Error('assistant-skills: capture changed')
  }
  #captureBridgeFailure(capture: SkillCapture, error: unknown): void {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
    if (code === 'pending' || code === 'unavailable') return
    const message = error instanceof Error ? error.message : ''
    const detail = typeof code === 'string' ? code : 'GOAL_CAPTURE_UNKNOWN'
    // Exact internal terminal outcomes are deliberately mapped without parsing
    // a foreign Host error message. All other failures become unknown once.
    const state = message === 'assistant-skills: owner route changed' || message === 'assistant-skills: capture authority ended' || message === 'assistant-skills: capture changed' ? 'revoked' : 'unknown'
    this.#store.finishCapture(capture.scope, capture.id, state, detail)
  }
  #queueReconcile(): void {
    if (!this.#active || this.#reconcileQueued) return
    this.#reconcileQueued = true
    queueMicrotask(() => { this.#reconcileQueued = false; if (!this.#active) return; try { this.#reconcile() } catch { /* Durable watches are retried on the next nudge or dependency activation. */ } })
  }
  #reconcile(): void {
    if (!this.#active || !this.ctx.get('assistantGoals', false) || !this.ctx.get('assistantPolicy', false)
      || !this.ctx.get('assistantDelivery', false) || !this.ctx.get('assistantVerifier', false)) return
    // Establish current deployment authority before consuming any later Goal
    // outcome.  A stale route/profile/policy cannot turn an old observation into
    // a promotion decision.
    for (const deployment of this.#store.listDeployments()) {
      const watch = this.#store.listWatches(deployment.scope).find(value => value.id === deployment.watchId)
      // These terminal facts cannot create a promotion, so synchronize them
      // without treating a later rollback as a policy revocation.
      if (deployment.expiresAt <= Date.now() || watch && ['rolled-back', 'expired', 'revoked', 'superseded'].includes(watch.state)) { this.#store.reconcileDeployment(deployment.scope, deployment.id); continue }
      if (deployment.state !== 'canary' && deployment.state !== 'promoted') continue
      try { this.#deploymentAuthorized(deployment, true) } catch { this.#store.stopDeployment(deployment.scope, deployment.id, 'revoked') }
    }
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
    // Watches above produce only independently verified observations.  Recheck
    // exact authority after that read, then let the store atomically select the
    // terminal deployment state; it never writes over a later skill version.
    for (const deployment of this.#store.listDeployments()) {
      const watch = this.#store.listWatches(deployment.scope).find(value => value.id === deployment.watchId)
      if (deployment.expiresAt <= Date.now() || watch && ['rolled-back', 'expired', 'revoked', 'superseded'].includes(watch.state)) { this.#store.reconcileDeployment(deployment.scope, deployment.id); continue }
      if (deployment.state !== 'canary' && deployment.state !== 'promoted') continue
      try {
        this.#deploymentAuthorized(deployment, true)
        const reconciled = this.#store.reconcileDeployment(deployment.scope, deployment.id)
        if (reconciled && reconciled.state !== deployment.state) this.#changed()
      } catch { this.#store.stopDeployment(deployment.scope, deployment.id, 'revoked') }
    }
    for (const capture of this.#store.listCaptures()) {
      const scope = capture.scope as GoalScope
      if (capture.expiresAt <= Date.now()) { this.#store.finishCapture(scope, capture.id, 'expired'); continue }
      try {
        this.#captureCurrent(capture)
        const goals = this.#goals() as AssistantGoalsService & { inspectOwnerVerifiedWorkflowSource?: (input: { ownerRouteId: string; principalId: string; workspace: string; preset: string; sessionId: string; goalId: string }, signal?: AbortSignal) => Promise<import('./definition.js').VerifiedWorkflowSource> }
        if (typeof goals.inspectOwnerVerifiedWorkflowSource !== 'function') { this.#store.finishCapture(scope, capture.id, 'unsupported', 'Goals Host capture bridge unavailable'); continue }
        if (this.#captureInflight.has(capture.id)) { this.#captureDirty.add(capture.id); continue }
        this.#captureInflight.add(capture.id)
        const task = goals.inspectOwnerVerifiedWorkflowSource({ ownerRouteId: capture.ownerRouteId, principalId: scope.principalId, workspace: scope.workspace, preset: scope.preset, sessionId: capture.sessionId, goalId: capture.goalId }, this.#lifecycle.signal).then(source => {
          try { this.#captureCurrent(capture); const definition = createDefinition(source, { name: capture.name, description: capture.description }, this.#allowed); this.#captureCurrent(capture); this.#store.captureCandidate(scope, capture.id, definition); this.#changed() } catch (error) { this.#captureBridgeFailure(capture, error) }
        }).catch(error => this.#captureBridgeFailure(capture, error)).then(() => undefined)
        this.#captureTasks.add(task)
        void task.finally(() => { this.#captureTasks.delete(task); this.#captureInflight.delete(capture.id); if (this.#captureDirty.delete(capture.id) && this.#active) this.#queueReconcile() })
      } catch (error) { this.#captureBridgeFailure(capture, error) }
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
    const goals = this.#goals() as AssistantGoalsService & { inspectActiveWorkflowCaptureContext?: (agent: Agent | undefined, goalId: string) => { scope: GoalScope; goalId: string; sessionId: string; nativeGoalId: string; definition: { digest: string } } }
    let current: ReturnType<AssistantGoalsService['inspectWorkflowRunContext']>
    try { current = goals.inspectWorkflowRunContext(exec.agent, goalId) } catch (roundError) {
      // This is a handoff only: no durable invocation is claimed and no action
      // authorization budget is consumed until the next admitted native round.
      const invocationValid = typeof invocationId === 'string' && invocationId.length > 0 && invocationId.length <= 256 && !/[\p{Cc}]/u.test(invocationId)
      if (!invocationValid || typeof goals.inspectActiveWorkflowCaptureContext !== 'function') throw roundError
      let active: { scope: GoalScope; goalId: string; sessionId: string; nativeGoalId: string; definition: { digest: string } }
      try { active = goals.inspectActiveWorkflowCaptureContext(exec.agent, goalId) } catch { throw roundError }
      if (acceptanceDigest(active.scope) !== acceptanceDigest(scope) || active.goalId !== goalId || active.sessionId !== String(exec.agent!.session.id)
        || goalId === skill.source.goal.id || typeof active.nativeGoalId !== 'string' || typeof active.definition.digest !== 'string') throw roundError
      exec.signal.throwIfAborted(); this.#lifecycle.signal.throwIfAborted()
      if (acceptanceDigest(this.#scope(exec.agent, action)) !== acceptanceDigest(scope)) throw roundError
      exec.concludeTurn()
      const tool = candidateId ? 'skill_trial' : 'skill_run'
      return { state: 'awaiting-native-round' as const, performed: false, context: 'No skill step or durable invocation has been claimed or executed; this is not a queued background task.', next: `After the Host starts this Goal's native round, call ${tool} again with this same goal, skill or candidate, inputs, and invocation_id.`, goalId, ...(candidateId ? { candidateId } : {}), skillName: name, version, invocationId, inputs }
    }
    if (acceptanceDigest(scope) !== acceptanceDigest(current.scope) || goalId === skill.source.goal.id) throw new Error('assistant-skills: fresh owner Goal required')
    const identity = acceptanceDigest(current)
    const goalContext = current as typeof current & { nativeGoalId?: string }
    // claim() reconciles a deployed version while holding its transaction.  Do
    // not let that implicit state transition promote from an old background
    // permission or route observation.
    const deploymentBeforeClaim = candidateId ? undefined : this.#store.deploymentForVersion(scope, name, version)
    const priorRun = this.#store.getRun(scope, `skill-run-${acceptanceDigest([scope, current.sessionId, invocationId])}`)
    if (deploymentBeforeClaim && !priorRun) {
      try {
        this.#deploymentAuthorized(deploymentBeforeClaim, true)
        const watch = this.#store.listWatches(scope).find(value => value.id === deploymentBeforeClaim.watchId)
        if (!watch) throw new Error('assistant-skills: deployment watch unavailable')
        this.#watchAuthorized(watch)
      } catch {
        this.#store.stopDeployment(scope, deploymentBeforeClaim.id, 'revoked')
        throw new Error('assistant-skills: deployment authority ended')
      }
    }
    const claim = this.#store.claim(scope, { invocationId, goalId, sessionId: current.sessionId, skillName: name, version, inputs, goalExecutionRunId: current.goalExecutionRunId, goalDefinitionDigest: current.definition.digest, ...(typeof goalContext.nativeGoalId === 'string' ? { nativeGoalId: goalContext.nativeGoalId } : {}), ...(candidateId ? { candidateId } : {}) })
    if (!claim.claimed) {
      if (claim.run.state !== 'succeeded') throw new Error(`assistant-skills: invocation ${claim.run.id} is ${claim.run.state}; inspect skill_status, do not replay`)
      return { ...claim.run, replayed: false, acceptance: 'requires-fresh-goal-verification' }
    }
    // claim() atomically reserves a deployment slot with the run.  The second
    // read binds this dispatch to that exact reservation before any tool call.
    const deployment = deploymentBeforeClaim
    if (deployment) {
      try { this.#deploymentAuthorized(this.#store.assertDeploymentRun(scope, claim.run.id)) } catch {
        this.#store.finish(scope, claim.run.id, 'unknown', [])
        throw new Error(`assistant-skills: invocation ${claim.run.id} is unknown; inspect skill_status, do not replay`)
      }
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
        if (deployment) this.#deploymentAuthorized(this.#store.assertDeploymentRun(scope, claim.run.id))
      }
    }
    try {
      this.#authorize(exec.agent, action, claim.run.id)
      for (const [index, step] of steps.entries()) {
        revalidate()
        if (!this.#allowed.includes(step.toolName)) throw new Error('assistant-skills: current tool allowlist denied')
        dispatched = true
        const result = await exec.agent!.ctx.get('tools')!.execute({ callId: ToolCallId(`${exec.callId}:skill:${index + 1}`), rootCallId: exec.rootCallId, parent: exec.token, agent: exec.agent!, name: step.toolName, arguments: step.arguments, signal })
        revalidate()
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
    } catch { state = deployment || dispatched || signal.aborted ? 'unknown' : 'failed' }
    finally { clearTimeout(timer) }
    if (!this.#active) throw new Error('assistant-skills: runtime disposed; invocation will recover as unknown')
    const saved = this.#store.finish(scope, claim.run.id, state, completed)
    if (saved.state !== 'succeeded') throw new Error(`assistant-skills: invocation ${saved.id} is ${saved.state}; inspect skill_status, do not replay`)
    this.#queueReconcile()
    return { ...saved, replayed: false, acceptance: 'requires-fresh-goal-verification' }
  }
}
