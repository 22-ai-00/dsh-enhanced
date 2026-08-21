import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test } from 'vitest'
import {
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

function createInput(prompt = 'Run a safe review.') {
  return {
    idempotencyKey: 'automation:create:review', requester: 'agent:primary', principal: 'owner:lark:123', ttlMs: 60_000,
    mutation: { op: 'create' as const, automationId: 'auto-review', definition: definition(prompt) },
  }
}

describe('approval-gated automation proposals', () => {
  test('persists the exact immutable change and sends policy only its diff', async () => {
    const fixture = await harness()
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
    const policy = new AssistantPolicyService(ctx, { databasePath: first.policyPath, rules: [] })
    const manager = new AutomationProposalManager(automations, proposals, policy)
    expect(manager.decide({ proposalId: proposal.proposalId, principal: 'owner:lark:123', expectedVersion: 1,
      decision: 'approved', reason: 'reviewed' })).toMatchObject({ status: 'approved', replayed: true })
    expect(automations.list()).toHaveLength(1)
    proposals.close()
    automations.close()
    await ctx.fiber.restart()
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
