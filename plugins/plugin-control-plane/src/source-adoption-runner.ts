/** Host-owned continuation from a completed source release into normal activation. */
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Ed25519ApprovalAuthority, parseApprovalReceipt } from './approval.js'
import { discover, loadCatalogWithMetadata } from './catalog.js'
import { activatePluginPlan, probePluginPlan } from './cli.js'
import { requestSourceAuthorityReceipt, validateSourceApprovalClientConfig, type SourceApprovalClientConfig } from './source-approval-client.js'
import { controlPlaneDigest, type ControlPlaneStore } from './store.js'
import { resolveTrustKey, type PluginControlTrustConfig } from './trust.js'
import type { PluginActivationPlan } from './types.js'

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const AWAITING = new Set<PluginActivationPlan['status']>(['awaiting-reload', 'awaiting-readiness', 'awaiting-effect-blocked-replay', 'awaiting-shadow', 'awaiting-canary', 'awaiting-soak', 'awaiting-health'])

export interface SourceAdoptionConfig {
  profile: string
  planTtlMs: number
  timeoutMs: number
  authority: SourceApprovalClientConfig
}

export function validateSourceAdoptionConfig(value: unknown): asserts value is SourceAdoptionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('plugin-control-plane: invalid source adoption config')
  const item = value as Record<string, unknown>
  if (Object.keys(item).sort().join('\0') !== ['authority', 'planTtlMs', 'profile', 'timeoutMs'].join('\0')
    || typeof item.profile !== 'string' || item.profile.normalize('NFC').trim() !== item.profile || !PROFILE.test(item.profile)
    || !Number.isSafeInteger(item.planTtlMs) || Number(item.planTtlMs) < 60_000 || Number(item.planTtlMs) > 86_400_000
    || !Number.isSafeInteger(item.timeoutMs) || Number(item.timeoutMs) < 1_000 || Number(item.timeoutMs) > 3_600_000) {
    throw new Error('plugin-control-plane: invalid source adoption config')
  }
  validateSourceApprovalClientConfig(item.authority)
}

function same(left: unknown, right: unknown): boolean { return controlPlaneDigest(left) === controlPlaneDigest(right) }

async function canonicalTarget(trust: PluginControlTrustConfig, profile: string): Promise<PluginActivationPlan['target']> {
  const profiles = join(trust.dshHome, 'profiles')
  if (await realpath(profiles) !== resolve(profiles)) throw new Error('plugin-control-plane: profiles directory is not canonical')
  const profilePath = join(profiles, profile)
  try {
    const metadata = await lstat(profilePath)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(profilePath) !== resolve(profilePath)) throw new Error('plugin-control-plane: target profile is not canonical')
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error
    if (await realpath(dirname(profilePath)) !== resolve(dirname(profilePath)) || basename(profilePath) !== profile) throw new Error('plugin-control-plane: target profile parent is not canonical')
  }
  return Object.freeze({ dshHome: trust.dshHome, profile, profilePath })
}

function assertPlanBinding(plan: PluginActivationPlan, sourcePlanId: string, trust: PluginControlTrustConfig, target: PluginActivationPlan['target'], catalog: { digest: string }, candidate: PluginActivationPlan['candidate']): void {
  if (plan.profile !== target.profile || plan.installationId !== trust.installationId || !same(plan.target, target)
    || !same(plan.ledger, trust.ledger) || !same(plan.executor, { id: trust.executor.id, version: trust.executor.version, path: trust.executor.path, sha256: trust.executor.sha256 })
    || plan.dossier.catalogDigest !== catalog.digest || plan.dossier.catalogProvenance !== 'owner-provided-integrity-pinned' || !same(plan.candidate, candidate)) {
    throw new Error(`plugin-control-plane: source adoption ${sourcePlanId} binding no longer matches current owner trust`)
  }
}

