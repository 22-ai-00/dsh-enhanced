import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTaskAcceptanceContract, type TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import { createVerifierAuthorities, verifyAcceptanceCriteria, type IsolatedRunnerAuthority, type IsolatedVerificationContext } from '../src/drivers.ts'

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function stateRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'isolated-verifier-')); cleanup.push(root); return root }
async function authority(testSetId = 'private-set'): Promise<IsolatedRunnerAuthority> {
  const root = await stateRoot()
  const [compiled] = createVerifierAuthorities({ authorities: [{
    kind: 'isolated-runner', id: 'isolation-runner', stateRoot: root, image: `sha256:${'a'.repeat(64)}`,
    dockerPath: realpathSync(process.execPath), command: '/bin/sh /workspace/artifact < /workspace/input',
    expiresAt: Date.now() + 60_000, maxRuns: 10, maxTotalDurationMs: 10_000, maxDurationMs: 1_000,
    maxOutputBytes: 1_024, testSets: [{ id: testSetId, cases: [{ stdin: 'private-stdin', expectedStdout: 'private-output', expectedExitCode: 0 }] }],
  }] })
  if (compiled?.kind !== 'isolated-runner') throw new Error('missing isolated authority')
  return compiled
}
function contract(authority: IsolatedRunnerAuthority, testSetId = 'private-set'): TaskAcceptanceContract {
  const issuedAt = Date.now()
  return createTaskAcceptanceContract({
    protocol: 'task-acceptance/v4', id: 'isolated-contract', scope: { workspace: '/workspace/task', preset: 'test' },
    owner: { principalRecordId: 'owner-1', principalVersion: 1 },
    task: { kind: 'goal-step', ref: 'run-1', goal: { id: 'goal-1', definitionVersion: 1, definitionDigest: 'b'.repeat(64), stepId: 'step-1', runId: 'run-1', sessionId: 'session-1', nativeGoalId: 'native-goal-1', nativeRevision: 1 } },
    objective: 'verify behavior', profile: { id: 'profile-1', version: 1, digest: 'c'.repeat(64) }, issuedAt, expiresAt: issuedAt + 30_000,
    criteria: [{ id: 'isolated', kind: 'isolated-process-behavior', authority: { id: authority.id, digest: authority.digest }, artifactPath: 'artifacts/result.sh', testSetId }],
    bounds: { maxDurationMs: 5_000, maxEvidenceBytes: 4_096 },
  })
}
function context(content = 'echo artifact', mutate = false): IsolatedVerificationContext {
  let read = 0
  const initial = { jobId: 'job-1', requestDigest: 'd'.repeat(64), path: 'artifacts/result.sh', content, sha256: sha(content) }
  return {
    async readArtifact() { read += 1; return mutate && read > 1 ? { ...initial, content: `${content}-changed`, sha256: sha(`${content}-changed`) } : initial },
    async run(_authority, _key, _artifact, _stdin) { return { jobId: 'verification-job-1', status: 'succeeded', quiescent: true, exitCode: 0, stdout: 'private-output', stderr: '' } },
  }
}

describe('isolated acceptance driver', () => {
  it('uses a Host snapshot and isolated runner callback to verify a private test set', async () => {
    const compiled = await authority(); const accepted = contract(compiled)
    const result = await verifyAcceptanceCriteria(accepted, [compiled], new AbortController().signal, context())
    expect(result).toMatchObject([{ status: 'passed', reason: 'verified', artifactDigest: sha('echo artifact') }])
    const wire = JSON.stringify(result)
    expect(wire).not.toContain('private-stdin')
    expect(wire).not.toContain('private-output')
    expect(wire).not.toContain(compiled.stateRoot)
  })

  it('reports deterministic mismatches and never treats unknown or non-quiescent runs as passed', async () => {
    const compiled = await authority(); const accepted = contract(compiled)
    const wrong = context(); wrong.run = async () => ({ jobId: 'job-1', status: 'succeeded', quiescent: true, exitCode: 0, stdout: 'wrong', stderr: '' })
    await expect(verifyAcceptanceCriteria(accepted, [compiled], new AbortController().signal, wrong)).resolves.toMatchObject([{ status: 'failed', reason: 'isolated-unexpected-stdout' }])
    const unknown = context(); unknown.run = async () => ({ jobId: 'job-1', status: 'unknown', quiescent: false, stdout: '', stderr: '' })
    await expect(verifyAcceptanceCriteria(accepted, [compiled], new AbortController().signal, unknown)).resolves.toMatchObject([{ status: 'unknown', reason: 'isolated-run-unknown' }])
  })

  it('fails closed for absent context, changed snapshots, authority mismatch, and missing test sets', async () => {
    const compiled = await authority(); const accepted = contract(compiled)
    await expect(verifyAcceptanceCriteria(accepted, [compiled], new AbortController().signal)).resolves.toMatchObject([{ status: 'unknown', reason: 'isolated-context-unavailable' }])
    await expect(verifyAcceptanceCriteria(accepted, [compiled], new AbortController().signal, context('echo artifact', true))).resolves.toMatchObject([{ status: 'unknown', reason: 'isolated-artifact-altered' }])
    const wrongAuthority = contract({ ...compiled, digest: '0'.repeat(64) })
    await expect(verifyAcceptanceCriteria(wrongAuthority, [compiled], new AbortController().signal, context())).resolves.toMatchObject([{ status: 'unknown', reason: 'authority-mismatch' }])
    const wrongSet = contract(compiled, 'absent-set')
    await expect(verifyAcceptanceCriteria(wrongSet, [compiled], new AbortController().signal, context())).resolves.toMatchObject([{ status: 'unknown', reason: 'isolated-test-set-unavailable' }])
  })

  it('rejects unsafe isolated authority configuration before a runner callback exists', async () => {
    const root = await stateRoot()
    expect(() => createVerifierAuthorities({ authorities: [{ kind: 'isolated-runner', id: 'bad', stateRoot: root, image: 'latest', dockerPath: realpathSync(process.execPath), command: 'any', expiresAt: 1, maxRuns: 1, maxTotalDurationMs: 1_000, maxDurationMs: 2_000, maxOutputBytes: 1, testSets: [] }] })).toThrow(/pinned|duration|testSets/i)
  })
})

