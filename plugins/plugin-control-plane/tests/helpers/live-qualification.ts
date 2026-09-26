import { generateKeyPairSync, sign } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect } from 'vitest'
import { approvalSigningPayload, Ed25519ApprovalAuthority } from '../../src/approval.ts'
import { hostAttestationEvidenceDigest, hostAttestationSigningPayload,
  Ed25519HostAttestationAuthority } from '../../src/attestation.ts'
import { loadCatalogWithMetadata } from '../../src/catalog.ts'
import { runtimeIdentityDigest, type ForegroundDeploymentRecord } from '../../src/foreground-deployment.ts'
import { liveQualificationDigest, liveQualificationId, type LiveQualificationBatch,
  type LiveQualificationTerms } from '../../src/live-qualification.ts'
import { advanceSourceRelease } from '../../src/source-release-runner.ts'
import { controlPlaneDigest, ControlPlaneStore, readOwnerSourceAdoptionPlan } from '../../src/store.ts'
import type { HostAttestationReceipt } from '../../src/types.ts'
import { createReadinessFixture } from './deployment-readiness.ts'
import { fixture } from './source-release-runner.ts'

const readinessRoots: string[] = []
export async function cleanupLiveQualificationReadinessFixtures(): Promise<void> {
  for (const root of readinessRoots.splice(0)) await rm(root, { recursive: true, force: true })
}

export const liveHandoff = { schemaVersion: 1 as const, coordinatorId: 'live-coordinator', maximumWindowMs: 60_000,
  commit: 'target-host' as const }
export const liveTerms: LiveQualificationTerms = { protocol: 'dsh-bounded-live/v1', maximumWindowMs: 60_000,
  minimumTasks: 1, authority: 'live-observer', keyId: 'live-key' }

