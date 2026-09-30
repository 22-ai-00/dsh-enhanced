import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { SourceGrowthRunUnavailableError, type CreationAcceptanceAuthorityRef } from '@dsh-enhanced/assistant-growth-contract'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantEvaluationService, EvaluationStore } from '@dsh-enhanced/assistant-evaluation'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import { afterEach, expect, test, vi } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
import { UsageLearningRuntime, type UsageReviewInput, type UsageReviewResult } from '../src/usage-runtime.ts'
import { UsageStore } from '../src/usage-store.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function fixture(options: { fixed?: boolean; sameOverride?: boolean; missing?: boolean; budget?: boolean; maxPending?: number; scanBudgetLimit?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'growth-usage-'))
  const ctx = new Context()
  const scope = { workspace: root, preset: 'primary', principalId: 'owner', ownerRouteId: 'owner-route' }
  const owner = { receiptVersion: 2 as const, authorityId: scope.ownerRouteId, authorityHash: 'a'.repeat(64),
    principalId: scope.principalId, principalRecordId: 'record', principalVersion: 1,
    workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  const policy = new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), budgets: [
    { id: 'growth-scan-budget', metric: 'automation-runs', limit: options.scanBudgetLimit ?? 10, periodMs: 86_400_000, scope: 'subject' },
    ...(options.budget === false ? [] : [{ id: 'growth-budget', metric: 'automation-runs', limit: 10, periodMs: 86_400_000, scope: 'global' as const }])], rules: [
    { id: 'usage-reconcile', effect: 'allow', subject: { kind: 'background', id: 'assistant-growth-usage', workspace: root, principal: 'owner' },
      actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    { id: 'usage-execute', effect: 'allow', subject: { kind: 'background', id: '*', workspace: root, principal: 'owner' },
      actions: ['execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
  ] })
  const automations = new AssistantAutomationsService(ctx, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
  const evaluation = new AssistantEvaluationService(ctx, { databasePath: join(root, 'evaluation.sqlite'), projectionIntervalMs: 0 })
  let time = Date.now() - 1000
  const producer = new EvaluationStore({ path: join(root, 'evaluation.sqlite'), now: () => ++time })
  const sourceModel = { provider: 'conversation', model: 'original', reasoningEffort: 'medium' }
  const delivery = {
    validateOwnerRoute: () => ({ ...owner }),
    inspectOwnerForegroundLearningTask: ({ outcomeId }: { outcomeId: string }): OwnerForegroundLearningTask | undefined => {
      const canonical = evaluation.getTrustedTaskLearningProjection({ scope: evaluation.canonicalHostScope({ workspace: root, preset: 'primary' }), outcomeId })
      if (!canonical || canonical.projection.subjectKind !== 'foreground-turn') return undefined
      return { protocol: 'assistant-delivery/owner-foreground-learning/v1', owner: { ...owner }, canonical,
        judgement: 'independent-verifier', source: { sessionId: 'original-session', inboxId: canonical.projection.subjectRef,
          objective: 'Fix the real task failure', truncated: false, quiescent: true,
          modelSelectionState: options.missing ? 'missing' : 'frozen', ...(options.missing ? {} : { modelSelection: { ...sourceModel } }) } }
    },
  }
  const config = normalizeConfig({ enabled: true, scope, budgetId: 'growth-budget', budgetAmount: 1,
    ...(options.fixed ? options.sameOverride
      ? { provider: sourceModel.provider, model: sourceModel.model, reasoningEffort: sourceModel.reasoningEffort }
      : { provider: 'fixed', model: 'repair' } : {}),
    usageLearning: { enabled: true, scanBudgetId: 'growth-scan-budget', scanBudgetAmount: 1, databasePath: join(root, 'usage.sqlite'), maxPending: options.maxPending ?? 16 } })
  const review = vi.fn<(input: UsageReviewInput) => Promise<UsageReviewResult>>(async input => { input.assertCurrent(); return 'reviewed' })
  let currentCreationAuthority: CreationAcceptanceAuthorityRef | undefined
  const runtimes: UsageLearningRuntime[] = []
  const create = (selectedConfig = config) => {
    const runtime = new UsageLearningRuntime(selectedConfig, { evaluation, automations, delivery, review,
      inspectCreationAcceptanceAuthority: () => currentCreationAuthority })
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
  return { ctx, root, config, owner, policy, evaluation, automations, sourceModel, review, create, append, tick,
    setCreationAuthority: (value: CreationAcceptanceAuthorityRef | undefined) => { currentCreationAuthority = value } }
}

function actualSourceRun(input: UsageReviewInput) {
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

test('fixed override records its origin even if the owner task selected the same model and invalidates on owner rotation', async () => {
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
  f.owner.generation += 1
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
  expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
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
