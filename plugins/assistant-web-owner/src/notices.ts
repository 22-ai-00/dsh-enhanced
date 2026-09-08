import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { DeliveryNotice, NativeWebOwnerAccess } from './index.js'

/** Strict Gateway-visible façade over the fixed owner access capability. */
export class DeliveryNoticesService extends TypertRemoteService {
  constructor(ctx: Context, private readonly access: NativeWebOwnerAccess) {
    super(ctx, 'deliveryNotices')
  }

  list(sessionId: SessionId): readonly DeliveryNotice[] {
    return this.access.notifications(sessionId)
  }
}
