import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { afterEach, describe, expect, test } from 'vitest'
import { DeliveryStore } from '../src/store.ts'
import type { InboundEnvelope } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-inbox-'))
  roots.push(root)
  const path = join(root, 'delivery.sqlite')
  let now = 1_000
  const store = new DeliveryStore({ path, now: () => now, codeGenerator: () => 'PAIR1234' })
  const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
  const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }
  const issued = store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
  store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
  const binding = store.createBinding({ conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
    sessionId: 'session-1', policyRef: 'owner-dm' })
  return { binding, path, principal, conversation, store, setNow(value: number) { now = value } }
}

function envelope(eventId: string, value: Awaited<ReturnType<typeof fixture>>, text = 'hello'): InboundEnvelope {
  return { channel: 'lark', account: 'bot-1', eventId, occurredAt: 900, principal: value.principal,
    conversation: value.conversation, kind: 'text', text, metadata: { source: 'websocket' } }
}

function addBinding(value: Awaited<ReturnType<typeof fixture>>, index: number) {
  const principal = { ...value.principal, user: `ou_batch_${index}` }
  const issued = value.store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
  value.store.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
  const conversation = { ...value.conversation, chat: `oc_batch_${index}` }
  const binding = value.store.createBinding({ conversation, principal, workspace: `/work/batch-${index}`,
    agentPreset: 'primary', sessionId: `session-batch-${index}`, policyRef: 'owner-dm' })
  return { binding, conversation, principal }
}

