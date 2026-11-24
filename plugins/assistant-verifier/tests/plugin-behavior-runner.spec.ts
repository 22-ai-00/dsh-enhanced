import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

import { PluginBehaviorRunner, NATIVE_BEHAVIOR_BOUNDARY, type PluginKind } from '../src/plugin-behavior-runner.ts'
import { behaviorNativeRuntimeDigest } from '../src/plugin-behavior-config.ts'
import { nativeBehaviorFiles } from '../src/native-behavior-artifact.ts'
import { NATIVE_BEHAVIOR_SOURCE } from '../src/native-behavior-worker.ts'

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

function packEntries(entries: Record<string, string>): Buffer {
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

function nativePack(): Buffer {
  return packEntries({
    'package/package.json': JSON.stringify({ name: 'native-probe', version: '1.0.0', type: 'module', main: './lib/index.js' }),
    'package/lib/index.js': 'export default {}',
  })
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

it('propagates explicit pluginKind through nonce/request/frame and rejects mismatches or invalid kinds', async () => {
  const svcSchema = { name: 'service_lifecycle_probe', parameters: { type: 'object', properties: {} } }
  const svcDigest = createHash('sha256').update(JSON.stringify([svcSchema])).digest('hex')
  seam.run.mockImplementation((_k: string, _f: unknown, stdin: string) => {
    const parsed = JSON.parse(stdin) as { pluginKind?: string }
    expect(parsed.pluginKind).toBe('service')
    return nativeResponse(stdin, { status: 'result', pluginKind: 'service', schemaDigest: svcDigest, schemas: [svcSchema] })
  })
  const runner = new PluginBehaviorRunner(authority)
  const observed = await runner.run({ key: 'svc-1', artifact, operation: { kind: 'discover' }, pluginKind: 'service', signal })
  expect(observed).toMatchObject({ status: 'observed', pluginKind: 'service', schemaDigest: svcDigest })

  // Mismatched frame pluginKind is rejected.
  seam.run.mockImplementationOnce((_k: string, _f: unknown, stdin: string) =>
    nativeResponse(stdin, { status: 'result', pluginKind: 'ui', schemaDigest: svcDigest, schemas: [svcSchema] }))
  const mismatched = await runner.run({ key: 'svc-mismatch', artifact, operation: { kind: 'discover' }, pluginKind: 'service', signal })
  expect(mismatched).toMatchObject({ status: 'unknown', quiescent: true, reason: 'plugin-worker-observation-invalid' })

  // Invalid pluginKind is rejected before dispatch.
  seam.run.mockClear()
  const invalid = await runner.run({ key: 'svc-bad', artifact, operation: { kind: 'discover' }, pluginKind: 'bogus' as PluginKind, signal })
  expect(invalid).toMatchObject({ status: 'unknown', quiescent: true, reason: 'plugin-operation-invalid' })
  expect(seam.run).not.toHaveBeenCalled()
  await runner.close()
})

async function runRealNativeWorker(
  tgz: Buffer,
  operation: { kind: 'discover' } | { kind: 'invoke'; schemaDigest: string; calls: { id: string; toolName: string; arguments: unknown }[] },
  pluginKind?: PluginKind,
) {
  const root = await mkdtemp(join(tmpdir(), 'native-worker-exec-'))
  try {
    const staged = nativeBehaviorFiles(tgz)
    for (const file of staged.files) {
      const target = join(root, file.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.content, 'utf8')
    }
    const workerPath = join(root, 'worker.mjs')
    await writeFile(workerPath, NATIVE_BEHAVIOR_SOURCE, 'utf8')
    const modulesPath = fileURLToPath(new URL('../node_modules', import.meta.url))
    const artifactSha = createHash('sha256').update(tgz).digest('hex')
    const nonce = 'a'.repeat(64)
    const stdin = JSON.stringify({
      schemaVersion: 1,
      nonce,
      artifactSha256: artifactSha,
      entry: staged.entry,
      modulesPath,
      operation,
      ...(pluginKind !== undefined ? { pluginKind } : {}),
    })
    const res = spawnSync(process.execPath, [workerPath], {
      cwd: root,
      input: stdin,
      encoding: 'utf8',
      timeout: 15_000,
    })
    expect(res.status).toBe(0)
    return JSON.parse(res.stdout.trim()) as Record<string, unknown>
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('executes real worker verification across tool, service, channel, ui, auto-inference, and disposal checks', async () => {
  // 1. Tool plugin (omitted pluginKind -> backward-compatible 7-key frame without pluginKind)
  const toolTgz = packEntries({
    'package/package.json': JSON.stringify({ name: 'test-tool', version: '1.0.0', type: 'module', main: './lib/index.js' }),
    'package/lib/index.js': `
      export const inject = ['tools']
      export function apply(ctx) {
        ctx.tools.register({
          name: 'echo_num',
          description: 'Echo number',
          parameters: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
          output: { schema: { type: 'object' }, render: v => [{ type: 'text', text: JSON.stringify(v) }] },
          execute: async ({ n }) => ({ doubled: n * 2 }),
        })
      }
    `,
  })
  const toolDisc = await runRealNativeWorker(toolTgz, { kind: 'discover' })
  expect(toolDisc.status).toBe('result')
  expect(Object.hasOwn(toolDisc, 'pluginKind')).toBe(false)
  expect(Object.keys(toolDisc)).toHaveLength(7)
  const toolInv = await runRealNativeWorker(toolTgz, {
    kind: 'invoke',
    schemaDigest: toolDisc.schemaDigest as string,
    calls: [{ id: 'c1', toolName: 'echo_num', arguments: { n: 21 } }],
  })
  expect(toolInv.status).toBe('result')
  expect((toolInv.calls as { result: { value: unknown } }[])[0]!.result.value).toEqual({ doubled: 42 })

  // Empty apply() plugin with omitted pluginKind still returns invalid-tool-schemas
  const emptyTgz = packEntries({
    'package/package.json': JSON.stringify({ name: 'test-empty', version: '1.0.0', type: 'module', main: './lib/index.js' }),
    'package/lib/index.js': 'export function apply() {}',
  })
  expect(await runRealNativeWorker(emptyTgz, { kind: 'discover' })).toMatchObject({ status: 'unknown', reason: 'invalid-tool-schemas' })
  expect(await runRealNativeWorker(emptyTgz, { kind: 'discover' }, 'service')).toMatchObject({ status: 'unknown', reason: 'invalid-service-plugin' })

  // 2. Service plugin (Cordis Service + health + custom method, auto-inferred AND explicit)
  const svcTgz = packEntries({
    'package/package.json': JSON.stringify({ name: 'test-svc', version: '1.0.0', type: 'module', main: './lib/index.js' }),
    'package/cordis.patch.yml': '- insert:\n  - id: test-svc\n    name: test-svc\n',
    'package/lib/index.js': `
      import { Service } from '@deepseek-ai/cordis'
      class Greeter extends Service {
        constructor(ctx) { super(ctx, 'greeter') }
        health() { return { ready: true, count: 1 } }
        greet(input) { return { hello: input?.who ?? 'world' } }
      }
      export default Greeter
    `,
  })
  const svcDisc = await runRealNativeWorker(svcTgz, { kind: 'discover' })
  expect(svcDisc).toMatchObject({ status: 'result', pluginKind: 'service' })
  const svcSchemas = svcDisc.schemas as { name: string }[]
  expect(svcSchemas.map(s => s.name)).toContain('service_lifecycle_probe')
  expect(svcSchemas.map(s => s.name)).toContain('service_method_probe')
  const svcInv = await runRealNativeWorker(svcTgz, {
    kind: 'invoke',
    schemaDigest: svcDisc.schemaDigest as string,
    calls: [
      { id: 'c1', toolName: 'service_lifecycle_probe', arguments: { check: 'health', service: 'greeter' } },
      { id: 'c2', toolName: 'service_method_probe', arguments: { service: 'greeter', method: 'greet', input: { who: 'dsh' } } },
    ],
  }, 'service')
  expect(svcInv.status).toBe('result')
  const svcCalls = svcInv.calls as { result: { isError: boolean; value: unknown } }[]
  expect(svcCalls[0]!.result.value).toMatchObject({ kind: 'service', active: true, provisions: ['greeter'] })
  expect(svcCalls[1]!.result.value).toMatchObject({ kind: 'service', service: 'greeter', method: 'greet', result: { hello: 'dsh' } })

  // Unhealthy service fails with service-health-failed
  const badSvcTgz = packEntries({
    'package/package.json': JSON.stringify({ name: 'bad-svc', version: '1.0.0', type: 'module', main: './lib/index.js' }),
    'package/lib/index.js': `
      export function apply(ctx) { ctx.provide('broken', { health: () => ({ ready: false }) }) }
    `,
  })
  expect(await runRealNativeWorker(badSvcTgz, { kind: 'discover' }, 'service')).toMatchObject({ status: 'unknown', reason: 'service-health-failed' })

  // 3. Channel plugin (injects assistantDelivery, registers DeliveryAdapter via ctx.effect)
  const chanTgz = packEntries({
    'package/package.json': JSON.stringify({ name: 'test-chan', version: '1.0.0', type: 'module', main: './lib/index.js' }),
    'package/cordis.patch.yml': '- insert:\n  - id: test-chan\n    name: test-chan\n    inject: [assistantDelivery]\n',
    'package/lib/index.js': `
      export const inject = ['assistantDelivery']
      export function apply(ctx) {
        ctx.effect(() => ctx.get('assistantDelivery').registerAdapter({
          channel: 'demo-chat',
          account: 'bot-1',
          capabilities: { text: true },
          start: async () => {},
          send: async () => ({ delivered: true }),
        }))
      }
    `,
  })
  const chanDisc = await runRealNativeWorker(chanTgz, { kind: 'discover' })
  expect(chanDisc).toMatchObject({ status: 'result', pluginKind: 'channel' })
  const chanInv = await runRealNativeWorker(chanTgz, {
    kind: 'invoke',
    schemaDigest: chanDisc.schemaDigest as string,
    calls: [{ id: 'ch1', toolName: 'channel_readiness_probe', arguments: { check: 'adapters', channel: 'demo-chat' } }],
  })
  expect(chanInv.status).toBe('result')
  expect((chanInv.calls as { result: { value: unknown } }[])[0]!.result.value).toMatchObject({
    kind: 'channel', ready: true, adapters: [{ channel: 'demo-chat', account: 'bot-1' }],
  })

  // Leaked channel adapter (missing ctx.effect cleanup) fails disposal check
  const leakedChanTgz = packEntries({
    'package/package.json': JSON.stringify({ name: 'leak-chan', version: '1.0.0', type: 'module', main: './lib/index.js' }),
    'package/lib/index.js': `
      export const inject = ['assistantDelivery']
      export function apply(ctx) {
        ctx.get('assistantDelivery').registerAdapter({
          channel: 'leak', account: 'a', capabilities: {}, start: async () => {}, send: async () => {},
        })
      }
    `,
  })
  expect(await runRealNativeWorker(leakedChanTgz, { kind: 'discover' }, 'channel')).toMatchObject({ status: 'unknown', reason: 'plugin-disposal-unconfirmed' })

  // 4. UI plugin (injects typert, exports ./client on disk, registers TypertContribution)
  const uiTgz = packEntries({
    'package/package.json': JSON.stringify({
      name: 'test-ui', version: '1.0.0', type: 'module', main: './lib/index.js',
      exports: { '.': './lib/index.js', './client': './lib/client.js' },
      dsh: { client: { platform: 'web' } },
    }),
    'package/lib/client.js': 'export default function Panel() { return null }',
    'package/lib/index.js': `
      export const inject = ['typert']
      export const routes = ['/console/demo']
      export function apply(ctx) {
        ctx.typert.register({ package: 'test-ui', face: 'web', schemas: { summary: { type: 'object' } }, model: { services: [], events: [], objects: [] }, invocations: {} })
      }
    `,
  })
  const uiDisc = await runRealNativeWorker(uiTgz, { kind: 'discover' })
  expect(uiDisc).toMatchObject({ status: 'result', pluginKind: 'ui' })
  const uiInv = await runRealNativeWorker(uiTgz, {
    kind: 'invoke',
    schemaDigest: uiDisc.schemaDigest as string,
    calls: [{ id: 'ui1', toolName: 'ui_declaration_probe', arguments: { check: 'contributions' } }],
  })
  expect(uiInv.status).toBe('result')
  expect((uiInv.calls as { result: { value: unknown } }[])[0]!.result.value).toMatchObject({
    kind: 'ui', ready: true, hasClientExport: true, routes: ['/console/demo'],
    contributions: [{ package: 'test-ui', face: 'web' }],
  })

  // Missing ./client export target file fails closed
  const brokenUiTgz = packEntries({
    'package/package.json': JSON.stringify({
      name: 'broken-ui', version: '1.0.0', type: 'module', main: './lib/index.js',
      exports: { '.': './lib/index.js', './client': './lib/client.js' },
      dsh: { client: { platform: 'web' } },
    }),
    'package/lib/index.js': 'export function apply() {}',
  })
  expect(await runRealNativeWorker(brokenUiTgz, { kind: 'discover' }, 'ui')).toMatchObject({ status: 'unknown', reason: 'invalid-ui-plugin' })
})

it('rejects empty UI stubs, false cordis.patch.yml UI matches, typert leaks, incomplete channel provisions, and hybrid tool+channel leaks', async () => {
  // 1a. Empty TYPERT = {} rejected (both omitted and explicit 'ui')
  const emptyTypertTgz = packEntries({
    'package/package.json': JSON.stringify({ name: 'stub-typert', version: '1.0.0', type: 'module', main: './lib/index.js' }),
    'package/lib/index.js': 'export const TYPERT = {}\nexport function apply() {}',
  })
  expect(await runRealNativeWorker(emptyTypertTgz, { kind: 'discover' })).toMatchObject({ status: 'unknown' })
  expect(await runRealNativeWorker(emptyTypertTgz, { kind: 'discover' }, 'ui')).toMatchObject({ status: 'unknown', reason: 'invalid-ui-plugin' })

  // 1b. Empty routes = [] rejected
  const emptyRoutesTgz = packEntries({
    'package/package.json': JSON.stringify({ name: 'stub-routes', version: '1.0.0', type: 'module', main: './lib/index.js' }),
    'package/lib/index.js': 'export const routes = []\nexport function apply() {}',
  })
  expect(await runRealNativeWorker(emptyRoutesTgz, { kind: 'discover' })).toMatchObject({ status: 'unknown' })
  expect(await runRealNativeWorker(emptyRoutesTgz, { kind: 'discover' }, 'ui')).toMatchObject({ status: 'unknown', reason: 'invalid-ui-plugin' })

  // 1c. Empty package.json dsh: { ui: {} } without client export, typert, or non-empty UI exports rejected
  const emptyDshUiTgz = packEntries({
    'package/package.json': JSON.stringify({ name: 'stub-dsh-ui', version: '1.0.0', type: 'module', main: './lib/index.js', dsh: { ui: {} } }),
    'package/lib/index.js': 'export function apply() {}',
  })
  expect(await runRealNativeWorker(emptyDshUiTgz, { kind: 'discover' })).toMatchObject({ status: 'unknown' })
  expect(await runRealNativeWorker(emptyDshUiTgz, { kind: 'discover' }, 'ui')).toMatchObject({ status: 'unknown', reason: 'invalid-ui-plugin' })

  // 1d. False cordis.patch.yml config:\n  ui: false (and nested config not flattened) rejected
  const falsePatchUiTgz = packEntries({
    'package/package.json': JSON.stringify({ name: 'false-patch-ui', version: '1.0.0', type: 'module', main: './lib/index.js' }),
    'package/cordis.patch.yml': '- insert:\n  - id: false-patch-ui\n    name: false-patch-ui\n    config:\n      ui: false\n      nested:\n        routes: ["/fake"]\n',
    'package/lib/index.js': 'export function apply() {}',
  })
  expect(await runRealNativeWorker(falsePatchUiTgz, { kind: 'discover' })).toMatchObject({ status: 'unknown' })
  expect(await runRealNativeWorker(falsePatchUiTgz, { kind: 'discover' }, 'ui')).toMatchObject({ status: 'unknown', reason: 'invalid-ui-plugin' })

  // 2. typertContributions disposal leak via ctx.root.typert.register(...) rejected with plugin-disposal-unconfirmed
  const leakTypertTgz = packEntries({
    'package/package.json': JSON.stringify({ name: 'leak-typert', version: '1.0.0', type: 'module', main: './lib/index.js' }),
    'package/lib/index.js': `
      export const inject = ['typert']
      export function apply(ctx) {
        ctx.root.typert.register({
          package: 'leak-typert',
          face: 'host',
          schemas: { panel: { type: 'object' } },
          model: { services: [], events: [], objects: [] },
          invocations: [],
        })
      }
    `,
  })
  expect(await runRealNativeWorker(leakTypertTgz, { kind: 'discover' }, 'ui')).toMatchObject({
    status: 'unknown',
    reason: 'plugin-disposal-unconfirmed',
  })

  // 3a. Incomplete channel service provisions ({ send() {} }, { capabilities: {} }) rejected for pluginKind: 'channel'
  //     and NOT misclassified as 'channel' when pluginKind is omitted
  for (const body of [
    `export function apply(ctx) { ctx.provide('fakeChan', { send() {} }) }`,
    `export function apply(ctx) { ctx.provide('fakeChan', { capabilities: {} }) }`,
  ]) {
    const fakeChanTgz = packEntries({
      'package/package.json': JSON.stringify({ name: 'fake-chan', version: '1.0.0', type: 'module', main: './lib/index.js' }),
      'package/lib/index.js': body,
    })
    expect(await runRealNativeWorker(fakeChanTgz, { kind: 'discover' }, 'channel')).toMatchObject({
      status: 'unknown',
      reason: 'invalid-channel-plugin',
    })
    const omitted = await runRealNativeWorker(fakeChanTgz, { kind: 'discover' })
    expect(omitted.pluginKind).not.toBe('channel')
  }

  // 3b. Valid service plugin with health() and custom send() still passes as 'service'
  const validSvcSendTgz = packEntries({
    'package/package.json': JSON.stringify({ name: 'valid-svc-send', version: '1.0.0', type: 'module', main: './lib/index.js' }),
    'package/lib/index.js': `
      export function apply(ctx) {
        ctx.provide('notifier', { health: () => ({ ready: true }), send: () => ({ ok: true }) })
      }
    `,
  })
  expect(await runRealNativeWorker(validSvcSendTgz, { kind: 'discover' })).toMatchObject({ status: 'result', pluginKind: 'service' })
  expect(await runRealNativeWorker(validSvcSendTgz, { kind: 'discover' }, 'service')).toMatchObject({ status: 'result', pluginKind: 'service' })

  // 4. Hybrid 'tool' plugin + leaked assistantDelivery.registerAdapter(...) rejected with plugin-disposal-unconfirmed
  const hybridLeakTgz = packEntries({
    'package/package.json': JSON.stringify({ name: 'hybrid-leak', version: '1.0.0', type: 'module', main: './lib/index.js' }),
    'package/lib/index.js': `
      export const inject = ['tools', 'assistantDelivery']
      export function apply(ctx) {
        ctx.tools.register({
          name: 'ping',
          description: 'Ping',
          parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'object' }, render: v => [{ type: 'text', text: JSON.stringify(v) }] },
          execute: async () => ({ ok: true }),
        })
        ctx.get('assistantDelivery').registerAdapter({
          channel: 'c', account: 'a', capabilities: {}, start: async () => {}, send: async () => ({ ok: true }),
        })
      }
    `,
  })
  expect(await runRealNativeWorker(hybridLeakTgz, { kind: 'discover' })).toMatchObject({
    status: 'unknown',
    reason: 'plugin-disposal-unconfirmed',
  })
})
