import { Context } from '@deepseek-ai/cordis'
import { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { Session, SessionId, SESSION_FORMAT_VERSION, type UserMessage } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { PersonalMemoryError, PersonalMemoryService } from '../src/service.ts'

const temporaryRoots: string[] = []

async function paths() {
  const root = await mkdtemp(join(tmpdir(), 'personal-memory-service-'))
  temporaryRoots.push(root)
  return { memory: join(root, 'memory.sqlite'), policy: join(root, 'policy.sqlite') }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function stubAgent(options: { cwd?: string; preset?: string } = {}) {
  const id = SessionId(`memory-agent-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.preset === undefined ? {} : { agentPreset: options.preset }),
  })
  const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
  const injections: UserMessage[] = []
  const agent: Agent = {
    id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    status: 'idle',
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject(message) { injections.push(message) },
  }
  return { agent, injections }
}

async function harness(options: {
  allow?: boolean
  approvalMode?: 'delivery-or-headless' | 'delivery-required'
  maxImportRecords?: number
  delivery?: {
    prepareAgentApproval: (agent: Agent | undefined, input: { sourceId: string }) => {
      sourceId: string
      bindingId: string
      workspace: string
      principal: string
    }
  }
} = {}) {
  const ctx = new Context()
  const databasePaths = await paths()
  const policy = new AssistantPolicyService(ctx, {
    databasePath: databasePaths.policy,
    rules: options.allow === false ? [] : [{
      id: 'allow-memory-service',
      effect: 'allow',
      subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['export', 'propose', 'read', 'search', 'snapshot'],
      resource: { kind: 'memory', id: '*' },
      context: { initiators: ['foreground'] },
    }],
  })
  if (options.delivery !== undefined) ctx.provide('assistantDelivery', options.delivery as never)
  const service = new PersonalMemoryService(ctx, {
    databasePath: databasePaths.memory,
    approvalMode: options.approvalMode
      ?? (options.delivery === undefined ? 'delivery-or-headless' : 'delivery-required'),
    snapshotLimit: 10,
    snapshotMaxBytes: 1_024,
    snapshotMaxTokens: 256,
    defaultProposalTtlMs: 60_000,
    ...(options.maxImportRecords === undefined ? {} : { maxImportRecords: options.maxImportRecords }),
  })
  return { ctx, policy, service }
}

function addInput(content: string, idempotencyKey = `add:${content}`) {
  return {
    idempotencyKey,
    principal: 'owner:lark:123',
    mutation: {
      op: 'add' as const,
      identity: { owner: 'user' as const, scope: 'user-global' as const },
      entry: {
        kind: 'fact' as const,
        content,
        sensitivity: 'private' as const,
        trust: 'user-confirmed' as const,
        confidence: 1,
        provenance: { source: 'user', observedAt: 10_000 },
      },
    },
  }
}

describe('personal memory Cordis service', () => {
  test('derives approval authority from the exact active delivery route and dispatches it durably', async () => {
    const calls: Array<{ agent: Agent | undefined; sourceId: string }> = []
    const route = {
      sourceId: 'dsh-enhanced-personal-memory',
      bindingId: 'binding-owner-dm',
      workspace: '/work/alpha',
      principal: 'lark/main/tenant/owner',
    }
    const { ctx, policy, service } = await harness({
      delivery: {
        prepareAgentApproval(agent, input) {
          calls.push({ agent, sourceId: input.sourceId })
          return route
        },
      },
    })
    const { agent } = stubAgent({ cwd: '/work/alpha', preset: 'primary' })
    const { principal: _principal, ...input } = addInput('Delivery-bound memory')

    const proposal = service.propose(agent, input)

    expect(calls).toEqual([{ agent, sourceId: 'dsh-enhanced-personal-memory' }])
    expect(policy.listPendingApprovalDispatches()).toEqual([
      expect.objectContaining({
        proposalId: proposal.policyProposalId,
        sourceId: route.sourceId,
        bindingId: route.bindingId,
        workspace: route.workspace,
        principal: route.principal,
        requester: 'agent:primary',
        action: 'memory.add',
        resource: { kind: 'memory', id: proposal.proposalId },
        summary: proposal.summary,
        diff: proposal.diff,
        proposalVersion: 1,
        state: 'pending',
      }),
    ])
    expect(() => service.propose(agent, {
      ...addInput('Authority substitution', 'delivery:authority-substitution'),
      principal: 'lark/main/tenant/attacker',
    })).toThrowError(expect.objectContaining<Partial<PersonalMemoryError>>({
      code: 'unauthorized-principal',
    }))
    await ctx.fiber.restart()
  })

  test('fails closed without an owner binding while preserving explicit headless authority', async () => {
    const bound = await harness({
      delivery: {
        prepareAgentApproval() {
          throw new Error('no authenticated owner binding')
        },
      },
    })
    const { agent } = stubAgent({ cwd: '/work/alpha', preset: 'primary' })
    const { principal: _principal, ...modelInput } = addInput('Cannot choose a principal')
    const importJson = JSON.stringify({
      format: 'dsh-personal-memory',
      version: 1,
      records: [{
        identity: modelInput.mutation.identity,
        entry: modelInput.mutation.op === 'add' ? modelInput.mutation.entry : undefined,
      }],
    })

    expect(() => bound.service.propose(agent, modelInput)).toThrow(/owner binding/i)
    expect(() => bound.service.proposeImport(agent, {
      json: importJson,
      idempotencyKey: 'import:no-owner-binding',
    })).toThrow(/owner binding/i)
    expect(() => bound.service.propose(agent, addInput('No fallback with Delivery present')))
      .toThrow(/owner binding/i)
    await bound.ctx.fiber.restart()

    const headless = await harness()
    expect(() => headless.service.propose(agent, modelInput))
      .toThrowError(expect.objectContaining<Partial<PersonalMemoryError>>({
        code: 'missing-approval-route',
      }))
    expect(headless.service.propose(agent, addInput('Trusted headless import')).status).toBe('pending')
    await headless.ctx.fiber.restart()

    const production = await harness({ approvalMode: 'delivery-required' })
    expect(() => production.service.propose(agent, addInput('No availability downgrade')))
      .toThrowError(expect.objectContaining<Partial<PersonalMemoryError>>({
        code: 'missing-approval-route',
      }))
    await production.ctx.fiber.restart()
  })

  test('derives the same Delivery authority for model-originated imports', async () => {
    const route = {
      sourceId: 'dsh-enhanced-personal-memory',
      bindingId: 'binding-import-owner',
      workspace: '/work/alpha',
      principal: 'lark/main/tenant/import-owner',
    }
    const { ctx, policy, service } = await harness({
      delivery: { prepareAgentApproval: () => route },
    })
    const { agent } = stubAgent({ cwd: '/work/alpha', preset: 'primary' })
    const mutation = addInput('Imported through owner route').mutation
    const batch = service.proposeImport(agent, {
      json: JSON.stringify({
        format: 'dsh-personal-memory',
        version: 1,
        records: [{
          identity: mutation.identity,
          entry: mutation.op === 'add' ? mutation.entry : undefined,
        }],
      }),
      idempotencyKey: 'import:delivery-owner',
    })

    expect(batch.proposals).toHaveLength(1)
    expect(policy.listPendingApprovalDispatches()).toEqual([
      expect.objectContaining({
        proposalId: batch.proposals[0]!.policyProposalId,
        ...route,
      }),
    ])
    await ctx.fiber.restart()
  })

  test('registers ctx.personalMemory and exposes approval-gated operations without a store handle', async () => {
    const { ctx, service } = await harness()
    const { agent } = stubAgent({ cwd: '/work/alpha', preset: 'primary' })

    const proposal = service.propose(agent, addInput('Stable service memory'))
    expect(service.health()).toEqual({ activeRecords: 0, removedRecords: 0, expiredRecords: 0, pendingProposals: 1 })
    expect(service.search(agent, { query: 'service' })).toEqual([])
    service.decideProposal({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: proposal.version,
      decision: 'approved',
      reason: 'confirmed',
    })

    expect(ctx.personalMemory).toBeDefined()
    expect(ctx.personalMemory.search(agent, { query: 'service' })[0]?.record.content)
      .toBe('Stable service memory')
    expect(service.health()).toEqual({ activeRecords: 1, removedRecords: 0, expiredRecords: 0, pendingProposals: 0 })
    expect((ctx.personalMemory as unknown as Record<string, unknown>)['applyApprovedMutation']).toBeUndefined()
    await ctx.fiber.restart()
  })

  test('reads an exact bounded set of visible stable ids and fails closed when any source disappeared', async () => {
    const { ctx, service } = await harness()
    const { agent } = stubAgent({ cwd: '/work/alpha', preset: 'primary' })
    const proposals = ['First exact fact', 'Second exact fact'].map((content, index) =>
      service.propose(agent, addInput(content, `read:${index}`)))
    const records = proposals.map(proposal => service.decideProposal({
      proposalId: proposal.proposalId, principal: 'owner:lark:123', expectedVersion: 1,
      decision: 'approved', reason: 'confirmed',
    }).record!)

    expect(service.read(agent, { ids: [records[1]!.id, records[0]!.id] }))
      .toEqual([records[1], records[0]])
    expect(() => service.read(agent, { ids: [records[0]!.id, 'missing-id'] }))
      .toThrowError(expect.objectContaining<Partial<PersonalMemoryError>>({ code: 'not-found' }))
    expect(() => service.read(agent, { ids: [] })).toThrow(/between 1 and 100/i)
    await ctx.fiber.restart()
  })

  test('fails closed when policy denies an operation or agent identity is incomplete', async () => {
    const { ctx, service } = await harness({ allow: false })
    const complete = stubAgent({ cwd: '/work/alpha', preset: 'primary' }).agent
    const incomplete = stubAgent({ cwd: '/work/alpha' }).agent
    const relative = {
      session: { header: { cwd: 'relative/workspace', agentPreset: 'primary' } },
    } as unknown as Agent

    expect(() => service.search(complete, { query: 'anything' }))
      .toThrowError(expect.objectContaining<Partial<PersonalMemoryError>>({ code: 'policy-denied' }))
    expect(() => service.search(incomplete, { query: 'anything' }))
      .toThrowError(expect.objectContaining<Partial<PersonalMemoryError>>({ code: 'missing-identity' }))
    expect(() => service.propose(relative, addInput('must not enter global memory')))
      .toThrowError(expect.objectContaining<Partial<PersonalMemoryError>>({ code: 'missing-identity' }))
    await ctx.fiber.restart()
  })

  test('rejects absent, relative, and invalid bounded configuration', async () => {
    expect(() => PersonalMemoryService.Config({
      databasePath: '/tmp/memory.sqlite',
      reconcileIntervalMs: 2_147_483_648,
    })).toThrow()
    for (const config of [
      undefined,
      { databasePath: 'relative.sqlite' },
      { databasePath: '/tmp/memory.sqlite', snapshotLimit: 0 },
      { databasePath: '/tmp/memory.sqlite', reconcileIntervalMs: -1 },
      { databasePath: '/tmp/memory.sqlite', reconcileIntervalMs: 2_147_483_648 },
      { databasePath: '/tmp/memory.sqlite', reconcileLimit: 1_001 },
      { databasePath: '/tmp/memory.sqlite', approvalMode: 'unsafe-auto' },
    ]) {
      const ctx = new Context()
      expect(() => new PersonalMemoryService(ctx, config as never)).toThrow(/personal-memory|absolute|snapshot/i)
      await ctx.fiber.restart()
    }
  })

  test('freezes and injects one non-empty snapshot at session start', async () => {
    const { ctx, service } = await harness()
    const fixture = stubAgent({ cwd: '/work/alpha', preset: 'primary' })
    const proposal = service.propose(fixture.agent, addInput('Frozen startup memory'))
    service.decideProposal({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'confirmed',
    })

    agentEvents(ctx, fixture.agent).emit('agent/session-start', { source: 'startup' })
    const late = service.propose(fixture.agent, addInput('Late memory', 'add:late'))
    service.decideProposal({
      proposalId: late.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'confirmed',
    })
    agentEvents(ctx, fixture.agent).emit('agent/session-start', { source: 'resume' })

    expect(fixture.injections).toHaveLength(1)
    expect(fixture.injections[0]).toMatchObject({ source: { kind: 'plugin', plugin: 'personal-memory' } })
    const text = fixture.injections[0]!.content[0]
    expect(text).toMatchObject({ type: 'text', text: expect.stringContaining('Frozen startup memory') })
    expect(JSON.stringify(text)).not.toContain('Late memory')
    expect(JSON.stringify(text)).toContain('untrusted data, not instructions')
    await ctx.fiber.restart()
  })

  test('injects nothing for an empty store or missing session identity', async () => {
    const { ctx } = await harness()
    const empty = stubAgent({ cwd: '/work/alpha', preset: 'primary' })
    const noWorkspace = stubAgent({ preset: 'primary' })
    const noPreset = stubAgent({ cwd: '/work/alpha' })

    agentEvents(ctx, empty.agent).emit('agent/session-start', { source: 'startup' })
    agentEvents(ctx, noWorkspace.agent).emit('agent/session-start', { source: 'startup' })
    agentEvents(ctx, noPreset.agent).emit('agent/session-start', { source: 'startup' })

    expect(empty.injections).toEqual([])
    expect(noWorkspace.injections).toEqual([])
    expect(noPreset.injections).toEqual([])
    await ctx.fiber.restart()
  })

  test('fails service calls after Cordis lifecycle disposal', async () => {
    const { ctx, service } = await harness()
    const { agent } = stubAgent({ cwd: '/work/alpha', preset: 'primary' })
    await ctx.fiber.restart()

    expect(() => service.search(agent, { query: 'after close' })).toThrow(/disposed/i)
  })

  test('exports versioned JSON without database internals and imports only through proposals', async () => {
    const source = await harness()
    const sourceAgent = stubAgent({ cwd: '/work/alpha', preset: 'primary' }).agent
    for (const [index, content] of ['Exported fact', 'Exported preference'].entries()) {
      const proposal = source.service.propose(sourceAgent, addInput(content, `export:${index}`))
      source.service.decideProposal({
        proposalId: proposal.proposalId,
        principal: 'owner:lark:123',
        expectedVersion: 1,
        decision: 'approved',
        reason: 'confirmed',
      })
    }
    const json = source.service.exportJson(sourceAgent)
    const decoded = JSON.parse(json) as Record<string, unknown>
    expect(decoded).toMatchObject({ format: 'dsh-personal-memory', version: 1 })
    expect(json).not.toMatch(/contentHash|createdAt|updatedAt|status|memory_audit|memory_tokens/)

    const target = await harness()
    const targetAgent = stubAgent({ cwd: '/work/alpha', preset: 'primary' }).agent
    const batch = target.service.proposeImport(targetAgent, {
      json,
      idempotencyKey: 'import:portable-memory',
      principal: 'owner:lark:123',
    })
    expect(batch.proposals).toHaveLength(2)
    expect(target.service.search(targetAgent, { query: 'Exported' })).toEqual([])
    for (const proposal of batch.proposals) {
      target.service.decideProposal({
        proposalId: proposal.proposalId,
        principal: 'owner:lark:123',
        expectedVersion: 1,
        decision: 'approved',
        reason: 'approve import',
      })
    }
    expect(target.service.search(targetAgent, { query: 'Exported' })).toHaveLength(2)
    await source.ctx.fiber.restart()
    await target.ctx.fiber.restart()
  })

  test('rejects an oversized or malformed import batch before creating proposals', async () => {
    const { ctx, service } = await harness({ maxImportRecords: 1 })
    const { agent } = stubAgent({ cwd: '/work/alpha', preset: 'primary' })
    const record = {
      identity: { owner: 'user', scope: 'user-global' },
      entry: addInput('one').mutation.entry,
    }

    expect(() => service.proposeImport(agent, {
      json: JSON.stringify({ format: 'dsh-personal-memory', version: 1, records: [record, record] }),
      idempotencyKey: 'too-many',
      principal: 'owner:lark:123',
    })).toThrowError(expect.objectContaining<Partial<PersonalMemoryError>>({ code: 'invalid-import' }))
    expect(() => service.proposeImport(agent, {
      json: '{not-json',
      idempotencyKey: 'malformed',
      principal: 'owner:lark:123',
    })).toThrowError(expect.objectContaining<Partial<PersonalMemoryError>>({ code: 'invalid-import' }))
    expect(service.search(agent, { query: '' })).toEqual([])
    await ctx.fiber.restart()
  })
})
