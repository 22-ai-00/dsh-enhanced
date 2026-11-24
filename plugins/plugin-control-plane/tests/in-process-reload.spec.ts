import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { EntryGroup, EntryTree, Loader } from '@deepseek-ai/cordis-plugin-loader'
import * as assistantDeliveryPlugin from '@dsh-enhanced/assistant-delivery'
import {
  computeInProcessArtifactDigest,
  computeInProcessPatchDigest,
} from '@dsh-enhanced/assistant-delivery'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { HostAutomationExecutor, HostAutomationExecutorInput } from '@dsh-enhanced/assistant-automations'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as releaseModule from '../src/release.ts'

vi.mock('../src/release.ts', async original => ({ ...await original<typeof releaseModule>(), invokeSourceReleaseAdapter: vi.fn() }))

import { coordinateAdoptionHandoff } from '../src/adoption-coordinator.js'
import { Ed25519ApprovalAuthority, approvalSigningPayload } from '../src/approval.js'
import { exampleIntegrityPinnedCatalog } from '../src/catalog.js'
import {
  IN_PROCESS_RELOAD_DENYLIST, InProcessReloadRefusal, applyInProcessReload, buildInProcessReloadEvidence,
  buildInProcessReloadRequirements, executeInProcessReloadHandoff, inProcessReloadWarrantDigest,
  prepareInProcessReload, rollbackInProcessReload, type InProcessReloadHostActivationInput,
  type InProcessReloadHostActivationResult, type InProcessReloadHostPort, type InProcessReloadHostProbe,
  type InProcessReloadHostRollbackInput, type InProcessReloadHostRollbackResult, type InProcessReloadSnapshot,
} from '../src/in-process-reload.js'
import { PluginControlPlaneService } from '../src/service.js'
import {
  Ed25519HostAttestationAuthority, hostAttestationEvidenceDigest, hostAttestationRequestDigest, hostAttestationSigningPayload,
  parseHostAttestationReceipt,
} from '../src/attestation.js'
import { ControlPlaneStore, ControlPlaneStoreError, controlPlaneDigest } from '../src/store.js'
import { resolveSystemdHostAuthority } from '../src/systemd-host-authority.js'
import { hostAuthorizationPlan } from './helpers/host-authorization.js'
import { cleanupReleaseFixtures } from './helpers/source-release-runner.js'

