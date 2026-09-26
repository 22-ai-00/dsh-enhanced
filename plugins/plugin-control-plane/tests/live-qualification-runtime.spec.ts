import { mkdtemp, rm } from 'node:fs/promises'
import { generateKeyPairSync, sign } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvaluationStore, type OutcomeEnvelope } from '@dsh-enhanced/assistant-evaluation'
import type { OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import { afterEach, expect, test, vi } from 'vitest'
import type { HostAutomationExecutor, HostAutomationExecutorInput } from '@dsh-enhanced/assistant-automations'
import { ControlPlaneStore, controlPlaneDigest } from '../src/store.ts'
import { withTrustedForegroundVoteFence } from '../src/task-observation-evidence.ts'
import { LiveQualificationRuntime, validateLiveQualificationConfig } from '../src/live-qualification-runtime.ts'
import { liveQualificationReceiptId, liveQualificationSigningPayload, type LiveQualificationBatch } from '../src/live-qualification.ts'
import type { PluginActivationPlan } from '../src/types.ts'
import type { TaskObservationOwner, TaskObservationVote } from '../src/task-observation-types.ts'
import * as release from '../src/release.ts'
import { cleanupLiveQualificationReadinessFixtures, livePlan, persistedVote } from './helpers/live-qualification.ts'
import { cleanupReleaseFixtures } from './helpers/source-release-runner.ts'

const roots: string[] = []
vi.mock('../src/release.ts', async original => ({ ...await original<typeof release>(), invokeSourceReleaseAdapter: vi.fn() }))
afterEach(async () => { await cleanupReleaseFixtures(); await cleanupLiveQualificationReadinessFixtures()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const authority = { executable: { path: '/tmp/pinned-live-signer', sha256: 'f'.repeat(64) },
  configPath: '/tmp/live-authority.json', timeoutMs: 1000 }
const config = { scope: { ownerRouteId: 'owner-route', principalId: 'owner', workspace: '/workspace', preset: 'primary' },
  profilePath: '/workspace/profiles/primary', timeoutMs: 30_000, budgetId: 'live-runs', budgetAmount: 1, authority }

test('live qualification requires exact absolute, finite native automation configuration', () => {
  expect(() => validateLiveQualificationConfig(config)).not.toThrow()
  expect(() => validateLiveQualificationConfig({ ...config, profilePath: 'relative/profile' })).toThrow('invalid liveQualification')
  expect(() => validateLiveQualificationConfig({ ...config, budgetAmount: 0 })).toThrow('invalid liveQualification')
  expect(() => validateLiveQualificationConfig({ ...config, excess: true } as never)).toThrow('invalid liveQualification')
})

test('one real Evaluation writer fence covers task votes and original owner failure while writing Store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-live-fence-')); roots.push(root)
  const evaluation = new EvaluationStore({ path: join(root, 'evaluation.sqlite') })
  const store = new ControlPlaneStore({ path: join(root, 'control.sqlite') })
  try {
    const owner: TaskObservationOwner = { authorityId: 'owner-route', authorityHash: 'a'.repeat(64),
      principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary' }
    const scope = { workspace: root, preset: 'primary' }
    const envelope = (ref: string, status: 'achieved' | 'not-achieved', key: string): OutcomeEnvelope => ({
      scope, situation: 'foreground', executionStatus: 'succeeded', objectiveStatus: status, deliveryStatus: 'delivered',
      source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' }, trust: 'trusted', metrics: {},
      evidence: [{ kind: 'foreground-turn', ref }, { kind: 'delivery-outbox', ref: `outbox-${ref}` }],
      occurredAt: Date.now(), evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' }, idempotencyKey: key,
    })
    evaluation.append(envelope('original', 'not-achieved', 'original-failed'), {
      principalRecordId: 'record', principalVersion: 1, action: 'initial', operationId: 'original-failed' })
    evaluation.append(envelope('live-task', 'achieved', 'live-succeeded'), {
      principalRecordId: 'record', principalVersion: 1, action: 'initial', operationId: 'live-succeeded' })
    const source = (ref: string): OwnerForegroundLearningTask => ({
      protocol: 'assistant-delivery/owner-foreground-learning/v1',
      owner: { ...owner, receiptVersion: 2, bindingVersion: 1, generation: 1 },
      canonical: evaluation.getForegroundLearningProjection(scope, ref)!, judgement: 'owner-feedback',
      ownerRevision: { version: 1, action: 'initial' },
      source: { inboxId: ref, sessionId: `session-${ref}`, objective: 'real owner task', quiescent: true,
        truncated: false, modelSelectionState: 'frozen', modelSelection: { provider: 'user', model: 'selected' } },
    })
    const voteSource = source('live-task')
    const vote: TaskObservationVote = { inboxId: 'live-task', outcomeId: voteSource.canonical.triggerOutcomeId,
      projection: voteSource.canonical.projection, sourceDigest: controlPlaneDigest(voteSource),
      deploymentDigest: 'b'.repeat(64), status: 'achieved', completedAt: Date.now() }
    let writerFences = 0
    const evaluationPort = {
      canonicalHostScope: (input: typeof scope) => input as never,
      withTrustedCanonicalTaskWriterFence: <T>(input: { scope: typeof scope; scopeWatermark: number; evidence: readonly typeof vote.projection[] }, callback: () => T) => {
        writerFences++
        return evaluation.withCanonicalTaskWriterFence(input.scope,
          { scopeWatermark: input.scopeWatermark, evidence: input.evidence }, callback)
      },
    }
    const original = () => {
      const current = source('original')
      if (current.canonical.objective?.status !== 'not-achieved') throw new Error('original failure was corrected')
      return current
    }
    const enter = (id: string) => withTrustedForegroundVoteFence({ evaluation: evaluationPort as never,
      owner, votes: [vote], read: () => [source('live-task')], additionalSource: original,
      callback: () => store.recordGap({ idempotencyKey: id, capability: 'health', context: 'live qualification',
        expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 }) })
    expect(enter('gap:qualified').id).toBeTruthy()
    expect(writerFences).toBe(1)
    evaluation.append(envelope('original', 'achieved', 'original-corrected'), {
      principalRecordId: 'record', principalVersion: 1, action: 'correct', operationId: 'original-corrected',
      expectedVersion: 1, previousStatus: 'not-achieved' })
    expect(() => enter('gap:stale')).toThrow('original failure was corrected')
    expect(store.listGaps(10).map(gap => gap.idempotencyKey)).not.toContain('gap:stale')
  } finally { store.close(); evaluation.close() }
})

test('live scan waits for every started task, then freezes an observed failure ahead of successes', async () => {
  const now = Date.now(), startedAt = now - 2_000, deadlineAt = now + 58_000
  const owner: TaskObservationOwner = { authorityId: 'owner-route', authorityHash: 'a'.repeat(64), principalId: 'owner',
    principalRecordId: 'record', principalVersion: 1, workspace: '/workspace', agentPreset: 'primary' }
  const projection = (inboxId: string) => ({ subjectKind: 'foreground-turn' as const, subjectRef: inboxId,
    version: 1, digest: controlPlaneDigest(inboxId), disposition: 'upsert' as const })
  const makeSource = (inboxId: string, status: 'achieved' | 'not-achieved'): OwnerForegroundLearningTask => ({
    protocol: 'assistant-delivery/owner-foreground-learning/v1',
    owner: { ...owner, receiptVersion: 2, bindingVersion: 1, generation: 1 },
    canonical: { triggerOutcomeId: `outcome-${inboxId}`, scope: { workspace: owner.workspace, preset: owner.agentPreset },
      scopeKey: 'scope', scopeWatermark: 1, situation: 'foreground', projection: projection(inboxId),
      objective: { status, source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
        outcomeId: `outcome-${inboxId}`, evidence: [], occurredAt: now,
        evaluator: { id: 'owner', version: '1' } } },
    judgement: 'owner-feedback', ownerRevision: { version: 1, action: 'initial' },
    source: { inboxId, sessionId: `session-${inboxId}`, objective: 'real task', quiescent: true,
      truncated: false, modelSelectionState: 'frozen', modelSelection: { provider: 'test', model: 'selected' } },
  })
  const original = makeSource('original', 'not-achieved')
  const sources = new Map([['success', makeSource('success', 'achieved')], ['later', makeSource('later', 'not-achieved')]])
  const terms = { protocol: 'dsh-bounded-live/v1' as const, maximumWindowMs: 60_000,
    minimumTasks: 1, authority: 'live-observer', keyId: 'live-key' }
  const plan = { id: 'plan-live', digest: 'b'.repeat(64), installationId: 'installation',
    status: 'awaiting-live-tasks', expiresAt: deadlineAt, target: { profilePath: config.profilePath },
    activation: { id: 'activation', fence: 1 }, dossier: { liveQualification: terms } } as unknown as PluginActivationPlan
  const window = { startedAt, deadlineAt, readinessDigest: 'c'.repeat(64), hostGeneration: 1 }
  const deployment = (inboxId: string, state: 'observed' | 'pending' | 'unknown') => ({
    schemaVersion: 1 as const,
    task: { inboxId, sessionId: `session-${inboxId}`, dispatchedAt: now - 1_000,
      owner: { principalRecordId: 'record', principalVersion: 1 }, scope: { workspace: owner.workspace, preset: owner.agentPreset } },
    readiness: { planId: plan.id, planDigest: plan.digest, installationId: plan.installationId,
      profilePath: config.profilePath, activationId: 'activation', fence: 1,
      hostGeneration: 1, receiptDigest: window.readinessDigest },
    state, execution: state === 'observed' ? { completedAt: now, modelSelectionState: 'frozen',
      modelSelection: { provider: 'test', model: 'selected' } } : undefined,
  })
  let deployments = [deployment('success', 'observed'), deployment('later', 'pending')]
  const records: Array<{ batch: LiveQualificationBatch;
    state: 'pending' | 'applied'; receipt?: { disposition: 'qualified' } }> = []
  let invalidated = false
  const store = {
    getPlan: () => plan, getLiveQualificationWindow: () => window,
    listLiveQualificationPlans: () => [plan], listLiveQualificationDeployments: () => deployments,
    listLiveQualifications: () => records, getLiveQualification: (id: string) => records.find(record => record.batch.id === id),
    getForegroundDeployment: (inboxId: string) => deployments.find(item => item.task.inboxId === inboxId),
    assertCurrentLiveQualification() {}, putLiveQualification(batch: LiveQualificationBatch) {
      records.push({ batch, state: 'pending' })
    }, invalidateLiveQualification() { invalidated = true }, close() {},
  }
  let taskChange!: () => void, executor!: HostAutomationExecutor, automationId = ''
  let definition!: { execution: { activationNonce: string } }
  let available = true
  const options: ConstructorParameters<typeof LiveQualificationRuntime>[0] = { config, store: store as never,
    trust: { installationId: plan.installationId } as never,
    assertCurrent() {}, assertRuntime() { if (!available) throw new Error('Host observer unavailable') },
    runtimeAvailable: () => available, qualificationSource: () => original,
    evaluation: { canonicalHostScope: value => value as never,
      getTrustedForegroundLearningProjection: input => sources.get(input.inboxId)?.canonical,
      withTrustedCanonicalTaskWriterFence: (_input, callback) => ({ matched: true, value: callback() }),
      onTrustedTaskChange: callback => { taskChange = callback; return () => {} } },
    delivery: { validateOwnerRoute: () => ({ ...owner, receiptVersion: 2, bindingVersion: 1, generation: 1 }),
      inspectOwnerForegroundLearningTask: input => [...sources.values()].find(source => source.canonical.triggerOutcomeId === input.outcomeId) },
    automations: { registerHostExecutor: value => { executor = value; return () => {} },
      reconcileSystem: input => { automationId = input.automationId; definition = input.definition as typeof definition; return {} as never },
      inspectSystemOwnedActivation: () => ({ definitionHash: 'definition-hash', activationNonce: definition.execution.activationNonce }) as never },
  }
  const runtime = new LiveQualificationRuntime(options)
  runtime.start()
  expect(records).toHaveLength(0)
  deployments = [deployment('success', 'observed'), deployment('later', 'unknown')]
  taskChange()
  expect(records).toHaveLength(0)
  deployments = [deployment('success', 'observed'), deployment('later', 'observed')]
  taskChange()
  expect(records).toHaveLength(1)
  expect(records[0]!.batch.votes.map(vote => vote.status)).toEqual(['not-achieved'])
  await runtime.close()
  expect(invalidated).toBe(false)

  // A fresh runtime may defer its initial scan while the sibling observer
  // mounts. Its first authenticated native cron tick must end that grace.
  records.length = 0
  sources.delete('later')
  deployments = [deployment('success', 'observed')]
  available = true
  const fresh = new LiveQualificationRuntime(options)
  fresh.start()
  expect(records).toHaveLength(1)
  expect(records[0]!.batch.votes.map(vote => vote.status)).toEqual(['achieved'])
  records[0]!.state = 'applied'; records[0]!.receipt = { disposition: 'qualified' }
  plan.status = 'activated'
  await fresh.close()
  available = false
  invalidated = false
  const restarted = new LiveQualificationRuntime(options)
  restarted.start()
  expect(invalidated).toBe(false)
  await executor.execute({ automationId, executionMode: 'production', activationNonce: definition.execution.activationNonce,
    definitionHash: 'definition-hash', catalogDigest: executor.descriptor.catalogDigest,
    ownerRouteId: owner.authorityId, principal: owner.principalId,
    targetScope: { workspace: owner.workspace, preset: owner.agentPreset },
    signal: new AbortController().signal } as HostAutomationExecutorInput)
  expect(invalidated).toBe(true)
  await restarted.close()
})

test('real live-plan final CAS runs under one combined canonical fence and rejects a corrected vote', async () => {
  const value = await livePlan()
  const witness = await persistedVote(value)
  const evaluation = new EvaluationStore({ path: join(value.f.root, 'live-evaluation.sqlite') })
  const liveStore = new ControlPlaneStore({ path: value.plan.ledger.path })
  let runtime: LiveQualificationRuntime | undefined
  let target: ControlPlaneStore | undefined
  try {
    const owner = witness.owner
    const scope = { workspace: owner.workspace, preset: owner.agentPreset }
    const envelope = (ref: string, status: 'achieved' | 'not-achieved', key: string): OutcomeEnvelope => ({
      scope, situation: 'foreground', executionStatus: 'succeeded', objectiveStatus: status, deliveryStatus: 'delivered',
      source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' }, trust: 'trusted', metrics: {},
      evidence: [{ kind: 'foreground-turn', ref }, { kind: 'delivery-outbox', ref: `outbox-${ref}` }],
      occurredAt: Date.now(), evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' }, idempotencyKey: key,
    })
    evaluation.append(envelope('original-live-source', 'not-achieved', 'original-live-failed'), {
      principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion,
      action: 'initial', operationId: 'original-live-failed' })
    evaluation.append(envelope(witness.vote.inboxId, 'achieved', 'qualified-live-task'), {
      principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion,
      action: 'initial', operationId: 'qualified-live-task' })
    const source = (ref: string, sessionId: string): OwnerForegroundLearningTask => ({
      protocol: 'assistant-delivery/owner-foreground-learning/v1',
      owner: { ...owner, receiptVersion: 2, bindingVersion: 1, generation: 1 },
      canonical: evaluation.getForegroundLearningProjection(scope, ref)!, judgement: 'owner-feedback',
      ownerRevision: { version: 1, action: 'initial' },
      source: { inboxId: ref, sessionId, objective: 'real task', quiescent: true, truncated: false,
        modelSelectionState: 'frozen', modelSelection: { provider: 'test', model: 'test' } },
    })
    const original = () => source('original-live-source', 'original-session')
    const voteSource = () => source(witness.vote.inboxId, 'session')
    const keys = generateKeyPairSync('ed25519')
    const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const trust = { ...value.f.options.trust,
      hostAttestationKeys: [{ authority: 'live-observer', keyId: 'live-key', publicKeyPem }] }
    let executor!: HostAutomationExecutor, automationId = ''
    let definition!: { execution: { activationNonce: string } }
    let writerFences = 0
    const runtimeConfig = { scope: { ownerRouteId: owner.authorityId, principalId: owner.principalId,
      workspace: owner.workspace, preset: owner.agentPreset }, profilePath: value.plan.target.profilePath,
      timeoutMs: 30_000, budgetId: 'live-runs', budgetAmount: 1, authority }
    runtime = new LiveQualificationRuntime({ config: runtimeConfig, store: liveStore, trust,
      assertCurrent() {}, runtimeAvailable: () => true,
      // Retained Host journal sampling has separate coverage; this case tests
      // the real Evaluation writer lock across the Store's final activation CAS.
      assertRuntime() {}, qualificationSource: () => original(),
      evaluation: { canonicalHostScope: input => input as never,
        getTrustedForegroundLearningProjection: input => evaluation.getForegroundLearningProjection(input.scope, input.inboxId),
        withTrustedCanonicalTaskWriterFence: (input, callback) => {
          writerFences++
          return evaluation.withCanonicalTaskWriterFence(input.scope,
            { scopeWatermark: input.scopeWatermark, evidence: input.evidence }, callback)
        }, onTrustedTaskChange: () => () => {} },
      delivery: { validateOwnerRoute: () => ({ ...owner, receiptVersion: 2, bindingVersion: 1, generation: 1 }),
        inspectOwnerForegroundLearningTask: input => input.outcomeId === voteSource().canonical.triggerOutcomeId ? voteSource() : undefined },
      automations: { registerHostExecutor: input => { executor = input; return () => {} },
        reconcileSystem: input => { automationId = input.automationId; definition = input.definition as typeof definition; return {} as never },
        inspectSystemOwnedActivation: () => ({ definitionHash: 'definition-hash', activationNonce: definition.execution.activationNonce }) as never },
      request: async batch => {
        const observedAt = Date.now()
        const identity = { schemaVersion: 1 as const, kind: 'dsh-live-qualification-receipt' as const,
          authority: 'live-observer', keyId: 'live-key', batchId: batch.id, batchDigest: batch.digest,
          planId: batch.planId, planDigest: batch.planDigest, activationId: batch.activationId,
          fence: batch.fence, hostGeneration: batch.hostGeneration, disposition: 'qualified' as const,
          observedAt, expiresAt: Math.min(batch.expiresAt, observedAt + 10_000) }
        const unsigned = { ...identity, receiptId: liveQualificationReceiptId(identity) }
        return { ...unsigned, signature: sign(null, Buffer.from(liveQualificationSigningPayload(unsigned)),
          keys.privateKey).toString('base64') }
      } })
    runtime.start()
    const pending = liveStore.listLiveQualifications(value.plan.id)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.batch.votes.map(vote => vote.status)).toEqual(['achieved'])
    const native = await executor.execute({ automationId, executionMode: 'production', activationNonce: definition.execution.activationNonce,
      definitionHash: 'definition-hash', catalogDigest: executor.descriptor.catalogDigest,
      ownerRouteId: owner.authorityId, principal: owner.principalId,
      targetScope: { workspace: owner.workspace, preset: owner.agentPreset },
      signal: new AbortController().signal } as HostAutomationExecutorInput)
    expect(native.outcome).toBe('succeeded')
    expect(liveStore.getPlan(value.plan.id).status).toBe('commit-pending')
    target = new ControlPlaneStore({ path: value.plan.ledger.path,
      withOwnerActivationFence: (_gap, callback) => value.f.options.withSourceFence!(callback),
      withLiveQualificationFence: (planId, callback) => runtime!.withQualificationFence(planId, callback) })
    let committed = await target.claimActivation({ planId: value.plan.id,
      expectedRevision: liveStore.getPlan(value.plan.id).revision, leaseMs: 5_000,
      resolveApprovalAuthority: () => value.approvalAuthority })
    committed = target.recordActivationInstalledBaseline({ planId: committed.id,
      expectedRevision: committed.revision, fence: committed.activation!.fence,
      baselineFiles: ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].map(name => ({
        path: join(committed.target.profilePath, name), sha256: '8'.repeat(64) })) })
    expect(target.advanceActivation({ planId: committed.id, expectedRevision: committed.revision,
      fence: committed.activation!.fence, from: 'commit-pending', to: 'activated' }).status).toBe('activated')
    expect(writerFences).toBeGreaterThan(0)
    evaluation.append(envelope(witness.vote.inboxId, 'not-achieved', 'qualified-task-corrected'), {
      principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion,
      action: 'correct', operationId: 'qualified-task-corrected', expectedVersion: 1, previousStatus: 'achieved' })
    expect(() => runtime!.withQualificationFence(value.plan.id, () => {})).toThrow()
  } finally { target?.close(); await runtime?.close(); evaluation.close(); value.coordinator.close() }
}, 30_000)
