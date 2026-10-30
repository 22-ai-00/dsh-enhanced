import { createHash } from 'node:crypto'
import type { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import type { AssistantDeliveryService, OwnerRouteValidationReceipt } from '@dsh-enhanced/assistant-delivery'

type Automations = Pick<AssistantAutomationsService, 'inspectSystemOwnedRetirement' | 'retireSystemOwned' | 'inspectSystemOwned'>
type Delivery = Pick<AssistantDeliveryService, 'inspectOwnerRouteState'>
type Scope = { authorityId: string; principalId: string; workspace: string; agentPreset: string }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Availability failures must never be interpreted as obsolete task evidence. */
export class ScannerOwnerUnavailable extends Error {}

/** Retires only this scanner, preserving its jobs, requests, grants and budgets. */
export class ScannerOwnerGuard {
  retired = false
  // Only the native reconcile transaction may admit a wake-up under an unreadable retirement state.
  canReconcileScanner = false
  constructor(private readonly owner: string, private readonly automationId: string,
    private readonly scope: Scope, private readonly delivery: Delivery, private readonly automations: Automations,
    private readonly expected?: { authorityHash: string; principalRecordId: string; principalVersion: number }) {}

  check(): OwnerRouteValidationReceipt {
    this.canReconcileScanner = false
    try {
      if (this.retired) throw new ScannerOwnerUnavailable('scanner permanently retired: owner-revoked')
      let retirement: ReturnType<Automations['inspectSystemOwnedRetirement']>
      try { retirement = this.automations.inspectSystemOwnedRetirement({ owner: this.owner, automationId: this.automationId }) }
      catch (error) {
        // A read outage must not strand a fresh scanner. Native reconcile checks
        // retirement before cached receipts and again in its SQLite transaction.
        // It can establish only this exact scanId, without touching old jobs.
        this.canReconcileScanner = true
        try {
          if (this.delivery.inspectOwnerRouteState(this.scope).status === 'revoked') this.canReconcileScanner = false
        } catch { /* The native retirement fence still owns activation admission. */ }
        throw error
      }
      if (retirement) {
        this.retired = true
        throw new ScannerOwnerUnavailable('scanner permanently retired: owner-revoked')
      }
      this.canReconcileScanner = true
      const state = this.delivery.inspectOwnerRouteState(this.scope)
      if (state.status === 'unavailable') throw new ScannerOwnerUnavailable(`scanner owner unavailable: ${state.reason}`)
      if (state.status === 'active') return state.receipt
      this.canReconcileScanner = false
      // Delivery increments the same principal record when revoking/reactivating it.
      // Revoked is authoritative at the frozen version or later; older lineage
      // must never retire a scanner authorized by a newer grant.
      if (this.expected && (state.authorityHash !== this.expected.authorityHash
        || state.principalRecordId !== this.expected.principalRecordId || state.principalVersion < this.expected.principalVersion)) {
        throw new ScannerOwnerUnavailable('scanner owner lineage unavailable')
      }
      let current: ReturnType<Automations['inspectSystemOwned']> | undefined
      try { current = this.automations.inspectSystemOwned({ owner: this.owner, automationId: this.automationId }) }
      catch (error) {
        if (!(error instanceof Error) || (error as Error & { code?: string }).code !== 'not-found') throw error
      }
      if (current) {
        const evidenceDigest = digest({ protocol: 'scanner-owner-revoked/v1', scope: this.scope, state })
        this.automations.retireSystemOwned({ owner: this.owner, automationId: this.automationId,
          operationId: `owner-revoked:${digest([this.owner, this.automationId, current.definitionHash, current.definitionVersion, evidenceDigest])}`,
          definitionHash: current.definitionHash, expectedVersion: current.definitionVersion, reason: 'owner-revoked', evidenceDigest })
      }
      // An absent definition must stay absent; no replacement grant or row is created.
      this.retired = true
      throw new ScannerOwnerUnavailable('scanner owner explicitly revoked')
    } catch (error) {
      if (error instanceof ScannerOwnerUnavailable) throw error
      throw new ScannerOwnerUnavailable(`scanner owner inspection or retirement unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
