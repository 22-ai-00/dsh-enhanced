import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import Schema from '@deepseek-ai/schemastery'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OpportunityEngine, validateProfile } from './engine.js'
import type { OpportunityInput, OpportunityProfile, OpportunityScope } from './types.js'
import { reminderText, reminderExpiresAt } from './reminder.js'
import { PreparationRuntime } from './preparation.js'
import { PreparationStore } from './preparation-store.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-proactive'
export { version, OpportunityEngine, validateProfile }
export type * from './types.js'
interface NotificationPort { enqueueOwnerNotification(input: { sourceId: string; ownerRouteId: string; scope: OpportunityScope; sessionId: string; idempotencyKey: string; text: string; expiresAt: number }): unknown }
export interface Config { databasePath?: string; profiles?: OpportunityProfile[] }
const integer = (max = 1_000_000_000) => Schema.number().step(1).min(0).max(max).required()
export const Config: Schema<Config> = Schema.object({
  databasePath: Schema.string().default(join(homedir(), '.dsh', 'assistant-proactive.sqlite')),
  profiles: Schema.array(Schema.object({
    preparation: Schema.union([Schema.object({ provider: Schema.string().required(), model: Schema.string().required(), budgetId: Schema.string().required(), maxOutputTokens: Schema.number().step(1).min(1).max(32_768).required(), timeoutMs: Schema.number().step(1).min(1_000).max(300_000).required() })]),
    id: Schema.string().required(), mode: Schema.union(['prepare', 'remind', 'execute']).required(),
    expectedBenefit: integer(), successPpm: integer(1_000_000), executionCost: integer(), interruptionCost: integer(), possibleLoss: integer(),
    minimumUtility: integer(),
    mergeWindowMs: integer(), cooldownMs: integer(), rejectionCooldownMs: integer(),
    quietHours: Schema.union([Schema.object({ timezone: Schema.string().required(), startMinute: integer(1439), endMinute: integer(1439) })]),
    maxDecisionsPerGoal: integer(), maxExecutionsPerGoal: integer(), maxRemindersPerGoal: integer(),
  })).default([]),
})
declare module '@deepseek-ai/cordis' { interface Context { assistantProactive: AssistantProactiveService } }

