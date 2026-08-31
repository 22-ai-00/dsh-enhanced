import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  AssistantPolicyService,
  setApprovalReviewer,
  type ApprovalDispatchRoute,
  type ApprovalProposalSnapshot,
} from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantEvolutionService } from '../src/service.ts'
import {
  installQualityFixtures,
  projectTrustedOutcome,
  type FakeAutomationQualityResolver,
} from './quality-fixture.ts'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import type {
  DeliveryPresentationUpdate,
  TrustedDeliveryPresentationRegistration,
} from '@dsh-enhanced/assistant-delivery'

const APPROVAL_SOURCE = 'dsh-enhanced-assistant-evolution'
const OWNER = 'lark/bot-1/tenant-a/ou_owner'
const WORKSPACE = '/work/alpha'
const PRESET = 'primary'
const roots: string[] = []
const contexts = new Set<Context>()

const policyRules = [
  {
    id: 'allow-evolution-service',
    effect: 'allow' as const,
    subject: { kind: 'agent' as const, id: PRESET, workspace: WORKSPACE },
    actions: ['append', 'inspect', 'snapshot'],
    resource: { kind: 'evolution' as const, id: '*' },
    context: { initiators: ['foreground' as const] },
  },
  {
    id: 'allow-evolution-proposals',
    effect: 'allow' as const,
    subject: { kind: 'agent' as const, id: PRESET, workspace: WORKSPACE },
    actions: ['propose'],
    resource: { kind: 'evolution' as const, id: 'proposals' },
    context: { initiators: ['foreground' as const] },
  },
  {
    id: 'allow-evolution-tools',
    effect: 'allow' as const,
    subject: { kind: 'agent' as const, id: PRESET, workspace: WORKSPACE },
    actions: ['execute'],
    resource: { kind: 'tool' as const, id: 'evolution_*' },
    context: { initiators: ['foreground' as const] },
  },
]

interface Harness {
  ctx: Context
  root: string
  policyPath: string
  evolutionPath: string
  policy: AssistantPolicyService
  service: AssistantEvolutionService
  evaluation: AssistantEvaluationService
  qualityResolver: FakeAutomationQualityResolver
  prepareAgentApproval: ReturnType<typeof vi.fn>
  publishDeliveryPresentation: ReturnType<typeof vi.fn>
}

function installPresentationSink(
  service: AssistantEvolutionService,
  publish: (input: unknown) => unknown,
): () => void {
  const registrations = new WeakSet<object>()
  let registration!: Readonly<TrustedDeliveryPresentationRegistration>
  registration = Object.freeze({
    protocol: 'assistant-delivery/trusted-presentation-producer/v1',
    producer: 'assistant-evolution' as const,
    generation: service.trustedDeliveryPresentationProducerGeneration(),
    owner: Object.freeze({
      ownsTrustedDeliveryPresentationRegistration: (
        candidate: Readonly<TrustedDeliveryPresentationRegistration>,
      ) => registrations.has(candidate),
    }),
    publish: (input: DeliveryPresentationUpdate) => publish(input) as never,
  }) satisfies TrustedDeliveryPresentationRegistration
  registrations.add(registration)
  return service.registerTrustedDeliveryPresentationSink(registration)
}

