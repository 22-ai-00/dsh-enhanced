import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { Ed25519ApprovalAuthority, approvalSigningPayload } from '../src/approval.ts'
import { Ed25519HostAttestationAuthority, hostAttestationEvidenceDigest, hostAttestationSigningPayload } from '../src/attestation.ts'
import { exampleIntegrityPinnedCatalog } from '../src/catalog.ts'
import { ControlPlaneStore, controlPlaneDigest } from '../src/store.ts'
import type { ApprovalReceipt, HostAttestationReceipt, HostAttestationRequest } from '../src/types.ts'

const roots: string[] = [], stores = new Set<ControlPlaneStore>()
const now = 1_800_000_000_000
afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of stores) store.close()
  stores.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'host-dispatch-')); roots.push(root)
  const path = join(root, 'control.sqlite')
  let sourceCurrent = true, insideSourceFence = false
  const open = () => {
    const store = new ControlPlaneStore({ path, now: () => now, withOwnerActivationFence: (_gap, callback) => {
      if (!sourceCurrent) throw new Error('source withdrawn')
      insideSourceFence = true
      try { return callback() } finally { insideSourceFence = false }
    } })
    stores.add(store); return store
  }
  const store = open(), candidate = exampleIntegrityPinnedCatalog.entries.find(value => value.id === 'assistant-health')!
  const recordGap = (target: ControlPlaneStore, id: string) => target.recordGap({ idempotencyKey: id, capability: 'health',
    context: 'health', expectedValue: 100, frequency: 10, estimatedCost: 50, risk: 0.2 })
  const gap = recordGap(store, 'gap')
  let plan = store.createPlan({ candidate, catalog: { digest: controlPlaneDigest(exampleIntegrityPinnedCatalog), provenance: 'owner-provided-integrity-pinned' },
    matchedCapabilities: candidate.capabilities, profile: 'web', target: { dshHome: root, profile: 'web', profilePath: join(root, 'profiles/web') },
    installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00', ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path },
    executor: { id: 'dsh', version: '0.1.2-rc.1', path: join(root, 'dsh'), sha256: 'd'.repeat(64) },
    ttlMs: 60_000, gapId: gap.id, idempotencyKey: 'plan' }).result
  const owner = generateKeyPairSync('ed25519')
  const approvalAuthority = new Ed25519ApprovalAuthority(owner.publicKey.export({ type: 'spki', format: 'pem' }), 'owner', 'owner-key', () => now)
  const approval: Omit<ApprovalReceipt, 'signature'> = { schemaVersion: 1, approvalId: 'approval', authority: 'owner', keyId: 'owner-key',
    planId: plan.id, planDigest: plan.digest, decision: 'approved', principal: 'owner', decidedAt: now, expiresAt: now + 10000 }
  plan = (await store.approve({ planId: plan.id, expectedRevision: plan.revision,
    receipt: { ...approval, signature: sign(null, Buffer.from(approvalSigningPayload(approval)), owner.privateKey).toString('base64') },
    resolveAuthority: () => approvalAuthority, idempotencyKey: 'approve' })).result
  plan = await store.claimActivation({ planId: plan.id, expectedRevision: plan.revision, leaseMs: 5000, resolveApprovalAuthority: () => approvalAuthority })
  plan = store.advanceActivation({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence, from: 'staging', to: 'awaiting-reload' })
  const keys = generateKeyPairSync('ed25519')
  const authority = new Ed25519HostAttestationAuthority(keys.publicKey.export({ type: 'spki', format: 'pem' }), 'host', 'host-key', () => now)
  const operation = store.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision,
    expectedFence: plan.activation!.fence, issuer: { mode: 'owner-manual' }, requirements: { kind: 'reload', previousHostGeneration: 0 }, receiptTtlMs: 10000 })
  if (operation.request.schemaVersion !== 2) throw new Error('expected schema 2')
  const receiptFor = (request: HostAttestationRequest): HostAttestationReceipt => {
    const evidence: HostAttestationReceipt['evidence'] = { kind: 'reload', reloaded: true, previousHostGeneration: 0, currentHostGeneration: 2, probeDigest: 'a'.repeat(64) }
    const unsigned: Omit<HostAttestationReceipt, 'signature'> = { schemaVersion: 2, receiptId: `receipt:${request.operationId}`, authority: 'host', keyId: 'host-key',
      installationId: plan.installationId, planId: plan.id, planDigest: plan.digest, activationId: plan.activation!.id, fence: plan.activation!.fence,
      operationId: request.operationId, requestDigest: controlPlaneDigest(request), phase: 'reload', outcome: 'passed', hostGeneration: 2,
      evidence, evidenceDigest: hostAttestationEvidenceDigest(evidence), observedAt: now, expiresAt: now + 10000 }
    return { ...unsigned, signature: sign(null, Buffer.from(hostAttestationSigningPayload(unsigned)), keys.privateKey).toString('base64') }
  }
  const receipt = receiptFor(operation.request)
  const input = { operationId: operation.operationId, expectedRevision: plan.revision, expectedFence: plan.activation!.fence, resolveAuthority: () => authority }
  const rollback = (target = store) => target.requestActivationRollback({ planId: plan.id, expectedRevision: plan.revision,
    fence: plan.activation!.fence, failureCode: 'source-withdrawn' })
  const ownerSource = () => {
    // Exercise the Store's Host fence seam; Delivery/Evaluation verification is
    // covered by owner-task-gaps.spec.ts, not fabricated by this fixture.
    vi.spyOn(store, 'getOwnerTaskFailureReference').mockReturnValue({ schemaVersion: 1,
      owner: { receiptVersion: 2, authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner', principalRecordId: 'record',
        principalVersion: 1, workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: 1 },
      outcomeId: 'outcome', projection: { subjectKind: 'foreground-turn', subjectRef: 'inbox', version: 1, digest: 'b'.repeat(64), disposition: 'upsert' }, sourceDigest: 'c'.repeat(64) })
  }
  return { store, path, open, plan, operation, receipt, input, rollback, recordGap, ownerSource,
    withdraw: () => { sourceCurrent = false }, insideFence: () => insideSourceFence }
}

