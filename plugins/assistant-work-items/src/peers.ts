/**
 * Structural peer contracts.
 *
 * Every dependency of this plugin is an optional peer service that the Loader
 * may mount independently, so the shapes are declared structurally here rather
 * than imported from sibling packages at build time. A missing service is a
 * bounded `missing-dependency` failure, never a crash.
 */

export type PeerPolicyEffect = 'allow' | 'deny'
export type PeerPolicyInitiator = 'background' | 'external' | 'foreground'
export type PeerPolicySubjectKind = 'agent' | 'background' | 'external'

export interface PeerPolicyRequest {
  readonly subject: Readonly<{ kind: PeerPolicySubjectKind; id: string; workspace?: string; principal?: string }>
  readonly action: string
  readonly resource: Readonly<{ kind: string; id: string }>
  readonly context: Readonly<{ initiator: PeerPolicyInitiator }>
}

export interface PeerPolicyDecision {
  readonly effect: PeerPolicyEffect
  readonly reasonCode: string
  readonly ruleId?: string | undefined
}

/** `assistant-policy` default-deny authorization surface. */
export interface PeerPolicyService {
  authorize(request: PeerPolicyRequest, options?: { idempotencyKey?: string; auditDetails?: unknown }): PeerPolicyDecision
}

/** `assistant-delivery` owner-route receipt (receiptVersion 2). */
export interface PeerOwnerRouteReceipt {
  readonly receiptVersion: number
  readonly authorityId: string
  readonly authorityHash: string
  readonly principalId: string
  readonly principalRecordId: string
  readonly principalVersion: number
  readonly workspace: string
  readonly agentPreset: string
  readonly bindingVersion: number
  readonly generation: number
}

export interface PeerOwnerRouteInspection {
  readonly status: 'active' | 'revoked' | 'unavailable'
  readonly receipt?: PeerOwnerRouteReceipt
  readonly reason?: string
}

/** `assistant-delivery` surfaces used by this plugin. */
export interface PeerDeliveryService {
  validateOwnerRoute(input: {
    authorityId: string
    principalId: string
    workspace: string
    agentPreset: string
  }): Readonly<PeerOwnerRouteReceipt>
  inspectOwnerRouteState?(input: {
    authorityId: string
    principalId: string
    workspace: string
    agentPreset: string
  }): PeerOwnerRouteInspection
  enqueueBackground(input: {
    sourceId: string
    workspace: string
    bindingId: string
    idempotencyKey: string
    text: string
    format?: 'markdown' | 'plain'
    metadata?: Readonly<Record<string, string>>
  }): { readonly id: string } | Promise<{ readonly id: string }>
}

/** `assistant-automations` external-event intake. */
export interface PeerAutomationsService {
  ingestExternal(input: {
    sourceId: string
    automationId: string
    eventId: string
    occurredAt: number
    envelope?: unknown
  }): { readonly id: string; readonly automationId: string }
}