function agent(options: { id?: string; cwd?: string; preset?: string } = {}): Agent {
  const id = SessionId(options.id ?? `evolution-approval-agent-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd: options.cwd ?? WORKSPACE,
    agentPreset: options.preset ?? PRESET,
  })
  setApprovalReviewer(session, 'none')
  session.append('approval/policy', { policy: 'never' })
  const append = session.append as unknown as (type: string, data: unknown) => unknown
  append.call(session, 'sandbox/mode', { mode: 'danger-full-access' })
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(),
    status: 'idle',
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
}

async function openHarness(options: {
  root?: string
  route?: ApprovalDispatchRoute
  tools?: boolean
  reconcileLimit?: number
  defaultProposalTtlMs?: number
} = {}): Promise<Harness> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'assistant-evolution-approval-'))
  if (options.root === undefined) roots.push(root)
  const policyPath = join(root, 'policy.sqlite')
  const evolutionPath = join(root, 'evolution.sqlite')
  const ctx = new Context()
  contexts.add(ctx)
  if (options.tools === true) {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
  }
  await ctx.plugin(AssistantPolicyService, {
    databasePath: policyPath,
    proposalMaintenanceIntervalMs: 0,
    rules: policyRules,
  })
  const prepareAgentApproval = vi.fn(() => {
    if (options.route === undefined) throw new Error('approval route unavailable')
    return options.route
  })
  const publishDeliveryPresentation = vi.fn((input: unknown) => input)
  if (options.route !== undefined) {
    ctx.provide('assistantDelivery', {
      prepareAgentApproval,
    } as never)
  }
  const quality = installQualityFixtures(ctx, join(root, 'evaluation.sqlite'))
  await ctx.plugin(AssistantEvolutionService, {
    databasePath: evolutionPath,
    evaluationWindow: 10,
    minSample: 4,
    defaultProposalTtlMs: options.defaultProposalTtlMs ?? 60_000,
    reconcileIntervalMs: 0,
    reconcileLimit: options.reconcileLimit ?? 50,
  })
  if (options.route !== undefined) {
    installPresentationSink(ctx.assistantEvolution, publishDeliveryPresentation)
  }
  return {
    ctx,
    root,
    policyPath,
    evolutionPath,
    policy: ctx.assistantPolicy,
    service: ctx.assistantEvolution,
    ...quality,
    prepareAgentApproval,
    publishDeliveryPresentation,
  }
}

async function closeHarness(fixture: Harness): Promise<void> {
  if (!contexts.delete(fixture.ctx)) return
  await fixture.ctx.fiber.restart()
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all([...contexts].map(ctx => ctx.fiber.restart()))
  contexts.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function seedCandidate(fixture: Harness, situation: string): Promise<void> {
  for (let index = 1; index <= 4; index += 1) {
    await projectTrustedOutcome({
      ...fixture,
      key: `seed:${situation}:${index}`,
      situation,
      outcome: 'failed',
      workspace: WORKSPACE,
      preset: PRESET,
      occurredAt: 1_000 + index,
    })
  }
}

function adoptMutation(situation: string) {
  return {
    op: 'adopt' as const,
    input: {
      situation: situation.startsWith('automation:') ? situation : `automation:${situation}`,
      guidance: 'Draft the report a day early.',
    },
  }
}

async function seedActiveAutomationRule(fixture: Harness, target: Agent, situation: string) {
  await seedCandidate(fixture, situation)
  const proposed = fixture.service.propose(target, { mutation: adoptMutation(situation) })
  fixture.policy.decideProposal({
    proposalId: proposed.policyProposalId,
    principal: OWNER,
    expectedVersion: 1,
    decision: 'approved',
    reason: 'owner adopts the rule',
  })
  const [settled] = fixture.service.reconcileProposals()
  return settled!.rule!
}

async function seedAttributedRetirementEvidence(
  fixture: Harness,
  rule: { id: string; situation: string; generation: number },
  outcomes: readonly ('succeeded' | 'failed')[],
  keyPrefix: string,
) {
  const episodes = []
  const automationId = rule.situation.replace(/^automation:/u, '')
  for (const [offset, outcome] of outcomes.entries()) {
    const index = offset + 1
    const session = agent({ id: `${keyPrefix}-session-${index}` })
    agentEvents(fixture.ctx, session).emit('agent/session-start', { source: 'startup' })
    const exposure = await fixture.service.captureAutomationExposure({
      workspace: WORKSPACE,
      agentPreset: PRESET,
      automationId,
      sessionId: String(session.session.id),
    })
    episodes.push(await projectTrustedOutcome({
      ...fixture,
      key: `${keyPrefix}:${index}`,
      situation: rule.situation,
      outcome,
      workspace: WORKSPACE,
      preset: PRESET,
      sessionId: String(session.session.id),
      ruleId: exposure!.ruleId,
      guidanceVersion: exposure!.guidanceVersion,
      occurredAt: Date.now() + 10_000 + index,
    }))
  }
  return episodes
}

function call(name: string, args: Record<string, unknown>, target: Agent) {
  return {
    callId: CallId(`call-${name}-${Math.random()}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: target,
  }
}

