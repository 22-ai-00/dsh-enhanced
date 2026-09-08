import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@dsh-enhanced/assistant-delivery'
import type {} from '@dsh-enhanced/assistant-policy'
import type {} from '@dsh-enhanced/credentials-keychain'
import type {} from '@dsh-enhanced/assistant-goals'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { Config, commitBytes, normalizeCommit, normalizeVerifiedDelivery, validateConfig } from './config.js'
import { VerifiedDeliveryRuntime, type DeliveryIntent, type DeliverySecurity, type VerifiedFiles } from './verified-delivery.js'
import { ActionLedger, normalizeWorkflow } from './ledger.js'
import { commitOnGitHub, createBranchOnGitHub, createPullRequestOnGitHub, inspectGitHub } from './github.js'
import type { ActionAuthority, ActionGrant, ActionIdentity, ActionRecord, ActionResult, BranchRequest, CommitRequest, InspectRequest, PullRequestRequest, VerifiedDeliveryRequest, WorkflowRequest } from './types.js'

export { Config }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const principalDigest = (value: string): string => createHash('sha256').update(value).digest('hex')
interface Authorization { identity(): ActionIdentity; authorize(record: ActionRecord): boolean; sessionId: string }
type Operation = (actionId: string, grant: ActionGrant, token: string, signal: AbortSignal) => Promise<ActionResult>
const workflowTransport = { branch: createBranchOnGitHub, pullRequest: createPullRequestOnGitHub, inspect: inspectGitHub }

declare module '@deepseek-ai/cordis' { interface Context { assistantActions: AssistantActionsService } }

/** Trusted Host control plane, never mounted or callable from the offline worker. */
export class AssistantActionsService extends Service {
  static Config = Config
  readonly #ledger: ActionLedger
  readonly #authority: ActionAuthority
  readonly #pending = new Map<string, { abort: AbortController; done: Promise<ActionResult> }>()
  #active = true
  #verified: VerifiedDeliveryRuntime | undefined