export async function livePlan(terms: LiveQualificationTerms = liveTerms) {
  const f = await fixture(true)
  await advanceSourceRelease(f.options); await f.decide(); await advanceSourceRelease(f.options)
  const source = f.store.getSourcePlan(f.plan.id), candidate = f.store.sourceReleaseCandidate(source.id)
  const catalog = await loadCatalogWithMetadata(f.options.trust.catalog.path)
  let plan = f.options.withSourceFence!(() => f.store.createPlan({ sourcePlanId: source.id, gapId: source.gapId, candidate,
    catalog: { digest: catalog.digest, provenance: catalog.provenance }, matchedCapabilities: candidate.capabilities,
    profile: 'web', target: { dshHome: f.root, profile: 'web', profilePath: join(f.root, 'profiles', 'web') },
    installationId: f.options.trust.installationId, ledger: f.options.trust.ledger,
    executor: { id: 'dsh', version: '1', path: join(f.root, 'dsh'), sha256: 'c'.repeat(64) },
    ttlMs: 60_000, idempotencyKey: 'live-plan', handoff: liveHandoff, liveQualification: terms })).result
  const approvalKeys = generateKeyPairSync('ed25519')
  const unsignedApproval = { schemaVersion: 1 as const, approvalId: 'live-approval', authority: 'owner', keyId: 'key',
    planId: plan.id, planDigest: plan.digest, decision: 'approved' as const, principal: 'owner',
    decidedAt: Date.now(), expiresAt: plan.expiresAt }
  const approval = { ...unsignedApproval, signature: sign(null, Buffer.from(approvalSigningPayload(unsignedApproval)),
    approvalKeys.privateKey).toString('base64') }
  const approvalAuthority = new Ed25519ApprovalAuthority(
    approvalKeys.publicKey.export({ type: 'spki', format: 'pem' }), 'owner', 'key')
  plan = (await f.store.approve({ planId: plan.id, expectedRevision: plan.revision, receipt: approval,
    resolveAuthority: () => approvalAuthority, idempotencyKey: 'live-approval',
    withSourceFence: f.options.withSourceFence! })).result
  f.options.withSourceFence!(() => f.store.prepareAdoptionHandoff({ planId: plan.id, expectedRevision: plan.revision }))
  const coordinator = new ControlPlaneStore({ path: plan.ledger.path, adoptionCoordinatorId: liveHandoff.coordinatorId })
  plan = await coordinator.claimActivation({ planId: plan.id, expectedRevision: plan.revision,
    leaseMs: 60_000, resolveApprovalAuthority: () => approvalAuthority })
  plan = coordinator.recordActivationTargetBaseline({ planId: plan.id, expectedRevision: plan.revision,
    fence: plan.activation!.fence, existed: false, baselineFiles: [] })
  plan = coordinator.markActivationHostExposure({ planId: plan.id, expectedRevision: plan.revision,
    fence: plan.activation!.fence })
  plan = coordinator.advanceActivation({ planId: plan.id, expectedRevision: plan.revision,
    fence: plan.activation!.fence, from: 'staging', to: 'awaiting-reload' })
  const hostKeys = generateKeyPairSync('ed25519')
  const host = new Ed25519HostAttestationAuthority(hostKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    'host', 'host-key')
  let generation = coordinator.latestHostGeneration(plan.installationId)
  let readinessReceipt: HostAttestationReceipt | undefined
  for (const phase of ['reload', 'readiness'] as const) {
    const requirements = phase === 'reload'
      ? { kind: 'reload' as const, previousHostGeneration: generation }
      : { kind: 'readiness' as const, minimumChecks: 1 }
    const operation = coordinator.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision,
      expectedFence: plan.activation!.fence, issuer: { mode: 'owner-manual' }, requirements, receiptTtlMs: 10_000 })
    const evidence = phase === 'reload'
      ? { kind: 'reload' as const, reloaded: true, previousHostGeneration: generation,
        currentHostGeneration: generation + 1, probeDigest: '1'.repeat(64) }
      : { kind: 'readiness' as const, checks: 1, failures: 0, probeDigest: '2'.repeat(64) }
    if (phase === 'reload') generation += 1
    const unsigned: Omit<HostAttestationReceipt, 'signature'> = {
      schemaVersion: 2, receiptId: `live-${phase}`, authority: 'host', keyId: 'host-key',
      installationId: plan.installationId, planId: plan.id, planDigest: plan.digest,
      activationId: plan.activation!.id, fence: plan.activation!.fence, operationId: operation.operationId,
      requestDigest: operation.requestDigest, phase, outcome: 'passed', hostGeneration: generation,
      evidence, evidenceDigest: hostAttestationEvidenceDigest(evidence), observedAt: Date.now(), expiresAt: Date.now() + 9_000,
    }
    const receipt = { ...unsigned, signature: sign(null, Buffer.from(hostAttestationSigningPayload(unsigned)),
      hostKeys.privateKey).toString('base64') }
    await coordinator.runHostAttestationOperation({ operationId: operation.operationId, expectedRevision: plan.revision,
      expectedFence: plan.activation!.fence, execute: async () => receipt, resolveAuthority: () => host })
    plan = (await coordinator.applyHostAttestation({ planId: plan.id, expectedRevision: plan.revision,
      expectedFence: plan.activation!.fence, receipt, resolveAuthority: () => host,
      idempotencyKey: `live-${phase}` })).result
    if (phase === 'readiness') readinessReceipt = receipt
  }
  expect(plan.status).toBe('awaiting-live-tasks')
  const window = coordinator.getLiveQualificationWindow(plan.id)
  return { f, coordinator, plan, window, readinessReceipt: readinessReceipt!, hostGeneration: generation, approvalAuthority }
}

