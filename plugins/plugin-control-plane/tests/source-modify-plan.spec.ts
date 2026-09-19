import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { approvalSigningPayload, Ed25519ApprovalAuthority } from '../src/approval.ts'
import { ControlPlaneStore, MODIFY_GENERATOR_DIGEST } from '../src/store.ts'
import type { ApprovalReceipt, PluginSourcePlan, SourcePreparedEvidence } from '../src/types.ts'

// 工程层、非真实供应商证据：本文件的 prepared evidence 全是字面量 fixture，
// 只验证 store 对 modify source plan 的状态机与校验，不代表任何真实构建。

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const hex = (character: string) => character.repeat(64)
const TTL_MS = 60_000

function validEvidence(overrides?: Partial<SourcePreparedEvidence>): SourcePreparedEvidence {
  return {
    schemaVersion: 1, kind: 'dsh-source-prepared-evidence',
    environment: { npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true, nodeVersion: 'v22.0.0', pnpmVersion: '9.0.0' },
    commands: [
      { command: 'pnpm', args: ['install', '--frozen-lockfile', '--ignore-scripts', '--offline'], exitCode: 0, durationMs: 4200, logDigest: hex('a') },
      { command: 'pnpm', args: ['check'], exitCode: 0, durationMs: 8100, logDigest: hex('b') },
      { command: 'pnpm', args: ['pack'], exitCode: 0, durationMs: 600, logDigest: hex('c') },
    ],
    pack: { name: 'dsh-enhanced-health-helper-0.1.0.tgz', version: '0.1.0', sizeBytes: 12_345, sha256: hex('d') },
    preparedAt: 1_800_000_000_500, ...overrides,
  }
}

async function fixture(now = 1_800_000_000_000) {
  const root = await mkdtemp(join(tmpdir(), 'control-plane-modify-')); roots.push(root)
  let clock = now; const path = join(root, 'state.sqlite')
  const store = new ControlPlaneStore({ path, now: () => clock })
  const recordGap = (suffix: string) => store.recordGap({ idempotencyKey: `gap:modify:${suffix}`, capability: 'health',
    context: `health gap ${suffix}`, expectedValue: 100, frequency: 10, estimatedCost: 50, risk: 0.2 })
  return { root, path, store, now: () => clock, setNow: (value: number) => { clock = value }, recordGap }
}

type Target = Awaited<ReturnType<typeof fixture>>

function modifyInput(gapId: string, suffix: string, evidence = validEvidence(), scope = ['plugins/health-helper']) {
  return { gapId, repository: '/canonical/repository', worktree: `/canonical/worktrees/${suffix}`,
    baseCommit: 'a'.repeat(40), name: 'health-helper', generatorDigest: MODIFY_GENERATOR_DIGEST,
    scope, mode: 'modify' as const, ttlMs: TTL_MS, idempotencyKey: `source:modify:${suffix}`,
    prepared: { treeDigest: hex('1'), patchDigest: hex('2'), checkedAt: 1_800_000_000_500, evidence } }
}

function signApproval(plan: PluginSourcePlan, now: number) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const unsigned: Omit<ApprovalReceipt, 'signature'> = { schemaVersion: 1, approvalId: `approval-${plan.id.slice(-12)}`,
    authority: 'owner-policy', keyId: 'owner-key-1', planId: plan.id, planDigest: plan.digest, decision: 'approved',
    principal: 'owner@example.test', decidedAt: now, expiresAt: now + 10_000 }
  const receipt: ApprovalReceipt = { ...unsigned,
    signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), privateKey).toString('base64') }
  const authority = new Ed25519ApprovalAuthority(publicKey.export({ format: 'pem', type: 'spki' }),
    'owner-policy', 'owner-key-1', () => now)
  return { receipt, authority }
}

