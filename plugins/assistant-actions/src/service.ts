import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@dsh-enhanced/assistant-delivery'
import type {} from '@dsh-enhanced/assistant-policy'
import type {} from '@dsh-enhanced/credentials-keychain'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { Config, commitBytes, normalizeCommit, validateConfig } from './config.js'
import { ActionLedger } from './ledger.js'
import { commitOnGitHub } from './github.js'
import type { ActionAuthority, ActionIdentity, ActionRecord, ActionResult, CommitRequest } from './types.js'

export { Config }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const principalDigest = (value: string): string => createHash('sha256').update(value).digest('hex')
declare module '@deepseek-ai/cordis' { interface Context { assistantActions: AssistantActionsService } }

/** Trusted Host control plane, never mounted or callable from the offline worker. */
export class AssistantActionsService extends Service {
  static Config = Config
  readonly #ledger: ActionLedger
  readonly #authority: ActionAuthority
  readonly #pending = new Map<string, { abort: AbortController; done: Promise<ActionResult> }>()
  #active = true

  constructor(ctx: Context, input: Config = {}, private readonly commit = commitOnGitHub) {
    super(ctx, 'assistantActions')
    const config = validateConfig(input)
    mkdirSync(config.stateRoot, { recursive: true, mode: 0o700 })
    const root = lstatSync(config.stateRoot)
    if (!root.isDirectory() || root.uid !== process.getuid?.() || realpathSync(config.stateRoot) !== config.stateRoot) throw new Error('assistant-actions: private owned state root required')
    chmodSync(config.stateRoot, 0o700)
    this.#ledger = new ActionLedger(join(config.stateRoot, 'ledger.sqlite'))
    try {
      this.#authority = this.#ledger.claimController(randomUUID(), 30_000)
      this.#ledger.syncGrants(config.grants, this.#authority)
      this.#ledger.recover(this.#authority)
    } catch (error) { this.#ledger.close(); throw error }
    const timer = setInterval(() => {
      try { if (this.#active && this.#ledger.renewController(this.#authority, 30_000)) return } catch { /* Stop when the fence is lost. */ }
      this.#active = false
      for (const operation of this.#pending.values()) operation.abort.abort()
    }, 5000)
    timer.unref()
    ctx.effect(() => async () => {
      this.#active = false; clearInterval(timer)
      for (const operation of this.#pending.values()) operation.abort.abort()
      await Promise.allSettled([...this.#pending.values()].map(operation => operation.done))
      try { this.#ledger.releaseController(this.#authority) } finally { this.#ledger.close() }
    }, 'assistant-actions.controller')
    // Configured scopes keep their restricted execution route even after grants
    // expire or are revoked. Only trusted fixed brokers can use Host authority.
    ctx.inject(['tools'], runtime => runtime.on('tools/execute', async (execution, next) => {
      const header = execution.agent?.session.header
      if (header && config.grants.some(grant => grant.workspace === header.cwd && grant.agentPreset === header.agentPreset)
        && !['isolation_run', 'goal_context', 'goal_checkpoint'].includes(execution.name)
        && !(execution.name === 'action_github_commit' && this.ctx.get('assistantPolicy')?.isPreauthorizedTool(execution))) throw new Error('assistant-actions: this scope requires isolated execution or an authorized broker')
      return await next()
    }))
    ctx.inject(['tools', 'agents', 'assistantPolicy', 'assistantDelivery', 'credentialsKeychain'], runtime => {
      const tool = defineTool({
        name: 'action_github_commit',
        description: 'Submit bounded file contents to an exact operator-authorized GitHub repository and branch. Requires an existing finite grant and expectedHeadOid. Reuse a key only for the identical request; unknown results must be investigated and never resent under a new key. This tool cannot authorize itself. Commit creation does not verify the user goal.',
        parameters: { grantId: { type: 'string', required: true }, idempotencyKey: { type: 'string', required: true }, expectedHeadOid: { type: 'string', required: true }, headline: { type: 'string', required: true },
          files: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, content: { type: 'string', required: true } } } } },
        output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args, output) => [{ type: 'text', text: output.result }] },
        execute: async (args, execution) => ({ result: JSON.stringify(await this.run(execution.agent, args, execution.signal)) }),
      })
      runtime.tools.register(tool)
      runtime.assistantPolicy.registerPreauthorizedTool(runtime, tool, execution => this.#preauthorized(execution))
    })
  }

  #identity(agent: Agent | undefined, grantId: string): ActionIdentity {
    if (!this.#active || !this.#ledger.hasController(this.#authority)) throw new Error('assistant-actions: controller unavailable')
    if (!agent || this.ctx.get('agents')?.get(agent.id) !== agent) throw new Error('assistant-actions: exact live agent required')
    const owner = this.ctx.get('assistantDelivery')?.preferencePrincipalForAgent(agent)
    if (!owner || owner.scope.workspace !== agent.session.header.cwd || owner.scope.preset !== agent.session.header.agentPreset) throw new Error('assistant-actions: authenticated owner required')
    if (this.ctx.get('assistantPolicy')?.evaluateAgent(agent, 'execute', { kind: 'tool', id: `action:github:${grantId}` }).effect !== 'allow') throw new Error('assistant-actions: policy denied')
    return { principalDigest: principalDigest(owner.principalId), ...owner.principalLineage, workspace: owner.scope.workspace, agentPreset: owner.scope.preset }
  }

  #preauthorized(execution: ToolExecution): boolean {
    try {
      if (execution.signal.aborted) return false
      const request = normalizeCommit(execution.arguments as CommitRequest)
      const identity = this.#identity(execution.agent, request.grantId)
      const grant = this.#ledger.grant(request.grantId)
      return !!grant && grant.expiresAt > Date.now() && grant.principalDigest === identity.principalDigest
        && grant.principalRecordId === identity.principalRecordId && grant.principalVersion === identity.principalVersion
        && grant.workspace === identity.workspace && grant.agentPreset === identity.agentPreset
        && request.files.every(file => grant.paths.includes(file.path)) && commitBytes(request) <= grant.maxTotalBytes
    } catch { return false }
  }

  run = async (agent: Agent | undefined, input: CommitRequest, signal: AbortSignal): Promise<ActionResult> => {
    signal.throwIfAborted()
    const request = normalizeCommit(input)
    const identity = this.#identity(agent, request.grantId)
    const { record, created } = this.#ledger.prepare({ identity, sessionId: String(agent!.session.id), request, bytes: commitBytes(request), authority: this.#authority })
    if (!created) {
      const pending = this.#pending.get(record.id)
      const result = pending ? await pending.done : record.result ?? { actionId: record.id, status: 'unknown' as const, reason: 'action-in-progress-no-replay' }
      if (digest(this.#identity(agent, request.grantId)) !== digest(identity)) throw new Error('assistant-actions: owner changed')
      return structuredClone(result)
    }
    const abort = new AbortController()
    const done = this.#execute(agent!, identity, record, request, AbortSignal.any([signal, abort.signal]))
    this.#pending.set(record.id, { abort, done })
    try {
      const result = await done
      if (digest(this.#identity(agent, request.grantId)) !== digest(identity)) throw new Error('assistant-actions: owner changed')
      return structuredClone(result)
    } finally { this.#pending.delete(record.id) }
  }

  async #execute(agent: Agent, identity: ActionIdentity, initial: ActionRecord, request: CommitRequest, signal: AbortSignal): Promise<ActionResult> {
    let record = initial
    const abort = new AbortController()
    const authorized = (): boolean => {
      try { return !signal.aborted && this.#ledger.usable(record.id) && digest(this.#identity(agent, record.grantId)) === digest(identity) } catch { return false }
    }
    const timer = setInterval(() => { if (!authorized()) abort.abort() }, 100); timer.unref()
    let result: ActionResult = { actionId: record.id, status: 'failed', reason: 'preparation-failed' }
    try {
      const grant = this.#ledger.grant(record.grantId)
      const credentials = this.ctx.get('credentialsKeychain')
      if (!grant || !credentials || !authorized()) throw new Error('unavailable')
      if (this.ctx.get('assistantPolicy')?.authorizeAgent(agent, 'execute', { kind: 'tool', id: `action:github:${record.grantId}` }, { idempotencyKey: `action:${record.id}` }).effect !== 'allow') throw new Error('policy budget denied')
      result = await credentials.withSecret(this.ctx, { handleId: grant.credentialHandle, purpose: 'github.commit', idempotencyKey: `action:${record.id}`, ttlMs: Math.min(30_000, record.expiresAt - Date.now()) }, async (token, credentialSignal) => {
        const combined = AbortSignal.any([signal, abort.signal, credentialSignal, AbortSignal.timeout(Math.max(1, record.expiresAt - Date.now()))])
        combined.throwIfAborted()
        if (!authorized()) throw new Error('authorization ended')
        record = this.#ledger.dispatch(record.id, record.version, this.#authority)
        const outcome = await this.commit({ actionId: record.id, grant, request, token, signal: combined })
        return authorized() && !combined.aborted ? outcome : { actionId: record.id, status: 'unknown', reason: 'authorization-ended-after-dispatch' }
      })
    } catch {
      if (record.status === 'dispatched') result = { actionId: record.id, status: 'unknown', reason: 'dispatch-unconfirmed-no-replay' }
    } finally { clearInterval(timer) }
    this.#ledger.settle(record.id, record.version, result, this.#authority)
    return result
  }
}
