import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createTaskAcceptanceContract, type GoalArtifactAdmission } from '@dsh-enhanced/task-acceptance-contract'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import IsolationPlugin from '../src/index.js'
import type { Config } from '../src/config.js'
import { IsolationLedger } from '../src/ledger.js'
import { isolationPrincipalDigest } from '../src/service.js'
import type { IsolationRequest, IsolationResult } from '../src/types.js'
import { linuxRuntimeFixture } from './helpers/linux-runtime-fixture.js'

const real = process.env.DSH_NATIVE_CGROUP_REAL === '1' && process.platform === 'linux' && (process.getuid?.() ?? 0) > 0
const roots: string[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function setup(maxRuns = 12) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-public-linux-')); roots.push(root)
  // The approved runtime is readable by UID 65534 while state stays private.
  await chmod(root, 0o755)
  const stateRoot = join(root, 'state'), project = join(root, 'project')
  await mkdir(stateRoot, { mode: 0o700 }); await mkdir(project, { mode: 0o700 })
  const linux = await linuxRuntimeFixture(root)
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); new SessionProjectionRegistry(ctx)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
  let owner = 'owner'
  let admission: GoalArtifactAdmission | undefined
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: (agent: Agent) => ({ principalId: owner,
    principalLineage: { principalRecordId: `record-${owner}`, principalVersion: 1 },
    scope: { workspace: project, preset: 'primary' }, sessionId: String(agent.session.id) }) } as never)
  ctx.provide('assistantGoals' as never, { currentArtifactAdmission: () => admission } as never)
  new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), toolDefaultEffect: 'deny', rules: [
    { id: 'run', effect: 'allow', actions: ['execute'], resource: { kind: 'tool', id: 'isolation_run' } },
    { id: 'discover', effect: 'allow', actions: ['execute'], resource: { kind: 'tool', id: 'isolation_grants' } },
    { id: 'grant', effect: 'allow', actions: ['execute'], resource: { kind: 'tool', id: 'isolation:offline' } },
  ] })
  const config: Config = { backend: 'linux-native', linux, stateRoot,
    // Any attempted Docker execution would fail and leave a detectable marker.
    dockerPath: join(root, 'forbidden-docker'), socketPath: join(root, 'missing.sock'),
    limits: { maxDurationMs: 5000, maxOutputBytes: 4096, memoryMiB: 128, pidsLimit: 32, cpus: 0.5, workspaceMiB: 4, workspaceInodes: 256 },
    grants: [{ id: 'offline', revision: 1, principalDigest: isolationPrincipalDigest('owner'), principalRecordId: 'record-owner', principalVersion: 1,
      workspace: project, agentPreset: 'primary', expiresAt: Date.now() + 120_000, maxRuns, maxTotalDurationMs: 60_000 }] }
  await writeFile(config.dockerPath!, `#!/bin/sh\nprintf contacted > '${join(root, 'docker-contacted')}'\nexit 1\n`, { mode: 0o700 })
  let plugin = await ctx.plugin(IsolationPlugin, config)
  const handle = await ctx.agents.create({ sessionId: SessionId('public-linux'), meta: { cwd: project, agentPreset: 'primary' } })
  const agent = handle.agent
  cleanups.push(async () => { await handle.dispose() })
  const db = new DatabaseSync(join(stateRoot, 'ledger.sqlite'))
  cleanups.push(async () => { db.close() })
  const signal = new AbortController().signal
  let calls = 0
  const call = async (request: IsolationRequest, callSignal = signal): Promise<IsolationResult> => {
    const output = await ctx.tools.execute({ callId: ToolCallId(`linux-${++calls}`), name: 'isolation_run', agent, signal: callSignal,
      arguments: { grant_id: request.grantId, idempotency_key: request.idempotencyKey, command: request.command,
        ...(request.files ? { files: request.files } : {}), ...(request.artifacts ? { artifacts: request.artifacts } : {}),
        ...(request.timeoutMs ? { timeout_ms: request.timeoutMs } : {}) } })
    const text = output.content[0]
    if (output.isError || text?.type !== 'text') throw new Error(JSON.stringify(output))
    return JSON.parse(text.text.slice(text.text.indexOf('\n') + 1)) as IsolationResult
  }
  return { root, stateRoot, project, config, ctx, agent, db, call, signal,
    owner: (value: string) => { owner = value }, admission: (value: GoalArtifactAdmission | undefined) => { admission = value },
    reopen: async () => { await plugin.dispose(); plugin = await ctx.plugin(IsolationPlugin, config) },
    close: async () => { await plugin.dispose() } }
}
function request(key: string, command = 'printf result'): IsolationRequest {
  return { grantId: 'offline', idempotencyKey: key, command, timeoutMs: 5000 }
}
async function groupsAbsent(db: DatabaseSync, key: string): Promise<void> {
  const resources = JSON.parse(db.prepare('SELECT linux_resources_json FROM isolation_jobs WHERE idempotency_key=?').get(key)?.linux_resources_json as string)
  for (const snapshot of [resources.worker, resources.keeper]) for (const directory of Object.values(snapshot.directories) as { path: string }[]) {
    await expect(stat(directory.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }
}
async function running(db: DatabaseSync, key: string): Promise<void> {
  await expect.poll(() => db.prepare('SELECT status FROM isolation_jobs WHERE idempotency_key=?').get(key)?.status, { timeout: 8000 }).toBe('running')
}

describe.skipIf(!real).sequential('public isolation_run with real Linux cgroups and Cordis ownership', () => {
  test('runs inline files through the real tool, exports artifacts, pins Node/PATH, and preserves finite idempotency on reopen', async () => {
    const f = await setup(1)
    const input = { ...request('inline', 'node --version; printf "%s\\n" "$PATH"; cat input.txt > result.txt'),
      files: [{ path: 'input.txt', content: 'inline only\n' }], artifacts: ['result.txt'] }
    const result = await f.call(input)
    expect(result).toMatchObject({ status: 'succeeded', quiescent: true, exitCode: 0,
      stdout: 'v22.23.2\n/runtime/0/bin:/runtime/0/pnpm-native:/usr/bin:/bin\n', artifacts: [{ path: 'result.txt', content: 'inline only\n' }] })
    expect(result).not.toHaveProperty('receipt'); expect(result).not.toHaveProperty('linuxResources')
    expect(await f.call(input)).toEqual(result)
    await expect(f.ctx.assistantIsolation.run(f.agent, { ...input, command: 'false' }, f.signal)).rejects.toThrow('different request')
    await expect(f.ctx.assistantIsolation.run(f.agent, request('exhausted'), f.signal)).rejects.toThrow('budget')
    expect(f.db.prepare('SELECT backend_kind,reserved_memory_mib,reserved_workspace_inodes FROM isolation_jobs').get())
      .toMatchObject({ backend_kind: 'linux-native', reserved_memory_mib: 293, reserved_workspace_inodes: 4640 })
    await groupsAbsent(f.db, 'inline')
    await f.reopen()
    expect(await f.call(input)).toEqual(result)
    await expect(f.ctx.assistantIsolation.run(f.agent, request('still-exhausted'), f.signal)).rejects.toThrow('budget')
    expect(f.db.prepare('SELECT COUNT(*) AS n,SUM(reserved_duration_ms) AS duration FROM isolation_jobs').get()).toMatchObject({ n: 1, duration: 5000 })
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM isolation_audit WHERE action='supervisor-spawn-intent'").get()?.n).toBe(1)
    await expect(stat(join(f.root, 'docker-contacted'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(f.stateRoot, 'docker-socket-path'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 20_000)

  test.each(['cancel', 'revoke', 'owner', 'fence', 'goal', 'dispose'] as const)('stops both actual resource groups after %s', async mode => {
    const f = await setup(), controller = new AbortController()
    if (mode === 'goal') f.admission({ protocol: 'goal-artifact-admission/v1', contractId: 'goal-contract', contractDigest: 'a'.repeat(64), runId: 'round-1', turn: 1 })
    // Attach rejection handling before changing identity/fence, which also suppresses public late results.
    const pending = f.ctx.assistantIsolation.run(f.agent, request(mode, 'sleep 30 & wait'), controller.signal)
      .then(result => ({ result }), error => ({ error }))
    await running(f.db, mode)
    let successor: { ledger: IsolationLedger; authority: ReturnType<IsolationLedger['claimController']> } | undefined
    if (mode === 'cancel') controller.abort()
    if (mode === 'owner') f.owner('other')
    if (mode === 'goal') f.admission(undefined)
    if (mode === 'revoke') {
      const peer = new IsolationLedger(join(f.stateRoot, 'ledger.sqlite'))
      try { peer.revoke('offline', 1, 'real-public-test') } finally { peer.close() }
    }
    if (mode === 'fence') {
      f.db.prepare('UPDATE isolation_controller SET expires_at=0 WHERE singleton=1').run()
      const ledger = new IsolationLedger(join(f.stateRoot, 'ledger.sqlite'))
      successor = { ledger, authority: ledger.claimController('successor', 30_000) }
    }
    if (mode === 'dispose') await f.close()
    try {
      const outcome = await pending
      if (mode === 'owner' || mode === 'fence' || mode === 'dispose') expect(outcome).toHaveProperty('error')
      else expect(outcome).toMatchObject({ result: { status: 'cancelled', quiescent: true } })
      await groupsAbsent(f.db, mode)
      if (successor) expect(successor.ledger.hasController(successor.authority)).toBe(true)
    } finally {
      if (successor) { successor.ledger.releaseController(successor.authority); successor.ledger.close() }
    }
  }, 15_000)

  test('recovers a private receipt after uncertain Host settlement without replaying or rewriting the unknown body', async () => {
    const f = await setup(2), input = request('interrupted', 'printf original')
    const first = await f.call(input)
    expect(first).toMatchObject({ status: 'succeeded', quiescent: true })
    await f.close()
    // Fault injection represents the Host retaining unknown before it could
    // accept the already persisted kernel-cleanup receipt. Cleanup stays real.
    f.db.prepare("UPDATE isolation_jobs SET status='unknown',result_json=?,version=version+1 WHERE id=?")
      .run(JSON.stringify({ ...first, status: 'unknown', quiescent: false, stdout: 'retained uncertainty', reason: 'Host settlement interrupted' }), first.jobId)
    await f.reopen()
    expect(await f.call(input)).toMatchObject({ jobId: first.jobId, status: 'unknown', quiescent: true, stdout: 'retained uncertainty', reason: 'Host settlement interrupted' })
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM isolation_audit WHERE action='supervisor-spawn-intent'").get()?.n).toBe(1)
    await groupsAbsent(f.db, 'interrupted')
    expect(await f.call(request('subsequent'))).toMatchObject({ status: 'succeeded', quiescent: true })
    expect(f.db.prepare('SELECT COUNT(*) AS n,SUM(reserved_duration_ms) AS duration FROM isolation_jobs').get()).toMatchObject({ n: 2, duration: 10000 })
    await expect(stat(join(f.root, 'docker-contacted'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('verifies the complete runtime before every new admission, while exact replay survives drift', async () => {
    const f = await setup()
    const input = request('verified')
    expect(await f.call(input)).toMatchObject({ status: 'succeeded' })
    await writeFile(join(f.config.linux!.runtime.cachePath, 'drift'), 'tampered')
    await expect(f.ctx.assistantIsolation.run(f.agent, request('denied'), f.signal)).rejects.toThrow('root differs')
    expect(await f.call(input)).toMatchObject({ status: 'succeeded' })
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(1)
  })

  test.each(['budget', 'capacity'] as const)('keeps old Docker uncertainty, socket identity and %s; same-key migration is an explicit conflict', async mode => {
    const f = await setup(mode === 'budget' ? 1 : 12)
    await f.close()
    const peer = new IsolationLedger(join(f.stateRoot, 'ledger.sqlite'))
    const authority = peer.claimController('historical', 30_000)
    try {
      const grant = f.config.grants![0]!
      const { principalDigest, principalRecordId, principalVersion, workspace, agentPreset } = grant
      const job = peer.prepare({ identity: { principalDigest, principalRecordId, principalVersion, workspace, agentPreset }, sessionId: String(f.agent.session.id), grantId: grant.id,
        idempotencyKey: 'legacy', requestDigest: 'legacy-unverifiable-digest', durationMs: 5000, authority, backend: 'docker' }).job
      const dispatched = peer.markDispatched(job.id, job.version, authority)
      peer.settle(job.id, dispatched.version, { jobId: job.id, status: 'unknown', quiescent: false,
        stdout: 'original Docker evidence', stderr: '', artifacts: [], reason: 'docker-creation-unconfirmed' }, authority)
    } finally { peer.releaseController(authority); peer.close() }
    await writeFile(join(f.stateRoot, 'docker-socket-path'), '/var/run/docker.sock\n', { mode: 0o600 })
    await f.reopen()
    await expect(f.ctx.assistantIsolation.run(f.agent, request('legacy'), f.signal)).rejects.toThrow('different request or backend')
    await expect(f.ctx.assistantIsolation.run(f.agent, request('fresh'), f.signal)).rejects.toThrow(mode === 'budget' ? 'budget' : 'active legacy job')
    expect(JSON.parse(f.db.prepare('SELECT result_json FROM isolation_jobs').get()?.result_json as string))
      .toMatchObject({ status: 'unknown', quiescent: false, stdout: 'original Docker evidence' })
    expect(await readdir(join(f.stateRoot, 'linux-executions'))).toEqual([])
    expect(await readFile(join(f.stateRoot, 'docker-socket-path'), 'utf8')).toBe('/var/run/docker.sock\n')
    await expect(stat(join(f.root, 'docker-contacted'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('binds a successful exported artifact to the exact goal contract for private readback', async () => {
    const f = await setup()
    const contract = createTaskAcceptanceContract({ protocol: 'task-acceptance/v4', id: 'goal-contract',
      scope: { workspace: f.project, preset: 'primary' }, owner: { principalRecordId: 'record-owner', principalVersion: 1 },
      task: { kind: 'goal-step', ref: 'round-1', goal: { id: 'goal-1', definitionVersion: 1, definitionDigest: 'a'.repeat(64),
        stepId: 'step-1', runId: 'round-1', sessionId: String(f.agent.session.id), nativeGoalId: 'native-1', nativeRevision: 1 } },
      objective: 'Export bounded artifact', profile: { id: 'profile', version: 1, digest: 'b'.repeat(64) },
      issuedAt: Date.now() - 1, expiresAt: Date.now() + 60_000,
      criteria: [{ id: 'artifact', kind: 'isolated-process-behavior', authority: { id: 'checker', digest: 'c'.repeat(64) }, artifactPath: 'report.txt', testSetId: 'held-out' }],
      bounds: { maxDurationMs: 5000, maxEvidenceBytes: 4096 } })
    f.admission({ protocol: 'goal-artifact-admission/v1', contractId: contract.id, contractDigest: contract.digest, runId: 'round-1', turn: 1 })
    const result = await f.call({ ...request('goal-artifact', 'cat input.txt > report.txt'), files: [{ path: 'input.txt', content: 'accepted artifact' }], artifacts: ['report.txt'] })
    expect(result).toMatchObject({ status: 'succeeded', quiescent: true })
    expect(f.ctx.assistantIsolation.readAcceptedArtifact(contract, 'report.txt')).toMatchObject({ jobId: result.jobId, content: 'accepted artifact' })
    expect(() => f.ctx.assistantIsolation.readAcceptedArtifact(contract, 'other.txt')).toThrow('unavailable')
  })
})
