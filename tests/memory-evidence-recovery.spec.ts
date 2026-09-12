import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { PersonalMemoryService } from '../plugins/personal-memory/src/service.ts'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

type Reply = string | { name: string; args: Record<string, unknown> }
class ScriptAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private readonly reply: (request: GenerateOptions, index: number) => Reply) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reply = this.reply(options, this.requests.length)
    this.requests.push(options)
    if (typeof reply === 'string') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    } else {
      const id = ToolCallId(`evidence-call-${this.requests.length}`)
      const args = JSON.stringify(reply.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: reply.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: reply.name, arguments: args } }
    }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
    yield { type: 'finish', reason: { kind: typeof reply === 'string' ? 'stop' : 'tool-calls' } }
  }
}

async function host(root: string, adapter: ScriptAdapter, options: { ownerVersion?: number; revoked?: boolean; denySource?: boolean; denyFile?: boolean; denyPipeline?: boolean; unregistered?: boolean; budgeted?: 'execute' | 'read' } = {}) {
  const ctx = new Context()
  try {
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'Use current verified evidence.', includeRuntimeContext: true } })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none', packChunks: false, writeBatchMaxDelayMs: 1 })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(ToolResultPruner, { thresholdChars: 8_192, headChars: 4_096, tailChars: 1_024 })
  ctx.provide('assistantDelivery', {
    preferencePrincipalForAgent: (agent: Agent) => options.revoked ? undefined : ({
      scope: { workspace: root, preset: 'primary' }, principalId: 'owner:public-fixture',
      principalLineage: { principalRecordId: 'owner-record', principalVersion: options.ownerVersion ?? 1 },
      sessionId: String(agent.session.id), bindingId: 'fixture-binding', bindingVersion: 1, bindingGeneration: 1,
    }),
  } as never)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    budgets: [{ id: 'evidence-reads', metric: 'operations', limit: 10, periodMs: 60_000, scope: 'subject' }], rules: [
      { id: 'memory', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root }, actions: ['search', 'snapshot'], resource: { kind: 'memory', id: '*' } },
      { id: 'evidence-read', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root }, actions: ['execute'], resource: { kind: 'tool', id: 'memory_read_evidence' } },
      { id: 'other-file', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root }, actions: ['read'], resource: { kind: 'filesystem', id: join(root, 'other.txt') } },
      { id: 'file', ...(options.budgeted === 'read' ? { budget: { id: 'evidence-reads', amount: 1 } } : {}), effect: options.denyFile ? 'deny' : 'allow', subject: { kind: 'agent', id: 'primary', workspace: root }, actions: ['read'], resource: { kind: 'filesystem', id: join(root, 'journal.txt') } },
      { id: 'source', ...(options.budgeted === 'execute' ? { budget: { id: 'evidence-reads', amount: 1 } } : {}), effect: options.denySource ? 'deny' : 'allow', subject: { kind: 'agent', id: 'primary', workspace: root }, actions: ['execute'], resource: { kind: 'tool', id: 'read' } },
    ],
  })
  await ctx.plugin(PersonalMemoryService, { databasePath: join(root, 'memory.sqlite'), reconcileIntervalMs: 0 })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  if (!options.unregistered) await ctx.plugin(FileTools, { readMaxLineLength: 32_000, readMaxBytes: 64_000 })
  let executions = 0
  ctx.on('tools/execute', async (exec, next) => { if (exec.name === 'read') executions++; return next() })
  if (options.denyPipeline) ctx.on('tools/pre-execute', async (exec, next) =>
    exec.name === 'read' ? { kind: 'deny', reason: 'resource provider revoked' } : next())
  ctx.on('agent/session-start', ({ agent }) => {
    agent.session.append('sandbox/mode', { mode: 'danger-full-access' })
    agent.session.append('approval/policy', { policy: 'never' })
    agent.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
  })
  ctx.llm.registerAdapter(['evidence-fixture'], adapter)
  await ctx.plugin(AgentLoop, { agents: [] })
  return { ctx, executions: () => executions }
  } catch (error) { await ctx.fiber.dispose(); throw error }
}

