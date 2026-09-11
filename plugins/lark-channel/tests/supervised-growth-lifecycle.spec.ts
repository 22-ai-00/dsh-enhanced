import { RECOVERY_CATALOG_DIGEST, type RecoveryOperatorSnapshot } from '@dsh-enhanced/assistant-recovery'
import type { AutomationsOperatorSnapshot } from '@dsh-enhanced/assistant-automations'
import { describe, expect, test } from 'vitest'
import {
  captureSupervisedGrowthLifecycleAttestation,
  expectedSupervisedGrowthManagedAutomationDigest,
  supervisedGrowthLifecycleAttestationDigest,
  verifySupervisedGrowthLifecycleSuccessor,
  type SupervisedGrowthLifecycleAttestationDependencies,
} from '../src/supervised-growth-setup.ts'

const planDigest = 'a'.repeat(64)
const recoveryDefinitionHash = 'b'.repeat(64)
const analystDefinitionHash = 'c'.repeat(64)
const databaseDigest = 'd'.repeat(64)

function effective(stage: 'preview' | 'active', nonce = 'activation-one'): string {
  return `
- id: dsh-enhanced-lark-channel
  config:
    enabled: ${stage === 'active'}
- id: dsh-enhanced-assistant-health
  config:
    requiredProviders: ${stage === 'active' ? '[larkChannel]' : '[]'}
- id: dsh-enhanced-assistant-recovery
  config:
    databasePath: /state/recovery.sqlite
    maxStepDurationMs: 1000
    jobs:
      - id: supervised-growth
        activationState: ${stage}
        activationNonce: ${nonce}
        catalogDigest: ${RECOVERY_CATALOG_DIGEST}
        workspace: /work/owner
        preset: standard
        principal: lark/primary/personal/ou_owner
        ownerRouteId: supervised-growth-owner
        cron: "0 8 * * *"
        timezone: UTC
        budgetId: supervised-growth-runs
        budgetAmount: 1
`
}

function recoverySnapshot(input: {
  stage: 'preview' | 'active'
  nonce?: string
  generation?: number
  snapshotDigest?: string
}): RecoveryOperatorSnapshot {
  const attestation = Object.freeze({
    automationId: 'recovery:supervised-growth',
    activationState: input.stage,
    activationNonce: input.nonce ?? 'activation-one',
    activationPlanDigest: planDigest,
  })
  const setDigest = input.stage === 'preview' ? 'e'.repeat(64) : 'f'.repeat(64)
  return Object.freeze({
    protocol: 'assistant-recovery/operator-snapshot/v1',
    schemaVersion: 4,
    database: Object.freeze({ device: '1', inode: '2', size: 4096, digest: databaseDigest }),
    bootstrap: Object.freeze({
      status: 'succeeded', generation: input.generation ?? 4, attestationValid: true,
      attestationSetDigest: setDigest, attestations: Object.freeze([attestation]), updatedAt: 10,
    }),
    snapshotDigest: input.snapshotDigest ?? '1'.repeat(64),
  })
}

function automationSnapshot(input: {
  stage: 'preview' | 'active'
  records?: AutomationsOperatorSnapshot['records']
  inFlightCount?: number
  inventoryDigest?: string
}): AutomationsOperatorSnapshot {
  const status = input.stage === 'active' ? 'active' : 'paused'
  const records = input.records ?? Object.freeze([
    Object.freeze({
      id: 'heartbeat:supervised-growth-analyst', owner: 'assistant-heartbeat',
      definitionHash: analystDefinitionHash, status, createdAt: 1, updatedAt: 2, version: 2,
      runningTaskCount: 0,
    }),
    Object.freeze({
      id: 'recovery:supervised-growth', owner: 'dsh-enhanced-assistant-recovery',
      definitionHash: recoveryDefinitionHash, status, createdAt: 1, updatedAt: 2, version: 2,
      runningTaskCount: 0,
    }),
  ])
  return Object.freeze({
    protocol: 'assistant-automations-operator-snapshot/v1',
    schemaVersion: 15,
    database: Object.freeze({
      device: '3', inode: '4', size: '4096', mtimeNs: '10', digest: databaseDigest,
    }),
    sidecars: Object.freeze({ wal: null, shm: null }),
    storageDigest: databaseDigest,
    inFlightCount: input.inFlightCount ?? 0,
    inventoryDigest: input.inventoryDigest ?? '2'.repeat(64),
    records,
  })
}

