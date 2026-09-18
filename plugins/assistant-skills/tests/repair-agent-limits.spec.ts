import { Context } from '@deepseek-ai/cordis'
import { expect, test, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { OwnerRepairAgentRuntime, type OwnerRepairAgentInput } from '../src/repair-agent.js'

// ENGINEERING-LAYER FAIL-CLOSED CONTRACT TESTS, NOT REAL EXTERNAL-AUTHORITY
// EVIDENCE. The three hooks mounted in `#setupRepairAgent` fire on shapes the
// production Agent loop itself produces for every turn, so every request below
// is a reachable hook input rather than a forged one:
//   - `llm/stream` sees the fully assembled GenerateOptions for each model
//     request. A wrong provider route, a preset-local tool that restrict() does
//     not mask (see repair-agent.ts note at #checkRepairTools), a raised token
//     cap, or loop exhaustion must all cancel the Agent before delegating.
//   - `tools.guard` sees `execution.name`, which is the model-written
//     ToolCallBlock.name: a non-allowlisted name or an exhausted tool budget is
//     fully model-controlled.
//   - `system-prompt/assemble` is the presentation filter that hides every
//     non-allowlisted tool from the model and presents the rest name-sorted.
// These pins run in-process with a stub Agent factory; they prove the gates'
// fail-closed behaviour, not any real provider or authorization platform.

const scope = { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: '/workspace', preset: 'repair' }
const baseInput = (): OwnerRepairAgentInput => ({ id: 'authorization-1', authorizationDigest: 'digest', scope, ownerRouteId: 'route',
  trigger: { protocol: 'assistant-skills/host-failure-trigger/v1', scope, taskFamily: { id: 'repair', definitionDigest: 'a'.repeat(64), objective: 'Repair' },
    failureCategory: 'objective-not-achieved', triggerCondition: { kind: 'not-achieved-count', minimumOccurrences: 1, windowStartedAt: 1, windowEndedAt: 1 }, failures: [], attestedAt: 1,
    evidence: { producer: 'assistant-goals', generation: 'generation', digest: 'digest' } }, objective: 'Repair', maxGoalRounds: 1, expiresAt: Date.now() + 3_600_000,
  provider: 'provider', model: 'model', maxModelCalls: 4, maxToolCalls: 2, maxOutputTokens: 10, maxDurationMs: 60_000,
  allowedTools: ['read'], assertCurrent: () => {} })

const readSchema = { name: 'read', description: 'read a file', parameters: { type: 'object' } }

type StreamListener = (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
type Guard = (execution: { name: string }) => string | undefined
type AssembleListener = (assembly: { tools: Array<{ name: string }> }, context: { agent: unknown }, next: () => Promise<{ tools: Array<{ name: string}> }>) => Promise<{ tools: Array<{ name: string }> }>

interface Harness {
  sessionId: string
  agent: { session: { id: unknown }, cancel: ReturnType<typeof vi.fn> }
  cancel: ReturnType<typeof vi.fn>
  stream: StreamListener
  guard: Guard
  assemble: AssembleListener
  restrict: ReturnType<typeof vi.fn>
}

/** Mounts the real runtime against a stub Agent factory and captures its hooks. */
async function mount(overrides: Partial<OwnerRepairAgentInput> = {}, mounted: Array<{ name: string }> = [readSchema]): Promise<{ runtime: OwnerRepairAgentRuntime; harness: Harness }> {
  let stream!: StreamListener, guard!: Guard, assemble!: AssembleListener
  const cancel = vi.fn()
  const restrict = vi.fn()
  const agent = { session: { id: '' }, cancel }
  const agentCtx = {
    effect: (acquire: () => unknown) => acquire(),
    tools: {
      // Real API: schemas() lists globals, schemas(agent) lists mounted tools.
      schemas: (target?: unknown) => (target === undefined ? [...mounted, { name: 'bash' }] : mounted),
      restrict,
      guard: (callback: Guard) => { guard = callback },
    },
    on: (name: string, listener: unknown) => {
      if (name === 'llm/stream') stream = listener as StreamListener
      else if (name === 'system-prompt/assemble') assemble = listener as AssembleListener
      return () => {}
    },
  }
  const ctx = { effect: () => {}, get: (name: string) => {
    if (name === 'agents') return { create: async ({ sessionId, setup }: { sessionId: string; setup: (c: typeof agentCtx, a: typeof agent) => Promise<void> }) => {
      agent.session.id = sessionId
      await setup(agentCtx, agent)
      return { agent, dispose: async () => {} }
    } }
    if (name === 'assistantGoals') return { startOwnerAuthorizedRepair: async () => ({ id: 'goal' }) }
    if (name === 'assistantPolicy') return { bindInitiator: () => () => {} }
    return undefined
  } } as unknown as Context
  const runtime = new OwnerRepairAgentRuntime(ctx)
  const made = await runtime.create({ ...baseInput(), ...overrides })
  return { runtime, harness: { sessionId: made.sessionId, agent, cancel, stream, guard, assemble, restrict } }
}

async function finishOnce(next: () => AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of next()) { /* drain the provider's terminal finish */ }
}

const validOptions = (sessionId: string): GenerateOptions => ({
  sessionId: SessionId(sessionId), provider: 'provider', model: 'model', messages: [], maxTokens: 10,
  // A fresh, equal-content array (not the setup reference) pins digest-by-value.
  tools: [{ ...readSchema }],
})

test('a conforming model request is delegated, metered, and not cancelled', async () => {
  const recordUsage = vi.fn()
  const { runtime, harness } = await mount({ recordUsage })
  try {
    const next = vi.fn(async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk })
    await finishOnce(() => harness.stream(validOptions(harness.sessionId), next))
    expect(next).toHaveBeenCalledTimes(1)
    expect(recordUsage).toHaveBeenCalledWith('model')
    expect(harness.cancel).not.toHaveBeenCalled()
  } finally { await runtime.dispose() }
})

