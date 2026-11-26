import { z } from 'zod'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'

const sessionId = z.string().min(1)
const noticeIds = z.array(z.string().min(1).max(256)).min(1).max(100).readonly()
const noticeAckStatus = z.enum(['delivered', 'read'])
const noticeAckResult = z.object({ acknowledged: z.number().int().min(0).max(100) }).readonly()
const noticeAttachment = z.object({
  kind: z.literal('text'),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  mediaType: z.enum(['text/plain', 'text/markdown']),
  text: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).readonly()
const notice = z.object({
  id: z.string().min(1),
  text: z.string(),
  createdAt: z.number().finite(),
  status: z.enum(['accepted', 'delivered']).optional(),
  attachment: noticeAttachment.optional(),
}).readonly()

/** Strict Host and client descriptor for owner-scoped accepted reminders. */
export const TYPERT = {
  package: '@dsh-ray/assistant-web-owner',
  face: 'host',
  schemas: [],
  invocations: [{
    id: '@dsh-ray/assistant-web-owner#deliveryNotices/list',
    service: 'deliveryNotices',
    namespace: 'deliveryNotices',
    method: 'list',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'sessionId', wire: 'sessionId', source: 'json',
      codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: () => sessionId },
    }],
    result: {
      mode: 'strict',
      typeSymbol: '@dsh-ray/assistant-web-owner#DeliveryNotice[]',
      create: () => z.array(notice).readonly(),
    },
    sourceLocation: { file: 'plugins/assistant-web-owner/src/typert.ts', line: 15, column: 3 },
  }, {
    id: '@dsh-ray/assistant-web-owner#deliveryNotices/ack',
    service: 'deliveryNotices',
    namespace: 'deliveryNotices',
    method: 'ack',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'sessionId', wire: 'sessionId', source: 'json',
      codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: () => sessionId },
    }, {
      name: 'ids', wire: 'ids', source: 'json',
      codec: { mode: 'strict', typeSymbol: '@dsh-ray/assistant-web-owner#NoticeIds', create: () => noticeIds },
    }, {
      name: 'status', wire: 'status', source: 'json',
      codec: { mode: 'strict', typeSymbol: '@dsh-ray/assistant-web-owner#NoticeAckStatus', create: () => noticeAckStatus },
    }],
    result: {
      mode: 'strict',
      typeSymbol: '@dsh-ray/assistant-web-owner#NoticeAckResult',
      create: () => noticeAckResult,
    },
    sourceLocation: { file: 'plugins/assistant-web-owner/src/typert.ts', line: 40, column: 3 },
  }],
  model: { services: [], events: [], objects: [] },
} satisfies TypertContribution

/** The generated client shape is bundled into the Web module by build-client. */
export const TYPERT_REMOTE = {
  package: TYPERT.package,
  descriptors: TYPERT.invocations,
}
