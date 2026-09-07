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