test('external await permits unrelated writes but rejects duplicate dispatch and rollback', async () => {
  const f = await fixture(), pending = Promise.withResolvers<HostAttestationReceipt>(), execute = vi.fn(() => pending.promise)
  const flight = f.store.runHostAttestationOperation({ ...f.input, execute })
  const other = f.open()
  try {
    expect(f.recordGap(other, 'unrelated').status).toBe('open')
    expect(other.getHostAttestationDispatchStatus(f.operation.operationId)).toBe('claimed')
    await expect(other.runHostAttestationOperation({ ...f.input, execute })).rejects.toThrow(/unknown/u)
    expect(() => f.rollback(other)).toThrow()
    expect(() => other.assertNoClaimedHostAttestation(f.plan.id)).toThrow(/unknown/u)
  } finally { pending.resolve(f.receipt) }
  await expect(flight).resolves.toEqual(f.receipt)
  expect(execute).toHaveBeenCalledTimes(1)
  expect(() => other.assertNoClaimedHostAttestation(f.plan.id)).not.toThrow()
})

test('restart preserves unknown and exact signed reconciliation never dispatches or advances the plan', async () => {
  const f = await fixture(), execute = vi.fn(async () => { throw new Error('response lost') })
  await expect(f.store.runHostAttestationOperation({ ...f.input, execute })).rejects.toThrow('response lost')
  f.store.close(); stores.delete(f.store)
  const reopened = f.open()
  await expect(reopened.runHostAttestationOperation({ ...f.input, execute })).rejects.toThrow(/unknown/u)
  await reopened.acceptHostAttestationReceipt({ ...f.input, receipt: f.receipt })
  expect(reopened.getHostAttestationDispatchStatus(f.operation.operationId)).toBe('completed')
  expect(reopened.getPlan(f.plan.id)).toEqual(f.plan)
  await expect(reopened.acceptHostAttestationReceipt({ ...f.input, receipt: f.receipt })).resolves.toEqual(f.receipt)
  expect(f.rollback(reopened).status).toBe('rollback-pending')
  expect(execute).toHaveBeenCalledTimes(1)
})

test('manual signed receipts remain usable without any dispatch reservation', async () => {
  const f = await fixture()
  await f.store.acceptHostAttestationReceipt({ ...f.input, receipt: f.receipt })
  const applied = await f.store.applyHostAttestation({ planId: f.plan.id, expectedRevision: f.plan.revision,
    expectedFence: f.plan.activation!.fence, receipt: f.receipt, resolveAuthority: f.input.resolveAuthority, idempotencyKey: 'manual' })
  expect(applied.result.status).toBe('awaiting-readiness')
})

test('withdrawn source cannot settle a forward dispatch but signed facts can unlock recovery', async () => {
  const f = await fixture(); f.ownerSource()
  const execute = vi.fn(async () => { expect(f.insideFence()).toBe(false); f.withdraw(); return f.receipt })
  await expect(f.store.runHostAttestationOperation({ ...f.input, execute })).rejects.toThrow('source withdrawn')
  expect(f.store.getHostAttestationDispatchStatus(f.operation.operationId)).toBe('claimed')
  expect(() => f.rollback()).toThrow()
  await f.store.acceptHostAttestationReceipt({ ...f.input, receipt: f.receipt })
  await expect(f.store.applyHostAttestation({ planId: f.plan.id, expectedRevision: f.plan.revision,
    expectedFence: f.plan.activation!.fence, receipt: f.receipt, resolveAuthority: f.input.resolveAuthority, idempotencyKey: 'withdrawn' })).rejects.toThrow('source withdrawn')
  expect(f.rollback().status).toBe('rollback-pending')
  expect(execute).toHaveBeenCalledTimes(1)
})

