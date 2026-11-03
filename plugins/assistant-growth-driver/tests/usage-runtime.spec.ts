import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { runGrowthAgent } from '../src/growth-agent.ts'
import { mintGrowthAuthority } from '../src/deposit.ts'
import type { GrowthSourcePlanePort } from '../src/source-port.ts'
import { anySourceGrowthRunDigest, SourceGrowthRunUnavailableError, type WorkItemGrowthAuthorityPins, type CreationAcceptanceAuthorityRef,
  type RevisionAcceptanceAuthorityRef, type RevisionRegressionAcceptanceAuthorityRef } from '@dsh-enhanced/assistant-growth-contract'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantEvaluationService, EvaluationStore } from '@dsh-enhanced/assistant-evaluation'
import { AssistantPolicyService, setApprovalReviewer, getApprovalReviewer } from '@dsh-enhanced/assistant-policy'
import type { OwnerForegroundLearningTask, OwnerWorkItemEngineeringContextSource } from '@dsh-enhanced/assistant-delivery'
import { afterEach, expect, test, vi } from 'vitest'
import GrowthPlugin from '../src/index.ts'
import { normalizeConfig } from '../src/config.ts'
import { UsageLearningRuntime, type UsageReviewInput, type WorkItemUsageReviewInput, type UsageReviewResult } from '../src/usage-runtime.ts'
import { defineTool, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { workItemTextDigest, type WorkItemCreationReadiness } from '../src/work-item-source.ts'
import { UsageStore } from '../src/usage-store.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function fixture(options: { fixed?: boolean; sameOverride?: boolean; missing?: boolean; budget?: boolean; maxPending?: number; scanBudgetLimit?: number; toolPolicy?: 'allow' | 'deny' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'growth-usage-'))
  const ctx = new Context()
  const scope = { workspace: root, preset: 'primary', principalId: 'owner', ownerRouteId: 'owner-route' }
  const owner = { receiptVersion: 2 as const, authorityId: scope.ownerRouteId, authorityHash: 'a'.repeat(64),
    principalId: scope.principalId, principalRecordId: 'record', principalVersion: 1,
    workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  const sourceOwner = structuredClone(owner)
  const policy = new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), budgets: [
    { id: 'growth-scan-budget', metric: 'automation-runs', limit: options.scanBudgetLimit ?? 10, periodMs: 86_400_000, scope: 'subject' },
    ...(options.budget === false ? [] : [{ id: 'growth-budget', metric: 'automation-runs', limit: 10, periodMs: 86_400_000, scope: 'global' as const }])], rules: [
    { id: 'usage-reconcile', effect: 'allow', subject: { kind: 'background', id: 'assistant-growth-usage', workspace: root, principal: 'owner' },
      actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    { id: 'usage-execute', effect: 'allow', subject: { kind: 'background', id: '*', workspace: root, principal: 'owner' },
      actions: ['execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    ...(options.toolPolicy ? ['plugin_source_gaps', 'plugin_source_read', 'plugin_source_create', 'plugin_source_job_status'].map((id, index) => ({ id: `growth-tool-${index}`, effect: options.toolPolicy!, subject: { kind: 'agent' as const, id: 'primary', workspace: root, principal: 'owner' }, actions: ['execute'], resource: { kind: 'tool' as const, id }, context: { initiators: ['background' as const] } })) : []),
  ] })
  const automations = new AssistantAutomationsService(ctx, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
  const evaluation = new AssistantEvaluationService(ctx, { databasePath: join(root, 'evaluation.sqlite'), projectionIntervalMs: 0 })
  let time = Date.now() - 1000
  const producer = new EvaluationStore({ path: join(root, 'evaluation.sqlite'), now: () => ++time })
  const sourceModel = { provider: 'conversation', model: 'original', reasoningEffort: 'medium' }
  let reply: OwnerForegroundLearningTask['source']['reply']
  const delivery = {
    validateOwnerRoute: () => ({ ...owner }),
    inspectOwnerRouteState: () => ({ status: 'active' as const, receipt: { ...owner } }),
    inspectOwnerForegroundLearningTask: ({ outcomeId }: { outcomeId: string }): OwnerForegroundLearningTask | undefined => {
      const canonical = evaluation.getTrustedTaskLearningProjection({ scope: evaluation.canonicalHostScope({ workspace: root, preset: 'primary' }), outcomeId })
      if (!canonical || canonical.projection.subjectKind !== 'foreground-turn') return undefined
      return { protocol: 'assistant-delivery/owner-foreground-learning/v1', owner: { ...sourceOwner }, canonical,
        judgement: 'independent-verifier', source: { sessionId: 'original-session', inboxId: canonical.projection.subjectRef,
          objective: 'Fix the real task failure', truncated: false, quiescent: true,
          modelSelectionState: options.missing ? 'missing' : 'frozen', ...(options.missing ? {} : { modelSelection: { ...sourceModel } }),
          ...(reply === undefined ? {} : { reply: { ...reply } }) } }
    },
  }
  const config = normalizeConfig({ enabled: true, scope, budgetId: 'growth-budget', budgetAmount: 1,
    ...(options.fixed ? options.sameOverride
      ? { provider: sourceModel.provider, model: sourceModel.model, reasoningEffort: sourceModel.reasoningEffort }
      : { provider: 'fixed', model: 'repair' } : {}),
    usageLearning: { enabled: true, scanBudgetId: 'growth-scan-budget', scanBudgetAmount: 1, databasePath: join(root, 'usage.sqlite'), maxPending: options.maxPending ?? 16 } })
  const review = vi.fn<(input: UsageReviewInput) => Promise<UsageReviewResult>>(async input => { input.assertCurrent(); return 'reviewed' })
  let currentCreationAuthority: CreationAcceptanceAuthorityRef | undefined
  let currentRevisionAuthority: RevisionAcceptanceAuthorityRef | undefined
  let currentRevisionRegressionAuthority: RevisionRegressionAcceptanceAuthorityRef | undefined
  const runtimes: UsageLearningRuntime[] = []
  const create = (selectedConfig = config) => {
    const runtime = new UsageLearningRuntime(selectedConfig, { evaluation, automations, delivery, review,
      inspectCreationAcceptanceAuthority: () => currentCreationAuthority,
      inspectRevisionAcceptanceAuthority: () => currentRevisionAuthority,
      inspectRevisionRegressionAcceptanceAuthority: () => currentRevisionRegressionAuthority })
    runtimes.push(runtime); runtime.start(); return runtime
  }
  const append = (task = 'task', status: 'achieved' | 'not-achieved' | 'unknown' = 'not-achieved') => producer.append({
    scope: { workspace: root, preset: 'primary' }, situation: `foreground:${task}`, executionStatus: 'succeeded', objectiveStatus: status,
    deliveryStatus: 'delivered', source: { kind: 'evaluator', id: 'assistant-verifier' }, trust: 'trusted',
    evidence: [{ kind: 'foreground-turn', ref: task }, { kind: 'acceptance-contract', ref: `contract:${task}` },
      { kind: 'verification-receipt', ref: `receipt:${time}` }], metrics: {}, occurredAt: Date.now() - 100,
    idempotencyKey: `${task}:${status}:${++time}`, evaluator: { id: 'assistant-verifier', version: '1' },
  })
  const tick = async () => {
    await new Promise(resolve => setTimeout(resolve, 1100))
    // A minute-boundary scanner may occupy the native runner's admission slot
    // on the first tick. Drain the remaining already-due occurrence as well.
    for (let i = 0; i < 3; i += 1) { await automations.tick(); await automations.whenIdle() }
  }
  cleanup.push(async () => { for (const runtime of runtimes) await runtime.close(); producer.close(); await ctx.fiber.restart(); await rm(root, { recursive: true, force: true }) })
  return { ctx, root, config, owner, policy, delivery, evaluation, automations, sourceModel, review, create, append, tick,
    setReply: (value: OwnerForegroundLearningTask['source']['reply']) => { reply = value },
    setCreationAuthority: (value: CreationAcceptanceAuthorityRef | undefined) => { currentCreationAuthority = value },
    setRevisionAuthority: (value: RevisionAcceptanceAuthorityRef | undefined) => { currentRevisionAuthority = value },
    setRevisionRegressionAuthority: (value: RevisionRegressionAcceptanceAuthorityRef | undefined) => { currentRevisionRegressionAuthority = value } }
}

function actualSourceRun(input: Pick<UsageReviewInput, 'model' | 'expiresAt'>) {
  const createdAt = Date.now()
  return { model: input.model, sessionId: 'growth-real-setup-session',
    toolContractDigest: 'a'.repeat(64), executionContractDigest: 'b'.repeat(64),
    createdAt, generationDeadlineAt: Math.min(input.expiresAt, createdAt + 1_000) }
}

test('native Automations dispatches one durable review of real canonical feedback and never replays it', async () => {
  const f = await fixture(); f.append(); const runtime = f.create()
  expect(runtime.health().counts).toEqual({ queued: 1 })
  await f.tick()
  expect(f.review).toHaveBeenCalledTimes(1)
  expect(f.review.mock.calls[0]![0]).toMatchObject({ model: f.sourceModel, source: { source: { objective: 'Fix the real task failure' } } })
  expect(runtime.health().counts).toEqual({ reviewed: 1 })
  await runtime.close(); const restarted = f.create(); await f.automations.tick(); await f.automations.whenIdle()
  expect(f.review).toHaveBeenCalledTimes(1); expect(restarted.health().counts).toEqual({ reviewed: 1 })
})

test('recovers queued work and freezes its original model across a restart', async () => {
  const f = await fixture(); f.append(); const first = f.create(); await first.close()
  const db = new DatabaseSync(join(f.root, 'usage.sqlite'))
  const queued = db.prepare("SELECT id,digest FROM usage_jobs WHERE state='queued'").get() as { id: string; digest: string }
  db.close()
  const second = f.create()
  expect(second.inspectSourceGrowthRun({ runId: queued.id, intentDigest: queued.digest })).toBeUndefined()
  await f.tick()
  expect(f.review).toHaveBeenCalledTimes(1)
  expect(f.review.mock.calls[0]![0].model).toEqual({ provider: 'conversation', model: 'original', reasoningEffort: 'medium' })
  expect(second.health().counts).toEqual({ reviewed: 1 })
})

const originalReply = { text: 'Original delivered answer', truncated: false, redacted: false,
  outboxId: 'original-outbox', intentDigest: 'a'.repeat(64), fullTextDigest: 'b'.repeat(64) }

test.each(['added', 'removed', 'changed'] as const)('rejects a frozen queued source when reply evidence is %s across restart', async change => {
  const f = await fixture()
  if (change !== 'added') f.setReply(originalReply)
  f.append(); const first = f.create(); await first.close()
  const db = new DatabaseSync(join(f.root, 'usage.sqlite'))
  const before = db.prepare('SELECT intent_json,digest FROM usage_jobs').get()
  db.close()
  f.setReply(change === 'removed' ? undefined : change === 'added' ? originalReply
    : { ...originalReply, text: 'Changed delivered answer', fullTextDigest: 'c'.repeat(64) })
  const restarted = f.create()
  expect(restarted.health().counts).toEqual({ failed: 1 })
  await f.tick()
  expect(f.review).not.toHaveBeenCalled()
  const afterDb = new DatabaseSync(join(f.root, 'usage.sqlite'))
  expect(afterDb.prepare('SELECT intent_json,digest FROM usage_jobs').get()).toEqual(before)
  afterDb.close()
})

test('invalidates a running reply snapshot without replaying or rebinding it', async () => {
  const f = await fixture(); f.setReply(originalReply); f.append(); const runtime = f.create()
  f.review.mockImplementationOnce(async input => {
    expect(input.source.source.reply).toEqual(originalReply)
    input.bindSourceRun(actualSourceRun(input))
    f.setReply({ ...originalReply, text: 'Another task answer', outboxId: 'wrong-outbox' })
    input.assertCurrent()
    return 'reviewed'
  })
  await f.tick()
  expect(runtime.health().counts).toEqual({ unknown: 1 })
  await runtime.close(); const restarted = f.create(); await f.tick()
  expect(f.review).toHaveBeenCalledTimes(1)
  expect(restarted.health().counts).toEqual({ unknown: 1 })
})

test('binds only the claimed native occurrence, permits exact replay, rejects conflicting setup, and inspects reviewed work after restart', async () => {
  const f = await fixture(); f.append(); const first = f.create()
  let runId = ''; let intentDigest = ''
  f.review.mockImplementationOnce(async input => {
    runId = input.id; intentDigest = input.intentDigest
    const actual = actualSourceRun(input)
    const binding = input.bindSourceRun(actual)
    expect(binding).toMatchObject({ runId, intentDigest, model: f.sourceModel,
      modelOrigin: 'inherited-owner-task', native: { owner: 'assistant-growth-usage',
        automationId: runId, definitionHash: input.definitionHash, occurrenceId: input.occurrenceId },
      budget: { budgetId: 'growth-budget', amount: 1, maxModelCalls: 8, maxToolCalls: 24,
        maxOutputTokens: 8192, maxDurationMs: 120000, maxPlansPerWake: 1 } })
    expect(first.inspectSourceGrowthRun({ runId, intentDigest })).toEqual(binding)
    expect(input.bindSourceRun(actual)).toEqual(binding)
    expect(() => input.bindSourceRun({ ...actual, sessionId: 'different-session' })).toThrow(/conflict/)
    expect(() => input.bindSourceRun({ ...actual, model: { provider: 'switched', model: 'wrong' } })).toThrow(/frozen model/)
    return 'reviewed'
  })
  await f.tick()
  expect(first.health().counts).toEqual({ reviewed: 1 })
  const before = first.inspectSourceGrowthRun({ runId, intentDigest })
  expect(before).toBeDefined()
  expect(first.inspectSourceGrowthRun({ runId, intentDigest: '0'.repeat(64) })).toBeUndefined()
  await first.close()
  const second = f.create()
  expect(second.inspectSourceGrowthRun({ runId, intentDigest })).toEqual(before)
  await second.close()
  expect(() => second.inspectSourceGrowthRun({ runId, intentDigest })).toThrow(SourceGrowthRunUnavailableError)
})

test('recovers only the exact policy bound before generation and never retrofits a legacy run', async () => {
  const f = await fixture()
  const authority: CreationAcceptanceAuthorityRef = { protocol: 'assistant-growth/creation-acceptance-authority/v1',
    authorityId: 'owner-policy', keyId: 'owner-key', authorityDigest: '9'.repeat(64),
    namePrefix: 'assistant-', expiresAt: Date.now() + 60_000 }
  f.setCreationAuthority(authority)
  f.append(); const first = f.create()
  let runId = ''; let intentDigest = ''
  f.review.mockImplementationOnce(async input => {
    runId = input.id; intentDigest = input.intentDigest
    f.setCreationAuthority({ ...authority, authorityDigest: '8'.repeat(64) })
    expect(() => input.bindSourceRun({ ...actualSourceRun(input), creationAcceptance: authority })).toThrow(/authority changed/)
    f.setCreationAuthority(authority)
    const bound = input.bindSourceRun({ ...actualSourceRun(input), creationAcceptance: authority })
    expect(bound.creationAcceptance).toEqual(authority)
    expect(first.inspectSourceGrowthRun({ runId, intentDigest })).toEqual(bound)
    expect(() => input.bindSourceRun(actualSourceRun(input))).toThrow(/conflict/)
    return 'reviewed'
  })
  await f.tick()
  await first.close()
  const recovered = f.create()
  expect(recovered.inspectSourceGrowthRun({ runId, intentDigest })?.creationAcceptance).toEqual(authority)
  f.setCreationAuthority({ ...authority, authorityDigest: '8'.repeat(64) })
  expect(recovered.inspectSourceGrowthRun({ runId, intentDigest })).toBeUndefined()
  f.setCreationAuthority(undefined)
  expect(recovered.inspectSourceGrowthRun({ runId, intentDigest })).toBeUndefined()
  f.setCreationAuthority(authority)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(authority.expiresAt + 1)
  expect(recovered.inspectSourceGrowthRun({ runId, intentDigest })).toBeUndefined()
  vi.useRealTimers()
  await recovered.close()

  const old = await fixture(); old.append(); const legacy = old.create()
  let oldId = ''; let oldDigest = ''
  old.review.mockImplementationOnce(async input => {
    oldId = input.id; oldDigest = input.intentDigest
    input.bindSourceRun(actualSourceRun(input))
    return 'reviewed'
  })
  await old.tick()
  old.setCreationAuthority(authority)
  expect(legacy.inspectSourceGrowthRun({ runId: oldId, intentDigest: oldDigest })).not.toHaveProperty('creationAcceptance')
})

test('freezes an independent revision policy before generation and rejects a changed ref after restart', async () => {
  const f = await fixture()
  const revision: RevisionAcceptanceAuthorityRef = { protocol: 'assistant-growth/revision-acceptance-authority/v1',
    authorityId: 'revision-policy', keyId: 'revision-key', authorityDigest: '8'.repeat(64),
    namePrefix: 'assistant-', expiresAt: Date.now() + 60_000 }
  const creation: CreationAcceptanceAuthorityRef = { protocol: 'assistant-growth/creation-acceptance-authority/v1',
    authorityId: 'creation-policy', keyId: 'creation-key', authorityDigest: '9'.repeat(64),
    namePrefix: 'assistant-', expiresAt: revision.expiresAt }
  f.setCreationAuthority(creation); f.setRevisionAuthority(revision)
  f.append('new-failed-task'); const first = f.create()
  let runId = ''; let intentDigest = ''
  f.review.mockImplementationOnce(async input => {
    runId = input.id; intentDigest = input.intentDigest
    f.setRevisionAuthority({ ...revision, authorityDigest: '0'.repeat(64) })
    expect(() => input.bindSourceRun({ ...actualSourceRun(input), revisionAcceptance: revision })).toThrow(/authority changed/)
    f.setRevisionAuthority(revision)
    const bound = input.bindSourceRun({ ...actualSourceRun(input), revisionAcceptance: revision, creationAcceptance: creation })
    expect(bound).toMatchObject({ revisionAcceptance: revision, creationAcceptance: creation,
      model: f.sourceModel, intentDigest, source: { projection: { subjectRef: 'new-failed-task' } } })
    expect(first.inspectSourceGrowthRun({ runId, intentDigest })).toEqual(bound)
    return 'reviewed'
  })
  await f.tick(); await first.close()
  const recovered = f.create()
  expect(recovered.inspectSourceGrowthRun({ runId, intentDigest })?.revisionAcceptance).toEqual(revision)
  expect(recovered.inspectSourceGrowthRun({ runId, intentDigest: '0'.repeat(64) })).toBeUndefined()
  f.setRevisionAuthority({ ...revision, authorityDigest: '0'.repeat(64) })
  expect(recovered.inspectSourceGrowthRun({ runId, intentDigest })).toBeUndefined()
  f.setRevisionAuthority(undefined)
  expect(recovered.inspectSourceGrowthRun({ runId, intentDigest })).toBeUndefined()
  f.setRevisionAuthority(revision)
  expect(recovered.inspectSourceGrowthRun({ runId, intentDigest })).toBeDefined()
  await recovered.close()
})

test('freezes the optional parent regression policy before dispatch and rechecks it after cold restart', async () => {
  const f = await fixture()
  const revision: RevisionAcceptanceAuthorityRef = { protocol: 'assistant-growth/revision-acceptance-authority/v1',
    authorityId: 'revision-policy', keyId: 'revision-key', authorityDigest: '8'.repeat(64),
    namePrefix: 'assistant-', expiresAt: Date.now() + 60_000 }
  const regression: RevisionRegressionAcceptanceAuthorityRef = {
    protocol: 'assistant-growth/revision-regression-acceptance-authority/v1', authorityId: 'regression-policy',
    keyId: 'regression-key', authorityDigest: '7'.repeat(64), namePrefix: 'assistant-', expiresAt: revision.expiresAt }
  f.setRevisionAuthority(revision); f.setRevisionRegressionAuthority(regression)
  f.append('regression-task'); const first = f.create()
  let runId = ''; let intentDigest = ''
  f.review.mockImplementationOnce(async input => {
    runId = input.id; intentDigest = input.intentDigest
    const actual = { ...actualSourceRun(input), revisionAcceptance: revision, revisionRegressionAcceptance: regression }
    f.setRevisionRegressionAuthority({ ...regression, authorityDigest: '0'.repeat(64) })
    expect(() => input.bindSourceRun(actual)).toThrow(/revision regression acceptance authority changed/)
    f.setRevisionRegressionAuthority(undefined)
    expect(() => input.bindSourceRun(actual)).toThrow(/revision regression acceptance authority changed/)
    f.setRevisionRegressionAuthority(regression)
    const bound = input.bindSourceRun(actual)
    expect(bound.revisionRegressionAcceptance).toEqual(regression)
    expect(first.inspectSourceGrowthRun({ runId, intentDigest })).toEqual(bound)
    return 'reviewed'
  })
  await f.tick(); await first.close()
  const recovered = f.create()
  expect(recovered.inspectSourceGrowthRun({ runId, intentDigest })?.revisionRegressionAcceptance).toEqual(regression)
  f.setRevisionRegressionAuthority({ ...regression, authorityDigest: '0'.repeat(64) })
  expect(recovered.inspectSourceGrowthRun({ runId, intentDigest })).toBeUndefined()
  f.setRevisionRegressionAuthority(undefined)
  expect(recovered.inspectSourceGrowthRun({ runId, intentDigest })).toBeUndefined()
  f.setRevisionRegressionAuthority(regression)
  expect(recovered.inspectSourceGrowthRun({ runId, intentDigest })).toBeDefined()
  await recovered.close()

  const old = await fixture(); old.append('pre-policy-task'); const legacy = old.create()
  let oldId = ''; let oldDigest = ''
  old.review.mockImplementationOnce(async input => {
    oldId = input.id; oldDigest = input.intentDigest
    input.bindSourceRun(actualSourceRun(input))
    return 'reviewed'
  })
  await old.tick()
  old.setRevisionRegressionAuthority(regression)
  expect(legacy.inspectSourceGrowthRun({ runId: oldId, intentDigest: oldDigest }))
    .not.toHaveProperty('revisionRegressionAcceptance')
})

test.each([true, false])('preserves historical usage digest unless modification is restricted: %s', async allowModification => {
  const f = await fixture(); f.append('legacy-compatible-task')
  f.create({ ...f.config, pluginSourceProposals: { ...f.config.pluginSourceProposals, allowModification } })
  const { allowRevision: _absentRevision, allowModification: _absentModification, ...legacySourceConfig } = f.config.pluginSourceProposals
  const historical = acceptanceDigest({ ...f.config, pluginSourceProposals: legacySourceConfig })
  const expected = allowModification ? historical : acceptanceDigest({ ...f.config, pluginSourceProposals: { ...legacySourceConfig, allowModification: false } })
  expect(expected === historical).toBe(allowModification)
  const db = new DatabaseSync(join(f.root, 'usage.sqlite'))
  try {
    const row = db.prepare('SELECT intent_json FROM usage_jobs LIMIT 1').get() as { intent_json: string }
    expect((JSON.parse(row.intent_json) as { configDigest: string }).configDigest).toBe(expected)
    expect(expected).not.toBe(acceptanceDigest(f.config))
  } finally { db.close() }
})

test('fixed override keeps its original source through a new Session but invalidates on owner rotation', async () => {
  const f = await fixture({ fixed: true, sameOverride: true }); f.append(); const runtime = f.create()
  let runId = ''; let intentDigest = ''
  f.review.mockImplementationOnce(async input => {
    runId = input.id; intentDigest = input.intentDigest
    input.bindSourceRun(actualSourceRun(input))
    return 'reviewed'
  })
  await f.tick()
  expect(runtime.inspectSourceGrowthRun({ runId, intentDigest })).toMatchObject({
    model: f.sourceModel, modelOrigin: 'explicit-growth-override',
  })
  const original = runtime.inspectSourceGrowthRun({ runId, intentDigest })
  f.owner.generation += 1
  expect(runtime.inspectSourceGrowthRun({ runId, intentDigest })).toEqual(original)
  f.owner.principalVersion += 1
  expect(runtime.inspectSourceGrowthRun({ runId, intentDigest })).toBeUndefined()
})

test('source run inspection rejects correction, expiry, changed configuration, and unknown outcomes', async () => {
  const f = await fixture(); f.append(); const first = f.create()
  let runId = ''; let intentDigest = ''; let expiresAt = 0
  f.review.mockImplementationOnce(async input => {
    runId = input.id; intentDigest = input.intentDigest; expiresAt = input.expiresAt
    input.bindSourceRun(actualSourceRun(input))
    return 'reviewed'
  })
  await f.tick()
  expect(first.inspectSourceGrowthRun({ runId, intentDigest })).toBeDefined()
  await first.close()
  const changed = normalizeConfig({ enabled: true, scope: f.config.scope!, budgetId: 'growth-budget', budgetAmount: 1,
    maxToolCalls: 25, usageLearning: { enabled: true, scanBudgetId: 'growth-scan-budget', scanBudgetAmount: 1,
      databasePath: join(f.root, 'usage.sqlite') } })
  const second = f.create(changed)
  expect(second.inspectSourceGrowthRun({ runId, intentDigest })).toBeUndefined()
  await second.close()
  const third = f.create()
  expect(third.inspectSourceGrowthRun({ runId, intentDigest })).toBeDefined()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(expiresAt + 1)
  expect(third.inspectSourceGrowthRun({ runId, intentDigest })).toBeUndefined()
  vi.useRealTimers()
  f.append('task', 'unknown')
  expect(third.inspectSourceGrowthRun({ runId, intentDigest })).toBeUndefined()

  const other = await fixture(); other.append(); const unknown = other.create()
  let unknownId = ''; let unknownDigest = ''
  other.review.mockImplementationOnce(async input => {
    unknownId = input.id; unknownDigest = input.intentDigest
    input.bindSourceRun(actualSourceRun(input))
    return 'unknown'
  })
  await other.tick()
  expect(unknown.health().counts).toEqual({ unknown: 1 })
  expect(unknown.inspectSourceGrowthRun({ runId: unknownId, intentDigest: unknownDigest })).toBeUndefined()
})

test('schema 1 migration preserves legacy intent bytes and never invents a source run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'growth-usage-legacy-'))
  cleanup.push(async () => rm(root, { recursive: true, force: true }))
  const path = join(root, 'usage.sqlite')
  await writeFile(path, '', { mode: 0o600 })
  const db = new DatabaseSync(path)
  const legacyJson = JSON.stringify({ configDigest: 'f'.repeat(64), model: { provider: 'old', model: 'old' },
    source: { owner: {}, canonical: { projection: {} } }, createdAt: 1, expiresAt: 2 })
  const legacyDigest = acceptanceDigest(JSON.parse(legacyJson))
  db.exec(`CREATE TABLE usage_jobs(id TEXT PRIMARY KEY, lane TEXT NOT NULL, subject TEXT NOT NULL,
    intent_json TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, definition_hash TEXT,
    occurrence_id TEXT, reason TEXT) STRICT;
    CREATE TABLE usage_cursors(lane TEXT PRIMARY KEY, scope_key TEXT NOT NULL, watermark INTEGER NOT NULL) STRICT;
    PRAGMA user_version=1;`)
  db.prepare("INSERT INTO usage_jobs(id,lane,subject,intent_json,digest,state) VALUES (?,?,?,?,?,'queued')")
    .run('legacy', 'lane', 'subject', legacyJson, legacyDigest)
  db.close()
  const store = new UsageStore(path)
  expect(store.get('legacy')).toMatchObject({ digest: legacyDigest, sourceRun: null })
  store.close()
  const migrated = new DatabaseSync(path)
  expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
  expect(migrated.prepare('SELECT intent_json,digest,source_run_json FROM usage_jobs WHERE id=?').get('legacy'))
    .toEqual({ intent_json: legacyJson, digest: legacyDigest, source_run_json: null })
  migrated.close()
})

test.each([false, true])('does not guess a missing source model; fixed override=%s', async fixed => {
  const f = await fixture({ missing: true, fixed }); f.append(); const runtime = f.create(); await f.tick()
  expect(f.review).toHaveBeenCalledTimes(fixed ? 1 : 0)
  if (fixed) expect(f.review.mock.calls[0]![0].model).toEqual({ provider: 'fixed', model: 'repair' })
  else expect(runtime.health().counts).toEqual({})
})

test('withdrawal before dispatch cancels the old review without a model call', async () => {
  const f = await fixture(); f.append(); const runtime = f.create(); f.append('task', 'unknown'); runtime.scan(); await f.tick()
  expect(f.review).not.toHaveBeenCalled()
  expect(runtime.health().counts.queued ?? 0).toBe(0)
})

test('native budget refusal settles a queued job without calling the review Agent', async () => {
  const f = await fixture({ budget: false }); f.append(); const runtime = f.create(); await f.tick(); runtime.scan()
  expect(f.review).not.toHaveBeenCalled(); expect(runtime.health().counts).toEqual({ failed: 1 })
})

test('a running review observes a correction and becomes unknown rather than replaying', async () => {
  const f = await fixture(); f.append(); const runtime = f.create()
  f.review.mockImplementationOnce(async input => { f.append('task', 'unknown'); input.assertCurrent(); return 'reviewed' })
  await f.tick()
  expect(runtime.health().counts).toEqual({ unknown: 1 })
  await runtime.close(); const restarted = f.create(); await f.tick()
  expect(f.review).toHaveBeenCalledTimes(1); expect(restarted.health().counts).toEqual({ unknown: 1 })
})

test('backpressure leaves unconsumed heads discoverable after the first job finishes', async () => {
  const f = await fixture({ maxPending: 1 }); f.append('one'); f.append('two'); const runtime = f.create()
  expect(runtime.health().counts).toEqual({ queued: 1 })
  await f.tick(); await f.tick()
  expect(f.review).toHaveBeenCalledTimes(2); expect(runtime.health().counts).toEqual({ reviewed: 2 })
})

test('the native periodic scan discovers later cross-process feedback without a local notification', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  // Keep the review tick away from the next cron minute, which can otherwise
  // occupy the native runner's single admission slot depending on wall time.
  vi.setSystemTime(new Date('2026-09-20T00:00:10Z'))
  const f = await fixture(); const runtime = f.create()
  expect(runtime.health().counts).toEqual({})
  f.append('later')
  const now = Date.now(); vi.setSystemTime(now + 65_000)
  await f.automations.tick(); await f.automations.whenIdle()
  const scanId = f.automations.listSystemOwned({ owner: 'assistant-growth-usage' })
    .find(row => row.automationId.startsWith('usage-scan-'))!.automationId
  expect(f.automations.inspectSystemOwned({ owner: 'assistant-growth-usage', automationId: scanId })
    .latestTerminalRuns.production).toMatchObject({ status: 'succeeded', diagnostic: { budgetSettlementState: 'finalized' } })
  expect(runtime.health().counts).toEqual({ queued: 1 })
  vi.setSystemTime(now + 67_000)
  await f.automations.tick(); await f.automations.whenIdle()
  expect(f.review).toHaveBeenCalledTimes(1)
  expect(runtime.health().counts).toEqual({ reviewed: 1 })
})

