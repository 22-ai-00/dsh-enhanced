import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  IN_PROCESS_RELOAD_DENYLIST, InProcessReloadRefusal, applyInProcessReload, inProcessReloadWarrantDigest,
  prepareInProcessReload, rollbackInProcessReload, type InProcessReloadHostActivationInput,
  type InProcessReloadHostActivationResult, type InProcessReloadHostPort, type InProcessReloadHostProbe,
  type InProcessReloadHostRollbackInput, type InProcessReloadHostRollbackResult, type InProcessReloadSnapshot,
} from '../src/in-process-reload.js'
import {
  Ed25519HostAttestationAuthority, hostAttestationEvidenceDigest, hostAttestationRequestDigest, hostAttestationSigningPayload,
  parseHostAttestationReceipt,
} from '../src/attestation.js'
import { ControlPlaneStoreError } from '../src/store.js'
import type {
  HostAttestationEvidence, HostAttestationReceipt, HostAttestationRequest, HostAttestationRequirements,
  PluginActivationPlan,
} from '../src/types.js'

const digest = (fill: string): string => fill.repeat(64)
const now = 1_800_000_000_000

const target: InProcessReloadSnapshot['target'] = {
  package: '@dsh-enhanced/assistant-health', version: '0.1.65',
  artifactDigest: digest('a'), patchDigest: digest('b'),
  changesProcessSubtree: false, holdsUnprovenProcessAuthority: false,
}

const snapshot = (overrides: Partial<InProcessReloadSnapshot> = {}): InProcessReloadSnapshot => ({
  planId: 'plan:1', planDigest: digest('c'), status: 'awaiting-reload',
  activation: { id: 'activation:1', fence: 2 }, hostGeneration: 3, inProcessGeneration: 1,
  running: { artifactDigest: target.artifactDigest, patchDigest: digest('d') },
  target: { ...target }, ...overrides,
})

const probe = (overrides: Partial<InProcessReloadHostProbe> = {}): InProcessReloadHostProbe => ({
  checks: 9, failures: 0, reloaded: true, fibersDisposed: 1, probeDigest: digest('e'), ...overrides,
})

interface Calls { activate: InProcessReloadHostActivationInput[]; rollback: InProcessReloadHostRollbackInput[] }

function port(options: {
  activation?: (input: InProcessReloadHostActivationInput) => Promise<InProcessReloadHostActivationResult>
  rollback?: (input: InProcessReloadHostRollbackInput) => Promise<InProcessReloadHostRollbackResult>
} = {}): { port: InProcessReloadHostPort; calls: Calls } {
  const calls: Calls = { activate: [], rollback: [] }
  return { calls, port: {
    async activate(input) {
      calls.activate.push(input)
      if (options.activation) return options.activation(input)
      return { previousHostGeneration: input.previousHostGeneration, currentHostGeneration: input.previousHostGeneration,
        previousInProcessGeneration: input.previousInProcessGeneration, currentInProcessGeneration: input.previousInProcessGeneration + 1, probe: probe() }
    },
    async rollback(input) {
      calls.rollback.push(input)
      if (options.rollback) return options.rollback(input)
      return { hostGeneration: 3, inProcessGeneration: input.reloadedInProcessGeneration + 1, restored: true, profileRestored: true, probe: probe() }
    },
  } }
}

function warrantFor(value: InProcessReloadSnapshot) {
  return prepareInProcessReload({ snapshot: value, requestedAt: now, ttlMs: 10_000 })
}

async function refusalOf(work: Promise<unknown> | (() => unknown)): Promise<InProcessReloadRefusal> {
  try { await (typeof work === 'function' ? work() : work) } catch (error) {
    if (error instanceof InProcessReloadRefusal) return error
    throw error
  }
  throw new Error('expected an InProcessReloadRefusal')
}

