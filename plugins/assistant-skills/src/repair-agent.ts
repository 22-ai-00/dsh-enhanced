import { createHash } from 'node:crypto'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { GoalScope, HostFailureTriggerEvidence, OwnerAuthorizedRepairInput } from '@dsh-enhanced/assistant-goals'
import type { AssistantGoalsService } from '@dsh-enhanced/assistant-goals'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'

export interface OwnerRepairAgentInput {
  id: string
  authorizationDigest: string
  scope: GoalScope
  ownerRouteId: string
  trigger: HostFailureTriggerEvidence
  objective: string
  maxGoalRounds: number
  expiresAt: number
  provider: string
  model: string
  maxModelCalls: number
  maxToolCalls: number
  maxOutputTokens: number
  maxDurationMs: number
  allowedTools: readonly string[]
  iteration?: number
  initialModelCalls?: number
  initialToolCalls?: number
  recordUsage?: (kind: 'model' | 'tool') => void
  assertCurrent: () => void
}

type Goals = Pick<AssistantGoalsService, 'startOwnerAuthorizedRepair'>
type Policy = Pick<AssistantPolicyService, 'bindInitiator'>

const validText = (value: unknown, max = 4_096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const validCount = (value: unknown, min = 1): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= 1_000_000_000
const sessionIdFor = (authorizationId: string) => SessionId(`owner-repair-${createHash('sha256').update(authorizationId).digest('hex').slice(0, 40)}`)

function validate(input: OwnerRepairAgentInput): void {
  if (!validText(input.id) || !validText(input.authorizationDigest) || !validText(input.ownerRouteId)
    || !validText(input.objective, 16_384) || !validText(input.provider) || !validText(input.model)
    || !validCount(input.maxGoalRounds) || !validCount(input.maxModelCalls) || !validCount(input.maxToolCalls, 0)
    || !validCount(input.maxOutputTokens) || !validCount(input.maxDurationMs) || !Number.isSafeInteger(input.expiresAt)
    || input.expiresAt <= Date.now() || typeof input.assertCurrent !== 'function'
    || !Array.isArray(input.allowedTools) || input.allowedTools.length > 256 || input.allowedTools.some(tool => !validText(tool, 256))
    || input.iteration !== undefined && (!validCount(input.iteration) || input.iteration > 4)
    || input.initialModelCalls !== undefined && (!validCount(input.initialModelCalls, 0) || input.initialModelCalls > input.maxModelCalls)
    || input.initialToolCalls !== undefined && (!validCount(input.initialToolCalls, 0) || input.initialToolCalls > input.maxToolCalls)
    || input.recordUsage !== undefined && typeof input.recordUsage !== 'function'
    || new Set(input.allowedTools).size !== input.allowedTools.length) throw new Error('assistant-skills: invalid owner repair Agent input')
}

/**
 * Owns short-lived Agents for already-authorized repair Goals.  It deliberately
 * does not submit a user message: the mounted native goal-round driver is the
 * only continuation producer after Goals creates the armed native goal.
 */
export class OwnerRepairAgentRuntime {
  readonly #handles = new Map<string, AgentHandle>()
  readonly #attempted = new Set<string>()
  readonly #toolSchemaDigests = new Map<string, string>()
  readonly #controllers = new Map<string, AbortController>()
  readonly #authorizationSessions = new Map<string, Set<string>>()
  readonly #inflight = new Map<string, Promise<{ sessionId: string; goalId: string }>>()
  #disposeFlight: Promise<void> | undefined
  #disposed = false

  constructor(private readonly ctx: Context) {
    ctx.effect(() => () => this.dispose(), 'assistant-skills.owner-repair-agents')
  }

  get(sessionId: string): Agent | undefined { return this.#handles.get(sessionId)?.agent }

  async create(input: OwnerRepairAgentInput, signal?: AbortSignal): Promise<{ sessionId: string; goalId: string }> {
    if (this.#disposed) throw new Error('assistant-skills: owner repair Agent runtime disposed')
    validate(input); input.assertCurrent()
    const sessionId = sessionIdFor(`${input.id}:${input.iteration ?? 1}`)
    const key = String(sessionId)
    if (this.#attempted.has(key)) throw new Error('assistant-skills: owner repair Agent creation is not retry-safe')
    this.#attempted.add(key)
    const sessions = this.#authorizationSessions.get(input.id) ?? new Set<string>(); sessions.add(key); this.#authorizationSessions.set(input.id, sessions)
    const creation = this.#create(sessionId, key, input, signal)
    this.#inflight.set(key, creation)
    try { return await creation } finally { this.#inflight.delete(key) }
  }

  async #create(sessionId: SessionId, key: string, input: OwnerRepairAgentInput, signal?: AbortSignal): Promise<{ sessionId: string; goalId: string }> {
    const deadline = new AbortController()
    this.#controllers.set(key, deadline)
    const timer = setTimeout(() => deadline.abort(new Error('assistant-skills: owner repair Agent deadline exceeded')), Math.min(input.maxDurationMs, input.expiresAt - Date.now()))
    timer.unref?.()
    const combined = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal])
    let handle: AgentHandle | undefined
    let retained = false
    try {
      const agents = this.ctx.get('agents')
      const goals = this.ctx.get('assistantGoals' as never, false) as Goals | undefined
      const policy = this.ctx.get('assistantPolicy' as never, false) as Policy | undefined
      if (agents === undefined || goals === undefined || policy === undefined) throw new Error('assistant-skills: repair Agent dependencies unavailable')
      handle = await agents.create({ sessionId, meta: { cwd: input.scope.workspace, agentPreset: input.scope.preset },
        agentOptions: { provider: input.provider, model: input.model, maxTokens: input.maxOutputTokens }, signal: combined,
        setup: async agentCtx => {
          const agent = agentCtx.agent
          if (agent === undefined) throw new Error('assistant-skills: unpublished repair Agent is unavailable')
          input.assertCurrent(); combined.throwIfAborted()
          // Establish background authority and cancellation before mounting preset effects.
          this.#setupRepairAgent(agentCtx, agent, input, combined, timer)
          const presets = this.ctx.get('agentPresets' as never, false) as { resolve(id: string): Promise<{ id: string }>; mount(ctx: typeof agentCtx, id: string): Promise<void> } | undefined
          if (presets !== undefined) {
            const preset = await presets.resolve(input.scope.preset)
            input.assertCurrent(); combined.throwIfAborted()
            if (preset.id !== input.scope.preset) throw new Error('assistant-skills: repair preset changed')
            await presets.mount(agentCtx, preset.id)
          }
          input.assertCurrent(); combined.throwIfAborted()
          this.#checkRepairTools(agentCtx, agent, input)
        },
      })
      input.assertCurrent(); combined.throwIfAborted()
      this.#handles.set(key, handle)
      const repair: OwnerAuthorizedRepairInput = { authorizationId: input.id, authorizationDigest: input.authorizationDigest,
        ownerRouteId: input.ownerRouteId, scope: input.scope, trigger: input.trigger, objective: input.objective,
        maxGoalRounds: input.maxGoalRounds, expiresAt: input.expiresAt }
      const currentGoals = this.ctx.get('assistantGoals' as never, false) as Goals | undefined
      if (currentGoals === undefined) throw new Error('assistant-skills: repair Goals service changed')
      const record = await currentGoals.startOwnerAuthorizedRepair(handle.agent, repair, input.assertCurrent)
      retained = true
      return { sessionId: key, goalId: record.id }
    } catch (error) {
      deadline.abort(new Error('assistant-skills: repair Agent creation failed'))
      this.#handles.delete(key)
      this.#toolSchemaDigests.delete(key)
      if (handle !== undefined) await handle.dispose()
      throw error
    } finally { if (!retained) { this.#controllers.delete(key); clearTimeout(timer) } }
  }

  #checkRepairTools(agentCtx: Agent['ctx'], agent: Agent, input: OwnerRepairAgentInput): void {
    const allowed = new Set(input.allowedTools)
    const globalNames = agentCtx.tools.schemas().map(schema => schema.name)
    const mountedNames = agentCtx.tools.schemas(agent).map(schema => schema.name)
    for (const name of allowed) {
      if (!mountedNames.includes(name)) throw new Error(`assistant-skills: unknown repair allowlist tool: ${name}`)
    }
    const denied = globalNames.filter(name => !allowed.has(name))
    if (denied.length > 0) agentCtx.tools.restrict({ deny: denied })
    this.#toolSchemaDigests.set(String(agent.session.id), acceptanceDigest(agentCtx.tools.schemas(agent).filter(tool => allowed.has(tool.name)).sort((a, b) => a.name.localeCompare(b.name))))
    // Pinned DSH restrict() masks globals only. Preset-local registrations stay
    // in their owning scope; model presentation and the monotonic execution
    // guard below enforce the frozen allowlist for both kinds of tool.
  }

  #setupRepairAgent(agentCtx: Agent['ctx'], agent: Agent, input: OwnerRepairAgentInput, combined: AbortSignal, timer: ReturnType<typeof setTimeout>): void {
    const policy = this.ctx.get('assistantPolicy' as never, false) as Policy | undefined
    if (policy === undefined) throw new Error('assistant-skills: repair policy changed')
    agentCtx.effect(() => policy.bindInitiator(agent, 'background', input.scope.principalId), 'assistant-skills.owner-repair-initiator')
    agentCtx.effect(() => installModelSelection(agentCtx, { current: { provider: input.provider, model: input.model }, assembled: undefined }), 'assistant-skills.owner-repair-model')
    const allowed = new Set(input.allowedTools)
    const schemaDigests = this.#toolSchemaDigests
    agentCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next()
      if (context.agent !== agent) return assembly
      return { ...assembly, tools: assembly.tools.filter(tool => allowed.has(tool.name)).sort((a, b) => a.name.localeCompare(b.name)) }
    })
    let calls = input.initialModelCalls ?? 0
    let toolCalls = input.initialToolCalls ?? 0
    agentCtx.on('llm/stream', async function* (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) {
      // Cordis service event filtering follows service realms, not Agent identity.
      // The native loop stamps this immutable Session id on every request.
      if (options.sessionId !== agent.session.id) { yield* next(); return }
      input.assertCurrent(); combined.throwIfAborted()
      if (options.provider !== input.provider || options.model !== input.model || options.maxTokens === undefined || options.maxTokens > input.maxOutputTokens || acceptanceDigest(options.tools ?? []) !== schemaDigests.get(String(agent.session.id)) || calls++ >= input.maxModelCalls) {
        agent.cancel({ kind: 'hook', reason: 'assistant-skills-owner-repair-model-limit' })
        throw new Error('assistant-skills: owner repair model request rejected')
      }
      input.recordUsage?.('model')
      for await (const chunk of next()) { combined.throwIfAborted(); yield chunk }
    })
    agentCtx.tools.guard(execution => {
      input.assertCurrent(); combined.throwIfAborted()
      if (!allowed.has(execution.name) || toolCalls >= input.maxToolCalls) {
        agent.cancel({ kind: 'hook', reason: 'assistant-skills-owner-repair-tool-limit' })
        return 'assistant-skills: owner repair tool request rejected'
      }
      toolCalls += 1
      input.recordUsage?.('tool')
      return undefined
    })
    const abort = () => agent.cancel({ kind: 'hook', reason: 'assistant-skills-owner-repair-expired' })
    combined.addEventListener('abort', abort, { once: true })
    agentCtx.effect(() => () => { clearTimeout(timer); combined.removeEventListener('abort', abort) }, 'assistant-skills.owner-repair-deadline')
  }

  async closeSession(sessionId: string): Promise<void> {
    this.#controllers.get(sessionId)?.abort(new Error('assistant-skills: repair Agent closed'))
    const creation = this.#inflight.get(sessionId)
    if (creation !== undefined) await creation.catch(() => undefined)
    const handle = this.#handles.get(sessionId)
    if (handle === undefined) { this.#controllers.delete(sessionId); this.#toolSchemaDigests.delete(sessionId); return }
    this.#handles.delete(sessionId)
    this.#controllers.delete(sessionId)
    await handle.dispose()
    this.#toolSchemaDigests.delete(sessionId)
  }

  async closeAuthorization(authorizationId: string): Promise<void> {
    if (!validText(authorizationId)) throw new Error('assistant-skills: invalid owner repair authorization id')
    await Promise.all([...this.#authorizationSessions.get(authorizationId) ?? []].map(sessionId => this.closeSession(sessionId)))
    this.#authorizationSessions.delete(authorizationId)
  }

  async dispose(): Promise<void> {
    return this.#disposeFlight ??= this.#dispose()
  }
  async #dispose(): Promise<void> {
    this.#disposed = true
    for (const controller of this.#controllers.values()) controller.abort(new Error('assistant-skills: repair runtime disposed'))
    const creations = [...this.#inflight.values()]
    // A creation rejected because this disposer revoked its signal is already
    // observable by its caller.  It has no published handle to dispose here.
    await Promise.allSettled(creations)
    this.#controllers.clear()
    this.#toolSchemaDigests.clear()
    this.#authorizationSessions.clear()
    const handles = [...this.#handles.entries()]
    this.#handles.clear()
    const disposalResults = await Promise.allSettled(handles.map(([, handle]) => handle.dispose()))
    const errors = disposalResults.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'assistant-skills: repair Agent disposal failed')
  }
}
