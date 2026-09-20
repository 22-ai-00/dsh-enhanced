import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AssistantEvaluationService, EvaluationStore } from '@dsh-enhanced/assistant-evaluation'
import type { OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import { afterEach, expect, test, vi } from 'vitest'
import { OwnerTaskFailureGaps } from '../src/owner-task-gaps.ts'
import { approvalSigningPayload, Ed25519ApprovalAuthority } from '../src/approval.ts'
import { ControlPlaneStore, MODIFY_GENERATOR_DIGEST } from '../src/store.ts'

// Real Evaluation canonical projections/fences and CP persistence. Delivery's
// proof lookup is a fixture; its native owner verification is tested in Delivery.
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cp-task-gaps-')))
  const ctx = new Context()
  await ctx.plugin(AssistantEvaluationService, { databasePath: join(root, 'evaluation.sqlite'), projectionIntervalMs: 0 })
  const evaluation = ctx.assistantEvaluation
  const producer = new EvaluationStore({ path: join(root, 'evaluation.sqlite') })
  const store = new ControlPlaneStore({ path: join(root, 'control.sqlite') })
  cleanup.push(async () => { producer.close(); store.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const scope = evaluation.canonicalHostScope({ workspace: root, preset: 'primary' })
  const append = (key: string, ref = 'inbox-1', status: 'not-achieved' | 'achieved' | 'unknown' = 'not-achieved') => producer.append({
    scope: { workspace: root, preset: 'primary' }, situation: `foreground:${ref}`, executionStatus: 'succeeded',
    objectiveStatus: status, deliveryStatus: 'delivered', trust: 'trusted',
    source: { kind: 'evaluator', id: 'assistant-verifier' }, evaluator: { id: 'assistant-verifier', version: '1' },
    evidence: [{ kind: 'foreground-turn', ref }, { kind: 'acceptance-contract', ref: 'contract' }, { kind: 'verification-receipt', ref: key }],
    metrics: {}, occurredAt: Date.now(), idempotencyKey: key,
  })
  const task = append('first')
  const owner = { receiptVersion: 2 as const, authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner',
    principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  const source = (): OwnerForegroundLearningTask => ({ protocol: 'assistant-delivery/owner-foreground-learning/v1', owner: { ...owner },
    canonical: evaluation.getTrustedTaskLearningProjection({ scope, outcomeId: task.id })!, judgement: 'independent-verifier',
    source: { sessionId: 'session', inboxId: 'inbox-1', objective: 'private original task', truncated: false, quiescent: true,
      modelSelectionState: 'frozen', modelSelection: { provider: 'supplier', model: 'task-model' } } })
  const inspect = vi.fn((input: { authorityId: string; principalId: string; workspace: string; agentPreset: string; outcomeId: string }) =>
    input.authorityId === owner.authorityId && input.principalId === owner.principalId && input.workspace === root
      && input.agentPreset === owner.agentPreset && input.outcomeId === task.id ? source() : undefined)
  const gateway = new OwnerTaskFailureGaps(store, () => ({ evaluation, delivery: { inspectOwnerForegroundLearningTask: inspect } }))
  return { root, evaluation, producer, store, append, owner, source, inspect, gateway }
}

test('rereads the trusted owner failure and idempotently records only its private reference', async () => {
  const f = await fixture()
  const first = f.source()
  const gap = f.gateway.record(first)
  f.append('unrelated', 'inbox-other')
  // A different task changes the scope watermark but not this gap's identity.
  expect(f.gateway.record(first).id).toBe(gap.id)
  expect(f.store.listGaps()).toEqual([])
  expect(JSON.stringify(f.store.getOwnerTaskFailureReference(gap.id))).not.toContain('private original task')
  expect(gap.context).not.toContain('private original task')
  expect(f.gateway.withCurrent(gap.id, f.owner, () => 'admitted')).toBe('admitted')
})

test.each(['owner', 'outcome', 'projection', 'text'] as const)('rejects a caller-forged %s expectation', async field => {
  const f = await fixture(), expected = structuredClone(f.source())
  const forged = field === 'owner' ? { ...expected, owner: { ...expected.owner, principalId: 'other-owner' } }
    : field === 'outcome' ? { ...expected, canonical: { ...expected.canonical, triggerOutcomeId: 'other-outcome' } }
    : field === 'projection' ? { ...expected, canonical: { ...expected.canonical, projection: { ...expected.canonical.projection, digest: 'f'.repeat(64) } } }
    : { ...expected, source: { ...expected.source, objective: 'model supplied instructions' } }
  expect(() => f.gateway.record(forged)).toThrow()
  expect(f.store.health().gaps).toBe(0)
})

test.each(['achieved', 'unknown', 'retract', 'unresolved', 'truncated', 'running'] as const)('does not admit %s as a trusted failure', async state => {
  const f = await fixture(), current = f.source()
  const invalid: OwnerForegroundLearningTask = state === 'achieved' || state === 'unknown'
    ? { ...current, canonical: { ...current.canonical, objective: { ...current.canonical.objective!, status: state } } }
    : state === 'retract' ? { ...current, canonical: { ...current.canonical, projection: { ...current.canonical.projection, disposition: 'retract' } } }
    : state === 'unresolved' ? { ...current, judgement: 'unresolved' }
    : { ...current, source: { ...current.source, ...(state === 'truncated' ? { truncated: true } : { quiescent: false }) } }
  f.inspect.mockReturnValue(invalid)
  expect(() => f.gateway.record(invalid)).toThrow('trusted foreground failure')
})

test('blocks wrong callers and owner generation changes, including a new session', async () => {
  const f = await fixture(), gap = f.gateway.record(f.source())
  expect(() => f.gateway.withCurrent(gap.id, undefined, () => {})).toThrow('caller')
  expect(() => f.gateway.withCurrent(gap.id, { ...f.owner, principalId: 'other-owner' }, () => {})).toThrow('caller')
  f.owner.generation += 1
  expect(() => f.gateway.withCurrent(gap.id, f.owner, () => {})).toThrow('caller')
  const caller = { ownerRouteId: f.owner.authorityId, principalId: f.owner.principalId, principalRecordId: f.owner.principalRecordId,
    principalVersion: f.owner.principalVersion, workspace: f.owner.workspace, preset: f.owner.agentPreset }
  expect(() => f.gateway.withCurrent(gap.id, caller, () => {})).toThrow('changed')
})

test('refuses stale evidence inside the canonical writer fence without writing a gap', async () => {
  const f = await fixture(), expected = f.source()
  const original = f.evaluation.withTrustedCanonicalTaskWriterFence.bind(f.evaluation)
  vi.spyOn(f.evaluation, 'withTrustedCanonicalTaskWriterFence').mockImplementationOnce((input, callback) => {
    f.append('corrected', 'inbox-1', 'achieved')
    return original(input, callback)
  })
  expect(() => f.gateway.record(expected)).toThrow('fence changed')
  expect(f.store.health().gaps).toBe(0)
})

test('a correction after preparation starts prevents the final admitted commit', async () => {
  const f = await fixture(), gap = f.gateway.record(f.source()), commit = vi.fn()
  f.gateway.withCurrent(gap.id, f.owner, () => {})
  f.append('corrected', 'inbox-1', 'achieved')
  expect(() => f.gateway.withCurrent(gap.id, f.owner, commit)).toThrow()
  expect(commit).not.toHaveBeenCalled()
  expect(f.store.getGap(gap.id).status).toBe('open')
})

async function approvalFixture() {
  const f = await fixture(), gap = f.gateway.record(f.source())
  const plan = f.gateway.withCurrent(gap.id, f.owner, () => f.store.createSourcePlan({ gapId: gap.id,
    repository: f.root, worktree: join(f.root, 'worktree'), baseCommit: 'a'.repeat(40), name: 'health-helper',
    generatorDigest: MODIFY_GENERATOR_DIGEST, scope: ['plugins/health-helper'], mode: 'modify', ttlMs: 60_000,
    idempotencyKey: 'prepared', prepared: { treeDigest: 'b'.repeat(64), patchDigest: 'c'.repeat(64), checkedAt: Date.now(),
      evidence: { schemaVersion: 1, kind: 'dsh-source-prepared-evidence', environment: { npmConfigIgnoreScripts: true,
        frozenLockfile: true, offline: true, nodeVersion: 'test', pnpmVersion: 'test' },
      commands: [{ command: 'pnpm', args: ['check'], exitCode: 0, durationMs: 1, logDigest: 'd'.repeat(64) }],
      pack: { name: 'health-helper', version: '1.0.0', sizeBytes: 1, sha256: 'e'.repeat(64) }, preparedAt: Date.now() } },
  }).result)
  const keys = generateKeyPairSync('ed25519')
  const unsigned = { schemaVersion: 1 as const, approvalId: 'approval', authority: 'authority', keyId: 'key',
    planId: plan.id, planDigest: plan.digest, decision: 'approved' as const, principal: 'owner', decidedAt: Date.now(), expiresAt: plan.expiresAt }
  const receipt = { ...unsigned, signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), keys.privateKey).toString('base64') }
  const authority = new Ed25519ApprovalAuthority(keys.publicKey.export({ type: 'spki', format: 'pem' }), 'authority', 'key')
  const input = { planId: plan.id, expectedRevision: plan.revision, receipt, resolveAuthority: () => authority,
    idempotencyKey: 'approve', withSourceFence: <T>(callback: () => T): T => f.gateway.withCurrent(gap.id, f.owner, callback) }
  return { ...f, plan, input, authority }
}

test('source approval requires a fresh Host fence even with a valid signature and on receipt replay', async () => {
  const f = await approvalFixture()
  const { withSourceFence: _fence, ...unfenced } = f.input
  await expect(f.store.approveSource(unfenced)).rejects.toThrow('Host admission')
  expect(f.store.getSourcePlan(f.plan.id).status).toBe('pending-approval')
  const approved = await f.store.approveSource(f.input)
  expect(approved.result.status).toBe('approved')
  expect(await f.store.approveSource(f.input)).toEqual(approved)
  f.append('corrected-approval', 'inbox-1', 'achieved')
  await expect(f.store.approveSource(f.input)).rejects.toThrow()
})

test('feedback corrected during asynchronous signature verification blocks the final source approval commit', async () => {
  const f = await approvalFixture()
  const verify = f.authority.verify.bind(f.authority)
  vi.spyOn(f.authority, 'verify').mockImplementationOnce(async (...args) => {
    const result = await verify(...args)
    f.append('corrected-during-signature', 'inbox-1', 'achieved')
    return result
  })
  await expect(f.store.approveSource(f.input)).rejects.toThrow()
  expect(f.store.getSourcePlan(f.plan.id)).toMatchObject({ status: 'pending-approval', revision: 1 })
})
