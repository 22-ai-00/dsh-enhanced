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
import { SkillStore, type SkillRunStep, type StoredSkillDefinition } from './store.js'

export interface Config { databasePath?: string; allowedTools?: string[]; maxDurationMs?: number }
export const Config: Schema<Config> = Schema.object({
  databasePath: Schema.string().default(join(homedir(), '.dsh', 'assistant-skills.sqlite')),
  allowedTools: Schema.array(Schema.string()).default(['read', 'write', 'edit']),
  maxDurationMs: Schema.number().step(1).min(1000).max(300000).default(60000),
})
declare module '@deepseek-ai/cordis' { interface Context { assistantSkills: AssistantSkillsService } }

const output = { schema: { type: 'object' as const, additionalProperties: false, properties: { context: { type: 'string' as const, required: true } } },
  render: (_args: unknown, value: { context: string }) => [{ type: 'text' as const, text: value.context }] } as const
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
  readonly #lifecycle = new AbortController()
  readonly #providers = new Set<SkillProviderControl>()
  #active = true
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'assistantSkills')
    this.#allowed = Object.freeze([...(config.allowedTools ?? ['read', 'write', 'edit'])])
    this.#duration = config.maxDurationMs ?? 60000
    if (!Number.isSafeInteger(this.#duration) || this.#duration < 1000 || this.#duration > 300000
      || this.#allowed.length > 32 || this.#allowed.some(name => typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/u.test(name))) throw new Error('assistant-skills: invalid configuration')
    this.#store = new SkillStore(config.databasePath ?? join(homedir(), '.dsh', 'assistant-skills.sqlite'))
    ctx.effect(() => () => { this.#active = false; this.#lifecycle.abort(); this.#store.close() }, 'assistant-skills.store')
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
  #scope(agent: Agent | undefined, action: 'inspect' | 'save' | 'run' | 'retire'): GoalScope {
    if (!this.#active || !agent || this.ctx.get('agents')?.get(agent.id) !== agent) throw new Error('assistant-skills: exact live agent required')
    const delivery = this.ctx.get('assistantDelivery', false) as AssistantDeliveryService | undefined
    const owner = delivery?.preferencePrincipalForAgent(agent)
    if (!owner || owner.scope.workspace !== agent.session.header.cwd || owner.scope.preset !== agent.session.header.agentPreset) throw new Error('assistant-skills: authenticated owner required')
    const scope = { principalId: owner.principalId, ...owner.principalLineage, workspace: owner.scope.workspace, preset: owner.scope.preset }
    if (action === 'save' || action === 'retire') {
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
  #authorize(agent: Agent | undefined, action: 'save' | 'run' | 'retire', key: unknown): void {
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
  async run(exec: ToolRunContext, goalId: string, name: string, version: number, inputs: Record<string, unknown>, invocationId: string) {
    const scope = this.#scope(exec.agent, 'run')
    const skill = this.#store.get(scope, name)
    if (!skill || skill.retired || skill.version !== version) throw new Error('assistant-skills: active skill version required')
    const steps = instantiate(skill, inputs).steps
    const current = this.#goals().inspectWorkflowRunContext(exec.agent, goalId)
    if (acceptanceDigest(scope) !== acceptanceDigest(current.scope) || goalId === skill.source.goal.id) throw new Error('assistant-skills: fresh owner Goal required')
    const identity = acceptanceDigest(current)
    const claim = this.#store.claim(scope, { invocationId, goalId, sessionId: current.sessionId, skillName: name, version, inputs })
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
      if (acceptanceDigest(this.#scope(exec.agent, 'run')) !== acceptanceDigest(scope)
        || acceptanceDigest(this.#goals().inspectWorkflowRunContext(exec.agent, goalId)) !== identity) throw new Error('assistant-skills: current authority changed')
      if (this.#store.getRun(scope, claim.run.id)?.state !== 'running') throw new Error('assistant-skills: invocation no longer owns dispatch')
      const live = this.#store.get(scope, name)
      if (!live || live.retired || live.version !== version) throw new Error('assistant-skills: skill retired or superseded')
    }
    try {
      this.#authorize(exec.agent, 'run', claim.run.id)
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
    return { ...saved, replayed: false, acceptance: 'requires-fresh-goal-verification' }
  }
}