function nativeInput() {
  const root = '/private/native-verifier-runtime'
  return { kind: 'isolated-runner' as const, id: 'native-runner', backend: 'linux-native' as const,
    stateRoot: '/private/native-verifier-state',
    runtime: { schemaVersion: 1 as const, backend: 'linux-native' as const,
      platform: `linux-${process.arch}` as 'linux-arm64' | 'linux-x64', sourceCommit: '1'.repeat(40), lockSha256: '2'.repeat(64),
      root: { path: root, dev: 1, ino: 2, sha256: '3'.repeat(64) }, nodePath: `${root}/bin/node`, nodeSha256: '4'.repeat(64),
      pnpmPath: `${root}/pnpm/bin/pnpm.mjs`, nativePnpmRoot: `${root}/pnpm-native`, nativePnpmPath: `${root}/pnpm-native/pnpm`,
      modulesPath: `${root}/node_modules`, storePath: `${root}/store`, cachePath: `${root}/cache`,
      versions: { node: 'v22.23.2' as const, pnpm: '11.7.0' as const, typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } },
    cgroupRoots: { mode: 'v1' as const, cpu: '/sys/fs/cgroup/cpu/dsh-native/uid-1000',
      memory: '/sys/fs/cgroup/memory/dsh-native/uid-1000', pids: '/sys/fs/cgroup/pids/dsh-native/uid-1000', freezer: '/sys/fs/cgroup/freezer/dsh-native/uid-1000' },
    command: '/bin/sh /workspace/artifact < /workspace/input', expiresAt: 2_000_000,
    maxRuns: 2, maxTotalDurationMs: 60_000, maxDurationMs: 1_000, maxOutputBytes: 4_096,
    testSets: [{ id: 'private-set', cases: [{ stdin: 'private-input', expectedStdout: 'private-output', expectedExitCode: 0 }] }] }
}
function compileNative(input: unknown = nativeInput()) {
  const [compiled] = createVerifierAuthorities({ authorities: [input] })
  if (compiled?.kind !== 'isolated-runner' || compiled.backend !== 'linux-native') throw new Error('missing native authority')
  return compiled
}

it('preserves the pre-native Docker normalized bytes/digest with omitted or explicit docker backend', () => {
  const input = { kind: 'isolated-runner', id: 'legacy-fixed', stateRoot: '/private/verifier-state',
    image: `sha256:${'a'.repeat(64)}`, dockerPath: '/usr/bin/true', command: '/bin/sh /workspace/artifact < /workspace/input',
    expiresAt: 2_000_000, maxRuns: 2, maxTotalDurationMs: 60_000, maxDurationMs: 1_000, maxOutputBytes: 4_096,
    testSets: [{ id: 'private-set', cases: [{ stdin: 'private-input', expectedStdout: 'private-output', expectedExitCode: 0 }] }] }
  const [legacy] = createVerifierAuthorities({ authorities: [input] })
  expect(legacy?.digest).toBe('acf5cfc56128d69d73a7cf718381a2a66fd0d7c814db3ac43a396422dcbe6735')
  expect(JSON.stringify(legacy)).toBe(JSON.stringify({ ...input, digest: 'acf5cfc56128d69d73a7cf718381a2a66fd0d7c814db3ac43a396422dcbe6735' }))
  const [explicit] = createVerifierAuthorities({ authorities: [{ ...input, backend: 'docker' }] })
  expect(JSON.stringify(explicit)).toBe(JSON.stringify(legacy))
})

