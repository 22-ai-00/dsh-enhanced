import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { CredentialLedger } from '../src/ledger.ts'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'credential-ledger-'))
  roots.push(root)
  let now = 1_000
  const path = join(root, 'credentials.sqlite')
  const ledger = new CredentialLedger({ path, now: () => now })
  return { ledger, path, setNow(value: number) { now = value } }
}

describe('credential lease ledger', () => {
  test('creates an idempotent secret-free lease and survives restart', async () => {
    const f = await fixture()
    const input = { handleId: 'lark-secret', consumer: 'dsh-enhanced-lark-channel', purpose: 'connect',
      idempotencyKey: 'lark:startup:1', ttlMs: 5_000 }
    const first = f.ledger.begin(input)
    expect(first).toMatchObject({ replayed: false, record: { status: 'active', expiresAt: 6_000, version: 1 } })
    expect(f.ledger.begin(input)).toEqual({ replayed: true, record: first.record })
    expect(() => f.ledger.begin({ ...input, purpose: 'exfiltrate' })).toThrowError(
      expect.objectContaining({ code: 'idempotency-conflict' }),
    )
    f.ledger.close()
    const reopened = new CredentialLedger({ path: f.path, now: () => 2_000 })
    expect(reopened.get(first.record.id)).toEqual(first.record)
    reopened.close()
    const bytes = await readFile(f.path, 'utf8')
    expect(bytes).not.toContain('super-secret-value')
    expect(bytes).not.toContain('dsh/lark/keychain-locator')
  })

  test('settles with CAS, expires stale leases and makes revocation idempotent', async () => {
    const f = await fixture()
    const first = f.ledger.begin({ handleId: 'one', consumer: 'plugin', purpose: 'connect',
      idempotencyKey: 'one', ttlMs: 100 }).record
    expect(f.ledger.settle({ leaseId: first.id, expectedVersion: 1, status: 'completed' }))
      .toMatchObject({ status: 'completed', version: 2, settledAt: 1_000 })
    expect(() => f.ledger.settle({ leaseId: first.id, expectedVersion: 1, status: 'failed' }))
      .toThrowError(expect.objectContaining({ code: 'version-conflict' }))

    const expiring = f.ledger.begin({ handleId: 'two', consumer: 'plugin', purpose: 'connect',
      idempotencyKey: 'two', ttlMs: 100 }).record
    f.setNow(1_101)
    expect(f.ledger.expire()).toBe(1)
    expect(f.ledger.get(expiring.id)).toMatchObject({ status: 'expired', version: 2 })

    const revoking = f.ledger.begin({ handleId: 'three', consumer: 'plugin', purpose: 'connect',
      idempotencyKey: 'three', ttlMs: 1_000 }).record
    const revoked = f.ledger.revoke({ leaseId: revoking.id, expectedVersion: 1, actor: 'local:owner', reason: 'rotate' })
    expect(revoked).toMatchObject({ status: 'revoked', failureCode: 'operator-revoked', version: 2 })
    expect(f.ledger.revoke({ leaseId: revoking.id, expectedVersion: 2, actor: 'local:owner', reason: 'again' }))
      .toEqual(revoked)
    f.ledger.close()
  })

  test('records bounded metadata-only audit events', async () => {
    const f = await fixture()
    const lease = f.ledger.begin({ handleId: 'secret-id', consumer: 'plugin', purpose: 'connect',
      idempotencyKey: 'audit', ttlMs: 1_000 }).record
    f.ledger.settle({ leaseId: lease.id, expectedVersion: 1, status: 'failed', failureCode: 'not-found' })
    expect(f.ledger.listAudit({ limit: 10 })).toEqual([
      expect.objectContaining({ action: 'lease.failed', handleId: 'secret-id', consumer: 'plugin', outcome: 'failed' }),
      expect.objectContaining({ action: 'lease.begin', handleId: 'secret-id', consumer: 'plugin', outcome: 'active' }),
    ])
    expect(JSON.stringify(f.ledger.listAudit({ limit: 10 }))).not.toContain('value')
    f.ledger.close()
  })
})