test('automatic learning requires its owner scope, budget and native scheduling', () => {
  expect(normalizeConfig({}).usageLearning.enabled).toBe(false)
  expect(() => normalizeConfig({ usageLearning: { enabled: true, scanBudgetId: 'growth-scan-budget', scanBudgetAmount: 1, databasePath: '/tmp/usage.sqlite' } })).toThrow(/usageLearning/)
  expect(() => normalizeConfig({ enabled: true, scope: { workspace: '/work', preset: 'p', principalId: 'u', ownerRouteId: 'r' },
    budgetId: 'b', budgetAmount: 1, intervalMs: 1000, usageLearning: { enabled: true, scanBudgetId: 'growth-scan-budget', scanBudgetAmount: 1, databasePath: '/tmp/usage.sqlite' } })).toThrow(/intervalMs/)
})

test.each([
  {}, { scanBudgetId: 'scan' }, { scanBudgetAmount: 1 },
  { scanBudgetId: ' ', scanBudgetAmount: 1 }, { scanBudgetId: 'scan', scanBudgetAmount: 0 },
  { scanBudgetId: 'scan', scanBudgetAmount: 1.5 }, { scanBudgetId: 'scan', scanBudgetAmount: 10_000_001 },
])('requires an explicit valid discovery budget: %j', scan => {
  expect(() => normalizeConfig({ enabled: true,
    scope: { workspace: '/work', preset: 'p', principalId: 'u', ownerRouteId: 'r' },
    budgetId: 'reviews', budgetAmount: 1,
    usageLearning: { enabled: true, databasePath: '/tmp/usage.sqlite', ...scan },
  })).toThrow()
})

