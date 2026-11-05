import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AssistantDeliveryService, AttentionRejectedError, AttentionRejectionLog, assessAttention, attentionEnforcementReasons,
  attentionSplitWindowMs, attentionWordCaps, deliverySchemaVersion,
  type AttentionEnvelope, type AttentionLedgerView, type OutboundIntent, type OwnerRouteAuthority,
} from '../src/index.ts'
import { AssistantDeliveryError } from '../src/service.ts'
import { DeliveryStore } from '../src/store.ts'
import { workItemReplyDigest, type WorkItemReplyConsumerRegistration, type WorkItemReportTarget } from '../src/work-item-replies.ts'

const roots: string[] = []
const contexts = new Set<Context>()
const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }
const authority: OwnerRouteAuthority = {
  id: 'attention-owner', conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
  policyRef: 'owner-dm', minimumGeneration: 1,
}
const emptyLedger: AttentionLedgerView = { questionAsked: () => false, questionAnswered: () => false, openQuestions: () => [], questionWorkItem: () => undefined }
const words = (count: number) => Array.from({ length: count }, (_, index) => `w${index % 10}`).join(' ')
const ask = (workItemId: string, id: string): AttentionEnvelope => ({ purpose: 'attention', workItemId, question: { id, prompt: 'Ship it?' } })

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all([...contexts].map(async ctx => { await ctx.fiber.dispose(); contexts.delete(ctx) }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(options: Readonly<{ root?: string; enforce?: boolean; attach?: boolean; textAttachments?: boolean; budget?: number }> = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'assistant-delivery-enforce-'))
  if (options.root === undefined) roots.push(root)
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: [
      { id: 'notice-send', effect: 'allow', subject: { kind: 'background', id: '*', workspace: '/work/alpha',
        principal: 'lark/bot-1/tenant-a/ou_owner' }, actions: ['send'], resource: { kind: 'message', id: '*' },
      context: { initiators: ['background'] }, ...(options.budget === undefined ? {} : { budget: { id: 'notice-sends', amount: 1 } }) },
    ],
    ...(options.budget === undefined ? {} : { budgets: [{ id: 'notice-sends', metric: 'sends', limit: options.budget, periodMs: 3_600_000, scope: 'global' as const }] }),
  })
  await ctx.plugin(AssistantDeliveryService, {
    databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false,
    retryBaseMs: 1, retryMaxMs: 1, ownerRoutes: [authority],
    ...(options.enforce === undefined ? {} : { attentionEnforce: options.enforce }),
    ...(options.attach === undefined ? {} : { attentionAttachOverCap: options.attach }),
  })
  const service = ctx.assistantDelivery
  const store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  if (store.getPrincipal(principal) === undefined) {
    const pair = store.issuePairing(principal, { ttlMs: 60_000, maxAttempts: 3 })
    store.confirmPairing({ challengeId: pair.challenge.id, principal, code: pair.code })
  }
  const binding = store.getActiveBinding(conversation) ?? store.createBinding({ conversation, principal, workspace: '/work/alpha',
    agentPreset: 'primary', sessionId: 'session-1', policyRef: 'owner-dm' })
  const owner = store.getPrincipal(principal)!
  // Narrow work-item report consumer: every report it is asked about is current.
  const targets = new Map<string, WorkItemReportTarget>()
  const registration: WorkItemReplyConsumerRegistration = { protocol: 1, sourceId: 'work-items-source', continuationAutomationId: 'reply-worker',
    inspectReport: input => targets.get(input.itemId), inspectChild: () => true, onPending: () => {}, onCancelled: () => {} }
  ctx.provide('assistantWorkItems' as never, { ownsWorkItemReplyRegistration: (input: unknown) => input === registration } as never)
  service.registerWorkItemReplyConsumer(registration)
  let sent = 0
  const send = vi.fn(async (_intent: Readonly<OutboundIntent>) => ({ outcome: 'accepted' as const, providerMessageId: `provider-${++sent}` }))
  await service.registerAdapter({ channel: 'lark', account: 'bot-1',
    capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain', 'markdown'],
      ...(options.textAttachments === undefined ? {} : { textAttachments: options.textAttachments }) }, start: async () => {}, send })
  const background = (idempotencyKey: string, text: string, attention?: unknown, sourceId = 'proactive-engine') => service.enqueueBackground({
    sourceId, workspace: '/work/alpha', bindingId: binding.id, idempotencyKey, text, format: 'plain',
    ...(attention === undefined ? {} : { attention: attention as AttentionEnvelope }),
  })
  const notify = (idempotencyKey: string, text: string, attention?: AttentionEnvelope) => service.enqueueOwnerNotification({
    sourceId: 'proactive-engine', ownerRouteId: authority.id,
    scope: { principalId: 'lark/bot-1/tenant-a/ou_owner', principalRecordId: owner.id, principalVersion: owner.version,
      workspace: '/work/alpha', preset: 'primary' }, sessionId: binding.sessionId, idempotencyKey, text, expiresAt: Date.now() + 60_000,
    ...(attention === undefined ? {} : { attention }),
  })
  const route = (idempotencyKey: string, text: string, attention?: AttentionEnvelope) => service.enqueueBackgroundRoute({
    sourceId: 'proactive-engine', authorityId: authority.id, idempotencyKey, text, ...(attention === undefined ? {} : { attention }),
  })
  const report = (itemId: string, text: string) => {
    targets.set(itemId, { protocol: 'assistant-delivery/work-item-report/v1', itemId, reportRevision: 1, streamId: itemId,
      reportDigest: workItemReplyDigest(['report', itemId]), sourceId: 'work-items-source', scope: { workspace: '/work/alpha', preset: 'primary' },
      owner: { principalRecordId: owner.id, principalVersion: owner.version } })
    return service.enqueueWorkItemReport({ sourceId: 'work-items-source', workspace: '/work/alpha', bindingId: binding.id,
      idempotencyKey: `report:${itemId}`, text, format: 'plain', itemId, reportRevision: 1 })
  }
  const rejection = (fn: () => unknown): AttentionRejectedError => {
    try { fn() } catch (error) { if (error instanceof AttentionRejectedError) return error; throw error }
    throw new Error('expected an attention rejection')
  }
  return { root, ctx, service, store, policy: ctx.assistantPolicy, send, binding, background, notify, route, report, rejection }
}

