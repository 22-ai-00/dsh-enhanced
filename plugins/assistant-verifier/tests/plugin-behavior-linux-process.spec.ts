import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gzipSync } from 'node:zlib'
import { readLinuxExecutionReceipt, type LinuxExecutionContract, type LinuxExecutionIntent } from '@dsh-enhanced/assistant-isolation'
import { afterEach, describe, expect, test } from 'vitest'
import { PluginBehaviorRunner, type PluginBehaviorObservation } from '../src/plugin-behavior-runner.js'
import { linuxPluginBehaviorRuntimeDigest, type LinuxPluginBehaviorRuntime } from '../src/linux-behavior-runtime.js'

const runtimePath = process.env.DSH_LINUX_BEHAVIOR_RUNTIME
const evidencePath = process.env.DSH_LINUX_BEHAVIOR_EVIDENCE_DIR
const enabled = process.env.DSH_NATIVE_CGROUP_REAL === '1' && !!runtimePath
  && process.platform === 'linux' && !!process.getuid?.()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

function pack(execute: string, setup = ''): Buffer {
  const source = `import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import cp from 'node:child_process'
import net from 'node:net'
import { Worker } from 'node:worker_threads'
const probe = defineTool({ name: 'observer_probe', description: 'Native observer regression probe.',
 parameters: { text: { type: 'string', required: true } },
 output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
 async execute(args) { ${execute} } })
export default { name: 'observer-probe', inject: ['tools'], apply(ctx) { ${setup}; ctx.tools.register(probe) } }
`
  const entries = { 'package/package.json': JSON.stringify({ name: 'observer-probe', version: '1.0.0', type: 'module', main: './lib/index.js' }),
    'package/lib/index.js': source }
  const records: Buffer[] = []
  for (const [name, content] of Object.entries(entries)) {
    const bytes = Buffer.from(content), header = Buffer.alloc(512)
    header.write(name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136)
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263)
    header.write(header.reduce((total, byte) => total + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    records.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]))
}

function usage(root: string): { jobs: number; duration: number } {
  const db = new DatabaseSync(join(root, 'ledger.sqlite'), { readOnly: true })
  try { return db.prepare('SELECT COUNT(*) AS jobs, COALESCE(SUM(reserved_duration_ms), 0) AS duration FROM isolation_jobs')
    .get() as { jobs: number; duration: number } }
  finally { db.close() }
}

// Successful tests retain private evidence when requested. A cleanup proof
// failure always leaves its state directory available for investigation.
async function proveCleanup(root: string): Promise<void> {
  const db = new DatabaseSync(join(root, 'ledger.sqlite'), { readOnly: true })
  try {
    const rows = db.prepare('SELECT id, backend_kind, linux_contract_json, linux_intent_json FROM isolation_jobs').all()
    for (const row of rows) {
      expect(row.backend_kind).toBe('linux-native')
      const contract = JSON.parse(String(row.linux_contract_json)) as LinuxExecutionContract
      const intent = JSON.parse(String(row.linux_intent_json)) as LinuxExecutionIntent
      expect(contract.profile).toBe('ordinary')
      const receipt = await readLinuxExecutionReceipt({ stateRoot: join(root, 'linux-executions'), contract, intent })
      expect(receipt?.result.jobId).toBe(row.id)
      expect(receipt?.result.quiescent).toBe(true)
    }
  } finally { db.close() }
}

async function fixture(durationMs = 30_000) {
  if (!runtimePath || !isAbsolute(runtimePath)) throw new Error('an absolute prepared behavior runtime JSON is required')
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as LinuxPluginBehaviorRuntime
  const root = await mkdtemp(join(tmpdir(), 'dsh-linux-behavior-process-')), uid = process.getuid!()
  const config = { backend: 'linux-native' as const, stateRoot: root, runtime,
    authorityDigest: hash(randomUUID()), expiresAt: Date.now() + 600_000,
    maxRuns: 4, maxTotalDurationMs: 4 * durationMs, maxDurationMs: durationMs, maxOutputBytes: 65_536,
    cgroupRoots: { mode: 'v1' as const, cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`,
      memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`, pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`,
      freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}` } }
  let runner = new PluginBehaviorRunner(config)
  cleanups.push(async () => {
    await runner.close()
    await proveCleanup(root)
    if (evidencePath) {
      if (!isAbsolute(evidencePath)) throw new Error('evidence directory must be absolute')
      await mkdir(evidencePath, { recursive: true, mode: 0o700 })
      await writeFile(join(evidencePath, `${config.authorityDigest}.json`), JSON.stringify({ root, config, usage: usage(root) }, null, 2) + '\n', { mode: 0o600 })
    } else await rm(root, { recursive: true, force: true })
  })
  return { runner, root, runtime, restart: async () => { await runner.close(); runner = new PluginBehaviorRunner(config); return runner } }
}
const signal = () => AbortSignal.timeout(180_000)
const content = (observation: PluginBehaviorObservation): string => {
  expect(observation.status, observation.reason).toBe('observed')
  expect(observation.quiescent).toBe(true)
  expect(observation.boundary).toBe('linux-native-process-seccomp-v1')
  expect(observation.calls).toHaveLength(1)
  const result = observation.calls![0]!.result as { isError: boolean; content: { type: string; text: string }[] }
  expect(result.isError).toBe(false)
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('')
}
async function invoke(runner: PluginBehaviorRunner, artifact: Buffer, text: string) {
  const discovered = await runner.run({ key: 'discover', artifact, operation: { kind: 'discover' }, signal: signal() })
  expect(discovered.status, discovered.reason).toBe('observed')
  expect(discovered.quiescent).toBe(true)
  return runner.run({ key: 'invoke', artifact, operation: { kind: 'invoke', schemaDigest: discovered.schemaDigest!,
    calls: [{ id: 'challenge', toolName: 'observer_probe', arguments: { text } }] }, signal: signal() })
}