test('native discovery stops at its budget without spending the review allocation', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-20T00:00:10Z'))
  const f = await fixture({ scanBudgetLimit: 1 }); const runtime = f.create()
  const reserve = vi.spyOn(f.policy, 'reserve')
  const scanId = f.automations.listSystemOwned({ owner: 'assistant-growth-usage' })[0]!.automationId
  const latest = () => f.automations.inspectSystemOwned({ owner: 'assistant-growth-usage', automationId: scanId })
    .latestTerminalRuns.production
  vi.setSystemTime(new Date('2026-09-20T00:01:10Z'))
  await f.automations.tick(); await f.automations.whenIdle()
  expect(latest()).toMatchObject({ status: 'succeeded', diagnostic: { budgetSettlementState: 'finalized' } })
  vi.setSystemTime(new Date('2026-09-20T00:02:10Z'))
  await f.automations.tick(); await f.automations.whenIdle()
  expect(latest()).toMatchObject({ diagnostic: { budgetSettlementState: 'not-reserved' } })
  expect(reserve.mock.results.at(-1)).toMatchObject({ type: 'throw', value: expect.objectContaining({ code: 'budget-exhausted' }) })
  expect(f.review).not.toHaveBeenCalled()
  // A local trusted notification can still queue a review using its separate allocation.
  f.append('local'); runtime.scan()
  vi.setSystemTime(new Date('2026-09-20T00:02:12Z'))
  await f.automations.tick(); await f.automations.whenIdle()
  expect(f.review).toHaveBeenCalledTimes(1)
})

