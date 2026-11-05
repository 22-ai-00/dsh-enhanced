import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AssistantDeliveryService, assessAttentionSplit, attentionAttachmentSummaryGraphemes, attentionAttachmentSummaryWords,
  attentionGraphemeCaps, attentionOverCap, attentionSplitWindowMs, attentionWordCaps, convertOverCapAttention, countAttentionWords,
  deliverySchemaVersion, measureAttentionText, type OutboundIntent, type OwnerRouteAuthority,
} from '../src/index.ts'
import { AssistantDeliveryError } from '../src/service.ts'
import { DeliveryStore } from '../src/store.ts'

const roots: string[] = []
const contexts = new Set<Context>()
const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }
const authority: OwnerRouteAuthority = {
  id: 'attention-owner', conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
  policyRef: 'owner-dm', minimumGeneration: 1,
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const words = (count: number, word = 'alpha') => Array.from({ length: count }, (_, index) => `${word}${index}`).join(' ')

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all([...contexts].map(async ctx => { await ctx.fiber.restart(); contexts.delete(ctx) }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(options: Readonly<{ attach?: boolean; textAttachments?: boolean }> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-attach-'))
  roots.push(root)
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: [
      { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
        actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
      { id: 'owner-pair', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
        actions: ['pair.confirm'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['external'] } },
      { id: 'notice-send', effect: 'allow', subject: { kind: 'background', id: '*', workspace: '/work/alpha',
        principal: 'lark/bot-1/tenant-a/ou_owner' }, actions: ['send'], resource: { kind: 'message', id: '*' },
      context: { initiators: ['background'] } },
    ],
  })
  await ctx.plugin(AssistantDeliveryService, {
    databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false,
    retryBaseMs: 1, retryMaxMs: 1, ownerRoutes: [authority],
    ...(options.attach === undefined ? {} : { attentionAttachOverCap: options.attach }),
  })
  const service = ctx.assistantDelivery
  const store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  const challenge = service.issuePairing('test', principal)
  service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
  const binding = store.createBinding({ conversation, principal, workspace: '/work/alpha',
    agentPreset: 'primary', sessionId: 'session-1', policyRef: 'owner-dm' })
  let sent = 0
  const send = vi.fn(async (_intent: Readonly<OutboundIntent>) => ({ outcome: 'accepted' as const, providerMessageId: `provider-${++sent}` }))
  await service.registerAdapter({ channel: 'lark', account: 'bot-1',
    capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain', 'markdown'],
      ...(options.textAttachments === undefined ? {} : { textAttachments: options.textAttachments }) }, start: async () => {}, send })
  const background = (idempotencyKey: string, text: string, sourceId = 'proactive-engine', format: 'plain' | 'markdown' = 'plain') =>
    service.enqueueBackground({ sourceId, workspace: '/work/alpha', bindingId: binding.id, idempotencyKey, text, format,
      attention: { purpose: 'result' } })
  const drain = async () => {
    for (let calls = -1; calls !== send.mock.calls.length;) { calls = send.mock.calls.length; await service.tick(); await service.whenIdle() }
  }
  return { service, store, send, binding, background, drain }
}

describe('over-cap conversion (pure)', () => {
  test('is deterministic, digest-bound, and keeps the body under every cap', () => {
    const text = `${words(500)} https://example.com/a/very/long/path?with=query [docs](https://example.com/docs)`
    const first = convertOverCapAttention({ text, format: 'markdown', digest: sha256 })
    expect(convertOverCapAttention({ text, format: 'markdown', digest: sha256 })).toEqual(first)
    expect(first.format).toBe('plain')
    expect(first.attachment).toEqual({ kind: 'text', name: `notice-${sha256(text).slice(0, 12)}.md`, mediaType: 'text/markdown', text, sha256: sha256(text) })
    expect(first.text).toContain(first.attachment.name)
    expect(first.text).toContain(`共 ${countAttentionWords(text)} 词`)
    for (const purpose of ['result', 'attention', 'answer'] as const) expect(attentionOverCap(first.text, purpose)).toBe(false)
    const plain = convertOverCapAttention({ text, format: 'plain', digest: sha256 })
    expect(plain.attachment).toMatchObject({ name: `notice-${sha256(text).slice(0, 12)}.txt`, mediaType: 'text/plain' })
  })

  test('links are never cut and count toward the budget', () => {
    const url = `https://example.com/${Array.from({ length: 80 }, (_, i) => `seg${i}`).join('/')}`
    expect(countAttentionWords(url)).toBeGreaterThan(attentionAttachmentSummaryWords)
    const text = `Intro words here ${url} ${words(500)}`
    const converted = convertOverCapAttention({ text, format: 'plain', digest: sha256 })
    // The URL alone exceeds the summary budget, so it is left entirely to the attachment.
    expect(converted.text.startsWith('Intro words here…')).toBe(true)
    expect(converted.text).not.toContain('https://')
    const short = 'https://example.com/ok'
    const withShort = convertOverCapAttention({ text: `See ${short} ${words(500)}`, format: 'plain', digest: sha256 })
    expect(withShort.text).toContain(short)
    const markdownLink = '[report](https://example.com/report)'
    expect(convertOverCapAttention({ text: `${markdownLink} ${words(500)}`, format: 'markdown', digest: sha256 }).text).toContain(markdownLink)
    // Links alone can push a notice over cap.
    expect(attentionOverCap(Array.from({ length: 40 }, (_, i) => `https://example.com/p${i}/q`).join(' '), 'attention')).toBe(true)
  })

  test('long CJK and unbroken text still produce a non-empty bounded body', () => {
    const cjk = '主动提醒目标有新的相关事件需要处理'.repeat(200)
    const converted = convertOverCapAttention({ text: cjk, format: 'plain', digest: sha256 })
    expect(converted.text.length).toBeGreaterThan(0)
    expect(measureAttentionText(converted.text).graphemes).toBeLessThan(attentionAttachmentSummaryGraphemes + 80)
    const blob = 'x'.repeat(5_000)
    const body = convertOverCapAttention({ text: blob, format: 'plain', digest: sha256 }).text
    expect(body.startsWith('（全文较长')).toBe(true)
    expect(attentionOverCap(body, 'attention')).toBe(false)
  })

  test('split assessment sums prior inline notices and is pure', () => {
    const part = words(70)
    expect(assessAttentionSplit({ text: words(500), purpose: 'result', priorInlineTexts: [] })).toEqual({ split: false })
    expect(assessAttentionSplit({ text: part, purpose: 'attention', priorInlineTexts: [] })).toEqual({ split: false })
    expect(assessAttentionSplit({ text: part, purpose: 'attention', priorInlineTexts: [part] }))
      .toEqual({ split: true, words: 140, graphemes: measureAttentionText(part).graphemes * 2, priorNotices: 1 })
    expect(assessAttentionSplit({ text: 'ok', purpose: 'result', priorInlineTexts: ['done'] })).toEqual({ split: false })
    expect(attentionWordCaps.attention).toBeLessThan(140)
    expect(attentionGraphemeCaps.result).toBeGreaterThan(0)
  })
})

describe('over-cap conversion (service, opt-in)', () => {
  test('default off: over-cap text is queued and sent inline unchanged', async () => {
    const f = await fixture({ textAttachments: true })
    const text = words(attentionWordCaps.result + 5)
    const queued = f.background('long', text)
    expect(queued.intent).not.toHaveProperty('attachment')
    await f.drain()
    expect(f.send.mock.calls[0]![0].text).toBe(text)
    expect(deliverySchemaVersion).toBe(31)
  })

  test('on with a capable adapter: one message with short body and attachment, idempotent replay', async () => {
    const f = await fixture({ attach: true, textAttachments: true })
    const text = words(attentionWordCaps.result + 5)
    const queued = f.background('long', text)
    expect(queued.intent.format).toBe('plain')
    expect(queued.intent.attachment).toEqual({ kind: 'text', name: `notice-${sha256(text).slice(0, 12)}.txt`,
      mediaType: 'text/plain', text, sha256: sha256(text) })
    expect(attentionOverCap(queued.intent.text, 'result')).toBe(false)
    expect(f.background('long', text).id).toBe(queued.id)
    await f.drain()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send.mock.calls[0]![0].attachment?.text).toBe(text)
    expect(f.store.attentionAudit.get(queued.id)).toMatchObject({ wordCount: attentionWordCaps.result + 5, verdict: 'would-attach' })
    // Under-cap notices are untouched.
    expect(f.background('short', 'Build passed.', 'other-source').intent).not.toHaveProperty('attachment')
  })

  test('a converted key stays idempotent after the flag is turned off', async () => {
    const f = await fixture({ attach: true, textAttachments: true })
    const text = words(attentionWordCaps.result + 5)
    const queued = f.background('long', text)
    ;(f.service as unknown as { config: { attentionAttachOverCap?: boolean } }).config.attentionAttachOverCap = false
    expect(f.background('long', text).id).toBe(queued.id)
    const routed = (() => {
      ;(f.service as unknown as { config: { attentionAttachOverCap?: boolean } }).config.attentionAttachOverCap = true
      return f.service.enqueueBackgroundRoute({ sourceId: 'route-source', authorityId: authority.id, idempotencyKey: 'route-long', text })
    })()
    ;(f.service as unknown as { config: { attentionAttachOverCap?: boolean } }).config.attentionAttachOverCap = false
    expect(f.service.enqueueBackgroundRoute({ sourceId: 'route-source', authorityId: authority.id, idempotencyKey: 'route-long', text }).id)
      .toBe(routed.id)
    // New keys with the flag off are untouched.
    expect(f.background('long-2', text).intent).not.toHaveProperty('attachment')
  })

  test('markdown over-cap text is attached as text/markdown', async () => {
    const f = await fixture({ attach: true, textAttachments: true })
    const text = `# Report\n\n${words(attentionWordCaps.result + 5)}`
    const queued = f.background('md', text, 'proactive-engine', 'markdown')
    expect(queued.intent).toMatchObject({ format: 'plain', attachment: { mediaType: 'text/markdown', text } })
  })

  test('on with an adapter lacking text attachments: rejected, nothing queued', async () => {
    const f = await fixture({ attach: true })
    const text = words(attentionWordCaps.result + 5)
    expect(() => f.background('long', text)).toThrow(AssistantDeliveryError)
    expect(() => f.background('long', text)).toThrow(expect.objectContaining({ code: 'policy-denied', message: expect.stringMatching(/text attachments/u) }))
    expect(f.store.getOutboxByIdempotencyKey('long')).toBeUndefined()
    expect(f.background('short', 'Build passed.').intent.text).toBe('Build passed.')
  })

  test('split evasion is rejected inside the window, allowed after it or from another source', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_800_000_000_000)
    const f = await fixture({ attach: true, textAttachments: true })
    const part = words(250)
    f.background('part-1', part)
    expect(() => f.background('part-2', part)).toThrow(/split evasion/u)
    expect(f.store.getOutboxByIdempotencyKey('part-2')).toBeUndefined()
    expect(f.background('other-1', part, 'other-source').intent.text).toBe(part)
    // Small follow-ups that stay under the cap together are fine.
    expect(f.background('part-small', 'Done.').intent.text).toBe('Done.')
    // A replay of an already queued inline notice is not a split.
    expect(f.background('part-1', part).intent.text).toBe(part)
    vi.setSystemTime(1_800_000_000_000 + attentionSplitWindowMs + 1)
    expect(f.background('part-3', part).intent.text).toBe(part)
  })

  test('owner notification and owner route lanes convert too', async () => {
    const f = await fixture({ attach: true, textAttachments: true })
    const owner = f.store.getPrincipal(principal)!
    const text = words(attentionWordCaps.result + 5)
    const notice = f.service.enqueueOwnerNotification({ sourceId: 'proactive-engine', ownerRouteId: authority.id,
      scope: { principalId: 'lark/bot-1/tenant-a/ou_owner', principalRecordId: owner.id, principalVersion: owner.version,
        workspace: '/work/alpha', preset: 'primary' }, sessionId: 'session-1', idempotencyKey: 'n-1', text, expiresAt: Date.now() + 60_000 })
    expect(notice.intent.attachment?.text).toBe(text)
    const routed = f.service.enqueueBackgroundRoute({ sourceId: 'proactive-engine', authorityId: authority.id, idempotencyKey: 'route-1', text })
    expect(routed.intent.attachment?.text).toBe(text)
    expect(f.service.enqueueBackgroundRoute({ sourceId: 'proactive-engine', authorityId: authority.id, idempotencyKey: 'route-1', text }).id)
      .toBe(routed.id)
  })
})

