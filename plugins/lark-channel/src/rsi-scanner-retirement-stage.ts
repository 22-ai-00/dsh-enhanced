import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { inspectAutomationRetirementSnapshot, type AutomationRetirementSnapshot } from '@dsh-enhanced/assistant-automations'
import { ActiveLarkOwnerBindingsSnapshotError, inspectActiveLarkOwnerBindingsLocally, inspectRevokedOwnerRouteLocally,
  type RevokedOwnerRouteSnapshot } from '@dsh-enhanced/assistant-delivery'
import { validateMemoryLearningOwner, type MemoryLearningOwner } from '@dsh-enhanced/assistant-growth-contract'
import { deriveScannerRetirementConfiguration, type ScannerRetirementConfiguration, type ScannerRetirementConfigurationInput } from './rsi-scanner-retirement-config.js'
import { applyScannerRetirementMaintenance } from './rsi-scanner-retirement-runtime.js'
import { prepareScannerRetirementOperations, verifyScannerRetirementTransition,
  type ScannerRetirementOperation, type ScannerRetirementTarget, type ScannerRetirementTransitionReceipt } from './rsi-scanner-retirement-transition.js'

export interface ScannerRetirementPlan {
  readonly protocol: 'lark-channel/scanner-retirement-plan/v1'
  readonly dshHome: string
  readonly profile: string
  readonly owner: MemoryLearningOwner
  readonly automationsDatabasePath: string
  readonly effectiveConfigDigest: string
  readonly before: AutomationRetirementSnapshot
  readonly ownerProof: RevokedOwnerRouteSnapshot
  readonly targets: readonly ScannerRetirementTarget[]
  readonly operations: readonly ScannerRetirementOperation[]
  readonly planDigest: string
}
export interface ScannerRetirementCompletion {
  readonly protocol: 'lark-channel/scanner-retirement-completion/v1'
  readonly planDigest: string
  readonly after: AutomationRetirementSnapshot
  readonly transition: ScannerRetirementTransitionReceipt
  readonly completionDigest: string
}
export type ScannerRetirementCapture = Readonly<{ status: 'prepared'; plan: ScannerRetirementPlan }>
  | Readonly<{ status: 'no-op'; reason: 'owner-active' | 'no-targets'; effectiveConfigDigest: string; beforeSnapshotDigest: string; storageDigest: string }>