test('provider disposal aborts and drains a running review before closing its store', async () => {
  const f = await fixture(); f.append(); const runtime = f.create()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  f.review.mockImplementationOnce(async input => {
    entered()
    await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))
    return 'unknown'
  })
  const ticking = f.tick()
  await started; await runtime.close(); await ticking
  const restarted = f.create()
  expect(restarted.health().counts).toEqual({ unknown: 1 })
  expect(f.review).toHaveBeenCalledTimes(1)
})


test('explicit owner revocation retires only discovery and preserves unknown work across restart and ABA', async () => {
  const f = await fixture(); f.append(); const runtime = f.create()
  f.review.mockResolvedValueOnce('unknown'); await f.tick()
  expect(runtime.health().counts).toEqual({ unknown: 1 })
  const identity = f.automations.listSystemOwned({ owner: 'assistant-growth-usage' }).find(item => item.automationId.startsWith('usage-scan-'))!
  vi.spyOn(f.delivery, 'inspectOwnerRouteState').mockReturnValue({ status: 'revoked', ...f.owner } as never)
  runtime.scan()
  expect(f.automations.inspectSystemOwnedRetirement(identity)).toMatchObject({ reason: 'owner-revoked', automationStatus: 'paused' })
  expect(runtime.health().counts).toEqual({ unknown: 1 })
  await runtime.close()
  vi.spyOn(f.delivery, 'inspectOwnerRouteState').mockReturnValue({ status: 'active', receipt: f.owner })
  const restarted = f.create(); restarted.scan(); await f.tick()
  expect(restarted.health()).toMatchObject({ connected: false, counts: { unknown: 1 } })
  expect(f.review).toHaveBeenCalledTimes(1)
  expect(f.automations.inspectSystemOwned(identity).automationStatus).toBe('paused')
})

test('temporary owner inspection failure preserves queued work and native recovery without retirement', async () => {
  const f = await fixture(); f.append(); const first = f.create(); await first.close()
  const identity = f.automations.listSystemOwned({ owner: 'assistant-growth-usage' }).find(item => item.automationId.startsWith('usage-scan-'))!
  const inspection = vi.spyOn(f.delivery, 'inspectOwnerRouteState').mockReturnValue({ status: 'unavailable', reason: 'missing-binding' } as never)
  const runtime = f.create(); runtime.scan()
  expect(runtime.health().counts).toEqual({ queued: 1 })
  expect(f.automations.inspectSystemOwnedRetirement(identity)).toBeUndefined()
  expect(f.review).not.toHaveBeenCalled()
  inspection.mockReturnValue({ status: 'active', receipt: f.owner })
  runtime.scan(); await f.tick()
  expect(f.review).toHaveBeenCalledTimes(1)
  expect(runtime.health().counts).toEqual({ reviewed: 1 })
})


