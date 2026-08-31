import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canonicalRecoveryBootstrapAttestationSet,
  RECOVERY_CATALOG_DIGEST,
  recoveryBootstrapAttestationSetDigest,
  type RecoveryBootstrapAttestation,
  type RecoveryHealth,
} from '@dsh-enhanced/assistant-recovery'
import { afterEach, describe, expect, test } from 'vitest'
import {
  assertSupervisedGrowthAutomationGuard,
  activateSupervisedGrowthPatch,
  activateSupervisedGrowthRecoveryStages,
  commitSupervisedGrowthPatch,
  expectedSupervisedGrowthRecoveryBootstrap,
  parseSupervisedGrowthSetupArgs,
  sameSupervisedGrowthBinding,
  selectUniqueOwnerBinding,
  verifySupervisedGrowthResidentService,
  verifySupervisedGrowthRecoveryStage,
} from '../src/supervised-growth-setup.ts'

const roots: string[] = []
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function bootstrapExpectation(
  input: readonly RecoveryBootstrapAttestation[],
): { attestations: readonly RecoveryBootstrapAttestation[]; attestationSetDigest: string } {
  const attestations = canonicalRecoveryBootstrapAttestationSet(input)
  return {
    attestations,
    attestationSetDigest: recoveryBootstrapAttestationSetDigest(attestations),
  }
}

const previewAttestation = Object.freeze({
  automationId: 'recovery:supervised-growth',
  activationState: 'preview' as const,
  activationNonce: 'activation-test',
  activationPlanDigest: 'a'.repeat(64),
})

const analystDefinition = Object.freeze({ prompt: 'exact supervised analyst' })
const expectedAnalystDefinition = async () => analystDefinition
const analystSnapshot = (status: 'active' | 'paused') => ({
  id: 'heartbeat:supervised-growth-analyst',
  owner: 'assistant-heartbeat',
  status,
  definition: analystDefinition,
})