describe('enforcement reasons (pure)', () => {
  test('purpose reasons always reject; caps only without the attachment path; exposure never', () => {
    const long = words(attentionWordCaps.result + 1)
    const legacy = assessAttention({ text: long, ledger: emptyLedger })
    expect(attentionEnforcementReasons(legacy, false)).toEqual(['missing-purpose', 'over-word-cap'])
    expect(attentionEnforcementReasons(legacy, true)).toEqual(['missing-purpose'])
    const lane = assessAttention({ text: 'done', lanePurpose: { purpose: 'result' }, ledger: emptyLedger })
    expect(attentionEnforcementReasons(lane, false)).toEqual([])
    const exposed = assessAttention({ text: '净收益 0123456789abcdef0123456789abcdef', envelope: { purpose: 'result' }, ledger: emptyLedger })
    expect(exposed.reasons).toEqual(['text-exposes-estimate', 'text-exposes-identifier'])
    expect(attentionEnforcementReasons(exposed, false)).toEqual([])
  })

  test('the rejection log dedupes a same-reason retry, pages, and evicts', () => {
    let clock = 10
    const log = new AttentionRejectionLog(2, () => clock++)
    const assessment = assessAttention({ text: 'x', ledger: emptyLedger })
    const input = { bindingId: 'b', lane: 'background' as const, sourceId: 's', idempotencyKey: 'k', assessment, reasons: ['missing-purpose' as const] }
    const first = log.record(input)
    expect(log.record(input)).toBe(first)
    expect(first).toMatchObject({ sequence: 1, verdict: 'rejected', reasons: ['missing-purpose'], recordedAt: 10, purposeSource: 'default' })
    expect(log.record({ ...input, reasons: ['split-evasion', 'missing-purpose'] }).reasons).toEqual(['missing-purpose', 'split-evasion'])
    log.record({ ...input, idempotencyKey: 'k2' })
    expect(log.list(0, 1)).toMatchObject({ entries: [{ sequence: 2 }], hasMore: true, nextAfterSequence: 2, durable: false, evicted: 1 })
    expect(log.list(2, 10)).toMatchObject({ entries: [{ sequence: 3 }], hasMore: false, nextAfterSequence: null })
  })
})

