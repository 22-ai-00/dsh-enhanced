import { createHash } from 'node:crypto'
import { copyFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as pause } from 'node:timers/promises'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { defaultLimits } from '../src/config.js'
import { IsolationLedger } from '../src/ledger.js'
import { linuxExecutionContractDigest, type LinuxExecutionContract } from '../src/linux-execution-contract.js'
import { prepareLinuxExecutionIntent, runLinuxExecution } from '../src/linux-execution.js'
import { hashLinuxRuntimeTree, linuxRuntimeDigest, type LinuxRuntime } from '../src/linux-runtime.js'
import { LinuxVerifierRunner, type LinuxVerifierRunnerConfig } from '../src/linux-verifier-runner.js'
import { IsolatedVerifierRunner } from '../src/verifier-runner.js'
import { observeStorage } from '../src/storage.js'
import { normalizeRequest } from '../src/workspace.js'

const uid = process.getuid?.() ?? 0
const real = process.env.DSH_NATIVE_CGROUP_REAL === '1' && process.platform === 'linux' && uid > 0
const roots: string[] = []
const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function root(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix)); roots.push(path); return path
}
async function fixture(): Promise<LinuxVerifierRunnerConfig> {
  const stateRoot = await root('dsh-linux-verifier-'), runtimeRoot = await root('dsh-linux-verifier-runtime-')
  const write = async (path: string, content: string, mode = 0o444): Promise<void> => {
    await mkdir(dirname(join(runtimeRoot, path)), { recursive: true, mode: 0o755 })
    await writeFile(join(runtimeRoot, path), content, { mode })
  }
  // Real Node 22 executable checks run on the Host. pnpm adapters and version
  // manifests are minimal fixture content; candidate execution uses real Python.
  await mkdir(join(runtimeRoot, 'bin'), { mode: 0o755 })
  await copyFile('/usr/bin/node', join(runtimeRoot, 'bin/node'))
  await chmod(join(runtimeRoot, 'bin/node'), 0o555)
  await write('pnpm/bin/pnpm.mjs', 'console.log("11.7.0")\n')
  await write('pnpm-native/pnpm', '#!/bin/sh\nprintf "11.7.0\\n"\n', 0o555)
  await copyFile('/usr/bin/node', join(runtimeRoot, 'pnpm-native/node'))
  await chmod(join(runtimeRoot, 'pnpm-native/node'), 0o555)
  await write('pnpm-native/package.json', '{"name":"@pnpm/exe","version":"11.7.0"}')
  await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
  for (const [name, version] of Object.entries({ typescript: '6.0.3', '@deepseek-ai/cordis': '4.0.5',
    '@deepseek-ai/dsh-tools': '0.2.1-rc.2', '@deepseek-ai/dsh-system-prompt': '0.2.1-rc.2' })) {
    await write(`node_modules/${name}/package.json`, JSON.stringify({ version }))
  }
  for (const name of ['store', 'cache']) await mkdir(join(runtimeRoot, name), { mode: 0o755 })
  await chmod(runtimeRoot, 0o755)
  const info = await stat(runtimeRoot)
  const runtime: LinuxRuntime = { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: '1'.repeat(40), lockSha256: hash(await readFile(join(runtimeRoot, 'pnpm-lock.yaml'))),
    root: { path: runtimeRoot, dev: info.dev, ino: info.ino, sha256: await hashLinuxRuntimeTree(runtimeRoot) },
    nodePath: join(runtimeRoot, 'bin/node'), nodeSha256: hash(await readFile(join(runtimeRoot, 'bin/node'))),
    pnpmPath: join(runtimeRoot, 'pnpm/bin/pnpm.mjs'), nativePnpmRoot: join(runtimeRoot, 'pnpm-native'),
    nativePnpmPath: join(runtimeRoot, 'pnpm-native/pnpm'), modulesPath: join(runtimeRoot, 'node_modules'),
    storePath: join(runtimeRoot, 'store'), cachePath: join(runtimeRoot, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } }
  return { backend: 'linux-native', stateRoot, runtime, authorityDigest: 'a'.repeat(64),
    command: '/usr/bin/python3 -I -S /workspace/artifact < /workspace/input',
    expiresAt: Date.now() + 120_000, maxRuns: 8, maxTotalDurationMs: 60_000, maxDurationMs: 5_000, maxOutputBytes: 4096,
    limits: { memoryMiB: 128, pidsLimit: 32, cpus: 0.5, workspaceMiB: 4, workspaceInodes: 256 },
    cgroupRoots: { mode: 'v1', cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`,
      memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`, pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`,
      freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}` } }
}
function database(input: LinuxVerifierRunnerConfig): DatabaseSync { return new DatabaseSync(join(input.stateRoot, 'ledger.sqlite')) }
function contract(input: LinuxVerifierRunnerConfig): LinuxExecutionContract {
  return { schemaVersion: 1, backend: 'linux-native', runtimeDigest: linuxRuntimeDigest(input.runtime), profile: 'ordinary',
    limits: { ...defaultLimits, ...input.limits, maxDurationMs: input.maxDurationMs, maxOutputBytes: input.maxOutputBytes },
    keeperLimits: { memoryMiB: 128, pidsLimit: 64, cpus: 0.5 }, cgroupRoots: input.cgroupRoots }
}
const identity = (input: LinuxVerifierRunnerConfig) => ({ principalDigest: input.authorityDigest,
  principalRecordId: `verification:${input.authorityDigest}`, principalVersion: 1, workspace: input.stateRoot, agentPreset: 'verification' })