/** Immutable fields sufficient for the shared engine to restore an exposed plan. */
function recoveryBinding(plan: PluginActivationPlan, trust: PluginControlTrustConfig, profile: string): boolean {
  return plan.profile === profile && plan.installationId === trust.installationId && plan.target.dshHome === trust.dshHome
    && plan.target.profile === profile && plan.target.profilePath === join(trust.dshHome, 'profiles', profile)
    && same(plan.ledger, trust.ledger)
    && same(plan.executor, { id: trust.executor.id, version: trust.executor.version, path: trust.executor.path, sha256: trust.executor.sha256 })
}

function authority(trust: PluginControlTrustConfig, receipt: ReturnType<typeof parseApprovalReceipt>): Ed25519ApprovalAuthority {
  const key = resolveTrustKey(trust, 'approval', receipt.authority, receipt.keyId)
  return new Ed25519ApprovalAuthority(key.publicKeyPem, key.authority, key.keyId)
}

function terminal(plan: PluginActivationPlan): boolean { return plan.status === 'activated' || plan.status === 'rolled-back' }

async function recoverAwaiting(store: ControlPlaneStore, trust: PluginControlTrustConfig, plan: PluginActivationPlan, timeoutMs: number): Promise<void> {
  const recoverySignal = AbortSignal.timeout(timeoutMs)
  let rollback = plan
  if (plan.status !== 'rollback-pending') {
    if ((!AWAITING.has(plan.status) && plan.status !== 'staging' && plan.status !== 'commit-pending') || plan.activation === undefined) return
    // The Store rejects a live lease. Expired staging/commit work can instead
    // be converted to the same durable rollback path as an awaiting failure.
    rollback = store.requestActivationRollback({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation.fence, failureCode: 'source-adoption-interrupted' })
  }
  const restored = await activatePluginPlan({ store, trust, planId: rollback.id, expectedRevision: rollback.revision, signal: recoverySignal })
  if (restored.status === 'rollback-pending' && restored.activation?.rollbackProfileRestored) {
    await probePluginPlan({ store, trust, planId: restored.id, expectedRevision: restored.revision, expectedFence: restored.activation.fence, signal: recoverySignal })
  }
}

/**
 * Create or recover the exact source-linked plan, obtain one finite approval,
 * then delegate all deployment and rollback mechanics to the shared engine.
 */