export async function persistedVote(value: Awaited<ReturnType<typeof livePlan>>,
  status: 'achieved' | 'not-achieved' = 'achieved') {
  const signed = await createReadinessFixture(value.plan)
  readinessRoots.push(signed.root)
  const sourceDb = new DatabaseSync(value.plan.ledger.path, { readOnly: true })
  let source: ReturnType<typeof readOwnerSourceAdoptionPlan>['source']
  try { source = readOwnerSourceAdoptionPlan(sourceDb, value.plan.id).source }
  finally { sourceDb.close() }
  const { authorityId, authorityHash, principalId, principalRecordId, principalVersion, workspace, agentPreset } = source.owner
  const owner = { authorityId, authorityHash, principalId, principalRecordId, principalVersion, workspace, agentPreset }
  const started = value.window.startedAt
  const dispatchedAt = Math.max(started, Date.now() - 2)
  const completedAt = Math.max(dispatchedAt, Date.now())
  const stable = signed.runtime
  const begin = { ...stable, challenge: 'a'.repeat(64), observedAt: dispatchedAt }
  const end = { ...stable, challenge: 'b'.repeat(64), observedAt: completedAt }
  if (value.readinessReceipt.evidence.kind !== 'readiness') throw new Error('fixture lacks readiness evidence')
  const readiness = { planId: value.plan.id, activationId: value.plan.activation!.id, fence: value.plan.activation!.fence,
    hostGeneration: value.hostGeneration, operationId: 'readiness-1', receiptDigest: controlPlaneDigest(value.readinessReceipt),
    readinessDigest: value.readinessReceipt.evidence.probeDigest, runtimeDigest: runtimeIdentityDigest(begin),
    planDigest: value.plan.digest, installationId: value.plan.installationId, profilePath: value.plan.target.profilePath,
    exact: { package: value.plan.candidate.package, version: value.plan.candidate.version, integrity: value.plan.candidate.integrity } }
  const deployment: ForegroundDeploymentRecord = { schemaVersion: 1,
    task: { protocol: 'assistant-delivery/foreground-task/v1', inboxId: 'live-inbox', sessionId: 'session',
      scope: { workspace: owner.workspace, preset: owner.agentPreset },
      owner: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
      binding: { id: 'binding', version: 1, generation: 1 }, dispatchedAt },
    readiness, begin, state: 'observed', end,
    execution: { dispatchedAt, completedAt, executionRef: 'live-inbox', status: 'succeeded', quiescent: true,
      modelSelectionState: 'frozen', modelSelection: { provider: 'test', model: 'test' } } }
  value.f.store.withForegroundDeployment(deployment.task, value.plan.target.profilePath, (plan, operation) => {
    expect(plan.id).toBe(value.plan.id)
    expect(operation.receipt).toEqual(value.readinessReceipt)
    const { end: _end, execution: _execution, ...pending } = deployment
    value.f.store.beginForegroundDeployment({ ...pending, state: 'pending' })
    value.f.store.finishForegroundDeployment(deployment)
  })
  const vote = { inboxId: deployment.task.inboxId, outcomeId: 'outcome',
    projection: { subjectKind: 'foreground-turn' as const, subjectRef: deployment.task.inboxId,
      version: 1, digest: '3'.repeat(64), disposition: 'upsert' as const },
    sourceDigest: '4'.repeat(64), deploymentDigest: controlPlaneDigest(deployment), status, completedAt }
  return { owner, vote }
}

export function liveQualificationBatch(value: Awaited<ReturnType<typeof livePlan>>,
  witness: Awaited<ReturnType<typeof persistedVote>>): LiveQualificationBatch {
  const core = { lane: '5'.repeat(64), configDigest: '6'.repeat(64), trustDigest: '7'.repeat(64),
    planId: value.plan.id, planDigest: value.plan.digest, installationId: value.plan.installationId,
    profilePath: value.plan.target.profilePath, owner: witness.owner, terms: value.plan.dossier.liveQualification!,
    activationId: value.plan.activation!.id, fence: value.plan.activation!.fence,
    startedAt: value.window.startedAt, deadlineAt: value.window.deadlineAt,
    readinessDigest: value.window.readinessDigest, hostGeneration: value.window.hostGeneration,
    votes: [witness.vote] }
  const unsigned = { schemaVersion: 1 as const, kind: 'dsh-live-qualification' as const,
    id: liveQualificationId(core), ...core, createdAt: Date.now(), expiresAt: value.window.deadlineAt + 300_000 }
  return { ...unsigned, digest: liveQualificationDigest(unsigned) }
}
