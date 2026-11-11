import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import GoalService from '@deepseek-ai/dsh-goal'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { acceptanceCanonicalJson, acceptanceDigest, acceptanceProtocolForTask, createTaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import type { AcceptanceCriterion, AcceptanceTaskIdentity, TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import type { AcceptanceHandle, TaskAcceptanceRegistration } from '@dsh-enhanced/assistant-verifier'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantGoalsService } from '../src/service.ts'
import { GoalOutcomeRuntime } from '../src/outcome.ts'
import { GoalOwnerAcceptanceStore } from '../src/owner-acceptance-store.ts'
import type { GoalExecutionRun, GoalRecord } from '../src/types.ts'
import type { OwnerPreparedContractInput, OwnerPreparedRegistration } from '../src/owner-acceptance.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const bounds = { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 }
const validityMs = 120_000
const authority = { id: 'target', digest: 'b'.repeat(64) }
const criterion: AcceptanceCriterion = { id: 'report-ready', kind: 'target-readback', authority,
  objectId: 'report', expected: [{ pointer: '/ready', value: true }] }
const otherCriterion: AcceptanceCriterion = { ...criterion, id: 'report-other' }
const preparer = { id: 'owner-control', digest: 'a'.repeat(64) }

interface FakeProfile {
  id: string; version: number; scope: { workspace: string; preset: string }
  owner: { principalRecordId: string; principalVersion: number }
  taskKind: 'goal-step' | 'goal-outcome'; objective: string; validityMs: number
  bounds: { maxDurationMs: number; maxEvidenceBytes: number }; criteria: readonly AcceptanceCriterion[]; digest: string
}

class FakeVerifier {
  generation = 'fake-generation'
  readonly registrations = new Set<object>()
  readonly contracts = new Map<string, TaskAcceptanceContract>()
  readonly byTask = new Map<string, TaskAcceptanceContract>()
  profiles: FakeProfile[] = []
  readonly authorities = [authority]
  readonly calls = { prepare: 0, prepared: 0, assessments: 0, inspectProfile: 0, inspectTask: 0 }
  ownsTaskAcceptanceRegistration = (value: TaskAcceptanceRegistration) => this.registrations.has(value)
  inspectAcceptanceProfile = (selection: { scope: { workspace: string; preset: string }; owner: { principalRecordId: string; principalVersion: number }; objective: string; taskKind: 'goal-step' | 'goal-outcome' }) => {
    this.calls.inspectProfile++
    const found = this.profiles.find(profile => profile.scope.workspace === selection.scope.workspace
      && profile.scope.preset === selection.scope.preset
      && profile.owner.principalRecordId === selection.owner.principalRecordId
      && profile.owner.principalVersion === selection.owner.principalVersion
      && profile.objective === selection.objective && profile.taskKind === selection.taskKind)
    return found === undefined ? null : Object.freeze({ profile: Object.freeze({ ...found, criteria: found.criteria }),
      digest: found.digest })
  }
  inspectAcceptedTask = (contractId: string) => {
    this.calls.inspectTask++
    const contract = this.contracts.get(contractId)
    return contract === undefined ? null : Object.freeze({ contract, state: 'awaiting-execution' as const,
      attempts: 0, reason: null, receipt: null, execution: null })
  }
  tick = async () => undefined
}

function taskKey(scope: object, owner: object, task: object): string { return acceptanceCanonicalJson([scope, owner, task]) }

function makeRegistration(verifier: FakeVerifier, generation: string): TaskAcceptanceRegistration & OwnerPreparedRegistration {
  const issue = (input: Parameters<typeof createTaskAcceptanceContract>[0]) => {
    const contract = createTaskAcceptanceContract(input)
    verifier.contracts.set(contract.id, contract)
    return contract
  }
  const handle = (contract: TaskAcceptanceContract): AcceptanceHandle =>
    Object.freeze({ contractId: contract.id, contractDigest: contract.digest })
  const registration = {
    protocol: 'assistant-verifier/host-producer/v1', generation, owner: verifier, requiresAcceptance: true,
    prepare: (input: { scope: { workspace: string; preset: string }; owner: { principalRecordId: string; principalVersion: number }; task: AcceptanceTaskIdentity; objective: string }) => {
      verifier.calls.prepare++
      const profile = verifier.profiles.find(item => item.scope.workspace === input.scope.workspace
        && item.scope.preset === input.scope.preset
        && item.owner.principalRecordId === input.owner.principalRecordId
        && item.owner.principalVersion === input.owner.principalVersion
        && item.objective === input.objective && item.taskKind === input.task.kind)
      if (profile === undefined) return null
      const previous = verifier.byTask.get(taskKey(input.scope, input.owner, input.task))
      if (previous !== undefined) return handle(previous)
      const contract = issue({ protocol: acceptanceProtocolForTask(input.task, profile.criteria),
        id: `acceptance-${acceptanceDigest([input.scope, input.owner, input.task])}`,
        scope: input.scope, owner: input.owner, task: input.task, objective: input.objective,
        profile: { id: profile.id, version: profile.version, digest: profile.digest },
        issuedAt: Date.now(), expiresAt: Date.now() + profile.validityMs, criteria: profile.criteria, bounds: profile.bounds })
      verifier.byTask.set(taskKey(input.scope, input.owner, input.task), contract)
      return handle(contract)
    },
    prepareOwnerContract: (input: OwnerPreparedContractInput) => {
      verifier.calls.prepared++
      if (input.criteria.some(item => !verifier.authorities.some(installed =>
        installed.id === item.authority.id && installed.digest === item.authority.digest))) {
        throw new Error('assistant-verifier: owner-prepared criterion has no installed authority')
      }
      const key = taskKey(input.scope, input.owner, input.task)
      const previous = verifier.byTask.get(key)
      if (previous !== undefined) {
        if (acceptanceDigest(previous.criteria) !== acceptanceDigest(input.criteria)
          || acceptanceDigest(previous.bounds) !== acceptanceDigest(input.bounds)) {
          throw new Error('assistant-verifier: owner-prepared contract changed for this task')
        }
        return handle(previous)
      }
      const contract = issue({ protocol: acceptanceProtocolForTask(input.task, input.criteria),
        id: `acceptance-${acceptanceDigest([input.scope, input.owner, input.task])}`,
        scope: input.scope, owner: input.owner, task: input.task, objective: input.objective,
        profile: { id: 'owner-prepared', version: 1, digest: acceptanceDigest({ protocol: 'assistant-goals/prepared-profile/v1', criteria: input.criteria, bounds: input.bounds }) },
        issuedAt: Date.now(), expiresAt: Date.now() + input.validityMs, criteria: input.criteria, bounds: input.bounds })
      verifier.byTask.set(key, contract)
      return handle(contract)
    },
    prepareGoalAssessment: (input: { scope: { workspace: string; preset: string }; owner: { principalRecordId: string; principalVersion: number }; task: AcceptanceTaskIdentity; objective: string }, template: AcceptanceHandle) => {
      verifier.calls.assessments++
      const original = verifier.contracts.get(template.contractId)!
      const contract = issue({ protocol: acceptanceProtocolForTask(input.task, original.criteria),
        id: `acceptance-${acceptanceDigest([input.scope, input.owner, input.task])}`,
        scope: input.scope, owner: input.owner, task: input.task, objective: input.objective,
        profile: original.profile, issuedAt: Date.now(), expiresAt: original.expiresAt,
        criteria: original.criteria, bounds: original.bounds })
      return handle(contract)
    },
    completed: async () => undefined,
  }
  return registration as unknown as TaskAcceptanceRegistration & OwnerPreparedRegistration
}

async function harness(options: { enabled?: boolean; profiles?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'owner-acceptance-'))
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
  ctx.provide('assistantDelivery' as never, {
    preferencePrincipalForAgent: (agent: Agent) => {
      const principal = owners.get(agent)
      return principal === undefined ? undefined : { scope: { workspace: root, preset: 'primary' }, principalId: principal,
        principalLineage: { principalRecordId: `record-${principal}`, principalVersion: 1 },
        bindingId: `binding_${String(agent.session.id)}`, bindingVersion: 1, bindingGeneration: 1, sessionId: String(agent.session.id) }
    },
    currentPreferenceTurn: (agent: Agent) => human.has(agent) ? {
      scope: { workspace: root, preset: 'primary' }, principalId: owners.get(agent)!,
      principalLineage: { principalRecordId: `record-${owners.get(agent)!}`, principalVersion: 1 },
      bindingId: `binding_${String(agent.session.id)}`, bindingVersion: 1, bindingGeneration: 1, sessionId: String(agent.session.id),
    } : undefined,
  } as never)
  ctx.provide('assistantPolicy' as never, { authorizeAgent: () => ({ effect: 'allow' }),
    evaluateAgent: () => ({ effect: 'allow' }) } as never)
  const verifier = new FakeVerifier()
  ctx.provide('assistantVerifier' as never, verifier as never)
  const path = join(root, 'goals.sqlite')
  await ctx.plugin(AssistantGoalsService, { databasePath: path, verifyNativeRounds: true, verifyGoalOutcome: true,
    stepMaxDurationMs: 5_000, ...(options.enabled === true ? { ownerPreparedAcceptance: true } : {}) })
  const service = ctx.assistantGoals
  if (options.profiles === true) {
    const objective = '发布经过独立验收的报告'
    verifier.profiles = (['goal-step', 'goal-outcome'] as const).map((taskKind, index) => ({
      id: `legacy-${taskKind}`, version: 1, scope: { workspace: root, preset: 'primary' },
      owner: { principalRecordId: 'record-owner', principalVersion: 1 }, taskKind, objective,
      validityMs, bounds, criteria: [criterion], digest: String(index + 1).repeat(64),
    }))
  }
  const generation = service.trustedAcceptanceProducerGeneration()
  const registration = makeRegistration(verifier, generation)
  verifier.registrations.add(registration)
  const dispose = service.registerTaskAcceptanceSink(registration)
  cleanups.push(async () => { dispose() })
  const create = async (id: string, owner = 'owner') => {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: root, agentPreset: 'primary' }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    owners.set(handle.agent, owner)
    cleanups.push(() => handle.dispose())
    return handle.agent
  }
  return { ctx, root, path, owners, human, create, verifier, registration, service,
    sealInput: (overrides: Partial<{ criteria: readonly AcceptanceCriterion[]; stepCriteria: readonly AcceptanceCriterion[]; validityMs: number }> = {}) => ({
      criteria: overrides.criteria ?? [criterion], ...(overrides.stepCriteria === undefined ? {} : { stepCriteria: overrides.stepCriteria }),
      bounds, validityMs: overrides.validityMs ?? validityMs, preparer,
    }) }
}