export class ScannerRetirementStageError extends Error {
  constructor(readonly code: 'invalid-plan' | 'configuration-drift' | 'owner-unavailable' | 'owner-drift' | 'storage-drift' | 'invalid-target' | 'persistence-drift') {
    super(`scanner retirement stage rejected: ${code}`); this.name = 'ScannerRetirementStageError'
  }
}
function fail(code: ScannerRetirementStageError['code']): never { throw new ScannerRetirementStageError(code) }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function sameStage(before: AutomationRetirementSnapshot, current: AutomationRetirementSnapshot): void {
  if (before.database.device !== current.database.device || before.database.inode !== current.database.inode) fail('storage-drift')
}
function selectTargets(before: AutomationRetirementSnapshot, configured: readonly ScannerRetirementTarget[]): readonly ScannerRetirementTarget[] {
  return configured.filter(target => {
    const record = before.records.find(row => row.id === target.automationId)
    const marker = before.retirements.find(row => row.owner === target.owner && row.automationId === target.automationId)
    if (record && record.owner !== target.owner) fail('invalid-target')
    // A formal marker can outlive its definition; neither case creates a row.
    if (marker) return false
    if (!record) return false
    if (!['active', 'paused'].includes(record.status)) fail('invalid-target')
    return true
  })
}
function proveActive(config: ScannerRetirementConfiguration, owner: MemoryLearningOwner): void {
  const authority = config.ownerQuery.authority
  const active = inspectActiveLarkOwnerBindingsLocally({ databasePath: config.ownerQuery.databasePath,
    account: authority.principal.account, tenant: authority.principal.tenant, workspace: authority.workspace, agentPreset: authority.agentPreset })
  const matches = active.bindings.filter(binding => binding.owner.id === owner.principalRecordId
    && binding.owner.version === owner.principalVersion && binding.owner.status === 'active' && binding.owner.role === 'owner'
    && isDeepStrictEqual(binding.owner.principal, authority.principal) && isDeepStrictEqual(binding.principal, authority.principal)
    && isDeepStrictEqual(binding.conversation, authority.conversation) && binding.workspace === authority.workspace
    && binding.agentPreset === authority.agentPreset && binding.policyRef === authority.policyRef
    && binding.generation >= authority.minimumGeneration)
  if (matches.length !== 1) fail('owner-unavailable')
}
function validatePlan(plan: ScannerRetirementPlan): void {
  try {
    if (Object.keys(plan).sort().join(',') !== 'automationsDatabasePath,before,dshHome,effectiveConfigDigest,operations,owner,ownerProof,planDigest,profile,protocol,targets'
      || plan.protocol !== 'lark-channel/scanner-retirement-plan/v1' || !/^[a-f0-9]{64}$/u.test(plan.effectiveConfigDigest)
      || !isAbsolute(plan.automationsDatabasePath) || resolve(plan.automationsDatabasePath) !== plan.automationsDatabasePath
      || plan.targets.length < 1 || plan.targets.length > 4) fail('invalid-plan')
    const { planDigest, ...unsigned } = plan
    if (digest(unsigned) !== planDigest) fail('invalid-plan')
    const owner = validateMemoryLearningOwner(plan.owner), proof = plan.ownerProof
    if (proof.frozenPrincipalVersion !== owner.principalVersion || proof.state.principalRecordId !== owner.principalRecordId
      || proof.state.principalId !== owner.principalId || proof.state.authorityId !== owner.authorityId
      || proof.state.authorityHash !== owner.authorityHash || proof.authority.workspace !== owner.workspace
      || proof.authority.agentPreset !== owner.agentPreset) fail('invalid-plan')
    if (!same(prepareScannerRetirementOperations(plan), plan.operations)) fail('invalid-plan')
  } catch (error) { if (error instanceof ScannerRetirementStageError) throw error; fail('invalid-plan') }
}
function completion(plan: ScannerRetirementPlan, after: AutomationRetirementSnapshot): ScannerRetirementCompletion {
  sameStage(plan.before, after)
  const transition = verifyScannerRetirementTransition({ ...plan, after })
  const unsigned = { protocol: 'lark-channel/scanner-retirement-completion/v1' as const, planDigest: plan.planDigest, after, transition }
  return freeze({ ...unsigned, completionDigest: digest(unsigned) })
}

/** Read-only preparation for a parent-attested, stopped stage. No Store is opened. */
export function captureScannerRetirementPlan(input: ScannerRetirementConfigurationInput & { expectedStorageDigest: string }): ScannerRetirementCapture {
  const { expectedStorageDigest, ...scope } = input
  const config = deriveScannerRetirementConfiguration(scope)
  const before = inspectAutomationRetirementSnapshot(config.automationsDatabasePath)
  if (!/^[a-f0-9]{64}$/u.test(expectedStorageDigest) || before.storageDigest !== expectedStorageDigest) fail('storage-drift')
  const noop = (reason: 'owner-active' | 'no-targets'): ScannerRetirementCapture => freeze({ status: 'no-op', reason,
    effectiveConfigDigest: config.effectiveConfigDigest, beforeSnapshotDigest: before.snapshotDigest, storageDigest: before.storageDigest })
  let ownerProof: RevokedOwnerRouteSnapshot
  try { ownerProof = inspectRevokedOwnerRouteLocally(config.ownerQuery) }
  catch (error) {
    if (!(error instanceof ActiveLarkOwnerBindingsSnapshotError) || error.code !== 'owner-not-revoked') throw error
    proveActive(config, input.owner)
    return noop('owner-active')
  }
  const targets = selectTargets(before, config.targets)
  if (targets.length === 0) return noop('no-targets')
  const operations = prepareScannerRetirementOperations({ before, ownerProof, targets })
  const unsigned = { protocol: 'lark-channel/scanner-retirement-plan/v1' as const, dshHome: input.dshHome, profile: input.profile,
    owner: structuredClone(input.owner), automationsDatabasePath: config.automationsDatabasePath,
    effectiveConfigDigest: config.effectiveConfigDigest, before, ownerProof, targets, operations }
  return freeze({ status: 'prepared', plan: { ...unsigned, planDigest: digest(unsigned) } })
}

