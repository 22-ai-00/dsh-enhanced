import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { growthObjectDigest } from '@dsh-enhanced/assistant-growth-contract'
import { validateMemoryReviewConfig } from '@dsh-enhanced/assistant-verifier'
import { validateMemoryLearningAdoptionGrant } from '@dsh-enhanced/personal-memory'
import { createRsiMemoryLearningSetup } from '../../lark-channel/lib/rsi-memory-learning.js'
import { validateLearningConfig } from '../src/config.ts'
import { MemoryLearningRuntime } from '../src/runtime.ts'
import { query, workItemLearningFixture } from './work-item-feedback.fixture.ts'

// The grants below are produced by the real installer generator
// (lark-channel/src/rsi-memory-learning.ts, built lib) and injected verbatim as
// LearningConfig / memoryReviews / automaticLearning. The rest of the stack is
// the real Delivery/Evaluation/WorkItems/Verifier/Memory fixture; only the LLM
// supplier is scripted. This closes the installer-configuration/runtime seam
// that a hand-written fixture cannot prove.

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const installationId = 'c1c-installer'
const placeholderOwner = { authorityId: 'owner-route', authorityHash: 'a'.repeat(64),
  principalId: 'web/browser/local/owner', principalRecordId: 'record', principalVersion: 1,
  workspace: '/placeholder-workspace', agentPreset: 'primary' }
const probeNow = Date.now()
const probe = createRsiMemoryLearningSetup({ installationId, stateRoot: '/placeholder-state',
  owner: placeholderOwner, now: probeNow, expiresAt: probeNow + 600_000, workItemExperiences: true })
const learningPolicyIds = { learningAuthorityId: probe.learning.authorityId,
  reviewAuthorityId: probe.reviews.authorityId, adoptionAuthorityId: probe.adoption.authorityId,
  learningBudgetId: probe.learning.budgetId, scanBudgetId: probe.learning.scanBudgetId }

type Fixture = Awaited<ReturnType<typeof workItemLearningFixture>>
async function generatedGrants(f: Fixture, suffix = '', targetId = installationId) {
  const stateRoot = join(f.root, 'rsi-memory-state' + suffix)
  await mkdir(stateRoot, { mode: 0o700 })
  const now = Date.now()
  const grants = createRsiMemoryLearningSetup({ installationId: targetId, stateRoot, owner: f.learningOwner(),
    now, expiresAt: now + 120_000, workItemExperiences: true })
  return { stateRoot, grants }
}

async function feedbackSource(f: Fixture) {
  const itemId = await f.produce(); await f.acceptReports()
  const report = query(join(f.root, 'items.sqlite'), "SELECT delivery_id FROM work_item_report WHERE item_id='" + itemId + "'")[0]!
  const outbox = f.operator!.getOutbox(String(report['delivery_id']))!
  expect(outbox).toMatchObject({ status: 'accepted', providerMessageId: expect.any(String) })
  const before = { requests: f.supplier.requests.length, runs: f.snapshot().runs, budget: f.snapshot().budget }
  const feedback = await f.reply(outbox.providerMessageId!, '还是不行', 'memory-owner-result')
  await vi.waitFor(async () => {
    await f.ctx.assistantDelivery.tick(); await f.ctx.assistantDelivery.whenIdle()
    expect(f.ctx.assistantEvaluation.getTrustedWorkItemLearningProjection({ scope: f.ctx.assistantEvaluation.createHostScope({ workspace: f.workspace, preset: 'primary' }), itemId })).toMatchObject({ projection: { subjectKind: 'work-item', subjectRef: itemId }, objective: { status: 'not-achieved' } })
  }, { timeout: 30000 })
  expect({ requests: f.supplier.requests.length, runs: f.snapshot().runs, budget: f.snapshot().budget }).toEqual(before)
  return { itemId, providerMessageId: outbox.providerMessageId!, feedback }
}
async function adopted(f: Fixture) {
  // Drive the native scheduler exactly once, then only observe. Re-entering
  // tick() inside the poll would let a slow first extraction turn a later scan
  // into a second job for the same work item: the store dedupes a repeated feed
  // sequence (store.ts stage cursor check) and a claimed job (store.claim CAS),
  // but a changed canonical revision is intentionally superseded. The test must
  // therefore wait for the single driven batch instead of re-driving scans.
  await f.ctx.assistantAutomations.tick(); await f.ctx.assistantAutomations.whenIdle()
  await vi.waitFor(() => {
    expect(f.ctx.assistantMemoryLearning.health(), JSON.stringify(f.warnings)).toMatchObject({ counts: { adopted: 1 } })
  }, { timeout: 60000 })
}
function memoryCalls(f: Fixture) {
  return f.supplier.requests.filter(call => /^memory-(extract|review)-/u.test(String(call.sessionId)))
}
function paidCounts(f: Fixture, stateRoot: string) {
  const learningPath = join(stateRoot, 'memory-learning.sqlite')
  const jobs = query(learningPath, 'SELECT id FROM jobs').map(row => 'background:' + String(row['id']))
  const reservations = query(join(f.root, 'policy.sqlite'), 'SELECT id,scope,amount FROM budget_reservations ORDER BY id').filter(row => jobs.includes(String(row['scope'])))
  return { reservations, learning: query(learningPath, 'SELECT authority_id,config_digest,max_extractions,consumed FROM grant_record'),
    reviews: query(join(f.root, 'verifier.sqlite.memory-reviews'), 'SELECT authority,digest,max,used FROM grants'),
    adoptions: query(join(f.root, 'memory.sqlite'), "SELECT authority_id,grant_json,grant_digest,used_mutations FROM memory_learning_adoptions WHERE row_kind='grant'") }
}
async function revise(f: Fixture, providerMessageId: string, text: string, eventId: string) {
  return f.ctx.assistantDelivery.acceptInbound({ channel: 'web', account: 'browser', eventId, occurredAt: Date.now(), principal: f.principal, conversation: f.conversation, kind: 'command', text, metadata: { replyToProviderMessageId: providerMessageId } })
}
async function mountGenerated(f: Fixture, grants: ReturnType<typeof createRsiMemoryLearningSetup>) {
  const review = validateMemoryReviewConfig(grants.reviews)
  const adoption = validateMemoryLearningAdoptionGrant(grants.adoption)
  expect(growthObjectDigest(review)).toBe(grants.learning.reviewAuthorityDigest)
  expect(growthObjectDigest(adoption)).toBe(grants.learning.adoptionGrantDigest)
  await f.mountLearning({ grants: { learning: grants.learning, reviews: review, adoption } })
}