test('holds the source fence for both durable claim and receipt completion', async () => {
  const f = await fixture(); f.ownerSource()
  const original = f.store.getHostAttestationDispatchStatus.bind(f.store), checks: boolean[] = []
  vi.spyOn(f.store, 'getHostAttestationDispatchStatus').mockImplementation(id => {
    checks.push(f.insideFence()); return original(id)
  })
  await f.store.runHostAttestationOperation({ ...f.input, execute: async () => f.receipt })
  expect(checks).toEqual([true, true])
})

test('two concurrent reconciliations retain the same receipt idempotently', async () => {
  const f = await fixture(), other = f.open()
  await expect(f.store.runHostAttestationOperation({ ...f.input, execute: async () => { throw new Error('lost') } })).rejects.toThrow('lost')
  await expect(Promise.all([f.store.acceptHostAttestationReceipt({ ...f.input, receipt: f.receipt }),
    other.acceptHostAttestationReceipt({ ...f.input, receipt: f.receipt })])).resolves.toEqual([f.receipt, f.receipt])
})

test.each(['signature', 'operation', 'revision', 'fence'] as const)('rejects %s substitution without clearing unknown', async kind => {
  const f = await fixture()
  await expect(f.store.runHostAttestationOperation({ ...f.input, execute: async () => { throw new Error('lost') } })).rejects.toThrow('lost')
  const receipt = kind === 'signature' ? { ...f.receipt, signature: Buffer.alloc(64).toString('base64') }
    : kind === 'operation' ? { ...f.receipt, operationId: 'another-operation' } : f.receipt
  await expect(f.store.acceptHostAttestationReceipt({ ...f.input, receipt,
    ...(kind === 'revision' ? { expectedRevision: f.plan.revision + 1 } : {}),
    ...(kind === 'fence' ? { expectedFence: f.plan.activation!.fence + 1 } : {}) })).rejects.toThrow()
  expect(f.store.getHostAttestationDispatchStatus(f.operation.operationId)).toBe('claimed')
})

test('revalidates a manual receipt after asynchronous verification before retaining it', async () => {
  const f = await fixture(), verification = Promise.withResolvers<void>()
  const accepting = f.store.acceptHostAttestationReceipt({ ...f.input, receipt: f.receipt, resolveAuthority: () => ({
    verify: async (...args) => { const verified = await f.input.resolveAuthority().verify(...args); await verification.promise; return verified },
  }) })
  expect(f.rollback().status).toBe('rollback-pending'); verification.resolve()
  await expect(accepting).rejects.toThrow(/stale/u)
  expect(f.store.getHostAttestationOperation(f.operation.operationId).receipt).toBeUndefined()
})

test('schema 21 migration claims historical pending operations and preserves applied receipts', async () => {
  const f = await fixture()
  await f.store.runHostAttestationOperation({ ...f.input, execute: async () => f.receipt })
  const plan = (await f.store.applyHostAttestation({ planId: f.plan.id, expectedRevision: f.plan.revision,
    expectedFence: f.plan.activation!.fence, receipt: f.receipt, resolveAuthority: f.input.resolveAuthority, idempotencyKey: 'reload' })).result
  const pending = f.store.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.activation!.fence,
    issuer: { mode: 'owner-manual' }, requirements: { kind: 'readiness', minimumChecks: 1 }, receiptTtlMs: 10000 })
  f.store.close(); stores.delete(f.store)
  const raw = new DatabaseSync(f.path)
  try { raw.exec('DROP TABLE host_attestation_dispatches; PRAGMA user_version = 21;') } finally { raw.close() }
  const reopened = f.open(), execute = vi.fn(async () => f.receipt)
  expect(reopened.getHostAttestationDispatchStatus(pending.operationId)).toBe('claimed')
  expect(reopened.getHostAttestationDispatchStatus(f.operation.operationId)).toBe('completed')
  expect(reopened.getHostAttestationOperation(f.operation.operationId).receipt).toEqual(f.receipt)
  await expect(reopened.runHostAttestationOperation({ ...f.input, operationId: pending.operationId, expectedRevision: plan.revision, execute })).rejects.toThrow(/unknown/u)
  expect(execute).not.toHaveBeenCalled()
})
