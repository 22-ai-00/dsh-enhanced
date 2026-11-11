import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import GoalService from '@deepseek-ai/dsh-goal'
import { LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecution } from '@deepseek-ai/dsh-tools'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantGoalsService } from '../src/service.ts'
import { GoalOwnerIntentStore, goalOwnerIntentSupplier } from '../src/owner-intent-store.ts'
import { OWNER_INTENT_PROTOCOL, ownerIntentObjectiveSpan, validateGoalOwnerIntent } from '../src/owner-intent.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

interface FakeSupplier { provider: string; model: string; reasoningEffort?: string }
interface ProofState {
  text: string
  callId: string
  supplier: FakeSupplier
  supplierState: 'frozen' | 'missing' | 'inconsistent'
  available: boolean
  changeAfterReads: number | undefined
  changed: boolean
  reads: number
  inspects: number
  offsets: number[]
}
interface DeliveryState { root: string; owners: Map<Agent, string>; human: Set<Agent>; proof: ProofState }

function attestationFor(state: DeliveryState, agent: Agent, input: { callId: string; toolName: string; argumentsJson: string }) {
  const principal = state.owners.get(agent)
  if (!state.proof.available || principal === undefined || !state.human.has(agent) || input.callId !== state.proof.callId) return undefined
  return {
    protocol: 'assistant-delivery/foreground-tool-call/v1',
    task: { protocol: 'assistant-delivery/foreground-task/v1', inboxId: 'owner-inbox',
      sessionId: String(agent.session.id), scope: { workspace: state.root, preset: 'primary' },
      owner: { principalRecordId: `record-${principal}`, principalVersion: 1 },
      binding: { id: `binding_${String(agent.session.id)}`, version: 1, generation: 1 }, dispatchedAt: 1 },
    turn: state.proof.changed ? 2 : 1,
    call: { id: input.callId, toolName: input.toolName, eventSeq: 1, eventDigest: sha256('event'), argumentsDigest: sha256(input.argumentsJson) },
  }
}

async function harness(options: { ownerIntent?: boolean; databasePath?: string; legacyDelivery?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'owner-intent-'))
  const ctx = new Context()
  ctx.provide('workingDirectory' as never, { ensure: async () => root, set: async () => root } as never)
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); new SessionProjectionRegistry(ctx)
  await ctx.plugin(Loader, { baseUrl: import.meta.url })
  await ctx.loader.create({ name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: join(root, 'sessions'), compression: 'none' } })
  await ctx.loader.await()
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(GoalService)
  const owners = new Map<Agent, string>(); const human = new Set<Agent>()
  const proof: ProofState = { text: '', callId: 'real-call', supplier: { provider: 'fixture', model: 'fixture' }, supplierState: 'frozen',
    available: true, changeAfterReads: undefined, changed: false, reads: 0, inspects: 0, offsets: [] }
  const state: DeliveryState = { root, owners, human, proof }
  const principalFor = (agent: Agent) => {
    const principal = owners.get(agent)
    if (principal === undefined) return undefined
    return { scope: { workspace: root, preset: 'primary' }, principalId: principal,
      principalLineage: { principalRecordId: `record-${principal}`, principalVersion: 1 },
      bindingId: `binding_${String(agent.session.id)}`, bindingVersion: 1, bindingGeneration: 1, sessionId: String(agent.session.id) }
  }
  const inspectForAgent = (agent: Agent, input: { callId: string; toolName: string; argumentsJson: string }) => {
    proof.inspects += 1
    return attestationFor(state, agent, input)
  }
  const readForAgent = (agent: Agent, input: { callId: string; toolName: string; argumentsJson: string; offset?: number; maxBytes?: number }) => {
    const current = attestationFor(state, agent, input)
    if (current === undefined) return undefined
    const bytes = Buffer.from(proof.text, 'utf8')
    const offset = input.offset ?? 0, limit = input.maxBytes ?? 4096
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 4 || limit > 8192) throw new Error('invalid page')
    let end = Math.min(bytes.length, offset + limit)
    while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
    const fullTextDigest = sha256(proof.text)
    const modelSelection = proof.supplierState === 'frozen' ? proof.supplier : undefined
    const modelSelectionState = proof.supplierState
    const sourceDigest = sha256(JSON.stringify([String(agent.session.id), fullTextDigest, modelSelectionState, modelSelection ?? null]))
    proof.reads += 1; proof.offsets.push(offset)
    if (proof.changeAfterReads !== undefined && proof.reads > proof.changeAfterReads) proof.changed = true
    return { protocol: 'assistant-delivery/foreground-tool-input/v1', attestation: current, sourceDigest,
      modelSelectionState, ...(modelSelection === undefined ? {} : { modelSelection }),
      input: { text: bytes.subarray(offset, end).toString('utf8'), fullTextDigest, fullBytes: bytes.length,
        returnedBytes: end - offset, offset, ...(end < bytes.length ? { nextOffset: end } : {}) } }
  }
  const delivery = {
    preferencePrincipalForAgent: principalFor,
    currentPreferenceTurn: (agent: Agent) => human.has(agent) ? principalFor(agent) : undefined,
    ...(options.legacyDelivery === true ? {} : { inspectOwnerForegroundToolCallForAgent: inspectForAgent,
      readOwnerForegroundToolInputForAgent: readForAgent }),
  }
  ctx.provide('assistantDelivery' as never, delivery as never)
  ctx.provide('assistantPolicy' as never, { authorizeAgent: () => ({ effect: 'allow' }),
    evaluateAgent: () => ({ effect: 'allow' }) } as never)
  const path = options.databasePath ?? join(root, 'goals.sqlite')
  await ctx.plugin(AssistantGoalsService, { databasePath: path, ...(options.ownerIntent === true ? { ownerIntent: true } : {}) })
  const create = async (id: string, owner?: string) => {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: root, agentPreset: 'primary' }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    if (owner !== undefined) owners.set(handle.agent, owner)
    cleanups.push(() => handle.dispose())
    return handle.agent
  }
  return { ctx, root, path, owners, human, create, proof, service: ctx.assistantGoals }
}

