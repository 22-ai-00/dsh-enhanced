import type { ConversationBinding, ConversationRef, ExternalPrincipalKey } from './types.js'

export type SessionLeaseTarget =
  | { kind: 'bound'; binding: Readonly<ConversationBinding> }
  | {
    kind: 'construction'
    sessionId: string
    conversation: ConversationRef
    principal: ExternalPrincipalKey
    workspace: string
    agentPreset: string
    generation: number
    previous?: Readonly<ConversationBinding>
  }

export interface SessionLease {
  sessionId: string
  holderId: string
  fencingToken: number
  leaseUntil: number
}

export type SessionLeaseClaim =
  | { kind: 'claimed'; lease: SessionLease }
  | { kind: 'busy' | 'unknown' | 'denied' }