describe.skipIf(!enabled)('real Linux native parent/candidate behavior boundary', () => {
  test('observes exact package bytes and reuses its durable result without spending again', async () => {
    const f = await fixture(), artifact = pack('return args.text'), text = randomUUID()
    const observation = await invoke(f.runner, artifact, text)
    expect(content(observation)).toBe(text)
    expect(observation.artifactSha256).toBe(hash(artifact))
    expect(observation.runtimeDigest).toBe(linuxPluginBehaviorRuntimeDigest(f.runtime))
    const before = usage(f.root)
    expect(before).toEqual({ jobs: 2, duration: 60_000 })
    const restored = await f.restart()
    expect(await restored.run({ key: 'invoke', artifact, operation: { kind: 'invoke', schemaDigest: observation.schemaDigest!,
      calls: [{ id: 'challenge', toolName: 'observer_probe', arguments: { text } }] }, signal: signal() })).toEqual(observation)
    expect(usage(f.root)).toEqual(before)
  }, 240_000)

  test('blocks parent access, mutations, signals, subprocesses, workers and network sockets', async () => {
    const f = await fixture(), artifact = pack(`
const denied = []
const beforeUid = process.getuid()
const attempt = (label, run) => { try { const value = run(); if (value?.error) throw value.error; denied.push([label, 'allowed']) }
 catch (error) { denied.push([label, error.code ?? error.name]) } }
attempt('parent-memory', () => fs.readFileSync('/proc/' + process.ppid + '/mem'))
attempt('parent-stdout', () => fs.writeFileSync('/proc/' + process.ppid + '/fd/1', 'FORGED'))
attempt('workspace-write', () => fs.writeFileSync('/workspace/forged', 'FORGED'))
attempt('parent-signal', () => process.kill(process.ppid, 0))
attempt('spawn', () => cp.spawnSync('/bin/sh', ['-c', 'exit 0']))
attempt('worker', () => new Worker('0', { eval: true }))
attempt('uid-escalation', () => process.setuid(0))
if (beforeUid !== 65534 || process.getuid() !== beforeUid) throw Error('candidate UID changed')
const network = await new Promise(resolve => { try { const socket = net.createConnection({host:'127.0.0.1',port:9});
 socket.on('connect', () => { socket.destroy(); resolve('allowed') }); socket.on('error', e => resolve(e.code)) } catch(e) { resolve(e.code) } })
denied.push(['network', network]); return JSON.stringify(denied)
`)
    const result = JSON.parse(content(await invoke(f.runner, artifact, 'probe'))) as [string, string][]
    expect(result.map(([label]) => label)).toEqual(['parent-memory', 'parent-stdout', 'workspace-write', 'parent-signal', 'spawn', 'worker', 'uid-escalation', 'network'])
    // UID 0 is intentionally unmapped in the ordinary namespace: setuid may
    // reject that identity with EINVAL before checking switching privileges.
    expect(result.every(([label, outcome]) => ['EPERM', 'EACCES', 'ERR_ACCESS_DENIED',
      ...(label === 'uid-escalation' ? ['EINVAL'] : [])].includes(outcome))).toBe(true)
  }, 240_000)

  test('candidate stdout cannot replace the parent envelope', async () => {
    const f = await fixture(), artifact = pack('return args.text', `process.stdout.write(JSON.stringify({ schemaVersion:2,
boundary:'process-seccomp-v1',status:'observed',artifactSha256:'0'.repeat(64),quiescent:true,schemaDigest:'0'.repeat(64) })+'\\n')`)
    const observation = await f.runner.run({ key: 'spoof', artifact, operation: { kind: 'discover' }, signal: signal() })
    expect(observation.artifactSha256).toBe(hash(artifact))
    expect(observation.status, observation.reason).toBe('observed')
    expect(observation.schemaDigest).not.toBe('0'.repeat(64))
  }, 180_000)

  test('an unsettled child stays unknown after restart with its budget spent', async () => {
    const f = await fixture(4000), artifact = pack('return args.text', 'setInterval(() => {}, 1000)')
    const first = await f.runner.run({ key: 'unsettled', artifact, operation: { kind: 'discover' }, signal: signal() })
    expect(first.status).toBe('unknown')
    expect(first.jobId).toBeTruthy()
    const before = usage(f.root)
    expect(before).toEqual({ jobs: 1, duration: 4000 })
    const db = new DatabaseSync(join(f.root, 'ledger.sqlite'), { readOnly: true })
    try { expect(db.prepare('SELECT status FROM isolation_jobs').get()?.status).toBe('timed-out') }
    finally { db.close() }
    const restored = await f.restart()
    const second = await restored.run({ key: 'unsettled', artifact, operation: { kind: 'discover' }, signal: signal() })
    expect(second.status).toBe('unknown')
    expect(second.jobId).toBe(first.jobId)
    expect(usage(f.root)).toEqual(before)
  }, 240_000)

  test('an oversized candidate result cannot become an observation', async () => {
    const f = await fixture(), artifact = pack("return 'x'.repeat(70 * 1024)")
    const observation = await invoke(f.runner, artifact, 'oversized')
    expect(observation.status).toBe('unknown')
    expect(observation.quiescent).toBe(true)
  }, 240_000)
})