function dependencies(input: {
  stage: 'preview' | 'active'
  nonce?: string
  generation?: number
  recoveries?: RecoveryOperatorSnapshot[]
  automations?: AutomationsOperatorSnapshot[]
}): SupervisedGrowthLifecycleAttestationDependencies {
  const recovery = input.recoveries ?? [recoverySnapshot(input)]
  const automations = input.automations ?? [automationSnapshot(input)]
  let recoveryRead = 0
  let automationRead = 0
  const attestation = recoverySnapshot(input).bootstrap.attestations[0]!
  return {
    inspectRecovery: async () => recovery[Math.min(recoveryRead++, recovery.length - 1)]!,
    inspectAutomations: async () => automations[Math.min(automationRead++, automations.length - 1)]!,
    expectedBootstrap: async () => ({
      attestations: Object.freeze([attestation]),
      attestationSetDigest: input.stage === 'preview' ? 'e'.repeat(64) : 'f'.repeat(64),
    }),
    expectedAnalystDefinition: async () => Object.freeze({ kind: 'analyst' }),
    definitionDigest: definition => typeof definition === 'object' && definition !== null
      && 'execution' in definition ? recoveryDefinitionHash : analystDefinitionHash,
  }
}

function target(stage: 'preview' | 'active', nonce = 'activation-one') {
  return {
    profile: 'web', stage,
    externalProviderExemptions: stage === 'preview' ? ['larkChannel'] as const : [] as const,
    effectiveConfig: effective(stage, nonce),
    recoveryDatabasePath: '/state/recovery.sqlite',
    automationsDatabasePath: '/state/automations.sqlite',
  } as const
}

