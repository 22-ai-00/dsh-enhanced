import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CredentialLedger } from '../src/ledger.ts'
import { CredentialsKeychainService } from '../src/service.ts'
import type { CredentialCommandRunner, CredentialCommandResult, CredentialHandle } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

async function harness(options: {
  allow?: boolean
  maxLeaseMs?: number
  provider?: 'environment' | 'macos-keychain'
  run?: CredentialCommandRunner
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'credentials-service-'))
  roots.push(root)
  let now = 1_000
  const ctx = new Context()
  new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), rules: options.allow === false ? [] : [
    { id: 'consumer-use', effect: 'allow', subject: { kind: 'background', id: 'dsh-enhanced-test-consumer' },
      actions: ['credential.use'], resource: { kind: 'credential', id: 'lark-secret' },
      context: { initiators: ['background'] } },
    { id: 'operator-revoke', effect: 'allow', subject: { kind: 'external', id: 'local:owner' },
      actions: ['credential.revoke'], resource: { kind: 'credential', id: '*' },
      context: { initiators: ['foreground'] } },
  ] })
  const handle: CredentialHandle = options.provider === 'macos-keychain'
    ? { id: 'lark-secret', provider: 'macos-keychain', service: 'dsh/lark', account: 'personal',
        consumers: ['dsh-enhanced-test-consumer'], purposes: ['connect'], maxLeaseMs: options.maxLeaseMs ?? 5_000 }
    : { id: 'lark-secret', provider: 'environment', environmentName: 'LARK_SECRET',
        consumers: ['dsh-enhanced-test-consumer'], purposes: ['connect'], maxLeaseMs: options.maxLeaseMs ?? 5_000 }
  const databasePath = join(root, 'credentials.sqlite')
  const service = new CredentialsKeychainService(ctx, {
    databasePath, defaultLeaseMs: 1_000,
    handles: [handle],
  }, { env: { LARK_SECRET: 'super-secret-value' }, now: () => now,
    run: options.run ?? vi.fn() as CredentialCommandRunner })
  return { ctx, service, databasePath, setNow(value: number) { now = value } }
}

function consumer(task: (ctx: Context) => Promise<void>) {
  return {
    name: 'dsh-enhanced-test-consumer',
    inject: ['credentialsKeychain'],
    async apply(ctx: Context) { await task(ctx) },
  }
}

function delayedProvider() {
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const result = new Promise<CredentialCommandResult>(resolve => {
    release = () => resolve({ code: 0, stdout: Buffer.from('super-secret-value'), stderr: Buffer.alloc(0) })
  })
  const run = vi.fn(async () => {
    started()
    return result
  }) as CredentialCommandRunner
  return { ready, release: () => release(), run }
}

