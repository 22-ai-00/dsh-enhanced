import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantHealthService } from '@dsh-enhanced/assistant-health'
import { AssistantHeartbeatService } from '@dsh-enhanced/assistant-heartbeat'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { EventTriggersService } from '@dsh-enhanced/event-triggers'
import { MemoryWikiBridgeService } from '@dsh-enhanced/memory-wiki-bridge'
import { PersonalMemoryService } from '@dsh-enhanced/personal-memory'
import { PersonalWikiService } from '@dsh-enhanced/personal-wiki'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function foreground(): Agent {
  const id = SessionId('p1-foreground')
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1,
    cwd: '/work/alpha', agentPreset: 'primary' })
  return { id, options: {}, session, inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(), status: 'idle', cancel() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
}

describe('personal assistant P1 composition', () => {
  test('composes heartbeat, events, bridge and health only through public Cordis services', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-assistant-p1-')); roots.push(root)
    const watched = join(root, 'watched.txt'); await writeFile(watched, 'v1')
    const ctx = new Context()
    await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [
      { id: 'agent-memory', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
        actions: ['propose', 'read'], resource: { kind: 'memory', id: '*' } },
      { id: 'agent-wiki', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
        actions: ['propose', 'read'], resource: { kind: 'wiki', id: '*' } },
      { id: 'agent-automation', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
        actions: ['propose'], resource: { kind: 'automation', id: '*' } },
      { id: 'agent-health', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
        actions: ['inspect'], resource: { kind: 'tool', id: 'assistant-health' } },
      { id: 'heartbeat-reconcile', effect: 'allow', subject: { kind: 'background', id: 'assistant-heartbeat' },
        actions: ['reconcile'], resource: { kind: 'automation', id: 'heartbeat:*' }, context: { initiators: ['background'] } },
      { id: 'event-observe', effect: 'allow', subject: { kind: 'background', id: 'event-triggers:file' },
        actions: ['observe'], resource: { kind: 'filesystem', id: watched }, context: { initiators: ['background'] } },
      { id: 'event-ingest', effect: 'allow', subject: { kind: 'external', id: 'event-triggers:file' },
        actions: ['ingest'], resource: { kind: 'automation', id: 'event-task' }, context: { initiators: ['external'] } },
    ] })
    await ctx.plugin(PersonalMemoryService, { databasePath: join(root, 'memory.sqlite') })
    await ctx.plugin(PersonalWikiService, { vaultRoot: join(root, 'wiki'), databasePath: join(root, 'wiki.sqlite') })
    await ctx.plugin(AssistantAutomationsService, { databasePath: join(root, 'automations.sqlite'),
      runsPath: join(root, 'runs'), schedulerEnabled: false })
    await ctx.plugin(AssistantHeartbeatService, { heartbeats: [{
      id: 'primary', enabled: true, scratchPath: join(root, 'heartbeat.md'), initialScratch: '',
      workspace: '/work/alpha', agentPreset: 'primary', provider: 'mock', model: 'mock', timezone: 'Asia/Shanghai',
      activeStartHour: 8, activeEndHour: 22, intervalMinutes: 30, principal: 'owner:me', allowedTools: [],
      timeoutMs: 60_000, maxOutputTokens: 256, maxToolCalls: 0,
    }] })
    await ctx.plugin(EventTriggersService, { databasePath: join(root, 'events.sqlite'), allowedFileRoots: [root],
      allowedHttpHosts: [], pollerEnabled: false, triggers: [{ id: 'file', kind: 'file', automationId: 'event-task',
        path: watched, fireWhen: 'changed', debounceMs: 0, cooldownMs: 0, maxFires: 10 }] })
    await ctx.plugin(MemoryWikiBridgeService, {})
    await ctx.plugin(AssistantHealthService, {})
    const agent = foreground()

    const automation = ctx.assistantAutomations.propose(agent, { idempotencyKey: 'event-task', principal: 'owner:me',
      mutation: { op: 'create', automationId: 'event-task', definition: { name: 'Event review', prompt: 'Review event.',
        schedule: { kind: 'at', at: '2030-01-01T00:00:00.000Z' }, workspace: '/work/alpha', agentPreset: 'primary',
        provider: 'mock', model: 'mock', allowedTools: [], timeoutMs: 60_000, maxOutputTokens: 256, maxToolCalls: 0,
        misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0, principal: 'owner:me' } } })
    ctx.assistantAutomations.decideProposal({ proposalId: automation.proposalId, principal: 'owner:me',
      expectedVersion: 1, decision: 'approved', reason: 'reviewed' })

    const memory = ctx.personalMemory.propose(agent, { idempotencyKey: 'fact', principal: 'owner:me', mutation: {
      op: 'add', identity: { owner: 'user', scope: 'workspace', workspace: '/work/alpha' }, entry: {
        kind: 'fact', content: 'Atlas uses a local-first architecture.', sensitivity: 'private', trust: 'user-confirmed',
        confidence: 1, provenance: { source: 'user', observedAt: 1 },
      } } })
    const record = ctx.personalMemory.decideProposal({ proposalId: memory.proposalId, principal: 'owner:me',
      expectedVersion: 1, decision: 'approved', reason: 'confirmed' }).record!
    const promoted = ctx.memoryWikiBridge.promote(agent, { memoryIds: [record.id], principal: 'owner:me',
      title: 'Atlas context', type: 'project', status: 'draft', tags: ['atlas'], aliases: [],
      synthesis: 'Atlas is designed around local-first state.', target: { op: 'create' } })
    const page = ctx.personalWiki.decideProposal({ proposalId: promoted.proposalId, principal: 'owner:me',
      expectedVersion: 1, decision: 'approved', reason: 'reviewed' }).page!
    const pinned = ctx.memoryWikiBridge.pin(agent, { wikiRef: `wiki://${page.metadata.id}`, principal: 'owner:me',
      summary: 'Atlas context is documented in the personal Wiki.',
      identity: { owner: 'user', scope: 'workspace', workspace: '/work/alpha' }, kind: 'fact' })
    expect(pinned.status).toBe('pending')

    await ctx.eventTriggers.pollOnce(); await writeFile(watched, 'v2'); await ctx.eventTriggers.pollOnce()
    expect(ctx.eventTriggers.health()).toMatchObject({ pendingEvents: 0, deliveredEvents: 1 })
    expect(ctx.assistantHeartbeat.health()).toEqual({ active: 0, paused: 1, empty: 1 })
    const report = ctx.assistantHealth.report(agent)
    expect(report).toMatchObject({ ready: true, providers: expect.arrayContaining([
      { id: 'personalMemory', status: 'ready', metrics: expect.objectContaining({ activeRecords: 1, pendingProposals: 1 }) },
      { id: 'personalWiki', status: 'ready', metrics: expect.objectContaining({ pages: 1 }) },
      { id: 'eventTriggers', status: 'ready', metrics: expect.objectContaining({ deliveredEvents: 1 }) },
    ]) })
    expect(JSON.stringify(report)).not.toContain('Atlas uses a local-first architecture')
    await ctx.fiber.restart()
  })
})