describe('assistant evolution approval bridge', () => {
  test('uses an exact static capability gate while freezing the exact approval target', async () => {
    const route: ApprovalDispatchRoute = {
      sourceId: APPROVAL_SOURCE,
      bindingId: 'binding-owner-dm',
      workspace: WORKSPACE,
      principal: OWNER,
    }
    const fixture = await openHarness({ route })
    const target = agent()
    await seedCandidate(fixture, 'static-gate-report')

    expect(fixture.policy.authorizeAgent(
      target,
      'propose',
      { kind: 'evolution', id: 'proposals' },
    ).effect).toBe('allow')
    expect(fixture.policy.authorizeAgent(
      target,
      'propose',
      { kind: 'evolution', id: 'situation:static-gate-report' },
    ).effect).toBe('deny')

    const proposed = fixture.service.propose(target, {
      mutation: adoptMutation('static-gate-report'),
    })

    expect(fixture.policy.getProposal(proposed.policyProposalId)?.resource).toEqual({
      kind: 'evolution',
      id: 'situation:automation:static-gate-report',
    })
  })

  test('keeps principal out of the model-visible evolution_propose schema', async () => {
    const route: ApprovalDispatchRoute = {
      sourceId: APPROVAL_SOURCE,
      bindingId: 'binding-owner-dm',
      workspace: WORKSPACE,
      principal: OWNER,
    }
    const fixture = await openHarness({ route, tools: true })
    const schema = fixture.ctx.tools.schemas().find(candidate => candidate.name === 'evolution_propose')
    const parameters = schema?.parameters as {
      properties?: Record<string, unknown>
      required?: string[]
    } | undefined

    expect(parameters?.properties).not.toHaveProperty('principal')
    expect(parameters?.required ?? []).not.toContain('principal')
  })

  test('executes the model-visible proposal without a principal by using the authenticated route', async () => {
    const route: ApprovalDispatchRoute = {
      sourceId: APPROVAL_SOURCE,
      bindingId: 'binding-owner-dm',
      workspace: WORKSPACE,
      principal: OWNER,
    }
    const fixture = await openHarness({ route, tools: true })
    const target = agent()
    await seedCandidate(fixture, 'tool-weekly-report')

    const proposed = await fixture.ctx.tools.execute(call('evolution_propose', {
      operation: 'adopt',
      situation: 'automation:tool-weekly-report',
      guidance: 'Draft the report a day early.',
    }, target))

    expect(proposed.isError).toBe(false)
    expect(proposed.isError ? undefined : proposed.value).toMatchObject({ status: 'pending' })
    expect(fixture.prepareAgentApproval).toHaveBeenCalledWith(target, { sourceId: APPROVAL_SOURCE })
  })

  test('derives the principal from Delivery and persists its complete Policy dispatch tuple', async () => {
    const route: ApprovalDispatchRoute = {
      sourceId: APPROVAL_SOURCE,
      bindingId: 'binding-owner-dm',
      workspace: WORKSPACE,
      principal: OWNER,
    }
    const fixture = await openHarness({ route })
    const target = agent()
    await seedCandidate(fixture, 'weekly-report')
    const candidate = fixture.service.candidates(target)[0]!

    const proposed = fixture.service.propose(target, {
      mutation: adoptMutation('weekly-report'),
    })

    expect(fixture.prepareAgentApproval).toHaveBeenCalledWith(target, { sourceId: APPROVAL_SOURCE })
    const database = new DatabaseSync(fixture.evolutionPath)
    const stored = database.prepare('SELECT mutation_json FROM evolution_proposals WHERE id = ?')
      .get(proposed.proposalId) as { mutation_json: string }
    const mutation = JSON.parse(stored.mutation_json) as Record<string, unknown>
    const expectedDiff = JSON.stringify({
      op: mutation.op,
      ruleId: mutation.ruleId,
      scopeKey: (mutation.input as { scopeKey: string }).scopeKey,
      situation: (mutation.input as { situation: string }).situation,
      guidance: (mutation.input as { guidance: string }).guidance,
      baseline: mutation.baseline,
      evidence: mutation.evidence,
    })
    const [dispatch] = fixture.policy.listPendingApprovalDispatches()
    expect(dispatch).toMatchObject({
      proposalId: proposed.policyProposalId,
      sourceId: APPROVAL_SOURCE,
      bindingId: route.bindingId,
      workspace: route.workspace,
      principal: route.principal,
      requester: `agent:${PRESET}`,
      action: 'evolution.adopt',
      resource: { kind: 'evolution', id: 'situation:automation:weekly-report' },
      summary: 'Adopt learned guidance for automation:weekly-report',
      diff: expectedDiff,
      proposalVersion: 1,
      state: 'pending',
    })
    expect(dispatch?.diffHash).toBe(createHash('sha256').update(expectedDiff).digest('hex'))
    expect(dispatch?.expiresAt).toBe(fixture.policy.getProposal(proposed.policyProposalId)?.expiresAt)
    expect(JSON.parse(expectedDiff)).toMatchObject({
      op: 'adopt',
      ruleId: expect.stringMatching(/^rule-/u),
      scopeKey: JSON.stringify([WORKSPACE, PRESET]),
      situation: 'automation:weekly-report',
      guidance: 'Draft the report a day early.',
      baseline: { failures: 4, total: 4 },
      evidence: {
        total: 4,
        digest: candidate.evidenceDigest,
        sampleEpisodeIds: candidate.evidence.map(entry => entry.episodeId),
      },
    })
    database.close()
  })

  test('publishes actual application state from an independent durable outbox and retries after failure', async () => {
    const route: ApprovalDispatchRoute = {
      sourceId: APPROVAL_SOURCE,
      bindingId: 'binding-owner-dm',
      workspace: WORKSPACE,
      principal: OWNER,
    }
    const fixture = await openHarness({ route })
    const target = agent()
    await seedCandidate(fixture, 'terminal-presentation')
    const proposed = fixture.service.propose(target, {
      mutation: adoptMutation('terminal-presentation'),
    })
    fixture.policy.decideProposal({
      proposalId: proposed.policyProposalId,
      principal: OWNER,
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner approved the exact guidance',
    })
    fixture.publishDeliveryPresentation.mockImplementation(() => {
      throw new Error('provider unavailable')
    })

    const [settled] = fixture.service.reconcileProposals()
    expect(settled).toMatchObject({ status: 'approved', rule: { status: 'active', version: 1 } })
    const database = new DatabaseSync(fixture.evolutionPath)
    expect(database.prepare(`
      SELECT state, attempt_count FROM evolution_application_outbox WHERE local_proposal_id = ?
    `).get(proposed.proposalId)).toMatchObject({ state: 'pending', attempt_count: 2 })

    fixture.publishDeliveryPresentation.mockImplementation((input: unknown) => input)
    expect(fixture.service.reconcileProposals()).toEqual([])
    expect(fixture.publishDeliveryPresentation).toHaveBeenLastCalledWith({
      presentationKey: `approval-application:${proposed.policyProposalId}`,
      originalOutboxIdempotencyKey: `approval-card:${proposed.policyProposalId}`,
      revision: 2,
      presentation: {
        kind: 'approval-application',
        policyProposalId: proposed.policyProposalId,
        localProposalId: proposed.proposalId,
        applicationStatus: 'applied',
        operation: 'adopt',
        terminalAt: expect.any(Number),
        receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        ruleId: settled!.rule!.id,
        resultingRuleVersion: 1,
        ruleStatus: 'active',
      },
    })
    expect(database.prepare(`
      SELECT state, attempt_count, published_at
      FROM evolution_application_outbox WHERE local_proposal_id = ?
    `).get(proposed.proposalId)).toMatchObject({
      state: 'published', attempt_count: 3, published_at: expect.any(Number),
    })
    const calls = fixture.publishDeliveryPresentation.mock.calls.length
    expect(fixture.service.reconcileApplicationPresentations()).toBe(0)
    expect(fixture.publishDeliveryPresentation).toHaveBeenCalledTimes(calls)
    database.close()
  })

  test('freezes an exact retirement candidate into local mutation and Policy diff/hash across restart', async () => {
    const route: ApprovalDispatchRoute = {
      sourceId: APPROVAL_SOURCE,
      bindingId: 'binding-owner-dm',
      workspace: WORKSPACE,
      principal: OWNER,
    }
    const fixture = await openHarness({ route })
    const target = agent()
    const rule = await seedActiveAutomationRule(fixture, target, 'automation:retire-snapshot')
    await seedAttributedRetirementEvidence(
      fixture,
      rule,
      ['failed', 'failed', 'failed', 'failed'],
      'retire-snapshot',
    )
    const candidate = fixture.service.candidates(target).find(entry => entry.kind === 'retire')!
    const request = {
      mutation: {
        op: 'retire' as const,
        ruleId: rule.id,
        expectedVersion: rule.version,
        reason: 'the exact attributed sample did not improve reliability',
      },
    }

    const proposed = fixture.service.propose(target, request)
    const evolutionDatabase = new DatabaseSync(fixture.evolutionPath)
    const pending = evolutionDatabase.prepare(`
      SELECT mutation_json, mutation_hash, creation_intent_json
      FROM evolution_proposals WHERE id = ?
    `).get(proposed.proposalId) as {
      mutation_json: string
      mutation_hash: string
      creation_intent_json: string
    }
    const frozenMutation = JSON.parse(pending.mutation_json) as Record<string, unknown>
    expect(frozenMutation).toEqual({
      op: 'retire',
      scopeKey: rule.scopeKey,
      ruleId: rule.id,
      situation: rule.situation,
      guidance: rule.guidance,
      generation: rule.generation,
      expectedVersion: rule.version,
      reason: request.mutation.reason,
      evaluation: candidate.stats,
      baseline: candidate.baseline,
      evidence: {
        sampleEpisodeIds: candidate.evidence.map(entry => entry.episodeId),
        digest: candidate.evidenceDigest,
        total: candidate.evidenceTotal,
        window: 10,
        scopeWatermark: candidate.scopeWatermark,
        taskRevisions: candidate.taskRevisions,
      },
    })
    expect(pending.mutation_hash).toBe(createHash('sha256')
      .update(JSON.stringify(frozenMutation)).digest('hex'))
    const expectedDiff = JSON.stringify(frozenMutation)
    const dispatch = fixture.policy.listPendingApprovalDispatches()
      .find(entry => entry.proposalId === proposed.policyProposalId)
    expect(dispatch?.diff).toBe(expectedDiff)
    expect(dispatch?.diffHash).toBe(createHash('sha256').update(expectedDiff).digest('hex'))
    expect(JSON.parse(pending.creation_intent_json)).toMatchObject({ diff: expectedDiff })
    expect(fixture.service.listRules(target, 'active')).toContainEqual(rule)

    fixture.policy.decideProposal({
      proposalId: proposed.policyProposalId,
      principal: OWNER,
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner reviewed the frozen attributed sample',
    })
    await closeHarness(fixture)

    const restarted = await openHarness({ root: fixture.root, route })
    const [settled] = restarted.service.reconcileProposals()
    expect(settled).toMatchObject({
      proposalId: proposed.proposalId,
      policyProposalId: proposed.policyProposalId,
      status: 'approved',
      rule: { id: rule.id, status: 'retired', version: rule.version + 1 },
    })
    const replayed = new DatabaseSync(fixture.evolutionPath)
    const after = replayed.prepare('SELECT mutation_json, mutation_hash FROM evolution_proposals WHERE id = ?')
      .get(proposed.proposalId) as { mutation_json: string; mutation_hash: string }
    expect(after).toEqual({
      mutation_json: pending.mutation_json,
      mutation_hash: pending.mutation_hash,
    })
    replayed.close()
    evolutionDatabase.close()
  })

  test('rejects a caller-supplied stale retirement version before creating Policy approval', async () => {
    const route: ApprovalDispatchRoute = {
      sourceId: APPROVAL_SOURCE,
      bindingId: 'binding-owner-dm',
      workspace: WORKSPACE,
      principal: OWNER,
    }
    const fixture = await openHarness({ route })
    const target = agent()
    const rule = await seedActiveAutomationRule(fixture, target, 'automation:retire-version')
    await seedAttributedRetirementEvidence(
      fixture,
      rule,
      ['failed', 'failed', 'failed', 'failed'],
      'retire-version',
    )
    const before = fixture.policy.listPendingApprovalDispatches().length

    expect(() => fixture.service.propose(target, {
      mutation: {
        op: 'retire',
        ruleId: rule.id,
        expectedVersion: rule.version + 1,
        reason: 'launder a stale rule view',
      },
    })).toThrowError(/version|candidate/iu)
    expect(fixture.policy.listPendingApprovalDispatches()).toHaveLength(before)
  })

  test('allows an explicit principal only without Delivery and fails closed without either identity source', async () => {
    const fixture = await openHarness()
    const target = agent()
    await seedCandidate(fixture, 'headless-report')

    const proposed = fixture.service.propose(target, {
      mutation: adoptMutation('headless-report'),
      principal: 'owner:headless:primary',
    })

    expect(proposed.status).toBe('pending')
    expect(fixture.policy.getProposal(proposed.policyProposalId)?.principal).toBe('owner:headless:primary')
    expect(fixture.policy.listPendingApprovalDispatches()).toEqual([])

    await seedCandidate(fixture, 'missing-route-report')
    expect(() => fixture.service.propose(target, {
      mutation: adoptMutation('missing-route-report'),
    })).toThrowError(/approval|principal|route/iu)
    expect(fixture.policy.listPendingApprovalDispatches()).toEqual([])
  })

  test('rejects an explicit principal that differs from the authenticated Delivery owner', async () => {
    const route: ApprovalDispatchRoute = {
      sourceId: APPROVAL_SOURCE,
      bindingId: 'binding-owner-dm',
      workspace: WORKSPACE,
      principal: OWNER,
    }
    const fixture = await openHarness({ route })
    await seedCandidate(fixture, 'forged-owner-report')

    expect(() => fixture.service.propose(agent(), {
      mutation: adoptMutation('forged-owner-report'),
      principal: 'lark/bot-1/tenant-a/ou_attacker',
    })).toThrowError(/principal|owner|route/iu)
    expect(fixture.policy.listPendingApprovalDispatches()).toEqual([])
  })

  test('dispatches a distinct exact owner undo and settles it safely after restart', async () => {
    const route: ApprovalDispatchRoute = {
      sourceId: APPROVAL_SOURCE,
      bindingId: 'binding-owner-dm',
      workspace: WORKSPACE,
      principal: OWNER,
    }
    const fixture = await openHarness({ route })
    const target = agent()
    const rule = await seedActiveAutomationRule(fixture, target, 'automation:owner-undo')

    expect(() => fixture.service.requestOwnerUndo(target, {
      ruleId: rule.id,
      expectedVersion: rule.version,
      operationId: 'owner-undo:forged-fields',
      guidance: 'replace the approved guidance',
      principal: 'lark/bot-1/tenant-a/ou_attacker',
      reason: 'caller-controlled',
    } as never)).toThrow(/accepts only/iu)
    expect(fixture.policy.listPendingApprovalDispatches()).toEqual([])

    fixture.prepareAgentApproval.mockReturnValueOnce({
      ...route,
      principal: 'lark/bot-1/tenant-a/ou_attacker',
    })
    expect(() => fixture.service.requestOwnerUndo(target, {
      ruleId: rule.id,
      expectedVersion: rule.version,
      operationId: 'owner-undo:wrong-owner-route',
    })).toThrow(/principal|owner|route/iu)
    expect(fixture.policy.listPendingApprovalDispatches()).toEqual([])

    const proposed = fixture.service.requestOwnerUndo(target, {
      ruleId: rule.id,
      expectedVersion: rule.version,
      operationId: 'owner-undo:message-42',
    })

    expect(proposed).toMatchObject({ status: 'pending', replayed: false })
    expect(fixture.service.listRules(target, 'active')).toContainEqual(rule)
    const [dispatch] = fixture.policy.listPendingApprovalDispatches()
      .filter(entry => entry.proposalId === proposed.policyProposalId)
    expect(dispatch).toMatchObject({
      sourceId: APPROVAL_SOURCE,
      bindingId: route.bindingId,
      workspace: WORKSPACE,
      principal: OWNER,
      requester: `agent:${PRESET}:owner-undo`,
      action: 'evolution.owner-undo',
      resource: { kind: 'evolution', id: `rule:${rule.id}` },
      summary: `Undo learned guidance rule ${rule.id}`,
      state: 'pending',
    })
    expect(JSON.parse(dispatch!.diff)).toEqual({
      op: 'owner-undo',
      scopeKey: JSON.stringify([WORKSPACE, PRESET]),
      ruleId: rule.id,
      situation: rule.situation,
      guidance: rule.guidance,
      generation: rule.generation,
      expectedVersion: rule.version,
      reason: 'Owner-approved immediate guidance undo.',
    })
    expect(() => fixture.policy.decideProposal({
      proposalId: proposed.policyProposalId,
      principal: 'lark/bot-1/tenant-a/ou_attacker',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'not the owner',
    })).toThrow(/principal|owner|review/iu)
    fixture.policy.decideProposal({
      proposalId: proposed.policyProposalId,
      principal: OWNER,
      expectedVersion: 1,
      decision: 'approved',
      reason: 'remove this guidance now',
    })
    await closeHarness(fixture)

    const restarted = await openHarness({ root: fixture.root, route })
    expect(restarted.service.reconcileProposals()).toMatchObject([{
      proposalId: proposed.proposalId,
      status: 'approved',
      rule: {
        id: rule.id,
        status: 'retired',
        version: rule.version + 1,
        retiredReason: 'Owner-approved immediate guidance undo.',
      },
    }])
    const replay = restarted.service.requestOwnerUndo(agent(), {
      ruleId: rule.id,
      expectedVersion: rule.version,
      operationId: 'owner-undo:message-42',
    })
    expect(replay).toMatchObject({
      proposalId: proposed.proposalId,
      status: 'approved',
      replayed: true,
      rule: { id: rule.id, status: 'retired', version: rule.version + 1 },
    })
    const database = new DatabaseSync(restarted.evolutionPath)
    expect(database.prepare(`
      SELECT operation, rule_id, result_version FROM evolution_audit
      WHERE operation = 'owner-undo'
    `).all()).toEqual([{
      operation: 'owner-undo', rule_id: rule.id, result_version: rule.version + 1,
    }])
    database.close()
  })

  test('owner undo rejects cross-scope and stale targets and conflicts a superseded card', async () => {
    const route: ApprovalDispatchRoute = {
      sourceId: APPROVAL_SOURCE,
      bindingId: 'binding-owner-dm',
      workspace: WORKSPACE,
      principal: OWNER,
    }
    const fixture = await openHarness({ route })
    const target = agent()
    const rule = await seedActiveAutomationRule(fixture, target, 'automation:owner-undo-cas')
    expect(() => fixture.service.requestOwnerUndo(target, {
      ruleId: rule.id,
      expectedVersion: rule.version + 1,
      operationId: 'owner-undo:stale',
    })).toThrow(/version|stale/iu)
    expect(() => fixture.service.requestOwnerUndo(agent({ cwd: '/work/beta' }), {
      ruleId: rule.id,
      expectedVersion: rule.version,
      operationId: 'owner-undo:cross-scope',
    })).toThrow(/denied|forbidden|scope|found/iu)

    const first = fixture.service.requestOwnerUndo(target, {
      ruleId: rule.id,
      expectedVersion: rule.version,
      operationId: 'owner-undo:first-card',
    })
    const superseded = fixture.service.requestOwnerUndo(target, {
      ruleId: rule.id,
      expectedVersion: rule.version,
      operationId: 'owner-undo:old-card',
    })
    fixture.policy.decideProposal({
      proposalId: first.policyProposalId,
      principal: OWNER,
      expectedVersion: 1,
      decision: 'approved',
      reason: 'first exact card wins',
    })
    expect(fixture.service.reconcileProposals()).toMatchObject([{
      proposalId: first.proposalId,
      status: 'approved',
      rule: { id: rule.id, status: 'retired' },
    }])
    fixture.policy.decideProposal({
      proposalId: superseded.policyProposalId,
      principal: OWNER,
      expectedVersion: 1,
      decision: 'approved',
      reason: 'late stale card',
    })
    expect(fixture.service.reconcileProposals()).toMatchObject([{
      proposalId: superseded.proposalId,
      status: 'conflicted',
      rule: undefined,
    }])
    expect(fixture.service.listRules(target, 'retired')).toHaveLength(1)
  })
})