describe('credentials-keychain Cordis service', () => {
  test('authorizes a derived consumer and bounds the secret to one callback', async () => {
    const f = await harness()
    let observed = ''
    await f.ctx.plugin(consumer(async caller => {
      const result = await caller.credentialsKeychain.withSecret(caller, {
        handleId: 'lark-secret', purpose: 'connect', ttlMs: 2_000, idempotencyKey: 'startup:1',
      }, async (value, signal) => {
        expect(signal.aborted).toBe(false)
        observed = value
        return 'connected'
      })
      expect(result).toBe('connected')
    }))
    expect(observed).toBe('super-secret-value')
    expect(f.service.health()).toEqual({ handles: 1, activeLeases: 0, failedLeases: 0 })
    expect(JSON.stringify(f.service.listLeases({ limit: 10 }))).not.toContain('super-secret')
    expect(JSON.stringify(f.service.listLeases({ limit: 10 }))).not.toContain('startup:1')
    expect(f.service.listLeases({ limit: 10 })[0]).toMatchObject({
      consumer: 'dsh-enhanced-test-consumer', purpose: 'connect', status: 'completed',
    })
    await f.ctx.fiber.restart()
  })

  test('fails closed before provider access for unlisted consumer, purpose or policy', async () => {
    const f = await harness({ allow: false })
    await expect(f.service.withSecret(f.ctx, {
      handleId: 'lark-secret', purpose: 'connect', idempotencyKey: 'root',
    }, async value => value)).rejects.toEqual(expect.objectContaining({ code: 'consumer-denied' }))
    const denied = consumer(async caller => {
      await expect(caller.credentialsKeychain.withSecret(caller, {
        handleId: 'lark-secret', purpose: 'wrong', idempotencyKey: 'wrong-purpose',
      }, async value => value)).rejects.toEqual(expect.objectContaining({ code: 'purpose-denied' }))
      await expect(caller.credentialsKeychain.withSecret(caller, {
        handleId: 'lark-secret', purpose: 'connect', idempotencyKey: 'policy-denied',
      }, async value => value)).rejects.toEqual(expect.objectContaining({ code: 'policy-denied' }))
    })
    await f.ctx.plugin(denied)
    expect(f.service.listLeases()).toEqual([])
    await f.ctx.fiber.restart()
  })

  test('aborts an active callback on TTL and records expiry', async () => {
    vi.useFakeTimers()
    const f = await harness({ maxLeaseMs: 1_000 })
    let abortReason: unknown
    const running = f.ctx.plugin(consumer(async caller => {
      await caller.credentialsKeychain.withSecret(caller, {
        handleId: 'lark-secret', purpose: 'connect', ttlMs: 1_000, idempotencyKey: 'expires',
      }, async (_value, signal) => new Promise<void>(resolve => signal.addEventListener('abort', () => {
        abortReason = signal.reason
        resolve()
      }, { once: true })))
    }))
    await vi.advanceTimersByTimeAsync(1_001)
    f.setNow(2_001)
    await running
    expect(f.service.listLeases()[0]).toMatchObject({ status: 'expired', failureCode: 'lease-expired' })
    expect(abortReason).toMatchObject({ name: 'CredentialLeaseAbortError', code: 'expired' })
    vi.useRealTimers()
    await f.ctx.fiber.restart()
  })

  test('operator revocation aborts the exact active lease and is policy gated', async () => {
    const f = await harness()
    let leaseId = ''
    let abortReason: unknown
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const running = f.ctx.plugin(consumer(async caller => {
      await caller.credentialsKeychain.withSecret(caller, {
        handleId: 'lark-secret', purpose: 'connect', ttlMs: 5_000, idempotencyKey: 'revoke',
      }, async (_value, signal, lease) => {
        leaseId = lease.id
        started()
        await new Promise<void>(resolve => signal.addEventListener('abort', () => {
          abortReason = signal.reason
          resolve()
        }, { once: true }))
      })
    }))
    await ready
    const current = f.service.listLeases()[0]!
    expect(f.service.revoke({ operatorId: 'owner', leaseId, expectedVersion: current.version, reason: 'rotate' }))
      .toMatchObject({ status: 'revoked' })
    await running
    expect(f.service.listLeases()[0]).toMatchObject({ status: 'revoked' })
    expect(abortReason).toMatchObject({ name: 'CredentialLeaseAbortError', code: 'revoked' })
    expect(() => f.service.revoke({ operatorId: 'attacker', leaseId, expectedVersion: 2, reason: 'no' }))
      .toThrowError(expect.objectContaining({ code: 'policy-denied' }))
    await f.ctx.fiber.restart()
  })

  test('does not deliver a provider result after its lease is revoked', async () => {
    const provider = delayedProvider()
    const f = await harness({ provider: 'macos-keychain', run: provider.run })
    const callback = vi.fn(async () => 'used')
    const running = f.ctx.plugin(consumer(async caller => {
      await caller.credentialsKeychain.withSecret(caller, {
        handleId: 'lark-secret', purpose: 'connect', ttlMs: 5_000, idempotencyKey: 'revoke-while-reading',
      }, callback)
    }))
    await provider.ready
    const lease = f.service.listLeases()[0]!
    f.service.revoke({ operatorId: 'owner', leaseId: lease.id, expectedVersion: lease.version, reason: 'rotate' })
    provider.release()
    await expect(running).rejects.toEqual(expect.objectContaining({ code: 'revoked' }))
    expect(callback).not.toHaveBeenCalled()
    expect(f.service.listLeases()[0]).toMatchObject({ status: 'revoked', failureCode: 'operator-revoked' })
    await f.ctx.fiber.restart()
  })

  test('expires by the ledger clock before delivering a provider result when its timer is late', async () => {
    const provider = delayedProvider()
    const f = await harness({ provider: 'macos-keychain', maxLeaseMs: 1_000, run: provider.run })
    const callback = vi.fn(async () => 'used')
    const running = f.ctx.plugin(consumer(async caller => {
      await caller.credentialsKeychain.withSecret(caller, {
        handleId: 'lark-secret', purpose: 'connect', ttlMs: 1_000, idempotencyKey: 'expire-while-reading',
      }, callback)
    }))
    await provider.ready
    f.setNow(2_000)
    provider.release()
    await expect(running).rejects.toEqual(expect.objectContaining({ code: 'expired' }))
    expect(callback).not.toHaveBeenCalled()
    expect(f.service.listLeases()[0]).toMatchObject({ status: 'expired', failureCode: 'lease-expired' })
    await f.ctx.fiber.restart()
  })

  test('does not expire another active lease when one delayed provider reaches its deadline', async () => {
    const expiredProvider = delayedProvider()
    const activeProvider = delayedProvider()
    let reads = 0
    const run = vi.fn((input) => (reads++ === 0 ? expiredProvider.run(input) : activeProvider.run(input))) as CredentialCommandRunner
    const f = await harness({ provider: 'macos-keychain', maxLeaseMs: 5_000, run })
    const expiredCallback = vi.fn(async () => 'expired')
    const activeCallback = vi.fn(async () => 'active')
    let expiredCode = ''
    let expiredSettled!: () => void
    const expiredDone = new Promise<void>(resolve => { expiredSettled = resolve })
    const running = f.ctx.plugin(consumer(async caller => {
      const expired = caller.credentialsKeychain.withSecret(caller, {
        handleId: 'lark-secret', purpose: 'connect', ttlMs: 1_000, idempotencyKey: 'expire-only-this-lease',
      }, expiredCallback).then(
        () => { expiredCode = 'resolved'; expiredSettled() },
        error => { expiredCode = error instanceof Error && 'code' in error ? String(error.code) : 'unknown'; expiredSettled() },
      )
      const active = caller.credentialsKeychain.withSecret(caller, {
        handleId: 'lark-secret', purpose: 'connect', ttlMs: 5_000, idempotencyKey: 'remain-active',
      }, activeCallback)
      await Promise.all([expired, active])
    }))
    await expiredProvider.ready
    await activeProvider.ready
    f.setNow(2_000)
    expiredProvider.release()
    await expiredDone
    expect(expiredCode).toBe('expired')
    expect(expiredCallback).not.toHaveBeenCalled()
    expect(f.service.listLeases({ status: 'active' })).toHaveLength(1)
    activeProvider.release()
    await running
    expect(activeCallback).toHaveBeenCalledOnce()
    await f.ctx.fiber.restart()
  })

  test('does not deliver a provider result while the service is disposing', async () => {
    const provider = delayedProvider()
    const f = await harness({ provider: 'macos-keychain', run: provider.run })
    const callback = vi.fn(async () => 'used')
    const running = f.ctx.plugin(consumer(async caller => {
      await caller.credentialsKeychain.withSecret(caller, {
        handleId: 'lark-secret', purpose: 'connect', ttlMs: 5_000, idempotencyKey: 'dispose-while-reading',
      }, callback)
    }))
    await provider.ready
    const disposing = f.ctx.fiber.dispose()
    provider.release()
    await expect(running).rejects.toEqual(expect.objectContaining({ code: 'disposed' }))
    await disposing
    expect(callback).not.toHaveBeenCalled()
    const ledger = new CredentialLedger({ path: f.databasePath })
    expect(ledger.list()[0]).toMatchObject({ status: 'failed', failureCode: 'service-disposed' })
    ledger.close()
  })

  test('makes idempotency replay and provider failure explicit without re-running a callback', async () => {
    const f = await harness()
    const callback = vi.fn(async (value: string) => value.length)
    await f.ctx.plugin(consumer(async caller => {
      await caller.credentialsKeychain.withSecret(caller, {
        handleId: 'lark-secret', purpose: 'connect', idempotencyKey: 'once',
      }, callback)
      await expect(caller.credentialsKeychain.withSecret(caller, {
        handleId: 'lark-secret', purpose: 'connect', idempotencyKey: 'once',
      }, callback)).rejects.toEqual(expect.objectContaining({ code: 'lease-replayed' }))
    }))
    expect(callback).toHaveBeenCalledOnce()
    await f.ctx.fiber.restart()
  })
})