async function approveModify(target: Target, plan: PluginSourcePlan, decidedAt = target.now() + 1_000) {
  const signed = signApproval(plan, decidedAt)
  const result = (await target.store.approveSource({ planId: plan.id, expectedRevision: plan.revision, receipt: signed.receipt,
    resolveAuthority: () => signed.authority, idempotencyKey: `source:modify-approval:${plan.id}` })).result
  return { result, receipt: signed.receipt, authority: signed.authority }
}

describe('modify source plans (engineering-layer fixtures, not vendor evidence)', () => {
  it('creates a pending modify plan carrying checked digests and frozen-build evidence', async () => {
    const target = await fixture()
    const gap = target.recordGap('ok')
    const receipt = target.store.createSourcePlan(modifyInput(gap.id, 'ok'))
    const plan = receipt.result
    expect(plan.mode).toBe('modify')
    expect(plan.status).toBe('pending-approval')
    expect(plan.revision).toBe(1)
    expect(plan.scope).toEqual(['plugins/health-helper'])
    expect(plan.sourceCheck).toEqual({ treeDigest: hex('1'), patchDigest: hex('2'), checkedAt: 1_800_000_000_500 })
    expect(plan.preparedEvidence?.kind).toBe('dsh-source-prepared-evidence')
    expect(plan.preparedEvidence?.environment.npmConfigIgnoreScripts).toBe(true)
    expect(plan.preparedEvidence?.pack.sha256).toBe(hex('d'))
    expect(target.store.getGap(gap.id).status).toBe('matched')

    // Idempotent replay with the same input returns the same plan, no second row.
    const replayed = target.store.createSourcePlan(modifyInput(gap.id, 'ok'))
    expect(replayed.result.id).toBe(plan.id)
    expect(target.store.getGap(gap.id).status).toBe('matched')
  })

  const builds: Array<[string, number, (gapId: string, suffix: string) => ReturnType<typeof modifyInput>]> = [
    ['missing prepared evidence', 0, (gapId, suffix) => {
      const input = modifyInput(gapId, suffix); delete (input as { prepared?: unknown }).prepared; return input
    }],
    ['create scope including plugins/README.md', 1, (gapId, suffix) =>
      modifyInput(gapId, suffix, validEvidence(), ['plugins/README.md', 'plugins/health-helper'])],
    ['a free-form generator digest instead of the modify constant', 2, (gapId, suffix) =>
      ({ ...modifyInput(gapId, suffix), generatorDigest: hex('9') })],
    ['prepared evidence with an unknown top-level key', 3, (gapId, suffix) =>
      modifyInput(gapId, suffix, { ...validEvidence(), unexpected: true } as SourcePreparedEvidence)],
    ['a non-hex pack sha256', 4, (gapId, suffix) =>
      modifyInput(gapId, suffix, validEvidence({ pack: { ...validEvidence().pack, sha256: 'z'.repeat(64) } }))],
    ['a command that exited non-zero', 5, (gapId, suffix) =>
      modifyInput(gapId, suffix, validEvidence({
        commands: [{ ...validEvidence().commands[0]!, exitCode: 1 as 0 }] }))],
  ]
  it.each(builds)('rejects %s without writing a plan or reserving the gap', async (_label, index, build) => {
    const target = await fixture()
    const suffix = `bad-${index}`
    const gap = target.recordGap(suffix)
    expect(() => target.store.createSourcePlan(build(gap.id, suffix))).toThrow()
    expect(target.store.getGap(gap.id).status).toBe('open')
    expect(target.store.listGaps().map(item => item.candidateId)).toEqual([undefined])
  })

  it('rejects a create plan carrying prepared evidence', async () => {
    const target = await fixture()
    const gap = target.recordGap('create-with-evidence')
    const input = modifyInput(gap.id, 'create-with-evidence')
    const createInput = { ...input, mode: 'create' as const,
      scope: ['plugins/README.md', 'plugins/health-helper'], generatorDigest: hex('b') }
    expect(() => target.store.createSourcePlan(createInput)).toThrow('create source plans cannot carry prepared evidence')
    expect(target.store.getGap(gap.id).status).toBe('open')
  })

  it('approves a modify plan while preserving its evidence, and replays idempotently', async () => {
    const target = await fixture()
    const gap = target.recordGap('approve')
    const created = target.store.createSourcePlan(modifyInput(gap.id, 'approve')).result
    const approval = await approveModify(target, created)
    const approved = approval.result
    expect(approved.status).toBe('approved')
    expect(approved.revision).toBe(2)
    expect(approved.sourceCheck).toEqual(created.sourceCheck)
    expect(approved.preparedEvidence).toEqual(created.preparedEvidence)

    // Replaying the same approval with the same signed receipt returns the
    // identical approved snapshot (ed25519 signatures are randomized, so a
    // freshly signed receipt would legitimately count as different input).
    const replayed = (await target.store.approveSource({ planId: created.id, expectedRevision: 1,
      receipt: approval.receipt, resolveAuthority: () => approval.authority,
      idempotencyKey: `source:modify-approval:${created.id}` })).result
    expect(replayed.revision).toBe(2)
    expect(replayed.status).toBe('approved')
    expect(replayed.sourceCheck).toBeDefined()
    expect(replayed.preparedEvidence).toBeDefined()
  })

  it('keeps the state unchanged when prepared verification digests do not match', async () => {
    const target = await fixture()
    const gap = target.recordGap('verify-drift')
    const created = target.store.createSourcePlan(modifyInput(gap.id, 'verify-drift')).result
    const { result: approved } = await approveModify(target, created)
    expect(() => target.store.verifyPreparedSourcePlan({ planId: approved.id, expectedRevision: 2,
      recheckedTreeDigest: hex('f'), recheckedPatchDigest: hex('2') })).toThrow('drifted')
    const untouched = target.store.getSourcePlan(approved.id)
    expect(untouched.status).toBe('approved')
    expect(untouched.revision).toBe(2)
  })

  it('advances an approved modify plan straight to ready-for-human-review on exact digest match', async () => {
    const target = await fixture()
    const gap = target.recordGap('verify-ok')
    const created = target.store.createSourcePlan(modifyInput(gap.id, 'verify-ok')).result
    const { result: approved } = await approveModify(target, created)
    const receipt = target.store.verifyPreparedSourcePlan({ planId: approved.id, expectedRevision: 2,
      recheckedTreeDigest: hex('1'), recheckedPatchDigest: hex('2') })
    expect(receipt.result.status).toBe('ready-for-human-review')
    expect(receipt.result.revision).toBe(3)
    expect(receipt.result.sourceCheck).toEqual(created.sourceCheck)
    expect(receipt.operation).toBe('source-verify-prepared')
    // Verification is one-shot: the plan is no longer in the approved state.
    expect(() => target.store.verifyPreparedSourcePlan({ planId: approved.id, expectedRevision: 3,
      recheckedTreeDigest: hex('1'), recheckedPatchDigest: hex('2') })).toThrow('approved before verification')
  })

  it('refuses the local scaffold checks path for modify plans', async () => {
    const target = await fixture()
    const gap = target.recordGap('no-scaffold')
    const created = target.store.createSourcePlan(modifyInput(gap.id, 'no-scaffold')).result
    // Even after approval, modify plans never enter running-local-checks.
    const { result: approved } = await approveModify(target, created)
    expect(() => target.store.beginSourceChecks({ planId: approved.id, expectedRevision: 2 }))
      .toThrow('verified, not locally scaffolded')
    expect(() => target.store.finishSourceChecks({ planId: approved.id, expectedRevision: 2, succeeded: true,
      checkedTreeDigest: hex('1'), checkedPatchDigest: hex('2') })).toThrow('verified, not locally scaffolded')
    expect(target.store.getSourcePlan(approved.id).status).toBe('approved')
  })

  it('rejects approval and prepared verification after the plan TTL expires', async () => {
    const target = await fixture()
    const gap = target.recordGap('expired')
    const created = target.store.createSourcePlan(modifyInput(gap.id, 'expired')).result

    // Approval past the plan TTL is refused (the receipt is also bound by the
    // plan's [createdAt, expiresAt] window, so the authority rejects it too).
    target.setNow(created.expiresAt + 1)
    const stale = signApproval(created, target.now())
    await expect(target.store.approveSource({ planId: created.id, expectedRevision: 1, receipt: stale.receipt,
      resolveAuthority: () => stale.authority, idempotencyKey: 'source:modify-approval:expired' })).rejects.toThrow()
    expect(target.store.getSourcePlan(created.id).status).toBe('pending-approval')

    // A plan approved inside its window cannot be verified after it expires.
    target.setNow(created.createdAt + 1_000)
    const { result: approved } = await approveModify(target, created, created.createdAt + 1_000)
    target.setNow(approved.expiresAt + 1)
    expect(() => target.store.verifyPreparedSourcePlan({ planId: approved.id, expectedRevision: 2,
      recheckedTreeDigest: hex('1'), recheckedPatchDigest: hex('2') })).toThrow('no longer applicable')
    expect(target.store.getSourcePlan(approved.id).status).toBe('approved')
  })
})


