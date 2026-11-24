import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CompensationExecutor,
  CompensationLedger,
  CompensationRegistry,
} from '../src/index.js'

const tempRoots: string[] = []

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-recovery-comp-exec-'))
  chmodSync(dir, 0o700)
  tempRoots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('CompensationExecutor', () => {
  it('seals preimage before dispatch, returns receipt, and omits raw preimage from result/status', async () => {
    const ledger = new CompensationLedger({ path: ':memory:' })
    const registry = new CompensationRegistry()
    const observedEvents: string[] = []

    registry.register({
      kind: 'fs.restore-file',
      category: 'rollback-state',
      capturePreimage: ({ record }) => {
        observedEvents.push(`capture:${record.status}`)
        return { existed: true, content: 'SECRET_PREIMAGE_DATA' }
      },
      compensate: ({ record }) => {
        observedEvents.push(`compensate:${record.status}`)
        expect(record.preimage).toEqual({ existed: true, content: 'SECRET_PREIMAGE_DATA' })
        return { status: 'succeeded', resultCode: 'restored', receipt: { bytesRestored: 20 } }
      },
    })

    const executor = new CompensationExecutor(registry, ledger)
    const result = await executor.executeCompensation({
      idempotencyKey: 'exec-happy-1',
      kind: 'fs.restore-file',
      target: { filePath: '/workspace/app.ts' },
      forwardActionId: 'fwd-happy-1',
    })

    expect(observedEvents).toEqual(['capture:capturing', 'compensate:dispatched'])
    expect(result.status).toBe('succeeded')
    expect(result.resultCode).toBe('restored')
    expect(result.replayed).toBe(false)
    expect(result.receipt).toEqual({ bytesRestored: 20 })
    expect(result.preimageDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect('preimage' in result).toBe(false)

    const status = ledger.getById(result.id)!
    expect('preimage' in status).toBe(false)
    expect(status.preimageDigest).toBe(result.preimageDigest)
    ledger.close()
  })

  it('fails closed on unregistered kind with zero ledger side effects', async () => {
    const ledger = new CompensationLedger({ path: ':memory:' })
    const registry = new CompensationRegistry()
    const executor = new CompensationExecutor(registry, ledger)

    await expect(
      executor.executeCompensation({
        idempotencyKey: 'missing-handler-1',
        kind: 'nonexistent.handler',
        target: { id: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'handler-not-registered' })

    expect(ledger.list()).toEqual([])
    ledger.close()
  })

  it('deduplicates identical idempotencyKey replays and rejects conflicting payloads', async () => {
    const ledger = new CompensationLedger({ path: ':memory:' })
    const registry = new CompensationRegistry()
    const captureSpy = vi.fn(() => ({ snapshot: 'v1' }))
    const compensateSpy = vi.fn(() => ({ status: 'succeeded' as const, resultCode: 'undone' }))

    registry.register({
      kind: 'lark.cancel-message',
      category: 'cancel',
      capturePreimage: captureSpy,
      compensate: compensateSpy,
    })

    const executor = new CompensationExecutor(registry, ledger)
    const input = {
      idempotencyKey: 'idem-replay-1',
      kind: 'lark.cancel-message',
      target: { messageId: 'om_123' },
      forwardActionId: 'fwd-replay-1',
    }
    const first = await executor.executeCompensation(input)
    const second = await executor.executeCompensation(input)

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.id).toBe(first.id)
    expect(captureSpy).toHaveBeenCalledTimes(1)
    expect(compensateSpy).toHaveBeenCalledTimes(1)
    expect(ledger.listAudit(first.id).map(a => a.event)).toEqual([
      'capturing',
      'prepared',
      'dispatched',
      'settled',
      'replayed',
    ])

    await expect(
      executor.executeCompensation({
        ...input,
        target: { messageId: 'om_999' },
      }),
    ).rejects.toMatchObject({ code: 'idempotency-conflict' })
    ledger.close()
  })

  it('enforces forwardActionId uniqueness after seal while allowing retry after pre-dispatch discard', async () => {
    const ledger = new CompensationLedger({ path: ':memory:' })
    const registry = new CompensationRegistry()
    let shouldFailCapture = true

    registry.register({
      kind: 'http.delete',
      category: 'delete',
      capturePreimage: () => {
        if (shouldFailCapture) throw new Error('transient capture failure')
        return { resourceId: 'res-1' }
      },
      compensate: () => ({ status: 'succeeded', resultCode: 'deleted' }),
    })

    const executor = new CompensationExecutor(registry, ledger)

    await expect(
      executor.executeCompensation({
        idempotencyKey: 'key-attempt-1',
        kind: 'http.delete',
        target: { url: 'https://example.invalid/res-1' },
        forwardActionId: 'fwd-unique-1',
      }),
    ).rejects.toMatchObject({ code: 'capture-failed' })

    // Because capturing row was discarded, retrying the same forwardActionId with a new key succeeds!
    shouldFailCapture = false
    const retried = await executor.executeCompensation({
      idempotencyKey: 'key-attempt-2',
      kind: 'http.delete',
      target: { url: 'https://example.invalid/res-1' },
      forwardActionId: 'fwd-unique-1',
    })
    expect(retried.status).toBe('succeeded')

    // A second idempotencyKey for the already-sealed forwardActionId is rejected as conflict.
    await expect(
      executor.executeCompensation({
        idempotencyKey: 'key-attempt-3',
        kind: 'http.delete',
        target: { url: 'https://example.invalid/res-1' },
        forwardActionId: 'fwd-unique-1',
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    ledger.close()
  })

  it('deduplicates concurrent in-flight calls with the same idempotencyKey', async () => {
    const ledger = new CompensationLedger({ path: ':memory:' })
    const registry = new CompensationRegistry()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const compensateSpy = vi.fn(async () => {
      await gate
      return { status: 'succeeded' as const, resultCode: 'concurrent-ok' }
    })

    registry.register({
      kind: 'calendar.cancel',
      category: 'cancel',
      compensate: compensateSpy,
    })

    const executor = new CompensationExecutor(registry, ledger)
    const p1 = executor.executeCompensation({
      idempotencyKey: 'concurrent-1',
      kind: 'calendar.cancel',
      target: { eventId: 'evt-1' },
    })
    const p2 = executor.executeCompensation({
      idempotencyKey: 'concurrent-1',
      kind: 'calendar.cancel',
      target: { eventId: 'evt-1' },
    })

    // Yield microtasks so p1 reaches compensateSpy
    await new Promise(resolve => setTimeout(resolve, 20))
    release()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(compensateSpy).toHaveBeenCalledTimes(1)
    expect(r1.id).toBe(r2.id)
    expect(r1.status).toBe('succeeded')
    expect(r2.status).toBe('succeeded')
    ledger.close()
  })

  it('discards capturing on auth loss during capture and abandons prepared as unknown if auth ends after seal before dispatch', async () => {
    const ledger = new CompensationLedger({ path: ':memory:' })
    const registry = new CompensationRegistry()
    const compensateSpy = vi.fn(() => ({ status: 'succeeded' as const, resultCode: 'should-not-run' }))

    // Case 1: auth loss during capture discards capturing row
    let authDuringCapture = true
    registry.register({
      kind: 'notify.undo-capture',
      category: 'notify-undo',
      capturePreimage: () => {
        authDuringCapture = false
        return { messageRef: 'm0' }
      },
      compensate: compensateSpy,
    })

    const executor = new CompensationExecutor(registry, ledger)
    await expect(
      executor.executeCompensation(
        {
          idempotencyKey: 'capture-auth-loss',
          kind: 'notify.undo-capture',
          target: { messageId: 'm0' },
        },
        { authorize: () => authDuringCapture },
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect(ledger.getByIdempotencyKey('capture-auth-loss')).toBeUndefined()

    // Case 2: auth loss after sealPrepared and before markDispatched abandons prepared as unknown
    let authChecks = 0
    registry.register({
      kind: 'notify.undo',
      category: 'notify-undo',
      capturePreimage: () => ({ messageRef: 'm1' }),
      compensate: compensateSpy,
    })

    await expect(
      executor.executeCompensation(
        {
          idempotencyKey: 'pre-dispatch-auth-loss',
          kind: 'notify.undo',
          target: { messageId: 'm1' },
        },
        {
          authorize: () => {
            authChecks += 1
            // 1st check: pre-capture, 2nd check: post-capture pre-seal, 3rd check: pre-dispatch
            return authChecks <= 2
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' })

    expect(compensateSpy).not.toHaveBeenCalled()
    const stored = ledger.getByIdempotencyKey('pre-dispatch-auth-loss')!
    expect(stored.status).toBe('unknown')
    expect(stored.resultCode).toBe('authorization-ended-before-dispatch')
    expect(ledger.listAudit(stored.id).map(a => a.event)).toEqual(['capturing', 'prepared', 'abandoned'])
    ledger.close()
  })

  it('settles post-dispatch errors and timeouts conservatively as unknown and never replays across restart', async () => {
    const dir = makeRoot()
    const dbPath = join(dir, 'recovery.sqlite')
    const ledger1 = new CompensationLedger({ path: dbPath })
    const registry1 = new CompensationRegistry()

    let markDispatchedGate!: () => void
    const dispatchedGate = new Promise<void>((resolve) => { markDispatchedGate = resolve })

    registry1.register({
      kind: 'external.post-error',
      category: 'revert',
      compensate: () => {
        throw new Error('network timeout after POST')
      },
    })
    registry1.register({
      kind: 'external.hang',
      category: 'revert',
      compensate: () => {
        markDispatchedGate()
        return new Promise(() => {})
      },
    })

    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const executor1 = new CompensationExecutor(registry1, ledger1, { defaultTimeoutMs: 1_000 })
      const errResult = await executor1.executeCompensation({
        idempotencyKey: 'post-err-1',
        kind: 'external.post-error',
        target: { op: 1 },
      })
      expect(errResult.status).toBe('unknown')
      expect(errResult.resultCode).toBe('dispatch-unconfirmed-no-replay')

      const timeoutPromise = executor1.executeCompensation(
        {
          idempotencyKey: 'post-timeout-1',
          kind: 'external.hang',
          target: { op: 2 },
        },
        { timeoutMs: 500 },
      )
      await dispatchedGate
      await vi.advanceTimersByTimeAsync(500)
      const timeoutResult = await timeoutPromise
      expect(timeoutResult.status).toBe('unknown')
      expect(timeoutResult.resultCode).toBe('authorization-ended-after-dispatch')
    } finally {
      vi.useRealTimers()
    }
    ledger1.close()

    // Restart and replay: must return stored unknown without calling compensate again.
    const ledger2 = new CompensationLedger({ path: dbPath })
    const registry2 = new CompensationRegistry()
    const replaySpy = vi.fn(() => ({ status: 'succeeded' as const, resultCode: 'nope' }))
    registry2.register({
      kind: 'external.post-error',
      category: 'revert',
      compensate: replaySpy,
    })
    const executor2 = new CompensationExecutor(registry2, ledger2)
    const replayed = await executor2.executeCompensation({
      idempotencyKey: 'post-err-1',
      kind: 'external.post-error',
      target: { op: 1 },
    })
    expect(replayed.replayed).toBe(true)
    expect(replayed.status).toBe('unknown')
    expect(replaySpy).not.toHaveBeenCalled()
    ledger2.close()
  })

  it('rejects pre-dispatch capture timeouts deterministically with expired and discards capturing rows', async () => {
    const ledger = new CompensationLedger({ path: ':memory:' })
    const registry = new CompensationRegistry()
    let markCaptureStarted!: () => void
    const captureGate = new Promise<void>((resolve) => { markCaptureStarted = resolve })
    const compensateSpy = vi.fn(() => ({ status: 'succeeded' as const, resultCode: 'should-not-run' }))

    registry.register({
      kind: 'external.capture-hang',
      category: 'revert',
      capturePreimage: () => {
        markCaptureStarted()
        return new Promise(() => {})
      },
      compensate: compensateSpy,
    })

    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const executor = new CompensationExecutor(registry, ledger, { defaultTimeoutMs: 1_000 })
      const pending = executor.executeCompensation(
        {
          idempotencyKey: 'pre-timeout-1',
          kind: 'external.capture-hang',
          target: { op: 3 },
        },
        { timeoutMs: 500 },
      )
      const rejection = expect(pending).rejects.toMatchObject({ code: 'expired' })
      await captureGate
      await vi.advanceTimersByTimeAsync(500)
      await rejection
      expect(compensateSpy).not.toHaveBeenCalled()
      expect(ledger.getByIdempotencyKey('pre-timeout-1')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
    ledger.close()
  })

  it('tracks pre-seal async authorize calls in whenIdle() before ledger close', async () => {
    const ledger = new CompensationLedger({ path: ':memory:' })
    const registry = new CompensationRegistry()
    let releaseAuth!: (allowed: boolean) => void
    let authStarted!: () => void
    const authStartedPromise = new Promise<void>((resolve) => { authStarted = resolve })

    registry.register({
      kind: 'external.async-auth',
      category: 'custom',
      compensate: () => ({ status: 'succeeded', resultCode: 'ok' }),
    })

    const executor = new CompensationExecutor(registry, ledger)
    let authCalls = 0
    const callPromise = executor.executeCompensation(
      {
        idempotencyKey: 'async-auth-idle-1',
        kind: 'external.async-auth',
        target: { op: 4 },
      },
      {
        authorize: () => {
          authCalls += 1
          if (authCalls === 1) {
            authStarted()
            return new Promise<boolean>((resolve) => { releaseAuth = resolve })
          }
          return true
        },
      },
    )

    await authStartedPromise
    let idleResolved = false
    const idlePromise = executor.whenIdle().then(() => { idleResolved = true })
    await Promise.resolve()
    expect(idleResolved).toBe(false)

    releaseAuth(true)
    const [res] = await Promise.all([callPromise, idlePromise])
    expect(idleResolved).toBe(true)
    expect(res.status).toBe('succeeded')
    ledger.close()
  })

  it('respects explicit failed outcomes with sideEffectState=none and upgrades possible to unknown', async () => {
    const ledger = new CompensationLedger({ path: ':memory:' })
    const registry = new CompensationRegistry()

    registry.register({
      kind: 'test.fail-clean',
      category: 'custom',
      compensate: () => ({ status: 'failed', resultCode: 'rejected-precheck', sideEffectState: 'none' }),
    })
    registry.register({
      kind: 'test.fail-possible',
      category: 'custom',
      compensate: () => ({ status: 'failed', resultCode: 'partial-write', sideEffectState: 'possible' }),
    })

    const executor = new CompensationExecutor(registry, ledger)
    const clean = await executor.executeCompensation({
      idempotencyKey: 'fail-clean-1',
      kind: 'test.fail-clean',
      target: { id: 1 },
    })
    expect(clean.status).toBe('failed')
    expect(clean.resultCode).toBe('rejected-precheck')

    const possible = await executor.executeCompensation({
      idempotencyKey: 'fail-possible-1',
      kind: 'test.fail-possible',
      target: { id: 2 },
    })
    expect(possible.status).toBe('unknown')
    expect(possible.resultCode).toBe('partial-write')
    ledger.close()
  })

  it.each([
    ['options.authorize', 'initial', 1],
    ['options.authorize', 'during-capture', 2],
    ['options.authorize', 'pre-dispatch', 3],
    ['options.authorize', 'post-dispatch', 4],
    ['handler.authorize', 'initial', 1],
    ['handler.authorize', 'during-capture', 2],
    ['handler.authorize', 'pre-dispatch', 3],
    ['handler.authorize', 'post-dispatch', 4],
  ] as const)(
    'deterministically times out stalled %s in %s phase without leaking timers',
    async (authSource, phase, stallOnCall) => {
      const ledger = new CompensationLedger({ path: ':memory:' })
      const registry = new CompensationRegistry()
      let markStalled!: () => void
      const stalledGate = new Promise<void>((resolve) => { markStalled = resolve })
      let authCalls = 0
      const authorizeFn = (): boolean | Promise<boolean> => {
        authCalls += 1
        if (authCalls === stallOnCall) {
          markStalled()
          return new Promise<boolean>(() => {})
        }
        return true
      }

      const compensateSpy = vi.fn(() => ({ status: 'succeeded' as const, resultCode: 'ok' }))
      registry.register({
        kind: `auth.timeout.${authSource}.${phase}`,
        category: 'revert',
        capturePreimage: () => ({ snap: phase }),
        ...(authSource === 'handler.authorize' ? { authorize: authorizeFn } : {}),
        compensate: compensateSpy,
      })

      vi.useFakeTimers()
      vi.setSystemTime(1_000_000)
      try {
        const executor = new CompensationExecutor(registry, ledger, { defaultTimeoutMs: 1_000 })
        const key = `timeout-${authSource}-${phase}`
        const pending = executor.executeCompensation(
          {
            idempotencyKey: key,
            kind: `auth.timeout.${authSource}.${phase}`,
            target: { phase },
          },
          {
            timeoutMs: 500,
            ...(authSource === 'options.authorize' ? { authorize: authorizeFn } : {}),
          },
        )

        if (phase === 'post-dispatch') {
          await stalledGate
          await vi.advanceTimersByTimeAsync(500)
          const res = await pending
          expect(res.status).toBe('unknown')
          expect(res.resultCode).toBe('authorization-ended-after-dispatch')
          expect(compensateSpy).toHaveBeenCalledTimes(1)
          expect(ledger.getByIdempotencyKey(key)).toMatchObject({
            status: 'unknown',
            resultCode: 'authorization-ended-after-dispatch',
          })
        } else {
          const rejection = expect(pending).rejects.toMatchObject({ code: 'expired' })
          await stalledGate
          await vi.advanceTimersByTimeAsync(500)
          await rejection
          expect(compensateSpy).not.toHaveBeenCalled()
          if (phase === 'pre-dispatch') {
            expect(ledger.getByIdempotencyKey(key)).toMatchObject({
              status: 'unknown',
              resultCode: 'authorization-ended-before-dispatch',
            })
          } else {
            expect(ledger.getByIdempotencyKey(key)).toBeUndefined()
          }
        }
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
      ledger.close()
    },
  )

  it.each([
    ['options.authorize', 'initial', 1],
    ['options.authorize', 'during-capture', 2],
    ['options.authorize', 'pre-dispatch', 3],
    ['options.authorize', 'post-dispatch', 4],
    ['handler.authorize', 'initial', 1],
    ['handler.authorize', 'during-capture', 2],
    ['handler.authorize', 'pre-dispatch', 3],
    ['handler.authorize', 'post-dispatch', 4],
  ] as const)(
    'unblocks stalled %s in %s phase when options.signal aborts',
    async (authSource, phase, stallOnCall) => {
      const ledger = new CompensationLedger({ path: ':memory:' })
      const registry = new CompensationRegistry()
      let markStalled!: () => void
      const stalledGate = new Promise<void>((resolve) => { markStalled = resolve })
      let authCalls = 0
      const authorizeFn = (): boolean | Promise<boolean> => {
        authCalls += 1
        if (authCalls === stallOnCall) {
          markStalled()
          return new Promise<boolean>(() => {})
        }
        return true
      }

      const compensateSpy = vi.fn(() => ({ status: 'succeeded' as const, resultCode: 'ok' }))
      registry.register({
        kind: `auth.abort.${authSource}.${phase}`,
        category: 'revert',
        capturePreimage: () => ({ snap: phase }),
        ...(authSource === 'handler.authorize' ? { authorize: authorizeFn } : {}),
        compensate: compensateSpy,
      })

      const controller = new AbortController()
      const executor = new CompensationExecutor(registry, ledger, { defaultTimeoutMs: 5_000 })
      const key = `abort-${authSource}-${phase}`
      const pending = executor.executeCompensation(
        {
          idempotencyKey: key,
          kind: `auth.abort.${authSource}.${phase}`,
          target: { phase },
        },
        {
          signal: controller.signal,
          ...(authSource === 'options.authorize' ? { authorize: authorizeFn } : {}),
        },
      )

      if (phase === 'post-dispatch') {
        await stalledGate
        controller.abort()
        const res = await pending
        expect(res.status).toBe('unknown')
        expect(res.resultCode).toBe('authorization-ended-after-dispatch')
        expect(compensateSpy).toHaveBeenCalledTimes(1)
      } else {
        const rejection = expect(pending).rejects.toMatchObject({ code: 'unauthorized' })
        await stalledGate
        controller.abort()
        await rejection
        expect(compensateSpy).not.toHaveBeenCalled()
        if (phase === 'pre-dispatch') {
          expect(ledger.getByIdempotencyKey(key)).toMatchObject({
            status: 'unknown',
            resultCode: 'authorization-ended-before-dispatch',
          })
        } else {
          expect(ledger.getByIdempotencyKey(key)).toBeUndefined()
        }
      }
      await executor.dispose()
      ledger.close()
    },
  )
})