export async function adoptSourceRelease(options: {
  store: ControlPlaneStore
  sourcePlanId: string
  trust: PluginControlTrustConfig
  config: SourceAdoptionConfig
  signal?: AbortSignal
  assertCurrent: () => Promise<void>
  withSourceFence: <T>(callback: () => T) => T
}): Promise<PluginActivationPlan> {
  // Locate a durable link before checking current job authority: a withdrawn
  // job may still have exposed a profile that needs the engine's recovery.
  let created = options.store.findSourceAdoption(options.sourcePlanId)
  let trustBound = created !== undefined && recoveryBinding(created, options.trust, options.config.profile)
  try {
    validateSourceAdoptionConfig(options.config)
    const deadline = AbortSignal.timeout(options.config.timeoutMs)
    const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])
    const source = options.store.getSourcePlan(options.sourcePlanId)
    if (source.status !== 'release-complete' || source.mode !== 'modify') throw new Error('plugin-control-plane: source adoption requires a release-complete owner modify plan')
    const released = options.store.sourceReleaseCandidate(source.id)
    const catalog = await loadCatalogWithMetadata(options.trust.catalog.path)
    const admitted = catalog.catalog.entries.find(entry => entry.id === released.id)
    // Owner-failure source plans retain the generic repair gap rather than
    // pretending that it is a candidate capability. Their durable Store link
    // already binds this exact released entry; ordinary gaps still require
    // catalog capability applicability.
    if (admitted === undefined || !same(admitted, released)
      || (source.gapSnapshot.capability !== 'foreground-task-repair' && !discover(catalog.catalog, source.gapSnapshot.capability).some(entry => entry.id === released.id))) {
      throw new Error('plugin-control-plane: source release is not the exact applicable current catalog entry')
    }
    const target = await canonicalTarget(options.trust, options.config.profile)
    let plan = created
    // A job can expire while catalog and filesystem checks await. Never make
    // its durable activation claim until the Host has revalidated it.
    await options.assertCurrent(); signal.throwIfAborted()
    if (plan === undefined) {
      plan = options.withSourceFence(() => options.store.createPlan({ candidate: admitted, catalog: { digest: catalog.digest, provenance: catalog.provenance }, matchedCapabilities: admitted.capabilities,
        profile: options.config.profile, target, installationId: options.trust.installationId, ledger: options.trust.ledger,
        executor: { id: options.trust.executor.id, version: options.trust.executor.version, path: options.trust.executor.path, sha256: options.trust.executor.sha256 },
        ttlMs: options.config.planTtlMs, gapId: source.gapId, sourcePlanId: source.id, idempotencyKey: `source-adoption:${source.id}` }).result)
    }
    assertPlanBinding(plan, source.id, options.trust, target, catalog, admitted); created = plan; trustBound = true
    let requestedApproval = false
    for (let step = 0; step < 32; step++) {
      await options.assertCurrent(); signal.throwIfAborted()
      const current = options.store.getPlan(plan.id); assertPlanBinding(current, source.id, options.trust, target, catalog, admitted)
      if (terminal(current)) return current
      const before = { status: current.status, revision: current.revision, fence: current.activation?.fence }
      if (current.status === 'pending-approval') {
        if (requestedApproval) return current
        requestedApproval = true
        const sourceReference = options.store.getOwnerTaskFailureReference(current.gapId)
        if (sourceReference === undefined) throw new Error('plugin-control-plane: source adoption owner reference is absent')
        const request = { protocol: 'dsh-source-adoption/v1' as const, planId: current.id, planDigest: current.digest, sourceReferenceDigest: controlPlaneDigest(sourceReference) }
        const receipt = await requestSourceAuthorityReceipt(options.config.authority, request, value => {
          const parsed = parseApprovalReceipt(value)
          if (parsed.decision !== 'approved' || parsed.planId !== request.planId || parsed.planDigest !== request.planDigest) throw new Error('plugin-control-plane: source adoption authority receipt is not exact')
          return parsed
        }, signal)
        await options.assertCurrent(); signal.throwIfAborted()
        plan = (await options.store.approve({ planId: current.id, expectedRevision: current.revision, receipt,
          resolveAuthority: value => authority(options.trust, value), idempotencyKey: `source-adoption-approval:${receipt.approvalId}`, withSourceFence: options.withSourceFence })).result
      } else if (current.status === 'rollback-pending' && current.activation?.rollbackProfileRestored) {
        plan = await probePluginPlan({ store: options.store, trust: options.trust, planId: current.id, expectedRevision: current.revision, expectedFence: current.activation.fence, signal })
      } else if (current.status === 'approved' || current.status === 'staging' || current.status === 'commit-pending' || current.status === 'rollback-pending') {
        plan = await activatePluginPlan({ store: options.store, trust: options.trust, planId: current.id, expectedRevision: current.revision, signal })
      } else if (AWAITING.has(current.status)) {
        if (current.activation === undefined) throw new Error('plugin-control-plane: awaiting source adoption has no activation fence')
        plan = await probePluginPlan({ store: options.store, trust: options.trust, planId: current.id, expectedRevision: current.revision, expectedFence: current.activation.fence, signal })
      } else return current
      if (plan.status === before.status && plan.revision === before.revision && plan.activation?.fence === before.fence) return plan
    }
    return options.store.getPlan(plan.id)
  } catch (error) {
    if (created !== undefined && trustBound) {
      try { await recoverAwaiting(options.store, options.trust, options.store.getPlan(created.id), options.config.timeoutMs) } catch { /* preserve the triggering failure */ }
    }
    throw error
  }
}
