import { generateKeyPairSync, sign } from 'node:crypto'
import { join } from 'node:path'
import { approvalSigningPayload, Ed25519ApprovalAuthority } from '../../src/approval.ts'
import { loadCatalogWithMetadata } from '../../src/catalog.ts'
import { advanceSourceRelease } from '../../src/source-release-runner.ts'
import { ControlPlaneStore } from '../../src/store.ts'
import type { HostAttestationReceipt, HostAttestationRequest, PluginActivationPlan } from '../../src/types.ts'
import type { LiveQualificationTerms } from '../../src/live-qualification.ts'
import { fixture } from './source-release-runner.ts'

/** A real owner release, approval, handoff, staged witness, and reserved reload. */
export async function hostAuthorizationPlan(options: { originallyExisted?: boolean;
  liveQualification?: LiveQualificationTerms; issuer?: HostAttestationRequest['issuer'];
  releaseFixture?: Pick<Awaited<ReturnType<typeof fixture>>, 'root' | 'store' | 'plan' | 'options' | 'decide'>;
  profile?: string; executor?: PluginActivationPlan['executor'];
  profileFiles?: { path: string; sha256: string }[]; baselineFiles?: { path: string; sha256: string | null }[];
  deploymentFiles?: { input: string; path: string; sha256: string }[];
  baselineDeploymentFiles?: { input: string; path: string; sha256: string }[] } = {}) {
  const f = options.releaseFixture ?? await fixture(true)
  const profile = options.profile ?? 'web'
  await advanceSourceRelease(f.options); await f.decide(); await advanceSourceRelease(f.options)
  const source = f.store.getSourcePlan(f.plan.id), candidate = f.store.sourceReleaseCandidate(source.id)
  const catalog = await loadCatalogWithMetadata(f.options.trust.catalog.path)
  const handoff = { schemaVersion: 1 as const, coordinatorId: 'host-auth-coordinator', maximumWindowMs: 60_000,
    commit: 'target-host' as const }
  let plan = f.options.withSourceFence!(() => f.store.createPlan({ sourcePlanId: source.id, gapId: source.gapId, candidate,
    catalog: { digest: catalog.digest, provenance: catalog.provenance }, matchedCapabilities: candidate.capabilities,
    profile, target: { dshHome: f.root, profile, profilePath: join(f.root, 'profiles', profile) },
    installationId: f.options.trust.installationId, ledger: f.options.trust.ledger,
    executor: options.executor ?? { id: 'dsh', version: '1', path: join(f.root, 'dsh'), sha256: 'c'.repeat(64) },
    ttlMs: 60_000, idempotencyKey: options.releaseFixture ? `host-auth-plan:${source.id}` : 'host-auth-plan', handoff,
    ...(options.liveQualification ? { liveQualification: options.liveQualification } : {}),
    hostDeploymentInputs: ['node_modules/.pnpm/host-entry/index.js'] })).result
  const keys = generateKeyPairSync('ed25519')
  const unsigned = { schemaVersion: 1 as const, approvalId: options.releaseFixture ? `host-auth-approval:${source.id}` : 'host-auth-approval', authority: 'owner', keyId: 'key',
    planId: plan.id, planDigest: plan.digest, decision: 'approved' as const, principal: 'owner',
    decidedAt: Date.now(), expiresAt: plan.expiresAt }
  const receipt = { ...unsigned, signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), keys.privateKey).toString('base64') }
  const approvalPublicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' })
  const approvalAuthority = new Ed25519ApprovalAuthority(approvalPublicKeyPem, 'owner', 'key')
  plan = (await f.store.approve({ planId: plan.id, expectedRevision: plan.revision, receipt,
    resolveAuthority: () => approvalAuthority, idempotencyKey: options.releaseFixture ? `host-auth-approval:${source.id}` : 'host-auth-approval',
    withSourceFence: f.options.withSourceFence! })).result
  f.options.withSourceFence!(() => f.store.prepareAdoptionHandoff({ planId: plan.id, expectedRevision: plan.revision }))
  const coordinator = new ControlPlaneStore({ path: plan.ledger.path, adoptionCoordinatorId: handoff.coordinatorId })
  plan = await coordinator.claimActivation({ planId: plan.id, expectedRevision: plan.revision,
    leaseMs: 60_000, resolveApprovalAuthority: () => approvalAuthority })
  const original = options.originallyExisted ?? false
  const corePaths = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].map(name => `${plan.target.profilePath}/${name}`)
  const baselineFiles = options.baselineFiles ?? (original ? corePaths.map(path => ({ path, sha256: 'a'.repeat(64) })) : [])
  plan = coordinator.recordActivationTargetBaseline({ planId: plan.id, expectedRevision: plan.revision,
    fence: plan.activation!.fence, existed: original, baselineFiles })
  const profileFiles = options.profileFiles ?? corePaths.map(path => ({ path, sha256: 'b'.repeat(64) }))
  const deploymentFiles = options.deploymentFiles ?? [{ input: plan.dossier.hostDeploymentInputs![0]!,
    path: `${plan.target.profilePath}/node_modules/.pnpm/host-entry/index.js`, sha256: 'c'.repeat(64) }]
  const baselineDeploymentFiles = options.baselineDeploymentFiles ?? (original ? deploymentFiles.map(item => ({ ...item, sha256: 'd'.repeat(64) })) : [])
  const witnessInput = { planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence,
    profileFiles, deploymentFiles, baselineDeploymentFiles }
  return { f, coordinator, plan, handoff, approvalAuthority, approvalPublicKeyPem, receipt, witnessInput,
    async exposeAndClaimReload() {
      let current = coordinator.recordActivationHostInputWitness(witnessInput)
      current = coordinator.markActivationHostExposure({ planId: current.id, expectedRevision: current.revision,
        fence: current.activation!.fence })
      current = coordinator.advanceActivation({ planId: current.id, expectedRevision: current.revision,
        fence: current.activation!.fence, from: 'staging', to: 'awaiting-reload' })
      const operation = coordinator.prepareHostAttestationOperation({ planId: current.id, expectedRevision: current.revision,
        expectedFence: current.activation!.fence, issuer: options.issuer ?? { mode: 'owner-manual' },
        requirements: { kind: 'reload', previousHostGeneration: 0 }, receiptTtlMs: 10_000 })
      let rejectExecution!: (reason?: unknown) => void
      const pending = new Promise<HostAttestationReceipt>((_resolve, reject) => { rejectExecution = reject })
      const running = coordinator.runHostAttestationOperation({ operationId: operation.operationId,
        expectedRevision: current.revision, expectedFence: current.activation!.fence,
        execute: async () => pending, resolveAuthority: () => { throw new Error('test does not settle Host attestation') } })
      return { plan: current, operation, stop: async () => { rejectExecution(new Error('test stopped')); await running.catch(() => {}) } }
    },
  }
}
