import { createHash } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'

const seam = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => {}),
  configs: [] as unknown[],
}))
vi.mock('@dsh-enhanced/assistant-isolation', () => ({
  IsolatedVerifierRunner: class {
    constructor(config: unknown) { seam.configs.push(config) }
    run(...args: unknown[]) { return seam.run(...args) }
    close() { return seam.close() }
  },
}))

import { PluginBehaviorRunner } from '../src/plugin-behavior-runner.ts'

const authority = {
  stateRoot: '/private/state', image: 'sha256:' + 'a'.repeat(64), dockerPath: '/usr/bin/docker',
  authorityDigest: 'b'.repeat(64), expiresAt: Date.now() + 60_000, maxRuns: 2,
  maxTotalDurationMs: 20_000, maxDurationMs: 10_000, maxOutputBytes: 65_536,
}
const artifact = Buffer.from('fixture tgz bytes')
const artifactSha256 = createHash('sha256').update(artifact).digest('hex')
const schema = { name: 'probe_echo', description: 'Echo', parameters: { type: 'object', properties: {} } }
const schemaDigest = createHash('sha256').update(JSON.stringify([schema])).digest('hex')
const signal = new AbortController().signal
const result = (value: unknown, status = 'succeeded', quiescent = true) => ({
  jobId: 'job-1', status, quiescent, exitCode: 0,
  stdout: JSON.stringify(value) + '\n', stderr: '', artifacts: [],
})
const observed = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 2, boundary: 'process-seccomp-v1', status: 'observed', artifactSha256, quiescent: true, schemaDigest,
  environment: { node: 'v22.23.2', cordis: '4.0.2', tools: '0.1.5-rc.3', systemPrompt: '0.1.5-rc.3' },
  schemas: [schema], ...extra,
})
beforeEach(() => { seam.run.mockReset(); seam.close.mockClear(); seam.configs.length = 0 })

it('stages only canonical base64 artifact and bounded operation, with fixed command and frozen authority', async () => {
  seam.run.mockResolvedValue(result(observed()))
  const runner = new PluginBehaviorRunner(authority)
  const value = await runner.run({ key: 'candidate:discover', artifact, operation: { kind: 'discover' }, signal })
  expect(value).toMatchObject({ status: 'observed', quiescent: true, artifactSha256, schemaDigest, jobId: 'job-1' })
  expect(seam.configs[0]).toMatchObject({ authorityDigest: authority.authorityDigest,
    maxRuns: authority.maxRuns,
    command: 'exec /usr/bin/env LD_PRELOAD=/opt/dsh-plugin-verifier/parent-protect.so /usr/local/bin/node --disable-sigusr1 /opt/dsh-plugin-verifier/worker.mjs' })
  const [key, encoded, input] = seam.run.mock.calls[0]!
  expect(key).toBe('candidate:discover')
  expect(encoded).toBe(artifact.toString('base64'))
  expect(JSON.parse(input)).toEqual({ schemaVersion: 1, sha256: artifactSha256,
    sizeBytes: artifact.length, operation: { kind: 'discover' } })
  await runner.close()
  expect(seam.close).toHaveBeenCalledOnce()
})

it('retains raw native execution outcomes only when the discovered schema digest is exact', async () => {
  const operation = { kind: 'invoke' as const, schemaDigest, calls: [
    { id: 'call-1', toolName: 'probe_echo', arguments: { value: ['repeat', 'repeat'] } },
  ] }
  const native = { content: [{ type: 'text', text: 'echo' }], value: { echo: 'ok' } }
  seam.run.mockResolvedValue(result(observed({ schemas: undefined, calls: [
    { id: 'call-1', toolName: 'probe_echo', result: native },
  ] })))
  const runner = new PluginBehaviorRunner(authority)
  const value = await runner.run({ key: 'candidate:invoke', artifact, operation, signal })
  expect(value).toMatchObject({ status: 'observed', calls: [{ result: native }] })
  expect(seam.run).toHaveBeenCalledOnce()
  expect(JSON.parse(seam.run.mock.calls[0]![2]).operation).toEqual(operation)
  await runner.close()
})