describe('assistant evolution settlement validation', () => {
  test('owner approval cannot execute legacy, evidence-stripped, or tampered retire JSON', async () => {
    const route: ApprovalDispatchRoute = {
      sourceId: APPROVAL_SOURCE,
      bindingId: 'binding-owner-dm',
      workspace: WORKSPACE,
      principal: OWNER,
    }
    const cases: Array<{
      name: string
      mutate: (mutation: Record<string, unknown>, hash: string) => {
        mutation: Record<string, unknown>
        hash: string
      }
    }> = [
      {
        name: 'runtime-valid retire reason with a matching replacement hash',
        mutate: mutation => {
          const changed = { ...mutation, reason: 'attacker supplied a different valid reason' }
          return {
            mutation: changed,
            hash: createHash('sha256').update(JSON.stringify(changed)).digest('hex'),
          }
        },
      },
      {
        name: 'runtime-valid retire evidence with a matching replacement hash',
        mutate: mutation => {
          const changed = {
            ...mutation,
            evidence: {
              ...(mutation.evidence as Record<string, unknown>),
              digest: '0'.repeat(64),
            },
          }
          return {
            mutation: changed,
            hash: createHash('sha256').update(JSON.stringify(changed)).digest('hex'),
          }
        },
      },
      {
        name: 'runtime-valid retire-to-adopt swap with a matching replacement hash',
        mutate: mutation => {
          const evaluation = mutation.evaluation as {
            scopeKey: string
            failures: number
            total: number
          }
          const situation = `swapped-adoption-${Math.random()}`
          const changed = {
            op: 'adopt',
            input: {
              scopeKey: evaluation.scopeKey,
              situation,
              guidance: 'Attacker-controlled replacement guidance.',
            },
            baseline: {
              scopeKey: evaluation.scopeKey,
              situation,
              failures: evaluation.failures,
              total: evaluation.total,
            },
            evidence: mutation.evidence,
            ruleId: 'rule-00000000-0000-4000-8000-000000000001',
          }
          return {
            mutation: changed,
            hash: createHash('sha256').update(JSON.stringify(changed)).digest('hex'),
          }
        },
      },
      {
        name: 'legacy evidence-free snapshot with a matching legacy hash',
        mutate: mutation => {
          const legacy = {
            op: mutation.op,
            ruleId: mutation.ruleId,
            expectedVersion: mutation.expectedVersion,
            reason: mutation.reason,
          }
          return {
            mutation: legacy,
            hash: createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),
          }
        },
      },
      {
        name: 'evidence-stripped JSON with the original frozen hash',
        mutate: (mutation, hash) => {
          const { evidence: _evidence, ...stripped } = mutation
          return { mutation: stripped, hash }
        },
      },
      {
        name: 'tampered JSON with the original frozen hash',
        mutate: (mutation, hash) => ({
          mutation: { ...mutation, reason: 'attacker replaced the owner-reviewed reason' },
          hash,
        }),
      },
    ]

    for (const [index, scenario] of cases.entries()) {
      const fixture = await openHarness({ route })
      const target = agent({ id: `settlement-mutation-${index}` })
      const rule = await seedActiveAutomationRule(
        fixture,
        target,
        `automation:settlement-mutation-${index}`,
      )
      await seedAttributedRetirementEvidence(
        fixture,
        rule,
        ['failed', 'failed', 'failed', 'failed'],
        `settlement-mutation-${index}`,
      )
      const proposed = fixture.service.propose(target, {
        mutation: {
          op: 'retire',
          ruleId: rule.id,
          expectedVersion: rule.version,
          reason: 'the reviewed exact sample did not improve reliability',
        },
      })
      const database = new DatabaseSync(fixture.evolutionPath)
      const row = database.prepare(`
        SELECT mutation_json, mutation_hash FROM evolution_proposals WHERE id = ?
      `).get(proposed.proposalId) as { mutation_json: string; mutation_hash: string }
      const changed = scenario.mutate(JSON.parse(row.mutation_json) as Record<string, unknown>, row.mutation_hash)
      database.prepare(`
        UPDATE evolution_proposals SET mutation_json = ?, mutation_hash = ? WHERE id = ?
      `).run(JSON.stringify(changed.mutation), changed.hash, proposed.proposalId)
      database.close()
      fixture.policy.decideProposal({
        proposalId: proposed.policyProposalId,
        principal: OWNER,
        expectedVersion: 1,
        decision: 'approved',
        reason: 'owner approved the original frozen proposal',
      })

      const settled = fixture.service.reconcileProposals()

      expect(settled, scenario.name).toMatchObject([{
        proposalId: proposed.proposalId,
        status: 'conflicted',
        version: 2,
        rule: undefined,
      }])
      expect(fixture.service.listRules(target, 'active'), scenario.name)
        .toContainEqual(rule)
      expect(fixture.service.reconcileProposals(), scenario.name).toEqual([])
      await closeHarness(fixture)
    }
  })

  test('reconciles the crash gap after Policy commit from the durable local creation intent', async () => {
    const route: ApprovalDispatchRoute = {
      sourceId: APPROVAL_SOURCE,
      bindingId: 'binding-owner-dm',
      workspace: WORKSPACE,
      principal: OWNER,
    }
    const fixture = await openHarness({ route })
    const target = agent()
    await seedCandidate(fixture, 'crash-gap')
    const originalRecovery = fixture.policy.recoverOrCreateProposal.bind(fixture.policy)
    vi.spyOn(fixture.policy, 'recoverOrCreateProposal').mockImplementationOnce((input) => {
      originalRecovery(input)
      throw new Error('simulated process death after Policy commit')
    })

    expect(() => fixture.service.propose(target, {
      mutation: adoptMutation('crash-gap'),
    })).toThrow('simulated process death')
    const [committedDispatch] = fixture.policy.listPendingApprovalDispatches()
    expect(committedDispatch).toBeDefined()
    fixture.policy.decideProposal({
      proposalId: committedDispatch!.proposalId,
      principal: OWNER,
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner approved before domain recovery',
    })
    await closeHarness(fixture)

    const restarted = await openHarness({ root: fixture.root, route })
    const propose = vi.spyOn(restarted.policy, 'propose')
    const recover = vi.spyOn(restarted.policy, 'recoverOrCreateProposal')
    const attached = restarted.service.reconcileProposals()

    expect(propose).not.toHaveBeenCalled()
    expect(recover).toHaveBeenCalledOnce()
    expect(attached).toMatchObject([{
      status: 'approved',
      rule: { situation: 'automation:crash-gap' },
    }])
  })

  test('does not create or renew Policy approval after an unattached local intent expires', async () => {
    let now = 10_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const fixture = await openHarness({ defaultProposalTtlMs: 1 })
    const target = agent()
    await seedCandidate(fixture, 'expired-gap')
    vi.spyOn(fixture.policy, 'recoverOrCreateProposal').mockImplementationOnce(() => {
      throw new Error('Policy was unavailable before commit')
    })

    expect(() => fixture.service.propose(target, {
      mutation: adoptMutation('expired-gap'),
      principal: OWNER,
    })).toThrow('Policy was unavailable')
    now += 2
    await closeHarness(fixture)

    const restarted = await openHarness({ root: fixture.root, defaultProposalTtlMs: 1 })
    const propose = vi.spyOn(restarted.policy, 'propose')
    const recover = vi.spyOn(restarted.policy, 'recoverOrCreateProposal')
    const settled = restarted.service.reconcileProposals()

    expect(propose).not.toHaveBeenCalled()
    expect(recover).toHaveBeenCalledOnce()
    expect(settled).toMatchObject([{ status: 'conflicted', rule: undefined }])
    expect(restarted.service.reconcileProposals()).toEqual([])
    expect(restarted.policy.listPendingApprovalDispatches()).toEqual([])
    clock.mockRestore()
  })

  test('atomically abandons an expired two-connection race without an orphan dispatch', async () => {
    let now = 20_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const route: ApprovalDispatchRoute = {
      sourceId: APPROVAL_SOURCE,
      bindingId: 'binding-owner-dm',
      workspace: WORKSPACE,
      principal: OWNER,
    }
    const first = await openHarness({ route, defaultProposalTtlMs: 1 })
    await seedCandidate(first, 'atomic-expiry-race')
    const second = await openHarness({ root: first.root, route, defaultProposalTtlMs: 1 })
    const originalPropose = first.policy.propose.bind(first.policy)
    const originalRecovery = first.policy.recoverOrCreateProposal.bind(first.policy)
    let raced = false
    const letCompetitorWinAfterDeadline = () => {
      if (raced) return
      raced = true
      now += 2
      expect(second.service.reconcileProposals()).toMatchObject([{
        status: 'conflicted',
        rule: undefined,
      }])
    }
    const legacyPropose = vi.spyOn(first.policy, 'propose').mockImplementation(input => {
      letCompetitorWinAfterDeadline()
      return originalPropose(input)
    })
    vi.spyOn(first.policy, 'recoverOrCreateProposal').mockImplementation(input => {
      letCompetitorWinAfterDeadline()
      return originalRecovery(input)
    })

    const settled = first.service.propose(agent(), {
      mutation: adoptMutation('atomic-expiry-race'),
    })

    expect(raced).toBe(true)
    expect(legacyPropose).not.toHaveBeenCalled()
    expect(settled).toMatchObject({ status: 'conflicted', rule: undefined })
    expect(first.policy.listPendingApprovalDispatches()).toEqual([])
    clock.mockRestore()
  })

  test('fair bounded reconciliation cannot let old pending rows starve a later decision', async () => {
    const fixture = await openHarness({ reconcileLimit: 2 })
    const target = agent()
    const proposals = []
    for (let index = 1; index <= 5; index += 1) {
      const situation = `fair-${index}`
      await seedCandidate(fixture, situation)
      proposals.push(fixture.service.propose(target, {
        mutation: adoptMutation(situation),
        principal: OWNER,
      }))
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    const last = proposals.at(-1)!
    fixture.policy.decideProposal({
      proposalId: last.policyProposalId,
      principal: OWNER,
      expectedVersion: 1,
      decision: 'approved',
      reason: 'settle the newest proposal',
    })

    expect(fixture.service.reconcileProposals()).toEqual([])
    expect(fixture.service.reconcileProposals()).toEqual([])
    expect(fixture.service.reconcileProposals()).toMatchObject([{
      proposalId: last.proposalId,
      status: 'approved',
      rule: { situation: 'automation:fair-5' },
    }])
  })

  test('settles an already-terminal exact Policy snapshot on the direct proposal replay path', async () => {
    const fixture = await openHarness()
    const target = agent()
    await seedCandidate(fixture, 'direct-replay')
    const request = {
      mutation: adoptMutation('direct-replay'),
      principal: OWNER,
    }
    const proposed = fixture.service.propose(target, request)
    fixture.policy.decideProposal({
      proposalId: proposed.policyProposalId,
      principal: OWNER,
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner approved the exact guidance',
    })

    const replay = fixture.service.propose(target, request)

    expect(replay).toMatchObject({
      proposalId: proposed.proposalId,
      policyProposalId: proposed.policyProposalId,
      status: 'approved',
      version: 2,
      replayed: true,
      rule: expect.objectContaining({ situation: 'automation:direct-replay', status: 'active' }),
    })
    expect(fixture.service.listRules(target, 'active')).toHaveLength(1)
    expect(fixture.service.reconcileProposals()).toEqual([])
  })

  test('uses the same settlement validator on direct replay and durably conflicts a forged snapshot', async () => {
    const fixture = await openHarness()
    const target = agent()
    await seedCandidate(fixture, 'direct-tamper')
    const request = {
      mutation: adoptMutation('direct-tamper'),
      principal: OWNER,
    }
    const proposed = fixture.service.propose(target, request)
    fixture.policy.decideProposal({
      proposalId: proposed.policyProposalId,
      principal: OWNER,
      expectedVersion: 1,
      decision: 'approved',
      reason: 'owner approved the exact guidance',
    })
    const originalGetProposal = fixture.policy.getProposal.bind(fixture.policy)
    const getProposal = vi.spyOn(fixture.policy, 'getProposal').mockImplementation((proposalId) => {
      const snapshot = originalGetProposal(proposalId)
      return snapshot === undefined ? undefined : { ...snapshot, requester: 'agent:attacker' }
    })

    const settled = fixture.service.propose(target, request)

    expect(settled).toMatchObject({ status: 'conflicted', version: 2, rule: undefined })
    expect(fixture.service.listRules(target, 'active')).toEqual([])
    getProposal.mockRestore()
    await closeHarness(fixture)

    const restarted = await openHarness({ root: fixture.root })
    const replay = restarted.service.propose(agent(), request)
    expect(replay).toMatchObject({ status: 'conflicted', version: 2, replayed: true, rule: undefined })
    expect(restarted.service.listRules(agent(), 'active')).toEqual([])
  })

  test('durably conflicts every immutable snapshot-field mismatch during reconciliation without applying a rule', async () => {
    const tamperCases: Array<[
      string,
      (snapshot: ApprovalProposalSnapshot) => ApprovalProposalSnapshot,
    ]> = [
      ['proposalId', snapshot => ({ ...snapshot, proposalId: `${snapshot.proposalId}-forged` })],
      ['requester', snapshot => ({ ...snapshot, requester: 'agent:attacker' })],
      ['principal', snapshot => ({ ...snapshot, principal: 'owner:attacker' })],
      ['action', snapshot => ({ ...snapshot, action: 'evolution.retire' })],
      ['resource kind', snapshot => ({
        ...snapshot,
        resource: { ...snapshot.resource, kind: 'memory' },
      })],
      ['resource id', snapshot => ({
        ...snapshot,
        resource: { ...snapshot.resource, id: 'rule:forged' },
      })],
      ['summary', snapshot => ({ ...snapshot, summary: 'Retire unrelated guidance' })],
      ['diffHash', snapshot => ({ ...snapshot, diffHash: '0'.repeat(64) })],
      ['expiresAt', snapshot => ({ ...snapshot, expiresAt: snapshot.expiresAt + 1 })],
      ['version', snapshot => ({ ...snapshot, version: snapshot.version + 1 })],
      ['decidedBy', snapshot => ({ ...snapshot, decidedBy: 'owner:attacker' })],
    ]

    for (const [field, tamper] of tamperCases) {
      const fixture = await openHarness()
      const target = agent()
      const situation = `tamper-${field.replaceAll(' ', '-')}`
      await seedCandidate(fixture, situation)
      const request = { mutation: adoptMutation(situation), principal: OWNER }
      const proposed = fixture.service.propose(target, request)
      fixture.policy.decideProposal({
        proposalId: proposed.policyProposalId,
        principal: OWNER,
        expectedVersion: 1,
        decision: 'approved',
        reason: 'owner approved the exact guidance',
      })
      const originalGetProposal = fixture.policy.getProposal.bind(fixture.policy)
      const getProposal = vi.spyOn(fixture.policy, 'getProposal').mockImplementation((proposalId) => {
        const snapshot = originalGetProposal(proposalId)
        return snapshot === undefined ? undefined : tamper(snapshot)
      })

      const settled = fixture.service.reconcileProposals()

      expect(settled, field).toHaveLength(1)
      expect(settled[0], field).toMatchObject({ status: 'conflicted', version: 2, rule: undefined })
      expect(fixture.service.listRules(target, 'active'), field).toEqual([])
      getProposal.mockRestore()
      await closeHarness(fixture)

      const restarted = await openHarness({ root: fixture.root })
      const replay = restarted.service.propose(agent(), request)
      expect(replay, field).toMatchObject({ status: 'conflicted', version: 2, replayed: true, rule: undefined })
      expect(restarted.service.listRules(agent(), 'active'), field).toEqual([])
      expect(restarted.service.reconcileProposals(), field).toEqual([])
      await closeHarness(restarted)
    }
  })
})