async function seed(input: LinuxVerifierRunnerConfig, key: string, backend: 'docker' | 'linux-native' = 'linux-native') {
  const ledger = new IsolationLedger(join(input.stateRoot, 'ledger.sqlite'))
  const controller = ledger.claimController('fixture-predecessor', 30_000)
  ledger.syncGrants([{ ...identity(input), id: 'verification', revision: 1, expiresAt: input.expiresAt,
    maxRuns: input.maxRuns, maxTotalDurationMs: input.maxTotalDurationMs }], controller)
  const artifact = 'print("must-not-replay")\n', stdin = ''
  const request = normalizeRequest({ grantId: 'verification', idempotencyKey: key, command: input.command,
    files: [{ path: 'artifact', content: artifact }, { path: 'input', content: stdin }], artifacts: [], timeoutMs: input.maxDurationMs }, contract(input).limits)
  const requestDigest = hash(JSON.stringify({ request, authority: input.authorityDigest,
    ...(backend === 'linux-native' ? { contract: linuxExecutionContractDigest(contract(input)) } : {}) }))
  const observation = await observeStorage(input.stateRoot)
  if (!observation) throw new Error('fixture state observation unavailable')
  let job = ledger.prepare({ identity: identity(input), sessionId: `authority:${input.authorityDigest}`, grantId: 'verification',
    idempotencyKey: key, requestDigest, durationMs: input.maxDurationMs, authority: controller, backend,
    ...(backend === 'linux-native' ? { linuxContract: contract(input),
      resourceReservation: { memoryMiB: 293, workspaceInodes: 4640, maxMemoryMiB: 2048, maxWorkspaceInodes: 32768 },
      storageBudget: { maxStateBytes: 268435456, maxJobRecords: 10000, reservedBytes: 16777216,
        observation } } : {}) }).job
  const stateRoot = join(input.stateRoot, 'linux-executions')
  if (backend === 'linux-native') {
    await mkdir(stateRoot, { mode: 0o700 })
    const intent = await prepareLinuxExecutionIntent({ stateRoot, contract: contract(input),
      job: { id: job.id, requestDigest, nativeNonce: job.nativeNonce!, nativeResourceId: job.nativeResourceId!, deadline: job.deadline } })
    job = ledger.markLinuxCreateIntent(job.id, job.version, intent, controller)
  }
  job = ledger.markDispatched(job.id, job.version, controller)
  return { ledger, controller, job, artifact, stdin, stateRoot, contract: contract(input) }
}

