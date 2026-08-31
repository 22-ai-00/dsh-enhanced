import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalRecoveryBootstrapAttestationSet,
  EMPTY_BOOTSTRAP_ATTESTATION_SET_DIGEST,
  recoveryBootstrapAttestationSetDigest,
} from '../src/attestation.ts'
import { RECOVERY_CATALOG, RECOVERY_CATALOG_DIGEST } from '../src/catalog.ts'
import { RecoveryStore, RecoveryStoreError } from '../src/store.ts'
import type { RecoveryRunInput, RecoveryStepId } from '../src/types.ts'

const roots: string[] = []
const hash = (digit: string) => digit.repeat(64)

function createStore(now = 1_000): { store: RecoveryStore; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-'))
  roots.push(root)
  const path = join(root, 'recovery.sqlite')
  return { store: new RecoveryStore({ path, now: () => now }), path }
}

function runInput(overrides: Partial<RecoveryRunInput> = {}): RecoveryRunInput {
  return {
    occurrenceId: 'occurrence-1',
    automationId: 'recovery:supervised-growth',
    definitionHash: hash('a'),
    executionMode: 'production',
    targetScope: { workspace: '/workspace', preset: 'owner-preset' },
    principal: 'lark/account/tenant/user',
    ownerRouteId: 'owner-route',
    activationNonce: 'activation-1',
    activationPlanDigest: hash('e'),
    catalogDigest: RECOVERY_CATALOG_DIGEST,
    ...overrides,
  }
}

function bootstrapAttestation(
  automationId: string,
  activationState: 'active' | 'paused' | 'preview',
  digit: string,
) {
  return {
    automationId,
    activationState,
    activationNonce: `nonce-${automationId}`,
    activationPlanDigest: hash(digit),
  }
}

function expectStoreError(action: () => unknown, code: RecoveryStoreError['code']): void {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(RecoveryStoreError)
    expect((error as RecoveryStoreError).code).toBe(code)
    return
  }
  throw new Error(`expected RecoveryStoreError:${code}`)
}

