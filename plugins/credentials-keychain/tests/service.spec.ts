import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CredentialsKeychainService } from '../src/service.ts'
import type { CredentialCommandRunner } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

async function harness(options: { allow?: boolean; maxLeaseMs?: number } = {}) {
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
  const service = new CredentialsKeychainService(ctx, {
    databasePath: join(root, 'credentials.sqlite'), defaultLeaseMs: 1_000,
    handles: [{ id: 'lark-secret', provider: 'environment', environmentName: 'LARK_SECRET',
      consumers: ['dsh-enhanced-test-consumer'], purposes: ['connect'], maxLeaseMs: options.maxLeaseMs ?? 5_000 }],
  }, { env: { LARK_SECRET: 'super-secret-value' }, now: () => now,
    run: vi.fn() as CredentialCommandRunner })
  return { ctx, service, setNow(value: number) { now = value } }
}

function consumer(task: (ctx: Context) => Promise<void>) {
  return {
    name: 'dsh-enhanced-test-consumer',
    inject: ['credentialsKeychain'],
    async apply(ctx: Context) { await task(ctx) },
  }
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