test('startup temporary owner unavailability recovers through the native scan without restarting', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture()
  const inspection = vi.spyOn(f.delivery, 'inspectOwnerRouteState').mockReturnValue({ status: 'unavailable', reason: 'missing-binding' } as never)
  const runtime = f.create()
  const identity = f.automations.listSystemOwned({ owner: 'assistant-growth-usage' })[0]!
  expect(identity.automationStatus).toBe('active')
  expect(f.review).not.toHaveBeenCalled()
  inspection.mockReturnValue({ status: 'active', receipt: f.owner }); f.append()
  vi.setSystemTime(Date.now() + 60_000)
  await f.automations.tick(); await f.automations.whenIdle()
  expect(runtime.health().counts).toEqual({ queued: 1 })
  vi.setSystemTime(Date.now() + 1500)
  await f.automations.tick(); await f.automations.whenIdle()
  expect(f.review).toHaveBeenCalledTimes(1)
  expect(runtime.health().counts).toEqual({ reviewed: 1 })
  expect(f.automations.inspectSystemOwnedRetirement(identity)).toBeUndefined()
})


test('startup retirement read outage establishes a fresh Usage cron and recovers on its native tick', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture()
  const inspection = vi.spyOn(f.automations, 'inspectSystemOwnedRetirement')
    .mockImplementation(() => { throw new Error('temporary retirement read unavailable') })
  const runtime = f.create(), identity = f.automations.listSystemOwned({ owner: 'assistant-growth-usage' })[0]!
  expect(identity.automationStatus).toBe('active')
  expect(f.review).not.toHaveBeenCalled()
  inspection.mockRestore(); f.append(); vi.setSystemTime(Date.now() + 60_000)
  await f.automations.tick(); await f.automations.whenIdle()
  expect(runtime.health().counts).toEqual({ queued: 1 })
  vi.setSystemTime(Date.now() + 1500)
  await f.automations.tick(); await f.automations.whenIdle()
  expect(f.review).toHaveBeenCalledTimes(1)
  expect(runtime.health().counts).toEqual({ reviewed: 1 })
})


test('native scheduler wake silently restores fresh Usage registration after both startup APIs recover', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T12:00:10Z'))
  const f = await fixture()
  const inspection = vi.spyOn(f.automations, 'inspectSystemOwnedRetirement')
    .mockImplementation(() => { throw new Error('SQLITE_BUSY retirement inspection') })
  const reconciliation = vi.spyOn(f.automations, 'reconcileSystem')
    .mockImplementation(() => { throw new Error('SQLITE_BUSY scanner registration') })
  const runtime = f.create()
  expect(f.automations.listSystemOwned({ owner: 'assistant-growth-usage' })).toEqual([])
  inspection.mockRestore(); reconciliation.mockRestore()
  vi.setSystemTime(Date.now() + 1000)
  await f.automations.tick(); await f.automations.whenIdle()
  const identity = f.automations.listSystemOwned({ owner: 'assistant-growth-usage' })[0]!
  expect(identity.automationStatus).toBe('active')
  expect(runtime.health().lastScanAt).toBeNull()
  expect(f.review).not.toHaveBeenCalled()
  f.append(); vi.setSystemTime(Date.now() + 59_000)
  await f.automations.tick(); await f.automations.whenIdle()
  expect(runtime.health().counts).toEqual({ queued: 1 })
  vi.setSystemTime(Date.now() + 1500)
  await f.automations.tick(); await f.automations.whenIdle()
  expect(f.review).toHaveBeenCalledTimes(1)
})


test('Usage close unregisters recovery before closing its store while Automations continues ticking', async () => {
  const f = await fixture()
  const onWake = f.automations.onSchedulerWake.bind(f.automations), disposers: ReturnType<typeof vi.fn>[] = []
  vi.spyOn(f.automations, 'onSchedulerWake').mockImplementation(listener => {
    const dispose = vi.fn(onWake(listener)); disposers.push(dispose); return dispose
  })
  const inspection = vi.spyOn(f.automations, 'inspectSystemOwnedRetirement')
    .mockImplementation(() => { throw new Error('SQLITE_BUSY retirement inspection') })
  const reconciliation = vi.spyOn(f.automations, 'reconcileSystem')
    .mockImplementation(() => { throw new Error('SQLITE_BUSY scanner registration') })
  const runtime = f.create(); await runtime.close()
  expect(disposers).toHaveLength(1); expect(disposers[0]).toHaveBeenCalledOnce()
  inspection.mockRestore(); reconciliation.mockRestore()
  const restored = vi.spyOn(f.automations, 'reconcileSystem')
  await f.automations.tick(); await f.automations.whenIdle()
  expect(restored).not.toHaveBeenCalled()
  expect(f.automations.listSystemOwned({ owner: 'assistant-growth-usage' })).toEqual([])
  expect(f.review).not.toHaveBeenCalled()
})

