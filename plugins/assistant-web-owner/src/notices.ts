import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { DeliveryNotice, DeliveryNoticeAckStatus, NativeWebOwnerAccess } from './index.js'

/** Strict Gateway-visible façade over the fixed owner access capability. */
export class DeliveryNoticesService extends TypertRemoteService {
  constructor(ctx: Context, private readonly access: NativeWebOwnerAccess) {
    super(ctx, 'deliveryNotices')
  }

  list(sessionId: SessionId): readonly DeliveryNotice[] {
    return this.access.notifications(sessionId)
  }

  /** Owner-scoped acknowledgement; Host revalidates binding and native-notice provenance. */
  ack(sessionId: SessionId, ids: readonly string[], status: DeliveryNoticeAckStatus): Readonly<{ acknowledged: number }> {
    return this.access.acknowledgeNotices(sessionId, ids, status)
  }
}
