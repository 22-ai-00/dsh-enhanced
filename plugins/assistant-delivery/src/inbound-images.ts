import { createHash } from 'node:crypto'
import {
  isImageAdmissionError,
  type AttachmentStore,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
  type ImageMediaType,
  type SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { DeliveryAdapterRegistry } from './coordinator.js'
import { DeliveryStoreError, type DeliveryStore } from './store.js'
import type { ConversationBinding, InboundAttachmentDescriptor, InboundEnvelope } from './types.js'

export type InboundImageMaterializeResult =
  | { outcome: 'ready'; imageAttachments: readonly ImageAttachmentRef[] }
  | { outcome: 'not-ready'; failureCode: string; retryable: boolean; retryAfterMs?: number }

export interface InboundImageMaterializeInput {
  inboxId: string
  ownerId: string
  fencingToken: number
  binding: Readonly<ConversationBinding>
  envelope: Readonly<InboundEnvelope>
  signal: AbortSignal
}

interface InboundImageMaterializerOptions {
  store: DeliveryStore
  registry: DeliveryAdapterRegistry
  getAttachments(): AttachmentStore | undefined
  isAuthorized(binding: Readonly<ConversationBinding>, envelope: Readonly<InboundEnvelope>): boolean
}

function abortIfNeeded(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason ?? new Error('assistant-delivery image preparation was cancelled')
}

function currentAuthorizationFailure(
  options: InboundImageMaterializerOptions,
  binding: Readonly<ConversationBinding>,
  envelope: Readonly<InboundEnvelope>,
): InboundImageMaterializeResult | undefined {
  try {
    return options.isAuthorized(binding, envelope)
      ? undefined
      : failure('image-authorization-revoked', false)
  } catch {
    return failure('image-authorization-check-failed', true)
  }
}

function failure(
  failureCode: string,
  retryable: boolean,
  retryAfterMs?: number,
): InboundImageMaterializeResult {
  return {
    outcome: 'not-ready',
    failureCode,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  }
}

function safeFailureCode(value: string): string {
  return /^[a-z][a-z0-9-]{0,63}$/u.test(value) ? value : 'image-download-failed'
}

function validPositiveLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function supportedMediaType(value: unknown, supported: readonly ImageMediaType[]): value is ImageMediaType {
  return typeof value === 'string' && supported.includes(value as ImageMediaType)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validImageRefShape(
  ref: ImageAttachmentRef,
  limits: Readonly<ImageAttachmentLimits>,
): boolean {
  return ref !== null
    && typeof ref === 'object'
    && !Array.isArray(ref)
    && Object.keys(ref).every(key => [
      'attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name', 'originalDimensions',
    ].includes(key))
    && typeof ref.attachmentId === 'string'
    && ref.attachmentId.length >= 1
    && ref.attachmentId.length <= 512
    && !/\p{Cc}/u.test(ref.attachmentId)
    && supportedMediaType(ref.mediaType, limits.mediaTypes)
    && Number.isSafeInteger(ref.bytes)
    && ref.bytes >= 1
    && ref.bytes <= limits.maxImageBytes
    && Number.isSafeInteger(ref.width)
    && ref.width > 0
    && ref.width <= limits.maxImageDimension
    && Number.isSafeInteger(ref.height)
    && ref.height > 0
    && ref.height <= limits.maxImageDimension
    && ref.width * ref.height <= limits.maxImagePixels
    && (ref.originalDimensions === undefined
      || (isRecord(ref.originalDimensions)
        && Object.keys(ref.originalDimensions).every(key => key === 'width' || key === 'height')
        && Number.isSafeInteger(ref.originalDimensions.width)
        && ref.originalDimensions.width > 0
        && Number.isSafeInteger(ref.originalDimensions.height)
        && ref.originalDimensions.height > 0))
    && (ref.name === undefined || (typeof ref.name === 'string'
      && ref.name.length >= 1
      && ref.name.length <= 255
      && ref.name !== '.'
      && ref.name !== '..'
      && !/[\\/\p{Cc}]/u.test(ref.name)))
}

function validReadyBatch(
  refs: readonly ImageAttachmentRef[],
  descriptorCount: number,
  limits: Readonly<ImageAttachmentLimits>,
): boolean {
  if (refs.length !== descriptorCount || refs.length > limits.maxImagesPerMessage) return false
  let totalBytes = 0
  for (const ref of refs) {
    if (!validImageRefShape(ref, limits)) return false
    totalBytes += ref.bytes
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxMessageImageBytes) return false
  }
  return true
}

function safeRetryAfterMs(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && value! >= 1 && value! <= 86_400_000 ? value : undefined
}

function declaredBatchFits(
  descriptors: readonly InboundAttachmentDescriptor[],
  maxImageBytes: number,
  maxMessageImageBytes: number,
): boolean {
  let knownTotal = 0
  for (const descriptor of descriptors) {
    if (descriptor.sizeBytes === undefined) continue
    if (!Number.isSafeInteger(descriptor.sizeBytes) || descriptor.sizeBytes < 0) return false
    if (descriptor.sizeBytes === 0) continue
    if (descriptor.sizeBytes > maxImageBytes) return false
    knownTotal += descriptor.sizeBytes
    if (!Number.isSafeInteger(knownTotal) || knownTotal > maxMessageImageBytes) return false
  }
  return true
}

/**
 * Materializes authorized provider image resources before the Agent dispatch marker.
 * Provider bytes terminate at AttachmentStore; the returned value contains durable refs only.
 */
export class InboundImageMaterializer {
  constructor(private readonly options: InboundImageMaterializerOptions) {}

  async materialize(input: Readonly<InboundImageMaterializeInput>): Promise<InboundImageMaterializeResult> {
    abortIfNeeded(input.signal)
    if (input.envelope.kind === 'command') return { outcome: 'ready', imageAttachments: [] }
    const descriptors = (input.envelope.attachments ?? [])
      .filter(attachment => attachment.resourceType === 'image')
    if (descriptors.length === 0) return { outcome: 'ready', imageAttachments: [] }
    const initialAuthorizationFailure = currentAuthorizationFailure(
      this.options, input.binding, input.envelope,
    )
    if (initialAuthorizationFailure !== undefined) return initialAuthorizationFailure

    const attachments = this.options.getAttachments()
    if (attachments === undefined) return failure('attachment-store-unavailable', true)
    const limits = attachments.imageLimits
    if (!validPositiveLimit(limits.maxImageBytes)
      || !validPositiveLimit(limits.maxImagesPerMessage)
      || !validPositiveLimit(limits.maxMessageImageBytes)
      || descriptors.length > limits.maxImagesPerMessage
      || !declaredBatchFits(descriptors, limits.maxImageBytes, limits.maxMessageImageBytes)) {
      return failure('image-admission-rejected', false)
    }

    let ready: readonly ImageAttachmentRef[] | undefined
    try {
      ready = this.options.store.listReadyInboundImageRefs(input.inboxId)
    } catch (error) {
      if (error instanceof DeliveryStoreError && error.code === 'stale-fence') throw error
      return failure('image-state-invalid', false)
    }
    if (ready !== undefined) {
      if (!validReadyBatch(ready, descriptors.length, limits)) return failure('image-state-invalid', false)
      return { outcome: 'ready', imageAttachments: ready }
    }

    const adapter = this.options.registry.get(input.envelope.channel, input.envelope.account)
    if (adapter === undefined) return failure('image-adapter-unavailable', true)
    if (adapter.capabilities.inboundImages !== true || adapter.readInboundImage === undefined) {
      return failure('image-download-unsupported', false)
    }

    const saveInputs: SaveImageAttachment[] = []
    let totalBytes = 0
    for (const descriptor of descriptors) {
      abortIfNeeded(input.signal)
      const remaining = limits.maxMessageImageBytes - totalBytes
      if (remaining <= 0) return failure('image-download-too-large', false)
      const maxBytes = Math.min(limits.maxImageBytes, remaining)
      const beforeDownloadAuthorizationFailure = currentAuthorizationFailure(
        this.options, input.binding, input.envelope,
      )
      if (beforeDownloadAuthorizationFailure !== undefined) return beforeDownloadAuthorizationFailure
      let downloaded: unknown
      try {
        downloaded = await adapter.readInboundImage({
          eventId: input.envelope.eventId,
          attachment: descriptor,
          maxBytes,
        }, input.signal)
      } catch {
        abortIfNeeded(input.signal)
        const failedDownloadAuthorizationFailure = currentAuthorizationFailure(
          this.options, input.binding, input.envelope,
        )
        if (failedDownloadAuthorizationFailure !== undefined) return failedDownloadAuthorizationFailure
        return failure('image-download-failed', true)
      }
      abortIfNeeded(input.signal)
      const afterDownloadAuthorizationFailure = currentAuthorizationFailure(
        this.options, input.binding, input.envelope,
      )
      if (afterDownloadAuthorizationFailure !== undefined) return afterDownloadAuthorizationFailure
      if (!isRecord(downloaded)) return failure('image-download-invalid', false)
      if (downloaded.outcome === 'not-downloaded') {
        if (typeof downloaded.failureCode !== 'string'
          || typeof downloaded.retryable !== 'boolean'
          || (downloaded.retryAfterMs !== undefined
            && safeRetryAfterMs(downloaded.retryAfterMs as number) === undefined)) {
          return failure('image-download-invalid', false)
        }
        return failure(
          safeFailureCode(downloaded.failureCode),
          downloaded.retryable,
          safeRetryAfterMs(downloaded.retryAfterMs as number | undefined),
        )
      }
      if (downloaded.outcome !== 'downloaded'
        || !(downloaded.data instanceof Uint8Array)
        || downloaded.data.byteLength < 1
        || !supportedMediaType(downloaded.mediaType, limits.mediaTypes)) {
        return failure('image-download-invalid', false)
      }
      if (downloaded.data.byteLength > maxBytes) {
        return failure('image-download-too-large', false)
      }
      totalBytes += downloaded.data.byteLength
      if (totalBytes > limits.maxMessageImageBytes) return failure('image-download-too-large', false)
      const name = descriptor.fileName
      saveInputs.push({
        data: downloaded.data,
        mediaType: downloaded.mediaType,
        ...(name === undefined ? {} : { name }),
      })
    }

    abortIfNeeded(input.signal)
    const beforeSaveAuthorizationFailure = currentAuthorizationFailure(
      this.options, input.binding, input.envelope,
    )
    if (beforeSaveAuthorizationFailure !== undefined) return beforeSaveAuthorizationFailure
    let refs: unknown
    try {
      refs = await attachments.saveImages(saveInputs)
    } catch (error) {
      abortIfNeeded(input.signal)
      return isImageAdmissionError(error)
        ? failure('image-admission-rejected', false)
        : failure('image-storage-failed', true)
    }
    abortIfNeeded(input.signal)
    if (!Array.isArray(refs) || !validReadyBatch(refs, saveInputs.length, limits)) {
      return failure('attachment-store-contract-invalid', false)
    }
    const afterSaveAuthorizationFailure = currentAuthorizationFailure(
      this.options, input.binding, input.envelope,
    )
    if (afterSaveAuthorizationFailure !== undefined) return afterSaveAuthorizationFailure

    let committed: readonly ImageAttachmentRef[]
    try {
      committed = this.options.store.commitInboundImageRefs({
        inboxId: input.inboxId,
        ownerId: input.ownerId,
        fencingToken: input.fencingToken,
        images: refs.map((ref, index) => ({
          ref,
          contentSha256: createHash('sha256').update(saveInputs[index]!.data).digest('hex'),
        })),
      })
    } catch (error) {
      if (error instanceof DeliveryStoreError && error.code === 'stale-fence') throw error
      if (error instanceof DeliveryStoreError && error.code === 'unauthorized-principal') {
        return failure('image-authorization-revoked', false)
      }
      return error instanceof DeliveryStoreError
        ? failure('image-state-invalid', false)
        : failure('image-state-commit-failed', true)
    }
    abortIfNeeded(input.signal)
    const publishedAuthorizationFailure = currentAuthorizationFailure(
      this.options, input.binding, input.envelope,
    )
    if (publishedAuthorizationFailure !== undefined) return publishedAuthorizationFailure
    return { outcome: 'ready', imageAttachments: committed }
  }
}