/** Source/CP contracts are fixtures here; native scheduling, persistence and budget are real. */
async function workItemFixture(options: { missing?: boolean; ready?: boolean; maxPending?: number; maxToolCalls?: number; toolPolicy?: 'allow' | 'deny' } = {}) {
  const f = await fixture({ ...(options.maxPending === undefined ? {} : { maxPending: options.maxPending }), ...(options.toolPolicy ? { toolPolicy: options.toolPolicy } : {}) })
  let growthCtx!: Context
  const growthFork = f.ctx.plugin({ name: 'dsh-enhanced-assistant-growth-driver', apply(ctx: Context) { growthCtx = ctx } }); await growthFork
  const until = Date.now() + 100_000, sourceOccurredAt = Date.now() - 100, workerCompletedAt = Date.now() - 200
  const acceptance: CreationAcceptanceAuthorityRef = { protocol: 'assistant-growth/creation-acceptance-authority/v1', authorityId: 'wi-review',
    authorityDigest: 'c'.repeat(64), keyId: 'wi-key', namePrefix: 'created-', expiresAt: until }
  const pins: WorkItemGrowthAuthorityPins = { protocol: 'assistant-growth/work-item-authorities/v1',
    sourceJobs: { authorityId: 'source', authorityDigest: 'a'.repeat(64), expiresAt: until },
    creationGrant: { id: 'create', digest: 'b'.repeat(64), expiresAt: until }, creationAcceptance: acceptance,
    adoption: { authorityId: 'adopt', authorityDigest: 'd'.repeat(64), expiresAt: until } }
  let missing = options.missing ?? false, version = 1, withdrawn = false, unrelatedWatermark = 0
  const config = normalizeConfig({ enabled: true, ...(options.maxToolCalls === undefined ? {} : { maxToolCalls: options.maxToolCalls }), scope: f.config.scope!, budgetId: 'growth-budget', budgetAmount: 1,
    usageLearning: { enabled: true, databasePath: join(f.root, 'usage.sqlite'), scanBudgetId: 'growth-scan-budget', scanBudgetAmount: 1,
      maxPending: options.maxPending ?? 16, workItemFailures: true, workItemAuthorities: pins },
    pluginSourceProposals: { enabled: true, allowCreation: true, preparationMode: 'durable', repository: f.root } })
  const canonical = () => ({ triggerOutcomeId: 'unrelated-trigger', scope: { workspace: f.root, preset: 'primary' }, scopeKey: 'wi-scope',
    scopeWatermark: version + unrelatedWatermark, situation: 'work-item:child', projection: { subjectKind: 'work-item' as const, subjectRef: 'child', version,
      digest: acceptanceDigest(['canonical', version]), disposition: withdrawn ? 'retract' as const : 'upsert' as const },
    objective: { outcomeId: `owner-objective-${version}`, status: withdrawn ? 'unknown' as const : 'not-achieved' as const,
      occurredAt: sourceOccurredAt, source: { kind: 'user-feedback' as const, id: 'assistant-delivery/typed-owner-feedback' },
      evidence: [], evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' } } })
  const rootInput = { kind: 'foreground' as const, inboxId: 'actual-owner-inbox', sourceDigest: 'e'.repeat(64), executionRef: 'root-run',
    completionSequence: 1, binding: { id: 'original-binding', version: 1, generation: 1 } }
  const childInput = { kind: 'continuation' as const, sourceDigest: 'f'.repeat(64), inputSha256: workItemTextDigest('Use the child requirement.原样'), inputBytes: Buffer.byteLength('Use the child requirement.原样') }
  const objective = acceptanceCanonicalJson({ protocol: 'work-item-owner-objective/v1', inputs: [
    { itemId: 'root', source: rootInput, text: 'Root task original.' }, { itemId: 'child', source: childInput, text: 'Use the child requirement.原样' }] })
  const source = (): OwnerWorkItemEngineeringContextSource => ({ task: { protocol: 'assistant-delivery/owner-work-item-learning/v1', owner: { ...f.owner },
    canonical: canonical(), judgement: 'owner-feedback', ownerRevision: { version, action: 'initial', operationId: 'owner-feedback' },
    proofIdentity: { protocol: 'assistant-work-items/owner-report-feedback/v1', itemId: 'child', reportRevision: 1, reportDigest: 'a'.repeat(64),
      sourceId: 'source', itemKind: 'reply', scope: { workspace: f.root, preset: 'primary' }, owner: { ownerRouteId: f.owner.authorityId, principalId: f.owner.principalId,
        principalRecordId: f.owner.principalRecordId, principalVersion: f.owner.principalVersion }, originBindingId: 'original-binding',
      production: { automationId: 'worker', occurrenceId: 'worker-occurrence', runId: 'worker-run', definitionHash: 'b'.repeat(64), definitionVersion: 1,
        executionStatus: 'succeeded', completedAt: workerCompletedAt, quiescent: true, budgetSettlementState: 'finalized' },
      supplier: { provider: 'original-worker', model: 'original-model' }, planDigest: 'c'.repeat(64), proofDigest: 'd'.repeat(64) },
    sourceDigest: 'e'.repeat(64), presentationDigest: 'f'.repeat(64), presentation: { brief: { text: 'Worker generated brief.', truncated: false, redacted: false },
      report: { text: 'Untrusted worker report.', truncated: false, redacted: false }, feedback: { inboxId: 'feedback', text: 'The child requirement failed.', truncated: false, redacted: false } } },
    manifest: { protocol: 'assistant-delivery/work-item-engineering-context/v1', itemId: 'child', rootItemId: 'root', feedbackProofDigest: 'd'.repeat(64),
      materialDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), objective: { protocol: 'work-item-owner-objective/v1', fullTextDigest: workItemTextDigest(objective), fullBytes: Buffer.byteLength(objective) },
      nodes: [{ itemId: 'root', planProtocol: 'assistant-work-items/foreground-diagnosis-plan/v1', planDigest: 'a'.repeat(64), input: rootInput, parent: null },
        { itemId: 'child', planProtocol: 'assistant-work-items/owner-continuation-plan/v1', planDigest: 'b'.repeat(64), input: childInput,
          parent: { itemId: 'root', rootItemId: 'root', report: null, outcomeRevision: 1, productionDigest: 'c'.repeat(64) } }], reports: [] }, objective })
  vi.spyOn(f.evaluation, 'listTrustedTaskLearningProjections').mockImplementation(({ after }) => ({
    items: (after?.watermark ?? 0) < version ? [{ watermark: version, receipt: canonical() }] : [], nextCursor: { scopeKey: 'wi-scope', watermark: version }, scopeWatermark: version, hasMore: false }))
  vi.spyOn(f.evaluation, 'getTrustedWorkItemLearningProjection').mockImplementation(() => canonical())
  vi.spyOn(f.evaluation, 'withTrustedCanonicalTaskWriterFence').mockImplementation((_input, callback) => ({ matched: true, value: callback() }))
  const delivery = { ...f.delivery,
    inspectOwnerWorkItemEngineeringContext: () => missing ? undefined : source(),
    readOwnerWorkItemEngineeringContext: () => missing ? undefined : { manifestDigest: source().manifest.manifestDigest,
      fullTextDigest: workItemTextDigest(objective), fullBytes: Buffer.byteLength(objective), text: objective, offset: 0, returnedBytes: Buffer.byteLength(objective) },
    withOwnerWorkItemEngineeringContextFence: <T,>(_input: unknown, callback: (value: OwnerWorkItemEngineeringContextSource) => T) => callback(source()),
  }
  let readiness: WorkItemCreationReadiness | undefined = options.ready === false ? undefined : { protocol: 'assistant-growth/work-item-creation-readiness/v1',
    sourceProtocol: 'assistant-delivery/work-item-engineering-context/v1', runProtocol: 'assistant-growth/source-run/v2', workItemFailures: true, pins,
    remaining: { sourceSubmissions: 1, creates: 1, verifications: 1, adoptions: 1 }, available: true }
  let readinessHook: (() => void) | undefined
  const review = vi.fn<(input: WorkItemUsageReviewInput) => Promise<UsageReviewResult>>(async input => {
    input.assertCurrent(); input.assertFirstModelAdmission(); input.bindSourceRun({ ...actualSourceRun(input), creationAcceptance: acceptance }); return 'reviewed'
  })
  const create = () => {
    const runtime = new UsageLearningRuntime(config, { evaluation: f.evaluation, automations: f.automations, delivery, review: f.review,
      inspectWorkItemToolPreauthorization: () => f.policy.workItemGrowthToolPreauthorizationVersion?.() === 1 && typeof f.policy.registerPreauthorizedTool === 'function',
      reviewWorkItem: review, inspectWorkItemCreationReadiness: () => { const result = readiness; readinessHook?.(); return result } })
    cleanup.push(() => runtime.close()); runtime.start(); return runtime
  }
  const tick = async () => { vi.setSystemTime(Date.now() + 1500); for (let i = 0; i < 3; i++) { await f.automations.tick(); await f.automations.whenIdle() } }
  return { ...f, growthCtx, growthFork, config, pins, review, create, tick, source, delivery, setMissing: (value: boolean) => { missing = value },
    setReadiness: (value: WorkItemCreationReadiness | undefined) => { readiness = value }, setReadinessHook: (hook: (() => void) | undefined) => { readinessHook = hook }, readiness: () => readiness,
    withdraw: () => { withdrawn = true; version++ }, correct: () => { version++ }, unrelatedChange: () => { unrelatedWatermark++ } }
}

test('work item locator survives reader absence and restart; source stays typed, original supplier and current child objective are frozen once', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = await workItemFixture({ missing: true })
  const first = f.create(); expect(first.health().counts).toEqual({}); await first.close()
  const ledger = new UsageStore(join(f.root, 'usage.sqlite'))
  const saved = ledger.pendingWorkItems(acceptanceDigest(f.config.scope))[0]!
  expect(saved.locator.canonical.outcomeId).toBe('owner-objective-1'); expect(saved.locator).not.toHaveProperty('inboxId'); ledger.close()
  f.setMissing(false); const restarted = f.create(); await f.tick()
  expect(f.review).toHaveBeenCalledOnce(); expect(f.review.mock.calls[0]![0].source.objective).toContain('Use the child requirement.')
  expect(f.review.mock.calls[0]![0].model).toEqual({ provider: 'original-worker', model: 'original-model' })
  expect(restarted.health().counts).toEqual({ reviewed: 1 }); restarted.scan(); await f.tick(); expect(f.review).toHaveBeenCalledOnce()
})

test('old or unavailable peer leaves same locator with zero paid native runs, reservations or author calls', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = await workItemFixture({ ready: false }), runtime = f.create()
  const ledger = new UsageStore(join(f.root, 'usage.sqlite')), id = ledger.pendingWorkItems(acceptanceDigest(f.config.scope))[0]!.id; ledger.close()
  await f.tick(); runtime.scan(); expect(f.review).not.toHaveBeenCalled()
  const db = new DatabaseSync(join(f.root, 'policy.sqlite')); expect(db.prepare('SELECT * FROM budget_reservations').all()).toEqual([]); db.close()
  const reopened = new UsageStore(join(f.root, 'usage.sqlite')); expect(reopened.pendingWorkItems(acceptanceDigest(f.config.scope))[0]!.id).toBe(id); reopened.close()
})

test('withdrawal after full freeze blocks a work item author before claim', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = await workItemFixture(), runtime = f.create()
  expect(runtime.health().counts).toEqual({ queued: 1 }); f.withdraw(); await f.tick()
  expect(f.review).not.toHaveBeenCalled()
})

test('producer v2 holds an actual UsageStore writer, freezes binding, rejects thenables and keeps last allowance valid', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = await workItemFixture(), runtime = f.create(); await f.tick()
  const input = f.review.mock.calls[0]![0], binding = runtime.inspectAnySourceGrowthRun({ runId: input.id, intentDigest: input.intentDigest })!
  expect(binding.protocol).toBe('assistant-growth/source-run/v2')
  f.setReadiness({ ...f.readiness()!, remaining: { sourceSubmissions: 0, creates: 0, verifications: 0, adoptions: 0 }, available: false })
  const request = { runId: input.id, intentDigest: input.intentDigest, expectedGrowthRunDigest: anySourceGrowthRunDigest(binding) }
  expect(runtime.withWorkItemRunFence(request, value => { expect(Object.isFrozen(value.source.context)).toBe(true);
    const contender = new DatabaseSync(join(f.root, 'usage.sqlite')); contender.exec('PRAGMA busy_timeout=1')
    try { expect(() => contender.exec('BEGIN IMMEDIATE')).toThrow(/locked/) } finally { contender.close() }
    return value.runId })).toBe(input.id)
  expect(() => runtime.withWorkItemRunFence(request, () => Promise.resolve('bad'))).toThrow(/synchronous/)
  expect(() => runtime.withWorkItemRunFence({ ...request, expectedGrowthRunDigest: '0'.repeat(64) }, () => 'bad')).toThrow(/binding changed/)
  f.owner.generation++; f.owner.bindingVersion++; f.unrelatedChange()
  expect(runtime.inspectAnySourceGrowthRun(request)?.runId).toBe(input.id)
  f.withdraw(); expect(runtime.inspectAnySourceGrowthRun(request)).toBeUndefined()
})

test('unknown work item author never supplies new producer authority or replays its paid occurrence', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = await workItemFixture()
  f.review.mockImplementation(async input => { input.bindSourceRun({ ...actualSourceRun(input), creationAcceptance: f.pins.creationAcceptance }); return 'unknown' })
  const first = f.create(); await f.tick()
  const input = f.review.mock.calls[0]![0], request = { runId: input.id, intentDigest: input.intentDigest }
  expect(first.health().counts).toEqual({ unknown: 1 }); expect(first.inspectAnySourceGrowthRun(request)).toBeUndefined()
  expect(() => first.withWorkItemRunFence({ ...request, expectedGrowthRunDigest: 'a'.repeat(64) }, () => 'bad')).toThrow()
  const db = new DatabaseSync(join(f.root, 'policy.sqlite')), reservations = db.prepare('SELECT * FROM budget_reservations ORDER BY id').all(); db.close()
  await first.close(); const restarted = f.create(); await f.tick()
  expect(restarted.health().counts).toEqual({ unknown: 1 }); expect(f.review).toHaveBeenCalledOnce()
  const after = new DatabaseSync(join(f.root, 'policy.sqlite')); expect(after.prepare('SELECT * FROM budget_reservations ORDER BY id').all()).toEqual(reservations); after.close()
})


