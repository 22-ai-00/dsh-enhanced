import IsolationPlugin from '../src/index.ts'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, LlmRuntime, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { IsolationLedger } from '../src/ledger.ts'
import { AssistantIsolationService, isolationPrincipalDigest } from '../src/service.ts'
import { maintainIsolation } from '../src/cli.ts'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'

const image = process.env.DSH_ISOLATION_TEST_IMAGE ?? ''
const enabled = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() !== 0
  && /^sha256:[0-9a-f]{64}$/.test(image)
const dockerTests = enabled ? describe.sequential : describe.skip
const roots: string[] = []

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

class IsolationToolAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  #calls = 0
  command = 'printf native-tool; printf tool-artifact > tool.txt'

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.#calls += 1
    if (this.#calls % 2 === 1) {
      const id = ToolCallId(`isolation-tool-${this.#calls}`)
      const argumentsText = JSON.stringify({ grant_id: 'offline', idempotency_key: `native-${this.#calls}`, command: this.command, artifacts: ['tool.txt'] })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'isolation_run', argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'isolation_run', arguments: argumentsText } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'normal finish after isolated tool' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'normal finish after isolated tool' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function marker(stateRoot: string): Promise<void> {
  const database = new DatabaseSync(join(stateRoot, 'ledger.sqlite'))
  try {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const rows = database.prepare("SELECT container_name FROM isolation_jobs WHERE status = 'running'").all() as Array<{ container_name: string }>
      for (const row of rows) {
        try {
          await promisify(execFile)(process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker',
            ['-H', 'unix:///var/run/docker.sock', 'exec', row.container_name, '/bin/busybox', 'test', '-f', '/workspace/started'],
            { timeout: 2000, maxBuffer: 4096, env: { PATH: process.env.PATH, LANG: 'C' } })
          return
        } catch { /* A running ledger CAS can precede Docker start; observe the actual worker. */ }
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  } finally { database.close() }
  throw new Error('isolated command did not create its start marker')
}

dockerTests('AssistantIsolationService real AgentLoop and Docker integration (opt in)', () => {
  test('denies new jobs at the record ceiling while returning explicitly pruned historical results without replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-isolation-retention-')); roots.push(root)
    const stateRoot = join(root, 'state'); await mkdirPrivate(stateRoot)
    const ctx = new Context()
    let plugin: { dispose(): Promise<void> } | undefined
    let handle: { agent: Agent, dispose(): Promise<void> } | undefined
    try {
      await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); new SessionProjectionRegistry(ctx)
      await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, persona: '' })
      await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
      ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: () => ({ principalId: 'owner', principalLineage: { principalRecordId: 'record-owner', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } }) } as never)
      new AssistantPolicyService(ctx, {
        databasePath: join(root, 'policy.sqlite'), toolDefaultEffect: 'deny',
        rules: [{ id: 'allow-native-isolation-tool', effect: 'allow', actions: ['execute'], resource: { kind: 'tool', id: 'isolation_run' } }, { id: 'allow-one-isolation-run', effect: 'allow', actions: ['execute'], resource: { kind: 'tool', id: 'isolation:offline' }, budget: { id: 'isolation-runs', amount: 1 } }],
        budgets: [{ id: 'isolation-runs', metric: 'isolation-runs', limit: 1, periodMs: 60_000, scope: 'subject' }],
      }, { now: () => 10000 })
      await ctx.plugin(ApprovalService, { policy: 'ask' })
      let asks = 0; ctx.on('approval/request', async () => { asks++; return 'rejected' })
      const config = { stateRoot, image, storage: { maxJobRecords: 1 }, grants: [{ id: 'offline', revision: 1,
        principalDigest: isolationPrincipalDigest('owner'), principalRecordId: 'record-owner', principalVersion: 1,
        workspace: root, agentPreset: 'primary', expiresAt: Date.now() + 120_000, maxRuns: 2, maxTotalDurationMs: 60_000 }] }
      plugin = await ctx.plugin(IsolationPlugin, config) as unknown as { dispose(): Promise<void> }
      handle = await ctx.agents.create({ sessionId: SessionId('retention-service'), meta: { cwd: root, agentPreset: 'primary' } })
      const request = { grantId: 'offline', idempotencyKey: 'original', command: 'sleep 1; head -c 10000 /dev/zero | tr "\\000" x', timeoutMs: 20_000 }
      const signal = new AbortController().signal
      handle.agent.session.append('turn/start', { turn: 1 })
      handle.agent.session.append('approval/policy', { policy: 'ask' })
      const nativeInput = { callId: ToolCallId('finite-offline'), rootCallId: ToolCallId('finite-offline'), token: Symbol('test') as never, name: 'isolation_run', arguments: { grant_id: request.grantId, idempotency_key: request.idempotencyKey, command: request.command, timeout_ms: request.timeoutMs }, signal, agent: handle.agent }
      expect(ctx.assistantIsolation.preauthorize(nativeInput), 'finite grant must pass broker predicate').toBe(true)
      expect(ctx.assistantPolicy.isPreauthorizedTool(nativeInput), 'exact tool registration must be preauthorized').toBe(true)
      const native = await ctx.tools.execute(nativeInput)
      expect(native.isError, JSON.stringify(native)).toBe(false); expect(asks).toBe(0)
      const text = native.content[0]; if (text?.type !== 'text') throw new Error('missing isolation result')
      const first = JSON.parse(text.text.slice(text.text.indexOf('\n') + 1))
      expect(first).toMatchObject({ status: 'succeeded', quiescent: true, stdout: 'x'.repeat(10_000) })
      expect(first.retention).toBeUndefined()
      await expect(ctx.assistantIsolation.run(handle.agent, { ...request, idempotencyKey: 'denied' }, signal)).rejects.toThrow(/record/i)
      await symlink('/tmp', join(stateRoot, 'unobservable'))
      expect(await ctx.assistantIsolation.run(handle.agent, request, signal)).toEqual(first)
      expect(ctx.assistantPolicy.queryAudit({ limit: 100 }).filter(event => event.action === 'execute' && event.resourceHash === isolationPrincipalDigest('isolation:offline') && event.outcome === 'allowed')).toHaveLength(1)
      expect(ctx.assistantPolicy.authorizeAgent(handle.agent, 'execute', { kind: 'tool', id: 'isolation:offline' }, { idempotencyKey: 'second-isolation-job' }))
        .toMatchObject({ effect: 'deny', reasonCode: 'budget-exhausted' })
      await expect(ctx.assistantIsolation.run(handle.agent, { ...request, idempotencyKey: 'observation-denied' }, signal)).rejects.toThrow(/observation unavailable/i)
      await rm(join(stateRoot, 'unobservable'))
      await plugin.dispose(); plugin = undefined
      expect((await maintainIsolation(stateRoot, 1)).pruned).toBe(1)
      plugin = await ctx.plugin(IsolationPlugin, config) as unknown as { dispose(): Promise<void> }
      const replay = await ctx.assistantIsolation.run(handle.agent, request, signal)
      expect(replay).toMatchObject({ jobId: first.jobId, status: 'succeeded', stdout: '', retention: { kind: 'pruned', stdout: { bytes: 10_000 } } })
      const database = new DatabaseSync(join(stateRoot, 'ledger.sqlite'))
      try {
        expect(database.prepare('SELECT COUNT(*) AS count, SUM(reserved_duration_ms) AS duration FROM isolation_jobs').get()).toMatchObject({ count: 1, duration: 20_000 })
        expect(database.prepare("SELECT COUNT(*) AS count FROM isolation_audit WHERE action='supervisor-spawn-intent'").get()).toMatchObject({ count: 1 })
      } finally { database.close() }
    } finally { await handle?.dispose(); await plugin?.dispose(); await ctx.fiber.dispose() }
  }, 60_000)

  test('runs durable owner-scoped jobs, native tool calls, cancellation, revocation, and recovery without replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-isolation-service-'))
    roots.push(root)
    const stateRoot = join(root, 'state'); const project = join(root, 'project')
    await Promise.all([mkdirPrivate(stateRoot), mkdirPrivate(project)])
    const ctx = new Context()
    let servicePlugin: { dispose(): Promise<void> } | undefined
    let agentHandle: { agent: Agent, dispose(): Promise<void> } | undefined
    try {
      await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); new SessionProjectionRegistry(ctx)
      await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, persona: '' })
      await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
      const owners = new Map<Agent, string>()
      ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: (agent: Agent) => {
        const principalId = owners.get(agent)
        return principalId === undefined ? undefined : { principalId, principalLineage: { principalRecordId: `record-${principalId}`, principalVersion: 1 },
          scope: { workspace: project, preset: 'primary' }, sessionId: String(agent.session.id) }
      } } as never)
      const policyResources: unknown[] = []
      ctx.provide('assistantPolicy' as never, { evaluateAgent: (_agent: Agent, action: string, resource: unknown) => {
        policyResources.push([action, resource])
        return { effect: action === 'execute' && JSON.stringify(resource) === JSON.stringify({ kind: 'tool', id: 'isolation:offline' }) ? 'allow' : 'deny' }
      }, authorizeAgent: (_agent: Agent, action: string, resource: unknown) => {
        policyResources.push([action, resource])
        return { effect: action === 'execute' && JSON.stringify(resource) === JSON.stringify({ kind: 'tool', id: 'isolation:offline' }) ? 'allow' : 'deny' }
      } } as never)
      let hostMarker = false
      ctx.tools.register(defineTool({
        name: 'bash', description: 'Host execution marker used only to prove the isolation guard.', parameters: {},
        output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
        async execute() { hostMarker = true; return {} },
      }))
      servicePlugin = await ctx.plugin(AssistantIsolationService, {
        stateRoot, image, dockerPath: process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker', maxConcurrentJobs: 2, maxReservedMemoryMiB: 352, maxReservedWorkspaceInodes: 4096,
        grants: [{ id: 'offline', revision: 1, principalDigest: isolationPrincipalDigest('owner'), principalRecordId: 'record-owner', principalVersion: 1,
          workspace: project, agentPreset: 'primary', expiresAt: Date.now() + 120_000, maxRuns: 20, maxTotalDurationMs: 600_000 }],
      }) as unknown as { dispose(): Promise<void> }
      agentHandle = await ctx.agents.create({ sessionId: SessionId('isolation-service'), meta: { cwd: project, agentPreset: 'primary' }, agentOptions: { provider: 'fixture', model: 'fixture' } })
      const agent = agentHandle.agent; owners.set(agent, 'owner')
      const signal = new AbortController().signal
      const hostCall = async () => await ctx.tools.execute({ callId: ToolCallId(`host-bash-${Math.random()}`), name: 'bash', arguments: {}, signal, agent })
      expect((await hostCall()).isError).toBe(true)
      expect(hostMarker).toBe(false)
      const request = { grantId: 'offline', idempotencyKey: 'same-request', command: 'printf direct-output; printf artifact > result.txt',
        files: [{ path: 'input.txt', content: 'staged' }], artifacts: ['result.txt'], timeoutMs: 20_000 }
      const first = await ctx.assistantIsolation.run(agent, request, signal)
      expect(first).toMatchObject({ status: 'succeeded', quiescent: true, exitCode: 0, artifacts: [{ path: 'result.txt', content: 'artifact' }] })
      expect(first.stdout).toContain('direct-output')
      expect(first).not.toHaveProperty('creationWitness')
      const audit = new DatabaseSync(join(stateRoot, 'ledger.sqlite'))
      try {
        expect(audit.prepare('SELECT action FROM isolation_audit WHERE job_id=? ORDER BY sequence').all(first.jobId).map(row => row.action))
          .toEqual(['job-prepared', 'supervisor-spawn-intent', 'job-started', 'job-settled'])
      } finally { audit.close() }
      expect(policyResources).toContainEqual(['execute', { kind: 'tool', id: 'isolation:offline' }])
      await expect(ctx.assistantIsolation.run(agent, { ...request, command: 'printf changed' }, signal)).rejects.toThrow()
      expect(await ctx.assistantIsolation.run(agent, request, signal)).toEqual(first)
      owners.set(agent, 'other')
      await expect(ctx.assistantIsolation.run(agent, { ...request, idempotencyKey: 'other-owner' }, signal)).rejects.toThrow(/authenticated owner|required|unauthorized/i)
      owners.set(agent, 'owner')

      const adapter = new IsolationToolAdapter()
      ctx.llm.registerAdapter(['fixture'], adapter)
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the isolation tool.' }] }))
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(2)
      expect(agent.session.snapshotEvents().some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('native-tool'))).toBe(true)

      adapter.command = 'touch started; sleep 30'
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Start then cancel.' }] }))
      await marker(stateRoot)
      await expect(ctx.assistantIsolation.run(agent, { grantId: 'offline', idempotencyKey: 'pool-denied', command: 'printf must-not-run' }, signal)).rejects.toThrow(/resource|reservation|pool/i)
      const poolDb = new DatabaseSync(join(stateRoot, 'ledger.sqlite'))
      try {
        expect(poolDb.prepare("SELECT COUNT(*) AS count FROM isolation_jobs WHERE idempotency_key = 'pool-denied'").get()).toMatchObject({ count: 0 })
        expect(poolDb.prepare("SELECT reserved_memory_mib, reserved_workspace_inodes FROM isolation_jobs WHERE idempotency_key = 'native-3'").get()).toMatchObject({ reserved_memory_mib: 352, reserved_workspace_inodes: 4096 })
      } finally { poolDb.close() }
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      // Native cancellation may suppress a tool/result projection. The private
      // broker ledger must nevertheless confirm the actual worker stopped.
      const cancelledDb = new DatabaseSync(join(stateRoot, 'ledger.sqlite'))
      try {
        let cancelled: { result_json: string | null } | undefined
        for (let attempt = 0; attempt < 100; attempt++) {
          cancelled = cancelledDb.prepare('SELECT result_json FROM isolation_jobs WHERE idempotency_key = ?').get('native-3') as { result_json: string | null } | undefined
          if (cancelled?.result_json !== null && cancelled?.result_json !== undefined) break
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        expect(JSON.parse(cancelled?.result_json ?? '{}')).toMatchObject({ status: 'cancelled', quiescent: true })
      } finally { cancelledDb.close() }

      const pending = ctx.assistantIsolation.run(agent, { grantId: 'offline', idempotencyKey: 'revoked-running', command: 'touch started; sleep 30', timeoutMs: 20_000 }, signal)
      await marker(stateRoot)
      const revoked = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../lib/cli.js', import.meta.url)), 'revoke', stateRoot, 'offline', '1', process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker'], {
        timeout: 15_000, maxBuffer: 16_384, env: { PATH: process.env.PATH, LANG: 'C' },
      })
      expect(JSON.parse(revoked.stdout)).toEqual({ revoked: true, containersRemoved: true })
      const revokedResult = await pending
      // A concurrent external kill can remove state before the supervisor
      // observes it. A dispatched unknown retains occupancy under schema v3.
      expect(revokedResult.quiescent, JSON.stringify(revokedResult)).toBe(revokedResult.status !== 'unknown')
      expect(['cancelled', 'unknown', 'failed']).toContain(revokedResult.status)
      const settledLedger = new IsolationLedger(join(stateRoot, 'ledger.sqlite'))
      try {
        expect(settledLedger.get(revokedResult.jobId)?.result).toEqual(revokedResult)
        expect(settledLedger.recoverable().some(job => job.id === revokedResult.jobId)).toBe(revokedResult.status === 'unknown')
      } finally { settledLedger.close() }
      expect((await hostCall()).isError).toBe(true)
      expect(hostMarker).toBe(false)

      await servicePlugin.dispose()
      const abandoned = new IsolationLedger(join(stateRoot, 'ledger.sqlite'))
      const abandonedIdentity = { principalDigest: isolationPrincipalDigest('owner'), principalRecordId: 'record-owner', principalVersion: 1, workspace: project, agentPreset: 'primary' }
      abandoned.syncGrants([{ ...abandonedIdentity, id: 'abandoned', revision: 1, expiresAt: Date.now() + 60_000, maxRuns: 1, maxTotalDurationMs: 20_000 }])
      const prepared = abandoned.prepare({ identity: abandonedIdentity, sessionId: String(agent.session.id), grantId: 'abandoned', idempotencyKey: 'crashed-before-create', requestDigest: 'historical-request', durationMs: 20_000 }).job
      abandoned.close()
      servicePlugin = await ctx.plugin(AssistantIsolationService, { stateRoot, image, dockerPath: process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker', grants: [] }) as unknown as { dispose(): Promise<void> }
      await expect(ctx.assistantIsolation.run(agent, { grantId: 'offline', idempotencyKey: 'after-reopen', command: 'false' }, signal)).rejects.toThrow()
      const recovered = new IsolationLedger(join(stateRoot, 'ledger.sqlite'))
      try { expect(recovered.get(prepared.id)?.result).toMatchObject({ status: 'unknown', quiescent: true, reason: 'controller-recovery-no-replay' }) }
      finally { recovered.close() }
      expect(adapter.requests).toHaveLength(3)
    } finally {
      await agentHandle?.dispose()
      await servicePlugin?.dispose()
      await ctx.fiber.dispose()
    }
  }, 120_000)
})

async function mkdirPrivate(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
  await writeFile(join(path, '.keep'), '', { mode: 0o600 })
}