const runFor = (record: GoalRecord): GoalExecutionRun => {
  const task = { kind: 'goal-step' as const, ref: 'run-a', goal: { id: record.id, definitionVersion: record.definition.version,
    definitionDigest: record.definition.digest, stepId: 'round-1', runId: 'run-a', sessionId: record.native.sessionId,
    nativeGoalId: record.native.goalId, nativeRevision: record.native.revision } }
  return { intent: { runId: 'run-a', scope: record.scope, objective: record.definition.objective,
    task, admission: { issuedAt: Date.now(), expiresAt: Date.now() + 5_000, maxGoalRounds: record.native.maxGoalRounds,
      round: 1, authorizationDigest: acceptanceDigest({ scope: record.scope, action: 'execute', resource: { kind: 'goal', id: 'business-context' } }) } } }
}

describe('owner-prepared whole-goal acceptance', () => {
  it('seals an owner-prepared outcome without a matching profile and serves the sealed preflight', async () => {
    const f = await harness({ enabled: true })
    const agent = await f.create('owner-acceptance-seal', 'owner'); f.human.add(agent)
    const record = f.service.create(agent, '发布经过独立验收的报告', 2)
    expect(f.verifier.calls.prepared).toBe(0)
    expect(f.service.inspectGoalOutcome(agent, record.id)?.conditions).toBeUndefined()
    const sealed = f.service.sealOwnerAcceptance(agent, record.id, f.sealInput())
    expect(f.verifier.calls.prepared).toBe(1)
    expect(sealed.outcome.contractDigest).toMatch(/^[a-f0-9]{64}$/u)
    const view = f.service.inspectGoalOutcome(agent, record.id)!
    expect(view.conditions).toMatchObject({ contractId: sealed.outcome.contractId, profileId: 'owner-prepared',
      profileVersion: 1, expiresAt: sealed.expiresAt })
    expect(view.conditions?.criteria).toEqual([criterion])
    const store = new GoalOwnerAcceptanceStore(`${f.path}.owner-acceptance`)
    try {
      const seal = store.get(record.id)!
      expect(seal.outcome).toEqual(sealed.outcome)
      expect(seal.criteria).toEqual([criterion])
      expect(seal.bounds).toEqual(bounds)
      expect(seal.preparer).toEqual(preparer)
      expect(seal.definition.digest).toBe(record.definition.digest)
      expect(seal.preparedProfileDigest).toBe(f.verifier.contracts.get(sealed.outcome.contractId)!.profile.digest)
    } finally { store.close() }
    // A sealed preflight accepts round-cap edits but rejects objective changes.
    const edited = f.service.control(agent, { goalId: record.id, expectedRevision: record.native.revision,
      operation: 'edit', maxGoalRounds: 3 })
    expect(edited.native.maxGoalRounds).toBe(3)
    expect(() => f.service.control(agent, { goalId: record.id, expectedRevision: edited.native.revision,
      operation: 'edit', objective: '换一个目标' }))
      .toThrow('assistant-goals: the objective is bound to the protected owner acceptance; create a new goal to change it')
  })

  it('is idempotent for the same seal and conflicts on different criteria without touching the native goal', async () => {
    const f = await harness({ enabled: true })
    const agent = await f.create('owner-acceptance-conflict', 'owner'); f.human.add(agent)
    const record = f.service.create(agent, '发布经过独立验收的报告', 2)
    const first = f.service.sealOwnerAcceptance(agent, record.id, f.sealInput())
    const replay = f.service.sealOwnerAcceptance(agent, record.id, f.sealInput())
    expect(replay).toEqual(first)
    expect(f.verifier.calls.prepared).toBe(1)
    expect(() => f.service.sealOwnerAcceptance(agent, record.id, f.sealInput({ criteria: [otherCriterion] })))
      .toThrow(/owner acceptance is already sealed for this goal with different criteria/u)
    expect(f.verifier.calls.prepared).toBe(1)
    expect(f.ctx.goals.get(agent)).toBeDefined()
  })

  it('fails closed before the first goal round when no seal exists', async () => {
    const f = await harness({ enabled: true })
    const agent = await f.create('owner-acceptance-unsealed', 'owner'); f.human.add(agent)
    const record = f.service.create(agent, '发布经过独立验收的报告', 2)
    const runtime = new GoalOutcomeRuntime(f.ctx, ':memory:', () => f.service.inspect(agent, record.id), () => [],
      5_000, () => {}, () => false, () => false, () => true, () => undefined)
    runtime.register(f.registration)
    expect(() => runtime.preflight(record.scope, record.definition.objective)).not.toThrow()
    expect(() => runtime.bind(record)).not.toThrow()
    expect(f.service.inspectGoalOutcome(agent, record.id)?.conditions).toBeUndefined()
    expect(() => runtime.prepare(agent, runFor(record)))
      .toThrow('assistant-goals: no sealed owner acceptance; seal before the first goal round')
  })

  it('reloads the same handle from the side ledger after reopening and rejects tampering', async () => {
    const f = await harness({ enabled: true })
    const agent = await f.create('owner-acceptance-reload', 'owner'); f.human.add(agent)
    const record = f.service.create(agent, '发布经过独立验收的报告', 2)
    const sealed = f.service.sealOwnerAcceptance(agent, record.id, f.sealInput())
    const databasePath = `${f.path}.owner-acceptance`
    const reopened = new GoalOwnerAcceptanceStore(databasePath)
    try { expect(reopened.get(record.id)?.outcome).toEqual(sealed.outcome) } finally { reopened.close() }
    const db = new DatabaseSync(databasePath)
    try {
      const row = db.prepare('SELECT seal_json FROM goal_owner_acceptance WHERE goal_id = ?').get(record.id) as { seal_json: string }
      db.prepare('UPDATE goal_owner_acceptance SET seal_json = ? WHERE goal_id = ?')
        .run(JSON.stringify({ ...JSON.parse(row.seal_json), criteria: [otherCriterion] }), record.id)
    } finally { db.close() }
    expect(() => new GoalOwnerAcceptanceStore(databasePath)).toThrow('goal store operation rejected')
  })

  it('rejects undecidable criteria and rolls back the unsealed native goal', async () => {
    const f = await harness({ enabled: true })
    const agent = await f.create('owner-acceptance-unavailable', 'owner'); f.human.add(agent)
    const record = f.service.create(agent, '发布经过独立验收的报告', 2)
    const unknown = { ...criterion, authority: { id: 'missing', digest: 'c'.repeat(64) } }
    expect(() => f.service.sealOwnerAcceptance(agent, record.id, f.sealInput({ criteria: [unknown] })))
      .toThrow(/owner acceptance could not be sealed; the native goal was rolled back/u)
    expect(f.ctx.goals.get(agent)).toBeUndefined()
    expect(f.service.inspectGoalOutcome(agent, record.id)?.conditions).toBeUndefined()
  })

  it('does not call any prepared API when the switch is off and keeps the profile fail-closed path', async () => {
    const f = await harness({ enabled: false, profiles: true })
    const agent = await f.create('owner-acceptance-off', 'owner'); f.human.add(agent)
    const record = f.service.create(agent, '发布经过独立验收的报告', 2)
    expect(f.verifier.calls.prepared).toBe(0)
    expect(f.verifier.calls.prepare).toBeGreaterThan(0)
    expect(f.service.inspectGoalOutcome(agent, record.id)?.conditions?.profileId).toBe('legacy-goal-outcome')
    expect(() => f.service.sealOwnerAcceptance(agent, record.id, f.sealInput()))
      .toThrow('assistant-goals: owner prepared acceptance is not enabled')
    expect(f.verifier.calls.prepared).toBe(0)

    const strict = await harness({ enabled: false })
    const strictAgent = await strict.create('owner-acceptance-strict', 'owner'); strict.human.add(strictAgent)
    expect(() => strict.service.create(strictAgent, '没有 profile 的目标', 2))
      .toThrow('assistant-goals: configure an exact goal-step acceptance profile before creating or editing this goal')
  })
})
