import { z } from 'zod'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'

const sessionId = z.string().min(1)
const notice = z.object({
  id: z.string().min(1),
  text: z.string(),
  createdAt: z.number().finite(),
}).readonly()

/** Strict Host and client descriptor for owner-scoped accepted reminders. */
export const TYPERT = {
  package: '@dsh-enhanced/assistant-web-owner',
  face: 'host',
  schemas: [],
  invocations: [{
    id: '@dsh-enhanced/assistant-web-owner#deliveryNotices/list',
    service: 'deliveryNotices',
    namespace: 'deliveryNotices',
    method: 'list',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'sessionId', wire: 'sessionId', source: 'json',
      codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', schema: sessionId },
    }],
    result: {
      mode: 'strict',
      typeSymbol: '@dsh-enhanced/assistant-web-owner#DeliveryNotice[]',
      schema: z.array(notice).readonly(),
    },
    sourceLocation: { file: 'plugins/assistant-web-owner/src/typert.ts', line: 15, column: 3 },
  }],
  model: { services: [], events: [], objects: [] },
} satisfies TypertContribution

/** The generated client shape is bundled into the Web module by build-client. */
export const TYPERT_REMOTE = {
  package: TYPERT.package,
  descriptors: TYPERT.invocations,
}
