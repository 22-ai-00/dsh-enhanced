/** Host continuation of the existing release phases. No scheduler or review authority. */
import { lstatSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { loadCatalogWithMetadata, previewCatalogAdmission } from './catalog.js'
import { Ed25519SourceReleaseAuthority, Ed25519SourceReleaseAuthorizationAuthority, invokeSourceReleaseAdapter } from './release.js'
import { sourceAuthorityCanonicalSafePath, sourceAuthorityReadSafeFile } from './source-approval-authority.js'
import { controlPlaneDigest, expectedSourceRelease, type ControlPlaneStore } from './store.js'
import { resolveTrustKey, type PluginControlTrustConfig } from './trust.js'
import type { PluginSourcePlan, SourceReleaseAuthorization, SourceReleaseReceipt, SourceReleaseRequest } from './types.js'

export interface SourceReleaseExecutionConfig {
  /** Independently produced decisions consumed by the configured local review adapter. */
  reviewDecisionRoot: string
  timeoutMs: number
}
export function validateSourceReleaseExecutionConfig(value: SourceReleaseExecutionConfig): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== ['reviewDecisionRoot', 'timeoutMs'].join('\0')
    || typeof value.reviewDecisionRoot !== 'string' || !isAbsolute(value.reviewDecisionRoot)
    || resolve(value.reviewDecisionRoot) !== value.reviewDecisionRoot
    || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 1_800_000) {
    throw new Error('plugin-control-plane: invalid sourceReleaseExecution config')
  }
  sourceAuthorityCanonicalSafePath(value.reviewDecisionRoot, 'directory')
}

/** A missing decision is a normal wait, never an attempted or self-approved review. */
function hasIndependentReview(request: SourceReleaseRequest, root: string): boolean {
  if (request.phase !== 'review') return true
  sourceAuthorityCanonicalSafePath(root, 'directory')
  const path = join(root, `${request.input.prId}.json`)
  try { lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const decision = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sourceAuthorityReadSafeFile(path, 8192))) as Record<string, unknown>
  const expected = { schemaVersion: 1, kind: 'dsh-local-review-decision', prId: request.input.prId,
    baseCommit: request.input.baseCommit, headCommit: request.input.headCommit, prEvidenceDigest: request.input.prEvidenceDigest,
    decision: 'approved', reviewerPrincipal: decision?.reviewerPrincipal }
  if (typeof expected.reviewerPrincipal !== 'string' || expected.reviewerPrincipal.trim() === '' || expected.reviewerPrincipal.length > 500
    || controlPlaneDigest(decision) !== controlPlaneDigest(expected)) throw new Error('independent review decision does not match the current release')
  return true
}

export function sourceReleaseAuthorities(trust: PluginControlTrustConfig) {
  const authorize = (value: SourceReleaseAuthorization) => {
    const key = resolveTrustKey(trust, 'release-authorization', value.authority, value.keyId)
    const verifier = new Ed25519SourceReleaseAuthorizationAuthority(key.publicKeyPem, key.authority, key.keyId)
    return { verify: (authorization: SourceReleaseAuthorization, plan: PluginSourcePlan) => {
      const { signatureDigest: _digest, ...signed } = authorization as SourceReleaseAuthorization & { signatureDigest?: string }
      return verifier.verify(signed, plan)
    } }
  }
  const authority = (value: SourceReleaseReceipt) => {
    const key = resolveTrustKey(trust, 'release', value.authority, value.keyId)
    return new Ed25519SourceReleaseAuthority(key.publicKeyPem, key.authority, key.keyId, Date.now, (id, keyId) => {
      const verifier = trust.releaseAdapters?.['registry-verify']
      return verifier?.authority === id && verifier.keyId === keyId ? resolveTrustKey(trust, 'release', id, keyId).publicKeyPem : undefined
    })
  }
  return { authorize, authority }
}

