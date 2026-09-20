import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { Ed25519ApprovalAuthority, approvalSigningPayload } from '../src/approval.ts'
import { Ed25519HostAttestationAuthority, hostAttestationEvidenceDigest, hostAttestationSigningPayload } from '../src/attestation.ts'
import { exampleIntegrityPinnedCatalog } from '../src/catalog.ts'
import { ControlPlaneStore, controlPlaneDigest } from '../src/store.ts'
import type { ApprovalReceipt, HostAttestationReceipt, HostAttestationRequest, HostAttestationRequirements, StoredHostAttestationRequest } from '../src/types.ts'

const roots: string[] = []
const stores = new Set<ControlPlaneStore>()
const now = 1_800_000_000_000
afterEach(async () => {
  for (const store of stores) store.close()
  stores.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'host-chain-')); roots.push(root)
  const path = join(root, 'control.sqlite')
  let store = new ControlPlaneStore({ path, now: () => now }); stores.add(store)
  const candidate = exampleIntegrityPinnedCatalog.entries.find(value => value.id === 'assistant-health')!
  const gap = store.recordGap({ idempotencyKey: 'gap', capability: 'health', context: 'health', expectedValue: 100, frequency: 10, estimatedCost: 50, risk: 0.2 })
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
    resolveAuthority: () => approvalAuthority,
    idempotencyKey: 'approve' })).result
  plan = await store.claimActivation({ planId: plan.id, expectedRevision: plan.revision, leaseMs: 5000,
    resolveApprovalAuthority: () => approvalAuthority })
  plan = store.advanceActivation({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence, from: 'staging', to: 'awaiting-reload' })
  const keys = generateKeyPairSync('ed25519')
  const authority = new Ed25519HostAttestationAuthority(keys.publicKey.export({ type: 'spki', format: 'pem' }), 'host', 'host-key', () => now)
  const prepare = (requirements: HostAttestationRequirements) => {
    const operation = store.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision,
      expectedFence: plan.activation!.fence, issuer: { mode: 'owner-manual' }, requirements, receiptTtlMs: 10000 })
    if (operation.request.schemaVersion !== 2) throw new Error('new request must be schema 2')
    return { ...operation, request: operation.request }
  }
  const receiptFor = (request: StoredHostAttestationRequest, overrides: Partial<Pick<HostAttestationReceipt, 'hostGeneration' | 'outcome'>> = {}): HostAttestationReceipt => {
    const evidence: HostAttestationReceipt['evidence'] = request.phase === 'reload'
      ? { kind: 'reload', reloaded: true, previousHostGeneration: 0, currentHostGeneration: 2, probeDigest: 'a'.repeat(64) }
      : { kind: 'readiness', checks: 1, failures: 0, probeDigest: 'b'.repeat(64) }
    const unsigned: Omit<HostAttestationReceipt, 'signature'> = { schemaVersion: 2, receiptId: `receipt:${request.operationId}`, authority: 'host', keyId: 'host-key',
      installationId: plan.installationId, planId: plan.id, planDigest: plan.digest, activationId: plan.activation!.id, fence: plan.activation!.fence,
      operationId: request.operationId, requestDigest: controlPlaneDigest(request), phase: request.phase, outcome: 'passed', hostGeneration: 2,
      evidence, evidenceDigest: hostAttestationEvidenceDigest(evidence), observedAt: now, expiresAt: now + 10000, ...overrides }
    return { ...unsigned, signature: sign(null, Buffer.from(hostAttestationSigningPayload(unsigned)), keys.privateKey).toString('base64') }
  }
  const run = async (operationId: string, receipt: HostAttestationReceipt) => store.runHostAttestationOperation({ operationId,
    expectedRevision: plan.revision, expectedFence: plan.activation!.fence, execute: async () => receipt, resolveAuthority: () => authority })
  const apply = async (receipt: HostAttestationReceipt) => {
    plan = (await store.applyHostAttestation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.activation!.fence,
      receipt, resolveAuthority: () => authority, idempotencyKey: `apply:${receipt.operationId}` })).result
    return plan
  }
  const reload = prepare({ kind: 'reload', previousHostGeneration: 0 })
  const reloadReceipt = receiptFor(reload.request)
  await run(reload.operationId, reloadReceipt)
  await apply(reloadReceipt)
  const writeRequest = (operationId: string, request: StoredHostAttestationRequest) => {
    const { operationId: _operationId, requestedAt: _requestedAt, ...binding } = request
    const db = new DatabaseSync(path)
    try { db.prepare('UPDATE host_attestation_operations SET request_json = ?, request_digest = ?, binding_digest = ? WHERE operation_id = ?')
      .run(JSON.stringify(request), controlPlaneDigest(request), controlPlaneDigest(binding), operationId) } finally { db.close() }
  }
  const legacy = (operationId: string) => {
    const operation = store.getHostAttestationOperation(operationId)
    if (operation.request.schemaVersion !== 2) throw new Error('expected schema 2 source fixture')
    const { predecessor: _predecessor, ...base } = operation.request
    const request: StoredHostAttestationRequest = { ...base, schemaVersion: 1 }
    writeRequest(operationId, request)
    const receipt = receiptFor(request)
    const { signature, ...fields } = receipt
    const verified = { ...fields, signatureDigest: createHash('sha256').update(Buffer.from(signature, 'base64')).digest('hex') }
    const db = new DatabaseSync(path)
    try {
      db.prepare('UPDATE host_attestation_operations SET receipt_json = ?, receipt_digest = ? WHERE operation_id = ?')
        .run(JSON.stringify(receipt), controlPlaneDigest(receipt), operationId)
      if (operation.status === 'applied') db.prepare('UPDATE host_attestations SET receipt_json = ?, receipt_digest = ? WHERE plan_id = ? AND phase = ?')
        .run(JSON.stringify(verified), controlPlaneDigest(receipt), plan.id, operation.phase)
    } finally { db.close() }
    store.close(); stores.delete(store); store = new ControlPlaneStore({ path, now: () => now }); stores.add(store)
    return { request, receipt }
  }
  return { get store() { return store }, get plan() { return plan }, path, reload, prepare, receiptFor, run, apply, writeRequest, legacy, authority }
}