describe('prepareInProcessReload', () => {
  test('binds a warrant to plan, fence, generations and target', () => {
    const value = snapshot()
    const warrant = warrantFor(value)
    expect(warrant).toMatchObject({
      schemaVersion: 1, kind: 'dsh-in-process-reload-warrant',
      planId: value.planId, planDigest: value.planDigest, activationId: value.activation.id, fence: value.activation.fence,
      previousHostGeneration: value.hostGeneration, previousInProcessGeneration: value.inProcessGeneration,
      requestedAt: now, expiresAt: now + 10_000, target: value.target,
    })
    expect(warrant.digest).toMatch(/^[a-f0-9]{64}$/u)
    const { digest: _digest, ...body } = warrant
    expect(inProcessReloadWarrantDigest(body)).toBe(warrant.digest)
    expect(() => warrantFor(snapshot({ planDigest: digest('f') }))).not.toThrow()
  })

  test.each(['staging', 'awaiting-readiness', 'reloaded', 'rollback-pending', 'activated'])('refuses plan status %s', async status => {
    expect((await refusalOf(() => warrantFor(snapshot({ status })))).reason).toBe('not-awaiting-reload')
  })

  test.each(IN_PROCESS_RELOAD_DENYLIST)('never hot-reloads %s', async packageName => {
    const refusal = await refusalOf(() => warrantFor(snapshot({ target: { ...target, package: packageName } })))
    expect(refusal.reason).toBe('never-hot-reload')
    expect(refusal.code).toBe('conflict')
  })

  test('refuses a dependency-subtree change and unproven process authority', async () => {
    expect((await refusalOf(() => warrantFor(snapshot({ target: { ...target, changesProcessSubtree: true } })))).reason)
      .toBe('process-subtree-change')
    expect((await refusalOf(() => warrantFor(snapshot({ target: { ...target, holdsUnprovenProcessAuthority: true } })))).reason)
      .toBe('unproven-process-authority')
  })

  test('refuses replacing the installed artifact in-process', async () => {
    const value = snapshot({ running: { artifactDigest: digest('f'), patchDigest: digest('d') } })
    expect((await refusalOf(() => warrantFor(value))).reason).toBe('artifact-digest-mismatch')
  })

  test('refuses when the profile patch did not change', async () => {
    const value = snapshot({ running: { artifactDigest: target.artifactDigest, patchDigest: target.patchDigest } })
    expect((await refusalOf(() => warrantFor(value))).reason).toBe('patch-digest-mismatch')
  })

  test('refuses malformed snapshots and targets', async () => {
    expect((await refusalOf(() => warrantFor(snapshot({ planDigest: 'not-a-digest' })))).reason).toBe('invalid-target')
    expect((await refusalOf(() => warrantFor(snapshot({ hostGeneration: 0 })))).reason).toBe('invalid-target')
    expect((await refusalOf(() => warrantFor(snapshot({ target: { ...target, artifactDigest: 'a'.repeat(63) } })))).reason).toBe('invalid-target')
    expect((await refusalOf(() => warrantFor(snapshot({ target: { ...target, changesProcessSubtree: 'no' as never } })))).reason).toBe('invalid-target')
    expect((await refusalOf(() => prepareInProcessReload({ snapshot: snapshot(), requestedAt: now, ttlMs: 0 }))).reason).toBe('invalid-target')
  })
})

