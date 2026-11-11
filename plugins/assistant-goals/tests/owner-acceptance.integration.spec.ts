import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import GoalService from '@deepseek-ai/dsh-goal'
import { LlmAdapter, LlmRuntime, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { AcceptanceCriterion } from '@dsh-enhanced/task-acceptance-contract'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantGoalsService } from '../src/service.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const bounds = { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 }
const validityMs = 120_000
const runnerId = 'local-runner'
const preparer = { id: 'owner-control', digest: 'a'.repeat(64) }

function criterion(id: string): AcceptanceCriterion {
  return { id, kind: 'process-behavior', authority: { id: runnerId, digest: 'pending' },
    artifactPath: 'report.txt', stdin: '', expectedStdout: '', expectedExitCode: 0 }
}

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
    yield { type: 'text-delta', index: 0, text: this.calls === 1 ? 'ready' : 'done' } as StreamChunk
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.calls === 1 ? 'ready' : 'done' } } as StreamChunk
    yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
  }
}

interface GoalConfig { ownerPreparedAcceptance: boolean }

async function harness(config: GoalConfig) {
  const root = await mkdtemp(join(tmpdir(), 'owner-acceptance-integration-'))
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
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: principalFor,
    currentPreferenceTurn: (agent: Agent) => human.has(agent) ? principalFor(agent) : undefined } as never)
  ctx.provide('assistantPolicy' as never, { authorizeAgent: () => ({ effect: 'allow' }),
    evaluateAgent: () => ({ effect: 'allow' }) } as never)
  const verifierSource = await loadVerifierSource()
  const verifierPath = join(root, 'verifier.sqlite')
  const runnerPath = join(root, 'runner.sh')
  await writeFile(runnerPath, '#!/bin/sh\nexit 0\n')
  await chmod(runnerPath, 0o755)
  const runnerAuthority = { kind: 'runner' as const, id: runnerId, executable: runnerPath,
    fixedArgs: [] as string[], timeoutMs: 1_000, maxOutputBytes: 4_096 }
  await ctx.plugin(verifierSource.AssistantVerifierService as never, {
    databasePath: verifierPath, tickIntervalMs: 0, requireAcceptance: true,
    authorities: [runnerAuthority], profiles: [],
  } as never)
  const installed = verifierSource.createVerifierAuthorities({ authorities: [runnerAuthority] })[0]!
  const goalsConfig = { databasePath: join(root, 'goals.sqlite'), verifyNativeRounds: true, verifyGoalOutcome: true,
    stepMaxDurationMs: 5_000, ...(config.ownerPreparedAcceptance ? { ownerPreparedAcceptance: true } : {}) }
  const goalsPlugin = await ctx.plugin(AssistantGoalsService, goalsConfig)
  const service = ctx.assistantGoals
  await installNativeGoalRoundDriver(ctx)
  await writeFile(join(root, 'report.txt'), 'report ready\n')
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const create = async (id: string, owner = 'owner') => {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: root, agentPreset: 'primary' },
      agentOptions: { provider: 'fixture', model: 'fixture' } })
    owners.set(handle.agent, owner)
    cleanups.push(() => handle.dispose())
    return handle.agent
  }
  return { ctx, root, verifierPath, service, goalsPlugin, goalsConfig, create, human, adapter, installed }
}

