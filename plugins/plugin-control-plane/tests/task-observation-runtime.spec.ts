import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { EvaluationStore, type OutcomeEnvelope } from '@dsh-enhanced/assistant-evaluation'
import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import type { HostAutomationExecutor, HostAutomationExecutorInput } from '@dsh-enhanced/assistant-automations'
import type { OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import * as release from '../src/release.ts'
import { ControlPlaneStore, controlPlaneDigest } from '../src/store.ts'
import { TaskObservationRuntime } from '../src/task-observation-runtime.ts'
import { Ed25519PostActivationObservationAuthority, postActivationEvidenceDigest, postActivationObservationSigningPayload } from '../src/post-activation.ts'
import type { TaskObservationBatch } from '../src/task-observation-types.ts'
import { foregroundDeploymentFixture, cleanupForegroundDeploymentFixtures } from './helpers/foreground-deployment.ts'

vi.mock('../src/release.ts', async original => ({ ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn() }))
const runtimes: TaskObservationRuntime[] = []
const evaluations: EvaluationStore[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); for (const store of evaluations.splice(0)) store.close(); await cleanupForegroundDeploymentFixtures() })

async function fixture(status: 'achieved' | 'not-achieved' = 'achieved') {
  const f = await foregroundDeploymentFixture()
  const handle = f.observer.begin(f.task); f.observer.completed(handle, f.task, f.execution())
  const record = f.store.getForegroundDeployment(f.task.inboxId)!
  const owner = { receiptVersion: 2 as const, authorityId: 'owner-route', authorityHash: 'a'.repeat(64), principalId: 'owner',
    principalRecordId: 'record', principalVersion: 1, workspace: f.root, agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  let source: OwnerForegroundLearningTask = { protocol: 'assistant-delivery/owner-foreground-learning/v1', owner,
    canonical: { triggerOutcomeId: 'feedback', scope: { workspace: f.root, preset: 'primary' }, scopeKey: 'scope', scopeWatermark: 1,
      situation: 'foreground', projection: { subjectKind: 'foreground-turn', subjectRef: f.task.inboxId, version: 1, digest: 'e'.repeat(64), disposition: 'upsert' },
      objective: { status, source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' }, outcomeId: 'feedback', evidence: [],
        occurredAt: Date.now(), evaluator: { id: 'owner', version: '1' } } },
    judgement: 'owner-feedback', ownerRevision: { version: 1, action: 'initial' },
    source: { inboxId: f.task.inboxId, sessionId: f.task.sessionId, objective: 'real task', quiescent: true, truncated: false,
      modelSelectionState: 'frozen', modelSelection: { provider: 'user', model: 'selected' } } }
  const evaluation = new EvaluationStore({ path: join(f.root, 'evaluation.sqlite') }); evaluations.push(evaluation)
  const envelope = (objectiveStatus: OutcomeEnvelope['objectiveStatus'], key: string): OutcomeEnvelope => ({
    scope: source.canonical.scope, situation: 'foreground', executionStatus: 'succeeded', objectiveStatus, deliveryStatus: 'delivered',
    source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' }, trust: 'trusted', metrics: {},
    evidence: [{ kind: 'foreground-turn', ref: f.task.inboxId }, { kind: 'delivery-outbox', ref: 'outbox' }],
    occurredAt: Date.now(), evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' }, idempotencyKey: key,
  })
  evaluation.append(envelope(status, 'feedback'), { principalRecordId: owner.principalRecordId, principalVersion: 1,
    action: 'initial', operationId: 'feedback' })
  source = { ...source, canonical: evaluation.getForegroundLearningProjection(source.canonical.scope, f.task.inboxId)! }
  const keys = generateKeyPairSync('ed25519'), trust = { ...f.signed.trust,
    hostAttestationKeys: [{ authority: 'observer', keyId: 'key', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] }
  let scheduleStatus: string | undefined
  let available = true, definition: { execution: { activationNonce: string }; [key: string]: unknown }, automationId = ''
  let executor: HostAutomationExecutor
  const unregister = vi.fn(), unsubscribe = vi.fn(), rollback = vi.fn(async () => {})
  const signBatch = (batch: TaskObservationBatch) => {
    const failures = batch.votes.filter(vote => vote.status === 'not-achieved').length
    const evidence = { kind: 'post-activation-health' as const, checks: batch.votes.length, failures, probeDigest: batch.digest }
    const unsigned = { schemaVersion: 1 as const, observationId: batch.id, authority: 'observer', keyId: 'key', installationId: f.plan.installationId,
      planId: f.plan.id, planDigest: f.plan.digest, activationId: f.plan.activation!.id, fence: f.plan.activation!.fence,
      package: f.plan.candidate.package, version: f.plan.candidate.version, integrity: f.plan.candidate.integrity,
      disposition: failures ? 'regressed' as const : 'healthy' as const, evidence, evidenceDigest: postActivationEvidenceDigest(evidence),
      hostGeneration: 5, observedAt: Date.now(), expiresAt: Date.now() + 20_000 }
    return { ...unsigned, signature: sign(null, Buffer.from(postActivationObservationSigningPayload(unsigned)), keys.privateKey).toString('base64') }
  }
  const request = vi.fn(async (batch: TaskObservationBatch) => signBatch(batch))
  const config = { policy: { id: 'finite-policy', expiresAt: Date.now() + 300_000, maximumObservations: 3,
    minimumChecks: 1, maximumChecks: 3, lookbackMs: 60_000 }, scope: { ownerRouteId: owner.authorityId,
    principalId: owner.principalId, workspace: f.root, preset: 'primary' }, profilePath: f.plan.target.profilePath, timeoutMs: 30_000,
    authority: { executable: { path: '/tmp/pinned-authority', sha256: 'f'.repeat(64) }, configPath: '/tmp/authority.json', timeoutMs: 1000 } }
  const options: ConstructorParameters<typeof TaskObservationRuntime>[0] = { config, trust, store: new ControlPlaneStore({ path: f.plan.ledger.path }),
    evaluation: { canonicalHostScope: value => value as never,
      getTrustedForegroundLearningProjection: input => evaluation.getForegroundLearningProjection(input.scope, input.inboxId),
      withTrustedCanonicalTaskWriterFence: (input, callback) => evaluation.withCanonicalTaskWriterFence(input.scope,
        { scopeWatermark: input.scopeWatermark, evidence: input.evidence }, callback),
      onTrustedTaskChange: () => unsubscribe },
    delivery: { validateOwnerRoute: () => owner, inspectOwnerForegroundLearningTask: () => available ? structuredClone(source) : undefined },
    automations: { registerHostExecutor: value => { executor = value; return unregister },
      reconcileSystem: input => { scheduleStatus = input.desiredStatus; automationId = input.automationId; definition = input.definition as unknown as typeof definition; return {} as never },
      inspectSystemOwnedActivation: () => ({ definitionHash: 'definition-hash', activationNonce: definition.execution.activationNonce }) as never },
    assertCurrent() {}, rollback, request }
  const makeRuntime = () => { const runtime = new TaskObservationRuntime({ ...options, store: new ControlPlaneStore({ path: f.plan.ledger.path }) }); runtimes.push(runtime); runtime.start(); return runtime }
  options.store.close()
  const runtime = makeRuntime()
  const execute = () => executor.execute({ automationId, executionMode: 'production', activationNonce: definition.execution.activationNonce,
    definitionHash: 'definition-hash', catalogDigest: executor.descriptor.catalogDigest, ownerRouteId: owner.authorityId,
    principal: owner.principalId, targetScope: { workspace: f.root, preset: 'primary' }, signal: new AbortController().signal } as HostAutomationExecutorInput)
  return { ...f, record, source, owner, runtime, makeRuntime, execute, request, signBatch, rollback, unregister, unsubscribe,
    scheduleStatus: () => scheduleStatus, lane: controlPlaneDigest({ scope: config.scope, profilePath: config.profilePath }), withdraw: () => {
      evaluation.append(envelope('unknown', 'withdraw'), { principalRecordId: owner.principalRecordId, principalVersion: 1,
        action: 'withdraw', operationId: 'withdraw', expectedVersion: 1, previousStatus: status })
      source = { ...source, canonical: evaluation.getForegroundLearningProjection(source.canonical.scope, f.task.inboxId)! }
      available = false
    } }
}

test('native cron signs current distinct tasks once; restart does not count completed votes again', async () => {
  const f = await fixture()
  expect(f.store.listTaskObservations(f.lane)).toHaveLength(1)
  expect((await f.execute()).outcome).toBe('succeeded')
  expect(f.store.getActivationWatch(f.plan.id).healthyObservations).toBe(1)
  await f.runtime.close(); expect(f.scheduleStatus()).toBe('paused')
  const restarted = f.makeRuntime(); restarted.scan(); expect(f.scheduleStatus()).toBe('active')
  expect((await f.execute()).outcome).toBe('succeeded')
  expect(f.request).toHaveBeenCalledTimes(1)
  expect(f.rollback).not.toHaveBeenCalled()
})

test('feedback withdrawn while signing cannot close the watch or trigger rollback', async () => {
  const f = await fixture('not-achieved')
  f.request.mockImplementationOnce(async batch => { f.withdraw(); return f.signBatch(batch) })
  await f.execute()
  expect(f.store.getActivationWatch(f.plan.id).state).toBe('watching')
  expect(f.store.listTaskObservations(f.lane)[0]?.state).toBe('stale')
  expect(f.rollback).not.toHaveBeenCalled()
})

test('the final writer fence rejects a correction during asynchronous signature verification', async () => {
  const f = await fixture('not-achieved')
  const original = Ed25519PostActivationObservationAuthority.prototype.verify
  vi.spyOn(Ed25519PostActivationObservationAuthority.prototype, 'verify').mockImplementationOnce(original).mockImplementationOnce(async function (this: Ed25519PostActivationObservationAuthority, ...args) {
    const verified = await original.apply(this, args); f.withdraw(); return verified
  })
  expect((await f.execute()).outcome).toBe('unknown')
  expect(f.store.getActivationWatch(f.plan.id).state).toBe('watching')
  expect(f.store.listTaskObservations(f.lane)[0]?.state).toBe('signed')
  expect(f.rollback).not.toHaveBeenCalled()
})

test('a committed regression resumes recovery after feedback withdrawal and restart', async () => {
  const f = await fixture('not-achieved')
  f.rollback.mockRejectedValueOnce(new Error('Host unavailable'))
  expect((await f.execute()).outcome).toBe('unknown')
  expect(f.store.getActivationWatch(f.plan.id).state).toBe('closed-regressed')
  expect(f.store.listTaskObservations(f.lane)[0]?.state).toBe('applied')
  await f.runtime.close(); f.withdraw(); f.makeRuntime()
  await f.execute()
  expect(f.request).toHaveBeenCalledTimes(1)
  expect(f.rollback).toHaveBeenCalledTimes(2)
})

test('dispose waits for an in-flight signer and suppresses its late result', async () => {
  const f = await fixture('not-achieved')
  let release!: () => void
  f.request.mockImplementationOnce(async batch => { await new Promise<void>(resolve => { release = resolve }); return f.signBatch(batch) })
  const running = f.execute()
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  let closed = false
  const close = f.runtime.close().then(() => { closed = true })
  await Promise.resolve(); expect(closed).toBe(false)
  release(); await running; await close
  expect(f.unregister).toHaveBeenCalledOnce(); expect(f.unsubscribe).toHaveBeenCalledOnce()
  expect(f.scheduleStatus()).toBe('paused')
  expect(f.store.getActivationWatch(f.plan.id).state).toBe('watching')
  expect(f.rollback).not.toHaveBeenCalled()
})


test('bad signer signatures become stale without closing the watch or retrying unchanged facts', async () => {
  const f = await fixture('not-achieved')
  f.request.mockImplementationOnce(async batch => ({ ...f.signBatch(batch), signature: Buffer.alloc(64).toString('base64') }))
  expect((await f.execute()).outcome).toBe('unknown')
  expect(f.store.listTaskObservations(f.lane)[0]?.state).toBe('stale')
  expect(f.store.getActivationWatch(f.plan.id).state).toBe('watching')
  f.runtime.scan()
  expect(f.store.listTaskObservations(f.lane)).toHaveLength(1)
  expect(f.rollback).not.toHaveBeenCalled()
})

test('in-flight unrelated tasks do not invalidate a completed deployment cohort', async () => {
  const f = await fixture()
  f.observer.begin({ ...f.task, inboxId: 'still-running', dispatchedAt: Date.now() })
  expect(f.store.listObservedForegroundDeployments(f.plan.target.profilePath)).toHaveLength(1)
  expect((await f.execute()).outcome).toBe('succeeded')
})


test('a deployment superseded while its batch awaits signing becomes stale', async () => {
  const f = await fixture()
  const db = new DatabaseSync(f.plan.ledger.path)
  try { db.prepare('UPDATE activation_deployment_checkpoints SET successful_order=NULL WHERE plan_id=?').run(f.plan.id) }
  finally { db.close() }
  f.runtime.scan()
  expect(f.store.listTaskObservations(f.lane)[0]?.state).toBe('stale')
  await f.execute()
  expect(f.request).not.toHaveBeenCalled()
  expect(f.store.getActivationWatch(f.plan.id).healthyObservations).toBe(0)
})
