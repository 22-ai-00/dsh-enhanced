import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import GoalService from '@deepseek-ai/dsh-goal'
import { LlmAdapter, LlmRuntime, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { AcceptanceCriterion } from '@dsh-enhanced/task-acceptance-contract'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantGoalsService } from '../src/service.ts'
import { GoalOwnerIntentStore } from '../src/owner-intent-store.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const bounds = { maxDurationMs: 5_000, maxEvidenceBytes: 4_096 }
const runnerId = 'local-runner'
const objective = 'Publish the independently verified report'
const ownerText = `Please ${objective} today.`

async function loadVerifierSource() {
  const url = new URL('../../assistant-verifier/src/index.ts', import.meta.url)
  return await import(url.href) as {
    AssistantVerifierService: new (ctx: Context, config: unknown, options?: { now?: () => number }) => unknown
    createVerifierAuthorities: (config: unknown) => readonly { id: string; digest: string }[]
  }
}

async function installNativeGoalRoundDriver(ctx: Context): Promise<void> {
  const requireFromGoals = createRequire(new URL('../package.json', import.meta.url))
  const entry = requireFromGoals.resolve('@deepseek-ai/dsh-goal-round-driver')
  const driver = await import(pathToFileURL(entry).href) as { inject: readonly string[]; apply(ctx: Context): void }
  await ctx.plugin({ inject: driver.inject, apply: driver.apply } as never, {} as never)
}

class ScriptedAdapter extends LlmAdapter {
  calls = 0
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id, inputModalities: ['text'] as const } }
  override async *stream(_request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
    yield { type: 'text-delta', index: 0, text: 'ready' } as StreamChunk
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ready' } } as StreamChunk
    yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
  }
}

async function harness(options: { acceptance: boolean; profiles?: boolean; ownerIntent?: boolean; withVerifier?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'owner-acceptance-natural-'))
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
  const principalFor = (agent: Agent) => {
    const principal = owners.get(agent)
    return principal === undefined ? undefined : { scope: { workspace: root, preset: 'primary' }, principalId: principal,
      principalLineage: { principalRecordId: `record-${principal}`, principalVersion: 1 },
      bindingId: `binding_${String(agent.session.id)}`, bindingVersion: 1, bindingGeneration: 1, sessionId: String(agent.session.id) }
  }
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
  const proofFor = (agent: Agent, input: { callId: string; toolName: string; argumentsJson: string }) => {
    const principal = owners.get(agent)
    if (principal === undefined || !human.has(agent)) return undefined
    return { protocol: 'assistant-delivery/foreground-tool-call/v1',
      task: { protocol: 'assistant-delivery/foreground-task/v1', inboxId: 'owner-inbox', sessionId: String(agent.session.id),
        scope: { workspace: root, preset: 'primary' }, owner: { principalRecordId: `record-${principal}`, principalVersion: 1 },
        binding: { id: `binding_${String(agent.session.id)}`, version: 1, generation: 1 }, dispatchedAt: 1 },
      turn: 1,
      call: { id: input.callId, toolName: input.toolName, eventSeq: 1, eventDigest: sha256('event'),
        argumentsDigest: sha256(input.argumentsJson) } }
  }
  const ownerIntentDelivery = options.ownerIntent === true ? {
    inspectOwnerForegroundToolCallForAgent: (agent: Agent, input: { callId: string; toolName: string; argumentsJson: string }) => proofFor(agent, input),
    readOwnerForegroundToolInputForAgent: (agent: Agent, input: { callId: string; toolName: string; argumentsJson: string; offset?: number; maxBytes?: number }) => {
      const attestation = proofFor(agent, input)
      if (attestation === undefined || (input.offset ?? 0) !== 0) return undefined
      const fullTextDigest = sha256(ownerText)
      const fullBytes = Buffer.byteLength(ownerText)
      return { protocol: 'assistant-delivery/foreground-tool-input/v1', attestation,
        sourceDigest: sha256(JSON.stringify([String(agent.session.id), fullTextDigest, 'frozen', 'fixture'])),
        modelSelectionState: 'frozen', modelSelection: { provider: 'fixture', model: 'fixture' },
        input: { text: ownerText, fullTextDigest, fullBytes, returnedBytes: fullBytes, offset: 0 } }
    },
  } : {}
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: principalFor,
    currentPreferenceTurn: (agent: Agent) => human.has(agent) ? principalFor(agent) : undefined,
    ...ownerIntentDelivery } as never)
  ctx.provide('assistantPolicy' as never, { authorizeAgent: () => ({ effect: 'allow' }),
    evaluateAgent: () => ({ effect: 'allow' }) } as never)
  const verifierSource = await loadVerifierSource()
  const verifierPath = join(root, 'verifier.sqlite')
  const runnerPath = join(root, 'runner.sh')
  await writeFile(runnerPath, '#!/bin/sh\ngrep -q ACCEPT "$1" && exit 0\nexit 1\n')
  await chmod(runnerPath, 0o755)
  const runnerAuthority = { kind: 'runner' as const, id: runnerId, executable: runnerPath,
    fixedArgs: [] as string[], timeoutMs: 1_000, maxOutputBytes: 4_096 }
  const installed = verifierSource.createVerifierAuthorities({ authorities: [runnerAuthority] })[0]!
  const profiles = options.profiles === true ? (['goal-step', 'goal-outcome'] as const).map(taskKind => ({
    id: `legacy-${taskKind}`, version: 1, scope: { workspace: root, preset: 'primary' },
    owner: { principalRecordId: 'record-owner', principalVersion: 1 }, taskKind, objective,
    validityMs: 300_000, bounds,
    criteria: [{ id: `legacy-${taskKind}-report`, kind: 'process-behavior' as const,
      authority: { id: installed.id, digest: installed.digest }, artifactPath: 'report.txt',
      stdin: '', expectedStdout: '', expectedExitCode: 0 }],
  })) : []
  const verifierEnabled = options.withVerifier !== false
  if (verifierEnabled) {
    await ctx.plugin(verifierSource.AssistantVerifierService as never, {
      databasePath: verifierPath, tickIntervalMs: 0, requireAcceptance: true,
      authorities: [runnerAuthority], profiles,
    } as never)
  }
  const goalsConfig = { databasePath: join(root, 'goals.sqlite'), verifyNativeRounds: true, verifyGoalOutcome: true,
    stepMaxDurationMs: 120_000,
    ...(options.acceptance ? { ownerPreparedAcceptance: true } : {}),
    ...(options.ownerIntent === true ? { ownerIntent: true } : {}) }
  await ctx.plugin(AssistantGoalsService, goalsConfig)
  const service = ctx.assistantGoals
  if (verifierEnabled) await installNativeGoalRoundDriver(ctx)
  await writeFile(join(root, 'report.txt'), 'ACCEPT ready\n')
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const create = async (id: string, owner = 'owner') => {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: root, agentPreset: 'primary' },
      agentOptions: { provider: 'fixture', model: 'fixture' } })
    owners.set(handle.agent, owner)
    cleanups.push(() => handle.dispose())
    return handle.agent
  }
  return { ctx, root, verifierPath, service, adapter, installed, create, human }
}

