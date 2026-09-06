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
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantGoalsService } from '../src/service.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function harness(databasePath?: string, maxContextChars?: number, duringGoalChange?: (agent: Agent) => void) {
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
  const plugin = await ctx.plugin(AssistantGoalsService, { databasePath: path, ...(maxContextChars === undefined ? {} : { maxContextChars }) })
  const create = async (id: string, owner?: string) => {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: root, agentPreset: 'primary' }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    if (owner !== undefined) owners.set(handle.agent, owner)
    cleanups.push(() => handle.dispose())
    return handle.agent
  }
  return { ctx, root, path, plugin, owners, human, create, deny() { allowed = false }, denyAction(action: string) { deniedActions.add(action) }, service: ctx.assistantGoals }
}
const checkpoint = { nextStep: 'Check repository state', blockers: [], assumptions: [{ statement: 'Latest build was green', expiresAt: 0 }], evidenceRefs: ['run:one'], dependencies: [] }

describe('owner-scoped native goal context', () => {
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
})
