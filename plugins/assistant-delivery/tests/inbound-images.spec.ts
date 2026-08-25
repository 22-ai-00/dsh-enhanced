import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AttachmentError,
  AttachmentId,
  type AttachmentStore,
  type ImageAttachmentRef,
  type SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DeliveryAdapterRegistry } from '../src/coordinator.ts'
import { InboundImageMaterializer } from '../src/inbound-images.ts'
import { DeliveryStore } from '../src/store.ts'
import type { ConversationBinding, DeliveryAdapter, InboundEnvelope } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function ref(id: string, name?: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${id}`),
    mediaType: 'image/png',
    bytes: png.byteLength,
    width: 1,
    height: 1,
    ...(name === undefined ? {} : { name }),
  }
}

async function fixture(overrides: {
  attachments?: AttachmentStore
  authorized?: () => boolean
  read?: DeliveryAdapter['readInboundImage']
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-images-'))
  roots.push(root)
  let now = 1_000
  const store = new DeliveryStore({ path: join(root, 'delivery.sqlite'), now: () => now })
  const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
  const conversation = {
    channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner',
  }
  const pairing = store.issuePairing(principal, { ttlMs: 5_000, maxAttempts: 3 })
  store.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
  const binding = store.createBinding({
    conversation,
    principal,
    workspace: '/work/alpha',
    agentPreset: 'primary',
    sessionId: 'session-1',
    policyRef: 'owner-dm',
  })
  const registry = new DeliveryAdapterRegistry({ accept: async () => {
    throw new Error('not used')
  }, receipt: async () => {} })
  const read = overrides.read ?? vi.fn(async () => ({
    outcome: 'downloaded' as const,
    data: png,
    mediaType: 'image/png' as const,
  }))
  const adapter: DeliveryAdapter = {
    channel: 'lark',
    account: 'bot-1',
    capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'], inboundImages: true },
    start: async () => {},
    readInboundImage: read,
    send: async () => ({ outcome: 'accepted', providerMessageId: 'om_unused' }),
  }
  await registry.register(adapter)
  const savedRefs = [ref('one', 'one.png'), ref('two', 'two.png')]
  const saveImages = vi.fn(async (images: readonly SaveImageAttachment[]) => savedRefs.slice(0, images.length))
  const attachments = overrides.attachments ?? ({
    imageLimits: {
      maxImageBytes: 32,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 48,
      maxImagePixels: 100,
      maxImageDimension: 10,
      mediaTypes: ['image/png'],
    },
    saveImages,
  } as unknown as AttachmentStore)
  const authorized = vi.fn(overrides.authorized ?? (() => true))
  const materializer = new InboundImageMaterializer({
    store,
    registry,
    getAttachments: () => attachments,
    isAuthorized: authorized,
  })
  const envelope = (eventId: string, attachmentsInput: InboundEnvelope['attachments'], kind: 'command' | 'text' = 'text'):
  InboundEnvelope => ({
    channel: 'lark',
    account: 'bot-1',
    eventId,
    occurredAt: now,
    principal,
    conversation,
    kind,
    text: kind === 'command' ? '/model' : 'look',
    ...(attachmentsInput === undefined ? {} : { attachments: attachmentsInput }),
  })
  const claim = (message: InboundEnvelope) => {
    const accepted = store.acceptInbound(message).record
    store.queueInbox(accepted.id, binding.id)
    const claimed = store.claimInbox({ ownerId: 'worker-a', leaseMs: 500, limit: 1, maxAttempts: 3 })[0]!
    return { inboxId: accepted.id, ownerId: 'worker-a', fencingToken: claimed.fencingToken }
  }
  return {
    attachments,
    authorized,
    binding,
    claim,
    envelope,
    materializer,
    read: read as ReturnType<typeof vi.fn>,
    registry,
    saveImages,
    savedRefs,
    setNow(value: number) { now = value },
    store,
  }
}

async function materialize(
  f: Awaited<ReturnType<typeof fixture>>,
  envelope: InboundEnvelope,
  binding: ConversationBinding = f.binding,
) {
  return f.materializer.materialize({
    ...f.claim(envelope),
    binding,
    envelope,
    signal: new AbortController().signal,
  })
}

describe('authorized inbound image materialization', () => {
  test('downloads in descriptor order, batch-saves once, and durably reuses refs without provider I/O', async () => {
    const f = await fixture()
    const input = f.envelope('evt-images', [
      { resourceType: 'file', providerRef: 'file_private' },
      { resourceType: 'image', providerRef: 'image_private_1', fileName: 'one.png' },
      { resourceType: 'image', providerRef: 'image_private_2', fileName: 'two.png' },
    ])

    await expect(materialize(f, input)).resolves.toEqual({ outcome: 'ready', imageAttachments: f.savedRefs })
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(f.read.mock.calls.map(call => call[0].attachment.providerRef))
      .toEqual(['image_private_1', 'image_private_2'])
    expect(f.read.mock.calls.map(call => call[0].maxBytes)).toEqual([32, 32])
    expect(f.saveImages).toHaveBeenCalledOnce()
    expect(f.saveImages).toHaveBeenCalledWith([
      { data: png, mediaType: 'image/png', name: 'one.png' },
      { data: png, mediaType: 'image/png', name: 'two.png' },
    ])
    expect(f.store.listReadyInboundImageRefs(f.store.listInbox({ bindingId: f.binding.id })[0]!.id))
      .toEqual(f.savedRefs)

    const originalReadCount = f.read.mock.calls.length
    const persistedInbox = f.store.listInbox({ bindingId: f.binding.id })[0]!
    await expect(f.materializer.materialize({
      inboxId: persistedInbox.id,
      ownerId: 'worker-a',
      fencingToken: persistedInbox.fencingToken!,
      binding: f.binding,
      envelope: input,
      signal: new AbortController().signal,
    })).resolves.toEqual({ outcome: 'ready', imageAttachments: f.savedRefs })
    expect(f.read).toHaveBeenCalledTimes(originalReadCount)
  })

  test('reuses committed refs after a pre-marker crash and requests the model only once after recovery', async () => {
    const f = await fixture()
    const input = f.envelope('evt-images-pre-marker-crash', [
      { resourceType: 'image', providerRef: 'image_private_once', fileName: 'once.png' },
    ])
    await expect(materialize(f, input)).resolves.toEqual({
      outcome: 'ready', imageAttachments: [f.savedRefs[0]],
    })
    const inbox = f.store.listInbox({ bindingId: f.binding.id })[0]!
    expect(inbox).not.toHaveProperty('failureCode')

    // Simulate a process crash after durable ref publication but before dispatch marking.
    f.setNow(1_500)
    expect(f.store.recoverInbox({ maxAttempts: 3 })).toEqual([
      expect.objectContaining({ id: inbox.id, status: 'retry_wait', failureCode: 'lease-expired' }),
    ])
    const recovered = f.store.claimInbox({ ownerId: 'worker-b', leaseMs: 500, limit: 1, maxAttempts: 3 })[0]!
    const ready = await f.materializer.materialize({
      inboxId: inbox.id,
      ownerId: 'worker-b',
      fencingToken: recovered.fencingToken,
      binding: f.binding,
      envelope: input,
      signal: new AbortController().signal,
    })
    expect(ready).toEqual({ outcome: 'ready', imageAttachments: [f.savedRefs[0]] })

    f.store.markInboxDispatching({
      inboxId: inbox.id,
      ownerId: 'worker-b',
      fencingToken: recovered.fencingToken,
      binding: f.binding,
    })
    const requestModel = vi.fn(async (_images: readonly ImageAttachmentRef[]) => 'reply')
    if (ready.outcome === 'ready') await requestModel(ready.imageAttachments)

    expect(f.read).toHaveBeenCalledOnce()
    expect(f.saveImages).toHaveBeenCalledOnce()
    expect(requestModel).toHaveBeenCalledOnce()
    expect(requestModel).toHaveBeenCalledWith([f.savedRefs[0]])
  })

  test('performs no network or storage for commands, non-images, missing capability, or revoked authorization', async () => {
    const f = await fixture()
    await expect(materialize(f, f.envelope('evt-command', [
      { resourceType: 'image', providerRef: 'secret_command' },
    ], 'command'))).resolves.toEqual({ outcome: 'ready', imageAttachments: [] })
    expect(f.read).not.toHaveBeenCalled()
    expect(f.saveImages).not.toHaveBeenCalled()

    const fileOnly = await fixture()
    await expect(materialize(fileOnly, fileOnly.envelope('evt-file', [
      { resourceType: 'file', providerRef: 'secret_file' },
    ]))).resolves.toEqual({ outcome: 'ready', imageAttachments: [] })
    expect(fileOnly.read).not.toHaveBeenCalled()

    const revoked = await fixture({ authorized: () => false })
    await expect(materialize(revoked, revoked.envelope('evt-revoked', [
      { resourceType: 'image', providerRef: 'secret_revoked' },
    ]))).resolves.toEqual({
      outcome: 'not-ready', failureCode: 'image-authorization-revoked', retryable: false,
    })
    expect(revoked.read).not.toHaveBeenCalled()
    expect(revoked.saveImages).not.toHaveBeenCalled()
  })

  test('enforces aggregate bytes even when the adapter violates its requested bound', async () => {
    const oversized = new Uint8Array(40)
    const f = await fixture({ read: vi.fn(async () => ({
      outcome: 'downloaded' as const, data: oversized, mediaType: 'image/png' as const,
    })) })
    const result = await materialize(f, f.envelope('evt-oversized', [
      { resourceType: 'image', providerRef: 'secret_oversized' },
    ]))
    expect(result).toEqual({ outcome: 'not-ready', failureCode: 'image-download-too-large', retryable: false })
    expect(f.saveImages).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('secret_oversized')
  })

  test('fails closed when an adapter violates the downloaded-byte contract', async () => {
    const f = await fixture({ read: vi.fn(async () => ({
      outcome: 'downloaded' as const,
      data: undefined as never,
      mediaType: 'image/png' as const,
    })) })

    await expect(materialize(f, f.envelope('evt-invalid-bytes', [
      { resourceType: 'image', providerRef: 'secret_invalid_bytes' },
    ]))).resolves.toEqual({
      outcome: 'not-ready', failureCode: 'image-download-invalid', retryable: false,
    })
    expect(f.saveImages).not.toHaveBeenCalled()
  })

  test('fails closed when an adapter returns no download result', async () => {
    const f = await fixture({ read: vi.fn(async () => null as never) })

    await expect(materialize(f, f.envelope('evt-null-download', [
      { resourceType: 'image', providerRef: 'secret_null_download' },
    ]))).resolves.toEqual({
      outcome: 'not-ready', failureCode: 'image-download-invalid', retryable: false,
    })
    expect(f.saveImages).not.toHaveBeenCalled()
  })

  test('fails closed when AttachmentStore returns a non-array result', async () => {
    const f = await fixture()
    vi.mocked(f.attachments.saveImages).mockResolvedValueOnce(null as never)

    await expect(materialize(f, f.envelope('evt-null-save-result', [
      { resourceType: 'image', providerRef: 'secret_null_save_result' },
    ]))).resolves.toEqual({
      outcome: 'not-ready', failureCode: 'attachment-store-contract-invalid', retryable: false,
    })
  })

  test('maps provider retry and attachment admission/storage failures without leaking provider refs', async () => {
    const retry = await fixture({ read: vi.fn(async () => ({
      outcome: 'not-downloaded' as const,
      failureCode: 'lark-image-unavailable',
      retryable: true,
      retryAfterMs: 123,
    })) })
    const retryResult = await materialize(retry, retry.envelope('evt-retry', [
      { resourceType: 'image', providerRef: 'secret_retry' },
    ]))
    expect(retryResult).toEqual({ outcome: 'not-ready', failureCode: 'lark-image-unavailable',
      retryable: true, retryAfterMs: 123 })
    expect(JSON.stringify(retryResult)).not.toContain('secret_retry')

    const admission = await fixture()
    vi.mocked(admission.attachments.saveImages).mockRejectedValueOnce(new AttachmentError(
      'invalid image', 'INVALID_IMAGE',
    ))
    await expect(materialize(admission, admission.envelope('evt-invalid', [
      { resourceType: 'image', providerRef: 'secret_invalid' },
    ]))).resolves.toEqual({ outcome: 'not-ready', failureCode: 'image-admission-rejected', retryable: false })

    const storage = await fixture()
    vi.mocked(storage.attachments.saveImages).mockRejectedValueOnce(new AttachmentError(
      'write failed', 'ATTACHMENT_WRITE_FAILED',
    ))
    await expect(materialize(storage, storage.envelope('evt-storage', [
      { resourceType: 'image', providerRef: 'secret_storage' },
    ]))).resolves.toEqual({ outcome: 'not-ready', failureCode: 'image-storage-failed', retryable: true })
  })

  test('rechecks authorization after download and before publishing durable refs', async () => {
    let checks = 0
    const f = await fixture({ authorized: () => ++checks < 3 })
    const input = f.envelope('evt-race', [{ resourceType: 'image', providerRef: 'secret_race' }])
    await expect(materialize(f, input)).resolves.toEqual({
      outcome: 'not-ready', failureCode: 'image-authorization-revoked', retryable: false,
    })
    expect(f.read).toHaveBeenCalledOnce()
    expect(f.saveImages).not.toHaveBeenCalled()
    expect(f.store.listReadyInboundImageRefs(f.store.listInbox({ bindingId: f.binding.id })[0]!.id))
      .toBeUndefined()
  })

  test('stops a batch before the next provider read when authorization is revoked after a download', async () => {
    let authorized = true
    const read = vi.fn(async () => {
      authorized = false
      return {
        outcome: 'downloaded' as const,
        data: png,
        mediaType: 'image/png' as const,
      }
    })
    const f = await fixture({ authorized: () => authorized, read })
    const input = f.envelope('evt-batch-revoked', [
      { resourceType: 'image', providerRef: 'secret_batch_1' },
      { resourceType: 'image', providerRef: 'secret_batch_2' },
    ])

    await expect(materialize(f, input)).resolves.toEqual({
      outcome: 'not-ready', failureCode: 'image-authorization-revoked', retryable: false,
    })
    expect(f.read).toHaveBeenCalledOnce()
    expect(f.read).toHaveBeenCalledWith(expect.objectContaining({
      attachment: expect.objectContaining({ providerRef: 'secret_batch_1' }),
    }), expect.any(AbortSignal))
    expect(f.saveImages).not.toHaveBeenCalled()
    expect(f.store.listReadyInboundImageRefs(f.store.listInbox({ bindingId: f.binding.id })[0]!.id))
      .toBeUndefined()
  })

  test('treats an authorization-check exception before provider I/O as retryable', async () => {
    const f = await fixture({ authorized: () => {
      throw new Error('authorization backend unavailable')
    } })
    const input = f.envelope('evt-auth-check-failed', [
      { resourceType: 'image', providerRef: 'secret_auth_check' },
    ])

    await expect(materialize(f, input)).resolves.toEqual({
      outcome: 'not-ready', failureCode: 'image-authorization-check-failed', retryable: true,
    })
    expect(f.read).not.toHaveBeenCalled()
    expect(f.saveImages).not.toHaveBeenCalled()
  })

  test('stops a batch when the authorization recheck after a download throws', async () => {
    let checks = 0
    const f = await fixture({ authorized: () => {
      checks += 1
      if (checks === 3) throw new Error('authorization backend unavailable')
      return true
    } })
    const input = f.envelope('evt-batch-auth-check-failed', [
      { resourceType: 'image', providerRef: 'secret_auth_check_1' },
      { resourceType: 'image', providerRef: 'secret_auth_check_2' },
    ])

    await expect(materialize(f, input)).resolves.toEqual({
      outcome: 'not-ready', failureCode: 'image-authorization-check-failed', retryable: true,
    })
    expect(f.read).toHaveBeenCalledOnce()
    expect(f.saveImages).not.toHaveBeenCalled()
  })

  test('persists SHA-256 of exact downloaded bytes rather than provider metadata', async () => {
    const f = await fixture()
    await materialize(f, f.envelope('evt-digest', [
      { resourceType: 'image', providerRef: 'secret_digest', mediaType: 'image/jpeg', sizeBytes: png.byteLength },
    ]))
    const attachment = f.store.listAttachments({
      ownerKind: 'inbox', ownerId: f.store.listInbox({ bindingId: f.binding.id })[0]!.id,
    }).find(value => value.resourceType === 'image')
    expect(attachment?.contentSha256).toBe(createHash('sha256').update(png).digest('hex'))
    expect(attachment?.mediaType).toBe('image/png')
    expect(attachment?.sizeBytes).toBe(png.byteLength)
  })
})