describe('purpose enforcement (service, opt-in)', () => {
  test('default off: legacy and invalid notices are queued and audited exactly as before', async () => {
    const f = await fixture()
    const legacy = f.background('legacy', 'done')
    const invalid = f.background('invalid', 'done', { purpose: 'progress' })
    const long = f.background('long', words(attentionWordCaps.result + 5))
    expect(f.store.attentionAudit.get(legacy.id)).toMatchObject({ purposeSource: 'default', verdict: 'would-accept', reasons: ['missing-purpose'] })
    expect(f.store.attentionAudit.get(invalid.id)).toMatchObject({ verdict: 'would-reject', reasons: ['invalid-envelope'] })
    expect(long.intent).not.toHaveProperty('attachment')
    expect(f.service.inspectAttentionRejections()).toEqual({ entries: [], hasMore: false, nextAfterSequence: null, durable: false, evicted: 0 })
    expect(deliverySchemaVersion).toBe(31)
  })

  test('on: an undeclared purpose is rejected with a structured reason and nothing is queued', async () => {
    const f = await fixture({ enforce: true })
    const error = f.rejection(() => f.background('legacy', 'done'))
    expect(error).toBeInstanceOf(AssistantDeliveryError)
    expect(error).toMatchObject({ code: 'policy-denied', reasons: ['missing-purpose'], message: 'attention rejected: missing-purpose' })
    expect(error.rejection).toMatchObject({ verdict: 'rejected', lane: 'background', idempotencyKey: 'legacy', purposeSource: 'default' })
    expect(f.store.getOutboxByIdempotencyKey('legacy')).toBeUndefined()
    expect(f.service.inspectAttentionAudit().entries).toEqual([])
    expect(f.service.inspectAttentionRejections().entries).toEqual([error.rejection])
    const accepted = f.background('declared', 'done', { purpose: 'result' })
    expect(f.store.attentionAudit.get(accepted.id)).toMatchObject({ verdict: 'would-accept', reasons: [] })
  })

  test.each([
    ['invalid-envelope', { purpose: 'progress' }],
    ['attention-missing-work-item', { purpose: 'attention', question: { id: 'q-1', prompt: 'ok?' } }],
    ['attention-question-invalid', { purpose: 'attention', workItemId: 'wi-1', question: { id: 'q-1', prompt: ' ' } }],
    ['answer-missing-question', { purpose: 'answer' }],
    ['answer-unknown-question', { purpose: 'answer', questionId: 'never-asked' }],
  ])('on: rejects %s', async (reason, attention) => {
    const f = await fixture({ enforce: true })
    expect(f.rejection(() => f.background('k', 'text', attention)).reasons).toEqual([reason])
    expect(f.store.getOutboxByIdempotencyKey('k')).toBeUndefined()
  })

  test('on: one current question per work item, single-use answers bound to the asked work item', async () => {
    const f = await fixture({ enforce: true })
    f.background('q1', 'Ship it?', ask('wi-1', 'q-1'))
    expect(f.rejection(() => f.background('q2', 'Ship it?', ask('wi-1', 'q-2'))).reasons).toEqual(['attention-question-not-current'])
    expect(f.rejection(() => f.background('q1-reused', 'Ship it?', ask('wi-2', 'q-1'))).reasons).toEqual(['attention-question-reused'])
    expect(f.rejection(() => f.background('a-wrong', 'Yes', { purpose: 'answer', questionId: 'q-1', workItemId: 'wi-2' })).reasons)
      .toEqual(['answer-work-item-mismatch'])
    const answer = f.background('a1', 'Yes', { purpose: 'answer', questionId: 'q-1' })
    expect(f.store.attentionAudit.get(answer.id)).toMatchObject({ workItemId: 'wi-1', answersQuestionId: 'q-1', verdict: 'would-accept' })
    expect(f.rejection(() => f.background('a2', 'Yes again', { purpose: 'answer', questionId: 'q-1' })).reasons).toEqual(['answer-already-used'])
    expect(f.rejection(() => f.background('q1-again', 'Ship it?', ask('wi-1', 'q-1'))).reasons).toEqual(['attention-question-already-answered'])
    // Rejections never opened a question: the next question for wi-1 is now current.
    expect(f.background('q3', 'Next?', ask('wi-1', 'q-3')).intent.text).toBe('Next?')
    expect(f.service.inspectAttentionRejections().entries.map(entry => entry.reasons)).toEqual([
      ['attention-question-not-current'], ['attention-question-reused'], ['answer-work-item-mismatch'],
      ['answer-already-used'], ['attention-question-already-answered']])
  })

  test('on with attachment off: over-cap text is rejected by word or grapheme cap', async () => {
    const f = await fixture({ enforce: true, textAttachments: true })
    expect(f.rejection(() => f.background('words', words(attentionWordCaps.result + 1), { purpose: 'result' })).reasons).toEqual(['over-word-cap'])
    expect(f.rejection(() => f.background('graphemes', 'x'.repeat(2401), { purpose: 'result' })).reasons).toEqual(['over-grapheme-cap'])
    expect(f.rejection(() => f.background('both', words(attentionWordCaps.result + 1))).reasons).toEqual(['missing-purpose', 'over-word-cap'])
    // Enforcement alone adds no split check.
    f.background('part-1', words(250), { purpose: 'result' })
    expect(f.background('part-2', words(250), { purpose: 'result' }).intent.text).toBe(words(250))
  })

  test('on with attachment on: over-cap converts, an incapable channel and split bursts are rejected with reasons', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_800_000_000_000)
    const capable = await fixture({ enforce: true, attach: true, textAttachments: true })
    const long = words(attentionWordCaps.result + 5)
    expect(capable.background('long', long, { purpose: 'result' }).intent.attachment?.text).toBe(long)
    capable.background('part-1', words(250), { purpose: 'result' })
    const split = capable.rejection(() => capable.background('part-2', words(250), { purpose: 'result' }))
    expect(split).toMatchObject({ reasons: ['split-evasion'], message: expect.stringMatching(/split evasion/u) })
    vi.setSystemTime(1_800_000_000_000 + attentionSplitWindowMs + 1)
    expect(capable.background('part-3', words(250), { purpose: 'result' }).intent.text).toBe(words(250))
    const incapable = await fixture({ enforce: true, attach: true })
    const error = incapable.rejection(() => incapable.background('long', long, { purpose: 'result' }))
    expect(error).toMatchObject({ reasons: ['over-word-cap', 'attachment-unsupported'], message: expect.stringMatching(/text attachments/u) })
    expect(incapable.store.getOutboxByIdempotencyKey('long')).toBeUndefined()
  })

  test('on: owner notification and owner route lanes are enforced; the work-item report lane only by caps', async () => {
    const f = await fixture({ enforce: true })
    expect(f.rejection(() => f.notify('n-1', 'Heads up')).rejection).toMatchObject({ lane: 'owner-notification', reasons: ['missing-purpose'] })
    expect(f.notify('n-2', 'Heads up', { purpose: 'result' }).intent.text).toBe('Heads up')
    expect(f.rejection(() => f.route('r-1', 'Heads up')).rejection).toMatchObject({ lane: 'background-route', reasons: ['missing-purpose'] })
    expect(f.route('r-2', 'Heads up', { purpose: 'result' }).intent.text).toBe('Heads up')
    const report = f.report('wi-1', 'Report done')
    expect(f.store.attentionAudit.get(report.id)).toMatchObject({ lane: 'work-item-report', purposeSource: 'lane', workItemId: 'wi-1', verdict: 'would-accept' })
    expect(f.rejection(() => f.report('wi-2', words(attentionWordCaps.result + 1))).rejection)
      .toMatchObject({ lane: 'work-item-report', purposeSource: 'lane', workItemId: 'wi-2', reasons: ['over-word-cap'] })
  })

  test.each(['background', 'route'] as const)('on: a %s rejection happens before Policy authorization (no audit row, no budget spent)', async lane => {
    const f = await fixture({ enforce: true, budget: 1 })
    const send = lane === 'background'
      ? (key: string, attention?: AttentionEnvelope) => f.background(key, 'Heads up', attention)
      : (key: string, attention?: AttentionEnvelope) => f.route(key, 'Heads up', attention)
    const audit = () => f.policy.queryAudit({ limit: 100 }).filter(event => event.action === 'send')
    const before = audit().length
    expect(f.rejection(() => send('legacy')).reasons).toEqual(['missing-purpose'])
    expect(f.rejection(() => send('invalid', { purpose: 'progress' } as unknown as AttentionEnvelope)).reasons).toEqual(['invalid-envelope'])
    expect(audit()).toHaveLength(before)
    // The single budget unit is still available for the first accepted send, and only then exhausted.
    expect(send('declared', { purpose: 'result' }).intent.text).toBe('Heads up')
    expect(audit()).toHaveLength(before + 1)
    expect(() => send('declared-2', { purpose: 'result' })).toThrowError(expect.objectContaining({ code: 'policy-denied' }))
    expect(f.store.getOutboxByIdempotencyKey('declared-2')).toBeUndefined()
  })

  test('off: a legacy send authorizes exactly as before (one audit row, one budget unit)', async () => {
    const f = await fixture({ budget: 1 })
    const before = f.policy.queryAudit({ limit: 100 }).filter(event => event.action === 'send').length
    expect(f.background('legacy', 'Heads up').intent.text).toBe('Heads up')
    expect(f.policy.queryAudit({ limit: 100 }).filter(event => event.action === 'send')).toHaveLength(before + 1)
    expect(() => f.background('legacy-2', 'Heads up')).toThrowError(expect.objectContaining({ code: 'policy-denied' }))
  })

  test('a retry of a rejected key is decided again and logged once', async () => {
    const f = await fixture({ enforce: true })
    const first = f.rejection(() => f.background('legacy', 'done'))
    expect(f.rejection(() => f.background('legacy', 'done')).rejection).toBe(first.rejection)
    expect(f.service.inspectAttentionRejections().entries).toHaveLength(1)
    expect(() => f.service.inspectAttentionRejections({ limit: 0 })).toThrow(/invalid attention rejection scan/u)
  })

  test('after restart with enforcement on: accepted keys replay, rejected keys are rejected again', async () => {
    const before = await fixture()
    const legacy = before.background('legacy', 'done')
    const long = before.background('long', words(attentionWordCaps.result + 5), { purpose: 'result' })
    await before.ctx.fiber.dispose()
    contexts.delete(before.ctx)
    const on = await fixture({ root: before.root, enforce: true })
    // Existing Outbox rows are replays and are never re-judged, so the flip does not break idempotency.
    expect(on.background('legacy', 'done').id).toBe(legacy.id)
    expect(on.background('long', words(attentionWordCaps.result + 5), { purpose: 'result' }).id).toBe(long.id)
    expect(on.store.attentionAudit.get(legacy.id)).toMatchObject({ verdict: 'would-accept', reasons: ['missing-purpose'] })
    const rejected = on.rejection(() => on.background('new', 'done'))
    expect(on.service.inspectAttentionRejections().entries).toHaveLength(1)
    await on.ctx.fiber.dispose()
    contexts.delete(on.ctx)
    const again = await fixture({ root: before.root, enforce: true })
    // The rejection log is process-local; the ledger that decided it is durable and unchanged.
    expect(again.service.inspectAttentionRejections().entries).toEqual([])
    expect(again.rejection(() => again.background('new', 'done')).reasons).toEqual(rejected.reasons)
    expect(again.store.getOutboxByIdempotencyKey('new')).toBeUndefined()
    await again.ctx.fiber.dispose()
    contexts.delete(again.ctx)
    // Turning enforcement off again accepts the same key as before.
    const off = await fixture({ root: before.root })
    expect(off.store.attentionAudit.get(off.background('new', 'done').id)).toMatchObject({ verdict: 'would-accept', reasons: ['missing-purpose'] })
  })
})