// This spec consumes the compiled generator artifact
// (plugins/lark-channel/lib/rsi-memory-learning.js), matching the repository
// build-then-test order. A standalone package test run must build lark-channel
// first: pnpm --filter @dsh-enhanced/lark-channel run build.
describe('installer-generated memory-learning configuration', () => {
  test('generator grants drive owner feedback through extraction, independent review, adoption and withdrawal', async () => {
    const f = await workItemLearningFixture({ learningPolicyIds })
    const { stateRoot, grants } = await generatedGrants(f)
    // The installer issues three independent finite grants bound to the owner.
    expect(new Set([grants.learning.authorityId, grants.reviews.authorityId, grants.adoption.authorityId,
      grants.learning.owner.authorityId]).size).toBe(4)
    expect(grants.learning.owner).toEqual(f.learningOwner())
    const source = await feedbackSource(f)
    await mountGenerated(f, grants)
    await adopted(f)
    const rows = query(join(stateRoot, 'memory-learning.sqlite'), 'SELECT * FROM jobs')
    expect(rows).toHaveLength(1)
    const request = JSON.parse(String(rows[0]!['request_json']))
    expect(request).toMatchObject({ protocol: 'memory-learning-review/v2', source: { protocol: 'memory-learning-source/work-item/v1', itemId: source.itemId } })
    const extraction = f.supplier.requests.filter(call => String(call.sessionId).startsWith('memory-extract-'))
    const review = f.supplier.requests.filter(call => String(call.sessionId).startsWith('memory-review-'))
    expect(extraction).toHaveLength(1); expect(review).toHaveLength(1)
    expect(String(review[0]!.sessionId)).not.toBe(String(extraction[0]!.sessionId))
    for (const call of [...extraction, ...review]) { expect(call).toMatchObject({ provider: 'local', model: 'scripted' }); expect(call.tools ?? []).toEqual([]) }
    const hits = await f.queryMemory()
    expect(hits).toHaveLength(1)
    expect(paidCounts(f, stateRoot)).toMatchObject({ learning: [{ consumed: 1 }], reviews: [{ used: 1 }], adoptions: [{ used_mutations: 1 }] })
    const counts = paidCounts(f, stateRoot)
    expect(counts.learning[0]!['authority_id']).toBe(grants.learning.authorityId)
    expect(counts.reviews[0]!['authority']).toBe(grants.reviews.authorityId)
    expect(counts.adoptions[0]!['authority_id']).toBe(grants.adoption.authorityId)
    // Owner withdrawal hides adopted memory immediately and after a cold remount.
    const paid = paidCounts(f, stateRoot), calls = memoryCalls(f).length
    await revise(f, source.providerMessageId, '/feedback correct 1 not-achieved achieved', 'correct-installer-source')
    await f.ctx.assistantDelivery.tick(); await f.ctx.assistantDelivery.whenIdle()
    expect(await f.queryMemory()).toEqual([])
    await f.remountMemoryStack()
    expect(await f.queryMemory()).toEqual([])
    await revise(f, source.providerMessageId, '/feedback withdraw 2 achieved', 'withdraw-installer-source')
    await f.ctx.assistantDelivery.tick(); await f.ctx.assistantDelivery.whenIdle()
    await f.remountMemoryStack(); expect(await f.queryMemory()).toEqual([])
    expect(memoryCalls(f)).toHaveLength(calls)
    expect(paidCounts(f, stateRoot)).toEqual(paid)
  }, 180_000)

  test('an expired installer grant performs zero paid extraction or review', async () => {
    const f = await workItemLearningFixture({ learningPolicyIds })
    await feedbackSource(f)
    const { stateRoot, grants } = await generatedGrants(f)
    const expired = { ...grants, learning: { ...grants.learning, expiresAt: Date.now() - 1 } }
    await mountGenerated(f, expired)
    const initial = f.supplier.requests.length
    for (let index = 0; index < 2; index += 1) { await f.ctx.assistantAutomations.tick(); await f.ctx.assistantAutomations.whenIdle() }
    expect(f.supplier.requests).toHaveLength(initial)
    expect(memoryCalls(f)).toEqual([])
    expect(query(join(f.root, 'memory.sqlite'), "SELECT operation_id FROM memory_learning_adoptions WHERE row_kind='operation'")).toEqual([])
    expect(query(join(stateRoot, 'memory-learning.sqlite'), 'SELECT consumed FROM grant_record')).toEqual([{ consumed: 0 }])
  }, 120_000)

  test('grants from another installation peer perform zero paid extraction', async () => {
    const f = await workItemLearningFixture({ learningPolicyIds })
    await feedbackSource(f)
    const own = await generatedGrants(f)
    const other = await generatedGrants(f, '-other', 'c1c-other-peer')
    // The learner config comes from the other peer while Memory/Verifier still
    // hold this installation's grants: every availability digest mismatches.
    await f.mountLearning({ grants: { learning: other.grants.learning, reviews: own.grants.reviews, adoption: own.grants.adoption } })
    const initial = f.supplier.requests.length
    await f.ctx.assistantAutomations.tick(); await f.ctx.assistantAutomations.whenIdle()
    expect(f.supplier.requests).toHaveLength(initial)
    expect(memoryCalls(f)).toEqual([])
    expect(query(join(f.root, 'memory.sqlite'), "SELECT operation_id FROM memory_learning_adoptions WHERE row_kind='operation'")).toEqual([])
  }, 120_000)

  test('a skip install issues no learning grants, so the learner fails closed on missing Host APIs before paid extraction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c1c-skip-port-')); roots.push(root)
    const config = validateLearningConfig({ ...probe.learning, databasePath: join(root, 'memory-learning.sqlite') })
    const methods = (names: readonly string[]) => Object.fromEntries(names.map(name => [name, vi.fn()]))
    const base = { delivery: methods(['inspectOwnerRouteState', 'validateOwnerRoute', 'listOwnerForegroundTaskSources', 'inspectOwnerForegroundTaskSource', 'withOwnerForegroundTaskSourcesFence', 'inspectOwnerForegroundLearningTask']),
      evaluation: methods(['canonicalHostScope', 'listTrustedTaskLearningProjections', 'withTrustedCanonicalScopeWriterFence', 'getTrustedForegroundLearningProjection', 'inspectTrustedTaskOwnerRevision']),
      automations: methods(['inspectSystemOwnedRetirement', 'retireSystemOwned', 'onSchedulerWake', 'registerHostExecutor', 'reconcileSystem', 'inspectSystemOwnedActivation', 'inspectSystemOwned']),
      policy: { evaluate: vi.fn(), authorize: vi.fn() }, extract: vi.fn() }
    const missingMemory = { ...base, memory: {}, verifier: methods(['inspectMemoryLearningReviewAvailability', 'reviewMemoryLearning', 'lookupMemoryLearningReview']) }
    expect(() => new MemoryLearningRuntime(config, missingMemory as never)).toThrow('memory learning requires compatible Host API: listLearningTargets')
    const missingReview = { ...base, memory: methods(['listLearningTargets', 'inspectLearningAdoptionAvailability', 'lookupLearningAdoption', 'adoptReviewedLearning']), verifier: {} }
    expect(() => new MemoryLearningRuntime(config, missingReview as never)).toThrow('memory learning requires compatible Host API: inspectMemoryLearningReviewAvailability')
    expect(base.extract).not.toHaveBeenCalled()
  })
})
