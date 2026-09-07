import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import GoalService from '@deepseek-ai/dsh-goal'
import { LlmRuntime, LlmAdapter, createUserMessage, type StreamChunk, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantGoalsService } from '../src/service.ts'
import { GoalExecutionStore } from '../src/execution-store.ts'
import { acceptanceDigest, createTaskAcceptanceContract, createTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import { AssistantVerifierService, createVerifierAuthorities } from '@dsh-enhanced/assistant-verifier'
import type { AcceptanceProfile } from '@dsh-enhanced/assistant-verifier'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function harness(databasePath?: string, maxContextChars?: number, duringGoalChange?: (agent: Agent) => void, verifyNativeRounds = false, verifyGoalOutcome = false, stepMaxDurationMs?: number) {
  const root = await mkdtemp(join(tmpdir(), 'business-goals-'))
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); new SessionProjectionRegistry(ctx)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, persona: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(GoalService)
  const owners = new Map<Agent, string>(); const human = new Set<Agent>(); let allowed = true; const deniedActions = new Set<string>()
  const attestation = (agent: Agent) => {
    const principalId = owners.get(agent)
    return principalId === undefined ? undefined : { scope: { workspace: root, preset: 'primary' }, principalId,
      principalLineage: { principalRecordId: `record-${principalId}`, principalVersion: 1 }, sessionId: String(agent.session.id) }
  }
  // Unit seam only. Actual Delivery owner/turn handling is covered separately
  // in assistant-delivery's real runtime integration test.
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: attestation,
    currentPreferenceTurn: (agent: Agent) => human.has(agent) ? attestation(agent) : undefined } as never)
  ctx.provide('assistantPolicy' as never, { authorizeAgent: (_agent: Agent, action: string) => ({ effect: allowed && !deniedActions.has(action) ? 'allow' : 'deny' }) } as never)
  if (duringGoalChange !== undefined) ctx.on('goal/changed', ({ agent }) => duringGoalChange(agent))
  const path = databasePath ?? join(root, 'goals.sqlite')
  const plugin = await ctx.plugin(AssistantGoalsService, { databasePath: path, verifyNativeRounds, verifyGoalOutcome,
    ...(maxContextChars === undefined ? {} : { maxContextChars }), ...(stepMaxDurationMs === undefined ? {} : { stepMaxDurationMs }) })
  const create = async (id: string, owner?: string) => {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: root, agentPreset: 'primary' }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    if (owner !== undefined) owners.set(handle.agent, owner)
    cleanups.push(() => handle.dispose())
    return handle.agent
  }
  return { ctx, root, path, plugin, owners, human, create, deny() { allowed = false }, denyAction(action: string) { deniedActions.add(action) }, service: ctx.assistantGoals }
}
const documentAuthority = { kind: 'document' as const, id: 'sources', sources: [{ id: 'source', url: 'https://example.org/source' }], timeoutMs: 1_000, maxResponseBytes: 1_024 }
const [compiledDocumentAuthority] = createVerifierAuthorities({ authorities: [documentAuthority] })
function goalProfiles(root: string, objective: string, options: { version?: number; validityMs?: number; wholeRequiredText?: string; scope?: AcceptanceProfile['scope']; owner?: AcceptanceProfile['owner'] } = {}) {
  const criteria = (id: string, requiredText: string) => [{ id, kind: 'document-citations' as const,
    authority: { id: 'sources', digest: compiledDocumentAuthority!.digest }, artifactPath: 'report.md', requiredText: [requiredText], quotes: [] }]
  const profiles: AcceptanceProfile[] = [
    { id: 'goal-step-profile', version: options.version ?? 1, scope: options.scope ?? { workspace: root, preset: 'primary' }, owner: options.owner ?? { principalRecordId: 'record-owner', principalVersion: 1 },
      taskKind: 'goal-step', objective, validityMs: options.validityMs ?? 10_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 }, criteria: criteria('step', 'Step verified') },
    { id: 'goal-outcome-profile', version: options.version ?? 1, scope: options.scope ?? { workspace: root, preset: 'primary' }, owner: options.owner ?? { principalRecordId: 'record-owner', principalVersion: 1 },
      taskKind: 'goal-outcome', objective, validityMs: options.validityMs ?? 10_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 }, criteria: criteria('whole', options.wholeRequiredText ?? 'Goal verified') },
  ]
  return profiles
}
async function installGoalVerifier(f: Awaited<ReturnType<typeof harness>>, profiles: AcceptanceProfile[]) {
  const plugin = await f.ctx.plugin(AssistantVerifierService, { databasePath: `${f.path}.verifier`, tickIntervalMs: 0, requireAcceptance: true,
    authorities: [documentAuthority], profiles })
  return { dispose: () => plugin.dispose(), service: f.ctx.assistantVerifier }
}
const checkpoint = { nextStep: 'Check repository state', blockers: [], assumptions: [{ statement: 'Latest build was green', expiresAt: 0 }], evidenceRefs: ['run:one'], dependencies: [] }

