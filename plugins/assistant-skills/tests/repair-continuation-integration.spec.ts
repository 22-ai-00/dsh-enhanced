import { generateKeyPairSync } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, expect, test, vi } from 'vitest'
vi.mock('../src/repair-agent.ts', () => ({ OwnerRepairAgentRuntime: class {
  constructor(private readonly ctx: Context) {}
  get(): Agent | undefined { return this.ctx.get('agents')?.list()[0] }
  async create(input: any, signal: AbortSignal) {
    signal.throwIfAborted()
    const agent = this.get(); if (!agent) throw new Error('missing repair Agent')
    return this.ctx.get('assistantGoals')!.startOwnerAuthorizedRepair(agent, { authorizationId: input.id, authorizationDigest: input.authorizationDigest, ownerRouteId: input.ownerRouteId, scope: input.scope, trigger: input.trigger, objective: input.objective, maxGoalRounds: input.maxGoalRounds, expiresAt: input.expiresAt }, input.assertCurrent)
      .then((goal: { id: string }) => ({ sessionId: String(agent.session.id), goalId: goal.id }))
  }
  async closeSession(): Promise<void> {}
  async dispose(): Promise<void> {}
} }))
import { AssistantSkillsService } from '../src/service.ts'

const cleanups: (() => Promise<void>)[] = []
function agent(ctx: Context, workspace: string, id: string): Agent {
  const sid = SessionId(id), session = Session.create(sid, [], { version: SESSION_FORMAT_VERSION, id: sid, createdAt: 1, isSeeded: false, cwd: workspace, agentPreset: 'primary' })
  const value: Agent = { id: sid, options: { provider: 'fixture', model: 'fixture' }, session, inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }), ctx: undefined as unknown as Context,
    status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
  ;(value as unknown as { ctx: Context }).ctx = createScope(ctx, value).ctx
  session.append('turn/start', { turn: 1 }); return value
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