async function prompt(handle: AgentHandle, text: string) {
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await handle.agent.whenIdle()
  const last = handle.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)
  expect(last, JSON.stringify(last))
    .toMatchObject({ data: { reason: { kind: 'completed' } } })
}

test.each(['current-owner', 'changed-owner', 'revoked-owner', 'denied-tool', 'changed-original', 'denied-file', 'pipeline-deny', 'restricted-tool', 'unregistered-tool', 'missing-file', 'missing-anchor', 'missing-source', 'budgeted-execute', 'budgeted-file', 'retargeted-file'] as const)(
  'native original evidence survives prune and disk reopen: %s', async mode => {
    // Policy grants use the filesystem provider's canonical execution path.
    // macOS temporary paths can otherwise retain the /var -> /private/var alias.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-tool-evidence-')))
    roots.push(root)
    await writeFile(join(root, 'journal.txt'), `report-start:${'a'.repeat(12_000)}NEEDLE=journal-v2${'b'.repeat(12_000)}:report-end`)
    const id = SessionId('original-evidence-session')
    const capture = new ScriptAdapter((_request, index) => index === 0 ? { name: 'read', args: { file_path: 'journal.txt' } } : 'Captured a historical report.')
    const first = await host(root, capture)
    let handle: AgentHandle | undefined
    let reference = ''; let sourcePath = ''
    try {
      handle = await first.ctx.agents.create({ sessionId: id, meta: { cwd: root, agentPreset: 'primary' }, agentOptions: { provider: 'evidence-fixture', model: 'fixture' } })
      await prompt(handle, 'Capture the journal report.')
      expect(first.executions(), JSON.stringify(handle.agent.session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => ({ seq: event.seq, failed: event.data.message.content[0].isError })))).toBe(1)
      const db = new DatabaseSync(join(root, 'memory.sqlite'), { readOnly: true })
      try {
        const anchors = db.prepare('SELECT reference, content_digest FROM memory_evidence_anchors').all()
        expect(anchors).toHaveLength(1)
        reference = String(anchors[0]!.reference)
        expect(db.prepare('SELECT count(*) AS n FROM memory_records').get()).toMatchObject({ n: 0 })
      } finally { db.close() }
      expect(reference).toMatch(/^dsh-evidence:v1:[0-9a-f]{64}$/u)
      const pruned = first.ctx.toolResultPruner.pruneSession(handle.agent.session)
      expect(pruned.pruned).toHaveLength(1)
      expect(JSON.stringify(handle.agent.session.deriveMessages())).not.toContain('NEEDLE=journal-v2')
      expect(handle.agent.session.eventAt(pruned.pruned[0]!.originalSeq)?.type).toBe('tool/result')
      expect(await first.ctx.sessions.flush(handle.agent.session)).toBe(true)
      const raw = await first.ctx.sessionPersistence.readRaw(id)
      expect(raw?.content).toContain('NEEDLE=journal-v2')
      sourcePath = first.ctx.sessionPersistence.locate(handle.agent.session.header)!.path
    } finally { await handle?.dispose(); await first.ctx.fiber.dispose() }

    if (mode === 'changed-original') {
      const raw = await readFile(sourcePath, 'utf8')
      let changed = 0
      const altered = raw.split('\n').map(line => {
        if (line === '') return line
        const value = JSON.parse(line)
        if (value.type !== 'tool/result' || value.surfaceOp !== 'append') return line
        const text = value.data.message.content[0].content[0].text
        if (!text.includes('NEEDLE=journal-v2')) return line
        value.data.message.content[0].content[0].text = text.replace('NEEDLE=journal-v2', 'BROKEN=journal-v2')
        changed++
        return JSON.stringify(value)
      }).join('\n')
      expect(changed).toBe(1)
      await writeFile(sourcePath, altered)
    }
    if (mode === 'missing-anchor') {
      const db = new DatabaseSync(join(root, 'memory.sqlite'))
      try { db.exec('DELETE FROM memory_evidence_anchors') } finally { db.close() }
    }
    if (mode === 'missing-source') {
      const rows = (await readFile(sourcePath, 'utf8')).trimEnd().split('\n')
      const callIndex = rows.findIndex(row => JSON.parse(row).type === 'tool/call')
      expect(callIndex).toBeGreaterThan(0)
      await writeFile(sourcePath, rows.slice(0, callIndex).join('\n') + '\n')
    }
    if (mode === 'missing-file') await rm(join(root, 'journal.txt'))
    else await writeFile(join(root, 'journal.txt'), 'NEEDLE=journal-v3')
    if (mode === 'retargeted-file') {
      await writeFile(join(root, 'other.txt'), 'NEEDLE=journal-v3')
      await rm(join(root, 'journal.txt'))
      await symlink('other.txt', join(root, 'journal.txt'))
    }
    const recovery = new ScriptAdapter((request, index) => {
      const text = JSON.stringify(request.messages)
      if (index === 0) {
        expect(text).not.toContain('NEEDLE=journal-v2')
        if (mode === 'current-owner') {
          expect(text).toContain(reference)
          expect(text).toContain('historical-unverified')
        } else if (mode === 'changed-original' || mode === 'missing-source') expect(text).toContain('unavailable')
        else if (!['denied-file', 'pipeline-deny', 'missing-file', 'budgeted-file', 'retargeted-file'].includes(mode)) expect(text).not.toContain('<session_tool_evidence>')
        return { name: 'memory_read_evidence', args: { reference, query: 'NEEDLE=', max_chars: 256 } }
      }
      if (mode !== 'current-owner') {
        expect(text).not.toContain('NEEDLE=journal-v2')
        expect(text).not.toContain('BROKEN=journal-v2')
        return 'Historical evidence is unavailable; do not use it.'
      }
      if (index === 1) {
        expect(text, JSON.stringify(request.messages.at(-1))).toContain('NEEDLE=journal-v2')
        expect(text).toContain('historical-unverified')
        expect(text).toContain('matched')
        return { name: 'read', args: { file_path: 'journal.txt' } }
      }
      expect(text).toContain('NEEDLE=journal-v3')
      return 'Current journal is v3; the recovered v2 observation was stale.'
    })
    const second = await host(root, recovery, {
      ...(mode === 'changed-owner' ? { ownerVersion: 2 } : {}),
      ...(mode === 'revoked-owner' ? { revoked: true } : {}),
      ...(mode === 'denied-tool' ? { denySource: true } : {}),
      ...(mode === 'denied-file' ? { denyFile: true } : {}),
      ...(mode === 'pipeline-deny' ? { denyPipeline: true } : {}),
      ...(mode === 'unregistered-tool' ? { unregistered: true } : {}),
      ...(mode === 'budgeted-execute' ? { budgeted: 'execute' as const } : {}),
      ...(mode === 'budgeted-file' ? { budgeted: 'read' as const } : {}),
    })
    handle = undefined
    try {
      handle = await second.ctx.agents.resume({ resumeSessionId: id, ...(mode === 'restricted-tool' ? { setup: (agentCtx: Context) => { agentCtx.tools.restrict({ deny: ['read'] }) } } : {}), agentOptions: { provider: 'evidence-fixture', model: 'fixture' } })
      await prompt(handle, 'Recover the original report, then check current state before deciding.')
      expect(recovery.requests).toHaveLength(mode === 'current-owner' ? 3 : 2)
      expect(second.executions()).toBe(mode === 'current-owner' ? 2 : 0)
      expect(handle.agent.session.header.id).toBe(id)
      if (mode === 'budgeted-execute' || mode === 'budgeted-file') {
        const db = new DatabaseSync(join(root, 'policy.sqlite'), { readOnly: true })
        try { expect(db.prepare('SELECT count(*) AS n FROM budget_reservations').get()).toMatchObject({ n: 0 }) } finally { db.close() }
      }
    } finally { await handle?.dispose(); await second.ctx.fiber.dispose() }
  },
)
