import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import {
  AssistantPolicyService,
  type ApprovalDispatchRoute,
  type ApprovalProposalSnapshot,
} from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  type AutomationApprovalPolicy,
  AutomationProposalManager,
  AutomationProposalStore,
  AutomationProposalStoreError,
} from '../src/proposals.ts'
import { AutomationStore } from '../src/store.ts'
import type { AutomationDefinition } from '../src/types.ts'

const roots: string[] = []
const nowValue = Date.parse('2026-08-21T10:00:00.000Z')

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function definition(prompt = 'Run a safe review.'): AutomationDefinition {
  return {
    name: 'Review', prompt,
    schedule: { kind: 'at', at: '2026-08-21T10:01:00.000Z' },
    workspace: '/work/alpha', agentPreset: 'primary', provider: 'mock', model: 'mock-model',
    allowedTools: [], timeoutMs: 60_000, maxOutputTokens: 512, maxToolCalls: 0,
    misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
    principal: 'owner:lark:123',
  }
}

async function harness(now: () => number = () => nowValue) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automations-proposals-'))
  roots.push(root)
  const statePath = join(root, 'automations.sqlite')
  const policyPath = join(root, 'policy.sqlite')
  const automations = new AutomationStore({ path: statePath, now })
  const proposals = new AutomationProposalStore({ path: statePath, now })
  const ctx = new Context()
  const policy = new AssistantPolicyService(ctx, { databasePath: policyPath, rules: [] }, { now })
  const manager = new AutomationProposalManager(automations, proposals, policy, now)
  return { root, statePath, policyPath, automations, proposals, policy, manager, ctx }
}

const dispatch: ApprovalDispatchRoute = {
  sourceId: 'dsh-enhanced-assistant-automations',
  bindingId: 'binding-owner',
  workspace: '/work/alpha',
  principal: 'owner:lark:123',
}

function createInput(prompt = 'Run a safe review.', suffix = 'review') {
  return {
    idempotencyKey: `automation:create:${suffix}`, requester: 'agent:primary', principal: 'owner:lark:123', ttlMs: 60_000,
    dispatch,
    mutation: { op: 'create' as const, automationId: `auto-${suffix}`, definition: definition(prompt) },
  }
}