describe('applyInProcessReload', () => {
  test('returns a reloaded result only from a failure-free probe', async () => {
    const value = snapshot()
    const { port: host, calls } = port()
    const result = await applyInProcessReload({ warrant: warrantFor(value), snapshot: value, port: host, now })
    expect(result).toEqual({
      status: 'reloaded', reloaded: true,
      previousHostGeneration: 3, currentHostGeneration: 3,
      previousInProcessGeneration: 1, currentInProcessGeneration: 2,
      fibersDisposed: 1, probeDigest: digest('e'), warrantDigest: warrantFor(value).digest,
    })
    expect(calls.activate).toHaveLength(1)
    expect(calls.activate[0]).toMatchObject({
      target: value.target, previousHostGeneration: 3, previousInProcessGeneration: 1,
    })
  })

  test('refuses a stale fence without calling the Host', async () => {
    const value = snapshot()
    const warrant = warrantFor(value)
    const { port: host, calls } = port()
    const refusal = await refusalOf(applyInProcessReload({ warrant, snapshot: snapshot({ activation: { id: 'activation:1', fence: 3 } }), port: host, now }))
    expect(refusal.reason).toBe('stale-fence')
    expect(calls.activate).toHaveLength(0)
  })

  test('refuses a warrant bound to another plan revision', async () => {
    const { port: host } = port()
    const refusal = await refusalOf(applyInProcessReload({
      warrant: warrantFor(snapshot()), snapshot: snapshot({ planDigest: digest('f') }), port: host, now,
    }))
    expect(refusal.reason).toBe('stale-fence')
  })

  test('refuses a tampered or expired warrant', async () => {
    const value = snapshot()
    const warrant = warrantFor(value)
    const { port: host } = port()
    expect((await refusalOf(applyInProcessReload({ warrant: { ...warrant, fence: 9 }, snapshot: value, port: host, now }))).reason)
      .toBe('warrant-digest-mismatch')
    expect((await refusalOf(applyInProcessReload({ warrant, snapshot: value, port: host, now: warrant.expiresAt + 1 }))).reason)
      .toBe('warrant-expired')
  })

  test('refuses when the plan left awaiting-reload after preparation', async () => {
    const value = snapshot()
    const warrant = warrantFor(value)
    const { port: host, calls } = port()
    for (const status of ['reloaded', 'rollback-pending', 'awaiting-readiness', 'activated']) {
      expect((await refusalOf(applyInProcessReload({ warrant, snapshot: snapshot({ status }), port: host, now }))).reason)
        .toBe('not-awaiting-reload')
    }
    expect(calls.activate).toHaveLength(0)
  })

  test('maps a Host exception to rollback-pending', async () => {
    const value = snapshot()
    const { port: host } = port({ activation: async () => { throw new Error('include root missing') } })
    const result = await applyInProcessReload({ warrant: warrantFor(value), snapshot: value, port: host, now })
    expect(result).toMatchObject({ status: 'rollback-pending', code: 'host-activation-failed' })
    expect(result.status === 'rollback-pending' && result.detail).toContain('include root missing')
  })

  test('never reports a reload when the Host process generation moved', async () => {
    const value = snapshot()
    const { port: host } = port({ activation: async input => ({
      previousHostGeneration: input.previousHostGeneration, currentHostGeneration: input.previousHostGeneration + 1,
      previousInProcessGeneration: input.previousInProcessGeneration, currentInProcessGeneration: input.previousInProcessGeneration + 1, probe: probe(),
    }) })
    expect(await applyInProcessReload({ warrant: warrantFor(value), snapshot: value, port: host, now }))
      .toMatchObject({ status: 'rollback-pending', code: 'host-generation-changed' })
  })

  test('never reports a reload when the in-process generation is not monotonic', async () => {
    const value = snapshot()
    for (const currentInProcessGeneration of [1, 3, 0]) {
      const { port: host } = port({ activation: async input => ({
        previousHostGeneration: input.previousHostGeneration, currentHostGeneration: input.previousHostGeneration,
        previousInProcessGeneration: input.previousInProcessGeneration, currentInProcessGeneration, probe: probe(),
      }) })
      expect(await applyInProcessReload({ warrant: warrantFor(value), snapshot: value, port: host, now }))
        .toMatchObject({ status: 'rollback-pending', code: 'in-process-generation-not-monotonic' })
    }
  })

  test('maps probe failures, unproven reloads and malformed probes to rollback-pending', async () => {
    const value = snapshot()
    const cases: Array<[InProcessReloadHostProbe, string]> = [
      [probe({ failures: 1, reloaded: false }), 'probe-failed'],
      [probe({ reloaded: false }), 'unproven-reload'],
      [probe({ probeDigest: 'nope' }), 'probe-failed'],
      [probe({ checks: 0 }), 'probe-failed'],
      [{ ...probe(), fibersDisposed: -1 }, 'probe-failed'],
    ]
    for (const [resultProbe, code] of cases) {
      const { port: host } = port({ activation: async input => ({
        previousHostGeneration: input.previousHostGeneration, currentHostGeneration: input.previousHostGeneration,
        previousInProcessGeneration: input.previousInProcessGeneration, currentInProcessGeneration: input.previousInProcessGeneration + 1, probe: resultProbe,
      }) })
      const result = await applyInProcessReload({ warrant: warrantFor(value), snapshot: value, port: host, now })
      expect(result).toMatchObject({ status: 'rollback-pending', code })
      expect(Object.keys(result)).not.toContain('probeDigest')
    }
  })

  test('refusal reasons stay distinct typed store errors', () => {
    const refusal = new InProcessReloadRefusal('stale-fence', 'fenced out')
    expect(refusal).toBeInstanceOf(ControlPlaneStoreError)
    expect(refusal).toMatchObject({ code: 'conflict', reason: 'stale-fence', name: 'InProcessReloadRefusal' })
    expect(new InProcessReloadRefusal('warrant-expired', 'expired').code).toBe('expired')
    expect(new InProcessReloadRefusal('invalid-target', 'bad').code).toBe('invalid-input')
  })
})