function imageRef(id: string, overrides: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${id}`),
    mediaType: 'image/png',
    bytes: 8,
    width: 1,
    height: 1,
    ...overrides,
  }
}

describe('durable inbox', () => {
  test('deduplicates exact provider events and conflicts on changed payload', async () => {
    const f = await fixture()
    const first = f.store.acceptInbound(envelope('evt-1', f))
    expect(first).toMatchObject({ duplicate: false, record: { status: 'received', eventId: 'evt-1' } })
    expect(f.store.acceptInbound(envelope('evt-1', f))).toEqual({ duplicate: true, record: first.record })
    expect(() => f.store.acceptInbound(envelope('evt-1', f, 'changed')))
      .toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    f.store.close()
  })

  test('assigns a durable total-order cursor even when Inbox timestamps tie', async () => {
    const f = await fixture()
    const first = f.store.acceptInbound(envelope('evt-cursor-1', f)).record
    const second = f.store.acceptInbound(envelope('evt-cursor-2', f)).record
    expect(second.admissionCursor).toEqual({
      epoch: first.admissionCursor.epoch,
      sequence: first.admissionCursor.sequence + 1,
    })
    expect(f.store.acceptInbound(envelope('evt-cursor-1', f))).toMatchObject({
      duplicate: true,
      record: { admissionCursor: first.admissionCursor },
    })
    f.store.close()

    const reopened = new DeliveryStore({ path: f.path, now: () => 1_000 })
    const third = reopened.acceptInbound({
      ...envelope('evt-cursor-3', f),
      eventId: 'evt-cursor-3',
    }).record
    expect(third.admissionCursor).toEqual({
      epoch: first.admissionCursor.epoch,
      sequence: second.admissionCursor.sequence + 1,
    })
    reopened.close()
  })

  test('rejects namespace confusion, oversize content, and unbounded metadata', async () => {
    const f = await fixture()
    expect(() => f.store.acceptInbound({ ...envelope('evt-1', f), account: 'bot-2' }))
      .toThrowError(expect.objectContaining({ code: 'invalid-envelope' }))
    expect(() => f.store.acceptInbound(envelope('evt-2', f, 'x'.repeat(65_537))))
      .toThrowError(expect.objectContaining({ code: 'invalid-envelope' }))
    expect(() => f.store.acceptInbound({ ...envelope('evt-3', f), metadata: Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`k${index}`, 'v']),
    ) })).toThrowError(expect.objectContaining({ code: 'invalid-envelope' }))
    f.store.close()
  })

  test('persists bounded attachment descriptors as quarantined metadata before any download', async () => {
    const f = await fixture()
    const accepted = f.store.acceptInbound({
      ...envelope('evt-attachment', f),
      attachments: [
        { resourceType: 'file', providerRef: 'file_1', fileName: 'report.pdf' },
        { resourceType: 'image', providerRef: 'image_1' },
      ],
    })
    expect(f.store.listAttachments({ ownerKind: 'inbox', ownerId: accepted.record.id })).toEqual([
      expect.objectContaining({ ownerId: accepted.record.id, resourceType: 'file', providerRef: 'file_1',
        fileName: 'report.pdf', status: 'metadata' }),
      expect.objectContaining({ ownerId: accepted.record.id, resourceType: 'image', providerRef: 'image_1',
        status: 'metadata' }),
    ])
    expect(f.store.acceptInbound({
      ...envelope('evt-attachment', f),
      attachments: [
        { resourceType: 'file', providerRef: 'file_1', fileName: 'report.pdf' },
        { resourceType: 'image', providerRef: 'image_1' },
      ],
    })).toMatchObject({ duplicate: true, record: { id: accepted.record.id } })
    expect(f.store.listAttachments({ ownerKind: 'inbox', ownerId: accepted.record.id })).toHaveLength(2)
    f.store.close()
  })

  test('keeps repeated provider image references as distinct ordered attachment rows', async () => {
    const f = await fixture()
    const accepted = f.store.acceptInbound({
      ...envelope('evt-repeated-image', f),
      attachments: [
        { resourceType: 'image', providerRef: 'image_same', fileName: 'first.png' },
        { resourceType: 'image', providerRef: 'image_same', fileName: 'second.png' },
      ],
    })

    const attachments = f.store.listAttachments({ ownerKind: 'inbox', ownerId: accepted.record.id })
    expect(attachments).toMatchObject([
      { providerRef: 'image_same', fileName: 'first.png', status: 'metadata' },
      { providerRef: 'image_same', fileName: 'second.png', status: 'metadata' },
    ])
    expect(attachments[0]!.id).not.toBe(attachments[1]!.id)
    f.store.close()
  })

  test('preserves provider attachment order after rowid changes, VACUUM, and reopen', async () => {
    const f = await fixture()
    const accepted = f.store.acceptInbound({
      ...envelope('evt-durable-attachment-order', f),
      attachments: [
        { resourceType: 'image', providerRef: 'image_1', fileName: 'first.png' },
        { resourceType: 'image', providerRef: 'image_2', fileName: 'second.png' },
        { resourceType: 'image', providerRef: 'image_3', fileName: 'third.png' },
      ],
    }).record
    f.store.close()

    const database = new DatabaseSync(f.path)
    database.prepare('UPDATE delivery_attachments SET rowid = rowid + 100 WHERE owner_id = ?').run(accepted.id)
    database.prepare(`UPDATE delivery_attachments SET rowid = CASE provider_ref
      WHEN 'image_1' THEN 3 WHEN 'image_2' THEN 1 WHEN 'image_3' THEN 2 END
      WHERE owner_id = ?`).run(accepted.id)
    database.exec('VACUUM')
    database.close()

    const reopened = new DeliveryStore({ path: f.path })
    expect(reopened.listAttachments({ ownerKind: 'inbox', ownerId: accepted.id }).map(item => item.providerRef))
      .toEqual(['image_1', 'image_2', 'image_3'])
    reopened.close()
  })

  test('atomically commits complete ordered image references under the current inbox fence and reuses them after restart', async () => {
    const f = await fixture()
    const accepted = f.store.acceptInbound({
      ...envelope('evt-ready-images', f),
      attachments: [
        { resourceType: 'file', providerRef: 'file_1' },
        { resourceType: 'image', providerRef: 'image_1' },
        { resourceType: 'image', providerRef: 'image_2' },
      ],
    }).record
    f.store.queueInbox(accepted.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    const refs = [imageRef('one', {
      attachmentId: AttachmentId('opaque:tenant/id+one=@~'),
      name: 'one.png',
    }), imageRef('two')]

    expect(f.store.listReadyInboundImageRefs(accepted.id)).toBeUndefined()
    expect(f.store.commitInboundImageRefs({
      inboxId: accepted.id,
      ownerId: 'worker-a',
      fencingToken: claim.fencingToken,
      images: [
        { ref: refs[0]!, contentSha256: 'a'.repeat(64) },
        { ref: refs[1]!, contentSha256: 'b'.repeat(64) },
      ],
    })).toEqual(refs)
    expect(f.store.listReadyInboundImageRefs(accepted.id)).toEqual(refs)
    expect(f.store.listAttachments({ ownerKind: 'inbox', ownerId: accepted.id })).toMatchObject([
      { resourceType: 'file', status: 'metadata' },
      { resourceType: 'image', status: 'ready', mediaType: 'image/png', sizeBytes: 8,
        contentSha256: 'a'.repeat(64), imageRef: refs[0] },
      { resourceType: 'image', status: 'ready', mediaType: 'image/png', sizeBytes: 8,
        contentSha256: 'b'.repeat(64), imageRef: refs[1] },
    ])

    f.store.close()
    const reopened = new DeliveryStore({ path: f.path })
    expect(reopened.listReadyInboundImageRefs(accepted.id)).toEqual(refs)
    reopened.close()
  })

  test('rejects a stale image commit fence without partially updating attachment metadata', async () => {
    const f = await fixture()
    const accepted = f.store.acceptInbound({
      ...envelope('evt-stale-images', f),
      attachments: [
        { resourceType: 'image', providerRef: 'image_1' },
        { resourceType: 'image', providerRef: 'image_2' },
      ],
    }).record
    f.store.queueInbox(accepted.id, f.binding.id)
    const stale = f.store.claimInbox({ ownerId: 'worker-old', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    f.setNow(1_100)
    f.store.recoverInbox({ maxAttempts: 3 })
    const current = f.store.claimInbox({ ownerId: 'worker-current', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!

    expect(() => f.store.commitInboundImageRefs({
      inboxId: accepted.id,
      ownerId: 'worker-old',
      fencingToken: stale.fencingToken,
      images: [
        { ref: imageRef('one'), contentSha256: 'a'.repeat(64) },
        { ref: imageRef('two'), contentSha256: 'b'.repeat(64) },
      ],
    })).toThrowError(expect.objectContaining({ code: 'stale-fence' }))
    expect(f.store.listReadyInboundImageRefs(accepted.id)).toBeUndefined()
    expect(f.store.listAttachments({ ownerKind: 'inbox', ownerId: accepted.id }))
      .toMatchObject([{ status: 'metadata' }, { status: 'metadata' }])

    expect(f.store.commitInboundImageRefs({
      inboxId: accepted.id,
      ownerId: 'worker-current',
      fencingToken: current.fencingToken,
      images: [
        { ref: imageRef('one'), contentSha256: 'a'.repeat(64) },
        { ref: imageRef('two'), contentSha256: 'b'.repeat(64) },
      ],
    })).toHaveLength(2)
    f.store.close()
  })

  test('rejects image publication when the claimed inbox binding is revoked before commit', async () => {
    const f = await fixture()
    const accepted = f.store.acceptInbound({
      ...envelope('evt-binding-revoked-images', f),
      attachments: [
        { resourceType: 'image', providerRef: 'image_1' },
        { resourceType: 'image', providerRef: 'image_2' },
      ],
    }).record
    f.store.queueInbox(accepted.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    f.store.rotateBinding({ bindingId: f.binding.id, expectedVersion: f.binding.version, sessionId: 'session-2' })

    expect(() => f.store.commitInboundImageRefs({
      inboxId: accepted.id,
      ownerId: 'worker-a',
      fencingToken: claim.fencingToken,
      images: [
        { ref: imageRef('one'), contentSha256: 'a'.repeat(64) },
        { ref: imageRef('two'), contentSha256: 'b'.repeat(64) },
      ],
    })).toThrowError(expect.objectContaining({ code: 'unauthorized-principal' }))
    expect(f.store.listAttachments({ ownerKind: 'inbox', ownerId: accepted.id }))
      .toMatchObject([{ status: 'metadata' }, { status: 'metadata' }])
    f.store.close()
  })

  test('rejects image publication when the claimed inbox principal is revoked before commit', async () => {
    const f = await fixture()
    const accepted = f.store.acceptInbound({
      ...envelope('evt-principal-revoked-images', f),
      attachments: [
        { resourceType: 'image', providerRef: 'image_1' },
        { resourceType: 'image', providerRef: 'image_2' },
      ],
    }).record
    f.store.queueInbox(accepted.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    const principal = f.store.getPrincipal(f.principal)!
    f.store.revokePrincipal(principal.id, principal.version)

    expect(() => f.store.commitInboundImageRefs({
      inboxId: accepted.id,
      ownerId: 'worker-a',
      fencingToken: claim.fencingToken,
      images: [
        { ref: imageRef('one'), contentSha256: 'a'.repeat(64) },
        { ref: imageRef('two'), contentSha256: 'b'.repeat(64) },
      ],
    })).toThrowError(expect.objectContaining({ code: 'unauthorized-principal' }))
    expect(f.store.listAttachments({ ownerKind: 'inbox', ownerId: accepted.id }))
      .toMatchObject([{ status: 'metadata' }, { status: 'metadata' }])
    f.store.close()
  })

  test('rejects an incomplete or malformed image-reference batch before updating any row', async () => {
    const f = await fixture()
    const accepted = f.store.acceptInbound({
      ...envelope('evt-invalid-image-batch', f),
      attachments: [
        { resourceType: 'image', providerRef: 'image_1' },
        { resourceType: 'image', providerRef: 'image_2' },
      ],
    }).record
    f.store.queueInbox(accepted.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!

    expect(() => f.store.commitInboundImageRefs({
      inboxId: accepted.id,
      ownerId: 'worker-a',
      fencingToken: claim.fencingToken,
      images: [{ ref: imageRef('one'), contentSha256: 'a'.repeat(64) }],
    })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => f.store.commitInboundImageRefs({
      inboxId: accepted.id,
      ownerId: 'worker-a',
      fencingToken: claim.fencingToken,
      images: [
        { ref: imageRef('one'), contentSha256: 'a'.repeat(64) },
        { ref: imageRef('two', { name: '../secret.png' }), contentSha256: 'b'.repeat(64) },
      ],
    })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => f.store.commitInboundImageRefs({
      inboxId: accepted.id,
      ownerId: 'worker-a',
      fencingToken: claim.fencingToken,
      images: [
        { ref: imageRef('one'), contentSha256: 'a'.repeat(64) },
        { ref: imageRef('two', { attachmentId: AttachmentId('opaque:\nsecret') }),
          contentSha256: 'b'.repeat(64) },
      ],
    })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(f.store.listAttachments({ ownerKind: 'inbox', ownerId: accepted.id }))
      .toMatchObject([{ status: 'metadata' }, { status: 'metadata' }])
    f.store.close()
  })

  test('strictly rejects a corrupted persisted image reference instead of treating spool_ref as a path', async () => {
    const f = await fixture()
    const accepted = f.store.acceptInbound({
      ...envelope('evt-corrupt-image-ref', f),
      attachments: [{ resourceType: 'image', providerRef: 'image_1' }],
    }).record
    f.store.queueInbox(accepted.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    f.store.commitInboundImageRefs({
      inboxId: accepted.id,
      ownerId: 'worker-a',
      fencingToken: claim.fencingToken,
      images: [{ ref: imageRef('one'), contentSha256: 'a'.repeat(64) }],
    })
    f.store.close()

    const database = new DatabaseSync(f.path)
    database.prepare("UPDATE delivery_attachments SET spool_ref = '/tmp/not-an-attachment-ref' WHERE owner_id = ?")
      .run(accepted.id)
    database.close()
    const reopened = new DeliveryStore({ path: f.path })
    expect(() => reopened.listReadyInboundImageRefs(accepted.id))
      .toThrowError(expect.objectContaining({ code: 'conflict' }))
    reopened.close()
  })

  test('rejects unbounded or malformed attachment descriptors without partial inbox state', async () => {
    const f = await fixture()
    expect(() => f.store.acceptInbound({
      ...envelope('evt-too-many-files', f),
      attachments: Array.from({ length: 11 }, (_, index) => ({ resourceType: 'file' as const,
        providerRef: `file_${index}` })),
    })).toThrowError(expect.objectContaining({ code: 'invalid-envelope' }))
    expect(() => f.store.acceptInbound({
      ...envelope('evt-bad-file', f),
      attachments: [{ resourceType: 'file', providerRef: '../escape', fileName: 'bad\0name' }],
    })).toThrowError(expect.objectContaining({ code: 'invalid-envelope' }))
    expect(f.store.getInboxByProviderEvent('lark', 'bot-1', 'evt-too-many-files')).toBeUndefined()
    expect(f.store.getInboxByProviderEvent('lark', 'bot-1', 'evt-bad-file')).toBeUndefined()
    f.store.close()
  })

  test('serializes the exact owner scope across bindings and allows another owner lane', async () => {
    const f = await fixture()
    const secondPrincipal = { ...f.principal, user: 'ou_second' }
    const issued = f.store.issuePairing(secondPrincipal, { ttlMs: 5_000, maxAttempts: 3 })
    f.store.confirmPairing({ challengeId: issued.challenge.id, principal: secondPrincipal, code: issued.code })
    const secondConversation = { ...f.conversation, chat: 'oc_second' }
    const secondBinding = f.store.createBinding({ conversation: secondConversation, principal: secondPrincipal,
      workspace: '/work/beta', agentPreset: 'primary', sessionId: 'session-2', policyRef: 'owner-dm' })
    const siblingConversation = { ...f.conversation, chat: 'oc_owner_sibling' }
    const siblingBinding = f.store.createBinding({
      conversation: siblingConversation,
      principal: f.principal,
      workspace: f.binding.workspace,
      agentPreset: f.binding.agentPreset,
      sessionId: 'session-owner-sibling',
      policyRef: 'owner-dm',
    })
    const one = f.store.acceptInbound(envelope('evt-1', f)).record
    const sibling = f.store.acceptInbound({
      ...envelope('evt-sibling', f),
      conversation: siblingConversation,
    }).record
    const two = f.store.acceptInbound(envelope('evt-2', f)).record
    const other = f.store.acceptInbound({ ...envelope('evt-3', f), principal: secondPrincipal,
      conversation: secondConversation }).record
    for (const [record, binding] of [
      [one, f.binding], [sibling, siblingBinding], [two, f.binding], [other, secondBinding],
    ] as const) {
      f.store.queueInbox(record.id, binding.id)
    }
    const claims = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 10, maxAttempts: 3 })
    expect(claims.map(claim => claim.record.id)).toEqual([one.id, other.id])
    expect(f.store.claimInbox({ ownerId: 'worker-b', leaseMs: 100, limit: 10, maxAttempts: 3 })).toEqual([])
    f.store.finishInbox({ inboxId: one.id, ownerId: 'worker-a', fencingToken: claims[0]!.fencingToken,
      outcome: 'processed' })
    const next = f.store.claimInbox({ ownerId: 'worker-b', leaseMs: 100, limit: 10, maxAttempts: 3 })[0]!
    expect(next.record.id).toBe(sibling.id)
    f.store.finishInbox({ inboxId: sibling.id, ownerId: 'worker-b', fencingToken: next.fencingToken,
      outcome: 'processed' })
    expect(f.store.claimInbox({ ownerId: 'worker-c', leaseMs: 100, limit: 10, maxAttempts: 3 })[0]?.record.id)
      .toBe(two.id)
    f.store.close()
  })

  test('claims owner-scoped Inbox work by its durable admission cursor after rowid rewrite', async () => {
    const f = await fixture()
    const first = f.store.acceptInbound(envelope('evt-stable-order-1', f)).record
    const second = f.store.acceptInbound(envelope('evt-stable-order-2', f)).record
    f.store.queueInbox(first.id, f.binding.id)
    f.store.queueInbox(second.id, f.binding.id)
    expect(first.admissionCursor.sequence).toBeLessThan(second.admissionCursor.sequence)
    f.store.close()

    const database = new DatabaseSync(f.path)
    database.prepare('UPDATE inbox_messages SET rowid = 10002 WHERE id = ?').run(first.id)
    database.prepare('UPDATE inbox_messages SET rowid = 10001 WHERE id = ?').run(second.id)
    database.exec('VACUUM')
    database.close()

    const reopened = new DeliveryStore({ path: f.path })
    const claim = reopened.claimInbox({ ownerId: 'worker-stable-order', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    expect(claim.record.id).toBe(first.id)
    expect(reopened.claimInbox({ ownerId: 'worker-other', leaseMs: 100, limit: 1, maxAttempts: 3 })).toEqual([])
    reopened.close()
  })

  test('durably fences every earlier undispatched Inbox while preserving an already-dispatched turn', async () => {
    const f = await fixture()
    const active = f.store.acceptInbound(envelope('evt-active', f)).record
    const queued = f.store.acceptInbound(envelope('evt-queued', f)).record
    const acceptedButUnbound = f.store.acceptInbound(envelope('evt-accepted-unbound', f)).record
    const stop = f.store.acceptInbound(envelope('evt-stop', f, '/stop')).record
    f.store.queueInbox(active.id, f.binding.id)
    f.store.queueInbox(queued.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    f.store.markInboxDispatching({
      inboxId: active.id,
      ownerId: 'worker-a',
      fencingToken: claim.fencingToken,
      binding: f.binding,
    })

    expect(f.store.cancelUndispatchedInboxBefore({
      bindingId: f.binding.id,
      beforeInboxId: stop.id,
      failureCode: 'user-stopped-before-dispatch',
    })).toEqual({
      cancelled: 2,
      dispatching: 1,
      claimedInboxIds: [],
      dispatchingInboxIds: [active.id],
    })
    f.store.close()
    const reopened = new DeliveryStore({ path: f.path })
    expect(reopened.getInbox(active.id)).toMatchObject({
      status: 'claimed',
      failureCode: 'dispatch-started',
    })
    expect(reopened.getInbox(queued.id)).toMatchObject({
      status: 'dead_letter',
      failureCode: 'user-stopped-before-dispatch',
    })
    expect(reopened.getInbox(acceptedButUnbound.id)).toMatchObject({
      status: 'dead_letter',
      failureCode: 'user-stopped-before-dispatch',
    })
    expect(reopened.getInbox(stop.id)).toMatchObject({ status: 'received' })
    reopened.close()
  })

  test.each([
    ['/permission full confirm', '/stop'],
    ['/permissions', '/new'],
  ])('durably marks an interrupted %s dispatch for cancelled recovery before %s', async (permission, command) => {
    const f = await fixture()
    const dispatched = f.store.acceptInbound({
      ...envelope(`evt-${command.slice(1)}-permission`, f, permission),
      kind: 'command',
    }).record
    const boundary = f.store.acceptInbound({
      ...envelope(`evt-${command.slice(1)}-boundary`, f, command),
      kind: 'command',
    }).record
    f.store.queueInbox(dispatched.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 1 })[0]!
    f.store.markInboxDispatching({
      inboxId: dispatched.id,
      ownerId: 'worker-a',
      fencingToken: claim.fencingToken,
      binding: f.binding,
    })

    f.store.cancelUndispatchedInboxBefore({
      bindingId: f.binding.id,
      beforeInboxId: boundary.id,
      failureCode: command === '/new' ? 'new-session-before-dispatch' : 'user-stopped-before-dispatch',
    })
    expect(f.store.getInbox(dispatched.id)).toMatchObject({
      status: 'claimed',
      failureCode: 'permission-cancelled-recovery',
    })
    f.store.close()

    const reopened = new DeliveryStore({ path: f.path })
    expect(reopened.recoverInbox({ maxAttempts: 1 })).toEqual([
      expect.objectContaining({
        id: dispatched.id,
        status: 'retry_wait',
        failureCode: 'permission-cancelled-recovery',
      }),
    ])
    reopened.close()
  })

  test('invalidates an earlier claimed Inbox that has not crossed its dispatch gate', async () => {
    const f = await fixture()
    const claimed = f.store.acceptInbound(envelope('evt-claimed', f)).record
    const stop = f.store.acceptInbound(envelope('evt-stop', f, '/stop')).record
    f.store.queueInbox(claimed.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!

    expect(f.store.cancelUndispatchedInboxBefore({
      bindingId: f.binding.id,
      beforeInboxId: stop.id,
      failureCode: 'user-stopped-before-dispatch',
    })).toEqual({
      cancelled: 1,
      dispatching: 0,
      claimedInboxIds: [claimed.id],
      dispatchingInboxIds: [],
    })
    expect(f.store.getInbox(claimed.id)).toMatchObject({
      status: 'dead_letter',
      failureCode: 'user-stopped-before-dispatch',
    })
    expect(() => f.store.markInboxDispatching({
      inboxId: claimed.id,
      ownerId: 'worker-a',
      fencingToken: claim.fencingToken,
      binding: f.binding,
    })).toThrowError(expect.objectContaining({ code: 'stale-fence' }))
    f.store.close()
  })

  test('recovers expired claims and rejects stale completion fencing', async () => {
    const f = await fixture()
    const record = f.store.acceptInbound(envelope('evt-1', f)).record
    f.store.queueInbox(record.id, f.binding.id)
    const first = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 2 })[0]!
    f.setNow(1_100)
    expect(f.store.recoverInbox({ maxAttempts: 2 })).toEqual([expect.objectContaining({ id: record.id, status: 'retry_wait' })])
    const second = f.store.claimInbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 2 })[0]!
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken)
    expect(() => f.store.finishInbox({ inboxId: record.id, ownerId: 'worker-a', fencingToken: first.fencingToken,
      outcome: 'processed' })).toThrowError(expect.objectContaining({ code: 'stale-fence' }))
    f.store.finishInbox({ inboxId: record.id, ownerId: 'worker-b', fencingToken: second.fencingToken,
      outcome: 'retry_wait', failureCode: 'temporary', retryAt: 1_200 })
    f.setNow(1_200)
    const third = f.store.claimInbox({ ownerId: 'worker-c', leaseMs: 100, limit: 1, maxAttempts: 2 })
    expect(third).toEqual([])
    expect(f.store.getInbox(record.id)).toMatchObject({ status: 'dead_letter', attemptCount: 2 })
    f.store.close()
  })

  test('renews only the current unexpired inbox claim', async () => {
    const f = await fixture()
    const record = f.store.acceptInbound(envelope('evt-renew', f)).record
    f.store.queueInbox(record.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!

    f.setNow(1_050)
    expect(f.store.renewInboxClaim({
      inboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken, leaseMs: 100,
    })).toBe(true)
    expect(f.store.getInbox(record.id)).toMatchObject({ status: 'claimed', leaseUntil: 1_150 })
    expect(f.store.renewInboxClaim({
      inboxId: record.id, ownerId: 'worker-b', fencingToken: claim.fencingToken, leaseMs: 100,
    })).toBe(false)
    expect(f.store.renewInboxClaim({
      inboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken + 1, leaseMs: 100,
    })).toBe(false)

    f.setNow(1_150)
    expect(f.store.renewInboxClaim({
      inboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken, leaseMs: 100,
    })).toBe(false)
    expect(() => f.store.markInboxDispatching({
      inboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken, binding: f.binding,
    })).toThrowError(expect.objectContaining({ code: 'stale-fence' }))
    expect(() => f.store.finishInbox({
      inboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken, outcome: 'processed',
    })).toThrowError(expect.objectContaining({ code: 'stale-fence' }))
    expect(f.store.recoverInbox({ maxAttempts: 3 })).toEqual([
      expect.objectContaining({ id: record.id, status: 'retry_wait', failureCode: 'lease-expired' }),
    ])
    f.store.close()
  })

  test('claims one explicit operator retry after automatic attempts are exhausted', async () => {
    const f = await fixture()
    const record = f.store.acceptInbound(envelope('evt-operator-retry', f)).record
    f.store.queueInbox(record.id, f.binding.id)
    const first = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 1 })[0]!
    f.store.finishInbox({ inboxId: record.id, ownerId: 'worker-a', fencingToken: first.fencingToken,
      outcome: 'retry_wait', failureCode: 'temporary', retryAt: 1_100 })
    f.setNow(1_100)
    expect(f.store.claimInbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 1 })).toEqual([])
    expect(f.store.getInbox(record.id)).toMatchObject({ status: 'dead_letter', attemptCount: 1,
      failureCode: 'attempts-exhausted' })

    expect(f.store.resolveInbox({ inboxId: record.id, expectedAttemptCount: 1,
      resolution: 'retry', operatorId: 'test-operator' }))
      .toMatchObject({ record: { status: 'queued', attemptCount: 1 }, replayed: false })
    const retried = f.store.claimInbox({ ownerId: 'worker-c', leaseMs: 100, limit: 1, maxAttempts: 1 })[0]!
    expect(retried).toMatchObject({ fencingToken: 2, record: { id: record.id, status: 'claimed', attemptCount: 2 } })
    expect(() => f.store.finishInbox({ inboxId: record.id, ownerId: 'worker-a', fencingToken: first.fencingToken,
      outcome: 'processed' })).toThrowError(expect.objectContaining({ code: 'stale-fence' }))
    f.store.close()
  })

  test('projects a cancelled dead letter as resolved across restart without deleting its audit row', async () => {
    const f = await fixture()
    const record = f.store.acceptInbound(envelope('evt-operator-cancel', f)).record
    f.store.deadLetterInbox(record.id, 'invalid-provider-payload')
    expect(f.store.health()).toMatchObject({
      deadLetterInbox: 1,
      actionableDeadLetterInbox: 1,
      resolvedDeadLetterInbox: 0,
    })

    expect(f.store.resolveInbox({ inboxId: record.id, expectedAttemptCount: 0,
      resolution: 'cancel', operatorId: 'owner-operator' }))
      .toMatchObject({ record: { id: record.id, status: 'dead_letter',
        failureCode: 'operator-cancelled' }, replayed: false })
    expect(f.store.getDeadLetterResolution({ kind: 'inbox', id: record.id, attemptCount: 0 })).toEqual({
      receiptVersion: 1,
      kind: 'inbox',
      id: record.id,
      attemptCount: 0,
      resolution: 'cancel',
      originalStatus: 'dead_letter',
      originalFailureCode: 'invalid-provider-payload',
      operatorId: 'owner-operator',
      createdAt: 1_000,
    })
    expect(f.store.health()).toMatchObject({
      deadLetterInbox: 1,
      actionableDeadLetterInbox: 0,
      resolvedDeadLetterInbox: 1,
    })
    f.store.close()

    const reopened = new DeliveryStore({ path: f.path, now: () => 2_000 })
    expect(reopened.getInbox(record.id)).toMatchObject({ status: 'dead_letter', failureCode: 'operator-cancelled' })
    expect(reopened.health()).toMatchObject({
      deadLetterInbox: 1,
      actionableDeadLetterInbox: 0,
      resolvedDeadLetterInbox: 1,
    })
    expect(reopened.getDeadLetterResolution({ kind: 'inbox', id: record.id, attemptCount: 0 }))
      .toMatchObject({ resolution: 'cancel', operatorId: 'owner-operator' })
    expect(reopened.resolveInbox({ inboxId: record.id, expectedAttemptCount: 0,
      resolution: 'cancel', operatorId: 'owner-operator' }))
      .toMatchObject({ record: { id: record.id, status: 'dead_letter' },
        receipt: { resolution: 'cancel', operatorId: 'owner-operator' }, replayed: true })
    expect(() => reopened.resolveInbox({ inboxId: record.id, expectedAttemptCount: 0,
      resolution: 'cancel', operatorId: 'different-operator' }))
      .toThrowError(expect.objectContaining({ code: 'version-conflict' }))
    reopened.close()
  })

  test('migrates v8 operator-cancelled dead letters with recovered or explicit unknown failures', async () => {
    const f = await fixture()
    const record = f.store.acceptInbound(envelope('evt-v8-operator-cancel-no-history', f)).record
    f.store.deadLetterInbox(record.id, 'invalid-provider-payload')
    const historical = f.store.acceptInbound(envelope('evt-v8-operator-cancel-history', f)).record
    f.store.queueInbox(historical.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    f.store.finishInbox({ inboxId: historical.id, ownerId: 'worker-a', fencingToken: claim.fencingToken,
      outcome: 'dead_letter', failureCode: 'processor-rejected' })
    f.store.close()

    const legacy = new DatabaseSync(f.path)
    legacy.exec(`
      DROP TABLE IF EXISTS delivery_preference_projection_outbox;
      DROP TABLE IF EXISTS trusted_delivery_evaluation_outbox;
      DROP TABLE IF EXISTS workflow_trace_commands;
      DROP TABLE IF EXISTS workflow_trace_outbox;
      DROP TABLE IF EXISTS workflow_trace_current;
      DROP TABLE IF EXISTS workflow_trace_revisions;
      DROP TABLE IF EXISTS workflow_template_registry;
      DROP TABLE IF EXISTS workflow_trace_source;
      DROP TABLE IF EXISTS delivery_presentations;
      DROP TRIGGER dead_letter_inbox_resolution_fence;
      DROP TRIGGER dead_letter_outbox_resolution_fence;
      DROP TRIGGER dead_letter_outbox_cancelled_unknown_fence;
      DROP TABLE dead_letter_resolutions;
      PRAGMA user_version = 8;
    `)
    legacy.prepare(`
      UPDATE inbox_messages SET failure_code = 'operator-cancelled' WHERE id IN (?, ?)
    `).run(record.id, historical.id)
    legacy.close()

    const migrated = new DeliveryStore({ path: f.path, now: () => 2_000 })
    expect(migrated.getInbox(record.id)).toMatchObject({
      status: 'dead_letter', attemptCount: 0, failureCode: 'operator-cancelled',
    })
    expect(migrated.getDeadLetterResolution({ kind: 'inbox', id: record.id, attemptCount: 0 }))
      .toEqual({
        receiptVersion: 1,
        kind: 'inbox',
        id: record.id,
        attemptCount: 0,
        resolution: 'cancel',
        originalStatus: 'dead_letter',
        originalFailureCode: 'legacy-unknown',
        operatorId: 'legacy-v8-migration',
        createdAt: 1_000,
      })
    expect(migrated.getDeadLetterResolution({ kind: 'inbox', id: historical.id, attemptCount: 1 }))
      .toMatchObject({
        resolution: 'cancel', originalStatus: 'dead_letter',
        originalFailureCode: 'processor-rejected', operatorId: 'legacy-v8-migration',
      })
    expect(migrated.health()).toMatchObject({
      deadLetterInbox: 2, actionableDeadLetterInbox: 0, resolvedDeadLetterInbox: 2,
    })
    for (const [id, attemptCount] of [[record.id, 0], [historical.id, 1]] as const) {
      expect(() => migrated.resolveInbox({ inboxId: id, expectedAttemptCount: attemptCount,
        resolution: 'retry', operatorId: 'owner-operator' }))
        .toThrowError(expect.objectContaining({ code: 'version-conflict' }))
    }
    migrated.close()
  })

  test('makes a newly failed retry attempt actionable despite the previous attempt receipt', async () => {
    const f = await fixture()
    const record = f.store.acceptInbound(envelope('evt-retry-fails-again', f)).record
    f.store.queueInbox(record.id, f.binding.id)
    const first = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 1 })[0]!
    f.store.finishInbox({ inboxId: record.id, ownerId: 'worker-a', fencingToken: first.fencingToken,
      outcome: 'dead_letter', failureCode: 'permanent-first' })
    f.store.resolveInbox({ inboxId: record.id, expectedAttemptCount: 1,
      resolution: 'retry', operatorId: 'owner-operator' })

    const second = f.store.claimInbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 1 })[0]!
    f.store.finishInbox({ inboxId: record.id, ownerId: 'worker-b', fencingToken: second.fencingToken,
      outcome: 'dead_letter', failureCode: 'permanent-second' })
    expect(f.store.getInbox(record.id)).toMatchObject({ status: 'dead_letter', attemptCount: 2,
      failureCode: 'permanent-second' })
    expect(f.store.getDeadLetterResolution({ kind: 'inbox', id: record.id, attemptCount: 1 }))
      .toMatchObject({ resolution: 'retry', originalFailureCode: 'permanent-first' })
    expect(f.store.getDeadLetterResolution({ kind: 'inbox', id: record.id, attemptCount: 2 })).toBeUndefined()
    expect(f.store.health()).toMatchObject({
      deadLetterInbox: 1,
      actionableDeadLetterInbox: 1,
      resolvedDeadLetterInbox: 0,
    })
    f.store.close()
  })

  test('never replays a claim whose external Agent dispatch may already have started', async () => {
    const f = await fixture()
    const record = f.store.acceptInbound(envelope('evt-ambiguous', f)).record
    f.store.queueInbox(record.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    f.store.markInboxDispatching({
      inboxId: record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken, binding: f.binding,
    })
    f.setNow(1_100)
    expect(f.store.recoverInbox({ maxAttempts: 3 })).toEqual([
      expect.objectContaining({ id: record.id, status: 'dead_letter', failureCode: 'dispatch-ambiguous' }),
    ])
    expect(f.store.claimInbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 3 })).toEqual([])
    f.store.close()
  })

  test('reopens and retries only an exact permission command interrupted after its dispatch fence', async () => {
    const f = await fixture()
    const record = f.store.acceptInbound({
      ...envelope('evt-permission-crash', f, '/permission full confirm'),
      kind: 'command',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 1 })[0]!
    f.store.markInboxDispatching({
      inboxId: record.id,
      ownerId: 'worker-a',
      fencingToken: claim.fencingToken,
      binding: f.binding,
    })
    f.store.close()

    const reopened = new DeliveryStore({ path: f.path })
    expect(reopened.recoverInbox({ maxAttempts: 1 })).toEqual([
      expect.objectContaining({
        id: record.id,
        status: 'retry_wait',
        failureCode: 'permission-dispatch-recovery',
      }),
    ])
    const recovered = reopened.claimInbox({
      ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 1,
    })[0]!
    expect(recovered.record).toMatchObject({
      id: record.id,
      status: 'claimed',
      failureCode: 'permission-dispatch-recovery',
      attemptCount: 2,
    })
    reopened.markInboxDispatching({
      inboxId: record.id,
      ownerId: 'worker-b',
      fencingToken: recovered.fencingToken,
      binding: f.binding,
    })
    expect(reopened.getInbox(record.id)).toMatchObject({
      status: 'claimed',
      failureCode: 'permission-dispatch-recovery',
    })
    reopened.close()
  })

  test.each([
    ['success', '已切换到完全访问权限。'],
    ['failure', '权限切换失败；已安全恢复为 ask。'],
  ])('cold reopen uses a durable %s permission reply as the terminal Inbox witness', async (_kind, text) => {
    const f = await fixture()
    const eventId = `evt-permission-outbox-witness-${_kind}`
    const record = f.store.acceptInbound({
      ...envelope(eventId, f, '/permission full confirm'),
      kind: 'command',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    f.store.markInboxDispatching({
      inboxId: record.id,
      ownerId: 'worker-a',
      fencingToken: claim.fencingToken,
      binding: f.binding,
    })
    f.store.enqueue({
      idempotencyKey: `inbound:${eventId}:reply`,
      bindingId: f.binding.id,
      target: { conversation: f.conversation, principal: f.principal },
      text,
      format: 'plain',
      replyToEventId: eventId,
    })
    f.store.close()

    const reopened = new DeliveryStore({ path: f.path })
    expect(reopened.recoverInbox({ maxAttempts: 3 })).toEqual([
      expect.objectContaining({ id: record.id, status: 'processed' }),
    ])
    expect(reopened.claimInbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 3 }))
      .toEqual([])
    reopened.close()
  })

  test('does not accept a background Outbox row as a permission terminal reply witness', async () => {
    const f = await fixture()
    const eventId = 'evt-permission-background-impostor'
    const record = f.store.acceptInbound({
      ...envelope(eventId, f, '/permission full confirm'),
      kind: 'command',
    }).record
    f.store.queueInbox(record.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    f.store.markInboxDispatching({
      inboxId: record.id,
      ownerId: 'worker-a',
      fencingToken: claim.fencingToken,
      binding: f.binding,
    })
    const impostorIntent = {
      idempotencyKey: `inbound:${record.id}:reply`,
      bindingId: f.binding.id,
      target: { conversation: f.conversation, principal: f.principal },
      text: 'unrelated background message',
      format: 'plain' as const,
    }
    expect(() => f.store.enqueue(impostorIntent)).toThrowError(expect.objectContaining({
      code: 'invalid-intent',
    }))
    const historicalImpostor = f.store.enqueue({
      ...impostorIntent,
      idempotencyKey: `background:${record.id}`,
    })
    f.store.close()

    // Simulate a row written by an older build before the inbound reply
    // namespace became reserved. Recovery must still inspect its intent rather
    // than trusting the key alone.
    const database = new DatabaseSync(f.path)
    database.prepare('UPDATE outbox_messages SET idempotency_key = ? WHERE id = ?')
      .run(`inbound:${record.id}:reply`, historicalImpostor.id)
    database.close()

    const reopened = new DeliveryStore({ path: f.path })
    expect(reopened.recoverInbox({ maxAttempts: 3 })).toEqual([
      expect.objectContaining({
        id: record.id,
        status: 'retry_wait',
        failureCode: 'permission-dispatch-recovery',
      }),
    ])
    reopened.close()
  })

  test('cold recovery scopes permission terminal witnesses by durable Inbox identity', async () => {
    const f = await fixture()
    const secondPrincipal = { ...f.principal, account: 'bot-2' }
    const secondConversation = { ...f.conversation, account: 'bot-2', chat: 'oc_owner_bot_2' }
    const issued = f.store.issuePairing(secondPrincipal, { ttlMs: 5_000, maxAttempts: 3 })
    f.store.confirmPairing({ challengeId: issued.challenge.id, principal: secondPrincipal, code: issued.code })
    const secondBinding = f.store.createBinding({
      conversation: secondConversation,
      principal: secondPrincipal,
      workspace: '/work/bot-2',
      agentPreset: 'primary',
      sessionId: 'session-bot-2',
      policyRef: 'owner-dm',
    })
    const eventId = 'evt-shared-provider-permission'
    const records = [
      {
        binding: f.binding,
        record: f.store.acceptInbound({
          ...envelope(eventId, f, '/permissions'),
          kind: 'command',
        }).record,
      },
      {
        binding: secondBinding,
        record: f.store.acceptInbound({
          ...envelope(eventId, f, '/permissions'),
          account: secondPrincipal.account,
          principal: secondPrincipal,
          conversation: secondConversation,
          kind: 'command',
        }).record,
      },
    ]
    for (const [index, item] of records.entries()) {
      f.store.queueInbox(item.record.id, item.binding.id)
      const claim = f.store.claimInbox({
        ownerId: `worker-${index}`,
        leaseMs: 100,
        limit: 1,
        maxAttempts: 1,
      })[0]!
      f.store.markInboxDispatching({
        inboxId: item.record.id,
        ownerId: `worker-${index}`,
        fencingToken: claim.fencingToken,
        binding: item.binding,
      })
      f.store.enqueue({
        idempotencyKey: `inbound:${item.record.id}:reply`,
        bindingId: item.binding.id,
        target: { conversation: item.binding.conversation, principal: item.binding.principal },
        text: `terminal reply ${index}`,
        format: 'plain',
        replyToEventId: eventId,
      })
    }
    f.store.close()

    const reopened = new DeliveryStore({ path: f.path })
    expect(reopened.recoverInbox({ maxAttempts: 1 })).toEqual([
      expect.objectContaining({ id: records[0]!.record.id, status: 'processed' }),
      expect.objectContaining({ id: records[1]!.record.id, status: 'processed' }),
    ])
    expect(reopened.claimInbox({ ownerId: 'worker-reopen', leaseMs: 100, limit: 2, maxAttempts: 1 }))
      .toEqual([])
    reopened.close()
  })

  test('atomically rejects a dispatch marker whose exact binding snapshot was rotated', async () => {
    const f = await fixture()
    const record = f.store.acceptInbound(envelope('evt-marker-rotated-binding', f)).record
    f.store.queueInbox(record.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!

    f.store.rotateBinding({ bindingId: f.binding.id, expectedVersion: f.binding.version, sessionId: 'session-2' })
    expect(() => f.store.markInboxDispatching({
      inboxId: record.id,
      ownerId: 'worker-a',
      fencingToken: claim.fencingToken,
      binding: f.binding,
    })).toThrowError(expect.objectContaining({ code: 'invalid-binding' }))
    expect(f.store.getInbox(record.id)).toMatchObject({ status: 'claimed' })
    expect(f.store.getInbox(record.id)).not.toHaveProperty('failureCode')
    f.store.close()
  })

  test('atomically rejects a dispatch marker after its exact principal is revoked', async () => {
    const f = await fixture()
    const record = f.store.acceptInbound(envelope('evt-marker-revoked-principal', f)).record
    f.store.queueInbox(record.id, f.binding.id)
    const claim = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 1, maxAttempts: 3 })[0]!
    const principal = f.store.getPrincipal(f.binding.principal)!

    f.store.revokePrincipal(principal.id, principal.version)
    expect(() => f.store.markInboxDispatching({
      inboxId: record.id,
      ownerId: 'worker-a',
      fencingToken: claim.fencingToken,
      binding: f.binding,
    })).toThrowError(expect.objectContaining({ code: 'unauthorized-principal' }))
    expect(f.store.getInbox(record.id)).toMatchObject({ status: 'claimed' })
    expect(f.store.getInbox(record.id)).not.toHaveProperty('failureCode')
    f.store.close()
  })

  test('revoking a principal revokes only all of that exact principal active bindings', async () => {
    const f = await fixture()
    const secondForOwner = f.store.createBinding({
      conversation: { ...f.conversation, chat: 'oc_owner_second' },
      principal: f.principal,
      workspace: '/work/owner-second',
      agentPreset: 'primary',
      sessionId: 'session-owner-second',
      policyRef: 'owner-dm',
    })
    const other = addBinding(f, 42)
    const principal = f.store.getPrincipal(f.principal)!

    f.store.revokePrincipal(principal.id, principal.version)

    expect(f.store.getBinding(f.binding.id)).toMatchObject({
      status: 'revoked', version: f.binding.version + 1,
    })
    expect(f.store.getBinding(secondForOwner.id)).toMatchObject({
      status: 'revoked', version: secondForOwner.version + 1,
    })
    expect(f.store.getBinding(other.binding.id)).toEqual(other.binding)
    f.store.close()
  })

  test('bounds expired inbox recovery to the requested database batch', async () => {
    const f = await fixture()
    const records = Array.from({ length: 3 }, (_, index) => {
      const route = addBinding(f, index)
      const record = f.store.acceptInbound({ ...envelope(`evt-expired-${index}`, f),
        principal: route.principal, conversation: route.conversation }).record
      f.store.queueInbox(record.id, route.binding.id)
      return record
    })
    expect(f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 3, maxAttempts: 3 })).toHaveLength(3)
    f.setNow(1_100)

    expect(f.store.recoverInbox({ maxAttempts: 3, limit: 2 })).toHaveLength(2)
    expect(records.map(record => f.store.getInbox(record.id)?.status)).toEqual([
      'retry_wait', 'retry_wait', 'claimed',
    ])
    expect(f.store.recoverInbox({ maxAttempts: 3, limit: 2 })).toHaveLength(1)
    f.store.close()
  })

  test('bounds exhausted inbox cleanup performed by a claim call', async () => {
    const f = await fixture()
    const records = Array.from({ length: 3 }, (_, index) => {
      const route = addBinding(f, index)
      const record = f.store.acceptInbound({ ...envelope(`evt-exhausted-${index}`, f),
        principal: route.principal, conversation: route.conversation }).record
      f.store.queueInbox(record.id, route.binding.id)
      return record
    })
    const claims = f.store.claimInbox({ ownerId: 'worker-a', leaseMs: 100, limit: 3, maxAttempts: 1 })
    for (const claim of claims) {
      f.store.finishInbox({ inboxId: claim.record.id, ownerId: 'worker-a', fencingToken: claim.fencingToken,
        outcome: 'retry_wait', failureCode: 'temporary', retryAt: 1_100 })
    }
    f.setNow(1_100)

    expect(f.store.claimInbox({ ownerId: 'worker-b', leaseMs: 100, limit: 1, maxAttempts: 1,
      maintenanceLimit: 2 })).toEqual([])
    expect(records.map(record => f.store.getInbox(record.id)?.status)).toEqual([
      'dead_letter', 'dead_letter', 'retry_wait',
    ])
    expect(f.store.claimInbox({ ownerId: 'worker-c', leaseMs: 100, limit: 1, maxAttempts: 1,
      maintenanceLimit: 2 })).toEqual([])
    expect(f.store.getInbox(records[2]!.id)).toMatchObject({ status: 'dead_letter',
      failureCode: 'attempts-exhausted' })
    f.store.close()
  })

  test('deduplicates the same persisted event over 100 cold store reopenings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-reopen-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const value: InboundEnvelope = { channel: 'lark', account: 'bot-1', eventId: 'evt-stable', occurredAt: 1,
      principal: { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' },
      conversation: { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm', chat: 'oc_owner' },
      kind: 'text', text: 'stable' }
    let id: string | undefined
    for (let index = 0; index < 100; index += 1) {
      const store = new DeliveryStore({ path })
      const accepted = store.acceptInbound(value)
      if (id === undefined) id = accepted.record.id
      else expect(accepted).toMatchObject({ duplicate: true, record: { id } })
      store.close()
    }
  })
})