function recoveryHealth(overrides: Partial<RecoveryHealth> = {}): RecoveryHealth {
  const expectation = bootstrapExpectation([previewAttestation])
  return {
    runningRuns: 0,
    failedRuns: 0,
    unknownRuns: 0,
    incompleteSteps: 0,
    staleRuns: 0,
    staleSteps: 0,
    lastSucceededAt: 0,
    lastFailedAt: 0,
    latestProductionStatus: 'none',
    consecutiveProductionFailures: 0,
    lastProductionRunAt: 0,
    bootstrapStatus: 'succeeded',
    bootstrapGeneration: 1,
    bootstrapAttestationValid: true,
    bootstrapAttestationSetDigest: expectation.attestationSetDigest,
    bootstrapAttestations: expectation.attestations,
    bootstrapUpdatedAt: 100,
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const binding = {
  id: 'binding-owner',
  conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_owner' },
  principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' },
  workspace: '/work/owner',
  agentPreset: 'standard',
  sessionId: 'session-owner',
  generation: 1,
  policyRef: 'owner-dm',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  version: 1,
} as const

describe('supervised-growth setup guards', () => {
  test('requires an explicit acknowledgement before every existing active job can coexist', () => {
    expect(() => assertSupervisedGrowthAutomationGuard([
      { id: 'owner-created-job', status: 'active' },
    ], false)).toThrow(/ack-existing-automations/i)
    expect(() => assertSupervisedGrowthAutomationGuard([
      { id: 'heartbeat:legacy', owner: 'assistant-heartbeat', status: 'active' },
    ], false)).toThrow(/ack-existing-automations/i)
    expect(() => assertSupervisedGrowthAutomationGuard([
      { id: 'heartbeat:supervised-growth', owner: 'assistant-heartbeat', status: 'active' },
      { id: 'heartbeat:supervised-growth-analyst', owner: 'assistant-heartbeat', status: 'active' },
      { id: 'recovery:supervised-growth', owner: 'dsh-enhanced-assistant-recovery', status: 'active' },
    ], false)).not.toThrow()
    expect(() => assertSupervisedGrowthAutomationGuard([
      {
        id: 'heartbeat:legacy-high-privilege',
        owner: 'assistant-heartbeat',
        status: 'active',
        definition: { allowedTools: ['bash', 'read'], provider: 'deepseek-official' },
      },
    ], false)).toThrow(/ack-existing-automations/i)
    expect(() => assertSupervisedGrowthAutomationGuard([
      { id: 'owner-created-job', status: 'active' },
    ], true)).not.toThrow()
  })

  test('refuses no or multiple matching owner DMs instead of guessing a recipient', () => {
    expect(() => selectUniqueOwnerBinding([])).toThrow(/send the bot a new direct message/i)
    expect(() => selectUniqueOwnerBinding([binding, { ...binding, id: 'binding-second' }])).toThrow(/multiple/i)
    expect(selectUniqueOwnerBinding([binding])).toEqual(binding)
  })

  test('treats any durable owner-route/version change as stale before activation', () => {
    expect(sameSupervisedGrowthBinding(binding, { ...binding })).toBe(true)
    expect(sameSupervisedGrowthBinding(binding, { ...binding, version: 2 })).toBe(false)
    expect(sameSupervisedGrowthBinding(binding, { ...binding, status: 'revoked' })).toBe(false)
    expect(sameSupervisedGrowthBinding(binding, {
      ...binding, conversation: { ...binding.conversation, chat: 'oc_other' },
    })).toBe(false)
    expect(sameSupervisedGrowthBinding(binding, { ...binding, agentPreset: 'other' })).toBe(false)
  })

  test('accepts only bounded explicit CLI flags', () => {
    expect(parseSupervisedGrowthSetupArgs(['--profile', 'web', '--timeout-ms', '30000', '--ack-existing-automations']))
      .toMatchObject({ profile: 'web', timeoutMs: 30000, ackExistingAutomations: true })
    expect(() => parseSupervisedGrowthSetupArgs(['--no-service'])).toThrow(/unknown option/i)
    expect(() => parseSupervisedGrowthSetupArgs(['--timeout-ms', '1'])).toThrow(/30000/i)
  })

  test('rolls back the atomic profile update when DSH validation rejects the overlay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supervised-growth-rollback-'))
    roots.push(root)
    const patchPath = join(root, 'cordis.patch.yml')
    await writeFile(patchPath, 'original\n', 'utf8')

    await expect(commitSupervisedGrowthPatch({
      patchPath,
      originalPatch: 'original\n',
      updatedPatch: 'updated\n',
      validate: () => { throw new Error('invalid profile') },
    })).rejects.toThrow('invalid profile')
    await expect(readFile(patchPath, 'utf8')).resolves.toBe('original\n')
  })

  test('restores the original profile and resident service if the post-write restart health gate fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supervised-growth-restart-rollback-'))
    roots.push(root)
    const patchPath = join(root, 'cordis.patch.yml')
    await writeFile(patchPath, 'original\n', 'utf8')
    let restored = 0

    await expect(activateSupervisedGrowthPatch({
      patchPath,
      originalPatch: 'original\n',
      updatedPatch: 'updated\n',
      validate: () => 'effective updated',
      afterCommit: async () => { throw new Error('resident service is not healthy') },
      restore: async () => { restored += 1 },
    })).rejects.toThrow(/resident service is not healthy/i)
    await expect(readFile(patchPath, 'utf8')).resolves.toBe('original\n')
    expect(restored).toBe(1)
  })

  test('restores the original bytes and resident after a process-healthy preview bootstrap fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supervised-growth-preview-rollback-'))
    roots.push(root)
    const patchPath = join(root, 'cordis.patch.yml')
    await writeFile(patchPath, 'original\n', 'utf8')
    const events: string[] = []

    await expect(activateSupervisedGrowthRecoveryStages({
      patchPath,
      originalPatch: 'original\n',
      previewPatch: 'preview\n',
      validate: stage => `${stage}-effective`,
      buildActivePatch: () => 'active\n',
      afterStage: async stage => {
        events.push(`${stage}:resident-running`)
        throw new Error('Recovery preview bootstrap failed: preview-failed')
      },
      restore: async () => { events.push('original:resident-restored') },
    })).rejects.toThrow(/preview bootstrap failed/i)
    await expect(readFile(patchPath, 'utf8')).resolves.toBe('original\n')
    expect(events).toEqual(['preview:resident-running', 'original:resident-restored'])
  })

  test('restores the original bytes after preview succeeds but active bootstrap fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supervised-growth-active-rollback-'))
    roots.push(root)
    const patchPath = join(root, 'cordis.patch.yml')
    await writeFile(patchPath, 'original\n', 'utf8')
    const events: string[] = []

    await expect(activateSupervisedGrowthRecoveryStages({
      patchPath,
      originalPatch: 'original\n',
      previewPatch: 'preview\n',
      validate: stage => `${stage}-effective`,
      buildActivePatch: preview => {
        expect(preview).toBe('preview-effective')
        return 'active\n'
      },
      afterStage: async stage => {
        events.push(`${stage}:resident-running`)
        if (stage === 'active') throw new Error('Recovery active bootstrap failed: missing-preview')
      },
      restore: async () => { events.push('original:resident-restored') },
    })).rejects.toThrow(/active bootstrap failed/i)
    await expect(readFile(patchPath, 'utf8')).resolves.toBe('original\n')
    expect(events).toEqual([
      'preview:resident-running', 'active:resident-running', 'original:resident-restored',
    ])
  })

  test('persistent Recovery health is a stricter gate than resident process health', async () => {
    const expected = bootstrapExpectation([previewAttestation])
    await expect(verifySupervisedGrowthRecoveryStage({
      stage: 'preview',
      effectiveConfig: 'preview',
      recoveryDatabasePath: '/tmp/recovery.sqlite',
      automationsDatabasePath: '/tmp/automations.sqlite',
      previousBootstrapGeneration: 0,
      timeoutMs: 1_000,
    }, {
      inspectRecovery: async () => recoveryHealth({
        bootstrapStatus: 'failed', bootstrapFailureCode: 'preview-failed', bootstrapGeneration: 1,
      }),
      listActiveAutomations: async () => [],
      expectedAnalystDefinition,
      expectedBootstrap: async () => expected,
    })).rejects.toThrow(/preview bootstrap failed: preview-failed/i)
  })

  test('active stage proves the exact system-owned production definition and no legacy heartbeat', async () => {
    const definition = { execution: { kind: 'host', catalogDigest: 'digest' } }
    const activeAttestation = { ...previewAttestation, activationState: 'active' as const }
    const expected = bootstrapExpectation([activeAttestation])
    await expect(verifySupervisedGrowthRecoveryStage({
      stage: 'active',
      effectiveConfig: 'active',
      recoveryDatabasePath: '/tmp/recovery.sqlite',
      automationsDatabasePath: '/tmp/automations.sqlite',
      previousBootstrapGeneration: 1,
      timeoutMs: 1_000,
    }, {
      inspectRecovery: async () => recoveryHealth({
        bootstrapGeneration: 2,
        bootstrapAttestationSetDigest: expected.attestationSetDigest,
        bootstrapAttestations: expected.attestations,
      }),
      listAutomations: async () => [
        {
          id: 'recovery:supervised-growth', status: 'active',
          owner: 'dsh-enhanced-assistant-recovery', definition,
        },
        analystSnapshot('active'),
      ],
      expectedProductionDefinition: async () => definition,
      expectedAnalystDefinition,
      expectedBootstrap: async () => expected,
    })).resolves.toBe(2)
  })

  test('fails closed when the analyst row is not the exact active managed definition', async () => {
    const definition = { execution: { kind: 'host', catalogDigest: 'digest' } }
    const expected = bootstrapExpectation([{ ...previewAttestation, activationState: 'active' as const }])
    await expect(verifySupervisedGrowthRecoveryStage({
      stage: 'active',
      effectiveConfig: 'active',
      recoveryDatabasePath: '/tmp/recovery.sqlite',
      automationsDatabasePath: '/tmp/automations.sqlite',
      previousBootstrapGeneration: 1,
      timeoutMs: 1_000,
    }, {
      inspectRecovery: async () => recoveryHealth({
        bootstrapGeneration: 2,
        bootstrapAttestationSetDigest: expected.attestationSetDigest,
        bootstrapAttestations: expected.attestations,
      }),
      listAutomations: async () => [{
        ...analystSnapshot('active'), definition: { prompt: 'drifted analyst' },
      }, {
        id: 'recovery:supervised-growth', status: 'active',
        owner: 'dsh-enhanced-assistant-recovery', definition,
      }],
      expectedProductionDefinition: async () => definition,
      expectedAnalystDefinition,
      expectedBootstrap: async () => expected,
    })).rejects.toThrow(/analyst automation.*exact attested definition/i)
  })

  test.each([
    ['nonce', { ...previewAttestation, activationNonce: 'wrong-nonce' }],
    ['state', { ...previewAttestation, activationState: 'active' as const }],
    ['plan digest', { ...previewAttestation, activationPlanDigest: 'b'.repeat(64) }],
  ])('rejects a coherent bootstrap set with the wrong %s', async (_field, actualAttestation) => {
    const expected = bootstrapExpectation([previewAttestation])
    const actual = bootstrapExpectation([actualAttestation])
    await expect(verifySupervisedGrowthRecoveryStage({
      stage: 'preview',
      effectiveConfig: 'preview',
      recoveryDatabasePath: '/tmp/recovery.sqlite',
      automationsDatabasePath: '/tmp/automations.sqlite',
      previousBootstrapGeneration: 4,
      timeoutMs: 1_000,
    }, {
      inspectRecovery: async () => recoveryHealth({
        bootstrapGeneration: 5,
        bootstrapAttestationSetDigest: actual.attestationSetDigest,
        bootstrapAttestations: actual.attestations,
      }),
      listAutomations: async () => [analystSnapshot('paused')],
      expectedAnalystDefinition,
      expectedBootstrap: async () => expected,
    })).rejects.toThrow(/exact bootstrap attestation set/i)
  })

  test.each([
    ['missing', []],
    ['extra', [
      previewAttestation,
      {
        ...previewAttestation,
        automationId: 'recovery:unexpected',
        activationNonce: 'unexpected-nonce',
      },
    ]],
  ] as const)('rejects a %s attestation from the full configured set', async (_kind, actualValues) => {
    const expected = bootstrapExpectation([previewAttestation])
    const actual = bootstrapExpectation(actualValues)
    await expect(verifySupervisedGrowthRecoveryStage({
      stage: 'preview',
      effectiveConfig: 'preview',
      recoveryDatabasePath: '/tmp/recovery.sqlite',
      automationsDatabasePath: '/tmp/automations.sqlite',
      previousBootstrapGeneration: 4,
      timeoutMs: 1_000,
    }, {
      inspectRecovery: async () => recoveryHealth({
        bootstrapGeneration: 5,
        bootstrapAttestationSetDigest: actual.attestationSetDigest,
        bootstrapAttestations: actual.attestations,
      }),
      listAutomations: async () => [analystSnapshot('paused')],
      expectedAnalystDefinition,
      expectedBootstrap: async () => expected,
    })).rejects.toThrow(/exact bootstrap attestation set/i)
  })

  test('rejects succeeded health whose attestation validity bit is false', async () => {
    const expected = bootstrapExpectation([previewAttestation])
    await expect(verifySupervisedGrowthRecoveryStage({
      stage: 'preview',
      effectiveConfig: 'preview',
      recoveryDatabasePath: '/tmp/recovery.sqlite',
      automationsDatabasePath: '/tmp/automations.sqlite',
      previousBootstrapGeneration: 4,
      timeoutMs: 1_000,
    }, {
      inspectRecovery: async () => recoveryHealth({
        bootstrapGeneration: 5,
        bootstrapAttestationValid: false,
      }),
      listActiveAutomations: async () => [],
      expectedAnalystDefinition,
      expectedBootstrap: async () => expected,
    })).rejects.toThrow(/bootstrap attestation is invalid/i)
  })

  test('rejects a set digest that does not bind the otherwise exact attestations', async () => {
    const expected = bootstrapExpectation([previewAttestation])
    await expect(verifySupervisedGrowthRecoveryStage({
      stage: 'preview',
      effectiveConfig: 'preview',
      recoveryDatabasePath: '/tmp/recovery.sqlite',
      automationsDatabasePath: '/tmp/automations.sqlite',
      previousBootstrapGeneration: 4,
      timeoutMs: 1_000,
    }, {
      inspectRecovery: async () => recoveryHealth({
        bootstrapGeneration: 5,
        bootstrapAttestationSetDigest: 'f'.repeat(64),
        bootstrapAttestations: expected.attestations,
      }),
      listActiveAutomations: async () => [],
      expectedAnalystDefinition,
      expectedBootstrap: async () => expected,
    })).rejects.toThrow(/attestation set digest/i)
  })

  test('requires active to use a generation strictly newer than the accepted preview', async () => {
    const activeAttestation = { ...previewAttestation, activationState: 'active' as const }
    const expected = bootstrapExpectation([activeAttestation])
    await expect(verifySupervisedGrowthRecoveryStage({
      stage: 'active',
      effectiveConfig: 'active',
      recoveryDatabasePath: '/tmp/recovery.sqlite',
      automationsDatabasePath: '/tmp/automations.sqlite',
      previousBootstrapGeneration: 8,
      timeoutMs: 1_000,
    }, {
      inspectRecovery: async () => recoveryHealth({
        bootstrapGeneration: 8,
        bootstrapAttestationSetDigest: expected.attestationSetDigest,
        bootstrapAttestations: expected.attestations,
      }),
      listActiveAutomations: async () => [],
      expectedProductionDefinition: async () => ({}),
      expectedAnalystDefinition,
      expectedBootstrap: async () => expected,
    })).rejects.toThrow(/reused generation 8/i)
  })

  test('waits through the pre-restart baseline proof and accepts only its successor', async () => {
    const expected = bootstrapExpectation([previewAttestation])
    const stale = bootstrapExpectation([{ ...previewAttestation, activationNonce: 'prior-activation' }])
    let inspection = 0
    await expect(verifySupervisedGrowthRecoveryStage({
      stage: 'preview',
      effectiveConfig: 'preview',
      recoveryDatabasePath: '/tmp/recovery.sqlite',
      automationsDatabasePath: '/tmp/automations.sqlite',
      previousBootstrapGeneration: 12,
      timeoutMs: 10,
    }, {
      inspectRecovery: async () => {
        inspection += 1
        return inspection === 1
          ? recoveryHealth({
              bootstrapGeneration: 12,
              bootstrapAttestationSetDigest: stale.attestationSetDigest,
              bootstrapAttestations: stale.attestations,
            })
          : recoveryHealth({ bootstrapGeneration: 13 })
      },
      listAutomations: async () => [analystSnapshot('paused')],
      expectedAnalystDefinition,
      expectedBootstrap: async () => expected,
      retryDelayMs: 1,
      wait: async () => {},
    })).resolves.toBe(13)
  })

  test('fails closed if the durable bootstrap generation regresses while polling', async () => {
    const expected = bootstrapExpectation([previewAttestation])
    let inspection = 0
    await expect(verifySupervisedGrowthRecoveryStage({
      stage: 'preview',
      effectiveConfig: 'preview',
      recoveryDatabasePath: '/tmp/recovery.sqlite',
      automationsDatabasePath: '/tmp/automations.sqlite',
      previousBootstrapGeneration: 7,
      timeoutMs: 10,
    }, {
      inspectRecovery: async () => {
        inspection += 1
        return inspection === 1
          ? recoveryHealth({ bootstrapStatus: 'running', bootstrapGeneration: 9 })
          : recoveryHealth({ bootstrapGeneration: 8 })
      },
      listActiveAutomations: async () => [],
      expectedAnalystDefinition,
      expectedBootstrap: async () => expected,
      retryDelayMs: 1,
      wait: async () => {},
    })).rejects.toThrow(/generation regressed from 9 to 8/i)
  })

  test('accepts an exact newer generation when the persisted diagnostic clock moves backward', async () => {
    const expected = bootstrapExpectation([previewAttestation])
    let inspection = 0
    await expect(verifySupervisedGrowthRecoveryStage({
      stage: 'preview',
      effectiveConfig: 'preview',
      recoveryDatabasePath: '/tmp/recovery.sqlite',
      automationsDatabasePath: '/tmp/automations.sqlite',
      previousBootstrapGeneration: 11,
      timeoutMs: 1_000,
    }, {
      inspectRecovery: async () => {
        inspection += 1
        return inspection === 1
          ? recoveryHealth({
              bootstrapStatus: 'running', bootstrapGeneration: 12, bootstrapUpdatedAt: 1_000,
            })
          : recoveryHealth({ bootstrapGeneration: 12, bootstrapUpdatedAt: 500 })
      },
      listAutomations: async () => [analystSnapshot('paused')],
      expectedAnalystDefinition,
      expectedBootstrap: async () => expected,
      retryDelayMs: 1,
      wait: async () => {},
    })).resolves.toBe(12)
  })

  test('rechecks Recovery proof after reading Automations and never returns a superseded generation', async () => {
    const expected = bootstrapExpectation([previewAttestation])
    let inspection = 0
    let inventoryReads = 0
    await expect(verifySupervisedGrowthRecoveryStage({
      stage: 'preview',
      effectiveConfig: 'preview',
      recoveryDatabasePath: '/tmp/recovery.sqlite',
      automationsDatabasePath: '/tmp/automations.sqlite',
      previousBootstrapGeneration: 4,
      timeoutMs: 10,
    }, {
      inspectRecovery: async () => {
        inspection += 1
        if (inspection === 1) return recoveryHealth({ bootstrapGeneration: 5 })
        if (inspection === 2) return recoveryHealth({ bootstrapStatus: 'running', bootstrapGeneration: 6 })
        return recoveryHealth({ bootstrapGeneration: 6 })
      },
      listAutomations: async () => {
        inventoryReads += 1
        return [analystSnapshot('paused')]
      },
      expectedAnalystDefinition,
      expectedBootstrap: async () => expected,
      retryDelayMs: 1,
      wait: async () => {},
    })).resolves.toBe(6)
    expect(inventoryReads).toBe(2)
  })

  test('keeps the legacy-heartbeat absence gate after exact active attestation', async () => {
    const definition = { execution: { kind: 'host' } }
    const activeAttestation = { ...previewAttestation, activationState: 'active' as const }
    const expected = bootstrapExpectation([activeAttestation])
    await expect(verifySupervisedGrowthRecoveryStage({
      stage: 'active',
      effectiveConfig: 'active',
      recoveryDatabasePath: '/tmp/recovery.sqlite',
      automationsDatabasePath: '/tmp/automations.sqlite',
      previousBootstrapGeneration: 1,
      timeoutMs: 1,
    }, {
      inspectRecovery: async () => recoveryHealth({
        bootstrapGeneration: 2,
        bootstrapAttestationSetDigest: expected.attestationSetDigest,
        bootstrapAttestations: expected.attestations,
      }),
      listAutomations: async () => [
        { id: 'heartbeat:supervised-growth', owner: 'assistant-heartbeat', status: 'active' },
        analystSnapshot('active'),
        {
          id: 'recovery:supervised-growth', owner: 'dsh-enhanced-assistant-recovery',
          status: 'active', definition,
        },
      ],
      expectedProductionDefinition: async () => definition,
      expectedAnalystDefinition,
      expectedBootstrap: async () => expected,
      retryDelayMs: 1,
      wait: async () => {},
    })).rejects.toThrow(/bootstrap did not become ready/i)
  })

  test('deterministically derives the complete canonical proof from Recovery jobs and owner routes', async () => {
    const effectiveConfig = `
- id: dsh-enhanced-assistant-delivery
  config:
    ownerRoutes:
      - id: route-zeta
        conversation: { channel: lark, account: primary, tenant: personal, kind: dm, chat: oc_zeta }
        principal: { channel: lark, account: primary, tenant: personal, user: ou_zeta }
        workspace: /work/zeta
        agentPreset: standard
        policyRef: owner-dm
        minimumGeneration: 1
      - id: route-alpha
        conversation: { channel: lark, account: primary, tenant: personal, kind: dm, chat: oc_alpha }
        principal: { channel: lark, account: primary, tenant: personal, user: ou_alpha }
        workspace: /work/alpha
        agentPreset: standard
        policyRef: owner-dm
        minimumGeneration: 2
- id: dsh-enhanced-assistant-recovery
  config:
    databasePath: /tmp/configured-recovery.sqlite
    maxStepDurationMs: 1000
    jobs:
      - id: zeta
        activationState: paused
        activationNonce: nonce-zeta
        catalogDigest: ${RECOVERY_CATALOG_DIGEST}
        workspace: /work/zeta
        preset: standard
        principal: lark/primary/personal/ou_zeta
        ownerRouteId: route-zeta
        cron: "0 8 * * *"
        timezone: UTC
      - id: alpha
        activationState: preview
        activationNonce: nonce-alpha
        catalogDigest: ${RECOVERY_CATALOG_DIGEST}
        workspace: /work/alpha
        preset: standard
        principal: lark/primary/personal/ou_alpha
        ownerRouteId: route-alpha
        cron: "0 10 * * *"
        timezone: UTC
        budgetId: growth-runs
        budgetAmount: 1
`
    const expected = await expectedSupervisedGrowthRecoveryBootstrap(
      effectiveConfig,
      '/tmp/effective-recovery.sqlite',
    )
    const [delivery, recovery] = await Promise.all([
      import('@dsh-enhanced/assistant-delivery'),
      import('@dsh-enhanced/assistant-recovery'),
    ])
    const ownerRouteAuthorityHash = (delivery as unknown as {
      ownerRouteAuthorityHash: (input: unknown) => string
    }).ownerRouteAuthorityHash
    const normalized = recovery.normalizeRecoveryConfig({
      databasePath: '/tmp/effective-recovery.sqlite',
      maxStepDurationMs: 1_000,
      jobs: [
        {
          id: 'zeta', activationState: 'paused', activationNonce: 'nonce-zeta',
          catalogDigest: RECOVERY_CATALOG_DIGEST, workspace: '/work/zeta', preset: 'standard',
          principal: 'lark/primary/personal/ou_zeta', ownerRouteId: 'route-zeta',
          cron: '0 8 * * *', timezone: 'UTC',
        },
        {
          id: 'alpha', activationState: 'preview', activationNonce: 'nonce-alpha',
          catalogDigest: RECOVERY_CATALOG_DIGEST, workspace: '/work/alpha', preset: 'standard',
          principal: 'lark/primary/personal/ou_alpha', ownerRouteId: 'route-alpha',
          cron: '0 10 * * *', timezone: 'UTC', budgetId: 'growth-runs', budgetAmount: 1,
        },
      ],
    })
    const authorityHashes = new Map([
      ['route-zeta', ownerRouteAuthorityHash({
        id: 'route-zeta',
        conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_zeta' },
        principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_zeta' },
        workspace: '/work/zeta', agentPreset: 'standard', policyRef: 'owner-dm', minimumGeneration: 1,
      })],
      ['route-alpha', ownerRouteAuthorityHash({
        id: 'route-alpha',
        conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_alpha' },
        principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_alpha' },
        workspace: '/work/alpha', agentPreset: 'standard', policyRef: 'owner-dm', minimumGeneration: 2,
      })],
    ])
    const exactPlanDigests = new Map(normalized.jobs.map(job => [
      recovery.recoveryAutomationId(job.id),
      recovery.recoveryActivationPlanDigest(
        job,
        normalized.maxStepDurationMs,
        authorityHashes.get(job.ownerRouteId)!,
      ),
    ]))
    expect(expected.attestations).toEqual([
      {
        automationId: 'recovery:alpha', activationState: 'preview', activationNonce: 'nonce-alpha',
        activationPlanDigest: exactPlanDigests.get('recovery:alpha'),
      },
      {
        automationId: 'recovery:zeta', activationState: 'paused', activationNonce: 'nonce-zeta',
        activationPlanDigest: exactPlanDigests.get('recovery:zeta'),
      },
    ])
    expect(expected.attestations)
      .toEqual(canonicalRecoveryBootstrapAttestationSet(expected.attestations))
    expect(expected.attestationSetDigest)
      .toBe(recoveryBootstrapAttestationSetDigest(expected.attestations))
    const rotatedRoute = await expectedSupervisedGrowthRecoveryBootstrap(
      effectiveConfig.replace('minimumGeneration: 2', 'minimumGeneration: 3'),
      '/tmp/effective-recovery.sqlite',
    )
    expect(rotatedRoute.attestations[0]!.activationPlanDigest)
      .not.toBe(expected.attestations[0]!.activationPlanDigest)
    expect(rotatedRoute.attestations[1]!.activationPlanDigest)
      .toBe(expected.attestations[1]!.activationPlanDigest)
  })

  test('requires a bounded, verifiable resident-running state instead of registration alone', async () => {
    const service = {
      kind: 'launchd' as const,
      target: 'gui/501/ai.dsh.web',
      statusCommand: 'launchctl print gui/501/ai.dsh.web',
      logCommand: 'tail -f /tmp/dsh.log',
    }
    await expect(verifySupervisedGrowthResidentService(service, {
      attempts: 1,
      run: () => ({ status: 0, stdout: 'state = exited\nlast exit code = 1\n', stderr: '' }),
    })).rejects.toThrow(/healthy/i)
    await expect(verifySupervisedGrowthResidentService(service, {
      attempts: 1,
      run: (command, args) => {
        expect(command).toBe('/bin/launchctl')
        expect(args).toEqual(['print', 'gui/501/ai.dsh.web'])
        return { status: 0, stdout: 'state = running\n', stderr: '' }
      },
    })).resolves.toBeUndefined()
    await expect(verifySupervisedGrowthResidentService({ ...service, kind: 'windows-task-best-effort' }, {
      attempts: 1,
      run: () => ({ status: 0, stdout: '', stderr: '' }),
    })).rejects.toThrow(/verifiable resident health/i)
  })

  test('the real pnpm-profile .bin entrypoint prints help and leaves the profile untouched', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'supervised-growth-profile-bin-'))
    roots.push(dshHome)
    const profileDirectory = join(dshHome, 'profiles', 'web')
    const nodeModules = join(profileDirectory, 'node_modules')
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    await mkdir(join(nodeModules, '@dsh-enhanced'), { recursive: true })
    await writeFile(patchPath, '[]\n', 'utf8')
    await symlink(join(repoRoot, 'plugins', 'lark-channel'), join(nodeModules, '@dsh-enhanced', 'lark-channel'), 'dir')
    await mkdir(join(nodeModules, '.bin'))
    const binary = join(nodeModules, '.bin', 'dsh-supervised-growth-setup')
    await symlink('../@dsh-enhanced/lark-channel/bin/dsh-supervised-growth-setup.js', binary, 'file')

    const result = spawnSync(binary, ['--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: dshHome },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Usage: dsh-supervised-growth-setup')
    await expect(readFile(patchPath, 'utf8')).resolves.toBe('[]\n')
    await expect(readFile(join(dshHome, 'assistant-delivery', 'state.sqlite'))).rejects.toThrow()
    await expect(readFile(join(dshHome, 'assistant-automations', 'state.sqlite'))).rejects.toThrow()
  })
})
