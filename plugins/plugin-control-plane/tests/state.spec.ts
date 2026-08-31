import { generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { approvalSigningPayload, Ed25519ApprovalAuthority } from '../src/approval.ts'
import { exampleIntegrityPinnedCatalog } from '../src/catalog.ts'
import { hostAttestationEvidenceDigest, hostAttestationSigningPayload, Ed25519HostAttestationAuthority } from '../src/attestation.ts'
import { controlPlaneSchemaVersion, openControlPlaneDatabase } from '../src/sqlite.ts'
import { controlPlaneDigest, ControlPlaneStore, type CreateActivationPlanInput } from '../src/store.ts'
import type { ApprovalReceipt, HostAttestationReceipt, PluginActivationPlan } from '../src/types.ts'

const roots: string[] = []
const candidate = exampleIntegrityPinnedCatalog.entries.find(item => item.id === 'assistant-health')!
const installationId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00'

async function fixture(now = 1_800_000_000_000) {
  const root = await mkdtemp(join(tmpdir(), 'control-plane-state-')); roots.push(root)
  let clock = now; const path = join(root, 'state.sqlite')
  const store = new ControlPlaneStore({ path, now: () => clock })
  return { root, path, store, now: () => clock, setNow: (value: number) => { clock = value } }
}

function gap(store: ControlPlaneStore, suffix: string, value = 100) {
  return store.recordGap({ idempotencyKey: `gap:health:${suffix}`, capability: 'health', context: `health gap ${suffix}`,
    expectedValue: value, frequency: 10, estimatedCost: 50, risk: 0.2 })
}

function activationInput(root: string, gapId: string, idempotencyKey: string): CreateActivationPlanInput {
  return { candidate, catalog: { digest: controlPlaneDigest(exampleIntegrityPinnedCatalog), provenance: 'owner-provided-integrity-pinned' },
    matchedCapabilities: candidate.capabilities, profile: 'web', target: { dshHome: root, profile: 'web', profilePath: join(root, 'profiles', 'web') },
    installationId, ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: join(root, 'control.sqlite') },
    executor: { id: 'dsh', version: '0.1.0-rc.8', path: join(root, 'bin', 'dsh'), sha256: 'd'.repeat(64) },
    ttlMs: 60_000, gapId, idempotencyKey }
}

function approval(plan: PluginActivationPlan, now: number) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const unsigned: Omit<ApprovalReceipt, 'signature'> = { schemaVersion: 1, approvalId: `approval-${plan.id.slice(-12)}`,
    authority: 'owner-policy', keyId: 'owner-key-1', planId: plan.id, planDigest: plan.digest, decision: 'approved',
    principal: 'owner@example.test', decidedAt: now, expiresAt: now + 10_000 }
  const receipt: ApprovalReceipt = { ...unsigned, signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), privateKey).toString('base64') }
  const authority = new Ed25519ApprovalAuthority(publicKey.export({ format: 'pem', type: 'spki' }), 'owner-policy', 'owner-key-1', () => now)
  return { receipt, authority }
}