describe('supervised growth lifecycle attestation', () => {
  test('captures a frozen content-free exact active baseline after two stable reads', async () => {
    const value = await captureSupervisedGrowthLifecycleAttestation(
      target('active'), dependencies({ stage: 'active' }),
    )
    expect(value.stage).toBe('active')
    expect(value.externalProviderExemptions).toEqual([])
    expect(value.recovery.bootstrapGeneration).toBe(4)
    expect(value.automations.records.map(record => record.id)).toEqual([
      'heartbeat:supervised-growth-analyst', 'recovery:supervised-growth',
    ])
    expect(value.automations.inFlightCount).toBe(0)
    expect(JSON.stringify(value)).not.toContain('/work/owner')
    expect(JSON.stringify(value)).not.toContain('ou_owner')
    expect(Object.isFrozen(value.automations.records)).toBe(true)
  })

  test('binds the pure expected managed projection before runtime inspection', async () => {
    const projection = await expectedSupervisedGrowthManagedAutomationDigest({
      stage: 'preview', effectiveConfig: effective('preview'), recoveryDatabasePath: '/state/recovery.sqlite',
    }, {
      expectedAnalystDefinition: async () => Object.freeze({ kind: 'analyst' }),
      definitionDigest: definition => typeof definition === 'object' && definition !== null
        && 'execution' in definition ? recoveryDefinitionHash : analystDefinitionHash,
    })
    expect(projection.records).toEqual([
      {
        id: 'heartbeat:supervised-growth-analyst', owner: 'assistant-heartbeat',
        status: 'paused', definitionHash: analystDefinitionHash,
      },
      {
        id: 'recovery:supervised-growth', owner: 'dsh-enhanced-assistant-recovery',
        status: 'paused', definitionHash: recoveryDefinitionHash,
      },
    ])
    expect(projection.digest).toMatch(/^[a-f\d]{64}$/u)
    expect(Object.isFrozen(projection.records)).toBe(true)
  })

  test('allows only the exact preview exemption and forbids any active exemption', async () => {
    await expect(captureSupervisedGrowthLifecycleAttestation({
      ...target('preview'), externalProviderExemptions: [],
    }, dependencies({ stage: 'preview' }))).rejects.toThrow(/preview external provider exemptions are invalid/i)
    await expect(captureSupervisedGrowthLifecycleAttestation({
      ...target('preview'), externalProviderExemptions: ['larkChannel', 'other'],
    }, dependencies({ stage: 'preview' }))).rejects.toThrow(/preview external provider exemptions are invalid/i)
    await expect(captureSupervisedGrowthLifecycleAttestation({
      ...target('active'), externalProviderExemptions: ['larkChannel'],
    }, dependencies({ stage: 'active' }))).rejects.toThrow(/active external provider exemptions are invalid/i)
  })

  test('requires active effective config to restore Lark and its Health provider', async () => {
    await expect(captureSupervisedGrowthLifecycleAttestation({
      ...target('active'),
      effectiveConfig: effective('active').replace('enabled: true', 'enabled: false'),
    }, dependencies({ stage: 'active' }))).rejects.toThrow(/Lark channel must be enabled/i)
    await expect(captureSupervisedGrowthLifecycleAttestation({
      ...target('active'),
      effectiveConfig: effective('active').replace('requiredProviders: [larkChannel]', 'requiredProviders: []'),
    }, dependencies({ stage: 'active' }))).rejects.toThrow(/Health must require larkChannel/i)
  })

  test('requires preview effective config to implement its exact Lark exemption', async () => {
    await expect(captureSupervisedGrowthLifecycleAttestation({
      ...target('preview'),
      effectiveConfig: effective('preview').replace('enabled: false', 'enabled: true'),
    }, dependencies({ stage: 'preview' }))).rejects.toThrow(/preview Lark channel must be disabled/i)
    await expect(captureSupervisedGrowthLifecycleAttestation({
      ...target('preview'),
      effectiveConfig: effective('preview').replace('requiredProviders: []', 'requiredProviders: [larkChannel]'),
    }, dependencies({ stage: 'preview' }))).rejects.toThrow(/preview Health must exempt larkChannel/i)
  })

  test('accepts preview to active only at a strictly newer exact generation', async () => {
    const baseline = await captureSupervisedGrowthLifecycleAttestation(
      target('preview'), dependencies({ stage: 'preview', generation: 7 }),
    )
    await expect(verifySupervisedGrowthLifecycleSuccessor({ baseline, target: target('active') },
      dependencies({ stage: 'active', generation: 8 }))).resolves.toMatchObject({
      stage: 'active', recovery: { bootstrapGeneration: 8 },
    })
  })

  test.each([
    ['reused', 7],
    ['regressed', 6],
  ])('rejects a %s Recovery generation', async (_kind, generation) => {
    const baseline = await captureSupervisedGrowthLifecycleAttestation(
      target('preview'), dependencies({ stage: 'preview', generation: 7 }),
    )
    await expect(verifySupervisedGrowthLifecycleSuccessor({ baseline, target: target('active') },
      dependencies({ stage: 'active', generation }))).rejects.toThrow(/strictly advance/i)
  })

  test('rejects Recovery or Automations drift between the two reads', async () => {
    await expect(captureSupervisedGrowthLifecycleAttestation(target('active'), dependencies({
      stage: 'active',
      recoveries: [
        recoverySnapshot({ stage: 'active', snapshotDigest: '1'.repeat(64) }),
        recoverySnapshot({ stage: 'active', snapshotDigest: '9'.repeat(64) }),
      ],
    }))).rejects.toThrow(/changed while capturing/i)
    await expect(captureSupervisedGrowthLifecycleAttestation(target('active'), dependencies({
      stage: 'active',
      automations: [
        automationSnapshot({ stage: 'active' }),
        automationSnapshot({ stage: 'active', inventoryDigest: '9'.repeat(64) }),
      ],
    }))).rejects.toThrow(/changed while capturing/i)
  })

  test('rejects a coherent expected proof whose nonce is not the effective config nonce', async () => {
    await expect(captureSupervisedGrowthLifecycleAttestation(target('active'), dependencies({
      stage: 'active', nonce: 'different-nonce',
    }))).rejects.toThrow(/identity does not match effective config/i)
  })

  test.each([
    ['missing', []],
    ['paused', [
      { ...automationSnapshot({ stage: 'active' }).records[0]!, status: 'active' as const },
      { ...automationSnapshot({ stage: 'active' }).records[1]!, status: 'paused' as const },
    ]],
    ['extra', [
      ...automationSnapshot({ stage: 'active' }).records,
      {
        id: 'recovery:unexpected', owner: 'dsh-enhanced-assistant-recovery',
        definitionHash: '9'.repeat(64), status: 'active' as const, createdAt: 1, updatedAt: 1,
        version: 1, runningTaskCount: 0,
      },
    ]],
  ] as const)('fails closed on %s managed active inventory', async (_kind, records) => {
    await expect(captureSupervisedGrowthLifecycleAttestation(target('active'), dependencies({
      stage: 'active', automations: [automationSnapshot({ stage: 'active', records })],
    }))).rejects.toThrow(/managed automation|unexpected active managed/i)
  })

  test('fails closed when global or per-definition work is running', async () => {
    await expect(captureSupervisedGrowthLifecycleAttestation(target('active'), dependencies({
      stage: 'active', automations: [automationSnapshot({ stage: 'active', inFlightCount: 1 })],
    }))).rejects.toThrow(/in-flight/i)
    const records = automationSnapshot({ stage: 'active' }).records.map((record, index) =>
      index === 0 ? { ...record, runningTaskCount: 1 } : record)
    await expect(captureSupervisedGrowthLifecycleAttestation(target('active'), dependencies({
      stage: 'active', automations: [automationSnapshot({ stage: 'active', records })],
    }))).rejects.toThrow(/in-flight/i)
  })

  test('rejects a changed runbook when it reuses the old activation nonce', async () => {
    const captured = await captureSupervisedGrowthLifecycleAttestation(
      target('preview'), dependencies({ stage: 'preview', generation: 3 }),
    )
    const { attestationDigest: _old, ...unsigned } = captured
    const changedUnsigned = {
      ...unsigned, recovery: { ...unsigned.recovery, catalogDigest: '7'.repeat(64) },
    }
    const baseline = Object.freeze({
      ...changedUnsigned,
      attestationDigest: supervisedGrowthLifecycleAttestationDigest(changedUnsigned),
    })
    await expect(verifySupervisedGrowthLifecycleSuccessor({ baseline, target: target('active') },
      dependencies({ stage: 'active', generation: 4 }))).rejects.toThrow(/reused the old activation nonce/i)
  })
})
