import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import {
  AssistantPolicyService,
  type ApprovalDispatchRoute,
  type ApprovalDispatchRouteV2,
  type ApprovalProposalSnapshot,
} from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test, vi } from 'vitest'
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

const v2Dispatch: ApprovalDispatchRouteV2 = {
  routeVersion: 2,
  sourceId: 'dsh-enhanced-personal-wiki',
  bindingId: 'binding-owner-dm',
  bindingVersion: 11,
  bindingGeneration: 4,
  workspace: '/work/alpha',
  principal: 'owner:lark:123',
  principalRecordId: 'principal-owner-record',
  principalVersion: 6,
}

describe('approval-gated wiki proposals', () => {
  test('round-trips the complete v2 dispatch through SQLite and Policy', async () => {
    const fixture = await harness()
    const recover = vi.spyOn(fixture.policy, 'recoverOrCreateProposal')
    const input = { ...proposalInput(), idempotencyKey: 'wiki:v2-roundtrip', dispatch: v2Dispatch }
    const created = fixture.manager.propose(input)

    expect(fixture.store.get(created.proposalId)?.dispatch).toStrictEqual(v2Dispatch)
    const raw = new DatabaseSync(fixture.statePath, { readOnly: true })
      .prepare('SELECT dispatch_json FROM wiki_proposals WHERE id = ?')
      .get(created.proposalId) as { dispatch_json: string }
    expect(JSON.parse(raw.dispatch_json)).toStrictEqual(v2Dispatch)
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ dispatch: v2Dispatch }))
    fixture.store.close()
    await fixture.ctx.fiber.restart()
  })

  test.each([
    ['bindingVersion', { bindingVersion: v2Dispatch.bindingVersion + 1 }],
    ['bindingGeneration', { bindingGeneration: v2Dispatch.bindingGeneration + 1 }],
    ['principalRecordId', { principalRecordId: `${v2Dispatch.principalRecordId}-other` }],
    ['principalVersion', { principalVersion: v2Dispatch.principalVersion + 1 }],
  ])('binds v2 %s into the proposal request hash', async (_field, changed) => {
    const fixture = await harness()
    const input = { ...proposalInput(), idempotencyKey: 'wiki:v2-hash', dispatch: v2Dispatch }
    fixture.manager.propose(input)
    expect(() => fixture.manager.propose({
      ...input,
      dispatch: { ...v2Dispatch, ...changed },
    })).toThrowError(expect.objectContaining<Partial<WikiProposalStoreError>>({
      code: 'idempotency-conflict',
    }))
    fixture.store.close()
    await fixture.ctx.fiber.restart()
  })

  test('preserves an exact legacy v1 database row without inventing authority fields', async () => {
    const fixture = await harness()
    const legacyDispatch: ApprovalDispatchRoute = {
      sourceId: v2Dispatch.sourceId,
      bindingId: v2Dispatch.bindingId,
      workspace: v2Dispatch.workspace,
      principal: v2Dispatch.principal,
    }
    const created = fixture.manager.propose({
      ...proposalInput(), idempotencyKey: 'wiki:v1-roundtrip', dispatch: v2Dispatch,
    })
    const database = new DatabaseSync(fixture.statePath)
    database.prepare('UPDATE wiki_proposals SET dispatch_json = ? WHERE id = ?')
      .run(JSON.stringify(legacyDispatch), created.proposalId)
    database.close()
    expect(fixture.store.get(created.proposalId)?.dispatch).toStrictEqual(legacyDispatch)
    fixture.store.close()
    await fixture.ctx.fiber.restart()
  })

  test('rejects a legacy v1 route at the new proposal boundary', async () => {
    const fixture = await harness()
    expect(() => fixture.manager.propose({
      ...proposalInput(),
      idempotencyKey: 'wiki:v1-write',
      dispatch: {
        sourceId: v2Dispatch.sourceId,
        bindingId: v2Dispatch.bindingId,
        workspace: v2Dispatch.workspace,
        principal: v2Dispatch.principal,
      } as ApprovalDispatchRouteV2,
    })).toThrowError(expect.objectContaining<Partial<WikiProposalStoreError>>({
      code: 'invalid-input',
    }))
    fixture.store.close()
    await fixture.ctx.fiber.restart()
  })

  test.each([
    ['missing fence', { ...v2Dispatch, principalVersion: undefined }],
    ['invalid version', { ...v2Dispatch, bindingVersion: 0 }],
    ['unknown key', { ...v2Dispatch, unexpected: true }],
  ])('rejects malformed stored v2 dispatch: %s', async (_case, malformed) => {
    const fixture = await harness()
    const created = fixture.manager.propose({
      ...proposalInput(), idempotencyKey: `wiki:v2-tamper:${_case}`, dispatch: v2Dispatch,
    })
    const database = new DatabaseSync(fixture.statePath)
    database.prepare('UPDATE wiki_proposals SET dispatch_json = ? WHERE id = ?')
      .run(JSON.stringify(malformed), created.proposalId)
    database.close()
    expect(() => fixture.store.get(created.proposalId))
      .toThrowError(expect.objectContaining<Partial<WikiProposalStoreError>>({ code: 'invalid-state' }))
    fixture.store.close()
    await fixture.ctx.fiber.restart()
  })

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
    const external = vault.get(approved.page!.metadata.id)!
    const restored = vault.updatePage(external.metadata.id, external.revision, pageInput())
    expect(restored.revision).toBe(approved.page!.revision)
    expect(() => manager.decide({
      proposalId: update.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'approved old diff',
    })).toThrowError(expect.objectContaining({ code: 'invalid-state' }))
    expect(vault.get(approved.page!.metadata.id)?.metadata.title).toBe('Personal assistant')
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

  test('commits an approval that policy settled after the originating turn', async () => {
    const { manager, vault, policy, store, ctx } = await harness()
    const proposal = manager.propose(proposalInput())

    // The owner decides on the policy ledger directly, as an approval card does,
    // without ever calling back into personal-wiki.
    policy.decideProposal({
      proposalId: proposal.policyProposalId!,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner confirmed on a card',
    })
    expect(vault.list()).toEqual([])

    const settled = manager.reconcile(50)

    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ proposalId: proposal.proposalId, status: 'approved' })
    expect(vault.list()).toHaveLength(1)
    // A second pass must not write the page twice or re-settle the proposal.
    expect(manager.reconcile(50)).toHaveLength(0)
    expect(vault.list()).toHaveLength(1)
    store.close()
    await ctx.fiber.restart()
  })

  test('leaves an undecided proposal pending instead of assuming approval', async () => {
    const { manager, vault, store, ctx } = await harness()
    manager.propose(proposalInput())

    expect(manager.reconcile(50)).toHaveLength(0)
    expect(vault.list()).toEqual([])
    store.close()
    await ctx.fiber.restart()
  })

  test('durably rotates reconcile pages so old pending rows cannot starve a later approval', async () => {
    let now = Date.parse('2026-08-20T00:00:00.000Z')
    const first = await harness(() => now)
    const proposals = []
    for (let index = 0; index < 4; index += 1) {
      proposals.push(first.manager.propose({
        ...proposalInput(`Fair proposal ${index}`),
        idempotencyKey: `wiki:fair:${index}`,
      }))
      now += 1
    }
    first.policy.decideProposal({
      proposalId: proposals[3]!.policyProposalId!,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'approve the row behind the first reconcile page',
    })

    expect(first.manager.reconcile(2)).toEqual([])
    first.store.close()
    await first.ctx.fiber.restart()

    const secondContext = new Context()
    const secondPolicy = new AssistantPolicyService(secondContext, {
      databasePath: first.policyPath,
      proposalMaintenanceIntervalMs: 0,
      rules: [],
    })
    const secondStore = new WikiProposalStore({ path: first.statePath })
    const secondVault = new WikiVault({ root: join(first.root, 'vault') })
    const secondManager = new WikiProposalManager(secondVault, secondStore, secondPolicy)

    expect(secondManager.reconcile(2)).toEqual([
      expect.objectContaining({ proposalId: proposals[3]!.proposalId, status: 'approved' }),
    ])
    expect(secondVault.list()).toHaveLength(1)
    secondStore.close()
    await secondContext.fiber.restart()
  })

  test('finishes a durable high-water cycle while same-millisecond proposals keep arriving', async () => {
    const now = Date.parse('2026-08-20T00:00:00.000Z')
    const fixture = await harness(() => now)
    // These stable keys order as c < e < h < a by local proposal id. The latter
    // two are inserted after the first cycle captures `a` as its high-water.
    const first = fixture.manager.propose({ ...proposalInput('Cycle C'), idempotencyKey: 'wiki:same:c' })
    fixture.manager.propose({ ...proposalInput('Cycle A'), idempotencyKey: 'wiki:same:a' })

    // A is observed pending in this cycle, then becomes approved behind the cursor.
    expect(fixture.manager.reconcile(1)).toEqual([])
    fixture.policy.decideProposal({
      proposalId: first.policyProposalId!, principal: 'owner:lark:123', expectedVersion: 1,
      decision: 'approved', reason: 'approved after its first scan',
    })

    fixture.manager.propose({ ...proposalInput('Cycle E'), idempotencyKey: 'wiki:same:e' })
    expect(fixture.manager.reconcile(1)).toEqual([])
    fixture.manager.propose({ ...proposalInput('Cycle H'), idempotencyKey: 'wiki:same:h' })

    expect(fixture.manager.reconcile(1)).toEqual([
      expect.objectContaining({ proposalId: first.proposalId, status: 'approved' }),
    ])
    expect(fixture.vault.list()).toHaveLength(1)
    fixture.store.close()
    await fixture.ctx.fiber.restart()
  })

  test('turns every immutable terminal snapshot mismatch into a durable conflict without touching the vault', async () => {
    const tamperCases: Array<[string, (snapshot: ApprovalProposalSnapshot) => ApprovalProposalSnapshot]> = [
      ['proposal id', snapshot => ({ ...snapshot, proposalId: `${snapshot.proposalId}-forged` })],
      ['requester', snapshot => ({ ...snapshot, requester: 'agent:attacker' })],
      ['principal', snapshot => ({ ...snapshot, principal: 'owner:lark:attacker' })],
      ['action', snapshot => ({ ...snapshot, action: 'wiki.update' })],
      ['resource kind', snapshot => ({ ...snapshot, resource: { ...snapshot.resource, kind: 'memory' } })],
      ['resource id', snapshot => ({ ...snapshot, resource: { ...snapshot.resource, id: 'forged-page' } })],
      ['summary', snapshot => ({ ...snapshot, summary: 'A different operation' })],
      ['diff hash', snapshot => ({ ...snapshot, diffHash: '0'.repeat(64) })],
      ['expiry', snapshot => ({ ...snapshot, expiresAt: snapshot.expiresAt + 1 })],
      ['version', snapshot => ({ ...snapshot, version: snapshot.version + 1 })],
      ['decider', snapshot => ({ ...snapshot, decidedBy: 'owner:lark:attacker' })],
    ]

    for (const [label, tamper] of tamperCases) {
      const fixture = await harness()
      let mutate = (snapshot: ApprovalProposalSnapshot) => snapshot
      const guardedPolicy = {
        recoverOrCreateProposal: fixture.policy.recoverOrCreateProposal.bind(fixture.policy),
        decideProposal: fixture.policy.decideProposal.bind(fixture.policy),
        getProposal(proposalId: string) {
          const snapshot = fixture.policy.getProposal(proposalId)
          return snapshot === undefined ? undefined : mutate(snapshot)
        },
      }
      const manager = new WikiProposalManager(fixture.vault, fixture.store, guardedPolicy)
      const proposed = manager.propose({
        ...proposalInput(`Tamper ${label}`),
        idempotencyKey: `wiki:tamper:${label}`,
      })
      fixture.policy.decideProposal({
        proposalId: proposed.policyProposalId!,
        principal: 'owner:lark:123',
        expectedVersion: 1,
        decision: 'approved',
        reason: 'owner approved the exact page',
      })
      mutate = tamper

      const settled = manager.reconcile(50)

      expect(settled, label).toHaveLength(1)
      expect(settled[0], label).toMatchObject({ status: 'conflicted', version: 2 })
      expect(fixture.store.get(proposed.proposalId), label).toMatchObject({ status: 'conflicted', version: 2 })
      expect(fixture.vault.list(), label).toEqual([])
      fixture.store.close()
      await fixture.ctx.fiber.restart()
    }
  })

  test('validates direct decisions through the same settlement gate', async () => {
    const fixture = await harness()
    const guardedPolicy = {
      recoverOrCreateProposal: fixture.policy.recoverOrCreateProposal.bind(fixture.policy),
      decideProposal: fixture.policy.decideProposal.bind(fixture.policy),
      getProposal(proposalId: string) {
        const snapshot = fixture.policy.getProposal(proposalId)
        return snapshot === undefined ? undefined : { ...snapshot, action: 'wiki.forged' }
      },
    }
    const manager = new WikiProposalManager(fixture.vault, fixture.store, guardedPolicy)
    const proposed = manager.propose({ ...proposalInput('Direct tamper'), idempotencyKey: 'wiki:direct-tamper' })

    const settled = manager.decide({
      proposalId: proposed.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner approved',
    })

    expect(settled).toMatchObject({ status: 'conflicted', version: 2 })
    expect(fixture.vault.list()).toEqual([])
    fixture.store.close()
    await fixture.ctx.fiber.restart()
  })

  test('does not wait forever when an attached terminal Policy record disappears', async () => {
    const fixture = await harness()
    const guardedPolicy = {
      recoverOrCreateProposal: fixture.policy.recoverOrCreateProposal.bind(fixture.policy),
      decideProposal: fixture.policy.decideProposal.bind(fixture.policy),
      getProposal: () => undefined,
    }
    const manager = new WikiProposalManager(fixture.vault, fixture.store, guardedPolicy)
    const proposed = manager.propose({ ...proposalInput('Missing snapshot'), idempotencyKey: 'wiki:missing-snapshot' })
    fixture.policy.decideProposal({
      proposalId: proposed.policyProposalId!,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner approved',
    })

    expect(manager.reconcile(50)).toEqual([
      expect.objectContaining({ status: 'conflicted', version: 2 }),
    ])
    expect(fixture.vault.list()).toEqual([])
    fixture.store.close()
    await fixture.ctx.fiber.restart()
  })

  test('commits one exact approved snapshot once after restart', async () => {
    const first = await harness()
    const proposed = first.manager.propose({
      ...proposalInput('Restart approval'),
      idempotencyKey: 'wiki:restart-approval',
    })
    first.policy.decideProposal({
      proposalId: proposed.policyProposalId!,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'approved while the domain was offline',
    })
    first.store.close()
    await first.ctx.fiber.restart()

    const secondContext = new Context()
    const secondPolicy = new AssistantPolicyService(secondContext, {
      databasePath: first.policyPath,
      proposalMaintenanceIntervalMs: 0,
      rules: [],
    })
    const secondStore = new WikiProposalStore({ path: first.statePath })
    const secondVault = new WikiVault({ root: join(first.root, 'vault') })
    const secondManager = new WikiProposalManager(secondVault, secondStore, secondPolicy)

    expect(secondManager.reconcile(50)).toEqual([
      expect.objectContaining({ proposalId: proposed.proposalId, status: 'approved', version: 2 }),
    ])
    expect(secondManager.reconcile(50)).toEqual([])
    expect(secondVault.list()).toHaveLength(1)
    secondStore.close()
    await secondContext.fiber.restart()

    const thirdContext = new Context()
    const thirdPolicy = new AssistantPolicyService(thirdContext, {
      databasePath: first.policyPath,
      proposalMaintenanceIntervalMs: 0,
      rules: [],
    })
    const thirdStore = new WikiProposalStore({ path: first.statePath })
    const thirdVault = new WikiVault({ root: join(first.root, 'vault') })
    const thirdManager = new WikiProposalManager(thirdVault, thirdStore, thirdPolicy)
    expect(thirdManager.reconcile(50)).toEqual([])
    expect(thirdVault.list()).toHaveLength(1)
    thirdStore.close()
    await thirdContext.fiber.restart()
  })

  test('recovers if Policy committed and was approved before the local attachment committed', async () => {
    let now = Date.parse('2026-08-20T00:00:00.000Z')
    const fixture = await harness(() => now)
    const input = {
      ...proposalInput('Cross-database recovery'),
      idempotencyKey: 'wiki:cross-database-recovery',
      dispatch: v2Dispatch,
    }
    let policyProposalId: string | undefined
    const crashingPolicy = {
      recoverOrCreateProposal(policyInput: Parameters<AssistantPolicyService['recoverOrCreateProposal']>[0]) {
        const recovered = fixture.policy.recoverOrCreateProposal(policyInput)
        if (recovered.kind === 'proposal') policyProposalId = recovered.proposal.proposalId
        throw new Error('simulated crash after Policy commit')
      },
      decideProposal: fixture.policy.decideProposal.bind(fixture.policy),
      getProposal: fixture.policy.getProposal.bind(fixture.policy),
    }
    const crashingManager = new WikiProposalManager(fixture.vault, fixture.store, crashingPolicy, () => now)

    expect(() => crashingManager.propose(input)).toThrow('simulated crash after Policy commit')
    const [durableIntent] = fixture.store.listPending(10)
    expect(durableIntent).toMatchObject({ ttlMs: 60_000, dispatch: input.dispatch })
    expect(durableIntent).not.toHaveProperty('policyProposalId')
    fixture.policy.decideProposal({
      proposalId: policyProposalId!,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner approved while wiki was restarting',
    })
    now += 60_001
    expect(now).toBeGreaterThan(durableIntent!.expiresAt)
    fixture.store.close()
    await fixture.ctx.fiber.restart()

    const recoveredContext = new Context()
    const recoveredPolicy = new AssistantPolicyService(recoveredContext, {
      databasePath: fixture.policyPath,
      proposalMaintenanceIntervalMs: 0,
      rules: [],
    }, { now: () => now })
    const recoveredStore = new WikiProposalStore({ path: fixture.statePath })
    const recoveredVault = new WikiVault({ root: join(fixture.root, 'vault') })
    const recoveredManager = new WikiProposalManager(
      recoveredVault,
      recoveredStore,
      recoveredPolicy,
      () => now,
    )
    expect(recoveredManager.reconcile(50)).toEqual([
      expect.objectContaining({ status: 'approved', version: 2 }),
    ])
    expect(recoveredManager.reconcile(50)).toEqual([])
    expect(recoveredVault.list()).toHaveLength(1)
    recoveredStore.close()
    await recoveredContext.fiber.restart()
  })

  test('atomically recovers an existing Policy proposal when legacy replay metadata is missing', async () => {
    const fixture = await harness()
    const proposed = fixture.manager.propose({
      ...proposalInput('Legacy lookup recovery'),
      idempotencyKey: 'wiki:legacy-lookup-recovery',
    })
    const interrupted = new DatabaseSync(fixture.statePath)
    interrupted.prepare(`
      UPDATE wiki_proposals
      SET policy_proposal_id = NULL, ttl_ms = NULL, dispatch_json = NULL
      WHERE id = ?
    `).run(proposed.proposalId)
    interrupted.close()
    fixture.policy.decideProposal({
      proposalId: proposed.policyProposalId!,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'approved before legacy wiki recovery',
    })

    expect(fixture.manager.reconcile(50)).toEqual([
      expect.objectContaining({ proposalId: proposed.proposalId, status: 'approved', version: 2 }),
    ])
    expect(fixture.vault.list()).toHaveLength(1)
    fixture.store.close()
    await fixture.ctx.fiber.restart()
  })

  test('never resurrects a pre-Policy intent after its local approval deadline', async () => {
    let now = Date.parse('2026-08-20T00:00:00.000Z')
    const fixture = await harness(() => now)
    const unavailablePolicy = {
      recoverOrCreateProposal: () => { throw new Error('Policy unavailable before commit') },
      decideProposal: fixture.policy.decideProposal.bind(fixture.policy),
      getProposal: fixture.policy.getProposal.bind(fixture.policy),
    }
    const firstManager = new WikiProposalManager(fixture.vault, fixture.store, unavailablePolicy, () => now)
    const input = {
      ...proposalInput('Expired local intent'),
      idempotencyKey: 'wiki:expired-local-intent',
      dispatch: v2Dispatch,
    }
    expect(() => firstManager.propose(input)).toThrow('Policy unavailable before commit')
    now += 60_001

    const recoveredManager = new WikiProposalManager(fixture.vault, fixture.store, fixture.policy, () => now)
    const [conflicted] = recoveredManager.reconcile(50)
    expect(conflicted).toEqual(expect.objectContaining({ status: 'conflicted', version: 2 }))
    expect(recoveredManager.propose(input)).toEqual({ ...conflicted!, replayed: true })
    expect(fixture.policy.listPendingApprovalDispatches()).toEqual([])
    expect(fixture.vault.list()).toEqual([])
    fixture.store.close()
    await fixture.ctx.fiber.restart()
  })

  test('atomically abandons a two-connection deadline race without orphaning an approval dispatch', async () => {
    let now = Date.parse('2026-08-20T00:00:00.000Z')
    const fixture = await harness(() => now)
    const input = {
      ...proposalInput('Atomic deadline race'),
      idempotencyKey: 'wiki:atomic-deadline-race',
      dispatch: v2Dispatch,
    }
    const unavailablePolicy = {
      recoverOrCreateProposal: () => { throw new Error('Policy unavailable before commit') },
      decideProposal: fixture.policy.decideProposal.bind(fixture.policy),
      getProposal: fixture.policy.getProposal.bind(fixture.policy),
    }
    const initialManager = new WikiProposalManager(fixture.vault, fixture.store, unavailablePolicy, () => now)
    expect(() => initialManager.propose(input)).toThrow('Policy unavailable before commit')
    const [intent] = fixture.store.listPending(10)
    if (intent === undefined) throw new Error('expected durable wiki intent')
    now = intent.expiresAt - 1

    const secondContext = new Context()
    const secondPolicy = new AssistantPolicyService(secondContext, {
      databasePath: fixture.policyPath,
      proposalMaintenanceIntervalMs: 0,
      rules: [],
    }, { now: () => now })
    const secondStore = new WikiProposalStore({ path: fixture.statePath, now: () => now })
    const secondVault = new WikiVault({ root: join(fixture.root, 'vault'), now: () => now })
    const secondManager = new WikiProposalManager(secondVault, secondStore, secondPolicy, () => now)

    let interleaved = false
    const crossDeadline = () => {
      if (interleaved) return
      interleaved = true
      now = intent.expiresAt
      secondManager.reconcile(50)
    }
    let ordinaryProposeCalls = 0
    let diagnosticLookupCalls = 0
    const racingPolicy = {
      propose(policyInput: Parameters<AssistantPolicyService['propose']>[0]) {
        ordinaryProposeCalls += 1
        crossDeadline()
        return fixture.policy.propose(policyInput)
      },
      recoverOrCreateProposal(policyInput: Parameters<AssistantPolicyService['recoverOrCreateProposal']>[0]) {
        crossDeadline()
        return fixture.policy.recoverOrCreateProposal(policyInput)
      },
      decideProposal: fixture.policy.decideProposal.bind(fixture.policy),
      getProposalByIdempotencyKey(policyInput: Parameters<AssistantPolicyService['getProposalByIdempotencyKey']>[0]) {
        diagnosticLookupCalls += 1
        return fixture.policy.getProposalByIdempotencyKey(policyInput)
      },
      getProposal: fixture.policy.getProposal.bind(fixture.policy),
    }
    const racingManager = new WikiProposalManager(fixture.vault, fixture.store, racingPolicy, () => now)

    racingManager.reconcile(50)

    expect(fixture.store.get(intent.proposalId)).toMatchObject({ status: 'conflicted', version: 2 })
    expect(ordinaryProposeCalls).toBe(0)
    expect(diagnosticLookupCalls).toBe(0)
    expect(fixture.policy.listPendingApprovalDispatches()).toEqual([])
    const inspected = new DatabaseSync(fixture.policyPath, { readOnly: true })
    const counts = inspected.prepare(`
      SELECT
        (SELECT COUNT(*) FROM approval_proposals) AS proposals,
        (SELECT COUNT(*) FROM approval_dispatches) AS dispatches,
        (SELECT COUNT(*) FROM approval_idempotency_tombstones) AS tombstones
    `).get() as { proposals: number; dispatches: number; tombstones: number }
    inspected.close()
    expect(counts).toEqual({ proposals: 0, dispatches: 0, tombstones: 1 })

    secondStore.close()
    await secondContext.fiber.restart()
    fixture.store.close()
    await fixture.ctx.fiber.restart()
  })

  test('migrates v1 state without inventing an approval recovery route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-wiki-v1-migration-'))
    temporaryRoots.push(root)
    const path = join(root, 'wiki.sqlite')
    const initial = new WikiProposalStore({ path })
    initial.close()
    const legacy = new DatabaseSync(path)
    legacy.prepare(`
      INSERT INTO wiki_proposals(
        id, policy_proposal_id, idempotency_key, requester, principal, request_hash,
        write_hash, write_json, status, expires_at, result_page_id, created_at, updated_at, version
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, 1)
    `).run(
      'legacy-pending', 'legacy-key', 'agent:legacy', 'owner:legacy', 'request-hash', 'write-hash',
      JSON.stringify({
        op: 'create', pageId: 'legacy-page', relativePath: 'wiki/concepts/legacy.md',
        markdown: 'legacy', targetRevision: 'a'.repeat(64),
      }),
      2_000, 1_000, 1_000,
    )
    legacy.exec(`
      DROP TABLE wiki_reconcile_cursor;
      ALTER TABLE wiki_proposals DROP COLUMN dispatch_json;
      ALTER TABLE wiki_proposals DROP COLUMN ttl_ms;
      PRAGMA user_version = 1;
    `)
    legacy.close()

    const migrated = new WikiProposalStore({ path })
    const legacyProposal = migrated.get('legacy-pending')
    migrated.close()
    const inspected = new DatabaseSync(path, { readOnly: true })
    const version = inspected.prepare('PRAGMA user_version').get() as { user_version: number }
    const fields = inspected.prepare('PRAGMA table_info(wiki_proposals)').all() as unknown as Array<{ name: string }>
    inspected.close()

    expect(version.user_version).toBe(4)
    expect(fields.map(field => field.name)).toEqual(expect.arrayContaining(['ttl_ms', 'dispatch_json']))
    expect(legacyProposal).not.toHaveProperty('ttlMs')
    expect(legacyProposal).not.toHaveProperty('dispatch')
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