describe('attachment guards', () => {
  test('the coordinator never sends an attachment intent through an incapable adapter', async () => {
    const f = await fixture({ textAttachments: false })
    const text = words(20)
    const attachment = { kind: 'text' as const, name: 'notice-x.txt', mediaType: 'text/plain' as const, text, sha256: sha256(text) }
    const queued = f.store.enqueue({ idempotencyKey: 'raw', bindingId: f.binding.id,
      target: { conversation: f.binding.conversation, principal: f.binding.principal }, text: 'summary', format: 'plain', attachment })
    await f.drain()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.store.getOutbox(queued.id)).toMatchObject({ status: 'dead', failureCode: 'attachment-unsupported' })
  })

  test('the store rejects a wrong digest, a markdown intent, and extra keys', async () => {
    const f = await fixture()
    const text = words(20)
    const target = { conversation: f.binding.conversation, principal: f.binding.principal }
    const good = { kind: 'text' as const, name: 'notice-x.txt', mediaType: 'text/plain' as const, text, sha256: sha256(text) }
    const enqueue = (key: string, format: 'plain' | 'markdown', attachment: unknown) => () => f.store.enqueue({ idempotencyKey: key,
      bindingId: f.binding.id, target, text: 'summary', format, attachment: attachment as NonNullable<OutboundIntent['attachment']> })
    expect(enqueue('bad-digest', 'plain', { ...good, sha256: sha256('other') })).toThrow(/attachment is invalid/u)
    expect(enqueue('markdown', 'markdown', good)).toThrow(/attachment is invalid/u)
    expect(enqueue('extra', 'plain', { ...good, extra: 1 })).toThrow(/attachment is invalid/u)
    expect(enqueue('bad-name', 'plain', { ...good, name: '../x' })).toThrow(/attachment is invalid/u)
    expect(enqueue('ok', 'plain', good)().intent.attachment).toEqual(good)
  })
})
