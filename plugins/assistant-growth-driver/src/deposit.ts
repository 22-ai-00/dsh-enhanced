import { createHash } from 'node:crypto'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { GoalScope, OwnerGoalExecutionSnapshotInput } from '@dsh-enhanced/assistant-goals'
import type { CommitOwnerAnchoredWorkflowTraceServiceResult } from '@dsh-enhanced/assistant-delivery'
import type { GrowthOwnerScopeConfig } from './config.js'

/**
 * A growth authority is the Host-side analogue of RepairExecutionAuthority,
 * but it is NOT backed by any durable repair continuation: the driver mints it
 * from the frozen configured owner scope for exactly one bounded wake.  It can
 * draft a pending skill candidate and nothing else.
 */
export interface GrowthAuthority {
  readonly id: string
  readonly scope: GoalScope
  readonly ownerRouteId: string
  readonly expiresAt: number
  assertCurrent(): void
}

export interface OwnerRouteReceipt {
  readonly receiptVersion: 2
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

export interface GrowthDeliveryPort {
  validateOwnerRoute(input: {
    authorityId: string
    principalId: string
    workspace: string
    agentPreset: string
  }): Readonly<OwnerRouteReceipt>
  /**
   * Host-only owner-anchored learning seam. The driver passes only a locator
   * and the bounded-wake authority; Delivery re-fetches the verified Goals
   * source and run proof itself and never accepts a caller-supplied prompt.
   */
  commitOwnerAnchoredWorkflowTrace(input: Readonly<{
    locator: OwnerGoalExecutionSnapshotInput
    authority: GrowthAuthority
  }>): Promise<Readonly<CommitOwnerAnchoredWorkflowTraceServiceResult>>
}

/**
 * Re-anchor the configured owner scope against the live authenticated Delivery
 * owner route and mint one short-lived growth authority.  Never derives an
 * owner from model-controlled values: the route id, principal, workspace and
 * preset all come from frozen plugin configuration.
 */
export function mintGrowthAuthority(delivery: GrowthDeliveryPort, config: GrowthOwnerScopeConfig, expiresAt: number): GrowthAuthority {
  const anchor = delivery.validateOwnerRoute({
    authorityId: config.ownerRouteId,
    principalId: config.principalId,
    workspace: config.workspace,
    agentPreset: config.preset,
  })
  if (anchor.principalId !== config.principalId || anchor.workspace !== config.workspace
    || anchor.agentPreset !== config.preset || anchor.authorityId !== config.ownerRouteId) {
    throw new Error('assistant-growth-driver: owner route receipt does not match the configured scope')
  }
  const scope: GoalScope = Object.freeze({
    principalId: config.principalId,
    principalRecordId: anchor.principalRecordId,
    principalVersion: anchor.principalVersion,
    workspace: config.workspace,
    preset: config.preset,
  })
  const anchorDigest = acceptanceDigest(anchor)
  const id = `growth-${createHash('sha256')
    .update(acceptanceDigest({ scope, ownerRouteId: config.ownerRouteId, expiresAt, anchorDigest }))
    .digest('hex')
    .slice(0, 40)}`
  return Object.freeze({
    id,
    scope,
    ownerRouteId: config.ownerRouteId,
    expiresAt,
    assertCurrent() {
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
        throw new Error('assistant-growth-driver: growth authority expired')
      }
      // Re-read the owner route on every use: a revoked/rebound delivery route
      // or a principal generation change invalidates the whole wake.
      const current = delivery.validateOwnerRoute({
        authorityId: config.ownerRouteId,
        principalId: config.principalId,
        workspace: config.workspace,
        agentPreset: config.preset,
      })
      if (acceptanceDigest(current) !== anchorDigest) {
        throw new Error('assistant-growth-driver: owner route changed during growth wake')
      }
    },
  })
}
