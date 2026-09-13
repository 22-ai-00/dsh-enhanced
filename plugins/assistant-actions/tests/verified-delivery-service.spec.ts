import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { CredentialsKeychainService } from '@dsh-enhanced/credentials-keychain'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { externalDeliveryFixture } from './external-delivery-fixture.ts'
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantActionsService } from '../src/service.ts'
import { AssistantVerifierService, createVerifierAuthorities } from '@dsh-enhanced/assistant-verifier'
import { createTaskAcceptanceContract, createTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import type { ActionGrant } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const oid = 'a'.repeat(40)
async function fixture(acceptance?: 'goal-step', external = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'avd-'))); const ctx = new Context(); const id = SessionId('owner-session')
  await writeFile(join(root, 'secret'), 'fixture-secret', { mode: 0o600 })
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd: root, agentPreset: 'primary' })
  const agent: Agent = { id, options: { provider: 'test', model: 'test' }, session, inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }), ctx: undefined as unknown as Context, status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
  ;(agent as any).ctx = createScope(ctx, agent).ctx; session.append('turn/start', { turn: 1 }); session.append('approval/policy', { policy: 'ask' })
  const grant: ActionGrant = { id: 'verified', revision: 1, principalDigest: createHash('sha256').update('owner').digest('hex'), principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary', repository: 'owner/repository', branch: 'fix', paths: ['artifacts/release.txt'], credentialHandle: 'github', expiresAt: Date.now() + 60_000, maxActions: 12, maxTotalBytes: 100_000, repoWorkflow: { baseBranch: 'main', allowBranchCreate: true, allowPullRequest: true }, verifiedDelivery: { ownerRouteId: 'route', budgetId: 'budget', ...(acceptance ? { acceptance } : {}) } }
  const agents = new Map<string, Agent>([[id, agent]]); let route = { principalRecordId: 'record', principalVersion: 1, bindingVersion: 1, generation: 1 }; let receiptVersion = 1
  const verifiedSnapshot = { protocol: 'assistant-goals/verified-artifacts/v1', acceptance: { validUntil: Date.now() + 30_000 }, files: [{ path: 'artifacts/release.txt', content: 'verified source', sha256: 'b'.repeat(64), jobId: 'job' }] }
  const snapshot = () => structuredClone(verifiedSnapshot)
  let registration: any; let proof: any = null
  const goals = { trustedAcceptanceProducerGeneration: () => 'goals', registerTaskAcceptanceSink: (value: any) => { registration = value; return () => { registration = undefined } }, inspectAcceptedExecution: async () => proof, taskContext: () => ({ goal: { id: 'goal' } }), inspectGoalLifecycle: () => ({ definition: { digest: 'd'.repeat(64), version: 1 }, native: { sessionId: 'owner-session', goalId: 'native-goal', phase: 'active' } }), inspectWorkflowRunContext: vi.fn(() => ({ goalId: 'goal', nativeGoalId: 'native-goal', goalExecutionRunId: 'run', definition: { digest: 'd'.repeat(64), version: 1 } })), inspectOwnerGoalExecution: vi.fn((): any => ({ storedGoal: { definition: { digest: 'd'.repeat(64), version: 1 }, nativeAtLastObservation: { phase: 'complete', sessionId: 'owner-session', goalId: 'native-goal' } }, outcome: { status: 'achieved' } })), inspectOwnerVerifiedArtifacts: vi.fn(() => snapshot()), inspectOwnerAcceptedStepArtifacts: vi.fn(() => ({ ...snapshot(), protocol: 'assistant-goals/accepted-step-artifacts/v1' })) }
  const executors: any[] = [], reconciles: any[] = []; const automations = { registerHostExecutor: (executor: any) => { executors.push(executor); return () => {} }, reconcileSystem: (input: any) => { reconciles.push(input); return { definition: input.definition } } }
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), toolDefaultEffect: 'allow', rules: [
    { id: 'agent', effect: 'allow', subject: { kind: 'agent', id: 'primary' }, actions: ['execute'], resource: { kind: 'tool', id: 'action:github:verified' } },
    { id: 'background', effect: 'allow', subject: { kind: 'background', id: 'dsh-enhanced-assistant-actions' }, actions: ['execute'], resource: { kind: 'tool', id: 'action:github:verified' } },
    { id: 'event-observe', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:trigger', workspace: root, principal: 'owner' }, actions: ['observe'], resource: { kind: 'network', id: 'https://api.github.com/repos/owner/repository' } },
    { id: 'credential', effect: 'allow', subject: { kind: 'background', id: 'dsh-enhanced-assistant-actions' }, actions: ['credential.use'], resource: { kind: 'credential', id: 'github' } },
  ] })
  if (!external) await ctx.plugin(CredentialsKeychainService, { databasePath: join(root, 'credentials.sqlite'), handles: [{ id: 'github', provider: 'linux-protected-file', path: join(root, 'secret'), consumers: ['dsh-enhanced-assistant-actions'], purposes: ['github.commit'], maxLeaseMs: 30_000 }] })
  ctx.provide('agents' as never, { get: (key: string) => agents.get(key) } as never)
  const notifications = vi.fn()
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: () => ({ principalId: 'owner', principalLineage: { principalRecordId: 'record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' }, sessionId: 'owner-session', bindingId: 'binding', bindingVersion: 1, bindingGeneration: 1 }), resolveOwnerRoute: () => ({ binding: { id: 'binding', sessionId: 'owner-session' }, snapshot: { bindingVersion: route.bindingVersion, generation: route.generation } }), validateOwnerRoute: () => ({ ...route, receiptVersion }), enqueueOwnerNotification: notifications } as never)
  ctx.provide('assistantGoals' as never, goals as never);
  // Keep freshness aligned with the readback timeout so parallel CI scheduling cannot invalidate a fresh fixture read mid-sample.
  const repositoryAuthority = { kind: 'repository-readback' as const, id: 'repository', grantId: 'verified', grantRevision: 1, repository: 'owner/repository', branch: 'fix', baseBranch: 'main', requiredChecks: [{ name: 'CI', appId: 7 }], reviewerIds: [42], minApprovals: 1, timeoutMs: 10_000, freshnessMs: 10_000 }
  const compiledAuthority = createVerifierAuthorities({ authorities: [repositoryAuthority] })[0]!
  const repositoryCriterion = { id: 'repository', kind: 'target-readback' as const, authority: { id: compiledAuthority.id, digest: compiledAuthority.digest }, objectId: 'owner/repository:fix', expected: [{ pointer: '/ready', value: true }] }
  const verifier = new AssistantVerifierService(ctx, { databasePath: join(root, 'verifier.sqlite'), authorities: [repositoryAuthority], tickIntervalMs: 0, requireAcceptance: true, profiles: [{ id: 'repository-profile', version: 1, scope: { workspace: root, preset: 'primary' }, owner: { principalRecordId: 'record', principalVersion: 1 }, taskKind: 'goal-outcome', objective: 'Repository delivery', validityMs: 30_000, bounds: { maxDurationMs: 5_000, maxEvidenceBytes: 4_096 }, criteria: [repositoryCriterion] }] })
  ctx.provide('assistantAutomations' as never, automations as never)
  const commit = vi.fn(async input => ({ actionId: input.actionId, status: 'succeeded' as const, commitOid: 'c'.repeat(40) })); const pullRequest = vi.fn(async input => ({ actionId: input.actionId, status: 'succeeded' as const, pullRequestNumber: 7 }))
  const remotePullRequest = { number: 7, state: 'open', merged: false, head: { ref: 'fix', sha: 'c'.repeat(40), repo: { full_name: 'owner/repository' } }, base: { ref: 'main', repo: { full_name: 'owner/repository' } } }
  const inspect = vi.fn(async ({ kind }: any) => ({ observed: kind === 'branch' ? { name: 'fix', commit: { sha: 'c'.repeat(40) }, untrusted: true }
    : kind === 'pull-request' ? { ...remotePullRequest, untrusted: true }
      : { pullRequest: remotePullRequest, headOid: 'c'.repeat(40), items: kind === 'checks' ? [{ id: 1, name: 'CI', app: { id: 7 }, head_sha: 'c'.repeat(40), status: 'completed', conclusion: 'success' }]
        : [{ id: 1, user: { id: 42 }, commit_id: 'c'.repeat(40), state: 'APPROVED', submitted_at: '2025-01-01T00:00:00Z' }], truncated: false, untrusted: true } }))
  const broker = external ? await externalDeliveryFixture(root, grant, { commit, pullRequest, inspect }) : undefined
  if (broker) cleanups.push(() => broker.close())
  let service!: AssistantActionsService
  const plugin = await ctx.plugin({ name: 'dsh-enhanced-assistant-actions', apply(runtime: Context) { service = new AssistantActionsService(runtime, broker?.config ?? { stateRoot: join(root, 'actions'), grants: [grant] }, external ? vi.fn() : commit, external ? { branch: vi.fn(), pullRequest: vi.fn(), inspect: vi.fn() } as any : { branch: vi.fn(), pullRequest, inspect } as any, undefined, broker?.dispatch) } })
  const execute = (name: string, args: any) => ctx.tools.execute({ callId: ToolCallId(`${name}-${Math.random()}`), name, arguments: args, signal: new AbortController().signal, agent })
  const activate = async (event = 'goal/changed') => { (ctx.emit as any)(event, { taskKind: 'goal-step' }); await new Promise(resolve => setTimeout(resolve, 0)); const active = reconciles.filter(entry => entry.desiredStatus === 'active').at(-1)!; return executors[0].execute({ occurrenceId: 'o', automationId: active.automationId, definitionHash: createHash('sha256').update(JSON.stringify(active.definition)).digest('hex'), executionMode: 'production', targetScope: { workspace: root, preset: 'primary' }, principal: 'owner', ownerRouteId: 'route', activationNonce: active.automationId, catalogDigest: executors[0].descriptor.catalogDigest, signal: new AbortController().signal }) }
  cleanups.push(async () => { await plugin.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, broker, service, ctx, agent, agents, goals, registration: () => registration, setProof: (value: any) => { proof = value }, repositoryAuthority: compiledAuthority, executors, reconciles, grant, commit, pullRequest, inspect, verifier, notifications, execute, activate, read: (input: any) => service.readRepositoryGoalOutcome(input, new AbortController().signal), prepare: (input: any) => service.prepareVerifiedDelivery(agent, input), revokeRoute: () => { route = { ...route, bindingVersion: 2 } }, changeReceipt: () => { receiptVersion++ } }
}