function sealInput(installed: { id: string; digest: string }) {
  const authority = { id: installed.id, digest: installed.digest }
  return { criteria: [{ ...criterion('whole-report-ready'), authority }], bounds, validityMs, preparer,
    stepCriteria: [{ ...criterion('step-report-ready'), authority }] }
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

async function ownerTurn(agent: Agent, adapter: ScriptedAdapter): Promise<void> {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare the native goal driver.' }] }))
  await vi.waitFor(() => expect(adapter.calls).toBe(1), { timeout: 5_000 })
  await agent.whenIdle()
}

describe('owner-prepared acceptance with the real verifier', () => {
  it('seals outcome at seal time and the step contract at first-run admission (exactly two prepared contracts)', async () => {
    const f = await harness({ ownerPreparedAcceptance: true })
    const agent = await f.create('owner-acceptance-integration-round', 'owner'); f.human.add(agent)
    await ownerTurn(agent, f.adapter)
    await vi.waitFor(() => expect(f.service.health().verifierConnected).toBe(true), { timeout: 5_000 })
    expect(f.service.health().outcomeConnected).toBe(true)
    const objective = 'Publish the independently verified report'
    const record = f.service.create(agent, objective, 1)
    const sealed = f.service.sealOwnerAcceptance(agent, record.id, sealInput(f.installed))
    expect(sealed.outcome.contractDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(contracts(f.verifierPath)).toHaveLength(1)
    await vi.waitFor(() => expect(f.ctx.goals.get(agent)?.roundsStarted).toBe(1), { timeout: 8_000 })
    await vi.waitFor(() => expect(f.adapter.calls).toBe(2), { timeout: 8_000 })
    await agent.whenIdle()
    await vi.waitFor(() => expect(contracts(f.verifierPath)).toHaveLength(2), { timeout: 8_000 })
    const stored = contracts(f.verifierPath)
    expect(stored.map(contract => contract.kind).sort()).toEqual(['goal-outcome', 'goal-step'])
    expect(stored.every(contract => contract.profile === 'owner-prepared')).toBe(true)
    expect(stored.every(contract => contract.objective === objective)).toBe(true)
    expect(stored.some(contract => contract.id === sealed.outcome.contractId)).toBe(true)
    const view = f.service.inspectGoalOutcome(agent, record.id)!
    expect(view.conditions).toMatchObject({ contractId: sealed.outcome.contractId, profileId: 'owner-prepared', profileVersion: 1 })
  }, 30_000)

  it('reuses the sealed outcome contract after a Goals restart without sealing again', async () => {
    const f = await harness({ ownerPreparedAcceptance: true })
    const agent = await f.create('owner-acceptance-integration-restart', 'owner'); f.human.add(agent)
    await ownerTurn(agent, f.adapter)
    await vi.waitFor(() => expect(f.service.health().verifierConnected).toBe(true), { timeout: 5_000 })
    const objective = 'Publish the independently verified report'
    const record = f.service.create(agent, objective, 1)
    const sealed = f.service.sealOwnerAcceptance(agent, record.id, sealInput(f.installed))
    expect(contracts(f.verifierPath)).toHaveLength(1)
    await f.goalsPlugin.dispose()
    await ctxRemount(f)
    const remounted = f.ctx.assistantGoals
    await vi.waitFor(() => expect(remounted.health().verifierConnected).toBe(true), { timeout: 5_000 })
    const view = remounted.inspectGoalOutcome(agent, record.id)!
    expect(view.conditions).toMatchObject({ contractId: sealed.outcome.contractId, profileId: 'owner-prepared' })
    const replay = remounted.sealOwnerAcceptance(agent, record.id, sealInput(f.installed))
    expect(replay).toEqual(sealed)
    expect(contracts(f.verifierPath)).toHaveLength(1)
  }, 30_000)
})

async function ctxRemount(f: Awaited<ReturnType<typeof harness>>): Promise<void> {
  await f.ctx.plugin(AssistantGoalsService, f.goalsConfig)
}

describe('owner-prepared acceptance fail-closed without a seal', () => {
  it('rejects the first goal round before the model request when no seal exists', async () => {
    const f = await harness({ ownerPreparedAcceptance: true })
    const agent = await f.create('owner-acceptance-integration-unsealed', 'owner'); f.human.add(agent)
    await ownerTurn(agent, f.adapter)
    await vi.waitFor(() => expect(f.service.health().verifierConnected).toBe(true), { timeout: 5_000 })
    const requestHeaders = () => agent.session.snapshotEvents().filter(event => event.type === 'request/header').length
    const beforeHeaders = requestHeaders()
    f.service.create(agent, 'Publish the independently verified report', 1)
    await vi.waitFor(() => {
      const aborted = agent.session.snapshotEvents().filter(event => {
        const end = event as { type: string; data?: { reason?: { kind?: string; reason?: { kind?: string; reason?: string } } } }
        return end.type === 'turn/end' && end.data?.reason?.kind === 'aborted'
          && end.data.reason.reason?.reason === 'assistant-goals-step-admission-failed'
      })
      expect(aborted).toHaveLength(1)
    }, { timeout: 8_000 })
    // The round never reached a model request and no prepared contract was sealed.
    expect(requestHeaders()).toBe(beforeHeaders)
    expect(f.adapter.calls).toBe(1)
    expect(f.ctx.goals.get(agent)?.roundsStarted).toBe(0)
    expect(contracts(f.verifierPath)).toHaveLength(0)
  }, 30_000)
})