test.each([
  ['a drifted provider route', { provider: 'other-provider' }],
  ['a drifted model id', { model: 'other-model' }],
  ['a missing maxTokens cap', { maxTokens: undefined }],
  ['a maxTokens above the frozen cap', { maxTokens: 11 }],
  ['an empty tool set against a mounted tool', { tools: [] }],
  ['a same-named tool with a changed description', { tools: [{ ...readSchema, description: 'tampered' }] }],
  ['an extra unmounted tool', { tools: [{ ...readSchema }, { name: 'bash', description: 'x', parameters: {} }] }],
])('rejects %s before delegating to the provider', async (_label, patch) => {
  const { runtime, harness } = await mount()
  try {
    const next = vi.fn(async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk })
    const options = { ...validOptions(harness.sessionId), ...patch } as GenerateOptions
    await expect(finishOnce(() => harness.stream(options, next))).rejects.toThrow(/owner repair model request rejected/u)
    expect(next).not.toHaveBeenCalled()
    expect(harness.cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'assistant-skills-owner-repair-model-limit' })
  } finally { await runtime.dispose() }
})

test('rejects a model request after the frozen maxModelCalls budget is spent', async () => {
  const { runtime, harness } = await mount({ maxModelCalls: 1 })
  try {
    const next = vi.fn(async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk })
    await finishOnce(() => harness.stream(validOptions(harness.sessionId), next))
    expect(next).toHaveBeenCalledTimes(1)
    await expect(finishOnce(() => harness.stream(validOptions(harness.sessionId), next))).rejects.toThrow(/owner repair model request rejected/u)
    expect(next).toHaveBeenCalledTimes(1)
    expect(harness.cancel).toHaveBeenCalledTimes(1)
  } finally { await runtime.dispose() }
})

test('passes through a model request stamped for a different Agent session without spending the budget', async () => {
  const { runtime, harness } = await mount({ maxModelCalls: 1 })
  try {
    const foreign = vi.fn(async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk })
    await finishOnce(() => harness.stream({ ...validOptions(harness.sessionId), sessionId: SessionId('owner-repair-foreign') }, foreign))
    expect(foreign).toHaveBeenCalledTimes(1)
    expect(harness.cancel).not.toHaveBeenCalled()
    // The foreign request must not have consumed this Agent's single call.
    const own = vi.fn(async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk })
    await finishOnce(() => harness.stream(validOptions(harness.sessionId), own))
    expect(own).toHaveBeenCalledTimes(1)
  } finally { await runtime.dispose() }
})

test('the tool guard admits an allowlisted tool and meters it', async () => {
  const recordUsage = vi.fn()
  const { runtime, harness } = await mount({ recordUsage })
  try {
    expect(harness.guard({ name: 'read' })).toBeUndefined()
    expect(recordUsage).toHaveBeenCalledWith('tool')
    expect(harness.cancel).not.toHaveBeenCalled()
  } finally { await runtime.dispose() }
})

test('the tool guard rejects a non-allowlisted tool name without spending the tool budget', async () => {
  const recordUsage = vi.fn()
  const { runtime, harness } = await mount({ recordUsage, maxToolCalls: 1 })
  try {
    // The model asks for a tool that was never frozen into the allowlist.
    expect(harness.guard({ name: 'bash' })).toMatch(/owner repair tool request rejected/u)
    expect(harness.cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'assistant-skills-owner-repair-tool-limit' })
    expect(recordUsage).not.toHaveBeenCalled()
    // Rejection does not consume the single permitted call: read still passes.
    expect(harness.guard({ name: 'read' })).toBeUndefined()
    expect(recordUsage).toHaveBeenCalledTimes(1)
  } finally { await runtime.dispose() }
})

test('the tool guard rejects calls beyond maxToolCalls', async () => {
  const { runtime, harness } = await mount({ maxToolCalls: 1 })
  try {
    expect(harness.guard({ name: 'read' })).toBeUndefined()
    expect(harness.guard({ name: 'read' })).toMatch(/owner repair tool request rejected/u)
    expect(harness.cancel).toHaveBeenCalledTimes(1)
    expect(harness.cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'assistant-skills-owner-repair-tool-limit' })
  } finally { await runtime.dispose() }
})

test('the system-prompt filter hides non-allowlisted tools and name-sorts the rest', async () => {
  // `bash` exists only as a global in this stub (schemas(undefined)), never as a
  // mounted preset tool, so it lands in restrict({deny}) and is filtered from
  // the model-facing assembly.
  const mountedTools = [{ name: 'write' }, readSchema]
  const { runtime, harness } = await mount({ allowedTools: ['read', 'write'] }, mountedTools)
  try {
    expect(harness.restrict).toHaveBeenCalledWith({ deny: ['bash'] })
    const next = vi.fn(async () => ({ tools: [{ name: 'bash' }, { name: 'write' }, { name: 'read' }] }))
    const own = await harness.assemble({ tools: [] }, { agent: harness.agent }, next)
    expect(own.tools.map(tool => tool.name)).toEqual(['read', 'write'])
    // A different Agent's assembly is returned untouched.
    const foreign = await harness.assemble({ tools: [] }, { agent: { session: { id: 'other' } } }, next)
    expect(foreign.tools.map(tool => tool.name)).toEqual(['bash', 'write', 'read'])
  } finally { await runtime.dispose() }
})