// Opt-in exercises actual delegated cgroups, namespace mounts, private receipts,
// real Node runtime verification and Python candidates. No Docker fallback.
describe.skipIf(!real)('finite Linux private verifier API with real kernel boundaries', () => {
  test('facade runs once, caches the exact key and retains budget and socket marker across reopen', async () => {
    const input = await fixture()
    await writeFile(join(input.stateRoot, 'docker-socket-path'), '/var/run/docker.sock\n', { mode: 0o600 })
    const artifact = 'import os,sys,subprocess; assert os.statvfs("/tmp").f_files==256 and os.statvfs("/workspace").f_files==256; print("seen:"+sys.stdin.read()); print(os.environ["PATH"]); print(subprocess.check_output(["node","--version"]).decode().strip())\n'
    const runner = new IsolatedVerifierRunner(input)
    let first
    try {
      first = await runner.run('normal', artifact, 'input', new AbortController().signal)
      expect(first).toMatchObject({ status: 'succeeded', quiescent: true, exitCode: 0,
        stdout: 'seen:input\n/runtime/0/bin:/runtime/0/pnpm-native:/usr/bin:/bin\nv22.23.2\n' })
      expect(await runner.run('normal', artifact, 'input', new AbortController().signal)).toEqual(first)
      await expect(runner.run('normal', 'print("changed")', 'input', new AbortController().signal)).rejects.toThrow('different request')
      const db = database(input)
      try {
        const row = db.prepare('SELECT backend_kind,reserved_memory_mib,reserved_workspace_inodes,dispatch_attempted FROM isolation_jobs').get()
        expect(row).toMatchObject({ backend_kind: 'linux-native', reserved_memory_mib: 293, reserved_workspace_inodes: 4640, dispatch_attempted: 1 })
        expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(1)
      } finally { db.close() }
    } finally { await runner.close() }
    const reopened = new LinuxVerifierRunner(input)
    try { expect(await reopened.run('normal', artifact, 'input', new AbortController().signal)).toEqual(first) }
    finally { await reopened.close() }
    expect(await readFile(join(input.stateRoot, 'docker-socket-path'), 'utf8')).toBe('/var/run/docker.sock\n')
    expect((await readdir(join(input.stateRoot, 'linux-executions', 'jobs'))).length).toBe(1)
  })

  test.each(['runs', 'duration'] as const)('finite %s budget remains exhausted after close and reopen', async mode => {
    const input = { ...await fixture(), ...(mode === 'runs' ? { maxRuns: 1 } : { maxTotalDurationMs: 5000 }) }
    const runner = new LinuxVerifierRunner(input)
    try {
      expect(await runner.run('one', 'print("one")', '', new AbortController().signal)).toMatchObject({ status: 'succeeded' })
      await expect(runner.run('two', 'print("two")', '', new AbortController().signal)).rejects.toThrow('budget')
    } finally { await runner.close() }
    const reopened = new LinuxVerifierRunner(input)
    try { await expect(reopened.run('three', 'print("three")', '', new AbortController().signal)).rejects.toThrow('budget') }
    finally { await reopened.close() }
  })

  test.each(['cancel', 'revoke', 'close'] as const)('revokes running process trees on %s and proves both groups stopped', async mode => {
    const input = await fixture(), runner = new LinuxVerifierRunner(input), controller = new AbortController()
    const pending = runner.run(mode, 'import subprocess,time; subprocess.Popen(["/usr/bin/sleep","30"]); time.sleep(30)', '', controller.signal)
    const db = database(input)
    try {
      await expect.poll(() => db.prepare('SELECT status FROM isolation_jobs WHERE idempotency_key=?').get(mode)?.status, { timeout: 8000 }).toBe('running')
      if (mode === 'cancel') controller.abort()
      else if (mode === 'revoke') {
        const ledger = new IsolationLedger(join(input.stateRoot, 'ledger.sqlite'))
        try { ledger.revoke('verification', 1, 'test-revocation') } finally { ledger.close() }
      } else await runner.close()
      expect(await pending).toMatchObject({ status: 'cancelled', quiescent: true })
      const row = db.prepare('SELECT linux_resources_json FROM isolation_jobs WHERE idempotency_key=?').get(mode)
      const resources = JSON.parse(row?.linux_resources_json as string)
      for (const snapshot of [resources.worker, resources.keeper]) for (const directory of Object.values(snapshot.directories) as { path: string }[]) {
        await expect(stat(directory.path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally { db.close(); await runner.close() }
  }, 15_000)

  test('persisted grant expiry bounds an admitted execution and denies new admission', async () => {
    const input = await fixture(), runner = new LinuxVerifierRunner(input), db = database(input)
    const originalPrepare = IsolationLedger.prototype.prepare
    const prepare = vi.spyOn(IsolationLedger.prototype, 'prepare')
    let expiresAt = 0
    // Runtime verification and storage observation remain real. Narrow only this
    // fixture's persisted grant at admission, so their variable cost cannot use
    // up the execution window. The configured run/duration budgets stay intact.
    prepare.mockImplementation(function (this: IsolationLedger, admission) {
      if (admission.identity.workspace === input.stateRoot && admission.idempotencyKey === 'expiry') {
        expiresAt = Date.now() + 2500
        expect(expiresAt).toBeLessThan(input.expiresAt)
        db.prepare('UPDATE isolation_grants SET expires_at=? WHERE id=?').run(expiresAt, 'verification')
        prepare.mockRestore()
      }
      return Reflect.apply(originalPrepare, this, [admission])
    })
    try {
      const pending = runner.run('expiry', 'import time; time.sleep(30)', '', new AbortController().signal)
      // Attach a rejection handler while observing admission; awaiting pending
      // below still fails on any error instead of accepting a prestart rejection.
      void pending.catch(() => {})
      await expect.poll(() => db.prepare('SELECT status FROM isolation_jobs WHERE idempotency_key=?').get('expiry')?.status,
        { timeout: 8000 }).toBe('running')
      const admitted = db.prepare('SELECT deadline,created_at,reserved_duration_ms FROM isolation_jobs WHERE idempotency_key=?').get('expiry')!
      expect(admitted.deadline).toBe(expiresAt)
      expect(expiresAt).toBeLessThan((admitted.created_at as number) + input.maxDurationMs)
      expect(admitted.reserved_duration_ms).toBe(input.maxDurationMs)
      const result = await pending
      expect(['cancelled', 'timed-out']).toContain(result.status)
      expect(result.quiescent).toBe(true)
      expect(Date.now()).toBeGreaterThanOrEqual(expiresAt)
      expect(db.prepare('SELECT expires_at,max_runs,max_total_duration_ms FROM isolation_grants WHERE id=?').get('verification'))
        .toMatchObject({ expires_at: expiresAt, max_runs: input.maxRuns, max_total_duration_ms: input.maxTotalDurationMs })
      await expect(runner.run('expired', 'print("bad")', '', new AbortController().signal)).rejects.toThrow('unauthorized')
      expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(1)
    } finally { prepare.mockRestore(); await runner.close(); db.close() }
  }, 20_000)

  test('an already expired configured authority denies admission without creating a job', async () => {
    const input = { ...await fixture(), expiresAt: Date.now() - 1 }, runner = new LinuxVerifierRunner(input)
    try {
      await expect(runner.run('already-expired', 'print("bad")', '', new AbortController().signal)).rejects.toThrow('unauthorized')
      const db = database(input)
      try { expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(0) } finally { db.close() }
      expect(await readdir(join(input.stateRoot, 'linux-executions'))).toEqual([])
    } finally { await runner.close() }
  })

  test('verifies the entire runtime for every new key before reserving or dispatching', async () => {
    const input = await fixture(), runner = new LinuxVerifierRunner(input)
    try {
      expect(await runner.run('good', 'print("good")', '', new AbortController().signal)).toMatchObject({ status: 'succeeded' })
      await writeFile(join(input.runtime.cachePath, 'drift'), 'tampered')
      await expect(runner.run('tampered', 'print("bad")', '', new AbortController().signal)).rejects.toThrow('root differs')
      const db = database(input)
      try { expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(1) } finally { db.close() }
      expect(await runner.run('good', 'print("good")', '', new AbortController().signal)).toMatchObject({ status: 'succeeded' })
    } finally { await runner.close() }
  })

  test('waits for the predecessor controller without stealing, and close cancels startup promptly', async () => {
    const input = await fixture(), ledger = new IsolationLedger(join(input.stateRoot, 'ledger.sqlite'))
    const prior = ledger.claimController('prior-controller', 30_000)
    const runner = new LinuxVerifierRunner(input)
    const pending = runner.run('blocked', 'print("bad")', '', new AbortController().signal)
    const rejected = expect(pending).rejects.toThrow()
    try {
      await pause(100)
      expect(ledger.hasController(prior)).toBe(true)
      const before = Date.now(); await runner.close()
      expect(Date.now() - before).toBeLessThan(1000)
      await rejected
      expect(ledger.hasController(prior)).toBe(true)
    } finally { await runner.close(); ledger.releaseController(prior); ledger.close() }
  })

  test('acquires only after a short predecessor lease expires', async () => {
    const input = await fixture(), ledger = new IsolationLedger(join(input.stateRoot, 'ledger.sqlite'))
    const prior = ledger.claimController('prior-controller', 400)
    const runner = new LinuxVerifierRunner(input)
    try {
      expect(await runner.run('after-expiry', 'print("claimed")', '', new AbortController().signal)).toMatchObject({ status: 'succeeded', stdout: 'claimed\n' })
      expect(ledger.hasController(prior)).toBe(false)
    } finally { await runner.close(); ledger.close() }
  })

  test('controller fencing cancels the kernel workload and prevents the old owner from settling or releasing the new fence', async () => {
    const input = await fixture(), runner = new LinuxVerifierRunner(input)
    const pending = runner.run('fenced', 'import time; time.sleep(30)', '', new AbortController().signal)
    const db = database(input), peer = new IsolationLedger(join(input.stateRoot, 'ledger.sqlite'))
    let authority
    try {
      await expect.poll(() => db.prepare('SELECT status FROM isolation_jobs').get()?.status, { timeout: 8000 }).toBe('running')
      // A lost renewal is represented by the persisted lease expiry; acquisition
      // and cancellation still use real ledger fences and actual kernel groups.
      db.prepare('UPDATE isolation_controller SET expires_at=0 WHERE singleton=1').run()
      authority = peer.claimController('successor', 30_000)
      expect(await pending).toMatchObject({ status: 'unknown', quiescent: false })
      await runner.close()
      expect(peer.hasController(authority)).toBe(true)
      const resources = JSON.parse(db.prepare('SELECT linux_resources_json FROM isolation_jobs').get()?.linux_resources_json as string)
      for (const snapshot of [resources.worker, resources.keeper]) for (const directory of Object.values(snapshot.directories) as { path: string }[]) {
        await expect(stat(directory.path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      await runner.close()
      if (authority) peer.releaseController(authority)
      peer.close(); db.close()
    }
    const reopened = new LinuxVerifierRunner(input)
    try { expect(await reopened.run('fenced', 'import time; time.sleep(30)', '', new AbortController().signal)).toMatchObject({ status: 'cancelled', quiescent: true }) }
    finally { await reopened.close() }
  }, 15_000)

  test.each(['budget', 'capacity'] as const)('historical Docker unknown preserves its body, socket marker and %s occupancy', async mode => {
    const input = { ...await fixture(), ...(mode === 'budget' ? { maxRuns: 1 } : {}) }
    const seeded = await seed(input, 'legacy', 'docker')
    seeded.ledger.settle(seeded.job.id, seeded.job.version, { jobId: seeded.job.id, status: 'unknown', quiescent: false,
      stdout: 'original evidence', stderr: '', artifacts: [], reason: 'docker-creation-unconfirmed' }, seeded.controller)
    seeded.ledger.releaseController(seeded.controller); seeded.ledger.close()
    await writeFile(join(input.stateRoot, 'docker-socket-path'), '/var/run/docker.sock\n', { mode: 0o600 })
    const runner = new LinuxVerifierRunner(input)
    try {
      expect(await runner.run('legacy', seeded.artifact, seeded.stdin, new AbortController().signal)).toMatchObject({ status: 'unknown', quiescent: false, stdout: 'original evidence' })
      await expect(runner.run('fresh', 'print("bad")', '', new AbortController().signal)).rejects.toThrow(mode === 'budget' ? 'budget' : 'active legacy job')
      const db = database(input)
      try { expect(db.prepare('SELECT backend_kind,result_json FROM isolation_jobs').get()?.backend_kind).toBe('docker') } finally { db.close() }
      expect(await readdir(join(input.stateRoot, 'linux-executions'))).toEqual([])
    } finally { await runner.close() }
    expect(await readFile(join(input.stateRoot, 'docker-socket-path'), 'utf8')).toBe('/var/run/docker.sock\n')
  })

  test.each(['partial', 'complete'] as const)('reconciles %s private proof without rewriting a historical unknown outcome', async mode => {
    const input = await fixture(), seeded = await seed(input, mode)
    const controller = new AbortController()
    if (mode === 'partial') controller.abort()
    const outcome = await runLinuxExecution({ stateRoot: seeded.stateRoot, contract: seeded.contract, intent: seeded.job.linuxIntent!,
      argv: ['/usr/bin/true'], files: [], signal: controller.signal,
      recordResources: async () => {}, authorizeStart: () => false })
    expect(outcome.result.quiescent).toBe(true)
    expect(mode === 'partial' ? outcome.partialProof : outcome.receipt).toBeDefined()
    seeded.ledger.settle(seeded.job.id, seeded.job.version, { jobId: seeded.job.id, status: 'unknown', quiescent: false,
      stdout: 'original outcome', stderr: '', artifacts: [], reason: 'historical uncertainty' }, seeded.controller)
    seeded.ledger.releaseController(seeded.controller); seeded.ledger.close()
    const runner = new LinuxVerifierRunner(input)
    try {
      expect(await runner.run(mode, seeded.artifact, seeded.stdin, new AbortController().signal)).toMatchObject({
        status: 'unknown', quiescent: true, stdout: 'original outcome', reason: 'historical uncertainty' })
      const db = database(input)
      try { expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(1) } finally { db.close() }
    } finally { await runner.close() }
  })

  test('background reconciliation repairs a temporary receipt publication failure in the same Host and releases capacity without replay', async () => {
    const base = await fixture(), input = { ...base, limits: { ...base.limits, workspaceInodes: 10_000 } }
    const runner = new LinuxVerifierRunner(input), artifact = 'import time; print("original output",flush=True); time.sleep(1)'
    const pending = runner.run('temporary-receipt-fault', artifact, '', new AbortController().signal)
    const db = database(input)
    let receiptPath: string | undefined
    try {
      await expect.poll(() => db.prepare('SELECT status FROM isolation_jobs').get()?.status, { timeout: 8000 }).toBe('running')
      const row = db.prepare('SELECT id,native_nonce FROM isolation_jobs').get() as { id: string; native_nonce: string }
      receiptPath = join(input.stateRoot, 'linux-executions', 'receipts', `${row.id}-${row.native_nonce}.json`)
      // A real filesystem collision blocks publication after all candidate and
      // keeper resources stop. No model/process mock supplies cleanup evidence.
      await mkdir(receiptPath, { mode: 0o700 })
      const original = await pending
      expect(original).toMatchObject({ status: 'unknown', quiescent: false })
      await expect(runner.run('capacity-blocked', 'print("blocked")', '', new AbortController().signal)).rejects.toThrow('resource pool')
      await rm(receiptPath, { recursive: true })
      await expect.poll(() => {
        const saved = db.prepare('SELECT result_json FROM isolation_jobs WHERE id=?').get(row.id)
        return saved?.result_json ? JSON.parse(saved.result_json as string).quiescent : false
      }, { timeout: 12_000 }).toBe(true)
      expect(await runner.run('temporary-receipt-fault', artifact, '', new AbortController().signal)).toEqual({ ...original, quiescent: true })
      expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(1)
      expect((await readdir(join(input.stateRoot, 'linux-executions', 'jobs'))).length).toBe(1)
      expect(await runner.run('capacity-restored', 'print("restored")', '', new AbortController().signal)).toMatchObject({
        status: 'succeeded', quiescent: true, stdout: 'restored\n' })
    } finally {
      if (receiptPath) await rm(receiptPath, { recursive: true, force: true })
      db.close(); await runner.close()
    }
  }, 25_000)

  test.each(['prepared', 'unknown'] as const)('switching the same state root back to Docker retains Linux %s without passing it to Docker cleanup', async status => {
    const input = await fixture(), seeded = await seed(input, 'backend-switch')
    if (status === 'unknown') seeded.ledger.settle(seeded.job.id, seeded.job.version,
      { jobId: seeded.job.id, status: 'unknown', quiescent: false, stdout: 'original Linux evidence', stderr: '', artifacts: [],
        reason: 'retained uncertainty' }, seeded.controller)
    seeded.ledger.releaseController(seeded.controller); seeded.ledger.close()
    const executableRoot = await root('dsh-rejecting-docker-fixture-')
    const called = join(executableRoot, 'called'), dockerPath = join(executableRoot, 'docker')
    // This rejecting fixture checks routing only; it is not a real Docker test.
    await writeFile(dockerPath, `#!/bin/sh\nprintf called > "${called}"\nexit 17\n`, { mode: 0o500 })
    const runner = new IsolatedVerifierRunner({ stateRoot: input.stateRoot, authorityDigest: input.authorityDigest,
      command: input.command, expiresAt: input.expiresAt, maxRuns: input.maxRuns,
      maxTotalDurationMs: input.maxTotalDurationMs, maxDurationMs: input.maxDurationMs, maxOutputBytes: input.maxOutputBytes,
      image: `sha256:${'1'.repeat(64)}`, dockerPath, socketPath: '/var/run/docker.sock' })
    try {
      await expect(runner.run('backend-switch', seeded.artifact, seeded.stdin, new AbortController().signal)).rejects.toThrow('different request or backend')
      await expect(stat(called)).rejects.toMatchObject({ code: 'ENOENT' })
      const db = database(input)
      try {
        const row = db.prepare('SELECT backend_kind,status,result_json FROM isolation_jobs').get()
        expect(row).toMatchObject({ backend_kind: 'linux-native', status: 'unknown' })
        expect(JSON.parse(row?.result_json as string)).toMatchObject({ quiescent: false,
          stdout: status === 'unknown' ? 'original Linux evidence' : '' })
        expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(1)
      } finally { db.close() }
    } finally { await runner.close() }
  })

  test('refuses runtime and state overlap before creating a ledger', async () => {
    const input = await fixture()
    expect(() => new LinuxVerifierRunner({ ...input, stateRoot: input.runtime.root.path })).toThrow('overlaps runtime')
    await expect(stat(join(input.runtime.root.path, 'ledger.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects a non-default inode limit whose workspace, tmp and shm reservations exceed the pool', async () => {
    const input = await fixture()
    expect(() => new LinuxVerifierRunner({ ...input, limits: { ...input.limits, workspaceInodes: 16_000 } })).toThrow('resource pool')
    await expect(stat(join(input.stateRoot, 'ledger.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
