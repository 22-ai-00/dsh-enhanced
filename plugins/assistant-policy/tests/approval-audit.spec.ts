import { createHash } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { PolicyLedger, PolicyLedgerError } from '../src/ledger.ts'

const temporaryRoots: string[] = []

async function createLedger(now: () => number = () => 100_000) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-approval-'))
  temporaryRoots.push(root)
  const path = join(root, 'policy.sqlite')
  return { ledger: new PolicyLedger({ path, now }), path }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('approval proposals', () => {
  test('stores a complete diff hash and replays the same proposal idempotently', async () => {
    const { ledger } = await createLedger()
    const input = {
      idempotencyKey: 'memory:proposal:42',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      action: 'memory.replace',
      resource: { kind: 'memory', id: 'preference:editor' },
      diff: '- vim\n+ helix\n',
      summary: 'Update the preferred editor',
      ttlMs: 60_000,
    }

    const created = ledger.propose(input)
    const replay = ledger.propose(input)

    expect(created).toMatchObject({
      status: 'pending',
      version: 1,
      expiresAt: 160_000,
      replayed: false,
      diffHash: createHash('sha256').update(input.diff).digest('hex'),
    })
    expect(replay).toEqual({ ...created, replayed: true })
    ledger.close()
  })

  test('rejects reuse of an idempotency key for different content', async () => {
    const { ledger } = await createLedger()
    const base = {
      idempotencyKey: 'proposal-key',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      action: 'wiki.upsert',
      resource: { kind: 'wiki', id: 'page:alpha' },
      diff: '+ original',
      summary: 'Write page',
      ttlMs: 60_000,
    }
    ledger.propose(base)

    expect(() => ledger.propose({ ...base, diff: '+ changed' }))
      .toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'idempotency-conflict' }))
    expect(() => ledger.propose({ ...base, ttlMs: 120_000 }))
      .toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'idempotency-conflict' }))
    ledger.close()
  })

  test('requires the bound principal and expected version to decide', async () => {
    const { ledger } = await createLedger()
    const proposal = ledger.propose({
      idempotencyKey: 'proposal-auth',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      action: 'automation.create',
      resource: { kind: 'automation', id: 'daily-review' },
      diff: '+ every day at 09:00',
      summary: 'Create daily review',
      ttlMs: 60_000,
    })

    expect(() => ledger.decideProposal({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:attacker',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'looks fine',
    })).toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'unauthorized' }))
    expect(() => ledger.decideProposal({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 2,
      decision: 'approved',
      reason: 'looks fine',
    })).toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'version-conflict' }))

    const decided = ledger.decideProposal({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'looks fine',
    })
    expect(decided).toMatchObject({ status: 'approved', version: 2, replayed: false })
    expect(ledger.decideProposal({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 2,
      decision: 'approved',
      reason: 'looks fine',
    })).toEqual({ ...decided, replayed: true })
    expect(ledger.decideProposal({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'looks fine',
    })).toEqual({ ...decided, replayed: true })
    ledger.close()
  })

  test('expires a proposal before a late decision can authorize work', async () => {
    let now = 100_000
    const { ledger } = await createLedger(() => now)
    const proposal = ledger.propose({
      idempotencyKey: 'proposal-expiry',
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      action: 'credential.use',
      resource: { kind: 'credential', id: 'github-token' },
      diff: '+ lease credential',
      summary: 'Use GitHub credential',
      ttlMs: 1_000,
    })
    now = 101_000

    const expired = ledger.decideProposal({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'late click',
    })

    expect(expired).toMatchObject({ status: 'expired', version: 2 })
    ledger.close()
  })

  test('expires pending proposals in bounded maintenance batches', async () => {
    let now = 100_000
    const { ledger } = await createLedger(() => now)
    const input = {
      requester: 'agent:primary',
      principal: 'owner:lark:123',
      action: 'memory.add',
      resource: { kind: 'memory', id: 'fact' },
      diff: '+ fact',
      summary: 'Remember fact',
      ttlMs: 1_000,
    }
    const first = ledger.propose({ ...input, idempotencyKey: 'expiry-1' })
    ledger.propose({ ...input, idempotencyKey: 'expiry-2' })
    now = 101_000

    expect(ledger.expireProposals(1)).toBe(1)
    expect(ledger.expireProposals(10)).toBe(1)
    expect(() => ledger.expireProposals(0))
      .toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-input' }))
    expect(() => ledger.decideProposal({
      proposalId: first.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 2,
      decision: 'approved',
      reason: 'too late',
    })).toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-state' }))
    ledger.close()
  })
})

describe('sanitized audit', () => {
  test('redacts secret-bearing fields and hashes resource identity', async () => {
    const { ledger, path } = await createLedger()
    ledger.appendAudit({
      actor: 'agent:primary',
      action: 'credential.use',
      resource: { kind: 'credential', id: 'production/github/token' },
      outcome: 'denied',
      reasonCode: 'rule-deny',
      details: {
        command: 'curl -H "Authorization: Bearer ghp_supersecret" https://api.github.com',
        apiKey: 'sk-sensitive-value',
        nested: { password: 'hunter2', safe: 'retained' },
      },
    })

    const [event] = ledger.queryAudit({ limit: 10 })
    expect(event).toMatchObject({
      sequence: 1,
      actor: 'agent:primary',
      action: 'credential.use',
      resourceKind: 'credential',
      resourceHash: createHash('sha256').update('production/github/token').digest('hex'),
      outcome: 'denied',
      reasonCode: 'rule-deny',
      details: {
        command: '[REDACTED]',
        apiKey: '[REDACTED]',
        nested: { password: '[REDACTED]', safe: 'retained' },
      },
    })
    ledger.close()

    const databaseBytes = await readFile(path)
    expect(databaseBytes.includes(Buffer.from('ghp_supersecret'))).toBe(false)
    expect(databaseBytes.includes(Buffer.from('sk-sensitive-value'))).toBe(false)
    expect(databaseBytes.includes(Buffer.from('hunter2'))).toBe(false)
    expect(databaseBytes.includes(Buffer.from('production/github/token'))).toBe(false)
  })

  test('bounds audit queries and pages after a sequence', async () => {
    const { ledger } = await createLedger()
    for (let index = 0; index < 3; index += 1) {
      ledger.appendAudit({
        actor: 'system',
        action: `test.${index}`,
        resource: { kind: 'tool', id: `tool-${index}` },
        outcome: 'allowed',
        reasonCode: 'rule-allow',
        details: { index },
      })
    }

    expect(ledger.queryAudit({ afterSequence: 1, limit: 1 }).map(event => event.sequence)).toEqual([2])
    expect(() => ledger.queryAudit({ limit: 101 }))
      .toThrowError(expect.objectContaining<Partial<PolicyLedgerError>>({ code: 'invalid-input' }))
    ledger.close()
  })
})
