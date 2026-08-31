import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HostAutomationExecutionSpec,
  HostAutomationExecutorInput,
} from '@dsh-enhanced/assistant-automations'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RECOVERY_EXECUTOR_CONTRACT_VERSION,
  RECOVERY_EXECUTOR_ID,
  RecoveryAutomationExecutor,
} from '../src/automation-executor.ts'
import { RECOVERY_CATALOG_DIGEST } from '../src/catalog.ts'
import {
  RecoveryExecutor,
  RecoveryPortError,
  type RecoveryRunbookPort,
} from '../src/executor.ts'
import { RecoveryStore } from '../src/store.ts'

const roots: string[] = []
const digest = (value: string) => value.repeat(64)
const preferenceLineage = Object.freeze({
  principalRecordId: 'principal-row-1',
  principalVersion: 1,
})

function spec(overrides: Partial<HostAutomationExecutionSpec> = {}): HostAutomationExecutionSpec {
  return {
    kind: 'host',
    executorId: RECOVERY_EXECUTOR_ID,
    executorContractVersion: RECOVERY_EXECUTOR_CONTRACT_VERSION,
    runbookId: 'supervised-growth/v2',
    runbookVersion: 3,
    catalogDigest: RECOVERY_CATALOG_DIGEST,
    targetScope: { workspace: '/workspace', preset: 'owner' },
    scopeDigest: '47dd5233c728db288367a8a04441645b88b26e44e62f06204795c2bf22d80f48',
    ownerRouteId: 'owner-route',
    activationNonce: 'activation-1',
    ...overrides,
  }
}

function input(overrides: Partial<HostAutomationExecutorInput> = {}): HostAutomationExecutorInput {
  return {
    occurrenceId: 'occurrence-1',
    automationId: 'recovery:supervised-growth',
    definitionHash: digest('a'),
    executionMode: 'production',
    targetScope: { workspace: '/workspace', preset: 'owner' },
    principal: 'owner-principal',
    ownerRouteId: 'owner-route',
    activationNonce: 'activation-1',
    catalogDigest: RECOVERY_CATALOG_DIGEST,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function harness(port: RecoveryRunbookPort): RecoveryAutomationExecutor {
  const root = mkdtempSync(join(tmpdir(), 'assistant-recovery-adapter-'))
  roots.push(root)
  const store = new RecoveryStore({ path: join(root, 'recovery.sqlite'), now: () => 1_000 })
  return new RecoveryAutomationExecutor(
    new RecoveryExecutor(store, port, 1_000),
    () => digest('e'),
  )
}

function noChangePort(overrides: Partial<RecoveryRunbookPort> = {}): RecoveryRunbookPort {
  return {
    async plan(_context, stepId) {
      if (stepId === 'authority-admission') return { action: { kind: 'verify-authority' }, beforeDigest: digest('b') }
      if (stepId === 'verification') return { action: { kind: 'verify-health' }, beforeDigest: digest('b') }
      return { action: { kind: 'noop', reasonCode: 'no-change' }, beforeDigest: digest('b') }
    },
    async execute() {
      return { status: 'succeeded', resultCode: 'verified', afterDigest: digest('c') }
    },
    ...overrides,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RecoveryAutomationExecutor', () => {
  it('accepts only the exact compiled contract and canonical scope digest', () => {
    const executor = harness(noChangePort())
    expect(executor.accepts(spec())).toBe(true)
    expect(executor.accepts(spec({ runbookVersion: 2 }))).toBe(false)
    expect(executor.accepts(spec({ scopeDigest: digest('0') }))).toBe(false)
  })

  it('maps a read-only successful run to a side-effect-free terminal tuple', async () => {
    const executor = harness(noChangePort())
    await expect(executor.execute(input())).resolves.toEqual({
      outcome: 'succeeded',
      failureClass: 'none',
      failurePhase: 'none',
      failureCode: 'none',
      sideEffectState: 'none',
      retryability: 'safe',
    })
  })

  it('single-flights concurrent dispatch of the same immutable occurrence', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const base = noChangePort()
    const plan = vi.fn(async (...args: Parameters<RecoveryRunbookPort['plan']>) => {
      if (args[1] === 'authority-admission') await gate
      return base.plan(...args)
    })
    const executor = harness({ ...base, plan })

    const first = executor.execute(input())
    await vi.waitFor(() => expect(plan).toHaveBeenCalledOnce())
    const second = executor.execute(input())
    expect(second).toBe(first)
    release()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(plan).toHaveBeenCalledTimes(7)
  })

  it('reports a committed T1 action conservatively as possible and unsafe to retry', async () => {
    const port = noChangePort({
      async plan(_context, stepId) {
        if (stepId === 'authority-admission') return { action: { kind: 'verify-authority' }, beforeDigest: digest('b') }
        if (stepId === 't1-effects') {
          return {
            action: {
              kind: 'activate-preference',
              hypothesisId: 'hypothesis-1',
              expectedVersion: 1,
              ownerGeneration: 1,
              principalLineage: preferenceLineage,
            },
            beforeDigest: digest('b'),
          }
        }
        if (stepId === 'verification') return { action: { kind: 'verify-health' }, beforeDigest: digest('b') }
        return { action: { kind: 'noop', reasonCode: 'no-change' }, beforeDigest: digest('b') }
      },
    })
    await expect(harness(port).execute(input())).resolves.toMatchObject({
      outcome: 'succeeded', sideEffectState: 'possible', retryability: 'unsafe',
    })
  })

  it('keeps an ambiguous mutation failure unknown and non-retryable', async () => {
    const port = noChangePort({
      async plan(_context, stepId) {
        if (stepId === 'authority-admission') return { action: { kind: 'verify-authority' }, beforeDigest: digest('b') }
        if (stepId === 'retention-maintenance') {
          return {
            action: {
              kind: 'maintain-preferences',
              limit: 1,
              ownerGeneration: 1,
              principalLineage: preferenceLineage,
            },
            beforeDigest: digest('b'),
          }
        }
        return { action: { kind: 'noop', reasonCode: 'no-change' }, beforeDigest: digest('b') }
      },
      async execute(_context, stepId) {
        if (stepId === 'retention-maintenance') throw new RecoveryPortError('store-ambiguous', 'possible')
        return { status: 'succeeded', resultCode: 'verified', afterDigest: digest('c') }
      },
    })
    await expect(harness(port).execute(input())).resolves.toMatchObject({
      outcome: 'unknown', failureClass: 'unknown', failurePhase: 'recovery',
      sideEffectState: 'possible', retryability: 'unsafe',
    })
  })

  it('exposes a drain seam so the Recovery database is not closed under an active execution', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const executor = harness(noChangePort({
      async execute() {
        await blocked
        return { status: 'succeeded', resultCode: 'verified', afterDigest: digest('c') }
      },
    }))
    const operation = executor.execute(input())
    let drained = false
    const drain = executor.whenIdle().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    release()
    await expect(operation).resolves.toMatchObject({ outcome: 'succeeded' })
    await drain
    expect(drained).toBe(true)
  })
})
