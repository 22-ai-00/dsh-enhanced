import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { beforeEach, expect, it, vi } from 'vitest'

const seam = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => {}),
  configs: [] as unknown[],
}))
vi.mock('@dsh-enhanced/assistant-isolation', () => ({
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

const nativePlatform: 'darwin-arm64' | 'darwin-x64' = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
const authority = {
  backend: 'macos-seatbelt' as const,
  stateRoot: '/private/state',
  authorityDigest: 'b'.repeat(64), expiresAt: Date.now() + 60_000, maxRuns: 2,
  maxTotalDurationMs: 20_000, maxDurationMs: 10_000, maxOutputBytes: 65_536,
  runtime: { schemaVersion: 1 as const, platform: nativePlatform,
    nodePath: '/private/runtime/node', nodeSha256: 'd'.repeat(64),
    modulesPath: '/private/runtime/node_modules', roots: [{ path: '/private/runtime', dev: 1, ino: 1, sha256: 'e'.repeat(64) }],
    versions: { node: 'v24.22.0', typescript: '5.9.3', cordis: '4.0.4', tools: '0.2.0-rc.2', systemPrompt: '0.2.0-rc.2' } },
}
// The native backend stages a real tgz pack; every case here uses one so the
// runner reaches the frame-parsing logic under test.
const artifact = nativePack()
const artifactSha256 = createHash('sha256').update(artifact).digest('hex')
const schema = { name: 'probe_echo', description: 'Echo', parameters: { type: 'object', properties: {} } }
const schemaDigest = createHash('sha256').update(JSON.stringify([schema])).digest('hex')
const signal = new AbortController().signal

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

/** Parses the runner's request from the supervisor stdin and answers with a matching native wire frame. */
function nativeResponse(
  stdin: string,
  body: Record<string, unknown>,
  extra: { status?: string; quiescent?: boolean; stdoutPrefix?: string } = {},
) {
  const request = JSON.parse(stdin) as { nonce: string; artifactSha256: string; operation: unknown }
  const frame = { wireVersion: 1, nonce: request.nonce, artifactSha256: request.artifactSha256,
    operationDigest: createHash('sha256').update(JSON.stringify(request.operation)).digest('hex'),
    ...body }
  return {
    jobId: 'job-1', status: extra.status ?? 'succeeded', quiescent: extra.quiescent ?? true, exitCode: 0,
    stdout: (extra.stdoutPrefix ?? '') + JSON.stringify(frame) + '\n', stderr: '', artifacts: [],
  }
}

it('native mode stages regular files, binds a fixed worker frame, and derives environment from runtime authority', async () => {
  const nativeArtifact = nativePack(), hash = createHash('sha256').update(nativeArtifact).digest('hex')
  const config = { ...authority, stateRoot: '/private/native-state',
    runtime: { ...authority.runtime, nodePath: '/private/runtime/node' } }
  seam.run.mockImplementation((_key: string, files: unknown, stdin: string) => {
    expect(files).toEqual([{ path: 'package/package.json', content: expect.any(String) },
      { path: 'package/lib/index.js', content: 'export default {}' }])
    return nativeResponse(stdin, { status: 'result', schemaDigest, schemas: [schema] })
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
  seam.run.mockImplementation((_key: string, _files: unknown, stdin: string) => {
    const frame = nativeResponse(stdin, { status: 'result', schemaDigest, schemas: [schema] })
    return { ...frame, stdout: JSON.stringify({ ...JSON.parse(frame.stdout),
      nonce: '0'.repeat(64) }) + '\n' }
  })
  const runner = new PluginBehaviorRunner(authority)
  expect((await runner.run({ key: 'native-forged', artifact: nativeArtifact,
    operation: { kind: 'discover' }, signal })).status).toBe('unknown')
  await runner.close()
})

it('stages a canonical artifact with a frozen native authority', async () => {
  seam.run.mockImplementation((...args: unknown[]) => nativeResponse(args[2] as string,
    { status: 'result', schemaDigest, schemas: [schema] }))
  const runner = new PluginBehaviorRunner(authority)
  const value = await runner.run({ key: 'candidate:discover', artifact, operation: { kind: 'discover' }, signal })
  expect(value).toMatchObject({ status: 'observed', quiescent: true, artifactSha256, schemaDigest, jobId: 'job-1' })
  expect(seam.configs[0]).toMatchObject({ authorityDigest: authority.authorityDigest,
    maxRuns: authority.maxRuns, source: expect.any(String) })
  const [key, files, input] = seam.run.mock.calls[0]!
  expect(key).toBe('candidate:discover')
  expect(files as { path: string }[]).toContainEqual({ path: 'package/package.json', content: expect.any(String) })
  expect(JSON.parse(input as string)).toMatchObject({ schemaVersion: 1, artifactSha256 })
  await runner.close()
  expect(seam.close).toHaveBeenCalledOnce()
})

it('retains raw native execution outcomes only when the discovered schema digest is exact', async () => {
  const operation = { kind: 'invoke' as const, schemaDigest, calls: [
    { id: 'call-1', toolName: 'probe_echo', arguments: { value: ['repeat', 'repeat'] } },
  ] }
  const native = { content: [{ type: 'text', text: 'echo' }], value: { echo: 'ok' } }
  seam.run.mockImplementation((...args: unknown[]) => nativeResponse(args[2] as string,
    { status: 'result', schemaDigest, calls: [{ id: 'call-1', toolName: 'probe_echo', result: native }] }))
  const runner = new PluginBehaviorRunner(authority)
  const value = await runner.run({ key: 'candidate:invoke', artifact, operation, signal })
  expect(value).toMatchObject({ status: 'observed', calls: [{ result: native }] })
  expect(seam.run).toHaveBeenCalledOnce()
  expect(JSON.parse(seam.run.mock.calls[0]![2] as string).operation).toEqual(operation)
  await runner.close()
})

it('accepts repeated JSON object references without treating them as cycles', async () => {
  seam.run.mockImplementation((...args: unknown[]) => nativeResponse(args[2] as string,
    { status: 'result', schemaDigest, calls: [{ id: 'call-1', toolName: 'probe_echo', result: { value: 1 } }] }))
  const runner = new PluginBehaviorRunner(authority)
  const value = await runner.run({ key: 'repeated', artifact, operation: { kind: 'invoke', schemaDigest,
    calls: [{ id: 'call-1', toolName: 'probe_echo', arguments: { pair: [{ value: 1 }, { value: 1 }] } }] }, signal })
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
  ['wrong schema digest', (stdin: string) => nativeResponse(stdin, { status: 'result', schemaDigest: '0'.repeat(64), schemas: [schema] })],
  ['wrong artifact digest', (stdin: string) => {
    const frame = nativeResponse(stdin, { status: 'result', schemaDigest, schemas: [schema] })
    return { ...frame, stdout: JSON.stringify({ ...JSON.parse(frame.stdout), artifactSha256: '0'.repeat(64) }) + '\n' }
  }],
  ['stdout pollution', (stdin: string) => {
    const frame = nativeResponse(stdin, { status: 'result', schemaDigest, schemas: [schema] })
    return { ...frame, stdout: `candidate log\n${frame.stdout}` }
  }],
  ['missing schema', (stdin: string) => nativeResponse(stdin, { status: 'result', schemaDigest, schemas: [] })],
  ['unknown native result', (stdin: string) => nativeResponse(stdin, { status: 'unknown', reason: 'worker-lost' })],
])('returns unknown for %s without replay', async (_label, responder) => {
  seam.run.mockImplementation((...args: unknown[]) => responder(args[2] as string))
  const runner = new PluginBehaviorRunner(authority)
  const value = await runner.run({ key: 'one', artifact, operation: { kind: 'discover' }, signal })
  expect(value.status).toBe('unknown')
  expect(seam.run).toHaveBeenCalledOnce()
  await runner.close()
})

it('preserves a bounded worker unknown reason after proven isolation cleanup', async () => {
  seam.run.mockImplementation((...args: unknown[]) => nativeResponse(args[2] as string,
    { status: 'unknown', reason: 'plugin-fiber-not-active' }))
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