  constructor(ctx: Context, input: Config = {}, private readonly commit = commitOnGitHub, private readonly workflow = workflowTransport) {
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
      await this.#verified?.close()
      for (const operation of this.#pending.values()) operation.abort.abort()
      await Promise.allSettled([...this.#pending.values()].map(operation => operation.done))
      try { this.#ledger.releaseController(this.#authority) } finally { this.#ledger.close() }
    }, 'assistant-actions.controller')
    // Configured scopes keep their restricted execution route even after grants
    // expire or are revoked. Only trusted fixed brokers can use Host authority.
    ctx.inject(['tools'], runtime => runtime.on('tools/execute', async (execution, next) => {
      const header = execution.agent?.session.header
      if (header && config.grants.some(grant => grant.workspace === header.cwd && grant.agentPreset === header.agentPreset)
        && !['isolation_run', 'isolation_grants', 'goal_context', 'goal_checkpoint'].includes(execution.name)
        && !(['action_github_grants', 'action_github_deliver', 'action_github_delivery_status', 'action_github_commit', 'action_github_branch', 'action_github_pr', 'action_github_inspect', 'goal_create', 'goal_schedule', 'goal_strategy', 'goal_wait_event'].includes(execution.name) && this.ctx.get('assistantPolicy')?.isPreauthorizedTool(execution))) throw new Error('assistant-actions: this scope requires isolated execution or an authorized broker')
      return await next()
    }))
    ctx.inject(['tools', 'agents', 'assistantPolicy', 'assistantDelivery', 'credentialsKeychain'], runtime => {
      if (config.grants.length === 0) return
      const grants = () => config.grants.map(grant => this.#ledger.grant(grant.id)).filter(grant => grant !== undefined && grant.expiresAt > Date.now())
      const visibleGrants = (agent: Agent | undefined) => grants().flatMap(grant => {
        try {
          const identity = this.#identity(agent, grant!.id)
          if (!this.#allows(grant, identity, { grantId: grant!.id, operation: 'inspect', idempotencyKey: 'discovery', kind: 'repository' })) return []
          return [{ grantId: grant!.id, repository: grant!.repository, branch: grant!.branch, paths: grant!.paths,
            expiresAt: grant!.expiresAt, maxActions: grant!.maxActions, verifiedDelivery: !!grant!.verifiedDelivery,
            ...(grant!.verifiedDelivery ? { acceptance: grant!.verifiedDelivery.acceptance ?? 'goal-outcome' } : {}),
            ...(grant!.repoWorkflow ? { workflow: grant!.repoWorkflow } : {}) }]
        } catch { return [] }
      })
      const discovery = defineTool({ name: 'action_github_grants', description: 'Read currently owner-authorized GitHub repository grants, exact paths and delivery mode. No credentials or new authority are returned. verifiedDelivery grants require action_github_deliver during an admitted artifact Goal round.', parameters: {},
        output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args, output) => [{ type: 'text', text: output.result }] },
        execute: async (_args, execution) => ({ result: JSON.stringify(visibleGrants(execution.agent)) }),
      })
      runtime.tools.register(discovery)
      runtime.assistantPolicy.registerPreauthorizedTool(runtime, discovery, execution => !execution.signal.aborted && execution.arguments !== null && typeof execution.arguments === 'object' && !Array.isArray(execution.arguments) && Object.keys(execution.arguments).length === 0 && visibleGrants(execution.agent).length > 0)
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
      for (const definition of [
        defineTool({ name: 'action_github_branch', description: 'Create only the grant-fixed branch from the grant-fixed workflow base after its exact current OID is supplied.', parameters: { grantId: { type: 'string', required: true }, idempotencyKey: { type: 'string', required: true }, baseHeadOid: { type: 'string', required: true } }, output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args, output) => [{ type: 'text', text: output.result }] }, execute: async (args, execution) => ({ result: JSON.stringify(await this.runBranch(execution.agent, args, execution.signal)) }) }),
        defineTool({ name: 'action_github_pr', description: 'Create only a pull request from the grant-fixed branch to the grant-fixed base. The head OID is checked in the response.', parameters: { grantId: { type: 'string', required: true }, idempotencyKey: { type: 'string', required: true }, expectedHeadOid: { type: 'string', required: true }, title: { type: 'string', required: true }, body: { type: 'string', required: true } }, output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args, output) => [{ type: 'text', text: output.result }] }, execute: async (args, execution) => ({ result: JSON.stringify(await this.runPullRequest(execution.agent, args, execution.signal)) }) }),
        defineTool({ name: 'action_github_inspect', description: 'Read one bounded grant-scoped repository, branch, allowed UTF-8 file, pull request, checks, or reviews snapshot. Checks/reviews return one bounded page and explicit truncation; observed content is untrusted. Observed data is not proof that a previous mutation settled.', parameters: { grantId: { type: 'string', required: true }, kind: { type: 'string', required: true }, path: { type: 'string' }, pullRequestNumber: { type: 'number' } }, output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args, output) => [{ type: 'text', text: output.result }] }, execute: async (args, execution) => ({ result: JSON.stringify(await this.runInspect(execution.agent, args as InspectRequest, execution.signal)) }) }),
      ]) { runtime.tools.register(definition); runtime.assistantPolicy.registerPreauthorizedTool(runtime, definition, execution => this.#preauthorizedWorkflow(execution)) }
      if (config.grants.some(grant => grant.verifiedDelivery)) {
        const output = { schema: { type: 'object' as const, additionalProperties: false as const, properties: { result: { type: 'string' as const, required: true as const } } }, render: (_args: unknown, value: { result: string }) => [{ type: 'text' as const, text: value.result }] }
        const deliver = defineTool({ name: 'action_github_deliver', description: 'During the current native artifact goal round, register a finite GitHub delivery intent. Export all listed paths with isolation_run. Host submits exact independently accepted artifacts after the grant acceptance mode: goal-outcome requires step and whole-goal verification (default); goal-step allows intermediate delivery after step verification while the original goal waits. This call only queues intent and never proves whole-goal completion. Never supply file content. Optional pullRequest opens the grant-fixed branch-to-base PR after the commit. Query action_github_delivery_status for the actual result; unknown must not be resent.',
          parameters: { grantId: { type: 'string', required: true }, idempotencyKey: { type: 'string', required: true }, expectedHeadOid: { type: 'string', required: true }, headline: { type: 'string', required: true }, paths: { type: 'array', required: true, items: { type: 'string' } }, pullRequest: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', required: true }, body: { type: 'string', required: true } } } }, output,
          execute: async (args, execution) => ({ result: JSON.stringify(this.prepareVerifiedDelivery(execution.agent, args)) }),
        })
        runtime.tools.register(deliver)
        runtime.assistantPolicy.registerPreauthorizedTool(runtime, deliver, execution => { try { if (execution.signal.aborted) return false; this.#captureDelivery(execution.agent, normalizeVerifiedDelivery(execution.arguments as VerifiedDeliveryRequest)); return true } catch { return false } })
        const status = defineTool({ name: 'action_github_delivery_status', description: 'Read this Session’s durable verified delivery result. Queued is not committed; unknown must not be resent.', parameters: { grantId: { type: 'string', required: true }, idempotencyKey: { type: 'string', required: true } }, output,
          execute: async (args, execution) => { const identity = this.#identity(execution.agent, args.grantId); return { result: JSON.stringify(this.#verified!.get(String(execution.agent!.session.id), args.grantId, args.idempotencyKey, identity) ?? { status: 'not-found' }) } },
        })
        runtime.tools.register(status)
        runtime.assistantPolicy.registerPreauthorizedTool(runtime, status, execution => { try { const args = execution.arguments as { grantId: string }; return !execution.signal.aborted && !!this.#identity(execution.agent, args.grantId) } catch { return false } })
      }
    })
    if (config.grants.some(grant => grant.verifiedDelivery)) this.#verified = new VerifiedDeliveryRuntime(ctx, config.stateRoot, {
      capture: (agent, request) => this.#captureDelivery(agent, request), inspect: intent => this.#inspectDelivery(intent),
      deliver: (intent, snapshot, signal) => this.#deliverVerified(intent, snapshot, signal),
      notify: (intent, value) => this.#notifyVerifiedDelivery(intent, value),
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

  prepareVerifiedDelivery = (agent: Agent | undefined, input: VerifiedDeliveryRequest) => {
    if (!this.#verified) throw new Error('assistant-actions: verified delivery unavailable')
    return this.#verified.prepare(agent, normalizeVerifiedDelivery(input))
  }

  #captureDelivery(agent: Agent | undefined, request: VerifiedDeliveryRequest): DeliverySecurity {
    const identity = this.#identity(agent, request.grantId)
    const grant = this.#ledger.grant(request.grantId)
    if (!grant?.verifiedDelivery || grant.expiresAt <= Date.now() || digest(identity) !== digest({ principalDigest: grant.principalDigest, principalRecordId: grant.principalRecordId, principalVersion: grant.principalVersion, workspace: grant.workspace, agentPreset: grant.agentPreset })
      || !request.paths.every(path => grant.paths.includes(path)) || request.pullRequest && !grant.repoWorkflow?.allowPullRequest) throw new Error('assistant-actions: verified delivery is not granted')
    const delivery = this.ctx.get('assistantDelivery')!
    const owner = delivery.preferencePrincipalForAgent(agent!)!
    const goals = this.ctx.get('assistantGoals', false)
    const context = goals?.taskContext(agent)
    const current = context ? goals!.inspectWorkflowRunContext(agent, context.goal.id) : undefined
    if (!current) throw new Error('assistant-actions: admitted native goal round required')
    const routeReceipt = delivery.validateOwnerRoute({ authorityId: grant.verifiedDelivery.ownerRouteId, principalId: owner.principalId, workspace: identity.workspace, agentPreset: identity.agentPreset })
    if (routeReceipt.principalRecordId !== identity.principalRecordId || routeReceipt.principalVersion !== identity.principalVersion
      || routeReceipt.bindingVersion !== owner.bindingVersion || routeReceipt.generation !== owner.bindingGeneration) throw new Error('assistant-actions: current owner route mismatch')
    const security: DeliverySecurity = { principalId: owner.principalId, identity, sessionId: String(agent!.session.id),
      goalId: current.goalId, runId: current.goalExecutionRunId, definitionDigest: current.definition.digest, definitionVersion: current.definition.version,
      grantId: grant.id, grantRevision: grant.revision, ownerRouteId: grant.verifiedDelivery.ownerRouteId, budgetId: grant.verifiedDelivery.budgetId,
      expiresAt: grant.expiresAt, routeReceipt, ...(grant.verifiedDelivery.acceptance ? { acceptance: grant.verifiedDelivery.acceptance } : {}) }
    this.#deliveryIdentity(security)
    return security
  }

  #deliveryPolicy(security: DeliverySecurity) {
    return { subject: { kind: 'background' as const, id: 'dsh-enhanced-assistant-actions', workspace: security.identity.workspace, principal: security.principalId },
      action: 'execute' as const, resource: { kind: 'tool' as const, id: `action:github:${security.grantId}` }, context: { initiator: 'background' as const } }
  }
  #deliveryIdentity(security: DeliverySecurity): ActionIdentity {
    if (!this.#active || !this.#ledger.hasController(this.#authority)) throw new Error('assistant-actions: controller unavailable')
    const grant = this.#ledger.grant(security.grantId)
    if (!grant?.verifiedDelivery || grant.revision !== security.grantRevision || grant.expiresAt <= Date.now()
      || Date.now() >= security.expiresAt || (grant.verifiedDelivery.acceptance ?? 'goal-outcome') !== (security.acceptance ?? 'goal-outcome')) throw new Error('assistant-actions: delivery grant ended')
    const route = this.ctx.get('assistantDelivery')?.validateOwnerRoute({ authorityId: security.ownerRouteId, principalId: security.principalId,
      workspace: security.identity.workspace, agentPreset: security.identity.agentPreset })
    if (digest(route) !== digest(security.routeReceipt) || this.ctx.get('assistantPolicy')?.evaluate(this.#deliveryPolicy(security)).effect !== 'allow') throw new Error('assistant-actions: delivery authority changed')
    return security.identity
  }
  #inspectDelivery(intent: DeliveryIntent): VerifiedFiles | undefined {
    const security = intent.security
    this.#deliveryIdentity(security)
    const goals = this.ctx.get('assistantGoals', false)
    if (!goals) throw new Error('assistant-actions: Goals unavailable')
    const input = { ownerRouteId: security.ownerRouteId, principalId: security.principalId, workspace: security.identity.workspace,
      preset: security.identity.agentPreset, sessionId: security.sessionId, goalId: security.goalId }
    const evidence = goals.inspectOwnerGoalExecution(input)
    const intermediate = security.acceptance === 'goal-step'
    if (evidence.storedGoal.definition.digest !== security.definitionDigest || evidence.storedGoal.definition.version !== security.definitionVersion
      || !(intermediate ? ['active', 'paused', 'complete'] : ['active', 'complete']).includes(evidence.storedGoal.nativeAtLastObservation.phase)) throw new Error('assistant-actions: delivery goal changed')
    if (intermediate) {
      if (typeof goals.inspectOwnerAcceptedStepArtifacts !== 'function') throw new Error('assistant-actions: upgrade Goals for accepted step delivery')
      const run = evidence.executionRuns.find(item => item.intent.runId === security.runId)
      if (!run?.acceptance) throw new Error('assistant-actions: delivery step missing')
      if (run.execution !== undefined && (run.execution.status !== 'succeeded' || !run.execution.quiescent)) throw new Error('assistant-actions: delivery step execution invalid')
      const step = evidence.acceptedTasks.find(item => item.contractId === run.acceptance!.contractId)
      if (run.execution === undefined || step === undefined || step.state === 'unavailable' || step.state === 'pending' || step?.state === 'verifying' || step?.state === 'awaiting-execution') return undefined
      const snapshot = goals.inspectOwnerAcceptedStepArtifacts({ ...input, runId: security.runId, paths: intent.request.paths })
      this.#deliveryIdentity(security)
      return snapshot
    }
    if (evidence.outcome?.status !== 'achieved') {
      if (evidence.storedGoal.nativeAtLastObservation.phase === 'complete') throw new Error('assistant-actions: current acceptance missing')
      return undefined
    }
    const snapshot = goals.inspectOwnerVerifiedArtifacts({ ...input, runId: security.runId, paths: intent.request.paths })
    this.#deliveryIdentity(security)
    return snapshot
  }
  #notifyVerifiedDelivery(intent: DeliveryIntent, value: { idempotencyKey: string; text: string; outcome: unknown }): void {
    const security = intent.security
    this.#deliveryIdentity(security)
    const delivery = this.ctx.get('assistantDelivery') as { enqueueOwnerNotification?: (input: unknown) => unknown } | undefined
    if (typeof delivery?.enqueueOwnerNotification !== 'function') throw new Error('assistant-actions: owner notification delivery unavailable')
    delivery.enqueueOwnerNotification({ sourceId: 'assistant-actions-verified-delivery/v1', ownerRouteId: security.ownerRouteId,
      scope: { principalId: security.principalId, principalRecordId: security.identity.principalRecordId, principalVersion: security.identity.principalVersion,
        workspace: security.identity.workspace, preset: security.identity.agentPreset }, sessionId: security.sessionId,
      idempotencyKey: value.idempotencyKey, text: value.text, expiresAt: security.expiresAt })
  }
  async #deliverVerified(intent: DeliveryIntent, snapshot: VerifiedFiles, signal: AbortSignal) {
    const security = intent.security, frozen = digest(snapshot)
    const authorization: Authorization = { sessionId: security.sessionId,
      identity: () => {
        const current = this.#inspectDelivery(intent)
        if (!current || digest(current) !== frozen) throw new Error('assistant-actions: accepted artifacts changed')
        return this.#deliveryIdentity(security)
      },
      authorize: record => this.ctx.get('assistantPolicy')?.authorize(this.#deliveryPolicy(security), { idempotencyKey: `action:${record.id}` }).effect === 'allow',
    }
    const request = normalizeCommit({ grantId: security.grantId, idempotencyKey: `${intent.id}:commit`, expectedHeadOid: intent.request.expectedHeadOid,
      headline: intent.request.headline, files: snapshot.files.map(file => ({ path: file.path, content: file.content })) })
    const commit = await this.#runAuthorized(authorization, request, signal, async (actionId, grant, token, combined) => this.commit({ actionId, grant, request, token, signal: combined }))
    if (commit.status !== 'succeeded' || !intent.request.pullRequest) return { commit }
    if (!commit.commitOid) return { commit, pullRequest: { actionId: intent.id, status: 'unknown' as const, reason: 'commit-oid-unavailable' } }
    const pr = normalizeWorkflow({ grantId: security.grantId, idempotencyKey: `${intent.id}:pr`, expectedHeadOid: commit.commitOid, ...intent.request.pullRequest }) as PullRequestRequest
    const pullRequest = await this.#runAuthorized(authorization, pr, signal, async (actionId, grant, token, combined) => this.workflow.pullRequest({ actionId, grant, expectedHeadOid: pr.expectedHeadOid, title: pr.title, body: pr.body, token, signal: combined }))
    return { commit, pullRequest }
  }

  #preauthorized(execution: ToolExecution): boolean {
    try {
      if (execution.signal.aborted) return false
      const request = normalizeCommit(execution.arguments as CommitRequest)
      const identity = this.#identity(execution.agent, request.grantId)
      const grant = this.#ledger.grant(request.grantId)
      return !!grant && !grant.verifiedDelivery && grant.expiresAt > Date.now() && grant.principalDigest === identity.principalDigest
        && grant.principalRecordId === identity.principalRecordId && grant.principalVersion === identity.principalVersion
        && grant.workspace === identity.workspace && grant.agentPreset === identity.agentPreset
        && request.files.every(file => grant.paths.includes(file.path)) && commitBytes(request) <= grant.maxTotalBytes
    } catch { return false }
  }

  #allows(grant: ActionGrant | undefined, identity: ActionIdentity, request: WorkflowRequest): boolean {
    if (!grant || grant.expiresAt <= Date.now() || digest(identity) !== digest({ principalDigest: grant.principalDigest, principalRecordId: grant.principalRecordId, principalVersion: grant.principalVersion, workspace: grant.workspace, agentPreset: grant.agentPreset })) return false
    if ('files' in request) return request.files.every(file => grant.paths.includes(file.path)) && commitBytes(request) <= grant.maxTotalBytes
    if ('baseHeadOid' in request) return grant.repoWorkflow?.allowBranchCreate === true
    if ('title' in request) return grant.repoWorkflow?.allowPullRequest === true
    return (request.kind !== 'file' || grant.paths.includes(request.path!)) && (!['pull-request', 'checks', 'reviews'].includes(request.kind) || !!grant.repoWorkflow)
  }

  #preauthorizedWorkflow(execution: ToolExecution): boolean {
    try {
      if (execution.signal.aborted) return false
      const input = execution.arguments
      if (!input || typeof input !== 'object' || Array.isArray(input)) return false
      const request = normalizeWorkflow(execution.name === 'action_github_inspect' ? { ...input, operation: 'inspect', idempotencyKey: 'preauthorization' } : input)
      if (!('operation' in request) && this.#ledger.grant(request.grantId)?.verifiedDelivery) return false
      return this.#allows(this.#ledger.grant(request.grantId), this.#identity(execution.agent, request.grantId), request)
    } catch { return false }
  }

  run = async (agent: Agent | undefined, input: CommitRequest, signal: AbortSignal): Promise<ActionResult> => {
    const request = normalizeCommit(input)
    if (this.#ledger.grant(request.grantId)?.verifiedDelivery) throw new Error('assistant-actions: this grant requires independently verified delivery')
    return await this.#runWorkflow(agent, request, signal, async (actionId, grant, token, combined) => await this.commit({ actionId, grant, request, token, signal: combined }))
  }

  async #runWorkflow(agent: Agent | undefined, request: WorkflowRequest, signal: AbortSignal, operation: Operation): Promise<ActionResult> {
    return await this.#runAuthorized({ sessionId: String(agent?.session.id),
      identity: () => this.#identity(agent, request.grantId),
      authorize: record => this.ctx.get('assistantPolicy')?.authorizeAgent(agent, 'execute', { kind: 'tool', id: `action:github:${record.grantId}` }, { idempotencyKey: `action:${record.id}` }).effect === 'allow',
    }, request, signal, operation)
  }

  async #runAuthorized(authorization: Authorization, request: WorkflowRequest, signal: AbortSignal, operation: Operation): Promise<ActionResult> {
    signal.throwIfAborted()
    const identity = authorization.identity()
    if (!this.#allows(this.#ledger.grant(request.grantId), identity, request)) throw new Error('assistant-actions: request not granted')
    const bytes = 'files' in request ? commitBytes(request) : Buffer.byteLength(JSON.stringify(request))
    const { record, created } = this.#ledger.prepare({ identity, sessionId: authorization.sessionId, request, bytes, authority: this.#authority })
    if (!created) {
      const pending = this.#pending.get(record.id)
      const result = pending ? await pending.done : record.result ?? { actionId: record.id, status: 'unknown' as const, reason: 'action-in-progress-no-replay' }
      if (digest(authorization.identity()) !== digest(identity)) throw new Error('assistant-actions: owner changed')
      return structuredClone(result)
    }
    const abort = new AbortController()
    const done = this.#execute(authorization, identity, record, operation, AbortSignal.any([signal, abort.signal]))
    this.#pending.set(record.id, { abort, done })
    try {
      const result = await done
      if (digest(authorization.identity()) !== digest(identity)) throw new Error('assistant-actions: owner changed')
      return structuredClone(result)
    } finally { this.#pending.delete(record.id) }
  }

  async #execute(authorization: Authorization, identity: ActionIdentity, initial: ActionRecord, operation: Operation, signal: AbortSignal): Promise<ActionResult> {
    let record = initial
    const abort = new AbortController()
    const authorized = (): boolean => {
      try { return !signal.aborted && this.#ledger.usable(record.id) && digest(authorization.identity()) === digest(identity) } catch { return false }
    }
    const timer = setInterval(() => { if (!authorized()) abort.abort() }, 100); timer.unref()
    let result: ActionResult = { actionId: record.id, status: 'failed', reason: 'preparation-failed' }
    try {
      const grant = this.#ledger.grant(record.grantId)
      const credentials = this.ctx.get('credentialsKeychain')
      if (!grant || !credentials || !authorized()) throw new Error('unavailable')
      if (!authorization.authorize(record)) throw new Error('policy budget denied')
      result = await credentials.withSecret(this.ctx, { handleId: grant.credentialHandle, purpose: 'github.commit', idempotencyKey: `action:${record.id}`, ttlMs: Math.min(30_000, record.expiresAt - Date.now()) }, async (token, credentialSignal) => {
        const combined = AbortSignal.any([signal, abort.signal, credentialSignal, AbortSignal.timeout(Math.max(1, record.expiresAt - Date.now()))])
        combined.throwIfAborted()
        if (!authorized()) throw new Error('authorization ended')
        record = this.#ledger.dispatch(record.id, record.version, this.#authority)
        const outcome = await operation(record.id, grant, token, combined)
        return authorized() && !combined.aborted ? outcome : { actionId: record.id, status: 'unknown', reason: 'authorization-ended-after-dispatch' }
      })
    } catch {
      if (record.status === 'dispatched') result = { actionId: record.id, status: 'unknown', reason: 'dispatch-unconfirmed-no-replay' }
    } finally { clearInterval(timer) }
    this.#ledger.settle(record.id, record.version, result, this.#authority)
    return result
  }

  runBranch = async (agent: Agent | undefined, input: BranchRequest, signal: AbortSignal): Promise<ActionResult> => {
    const request = normalizeWorkflow(input)
    if (this.#ledger.grant(request.grantId)?.verifiedDelivery) throw new Error('assistant-actions: this grant requires independently verified delivery')
    if (!('baseHeadOid' in request)) throw new Error('assistant-actions: invalid branch request')
    return await this.#runWorkflow(agent, request, signal, async (actionId, grant, token, combined) => await this.workflow.branch({ actionId, grant, baseHeadOid: request.baseHeadOid, token, signal: combined }))
  }

  runPullRequest = async (agent: Agent | undefined, input: PullRequestRequest, signal: AbortSignal): Promise<ActionResult> => {
    const request = normalizeWorkflow(input)
    if (this.#ledger.grant(request.grantId)?.verifiedDelivery) throw new Error('assistant-actions: this grant requires independently verified delivery')
    if (!('title' in request)) throw new Error('assistant-actions: invalid pull request')
    return await this.#runWorkflow(agent, request, signal, async (actionId, grant, token, combined) => await this.workflow.pullRequest({ actionId, grant, expectedHeadOid: request.expectedHeadOid, title: request.title, body: request.body, token, signal: combined }))
  }

  runInspect = async (agent: Agent | undefined, input: InspectRequest, signal: AbortSignal): Promise<{ result: ActionResult; observed?: unknown }> => {
    // Each read is a distinct, durably charged action, never a synthetic write.
    const request = normalizeWorkflow({ ...input, operation: 'inspect', idempotencyKey: randomUUID() })
    if (!('operation' in request)) throw new Error('assistant-actions: invalid inspection')
    let observed: unknown
    const result = await this.#runWorkflow(agent, request, signal, async (actionId, grant, token, combined) => {
      const reply = await this.workflow.inspect({ grant, kind: request.kind, ...(request.path === undefined ? {} : { path: request.path }), ...(request.pullRequestNumber === undefined ? {} : { pullRequestNumber: request.pullRequestNumber }), token, signal: combined })
      observed = reply?.observed
      return reply ? { actionId, status: 'succeeded' } : { actionId, status: 'failed', reason: 'github-inspect-failed' }
    })
    // A late response after revocation must not release repository content.
    return { result, ...(result.status === 'succeeded' ? { observed } : {}) }
  }
}