describe('rollbackInProcessReload', () => {
  // A rollback reuses the warrant prepared while the plan was still
  // `awaiting-reload`: the status transition to `rollback-pending` does not
  // rebind plan, fence or generations.
  const prepared = snapshot()
  const rollbackSnapshot = (overrides: Partial<InProcessReloadSnapshot> = {}) => snapshot({ status: 'rollback-pending', ...overrides })
  const rollbackWarrant = warrantFor(prepared)

  test('claims a rollback only with a proven profile restore and probe', async () => {
    const value = rollbackSnapshot()
    const { port: host, calls } = port()
    const result = await rollbackInProcessReload({ warrant: rollbackWarrant, snapshot: value, port: host, now })
    expect(result).toEqual({ status: 'rolled-back', restored: true, hostGeneration: 3, inProcessGeneration: 2, probeDigest: digest('e'), warrantDigest: rollbackWarrant.digest })
    expect(calls.rollback[0]).toMatchObject({ reloadedInProcessGeneration: 1 })
  })

  test('stays rollback-pending when the profile restore is unproven', async () => {
    const value = rollbackSnapshot()
    for (const result of [
      { hostGeneration: 3, inProcessGeneration: 2, restored: true, profileRestored: false, probe: probe() },
      { hostGeneration: 3, inProcessGeneration: 2, restored: false, profileRestored: true, probe: probe() },
    ]) {
      const { port: host } = port({ rollback: async () => result })
      expect(await rollbackInProcessReload({ warrant: rollbackWarrant, snapshot: value, port: host, now }))
        .toMatchObject({ status: 'rollback-pending', code: 'restore-unproven' })
    }
  })

  test('stays rollback-pending when the rollback probe is not failure-free', async () => {
    const value = rollbackSnapshot()
    const { port: host } = port({ rollback: async input => ({
      hostGeneration: 3, inProcessGeneration: input.reloadedInProcessGeneration + 1,
      restored: true, profileRestored: true, probe: probe({ failures: 2, reloaded: false }),
    }) })
    expect(await rollbackInProcessReload({ warrant: rollbackWarrant, snapshot: value, port: host, now }))
      .toMatchObject({ status: 'rollback-pending', code: 'probe-failed' })
  })

  test('maps a rollback exception and a moved Host generation to rollback-pending', async () => {
    const value = rollbackSnapshot()
    const throwing = port({ rollback: async () => { throw new Error('restore hook missing') } })
    expect(await rollbackInProcessReload({ warrant: rollbackWarrant, snapshot: value, port: throwing.port, now }))
      .toMatchObject({ status: 'rollback-pending', code: 'host-rollback-failed' })
    const moved = port({ rollback: async () => ({ hostGeneration: 4, inProcessGeneration: 2, restored: true, profileRestored: true, probe: probe() }) })
    expect(await rollbackInProcessReload({ warrant: rollbackWarrant, snapshot: value, port: moved.port, now }))
      .toMatchObject({ status: 'rollback-pending', code: 'host-generation-changed' })
  })

  test('refuses a plan that is not rollback-eligible', async () => {
    const { port: host, calls } = port()
    for (const status of ['awaiting-reload', 'activated', 'staging']) {
      expect((await refusalOf(rollbackInProcessReload({ warrant: rollbackWarrant, snapshot: snapshot({ status }), port: host, now }))).reason)
        .toBe('not-rollback-eligible')
    }
    expect(calls.rollback).toHaveLength(0)
  })
})