test('a public arm mints the Goals capability once through the actual Service create port without another human turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-skills-repair-integration-')); await chmod(root, 0o700); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const stateRoot = await mkdtemp(join(tmpdir(), 'assistant-skills-repair-holdout-')); await chmod(stateRoot, 0o700); cleanups.push(() => rm(stateRoot, { recursive: true, force: true }))
  const ctx = new Context(), owner = agent(ctx, root, 'owner'), agents: Agent[] = [owner]; cleanups.push(() => ctx.fiber.restart())
  const scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, preset: 'primary' }
  let human = true, repairAchieved = false, minted = 0, serial = 0
  const source = { protocol: 'assistant-goals/verified-workflow-source/v1' as const, scope, goal: { id: 'failed-goal', sessionId: String(owner.session.id), nativeGoalId: 'native-failed', definition: { version: 1, digest: 'a'.repeat(64), objective: 'Repair a saved artifact' } }, runId: 'source-run', turn: 1,
    acceptance: { contractId: 'contract', contractDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64), verifiedAt: Date.now(), validUntil: Date.now() + 60_000 }, steps: [{ id: 'step', toolName: 'write', arguments: { file: 'result.txt', data: 'saved' } }], failedObservations: [] }
  const trigger = { protocol: 'assistant-skills/host-failure-trigger/v1', scope, taskFamily: { id: 'family', objective: 'Repair a saved artifact' }, failures: [], triggerCondition: { minimumOccurrences: 1 }, evidence: { digest: 'trigger' } }
  const inspection = (input: { goalId: string; sessionId: string }) => input.goalId === 'repair-goal'
    ? { outcome: { status: repairAchieved ? 'achieved' : 'running' }, storedGoal: { definition: { digest: 'a'.repeat(64) }, nativeAtLastObservation: { phase: repairAchieved ? 'complete' : 'active', goalId: 'native-repair' } } }
    : { outcome: { status: 'not-achieved' }, storedGoal: { definition: { digest: 'a'.repeat(64) }, nativeAtLastObservation: { phase: 'complete', goalId: 'native-failed' } } }
  ctx.provide('agents' as never, { get: (id: string) => agents.find(value => value.id === id), list: () => agents,
    create: async (options: any) => { const created = agent(ctx, options.meta.cwd, `repair-${++serial}`); agents.push(created); await options.setup(created.ctx); return { agent: created, dispose: async () => { agents.splice(agents.indexOf(created), 1) } } } } as never)
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: () => ({ principalId: 'owner', principalLineage: { principalRecordId: 'record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } }), currentPreferenceTurn: () => human ? { principalId: 'owner', principalLineage: { principalRecordId: 'record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } } : undefined,
    validateOwnerRoute: (input: any) => input.authorityId === 'route' ? { authorityId: 'route', principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: 1 } : undefined } as never)
  ctx.provide('assistantPolicy' as never, { evaluateAgent: () => ({ effect: 'allow' }), authorizeAgent: () => ({ effect: 'allow' }), evaluate: () => ({ effect: 'allow' }), authorize: () => ({ effect: 'allow' }), bindInitiator: () => () => {} } as never)
  ctx.provide('assistantVerifier' as never, {} as never); ctx.provide('sessions' as never, {} as never); ctx.provide('llm' as never, {} as never)
  ctx.provide('assistantGoals' as never, { inspectVerifiedWorkflowSource: () => source, inspectOwnerGoalExecution: inspection, inspectOwnerFailureTrigger: async () => trigger,
    startOwnerAuthorizedRepair: async (_repairAgent: Agent, input: any, callback: () => void) => { expect(ctx.assistantSkills.ownsOwnerAuthorizedRepair(input, callback)).toBe(true); minted++; repairAchieved = true; return { id: 'repair-goal' } } } as never)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(SkillRegistry)
  const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  await ctx.plugin(AssistantSkillsService, { databasePath: join(root, 'skills.sqlite'), allowedTools: ['write'], externalHoldouts: [{ id: 'holdout', version: 1, scope, execution: { image: `sha256:${'d'.repeat(64)}`, dockerPath: process.execPath, stateRoot, command: 'true', artifactPath: 'result', expiresAt: Date.now() + 60_000, repeats: 2, maxToolCalls: 1, maxBytes: 1024, maxOutputBytes: 1024, cellDurationMs: 1000, verificationDurationMs: 1 }, authority: { executable: process.execPath, args: [], publicKey: key, generatorDigest: 'e'.repeat(64) }, canaryAdmissionTemplate: { protocol: 'assistant-skills/canary-admission-template/v1', skillName: 'repair-skill', taskFamily: { goalDefinitionDigest: 'a'.repeat(64), outcomeProfile: { id: 'outcome', version: 1, digest: 'f'.repeat(64) } } }, maxComparisons: 1 }], repairProfiles: [{ id: 'repair', scope, skillName: 'repair-skill', taskFamilyId: 'family', description: 'Repair', externalHoldoutProfileId: 'holdout', provider: 'fixture', model: 'fixture', allowedTools: ['write'], maxGoalRounds: 1, maxModelCalls: 1, maxToolCalls: 1, maxOutputTokens: 32, maxDurationMs: 30_000, canaryRuns: 1, maxCanaryRuns: 1 }] })
  const service = ctx.assistantSkills
  const execute = (name: string, arguments_: object) => owner.ctx.get('tools')!.execute({ callId: ToolCallId(`call-${name}`), name, arguments: arguments_, signal: new AbortController().signal, agent: owner })
  expect((await execute('skill_save', { goal_id: 'failed-goal', name: 'repair-skill', description: 'Saved repair skill', bindings_json: '[]' })).isError).toBe(false)
  const result = await owner.ctx.get('tools')!.execute({ callId: ToolCallId('repair-arm'), name: 'skill_repair_arm', arguments: { goal_id: 'failed-goal', profile_id: 'repair', owner_route_id: 'route', invocation_id: 'once', expires_at: Date.now() + 20_000 }, signal: new AbortController().signal, agent: owner })
  expect(result.isError).toBe(false); human = false
  await expect.poll(() => (service.repairStatus(owner) as { continuations: readonly unknown[] }).continuations[0], { timeout: 3_000, interval: 100 }).toMatchObject({ state: 'repairing', repair: { goalId: 'repair-goal' } })
  expect(minted).toBe(1)
}, 12_000)