it('compiles native authority synchronously without runtime files and deep freezes detached identity and held-out cases', () => {
  const input = nativeInput(), compiled = compileNative(input), before = JSON.stringify(compiled)
  for (const object of [compiled, compiled.runtime, compiled.runtime.root, compiled.runtime.versions, compiled.cgroupRoots, compiled.testSets, compiled.testSets[0]!.cases[0]]) expect(Object.isFrozen(object)).toBe(true)
  input.runtime.root.sha256 = '5'.repeat(64); input.cgroupRoots.cpu = '/sys/fs/cgroup/cpu2/dsh-native/uid-1000'
  input.testSets[0]!.cases[0]!.expectedStdout = 'changed'
  expect(JSON.stringify(compiled)).toBe(before)
  expect(compileNative(input).digest).not.toBe(compiled.digest)
  expect(compiled).not.toHaveProperty('image'); expect(compiled).not.toHaveProperty('dockerPath')
})

it('binds every native runtime identity, cgroup root and finite limit in authority digest', () => {
  const original = compileNative()
  for (const change of [
    (x: ReturnType<typeof nativeInput>) => { x.runtime.sourceCommit = '5'.repeat(40) },
    (x: ReturnType<typeof nativeInput>) => { x.runtime.nodeSha256 = '6'.repeat(64) },
    (x: ReturnType<typeof nativeInput>) => { x.runtime.root.ino++ },
    (x: ReturnType<typeof nativeInput>) => { x.cgroupRoots.freezer = '/sys/fs/cgroup/freezer2/dsh-native/uid-1000' },
    (x: ReturnType<typeof nativeInput>) => { x.expiresAt++ },
    (x: ReturnType<typeof nativeInput>) => { x.maxRuns++ },
  ]) { const input = nativeInput(); change(input); expect(compileNative(input).digest).not.toBe(original.digest) }
})

it('rejects mixed/unknown backends, cgroup v2, malformed paths/overlap and accessor-shaped runtime', () => {
  const base = nativeInput()
  for (const input of [
    { ...base, backend: 'future' }, { ...base, image: `sha256:${'a'.repeat(64)}` },
    { ...base, dockerPath: '/usr/bin/true' }, { ...base, backend: 'docker' },
    { ...base, cgroupRoots: { mode: 'v2', unified: '/sys/fs/cgroup/dsh-native/uid-1000' } },
    { ...base, stateRoot: base.runtime.root.path }, { ...base, stateRoot: `${base.runtime.root.path}/state` },
    { ...base, stateRoot: '/private' }, { ...base, stateRoot: base.cgroupRoots.cpu },
    { ...base, stateRoot: '/private/state\nunsafe' }, { ...base, stateRoot: '/private/state\\unsafe' },
    { ...base, runtime: { ...base.runtime, nodePath: '/outside/node' } },
    { ...base, runtime: { ...base.runtime, schemaVersion: 2 } },
    { ...base, cgroupRoots: { ...base.cgroupRoots, memory: base.cgroupRoots.cpu } },
  ]) expect(() => createVerifierAuthorities({ authorities: [input] })).toThrow()
  let read = 0
  const runtime = { ...base.runtime, get root() { read++; return base.runtime.root } }
  expect(() => createVerifierAuthorities({ authorities: [{ ...base, runtime }] })).toThrow('unsupported fields')
  expect(read).toBe(0)
})

it('native compilation keeps the existing private criterion comparison and post-run artifact reread', async () => {
  const compiled = compileNative({ ...nativeInput(), expiresAt: Date.now() + 60_000 }), accepted = contract(compiled)
  expect(await verifyAcceptanceCriteria(accepted, [compiled], new AbortController().signal, context())).toMatchObject([{ status: 'passed' }])
  const wrong = context(); wrong.run = async () => ({ jobId: 'native-case', status: 'succeeded', quiescent: true, exitCode: 1, stdout: 'private-output', stderr: '' })
  expect(await verifyAcceptanceCriteria(accepted, [compiled], new AbortController().signal, wrong)).toMatchObject([{ status: 'failed' }])
  expect(await verifyAcceptanceCriteria(accepted, [compiled], new AbortController().signal, context('echo artifact', true))).toMatchObject([{ status: 'unknown', reason: 'isolated-artifact-altered' }])
})