function criterion(installed: { id: string; digest: string }, id = 'report-ready'): AcceptanceCriterion {
  return { id, kind: 'process-behavior', authority: { id: installed.id, digest: installed.digest },
    artifactPath: 'report.txt', stdin: '', expectedStdout: '', expectedExitCode: 0 }
}

function acceptance(installed: { id: string; digest: string }, overrides: Partial<{ criteria: readonly AcceptanceCriterion[]; validity_ms: number }> = {}) {
  return { criteria: overrides.criteria ?? [criterion(installed)], bounds,
    ...(overrides.validity_ms === undefined ? {} : { validity_ms: overrides.validity_ms }) }
}

async function ownerTurn(agent: Agent, adapter: ScriptedAdapter): Promise<void> {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare the native goal driver.' }] }))
  await vi.waitFor(() => expect(adapter.calls).toBe(1), { timeout: 5_000 })
  await agent.whenIdle()
}

async function goalCreate(f: Awaited<ReturnType<typeof harness>>, agent: Agent, args: unknown) {
  return await f.ctx.tools.execute({ callId: ToolCallId(`goal-create-${Math.random()}`), name: 'goal_create',
    arguments: args as never, signal: new AbortController().signal, agent })
}

async function goalCatalog(f: Awaited<ReturnType<typeof harness>>, agent: Agent) {
  return await f.ctx.tools.execute({ callId: ToolCallId(`goal-catalog-${Math.random()}`), name: 'goal_acceptance_catalog',
    arguments: {} as never, signal: new AbortController().signal, agent })
}

function catalogOf(result: Awaited<ReturnType<typeof goalCatalog>>) {
  return JSON.parse(String((result.value as { context: string }).context)) as {
    protocol: string
    authorities: Array<{ id: string; digest: string; kind: string; artifactPath?: string }>
  }
}

function tableCount(databasePath: string, table: string): number {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try { return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count } finally { db.close() }
}

