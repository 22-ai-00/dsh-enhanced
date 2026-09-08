import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { createDefinition } from '../src/definition.ts'
import { HoldoutAuthority, type HoldoutDataset } from '../src/holdout-authority.ts'
import { qualifyHoldout, type HoldoutQualificationInput } from '../src/holdout-qualification.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const digest = (letter: string) => letter.repeat(64)
const dataset: HoldoutDataset = { id: 'private', version: '1', cases: [
  { id: 'replay', kind: 'replay', stdin: 'r', expectedStdout: 'r', expectedExitCode: 0 },
  { id: 'evaluation', kind: 'evaluation', stdin: 'e', expectedStdout: 'e', expectedExitCode: 0 },
  { id: 'regression', kind: 'regression', stdin: 'g', expectedStdout: 'g', expectedExitCode: 0 },
] }
async function stateRoot() { const root = await mkdtemp(join(tmpdir(), 'holdout-qualification-')); roots.push(root); await chmod(root, 0o700); return root }
function skill(workspace: string, content: string) {
  const scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace, preset: 'primary' }
  return createDefinition({ protocol: 'assistant-goals/verified-workflow-source/v1', scope, goal: { id: 'goal', definition: { version: 1, digest: digest('a'), objective: 'write' }, sessionId: 'session', nativeGoalId: 'native' }, runId: 'run', turn: 1,
    acceptance: { contractId: 'contract', contractDigest: digest('b'), receiptDigest: digest('c'), verifiedAt: 1, validUntil: 2 }, steps: [{ id: 'write', toolName: 'write', arguments: { file_path: 'result.sh', content } }] },
  { name: 'result', description: 'Write result.' }, ['write'])
}
async function fixture() {
  const workspace = await stateRoot(), root = await stateRoot(), keys = generateKeyPairSync('ed25519')
  const authority = HoldoutAuthority.create({ dataset, privateKey: keys.privateKey, limits: { maxToolCalls: 2, maxOutputBytes: 1024 } })
  const input: Omit<HoldoutQualificationInput, 'transport'> = { baseline: skill(workspace, 'printf bad'), candidate: skill(workspace, 'cat'),
    scope: { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace, preset: 'primary' }, execution: { image: `sha256:${digest('d')}`, dockerPath: '/usr/bin/docker', stateRoot: root,
      command: '/bin/sh /workspace/artifact < /workspace/input', artifactPath: 'result.sh', expiresAt: Date.now() + 60000, repeats: 2, maxToolCalls: 2, maxBytes: 4096, maxOutputBytes: 1024, cellDurationMs: 2000, verificationDurationMs: 1000 },
    expectedDatasetDigest: acceptanceDigest(dataset), pinnedPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), signal: new AbortController().signal, authorize() {} }
  return { authority, input }
}

test('rejects a begin response whose key does not match the pinned authority key', async () => {
  const { authority, input } = await fixture()
  await expect(qualifyHoldout({ ...input, pinnedPublicKey: 'wrong-key', transport: { async request(operation, value) {
    if (operation === 'begin') return authority.begin(value as any)
    throw new Error('unexpected request')
  } } })).rejects.toThrow(/pinned key/)
})

test('rejects a begin response with an altered immutable arm binding', async () => {
  const { authority, input } = await fixture()
  await expect(qualifyHoldout({ ...input, transport: { async request(operation, value) {
    if (operation !== 'begin') throw new Error('unexpected request')
    return { ...authority.begin(value as any), candidateDigest: digest('f') }
  } } })).rejects.toThrow(/begin binding/)
})

test('does not execute or record an unsigned next cell', async () => {
  const { authority, input } = await fixture(); let records = 0
  await expect(qualifyHoldout({ ...input, transport: { async request(operation, value) {
    if (operation === 'begin') return authority.begin(value as any)
    if (operation === 'next') return { ...authority.next()!, signature: 'tampered' }
    if (operation === 'record') { records++; return authority.record(value as any) }
    throw new Error('unexpected request')
  } } })).rejects.toThrow(/next cell signature/)
  expect(records).toBe(0)
})

test('rejects a response for a different pinned dataset before issuing any cell', async () => {
  const { authority, input } = await fixture()
  await expect(qualifyHoldout({ ...input, expectedDatasetDigest: digest('e'), transport: { async request(operation, value) {
    if (operation === 'begin') return authority.begin(value as any)
    throw new Error('must not request private input')
  } } })).rejects.toThrow(/pinned plan/)
})

test('the authority binding changes with actual initial files and rejects an older plan', async () => {
  const { authority, input } = await fixture()
  let previous: unknown
  await expect(qualifyHoldout({ ...input, transport: { async request(operation, value) {
    if (operation !== 'begin') throw new Error('must not execute')
    previous = authority.begin(value as any)
    return { ...(previous as object), publicKey: 'deliberately stop first attempt before any cell' }
  } } })).rejects.toThrow(/pinned key/)
  await expect(qualifyHoldout({ ...input, files: [{ path: 'context.txt', content: 'different initial context' }], transport: { async request(operation) {
    if (operation !== 'begin') throw new Error('must not execute')
    return previous
  } } })).rejects.toThrow(/begin binding/)
})
