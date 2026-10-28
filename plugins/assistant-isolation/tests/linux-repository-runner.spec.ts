import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as pause } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { IsolationLedger } from '../src/ledger.js'
import { linuxJobResourceReservation } from '../src/linux-execution-contract.js'
import { LinuxRepositoryRunner, type LinuxRepositoryRunnerConfig, type LinuxRepositoryRunnerRequest } from '../src/linux-repository-runner.js'
import { linuxRuntimeFixture } from './helpers/linux-runtime-fixture.js'

const real = process.env.DSH_NATIVE_CGROUP_REAL === '1' && process.platform === 'linux' && (process.getuid?.() ?? 0) > 0
const roots: string[] = []
const runners: LinuxRepositoryRunner[] = []
afterEach(async () => {
  await Promise.all(runners.splice(0).map(async runner => { await runner.close() }))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
async function fixture(overrides: Partial<LinuxRepositoryRunnerConfig> = {}): Promise<{ input: LinuxRepositoryRunnerConfig; request: LinuxRepositoryRunnerRequest; bytes: Buffer }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repository-runner-')); roots.push(root)
  const { runtime, cgroupRoots } = await linuxRuntimeFixture(root)
  const source = join(root, 'source'); await mkdir(source, { mode: 0o700 })
  await writeFile(join(source, 'package.json'), '{"name":"binary-repository-fixture","private":true}')
  await writeFile(join(source, 'build.cjs'), 'const fs=require("node:fs");fs.mkdirSync(".dsh-native-artifact");fs.writeFileSync(".dsh-native-artifact/package.tgz",Buffer.from([0,255,128,1]));console.log("built");')
  const bytes = execFileSync('/usr/bin/tar', ['-cf', '-', '-C', source, '.'])
  return { bytes, request: { argv: ['/bin/sh', '-c', 'mkdir source; tar -xf /input/source.tar -C source; /runtime/0/bin/node source/build.cjs'],
    archive: { bytes: bytes.length, sha256: sha(bytes) }, artifacts: ['.dsh-native-artifact/package.tgz'] },
  input: { backend: 'linux-native', stateRoot: join(root, 'state'), authorityDigest: 'a'.repeat(64), expiresAt: Date.now() + 120_000,
    maxRuns: 4, maxTotalDurationMs: 20_000, runtime, cgroupRoots,
    limits: { maxDurationMs: 5000, maxInputBytes: 64 * 1024 ** 2, maxOutputBytes: 4096, maxArtifactBytes: 4 * 1024 ** 2,
      maxFiles: 8, memoryMiB: 128, workspaceMiB: 16, workspaceInodes: 512, tmpMiB: 8, tmpInodes: 256,
      inputMiB: 65, inputInodes: 16, pidsLimit: 32, cpus: 0.5 }, ...overrides } }
}
function runner(input: LinuxRepositoryRunnerConfig): LinuxRepositoryRunner { const value = new LinuxRepositoryRunner(input); runners.push(value); return value }
function database(input: LinuxRepositoryRunnerConfig): DatabaseSync { return new DatabaseSync(join(input.stateRoot, 'ledger.sqlite')) }
async function absence(db: DatabaseSync, key: string): Promise<void> {
  const row = db.prepare('SELECT linux_resources_json,linux_intent_json FROM isolation_jobs WHERE idempotency_key=?').get(key)!
  const resources = JSON.parse(row.linux_resources_json as string)
  for (const group of [resources.worker, resources.keeper]) for (const directory of Object.values(group.directories) as { path: string }[]) {
    await expect(lstat(directory.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }
  await expect(lstat(JSON.parse(row.linux_intent_json as string).namespacePath)).rejects.toMatchObject({ code: 'ENOENT' })
}

describe.skipIf(!real)('finite private repository runner with actual Linux receipts', () => {
  test('reserves before loading, builds a real source tar and reopens the exact key without loading or dispatching', async () => {
    const { input, request, bytes } = await fixture(), first = runner(input)
    let loads = 0
    const result = await first.run('source-job', request, async () => {
      loads++
      const db = database(input)
      try {
        const row = db.prepare('SELECT status,dispatch_attempted,reserved_memory_mib,reserved_storage_bytes FROM isolation_jobs').get()!
        expect(row).toMatchObject({ status: 'prepared', dispatch_attempted: 0 })
        const minimum = linuxJobResourceReservation({ schemaVersion: 2, backend: 'linux-native', profile: 'repository', runtimeDigest: first.runtimeDigest,
          limits: input.limits, cgroupRoots: input.cgroupRoots, keeperLimits: { memoryMiB: 256, pidsLimit: 64, cpus: 0.5 } })
        expect(row.reserved_memory_mib).toBe(minimum.memoryMiB + 256)
        expect(row.reserved_storage_bytes).toBe(minimum.storageBytes + 96 * 1024 ** 2)
      } finally { db.close() }
      return bytes
    }, new AbortController().signal)
    expect(result.result).toMatchObject({ status: 'succeeded', quiescent: true, stdout: 'built\n', artifacts: [] })
    expect(result.artifacts[0]!.bytes.equals(Buffer.from([0, 255, 128, 1]))).toBe(true)
    expect(result.receiptBinding?.receiptDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(result).toMatchObject({ runtimeDigest: first.runtimeDigest, contractDigest: first.contractDigest })
    expect(await first.inspectSuccessfulExecution('source-job')).toEqual(result)
    expect(await first.inspectQuiescence('source-job')).toBe('quiescent')
    const never = async (): Promise<Uint8Array> => { throw new Error('archive factory must not replay') }
    expect((await first.run('source-job', request, never, new AbortController().signal)).result).toEqual(result.result)
    await first.close()
    const reopened = runner(input), cached = await reopened.run('source-job', request, never, new AbortController().signal)
    expect(cached.result).toEqual(result.result)
    expect(cached.artifacts[0]!.bytes.equals(result.artifacts[0]!.bytes)).toBe(true)
    expect(await reopened.inspectSuccessfulExecution('source-job')).toEqual(result)
    expect(await reopened.inspectSuccessfulExecution('missing')).toBeUndefined()
    expect(loads).toBe(1)
    const db = database(input)
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(1)
      await absence(db, 'source-job')
      const intent = JSON.parse(db.prepare('SELECT linux_intent_json FROM isolation_jobs').get()?.linux_intent_json as string)
      await mkdir(intent.namespacePath, { mode: 0o700 })
      expect(await reopened.inspectSuccessfulExecution('source-job')).toBeUndefined()
      expect(await reopened.inspectQuiescence('source-job')).toBe('unknown')
      expect(await reopened.run('source-job', request, never, new AbortController().signal))
        .toMatchObject({ result: { status: 'unknown', quiescent: false }, artifacts: [] })
      await rm(intent.namespacePath, { recursive: true })
      expect(await reopened.inspectQuiescence('source-job')).toBe('quiescent')
      const spool = join(input.stateRoot, 'linux-executions/artifacts', `${intent.jobId}-${intent.nativeNonce}`, '0.bin')
      const original = await readFile(spool)
      try {
        await writeFile(spool, Buffer.alloc(original.length))
        expect(await reopened.inspectSuccessfulExecution('source-job')).toBeUndefined()
      } finally { await writeFile(spool, original) }
      expect(await reopened.inspectSuccessfulExecution('source-job')).toEqual(result)
      const receiptPath = join(input.stateRoot, 'linux-executions/receipts', `${intent.jobId}-${intent.nativeNonce}.json`)
      const originalReceipt = await readFile(receiptPath)
      try {
        const changed = JSON.parse(originalReceipt.toString('utf8'))
        changed.result.stdout = 'receipt drift'
        await writeFile(receiptPath, JSON.stringify(changed))
        expect(await reopened.inspectSuccessfulExecution('source-job')).toBeUndefined()
      } finally { await writeFile(receiptPath, originalReceipt) }
      expect(await reopened.inspectSuccessfulExecution('source-job')).toEqual(result)
    } finally { db.close() }
    expect(await reopened.inspectQuiescence('missing')).toBe('unknown')
  })

  test('rejects key metadata/path drift and runtime drift without loading another archive', async () => {
    const { input, request, bytes } = await fixture(), value = runner(input)
    await value.run('bound', request, async () => bytes, new AbortController().signal)
    let loads = 0
    const loader = async (): Promise<Uint8Array> => { loads++; return bytes }
    for (const changed of [{ ...request, argv: ['/bin/false'] }, { ...request, artifacts: ['other.tgz'] },
      { ...request, archive: { ...request.archive, sha256: 'f'.repeat(64) } }]) {
      await expect(value.run('bound', changed, loader, new AbortController().signal)).rejects.toThrow('different request')
    }
    await expect(value.run('unsafe', { ...request, artifacts: ['../escape'] }, loader, new AbortController().signal)).rejects.toThrow('invalid')
    await writeFile(join(input.runtime.cachePath, 'drift'), 'changed')
    await expect(value.run('new-runtime', request, loader, new AbortController().signal)).rejects.toThrow('root differs')
    expect(loads).toBe(0)
    const db = database(input)
    try { expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(1) } finally { db.close() }
  })

  test.each(['length', 'hash'] as const)('a factory %s mismatch consumes one finite reservation and never dispatches or retries', async kind => {
    const { input, request, bytes } = await fixture({ maxRuns: 1 })
    const value = runner(input)
    let loads = 0
    const bad = await value.run('bad', request, async () => { loads++; return kind === 'length' ? bytes.subarray(1) : Buffer.alloc(bytes.length) }, new AbortController().signal)
    expect(bad.result).toMatchObject({ status: 'failed', quiescent: true })
    expect(bad.artifacts).toEqual([])
    expect(await value.inspectQuiescence('bad')).toBe('quiescent')
    expect((await value.run('bad', request, async () => { loads++; return bytes }, new AbortController().signal)).result).toEqual(bad.result)
    await expect(value.run('exhausted', request, async () => { loads++; return bytes }, new AbortController().signal)).rejects.toThrow('budget')
    expect(loads).toBe(1)
    const db = database(input)
    try { expect(db.prepare('SELECT dispatch_attempted,reserved_duration_ms FROM isolation_jobs').get()).toMatchObject({ dispatch_attempted: 0, reserved_duration_ms: 5000 }) } finally { db.close() }
    expect(await readdir(join(input.stateRoot, 'linux-executions'))).toEqual([])
    await value.close()
    const widened = runner({ ...input, maxRuns: 2 })
    await expect(widened.run('more', request, async () => { loads++; return bytes }, new AbortController().signal)).rejects.toThrow('grant revision digest differs')
    expect(loads).toBe(1)
  })

  test.each(['cancel', 'close'] as const)('%s revokes the blocked archive factory signal and ignores its late resolution', async mode => {
    const { input, request, bytes } = await fixture(), value = runner(input), controller = new AbortController()
    let release!: (bytes: Uint8Array) => void, entered!: () => void
    const loading = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<Uint8Array>(resolve => { release = resolve })
    let factorySignal: AbortSignal | undefined
    const pending = value.run('blocked', request, async signal => { factorySignal = signal; entered(); return await blocked }, controller.signal)
    await loading
    expect(await value.inspectQuiescence('blocked')).toBe('unknown')
    if (mode === 'cancel') controller.abort()
    else await value.close()
    const result = await pending
    expect(factorySignal?.aborted).toBe(true)
    expect(result.result).toMatchObject({ status: 'cancelled', quiescent: true })
    release(bytes)
    const cached = mode === 'close' ? runner(input) : value
    expect((await cached.run('blocked', request, async () => { throw new Error('must not load') }, new AbortController().signal)).result).toEqual(result.result)
    const db = database(input)
    try { expect(db.prepare('SELECT dispatch_attempted FROM isolation_jobs').get()?.dispatch_attempted).toBe(0) } finally { db.close() }
  })

  test.each(['deadline', 'expiry', 'fence'] as const)('%s revokes a blocked factory before settlement and stops its real Host child', async mode => {
    const base = await fixture(), input = { ...base.input, limits: { ...base.input.limits, maxDurationMs: mode === 'deadline' ? 750 : 5000 } }
    const value = runner(input), external = new AbortController(), db = database(input)
    let child: ChildProcess | undefined, childClosed: Promise<void> | undefined, factorySignal: AbortSignal | undefined
    let release!: (bytes: Uint8Array) => void, entered!: () => void, statusAtAbort: unknown
    const loading = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<Uint8Array>(resolve => { release = resolve })
    const pending = value.run('factory-' + mode, base.request, async signal => {
      factorySignal = signal
      child = spawn('/usr/bin/sleep', ['30'], { stdio: 'ignore' })
      childClosed = new Promise<void>(resolve => { child!.once('close', () => resolve()) })
      signal.addEventListener('abort', () => {
        statusAtAbort = db.prepare('SELECT status FROM isolation_jobs').get()?.status
        child!.kill('SIGKILL')
      }, { once: true })
      entered()
      return await blocked
    }, external.signal)
    void pending.catch(() => {})
    let peer: IsolationLedger | undefined, authority
    try {
      await loading
      expect(factorySignal?.aborted).toBe(false)
      if (mode === 'expiry') db.prepare('UPDATE isolation_grants SET expires_at=? WHERE id=?').run(Date.now() + 100, 'repository')
      if (mode === 'fence') {
        peer = new IsolationLedger(join(input.stateRoot, 'ledger.sqlite'))
        db.prepare('UPDATE isolation_controller SET expires_at=0 WHERE singleton=1').run()
        authority = peer.claimController('factory-successor', 30_000)
      }
      const result = await pending
      expect(factorySignal?.aborted, JSON.stringify({ mode, result })).toBe(true)
      expect(external.signal.aborted).toBe(false)
      expect(statusAtAbort).toBe('prepared')
      await expect.poll(() => child!.signalCode, { timeout: 2000 }).toBe('SIGKILL')
      await childClosed
      expect(result.result).toMatchObject(mode === 'fence' ? { status: 'unknown', quiescent: false } : { status: 'cancelled', quiescent: true })
      expect(result.artifacts).toEqual([])
      expect(db.prepare('SELECT dispatch_attempted,reserved_duration_ms FROM isolation_jobs').get())
        .toMatchObject({ dispatch_attempted: 0, reserved_duration_ms: input.limits.maxDurationMs })
      release(base.bytes)
      expect(await readdir(join(input.stateRoot, 'linux-executions'))).toEqual([])
      if (mode !== 'fence') {
        expect((await value.run('factory-' + mode, base.request, async () => { throw new Error('late factory must not replay') }, external.signal)).result).toEqual(result.result)
      } else expect(peer!.hasController(authority!)).toBe(true)
    } finally {
      child?.kill('SIGKILL'); release(base.bytes); await childClosed
      await value.close()
      if (peer && authority) peer.releaseController(authority)
      peer?.close(); db.close()
    }
  }, 15_000)

  test.each(['cancel', 'expiry', 'close'] as const)('a running repository is revoked on %s and both kernel groups disappear', async mode => {
    const { input, request, bytes } = await fixture(), value = runner(input), controller = new AbortController()
    const pending = value.run(mode, { ...request, argv: ['/bin/sh', '-c', 'sleep 30'], artifacts: [] }, async () => bytes, controller.signal)
    const db = database(input)
    try {
      await expect.poll(() => db.prepare('SELECT status FROM isolation_jobs').get()?.status, { timeout: 8000 }).toBe('running')
      if (mode === 'cancel') controller.abort()
      else if (mode === 'expiry') db.prepare('UPDATE isolation_grants SET expires_at=0 WHERE id=?').run('repository')
      else await value.close()
      const result = await pending
      expect(['cancelled', 'timed-out']).toContain(result.result.status)
      expect(result.result.quiescent).toBe(true)
      expect(result.artifacts).toEqual([])
      await absence(db, mode)
    } finally { db.close() }
  }, 15_000)

  test('a successor fence retains an unknown body and spent budget, then recovers without loading or replaying', async () => {
    const { input, request, bytes } = await fixture({ maxRuns: 1 })
    const value = runner(input), command = { ...request, argv: ['/bin/sh', '-c', 'sleep 30'], artifacts: [] }
    const pending = value.run('fenced', command, async () => bytes, new AbortController().signal)
    const db = database(input), peer = new IsolationLedger(join(input.stateRoot, 'ledger.sqlite'))
    let authority
    try {
      await expect.poll(() => db.prepare('SELECT status FROM isolation_jobs').get()?.status, { timeout: 8000 }).toBe('running')
      db.prepare('UPDATE isolation_controller SET expires_at=0 WHERE singleton=1').run()
      authority = peer.claimController('successor', 30_000)
      expect((await pending).result).toMatchObject({ status: 'unknown', quiescent: false })
      await value.close()
      expect(peer.hasController(authority)).toBe(true)
      await absence(db, 'fenced')
      const row = db.prepare('SELECT id FROM isolation_jobs').get()!, job = peer.get(row.id as string)!
      peer.settle(job.id, job.version, { jobId: job.id, status: 'unknown', quiescent: false, stdout: 'original uncertainty', stderr: '', artifacts: [], reason: 'lost acknowledgement' }, authority)
      peer.releaseController(authority); authority = undefined
    } finally { if (authority) peer.releaseController(authority); peer.close(); db.close() }
    const reopened = runner(input)
    const result = await reopened.run('fenced', command, async () => { throw new Error('unknown must never reload') }, new AbortController().signal)
    expect(result.result).toMatchObject({ status: 'unknown', quiescent: true, stdout: 'original uncertainty', reason: 'lost acknowledgement' })
    expect(result.artifacts).toEqual([])
    expect(await reopened.inspectQuiescence('fenced')).toBe('quiescent')
    await expect(reopened.run('new', request, async () => { throw new Error('spent budget must reject before load') }, new AbortController().signal)).rejects.toThrow('budget')
  }, 15_000)

  test('a killed Host leaves an unknown recoverable job and its original key never reloads or dispatches', async () => {
    const original = await fixture(), input = { ...original.input, maxRuns: 1, maxTotalDurationMs: 20_000,
      limits: { ...original.input.limits, maxDurationMs: 20_000 } }
    const request = { ...original.request, argv: ['/bin/sh', '-c', 'sleep 30'], artifacts: [] }
    const entry = pathToFileURL(join(import.meta.dirname, '../src/linux-repository-runner.ts')).href
    const script = `import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){try{return next(specifier,context)}catch(error){if(specifier.startsWith('.')&&specifier.endsWith('.js'))return next(specifier.slice(0,-3)+'.ts',context);throw error}}});
const {LinuxRepositoryRunner}=await import(${JSON.stringify(entry)});const {appendFile}=await import('node:fs/promises');
const input=${JSON.stringify(input)},request=${JSON.stringify(request)};const runner=new LinuxRepositoryRunner(input);
await runner.run('interrupted',request,async()=>{await appendFile(input.stateRoot+'/loads','load\\n',{mode:0o600});return Buffer.from(${JSON.stringify(original.bytes.toString('base64'))},'base64')},new AbortController().signal);`
    const host = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostic = ''; host.stderr.on('data', chunk => { diagnostic += String(chunk) })
    let db: DatabaseSync | undefined
    try {
      let running = false
      for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
        try {
          db ??= new DatabaseSync(join(input.stateRoot, 'ledger.sqlite'), { readOnly: true })
          running = db.prepare('SELECT status FROM isolation_jobs').get()?.status === 'running'
          if (running) break
        } catch { /* The child creates its private ledger before admission. */ }
        await pause(25)
      }
      expect(running, diagnostic).toBe(true)
      const closed = new Promise<void>(resolve => { host.once('close', () => resolve()) }); host.kill('SIGKILL'); await closed
      db!.close(); db = database(input)
      db.prepare('UPDATE isolation_controller SET expires_at=0 WHERE singleton=1').run()
      const reopened = runner(input)
      const result = await reopened.run('interrupted', request, async () => { throw new Error('interrupted key must never reload') }, new AbortController().signal)
      expect(result.result).toMatchObject({ status: 'unknown', quiescent: true })
      expect(result.artifacts).toEqual([])
      expect(await reopened.inspectQuiescence('interrupted')).toBe('quiescent')
      expect(await readFile(join(input.stateRoot, 'loads'), 'utf8')).toBe('load\n')
      await absence(db!, 'interrupted')
      await expect(reopened.run('another', original.request, async () => { throw new Error('budget must prevent reload') }, new AbortController().signal)).rejects.toThrow('budget')
    } finally { host.kill('SIGKILL'); db?.close() }
  }, 20_000)

  test('freezes caller configuration and rejects authority or resource pools outside the finite contract', async () => {
    const { input, request, bytes } = await fixture(), value = runner(input)
    const digest = value.contractDigest
    Object.assign(input.limits, { tmpMiB: 4096 })
    Object.assign(input.cgroupRoots, { memory: '/not-the-delegated-root' })
    expect(value.contractDigest).toBe(digest)
    expect((await value.run('frozen', request, async () => bytes, new AbortController().signal)).result.status).toBe('succeeded')
    const original = await fixture()
    for (const changed of [{ maxRuns: 1001 }, { maxTotalDurationMs: 86_400_001 }, { maxTotalDurationMs: 1 },
      { limits: { ...original.input.limits, memoryMiB: 65_536 } }]) {
      expect(() => new LinuxRepositoryRunner({ ...original.input, ...changed })).toThrow()
    }
  })

  test.each(['grant', 'backend'] as const)('rejects a foreign %s ledger before any migration, controller or grant writes', async mode => {
    const { input } = await fixture()
    const ledger = new IsolationLedger(join(input.stateRoot, 'ledger.sqlite'))
    const authority = ledger.claimController('historical-owner', 30_000)
    const identity = { principalDigest: input.authorityDigest, principalRecordId: `repository:${input.authorityDigest}`,
      principalVersion: 1, workspace: input.stateRoot, agentPreset: 'repository' }
    const grantId = mode === 'grant' ? 'historical-docker' : 'repository'
    ledger.syncGrants([{ ...identity, id: grantId, revision: 1, expiresAt: input.expiresAt, maxRuns: 1, maxTotalDurationMs: 5000 }], authority)
    let job = ledger.prepare({ identity, sessionId: `authority:${input.authorityDigest}`, grantId, idempotencyKey: 'historical',
      requestDigest: 'b'.repeat(64), durationMs: 5000, authority }).job
    job = ledger.markDispatched(job.id, job.version, authority)
    ledger.settle(job.id, job.version, { jobId: job.id, status: 'unknown', quiescent: false, stdout: 'historical Docker evidence', stderr: '', artifacts: [] }, authority)
    ledger.releaseController(authority)
    const path = join(input.stateRoot, 'ledger.sqlite'), before = await readFile(path), wal = await readFile(path + '-wal')
    const db = new DatabaseSync(path, { readOnly: true })
    const snapshot = () => ({ grants: db.prepare('SELECT * FROM isolation_grants').all(), jobs: db.prepare('SELECT * FROM isolation_jobs').all(),
      audits: db.prepare('SELECT * FROM isolation_audit').all(), controller: db.prepare('SELECT * FROM isolation_controller').all() })
    try {
      const original = snapshot()
      expect(() => new LinuxRepositoryRunner(input)).toThrow('foreign authority or backend')
      expect((await readFile(path)).equals(before)).toBe(true)
      expect((await readFile(path + '-wal')).equals(wal)).toBe(true)
      expect(snapshot()).toEqual(original)
      expect(db.prepare('SELECT backend_kind,result_json FROM isolation_jobs').get()).toMatchObject({ backend_kind: 'docker' })
      expect(db.prepare('SELECT revoked FROM isolation_grants').get()?.revoked).toBe(0)
    } finally { db.close(); ledger.close() }
  })

  test('startup never steals a predecessor controller and close cancels its wait before loading', async () => {
    const { input, request } = await fixture(), ledger = new IsolationLedger(join(input.stateRoot, 'ledger.sqlite'))
    const authority = ledger.claimController('predecessor', 30_000), value = runner(input)
    const pending = value.run('waiting', request, async () => { throw new Error('must not load before controller admission') }, new AbortController().signal)
    const rejected = expect(pending).rejects.toThrow()
    try {
      await value.close()
      await rejected
      expect(ledger.hasController(authority)).toBe(true)
      const db = database(input)
      try { expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(0) } finally { db.close() }
    } finally { ledger.releaseController(authority); ledger.close() }
  })

  test('an expired authority rejects before loading or reserving a new key', async () => {
    const { input, request } = await fixture({ expiresAt: Date.now() - 1 })
    const value = runner(input)
    await expect(value.run('expired', request, async () => { throw new Error('must not load') }, new AbortController().signal)).rejects.toThrow('unauthorized')
    const db = database(input)
    try { expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(0) } finally { db.close() }
  })
})