function goalExecution(agent: Agent, objective: string, callId = 'real-call'): ToolExecution {
  return { callId: ToolCallId(callId), rootCallId: ToolCallId(callId), name: 'goal_create',
    arguments: { objective }, signal: new AbortController().signal, agent, token: Symbol(callId) as never }
}
const businessId = (agent: Agent, nativeGoalId: string) => createHash('sha256').update(String(agent.session.id)).update('\0').update(nativeGoalId).digest('hex')

describe('frozen authenticated owner intent', () => {
  it('binds one live goal_create call to the owner text, objective span, supplier and call identity', async () => {
    const f = await harness({ ownerIntent: true })
    const agent = await f.create('owner-intent-valid', 'owner'); f.human.add(agent)
    const ownerText = '请修复构建并把测试跑绿，不要改动 .github。'
    const objective = '修复构建并把测试跑绿'
    f.proof.text = ownerText
    const record = f.service.createFromOwnerIntent(goalExecution(agent, objective), objective, 2)
    const intent = f.service.ownerIntent(agent, record.id)!
    const start = ownerText.indexOf(objective)
    expect(intent).toMatchObject({
      protocol: OWNER_INTENT_PROTOCOL, text: ownerText, inputBytes: Buffer.byteLength(ownerText),
      inputSha256: sha256(ownerText), fullTextDigest: sha256(ownerText),
      objective: { text: objective, start, end: start + objective.length },
      owner: { principalRecordId: 'record-owner', principalVersion: 1 },
      scope: { workspace: f.root, preset: 'primary' }, sessionId: String(agent.session.id),
      binding: { id: `binding_${String(agent.session.id)}`, version: 1, generation: 1 },
      call: { id: 'real-call', toolName: 'goal_create' }, supplier: { provider: 'fixture', model: 'fixture' }, turn: 1,
    })
    expect(intent.sourceDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(intent.call.argumentsDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(intent.at).toBeGreaterThan(0)
    expect(Object.isFrozen(intent)).toBe(true)
    expect(Object.isFrozen(intent.objective)).toBe(true)
    expect(validateGoalOwnerIntent(intent)).toEqual(intent)
    expect(f.ctx.goals.get(agent)).toBeDefined()
    // Reopen the side ledger: row digests bind the exact intent and definition.
    const databasePath = `${f.path}.owner-intents`
    const reopened = new GoalOwnerIntentStore(databasePath)
    try { expect(reopened.get(record.id)).toEqual(intent) } finally { reopened.close() }
    const db = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const row = db.prepare('SELECT intent_digest, definition_digest FROM goal_owner_intents WHERE goal_id = ?').get(record.id) as { intent_digest: string; definition_digest: string }
      expect(row.definition_digest).toBe(record.definition.digest)
      expect(row.intent_digest).toBe(acceptanceDigest(intent))
    } finally { db.close() }
  })

  it('rejects a forged or unavailable foreground call before creating the native goal', async () => {
    const f = await harness({ ownerIntent: true })
    const agent = await f.create('owner-intent-forged', 'owner'); f.human.add(agent)
    f.proof.text = '修复构建'
    expect(() => f.service.createFromOwnerIntent(goalExecution(agent, '修复构建', 'forged-call'), '修复构建', 2))
      .toThrow('assistant-goals: owner intent proof is unavailable')
    expect(f.ctx.goals.get(agent)).toBeUndefined()
    expect(f.service.ownerIntent(agent, businessId(agent, 'missing'))).toBeUndefined()
  })

  it('rejects an objective that is not a verbatim quote of the authenticated owner text', async () => {
    const f = await harness({ ownerIntent: true })
    const agent = await f.create('owner-intent-paraphrase', 'owner'); f.human.add(agent)
    f.proof.text = '请审查这个补丁，不要改任何生产代码。'
    expect(() => f.service.createFromOwnerIntent(goalExecution(agent, '修复所有失败的测试'), '修复所有失败的测试', 2))
      .toThrow(/must quote the owner's original words verbatim/u)
    expect(f.ctx.goals.get(agent)).toBeUndefined()
    // The span helper itself never normalizes or trims the requested objective.
    expect(ownerIntentObjectiveSpan('abc def', 'abc')).toEqual({ start: 0, end: 3 })
    expect(() => ownerIntentObjectiveSpan('abc abc', ' abc ')).toThrow('trimmed')
    expect(() => ownerIntentObjectiveSpan('abcabc', 'abd')).toThrow(/original words verbatim/u)
  })

  it('reassembles a paginated owner text and keeps the full digest stable', async () => {
    const f = await harness({ ownerIntent: true })
    const agent = await f.create('owner-intent-pages', 'owner'); f.human.add(agent)
    const marker = '整理全部测试报告并核对数据'
    const ownerText = '开头'.repeat(900) + marker + '结尾'.repeat(900)
    f.proof.text = ownerText
    const record = f.service.createFromOwnerIntent(goalExecution(agent, marker), marker, 2)
    const intent = f.service.ownerIntent(agent, record.id)!
    expect(Buffer.byteLength(ownerText)).toBeGreaterThan(4096)
    expect(intent.text).toBe(ownerText)
    expect(intent.inputBytes).toBe(Buffer.byteLength(ownerText))
    expect(intent.inputSha256).toBe(sha256(ownerText))
    expect(intent.objective.start).toBe(ownerText.indexOf(marker))
    expect(f.proof.reads).toBeGreaterThanOrEqual(2)
    expect(f.proof.offsets[0]).toBe(0)
    for (let index = 1; index < f.proof.offsets.length; index++) expect(f.proof.offsets[index]!).toBeGreaterThan(f.proof.offsets[index - 1]!)
  })

  it('rejects a proof change in the middle of pagination', async () => {
    const f = await harness({ ownerIntent: true })
    const agent = await f.create('owner-intent-changing', 'owner'); f.human.add(agent)
    f.proof.text = '甲'.repeat(2000) + '修复构建'
    f.proof.changeAfterReads = 1
    expect(() => f.service.createFromOwnerIntent(goalExecution(agent, '修复构建'), '修复构建', 2))
      .toThrow(/owner intent proof changed during pagination/u)
    expect(f.ctx.goals.get(agent)).toBeUndefined()
  })

  it('rejects a non-frozen or malformed supplier', async () => {
    const inconsistent = await harness({ ownerIntent: true })
    const first = await inconsistent.create('owner-intent-supplier-state', 'owner'); inconsistent.human.add(first)
    inconsistent.proof.text = '修复构建'
    inconsistent.proof.supplierState = 'inconsistent'
    expect(() => inconsistent.service.createFromOwnerIntent(goalExecution(first, '修复构建'), '修复构建', 2))
      .toThrow(/owner intent human input supplier is not frozen/u)
    expect(inconsistent.ctx.goals.get(first)).toBeUndefined()

    const malformed = await harness({ ownerIntent: true })
    const second = await malformed.create('owner-intent-supplier-fields', 'owner'); malformed.human.add(second)
    malformed.proof.text = '修复构建'
    malformed.proof.supplier = { provider: 'fixture', model: 'fixture', reasoningEffort: 'high\u0001' }
    expect(() => malformed.service.createFromOwnerIntent(goalExecution(second, '修复构建'), '修复构建', 2))
      .toThrow(/owner intent human input supplier is not frozen/u)
    expect(malformed.ctx.goals.get(second)).toBeUndefined()
  })

  it('keeps the historical create path when owner intent is not configured', async () => {
    const f = await harness()
    const agent = await f.create('owner-intent-disabled', 'owner'); f.human.add(agent)
    const record = f.service.createFromOwnerIntent(goalExecution(agent, '记录当前行为'), '记录当前行为', 2)
    expect(record.definition.objective).toBe('记录当前行为')
    expect(f.ctx.goals.get(agent)).toBeDefined()
    expect(f.service.ownerIntent(agent, record.id)).toBeUndefined()
    expect(f.proof.inspects).toBe(0)
    expect(f.proof.reads).toBe(0)
    // The registered goal_create tool delegates through the same disabled path.
    const other = await f.create('owner-intent-disabled-tool', 'other-owner'); f.human.add(other)
    const result = await f.ctx.tools.execute({ callId: ToolCallId('plain-tool-call'), name: 'goal_create',
      arguments: { objective: '第二个目标' }, signal: new AbortController().signal, agent: other })
    expect(result.isError).toBe(false)
    expect(f.ctx.goals.get(other)).toBeDefined()
    expect(f.proof.inspects).toBe(0)
    expect(f.proof.reads).toBe(0)
  })

  it('rejects a tampered side ledger on reopen and a different intent for the same goal', async () => {
    const f = await harness({ ownerIntent: true })
    const agent = await f.create('owner-intent-ledger', 'owner'); f.human.add(agent)
    f.proof.text = '修复构建'
    const record = f.service.createFromOwnerIntent(goalExecution(agent, '修复构建'), '修复构建', 2)
    const intent = f.service.ownerIntent(agent, record.id)!
    const databasePath = `${f.path}.owner-intents`
    const store = new GoalOwnerIntentStore(databasePath)
    try {
      expect(store.record(intent, record.id, record.definition.digest)).toEqual(intent)
      expect(() => store.record({ ...intent, turn: 2 }, record.id, record.definition.digest)).toThrow('goal store operation rejected')
    } finally { store.close() }
    const db = new DatabaseSync(databasePath)
    try { db.prepare('UPDATE goal_owner_intents SET intent_json = ? WHERE goal_id = ?').run(JSON.stringify({ ...intent, text: 'tampered' }), record.id) } finally { db.close() }
    expect(() => new GoalOwnerIntentStore(databasePath)).toThrow('goal store operation rejected')
  })

  it('fails closed when the Delivery peer cannot prove agent-scoped foreground calls', async () => {
    const f = await harness({ ownerIntent: true, legacyDelivery: true })
    const agent = await f.create('owner-intent-legacy', 'owner'); f.human.add(agent)
    expect(() => f.service.createFromOwnerIntent(goalExecution(agent, '修复构建'), '修复构建', 2))
      .toThrow('assistant-goals: owner intent proof is unavailable')
    expect(f.ctx.goals.get(agent)).toBeUndefined()
    expect(f.proof.inspects).toBe(0)
    expect(f.proof.reads).toBe(0)
  })

  it('rejects an objective edit while a frozen intent exists and allows edits without one', async () => {
    const f = await harness({ ownerIntent: true })
    const bound = await f.create('owner-intent-edit-bound', 'owner'); f.human.add(bound)
    f.proof.text = '修复构建'
    const record = f.service.createFromOwnerIntent(goalExecution(bound, '修复构建'), '修复构建', 2)
    expect(() => f.service.control(bound, { goalId: record.id, expectedRevision: record.native.revision,
      operation: 'edit', objective: '换一个目标' }))
      .toThrow('assistant-goals: the objective is bound to the authenticated owner request; create a new goal to change it')
    expect(f.ctx.goals.get(bound)!.objective).toBe('修复构建')
    expect(f.service.ownerIntent(bound, record.id)!.objective.text).toBe('修复构建')

    const plain = await f.create('owner-intent-edit-plain', 'other-owner'); f.human.add(plain)
    const free = f.service.create(plain, '普通目标', 2)
    const edited = f.service.control(plain, { goalId: free.id, expectedRevision: free.native.revision,
      operation: 'edit', objective: '新的普通目标' })
    expect(edited.definition.objective).toBe('新的普通目标')
    expect(f.ctx.goals.get(plain)!.objective).toBe('新的普通目标')
    expect(f.service.ownerIntent(plain, free.id)).toBeUndefined()
  })

  it('returns undefined and fails the supplier pin when the goal definition no longer matches the frozen intent', async () => {
    const f = await harness({ ownerIntent: true })
    const agent = await f.create('owner-intent-stale', 'owner'); f.human.add(agent)
    f.proof.text = '修复构建'
    const record = f.service.createFromOwnerIntent(goalExecution(agent, '修复构建'), '修复构建', 2)
    const native = f.ctx.goals.get(agent)!
    f.ctx.goals.edit(agent, { id: native.id, revision: native.revision }, { objective: '被原生入口改写的目标' })
    const updated = f.service.inspect(agent, record.id)
    expect(updated.definition.digest).not.toBe(record.definition.digest)
    expect(f.service.ownerIntent(agent, record.id)).toBeUndefined()
    const databasePath = `${f.path}.owner-intents`
    const store = new GoalOwnerIntentStore(databasePath)
    try {
      expect(() => goalOwnerIntentSupplier(store, updated))
        .toThrow('assistant-goals: frozen owner intent is stale for the current goal definition')
      expect(goalOwnerIntentSupplier(store, { ...updated, id: 'f'.repeat(64) })).toBeUndefined()
      expect(goalOwnerIntentSupplier(undefined, updated)).toBeUndefined()
    } finally { store.close() }
  })

  it('rolls back the native goal when the frozen intent cannot be recorded', async () => {
    const f = await harness({ ownerIntent: true })
    const agent = await f.create('owner-intent-rollback', 'owner'); f.human.add(agent)
    f.proof.text = '修复构建'
    vi.spyOn(GoalOwnerIntentStore.prototype, 'record').mockImplementationOnce(() => { throw new Error('ledger write failed') })
    const prototype = (GoalService as unknown as { prototype: { clear: (...args: never[]) => unknown } }).prototype
    const clear = vi.spyOn(prototype, 'clear')
    expect(() => f.service.createFromOwnerIntent(goalExecution(agent, '修复构建'), '修复构建', 2))
      .toThrow('the native goal was rolled back')
    expect(clear).toHaveBeenCalledTimes(1)
    expect(f.ctx.goals.get(agent)).toBeUndefined()
    const db = new DatabaseSync(`${f.path}.owner-intents`, { readOnly: true })
    try { expect((db.prepare('SELECT COUNT(*) AS count FROM goal_owner_intents').get() as { count: number }).count).toBe(0) } finally { db.close() }
  })

  it('reports a diagnostic failure when the unproven native goal cannot be rolled back', async () => {
    const f = await harness({ ownerIntent: true })
    const agent = await f.create('owner-intent-rollback-failed', 'owner'); f.human.add(agent)
    f.proof.text = '修复构建'
    vi.spyOn(GoalOwnerIntentStore.prototype, 'record').mockImplementationOnce(() => { throw new Error('ledger write failed') })
    const prototype = (GoalService as unknown as { prototype: { clear: (...args: never[]) => unknown } }).prototype
    vi.spyOn(prototype, 'clear').mockImplementationOnce(() => { throw new Error('clear failed') })
    expect(() => f.service.createFromOwnerIntent(goalExecution(agent, '修复构建'), '修复构建', 2))
      .toThrow('assistant-goals: native goal created without a frozen owner intent; inspect and clear it before use')
    expect(f.ctx.goals.get(agent)).toBeDefined()
  })

  it('rejects an in-memory goal database when owner intent is enabled', async () => {
    await expect(harness({ ownerIntent: true, databasePath: ':memory:' })).rejects.toThrow('owner intent requires a durable private database file')
  })
})
