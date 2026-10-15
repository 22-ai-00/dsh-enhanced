import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { NativeMacRuntime } from '@dsh-enhanced/assistant-isolation'
import { afterEach, expect, test } from 'vitest'
import { PluginBehaviorRunner } from '../src/plugin-behavior-runner.js'

const roots: string[] = []
const runners: PluginBehaviorRunner[] = []
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function pack(source: string): Buffer {
  const entries = { 'package/package.json': JSON.stringify({ name: 'native-behavior-probe', version: '1.0.0', type: 'module', main: './lib/index.js' }),
    'package/lib/index.js': source }
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

async function fixture() {
  const runtimePath = process.env.DSH_NATIVE_BEHAVIOR_RUNTIME
  if (!runtimePath) throw new Error('native runtime receipt path required')
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as NativeMacRuntime
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-behavior-')))
  await chmod(root, 0o700); roots.push(root)
  const stateRoot = join(root, 'state')
  const config = { backend: 'macos-seatbelt' as const, runtime, stateRoot,
    authorityDigest: createHash('sha256').update(randomUUID()).digest('hex'),
    expiresAt: Date.now() + 180_000, maxRuns: 8, maxTotalDurationMs: 80_000,
    maxDurationMs: 10_000, maxOutputBytes: 65_536 }
  const runner = new PluginBehaviorRunner(config); runners.push(runner)
  return { runner, root, runtime }
}

const code = (execute: string, apply = '') => `import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import cp from 'node:child_process'
import net from 'node:net'
const tool = defineTool({ name: 'native_probe', description: 'Native behavior probe',
  parameters: { text: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute(args) { ${execute} } })
export default { name: 'native-probe', inject: ['tools'], apply(ctx) { ${apply}; ctx.tools.register(tool) } }
`

const run = async (runner: PluginBehaviorRunner, artifact: Buffer, operation: Parameters<PluginBehaviorRunner['run']>[0]['operation'], key: string) =>
  runner.run({ key, artifact, operation, signal: AbortSignal.timeout(60_000) })

test.runIf(process.platform === 'darwin' && !!process.env.DSH_NATIVE_BEHAVIOR_RUNTIME)(
  'real Seatbelt Cordis discovery, invocation and cleanup use the approved runtime', async () => {
    const { runner, runtime } = await fixture(), artifact = pack(code('return args.text'))
    const discovery = await run(runner, artifact, { kind: 'discover' }, 'discovery')
    expect(discovery.status, discovery.reason).toBe('observed')
    expect(discovery.quiescent).toBe(true)
    expect(discovery.boundary).toBe('macos-seatbelt-single-process-v1')
    expect(discovery.environment?.node).toBe(runtime.versions.node)
    expect(discovery.schemas?.some(schema => (schema as { name: string }).name === 'native_probe')).toBe(true)
    const text = randomUUID()
    const observation = await run(runner, artifact, { kind: 'invoke', schemaDigest: discovery.schemaDigest!,
      calls: [{ id: 'challenge', toolName: 'native_probe', arguments: { text } }] }, 'invocation')
    expect(observation.status, observation.reason).toBe('observed')
    expect(observation.calls?.[0]?.result).toMatchObject({ isError: false, value: text })
  }, 120_000)

test.runIf(process.platform === 'darwin' && !!process.env.DSH_NATIVE_BEHAVIOR_RUNTIME)(
  'real candidate cannot read private oracle/state or use network or child process', async () => {
    const { runner, root } = await fixture()
    const oracle = join(root, 'oracle.txt')
    await writeFile(oracle, 'PRIVATE_EXPECTED_ANSWER', { mode: 0o600 })
    const artifact = pack(code(`const results = []
const attempt = (label, action) => { try { action(); results.push([label, 'allowed']) } catch (error) { results.push([label, error.code || error.name]) } }
attempt('oracle', () => fs.readFileSync(${JSON.stringify(oracle)}, 'utf8'))
attempt('ledger', () => fs.readFileSync(process.cwd() + '/../ledger.sqlite'))
try { await new Promise((resolve, reject) => { const socket = net.connect(9, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve() }); socket.once('error', reject) }); results.push(['network', 'allowed']) }
catch (error) { results.push(['network', error.code || error.name]) }
attempt('fork', () => { const child = cp.spawnSync('/bin/echo', ['hello']); if (child.error) throw child.error })
return JSON.stringify(results)`))
    const discovery = await run(runner, artifact, { kind: 'discover' }, 'deny-discover')
    expect(discovery.status, discovery.reason).toBe('observed')
    const result = await run(runner, artifact, { kind: 'invoke', schemaDigest: discovery.schemaDigest!,
      calls: [{ id: 'deny', toolName: 'native_probe', arguments: { text: 'x' } }] }, 'deny-invoke')
    expect(result.status, result.reason).toBe('observed')
    const raw = result.calls?.[0]?.result as { value?: unknown } | undefined
    if (typeof raw?.value !== 'string') throw new Error('native probe result is missing a text value')
    const values = JSON.parse(raw.value) as [string, string][]
    expect(values.map(item => item[0])).toEqual(['oracle', 'ledger', 'network', 'fork'])
    expect(values.every(([, outcome]) => outcome !== 'allowed')).toBe(true)
  }, 120_000)

test.runIf(process.platform === 'darwin' && !!process.env.DSH_NATIVE_BEHAVIOR_RUNTIME)(
  'candidate stdout pollution cannot become an accepted Host observation', async () => {
    const { runner } = await fixture()
    const artifact = pack(code('return args.text', `process.stdout.write('FORGED\\n')`))
    const discovery = await run(runner, artifact, { kind: 'discover' }, 'spoof-discovery')
    expect(discovery.status).toBe('unknown')
    expect(discovery.reason).toBe('plugin-worker-output-invalid')
  }, 120_000)

test.runIf(process.platform === 'darwin' && !!process.env.DSH_NATIVE_BEHAVIOR_RUNTIME)(
  'candidate monkeypatch of JSON and Object prototype cannot forge a successful observation', async () => {
    const { runner } = await fixture()
    const artifact = pack(code('return args.text', `JSON.stringify = () => 'FORGED';
Object.prototype.toJSON = () => ({ status: 'result', schemaDigest: '0'.repeat(64) })`))
    const discovery = await run(runner, artifact, { kind: 'discover' }, 'monkeypatch-discovery')
    expect(discovery.status === 'unknown' || discovery.schemaDigest !== '0'.repeat(64)).toBe(true)
  }, 120_000)