function completeSuccessfulRun(
  store: RecoveryStore,
  input: RecoveryRunInput,
  resultCode = input.executionMode === 'preview' ? 'preview-verified' : 'runbook-complete',
) {
  const { run } = store.beginRun(input)
  for (const catalogStep of RECOVERY_CATALOG) {
    const action = catalogStep.id === 'authority-admission'
      ? { kind: 'verify-authority' as const }
      : catalogStep.id === 'verification'
        ? { kind: 'verify-health' as const }
        : { kind: 'noop' as const, reasonCode: 'no-change' }
    const { step } = store.beginStep({
      runId: run.id,
      stepId: catalogStep.id,
      action,
      beforeDigest: hash('a'),
    })
    store.completeStep({
      runId: run.id,
      stepId: catalogStep.id,
      expectedVersion: step.version,
      status: catalogStep.id === 'authority-admission' || catalogStep.id === 'verification'
        ? 'succeeded'
        : 'noop',
      beforeDigest: hash('a'),
      afterDigest: hash('a'),
      resultCode: catalogStep.id === 'authority-admission' || catalogStep.id === 'verification'
        ? 'verified'
        : 'no-change',
    })
  }
  return store.completeRun({
    runId: run.id,
    expectedVersion: run.version,
    status: 'succeeded',
    resultCode,
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RecoveryStore', () => {
  it('creates one immutable run per occurrence and rejects an input collision', () => {
    const { store } = createStore()
    const created = store.beginRun(runInput())
    const replayed = store.beginRun(runInput())

    expect(created.replayed).toBe(false)
    expect(replayed).toEqual({ run: created.run, replayed: true })
    expectStoreError(
      () => store.beginRun(runInput({ ownerRouteId: 'different-route' })),
      'idempotency-conflict',
    )
    store.close()
  })

  it('pins the compiled catalog digest and a printable immutable target scope', () => {
    const { store } = createStore()
    expectStoreError(() => store.beginRun(runInput({ catalogDigest: hash('b') })), 'invalid-input')
    expectStoreError(
      () => store.beginRun(runInput({ targetScope: { workspace: '/work\nspace', preset: 'owner' } })),
      'invalid-input',
    )
    expectStoreError(
      () => store.beginRun(runInput({ targetScope: { workspace: 'relative', preset: 'owner' } })),
      'invalid-input',
    )
    const canonical = store.beginRun(runInput({
      occurrenceId: 'canonical-scope',
      targetScope: { workspace: '/work/../workspace', preset: 'owner' },
    })).run
    expect(canonical.targetScope.workspace).toBe('/workspace')
    expect(store.targetScopeDigest({ workspace: '/work/../workspace', preset: 'owner' }))
      .toBe(store.targetScopeDigest(canonical.targetScope))
    expectStoreError(() => store.beginStep({
      runId: canonical.id,
      stepId: 'authority-admission',
      action: { kind: 'noop', reasonCode: `x${'a'.repeat(64)}` },
      beforeDigest: hash('b'),
    }), 'invalid-input')
    store.close()
  })

  it('writes ordered intent and terminal receipts with deterministic idempotency keys', () => {
    const { store } = createStore()
    const { run } = store.beginRun(runInput())
    const first = store.beginStep({
      runId: run.id,
      stepId: 'authority-admission',
      action: { kind: 'verify-authority' },
      beforeDigest: hash('b'),
    })

    expect(first.step).toMatchObject({
      idempotencyKey: 'recovery:3:occurrence-1:authority-admission',
      status: 'started',
      version: 1,
    })
    const completed = store.completeStep({
      runId: run.id,
      stepId: 'authority-admission',
      expectedVersion: first.step.version,
      status: 'succeeded',
      beforeDigest: hash('b'),
      afterDigest: hash('c'),
      resultCode: 'authority-proven',
    })
    expect(completed).toMatchObject({ status: 'succeeded', version: 2, resultCode: 'authority-proven' })
    expect(store.listSteps(run.id)).toEqual([completed])
    store.close()
  })

  it('does not let a later catalog step bypass a missing or non-terminal predecessor', () => {
    const { store } = createStore()
    const { run } = store.beginRun(runInput())

    expectStoreError(() => store.beginStep({
      runId: run.id,
      stepId: 'ledger-reconcile',
      action: { kind: 'noop', reasonCode: 'nothing-pending' },
      beforeDigest: hash('b'),
    }), 'invalid-state')

    store.beginStep({
      runId: run.id,
      stepId: 'authority-admission',
      action: { kind: 'verify-authority' },
      beforeDigest: hash('b'),
    })
    expectStoreError(() => store.beginStep({
      runId: run.id,
      stepId: 'ledger-reconcile',
      action: { kind: 'noop', reasonCode: 'nothing-pending' },
      beforeDigest: hash('d'),
    }), 'invalid-state')
    store.close()
  })

  it('recovers a crash after intent by replaying the exact started step after restart', () => {
    const created = createStore()
    const { run } = created.store.beginRun(runInput())
    const intent = created.store.beginStep({
      runId: run.id,
      stepId: 'authority-admission',
      action: { kind: 'verify-authority' },
      beforeDigest: hash('b'),
    })
    created.store.close()

    const restarted = new RecoveryStore({ path: created.path, now: () => 2_000 })
    expect(restarted.beginRun(runInput())).toEqual({ run, replayed: true })
    expect(restarted.beginStep({
      runId: run.id,
      stepId: 'authority-admission',
      action: { kind: 'verify-authority' },
      beforeDigest: hash('b'),
    })).toEqual({ step: intent.step, replayed: true })
    expectStoreError(() => restarted.beginStep({
      runId: run.id,
      stepId: 'authority-admission',
      action: { kind: 'noop', reasonCode: 'different-action' },
      beforeDigest: hash('b'),
    }), 'idempotency-conflict')
    expect(restarted.health()).toMatchObject({ runningRuns: 1, incompleteSteps: 1 })
    restarted.close()
  })

  it('fails closed when a persisted started action no longer matches its durable digest', () => {
    const created = createStore()
    const { run } = created.store.beginRun(runInput())
    created.store.beginStep({
      runId: run.id,
      stepId: 'authority-admission',
      action: { kind: 'verify-authority' },
      beforeDigest: hash('b'),
    })
    created.store.close()

    const database = new DatabaseSync(created.path)
    database.prepare(`
      UPDATE recovery_steps SET action_json = ?
      WHERE run_id = ? AND step_id = 'authority-admission'
    `).run('{"kind":"noop","reasonCode":"tampered"}', run.id)
    database.close()

    const restarted = new RecoveryStore({ path: created.path, now: () => 2_000 })
    expectStoreError(
      () => restarted.getStep(run.id, 'authority-admission'),
      'invalid-state',
    )
    expectStoreError(() => restarted.beginStep({
      runId: run.id,
      stepId: 'authority-admission',
      action: { kind: 'verify-authority' },
      beforeDigest: hash('b'),
    }), 'invalid-state')
    restarted.close()
  })

  it('reads legacy unfenced maintenance intent for audit but never accepts it as a new action', () => {
    const created = createStore()
    const { run } = created.store.beginRun(runInput())
    for (const [stepId, action] of [
      ['authority-admission', { kind: 'verify-authority' }],
      ['ledger-reconcile', { kind: 'noop', reasonCode: 'nothing-pending' }],
    ] as const) {
      const step = created.store.beginStep({
        runId: run.id,
        stepId,
        action,
        beforeDigest: hash('b'),
      }).step
      created.store.completeStep({
        runId: run.id,
        stepId,
        expectedVersion: step.version,
        status: stepId === 'authority-admission' ? 'succeeded' : 'noop',
        beforeDigest: step.beforeDigest,
        afterDigest: hash('c'),
        resultCode: stepId === 'authority-admission' ? 'authority-proven' : 'nothing-pending',
      })
    }
    expectStoreError(() => created.store.beginStep({
      runId: run.id,
      stepId: 'retention-maintenance',
      action: { kind: 'maintain-preferences', limit: 1 },
      beforeDigest: hash('b'),
    }), 'invalid-input')
    created.store.beginStep({
      runId: run.id,
      stepId: 'retention-maintenance',
      action: {
        kind: 'maintain-preferences',
        limit: 1,
        ownerGeneration: 1,
        principalLineage: { principalRecordId: 'principal-row-1', principalVersion: 1 },
      },
      beforeDigest: hash('b'),
    })
    created.store.close()

    const legacyActionJson = '{"kind":"maintain-preferences","limit":1}'
    const database = new DatabaseSync(created.path)
    database.prepare(`
      UPDATE recovery_steps SET action_json = ?, action_digest = ?
      WHERE run_id = ? AND step_id = 'retention-maintenance'
    `).run(
      legacyActionJson,
      createHash('sha256').update(legacyActionJson).digest('hex'),
      run.id,
    )
    database.close()

    const restarted = new RecoveryStore({ path: created.path, now: () => 2_000 })
    expect(restarted.getStep(run.id, 'retention-maintenance')).toMatchObject({
      status: 'started',
      action: { kind: 'maintain-preferences', limit: 1 },
    })
    expect(restarted.listSteps(run.id)).toHaveLength(3)
    restarted.close()
  })

  it('derives stale health only from immutable run and step deadlines', () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-deadline-'))
    roots.push(root)
    let now = 1_000
    const store = new RecoveryStore({
      path: join(root, 'recovery.sqlite'),
      now: () => now,
      maxStepDurationMs: 100,
      deadlineGraceMs: 50,
    })
    const run = store.beginRun(runInput()).run
    const step = store.beginStep({
      runId: run.id,
      stepId: 'authority-admission',
      action: { kind: 'verify-authority' },
      beforeDigest: hash('b'),
    }).step
    expect(run.deadlineAt).toBe(2_450)
    expect(step.deadlineAt).toBe(1_150)
    expect(store.health()).toMatchObject({
      runningRuns: 1, incompleteSteps: 1, staleRuns: 0, staleSteps: 0,
    })

    now = 1_150
    expect(store.health()).toMatchObject({ staleRuns: 0, staleSteps: 1 })
    expect(store.deadlineRemainingMs(step.deadlineAt)).toBe(0)
    now = 2_450
    expect(store.health()).toMatchObject({ staleRuns: 1, staleSteps: 1 })
    store.close()
  })

  it('never creates a new step at or after the persisted run deadline', () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-run-deadline-'))
    roots.push(root)
    let now = 1_000
    const store = new RecoveryStore({
      path: join(root, 'recovery.sqlite'),
      now: () => now,
      maxStepDurationMs: 100,
      deadlineGraceMs: 0,
    })
    const run = store.beginRun(runInput()).run
    expect(run.deadlineAt).toBe(2_400)
    now = run.deadlineAt
    expectStoreError(() => store.beginStep({
      runId: run.id,
      stepId: 'authority-admission',
      action: { kind: 'verify-authority' },
      beforeDigest: hash('b'),
    }), 'deadline-expired')
    expect(store.listSteps(run.id)).toEqual([])
    store.close()
  })

  it('makes a terminal receipt replayable but rejects a contradictory receipt', () => {
    const { store } = createStore()
    const { run } = store.beginRun(runInput())
    const { step } = store.beginStep({
      runId: run.id,
      stepId: 'authority-admission',
      action: { kind: 'verify-authority' },
      beforeDigest: hash('b'),
    })
    const request = {
      runId: run.id,
      stepId: 'authority-admission' as const,
      expectedVersion: step.version,
      status: 'noop' as const,
      beforeDigest: hash('b'),
      afterDigest: hash('c'),
      resultCode: 'already-valid',
    }
    const completed = store.completeStep(request)
    expect(store.completeStep(request)).toEqual(completed)
    expectStoreError(
      () => store.completeStep({ ...request, resultCode: 'different-result' }),
      'idempotency-conflict',
    )
    store.close()
  })

  it('never lets terminal settlement rewrite the before digest from the durable intent', () => {
    const { store } = createStore()
    const { run } = store.beginRun(runInput())
    const { step } = store.beginStep({
      runId: run.id,
      stepId: 'authority-admission',
      action: { kind: 'verify-authority' },
      beforeDigest: hash('b'),
    })
    expectStoreError(() => store.completeStep({
      runId: run.id,
      stepId: 'authority-admission',
      expectedVersion: step.version,
      status: 'succeeded',
      beforeDigest: hash('c'),
      afterDigest: hash('d'),
      resultCode: 'authority-proven',
    }), 'idempotency-conflict')
    expect(store.getStep(run.id, 'authority-admission')).toMatchObject({
      status: 'started', beforeDigest: hash('b'),
    })
    store.close()
  })

  it('requires a successful verification receipt before marking a run succeeded', () => {
    const { store } = createStore()
    const completed = completeSuccessfulRun(store, runInput())
    expect(completed).toMatchObject({ status: 'succeeded', version: 2 })
    expect(store.health()).toMatchObject({ runningRuns: 0, failedRuns: 0, lastSucceededAt: 1_000 })
    store.close()
  })

  it('projects a frozen exact multi-job bootstrap attestation in canonical order', () => {
    const { store, path } = createStore()
    expect(store.health()).toMatchObject({
      bootstrapStatus: 'idle',
      bootstrapGeneration: 0,
      bootstrapAttestationValid: false,
      bootstrapAttestations: [],
      bootstrapAttestationSetDigest: EMPTY_BOOTSTRAP_ATTESTATION_SET_DIGEST,
      bootstrapUpdatedAt: 0,
    })
    const started = store.beginBootstrap({ attestationValid: false, attestations: [] })
    expect(started).toMatchObject({
      status: 'running', generation: 1, attestationValid: false, attestations: [], updatedAt: 1_000,
    })
    const attested = store.attestBootstrap({
      expectedGeneration: started.generation,
      attestations: [
        bootstrapAttestation('recovery:zeta', 'paused', 'e'),
        bootstrapAttestation('recovery:alpha', 'preview', 'f'),
      ],
    })
    expect(attested).toMatchObject({
      status: 'running',
      generation: 1,
      attestationValid: true,
      attestations: [
        bootstrapAttestation('recovery:alpha', 'preview', 'f'),
        bootstrapAttestation('recovery:zeta', 'paused', 'e'),
      ],
    })
    expect(attested.attestationSetDigest).toMatch(/^[a-f\d]{64}$/u)
    expect(Object.isFrozen(attested)).toBe(true)
    expect(Object.isFrozen(attested.attestations)).toBe(true)
    expect(attested.attestations.every(Object.isFrozen)).toBe(true)
    const expectedCanonical = canonicalRecoveryBootstrapAttestationSet([
      bootstrapAttestation('recovery:zeta', 'paused', 'e'),
      bootstrapAttestation('recovery:alpha', 'preview', 'f'),
    ])
    const inspection = new DatabaseSync(path, { readOnly: true })
    const durable = inspection.prepare(`
      SELECT bootstrap_attestations_json, bootstrap_attestation_set_digest
      FROM recovery_runtime_state WHERE singleton = 1
    `).get() as unknown as {
      bootstrap_attestations_json: string
      bootstrap_attestation_set_digest: string
    }
    inspection.close()
    expect(durable.bootstrap_attestations_json).toBe(JSON.stringify(expectedCanonical))
    expect(durable.bootstrap_attestation_set_digest)
      .toBe(recoveryBootstrapAttestationSetDigest(expectedCanonical))

    const failed = store.completeBootstrap({
      expectedGeneration: started.generation,
      status: 'failed',
      failureCode: 'policy-denied',
    })
    expect(failed).toMatchObject({ status: 'failed', failureCode: 'policy-denied' })
    expect(store.completeBootstrap({
      expectedGeneration: started.generation,
      status: 'failed',
      failureCode: 'policy-denied',
    })).toEqual(failed)
    expect(store.health()).toMatchObject({
      bootstrapStatus: 'failed',
      bootstrapFailureCode: 'policy-denied',
      bootstrapGeneration: 1,
      bootstrapAttestationValid: true,
      bootstrapAttestationSetDigest: attested.attestationSetDigest,
      bootstrapAttestations: attested.attestations,
      bootstrapUpdatedAt: 1_000,
    })
    store.close()
  })

  it('uses generation CAS across equal timestamps and clock rollback', () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-bootstrap-generation-'))
    roots.push(root)
    const path = join(root, 'recovery.sqlite')
    const first = new RecoveryStore({ path, now: () => 1_000 })
    const generationOne = first.beginBootstrap({ attestationValid: false, attestations: [] })
    const sameMillisecond = first.beginBootstrap({ attestationValid: false, attestations: [] })
    expect(sameMillisecond).toMatchObject({ generation: 2, status: 'running', updatedAt: 1_000 })

    const second = new RecoveryStore({ path, now: () => 500 })
    const generationTwo = second.beginBootstrap({
      attestationValid: true,
      attestations: [bootstrapAttestation('recovery:current', 'active', 'e')],
    })
    expect(generationTwo).toMatchObject({ generation: 3, status: 'running', updatedAt: 500 })
    expectStoreError(() => first.completeBootstrap({
      expectedGeneration: generationOne.generation,
      status: 'succeeded',
    }), 'version-conflict')

    const succeeded = second.completeBootstrap({
      expectedGeneration: generationTwo.generation,
      status: 'succeeded',
    })
    expect(succeeded).toMatchObject({ generation: 3, status: 'succeeded', updatedAt: 500 })
    expect(first.health()).toMatchObject({
      bootstrapGeneration: 3,
      bootstrapStatus: 'succeeded',
      bootstrapUpdatedAt: 500,
      bootstrapAttestations: [bootstrapAttestation('recovery:current', 'active', 'e')],
    })
    second.close()
    first.close()
  })

  it('fails closed when the durable bootstrap attestation no longer matches its digest', () => {
    const created = createStore()
    created.store.beginBootstrap({
      attestationValid: true,
      attestations: [bootstrapAttestation('recovery:current', 'active', 'e')],
    })
    created.store.close()

    const database = new DatabaseSync(created.path)
    database.prepare(`
      UPDATE recovery_runtime_state
      SET bootstrap_attestations_json = replace(
        bootstrap_attestations_json, 'nonce-recovery:current', 'tampered-nonce')
      WHERE singleton = 1
    `).run()
    database.close()

    const restarted = new RecoveryStore({ path: created.path })
    expectStoreError(() => restarted.health(), 'invalid-state')
    restarted.close()
  })

  it('requires an exact successful preview attestation before production activation', () => {
    const { store } = createStore()
    const previewInput = runInput({ executionMode: 'preview' })
    const preview = completeSuccessfulRun(store, previewInput)
    const exact = {
      automationId: previewInput.automationId,
      targetScope: previewInput.targetScope,
      principal: previewInput.principal,
      ownerRouteId: previewInput.ownerRouteId,
      activationNonce: previewInput.activationNonce,
      activationPlanDigest: previewInput.activationPlanDigest,
      catalogDigest: previewInput.catalogDigest,
    }
    expect(store.findSuccessfulPreview(exact)).toEqual(preview)
    expect(store.findSuccessfulPreview({ ...exact, activationNonce: 'different' })).toBeUndefined()
    expect(store.findSuccessfulPreview({ ...exact, activationPlanDigest: hash('f') })).toBeUndefined()
    expect(store.findSuccessfulPreview({
      ...exact,
      targetScope: { ...exact.targetScope, preset: 'different' },
    })).toBeUndefined()
    expect(store.findSuccessfulPreview({ ...exact, ownerRouteId: 'different' })).toBeUndefined()
    store.close()
  })

  it('allows fail-fast completion only after the started step has a failure receipt', () => {
    const { store } = createStore()
    const { run } = store.beginRun(runInput())
    const { step } = store.beginStep({
      runId: run.id,
      stepId: 'authority-admission',
      action: { kind: 'verify-authority' },
      beforeDigest: hash('b'),
    })
    expectStoreError(() => store.completeRun({
      runId: run.id,
      expectedVersion: run.version,
      status: 'failed',
      resultCode: 'admission-failed',
    }), 'invalid-state')
    store.completeStep({
      runId: run.id,
      stepId: 'authority-admission',
      expectedVersion: step.version,
      status: 'failed',
      beforeDigest: hash('b'),
      afterDigest: hash('c'),
      resultCode: 'scope-mismatch',
    })
    expect(store.completeRun({
      runId: run.id,
      expectedVersion: run.version,
      status: 'failed',
      resultCode: 'admission-failed',
    })).toMatchObject({ status: 'failed', resultCode: 'admission-failed' })
    store.close()
  })

  it('never treats preview and production for one occurrence as interchangeable', () => {
    const { store } = createStore()
    store.beginRun(runInput({ executionMode: 'preview' }))
    expectStoreError(
      () => store.beginRun(runInput({ executionMode: 'production' })),
      'idempotency-conflict',
    )
    store.close()
  })

  it('does not let a later preview hide the latest production failure in health', () => {
    let now = 1_000
    const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-'))
    roots.push(root)
    const store = new RecoveryStore({ path: join(root, 'recovery.sqlite'), now: () => now })
    const failed = store.beginRun(runInput()).run
    store.completeRun({
      runId: failed.id,
      expectedVersion: failed.version,
      status: 'failed',
      resultCode: 'production-failed',
    })
    now = 2_000
    const preview = store.beginRun(runInput({ occurrenceId: 'preview-2', executionMode: 'preview' })).run
    store.completeRun({
      runId: preview.id,
      expectedVersion: preview.version,
      status: 'failed',
      resultCode: 'preview-failed',
    })

    expect(store.health()).toMatchObject({
      latestProductionStatus: 'failed',
      consecutiveProductionFailures: 1,
      lastProductionRunAt: 1_000,
    })
    store.close()
  })

  it.each<RecoveryStepId>([
    'authority-admission',
    'ledger-reconcile',
    'retention-maintenance',
    't1-effects',
    'regression-rollback',
    'incident-review',
    'verification',
  ])('keeps catalog step %s stable', (stepId) => {
    expect(RECOVERY_CATALOG.some(step => step.id === stepId)).toBe(true)
  })
})
