import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AssistantDeliveryService, assessAttention, attentionWordCaps, countAttentionWords, deliverySchemaVersion,
  type AttentionEnvelope, type AttentionLedgerView, type OwnerRouteAuthority,
} from '../src/index.ts'
import { DeliveryStore } from '../src/store.ts'

const roots: string[] = []
const contexts = new Set<Context>()
const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }
const authority: OwnerRouteAuthority = {
  id: 'attention-owner', conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
  policyRef: 'owner-dm', minimumGeneration: 1,
}
const emptyLedger: AttentionLedgerView = { questionAsked: () => false, questionAnswered: () => false, openQuestions: () => [] }

afterEach(async () => {
  await Promise.all([...contexts].map(async ctx => { await ctx.fiber.restart(); contexts.delete(ctx) }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-attention-'))
  roots.push(root)
  return root
}

async function fixture() {
  const root = await tempRoot()
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: [
      { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
        actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
      { id: 'owner-pair', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
        actions: ['pair.confirm'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['external'] } },
      { id: 'notice-send', effect: 'allow', subject: { kind: 'background', id: 'proactive-engine', workspace: '/work/alpha',
        principal: 'lark/bot-1/tenant-a/ou_owner' }, actions: ['send'], resource: { kind: 'message', id: '*' },
      context: { initiators: ['background'] } },
    ],
  })
  await ctx.plugin(AssistantDeliveryService, {
    databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false,
    retryBaseMs: 1, retryMaxMs: 1, ownerRoutes: [authority],
  })
  const service = ctx.assistantDelivery
  const store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  const challenge = service.issuePairing('test', principal)
  service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
  const binding = store.createBinding({ conversation, principal, workspace: '/work/alpha',
    agentPreset: 'primary', sessionId: 'session-1', policyRef: 'owner-dm' })
  let sent = 0
  const send = vi.fn(async () => ({ outcome: 'accepted' as const, providerMessageId: `provider-${++sent}` }))
  await service.registerAdapter({ channel: 'lark', account: 'bot-1',
    capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain', 'markdown'] }, start: async () => {}, send })
  const background = (idempotencyKey: string, text: string, attention?: AttentionEnvelope) => service.enqueueBackground({
    sourceId: 'proactive-engine', workspace: '/work/alpha', bindingId: binding.id, idempotencyKey, text, format: 'plain',
    ...(attention === undefined ? {} : { attention }),
  })
  // One send per conversation per tick; repeat until the Outbox is quiet.
  const drain = async () => {
    for (let calls = -1; calls !== send.mock.calls.length;) { calls = send.mock.calls.length; await service.tick(); await service.whenIdle() }
  }
  return { service, store, send, binding, background, drain }
}

describe('attention word counting', () => {
  test('counts word-like segments for Latin, CJK, link text and URLs', () => {
    expect(countAttentionWords('')).toBe(0)
    expect(countAttentionWords('Build passed, 3 warnings.')).toBe(4)
    expect(countAttentionWords('主动提醒：目标有新的相关事件')).toBe(7)
    expect(countAttentionWords('see [docs](https://example.com/a/b?x=1) now')).toBe(9)
    expect(countAttentionWords('https://example.com/a/b?x=1')).toBe(countAttentionWords('see [docs](https://example.com/a/b?x=1) now') - 3)
    expect(countAttentionWords('—— ！？ ...')).toBe(0)
  })

  test('is deterministic and independent of call order', () => {
    const text = '请确认是否发布 v2.1？详情见 https://example.com/release/notes'
    const counts = Array.from({ length: 5 }, () => countAttentionWords(text))
    expect(new Set(counts).size).toBe(1)
    const input = { text, envelope: { purpose: 'attention', workItemId: 'wi-1', question: { id: 'q-1', prompt: '发布吗？', choices: ['是', '否'] } }, ledger: emptyLedger }
    expect(assessAttention(input)).toEqual(assessAttention({ ...structuredClone({ text: input.text, envelope: input.envelope }), ledger: emptyLedger }))
    expect(JSON.stringify(assessAttention(input))).toBe(JSON.stringify(assessAttention(input)))
  })
})

describe('attention purpose validation', () => {
  test('legacy callers default to result and record missing-purpose', () => {
    expect(assessAttention({ text: 'done', ledger: emptyLedger })).toEqual({ purpose: 'result', purposeSource: 'default',
      wordCount: 1, wordCap: attentionWordCaps.result, verdict: 'would-accept', reasons: ['missing-purpose'] })
    expect(assessAttention({ text: 'done', lanePurpose: { purpose: 'result', workItemId: 'wi-1' }, ledger: emptyLedger }))
      .toMatchObject({ purposeSource: 'lane', workItemId: 'wi-1', reasons: [] })
  })

  test.each([
    ['not an object', 'result'],
    ['unknown purpose', { purpose: 'progress' }],
    ['bad work item id', { purpose: 'result', workItemId: ' spaced id ' }],
  ])('rejects an invalid envelope: %s', (_name, envelope) => {
    expect(assessAttention({ text: 'x', envelope, ledger: emptyLedger })).toMatchObject({
      purpose: 'result', verdict: 'would-reject', reasons: expect.arrayContaining(['invalid-envelope']) })
  })

  test('attention needs a work item and exactly one valid structured question', () => {
    const question = { id: 'q-1', prompt: 'Ship it?' }
    expect(assessAttention({ text: 'x', envelope: { purpose: 'attention', question }, ledger: emptyLedger }).reasons)
      .toEqual(['attention-missing-work-item'])
    for (const bad of [undefined, { id: 'q-1', prompt: ' ' }, { id: 'q 1', prompt: 'ok' }, { id: 'q-1', prompt: 'ok', choices: ['one'] },
      { id: 'q-1', prompt: 'ok', choices: ['a', 'a'] }, [question]]) {
      expect(assessAttention({ text: 'x', envelope: { purpose: 'attention', workItemId: 'wi-1', question: bad }, ledger: emptyLedger }).reasons)
        .toEqual(['attention-question-invalid'])
    }
    expect(assessAttention({ text: 'x', envelope: { purpose: 'attention', workItemId: 'wi-1', question, questions: [question] }, ledger: emptyLedger }).reasons)
      .toEqual(['attention-question-invalid'])
    expect(assessAttention({ text: 'x', envelope: { purpose: 'attention', workItemId: 'wi-1', question: { ...question, choices: ['yes', 'no'] } }, ledger: emptyLedger }))
      .toMatchObject({ purpose: 'attention', purposeSource: 'declared', workItemId: 'wi-1', questionId: 'q-1', verdict: 'would-accept', reasons: [] })
  })

  test('answer must reference an asked question exactly once', () => {
    const asked: AttentionLedgerView = { ...emptyLedger, questionAsked: id => id === 'q-1' }
    expect(assessAttention({ text: 'x', envelope: { purpose: 'answer' }, ledger: asked }).reasons).toEqual(['answer-missing-question'])
    expect(assessAttention({ text: 'x', envelope: { purpose: 'answer', questionId: 'q-2' }, ledger: asked }).reasons).toEqual(['answer-unknown-question'])
    expect(assessAttention({ text: 'x', envelope: { purpose: 'answer', questionId: 'q-1' }, ledger: asked }))
      .toMatchObject({ answersQuestionId: 'q-1', verdict: 'would-accept' })
    expect(assessAttention({ text: 'x', envelope: { purpose: 'answer', questionId: 'q-1' }, ledger: { ...asked, questionAnswered: id => id === 'q-1' } }).reasons)
      .toEqual(['answer-already-used'])
  })

  test('over-cap text would become an attachment; exposure is audit-only', () => {
    const long = Array.from({ length: attentionWordCaps.attention + 1 }, (_, i) => `w${i}`).join(' ')
    expect(assessAttention({ text: long, envelope: { purpose: 'attention', workItemId: 'wi-1', question: { id: 'q-1', prompt: 'ok?' } }, ledger: emptyLedger }))
      .toMatchObject({ wordCount: attentionWordCaps.attention + 1, verdict: 'would-attach', reasons: ['over-word-cap'] })
    expect(assessAttention({ text: '配置估值 0.7；机会：opportunity-123e4567-e89b-12d3-a456-426614174000', lanePurpose: { purpose: 'result' }, ledger: emptyLedger }))
      .toMatchObject({ verdict: 'would-accept', reasons: ['text-exposes-estimate', 'text-exposes-identifier'] })
  })
})

describe('attention audit through the delivery service', () => {
  test('legacy background send is audited without changing delivery', async () => {
    const f = await fixture()
    const legacy = f.background('legacy-1', 'Build finished.')
    const rejected = f.background('declared-bad', 'Build finished.', { purpose: 'answer', questionId: 'never-asked' })
    expect(rejected.intent).toEqual({ ...legacy.intent, idempotencyKey: 'declared-bad' })
    await f.drain()
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.send.mock.calls.map(call => (call as unknown as [{ text: string }])[0].text)).toEqual(['Build finished.', 'Build finished.'])
    const audit = f.service.inspectAttentionAudit()
    expect(audit).toMatchObject({ hasMore: false, nextAfterSequence: null, writeFailures: 0 })
    expect(audit.entries).toEqual([
      expect.objectContaining({ sequence: 1, outboxId: legacy.id, bindingId: f.binding.id, lane: 'background', sourceId: 'proactive-engine',
        purpose: 'result', purposeSource: 'default', wordCount: 2, verdict: 'would-accept', reasons: ['missing-purpose'] }),
      expect.objectContaining({ sequence: 2, outboxId: rejected.id, purpose: 'answer', purposeSource: 'declared',
        answersQuestionId: 'never-asked', verdict: 'would-reject', reasons: ['answer-unknown-question'] }),
    ])
    expect(JSON.stringify(audit)).not.toContain('Build finished')
  })

  test('an idempotent replay keeps one audit row with the first verdict', async () => {
    const f = await fixture()
    const first = f.background('same', 'one two three')
    const replay = f.background('same', 'one two three', { purpose: 'result' })
    expect(replay.id).toBe(first.id)
    expect(f.service.inspectAttentionAudit().entries).toEqual([expect.objectContaining({ outboxId: first.id, purposeSource: 'default' })])
  })

  test('audit write failure is counted and never blocks enqueue or send', async () => {
    const f = await fixture()
    const record = vi.spyOn(f.store.attentionAudit, 'record').mockImplementation(() => { throw new Error('disk full') })
    const queued = f.background('fails-audit', 'still sent')
    record.mockRestore()
    await f.drain()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.store.getOutbox(queued.id)).toMatchObject({ status: 'accepted' })
    expect(f.service.inspectAttentionAudit()).toMatchObject({ entries: [], writeFailures: 1 })
  })

  test('tracks one current question per work item and single-use answers per binding', async () => {
    const f = await fixture()
    const ask = (key: string, id: string, workItemId = 'wi-1') => f.background(key, 'Ship it?', { purpose: 'attention', workItemId, question: { id, prompt: 'Ship it?' } })
    ask('a1', 'q-1')
    ask('a2', 'q-2')
    ask('a3', 'q-3', 'wi-2')
    f.background('r1', 'yes', { purpose: 'answer', questionId: 'q-1' })
    f.background('r2', 'yes again', { purpose: 'answer', questionId: 'q-1' })
    ask('a4', 'q-1')
    ask('a5', 'q-4')
    const entries = f.service.inspectAttentionAudit().entries
    expect(entries.map(entry => [entry.verdict, entry.reasons])).toEqual([
      ['would-accept', []],
      ['would-reject', ['attention-question-not-current']],
      ['would-accept', []],
      ['would-accept', []],
      ['would-reject', ['answer-already-used']],
      ['would-reject', ['attention-question-already-answered']],
      ['would-accept', []],
    ])
    await f.drain()
    expect(f.send).toHaveBeenCalledTimes(7)
  })

  test('owner notifications and owner routes are audited; reminder exposure is recorded only', async () => {
    const f = await fixture()
    const owner = f.store.getPrincipal(principal)!
    const text = '主动提醒：目标有新的相关事件\n配置估值：0.42\n机会：opportunity-123e4567-e89b-12d3-a456-426614174000'
    const notice = f.service.enqueueOwnerNotification({ sourceId: 'proactive-engine', ownerRouteId: authority.id,
      scope: { principalId: 'lark/bot-1/tenant-a/ou_owner', principalRecordId: owner.id, principalVersion: owner.version,
        workspace: '/work/alpha', preset: 'primary' }, sessionId: 'session-1', idempotencyKey: 'notice-1', text, expiresAt: Date.now() + 60_000 })
    const routed = f.service.enqueueBackgroundRoute({ sourceId: 'proactive-engine', authorityId: authority.id, idempotencyKey: 'route-1', text: 'Done.' })
    expect(notice.intent.text).toBe(text)
    expect(f.service.inspectAttentionAudit().entries).toEqual([
      expect.objectContaining({ outboxId: notice.id, lane: 'owner-notification', purposeSource: 'default',
        reasons: ['missing-purpose', 'text-exposes-estimate', 'text-exposes-identifier'], verdict: 'would-accept' }),
      expect.objectContaining({ outboxId: routed.id, lane: 'background-route', reasons: ['missing-purpose'] }),
    ])
  })

  test('over-cap result is fully delivered and audited as would-attach', async () => {
    const f = await fixture()
    const text = Array.from({ length: attentionWordCaps.result + 5 }, () => '词').join(' ')
    const queued = f.background('long', text, { purpose: 'result' })
    await f.drain()
    expect((f.send.mock.calls[0] as unknown as [{ text: string }])[0].text).toBe(text)
    expect(f.store.attentionAudit.get(queued.id)).toMatchObject({ wordCount: attentionWordCaps.result + 5, verdict: 'would-attach', reasons: ['over-word-cap'] })
  })

  test('inspection pages by sequence and validates its cursor', async () => {
    const f = await fixture()
    for (const key of ['p1', 'p2', 'p3']) f.background(key, key)
    const first = f.service.inspectAttentionAudit({ limit: 2 })
    expect(first).toMatchObject({ hasMore: true, nextAfterSequence: 2 })
    expect(f.service.inspectAttentionAudit({ afterSequence: first.nextAfterSequence!, limit: 2 }))
      .toMatchObject({ entries: [expect.objectContaining({ sequence: 3 })], hasMore: false, nextAfterSequence: null })
    for (const bad of [{ limit: 0 }, { limit: 501 }, { afterSequence: -1 }, { afterSequence: 1.5 }]) {
      expect(() => f.service.inspectAttentionAudit(bad)).toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    }
    expect(Object.isFrozen(first.entries[0])).toBe(true)
  })

  test('two fresh Hosts given the same sequence record identical verdicts', async () => {
    const run = async () => {
      const f = await fixture()
      f.background('d1', 'Need a decision', { purpose: 'attention', workItemId: 'wi-9', question: { id: 'q-9', prompt: 'A or B?', choices: ['A', 'B'] } })
      f.background('d2', 'A', { purpose: 'answer', questionId: 'q-9', workItemId: 'wi-9' })
      f.background('d3', 'legacy')
      return f.service.inspectAttentionAudit().entries.map(({ outboxId: _o, bindingId: _b, recordedAt: _r, ...rest }) => rest)
    }
    expect(await run()).toEqual(await run())
  })
})

describe('attention audit persistence', () => {
  test('migrates schema 30 to 31, reopens cleanly and rejects a tampered table', async () => {
    const root = await tempRoot()
    const path = join(root, 'delivery.sqlite')
    let store = new DeliveryStore({ path })
    store.close()
    const raw = new DatabaseSync(path)
    raw.exec('DROP TABLE delivery_attention_audit; PRAGMA user_version = 30;')
    raw.close()
    store = new DeliveryStore({ path })
    store.close()
    const check = new DatabaseSync(path)
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: deliverySchemaVersion })
    expect(deliverySchemaVersion).toBe(31)
    check.exec('DROP TRIGGER delivery_attention_audit_no_delete')
    check.close()
    expect(() => new DeliveryStore({ path })).toThrow()
  })
})
