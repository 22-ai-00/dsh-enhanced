import { createHash } from 'node:crypto'
import {
  RECOVERY_RUNBOOK_ID,
  RECOVERY_RUNBOOK_VERSION,
  type RecoveryStepId,
} from './types.js'

export interface RecoveryCatalogStep {
  id: RecoveryStepId
  maximumMutations: number
  authority: 'host-read' | 't1-bounded-write'
  /** Versioned exact-action/receipt contract covered by the catalog digest. */
  actionContract: string
}

/**
 * This order is part of the durable runbook contract. New behaviour requires a
 * new runbook version; production configuration pins the resulting digest.
 */
export const RECOVERY_CATALOG = Object.freeze<readonly RecoveryCatalogStep[]>([
  Object.freeze({
    id: 'authority-admission', maximumMutations: 0, authority: 'host-read',
    actionContract: 'verify-authority/live-owner-route/v2',
  }),
  Object.freeze({
    id: 'ledger-reconcile', maximumMutations: 1, authority: 't1-bounded-write',
    actionContract: 'project-evaluation/exact-id-owner-route/v2',
  }),
  Object.freeze({
    id: 'retention-maintenance', maximumMutations: 1, authority: 't1-bounded-write',
    actionContract: 'maintain-preferences/exact-owner-lineage-generation/v3',
  }),
  Object.freeze({
    id: 't1-effects', maximumMutations: 1, authority: 't1-bounded-write',
    actionContract: 'activate-preference/exact-cas-owner-lineage/v3',
  }),
  Object.freeze({
    id: 'regression-rollback', maximumMutations: 1, authority: 't1-bounded-write',
    actionContract: 'rollback-evolution/exact-cas-owner-route/v2',
  }),
  Object.freeze({
    id: 'incident-review', maximumMutations: 1, authority: 't1-bounded-write',
    actionContract: 'probe-automation-circuit/atomic-production-canary/v2',
  }),
  Object.freeze({
    id: 'verification', maximumMutations: 0, authority: 'host-read',
    actionContract: 'verify-health/live-owner-route-strict/v2',
  }),
])

export const RECOVERY_CATALOG_DIGEST = createHash('sha256').update(JSON.stringify({
  id: RECOVERY_RUNBOOK_ID,
  version: RECOVERY_RUNBOOK_VERSION,
  steps: RECOVERY_CATALOG,
})).digest('hex')

const stepIndexes = new Map(RECOVERY_CATALOG.map((step, index) => [step.id, index]))

export function recoveryStepIndex(stepId: RecoveryStepId): number {
  const index = stepIndexes.get(stepId)
  if (index === undefined) throw new Error(`assistant-recovery: unknown catalog step: ${stepId}`)
  return index
}
