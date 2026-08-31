import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  AssistantPolicyService,
  type ApprovalProposalRecoveryInput,
  type ApprovalProposalSnapshot,
} from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test } from 'vitest'
import { MemoryProposalManager } from '../src/proposals.ts'
import { hashMemoryMutation, memoryPrincipalDigest, MemoryStore } from '../src/store.ts'
import type { MemoryEntryInput, MemoryIdentity, MemoryOwnerNamespace } from '../src/types.ts'

const temporaryRoots: string[] = []
const identity: MemoryIdentity = { owner: 'user', scope: 'user-global' }
const namespace: MemoryOwnerNamespace = Object.freeze({
  mode: 'headless',
  principalDigest: memoryPrincipalDigest('owner:lark:123'),
  lineageId: 'proposal-tests',
  lineageVersion: 1,
})
const routeV2 = {
  routeVersion: 2 as const,
  bindingVersion: 1,
  bindingGeneration: 1,
  principalRecordId: 'principal-row-proposals',
  principalVersion: 1,
}

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
    namespace,
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
    expect(memory.list(namespace, identity)).toEqual([])
    memory.close()
    await ctx.fiber.restart()
  })

  test('atomically recovers or creates a fresh proposal under the local absolute deadline', async () => {
    const fixture = await harness()
    const calls: string[] = []
    let recoveryInput: ApprovalProposalRecoveryInput | undefined
    const manager = new MemoryProposalManager(fixture.memory, {
      recoverOrCreateProposal(input) {
        calls.push('recover-or-create')
        recoveryInput = input
        return fixture.policy.recoverOrCreateProposal(input)
      },
      propose(input) {
        calls.push('propose')
        return fixture.policy.propose(input)
      },
      decideProposal: input => fixture.policy.decideProposal(input),
      getProposal: proposalId => fixture.policy.getProposal(proposalId),
    })

    expect(manager.propose({
      ...proposalInput('atomic recover before create'),
      idempotencyKey: 'proposal:atomic-recover-before-create',
    })).toMatchObject({ status: 'pending', version: 1 })
    expect(calls).toEqual(['recover-or-create'])
    expect(recoveryInput).toEqual(expect.objectContaining({ notAfter: 160_000 }))
    fixture.memory.close()
    await fixture.ctx.fiber.restart()
  })

  test('binds and exactly replays the durable delivery dispatch route', async () => {
    const { manager, memory, policy, ctx } = await harness()
    const dispatch = {
      ...routeV2,
      sourceId: 'dsh-enhanced-personal-memory',
      bindingId: 'binding-owner-dm',
      workspace: '/work/alpha',
      principal: 'owner:lark:123',
    }

    const created = manager.propose({ ...proposalInput(), dispatch })
    const replay = manager.propose({ ...proposalInput(), dispatch })

    expect(replay).toEqual({ ...created, replayed: true })
    expect(policy.listPendingApprovalDispatches()).toEqual([
      expect.objectContaining({
        proposalId: created.policyProposalId,
        ...dispatch,
        requester: 'agent:primary',
        action: 'memory.add',
        resource: { kind: 'memory', id: created.proposalId },
        summary: created.summary,
        diff: created.diff,
        proposalVersion: 1,
        state: 'pending',
      }),
    ])
    expect(() => manager.propose({
      ...proposalInput(),
      dispatch: { ...dispatch, bindingId: 'different-binding' },
    })).toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    expect(() => manager.propose({
      ...proposalInput(),
      ttlMs: proposalInput().ttlMs + 1,
      dispatch,
    })).toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    memory.close()
    await ctx.fiber.restart()
  })

  test('never recreates Policy or dispatch when an attached local proposal loses its Policy row', async () => {
    const fixture = await harness()
    const input = {
      ...proposalInput('attached proposal must stay read-only'),
      idempotencyKey: 'proposal:attached-policy-missing',
      dispatch: {
        ...routeV2,
        sourceId: 'dsh-enhanced-personal-memory',
        bindingId: 'binding-owner-dm',
        workspace: '/work/alpha',
        principal: 'owner:lark:123',
      },
    }
    const attached = fixture.manager.propose(input)
    const emptyPolicyPath = join(temporaryRoots.at(-1)!, 'empty-policy.sqlite')
    const emptyCtx = new Context()
    const emptyPolicy = new AssistantPolicyService(
      emptyCtx,
      { databasePath: emptyPolicyPath, rules: [] },
      { now: () => 100_000 },
    )
    let createCalls = 0
    let readCalls = 0
    const replayManager = new MemoryProposalManager(fixture.memory, {
      recoverOrCreateProposal() {
        createCalls += 1
        throw new Error('attached recovery must not create')
      },
      propose() {
        createCalls += 1
        throw new Error('attached recovery must not propose')
      },
      decideProposal: decision => emptyPolicy.decideProposal(decision),
      getProposal(proposalId) {
        readCalls += 1
        return emptyPolicy.getProposal(proposalId)
      },
    })

    expect(replayManager.propose(input)).toMatchObject({
      proposalId: attached.proposalId,
      status: 'conflicted',
      version: 2,
    })
    expect(createCalls).toBe(0)
    expect(readCalls).toBe(1)
    expect(emptyPolicy.listPendingApprovalDispatches()).toEqual([])
    expect(emptyPolicy.getProposal(attached.policyProposalId)).toBeUndefined()
    expect(fixture.memory.list(namespace, identity)).toEqual([])
    fixture.memory.close()
    await fixture.ctx.fiber.restart()
    await emptyCtx.fiber.restart()
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
    expect(memory.list(namespace, identity)).toHaveLength(1)
    expect(manager.propose(proposalInput())).toMatchObject({ status: 'approved', version: 2, replayed: true })
    memory.close()
    await ctx.fiber.restart()
  })

  test('supports approved replace and remove with target-version CAS', async () => {
    const { manager, memory, ctx } = await harness()
    const original = memory.applyApprovedMutation({
      op: 'add', idempotencyKey: 'fixture:add', namespace, identity, entry: entry('Vim'),
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
    expect(memory.get(namespace, identity, original.id)).toBeUndefined()
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
    expect(memory.list(namespace, identity)).toEqual([])
    memory.close()
    await ctx.fiber.restart()
  })

  test('marks an approved proposal conflicted when its target changed after review', async () => {
    const { manager, memory, ctx } = await harness()
    const original = memory.applyApprovedMutation({
      op: 'add', idempotencyKey: 'fixture:add', namespace, identity, entry: entry('old value'),
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
      namespace,
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
    expect(memory.get(namespace, identity, original.id)?.content).toBe('concurrent value')
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
    expect(memory.list(namespace, identity).map(record => record.content)).toEqual(['recover after restart'])
    memory.close()
    await ctx.fiber.restart()
  })

  test('recovers exactly once after restart if Policy and dispatch commit before the local proposal row', async () => {
    let now = 100_000
    const fixture = await harness(() => now)
    const input = {
      ...proposalInput('recover cross-database proposal gap'),
      idempotencyKey: 'proposal:cross-database-gap',
      dispatch: {
        ...routeV2,
        sourceId: 'dsh-enhanced-personal-memory',
        bindingId: 'binding-owner-dm',
        workspace: '/work/alpha',
        principal: 'owner:lark:123',
      },
    }
    const saveProposal = fixture.memory.saveProposal.bind(fixture.memory)
    fixture.memory.saveProposal = (() => {
      throw new Error('simulated crash after Policy commit')
    }) as typeof fixture.memory.saveProposal

    expect(() => fixture.manager.propose(input)).toThrow(/simulated crash/i)
    const dispatch = fixture.policy.listPendingApprovalDispatches()[0]!
    fixture.policy.decideProposal({
      proposalId: dispatch.proposalId,
      principal: input.principal,
      expectedVersion: dispatch.proposalVersion,
      decision: 'approved',
      reason: 'owner approved before domain restart',
    })
    now += input.ttlMs + 1
    fixture.memory.saveProposal = saveProposal
    fixture.memory.close()
    await fixture.ctx.fiber.restart()

    const memory = new MemoryStore({ path: fixture.memoryPath, now: () => now })
    const ctx = new Context()
    const policy = new AssistantPolicyService(
      ctx,
      { databasePath: fixture.policyPath, rules: [] },
      { now: () => now },
    )
    let recoveryCount = 0
    let proposeCount = 0
    const manager = new MemoryProposalManager(memory, {
      recoverOrCreateProposal(input) {
        recoveryCount += 1
        return policy.recoverOrCreateProposal(input)
      },
      propose(input) {
        proposeCount += 1
        return policy.propose(input)
      },
      decideProposal: input => policy.decideProposal(input),
      getProposal: proposalId => policy.getProposal(proposalId),
    })

    expect(manager.reconcile(50)).toEqual([
      expect.objectContaining({ status: 'approved', version: 2 }),
    ])
    expect(manager.reconcile(50)).toEqual([])
    expect(recoveryCount).toBe(1)
    expect(proposeCount).toBe(0)
    expect(memory.list(namespace, identity).map(record => record.content))
      .toEqual(['recover cross-database proposal gap'])
    memory.close()
    await ctx.fiber.restart()
  })

  test('rejects a legacy ownerless intent hash instead of attaching it to a namespaced proposal', async () => {
    let now = 100_000
    const fixture = await harness(() => now)
    const input = {
      ...proposalInput('recover a legacy crash-gap intent'),
      idempotencyKey: 'proposal:legacy-cross-database-gap',
    }
    const mutation = fixture.memory.normalizeMutation(input.mutation, { namespace })
    const proposalId = `memory-${createHash('sha256')
      .update(input.idempotencyKey)
      .digest('hex')
      .slice(0, 32)}`
    const legacyHash = hashMemoryMutation(mutation)
    expect(() => fixture.memory.prepareProposalIntent({
      ...input, notAfter: 160_000, mutation, proposalId, mutationHash: legacyHash,
    })).toThrowError(expect.objectContaining({ code: 'invalid-entry' }))
    expect(fixture.memory.listProposalIntents(10)).toEqual([])
    fixture.memory.close()
    await fixture.ctx.fiber.restart()
  })

  test('durably conflicts an expired local intent when Policy atomically abandons it', async () => {
    let now = 100_000
    const fixture = await harness(() => now)
    const unavailable = new MemoryProposalManager(fixture.memory, {
      recoverOrCreateProposal() { throw new Error('Policy unavailable before commit') },
      propose() { throw new Error('Policy unavailable before commit') },
      decideProposal: input => fixture.policy.decideProposal(input),
      getProposal: proposalId => fixture.policy.getProposal(proposalId),
    })
    const input = {
      ...proposalInput('never resurrect expired intent'),
      idempotencyKey: 'proposal:expired-local-intent',
      ttlMs: 1_000,
    }
    expect(() => unavailable.propose(input)).toThrow(/Policy unavailable/i)
    expect(fixture.memory.listProposalIntents(10)).toHaveLength(1)
    now += input.ttlMs + 1

    let recoveryCount = 0
    let proposeCount = 0
    const recovered = new MemoryProposalManager(fixture.memory, {
      recoverOrCreateProposal(recovery) {
        recoveryCount += 1
        return fixture.policy.recoverOrCreateProposal(recovery)
      },
      propose(policyInput) {
        proposeCount += 1
        return fixture.policy.propose(policyInput)
      },
      decideProposal: decision => fixture.policy.decideProposal(decision),
      getProposal: proposalId => fixture.policy.getProposal(proposalId),
    })

    const [conflicted] = recovered.reconcile(50)
    expect(conflicted).toEqual(
      expect.objectContaining({ status: 'conflicted', version: 2 }),
    )
    expect(recovered.reconcile(50)).toEqual([])
    expect(recovered.propose(input)).toEqual({ ...conflicted!, replayed: true })
    expect(recovered.decide({
      proposalId: conflicted!.proposalId,
      principal: input.principal,
      expectedVersion: 1,
      decision: 'approved',
      reason: 'late replay cannot resurrect the intent',
    })).toEqual({ ...conflicted!, replayed: true })
    expect(() => recovered.propose({ ...input, ttlMs: input.ttlMs + 1 }))
      .toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    expect(recoveryCount).toBe(1)
    expect(proposeCount).toBe(0)
    expect(fixture.memory.listProposalIntents(10)).toEqual([])
    expect(fixture.memory.list(namespace, identity)).toEqual([])
    expect(fixture.policy.listPendingApprovalDispatches()).toEqual([])
    fixture.memory.close()
    await fixture.ctx.fiber.restart()
  })

  test('two Policy connections serialize expired abandonment and cannot leave an orphan dispatch', async () => {
    const fixture = await harness(() => 100_000)
    let captured: ApprovalProposalRecoveryInput | undefined
    const unavailable = new MemoryProposalManager(fixture.memory, {
      recoverOrCreateProposal(input) {
        captured = input
        throw new Error('crash before atomic Policy recovery')
      },
      propose: input => fixture.policy.propose(input),
      decideProposal: input => fixture.policy.decideProposal(input),
      getProposal: proposalId => fixture.policy.getProposal(proposalId),
    })
    const input = {
      ...proposalInput('atomic abandonment winner'),
      idempotencyKey: 'proposal:atomic-abandonment-winner',
      ttlMs: 1_000,
      dispatch: {
        ...routeV2,
        sourceId: 'dsh-enhanced-personal-memory',
        bindingId: 'binding-owner-dm',
        workspace: '/work/alpha',
        principal: 'owner:lark:123',
      },
    }
    expect(() => unavailable.propose(input)).toThrow(/crash before atomic/i)
    expect(captured?.notAfter).toBe(101_000)
    fixture.memory.close()
    await fixture.ctx.fiber.restart()

    const firstContext = new Context()
    const secondContext = new Context()
    const firstPolicy = new AssistantPolicyService(
      firstContext,
      { databasePath: fixture.policyPath, rules: [] },
      { now: () => 101_000 },
    )
    const secondPolicy = new AssistantPolicyService(
      secondContext,
      { databasePath: fixture.policyPath, rules: [] },
      { now: () => 101_001 },
    )
    const firstMemory = new MemoryStore({ path: fixture.memoryPath, now: () => 101_000 })
    const secondMemory = new MemoryStore({ path: fixture.memoryPath, now: () => 101_001 })
    const firstManager = new MemoryProposalManager(firstMemory, firstPolicy)
    const secondManager = new MemoryProposalManager(secondMemory, secondPolicy)

    expect(firstManager.reconcile(50)).toEqual([
      expect.objectContaining({ status: 'conflicted', version: 2 }),
    ])
    expect(secondPolicy.recoverOrCreateProposal(captured!)).toMatchObject({
      kind: 'abandoned',
      notAfter: 101_000,
      replayed: true,
    })
    const { notAfter: _notAfter, ...ordinaryInput } = captured!
    expect(() => secondPolicy.propose({ ...ordinaryInput, ttlMs: input.ttlMs }))
      .toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    expect(secondManager.reconcile(50)).toEqual([])
    expect(firstPolicy.listPendingApprovalDispatches()).toEqual([])
    expect(secondPolicy.listPendingApprovalDispatches()).toEqual([])
    expect(firstMemory.list(namespace, identity)).toEqual([])
    expect(secondMemory.list(namespace, identity)).toEqual([])
    firstMemory.close()
    secondMemory.close()
    await firstContext.fiber.restart()
    await secondContext.fiber.restart()
  })

  test('two Policy connections converge when exact creation wins just before the deadline', async () => {
    const fixture = await harness(() => 100_000)
    let captured: ApprovalProposalRecoveryInput | undefined
    const unavailable = new MemoryProposalManager(fixture.memory, {
      recoverOrCreateProposal(input) {
        captured = input
        throw new Error('crash before atomic Policy recovery')
      },
      propose: input => fixture.policy.propose(input),
      decideProposal: input => fixture.policy.decideProposal(input),
      getProposal: proposalId => fixture.policy.getProposal(proposalId),
    })
    const input = {
      ...proposalInput('atomic creation winner'),
      idempotencyKey: 'proposal:atomic-creation-winner',
      ttlMs: 1_000,
      dispatch: {
        ...routeV2,
        sourceId: 'dsh-enhanced-personal-memory',
        bindingId: 'binding-owner-dm',
        workspace: '/work/alpha',
        principal: 'owner:lark:123',
      },
    }
    expect(() => unavailable.propose(input)).toThrow(/crash before atomic/i)
    expect(captured?.notAfter).toBe(101_000)
    fixture.memory.close()
    await fixture.ctx.fiber.restart()

    const earlyContext = new Context()
    const lateContext = new Context()
    const earlyPolicy = new AssistantPolicyService(
      earlyContext,
      { databasePath: fixture.policyPath, rules: [] },
      { now: () => 100_999 },
    )
    const latePolicy = new AssistantPolicyService(
      lateContext,
      { databasePath: fixture.policyPath, rules: [] },
      { now: () => 101_000 },
    )
    const earlyMemory = new MemoryStore({ path: fixture.memoryPath, now: () => 100_999 })
    const lateMemory = new MemoryStore({ path: fixture.memoryPath, now: () => 101_000 })
    const earlyManager = new MemoryProposalManager(earlyMemory, earlyPolicy)
    const lateManager = new MemoryProposalManager(lateMemory, latePolicy)

    const created = earlyPolicy.recoverOrCreateProposal(captured!)
    if (created.kind !== 'proposal') throw new Error('exact creation should win before deadline')
    expect(lateManager.reconcile(50)).toEqual([])
    expect(lateMemory.getProposalIntent(captured!.resource.id)).toBeUndefined()
    const [local] = lateMemory.listPendingProposals(10)
    expect(local).toMatchObject({
      policyProposalId: created.proposal.proposalId,
      expiresAt: 101_000,
      version: 1,
    })
    earlyPolicy.decideProposal({
      proposalId: created.proposal.proposalId,
      principal: input.principal,
      expectedVersion: 1,
      decision: 'approved',
      reason: 'exact owner approved atomic winner',
    })
    const settlements = [
      ...earlyManager.reconcile(50),
      ...lateManager.reconcile(50),
    ]
    expect(settlements).toEqual([
      expect.objectContaining({ status: 'approved', version: 2 }),
    ])
    expect(earlyMemory.list(namespace, identity).map(record => record.content)).toEqual(['atomic creation winner'])
    expect(lateMemory.list(namespace, identity).map(record => record.content)).toEqual(['atomic creation winner'])
    expect(earlyPolicy.listPendingApprovalDispatches()).toEqual([])
    expect(latePolicy.listPendingApprovalDispatches()).toEqual([])
    earlyMemory.close()
    lateMemory.close()
    await earlyContext.fiber.restart()
    await lateContext.fiber.restart()
  })

  test('atomically rejects a cross-connection proposal/intent race without leaving poison work', async () => {
    const fixture = await harness()
    const secondMemory = new MemoryStore({ path: fixture.memoryPath, now: () => 100_000 })
    const secondCtx = new Context()
    const secondPolicy = new AssistantPolicyService(
      secondCtx,
      { databasePath: fixture.policyPath, rules: [] },
      { now: () => 100_000 },
    )
    const managerB = new MemoryProposalManager(secondMemory, secondPolicy)
    const dispatch = {
      ...routeV2,
      sourceId: 'dsh-enhanced-personal-memory',
      bindingId: 'binding-owner-dm',
      workspace: '/work/alpha',
      principal: 'owner:lark:123',
    }
    const inputA = {
      ...proposalInput('connection A loses the race'),
      idempotencyKey: 'proposal:cross-connection-local-race',
      dispatch,
    }
    const inputB = {
      ...inputA,
      mutation: { ...inputA.mutation, entry: entry('connection B wins the race') },
    }
    const originalNormalize = fixture.memory.normalizeMutation.bind(fixture.memory)
    let winner: ReturnType<typeof managerB.propose> | undefined
    let interleaved = false
    fixture.memory.normalizeMutation = ((mutation, options) => {
      const normalized = originalNormalize(mutation, options)
      if (!interleaved) {
        interleaved = true
        winner = managerB.propose(inputB)
      }
      return normalized
    }) as typeof fixture.memory.normalizeMutation

    expect(() => fixture.manager.propose(inputA))
      .toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    expect(winner).toMatchObject({ status: 'pending', mutation: inputB.mutation })
    expect(fixture.memory.listProposalIntents(10)).toEqual([])
    expect(fixture.memory.getProposal(winner!.proposalId)?.mutation).toEqual(inputB.mutation)
    expect(fixture.policy.listPendingApprovalDispatches()).toHaveLength(1)

    const later = fixture.manager.propose({
      ...proposalInput('later work is not starved'),
      idempotencyKey: 'proposal:after-cross-connection-race',
      dispatch,
    })
    expect(later.status).toBe('pending')
    expect(fixture.memory.listProposalIntents(10)).toEqual([])
    secondMemory.close()
    fixture.memory.close()
    await fixture.ctx.fiber.restart()
    await secondCtx.fiber.restart()
  })

  test('durably conflicts recovered Policy rows with a different TTL or dispatch route', async () => {
    for (const mismatch of ['ttl', 'dispatch'] as const) {
      const fixture = await harness()
      let captured: ApprovalProposalRecoveryInput | undefined
      const unavailable = new MemoryProposalManager(fixture.memory, {
        recoverOrCreateProposal(input) {
          captured = input
          throw new Error('crash before Policy commit')
        },
        propose: input => fixture.policy.propose(input),
        decideProposal: input => fixture.policy.decideProposal(input),
        getProposal: proposalId => fixture.policy.getProposal(proposalId),
      })
      const input = {
        ...proposalInput(`recovery ${mismatch} mismatch`),
        idempotencyKey: `proposal:recovery-${mismatch}-mismatch`,
        dispatch: {
          ...routeV2,
          sourceId: 'dsh-enhanced-personal-memory',
          bindingId: 'expected-owner-binding',
          workspace: '/work/alpha',
          principal: 'owner:lark:123',
        },
      }
      expect(() => unavailable.propose(input)).toThrow(/crash before Policy/i)
      expect(captured).toBeDefined()
      const recovery = fixture.policy.recoverOrCreateProposal(mismatch === 'ttl'
        ? { ...captured!, notAfter: captured!.notAfter + 1 }
        : {
          ...captured!,
          dispatch: { ...captured!.dispatch!, bindingId: 'different-owner-binding' },
        })
      if (recovery.kind !== 'proposal') throw new Error('expected mismatched proposal fixture')
      const foreign = recovery.proposal
      fixture.policy.decideProposal({
        proposalId: foreign.proposalId,
        principal: input.principal,
        expectedVersion: 1,
        decision: 'approved',
        reason: 'approved mismatched recovery fixture',
      })

      const recovered = new MemoryProposalManager(fixture.memory, fixture.policy)
      expect(recovered.reconcile(50)).toEqual([
        expect.objectContaining({ status: 'conflicted', version: 2 }),
      ])
      expect(fixture.memory.list(namespace, identity), mismatch).toEqual([])
      expect(fixture.memory.listProposalIntents(10), mismatch).toEqual([])
      fixture.memory.close()
      await fixture.ctx.fiber.restart()
    }
  })

  test('fairly reaches a terminal proposal beyond the reconcile limit', async () => {
    const fixture = await harness()
    for (let index = 0; index < 51; index += 1) {
      fixture.manager.propose({
        ...proposalInput(`fair proposal ${index}`),
        idempotencyKey: `proposal:fair:${index}`,
      })
    }
    const beyondFirstPage = fixture.memory.listPendingProposals(51)[50]!
    fixture.policy.decideProposal({
      proposalId: beyondFirstPage.policyProposalId,
      principal: beyondFirstPage.principal,
      expectedVersion: beyondFirstPage.version,
      decision: 'approved',
      reason: 'approved outside the first bounded page',
    })

    expect(fixture.manager.reconcile(50)).toEqual([])
    expect(fixture.manager.reconcile(50)).toEqual([
      expect.objectContaining({ proposalId: beyondFirstPage.proposalId, status: 'approved' }),
    ])
    expect(fixture.memory.list(namespace, identity).map(record => record.content))
      .toEqual([beyondFirstPage.mutation.op === 'add' ? beyondFirstPage.mutation.entry.content : ''])
    fixture.memory.close()
    await fixture.ctx.fiber.restart()
  })

  test('isolates a poison creation intent so later intents and pending settlements still progress', async () => {
    const fixture = await harness()
    const unavailable = new MemoryProposalManager(fixture.memory, {
      recoverOrCreateProposal() { throw new Error('simulated Policy outage') },
      propose() { throw new Error('simulated Policy outage') },
      decideProposal: input => fixture.policy.decideProposal(input),
      getProposal: proposalId => fixture.policy.getProposal(proposalId),
    })
    for (let index = 0; index < 2; index += 1) {
      expect(() => unavailable.propose({
        ...proposalInput(`intent lane ${index}`),
        idempotencyKey: `proposal:intent-lane:${index}`,
      })).toThrow(/Policy outage/i)
    }
    const poison = fixture.memory.listProposalIntents(2)[0]!
    const manager = new MemoryProposalManager(fixture.memory, {
      recoverOrCreateProposal(input) {
        if (input.idempotencyKey === `personal-memory:${poison.idempotencyKey}`) {
          throw new Error('permanent poison intent')
        }
        return fixture.policy.recoverOrCreateProposal(input)
      },
      propose: input => fixture.policy.propose(input),
      decideProposal: input => fixture.policy.decideProposal(input),
      getProposal: proposalId => fixture.policy.getProposal(proposalId),
    })

    expect(manager.reconcile(2)).toEqual([])
    expect(manager.reconcile(2)).toEqual([])
    const attached = fixture.memory.listPendingProposals(10)
    expect(attached).toHaveLength(1)
    expect(attached[0]!.idempotencyKey).not.toBe(poison.idempotencyKey)
    fixture.policy.decideProposal({
      proposalId: attached[0]!.policyProposalId,
      principal: attached[0]!.principal,
      expectedVersion: attached[0]!.version,
      decision: 'approved',
      reason: 'later intent must not starve',
    })

    expect(manager.reconcile(2)).toEqual([
      expect.objectContaining({ proposalId: attached[0]!.proposalId, status: 'approved' }),
    ])
    expect(fixture.memory.listProposalIntents(10).map(intent => intent.proposalId))
      .toEqual([poison.proposalId])
    fixture.memory.close()
    await fixture.ctx.fiber.restart()
  })

  test('durably conflicts an invalid Policy recovery lifecycle instead of retrying forever', async () => {
    const fixture = await harness()
    const manager = new MemoryProposalManager(fixture.memory, {
      recoverOrCreateProposal(input) {
        return {
          kind: 'proposal',
          proposal: {
            proposalId: 'invalid-lifecycle-policy-proposal',
            status: 'pending',
            diffHash: '0'.repeat(64),
            expiresAt: input.notAfter,
            version: 99,
            replayed: false,
          },
        }
      },
      propose: input => fixture.policy.propose(input),
      decideProposal: input => fixture.policy.decideProposal(input),
      getProposal: proposalId => fixture.policy.getProposal(proposalId),
    })

    expect(manager.propose({
      ...proposalInput('invalid Policy lifecycle'),
      idempotencyKey: 'proposal:invalid-policy-lifecycle',
    })).toMatchObject({ status: 'conflicted', version: 2 })
    expect(fixture.memory.listProposalIntents(10)).toEqual([])
    expect(fixture.memory.listPendingProposals(10)).toEqual([])
    expect(fixture.memory.list(namespace, identity)).toEqual([])
    fixture.memory.close()
    await fixture.ctx.fiber.restart()
  })

  test('rejects an over-budget Policy payload before persisting a creation intent', async () => {
    const fixture = await harness()
    const oversized = proposalInput('bounded content')
    oversized.mutation.entry.provenance.uri = 'x'.repeat(70 * 1_024)

    expect(() => fixture.manager.propose({
      ...oversized,
      idempotencyKey: 'proposal:oversized-policy-payload',
    })).toThrowError(expect.objectContaining({ code: 'invalid-entry' }))
    expect(fixture.memory.listProposalIntents(10)).toEqual([])
    expect(fixture.memory.listPendingProposals(10)).toEqual([])
    fixture.memory.close()
    await fixture.ctx.fiber.restart()
  })

  test('rejects an unsafe absolute approval deadline before persisting a creation intent', async () => {
    const fixture = await harness(() => Number.MAX_SAFE_INTEGER - 10)

    expect(() => fixture.manager.propose({
      ...proposalInput('unsafe absolute deadline'),
      idempotencyKey: 'proposal:unsafe-absolute-deadline',
      ttlMs: 60,
    })).toThrowError(expect.objectContaining({ code: 'invalid-entry' }))
    expect(fixture.memory.listProposalIntents(10)).toEqual([])
    expect(fixture.memory.listPendingProposals(10)).toEqual([])
    fixture.memory.close()
    await fixture.ctx.fiber.restart()
  })

  test('rejects idempotency-key reuse with changed content before policy mutation', async () => {
    const { manager, memory, ctx } = await harness()
    manager.propose(proposalInput('first content'))

    expect(() => manager.propose(proposalInput('changed content')))
      .toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    expect(memory.list(namespace, identity)).toEqual([])
    memory.close()
    await ctx.fiber.restart()
  })

  test('commits an approval that policy settled after the originating turn', async () => {
    const { manager, memory, policy, ctx } = await harness()
    const proposal = manager.propose(proposalInput('approved out of band'))

    // The owner decides on the policy ledger directly, as an approval card does,
    // without ever calling back into personal-memory.
    policy.decideProposal({
      proposalId: proposal.policyProposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner confirmed on a card',
    })
    expect(memory.list(namespace, identity)).toEqual([])

    const settled = manager.reconcile(50)

    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ proposalId: proposal.proposalId, status: 'approved' })
    expect(memory.list(namespace, identity).map(record => record.content)).toEqual(['approved out of band'])
    memory.close()
    await ctx.fiber.restart()
  })

  test('durably conflicts every tampered policy settlement field without writing memory', async () => {
    const tamperCases: Array<[
      string,
      (snapshot: ApprovalProposalSnapshot) => ApprovalProposalSnapshot | undefined,
    ]> = [
      ['missing', () => undefined],
      ['proposalId', snapshot => ({ ...snapshot, proposalId: 'tampered-proposal' })],
      ['diff', snapshot => ({ ...snapshot, diffHash: '0'.repeat(64) })],
      ['action', snapshot => ({ ...snapshot, action: 'memory.remove' })],
      ['resource', snapshot => ({ ...snapshot, resource: { kind: 'memory', id: 'tampered-resource' } })],
      ['requester', snapshot => ({ ...snapshot, requester: 'agent:attacker' })],
      ['principal', snapshot => ({ ...snapshot, principal: 'owner:lark:attacker' })],
      ['summary', snapshot => ({ ...snapshot, summary: 'tampered summary' })],
      ['expiry', snapshot => ({ ...snapshot, expiresAt: snapshot.expiresAt + 1 })],
      ['decider', snapshot => ({ ...snapshot, decidedBy: 'owner:lark:attacker' })],
      ['version', snapshot => ({ ...snapshot, version: snapshot.version + 1 })],
    ]

    for (const [field, tamper] of tamperCases) {
      const fixture = await harness()
      const proposal = fixture.manager.propose({
        ...proposalInput(`tamper ${field}`),
        idempotencyKey: `proposal:tamper:${field}`,
      })
      fixture.policy.decideProposal({
        proposalId: proposal.policyProposalId,
        principal: 'owner:lark:123',
        expectedVersion: 1,
        decision: 'approved',
        reason: 'owner confirmed',
      })
      const policy = fixture.policy
      const manager = new MemoryProposalManager(fixture.memory, {
        recoverOrCreateProposal: input => policy.recoverOrCreateProposal(input),
        propose: input => policy.propose(input),
        decideProposal: input => policy.decideProposal(input),
        getProposal: proposalId => {
          const snapshot = policy.getProposal(proposalId)
          return snapshot === undefined ? undefined : tamper(snapshot)
        },
      })

      expect(manager.reconcile(50)).toEqual([
        expect.objectContaining({ proposalId: proposal.proposalId, status: 'conflicted', version: 2 }),
      ])
      expect(fixture.memory.list(namespace, identity), field).toEqual([])
      expect(fixture.memory.getProposal(proposal.proposalId), field)
        .toMatchObject({ status: 'conflicted', version: 2 })
      fixture.memory.close()
      await fixture.ctx.fiber.restart()
    }
  })

  test('validates a direct decision snapshot before applying it', async () => {
    const fixture = await harness()
    const policy = fixture.policy
    const manager = new MemoryProposalManager(fixture.memory, {
      recoverOrCreateProposal: input => policy.recoverOrCreateProposal(input),
      propose: input => policy.propose(input),
      decideProposal: input => policy.decideProposal(input),
      getProposal: proposalId => {
        const snapshot = policy.getProposal(proposalId)
        return snapshot === undefined ? undefined : { ...snapshot, requester: 'agent:attacker' }
      },
    })
    const proposal = manager.propose({
      ...proposalInput('direct snapshot tamper'),
      idempotencyKey: 'proposal:direct-tamper',
    })

    const settled = manager.decide({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner confirmed',
    })

    expect(settled).toMatchObject({ status: 'conflicted', version: 2 })
    expect(fixture.memory.list(namespace, identity)).toEqual([])
    fixture.memory.close()
    await fixture.ctx.fiber.restart()
  })

  test('reconcile is idempotent and never invents an approval', async () => {
    const { manager, memory, policy, ctx } = await harness()
    const approved = manager.propose(proposalInput('committed once'))
    policy.decideProposal({
      proposalId: approved.policyProposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner confirmed',
    })

    expect(manager.reconcile(50)).toHaveLength(1)
    // A second pass must not duplicate the record or re-settle the proposal.
    expect(manager.reconcile(50)).toHaveLength(0)
    expect(memory.list(namespace, identity).map(record => record.content)).toEqual(['committed once'])

    // An undecided proposal stays pending: silence is never treated as approval.
    manager.propose({ ...proposalInput('still pending'), idempotencyKey: 'proposal:add:pending' })
    expect(manager.reconcile(50)).toHaveLength(0)
    expect(memory.list(namespace, identity).map(record => record.content)).toEqual(['committed once'])
    memory.close()
    await ctx.fiber.restart()
  })

  test('commits a rejection without writing the memory', async () => {
    const { manager, memory, policy, ctx } = await harness()
    const proposal = manager.propose(proposalInput('never stored'))
    policy.decideProposal({
      proposalId: proposal.policyProposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'rejected',
      reason: 'owner declined',
    })

    const settled = manager.reconcile(50)

    expect(settled[0]).toMatchObject({ status: 'rejected' })
    expect(memory.list(namespace, identity)).toEqual([])
    memory.close()
    await ctx.fiber.restart()
  })
})
