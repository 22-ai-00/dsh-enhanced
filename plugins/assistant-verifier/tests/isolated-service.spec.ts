import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import { AssistantVerifierService } from '../src/service.ts'
import { createVerifierAuthorities, type NativeIsolatedRunnerAuthorityInput } from '../src/drivers.ts'
import type { AcceptanceHandle, AcceptanceTask, AcceptedExecution, TaskAcceptanceProducer, TaskAcceptanceRegistration } from '../src/host.ts'

// Records service dispatch only. This seam is not Linux execution evidence.
const runnerCalls = vi.hoisted(() => ({ created: [] as Record<string, unknown>[], runs: 0, closed: 0, onRun: undefined as (() => void) | undefined }))
vi.mock('@dsh-enhanced/assistant-isolation', async importOriginal => {
  const actual = await importOriginal<typeof import('@dsh-enhanced/assistant-isolation')>()
  return { ...actual, IsolatedVerifierRunner: class {
    constructor(input: Record<string, unknown>) { runnerCalls.created.push(input) }
    async run() { runnerCalls.runs++; runnerCalls.onRun?.(); return { jobId: 'private-verification', status: 'succeeded', quiescent: true,
      exitCode: 0, stdout: 'private-output', stderr: '' } }
    async close() { runnerCalls.closed++ }
  } }
})
const roots: string[] = []
const contexts: Context[] = []
const sha = 'a'.repeat(64)
afterEach(async () => {
  runnerCalls.created.splice(0); runnerCalls.runs = 0; runnerCalls.closed = 0; runnerCalls.onRun = undefined
  for (const ctx of contexts.splice(0)) await ctx.fiber.restart()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class GoalsProducer implements TaskAcceptanceProducer {
  registration: TaskAcceptanceRegistration | undefined
  #generation = crypto.randomUUID()
  source: AcceptanceHandle | null = null
  changeGenerationDuringSource = false
  readonly proofs = new Map<string, AcceptedExecution>()
  trustedAcceptanceProducerGeneration() { return this.#generation }
  registerTaskAcceptanceSink(registration: TaskAcceptanceRegistration) {
    const owner = registration.owner as AssistantVerifierService
    if (!owner.ownsTaskAcceptanceRegistration(registration)) throw new Error('foreign registration')
    this.registration = registration
    return () => { if (this.registration === registration) this.registration = undefined }
  }
  async inspectAcceptedArtifactSource(_contract: TaskAcceptanceContract) {
    const source = this.source
    if (this.changeGenerationDuringSource) this.#generation = crypto.randomUUID()
    return source
  }
  async inspectAcceptedExecution(contract: TaskAcceptanceContract) { return this.proofs.get(contract.id) ?? null }
  complete(handle: AcceptanceHandle, ref: string) {
    this.proofs.set(handle.contractId, { ...handle, dispatchedAt: 2_000, completedAt: 2_000, status: 'succeeded', quiescent: true, executionRef: ref })
  }
}

type GoalStepTask = AcceptanceTask & { readonly task: Extract<AcceptanceTask['task'], { kind: 'goal-step' }> }
function step(ref = 'run-1', owner = 'owner-1', definitionDigest = sha): GoalStepTask {
  return { scope: { workspace: '', preset: 'primary' }, owner: { principalRecordId: owner, principalVersion: 1 },
    task: { kind: 'goal-step', ref, goal: { id: 'goal-1', definitionVersion: 1, definitionDigest, stepId: 'step-1', runId: ref, sessionId: 'session-1', nativeGoalId: 'native-1', nativeRevision: 1 } },
    objective: 'verify isolated behavior' }
}
async function harness(withIsolation = true, acceptedArtifact = false) {
  const root = await mkdtemp(join(tmpdir(), 'verifier-isolated-service-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx); const producer = new GoalsProducer(); ctx.provide('assistantGoals' as never, producer as never)
  let artifactReads = 0
  if (withIsolation) ctx.provide('assistantIsolation' as never, {
    readAcceptedArtifact: () => {
      artifactReads++
      if (!acceptedArtifact) throw new Error('artifact-read-sentinel')
      const content = 'echo candidate'
      return { jobId: 'original-artifact-job', requestDigest: 'd'.repeat(64), path: 'artifacts/result.sh', content,
        sha256: createHash('sha256').update(content).digest('hex') }
    },
  } as never)
  const runtimeRoot = '/private/service-native-runtime'
  const backend: Pick<NativeIsolatedRunnerAuthorityInput, 'backend' | 'runtime' | 'cgroupRoots'> = { backend: 'linux-native' as const,
    runtime: { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as 'linux-x64' | 'linux-arm64', sourceCommit: '1'.repeat(40), lockSha256: sha,
      root: { path: runtimeRoot, dev: 1, ino: 2, sha256: sha }, nodePath: `${runtimeRoot}/bin/node`, nodeSha256: sha,
      pnpmPath: `${runtimeRoot}/pnpm/bin/pnpm.mjs`, nativePnpmRoot: `${runtimeRoot}/pnpm-native`, nativePnpmPath: `${runtimeRoot}/pnpm-native/pnpm`,
      modulesPath: `${runtimeRoot}/node_modules`, storePath: `${runtimeRoot}/store`, cachePath: `${runtimeRoot}/cache`,
      versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } },
    cgroupRoots: { mode: 'v1', cpu: '/sys/fs/cgroup/cpu/dsh-native/uid-1000', memory: '/sys/fs/cgroup/memory/dsh-native/uid-1000',
      pids: '/sys/fs/cgroup/pids/dsh-native/uid-1000', freezer: '/sys/fs/cgroup/freezer/dsh-native/uid-1000' } }
  const authority = { kind: 'isolated-runner' as const, id: 'isolation-runner', stateRoot: root, ...backend, command: '/bin/sh /workspace/artifact < /workspace/input', expiresAt: Date.now() + 60_000,
    maxRuns: 2, maxTotalDurationMs: 60_000, maxDurationMs: 1_000, maxOutputBytes: 4_096,
    testSets: [{ id: 'private-set', cases: [{ stdin: 'private-input', expectedStdout: 'private-output', expectedExitCode: 0 }] }] }
  const [compiled] = createVerifierAuthorities({ authorities: [authority] })
  if (compiled?.kind !== 'isolated-runner') throw new Error('missing isolated authority')
  const main = { ...step(), scope: { workspace: root, preset: 'primary' } }
  const foreignOwner = { ...step('run-owner', 'owner-foreign'), scope: main.scope }
  const foreignDefinition = { ...step('run-definition', 'owner-1', 'b'.repeat(64)), scope: main.scope }
  const outcome: AcceptanceTask = { ...main, task: { kind: 'goal-outcome', ref: 'assessment-1', goal: { id: 'goal-1', definitionVersion: 1, definitionDigest: sha, assessmentId: 'assessment-1', sessionId: 'session-1', nativeGoalId: 'native-1' } } }
  const profiles = [main, foreignOwner, outcome].map((task, index) => ({ id: `profile-${index}`, version: 1, scope: task.scope, owner: task.owner, taskKind: task.task.kind, objective: task.objective,
    validityMs: 10_000, bounds: { maxDurationMs: 1_000, maxEvidenceBytes: 4_096 },
    criteria: [{ id: 'isolated', kind: 'isolated-process-behavior' as const, authority: { id: compiled.id, digest: compiled.digest }, artifactPath: 'artifacts/result.sh', testSetId: 'private-set' }] }))
  const service = new AssistantVerifierService(ctx, { databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: true, authorities: [authority], profiles }, { now: () => 2_000 })
  const prepare = (task: AcceptanceTask) => producer.registration!.prepare(task)!
  const finish = async (handle: AcceptanceHandle, task: AcceptanceTask) => { producer.complete(handle, task.task.ref); await producer.registration!.completed(handle); await service.tick(); return service.inspect(handle.contractId) }
  return { producer, service, main, outcome, foreignOwner, foreignDefinition, artifactReads: () => artifactReads, prepare, finish }
}

describe('v4 isolated service provenance', () => {
  it('uses an exact goal-step source handle before Isolation rejects the artifact read', async () => {
    const { producer, main, artifactReads, prepare, finish } = await harness(); const handle = prepare(main)
    producer.source = handle
    const state = await finish(handle, main)
    expect(state).toMatchObject({ receipt: { protocol: 'task-verification/v4', objectiveStatus: 'unknown', results: [{ status: 'unknown' }] } })
    expect(artifactReads()).toBeGreaterThan(0)
  })

  it('does not let a foreign owner, definition, or run source pass for the current v4 step', async () => {
    for (const sourceKind of ['owner', 'definition', 'run'] as const) {
      const { producer, main, foreignOwner, foreignDefinition, artifactReads, prepare, finish } = await harness()
      const target = prepare(main)
      const foreign = sourceKind === 'owner' ? foreignOwner : sourceKind === 'definition' ? foreignDefinition
        : { ...main, task: { ...main.task, ref: 'run-other', goal: { ...main.task.goal, runId: 'run-other' } } }
      producer.source = prepare(foreign)
      const state = await finish(target, main)
      expect(state).toMatchObject({ receipt: { protocol: 'task-verification/v4', objectiveStatus: 'unknown', results: [{ status: 'unknown' }] } })
      expect(artifactReads()).toBe(0)
    }
  })

  it('fails closed when the source is absent or the Goals producer generation changes', async () => {
    const { producer, main, artifactReads, prepare, finish } = await harness(); const missing = prepare(main)
    producer.source = null
    expect(await finish(missing, main)).toMatchObject({ receipt: { protocol: 'task-verification/v4', objectiveStatus: 'unknown' } })
    expect(artifactReads()).toBe(0)
    const changed = prepare({ ...main, task: { ...main.task, ref: 'run-changed', goal: { ...main.task.goal, runId: 'run-changed' } } })
    producer.source = changed; producer.changeGenerationDuringSource = true
    expect(await finish(changed, { ...main, task: { ...main.task, ref: 'run-changed', goal: { ...main.task.goal, runId: 'run-changed' } } })).toMatchObject({ receipt: { protocol: 'task-verification/v4', objectiveStatus: 'unknown' } })
    expect(artifactReads()).toBe(0)
  })

  it('emits an unknown v4 receipt when Isolation is missing after valid source provenance', async () => {
    const { producer, main, artifactReads, prepare, finish } = await harness(false); const handle = prepare(main)
    producer.source = handle
    expect(await finish(handle, main)).toMatchObject({ receipt: { protocol: 'task-verification/v4', objectiveStatus: 'unknown' } })
    expect(artifactReads()).toBe(0)
  })

  it('requires a whole-goal v4 assessment to point at its real goal-step source', async () => {
    const { producer, main, outcome, artifactReads, prepare, finish } = await harness()
    const source = prepare(main); const assessment = prepare(outcome)
    producer.source = source
    expect(await finish(assessment, outcome)).toMatchObject({ receipt: { protocol: 'task-verification/v4', task: { kind: 'goal-outcome', ref: 'assessment-1' }, objectiveStatus: 'unknown' } })
    expect(artifactReads()).toBeGreaterThan(0)
  })
})

describe('compiled isolated authority backend dispatch (recording runner seam)', () => {
  it('dispatches the native runner with exact finite terms and reuses the authority runner', async () => {
    const h = await harness(true, true), handle = h.prepare(h.main)
    h.producer.source = handle
    expect(await h.finish(handle, h.main)).toMatchObject({ receipt: { objectiveStatus: 'achieved' } })
    expect(runnerCalls.created).toHaveLength(1); expect(runnerCalls.runs).toBe(1)
    const config = runnerCalls.created[0]!
    expect(config).toMatchObject({ expiresAt: expect.any(Number), maxRuns: 2, maxTotalDurationMs: 60_000,
      maxDurationMs: 1_000, maxOutputBytes: 4_096, authorityDigest: expect.any(String),
      backend: 'linux-native', runtime: { schemaVersion: 1 }, cgroupRoots: { mode: 'v1' } })
    expect(config).not.toHaveProperty('image'); expect(config).not.toHaveProperty('dockerPath')
    await h.finish(handle, h.main)
    expect(runnerCalls.created).toHaveLength(1); expect(runnerCalls.runs).toBe(1)
  })

  it('native cannot bypass owner/source or producer generation fences to create a runner', async () => {
    for (const change of ['owner', 'generation'] as const) {
      const h = await harness(true, true), handle = h.prepare(h.main)
      if (change === 'owner') h.producer.source = h.prepare(h.foreignOwner)
      else { h.producer.source = handle; h.producer.changeGenerationDuringSource = true }
      expect(await h.finish(handle, h.main)).toMatchObject({ receipt: { objectiveStatus: 'unknown' } })
      expect(runnerCalls.created).toHaveLength(0); expect(runnerCalls.runs).toBe(0)
    }
  })
})

it('native dispatch still rejects a producer generation changed during independent case execution', async () => {
  const h = await harness(true, true), handle = h.prepare(h.main)
  h.producer.source = handle
  runnerCalls.onRun = () => { h.producer.changeGenerationDuringSource = true }
  expect(await h.finish(handle, h.main)).toMatchObject({ receipt: { objectiveStatus: 'unknown' } })
  expect(runnerCalls.runs).toBe(1)
  expect(runnerCalls.created).toHaveLength(1)
})