/** This optional decision gate cannot resume a goal or grant tool/route authority. */
export class AssistantProactiveService extends Service {
  static Config = Config
  readonly #preparations: PreparationRuntime
  readonly #engine: OpportunityEngine
  readonly #profiles = new Map<string, OpportunityProfile>()
  #active = true
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'assistantProactive')
    for (const input of config.profiles ?? []) {
      const profile = validateProfile(input)
      if (this.#profiles.has(profile.id)) throw new Error('assistant-proactive: duplicate profile')
      this.#profiles.set(profile.id, profile)
    }
    this.#engine = new OpportunityEngine(config.databasePath ?? join(homedir(), '.dsh', 'assistant-proactive.sqlite'), [...this.#profiles.values()])
    ctx.effect(() => () => { this.#active = false; this.#engine.close() }, 'assistant-proactive.store')
    const preparationPath = config.databasePath === ':memory:' ? ':memory:' : `${config.databasePath ?? join(homedir(), '.dsh', 'assistant-proactive.sqlite')}.preparations`
    this.#preparations = new PreparationRuntime(ctx, new PreparationStore(preparationPath))
    ctx.inject(['tools', 'agents', 'assistantDelivery', 'assistantPolicy'], runtime => {
      const output = {
        schema: { type: 'object' as const, additionalProperties: false, properties: { context: { type: 'string' as const, required: true } } },
        render: (_args: unknown, value: { context: string }) => [{ type: 'text' as const, text: value.context }],
      } as const
      runtime.tools.register(defineTool({
        name: 'proactive_status',
        description: 'Inspect owner-scoped event opportunity decisions and operator utility estimates. Preparation may include a persisted model draft when explicitly configured. Drafts are unverified and do not mean the original goal was executed.',
        parameters: { goal_id: { type: 'string' } }, output,
        execute: async (args, execution) => { return { context: JSON.stringify(this.inspect(execution.agent, args.goal_id)) } },
      }))
      runtime.tools.register(defineTool({
        name: 'proactive_feedback',
        description: 'Record current authenticated owner feedback on an opportunity. Rejection starts a durable cooldown for subsequent decisions. Feedback grants no execution permission and does not undo an already dispatched goal.',
        parameters: { decision_id: { type: 'string', required: true }, feedback: { type: 'string', enum: ['accepted', 'rejected'], required: true } }, output,
        execute: async (args, execution) => { return { context: JSON.stringify(this.feedback(execution.agent, args.decision_id, args.feedback as 'accepted' | 'rejected')) } },
      }))
    })
  }
  assertProfile = (profileId: string): void => {
    if (!this.#active || !this.#profiles.has(profileId)) throw new Error('assistant-proactive: configured active opportunity profile required')
    if (this.#profiles.get(profileId)!.preparation && !this.#preparations.available()) throw new Error('assistant-proactive: preparation services unavailable')
    if (this.#profiles.get(profileId)!.mode === 'remind' && !this.#notificationPort()) throw new Error('assistant-proactive: reminder delivery service unavailable')
  }
  evaluate = (input: OpportunityInput) => {
    this.assertProfile(input.profileId)
    const evaluation = this.#engine.evaluate(input)
    const decision = evaluation.decision
    if (evaluation.disposition === 'consume' && decision.mode === 'remind' && decision.state === 'decided') {
      const delivery = this.#notificationPort()
      if (!delivery) throw new Error('assistant-proactive: reminder delivery service unavailable')
      const profile = this.#engine.profileSnapshot(decision.scope, decision.goalId, decision.profileId)
      const expiresAt = reminderExpiresAt(decision, profile)
      if (Date.now() < expiresAt) delivery.enqueueOwnerNotification({ sourceId: 'assistant-proactive/v1', ownerRouteId: decision.ownerRouteId, scope: decision.scope, sessionId: decision.sessionId, idempotencyKey: `proactive-reminder:${decision.id}`, text: reminderText(decision, profile), expiresAt })
    }
    if (evaluation.disposition === 'consume' && decision.mode === 'prepare' && decision.state === 'decided') {
      const profile = this.#engine.profileSnapshot(decision.scope, decision.goalId, decision.profileId)
      if (profile.preparation) {
        this.#preparations.store.enqueue(decision, profile.preparation, reminderExpiresAt(decision, profile))
        void this.#preparations.tick().catch(() => {})
      }
    }
    return evaluation
  }
  #notificationPort(): NotificationPort | undefined {
    const delivery = this.ctx.get('assistantDelivery') as unknown as Partial<NotificationPort> | undefined
    return typeof delivery?.enqueueOwnerNotification === 'function' ? delivery as NotificationPort : undefined
  }
  closeWait = (waitId: string, scope: OpportunityScope, reason: 'expired' | 'cancelled'): void => {
    if (!this.#active) throw new Error('assistant-proactive: disposed')
    this.#engine.closeWait(waitId, scope, reason)
    this.#preparations.store.cancelWait(waitId, scope)
  }
  #scope(agent: Agent | undefined, feedback: boolean): OpportunityScope {
    if (!this.#active) throw new Error('assistant-proactive: disposed')
    if (!agent || this.ctx.get('agents')?.get(agent.id) !== agent) throw new Error('assistant-proactive: exact live agent required')
    const delivery = this.ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
    const owner = delivery?.preferencePrincipalForAgent(agent)
    if (!owner || owner.scope.workspace !== agent.session.header.cwd || owner.scope.preset !== agent.session.header.agentPreset) throw new Error('assistant-proactive: authenticated owner required')
    const scope = { principalId: owner.principalId, ...owner.principalLineage, workspace: owner.scope.workspace, preset: owner.scope.preset }
    if (feedback) {
      const turn = delivery?.currentPreferenceTurn(agent)
      if (!turn || acceptanceDigest({ principalId: turn.principalId, ...turn.principalLineage, workspace: turn.scope.workspace, preset: turn.scope.preset }) !== acceptanceDigest(scope)) throw new Error('assistant-proactive: current authenticated owner turn required')
    }
    const policy = this.ctx.get('assistantPolicy') as AssistantPolicyService | undefined
    if (policy?.authorizeAgent(agent, feedback ? 'feedback' : 'inspect', { kind: 'goal', id: 'proactive-opportunities' }).effect !== 'allow') throw new Error('assistant-proactive: policy denied')
    return scope
  }
  inspect = (agent: Agent | undefined, goalId?: string) => {
    return this.#engine.list(this.#scope(agent, false), goalId).map(decision => {
      const preparation = this.#preparations.store.get(decision.id)
      return preparation ? { ...decision, preparation: { state: preparation.state, reason: preparation.reason, updatedAt: preparation.updatedAt,
        ...(preparation.result ? { output: preparation.result.output, sessionId: preparation.result.sessionId, usage: preparation.result.usage, diagnostic: preparation.result.diagnostic, verified: false } : {}) } } : decision
    })
  }
  reconcilePreparations = (): Promise<void> => this.#preparations.tick()
  feedback = (agent: Agent | undefined, id: string, feedback: 'accepted' | 'rejected') => { const decision = this.#engine.feedback(id, this.#scope(agent, true), feedback); if (feedback === 'rejected') this.#preparations.store.cancel(id); return decision }
}
export function apply(ctx: Context, config: Config = {}): void { new AssistantProactiveService(ctx, config) }
export default { name, Config, apply }