it.each([false, true])('expires a prepared plan once and durably releases its gap (approved=%s)', async alreadyApproved => {
  const target = await fixture()
  try {
    const gap = target.recordGap('expiry')
    const plan = target.store.createSourcePlan(modifyInput(gap.id, 'expiry')).result
    const approved = alreadyApproved ? (await approveModify(target, plan)).result : plan
    expect(() => target.store.expirePreparedSourcePlan({ planId: plan.id, expectedRevision: approved.revision, now: plan.expiresAt })).toThrow(/not expired/)
    target.setNow(plan.expiresAt + 1)
    const expired = target.store.expirePreparedSourcePlan({ planId: plan.id, expectedRevision: approved.revision, now: target.now() })
    expect(expired).toMatchObject({ status: 'expired', revision: approved.revision + 1 })
    expect(target.store.getGap(gap.id).status).toBe('open')
    expect(target.store.expirePreparedSourcePlan({ planId: plan.id, expectedRevision: approved.revision, now: target.now() })).toEqual(expired)
    const reopened = new ControlPlaneStore({ path: target.path, now: target.now })
    try { expect(reopened.expirePreparedSourcePlan({ planId: plan.id, expectedRevision: approved.revision, now: target.now() })).toEqual(expired) }
    finally { reopened.close() }
    expect(() => target.store.verifyPreparedSourcePlan({ planId: plan.id, expectedRevision: expired.revision,
      recheckedTreeDigest: plan.sourceCheck!.treeDigest, recheckedPatchDigest: plan.sourceCheck!.patchDigest })).toThrow(/must be approved/)
    const next = modifyInput(gap.id, 'after-expiry')
    next.prepared.checkedAt = target.now()
    expect(target.store.createSourcePlan(next).result.status).toBe('pending-approval')
    expect(target.store.getGap(gap.id).status).toBe('matched')
    target.store.expirePreparedSourcePlan({ planId: plan.id, expectedRevision: expired.revision, now: target.now() })
    expect(target.store.getGap(gap.id).status).toBe('matched')
  } finally { target.store.close() }
})

it('rejects replaying one idempotency key with different prepared source bytes', async () => {
  const target = await fixture()
  try {
    const gap = target.recordGap('different-patch')
    const input = modifyInput(gap.id, 'different-patch')
    target.store.createSourcePlan(input)
    expect(() => target.store.createSourcePlan({ ...input,
      prepared: { ...input.prepared, patchDigest: hex('f') } })).toThrow(/idempotency/)
  } finally { target.store.close() }
})
