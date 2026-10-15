import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
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
  NativeMacVerifierRunner: class {
    constructor(config: unknown) { seam.configs.push(config) }
    run(...args: unknown[]) { return seam.run(...args) }
    close() { return seam.close() }
  },
  validateNativeMacRuntime: (value: unknown) => value,
  nativeMacRuntimeDigest: () => 'c'.repeat(64),
}))

import { PluginBehaviorRunner, NATIVE_BEHAVIOR_BOUNDARY } from '../src/plugin-behavior-runner.ts'
import { behaviorNativeRuntimeDigest } from '../src/plugin-behavior-config.ts'

const authority = {
  stateRoot: '/private/state', image: 'sha256:' + 'a'.repeat(64), dockerPath: '/usr/bin/docker',
  authorityDigest: 'b'.repeat(64), expiresAt: Date.now() + 60_000, maxRuns: 2,
  maxTotalDurationMs: 20_000, maxDurationMs: 10_000, maxOutputBytes: 65_536,
}
const nativePlatform: 'darwin-arm64' | 'darwin-x64' = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
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

function nativePack(): Buffer {
  const entries = { 'package/package.json': JSON.stringify({ name: 'native-probe', version: '1.0.0', type: 'module', main: './lib/index.js' }),
    'package/lib/index.js': 'export default {}' }
  const records: Buffer[] = []
  for (const [name, content] of Object.entries(entries)) {
    const bytes = Buffer.from(content), header = Buffer.alloc(512)
    header.write(name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136)
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263)
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    records.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]))
}

it('native mode stages regular files, binds a fixed worker frame, and derives environment from runtime authority', async () => {
  const nativeArtifact = nativePack(), hash = createHash('sha256').update(nativeArtifact).digest('hex')
  const config = { backend: 'macos-seatbelt' as const, stateRoot: '/private/native-state', authorityDigest: 'b'.repeat(64),
    expiresAt: Date.now() + 60_000, maxRuns: 2, maxTotalDurationMs: 20_000, maxDurationMs: 10_000, maxOutputBytes: 65_536,
    runtime: { schemaVersion: 1 as const, platform: nativePlatform, nodePath: '/private/runtime/node', nodeSha256: 'd'.repeat(64),
      modulesPath: '/private/runtime/node_modules', roots: [{ path: '/private/runtime', dev: 1, ino: 1, sha256: 'e'.repeat(64) }], versions: {
        node: 'v24.22.0', typescript: '5.9.3', cordis: '4.0.4', tools: '0.2.0-rc.2', systemPrompt: '0.2.0-rc.2' } } }
  seam.run.mockImplementation((_key: string, files: unknown, stdin: string) => {
    expect(files).toEqual([{ path: 'package/package.json', content: expect.any(String) },
      { path: 'package/lib/index.js', content: 'export default {}' }])
    const request = JSON.parse(stdin) as { nonce: string; artifactSha256: string; operation: unknown }
    return result({ wireVersion: 1, nonce: request.nonce, artifactSha256: request.artifactSha256,
      operationDigest: createHash('sha256').update(JSON.stringify(request.operation)).digest('hex'),
      status: 'result', schemaDigest, schemas: [schema] })
  })
  const runner = new PluginBehaviorRunner(config)
  const observation = await runner.run({ key: 'native-discover', artifact: nativeArtifact, operation: { kind: 'discover' }, signal })
  expect(observation).toMatchObject({ status: 'observed', artifactSha256: hash,
    boundary: NATIVE_BEHAVIOR_BOUNDARY, runtimeDigest: behaviorNativeRuntimeDigest(config.runtime),
    environment: { node: 'v24.22.0', cordis: '4.0.4' } })
  expect((seam.configs[0] as { source: string }).source).toContain('registerHooks')
  await runner.close()
})

it('native mode rejects a forged or polluted frame without converting candidate stdout into Host authority', async () => {
  const nativeArtifact = nativePack()
  const config = { backend: 'macos-seatbelt' as const, stateRoot: '/private/native-state', authorityDigest: 'b'.repeat(64),
    expiresAt: Date.now() + 60_000, maxRuns: 2, maxTotalDurationMs: 20_000, maxDurationMs: 10_000, maxOutputBytes: 65_536,
    runtime: { schemaVersion: 1 as const, platform: nativePlatform, nodePath: '/private/runtime/node', nodeSha256: 'd'.repeat(64),
      modulesPath: '/private/runtime/node_modules', roots: [{ path: '/private/runtime', dev: 1, ino: 1, sha256: 'e'.repeat(64) }], versions: {
        node: 'v24.22.0', typescript: '5.9.3', cordis: '4.0.4', tools: '0.2.0-rc.2', systemPrompt: '0.2.0-rc.2' } } }
  seam.run.mockImplementation((_key: string, _files: unknown, stdin: string) => {
    const request = JSON.parse(stdin) as { artifactSha256: string; operation: unknown }
    return { ...result({ wireVersion: 1, nonce: '0'.repeat(64), artifactSha256: request.artifactSha256,
      operationDigest: createHash('sha256').update(JSON.stringify(request.operation)).digest('hex'),
      status: 'result', schemaDigest, schemas: [schema] }), stderr: '' }
  })
  const runner = new PluginBehaviorRunner(config)
  expect((await runner.run({ key: 'native-forged', artifact: nativeArtifact,
    operation: { kind: 'discover' }, signal })).status).toBe('unknown')
  await runner.close()
})

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