test.each(['missing', 'foreign-operation', 'wrong-digest', 'wrong-phase'] as const)('refuses a %s predecessor before dispatch even if request hashes agree', async kind => {
  const f = await fixture(); const op = f.prepare({ kind: 'readiness', minimumChecks: 1 })
  const predecessor = op.request.predecessor!
  const request: HostAttestationRequest = { ...op.request, predecessor: kind === 'missing' ? null
    : kind === 'foreign-operation' ? { ...predecessor, operationId: 'another-operation' }
      : kind === 'wrong-digest' ? { ...predecessor, receiptDigest: 'f'.repeat(64) } : { ...predecessor, phase: 'health' } }
  f.writeRequest(op.operationId, request)
  let calls = 0
  await expect(f.store.runHostAttestationOperation({ operationId: op.operationId, expectedRevision: f.plan.revision,
    expectedFence: f.plan.activation!.fence, execute: async () => { calls++; return f.receiptFor(request) }, resolveAuthority: () => f.authority }))
    .rejects.toThrow(/predecessor|legacy/u)
  expect(calls).toBe(0)
  expect(f.store.getPlan(f.plan.id).status).toBe('awaiting-readiness')
  expect(f.store.getHostAttestationOperation(op.operationId).status).toBe('pending')
})

test('independent signature verification rejects a signed request with the wrong predecessor phase', async () => {
  const f = await fixture(); const op = f.prepare({ kind: 'readiness', minimumChecks: 1 })
  const request: HostAttestationRequest = { ...op.request, predecessor: { ...op.request.predecessor!, phase: 'health' } }
  await expect(f.authority.verify(f.receiptFor(request), f.plan, request)).rejects.toThrow('preceding phase')
})

test.each([
  { hostGeneration: 1, outcome: 'passed' }, { hostGeneration: 1, outcome: 'failed' },
  { hostGeneration: 3, outcome: 'passed' }, { hostGeneration: 3, outcome: 'failed' },
] as const)('refuses correctly signed normal receipt generation $hostGeneration with outcome $outcome', async overrides => {
  const f = await fixture(); const op = f.prepare({ kind: 'readiness', minimumChecks: 1 })
  const receipt = f.receiptFor(op.request, overrides)
  await expect(f.authority.verify(receipt, f.plan, op.request)).rejects.toThrow(/generation/u)
  await expect(f.run(op.operationId, receipt)).rejects.toThrow(/generation/u)
  expect(f.store.getHostAttestationOperation(op.operationId).status).toBe('pending')
  expect(f.store.getPlan(f.plan.id).status).toBe('awaiting-readiness')
})

test('completed successor cannot apply after its predecessor signed bytes change', async () => {
  const f = await fixture(); const op = f.prepare({ kind: 'readiness', minimumChecks: 1 })
  const receipt = f.receiptFor(op.request)
  await f.run(op.operationId, receipt)
  // Simulate an independently signed historical replacement after reservation.
  // Its semantics and generation agree, but its full signed digest is different.
  f.legacy(f.reload.operationId)
  const stored = f.store.getHostAttestationOperation(op.operationId)
  await expect(f.apply(receipt)).rejects.toThrow(/predecessor/u)
  expect(f.store.getHostAttestationOperation(op.operationId)).toEqual(stored)
  expect(f.store.getPlan(f.plan.id).status).toBe('awaiting-readiness')
})

test('legacy completed operation remains inspectable across reopen but cannot dispatch or apply', async () => {
  const f = await fixture(); const op = f.prepare({ kind: 'readiness', minimumChecks: 1 })
  await f.run(op.operationId, f.receiptFor(op.request))
  const prior = f.legacy(op.operationId)
  const stored = f.store.getHostAttestationOperation(op.operationId)
  expect(stored).toMatchObject({ status: 'completed', request: prior.request, receipt: prior.receipt })
  let calls = 0
  await expect(f.store.runHostAttestationOperation({ operationId: op.operationId, expectedRevision: f.plan.revision, expectedFence: f.plan.activation!.fence,
    execute: async () => { calls++; return prior.receipt }, resolveAuthority: () => f.authority })).rejects.toThrow('legacy')
  await expect(f.apply(prior.receipt)).rejects.toThrow('legacy')
  expect(calls).toBe(0)
  expect(f.store.getHostAttestationOperation(op.operationId)).toEqual(stored)
  expect(f.store.getPlan(f.plan.id).status).toBe('awaiting-readiness')
})

test('new schema-2 phase binds original schema-1 applied signed receipt without rewriting history', async () => {
  const f = await fixture(); const prior = f.legacy(f.reload.operationId)
  const stored = f.store.getHostAttestationOperation(f.reload.operationId)
  const op = f.prepare({ kind: 'readiness', minimumChecks: 1 })
  expect(op.request.predecessor).toEqual({ operationId: f.reload.operationId, receiptId: prior.receipt.receiptId,
    phase: 'reload', receiptDigest: controlPlaneDigest(prior.receipt), hostGeneration: 2 })
  const receipt = f.receiptFor(op.request)
  await f.run(op.operationId, receipt)
  expect((await f.apply(receipt)).status).toBe('awaiting-effect-blocked-replay')
  expect(f.store.getHostAttestationOperation(f.reload.operationId)).toEqual(stored)
})