describe('verified delivery Actions service', () => {
  it('keeps legacy whole-goal delivery capture available when an older Goals service has no nativeGoalId', async () => {
    const f = await fixture()
    f.goals.inspectWorkflowRunContext.mockReturnValue({ goalId: 'goal', goalExecutionRunId: 'run', definition: { digest: 'd'.repeat(64), version: 1 } } as never)
    expect(f.prepare({ grantId: 'verified', idempotencyKey: 'legacy', expectedHeadOid: oid, headline: 'Legacy', paths: ['artifacts/release.txt'] })).toMatchObject({ status: 'awaiting-verification' })
  })
  it.runIf(process.platform === 'linux')('registers through the real tool/ledger, then host commits and opens a PR after the Agent disappears', async () => {
    const f = await fixture(); const delivery = { grantId: 'verified', idempotencyKey: 'delivery', expectedHeadOid: oid, headline: 'Deliver verified', paths: ['artifacts/release.txt'], pullRequest: { title: 'PR', body: 'body' } }
    const queued: any = await f.execute('action_github_deliver', delivery)
    expect(queued.isError, JSON.stringify(queued)).toBe(false); f.agents.clear(); expect((await f.activate()).outcome).toBe('succeeded')
    expect(f.commit).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ files: [{ path: 'artifacts/release.txt', content: 'verified source' }] }) })); expect(f.pullRequest).toHaveBeenCalledTimes(1)
    expect(f.notifications).toHaveBeenCalledWith(expect.objectContaining({ ownerRouteId: 'route', sessionId: 'owner-session', text: expect.stringContaining('c'.repeat(40)) }))
    expect(f.notifications.mock.calls[0]?.[0].text).toContain('#7')
  })

  it.runIf(process.platform === 'linux')('uses explicit step acceptance to commit and open a PR while the original goal remains paused and unachieved', async () => {
    const f = await fixture('goal-step')
    const evidence = { storedGoal: { definition: { digest: 'd'.repeat(64), version: 1 }, nativeAtLastObservation: { phase: 'active' } },
      outcome: { status: 'not-achieved' }, executionRuns: [{ intent: { runId: 'run' }, acceptance: { contractId: 'step' }, execution: { status: 'succeeded', quiescent: true } }],
      acceptedTasks: [{ contractId: 'step', state: 'unavailable' }] }
    f.goals.inspectOwnerGoalExecution.mockImplementation(() => evidence)
    await f.execute('action_github_deliver', { grantId: 'verified', idempotencyKey: 'step', expectedHeadOid: oid, headline: 'Step', paths: ['artifacts/release.txt'], pullRequest: { title: 'PR', body: 'pending CI' } })
    evidence.storedGoal.nativeAtLastObservation.phase = 'paused'
    // Even a forged nudge does not replace a durable accepted receipt.
    ;(f.ctx.emit as any)('assistant-verifier/receipt', { taskKind: 'goal-step', objectiveStatus: 'achieved' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.reconciles).toHaveLength(0); expect(f.goals.inspectOwnerAcceptedStepArtifacts).not.toHaveBeenCalled()
    evidence.acceptedTasks[0]!.state = 'pending'
    ;(f.ctx.emit as any)('assistant-verifier/receipt', { taskKind: 'goal-step' })
    await new Promise(resolve => setTimeout(resolve, 0)); expect(f.reconciles).toHaveLength(0)
    evidence.acceptedTasks[0]!.state = 'done'
    expect((await f.activate('assistant-verifier/receipt')).outcome).toBe('succeeded')
    expect(f.commit).toHaveBeenCalledOnce(); expect(f.pullRequest).toHaveBeenCalledOnce()
    expect(f.goals.inspectOwnerVerifiedArtifacts).not.toHaveBeenCalled()
    expect(f.goals.inspectOwnerAcceptedStepArtifacts).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run', sessionId: 'owner-session', goalId: 'goal' }))
    expect(evidence.storedGoal.nativeAtLastObservation.phase).toBe('paused'); expect(evidence.outcome.status).toBe('not-achieved')
    await f.activate('assistant-verifier/receipt'); expect(f.commit).toHaveBeenCalledOnce()
  })

  it('keeps the default grant waiting for whole-goal acceptance despite an achieved step', async () => {
    const f = await fixture()
    f.goals.inspectOwnerGoalExecution.mockReturnValue({ storedGoal: { definition: { digest: 'd'.repeat(64), version: 1 }, nativeAtLastObservation: { phase: 'active' } }, outcome: { status: 'not-achieved' } })
    await f.execute('action_github_deliver', { grantId: 'verified', idempotencyKey: 'final', expectedHeadOid: oid, headline: 'Final', paths: ['artifacts/release.txt'] })
    ;(f.ctx.emit as any)('assistant-verifier/receipt', { taskKind: 'goal-step' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.reconciles).toHaveLength(0); expect(f.commit).not.toHaveBeenCalled(); expect(f.goals.inspectOwnerAcceptedStepArtifacts).not.toHaveBeenCalled()
  })

  it('does not commit intermediate files if the authoritative step inspection rejects them', async () => {
    const f = await fixture('goal-step')
    f.goals.inspectOwnerGoalExecution.mockReturnValue({ storedGoal: { definition: { digest: 'd'.repeat(64), version: 1 }, nativeAtLastObservation: { phase: 'paused' } }, executionRuns: [{ intent: { runId: 'run' }, acceptance: { contractId: 'step' }, execution: { status: 'succeeded', quiescent: true } }], acceptedTasks: [{ contractId: 'step', state: 'done' }] })
    f.goals.inspectOwnerAcceptedStepArtifacts.mockImplementation(() => { throw new Error('expired or changed step artifact') })
    await f.execute('action_github_deliver', { grantId: 'verified', idempotencyKey: 'invalid-step', expectedHeadOid: oid, headline: 'Step', paths: ['artifacts/release.txt'] })
    ;(f.ctx.emit as any)('assistant-verifier/receipt', { taskKind: 'goal-step' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.reconciles).toHaveLength(0); expect(f.commit).not.toHaveBeenCalled()
  })

  it('rejects direct mutations for verified grants and only discovers the owner grant without credentials', async () => {
    const f = await fixture(); const direct = await f.execute('action_github_commit', { grantId: 'verified', idempotencyKey: 'direct', expectedHeadOid: oid, headline: 'no', files: [{ path: 'artifacts/release.txt', content: 'x' }] })
    const branch = await f.execute('action_github_branch', { grantId: 'verified', idempotencyKey: 'branch', baseHeadOid: oid }); const pr = await f.execute('action_github_pr', { grantId: 'verified', idempotencyKey: 'pr', expectedHeadOid: oid, title: 'no', body: '' })
    expect(direct.isError).toBe(true); expect(branch.isError).toBe(true); expect(pr.isError).toBe(true); expect(f.commit).not.toHaveBeenCalled(); const grants: any = await f.execute('action_github_grants', {})
    expect(JSON.stringify(grants)).toContain('verified'); expect(JSON.stringify(grants)).not.toContain('github'); expect(JSON.stringify(grants)).not.toContain('fixture-secret')
  })

  it('does not dispatch after route receipt changes before Host execution', async () => {
    const f = await fixture(); await f.execute('action_github_deliver', { grantId: 'verified', idempotencyKey: 'changed', expectedHeadOid: oid, headline: 'Deliver', paths: ['artifacts/release.txt'] }); f.changeReceipt();
    (f.ctx.emit as any)('goal/changed', {}); await new Promise(resolve => setTimeout(resolve, 0)); expect(f.reconciles).toHaveLength(0); expect(f.commit).not.toHaveBeenCalled(); expect(f.notifications).not.toHaveBeenCalled()
  })

  it('rechecks the receipt while credential acquisition waits and suppresses the commit', async () => {
    const f = await fixture(); const original = f.ctx.credentialsKeychain.withSecret.bind(f.ctx.credentialsKeychain); const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    vi.spyOn(f.ctx.credentialsKeychain, 'withSecret').mockImplementation(async (...args: any[]) => { entered.resolve(); await release.promise; return await (original as any)(...args) })
    await f.execute('action_github_deliver', { grantId: 'verified', idempotencyKey: 'wait', expectedHeadOid: oid, headline: 'Deliver', paths: ['artifacts/release.txt'] })
    const pending = f.activate(); await entered.promise; f.changeReceipt(); release.resolve()
    expect((await pending).outcome).not.toBe('succeeded'); expect(f.commit).not.toHaveBeenCalled()
  })

  const bindRepository = (f: any, nativeGoalId = 'native-goal') => {
    const task = { kind: 'goal-outcome' as const, ref: 'assessment', goal: { id: 'goal', sessionId: 'owner-session', nativeGoalId, definitionVersion: 1, definitionDigest: 'd'.repeat(64), assessmentId: 'assessment' } }
    const handle = f.registration().prepare({ scope: { workspace: f.grant.workspace, preset: 'primary' }, owner: { principalRecordId: 'record', principalVersion: 1 }, objective: 'Repository delivery', task })
    expect(handle).not.toBeNull()
    const inspected = f.verifier.inspectRepositoryReadbackAuthority(handle!.contractId, f.repositoryAuthority.id, f.repositoryAuthority.digest)
    const run = (runId: string, round: number) => ({ intent: { runId, scope: { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: f.grant.workspace, preset: 'primary' }, objective: 'Repository delivery', admission: { issuedAt: 1, expiresAt: 60_000, maxGoalRounds: 2, round, authorizationDigest: 'a'.repeat(64) }, task: { kind: 'goal-step', ref: runId, goal: { id: 'goal', definitionVersion: 1, definitionDigest: 'd'.repeat(64), stepId: `step-${runId}`, runId, sessionId: 'owner-session', nativeGoalId: 'native-goal', nativeRevision: 1 } } }, dispatchedAt: 1, execution: { status: 'succeeded', quiescent: true, completedAt: 2 } })
    const source = run('run', 1), trigger = run('assessment-run', 2), sourceIssuedAt = Date.now() - 1000
    const sourceContract = createTaskAcceptanceContract({ protocol: 'task-acceptance/v2', id: 'source-step', scope: inspected.contract.scope, owner: inspected.contract.owner,
      task: source.intent.task as never, objective: 'Repository delivery', profile: { id: 'step', version: 1, digest: 'a'.repeat(64) }, issuedAt: sourceIssuedAt, expiresAt: sourceIssuedAt + 30_000,
      criteria: [{ id: 'source', kind: 'document-citations', authority: { id: 'docs', digest: 'a'.repeat(64) }, artifactPath: 'artifacts/release.txt', requiredText: ['verified source'], quotes: [] }], bounds: { maxDurationMs: 1000, maxEvidenceBytes: 4096 } })
    const receipt = createTaskVerificationReceipt(sourceContract, { protocol: 'task-verification/v2', id: 'source-receipt', contractId: sourceContract.id, contractDigest: sourceContract.digest,
      scope: sourceContract.scope, owner: sourceContract.owner, task: sourceContract.task, startedAt: sourceIssuedAt + 1, completedAt: sourceIssuedAt + 2, validUntil: sourceContract.expiresAt,
      results: [{ criterionId: 'source', status: 'passed', reason: 'verified', evidence: [] }] })
    const evidence = { storedGoal: { definition: { digest: 'd'.repeat(64), version: 1 }, nativeAtLastObservation: { phase: 'blocked', sessionId: 'owner-session', goalId: 'native-goal' } },
      executionRuns: [{ ...source, acceptance: { contractId: sourceContract.id, contractDigest: sourceContract.digest } }, trigger],
      acceptedTasks: [{ contractId: sourceContract.id, state: 'done', contract: sourceContract, receipt }],
      outcomeAssessments: [{ contract: inspected.contract, triggerRunId: 'assessment-run', dispatchedAt: 1, execution: { status: 'succeeded', quiescent: true, completedAt: 2 } }] }
    f.goals.inspectOwnerGoalExecution.mockReturnValue(evidence)
    return { authority: f.repositoryAuthority, contract: { id: handle!.contractId }, handle, evidence }
  }
  const stepEvidence = () => ({ storedGoal: { definition: { digest: 'd'.repeat(64), version: 1 }, nativeAtLastObservation: { phase: 'paused', sessionId: 'owner-session', goalId: 'native-goal' } }, outcome: { status: 'not-achieved' },
    executionRuns: [{ intent: { runId: 'run' }, acceptance: { contractId: 'step' }, execution: { status: 'succeeded', quiescent: true } }], acceptedTasks: [{ contractId: 'step', state: 'done' }] })

  const completeStepDelivery = async (f: any, key = 'repository', outcome: 'succeeded' | 'unknown' = 'succeeded') => {
    f.goals.inspectOwnerGoalExecution.mockReturnValue(stepEvidence())
    await f.execute('action_github_deliver', { grantId: 'verified', idempotencyKey: key, expectedHeadOid: oid, headline: 'Deliver', paths: ['artifacts/release.txt'], pullRequest: { title: 'PR', body: 'body' } })
    expect((await f.activate('assistant-verifier/receipt')).outcome).toBe(outcome)
  }

  it.runIf(process.platform === 'linux')('uses the fenced Host ledger and four independently charged reads for a fresh exact repository outcome', async () => {
    const f = await fixture('goal-step'); await completeStepDelivery(f); const { authority, contract } = bindRepository(f)
    await expect(f.read({ contractId: contract.id, authorityId: authority.id, authorityDigest: authority.digest })).resolves.toEqual({ objectId: 'owner/repository:fix', headOid: 'c'.repeat(40), ci: 'passed', review: 'approved', pullRequest: 'open', ready: true })
    expect(f.inspect).toHaveBeenCalledTimes(4); expect(f.inspect.mock.calls.map((call: any[]) => call[0].kind)).toEqual(['checks', 'reviews', 'pull-request', 'branch'])
  })

  it.runIf(process.platform === 'linux')('a real Verifier tick reaches Actions through the Cordis service and issues a fresh achieved receipt', async () => {
    const f = await fixture('goal-step'); await completeStepDelivery(f); const { handle } = bindRepository(f)
    f.setProof({ ...handle, dispatchedAt: Date.now(), completedAt: Date.now(), status: 'succeeded', quiescent: true, executionRef: 'assessment' })
    await f.registration().completed(handle); await f.verifier.tick()
    expect(f.verifier.inspectAcceptedTask(handle.contractId)).toMatchObject({ state: 'done', receipt: { objectiveStatus: 'achieved' } })
    expect(f.inspect).toHaveBeenCalledTimes(4)
  })

  it.runIf(process.platform === 'linux')('does not reuse an older success once a newer exact delivery is pending or unknown', async () => {
    const f = await fixture('goal-step'); await completeStepDelivery(f, 'old'); const { authority, contract } = bindRepository(f)
    await f.execute('action_github_deliver', { grantId: 'verified', idempotencyKey: 'new', expectedHeadOid: oid, headline: 'New', paths: ['artifacts/release.txt'], pullRequest: { title: 'PR', body: 'body' } })
    await expect(f.read({ contractId: contract.id, authorityId: authority.id, authorityDigest: authority.digest })).rejects.toThrow('not settled')
    const unknown = await fixture('goal-step'); await completeStepDelivery(unknown, 'old'); const binding = bindRepository(unknown)
    unknown.goals.inspectOwnerGoalExecution.mockReturnValue(stepEvidence())
    ;(unknown.commit as any).mockResolvedValueOnce({ actionId: 'ignored', status: 'unknown', reason: 'unconfirmed' })
    await unknown.execute('action_github_deliver', { grantId: 'verified', idempotencyKey: 'later-failed-source', expectedHeadOid: oid, headline: 'Later', paths: ['artifacts/release.txt'], pullRequest: { title: 'PR', body: 'body' } })
    expect((await unknown.activate('assistant-verifier/receipt')).outcome).toBe('unknown')
    await expect(unknown.read({ contractId: binding.contract.id, authorityId: binding.authority.id, authorityDigest: binding.authority.digest })).rejects.toThrow('not settled')
  })

  it.runIf(process.platform === 'linux').each(['later-source', 'unknown-source', 'changed-assessment', 'failed-source-proof'] as const)('rejects %s substitution before remote I/O', async change => {
    const f = await fixture('goal-step'); await completeStepDelivery(f); const binding = bindRepository(f)
    const evidence = structuredClone(binding.evidence)
    if (change === 'later-source') evidence.executionRuns[0]!.intent.admission.round = 3
    if (change === 'unknown-source') evidence.executionRuns[0]!.execution.quiescent = false
    if (change === 'changed-assessment') evidence.outcomeAssessments[0]!.triggerRunId = 'foreign'
    if (change === 'failed-source-proof') evidence.acceptedTasks[0]!.state = 'needs-attention'
    f.goals.inspectOwnerGoalExecution.mockReturnValue(evidence)
    await expect(f.read({ contractId: binding.contract.id, authorityId: binding.authority.id, authorityDigest: binding.authority.digest })).rejects.toThrow()
    expect(f.inspect).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'linux')('does not read back after route revocation or a contract native-goal mismatch', async () => {
    const f = await fixture('goal-step'); await completeStepDelivery(f); const { authority, contract } = bindRepository(f)
    f.changeReceipt(); await expect(f.read({ contractId: contract.id, authorityId: authority.id, authorityDigest: authority.digest })).rejects.toThrow('authority changed')
    const fresh = await fixture('goal-step'); await completeStepDelivery(fresh); const wrong = bindRepository(fresh, 'other-native')
    await expect(fresh.read({ contractId: wrong.contract.id, authorityId: wrong.authority.id, authorityDigest: wrong.authority.digest })).rejects.toThrow('not settled')
  })

  it.runIf(process.platform === 'linux')('does not mark a remote outcome ready when the current branch head differs from the settled commit', async () => {
    const f = await fixture('goal-step'); await completeStepDelivery(f); const { authority, contract } = bindRepository(f)
    const original = f.inspect.getMockImplementation()
    f.inspect.mockImplementation(async (input: any) => input.kind === 'branch' ? { observed: { name: 'fix', commit: { sha: oid }, untrusted: true } } : await original!(input))
    await expect(f.read({ contractId: contract.id, authorityId: authority.id, authorityDigest: authority.digest })).resolves.toEqual(expect.objectContaining({ headOid: '', ci: 'unknown', review: 'unknown', pullRequest: 'open', ready: false }))
  })

  it.runIf(process.platform === 'linux')('delivers accepted artifacts through the signed external socket and verifies the exact remote outcome without Host credentials', async () => {
    const f = await fixture('goal-step', true)
    expect(f.ctx.get('credentialsKeychain', false)).toBeUndefined()
    await completeStepDelivery(f)
    await expect(access(join(f.root, 'actions', 'ledger.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.commit).toHaveBeenCalledWith(expect.objectContaining({ token: 'external-only-fixture-secret', request: expect.objectContaining({ files: [{ path: 'artifacts/release.txt', content: 'verified source' }] }) }))
    expect(f.pullRequest).toHaveBeenCalledOnce()
    expect(f.notifications).toHaveBeenCalledOnce()
    const status = await f.execute('action_github_delivery_status', { grantId: 'verified', idempotencyKey: 'repository' })
    expect(JSON.stringify(status)).not.toContain('signature')
    expect(JSON.stringify(status)).not.toContain('external-only-fixture-secret')
    const db = new DatabaseSync(join(f.root, 'actions', 'verified-delivery.sqlite'))
    try {
      const rows = JSON.stringify(db.prepare('SELECT * FROM deliveries').all())
      expect(rows).not.toContain('verified source')
      expect(rows).toContain('brokerReceipts')
    } finally { db.close() }
    const { handle } = bindRepository(f)
    f.setProof({ ...handle, dispatchedAt: Date.now(), completedAt: Date.now(), status: 'succeeded', quiescent: true, executionRef: 'assessment' })
    await f.registration().completed(handle); await f.verifier.tick()
    expect(f.verifier.inspectAcceptedTask(handle.contractId)).toMatchObject({ state: 'done', receipt: { objectiveStatus: 'achieved' } })
    expect(f.inspect).toHaveBeenCalledTimes(4)
    const inspected = await f.execute('action_github_inspect', { grantId: 'verified', kind: 'branch' })
    expect(inspected.isError).not.toBe(true)
    expect(JSON.stringify(inspected)).toContain('succeeded')
    expect(JSON.stringify(inspected)).not.toContain('signature')
    expect(JSON.stringify(inspected)).not.toContain('server-hello')
  })

  it.runIf(process.platform === 'linux')('observes only the PR bound by a real signed external delivery', async () => {
    const f = await fixture('goal-step', true); await completeStepDelivery(f)
    const grant = f.broker!.config.externalGrants![0]!
    const observed = await f.service.readRepositoryEventObservation({ version: 1, triggerId: 'trigger', grantId: grant.id, grantRevision: grant.revision, grantDigest: grant.grantDigest,
      repository: grant.destination.repository, branch: grant.destination.branch, baseBranch: grant.destination.baseBranch!, owner: { workspace: f.root, preset: 'primary', principalId: 'owner', principalRecordId: 'record', principalVersion: 1, ownerRouteId: 'route', expiresAt: grant.expiresAt, budgetId: 'events' },
      goal: { id: 'goal', sessionId: 'owner-session', nativeGoalId: 'native-goal', definitionVersion: 1, definitionDigest: 'd'.repeat(64) } }, new AbortController().signal)
    expect(observed).toMatchObject({ protocol: 'assistant-actions/repository-event/v1', truthy: true, fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) })
    expect(f.inspect).toHaveBeenCalledTimes(4)
  })

  it.runIf(process.platform === 'linux')('rejects altered signed delivery history before external readback', async () => {
    const f = await fixture('goal-step', true); await completeStepDelivery(f); const { authority, contract } = bindRepository(f)
    const db = new DatabaseSync(join(f.root, 'actions', 'verified-delivery.sqlite'))
    try {
      const row = db.prepare('SELECT id,result FROM deliveries').get() as { id: string; result: string }
      const result = JSON.parse(row.result); result.brokerReceipts.commit.response.signature = Buffer.alloc(64).toString('base64url')
      db.prepare('UPDATE deliveries SET result=? WHERE id=?').run(JSON.stringify(result), row.id)
    } finally { db.close() }
    await expect(f.read({ contractId: contract.id, authorityId: authority.id, authorityDigest: authority.digest })).rejects.toThrow()
    expect(f.inspect).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'linux')('fences external readback when broker generation changes and never repeats the successful writes', async () => {
    const f = await fixture('goal-step', true); await completeStepDelivery(f); const { authority, contract } = bindRepository(f)
    const input = { contractId: contract.id, authorityId: authority.id, authorityDigest: authority.digest }
    const generation = f.service.repositoryReadbackGeneration()
    await f.broker!.restart()
    await expect(f.read(input)).rejects.toThrow(/broker changed/)
    expect(f.service.repositoryReadbackGeneration()).not.toBe(generation)
    await expect(f.read(input)).resolves.toMatchObject({ ready: true })
    expect(f.commit).toHaveBeenCalledOnce(); expect(f.pullRequest).toHaveBeenCalledOnce()
  })

  it.runIf(process.platform === 'linux')('rejects direct mutations and changed owner authority for external verified grants', async () => {
    const f = await fixture('goal-step', true)
    const direct = await f.execute('action_github_commit', { grantId: 'verified', idempotencyKey: 'direct', expectedHeadOid: oid, headline: 'No', files: [{ path: 'artifacts/release.txt', content: 'unverified' }] })
    expect(direct.isError).toBe(true); expect(f.commit).not.toHaveBeenCalled()
    f.goals.inspectOwnerGoalExecution.mockReturnValue(stepEvidence())
    await f.execute('action_github_deliver', { grantId: 'verified', idempotencyKey: 'changed', expectedHeadOid: oid, headline: 'Deliver', paths: ['artifacts/release.txt'] })
    f.changeReceipt(); (f.ctx.emit as any)('assistant-verifier/receipt', { taskKind: 'goal-step' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.commit).not.toHaveBeenCalled(); expect(f.notifications).not.toHaveBeenCalled()
  })

})