it('accepts repeated JSON object references without treating them as cycles', async () => {
  const shared = { value: 1 }
  seam.run.mockResolvedValue(result(observed({ schemas: undefined, calls: [
    { id: 'call-1', toolName: 'probe_echo', result: { value: 1 } },
  ] })))
  const runner = new PluginBehaviorRunner(authority)
  const value = await runner.run({ key: 'repeated', artifact, operation: { kind: 'invoke', schemaDigest,
    calls: [{ id: 'call-1', toolName: 'probe_echo', arguments: { pair: [shared, shared] } }] }, signal })
  expect(value.status).toBe('observed')
  await runner.close()
})

it.each([
  ['non-object operation', null],
  ['empty calls', { kind: 'invoke', schemaDigest, calls: [] }],
  ['duplicate call IDs', { kind: 'invoke', schemaDigest, calls: [
    { id: 'x', toolName: 'probe_echo', arguments: {} }, { id: 'x', toolName: 'probe_echo', arguments: {} },
  ] }],
  ['oversized call data', { kind: 'invoke', schemaDigest, calls: [
    { id: 'x', toolName: 'probe_echo', arguments: { text: 'a'.repeat(65_536) } },
  ] }],
])('rejects %s without dispatch or fabricated observation', async (_label, operation) => {
  const runner = new PluginBehaviorRunner(authority)
  const value = await runner.run({ key: 'bad', artifact, operation: operation as never, signal })
  expect(value).toMatchObject({ status: 'unknown', quiescent: true })
  expect(seam.run).not.toHaveBeenCalled()
  await runner.close()
})

it('returns unknown for a package above the isolation input budget without dispatch', async () => {
  const runner = new PluginBehaviorRunner(authority)
  const value = await runner.run({ key: 'large', artifact: Buffer.alloc(512 * 1024 + 1),
    operation: { kind: 'discover' }, signal })
  expect(value).toMatchObject({ status: 'unknown', quiescent: true, reason: 'plugin-artifact-out-of-bound' })
  expect(seam.run).not.toHaveBeenCalled()
  await runner.close()
})

it.each([
  ['wrong schema digest', result(observed({ schemaDigest: '0'.repeat(64) }))],
  ['wrong artifact digest', result(observed({ artifactSha256: '0'.repeat(64) }))],
  ['legacy same-process worker', result(observed({ schemaVersion: 1, boundary: undefined }))],
  ['missing process boundary', result(observed({ boundary: undefined }))],
  ['stdout pollution', { ...result(observed()), stdout: 'candidate log\n' + JSON.stringify(observed()) + '\n' }],
  ['missing schema', result(observed({ schemas: [] }))],
  ['unknown process result', result(observed(), 'unknown', false)],
])('returns unknown for %s without replay', async (_label, isolated) => {
  seam.run.mockResolvedValue(isolated)
  const runner = new PluginBehaviorRunner(authority)
  const value = await runner.run({ key: 'one', artifact, operation: { kind: 'discover' }, signal })
  expect(value.status).toBe('unknown')
  expect(seam.run).toHaveBeenCalledOnce()
  await runner.close()
})

it('preserves a bounded worker unknown reason after proven isolation cleanup', async () => {
  seam.run.mockResolvedValue(result({ schemaVersion: 2, boundary: 'process-seccomp-v1', status: 'unknown', reason: 'plugin-fiber-not-active' }))
  const runner = new PluginBehaviorRunner(authority)
  expect(await runner.run({ key: 'pending', artifact, operation: { kind: 'discover' }, signal }))
    .toMatchObject({ status: 'unknown', quiescent: true, reason: 'plugin-fiber-not-active' })
  expect(seam.run).toHaveBeenCalledOnce()
  await runner.close()
})

it('treats a failed isolated runner or unresolved cleanup as unknown', async () => {
  seam.run.mockRejectedValue(new Error('unavailable'))
  const runner = new PluginBehaviorRunner(authority)
  expect(await runner.run({ key: 'one', artifact, operation: { kind: 'discover' }, signal }))
    .toMatchObject({ status: 'unknown', quiescent: false })
  expect(seam.run).toHaveBeenCalledOnce()
  await runner.close()
})
