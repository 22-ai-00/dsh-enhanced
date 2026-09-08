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
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantActionsService } from '../src/service.ts'
import type { ActionGrant } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const oid = 'a'.repeat(40)
async function fixture(acceptance?: 'goal-step') {
  const root = await mkdtemp(join(tmpdir(), 'verified-delivery-service-')); const ctx = new Context(); const id = SessionId('owner-session')
  await writeFile(join(root, 'secret'), 'fixture-secret', { mode: 0o600 })
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd: root, agentPreset: 'primary' })
  const agent: Agent = { id, options: { provider: 'test', model: 'test' }, session, inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }), ctx: undefined as unknown as Context, status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
  ;(agent as any).ctx = createScope(ctx, agent).ctx; session.append('turn/start', { turn: 1 }); session.append('approval/policy', { policy: 'ask' })
  const grant: ActionGrant = { id: 'verified', revision: 1, principalDigest: createHash('sha256').update('owner').digest('hex'), principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary', repository: 'owner/repository', branch: 'fix', paths: ['artifacts/release.txt'], credentialHandle: 'github', expiresAt: Date.now() + 60_000, maxActions: 4, maxTotalBytes: 100_000, repoWorkflow: { baseBranch: 'main', allowBranchCreate: true, allowPullRequest: true }, verifiedDelivery: { ownerRouteId: 'route', budgetId: 'budget', ...(acceptance ? { acceptance } : {}) } }
  const agents = new Map<string, Agent>([[id, agent]]); let route = { principalRecordId: 'record', principalVersion: 1, bindingVersion: 1, generation: 1 }; let receiptVersion = 1
  const verifiedSnapshot = { protocol: 'assistant-goals/verified-artifacts/v1', acceptance: { validUntil: Date.now() + 30_000 }, files: [{ path: 'artifacts/release.txt', content: 'verified source', sha256: 'b'.repeat(64), jobId: 'job' }] }
  const snapshot = () => structuredClone(verifiedSnapshot)
  const goals = { taskContext: () => ({ goal: { id: 'goal' } }), inspectWorkflowRunContext: () => ({ goalId: 'goal', goalExecutionRunId: 'run', definition: { digest: 'd'.repeat(64), version: 1 } }), inspectOwnerGoalExecution: vi.fn((): any => ({ storedGoal: { definition: { digest: 'd'.repeat(64), version: 1 }, nativeAtLastObservation: { phase: 'complete' } }, outcome: { status: 'achieved' } })), inspectOwnerVerifiedArtifacts: vi.fn(() => snapshot()), inspectOwnerAcceptedStepArtifacts: vi.fn(() => ({ ...snapshot(), protocol: 'assistant-goals/accepted-step-artifacts/v1' })) }
  const executors: any[] = [], reconciles: any[] = []; const automations = { registerHostExecutor: (executor: any) => { executors.push(executor); return () => {} }, reconcileSystem: (input: any) => { reconciles.push(input); return { definition: input.definition } } }
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), toolDefaultEffect: 'allow', rules: [
    { id: 'agent', effect: 'allow', subject: { kind: 'agent', id: 'primary' }, actions: ['execute'], resource: { kind: 'tool', id: 'action:github:verified' } },
    { id: 'background', effect: 'allow', subject: { kind: 'background', id: 'dsh-enhanced-assistant-actions' }, actions: ['execute'], resource: { kind: 'tool', id: 'action:github:verified' } },
    { id: 'credential', effect: 'allow', subject: { kind: 'background', id: 'dsh-enhanced-assistant-actions' }, actions: ['credential.use'], resource: { kind: 'credential', id: 'github' } },
  ] })
  await ctx.plugin(CredentialsKeychainService, { databasePath: join(root, 'credentials.sqlite'), handles: [{ id: 'github', provider: 'linux-protected-file', path: join(root, 'secret'), consumers: ['dsh-enhanced-assistant-actions'], purposes: ['github.commit'], maxLeaseMs: 30_000 }] })
  ctx.provide('agents' as never, { get: (key: string) => agents.get(key) } as never)
  const notifications = vi.fn()
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: () => ({ principalId: 'owner', principalLineage: { principalRecordId: 'record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' }, bindingVersion: 1, bindingGeneration: 1 }), validateOwnerRoute: () => ({ ...route, receiptVersion }), enqueueOwnerNotification: notifications } as never)
  ctx.provide('assistantVerifier' as never, {} as never); ctx.provide('assistantGoals' as never, goals as never); ctx.provide('assistantAutomations' as never, automations as never)
  const commit = vi.fn(async input => ({ actionId: input.actionId, status: 'succeeded' as const, commitOid: 'c'.repeat(40) })); const pullRequest = vi.fn(async input => ({ actionId: input.actionId, status: 'succeeded' as const, pullRequestNumber: 7 }))
  let service!: AssistantActionsService
  const plugin = await ctx.plugin({ name: 'dsh-enhanced-assistant-actions', apply(runtime: Context) { service = new AssistantActionsService(runtime, { stateRoot: join(root, 'actions'), grants: [grant] }, commit, { branch: vi.fn(), pullRequest, inspect: vi.fn() } as any) } })
  const execute = (name: string, args: any) => ctx.tools.execute({ callId: ToolCallId(`${name}-${Math.random()}`), name, arguments: args, signal: new AbortController().signal, agent })
  const activate = async (event = 'goal/changed') => { (ctx.emit as any)(event, { taskKind: 'goal-step' }); await new Promise(resolve => setTimeout(resolve, 0)); const active = reconciles.find(entry => entry.desiredStatus === 'active'); return executors[0].execute({ occurrenceId: 'o', automationId: active.automationId, definitionHash: createHash('sha256').update(JSON.stringify(active.definition)).digest('hex'), executionMode: 'production', targetScope: { workspace: root, preset: 'primary' }, principal: 'owner', ownerRouteId: 'route', activationNonce: active.automationId, catalogDigest: executors[0].descriptor.catalogDigest, signal: new AbortController().signal }) }
  cleanups.push(async () => { await plugin.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return { ctx, agent, agents, goals, executors, reconciles, grant, commit, pullRequest, notifications, execute, activate, prepare: (input: any) => service.prepareVerifiedDelivery(agent, input), revokeRoute: () => { route = { ...route, bindingVersion: 2 } }, changeReceipt: () => { receiptVersion++ } }
}

describe('verified delivery Actions service', () => {
  it('registers through the real tool/ledger, then host commits and opens a PR after the Agent disappears', async () => {
    const f = await fixture(); const delivery = { grantId: 'verified', idempotencyKey: 'delivery', expectedHeadOid: oid, headline: 'Deliver verified', paths: ['artifacts/release.txt'], pullRequest: { title: 'PR', body: 'body' } }
    const queued: any = await f.execute('action_github_deliver', delivery)
    expect(queued.isError, JSON.stringify(queued)).toBe(false); f.agents.clear(); expect((await f.activate()).outcome).toBe('succeeded')
    expect(f.commit).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ files: [{ path: 'artifacts/release.txt', content: 'verified source' }] }) })); expect(f.pullRequest).toHaveBeenCalledTimes(1)
    expect(f.notifications).toHaveBeenCalledWith(expect.objectContaining({ ownerRouteId: 'route', sessionId: 'owner-session', text: expect.stringContaining('c'.repeat(40)) }))
    expect(f.notifications.mock.calls[0]?.[0].text).toContain('#7')
  })

  it('uses explicit step acceptance to commit and open a PR while the original goal remains paused and unachieved', async () => {
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
})