describe('in-process reload attestation', () => {
  const keys = generateKeyPairSync('ed25519')
  const authority = new Ed25519HostAttestationAuthority(keys.publicKey.export({ type: 'spki', format: 'pem' }), 'host', 'host-key', () => now)
  const installationId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00'
  const plan = {
    id: 'plan:1', digest: digest('c'), installationId, createdAt: now - 1_000,
    activation: { id: 'activation:1', fence: 2 },
  } as unknown as PluginActivationPlan

  const requirements: HostAttestationRequirements = {
    kind: 'in-process-reload', previousHostGeneration: 3, previousInProcessGeneration: 1,
    artifactDigest: digest('a'), patchDigest: digest('b'), minimumChecks: 4,
  }
  const request = (overrides: Partial<HostAttestationRequest> = {}): HostAttestationRequest => ({
    schemaVersion: 2, kind: 'dsh-host-attestation-request', operationId: 'operation:1', requestedAt: now,
    receiptTtlMs: 10_000, installationId, ledger: { id: 'ledger:1', path: '/tmp/ledger' },
    plan: { id: 'plan:1', digest: digest('c') }, activation: { id: 'activation:1', fence: 2 },
    profile: { name: 'web', path: '/tmp/profile' }, issuer: { mode: 'owner-manual' }, phase: 'reload',
    requirements, predecessor: null, ...overrides,
  })
  const evidence = (overrides: Partial<HostAttestationEvidence> = {}): HostAttestationEvidence => ({
    kind: 'in-process-reload', reloaded: true, previousHostGeneration: 3, currentHostGeneration: 3,
    previousInProcessGeneration: 1, currentInProcessGeneration: 2, fibersDisposed: 1,
    checks: 9, failures: 0, probeDigest: digest('e'), ...overrides,
  } as HostAttestationEvidence)
  const receipt = (hostEvidence: HostAttestationEvidence, overrides: Partial<HostAttestationReceipt> = {}): HostAttestationReceipt => {
    const unsigned: Omit<HostAttestationReceipt, 'signature'> = {
      schemaVersion: 2, receiptId: 'receipt:1', authority: 'host', keyId: 'host-key', installationId,
      planId: 'plan:1', planDigest: digest('c'), activationId: 'activation:1', fence: 2, operationId: 'operation:1',
      requestDigest: hostAttestationRequestDigest(request()), phase: 'reload', outcome: 'passed', hostGeneration: 3,
      evidence: hostEvidence, evidenceDigest: hostAttestationEvidenceDigest(hostEvidence),
      observedAt: now, expiresAt: now + 10_000, ...overrides,
    }
    return { ...unsigned, signature: sign(null, Buffer.from(hostAttestationSigningPayload(unsigned)), keys.privateKey).toString('base64') }
  }

  test('accepts a config-only in-process reload under the reload phase', async () => {
    const value = request()
    const unsigned = receipt(evidence())
    const verified = await authority.verify(unsigned, plan, value)
    expect(verified.evidence).toMatchObject({ kind: 'in-process-reload', currentInProcessGeneration: 2 })
    expect(verified.hostGeneration).toBe(3)
  })

  test('never lets in-process evidence satisfy the process-restart reload contract', async () => {
    // A generation bump is the process-restart signature; in-process evidence must not carry it.
    const restartShaped = evidence({ currentHostGeneration: 4, currentInProcessGeneration: 1 })
    await expect(authority.verify(receipt(restartShaped), plan, request())).rejects.toMatchObject({ code: 'invalid-input' })
    // Nor may a restart-style requirement accept in-process evidence.
    await expect(authority.verify(receipt(evidence()), plan, request({
      requirements: { kind: 'reload', previousHostGeneration: 3, probeDigestMinimumChecks: 1 } as unknown as HostAttestationRequirements,
    }))).rejects.toMatchObject({ code: 'conflict' })
  })

  test.each([
    ['fewer than minimumChecks', { checks: 3 }],
    ['a reported failure', { failures: 1 }],
    ['an unproven reload', { reloaded: false }],
    ['a stale in-process generation', { currentInProcessGeneration: 3 }],
    ['a non-monotonic in-process generation', { currentInProcessGeneration: 1 }],
  ])('rejects passed in-process evidence with %s', async (_label, overrides) => {
    await expect(authority.verify(receipt(evidence(overrides as Partial<HostAttestationEvidence>)), plan, request()))
      .rejects.toMatchObject({ code: 'invalid-input' })
  })

  test('parses evidence strictly and rejects extra or malformed fields', () => {
    const good = receipt(evidence())
    expect(parseHostAttestationReceipt(good).evidence).toMatchObject({ kind: 'in-process-reload', checks: 9 })
    expect(() => parseHostAttestationReceipt({ ...good, evidence: { ...evidence(), extra: true },
      evidenceDigest: hostAttestationEvidenceDigest({ ...evidence(), extra: true } as never) })).toThrow(ControlPlaneStoreError)
    expect(() => parseHostAttestationReceipt({ ...good, evidence: { ...evidence(), failures: 10 },
      evidenceDigest: hostAttestationEvidenceDigest({ ...evidence(), failures: 10 } as never) })).toThrow(ControlPlaneStoreError)
    expect(() => parseHostAttestationReceipt({ ...good, evidence: { ...evidence(), probeDigest: 'x' },
      evidenceDigest: hostAttestationEvidenceDigest({ ...evidence(), probeDigest: 'x' } as never) })).toThrow(ControlPlaneStoreError)
  })

  test('keeps the requirements shape additive and digest-bound', () => {
    expect(requirements.kind).toBe('in-process-reload')
    expect(hostAttestationEvidenceDigest(evidence())).toMatch(/^[a-f0-9]{64}$/u)
  })
})