test('producer UsageStore frame rejects same-instance mutations, rolls back throw/thenable and clears guard', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = await workItemFixture(), runtime = f.create(); await f.tick()
  const input = f.review.mock.calls[0]![0], request = { runId: input.id, intentDigest: input.intentDigest }
  const store = new UsageStore(join(f.root, 'usage.sqlite')), before = store.get(input.id)
  for (const mutate of [() => store.interrupt(acceptanceDigest(f.config.scope)), () => store.settle(input.id, 'superseded', 'bad'), () => store.close()]) {
    expect(() => store.withWorkItemRunWriter(request, mutate)).toThrow(/forbidden/)
    expect(store.get(input.id)).toEqual(before)
  }
  expect(() => store.withWorkItemRunWriter(request, () => { throw new Error('consumer failed') })).toThrow(/consumer failed/)
  expect(() => store.withWorkItemRunWriter(request, () => Promise.resolve('bad'))).toThrow(/synchronous/)
  let proxyReads = 0
  expect(() => store.withWorkItemRunWriter(request, () => new Proxy({}, { has: () => { proxyReads++; return false } }))).toThrow(/synchronous/)
  expect(proxyReads).toBe(0)
  expect(store.withWorkItemRunWriter(request, job => job.id)).toBe(input.id)
  store.interrupt(acceptanceDigest(f.config.scope)); expect(store.get(input.id)).toEqual(before); store.close()
  expect(runtime.health().counts).toEqual({ reviewed: 1 })
})


for (const loseReadyBeforeModel of [false, true, 'withdraw-in-final-probe'] as const) test(`native work item author pins creation-only tools and rechecks before first LLM (${loseReadyBeforeModel})`, async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = await workItemFixture()
  await mountAgentLoopTestDependencies(f.ctx, { workingDirectory: true })
  class Adapter extends LlmAdapter {
    requests: GenerateOptions[] = []
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'No bounded candidate is justified.' } }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const adapter = new Adapter(); f.ctx.llm.registerAdapter(['original-worker'], adapter); await f.ctx.plugin(AgentLoop, { agents: [] })
  const plane: GrowthSourcePlanePort = { listOpenGaps: () => [],
    // Real Control Plane exposes target discovery even when this source is creation-only.
    inspectSourceTargets: async () => ({ baseCommit: 'a'.repeat(40), plugins: [] }), inspectSource: async () => { throw new Error('not used') },
    inspectCreateSource: async () => { throw new Error('not used') }, getSourceCreationNamespace: () => ({ namePrefix: 'created-' }),
    inspectSourceCreationAcceptanceAuthority: () => f.pins.creationAcceptance,
    prepareModifySourcePlan: async () => { throw new Error('modification forbidden') }, enqueueSourceJob: async () => { throw new Error('no candidate') },
    inspectSourceJob: () => { throw new Error('not used') } }
  let authorFailure: unknown
  f.review.mockImplementation(async input => {
    try {
    const authority = mintGrowthAuthority({ validateOwnerRoute: f.delivery.validateOwnerRoute, commitOwnerAnchoredWorkflowTrace: async () => { throw new Error('not used') } }, f.config.scope!, input.expiresAt, true)
    const result = await runGrowthAgent(f.growthCtx, { wakeId: input.id, authority, config: f.config, model: { provider: input.model.provider, model: input.model.model, ...(input.model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(input.model.reasoningEffort) }) },
      goals: { inspectOwnerGoals: () => [], inspectOwnerVerifiedWorkflowSource: () => { throw new Error('not used') } },
      skills: { inspectOwnerActiveSkills: () => [], inspectOwnerSkillCandidates: () => [], stageOwnerVerifiedSuccessCandidate: async () => { throw new Error('skill write forbidden') } },
      sourcePlane: plane, feedback: input.source, signal: input.signal, generationDeadlineAt: input.expiresAt,
      onSourceExecution: actual => { const binding = input.bindSourceRun(actual); if (loseReadyBeforeModel === true) f.setReadiness(undefined); return binding },
      workItemAuthorization: { runId: input.id, intentDigest: input.intentDigest, definitionHash: input.definitionHash, occurrenceId: input.occurrenceId, assertCurrent: input.assertCurrent },
      assertFirstModelAdmission: () => {
        let probes = 0
        if (loseReadyBeforeModel === 'withdraw-in-final-probe') f.setReadinessHook(() => { if (++probes === 2) f.withdraw() })
        try { input.assertFirstModelAdmission() } finally { f.setReadinessHook(undefined) }
      } })
    return result.outcome === 'succeeded' ? 'reviewed' : 'unknown'
    } catch (error) { authorFailure = String(error); throw error }
  })
  const effectBaseline = f.growthCtx.fiber.getEffects().length
  const runtime = f.create(); await f.tick()
  if (loseReadyBeforeModel) { expect(adapter.requests).toHaveLength(0); expect(runtime.health().counts).toEqual({ unknown: 1 }) }
  else {
    expect(authorFailure).toBeUndefined()
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]!.tools?.map(tool => tool.name).sort()).toEqual(['plugin_source_create', 'plugin_source_gaps', 'plugin_source_job_status', 'plugin_source_read'])
    const messages = JSON.stringify(adapter.requests[0]!.messages)
    expect(messages).toContain('Use the child requirement.')
    expect(messages).toContain('Untrusted worker report.')
    expect(runtime.health().counts).toEqual({ reviewed: 1 })
    const preauthorizationEffects = () => f.growthCtx.fiber.getEffects().filter(effect => ['assistant-policy.preauthorized-tool', 'assistant-growth-driver.work-item-preauthorization'].includes(effect.label))
    expect(preauthorizationEffects()).toHaveLength(0)
    expect(f.growthCtx.fiber.getEffects()).toHaveLength(effectBaseline)
    f.correct(); runtime.scan(); await f.tick()
    expect(adapter.requests).toHaveLength(2)
    expect(preauthorizationEffects()).toHaveLength(0)
    expect(f.growthCtx.fiber.getEffects()).toHaveLength(effectBaseline)
  }
})


test('producer writer consumes rejected native Promise before rejecting synchronous callback and releasing writer', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = await workItemFixture(); f.create(); await f.tick()
  const input = f.review.mock.calls[0]![0], request = { runId: input.id, intentDigest: input.intentDigest }
  const store = new UsageStore(join(f.root, 'usage.sqlite')), before = store.get(input.id)
  const unhandled: unknown[] = [], capture = (error: unknown) => { unhandled.push(error) }
  process.on('unhandledRejection', capture)
  try {
    let thenReads = 0
    const rejected = Promise.reject(new Error('work-item-native-promise-rejected'))
    // oxlint-disable-next-line unicorn/no-thenable -- Verify that the synchrony guard never reads this custom getter.
    Object.defineProperty(rejected, 'then', { get: () => { thenReads++; throw new Error('custom then getter must not run') } })
    expect(() => store.withWorkItemRunWriter(request, () => rejected)).toThrow(/synchronous/)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(unhandled).toEqual([])
    expect(thenReads).toBe(0)
    expect(store.get(input.id)).toEqual(before)
    expect(store.withWorkItemRunWriter(request, job => job.id)).toBe(input.id)
  } finally { process.off('unhandledRejection', capture); store.close() }
})

