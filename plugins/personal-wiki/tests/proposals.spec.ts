import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test } from 'vitest'
import { WikiProposalManager, WikiProposalStore, WikiProposalStoreError } from '../src/proposals.ts'
import type { WikiPageInput } from '../src/types.ts'
import { WikiVault } from '../src/vault.ts'

const temporaryRoots: string[] = []

function pageInput(title = 'Personal assistant'): WikiPageInput {
  return {
    title,
    type: 'concept',
    authority: 'curated',
    status: 'active',
    tags: ['assistant'],
    aliases: [],
    sources: [{ uri: 'https://example.test/assistant', sha256: 'd'.repeat(64) }],
    body: '# Personal assistant\n\nA reviewed knowledge page.',
  }
}

async function harness(now: () => number = () => Date.parse('2026-08-20T00:00:00.000Z')) {
  const root = await mkdtemp(join(tmpdir(), 'personal-wiki-proposals-'))
  temporaryRoots.push(root)
  const statePath = join(root, 'state', 'wiki.sqlite')
  const policyPath = join(root, 'policy', 'policy.sqlite')
  const vault = new WikiVault({ root: join(root, 'vault'), now })
  const store = new WikiProposalStore({ path: statePath, now })
  const ctx = new Context()
  const policy = new AssistantPolicyService(ctx, { databasePath: policyPath, rules: [] }, { now })
  return {
    root,
    statePath,
    policyPath,
    vault,
    store,
    policy,
    ctx,
    manager: new WikiProposalManager(vault, store, policy, now),
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function proposalInput(title = 'Personal assistant') {
  return {
    idempotencyKey: 'wiki:create:assistant',
    requester: 'agent:primary',
    principal: 'owner:lark:123',
    ttlMs: 60_000,
    mutation: { op: 'create' as const, input: pageInput(title) },
  }
}

describe('approval-gated wiki proposals', () => {
  test('persists one exact proposed page privately and replays idempotently', async () => {
    const { manager, statePath, store, ctx } = await harness()

    const created = manager.propose(proposalInput())
    const replay = manager.propose(proposalInput())

    expect(created).toMatchObject({
      status: 'pending',
      version: 1,
      replayed: false,
      write: {
        op: 'create',
        pageId: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
        relativePath: expect.stringMatching(/^wiki\/concepts\//),
        targetRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
    expect(created.diff).toContain('Personal assistant')
    expect(replay).toEqual({ ...created, replayed: true })
    expect((await stat(statePath)).mode & 0o777).toBe(0o600)
    store.close()
    await ctx.fiber.restart()
  })

  test('rejects changed content under a reused idempotency key', async () => {
    const { manager, store, ctx } = await harness()
    manager.propose(proposalInput())

    expect(() => manager.propose(proposalInput('Changed page')))
      .toThrowError(expect.objectContaining<Partial<WikiProposalStoreError>>({ code: 'idempotency-conflict' }))
    store.close()
    await ctx.fiber.restart()
  })

  test('binds decisions to the principal and never writes rejected or expired pages', async () => {
    let now = Date.parse('2026-08-20T00:00:00.000Z')
    const { manager, vault, store, ctx } = await harness(() => now)
    const rejectedProposal = manager.propose(proposalInput())
    expect(() => manager.decide({
      proposalId: rejectedProposal.proposalId,
      principal: 'owner:lark:attacker',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'malicious click',
    })).toThrowError(expect.objectContaining({ code: 'unauthorized' }))
    const rejected = manager.decide({
      proposalId: rejectedProposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'rejected',
      reason: 'not knowledge',
    })
    const expiring = manager.propose({ ...proposalInput('Expired'), idempotencyKey: 'wiki:create:expired', ttlMs: 1_000 })
    now += 1_000
    const expired = manager.decide({
      proposalId: expiring.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'too late',
    })

    expect(rejected.status).toBe('rejected')
    expect(expired.status).toBe('expired')
    expect(vault.list()).toEqual([])
    store.close()
    await ctx.fiber.restart()
  })

  test('approves create/update once and conflicts after an external edit', async () => {
    const { manager, vault, statePath, store, ctx } = await harness()
    const proposed = manager.propose(proposalInput())
    const approved = manager.decide({
      proposalId: proposed.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'reviewed',
    })
    expect(approved).toMatchObject({ status: 'approved', version: 2, page: { metadata: { title: 'Personal assistant' } } })
    expect(manager.decide({
      proposalId: proposed.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'reviewed',
    })).toEqual({ ...approved, replayed: true })

    const update = manager.propose({
      ...proposalInput(),
      idempotencyKey: 'wiki:update:assistant',
      mutation: {
        op: 'update' as const,
        pageId: approved.page!.metadata.id,
        expectedRevision: approved.page!.revision,
        input: pageInput('Reviewed assistant'),
      },
    })
    vault.updatePage(approved.page!.metadata.id, approved.page!.revision, pageInput('External edit'))
    const conflicted = manager.decide({
      proposalId: update.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'approved old diff',
    })
    expect(conflicted).toMatchObject({ status: 'conflicted', version: 2 })
    expect(vault.get(approved.page!.metadata.id)?.metadata.title).toBe('External edit')
    const audit = new DatabaseSync(statePath, { readOnly: true })
    expect(audit.prepare('SELECT status, result_page_id FROM wiki_audit ORDER BY sequence').all())
      .toEqual([
        { status: 'approved', result_page_id: approved.page!.metadata.id },
        { status: 'conflicted', result_page_id: null },
      ])
    audit.close()
    store.close()
    await ctx.fiber.restart()
  })

  test('rejects an existing title and conflicts if a title becomes occupied after review', async () => {
    const { manager, vault, store, ctx } = await harness()
    vault.createPage(pageInput('Existing title'))
    expect(() => manager.propose(proposalInput('Existing title')))
      .toThrowError(expect.objectContaining({ code: 'path-collision' }))

    const pending = manager.propose({ ...proposalInput('Reserved later'), idempotencyKey: 'wiki:create:reserved-later' })
    vault.createPage(pageInput('Reserved later'))
    const result = manager.decide({
      proposalId: pending.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'reviewed before collision',
    })
    expect(result).toMatchObject({ status: 'conflicted', version: 2 })
    expect(vault.list().filter(page => page.metadata.title === 'Reserved later')).toHaveLength(1)
    store.close()
    await ctx.fiber.restart()
  })

  test('recovers after either policy approval or the exact file write committed first', async () => {
    const first = await harness()
    const proposal = first.manager.propose(proposalInput('Recovered page'))
    const stored = first.store.get(proposal.proposalId)!
    first.policy.decideProposal({
      proposalId: stored.policyProposalId!,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'reviewed',
    })
    first.vault.applyPreparedWrite(proposal.write)
    first.store.close()
    await first.ctx.fiber.restart()

    const store = new WikiProposalStore({ path: first.statePath })
    const ctx = new Context()
    const policy = new AssistantPolicyService(ctx, { databasePath: first.policyPath, rules: [] })
    const vault = new WikiVault({ root: join(first.root, 'vault') })
    const manager = new WikiProposalManager(vault, store, policy)
    const recovered = manager.decide({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'reviewed',
    })

    expect(recovered).toMatchObject({ status: 'approved', version: 2, replayed: true })
    expect(vault.list()).toHaveLength(1)
    store.close()
    await ctx.fiber.restart()
  })

  test('refuses a future schema instead of downgrading it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-wiki-schema-'))
    temporaryRoots.push(root)
    const path = join(root, 'future.sqlite')
    const database = new DatabaseSync(path)
    database.exec('PRAGMA user_version = 99')
    database.close()
    await chmod(path, 0o600)

    expect(() => new WikiProposalStore({ path }))
      .toThrowError(expect.objectContaining<Partial<WikiProposalStoreError>>({ code: 'schema-too-new' }))
  })
})
