import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@dsh-enhanced/assistant-delivery'
import type {} from '@dsh-enhanced/assistant-policy'
import type {} from '@dsh-enhanced/credentials-keychain'
import type { GoalExecutionRun } from '@dsh-enhanced/assistant-goals'
import type { RepositoryReadbackAuthority } from '@dsh-enhanced/assistant-verifier'
import { validateTaskAcceptanceContract, validateTaskVerificationReceipt, type TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { Config, commitBytes, normalizeCommit, normalizeCompensation, normalizeVerifiedDelivery, validateConfig } from './config.js'
import { VerifiedDeliveryRuntime, type DeliveryIntent, type DeliveryOutcome, type DeliverySecurity, type VerifiedFiles } from './verified-delivery.js'
import { normalizeRepositoryReadback, validateRepositoryReadbackRequirements, type RepositoryReadback, type RepositoryReadbackRequirements } from './repository-readback.js'
import { ActionLedger, normalizeWorkflow } from './ledger.js'
import { commitOnGitHub, createBranchOnGitHub, createCompensatingCommitOnGitHub, createPullRequestOnGitHub, inspectGitHub, readGitHubPreimage } from './github.js'
import type { ActionAuthority, ActionGrant, ActionIdentity, ActionRecord, ActionResult, BranchRequest, CommitRequest, CompensationRecord, CompensationRequest, CompensationResult, InspectRequest, PullRequestRequest, VerifiedDeliveryRequest, WorkflowRequest } from './types.js'

export { Config }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const principalDigest = (value: string): string => createHash('sha256').update(value).digest('hex')
interface Authorization { identity(): ActionIdentity; authorize(record: ActionRecord): boolean; sessionId: string }
type Operation = (actionId: string, grant: ActionGrant, token: string, signal: AbortSignal) => Promise<ActionResult>
type CompensationStatus = Readonly<{ actionId: string; status: CompensationRecord['status']; repository: string; branch: string; parentOid: string; resultOid?: string; reason?: string }>
interface RepositoryReadbackContext {
  authority: { grantId: string; grantRevision: number; repository: string; branch: string; baseBranch: string; timeoutMs: number; freshnessMs: number }
  evidenceDigest: string; requirements: RepositoryReadbackRequirements; security: DeliverySecurity; intent: DeliveryIntent; commitOid: string; pullRequestNumber: number
}
const workflowTransport = { branch: createBranchOnGitHub, pullRequest: createPullRequestOnGitHub, inspect: inspectGitHub }
const compensationTransport = { capture: readGitHubPreimage, commit: createCompensatingCommitOnGitHub }
const ROLLBACK_BUDGET_METRIC = 'github-compensations'

declare module '@deepseek-ai/cordis' { interface Context { assistantActions: AssistantActionsService } }

/** Trusted Host control plane, never mounted or callable from the offline worker. */
export class AssistantActionsService extends Service {
  static Config = Config
  readonly #ledger: ActionLedger
  readonly #authority: ActionAuthority
  readonly #pending = new Map<string, { abort: AbortController; done: Promise<ActionResult> }>()
  readonly #pendingCompensations = new Map<string, { abort: AbortController; done: Promise<CompensationResult> }>()
  #active = true
  #verified: VerifiedDeliveryRuntime | undefined

  constructor(ctx: Context, input: Config = {}, private readonly commit = commitOnGitHub, private readonly workflow = workflowTransport, private readonly compensation = compensationTransport) {
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
      this.#ledger.recoverCompensations(this.#authority)
    } catch (error) { this.#ledger.close(); throw error }
    const timer = setInterval(() => {
      try { if (this.#active && this.#ledger.renewController(this.#authority, 30_000)) return } catch { /* Stop when the fence is lost. */ }
      this.#active = false
      for (const operation of this.#pending.values()) operation.abort.abort()
      for (const operation of this.#pendingCompensations.values()) operation.abort.abort()
    }, 5000)
    timer.unref()
    ctx.effect(() => async () => {
      this.#active = false; clearInterval(timer)
      await this.#verified?.close()
      for (const operation of this.#pending.values()) operation.abort.abort()
      for (const operation of this.#pendingCompensations.values()) operation.abort.abort()
      await Promise.allSettled([...this.#pending.values()].map(operation => operation.done))
      await Promise.allSettled([...this.#pendingCompensations.values()].map(operation => operation.done))
      try { this.#ledger.releaseController(this.#authority) } finally { this.#ledger.close() }
    }, 'assistant-actions.controller')
    // Configured scopes keep their restricted execution route even after grants
    // expire or are revoked. Only trusted fixed brokers can use Host authority.
    ctx.inject(['tools'], runtime => runtime.on('tools/execute', async (execution, next) => {
      const header = execution.agent?.session.header
      if (header && config.grants.some(grant => grant.workspace === header.cwd && grant.agentPreset === header.agentPreset)
        && !['isolation_run', 'isolation_grants', 'goal_context', 'goal_checkpoint'].includes(execution.name)
        && !(['action_github_grants', 'action_github_deliver', 'action_github_delivery_status', 'action_github_commit', 'action_github_branch', 'action_github_pr', 'action_github_inspect', 'action_github_compensate', 'action_github_compensation_status', 'goal_create', 'goal_schedule', 'goal_strategy', 'goal_wait_event'].includes(execution.name) && this.ctx.get('assistantPolicy')?.isPreauthorizedTool(execution))) throw new Error('assistant-actions: this scope requires isolated execution or an authorized broker')
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
        execute: async (args, execution) => {
          const request = normalizeCommit(args as CommitRequest)
          const result = await this.run(execution.agent, request, execution.signal)
          return { result: JSON.stringify(this.#forwardResult(request, result)) }
        },
      })
      runtime.tools.register(tool)
      runtime.assistantPolicy.registerPreauthorizedTool(runtime, tool, execution => this.#preauthorized(execution))
      for (const definition of [
        defineTool({ name: 'action_github_branch', description: 'Create only the grant-fixed branch from the grant-fixed workflow base after its exact current OID is supplied.', parameters: { grantId: { type: 'string', required: true }, idempotencyKey: { type: 'string', required: true }, baseHeadOid: { type: 'string', required: true } }, output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args, output) => [{ type: 'text', text: output.result }] }, execute: async (args, execution) => ({ result: JSON.stringify(await this.runBranch(execution.agent, args, execution.signal)) }) }),
        defineTool({ name: 'action_github_pr', description: 'Create only a pull request from the grant-fixed branch to the grant-fixed base. The head OID is checked in the response.', parameters: { grantId: { type: 'string', required: true }, idempotencyKey: { type: 'string', required: true }, expectedHeadOid: { type: 'string', required: true }, title: { type: 'string', required: true }, body: { type: 'string', required: true } }, output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args, output) => [{ type: 'text', text: output.result }] }, execute: async (args, execution) => ({ result: JSON.stringify(await this.runPullRequest(execution.agent, args, execution.signal)) }) }),
        defineTool({ name: 'action_github_inspect', description: 'Read one bounded grant-scoped repository, branch, allowed UTF-8 file, pull request, checks, or reviews snapshot. Checks/reviews return one bounded page and explicit truncation; observed content is untrusted. Observed data is not proof that a previous mutation settled.', parameters: { grantId: { type: 'string', required: true }, kind: { type: 'string', required: true }, path: { type: 'string' }, pullRequestNumber: { type: 'number' } }, output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args, output) => [{ type: 'text', text: output.result }] }, execute: async (args, execution) => ({ result: JSON.stringify(await this.runInspect(execution.agent, args as InspectRequest, execution.signal)) }) }),
      ]) { runtime.tools.register(definition); runtime.assistantPolicy.registerPreauthorizedTool(runtime, definition, execution => this.#preauthorizedWorkflow(execution)) }
      if (config.grants.some(grant => grant.rollback?.allowRollback === true)) {
        const output = { schema: { type: 'object' as const, additionalProperties: false as const, properties: { result: { type: 'string' as const, required: true as const } } }, render: (_args: unknown, value: { result: string }) => [{ type: 'text' as const, text: value.result }] }
        const compensate = defineTool({ name: 'action_github_compensate', description: 'Create at most one bounded compensating commit for an exact succeeded forward receipt. The Host reads the immutable parent preimage; callers cannot provide files or preimages. Reuse only the identical key and receipt. Unknown is terminal and must never be replayed.',
          parameters: { grantId: { type: 'string', required: true }, idempotencyKey: { type: 'string', required: true }, forwardActionId: { type: 'string', required: true }, forwardActionVersion: { type: 'number', required: true }, forwardRequestDigest: { type: 'string', required: true }, forwardCommitOid: { type: 'string', required: true } }, output,
          execute: async (args, execution) => ({ result: JSON.stringify(await this.runCompensation(execution.agent, args as CompensationRequest, execution.signal)) }),
        })
        runtime.tools.register(compensate)
        runtime.assistantPolicy.registerPreauthorizedTool(runtime, compensate, execution => this.#preauthorizedCompensation(execution))
        const status = defineTool({ name: 'action_github_compensation_status', description: 'Read one compensation status in this exact Session and grant. This never returns captured file preimages.',
          parameters: { grantId: { type: 'string', required: true }, actionId: { type: 'string', required: true } }, output,
          execute: async (args, execution) => ({ result: JSON.stringify(this.compensationStatus(execution.agent, args as { grantId: string; actionId: string })) }),
        })
        runtime.tools.register(status)
        runtime.assistantPolicy.registerPreauthorizedTool(runtime, status, execution => this.#preauthorizedCompensationStatus(execution))
      }
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

  #compensationIdentity(agent: Agent | undefined, grantId: string): ActionIdentity {
    if (!this.#active || !this.#ledger.hasController(this.#authority)) throw new Error('assistant-actions: controller unavailable')
    if (!agent || this.ctx.get('agents')?.get(agent.id) !== agent) throw new Error('assistant-actions: exact live agent required')
    const owner = this.ctx.get('assistantDelivery')?.preferencePrincipalForAgent(agent)
    if (!owner || owner.scope.workspace !== agent.session.header.cwd || owner.scope.preset !== agent.session.header.agentPreset) throw new Error('assistant-actions: authenticated owner required')
    const grant = this.#ledger.grant(grantId)
    const rollback = grant?.rollback
    const policy = this.ctx.get('assistantPolicy')
    if (!grant || !rollback?.allowRollback || grant.expiresAt <= Date.now()
      || policy?.getBudgetConfig(rollback.budgetId)?.metric !== ROLLBACK_BUDGET_METRIC
      || policy.evaluateAgent(agent, 'compensate', { kind: 'tool', id: `action:github-rollback:${grantId}` }).effect !== 'allow') throw new Error('assistant-actions: compensation denied')
    return { principalDigest: principalDigest(owner.principalId), ...owner.principalLineage, workspace: owner.scope.workspace, agentPreset: owner.scope.preset }
  }

  #authorizeCompensation(agent: Agent | undefined, record: CompensationRecord): boolean {
    try {
      const grant = this.#ledger.grant(record.grantId)
      const rollback = grant?.rollback
      const policy = this.ctx.get('assistantPolicy')
      if (!rollback?.allowRollback || policy?.getBudgetConfig(rollback.budgetId)?.metric !== ROLLBACK_BUDGET_METRIC) return false
      const decision = policy.authorizeAgent(agent, 'compensate', { kind: 'tool', id: `action:github-rollback:${record.grantId}` }, { idempotencyKey: `compensation:${record.id}` })
      return decision.effect === 'allow' && decision.budget?.id === rollback.budgetId
    } catch { return false }
  }

  #forwardResult(request: CommitRequest, result: ActionResult): ActionResult | (ActionResult & { forwardReceipt: { actionId: string; version: number; requestDigest: string; commitOid: string } }) {
    if (result.status !== 'succeeded' || !result.commitOid) return result
    const record = this.#ledger.get(result.actionId)
    const grant = this.#ledger.grant(request.grantId)
    if (!grant?.rollback?.allowRollback || !record || record.kind !== 'commit' || record.status !== 'succeeded'
      || record.grantId !== request.grantId || record.result?.commitOid !== result.commitOid || digest(record.result) !== digest(result)) return result
    return { ...result, forwardReceipt: { actionId: record.id, version: record.version, requestDigest: record.requestDigest, commitOid: result.commitOid } }
  }

  prepareVerifiedDelivery = (agent: Agent | undefined, input: VerifiedDeliveryRequest) => {
    if (!this.#verified) throw new Error('assistant-actions: verified delivery unavailable')
    return this.#verified.prepare(agent, normalizeVerifiedDelivery(input))
  }

  /** Stable only while this fenced broker remains active; used by Verifier around an untrusted remote read. */
  repositoryReadbackGeneration = (): string => this.#active && this.#ledger.hasController(this.#authority) ? digest(this.#authority) : ''

  readRepositoryGoalOutcome = async (input: { contractId: string; authorityId: string; authorityDigest: string }, signal: AbortSignal): Promise<RepositoryReadback & { ready: boolean }> => {
    signal.throwIfAborted()
    const verifier = this.ctx.get('assistantVerifier', false)
    if (!verifier) throw new Error('assistant-actions: repository readback authority unavailable')
    const binding = verifier.inspectRepositoryReadbackAuthority(input.contractId, input.authorityId, input.authorityDigest)
    const bindingDigest = digest(binding)
    const context = () => {
      const currentVerifier = this.ctx.get('assistantVerifier', false)
      if (!currentVerifier) throw new Error('assistant-actions: repository readback authority unavailable')
      const current = currentVerifier.inspectRepositoryReadbackAuthority(input.contractId, input.authorityId, input.authorityDigest)
      if (digest(current) !== bindingDigest) throw new Error('assistant-actions: repository readback authority changed')
      return this.#repositoryReadbackContext(current.contract, current.authority)
    }
    const initial = context()
    if (!Number.isSafeInteger(initial.authority.timeoutMs) || initial.authority.timeoutMs <= 0 || !Number.isSafeInteger(initial.authority.freshnessMs) || initial.authority.freshnessMs <= 0) throw new Error('assistant-actions: repository readback bounds invalid')
    const observedAt = Date.now()
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(initial.authority.timeoutMs)])
    const pullRequestNumber = initial.pullRequestNumber
    const [checks, reviews, pullRequest, branchSnapshot] = [
      await this.#readRepositoryInspection(context, 'checks', pullRequestNumber, deadline),
      await this.#readRepositoryInspection(context, 'reviews', pullRequestNumber, deadline),
      await this.#readRepositoryInspection(context, 'pull-request', pullRequestNumber, deadline),
      await this.#readRepositoryInspection(context, 'branch', undefined, deadline),
    ]
    const final = context()
    if (digest(initial) !== digest(final) || Date.now() - observedAt > final.authority.freshnessMs) throw new Error('assistant-actions: repository readback authority changed')
    const normalized = normalizeRepositoryReadback({ repository: final.authority.repository, branch: final.authority.branch, baseBranch: final.authority.baseBranch,
      commitOid: final.commitOid, pullRequestNumber: final.pullRequestNumber, requirements: final.requirements, checks, reviews, pullRequest, branchSnapshot })
    const headConfirmed = normalized.headOid === final.commitOid
    const ci = !headConfirmed ? 'unknown' : normalized.ci
    const review = !headConfirmed ? 'unknown' : normalized.review
    return Object.freeze({ objectId: normalized.objectId, headOid: normalized.headOid, ci, review, pullRequest: normalized.pullRequest,
      ready: ci === 'passed' && review === 'approved' && (normalized.pullRequest === 'open' || normalized.pullRequest === 'merged') })
  }

  #repositoryReadbackContext(contract: TaskAcceptanceContract, authority: RepositoryReadbackAuthority): RepositoryReadbackContext {
    if (!this.#active || !this.#verified || contract.expiresAt <= Date.now() || contract.task.kind !== 'goal-outcome' || authority.kind !== 'repository-readback') throw new Error('assistant-actions: repository readback binding invalid')
    const goal = contract.task.goal
    const latest = this.#verified.latestForGoal({ id: goal.id, sessionId: goal.sessionId, nativeGoalId: goal.nativeGoalId, definitionVersion: goal.definitionVersion, definitionDigest: goal.definitionDigest }, authority.grantId, contract.owner, contract.scope)
    if (!latest || latest.state !== 'succeeded' || latest.intent.security.acceptance !== 'goal-step' || !latest.outcome) throw new Error('assistant-actions: repository delivery not settled')
    const security = latest.intent.security
    if (security.goalId !== goal.id || security.nativeGoalId === undefined || security.nativeGoalId !== goal.nativeGoalId || security.sessionId !== goal.sessionId || security.definitionVersion !== goal.definitionVersion || security.definitionDigest !== goal.definitionDigest
      || security.grantId !== authority.grantId || security.grantRevision !== authority.grantRevision || security.identity.principalRecordId !== contract.owner.principalRecordId || security.identity.principalVersion !== contract.owner.principalVersion
      || security.identity.workspace !== contract.scope.workspace || security.identity.agentPreset !== contract.scope.preset) throw new Error('assistant-actions: repository delivery binding changed')
    const grant = this.#ledger.grant(authority.grantId)
    if (!grant || grant.revision !== authority.grantRevision || grant.repository !== authority.repository || grant.branch !== authority.branch || grant.repoWorkflow?.baseBranch !== authority.baseBranch) throw new Error('assistant-actions: repository grant changed')
    const outcome = latest.outcome as DeliveryOutcome
    const commitOid = outcome.commit.commitOid, pullRequestOutcome = outcome.pullRequest, pullRequestNumber = pullRequestOutcome?.pullRequestNumber
    const commit = this.#ledger.get(outcome.commit.actionId)
    const pullRequest = pullRequestOutcome && this.#ledger.get(pullRequestOutcome.actionId)
    if (outcome.commit.status !== 'succeeded' || !commitOid || !commit || commit.kind !== 'commit' || commit.status !== 'succeeded' || digest(commit.result) !== digest(outcome.commit)
      || commit.grantId !== grant.id || commit.grantRevision !== grant.revision || commit.sessionId !== security.sessionId || digest(commit.identity) !== digest(security.identity)
      || !pullRequestOutcome || pullRequestOutcome.status !== 'succeeded' || !pullRequestNumber || !pullRequest || pullRequest.kind !== 'pull-request' || pullRequest.status !== 'succeeded' || digest(pullRequest.result) !== digest(pullRequestOutcome)
      || pullRequest.grantId !== grant.id || pullRequest.grantRevision !== grant.revision || pullRequest.sessionId !== security.sessionId || digest(pullRequest.identity) !== digest(security.identity)) throw new Error('assistant-actions: repository delivery receipt invalid')
    this.#deliveryIdentity(security)
    type OwnerEvidence = { storedGoal?: { definition?: { version?: number; digest?: string }; nativeAtLastObservation?: { phase?: string; sessionId?: string; goalId?: string } }; acceptedTasks?: readonly { contractId: string; state: string; contract: unknown; receipt: unknown }[]; executionRuns?: readonly GoalExecutionRun[]; outcomeAssessments?: readonly { contract: TaskAcceptanceContract; triggerRunId: string | null; execution: { status: 'succeeded' | 'unknown'; quiescent: boolean } | null }[] }
    const goals = this.ctx.get('assistantGoals', false) as { inspectOwnerGoalExecution?: (input: { ownerRouteId: string; principalId: string; workspace: string; preset: string; sessionId: string; goalId: string }) => OwnerEvidence } | undefined
    const evidence = goals?.inspectOwnerGoalExecution?.({ ownerRouteId: security.ownerRouteId, principalId: security.principalId, workspace: security.identity.workspace, preset: security.identity.agentPreset, sessionId: security.sessionId, goalId: security.goalId })
    const phase = evidence?.storedGoal?.nativeAtLastObservation?.phase
    if (!evidence || phase === undefined || !['active', 'paused', 'complete', 'blocked'].includes(phase) || evidence.storedGoal?.definition?.version !== goal.definitionVersion || evidence.storedGoal?.definition?.digest !== goal.definitionDigest
      || evidence.storedGoal?.nativeAtLastObservation?.sessionId !== goal.sessionId || evidence.storedGoal?.nativeAtLastObservation?.goalId !== goal.nativeGoalId) throw new Error('assistant-actions: repository goal changed')
    const assessment = evidence.outcomeAssessments?.find(item => item.contract.id === contract.id && item.contract.digest === contract.digest)
    const source = evidence.executionRuns?.find(run => run.intent.runId === security.runId)
    const assessmentRun = assessment?.triggerRunId === null || assessment?.triggerRunId === undefined ? undefined : evidence.executionRuns?.find(run => run.intent.runId === assessment.triggerRunId)
    const exactRun = (run: GoalExecutionRun | undefined) => run !== undefined && run.intent.scope.workspace === contract.scope.workspace && run.intent.scope.preset === contract.scope.preset
      && run.intent.scope.principalId === security.principalId && run.dispatchedAt !== undefined && run.intent.scope.principalRecordId === contract.owner.principalRecordId && run.intent.scope.principalVersion === contract.owner.principalVersion
      && run.intent.task.goal.id === goal.id && run.intent.task.goal.definitionVersion === goal.definitionVersion && run.intent.task.goal.definitionDigest === goal.definitionDigest
      && run.intent.task.goal.sessionId === goal.sessionId && run.intent.task.goal.nativeGoalId === goal.nativeGoalId && run.execution?.status === 'succeeded' && run.execution.quiescent
    if (!assessment || !source || !assessmentRun || assessment.execution?.status !== 'succeeded' || !assessment.execution.quiescent || !exactRun(source) || !exactRun(assessmentRun)) throw new Error('assistant-actions: repository goal execution changed')
    if (source.intent.admission.round > assessmentRun.intent.admission.round) throw new Error('assistant-actions: repository goal execution changed')
    const acceptedSource = evidence.acceptedTasks?.find(value => value.contractId === source.acceptance?.contractId && value.state === 'done')
    if (!acceptedSource) throw new Error('assistant-actions: repository source acceptance unavailable')
    const sourceContract = validateTaskAcceptanceContract(acceptedSource.contract)
    const sourceReceipt = validateTaskVerificationReceipt(sourceContract, acceptedSource.receipt)
    if (sourceContract.digest !== source.acceptance?.contractDigest || digest(sourceContract.task) !== digest(source.intent.task)
      || sourceContract.owner.principalRecordId !== contract.owner.principalRecordId || sourceContract.owner.principalVersion !== contract.owner.principalVersion
      || digest(sourceContract.scope) !== digest(contract.scope) || sourceReceipt.objectiveStatus !== 'achieved') throw new Error('assistant-actions: repository source acceptance changed')
    const evidenceDigest = digest({ source, assessment, assessmentRun, acceptedSource })
    return Object.freeze({ authority: Object.freeze({ grantId: authority.grantId, grantRevision: authority.grantRevision, repository: authority.repository, branch: authority.branch, baseBranch: authority.baseBranch, timeoutMs: authority.timeoutMs, freshnessMs: authority.freshnessMs }),
      evidenceDigest, requirements: validateRepositoryReadbackRequirements({ requiredChecks: authority.requiredChecks, reviewerIds: authority.reviewerIds, minApprovals: authority.minApprovals }), security, intent: latest.intent, commitOid, pullRequestNumber })
  }

  async #readRepositoryInspection(context: () => RepositoryReadbackContext, kind: InspectRequest['kind'], pullRequestNumber: number | undefined, signal: AbortSignal): Promise<unknown> {
    let observed: unknown
    const start = context()
    const request = normalizeWorkflow({ grantId: start.authority.grantId, operation: 'inspect', idempotencyKey: randomUUID(), kind, ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }) })
    if (!('operation' in request)) throw new Error('assistant-actions: repository inspection invalid')
    const authorization: Authorization = { sessionId: start.security.sessionId,
      identity: () => { const current = context(); if (digest(current) !== digest(start)) throw new Error('assistant-actions: repository readback changed'); return current.security.identity },
      authorize: record => this.ctx.get('assistantPolicy')?.authorize(this.#deliveryPolicy(start.security), { idempotencyKey: `action:${record.id}` }).effect === 'allow' }
    const result = await this.#runAuthorized(authorization, request, signal, async (actionId, grant, token, combined) => {
      const reply = await this.workflow.inspect({ grant, kind: request.kind, ...(request.pullRequestNumber === undefined ? {} : { pullRequestNumber: request.pullRequestNumber }), token, signal: combined })
      observed = reply?.observed
      return reply ? { actionId, status: 'succeeded' } : { actionId, status: 'failed', reason: 'github-inspect-failed' }
    })
    if (result.status !== 'succeeded' || observed === undefined) throw new Error('assistant-actions: repository inspection unavailable')
    context()
    return observed
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
    const nativeGoalId = current?.nativeGoalId
    if (!current) throw new Error('assistant-actions: admitted native goal round required')
    const routeReceipt = delivery.validateOwnerRoute({ authorityId: grant.verifiedDelivery.ownerRouteId, principalId: owner.principalId, workspace: identity.workspace, agentPreset: identity.agentPreset })
    if (routeReceipt.principalRecordId !== identity.principalRecordId || routeReceipt.principalVersion !== identity.principalVersion
      || routeReceipt.bindingVersion !== owner.bindingVersion || routeReceipt.generation !== owner.bindingGeneration) throw new Error('assistant-actions: current owner route mismatch')
    const security: DeliverySecurity = { principalId: owner.principalId, identity, sessionId: String(agent!.session.id),
      goalId: current.goalId, ...(typeof nativeGoalId === 'string' && nativeGoalId.length > 0 ? { nativeGoalId } : {}), runId: current.goalExecutionRunId, definitionDigest: current.definition.digest, definitionVersion: current.definition.version,
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

  #preauthorizedCompensation(execution: ToolExecution): boolean {
    try {
      if (execution.signal.aborted) return false
      const request = normalizeCompensation(execution.arguments as CompensationRequest)
      const identity = this.#compensationIdentity(execution.agent, request.grantId)
      const forward = this.#ledger.get(request.forwardActionId)
      return !!forward && forward.kind === 'commit' && forward.status === 'succeeded' && forward.sessionId === String(execution.agent?.session.id)
        && forward.grantId === request.grantId && forward.version === request.forwardActionVersion
        && forward.requestDigest === request.forwardRequestDigest && forward.result?.commitOid === request.forwardCommitOid
        && digest(forward.identity) === digest(identity)
    } catch { return false }
  }

  #preauthorizedCompensationStatus(execution: ToolExecution): boolean {
    try {
      if (execution.signal.aborted || !execution.arguments || typeof execution.arguments !== 'object' || Array.isArray(execution.arguments)
        || Object.keys(execution.arguments).length !== 2) return false
      const { grantId, actionId } = execution.arguments as { grantId?: unknown; actionId?: unknown }
      if (typeof grantId !== 'string' || typeof actionId !== 'string') return false
      const identity = this.#compensationIdentity(execution.agent, grantId)
      const record = this.#ledger.getCompensation(actionId)
      return !!record && record.grantId === grantId && record.sessionId === String(execution.agent?.session.id) && digest(record.identity) === digest(identity)
    } catch { return false }
  }

  run = async (agent: Agent | undefined, input: CommitRequest, signal: AbortSignal): Promise<ActionResult> => {
    const request = normalizeCommit(input)
    if (this.#ledger.grant(request.grantId)?.verifiedDelivery) throw new Error('assistant-actions: this grant requires independently verified delivery')
    return await this.#runWorkflow(agent, request, signal, async (actionId, grant, token, combined) => await this.commit({ actionId, grant, request, token, signal: combined }))
  }

  runCompensation = async (agent: Agent | undefined, input: CompensationRequest, signal: AbortSignal): Promise<CompensationStatus> => {
    signal.throwIfAborted()
    const request = normalizeCompensation(input)
    const identity = this.#compensationIdentity(agent, request.grantId)
    const sessionId = String(agent?.session.id)
    const { record } = this.#ledger.prepareCompensation({ identity, sessionId, request, authority: this.#authority })
    const terminal = this.#publicCompensation(record)
    if (terminal) return terminal
    const current = this.#pendingCompensations.get(record.id)
    if (current) return this.#publicCompensationResult(await current.done)
    const abort = new AbortController()
    const done = this.#executeCompensation(agent, identity, record, AbortSignal.any([signal, abort.signal]))
    this.#pendingCompensations.set(record.id, { abort, done })
    try {
      const result = await done
      if (digest(this.#compensationIdentity(agent, request.grantId)) !== digest(identity)) throw new Error('assistant-actions: owner changed')
      return this.#publicCompensationResult(result)
    } finally { this.#pendingCompensations.delete(record.id) }
  }

  compensationStatus = (agent: Agent | undefined, input: { grantId: string; actionId: string }): CompensationStatus | { status: 'not-found' } => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
      || typeof input.grantId !== 'string' || typeof input.actionId !== 'string') throw new Error('assistant-actions: invalid compensation status request')
    const identity = this.#compensationIdentity(agent, input.grantId)
    const record = this.#ledger.getCompensation(input.actionId)
    if (!record) return { status: 'not-found' }
    if (record.grantId !== input.grantId || record.sessionId !== String(agent?.session.id) || digest(record.identity) !== digest(identity)) throw new Error('assistant-actions: compensation status denied')
    return this.#publicCompensation(record) ?? { actionId: record.id, status: record.status, repository: record.repository, branch: record.branch, parentOid: record.forwardCommitOid }
  }

  #publicCompensation(record: CompensationRecord): CompensationStatus | undefined {
    if (!record.result) return undefined
    return this.#publicCompensationResult(record.result)
  }

  #publicCompensationResult(result: CompensationResult): CompensationStatus {
    return Object.freeze({ actionId: result.actionId, status: result.status, repository: result.repository, branch: result.branch, parentOid: result.parentOid,
      ...(result.resultOid === undefined ? {} : { resultOid: result.resultOid }), ...(result.reason === undefined ? {} : { reason: result.reason }) })
  }

  async #executeCompensation(agent: Agent | undefined, identity: ActionIdentity, initial: CompensationRecord, signal: AbortSignal): Promise<CompensationResult> {
    let record = initial
    const abort = new AbortController()
    const stillAuthorized = (): boolean => {
      try {
        const grant = this.#ledger.grant(record.grantId)
        return !signal.aborted && !!grant?.rollback?.allowRollback && grant.revision === record.grantRevision && grant.expiresAt > Date.now()
          && digest(this.#compensationIdentity(agent, record.grantId)) === digest(identity)
      } catch { return false }
    }
    const timer = setInterval(() => { if (!stillAuthorized()) abort.abort() }, 100); timer.unref()
    try {
      const grant = this.#ledger.grant(record.grantId)
      const credentials = this.ctx.get('credentialsKeychain')
      if (!grant || !credentials || !stillAuthorized()) throw new Error('assistant-actions: compensation unavailable')
      if (!this.#authorizeCompensation(agent, record)) throw new Error('assistant-actions: compensation budget denied')
      return await credentials.withSecret(this.ctx, { handleId: grant.credentialHandle, purpose: 'github.compensate', idempotencyKey: `compensation:${record.id}`, ttlMs: Math.min(30_000, record.expiresAt - Date.now()) }, async (token, credentialSignal) => {
        const combined = AbortSignal.any([signal, abort.signal, credentialSignal, AbortSignal.timeout(Math.max(1, record.expiresAt - Date.now()))])
        combined.throwIfAborted()
        if (!stillAuthorized()) throw new Error('assistant-actions: compensation authorization ended')
        if (record.status === 'capturing') {
          const preimage = await this.compensation.capture({ grant, commitOid: record.parentOid, paths: record.paths, token, signal: combined })
          if (!preimage || !stillAuthorized() || combined.aborted) throw new Error('assistant-actions: compensation capture unavailable')
          record = this.#ledger.captureCompensation(record.id, record.version, preimage, this.#authority)
        }
        if (record.status !== 'prepared' || !record.preimage) throw new Error('assistant-actions: compensation is not dispatchable')
        if (!stillAuthorized() || !this.#authorizeCompensation(agent, record)) throw new Error('assistant-actions: compensation authorization ended')
        record = this.#ledger.dispatchCompensation(record.id, record.version, this.#authority)
        let outcome: CompensationResult
        try {
          outcome = await this.compensation.commit({ actionId: record.id, grant, forwardCommitOid: record.forwardCommitOid, preimage: record.preimage!, token, signal: combined })
          if (!stillAuthorized() || combined.aborted) outcome = { actionId: record.id, status: 'unknown', repository: record.repository, branch: record.branch, parentOid: record.forwardCommitOid, actionMarker: `dsh-compensation:${record.id}`, reason: 'authorization-ended-after-dispatch' }
        } catch {
          outcome = { actionId: record.id, status: 'unknown', repository: record.repository, branch: record.branch, parentOid: record.forwardCommitOid, actionMarker: `dsh-compensation:${record.id}`, reason: 'dispatch-unconfirmed-no-replay' }
        }
        return this.#ledger.settleCompensation(record.id, record.version, outcome, this.#authority).result!
      })
    } catch (error) {
      // A capturing row is only a pre-dispatch placeholder: no preimage was
      // sealed and no compensation POST could have been sent. Drop it so a
      // denial, abort or capture failure neither wedges the forward action's
      // one-compensation slot nor permanently consumes a rollback action.
      if (record.status === 'capturing') {
        try { this.#ledger.discardCompensation(record.id, record.version, this.#authority) } catch {}
      }
      throw error
    } finally { clearInterval(timer) }
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