for (const mode of ['allowed-last-slot', 'policy-deny', 'withdraw', 'expired', 'schema-drift', 'wrong-agent', 'global-same-name', 'closed', 'cancelled', 'missing-binding', 'wrong-session-binding', 'wrong-occurrence-binding', 'policy-replaced-in-source-check'] as const) test(`real Policy WorkItem preauthorization without approval channel: ${mode}`, async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = await workItemFixture({ maxToolCalls: 2, toolPolicy: mode === 'policy-deny' ? 'deny' : 'allow' })
  await mountAgentLoopTestDependencies(f.ctx, { workingDirectory: true })
  let bodies = 0, globalBodies = 0, count = 0
  let closeTask: Promise<void> | undefined
  const results: ToolExecutionResult[] = [], authorization: boolean[] = [], afterGuardAuthorization: boolean[] = []
  let replacePolicyDuringCheck = false, replacements = 0
  f.ctx.on('tools/pre-execute', async (execution, next) => { authorization.push(f.policy.isPreauthorizedTool(execution)); return next() })
  f.ctx.on('tools/execute', async (execution, next) => { afterGuardAuthorization.push(f.policy.isPreauthorizedTool(execution)); return next() })
  const plane: GrowthSourcePlanePort = { listOpenGaps: () => { bodies++; return [] }, inspectSource: async () => { throw new Error('not used') },
    inspectSourceTargets: async () => ({ baseCommit: 'a'.repeat(40), plugins: [] }), inspectCreateSource: async () => { throw new Error('not used') },
    getSourceCreationNamespace: () => ({ namePrefix: 'created-' }), inspectSourceCreationAcceptanceAuthority: () => f.pins.creationAcceptance,
    prepareModifySourcePlan: async () => { throw new Error('not allowed') }, enqueueSourceJob: async () => { throw new Error('not used') },
    inspectSourceJob: input => { bodies++; return { id: input.id, name: 'created-tool', gapId: 'gap', baseCommit: 'a'.repeat(40), status: 'queued', createdAt: 1, expiresAt: 2 } } }
  class Adapter extends LlmAdapter {
    requests = 0
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests++
      const agent = f.ctx.agents.get(SessionId(options.sessionId!))!
      if (!agent) throw new Error('real author Agent missing')
      agent.session.append('approval/policy', { policy: 'ask' }); setApprovalReviewer(agent.session, 'user')
      expect(getApprovalReviewer(agent.session)).toBe('user')
      const invoke = (name: string, target = agent, signal = new AbortController().signal) => f.ctx.tools.execute({
        name, arguments: name === 'plugin_source_job_status' ? { id: 'existing-job' } : {}, agent: target,
        callId: ToolCallId(`preauthorized-${++count}`), signal })
      if (mode === 'policy-replaced-in-source-check') replacePolicyDuringCheck = true
      if (mode === 'withdraw') f.withdraw()
      if (mode === 'expired') vi.setSystemTime(Date.now() + 200_000)
      if (mode === 'schema-drift') Object.defineProperty(agent.ctx.tools.get('plugin_source_gaps', agent)!, 'description', { value: 'changed after binding' })
      if (mode === 'closed') { closeTask = f.growthFork.dispose(); await Promise.resolve() }
      if (mode === 'wrong-agent' || mode === 'global-same-name') {
        const foreign = await f.ctx.agents.create({ sessionId: SessionId('foreign-work-item-author'), meta: { cwd: f.root, agentPreset: 'primary' }, agentOptions: { provider: 'original-worker', model: 'original-model' } })
        try {
          foreign.agent.session.append('approval/policy', { policy: 'ask' }); setApprovalReviewer(foreign.agent.session, 'user')
          if (mode === 'wrong-agent') foreign.agent.ctx.tools.register(agent.ctx.tools.get('plugin_source_gaps', agent)!)
          else f.ctx.tools.register(defineTool({ name: 'plugin_source_gaps', description: 'same name, different global definition', parameters: {},
            output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'global' }] }, execute: async () => { globalBodies++; return 'global' } }))
          results.push(await invoke('plugin_source_gaps', foreign.agent))
        } finally { await foreign.dispose() }
      } else {
        const controller = new AbortController(); if (mode === 'cancelled') controller.abort()
        results.push(await invoke('plugin_source_gaps', agent, controller.signal))
      }
      if (mode === 'allowed-last-slot') {
        f.setReadiness({ ...f.readiness()!, remaining: { sourceSubmissions: 0, creates: 0, verifications: 0, adoptions: 0 }, available: false })
        results.push(await invoke('plugin_source_job_status'))
        results.push(await invoke('plugin_source_gaps'))
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Bounded author completed.' } }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const adapter = new Adapter(); f.ctx.llm.registerAdapter(['original-worker'], adapter); await f.ctx.plugin(AgentLoop, { agents: [] })
  f.review.mockImplementation(async input => {
    const authority = mintGrowthAuthority({ validateOwnerRoute: f.delivery.validateOwnerRoute, commitOwnerAnchoredWorkflowTrace: async () => { throw new Error('not used') } }, f.config.scope!, input.expiresAt, true)
    const result = await runGrowthAgent(f.growthCtx, { wakeId: input.id, authority, config: f.config, model: { provider: input.model.provider, model: input.model.model },
      goals: { inspectOwnerGoals: () => [], inspectOwnerVerifiedWorkflowSource: () => { throw new Error('not used') } },
      skills: { inspectOwnerActiveSkills: () => [], inspectOwnerSkillCandidates: () => [], stageOwnerVerifiedSuccessCandidate: async () => { throw new Error('not used') } },
      sourcePlane: plane, feedback: input.source, signal: input.signal, generationDeadlineAt: input.expiresAt,
      workItemAuthorization: { runId: input.id, intentDigest: input.intentDigest, definitionHash: input.definitionHash, occurrenceId: input.occurrenceId, assertCurrent: () => {
        input.assertCurrent()
        if (replacePolicyDuringCheck) { replacePolicyDuringCheck = false; replacements++; f.growthCtx.provide('assistantPolicy', undefined as never) }
      } },
      assertFirstModelAdmission: input.assertFirstModelAdmission,
      onSourceExecution: actual => {
        const binding = input.bindSourceRun(actual)
        if (mode === 'missing-binding') return undefined
        if (mode === 'wrong-session-binding') return { ...binding, sessionId: 'another-session' }
        if (mode === 'wrong-occurrence-binding') return { ...binding, native: { ...binding.native, occurrenceId: 'another-occurrence' } }
        return binding
      } })
    return result.outcome === 'succeeded' ? 'reviewed' : 'unknown'
  })
  f.create(); await f.tick(); await closeTask
  if (mode === 'missing-binding' || mode === 'wrong-session-binding' || mode === 'wrong-occurrence-binding') { expect(adapter.requests).toBe(0); expect(bodies).toBe(0); return }
  expect(adapter.requests).toBe(1)
  if (mode === 'allowed-last-slot') {
    expect(results.map(result => result.isError === true), JSON.stringify(results)).toEqual([false, false, true])
    expect(bodies).toBe(2); expect(authorization.filter(Boolean)).toHaveLength(2)
    expect(afterGuardAuthorization).toEqual([true, true])
  } else {
    expect(results).toHaveLength(1); expect(results[0]!.isError).toBe(true); expect(bodies).toBe(0)
    if (mode === 'policy-deny') expect(authorization).toContain(true)
  }
  if (mode === 'policy-replaced-in-source-check') expect(replacements).toBe(1)
  expect(globalBodies).toBe(0)
})

test('missing Policy WorkItem capability keeps the same locator with zero paid author runs', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = await workItemFixture({ toolPolicy: 'allow' })
  Object.defineProperty(f.policy, 'workItemGrowthToolPreauthorizationVersion', { value: undefined })
  const runtime = f.create(); await f.tick(); expect(f.review).not.toHaveBeenCalled()
  const db = new DatabaseSync(join(f.root, 'policy.sqlite')); expect(db.prepare('SELECT * FROM budget_reservations').all()).toEqual([]); db.close()
  expect(runtime.health().counts).toEqual({})
})

test('published default Growth plugin preauthorizes its real native WorkItem tool call without an approval channel', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = await workItemFixture({ toolPolicy: 'allow' })
  await mountAgentLoopTestDependencies(f.ctx, { workingDirectory: true })
  let requests = 0, successfulTools = 0
  class Adapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const agent = f.ctx.agents.get(SessionId(options.sessionId!))!
      agent.session.append('approval/policy', { policy: 'ask' }); setApprovalReviewer(agent.session, 'user')
      if (requests++ === 0) {
        const id = ToolCallId('actual-default-growth-gap')
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'plugin_source_gaps', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'plugin_source_gaps', arguments: '{}' } }
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'No candidate justified.' } }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  f.ctx.llm.registerAdapter(['original-worker'], new Adapter()); await f.ctx.plugin(AgentLoop, { agents: [] })
  f.ctx.on('tools/post-execute', async (execution, result, next) => { if (execution.name === 'plugin_source_gaps' && !result.isError) successfulTools++; return next() })
  f.ctx.provide('assistantGoals' as never, { inspectOwnerGoals: () => [], inspectOwnerVerifiedWorkflowSource: () => { throw new Error('not used') } } as never)
  f.ctx.provide('assistantSkills' as never, { inspectOwnerActiveSkills: () => [], inspectOwnerSkillCandidates: () => [], stageOwnerVerifiedSuccessCandidate: async () => { throw new Error('not used') } } as never)
  f.ctx.provide('assistantDelivery', f.delivery as never)
  f.ctx.provide('pluginControlPlane' as never, {
    canEnqueueSource: () => true, gaps: () => [], registerSourceGrowthRunProducer: () => () => {}, reconcileSourceGrowthRuns: () => {},
    inspectWorkItemCreationReadiness: () => f.readiness(), recordOwnerWorkItemFailureGap: () => ({ id: 'gap', capability: 'new-tool', context: 'authenticated failure', status: 'open', createdAt: 1 }),
    inspectSourceTargets: async () => ({ baseCommit: 'a'.repeat(40), plugins: [] }), inspectSource: async () => { throw new Error('not used') },
    inspectCreateSource: async () => { throw new Error('not used') }, getSourceCreationNamespace: () => ({ namePrefix: 'created-' }), inspectSourceCreationAcceptanceAuthority: () => f.pins.creationAcceptance,
    prepareModifySourcePlan: async () => { throw new Error('not used') }, enqueueSourceJob: async () => { throw new Error('not used') }, inspectSourceJob: () => { throw new Error('not used') },
  } as never)
  const fork = f.ctx.plugin(GrowthPlugin, { enabled: true, scope: f.config.scope!, budgetId: 'growth-budget', budgetAmount: 1,
    usageLearning: { enabled: true, databasePath: join(f.root, 'usage.sqlite'), scanBudgetId: 'growth-scan-budget', scanBudgetAmount: 1, workItemFailures: true, workItemAuthorities: f.pins },
    pluginSourceProposals: { enabled: true, allowCreation: true, preparationMode: 'durable', repository: f.root } })
  cleanup.push(async () => { await fork.dispose() }); await fork; await fork.await()
  expect(fork.name).toBe('dsh-enhanced-assistant-growth-driver')
  await f.tick()
  expect(requests).toBe(2); expect(successfulTools).toBe(1)
  const ledger = new UsageStore(join(f.root, 'usage.sqlite'))
  try { expect(ledger.counts(acceptanceDigest(f.config.scope))).toEqual({ reviewed: 1 }) } finally { ledger.close() }
})