describe('approval-gated automation proposals', () => {
  test('persists the exact immutable change and sends policy only its diff', async () => {
    const fixture = await harness()
    const recover = vi.spyOn(fixture.policy, 'recoverOrCreateProposal')
    const ordinaryPropose = vi.spyOn(fixture.policy, 'propose')
    const created = fixture.manager.propose(createInput())
    const replay = fixture.manager.propose(createInput())
    expect(created).toMatchObject({
      status: 'pending', version: 1, replayed: false,
      mutation: { op: 'create', automationId: 'auto-review', definition: definition() },
      policyProposalId: expect.any(String),
    })
    expect(created.diff).toContain('Run a safe review.')
    expect(replay).toEqual({ ...created, replayed: true })
    expect(fixture.automations.get('auto-review')).toBeUndefined()
    expect(recover).toHaveBeenCalledOnce()
    expect(ordinaryPropose).not.toHaveBeenCalled()
    expect(fixture.policy.listPendingApprovalDispatches()).toEqual([
      expect.objectContaining({
        proposalId: created.policyProposalId,
        sourceId: dispatch.sourceId,
        bindingId: dispatch.bindingId,
        workspace: dispatch.workspace,
        principal: dispatch.principal,
      }),
    ])
    expect((await stat(fixture.statePath)).mode & 0o777).toBe(0o600)
    fixture.proposals.close()
    fixture.automations.close()
    await fixture.ctx.fiber.restart()
  })

  test('rejects changed input under a reused idempotency key', async () => {
    const fixture = await harness()
    fixture.manager.propose(createInput())
    expect(() => fixture.manager.propose(createInput('changed')))
      .toThrowError(expect.objectContaining<Partial<AutomationProposalStoreError>>({ code: 'idempotency-conflict' }))
    fixture.proposals.close()
    fixture.automations.close()
    await fixture.ctx.fiber.restart()
  })

  test('binds principal and TTL; rejected and expired proposals never mutate automations', async () => {
    let now = nowValue
    const fixture = await harness(() => now)
    const rejected = fixture.manager.propose(createInput())
    expect(() => fixture.manager.decide({
      proposalId: rejected.proposalId, principal: 'attacker', expectedVersion: 1,
      decision: 'approved', reason: 'attack',
    })).toThrowError(expect.objectContaining({ code: 'unauthorized' }))
    expect(fixture.manager.decide({
      proposalId: rejected.proposalId, principal: 'owner:lark:123', expectedVersion: 1,
      decision: 'rejected', reason: 'not desired',
    })).toMatchObject({ status: 'rejected', version: 2 })
    expect(() => fixture.manager.decide({
      proposalId: rejected.proposalId, principal: 'owner:lark:attacker', expectedVersion: 2,
      decision: 'rejected', reason: 'probe terminal result',
    })).toThrowError(expect.objectContaining({ code: 'unauthorized' }))
    const expiring = fixture.manager.propose({ ...createInput(), idempotencyKey: 'automation:create:expired', ttlMs: 1_000,
      mutation: { ...createInput().mutation, automationId: 'auto-expired' } })
    now += 1_000
    expect(fixture.manager.decide({
      proposalId: expiring.proposalId, principal: 'owner:lark:123', expectedVersion: 1,
      decision: 'approved', reason: 'late',
    })).toMatchObject({ status: 'expired' })
    expect(fixture.automations.list()).toEqual([])
    fixture.proposals.close()
    fixture.automations.close()
    await fixture.ctx.fiber.restart()
  })

  test('approves create and exact versioned lifecycle mutations idempotently', async () => {
    const fixture = await harness()
    const create = fixture.manager.propose(createInput())
    const approved = fixture.manager.decide({
      proposalId: create.proposalId, principal: 'owner:lark:123', expectedVersion: 1,
      decision: 'approved', reason: 'reviewed',
    })
    expect(approved).toMatchObject({ status: 'approved', version: 2, automation: { id: 'auto-review', status: 'active' } })
    expect(fixture.manager.propose(createInput())).toEqual({ ...approved, replayed: true })
    expect(fixture.manager.decide({
      proposalId: create.proposalId, principal: 'owner:lark:123', expectedVersion: 1,
      decision: 'approved', reason: 'reviewed',
    })).toEqual({ ...approved, replayed: true })

    const pause = fixture.manager.propose({
      idempotencyKey: 'automation:pause:review', requester: 'agent:primary', principal: 'owner:lark:123', ttlMs: 60_000,
      mutation: { op: 'pause', automationId: 'auto-review', expectedVersion: 1 },
    })
    expect(fixture.manager.decide({
      proposalId: pause.proposalId, principal: 'owner:lark:123', expectedVersion: 1,
      decision: 'approved', reason: 'pause it',
    })).toMatchObject({ status: 'approved', automation: { status: 'paused', version: 2 } })
    expect(fixture.manager.propose({
      idempotencyKey: 'automation:pause:review', requester: 'agent:primary', principal: 'owner:lark:123', ttlMs: 60_000,
      mutation: { op: 'pause', automationId: 'auto-review', expectedVersion: 1 },
    })).toMatchObject({ status: 'approved', replayed: true, automation: { status: 'paused' } })
    fixture.proposals.close()
    fixture.automations.close()
    await fixture.ctx.fiber.restart()
  })

  test('marks an approved stale lifecycle snapshot conflicted', async () => {
    const fixture = await harness()
    fixture.automations.createApproved({ automationId: 'auto-review', idempotencyKey: 'seed', definition: definition() })
    const pause = fixture.manager.propose({
      idempotencyKey: 'automation:pause:stale', requester: 'agent:primary', principal: 'owner:lark:123', ttlMs: 60_000,
      mutation: { op: 'pause', automationId: 'auto-review', expectedVersion: 1 },
    })
    fixture.automations.changeApproved({ automationId: 'auto-review', operation: 'pause', expectedVersion: 1, idempotencyKey: 'external' })
    expect(fixture.manager.decide({
      proposalId: pause.proposalId, principal: 'owner:lark:123', expectedVersion: 1,
      decision: 'approved', reason: 'approved old snapshot',
    })).toMatchObject({ status: 'conflicted', version: 2 })
    fixture.proposals.close()
    fixture.automations.close()
    await fixture.ctx.fiber.restart()
  })

  test('recovers after policy approval and automation commit happened before local settlement', async () => {
    const first = await harness()
    const proposal = first.manager.propose(createInput())
    const stored = first.proposals.get(proposal.proposalId)!
    first.policy.decideProposal({ proposalId: stored.policyProposalId!, principal: 'owner:lark:123', expectedVersion: 1,
      decision: 'approved', reason: 'reviewed' })
    first.automations.createApproved({ automationId: 'auto-review', idempotencyKey: `proposal:${proposal.proposalId}`, definition: definition() })
    first.proposals.close()
    first.automations.close()
    await first.ctx.fiber.restart()

    const automations = new AutomationStore({ path: first.statePath })
    const proposals = new AutomationProposalStore({ path: first.statePath })
    const ctx = new Context()
    const policy = new AssistantPolicyService(ctx, { databasePath: first.policyPath, rules: [] }, { now: () => nowValue })
    const manager = new AutomationProposalManager(automations, proposals, policy, () => nowValue)
    expect(manager.decide({ proposalId: proposal.proposalId, principal: 'owner:lark:123', expectedVersion: 1,
      decision: 'approved', reason: 'reviewed' })).toMatchObject({ status: 'approved', replayed: true })
    expect(automations.list()).toHaveLength(1)
    proposals.close()
    automations.close()
    await ctx.fiber.restart()
  })

  test('commits an approval that policy settled after the originating turn', async () => {
    const { manager, automations, policy, proposals, ctx } = await harness()
    const proposal = manager.propose(createInput())

    // The owner decides on the policy ledger directly, as an approval card does,
    // without ever calling back into assistant-automations.
    policy.decideProposal({
      proposalId: proposal.policyProposalId!,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner confirmed on a card',
    })
    expect(automations.list()).toEqual([])

    const settled = manager.reconcile(50)

    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ proposalId: proposal.proposalId, status: 'approved' })
    expect(automations.list().map(record => record.id)).toEqual(['auto-review'])
    // A second pass must not create the automation twice or re-settle the proposal.
    expect(manager.reconcile(50)).toHaveLength(0)
    expect(automations.list()).toHaveLength(1)
    proposals.close()
    automations.close()
    await ctx.fiber.restart()
  })

  test('validates every immutable Policy settlement field before applying direct decisions', async () => {
    const fixture = await harness()
    let tamper: (snapshot: ApprovalProposalSnapshot) => ApprovalProposalSnapshot = snapshot => snapshot
    const policy: AutomationApprovalPolicy = {
      recoverOrCreateProposal: input => fixture.policy.recoverOrCreateProposal(input),
      decideProposal: input => fixture.policy.decideProposal(input),
      getProposal(proposalId) {
        const snapshot = fixture.policy.getProposal(proposalId)
        return snapshot === undefined ? undefined : tamper(snapshot)
      },
    }
    const manager = new AutomationProposalManager(fixture.automations, fixture.proposals, policy, () => nowValue)
    const changes: Array<[string, (snapshot: ApprovalProposalSnapshot) => ApprovalProposalSnapshot]> = [
      ['proposalId', snapshot => ({ ...snapshot, proposalId: 'forged-proposal' })],
      ['requester', snapshot => ({ ...snapshot, requester: 'agent:attacker' })],
      ['principal', snapshot => ({ ...snapshot, principal: 'owner:lark:attacker' })],
      ['action', snapshot => ({ ...snapshot, action: 'automation.delete' })],
      ['resource.kind', snapshot => ({ ...snapshot, resource: { ...snapshot.resource, kind: 'message' } })],
      ['resource.id', snapshot => ({ ...snapshot, resource: { ...snapshot.resource, id: 'auto-attacker' } })],
      ['summary', snapshot => ({ ...snapshot, summary: 'create automation attacker' })],
      ['diffHash', snapshot => ({ ...snapshot, diffHash: '0'.repeat(64) })],
      ['expiresAt', snapshot => ({ ...snapshot, expiresAt: snapshot.expiresAt + 1 })],
      ['version', snapshot => ({ ...snapshot, version: snapshot.version + 1 })],
      ['status', snapshot => ({ ...snapshot, status: 'pending', decidedBy: undefined })],
      ['decidedBy', snapshot => ({ ...snapshot, decidedBy: 'owner:lark:attacker' })],
    ]

    for (const [field, change] of changes) {
      const suffix = `tamper-${field.replace('.', '-')}`
      const proposal = manager.propose(createInput('Run a safe review.', suffix))
      tamper = change
      expect(manager.decide({
        proposalId: proposal.proposalId,
        principal: 'owner:lark:123',
        expectedVersion: 1,
        decision: 'approved',
        reason: 'reviewed',
      }), field).toMatchObject({ status: 'conflicted', version: 2 })
      expect(fixture.automations.get(`auto-${suffix}`), field).toBeUndefined()
      tamper = snapshot => snapshot
    }
    fixture.proposals.close()
    fixture.automations.close()
    await fixture.ctx.fiber.restart()
  })

  test('recovers a local creation intent after Policy persisted but attach crashed, then applies exactly once after restart', async () => {
    const first = await harness()
    vi.spyOn(first.proposals, 'attachPolicy').mockImplementationOnce(() => {
      throw new Error('simulated crash after Policy commit')
    })
    expect(() => first.manager.propose(createInput('Recover me.', 'crash-window')))
      .toThrow(/simulated crash/)
    expect(first.proposals.listPending(50)).toHaveLength(1)
    const policyProposalId = first.policy.listPendingApprovalDispatches()[0]!.proposalId
    first.proposals.close()
    first.automations.close()
    await first.ctx.fiber.restart()

    const automations = new AutomationStore({ path: first.statePath })
    const proposals = new AutomationProposalStore({ path: first.statePath })
    const ctx = new Context()
    const policy = new AssistantPolicyService(ctx, { databasePath: first.policyPath, rules: [] }, { now: () => nowValue })
    const recover = vi.spyOn(policy, 'recoverOrCreateProposal')
    const propose = vi.spyOn(policy, 'propose')
    const manager = new AutomationProposalManager(automations, proposals, policy, () => nowValue)
    expect(manager.reconcile(50)).toEqual([])
    expect(recover).toHaveBeenCalledOnce()
    expect(propose).not.toHaveBeenCalled()
    expect(proposals.listPending(50)[0]).toMatchObject({ policyProposalId })
    policy.decideProposal({ proposalId: policyProposalId, principal: 'owner:lark:123', expectedVersion: 1,
      decision: 'approved', reason: 'reviewed after restart' })
    expect(manager.reconcile(50)).toEqual([
      expect.objectContaining({ status: 'approved', automation: expect.objectContaining({ id: 'auto-crash-window' }) }),
    ])
    expect(manager.reconcile(50)).toEqual([])
    expect(automations.list().map(item => item.id)).toEqual(['auto-crash-window'])
    proposals.close()
    automations.close()
    await ctx.fiber.restart()
  })

  test('creates a missing Policy proposal before the frozen deadline after a pre-commit crash', async () => {
    const fixture = await harness()
    const recover = vi.spyOn(fixture.policy, 'recoverOrCreateProposal').mockImplementationOnce(() => {
      throw new Error('simulated crash before Policy commit')
    })
    expect(() => fixture.manager.propose(createInput('Never committed.', 'missing-policy')))
      .toThrow(/simulated crash/)
    recover.mockRestore()
    const ordinaryPropose = vi.spyOn(fixture.policy, 'propose')

    expect(fixture.manager.reconcile(50)).toEqual([])
    expect(fixture.proposals.listPending(50)).toEqual([
      expect.objectContaining({ policyProposalId: expect.any(String), status: 'pending' }),
    ])
    expect(fixture.policy.listPendingApprovalDispatches()).toHaveLength(1)
    expect(ordinaryPropose).not.toHaveBeenCalled()
    expect(fixture.automations.get('auto-missing-policy')).toBeUndefined()
    fixture.proposals.close()
    fixture.automations.close()
    await fixture.ctx.fiber.restart()
  })

  test('abandons a missing Policy half at the frozen deadline without creating an orphan dispatch', async () => {
    let now = nowValue
    const fixture = await harness(() => now)
    const recover = vi.spyOn(fixture.policy, 'recoverOrCreateProposal').mockImplementationOnce(() => {
      throw new Error('simulated crash before Policy commit')
    })
    const input = { ...createInput('Deadline.', 'deadline'), ttlMs: 1_000 }
    expect(() => fixture.manager.propose(input)).toThrow(/simulated crash/)
    recover.mockRestore()
    now += 1_000
    const ordinaryPropose = vi.spyOn(fixture.policy, 'propose')

    expect(fixture.manager.reconcile(50)).toEqual([
      expect.objectContaining({ status: 'conflicted', mutation: expect.objectContaining({ automationId: 'auto-deadline' }) }),
    ])
    expect(ordinaryPropose).not.toHaveBeenCalled()
    expect(fixture.policy.listPendingApprovalDispatches()).toEqual([])
    expect(fixture.policy.getProposalByIdempotencyKey({
      idempotencyKey: `assistant-automations:${input.idempotencyKey}`,
      requester: input.requester,
      principal: input.principal,
      action: 'automation.create',
      resource: { kind: 'automation', id: input.mutation.automationId },
    })).toBeUndefined()
    expect(() => fixture.policy.propose({
      idempotencyKey: `assistant-automations:${input.idempotencyKey}`,
      requester: input.requester,
      principal: input.principal,
      action: 'automation.create',
      resource: { kind: 'automation', id: input.mutation.automationId },
      diff: JSON.stringify(input.mutation),
      summary: 'create automation auto-deadline',
      ttlMs: 1_000,
      dispatch,
    })).toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }))
    expect(fixture.policy.listPendingApprovalDispatches()).toEqual([])
    fixture.proposals.close()
    fixture.automations.close()
    await fixture.ctx.fiber.restart()
  })

  test('two domain and Policy connections converge in the attach window with one proposal and dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-automations-proposal-race-'))
    roots.push(root)
    const statePath = join(root, 'automations.sqlite')
    const policyPath = join(root, 'policy.sqlite')
    const automations1 = new AutomationStore({ path: statePath, now: () => nowValue })
    const proposals1 = new AutomationProposalStore({ path: statePath, now: () => nowValue })
    const automations2 = new AutomationStore({ path: statePath, now: () => nowValue })
    const proposals2 = new AutomationProposalStore({ path: statePath, now: () => nowValue })
    const ctx1 = new Context()
    const ctx2 = new Context()
    const policy1 = new AssistantPolicyService(ctx1, { databasePath: policyPath, rules: [] }, { now: () => nowValue })
    const policy2 = new AssistantPolicyService(ctx2, { databasePath: policyPath, rules: [] }, { now: () => nowValue })
    const manager1 = new AutomationProposalManager(automations1, proposals1, policy1, () => nowValue)
    const manager2 = new AutomationProposalManager(automations2, proposals2, policy2, () => nowValue)
    const recover1 = vi.spyOn(policy1, 'recoverOrCreateProposal')
    const recover2 = vi.spyOn(policy2, 'recoverOrCreateProposal')
    const ordinary1 = vi.spyOn(policy1, 'propose')
    const ordinary2 = vi.spyOn(policy2, 'propose')
    const attach = proposals1.attachPolicy.bind(proposals1)
    let secondResult: ReturnType<AutomationProposalManager['reconcile']> | undefined
    vi.spyOn(proposals1, 'attachPolicy').mockImplementationOnce((...args) => {
      secondResult = manager2.reconcile(50)
      return attach(...args)
    })

    const created = manager1.propose(createInput('Race safely.', 'double-connection'))

    expect(secondResult).toEqual([])
    expect(created).toMatchObject({ status: 'pending', policyProposalId: expect.any(String) })
    expect(proposals1.get(created.proposalId)).toMatchObject({ policyProposalId: created.policyProposalId })
    expect(recover1).toHaveBeenCalledOnce()
    expect(recover2).toHaveBeenCalledOnce()
    expect(ordinary1).not.toHaveBeenCalled()
    expect(ordinary2).not.toHaveBeenCalled()
    expect(policy1.listPendingApprovalDispatches()).toEqual([
      expect.objectContaining({ proposalId: created.policyProposalId, bindingId: dispatch.bindingId }),
    ])
    const policyDatabase = new DatabaseSync(policyPath, { readOnly: true })
    expect(policyDatabase.prepare('SELECT count(*) AS count FROM approval_proposals').get()).toEqual({ count: 1 })
    expect(policyDatabase.prepare('SELECT count(*) AS count FROM approval_dispatches').get()).toEqual({ count: 1 })
    policyDatabase.close()
    proposals2.close()
    automations2.close()
    proposals1.close()
    automations1.close()
    await Promise.all([ctx1.fiber.restart(), ctx2.fiber.restart()])
  })

  test('attaches and settles an existing terminal Policy proposal after the local TTL elapsed', async () => {
    let now = nowValue
    const fixture = await harness(() => now)
    vi.spyOn(fixture.proposals, 'attachPolicy').mockImplementationOnce(() => {
      throw new Error('simulated crash after Policy commit')
    })
    expect(() => fixture.manager.propose({
      ...createInput('Terminal survives.', 'terminal-after-ttl'),
      ttlMs: 1_000,
    })).toThrow(/simulated crash/)
    const policyProposalId = fixture.policy.listPendingApprovalDispatches()[0]!.proposalId
    fixture.policy.decideProposal({
      proposalId: policyProposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'reviewed before expiry',
    })
    now += 60_000
    const propose = vi.spyOn(fixture.policy, 'propose')

    expect(fixture.manager.reconcile(50)).toEqual([
      expect.objectContaining({
        status: 'approved',
        automation: expect.objectContaining({ id: 'auto-terminal-after-ttl' }),
      }),
    ])
    expect(propose).not.toHaveBeenCalled()
    expect(fixture.manager.reconcile(50)).toEqual([])
    fixture.proposals.close()
    fixture.automations.close()
    await fixture.ctx.fiber.restart()
  })

  test('durably rotates unresolved pending rows so a terminal proposal beyond the reconcile limit is not starved', async () => {
    const fixture = await harness()
    for (const suffix of ['fair-a', 'fair-b', 'fair-c']) fixture.manager.propose(createInput('Fair.', suffix))
    const ordered = fixture.proposals.listPending(10)
    const target = ordered[2]!
    fixture.policy.decideProposal({
      proposalId: target.policyProposalId!, principal: target.principal, expectedVersion: 1,
      decision: 'approved', reason: 'reviewed',
    })

    expect(fixture.manager.reconcile(2)).toEqual([])
    expect(fixture.manager.reconcile(2)).toEqual([
      expect.objectContaining({ proposalId: target.proposalId, status: 'approved' }),
    ])
    expect(fixture.automations.get(target.mutation.automationId)).toBeDefined()
    fixture.proposals.close()
    fixture.automations.close()
    await fixture.ctx.fiber.restart()
  })

  test('rotates per-row Policy read failures instead of aborting the bounded reconcile batch', async () => {
    const fixture = await harness()
    for (const suffix of ['read-a', 'read-b', 'read-c']) fixture.manager.propose(createInput('Read.', suffix))
    const ordered = fixture.proposals.listPending(10)
    const blockedIds = new Set(ordered.slice(0, 2).map(proposal => proposal.policyProposalId))
    const target = ordered[2]!
    fixture.policy.decideProposal({
      proposalId: target.policyProposalId!, principal: target.principal, expectedVersion: 1,
      decision: 'approved', reason: 'reviewed',
    })
    const policy: AutomationApprovalPolicy = {
      recoverOrCreateProposal: input => fixture.policy.recoverOrCreateProposal(input),
      decideProposal: input => fixture.policy.decideProposal(input),
      getProposal(proposalId) {
        if (blockedIds.has(proposalId)) throw new Error('temporary Policy read outage')
        return fixture.policy.getProposal(proposalId)
      },
    }
    const manager = new AutomationProposalManager(fixture.automations, fixture.proposals, policy, () => nowValue)

    expect(manager.reconcile(2)).toEqual([])
    expect(manager.reconcile(2)).toEqual([
      expect.objectContaining({ proposalId: target.proposalId, status: 'approved' }),
    ])
    expect(fixture.automations.get(target.mutation.automationId)).toBeDefined()
    fixture.proposals.close()
    fixture.automations.close()
    await fixture.ctx.fiber.restart()
  })

  test('leaves an undecided proposal pending instead of assuming approval', async () => {
    const { manager, automations, proposals, ctx } = await harness()
    manager.propose(createInput())

    expect(manager.reconcile(50)).toHaveLength(0)
    expect(automations.list()).toEqual([])
    proposals.close()
    automations.close()
    await ctx.fiber.restart()
  })

  test('migrates v3 proposal intents with their original TTL and no invented dispatch route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-automations-proposal-v3-'))
    roots.push(root)
    const path = join(root, 'v3.sqlite')
    const database = new DatabaseSync(path)
    database.exec(`
      CREATE TABLE automation_proposals (
        id TEXT PRIMARY KEY,
        policy_proposal_id TEXT UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        requester TEXT NOT NULL,
        principal TEXT NOT NULL,
        change_hash TEXT NOT NULL,
        change_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'conflicted')),
        expires_at INTEGER NOT NULL,
        result_automation_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      PRAGMA user_version = 3;
    `)
    database.prepare(`
      INSERT INTO automation_proposals(
        id, policy_proposal_id, idempotency_key, requester, principal, change_hash, change_json,
        status, expires_at, result_automation_id, created_at, updated_at, version
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, 1)
    `).run(
      'legacy-intent', 'legacy:key', 'agent:primary', 'owner:lark:123', 'legacy-request-hash',
      JSON.stringify(createInput().mutation), nowValue + 60_000, nowValue, nowValue,
    )
    database.close()
    await chmod(path, 0o600)

    const proposals = new AutomationProposalStore({ path, now: () => nowValue })
    const legacy = proposals.get('legacy-intent')!
    expect(legacy).toMatchObject({
      proposalId: 'legacy-intent',
      idempotencyKey: 'legacy:key',
      ttlMs: 60_000,
      createdAt: nowValue,
    })
    expect('dispatch' in legacy).toBe(false)
    proposals.close()
    const migrated = new DatabaseSync(path, { readOnly: true })
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 })
    expect(migrated.prepare('SELECT dispatch_json, ttl_ms FROM automation_proposals WHERE id = ?')
      .get('legacy-intent')).toEqual({ dispatch_json: null, ttl_ms: 60_000 })
    migrated.close()
  })

  test('refuses a future schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-automations-proposal-schema-'))
    roots.push(root)
    const path = join(root, 'future.sqlite')
    const database = new DatabaseSync(path)
    database.exec('PRAGMA user_version = 99')
    database.close()
    await chmod(path, 0o600)
    expect(() => new AutomationProposalStore({ path }))
      .toThrowError(expect.objectContaining<Partial<AutomationProposalStoreError>>({ code: 'schema-too-new' }))
  })
})