async function approved(target: Awaited<ReturnType<typeof fixture>>, suffix: string): Promise<PluginActivationPlan> {
  const plan = target.store.createPlan(activationInput(target.root, gap(target.store, suffix).id, `plan:${suffix}`)).result
  const signed = approval(plan, target.now() + 1)
  return (await target.store.approve({ planId: plan.id, expectedRevision: plan.revision, receipt: signed.receipt,
    resolveAuthority: () => signed.authority, idempotencyKey: `approval:${suffix}` })).result
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('bound durable control-plane state', () => {
  test('ranks bounded ROI, snapshots exact gap evidence and enforces one active plan per gap', async () => {
    const target = await fixture(); const low = gap(target.store, 'low', 10); const high = gap(target.store, 'high', 100)
    expect(target.store.listGaps().map(item => item.id)).toEqual([high.id, low.id])
    expect(high).toMatchObject({ revision: 1, inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), roi: 16 })
    const input = activationInput(target.root, high.id, 'plan:ranked')
    const first = target.store.createPlan(input)
    expect(first.result).toMatchObject({ schemaVersion: 4, kind: 'activation', installationId,
      gapSnapshot: { revision: 1, inputDigest: high.inputDigest, roi: high.roi },
      dossier: { catalogProvenance: 'owner-provided-integrity-pinned' } })
    expect(target.store.createPlan(input)).toEqual(first)
    expect(() => target.store.createPlan({ ...input, idempotencyKey: 'plan:second' })).toThrow('only an open gap')
    expect(() => target.store.createSourcePlan({ gapId: high.id, repository: '/repo', worktree: '/worktree',
      baseCommit: 'a'.repeat(40), name: 'health-helper', generatorDigest: 'b'.repeat(64), scope: ['plugins/health-helper'],
      ttlMs: 60_000, idempotencyKey: 'source:same-gap' })).toThrow('only an open gap')
  })

  test('rejects candidates that do not match the exact gap capability', async () => {
    const target = await fixture(); const mismatch = target.store.recordGap({ idempotencyKey: 'gap:calendar', capability: 'calendar',
      context: 'calendar gap', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
    expect(() => target.store.createPlan(activationInput(target.root, mismatch.id, 'plan:mismatch'))).toThrow('does not match')
  })

  test('looks up an exact durable approval replay before expiry or authority verification', async () => {
    const target = await fixture(); const plan = target.store.createPlan(activationInput(target.root, gap(target.store, 'replay').id, 'plan:replay')).result
    const signed = approval(plan, target.now() + 1)
    const first = await target.store.approve({ planId: plan.id, expectedRevision: 1, receipt: signed.receipt,
      resolveAuthority: () => signed.authority, idempotencyKey: 'approval:replay' })
    target.setNow(target.now() + 20_000)
    const replay = await target.store.approve({ planId: plan.id, expectedRevision: 1, receipt: signed.receipt,
      resolveAuthority: () => { throw new Error('must not resolve on exact replay') }, idempotencyKey: 'approval:replay' })
    expect(replay).toEqual(first)
    await expect(target.store.approve({ planId: plan.id, expectedRevision: 1, receipt: { ...signed.receipt, signature: `${signed.receipt.signature.slice(0, -2)}AA` },
      resolveAuthority: () => signed.authority, idempotencyKey: 'approval:replay' })).rejects.toThrow('reused with different input')
  })

  test('binds source plans to repository/base/worktree/name/generator/scope and CASes local terminal state', async () => {
    const target = await fixture(); const sourceGap = gap(target.store, 'source')
    const plan = target.store.createSourcePlan({ gapId: sourceGap.id, repository: '/canonical/repository', worktree: '/canonical/worktree',
      baseCommit: 'a'.repeat(40), name: 'health-helper', generatorDigest: 'b'.repeat(64), scope: ['plugins/health-helper'],
      ttlMs: 60_000, idempotencyKey: 'source:create' }).result
    expect(plan).toMatchObject({ kind: 'source', repository: '/canonical/repository', worktree: '/canonical/worktree',
      baseCommit: 'a'.repeat(40), name: 'health-helper', generatorDigest: 'b'.repeat(64), scope: ['plugins/health-helper'] })
    const signed = approval(plan as unknown as PluginActivationPlan, target.now() + 1)
    const approvedPlan = (await target.store.approveSource({ planId: plan.id, expectedRevision: 1, receipt: signed.receipt,
      resolveAuthority: () => signed.authority, idempotencyKey: 'source:approval' })).result
    const running = target.store.beginSourceChecks({ planId: plan.id, expectedRevision: approvedPlan.revision })
    expect(() => target.store.beginSourceChecks({ planId: plan.id, expectedRevision: approvedPlan.revision })).toThrow('changed')
    expect(target.store.finishSourceChecks({ planId: plan.id, expectedRevision: running.revision, succeeded: true }).status).toBe('ready-for-human-review')
  })

  test('heartbeats one worker, recovers past plan expiry only after lease expiry, and fences the old worker', async () => {
    const target = await fixture(); const approvedPlan = await approved(target, 'lease')
    const first = target.store.claimActivation({ planId: approvedPlan.id, expectedRevision: approvedPlan.revision, leaseMs: 5_000 })
    const other = new ControlPlaneStore({ path: target.path, now: target.now })
    expect(() => other.claimActivation({ planId: first.id, expectedRevision: first.revision, leaseMs: 5_000 })).toThrow('cannot be claimed')
    target.setNow(target.now() + 4_000); target.store.heartbeatActivation({ planId: first.id, expectedRevision: first.revision, fence: first.activation!.fence, leaseMs: 5_000 })
    target.setNow(1_800_000_070_000) // The approval plan is expired, but a started activation remains recoverable.
    const recovered = other.claimActivation({ planId: first.id, expectedRevision: first.revision, leaseMs: 5_000 })
    expect(recovered.activation).toMatchObject({ id: first.activation!.id, fence: first.activation!.fence + 1 })
    expect(() => target.store.heartbeatActivation({ planId: first.id, expectedRevision: first.revision, fence: first.activation!.fence, leaseMs: 5_000 })).toThrow('lost')
    other.close()
  })

  test('holds the cross-process SQLite filesystem mutex even after the visible lease deadline', async () => {
    const target = await fixture(); const approvedPlan = await approved(target, 'filesystem-mutex')
    const claimed = target.store.claimActivation({ planId: approvedPlan.id, expectedRevision: approvedPlan.revision, leaseMs: 5_000 })
    await target.store.withActivationFileSystemGuard({ planId: claimed.id, expectedRevision: claimed.revision,
      fence: claimed.activation!.fence, status: claimed.status, leaseMs: 5_000 }, async () => {
      target.setNow(target.now() + 10_000)
      const probe = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA busy_timeout=100'); try { db.exec('BEGIN IMMEDIATE'); process.stdout.write('acquired'); db.exec('ROLLBACK') }
catch { process.stdout.write('busy') } finally { db.close() }`
      expect(execFileSync(process.execPath, ['-e', probe, target.path], { encoding: 'utf8' })).toBe('busy')
    })
    expect(target.store.getPlan(claimed.id).activation?.fence).toBe(claimed.activation!.fence)
  })

  test('accepts only exact signed typed Host phases and never treats configuration validation as activation', async () => {
    const target = await fixture(); const approvedPlan = await approved(target, 'attestation')
    let plan = target.store.claimActivation({ planId: approvedPlan.id, expectedRevision: approvedPlan.revision, leaseMs: 5_000 })
    plan = target.store.advanceActivation({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence, from: 'staging', to: 'awaiting-reload' })
    const operation = target.store.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision,
      expectedFence: plan.activation!.fence, issuer: { mode: 'owner-manual' }, requirements: { kind: 'reload', previousHostGeneration: 0 }, receiptTtlMs: 10_000 })
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const evidence = { kind: 'reload' as const, reloaded: true, previousHostGeneration: 0, currentHostGeneration: 7, probeDigest: 'c'.repeat(64) }
    const unsigned: Omit<HostAttestationReceipt, 'signature'> = { schemaVersion: 2, receiptId: 'host-reload-1', authority: 'host-runtime', keyId: 'host-key-1',
      installationId, planId: plan.id, planDigest: plan.digest, activationId: plan.activation!.id, fence: plan.activation!.fence,
      operationId: operation.operationId, requestDigest: operation.requestDigest, phase: 'reload', outcome: 'passed', hostGeneration: 7,
      evidence, evidenceDigest: hostAttestationEvidenceDigest(evidence), observedAt: target.now(), expiresAt: target.now() + 10_000 }
    const receipt: HostAttestationReceipt = { ...unsigned, signature: sign(null, Buffer.from(hostAttestationSigningPayload(unsigned)), privateKey).toString('base64') }
    const authority = new Ed25519HostAttestationAuthority(publicKey.export({ type: 'spki', format: 'pem' }), 'host-runtime', 'host-key-1', target.now)
    await target.store.runHostAttestationOperation({ operationId: operation.operationId, expectedRevision: plan.revision,
      expectedFence: plan.activation!.fence, execute: async () => receipt, resolveAuthority: () => authority })
    const result = await target.store.applyHostAttestation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.activation!.fence,
      receipt, resolveAuthority: () => authority, idempotencyKey: 'host:reload' })
    expect(result.result.status).toBe('awaiting-readiness')
    expect(target.store.health().activeActivations).toBe(1)
    target.setNow(target.now() + 20_000)
    expect(await target.store.applyHostAttestation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.activation!.fence,
      receipt, resolveAuthority: () => { throw new Error('must not resolve expired exact replay') }, idempotencyKey: 'host:reload' })).toEqual(result)
    await expect(target.store.applyHostAttestation({ planId: plan.id, expectedRevision: result.result.revision,
      expectedFence: plan.activation!.fence, receipt: { ...receipt, receiptId: 'wrong-phase', phase: 'health' },
      resolveAuthority: () => authority, idempotencyKey: 'host:wrong' })).rejects.toThrow()
  })

  test('quarantines schema-v3 plans that lack installation/target/executor/attestation bindings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'control-plane-v3-')); roots.push(root); const path = join(root, 'legacy.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE capability_gaps (id TEXT PRIMARY KEY);
      CREATE TABLE activation_plans (id TEXT PRIMARY KEY, arbitrary TEXT);
      INSERT INTO activation_plans VALUES ('old-plan', 'unbound');
      CREATE TABLE operation_receipts (idempotency_key TEXT PRIMARY KEY, operation TEXT, input_digest TEXT, result_json TEXT, created_at INTEGER);
      CREATE TABLE quarantined_legacy_plans (source TEXT PRIMARY KEY, reason TEXT NOT NULL, payload_json TEXT NOT NULL, quarantined_at INTEGER NOT NULL);
      PRAGMA user_version = 3;
    `)
    legacy.close(); await chmod(path, 0o600)
    const migrated = openControlPlaneDatabase(path)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(controlPlaneSchemaVersion)
    expect((migrated.prepare('SELECT count(*) AS count FROM quarantined_legacy_plans').get() as { count: number }).count).toBe(1)
    expect((migrated.prepare('SELECT count(*) AS count FROM activation_plans').get() as { count: number }).count).toBe(0)
    migrated.close()
  })

  test('migrates schema-v6 ledgers by adding durable operation tables without changing existing rows', async () => {
    const target = await fixture(); const before = target.store.recordGap({ idempotencyKey: 'gap:migrate-v6', capability: 'health',
      context: 'migration evidence', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 }); target.store.close()
    const legacy = new DatabaseSync(target.path)
    legacy.exec('DROP TABLE host_attestation_operations; DROP TABLE source_release_operations; PRAGMA user_version = 6;'); legacy.close(); await chmod(target.path, 0o600)
    const migrated = openControlPlaneDatabase(target.path)
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(controlPlaneSchemaVersion)
    expect((migrated.prepare('SELECT capability FROM capability_gaps WHERE id = ?').get(before.id) as { capability: string }).capability).toBe('health')
    expect((migrated.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'host_attestation_operations'").get() as { count: number }).count).toBe(1)
    expect((migrated.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'source_release_operations'").get() as { count: number }).count).toBe(1)
    migrated.close()
  })

  test('health exposes only fixed aggregate counters', async () => {
    const target = await fixture(); gap(target.store, 'health-counter')
    expect(target.store.health()).toEqual({ gaps: 1, readyPlans: 0, activeActivations: 0, failed: 0, rollbackPending: 0 })
    expect(Object.keys(target.store.health()).sort()).toEqual(['activeActivations', 'failed', 'gaps', 'readyPlans', 'rollbackPending'].sort())
  })
})