describe('owner-scoped native goal context', () => {
  it('returns only the current active owner-scoped task projection and refreshes edits', async () => {
    const f = await harness(); const agent = await f.create('task-context', 'owner'); f.human.add(agent)
    const created = f.service.create(agent, 'Original current objective')
    expect(f.service.taskContext(agent)).toMatchObject({ protocol: 'goal-task-context/v1', active: true,
      scope: created.scope, goal: { id: created.id, definition: { version: created.definition.version, digest: created.definition.digest }, native: { goalId: created.native.goalId }, objective: 'Original current objective' }, checkpoint: { nextStep: '' } })
    const checkpointed = f.service.checkpoint(agent, created.id, created.version, { ...checkpoint, nextStep: 'Inspect the changed source' })
    const edited = f.service.control(agent, { goalId: created.id, expectedRevision: checkpointed.native.revision, operation: 'edit', objective: 'Edited current objective' })
    expect(f.service.taskContext(agent)).toMatchObject({ goal: { id: edited.id, definition: { version: edited.definition.version, digest: edited.definition.digest }, native: { revision: edited.native.revision }, objective: 'Edited current objective' }, checkpoint: { nextStep: 'Inspect the changed source' } })
    const other = await f.create('task-context-other', 'other')
    expect(f.service.taskContext(other)).toBeUndefined()
    f.owners.delete(agent)
    expect(f.service.taskContext(agent)).toBeUndefined()
    f.owners.set(agent, 'owner')
    expect(f.service.taskContext(agent)?.goal.id).toBe(edited.id)
    f.ctx.goals.complete(agent, { id: edited.native.goalId as never, revision: edited.native.revision })
    expect(f.service.taskContext(agent)).toBeUndefined()
  })

  it('uses an explicit same-owner focus as retrieval context but hides it when snapshot authority is revoked', async () => {
    const f = await harness(); const first = await f.create('task-focus-first', 'owner'); const second = await f.create('task-focus-second', 'owner')
    f.human.add(first); const record = f.service.create(first, 'Focused owner objective')
    const saved = f.service.checkpoint(first, record.id, record.version, { ...checkpoint, nextStep: 'Use focused next step' })
    f.service.focus(second, saved.id)
    expect(f.service.taskContext(second)).toMatchObject({ active: true, goal: { id: saved.id, definition: { version: saved.definition.version, digest: saved.definition.digest } }, checkpoint: { nextStep: 'Use focused next step' } })
    f.denyAction('snapshot')
    expect(f.service.taskContext(second)).toBeUndefined()
  })

  it('drops a previously achieved feedback result when the Host verifier is unloaded', async () => {
    const f = await harness(undefined, undefined, undefined, true)
    const agent = await f.create('feedback-unload', 'owner'); f.human.add(agent)
    const record = f.service.create(agent, 'Check independent evidence')
    const now = Date.now()
    const task = { kind: 'goal-step' as const, ref: 'feedback-run', goal: { id: record.id,
      definitionVersion: record.definition.version, definitionDigest: record.definition.digest,
      stepId: 'round-1', runId: 'feedback-run', sessionId: record.native.sessionId,
      nativeGoalId: record.native.goalId, nativeRevision: record.native.revision } }
    const contract = createTaskAcceptanceContract({ protocol: 'task-acceptance/v2', id: 'feedback-contract', task,
      objective: record.definition.objective, scope: { workspace: f.root, preset: 'primary' },
      owner: { principalRecordId: record.scope.principalRecordId, principalVersion: record.scope.principalVersion },
      profile: { id: 'feedback-profile', version: 1, digest: 'a'.repeat(64) }, issuedAt: now, expiresAt: now + 60_000,
      criteria: [{ id: 'result', kind: 'document-citations', authority: { id: 'source', digest: 'a'.repeat(64) }, artifactPath: 'report.md', requiredText: ['Done'], quotes: [] }],
      bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 } })
    const execution = { status: 'succeeded' as const, quiescent: true, completedAt: now }
    const store = new GoalExecutionStore(`${f.path}.executions`)
    try {
      store.prepare({ runId: task.ref, task, scope: record.scope, objective: record.definition.objective,
        admission: { issuedAt: now, expiresAt: now + 60_000, maxGoalRounds: 3, round: 1,
          authorizationDigest: acceptanceDigest({ scope: record.scope, action: 'execute', resource: { kind: 'goal', id: 'business-context' } }) } })
      store.bindAcceptance(task.ref, { contractId: contract.id, contractDigest: contract.digest })
      store.markDispatched(task.ref, now); store.finish(task.ref, execution)
    } finally { store.close() }
    const receipt = createTaskVerificationReceipt(contract, { protocol: 'task-verification/v2', id: 'feedback-receipt',
      contractId: contract.id, contractDigest: contract.digest, scope: contract.scope, owner: contract.owner, task,
      results: [{ criterionId: 'result', status: 'passed', reason: 'verified', evidence: [] }],
      startedAt: now, completedAt: now, validUntil: now + 60_000 })
    // Read-only Host seam; the real producer/Verifier path is tested in Delivery.
    const verifier = await f.ctx.plugin((ctx: Context) => {
      ctx.provide('assistantVerifier', { inspectAcceptedTask: () => ({ contract, receipt, execution: { ...execution, executionRef: task.ref } }) } as never)
    })
    expect(f.service.describeForAgent(agent, record.id)).toContain('"status":"achieved"')
    await verifier.dispose()
    expect(f.service.describeForAgent(agent, record.id)).toContain('"status":"unavailable"')
    expect(f.service.snapshot(agent)).not.toContain('"status":"achieved"')
  })

  it('scopes feedback inspection and refreshes authorization after asynchronous prompt assembly', async () => {
    const f = await harness(undefined, undefined, undefined, true)
    const agent = await f.create('feedback-owner', 'owner'); f.human.add(agent)
    const record = f.service.create(agent, 'Private feedback objective')
    expect(f.service.describeForAgent(agent, record.id)).toContain('assistant-goals/feedback/v1')
    const other = await f.create('feedback-other', 'other')
    expect(() => f.service.describeForAgent(other, record.id)).toThrow('goal not found')
    expect(() => f.service.describeForAgent({ ...agent } as Agent, record.id)).toThrow('exact live agent')
    f.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const result = await next()
      f.owners.delete(agent)
      return result
    })
    const assembly = await f.ctx.systemPrompt.assemble({ agent })
    expect(assembly.contexts.find(item => item.name === 'assistant-goals:current-context')?.text).toBe('')
    expect(JSON.stringify(assembly.contexts)).not.toContain('Private feedback objective')
  })

  it('binds only newly created goals in a current owner turn; never adopts old unbound goals', async () => {
    const f = await harness(); const agent = await f.create('unowned')
    f.ctx.goals.create(agent, { objective: 'Private old goal' })
    f.owners.set(agent, 'owner'); f.human.add(agent)
    expect(f.service.list(agent)).toEqual([])
    const old = f.ctx.goals.get(agent)!
    f.ctx.goals.edit(agent, old, { objective: 'Do not retroactively adopt' })
    expect(f.service.list(agent)).toEqual([])
    f.ctx.goals.clear(agent, f.ctx.goals.get(agent)!)
    f.ctx.goals.create(agent, { objective: 'New owner-authorized goal' })
    expect(f.service.list(agent)).toHaveLength(1)
    expect(() => f.service.list({ ...agent } as Agent)).toThrow('exact live agent')
  })

  it('creates through the owner bridge only in the current human turn and preserves native exclusivity', async () => {
    const f = await harness(); const agent = await f.create('bridge', 'owner')
    expect(() => f.service.create(agent, 'Requested objective', 2)).toThrow('current authenticated owner turn')
    expect(f.ctx.goals.get(agent)).toBeUndefined()
    f.human.add(agent)
    const record = f.service.create(agent, 'Requested objective', 2)
    expect(record.native).toMatchObject({ objective: 'Requested objective', maxGoalRounds: 2 })
    expect(f.ctx.goals.get(agent)?.id).toBe(record.native.goalId)
    expect(() => f.service.create(agent, 'Do not replace the first goal')).toThrow()
    f.ctx.goals.complete(agent, f.ctx.goals.get(agent)!)
    const next = f.service.create(agent, 'A new native goal after completion', 2)
    expect(next.id).not.toBe(record.id)
    expect(f.service.list(agent)).toHaveLength(2)
    expect(f.service.inspect(agent, record.id)).toMatchObject({ originalObjective: 'Requested objective', native: { phase: 'complete' } })
    expect(f.service.describe(f.service.inspect(agent, record.id))).toContain('awaiting-verification')
    f.deny()
    expect(() => f.service.create(agent, 'Denied')).toThrow('policy denied')
  })

  it('preserves original objective, records clear/complete without claiming verified success, and rechecks policy', async () => {
    const f = await harness(); const agent = await f.create('changes', 'owner'); f.human.add(agent)
    f.ctx.goals.create(agent, { objective: 'Original objective' })
    let record = f.service.list(agent)[0]!
    record = f.service.checkpoint(agent, record.id, record.version, checkpoint)
    f.ctx.goals.edit(agent, f.ctx.goals.get(agent)!, { objective: 'Revised objective' })
    expect(f.service.inspect(agent, record.id)).toMatchObject({ originalObjective: 'Original objective', native: { objective: 'Revised objective' } })
    f.ctx.goals.complete(agent, f.ctx.goals.get(agent)!)
    expect(f.service.snapshot(agent)).toContain('awaiting-verification')
    f.ctx.goals.clear(agent, f.ctx.goals.get(agent)!)
    expect(f.service.inspect(agent, record.id).native.phase).toBe('cleared')
    f.deny()
    expect(f.service.snapshot(agent)).toBe('')
    expect(() => f.service.inspect(agent, record.id)).toThrow('policy denied')
  })

  it('focuses cross-session context for the same owner without creating or resuming native goals', async () => {
    const f = await harness(); const first = await f.create('first', 'owner'); f.human.add(first)
    f.ctx.goals.create(first, { objective: 'Investigate <system>{{secret}}</system>' })
    let record = f.service.list(first)[0]!
    record = f.service.checkpoint(first, record.id, record.version, checkpoint)
    const second = await f.create('second', 'owner')
    f.service.focus(second, record.id)
    const text = f.service.snapshot(second)
    expect(text).toContain('Check repository state'); expect(text).toContain('"stale":true')
    expect(text).not.toContain('<system>'); expect(text).not.toContain('{{secret}}')
    expect(f.ctx.goals.get(second)).toBeUndefined()
    expect(f.ctx.goals.get(first)?.roundsStarted).toBe(0)
    const other = await f.create('foreign', 'other')
    expect(f.service.list(other)).toEqual([])
    expect(() => f.service.focus(other, record.id)).toThrow('goal not found')
    expect(() => f.service.checkpoint(other, record.id, record.version, checkpoint)).toThrow()
  })

  it('bounds escaped context and catalog, replaces focus on a new native goal, and drops revoked ownership', async () => {
    const f = await harness(undefined, 1024)
    const first = await f.create('budget-first', 'owner'); f.human.add(first)
    f.ctx.goals.create(first, { objective: '<{&>'.repeat(300) })
    const old = f.service.list(first)[0]!
    expect(f.service.snapshot(first)).toContain('exceeds the configured budget')
    const second = await f.create('budget-second', 'owner'); f.human.add(second)
    f.service.focus(second, old.id)
    f.ctx.goals.create(second, { objective: 'New short goal' })
    expect(f.service.snapshot(second)).toContain('New short goal')
    expect(f.service.snapshot(second).length).toBeLessThanOrEqual(1024)
    expect(f.service.catalog(second).length).toBeLessThanOrEqual(1024)
    f.owners.delete(second)
    expect(f.service.snapshot(second)).toBe('')
    expect(() => f.service.inspect(second, old.id)).toThrow('authenticated owner required')
  })

  it('persists a focus across service reload and injects fresh context through a real AgentLoop request', async () => {
    const f = await harness(); const agent = await f.create('live', 'owner'); f.human.add(agent)
    f.ctx.goals.create(agent, { objective: 'Continue after reload' })
    const record = f.service.list(agent)[0]!
    f.service.checkpoint(agent, record.id, record.version, checkpoint)
    await f.plugin.dispose()
    await f.ctx.plugin(AssistantGoalsService, { databasePath: f.path })
    const requests: GenerateOptions[] = []
    class Adapter extends LlmAdapter { async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'Working' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Working' } }; yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    f.ctx.llm.registerAdapter(['fixture'], new Adapter())
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the goal' }] }))
    await agent.whenIdle()
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0]!.messages)).toContain('Check repository state')
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && JSON.stringify(event.data).includes('Check repository state'))).toBe(true)
    expect(f.ctx.assistantGoals.snapshot(agent)).toContain('Continue after reload')
  })

  it('controls only the current session binding through native CAS and retains business history', async () => {
    const f = await harness(); const first = await f.create('control-first', 'owner'); f.human.add(first)
    f.ctx.goals.create(first, { objective: 'Original control objective', maxGoalRounds: 3 })
    let record = f.service.list(first)[0]!
    record = f.service.checkpoint(first, record.id, record.version, checkpoint)
    const edited = f.service.control(first, { goalId: record.id, expectedRevision: record.native.revision, operation: 'edit', objective: 'Edited control objective' })
    expect(edited).toMatchObject({ originalObjective: 'Original control objective', checkpoint, native: { objective: 'Edited control objective', phase: 'active' } })
    const paused = f.service.control(first, { goalId: record.id, expectedRevision: edited.native.revision, operation: 'pause' })
    expect(paused.native.phase).toBe('paused')
    const resumed = f.service.control(first, { goalId: record.id, expectedRevision: paused.native.revision, operation: 'resume' })
    expect(resumed.native).toMatchObject({ phase: 'active', revision: paused.native.revision + 1 })
    const beforeStale = f.ctx.goals.get(first)!
    expect(() => f.service.control(first, { goalId: record.id, expectedRevision: paused.native.revision, operation: 'pause' })).toThrow()
    expect(f.ctx.goals.get(first)).toEqual(beforeStale)
    const second = await f.create('control-second', 'owner'); f.human.add(second)
    f.service.focus(second, record.id)
    expect(() => f.service.control(second, { goalId: record.id, expectedRevision: resumed.native.revision, operation: 'clear' })).toThrow('current session')
    expect(f.ctx.goals.get(first)).toMatchObject({ id: resumed.native.goalId, revision: resumed.native.revision })
    const cleared = f.service.control(first, { goalId: record.id, expectedRevision: resumed.native.revision, operation: 'clear' })
    expect(cleared.native.phase).toBe('cleared')
    expect(f.ctx.goals.get(first)).toBeUndefined()
    await f.plugin.dispose()
    await f.ctx.plugin(AssistantGoalsService, { databasePath: f.path })
    expect(f.ctx.assistantGoals.inspect(first, record.id).native.phase).toBe('cleared')
  })

  it('requires the live owner turn and per-operation policy before control CAS', async () => {
    const f = await harness(); const agent = await f.create('control-guard', 'owner')
    f.human.add(agent); f.ctx.goals.create(agent, { objective: 'Guarded goal' })
    const record = f.service.list(agent)[0]!
    f.human.delete(agent)
    expect(() => f.service.control(agent, { goalId: record.id, expectedRevision: record.native.revision, operation: 'pause' })).toThrow('current authenticated owner turn')
    expect(f.ctx.goals.get(agent)?.phase).toBe('active')
    f.human.add(agent); f.denyAction('pause')
    expect(() => f.service.control(agent, { goalId: record.id, expectedRevision: record.native.revision, operation: 'pause' })).toThrow('policy denied')
    expect(f.ctx.goals.get(agent)?.phase).toBe('active')
    f.owners.delete(agent)
    expect(() => f.service.control(agent, { goalId: record.id, expectedRevision: record.native.revision, operation: 'pause' })).toThrow('authenticated owner required')
  })

  it('rejects malformed direct control input before native mutation', async () => {
    const f = await harness(); const agent = await f.create('control-input', 'owner'); f.human.add(agent)
    f.ctx.goals.create(agent, { objective: 'Input goal' })
    const record = f.service.list(agent)[0]!
    expect(() => f.service.control(agent, { goalId: record.id, expectedRevision: record.native.revision, operation: 'edit' })).toThrow('invalid control input')
    expect(() => f.service.control(agent, { goalId: record.id, expectedRevision: record.native.revision, operation: 'pause', objective: 'nope' } as never)).toThrow('invalid control input')
    expect(() => f.service.control(agent, { goalId: record.id, expectedRevision: 0, operation: 'pause' })).toThrow('invalid control input')
    expect(f.ctx.goals.get(agent)).toMatchObject({ id: record.native.goalId, revision: record.native.revision, phase: 'active' })
  })

  it('reports a partial commit when owner revocation prevents the native change from being projected', async () => {
    let revoke = false
    let f!: Awaited<ReturnType<typeof harness>>
    f = await harness(undefined, undefined, agent => { if (revoke) f.owners.delete(agent) })
    const agent = await f.create('control-partial', 'owner'); f.human.add(agent)
    f.ctx.goals.create(agent, { objective: 'Projection failure goal' })
    const record = f.service.list(agent)[0]!
    revoke = true
    expect(() => f.service.control(agent, { goalId: record.id, expectedRevision: record.native.revision, operation: 'pause' }))
      .toThrow('native goal changed but business context could not be read back')
    expect(f.ctx.goals.get(agent)).toMatchObject({ id: record.native.goalId, phase: 'paused', revision: record.native.revision + 1 })
  })

  it('does not return projected goal data when a later native listener revokes the owner', async () => {
    const f = await harness(); const agent = await f.create('control-late-revocation', 'owner'); f.human.add(agent)
    f.ctx.goals.create(agent, { objective: 'Late revocation goal' })
    const record = f.service.list(agent)[0]!
    f.ctx.on('goal/changed', ({ agent: changed }) => { if (changed === agent) f.owners.delete(agent) })
    expect(() => f.service.control(agent, { goalId: record.id, expectedRevision: record.native.revision, operation: 'pause' }))
      .toThrow('native goal changed but business context could not be read back')
    expect(f.ctx.goals.get(agent)).toMatchObject({ id: record.native.goalId, phase: 'paused', revision: record.native.revision + 1 })
    f.owners.set(agent, 'owner')
    expect(f.service.inspect(agent, record.id).native.phase).toBe('paused')
  })

  it('normalizes control input before synchronous native change listeners can mutate the caller object', async () => {
    let mutate = false
    const input = { goalId: '', expectedRevision: 0, operation: 'pause' as const }
    const f = await harness(undefined, undefined, () => { if (mutate) input.expectedRevision = 999 })
    const agent = await f.create('control-snapshot', 'owner'); f.human.add(agent)
    f.ctx.goals.create(agent, { objective: 'Snapshot goal' })
    const record = f.service.list(agent)[0]!
    input.goalId = record.id; input.expectedRevision = record.native.revision
    mutate = true
    const paused = f.service.control(agent, input)
    expect(paused.native).toMatchObject({ phase: 'paused', revision: record.native.revision + 1 })
    expect(input.expectedRevision).toBe(999)
  })

  it('rejects goal creation before native, business, or verifier state exists when whole-goal preflight is incomplete or mismatched', async () => {
    const assertUnchanged = (f: Awaited<ReturnType<typeof harness>>, agent: Agent, verifier?: { service: AssistantVerifierService }) => {
      expect(f.ctx.goals.get(agent)).toBeUndefined()
      expect(f.service.list(agent)).toEqual([])
      if (verifier !== undefined) {
        expect(verifier.service.health()).toMatchObject({ awaitingExecution: 0, pendingVerification: 0, pendingReceipts: 0 })
        const db = new DatabaseSync(`${f.path}.verifier`, { readOnly: true })
        try { expect(db.prepare('SELECT id FROM acceptance_contracts').all()).toEqual([]) } finally { db.close() }
      }
    }
    const absent = await harness(undefined, undefined, undefined, true, true, 1_000)
    const absentAgent = await absent.create('preflight-absent', 'owner'); absent.human.add(absentAgent)
    expect(() => absent.service.create(absentAgent, 'No verifier')).toThrow('whole-goal verifier unavailable')
    assertUnchanged(absent, absentAgent)

    for (const [id, profiles, objective] of [
      ['missing-step', goalProfiles('', 'Missing step').filter(profile => profile.taskKind === 'goal-outcome'), 'Missing step'],
      ['missing-whole', goalProfiles('', 'Missing whole').filter(profile => profile.taskKind === 'goal-step'), 'Missing whole'],
      ['wrong-owner', goalProfiles('', 'Wrong owner', { owner: { principalRecordId: 'record-other', principalVersion: 1 } }), 'Wrong owner'],
      ['wrong-scope', goalProfiles('', 'Wrong scope', { scope: { workspace: '/tmp/foreign-goal-scope', preset: 'primary' } }), 'Wrong scope'],
      ['wrong-objective', goalProfiles('', 'Other objective'), 'Wanted objective'],
    ] as const) {
      const f = await harness(undefined, undefined, undefined, true, true, 1_000)
      const agent = await f.create(id, 'owner'); f.human.add(agent)
      const bound = profiles.map(profile => ({ ...profile, scope: profile.scope.workspace === '' ? { ...profile.scope, workspace: f.root } : profile.scope }))
      const verifier = await installGoalVerifier(f, bound)
      expect(() => f.service.create(agent, objective)).toThrow(/exact goal-step|whole-goal success specification/)
      assertUnchanged(f, agent, verifier)
    }
  })

  it('trims an objective for exact preflight selection and freezes whole-goal conditions before create returns', async () => {
    const f = await harness(undefined, undefined, undefined, true, true, 1_000)
    const agent = await f.create('preflight-trim', 'owner'); f.human.add(agent)
    await installGoalVerifier(f, goalProfiles(f.root, 'Trimmed objective'))
    const record = f.service.create(agent, '  Trimmed objective  ')
    expect(record.native.objective).toBe('Trimmed objective')
    expect(f.service.inspectGoalOutcome(agent, record.id)).toMatchObject({ definitionVersion: record.definition.version,
      conditions: { profileId: 'goal-outcome-profile', profileVersion: 1, criteria: expect.any(Array), expiresAt: expect.any(Number) } })
  })

  it('preflights objective edits without changing the old native revision or frozen definition, then freezes exact replacement profiles', async () => {
    const f = await harness(undefined, undefined, undefined, true, true, 1_000)
    const agent = await f.create('preflight-edit', 'owner'); f.human.add(agent)
    let verifier = await installGoalVerifier(f, goalProfiles(f.root, 'Initial objective'))
    const original = f.service.create(agent, 'Initial objective')
    const originalOutcome = f.service.inspectGoalOutcome(agent, original.id)!
    expect(() => f.service.control(agent, { goalId: original.id, expectedRevision: original.native.revision, operation: 'edit', objective: 'Unconfigured objective' }))
      .toThrow('exact goal-step')
    expect(f.ctx.goals.get(agent)).toMatchObject({ objective: 'Initial objective', revision: original.native.revision })
    expect(f.service.inspect(agent, original.id).definition).toEqual(original.definition)
    expect(f.service.inspectGoalOutcome(agent, original.id)?.conditions).toEqual(originalOutcome.conditions)

    await verifier.dispose()
    verifier = await installGoalVerifier(f, [...goalProfiles(f.root, 'Initial objective'), ...goalProfiles(f.root, 'Configured replacement', { version: 2 }).map(profile => ({ ...profile, id: `replacement-${profile.id}` }))])
    const updated = f.service.control(agent, { goalId: original.id, expectedRevision: original.native.revision, operation: 'edit', objective: 'Configured replacement' })
    expect(updated).toMatchObject({ native: { objective: 'Configured replacement', revision: original.native.revision + 1 }, definition: { version: original.definition.version + 1 } })
    expect(f.service.inspectGoalOutcome(agent, original.id)).toMatchObject({ definitionVersion: updated.definition.version,
      conditions: { profileId: 'replacement-goal-outcome-profile', profileVersion: 2 } })
    await verifier.dispose()
  })

  it('keeps frozen conditions for max-round edits and rejects reconfigured or expired conditions before native mutation', async () => {
    const f = await harness(undefined, undefined, undefined, true, true, 1_000)
    const agent = await f.create('preflight-frozen', 'owner'); f.human.add(agent)
    let verifier = await installGoalVerifier(f, goalProfiles(f.root, 'Frozen objective'))
    const created = f.service.create(agent, 'Frozen objective', 2)
    const frozen = f.service.inspectGoalOutcome(agent, created.id)!.conditions!
    let rounds = f.service.control(agent, { goalId: created.id, expectedRevision: created.native.revision, operation: 'edit', maxGoalRounds: 3 })
    expect(f.service.inspectGoalOutcome(agent, created.id)?.conditions).toEqual(frozen)

    // A new run can use a newly configured step profile; the whole-goal
    // specification and its absolute deadline remain the original template.
    await verifier.dispose()
    verifier = await installGoalVerifier(f, goalProfiles(f.root, 'Frozen objective').map(profile => profile.taskKind === 'goal-step'
      ? { ...profile, version: 2 } : profile))
    rounds = f.service.control(agent, { goalId: created.id, expectedRevision: rounds.native.revision, operation: 'edit', maxGoalRounds: 3 })
    expect(f.service.inspectGoalOutcome(agent, created.id)?.conditions).toEqual(frozen)

    await verifier.dispose()
    verifier = await installGoalVerifier(f, goalProfiles(f.root, 'Frozen objective', { version: 2, wholeRequiredText: 'Changed condition' }))
    expect(() => f.service.control(agent, { goalId: created.id, expectedRevision: rounds.native.revision, operation: 'edit', maxGoalRounds: 4 }))
      .toThrow('frozen success specification')
    expect(f.ctx.goals.get(agent)).toMatchObject({ revision: rounds.native.revision, maxGoalRounds: 3 })

    await verifier.dispose()
    verifier = await installGoalVerifier(f, goalProfiles(f.root, 'Frozen objective'))
    const now = vi.spyOn(Date, 'now').mockReturnValue(frozen.expiresAt - 3_000)
    try {
      expect(() => f.service.control(agent, { goalId: created.id, expectedRevision: rounds.native.revision, operation: 'edit', maxGoalRounds: 4 }))
        .toThrow('frozen whole-goal deadline')
    } finally { now.mockRestore() }
    expect(f.ctx.goals.get(agent)).toMatchObject({ revision: rounds.native.revision, maxGoalRounds: 3 })
    await verifier.dispose()

    const short = await harness(undefined, undefined, undefined, true, true, 1_000)
    const shortAgent = await short.create('preflight-short', 'owner'); short.human.add(shortAgent)
    const shortVerifier = await installGoalVerifier(short, goalProfiles(short.root, 'Short validity', { validityMs: 3_000 }))
    expect(() => short.service.create(shortAgent, 'Short validity')).toThrow('acceptance validity')
    expect(short.ctx.goals.get(shortAgent)).toBeUndefined()
    expect(short.service.list(shortAgent)).toEqual([])
    expect(shortVerifier.service.health()).toMatchObject({ awaitingExecution: 0, pendingVerification: 0, pendingReceipts: 0 })
  })
})