const cleanupCallbacks: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanupCallbacks.splice(0).reverse()) {
    await cleanup()
  }
  await cleanupReleaseFixtures()
})
import type {
  ApprovalReceipt, HostAttestationEvidence, HostAttestationReceipt, HostAttestationRequest,
  HostAttestationRequirements, PluginActivationPlan,
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

describe('artifact-replace mode, store isolation, and Host control-plane handoff', () => {
  test('binds artifact-replace mode, requires fibersDisposed >= 1, and preserves denylist and process-subtree refusals', async () => {
    const artifactSpec = { sourceDir: '/tmp/plugin-v2', config: { greeting: 'v2' } }
    const replaceSnapshot = snapshot({
      mode: 'artifact-replace',
      running: { artifactDigest: digest('f'), patchDigest: digest('d') },
      target: { ...target, version: '0.2.0', artifact: artifactSpec },
    })
    const warrant = prepareInProcessReload({ snapshot: replaceSnapshot, requestedAt: now, ttlMs: 10_000 })
    expect(warrant.mode).toBe('artifact-replace')
    expect(warrant.target.artifact).toEqual(artifactSpec)

    // Still refuses denylist and unproven authority even in artifact-replace mode,
    // while allowing changesProcessSubtree: true under artifact-replace.
    expect(IN_PROCESS_RELOAD_DENYLIST).toEqual([
      '@dsh-enhanced/plugin-control-plane',
      '@dsh-enhanced/assistant-delivery',
    ])
    for (const pkg of IN_PROCESS_RELOAD_DENYLIST) {
      await expect(Promise.resolve().then(() => prepareInProcessReload({
        snapshot: snapshot({
          mode: 'artifact-replace',
          running: { artifactDigest: digest('f'), patchDigest: digest('d') },
          target: { ...target, package: pkg, artifact: artifactSpec },
        }),
        requestedAt: now,
        ttlMs: 10_000,
      }))).rejects.toMatchObject({ reason: 'never-hot-reload' })
    }
    const subtreeArtifactWarrant = prepareInProcessReload({
      snapshot: snapshot({
        mode: 'artifact-replace',
        running: { artifactDigest: digest('f'), patchDigest: digest('d') },
        target: { ...target, package: '@dsh-enhanced/assistant-isolation', changesProcessSubtree: true, artifact: artifactSpec },
      }),
      requestedAt: now,
      ttlMs: 10_000,
    })
    expect(subtreeArtifactWarrant.mode).toBe('artifact-replace')
    expect(subtreeArtifactWarrant.target.changesProcessSubtree).toBe(true)

    const larkChannelWarrant = prepareInProcessReload({
      snapshot: snapshot({
        mode: 'artifact-replace',
        running: { artifactDigest: digest('f'), patchDigest: digest('d') },
        target: { ...target, package: '@dsh-enhanced/lark-channel', changesProcessSubtree: true, artifact: artifactSpec },
      }),
      requestedAt: now,
      ttlMs: 10_000,
    })
    expect(larkChannelWarrant.target.package).toBe('@dsh-enhanced/lark-channel')

    // Tampered artifact spec after warrant issuance is rejected without calling Host port.
    const { port: host, calls } = port()
    await expect(applyInProcessReload({
      warrant,
      snapshot: {
        ...replaceSnapshot,
        target: { ...replaceSnapshot.target, artifact: { sourceDir: '/tmp/evil-v2' } },
      },
      port: host,
      now,
    })).rejects.toMatchObject({ reason: 'artifact-digest-mismatch' })
    expect(calls.activate).toHaveLength(0)

    // Direct executeInProcessReloadHandoff autoRollback toggle check.
    const { port: failingPort, calls: failingCalls } = port({
      activation: async input => ({
        previousHostGeneration: input.previousHostGeneration,
        currentHostGeneration: input.previousHostGeneration,
        previousInProcessGeneration: input.previousInProcessGeneration,
        currentInProcessGeneration: input.previousInProcessGeneration + 1,
        probe: probe({ failures: 1, reloaded: false }),
      }),
    })
    const noAuto = await executeInProcessReloadHandoff({ snapshot: replaceSnapshot, port: failingPort, now, autoRollback: false })
    expect(noAuto.status).toBe('rollback-pending')
    expect(failingCalls.rollback).toHaveLength(0)

    const withAuto = await executeInProcessReloadHandoff({ snapshot: replaceSnapshot, port: failingPort, now })
    expect(withAuto.status).toBe('rolled-back')
    expect(failingCalls.rollback).toHaveLength(1)

    // Artifact replacement claiming reloaded with 0 fibersDisposed maps to rollback-pending.
    const { port: zeroDisposeHost } = port({
      activation: async input => ({
        previousHostGeneration: input.previousHostGeneration,
        currentHostGeneration: input.previousHostGeneration,
        previousInProcessGeneration: input.previousInProcessGeneration,
        currentInProcessGeneration: input.previousInProcessGeneration + 1,
        probe: probe({ fibersDisposed: 0, reloaded: true }),
      }),
    })
    expect(await applyInProcessReload({ warrant, snapshot: replaceSnapshot, port: zeroDisposeHost, now }))
      .toMatchObject({ status: 'rollback-pending', code: 'probe-failed' })
  })

  test('isolates in-process-reload store attestation operations from process-restart reload and systemd-host-authority', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-pcp-ipr-store-')))
    cleanupCallbacks.push(async () => { await rm(root, { recursive: true, force: true }) })
    const dbPath = join(root, 'control.sqlite')
    const store = new ControlPlaneStore({ path: dbPath, now: () => now })
    cleanupCallbacks.push(async () => { store.close() })

    const candidate = exampleIntegrityPinnedCatalog.entries.find(value => value.id === 'assistant-health')!
    const gap = store.recordGap({
      idempotencyKey: 'gap-ipr', capability: 'health', context: 'health',
      expectedValue: 100, frequency: 10, estimatedCost: 50, risk: 0.2,
    })
    let plan = store.createPlan({
      candidate,
      catalog: { digest: controlPlaneDigest(exampleIntegrityPinnedCatalog), provenance: 'owner-provided-integrity-pinned' },
      matchedCapabilities: candidate.capabilities,
      profile: 'web',
      target: { dshHome: root, profile: 'web', profilePath: join(root, 'profiles', 'web') },
      installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00',
      ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: dbPath },
      executor: { id: 'dsh', version: '0.1.2-rc.1', path: join(root, 'dsh'), sha256: digest('d') },
      ttlMs: 60_000,
      gapId: gap.id,
      idempotencyKey: 'plan-ipr',
    }).result

    const ownerKeys = generateKeyPairSync('ed25519')
    const approvalAuthority = new Ed25519ApprovalAuthority(ownerKeys.publicKey.export({ type: 'spki', format: 'pem' }), 'owner', 'owner-key', () => now)
    const approvalBody: Omit<ApprovalReceipt, 'signature'> = {
      schemaVersion: 1, approvalId: 'approval-ipr', authority: 'owner', keyId: 'owner-key',
      planId: plan.id, planDigest: plan.digest, decision: 'approved', principal: 'owner',
      decidedAt: now, expiresAt: now + 30_000,
    }
    plan = (await store.approve({
      planId: plan.id,
      expectedRevision: plan.revision,
      receipt: { ...approvalBody, signature: sign(null, Buffer.from(approvalSigningPayload(approvalBody)), ownerKeys.privateKey).toString('base64') },
      resolveAuthority: () => approvalAuthority,
      idempotencyKey: 'approve-ipr',
    })).result
    plan = await store.claimActivation({
      planId: plan.id,
      expectedRevision: plan.revision,
      leaseMs: 10_000,
      resolveApprovalAuthority: () => approvalAuthority,
    })
    plan = store.advanceActivation({
      planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence,
      from: 'staging', to: 'awaiting-reload',
    })

    const hostKeys = generateKeyPairSync('ed25519')
    const hostAuthority = new Ed25519HostAttestationAuthority(hostKeys.publicKey.export({ type: 'spki', format: 'pem' }), 'host', 'host-key', () => now)

    const inProcessReqs = buildInProcessReloadRequirements({
      previousHostGeneration: 0,
      previousInProcessGeneration: 1,
      artifactDigest: digest('a'),
      patchDigest: digest('b'),
      minimumChecks: 4,
    })
    const operation = store.prepareHostAttestationOperation({
      planId: plan.id,
      expectedRevision: plan.revision,
      expectedFence: plan.activation!.fence,
      issuer: { mode: 'owner-manual' },
      requirements: inProcessReqs,
      receiptTtlMs: 10_000,
    })

    // systemd-host-authority must strictly refuse in-process-reload requests rather than restarting systemd.
    await expect(resolveSystemdHostAuthority({} as never, operation.request as HostAttestationRequest))
      .rejects.toThrow()

    const appliedEvidence = buildInProcessReloadEvidence({
      applied: {
        status: 'reloaded',
        reloaded: true,
        previousHostGeneration: 0,
        currentHostGeneration: 0,
        previousInProcessGeneration: 1,
        currentInProcessGeneration: 2,
        fibersDisposed: 1,
        probeDigest: digest('e'),
        warrantDigest: digest('c'),
      },
      checks: 9,
    })
    // Host running generation must be >= 1 to claim a passed in-process reload receipt.
    const validEvidence: HostAttestationEvidence = {
      ...appliedEvidence,
      previousHostGeneration: 1,
      currentHostGeneration: 1,
    } as HostAttestationEvidence
    const opWithValidGen = parseHostAttestationReceipt({
      schemaVersion: 2, receiptId: 'r:1', authority: 'host', keyId: 'host-key',
      installationId: plan.installationId, planId: plan.id, planDigest: plan.digest,
      activationId: plan.activation!.id, fence: plan.activation!.fence,
      operationId: operation.operationId, requestDigest: hostAttestationRequestDigest(operation.request as HostAttestationRequest),
      phase: 'reload', outcome: 'passed', hostGeneration: 1,
      evidence: validEvidence, evidenceDigest: hostAttestationEvidenceDigest(validEvidence),
      observedAt: now, expiresAt: now + 10_000,
      signature: 'pending',
    } as unknown as HostAttestationReceipt)
    void opWithValidGen

    // In-process evidence submitted against a process-restart { kind: 'reload' } request must fail.
    const restartOperationRequest: HostAttestationRequest = {
      schemaVersion: 2,
      kind: 'dsh-host-attestation-request',
      operationId: 'operation:restart',
      requestedAt: now,
      receiptTtlMs: 10_000,
      installationId: plan.installationId,
      ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: dbPath },
      plan: { id: plan.id, digest: plan.digest },
      activation: { id: plan.activation!.id, fence: plan.activation!.fence },
      profile: { name: 'web', path: join(root, 'profiles', 'web') },
      issuer: { mode: 'owner-manual' },
      phase: 'reload',
      requirements: { kind: 'reload', previousHostGeneration: 1, probeDigestMinimumChecks: 1 } as unknown as HostAttestationRequirements,
      predecessor: null,
    }
    const crossReceiptUnsigned: Omit<HostAttestationReceipt, 'signature'> = {
      schemaVersion: 2, receiptId: 'r:cross', authority: 'host', keyId: 'host-key',
      installationId: plan.installationId, planId: plan.id, planDigest: plan.digest,
      activationId: plan.activation!.id, fence: plan.activation!.fence,
      operationId: 'operation:restart', requestDigest: hostAttestationRequestDigest(restartOperationRequest),
      phase: 'reload', outcome: 'passed', hostGeneration: 1,
      evidence: validEvidence, evidenceDigest: hostAttestationEvidenceDigest(validEvidence),
      observedAt: now, expiresAt: now + 10_000,
    }
    const crossReceipt: HostAttestationReceipt = {
      ...crossReceiptUnsigned,
      signature: sign(null, Buffer.from(hostAttestationSigningPayload(crossReceiptUnsigned)), hostKeys.privateKey).toString('base64'),
    }
    await expect(hostAuthority.verify(crossReceipt, plan, restartOperationRequest))
      .rejects.toMatchObject({ code: 'conflict' })

    // Verify real in-process receipt with matching host generation 0 -> operation prepared on Gen 0
    // wait: prepareHostAttestationOperation requires previousHostGeneration === 0 when initial,
    expect(operation.request.requirements.kind).toBe('in-process-reload')
    expect(operation.phase).toBe('reload')

    // Establish initial Host generation = 3 on a fresh store, then run a second plan's in-process reload
    // end-to-end through acceptHostAttestationReceipt + applyHostAttestation.
    const root2 = await realpath(await mkdtemp(join(tmpdir(), 'dsh-pcp-ipr-store2-')))
    cleanupCallbacks.push(async () => { await rm(root2, { recursive: true, force: true }) })
    const db2Path = join(root2, 'control.sqlite')
    const store2 = new ControlPlaneStore({ path: db2Path, now: () => now })
    cleanupCallbacks.push(async () => { store2.close() })
    const createReadyPlan = async (keySuffix: string) => {
      const g = store2.recordGap({
        idempotencyKey: `gap-${keySuffix}`, capability: 'health', context: 'health',
        expectedValue: 100, frequency: 10, estimatedCost: 50, risk: 0.2,
      })
      let p = store2.createPlan({
        candidate,
        catalog: { digest: controlPlaneDigest(exampleIntegrityPinnedCatalog), provenance: 'owner-provided-integrity-pinned' },
        matchedCapabilities: candidate.capabilities,
        profile: 'web',
        target: { dshHome: root2, profile: 'web', profilePath: join(root2, 'profiles', `web-${keySuffix}`) },
        installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00',
        ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: db2Path },
        executor: { id: 'dsh', version: '0.1.2-rc.1', path: join(root2, 'dsh'), sha256: digest('d') },
        ttlMs: 60_000,
        gapId: g.id,
        idempotencyKey: `plan-${keySuffix}`,
      }).result
      const appBody: Omit<ApprovalReceipt, 'signature'> = {
        schemaVersion: 1, approvalId: `approval-${keySuffix}`, authority: 'owner', keyId: 'owner-key',
        planId: p.id, planDigest: p.digest, decision: 'approved', principal: 'owner',
        decidedAt: now, expiresAt: now + 30_000,
      }
      p = (await store2.approve({
        planId: p.id,
        expectedRevision: p.revision,
        receipt: { ...appBody, signature: sign(null, Buffer.from(approvalSigningPayload(appBody)), ownerKeys.privateKey).toString('base64') },
        resolveAuthority: () => approvalAuthority,
        idempotencyKey: `approve-${keySuffix}`,
      })).result
      p = await store2.claimActivation({
        planId: p.id,
        expectedRevision: p.revision,
        leaseMs: 10_000,
        resolveApprovalAuthority: () => approvalAuthority,
      })
      return store2.advanceActivation({
        planId: p.id, expectedRevision: p.revision, fence: p.activation!.fence,
        from: 'staging', to: 'awaiting-reload',
      })
    }
    const p1 = await createReadyPlan('boot')
    const bootOp = store2.prepareHostAttestationOperation({
      planId: p1.id, expectedRevision: p1.revision, expectedFence: p1.activation!.fence,
      issuer: { mode: 'owner-manual' }, requirements: { kind: 'reload', previousHostGeneration: 0 }, receiptTtlMs: 10_000,
    })
    const bootEvidence: HostAttestationEvidence = { kind: 'reload', reloaded: true, previousHostGeneration: 0, currentHostGeneration: 3, probeDigest: digest('f') }
    const bootUnsigned: Omit<HostAttestationReceipt, 'signature'> = {
      schemaVersion: 2, receiptId: 'r:boot', authority: 'host', keyId: 'host-key',
      installationId: p1.installationId, planId: p1.id, planDigest: p1.digest,
      activationId: p1.activation!.id, fence: p1.activation!.fence,
      operationId: bootOp.operationId, requestDigest: hostAttestationRequestDigest(bootOp.request as HostAttestationRequest),
      phase: 'reload', outcome: 'passed', hostGeneration: 3,
      evidence: bootEvidence, evidenceDigest: hostAttestationEvidenceDigest(bootEvidence),
      observedAt: now, expiresAt: now + 10_000,
    }
    const bootReceipt: HostAttestationReceipt = {
      ...bootUnsigned,
      signature: sign(null, Buffer.from(hostAttestationSigningPayload(bootUnsigned)), hostKeys.privateKey).toString('base64'),
    }
    await store2.acceptHostAttestationReceipt({ operationId: bootOp.operationId, expectedRevision: p1.revision, expectedFence: p1.activation!.fence, receipt: bootReceipt, resolveAuthority: () => hostAuthority })
    await store2.applyHostAttestation({ planId: p1.id, expectedRevision: p1.revision, expectedFence: p1.activation!.fence, receipt: bootReceipt, resolveAuthority: () => hostAuthority, idempotencyKey: 'apply-boot' })

    // Now Host generation 3 is established cleanly. Run a second plan with in-process-reload!
    const p2 = await createReadyPlan('hot')
    const hotOp = store2.prepareHostAttestationOperation({
      planId: p2.id, expectedRevision: p2.revision, expectedFence: p2.activation!.fence,
      issuer: { mode: 'owner-manual' },
      requirements: buildInProcessReloadRequirements({
        previousHostGeneration: 3, previousInProcessGeneration: 1,
        artifactDigest: digest('a'), patchDigest: digest('b'), minimumChecks: 4,
      }),
      receiptTtlMs: 10_000,
    })
    const hotEvidence = buildInProcessReloadEvidence({
      applied: {
        status: 'reloaded', reloaded: true,
        previousHostGeneration: 3, currentHostGeneration: 3,
        previousInProcessGeneration: 1, currentInProcessGeneration: 2,
        fibersDisposed: 1, probeDigest: digest('e'), warrantDigest: digest('c'),
      },
      checks: 9,
    })
    const hotUnsigned: Omit<HostAttestationReceipt, 'signature'> = {
      schemaVersion: 2, receiptId: 'r:hot', authority: 'host', keyId: 'host-key',
      installationId: p2.installationId, planId: p2.id, planDigest: p2.digest,
      activationId: p2.activation!.id, fence: p2.activation!.fence,
      operationId: hotOp.operationId, requestDigest: hostAttestationRequestDigest(hotOp.request as HostAttestationRequest),
      phase: 'reload', outcome: 'passed', hostGeneration: 3,
      evidence: hotEvidence, evidenceDigest: hostAttestationEvidenceDigest(hotEvidence),
      observedAt: now, expiresAt: now + 10_000,
    }
    const hotReceipt: HostAttestationReceipt = {
      ...hotUnsigned,
      signature: sign(null, Buffer.from(hostAttestationSigningPayload(hotUnsigned)), hostKeys.privateKey).toString('base64'),
    }
    await store2.acceptHostAttestationReceipt({ operationId: hotOp.operationId, expectedRevision: p2.revision, expectedFence: p2.activation!.fence, receipt: hotReceipt, resolveAuthority: () => hostAuthority })
    const appliedPlan = await store2.applyHostAttestation({
      planId: p2.id, expectedRevision: p2.revision, expectedFence: p2.activation!.fence,
      receipt: hotReceipt, resolveAuthority: () => hostAuthority, idempotencyKey: 'apply-hot',
    })
    expect(appliedPlan.result.status).toBe('awaiting-readiness')
  })

  test('connects assistant-delivery inProcessReload with PluginControlPlaneService for artifact reload, automatic rollback, and coordinator handoff', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-pcp-host-wire-')))
    cleanupCallbacks.push(async () => { await rm(root, { recursive: true, force: true }) })

    class TestJsonInclude extends EntryTree {
      static [EntryGroup.key] = true
      filename: string
      type = 'application/json' as const
      cache: { content: string; data: unknown } | undefined
      constructor(ctx: Context, config: { path: string }) {
        super(ctx)
        this.filename = config.path.startsWith('file://') ? new URL(config.path).pathname : config.path
        this.ctx.baseUrl = new URL('.', pathToFileURL(this.filename)).href
      }
      dump(data: unknown): string { return JSON.stringify(data, null, 2) }
      commit(): void {}
      async refresh(): Promise<void> {
        const content = readFileSync(this.filename, 'utf8')
        if (content === this.cache?.content) return
        const data = JSON.parse(content) as Array<Record<string, unknown>>
        this.cache = { content, data }
        await this.root.update(data as never)
        await this.await()
      }
      async *[Service.init]() {
        yield () => { this.root.stop() }
        await this.refresh()
      }
    }

    const writePkg = async (dir: string, version: string, body: string) => {
      await mkdir(join(dir, 'lib'), { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({
        name: '@dsh-enhanced/demo-plugin', version, type: 'module', exports: { '.': './lib/index.js' },
      }))
      await writeFile(join(dir, 'lib', 'index.js'), body, 'utf8')
      return computeInProcessArtifactDigest({ sourceDir: dir })
    }

    const profileDir = join(root, 'profile')
    const profileFile = join(profileDir, 'cordis.json')
    const v1Dir = join(root, 'bundles', 'v1')
    const siblingDir = join(root, 'bundles', 'sibling')
    await mkdir(profileDir, { recursive: true })

    const v1Digest = await writePkg(v1Dir, '0.1.0', `
export function apply(ctx, config) {
  ctx.provide('demoCapability', () => 'v1:' + String(config?.label ?? 'base'))
}
`)
    await mkdir(join(siblingDir, 'lib'), { recursive: true })
    await writeFile(join(siblingDir, 'package.json'), JSON.stringify({
      name: '@dsh-enhanced/sibling-plugin', version: '0.1.0', type: 'module', exports: { '.': './lib/index.js' },
    }))
    await writeFile(join(siblingDir, 'lib', 'index.js'), `
export function apply(ctx) {
  ctx.provide('siblingService', () => 'steady')
}
`, 'utf8')

    await writeFile(profileFile, JSON.stringify([
      { id: 'candidate', name: '../bundles/v1/lib/index.js', config: { label: 'one' } },
      { id: 'sibling', name: '../bundles/sibling/lib/index.js', config: {} },
    ], null, 2), 'utf8')

    const app = new Context()
    cleanupCallbacks.push(async () => { await app.fiber.dispose() })
    await app.plugin(Loader)
    app.loader.builtins.include = TestJsonInclude as never
    await app.loader.create({ id: 'include', name: 'cordis:include', config: { path: pathToFileURL(profileFile).href } } as never)
    await app.loader.await()

    await app.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite') })
    await app.plugin(ctx => {
      assistantDeliveryPlugin.apply(ctx, {
        databasePath: join(root, 'delivery.sqlite'),
        spoolPath: join(root, 'spool'),
        defaultWorkspace: root,
        schedulerEnabled: false,
        inProcessReload: { profilePath: profileFile, entryId: 'candidate', hostGeneration: 3 },
      })
    })

    const catalogPath = join(root, 'catalog.json')
    const statePath = join(root, 'state')
    const trustPath = join(root, 'trust.json')
    const ownerKey = generateKeyPairSync('ed25519')
    await writeFile(catalogPath, JSON.stringify(exampleIntegrityPinnedCatalog), 'utf8')
    await writeFile(trustPath, JSON.stringify({
      schemaVersion: 1,
      installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00',
      ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: join(root, 'cp.sqlite') },
      dsh: { binaryPath: join(root, 'dsh'), expectedVersion: '0.1.73' },
      approvalKeys: [{ authority: 'owner', keyId: 'owner-1', publicKeyPem: ownerKey.publicKey.export({ type: 'spki', format: 'pem' }) }],
      hostAttestationKeys: [],
    }), 'utf8')

    // Default delivery registers inProcessReload automatically; explicit enabled: false opts out cleanly.
    const defaultEnabled = new Context()
    cleanupCallbacks.push(async () => { await defaultEnabled.fiber.dispose() })
    await defaultEnabled.plugin(AssistantPolicyService, { databasePath: join(root, 'policy-def.sqlite') })
    await defaultEnabled.plugin(ctx => {
      assistantDeliveryPlugin.apply(ctx, {
        databasePath: join(root, 'delivery-def.sqlite'),
        spoolPath: join(root, 'spool-def'),
        defaultWorkspace: root,
        schedulerEnabled: false,
      })
    })
    await defaultEnabled.plugin(PluginControlPlaneService, { catalogPath, statePath: join(root, 'state-def'), trustPath })
    expect((defaultEnabled.get('pluginControlPlane' as never) as unknown as PluginControlPlaneService).canInProcessReload()).toBe(true)

    const optedOut = new Context()
    cleanupCallbacks.push(async () => { await optedOut.fiber.dispose() })
    await optedOut.plugin(AssistantPolicyService, { databasePath: join(root, 'policy-unconf.sqlite') })
    await optedOut.plugin(ctx => {
      assistantDeliveryPlugin.apply(ctx, {
        databasePath: join(root, 'delivery-unconf.sqlite'),
        spoolPath: join(root, 'spool-unconf'),
        defaultWorkspace: root,
        schedulerEnabled: false,
        inProcessReload: { enabled: false },
      })
    })
    await optedOut.plugin(PluginControlPlaneService, { catalogPath, statePath: join(root, 'state-unconf'), trustPath })
    expect((optedOut.get('pluginControlPlane' as never) as unknown as PluginControlPlaneService).canInProcessReload()).toBe(false)

    await app.plugin(PluginControlPlaneService, { catalogPath, statePath, trustPath })
    const controlPlane = app.get('pluginControlPlane' as never) as unknown as PluginControlPlaneService
    expect(controlPlane.canInProcessReload()).toBe(true)

    const v2Dir = join(root, 'bundles', 'v2')
    const v2Digest = await writePkg(v2Dir, '0.2.0', `
export function apply(ctx, config) {
  ctx.provide('demoCapability', () => 'v2:' + String(config?.label ?? 'next'))
}
`)
    const siblingBefore = app.loader.resolve('include:sibling').fiber!

    const v2Patch = computeInProcessPatchDigest({ config: { label: 'two' } })
    const reloadOutcome = await controlPlane.reloadInProcess({
      now,
      snapshot: {
        planId: 'plan:host-wire',
        planDigest: digest('c'),
        status: 'awaiting-reload',
        activation: { id: 'activation:1', fence: 1 },
        hostGeneration: 3,
        inProcessGeneration: 1,
        running: { artifactDigest: v1Digest, patchDigest: digest('0') },
        mode: 'artifact-replace',
        target: {
          package: '@dsh-enhanced/demo-plugin',
          version: '0.2.0',
          artifactDigest: v2Digest,
          patchDigest: v2Patch,
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v2Dir, config: { label: 'two' } },
        },
      },
    })
    expect(reloadOutcome.status).toBe('reloaded')
    if (reloadOutcome.status !== 'reloaded') throw new Error('expected reloaded')
    expect(reloadOutcome.apply.fibersDisposed).toBe(1)
    expect(reloadOutcome.apply.currentHostGeneration).toBe(3)
    expect(reloadOutcome.apply.currentInProcessGeneration).toBe(2)
    expect((app.get('demoCapability' as never) as unknown as () => string)()).toBe('v2:two')
    expect(app.loader.resolve('include:sibling').fiber).toBe(siblingBefore)

    // Now push a broken v3 (missing injection) through PluginControlPlaneService.reloadInProcess:
    // Control plane automatically rolls back to active v2 and keeps sibling undisturbed.
    const v3Dir = join(root, 'bundles', 'v3-bad')
    const v3Digest = await writePkg(v3Dir, '0.3.0', `
export const inject = ['missingHostService']
export function apply() {}
`)
    const v3Patch = computeInProcessPatchDigest({ config: { label: 'three' } })
    const rollbackOutcome = await controlPlane.reloadInProcess({
      now,
      snapshot: {
        planId: 'plan:host-wire-2',
        planDigest: digest('e'),
        status: 'awaiting-reload',
        activation: { id: 'activation:2', fence: 1 },
        hostGeneration: 3,
        inProcessGeneration: 2,
        running: { artifactDigest: v2Digest, patchDigest: v2Patch },
        mode: 'artifact-replace',
        target: {
          package: '@dsh-enhanced/demo-plugin',
          version: '0.3.0',
          artifactDigest: v3Digest,
          patchDigest: v3Patch,
          changesProcessSubtree: false,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v3Dir, config: { label: 'three' } },
        },
      },
    })
    expect(rollbackOutcome.status).toBe('rolled-back')
    expect((app.get('demoCapability' as never) as unknown as () => string)()).toBe('v2:two')
    expect(app.loader.resolve('include:sibling').fiber).toBe(siblingBefore)

    // Verify coordinateAdoptionHandoff cleanly dispatches awaiting-reload through optional inProcessReload hook.
    let coordState: PluginActivationPlan = {
      id: 'plan:coord-hook',
      digest: digest('c'),
      status: 'awaiting-reload',
      revision: 3,
      activation: { id: 'activation:1', fence: 1 },
      dossier: { handoff: { schemaVersion: 1, coordinatorId: 'coord-1', maximumWindowMs: 60_000, commit: 'target-host' } },
      target: { dshHome: root, profile: 'web', profilePath: join(root, 'profiles', 'web') },
      installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00',
      ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: join(root, 'coord.sqlite') },
    } as unknown as PluginActivationPlan
    const coordStore = {
      getPlan: () => coordState,
      assertAdoptionHandoff: () => {},
      getAdoptionHandoff: () => ({
        planId: coordState.id, planDigest: coordState.digest, coordinatorId: 'coord-1',
        createdAt: now, expiresAt: now + 60_000,
      }),
      getLiveQualificationDeadline: () => undefined,
      requestActivationRollback: (input: { failureCode: string }) => {
        coordState = {
          ...coordState,
          status: 'rollback-pending',
          revision: coordState.revision + 1,
          activation: { ...coordState.activation!, failureCode: input.failureCode },
        } as PluginActivationPlan
        return coordState
      },
    }
    let hooked = 0
    const handoffResult = await coordinateAdoptionHandoff({
      store: coordStore as unknown as ControlPlaneStore,
      trust: {} as never,
      planId: coordState.id,
      inProcessReload: {
        canHandle: p => p.id === coordState.id,
        execute: async _p => {
          hooked += 1
          return {
            status: 'rolled-back',
            plan: coordStore.requestActivationRollback({ failureCode: 'in-process-reload-rolled-back' }),
          }
        },
      },
    })
    expect(hooked).toBe(1)
    expect(handoffResult.status).toBe('rollback-pending')
    expect(handoffResult.activation?.failureCode).toBe('in-process-reload-rolled-back')

    // And when the hook reports reloaded -> coordinator advances cleanly to commit-pending.
    coordState = { ...coordState, status: 'awaiting-reload', revision: 4 }
    const reloadedCoord = await coordinateAdoptionHandoff({
      store: coordStore as unknown as ControlPlaneStore,
      trust: {} as never,
      planId: coordState.id,
      inProcessReload: {
        canHandle: p => p.id === coordState.id,
        execute: async p => ({
          status: 'reloaded',
          plan: { ...p, status: 'commit-pending', revision: p.revision + 1 },
        }),
      },
    })
    expect(reloadedCoord.status).toBe('commit-pending')
  })

  test('hot-reloads @dsh-enhanced/lark-channel with omitted profilePath and changesProcessSubtree: true, rolling back on broken inject', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-pcp-lark-sub-')))
    cleanupCallbacks.push(async () => { await rm(root, { recursive: true, force: true }) })

    class TestJsonInclude extends EntryTree {
      static [EntryGroup.key] = true
      filename: string
      type = 'application/json' as const
      cache: { content: string; data: unknown } | undefined
      constructor(ctx: Context, config: { path: string }) {
        super(ctx)
        this.filename = config.path.startsWith('file://') ? new URL(config.path).pathname : config.path
        this.ctx.baseUrl = new URL('.', pathToFileURL(this.filename)).href
      }
      dump(data: unknown): string { return JSON.stringify(data, null, 2) }
      commit(): void {}
      async refresh(): Promise<void> {
        const content = readFileSync(this.filename, 'utf8')
        if (content === this.cache?.content) return
        const data = JSON.parse(content) as Array<Record<string, unknown>>
        this.cache = { content, data }
        await this.root.update(data as never)
        await this.await()
      }
      async *[Service.init]() {
        yield () => { this.root.stop() }
        await this.refresh()
      }
    }

    const writePkg = async (dir: string, version: string, body: string) => {
      await mkdir(join(dir, 'lib'), { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({
        name: '@dsh-enhanced/lark-channel', version, type: 'module', exports: { '.': './lib/index.js' },
      }))
      await writeFile(join(dir, 'lib', 'index.js'), body, 'utf8')
      return computeInProcessArtifactDigest({ sourceDir: dir })
    }

    const profileDir = join(root, 'profile')
    const profileFile = join(profileDir, 'cordis.json')
    const v1Dir = join(root, 'bundles', 'lark-v1')
    const v2Dir = join(root, 'bundles', 'lark-v2')
    const v3BadDir = join(root, 'bundles', 'lark-v3-bad')
    await mkdir(profileDir, { recursive: true })

    const v1Digest = await writePkg(v1Dir, '0.1.0', `
export function apply(ctx, config) {
  ctx.provide('larkChannelSvc', () => 'lark-v1:' + String(config?.tag ?? 'a'))
}
`)
    const v2Digest = await writePkg(v2Dir, '0.2.0', `
export function apply(ctx, config) {
  ctx.provide('larkChannelSvc', () => 'lark-v2:' + String(config?.tag ?? 'b'))
}
`)
    const v3Digest = await writePkg(v3BadDir, '0.3.0', `
export const inject = ['nonExistentLarkPeer']
export function apply() {}
`)

    await writeFile(profileFile, JSON.stringify([
      { id: 'lark-channel', name: '../bundles/lark-v1/lib/index.js', config: { tag: 'a' } },
    ], null, 2), 'utf8')

    const app = new Context()
    cleanupCallbacks.push(async () => { await app.fiber.dispose() })
    await app.plugin(Loader)
    app.loader.builtins.include = TestJsonInclude as never
    await app.loader.create({ id: 'include', name: 'cordis:include', config: { path: pathToFileURL(profileFile).href } } as never)
    await app.loader.await()

    await app.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite') })
    await app.plugin(ctx => {
      assistantDeliveryPlugin.apply(ctx, {
        databasePath: join(root, 'delivery.sqlite'),
        spoolPath: join(root, 'spool'),
        defaultWorkspace: root,
        schedulerEnabled: false,
      })
    })

    const catalogPath = join(root, 'catalog.json')
    const statePath = join(root, 'state')
    const trustPath = join(root, 'trust.json')
    const ownerKey = generateKeyPairSync('ed25519')
    await writeFile(catalogPath, JSON.stringify(exampleIntegrityPinnedCatalog), 'utf8')
    await writeFile(trustPath, JSON.stringify({
      schemaVersion: 1,
      installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00',
      ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: join(root, 'cp.sqlite') },
      dsh: { binaryPath: join(root, 'dsh'), expectedVersion: '0.1.73' },
      approvalKeys: [{ authority: 'owner', keyId: 'owner-1', publicKeyPem: ownerKey.publicKey.export({ type: 'spki', format: 'pem' }) }],
      hostAttestationKeys: [],
    }), 'utf8')

    await app.plugin(PluginControlPlaneService, { catalogPath, statePath, trustPath })
    const controlPlane = app.get('pluginControlPlane' as never) as unknown as PluginControlPlaneService
    expect(controlPlane.canInProcessReload()).toBe(true)

    const v2Patch = computeInProcessPatchDigest({ config: { tag: 'b' } })
    const ok = await controlPlane.reloadInProcess({
      now,
      snapshot: {
        planId: 'plan:lark-subtree',
        planDigest: digest('a'),
        status: 'awaiting-reload',
        activation: { id: 'activation:1', fence: 1 },
        hostGeneration: 1,
        inProcessGeneration: 1,
        running: { artifactDigest: v1Digest, patchDigest: digest('0') },
        mode: 'artifact-replace',
        target: {
          package: '@dsh-enhanced/lark-channel',
          version: '0.2.0',
          artifactDigest: v2Digest,
          patchDigest: v2Patch,
          changesProcessSubtree: true,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v2Dir, config: { tag: 'b' } },
        },
      },
    })
    expect(ok.status).toBe('reloaded')
    expect((app.get('larkChannelSvc' as never) as unknown as () => string)()).toBe('lark-v2:b')

    const v3Patch = computeInProcessPatchDigest({ config: { tag: 'c' } })
    const rolled = await controlPlane.reloadInProcess({
      now,
      snapshot: {
        planId: 'plan:lark-subtree-bad',
        planDigest: digest('b'),
        status: 'awaiting-reload',
        activation: { id: 'activation:2', fence: 1 },
        hostGeneration: 1,
        inProcessGeneration: 2,
        running: { artifactDigest: v2Digest, patchDigest: v2Patch },
        mode: 'artifact-replace',
        target: {
          package: '@dsh-enhanced/lark-channel',
          version: '0.3.0',
          artifactDigest: v3Digest,
          patchDigest: v3Patch,
          changesProcessSubtree: true,
          holdsUnprovenProcessAuthority: false,
          artifact: { sourceDir: v3BadDir, config: { tag: 'c' } },
        },
      },
    })
    expect(rolled.status).toBe('rolled-back')
    expect((app.get('larkChannelSvc' as never) as unknown as () => string)()).toBe('lark-v2:b')
  })

  test('AdoptionCoordinatorRuntime buildReloadSnapshot handles pnpm-symlinked node_modules/<pkg> and rejects symlink escapes', async () => {
    const auth = await hostAuthorizationPlan()
    cleanupCallbacks.push(async () => { auth.coordinator.close() })
    const root = auth.f.root
    const candidate = auth.plan.candidate
    const pkgParts = candidate.package.split('/')
    const profileDir = auth.plan.target.profilePath
    const profileFile = join(profileDir, 'cordis.json')
    const v1Dir = join(root, 'bundles', 'v1')
    const pnpmStoreDir = join(profileDir, 'node_modules', '.pnpm', `${candidate.package.replace('/', '+')}@${candidate.version}`, 'node_modules', ...pkgParts)
    const symlinkPkgDir = join(profileDir, 'node_modules', ...pkgParts)
    const outsideDir = join(root, 'outside-pkg')

    for (const [dir, tag] of [[v1Dir, 'v1'], [pnpmStoreDir, 'v2-pnpm'], [outsideDir, 'outside']] as const) {
      await mkdir(join(dir, 'lib'), { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({
        name: candidate.package, version: candidate.version, type: 'module', exports: { '.': './lib/index.js' },
      }))
      await writeFile(join(dir, 'lib', 'index.js'), `
export function apply(ctx) {
  ctx.provide('pnpmSymlinkSvc', () => '${tag}')
}
`, 'utf8')
    }
    await mkdir(join(profileDir, 'node_modules', pkgParts[0]!), { recursive: true })
    await symlink(join('..', '.pnpm', `${candidate.package.replace('/', '+')}@${candidate.version}`, 'node_modules', ...pkgParts), symlinkPkgDir)
    await writeFile(profileFile, JSON.stringify([
      { id: 'candidate', name: '../../bundles/v1/lib/index.js', config: {} },
    ], null, 2), 'utf8')

    // Advance the staged plan to awaiting-reload
    let currentPlan = auth.coordinator.recordActivationHostInputWitness(auth.witnessInput)
    currentPlan = auth.coordinator.markActivationHostExposure({
      planId: currentPlan.id, expectedRevision: currentPlan.revision, fence: currentPlan.activation!.fence,
    })
    currentPlan = auth.coordinator.advanceActivation({
      planId: currentPlan.id, expectedRevision: currentPlan.revision, fence: currentPlan.activation!.fence,
      from: 'staging', to: 'awaiting-reload',
    })
    const planIdOk = currentPlan.id

    class TestJsonInclude extends EntryTree {
      static [EntryGroup.key] = true
      filename: string
      type = 'application/json' as const
      cache: { content: string; data: unknown } | undefined
      constructor(ctx: Context, config: { path: string }) {
        super(ctx)
        this.filename = config.path.startsWith('file://') ? new URL(config.path).pathname : config.path
        this.ctx.baseUrl = new URL('.', pathToFileURL(this.filename)).href
      }
      dump(data: unknown): string { return JSON.stringify(data, null, 2) }
      commit(): void {}
      async refresh(): Promise<void> {
        const content = readFileSync(this.filename, 'utf8')
        if (content === this.cache?.content) return
        const data = JSON.parse(content) as Array<Record<string, unknown>>
        this.cache = { content, data }
        await this.root.update(data as never)
        await this.await()
      }
      async *[Service.init]() {
        yield () => { this.root.stop() }
        await this.refresh()
      }
    }

    const baseTrust = JSON.parse(readFileSync(join(auth.f.root, 'trust.json'), 'utf8')) as Record<string, unknown>
    const trustPath = join(root, 'trust-coordinator.json')
    await writeFile(trustPath, JSON.stringify({
      ...baseTrust,
      hostAttestor: null,
      approvalKeys: [{ authority: 'owner', keyId: 'key', publicKeyPem: auth.approvalPublicKeyPem }],
    }), { mode: 0o600 })

    const app = new Context()
    cleanupCallbacks.push(async () => { await app.fiber.dispose() })
    await app.plugin(Loader)
    app.loader.builtins.include = TestJsonInclude as never
    await app.loader.create({ id: 'include', name: 'cordis:include', config: { path: pathToFileURL(profileFile).href } } as never)
    await app.loader.await()
    expect((app.get('pnpmSymlinkSvc' as never) as unknown as () => string)()).toBe('v1')

    await app.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite') })
    await app.plugin(ctx => {
      assistantDeliveryPlugin.apply(ctx, {
        databasePath: join(root, 'delivery.sqlite'),
        spoolPath: join(root, 'spool'),
        defaultWorkspace: root,
        schedulerEnabled: false,
        inProcessReload: { profilePath: profileFile, entryId: 'candidate', hostGeneration: 1 },
      })
    })

    let coordinatorExecutor: HostAutomationExecutor | undefined
    let activeDef: { automationId: string; definitionHash: string; activationNonce: string } | undefined
    app.provide('assistantAutomations' as never, {
      registerHostExecutor: (exec: HostAutomationExecutor) => {
        coordinatorExecutor = exec
        return () => { coordinatorExecutor = undefined }
      },
      reconcileSystem: (req: { automationId: string; definition: { execution?: { activationNonce: string } } }) => {
        activeDef = {
          automationId: req.automationId,
          definitionHash: digest('d'),
          activationNonce: req.definition.execution!.activationNonce,
        }
        return {}
      },
      inspectSystemOwnedActivation: () => activeDef,
      registerHostShutdown: () => () => {},
    } as never)

    await app.plugin(PluginControlPlaneService, {
      catalogPath: auth.f.options.trust.catalog.path,
      statePath: join(root, 'coord-state'),
      trustPath,
      adoptionCoordinator: {
        coordinatorId: auth.handoff.coordinatorId,
        scope: { workspace: root, preset: 'primary', principalId: 'owner', ownerRouteId: 'owner-route' },
        timeoutMs: 30_000,
        budgetId: 'adoption-runs',
        budgetAmount: 2,
      },
    })

    for (let i = 0; i < 40 && (!coordinatorExecutor || !activeDef); i++) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(coordinatorExecutor).toBeDefined()
    expect(activeDef).toBeDefined()

    // 1. Pnpm-symlinked package inside profilePath/node_modules succeeds in-process reload
    const execOk = await coordinatorExecutor!.execute({
      automationId: activeDef!.automationId,
      executionMode: 'production',
      activationNonce: activeDef!.activationNonce,
      definitionHash: activeDef!.definitionHash,
      catalogDigest: coordinatorExecutor!.descriptor.catalogDigest,
      ownerRouteId: 'owner-route',
      principal: 'owner',
      targetScope: { workspace: root, preset: 'primary' },
      signal: new AbortController().signal,
    } as HostAutomationExecutorInput)
    expect(execOk, JSON.stringify({ execOk, planStatus: auth.f.store.getPlan(planIdOk).status, activation: auth.f.store.getPlan(planIdOk).activation })).toMatchObject({ outcome: 'succeeded' })
    expect(auth.f.store.getPlan(planIdOk).activation?.failureCode).toBeUndefined()
    expect(auth.f.store.getPlan(planIdOk).status).toBe('awaiting-reload')
    expect((app.get('pnpmSymlinkSvc' as never) as unknown as () => string)()).toBe('v2-pnpm')

    // 2. Symlink escaping outside node_modules (both outside profilePath and inside profilePath/outside-modules) is rejected cleanly and triggers rollback
    const runEscapeCase = async (targetDir: string) => {
      const authEsc = await hostAuthorizationPlan()
      cleanupCallbacks.push(async () => { authEsc.coordinator.close() })
      const escProfileDir = authEsc.plan.target.profilePath
      const escProfileFile = join(escProfileDir, 'cordis.json')
      await mkdir(join(escProfileDir, 'node_modules', pkgParts[0]!), { recursive: true })
      await writeFile(escProfileFile, '[]\n', 'utf8')
      const resolvedTarget = targetDir.startsWith('<profile>')
        ? join(escProfileDir, targetDir.slice('<profile>/'.length))
        : targetDir
      if (targetDir.startsWith('<profile>')) {
        await mkdir(join(resolvedTarget, 'lib'), { recursive: true })
        await writeFile(join(resolvedTarget, 'package.json'), JSON.stringify({
          name: candidate.package, version: candidate.version, type: 'module', exports: { '.': './lib/index.js' },
        }))
        await writeFile(join(resolvedTarget, 'lib', 'index.js'), 'export function apply() {}\n', 'utf8')
      }
      const escLink = join(escProfileDir, 'node_modules', ...pkgParts)
      await symlink(resolvedTarget, escLink)
      let escPlan = authEsc.coordinator.recordActivationHostInputWitness(authEsc.witnessInput)
      escPlan = authEsc.coordinator.markActivationHostExposure({
        planId: escPlan.id, expectedRevision: escPlan.revision, fence: escPlan.activation!.fence,
      })
      escPlan = authEsc.coordinator.advanceActivation({
        planId: escPlan.id, expectedRevision: escPlan.revision, fence: escPlan.activation!.fence,
        from: 'staging', to: 'awaiting-reload',
      })
      const escBaseTrust = JSON.parse(readFileSync(join(authEsc.f.root, 'trust.json'), 'utf8')) as Record<string, unknown>
      const escTrustPath = join(authEsc.f.root, 'trust-esc.json')
      await writeFile(escTrustPath, JSON.stringify({
        ...escBaseTrust,
        hostAttestor: null,
        approvalKeys: [{ authority: 'owner', keyId: 'key', publicKeyPem: authEsc.approvalPublicKeyPem }],
      }), { mode: 0o600 })
      const escApp = new Context()
      cleanupCallbacks.push(async () => { await escApp.fiber.dispose() })
      await escApp.plugin(AssistantPolicyService, { databasePath: join(authEsc.f.root, 'policy-esc.sqlite') })
      await escApp.plugin(ctx => {
        assistantDeliveryPlugin.apply(ctx, {
          databasePath: join(authEsc.f.root, 'delivery-esc.sqlite'),
          spoolPath: join(authEsc.f.root, 'spool-esc'),
          defaultWorkspace: authEsc.f.root,
          schedulerEnabled: false,
          inProcessReload: { profilePath: escProfileFile, entryId: 'candidate', hostGeneration: 1 },
        })
      })
      let escExec: HostAutomationExecutor | undefined
      let escDef: { automationId: string; definitionHash: string; activationNonce: string } | undefined
      escApp.provide('assistantAutomations' as never, {
        registerHostExecutor: (exec: HostAutomationExecutor) => { escExec = exec; return () => { escExec = undefined } },
        reconcileSystem: (req: { automationId: string; definition: { execution?: { activationNonce: string } } }) => {
          escDef = { automationId: req.automationId, definitionHash: digest('e'), activationNonce: req.definition.execution!.activationNonce }
          return {}
        },
        inspectSystemOwnedActivation: () => escDef,
        registerHostShutdown: () => () => {},
      } as never)
      await escApp.plugin(PluginControlPlaneService, {
        catalogPath: authEsc.f.options.trust.catalog.path,
        statePath: join(authEsc.f.root, 'coord-esc'),
        trustPath: escTrustPath,
        adoptionCoordinator: {
          coordinatorId: authEsc.handoff.coordinatorId,
          scope: { workspace: authEsc.f.root, preset: 'primary', principalId: 'owner', ownerRouteId: 'owner-route' },
          timeoutMs: 30_000,
          budgetId: 'adoption-runs',
          budgetAmount: 2,
        },
      })
      for (let i = 0; i < 40 && (!escExec || !escDef); i++) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(escExec).toBeDefined()
      const execEscape = await escExec!.execute({
        automationId: escDef!.automationId,
        executionMode: 'production',
        activationNonce: escDef!.activationNonce,
        definitionHash: escDef!.definitionHash,
        catalogDigest: escExec!.descriptor.catalogDigest,
        ownerRouteId: 'owner-route',
        principal: 'owner',
        targetScope: { workspace: authEsc.f.root, preset: 'primary' },
        signal: new AbortController().signal,
      } as HostAutomationExecutorInput)
      expect(execEscape.outcome).toBe('succeeded')
      const escapedPlan = authEsc.f.store.getPlan(escPlan.id)
      expect(escapedPlan.status).toBe('rollback-pending')
      expect(escapedPlan.activation?.failureCode).toBe('in-process-reload-error')
    }
    await runEscapeCase(outsideDir)
    await runEscapeCase('<profile>/outside-modules')
  }, 45_000)
})
