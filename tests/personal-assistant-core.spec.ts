import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { PersonalMemoryService } from '@dsh-enhanced/personal-memory'
import { PersonalWikiService } from '@dsh-enhanced/personal-wiki'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function foreground(): Agent {
  const id = SessionId(`core-foreground-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 1, cwd: '/work/alpha', agentPreset: 'primary', isSeeded: false,
  })
  return {
    id, options: {}, session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(), status: 'idle', cancel() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {},
  }
}

class CoreAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      for (const [index, call] of [
        { name: 'memory_search', arguments: '{"query":"coffee Helix","limit":5}' },
        { name: 'wiki_search', arguments: '{"query":"agent architecture","limit":5}' },
      ].entries()) {
        const id = ToolCallId(`core-call-${index}`)
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments }
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: call.arguments } }
      }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Used approved memory and wiki knowledge.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Used approved memory and wiki knowledge.' } }
    yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 7 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('four-core personal assistant composition', () => {
  test('uses only Cordis seams and lets an approved background Agent retrieve Memory and Wiki', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-assistant-core-'))
    roots.push(root)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
    await ctx.plugin(SessionProjectionRegistry)
    ctx.on('agent/session-start', ({ agent }) => {
      agent.session.append('approval/policy', { policy: 'never' })
      agent.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
      const append = agent.session.append as unknown as (type: string, data: unknown) => unknown
      append.call(agent.session, 'sandbox/mode', { mode: 'danger-full-access' })
    })
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      budgets: [
        { id: 'core-automation-runs', metric: 'automation-runs', limit: 10, periodMs: 60_000, scope: 'subject' },
      ],
      rules: [
        { id: 'foreground-memory', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
          actions: ['propose', 'search', 'snapshot'], resource: { kind: 'memory', id: '*' }, context: { initiators: ['foreground'] } },
        { id: 'foreground-wiki', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
          actions: ['propose', 'read', 'search'], resource: { kind: 'wiki', id: '*' }, context: { initiators: ['foreground'] } },
        { id: 'foreground-automation', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
          actions: ['history', 'propose'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['foreground'] } },
        { id: 'background-memory-service', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
          actions: ['search', 'snapshot'], resource: { kind: 'memory', id: '*' }, context: { initiators: ['background'] } },
        { id: 'background-wiki-service', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
          actions: ['read', 'search'], resource: { kind: 'wiki', id: '*' }, context: { initiators: ['background'] } },
        { id: 'background-knowledge-tools', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
          actions: ['execute'], resource: { kind: 'tool', id: '*_search' }, context: { initiators: ['background'] } },
        { id: 'background-automation', effect: 'allow', subject: { kind: 'background', id: 'auto-context', workspace: '/work/alpha' },
          actions: ['execute'], resource: { kind: 'automation', id: 'auto-context' }, context: { initiators: ['background'] } },
        { id: 'external-core-event', effect: 'allow', subject: { kind: 'external', id: 'core-test' },
          actions: ['ingest'], resource: { kind: 'automation', id: 'auto-context' }, context: { initiators: ['external'] } },
      ],
    })
    const ownerPrincipal = 'owner:test'
    const ownerBindingId = 'binding-core-owner'
    const ownerRecordId = 'principal-core-owner'
    // This Host-owned test seam mirrors Delivery's authenticated v2 route and
    // principal attestation. Both the foreground proposal Agent and the
    // Automation-created background Agent therefore resolve the same durable
    // owner namespace without weakening Personal Memory's fail-closed path.
    ctx.provide('assistantDelivery' as never, {
      prepareAgentApproval(current: Agent | undefined, input: { sourceId: string }) {
        if (current?.session.header.cwd !== '/work/alpha'
          || current.session.header.agentPreset !== 'primary') {
          throw new Error('test Delivery owner route does not match the Agent')
        }
        return Object.freeze({
          routeVersion: 2 as const,
          sourceId: input.sourceId,
          bindingId: ownerBindingId,
          bindingVersion: 1,
          bindingGeneration: 1,
          workspace: '/work/alpha',
          principal: ownerPrincipal,
          principalRecordId: ownerRecordId,
          principalVersion: 1,
        })
      },
      preferencePrincipalForAgent(current: Agent) {
        if (current.session.header.cwd !== '/work/alpha'
          || current.session.header.agentPreset !== 'primary') return undefined
        return Object.freeze({
          scope: Object.freeze({ workspace: '/work/alpha', preset: 'primary' }),
          principalId: ownerPrincipal,
          principalLineage: Object.freeze({ principalRecordId: ownerRecordId, principalVersion: 1 }),
          bindingId: ownerBindingId,
          bindingVersion: 1,
          bindingGeneration: 1,
          sessionId: String(current.session.id),
        })
      },
    } as never)
    await ctx.plugin(PersonalMemoryService, {
      databasePath: join(root, 'memory.sqlite'),
      approvalMode: 'delivery-or-headless',
    })
    await ctx.plugin(PersonalWikiService, { vaultRoot: join(root, 'wiki'), databasePath: join(root, 'wiki.sqlite') })
    await ctx.plugin(AssistantAutomationsService, {
      databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false,
      proposalDefaults: {
        provider: 'mock', model: 'core-model', allowedTools: ['memory_search', 'wiki_search'],
        timeoutMs: 60_000, maxOutputTokens: 512, maxToolCalls: 2,
        misfireKind: 'latest', misfireLimit: 1, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
        budgetId: 'core-automation-runs', budgetAmount: 1,
      },
    })
    const adapter = new CoreAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(AgentLoop, { agents: [] })

    const agent = foreground()
    const memory = ctx.personalMemory.propose(agent, {
      idempotencyKey: 'core:memory', principal: ownerPrincipal,
      mutation: { op: 'add', identity: { owner: 'user', scope: 'workspace', workspace: '/work/alpha' },
        entry: { kind: 'preference', content: 'Preferred editor is Helix and coffee is hand-brewed.', sensitivity: 'private',
          trust: 'user-confirmed', confidence: 1, provenance: { source: 'user', observedAt: 1 } } },
    })
    ctx.personalMemory.decideProposal({ proposalId: memory.proposalId, principal: ownerPrincipal, expectedVersion: 1,
      decision: 'approved', reason: 'confirmed' })
    const wiki = ctx.personalWiki.propose(agent, {
      idempotencyKey: 'core:wiki', principal: ownerPrincipal, mutation: { op: 'create', input: {
        title: 'Agent architecture', type: 'concept', authority: 'curated', status: 'active', tags: ['agent'], aliases: [],
        sources: [{ uri: 'https://example.test/agent', sha256: 'a'.repeat(64) }],
        body: '# Agent architecture\n\nMemory and knowledge remain separate service-owned truths.',
      } },
    })
    ctx.personalWiki.decideProposal({ proposalId: wiki.proposalId, principal: ownerPrincipal, expectedVersion: 1,
      decision: 'approved', reason: 'reviewed' })
    const automation = ctx.assistantAutomations.propose(agent, {
      idempotencyKey: 'core:automation', principal: ownerPrincipal, mutation: { op: 'create', automationId: 'auto-context',
        definition: { name: 'Context review', prompt: 'Retrieve approved personal context.',
          schedule: { kind: 'at', at: '2030-01-01T00:00:00.000Z' }, workspace: '/work/alpha', agentPreset: 'primary',
          provider: 'mock', model: 'core-model', allowedTools: ['memory_search', 'wiki_search'], timeoutMs: 60_000,
          maxOutputTokens: 512, maxToolCalls: 2, misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never',
          maxRetries: 0, principal: ownerPrincipal } },
    })
    ctx.assistantAutomations.decideProposal({ proposalId: automation.proposalId, principal: ownerPrincipal, expectedVersion: 1,
      decision: 'approved', reason: 'reviewed' })
    ctx.assistantAutomations.ingestExternal({ sourceId: 'core-test', automationId: 'auto-context', eventId: 'event-1', occurredAt: 1 })

    await ctx.assistantAutomations.tick()
    await ctx.assistantAutomations.whenIdle()

    expect(adapter.requests[0]!.tools?.map(tool => tool.name).sort()).toEqual(['memory_search', 'wiki_search'])
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('Preferred editor is Helix')
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('Memory and knowledge remain separate')
    expect(ctx.assistantAutomations.history(agent, { automationId: 'auto-context' }).runs[0]).toMatchObject({
      status: 'succeeded', outputPreview: 'Used approved memory and wiki knowledge.',
    })
    expect((ctx.assistantAutomations as unknown as Record<string, unknown>)['createApproved']).toBeUndefined()
    await ctx.fiber.restart()
  })
})
