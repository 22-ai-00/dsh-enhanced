import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test } from 'vitest'
import { MemoryProposalManager } from '../src/proposals.ts'
import { MemoryStore } from '../src/store.ts'
import type { MemoryEntryInput, MemoryIdentity } from '../src/types.ts'

const temporaryRoots: string[] = []
const identity: MemoryIdentity = { owner: 'user', scope: 'user-global' }

async function harness(now: () => number = () => 100_000) {
  const root = await mkdtemp(join(tmpdir(), 'personal-memory-proposals-'))
  temporaryRoots.push(root)
  const memoryPath = join(root, 'memory.sqlite')
  const policyPath = join(root, 'policy.sqlite')
  const memory = new MemoryStore({ path: memoryPath, now })
  const ctx = new Context()
  const policy = new AssistantPolicyService(ctx, { databasePath: policyPath, rules: [] }, { now })
  return {
    manager: new MemoryProposalManager(memory, policy),
    memory,
    memoryPath,
    policy,
    policyPath,
    ctx,
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function entry(content: string, overrides: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
  return {
    kind: 'fact',
    content,
    sensitivity: 'private',
    trust: 'user-confirmed',
    confidence: 1,
    provenance: { source: 'user', observedAt: 10_000 },
    ...overrides,
  }
}

function proposalInput(content = 'Remember this stable fact') {
  return {
    idempotencyKey: 'proposal:add:stable-fact',
    requester: 'agent:primary',
    principal: 'owner:lark:123',
    ttlMs: 60_000,
    mutation: { op: 'add' as const, identity, entry: entry(content) },
  }
}

describe('approval-gated memory proposals', () => {
  test('creates an exact durable proposal and replays it idempotently', async () => {
    const { manager, memory, ctx } = await harness()

    const created = manager.propose(proposalInput())
    const replay = manager.propose(proposalInput())

    expect(created).toMatchObject({
      status: 'pending',
      version: 1,
      expiresAt: 160_000,
      replayed: false,
      mutation: proposalInput().mutation,
    })
    expect(created.diff).toContain('Remember this stable fact')
    expect(replay).toEqual({ ...created, replayed: true })
    expect(memory.list(identity)).toEqual([])
    memory.close()
    await ctx.fiber.restart()
  })

  test('binds the decision to the principal and commits an approved add only once', async () => {
    const { manager, memory, ctx } = await harness()
    const proposal = manager.propose(proposalInput())

    expect(() => manager.decide({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:attacker',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'malicious click',
    })).toThrowError(expect.objectContaining({ code: 'unauthorized' }))

    const approved = manager.decide({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner confirmed',
    })
    const replay = manager.decide({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner confirmed',
    })

    expect(approved).toMatchObject({ status: 'approved', version: 2, replayed: false })
    expect(approved.record?.content).toBe('Remember this stable fact')
    expect(replay).toEqual({ ...approved, replayed: true })
    expect(memory.list(identity)).toHaveLength(1)
    expect(manager.propose(proposalInput())).toMatchObject({ status: 'approved', version: 2, replayed: true })
    memory.close()
    await ctx.fiber.restart()
  })

  test('supports approved replace and remove with target-version CAS', async () => {
    const { manager, memory, ctx } = await harness()
    const original = memory.applyApprovedMutation({
      op: 'add', idempotencyKey: 'fixture:add', identity, entry: entry('Vim'),
    })
    const replacement = manager.propose({
      ...proposalInput(),
      idempotencyKey: 'proposal:replace',
      mutation: {
        op: 'replace' as const,
        identity,
        id: original.id,
        expectedVersion: original.version,
        entry: entry('Helix', { supersedes: original.contentHash }),
      },
    })
    const replaced = manager.decide({
      proposalId: replacement.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'update editor',
    })
    const removal = manager.propose({
      ...proposalInput(),
      idempotencyKey: 'proposal:remove',
      mutation: {
        op: 'remove' as const,
        identity,
        id: original.id,
        expectedVersion: replaced.record!.version,
      },
    })
    const removed = manager.decide({
      proposalId: removal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'forget it',
    })

    expect(replaced.record).toMatchObject({ content: 'Helix', version: 2 })
    expect(removed.record).toMatchObject({ status: 'removed', version: 3 })
    expect(memory.get(identity, original.id)).toBeUndefined()
    memory.close()
    await ctx.fiber.restart()
  })

  test('never mutates memory for a rejected or expired proposal', async () => {
    let now = 100_000
    const { manager, memory, ctx } = await harness(() => now)
    const rejectedProposal = manager.propose(proposalInput('rejected content'))
    const rejected = manager.decide({
      proposalId: rejectedProposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'rejected',
      reason: 'not durable',
    })
    const expiredProposal = manager.propose({
      ...proposalInput('expired content'),
      idempotencyKey: 'proposal:expired',
      ttlMs: 1_000,
    })
    now = 101_000
    const expired = manager.decide({
      proposalId: expiredProposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'too late',
    })

    expect(rejected.status).toBe('rejected')
    expect(expired.status).toBe('expired')
    expect(memory.list(identity)).toEqual([])
    memory.close()
    await ctx.fiber.restart()
  })

  test('marks an approved proposal conflicted when its target changed after review', async () => {
    const { manager, memory, ctx } = await harness()
    const original = memory.applyApprovedMutation({
      op: 'add', idempotencyKey: 'fixture:add', identity, entry: entry('old value'),
    })
    const proposal = manager.propose({
      ...proposalInput(),
      idempotencyKey: 'proposal:stale-replace',
      mutation: {
        op: 'replace' as const,
        identity,
        id: original.id,
        expectedVersion: original.version,
        entry: entry('reviewed value'),
      },
    })
    memory.applyApprovedMutation({
      op: 'replace',
      idempotencyKey: 'fixture:concurrent-replace',
      identity,
      id: original.id,
      expectedVersion: original.version,
      entry: entry('concurrent value'),
    })

    const result = manager.decide({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner confirmed old diff',
    })

    expect(result).toMatchObject({ status: 'conflicted', version: 2 })
    expect(result.record).toBeUndefined()
    expect(memory.get(identity, original.id)?.content).toBe('concurrent value')
    memory.close()
    await ctx.fiber.restart()
  })

  test('recovers when policy approval committed before the local memory transaction', async () => {
    const first = await harness()
    const proposal = first.manager.propose(proposalInput('recover after restart'))
    const local = first.memory.getProposal(proposal.proposalId)!
    first.policy.decideProposal({
      proposalId: local.policyProposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner confirmed',
    })
    first.memory.close()
    await first.ctx.fiber.restart()

    const memory = new MemoryStore({ path: first.memoryPath, now: () => 100_000 })
    const ctx = new Context()
    const policy = new AssistantPolicyService(ctx, { databasePath: first.policyPath, rules: [] }, { now: () => 100_000 })
    const manager = new MemoryProposalManager(memory, policy)
    const recovered = manager.decide({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner confirmed',
    })

    expect(recovered).toMatchObject({ status: 'approved', version: 2, replayed: true })
    expect(memory.list(identity).map(record => record.content)).toEqual(['recover after restart'])
    memory.close()
    await ctx.fiber.restart()
  })

  test('rejects idempotency-key reuse with changed content before policy mutation', async () => {
    const { manager, memory, ctx } = await harness()
    manager.propose(proposalInput('first content'))

    expect(() => manager.propose(proposalInput('changed content')))
      .toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    expect(memory.list(identity)).toEqual([])
    memory.close()
    await ctx.fiber.restart()
  })
})