export async function advanceSourceRelease(options: {
  store: ControlPlaneStore; planId: string; trust: PluginControlTrustConfig; config: SourceReleaseExecutionConfig
  signal: AbortSignal; assertCurrent: () => Promise<void>; withSourceFence: <T>(callback: () => T) => T
}): Promise<PluginSourcePlan> {
  const { store, trust, signal, withSourceFence } = options
  if (trust.schemaVersion !== 4 || !trust.releaseRegistry?.locator.startsWith('file:')) throw new Error('source release execution requires local schema-v4 trust')
  const { authorize, authority } = sourceReleaseAuthorities(trust)
  // Exactly the existing eight phases, with state/receipt recovery from the Store.
  for (let step = 0; step < 8; step++) {
    await options.assertCurrent(); signal.throwIfAborted()
    const plan = store.getSourcePlan(options.planId), expected = expectedSourceRelease(plan.status)
    if (!expected) return plan
    if (!plan.release || !plan.releaseAuthorization) throw new Error('source release has no authorization')
    const adapter = trust.releaseAdapters?.[expected.phase]
    if (!adapter) throw new Error(`source release adapter missing: ${expected.phase}`)
    if (plan.releaseAuthorization.releasePolicy.registryId !== trust.releaseRegistry.id
      || plan.releaseAuthorization.releasePolicy.registryLocator !== trust.releaseRegistry.locator
      || plan.releaseAuthorization.releasePolicy.catalogId !== trust.catalog.id
      || plan.releaseAuthorization.releasePolicy.catalogPath !== trust.catalog.path) throw new Error('source release trust changed')
    let operation = store.findSourceReleaseOperation(plan.id, expected.phase, plan.release.fence)
    if (!operation) {
      let catalog: { id: string; path: string; expectedBeforeDigest?: string; expectedAfterDigest?: string } = { id: trust.catalog.id, path: trust.catalog.path }
      if (expected.phase === 'catalog-admission') {
        const loaded = await loadCatalogWithMetadata(trust.catalog.path)
        const preview = previewCatalogAdmission(loaded.catalog, store.previewSourceReleaseCandidate(plan.id))
        catalog = { ...catalog, expectedBeforeDigest: preview.beforeCatalogDigest, expectedAfterDigest: preview.afterCatalogDigest }
      }
      await options.assertCurrent()
      operation = await store.prepareSourceReleaseOperation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.release.fence,
        installationId: trust.installationId, ledger: trust.ledger, registry: { id: trust.releaseRegistry.id, locator: trust.releaseRegistry.locator }, catalog,
        adapter: { id: adapter.id, version: adapter.version, path: adapter.path, sha256: adapter.sha256, interpreter: adapter.interpreter, authority: adapter.authority, keyId: adapter.keyId },
        receiptTtlMs: trust.releaseReceiptTtlMs, resolveAuthorizationAuthority: authorize, withSourceFence })
    } else if (controlPlaneDigest(operation.request.adapter) !== controlPlaneDigest({ id: adapter.id, version: adapter.version,
      path: adapter.path, sha256: adapter.sha256, interpreter: adapter.interpreter, authority: adapter.authority, keyId: adapter.keyId })) {
      throw new Error('source release adapter changed since preparation')
    }
    // A completed signed receipt can be applied even if the decision file was
    // subsequently removed. Store still rechecks its exact request and source.
    if (!operation.receipt && !hasIndependentReview(operation.request, options.config.reviewDecisionRoot)) return plan
    await options.assertCurrent()
    const receipt = await store.runSourceReleaseOperation({ operationId: operation.operationId, expectedRevision: plan.revision,
      expectedFence: plan.release.fence, resolveAuthority: authority, resolveAuthorizationAuthority: authorize, withSourceFence,
      execute: async request => { await options.assertCurrent(); signal.throwIfAborted(); return invokeSourceReleaseAdapter(trust, request, signal) } })
    await options.assertCurrent()
    await store.applySourceRelease({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.release.fence, receipt,
      resolveAuthority: authority, idempotencyKey: `source-release:${operation.operationId}`, withSourceFence })
  }
  await options.assertCurrent()
  return store.getSourcePlan(options.planId)
}