function contracts(verifierPath: string): Array<{ id: string; kind: string; profile: string; objective: string }> {
  const db = new DatabaseSync(verifierPath, { readOnly: true })
  try {
    return (db.prepare('SELECT payload FROM acceptance_contracts').all() as Array<{ payload: string }>).map(row => {
      const contract = JSON.parse(row.payload) as { id: string; task: { kind: string }; profile: { id: string }; objective: string }
      return { id: contract.id, kind: contract.task.kind, profile: contract.profile.id, objective: contract.objective }
    })
  } finally { db.close() }
}

function receiptStatus(verifierPath: string, contractId: string): string | undefined {
  const db = new DatabaseSync(verifierPath, { readOnly: true })
  try {
    const row = db.prepare('SELECT payload FROM acceptance_receipts WHERE contract_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(contractId) as { payload: string } | undefined
    return row === undefined ? undefined : (JSON.parse(row.payload) as { objectiveStatus: string }).objectiveStatus
  } finally { db.close() }
}

describe('natural-language owner acceptance through goal_create', () => {
  it('seals the outcome in the owner turn and the step contract at the first real round', async () => {
    const f = await harness({ acceptance: true })
    const agent = await f.create('natural-language-seal', 'owner'); f.human.add(agent)
    await ownerTurn(agent, f.adapter)
    await vi.waitFor(() => expect(f.service.health().verifierConnected).toBe(true), { timeout: 5_000 })
    const result = await goalCreate(f, agent, { objective, max_goal_rounds: 1, acceptance: acceptance(f.installed) })
    expect(result.isError).toBe(false)
    const [record] = f.service.list(agent)
    expect(record).toBeDefined()
    const outcomeContracts = contracts(f.verifierPath)
    expect(outcomeContracts).toHaveLength(1)
    expect(outcomeContracts[0]).toMatchObject({ kind: 'goal-outcome', profile: 'owner-prepared', objective })
    expect(f.service.inspectGoalOutcome(agent, record!.id)?.conditions).toMatchObject({ profileId: 'owner-prepared', contractId: outcomeContracts[0]!.id })
    await vi.waitFor(() => expect(f.ctx.goals.get(agent)?.roundsStarted).toBe(1), { timeout: 8_000 })
    await vi.waitFor(() => expect(f.adapter.calls).toBe(2), { timeout: 8_000 })
    await agent.whenIdle()
    await vi.waitFor(() => expect(contracts(f.verifierPath)).toHaveLength(2), { timeout: 8_000 })
    expect(contracts(f.verifierPath).map(contract => contract.kind).sort()).toEqual(['goal-outcome', 'goal-step'])
    expect(contracts(f.verifierPath).every(contract => contract.profile === 'owner-prepared')).toBe(true)
  }, 30_000)

  it('rejects undecidable criteria, rolls back the native goal and keeps zero round model requests', async () => {
    const f = await harness({ acceptance: true })
    const agent = await f.create('natural-language-undecidable', 'owner'); f.human.add(agent)
    await ownerTurn(agent, f.adapter)
    await vi.waitFor(() => expect(f.service.health().verifierConnected).toBe(true), { timeout: 5_000 })
    const wrongKind: AcceptanceCriterion = { id: 'wrong-kind', kind: 'target-readback',
      authority: { id: f.installed.id, digest: f.installed.digest }, objectId: 'report',
      expected: [{ pointer: '/ready', value: true }] }
    const result = await goalCreate(f, agent, { objective, max_goal_rounds: 1,
      acceptance: acceptance(f.installed, { criteria: [wrongKind] }) })
    expect(result.isError).toBe(true)
    expect(result.isError ? result.error.message : '').toContain('the native goal was rolled back')
    expect(f.ctx.goals.get(agent)).toBeUndefined()
    expect(f.service.list(agent).every(record => record.native.phase === 'cleared')).toBe(true)
    expect(contracts(f.verifierPath)).toHaveLength(0)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(f.adapter.calls).toBe(1)
  }, 30_000)

  it('fails before native creation when prepared mode receives no acceptance', async () => {
    const f = await harness({ acceptance: true })
    const agent = await f.create('natural-language-missing', 'owner'); f.human.add(agent)
    await ownerTurn(agent, f.adapter)
    await vi.waitFor(() => expect(f.service.health().verifierConnected).toBe(true), { timeout: 5_000 })
    const result = await goalCreate(f, agent, { objective, max_goal_rounds: 1 })
    expect(result.isError).toBe(true)
    expect(result.isError ? result.error.message : '').toContain('owner-prepared acceptance requires explicit criteria')
    expect(f.ctx.goals.get(agent)).toBeUndefined()
    expect(contracts(f.verifierPath)).toHaveLength(0)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(f.adapter.calls).toBe(1)
  }, 30_000)

  it('keeps the legacy path when the switch is off and rejects an explicit acceptance', async () => {
    const f = await harness({ acceptance: false, profiles: true })
    const agent = await f.create('natural-language-legacy', 'owner'); f.human.add(agent)
    await ownerTurn(agent, f.adapter)
    await vi.waitFor(() => expect(f.service.health().verifierConnected).toBe(true), { timeout: 5_000 })
    const rejected = await goalCreate(f, agent, { objective, max_goal_rounds: 1, acceptance: acceptance(f.installed) })
    expect(rejected.isError).toBe(true)
    expect(rejected.isError ? rejected.error.message : '').toContain('owner-prepared acceptance is not enabled')
    expect(f.ctx.goals.get(agent)).toBeUndefined()
    expect(contracts(f.verifierPath)).toHaveLength(0)
    const created = await goalCreate(f, agent, { objective, max_goal_rounds: 1 })
    expect(created.isError).toBe(false)
    const [record] = f.service.list(agent)
    expect(record).toBeDefined()
    expect(f.service.inspectGoalOutcome(agent, record!.id)?.conditions?.profileId).toBe('legacy-goal-outcome')
    await agent.whenIdle()
  }, 30_000)

  it('reaches achieved through real whole-goal verification for the accepted state', async () => {
    const f = await harness({ acceptance: true })
    const agent = await f.create('natural-language-achieved', 'owner'); f.human.add(agent)
    await ownerTurn(agent, f.adapter)
    await vi.waitFor(() => expect(f.service.health().verifierConnected).toBe(true), { timeout: 5_000 })
    await writeFile(join(f.root, 'report.txt'), 'ACCEPT ready\n')
    const result = await goalCreate(f, agent, { objective, max_goal_rounds: 1, acceptance: acceptance(f.installed) })
    expect(result.isError).toBe(false)
    const [record] = f.service.list(agent)
    await vi.waitFor(() => expect(f.service.inspectGoalOutcome(agent, record!.id)?.status).toBe('achieved'), { timeout: 25_000 })
    await vi.waitFor(() => expect(f.ctx.goals.get(agent)?.phase).toBe('complete'), { timeout: 10_000 })
    const outcomeContract = contracts(f.verifierPath).find(contract => contract.kind === 'goal-outcome')!
    expect(receiptStatus(f.verifierPath, outcomeContract.id)).toBe('achieved')
  }, 60_000)

  it('reaches not-achieved when the accepted state is absent', async () => {
    const f = await harness({ acceptance: true })
    const agent = await f.create('natural-language-not-achieved', 'owner'); f.human.add(agent)
    await ownerTurn(agent, f.adapter)
    await vi.waitFor(() => expect(f.service.health().verifierConnected).toBe(true), { timeout: 5_000 })
    await writeFile(join(f.root, 'report.txt'), 'REJECT pending\n')
    const result = await goalCreate(f, agent, { objective, max_goal_rounds: 1, acceptance: acceptance(f.installed) })
    expect(result.isError).toBe(false)
    const [record] = f.service.list(agent)
    await vi.waitFor(() => expect(f.service.inspectGoalOutcome(agent, record!.id)?.status).toBe('not-achieved'), { timeout: 25_000 })
    const outcomeContract = contracts(f.verifierPath).find(contract => contract.kind === 'goal-outcome')!
    expect(receiptStatus(f.verifierPath, outcomeContract.id)).toBe('not-achieved')
  }, 60_000)

  it('serves a catalog whose id/digest seals decidable criteria with the real verifier', async () => {
    const f = await harness({ acceptance: true })
    const agent = await f.create('natural-language-catalog', 'owner'); f.human.add(agent)
    await ownerTurn(agent, f.adapter)
    await vi.waitFor(() => expect(f.service.health().verifierConnected).toBe(true), { timeout: 5_000 })
    const catalogResult = await goalCatalog(f, agent)
    expect(catalogResult.isError).toBe(false)
    const catalog = catalogOf(catalogResult)
    expect(catalog.protocol).toBe('assistant-verifier/acceptance-authorities/v1')
    const entry = catalog.authorities.find(authority => authority.kind === 'runner')!
    expect(entry.artifactPath).toBe('workspace-relative')
    expect(entry.id).toBe(f.installed.id)
    expect(entry.digest).toBe(f.installed.digest)
    const criteria: AcceptanceCriterion[] = [{ id: 'catalog-report', kind: 'process-behavior',
      authority: { id: entry.id, digest: entry.digest }, artifactPath: 'report.txt',
      stdin: '', expectedStdout: '', expectedExitCode: 0 }]
    const result = await goalCreate(f, agent, { objective, max_goal_rounds: 1, acceptance: { criteria, bounds } })
    expect(result.isError).toBe(false)
    const [record] = f.service.list(agent)
    const stored = contracts(f.verifierPath).filter(contract => contract.kind === 'goal-outcome')
    expect(stored).toHaveLength(1)
    expect(stored[0]!.profile).toBe('owner-prepared')
    expect(f.service.inspectGoalOutcome(agent, record!.id)?.conditions?.contractId).toBe(stored[0]!.id)
  }, 30_000)

  it('reports a diagnostic error when no verifier peer can serve the catalog', async () => {
    const f = await harness({ acceptance: true, withVerifier: false })
    const agent = await f.create('natural-language-catalog-unavailable', 'owner'); f.human.add(agent)
    const result = await goalCatalog(f, agent)
    expect(result.isError).toBe(true)
    expect(result.isError ? result.error.message : '').toContain('acceptance authority catalog is unavailable')
  }, 30_000)

  it('combines owner intent freezing with prepared acceptance in one owner turn', async () => {
    const f = await harness({ acceptance: true, ownerIntent: true })
    const agent = await f.create('natural-language-combined', 'owner'); f.human.add(agent)
    await ownerTurn(agent, f.adapter)
    await vi.waitFor(() => expect(f.service.health().verifierConnected).toBe(true), { timeout: 5_000 })
    const result = await goalCreate(f, agent, { objective, max_goal_rounds: 1, acceptance: acceptance(f.installed) })
    expect(result.isError).toBe(false)
    const [record] = f.service.list(agent)
    expect(f.service.ownerIntent(agent, record!.id)).toBeDefined()
    expect(tableCount(`${f.root}/goals.sqlite.owner-acceptance`, 'goal_owner_acceptance')).toBe(1)
    expect(tableCount(`${f.root}/goals.sqlite.owner-intents`, 'goal_owner_intents')).toBe(1)
    expect(contracts(f.verifierPath).filter(contract => contract.kind === 'goal-outcome')).toHaveLength(1)
  }, 30_000)

  it('rolls back both intent and seal when prepared acceptance cannot be sealed', async () => {
    const f = await harness({ acceptance: true, ownerIntent: true })
    const agent = await f.create('natural-language-combined-failed-seal', 'owner'); f.human.add(agent)
    await ownerTurn(agent, f.adapter)
    await vi.waitFor(() => expect(f.service.health().verifierConnected).toBe(true), { timeout: 5_000 })
    const wrongKind: AcceptanceCriterion = { id: 'wrong-kind', kind: 'target-readback',
      authority: { id: f.installed.id, digest: f.installed.digest }, objectId: 'report',
      expected: [{ pointer: '/ready', value: true }] }
    const result = await goalCreate(f, agent, { objective, max_goal_rounds: 1,
      acceptance: acceptance(f.installed, { criteria: [wrongKind] }) })
    expect(result.isError).toBe(true)
    expect(result.isError ? result.error.message : '').toContain('the native goal was rolled back')
    expect(f.ctx.goals.get(agent)).toBeUndefined()
    expect(tableCount(`${f.root}/goals.sqlite.owner-intents`, 'goal_owner_intents')).toBe(0)
    expect(tableCount(`${f.root}/goals.sqlite.owner-acceptance`, 'goal_owner_acceptance')).toBe(0)
  }, 30_000)

  it('rolls back the native goal when the combined owner intent cannot be recorded', async () => {
    const f = await harness({ acceptance: true, ownerIntent: true })
    const agent = await f.create('natural-language-combined-failed-intent', 'owner'); f.human.add(agent)
    await ownerTurn(agent, f.adapter)
    await vi.waitFor(() => expect(f.service.health().verifierConnected).toBe(true), { timeout: 5_000 })
    vi.spyOn(GoalOwnerIntentStore.prototype, 'record').mockImplementationOnce(() => { throw new Error('ledger write failed') })
    const result = await goalCreate(f, agent, { objective, max_goal_rounds: 1, acceptance: acceptance(f.installed) })
    expect(result.isError).toBe(true)
    expect(result.isError ? result.error.message : '').toContain('owner intent could not be recorded; the native goal was rolled back')
    expect(f.ctx.goals.get(agent)).toBeUndefined()
    expect(tableCount(`${f.root}/goals.sqlite.owner-intents`, 'goal_owner_intents')).toBe(0)
  }, 30_000)
})