/** Uses only the archived tuples; a partial or close failure never renews a key or grant. */
export async function applyScannerRetirementPlan(input: { plan: ScannerRetirementPlan; effectiveConfig: string; signal: AbortSignal }): Promise<ScannerRetirementCompletion> {
  input.signal.throwIfAborted()
  // Own a detached copy across every asynchronous maintenance boundary.
  const plan = freeze(structuredClone(input.plan))
  validatePlan(plan)
  const config = deriveScannerRetirementConfiguration({ effectiveConfig: input.effectiveConfig, dshHome: plan.dshHome, profile: plan.profile, owner: plan.owner })
  if (config.effectiveConfigDigest !== plan.effectiveConfigDigest || config.automationsDatabasePath !== plan.automationsDatabasePath
    || !same(selectTargets(plan.before, config.targets), plan.targets)
    || !same(config.ownerQuery.authority, plan.ownerProof.authority)
    || config.ownerQuery.principalRecordId !== plan.ownerProof.state.principalRecordId
    || config.ownerQuery.frozenPrincipalVersion !== plan.ownerProof.frozenPrincipalVersion) fail('configuration-drift')
  const ownerProof = inspectRevokedOwnerRouteLocally(config.ownerQuery)
  if (ownerProof.snapshotDigest !== plan.ownerProof.snapshotDigest) fail('owner-drift')
  const current = inspectAutomationRetirementSnapshot(plan.automationsDatabasePath)
  sameStage(plan.before, current)
  const completed = plan.targets.filter(target => current.retirements.some(marker => marker.owner === target.owner && marker.automationId === target.automationId))
  if (!same(current, plan.before)) verifyScannerRetirementTransition({ before: plan.before, after: current, ownerProof: plan.ownerProof, targets: completed })
  input.signal.throwIfAborted()
  if (completed.length === plan.targets.length) return completion(plan, current)
  await applyScannerRetirementMaintenance({ policyConfig: config.policyConfig, automationsConfig: config.automationsConfig,
    operations: plan.operations, signal: input.signal })
  input.signal.throwIfAborted()
  return completion(plan, inspectAutomationRetirementSnapshot(plan.automationsDatabasePath))
}

/** Recheck permanent markers after legitimate task/history progress, using the frozen stage path. */
export function verifyScannerRetirementPersistence(input: { plan: ScannerRetirementPlan; completion: ScannerRetirementCompletion }): AutomationRetirementSnapshot {
  const { plan, completion: receipt } = structuredClone(input)
  validatePlan(plan)
  const { completionDigest, ...unsigned } = receipt
  if (Object.keys(receipt).sort().join(',') !== 'after,completionDigest,planDigest,protocol,transition'
    || receipt.protocol !== 'lark-channel/scanner-retirement-completion/v1' || receipt.planDigest !== plan.planDigest
    || digest(unsigned) !== completionDigest || !same(completion(plan, receipt.after), receipt)) fail('invalid-plan')
  const current = inspectAutomationRetirementSnapshot(plan.automationsDatabasePath)
  sameStage(plan.before, current)
  if (current.schemaVersion !== 16) fail('persistence-drift')
  for (const target of plan.targets) {
    const record = receipt.after.records.find(row => row.id === target.automationId)
    const marker = receipt.after.retirements.find(row => row.owner === target.owner && row.automationId === target.automationId)
    if (!record || !marker || !same(record, current.records.find(row => row.id === target.automationId))
      || !same(marker, current.retirements.find(row => row.owner === target.owner && row.automationId === target.automationId))) fail('persistence-drift')
  }
  return current
}
