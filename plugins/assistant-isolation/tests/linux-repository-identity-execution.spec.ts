import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { appendFile, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import { LinuxCgroupLease } from '../src/linux-cgroups.js'
import { runLinuxRepositoryNamespace, type LinuxCandidateIdentity } from '../src/linux-namespace.js'
import { IsolationLedger } from '../src/ledger.js'
import { reconcileLinuxJob } from '../src/linux-job-recovery.js'
import { linuxExecutionContractDigest, linuxJobResourceReservation, validateLinuxExecutionContract,
  validateLinuxExecutionIntent, type LinuxExecutionResources, type LinuxRepositoryExecutionContractV3 } from '../src/linux-execution-contract.js'
import { linuxExecutionReceiptBinding, prepareLinuxRepositoryIntent, readLinuxRepositoryReceipt,
  reconcileLinuxRepositoryExecution, runLinuxRepositoryExecution, type LinuxRepositoryExecutionContext } from '../src/linux-execution.js'
import { inspectLinuxRepositoryCandidate, inspectLinuxUserNamespace, linuxRepositoryImplementationDigest, readLinuxUserNamespaceMapping } from '../src/linux-user-namespace.js'
import type { LinuxSystemSnapshot } from '../src/linux-system-snapshot.js'

// Inject only failed private writes, implementation drift and a control-pipe close. Successful kernel
// namespace, candidate identity, cgroup inventory and termination are never mocked.
const fault = vi.hoisted(() => ({ journal: '', phase: '', fired: false, implementationDigest: '', keeper: undefined as ChildProcess | undefined }))
vi.mock('../src/linux-user-namespace.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/linux-user-namespace.js')>()
  return { ...actual, linuxRepositoryImplementationDigest: () => fault.implementationDigest || actual.linuxRepositoryImplementationDigest() }
})
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (!fault.fired && String(args[1]) === fault.journal && JSON.parse(await actual.readFile(args[0], 'utf8')).phase === fault.phase) {
      fault.fired = true
      throw new Error('identity journal injected rename EIO')
    }
    return await actual.rename(...args)
  } }
})
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args)
    if (args[0] === '/bin/sh' && Array.isArray(args[1]) && args[1].includes('dsh-keeper-gate')) fault.keeper = child
    return child
  } }
})
const snapshotFile = process.env.DSH_LINUX_SYSTEM_SNAPSHOT_JSON
const real = process.platform === 'linux' && process.env.DSH_NATIVE_CGROUP_REAL === '1' && !!snapshotFile
const uid = process.getuid?.() ?? 0
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
async function contract(): Promise<LinuxRepositoryExecutionContractV3> {
  const decoded = JSON.parse(await readFile(resolve(snapshotFile!), 'utf8')) as { snapshot?: LinuxSystemSnapshot } & LinuxSystemSnapshot
  return { schemaVersion: 3, backend: 'linux-native', runtimeDigest: 'a'.repeat(64), profile: 'repository',
    implementationDigest: linuxRepositoryImplementationDigest(), userNamespace: await readLinuxUserNamespaceMapping(), systemSnapshot: decoded.snapshot ?? decoded,
    limits: { maxDurationMs: 60_000, maxInputBytes: 64 * 1024 ** 2, maxOutputBytes: 4096, maxArtifactBytes: 32 * 1024 ** 2,
      maxFiles: 8, memoryMiB: 256, workspaceMiB: 8, workspaceInodes: 256, tmpMiB: 8, tmpInodes: 128,
      inputMiB: 65, inputInodes: 16, pidsLimit: 64, cpus: 1 },
    keeperLimits: { memoryMiB: 256, pidsLimit: 64, cpus: 1 },
    cgroupRoots: { mode: 'v1', cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`,
      memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`, pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`,
      freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}` } }
}
function request(command = 'cat /input/source.tar > package.tgz; printf identity-built', payload = Buffer.from([0, 255, 128, 3])) {
  return { argv: ['/bin/sh', '-ec', command], archive: { bytes: payload, sha256: sha(payload) }, artifacts: ['package.tgz'] }
}
async function fixture(input?: LinuxRepositoryExecutionContractV3, supplied = request()) {
  const configured = input ?? await contract()
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-identity-execution-')), id = randomUUID()
  const intent = await prepareLinuxRepositoryIntent({ stateRoot, contract: configured, ...supplied,
    job: { id, nativeResourceId: `linux-${id}`, requestDigest: 'b'.repeat(64), nativeNonce: randomBytes(16).toString('hex'),
      deadline: Date.now() + configured.limits.maxDurationMs } })
  return { stateRoot, contract: configured, intent, ...supplied }
}
const journalPath = (ctx: LinuxRepositoryExecutionContext): string => join(ctx.stateRoot, 'jobs', `${ctx.intent.jobId}-${ctx.intent.nativeNonce}.json`)
const journal = async (ctx: LinuxRepositoryExecutionContext): Promise<Record<string, any>> => JSON.parse(await readFile(journalPath(ctx), 'utf8'))
async function absent(ctx: LinuxRepositoryExecutionContext): Promise<void> {
  for (const nonce of [ctx.intent.workerNonce, ctx.intent.keeperNonce]) for (const root of Object.values(ctx.intent.roots)) {
    await expect(lstat(join(root.path, `job-${ctx.intent.jobId}-${nonce}`))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  await expect(lstat(ctx.intent.namespacePath)).rejects.toMatchObject({ code: 'ENOENT' })
}
async function dispose(ctx: LinuxRepositoryExecutionContext): Promise<void> {
  fault.journal = ''; fault.phase = ''; fault.fired = false; fault.implementationDigest = ''
  const recovered = await reconcileLinuxRepositoryExecution(ctx)
  // Never erase private ownership evidence if production cleanup is unproven.
  expect(recovered.quiescent, JSON.stringify(recovered)).toBe(true)
  await absent(ctx)
  await rm(ctx.stateRoot, { recursive: true, force: true })
}
async function evidence(kind: string, value: unknown): Promise<void> {
  if (process.env.DSH_LINUX_IDENTITY_EXECUTION_EVIDENCE) await appendFile(process.env.DSH_LINUX_IDENTITY_EXECUTION_EVIDENCE,
    JSON.stringify({ kind, value }) + '\n')
}
const run = (ctx: Awaited<ReturnType<typeof fixture>>) => runLinuxRepositoryExecution({ ...ctx,
  signal: new AbortController().signal, recordResources: async () => {}, authorizeStart: () => true })

describe.skipIf(!real)('durable repository protocol 3 with actual kernel identities', () => {
  test('ledger reserves every V3 mount and only settles a null anchor after a negative receipt', async () => {
    const configured = await contract(), stateRoot = await mkdtemp(join(tmpdir(), 'dsh-identity-ledger-'))
    const ledger = new IsolationLedger(join(stateRoot, 'ledger.sqlite'))
    const authority = ledger.claimController('identity-ledger', 30_000)
    const identity = { principalDigest: 'a'.repeat(64), principalRecordId: 'owner', principalVersion: 1, workspace: '/work', agentPreset: 'default' }
    ledger.syncGrants([{ ...identity, id: 'grant', revision: 1, expiresAt: Date.now() + 120_000, maxRuns: 1, maxTotalDurationMs: 60_000 }], authority)
    const minimum = linuxJobResourceReservation(configured)
    const resourceReservation = { memoryMiB: minimum.memoryMiB, workspaceInodes: minimum.workspaceInodes,
      maxMemoryMiB: minimum.memoryMiB, maxWorkspaceInodes: minimum.workspaceInodes }
    const storageBudget = { maxStateBytes: 1024 ** 3, maxJobRecords: 10, reservedBytes: minimum.storageBytes,
      observation: { bytes: 0, observedAt: Date.now() } }
    const input = { identity, sessionId: 'session', grantId: 'grant', idempotencyKey: 'one', requestDigest: 'b'.repeat(64),
      durationMs: 60_000, backend: 'linux-native' as const, linuxContract: configured, authority, resourceReservation, storageBudget }
    let ctx: LinuxRepositoryExecutionContext | undefined
    try {
      for (const changed of [
        { resourceReservation: { ...resourceReservation, memoryMiB: minimum.memoryMiB - 1 } },
        { resourceReservation: { ...resourceReservation, workspaceInodes: minimum.workspaceInodes - 1 } },
        { storageBudget: { ...storageBudget, reservedBytes: minimum.storageBytes - 1 } },
      ]) expect(() => ledger.prepare({ ...input, ...changed })).toThrow('repository resources must be reserved')
      let job = ledger.prepare(input).job
      const supplied = request(), intent = await prepareLinuxRepositoryIntent({ stateRoot, contract: configured, ...supplied,
        job: { id: job.id, requestDigest: job.requestDigest, nativeNonce: job.nativeNonce!, nativeResourceId: job.nativeResourceId!, deadline: job.deadline } })
      ctx = { stateRoot, contract: configured, intent }
      job = ledger.markLinuxCreateIntent(job.id, job.version, intent, authority)
      job = ledger.markDispatched(job.id, job.version, authority)
      Object.assign(fault, { journal: journalPath(ctx), phase: 'recorded', fired: false })
      const outcome = await runLinuxRepositoryExecution({ ...ctx, ...supplied, signal: new AbortController().signal,
        recordResources: async () => { throw new Error('preanchor must not publish resources') }, authorizeStart: () => { throw new Error('preanchor must not start') } })
      expect(outcome.resources).toMatchObject({ schemaVersion: 2, userNamespace: null })
      job = ledger.recordLinuxResources(job.id, job.version, outcome.resources!, authority)
      expect(() => ledger.start(job.id, job.version, authority)).toThrow('namespace admission is missing')
      expect(() => ledger.settleLinuxReceipt(job.id, job.version, linuxExecutionReceiptBinding(outcome.receipt!),
        { ...outcome.result, status: 'succeeded' }, authority)).toThrow('namespace admission is missing')
      expect(await reconcileLinuxJob(ledger, authority, job, stateRoot)).toBe(true)
      const settled = ledger.get(job.id)!
      expect(settled.result).toMatchObject({ status: 'unknown', quiescent: true })
      expect(settled.reservedDurationMs).toBe(60_000)
      expect(ledger.prepare(input)).toMatchObject({ created: false, job: { id: job.id } })
      expect(() => ledger.prepare({ ...input, idempotencyKey: 'two' })).toThrow()
    } finally {
      ledger.close()
      if (ctx) await dispose(ctx)
      else await rm(stateRoot, { recursive: true, force: true })
    }
  }, 90_000)

  test('freezes mapping and system snapshot, accounts private identity mount and rejects mixed versions', async () => {
    const configured = await contract(), ctx = await fixture(configured)
    try {
      const checked = validateLinuxExecutionContract(configured)
      expect(Object.isFrozen(checked)).toBe(true)
      const { implementationDigest: _implementation, userNamespace: _mapping, systemSnapshot: _snapshot, ...legacy } = configured
      const v2 = { ...legacy, schemaVersion: 2 as const }
      const modern = linuxJobResourceReservation(configured), old = linuxJobResourceReservation(v2)
      expect(modern.memoryMiB - old.memoryMiB).toBe(8)
      expect(modern.workspaceInodes - old.workspaceInodes).toBe(16384)
      expect(modern.storageBytes).toBe(old.storageBytes)
      expect(() => validateLinuxExecutionIntent(ctx.intent, v2)).toThrow()
      expect(() => validateLinuxExecutionContract({ ...configured, schemaVersion: 2 })).toThrow()
      expect(() => validateLinuxExecutionIntent({ ...ctx.intent, schemaVersion: 2 }, configured)).toThrow()
      expect(ctx.intent.contractDigest).toBe(linuxExecutionContractDigest(configured))
      await runLinuxRepositoryExecution({ ...ctx, signal: AbortSignal.abort(), recordResources: async () => {}, authorizeStart: () => false })
    } finally { await dispose(ctx) }
  }, 90_000)

  test('persists namespace and dropped entry before START, exports binary only after proof and never replays', async () => {
    const ctx = await fixture(), recorded: LinuxExecutionResources[] = []
    try {
      const outcome = await runLinuxRepositoryExecution({ ...ctx, signal: new AbortController().signal,
        recordResources: async resources => {
          recorded.push(resources)
          expect(resources).toMatchObject({ schemaVersion: 2, userNamespace: { witness: { mapping: ctx.contract.userNamespace } } })
          expect(await journal(ctx)).toMatchObject({ phase: 'user-namespace-ready', candidateIdentity: null })
        }, authorizeStart: async () => {
          const saved = await journal(ctx)
          expect(saved).toMatchObject({ phase: 'candidate-ready', candidateIdentity: { uid: ctx.contract.userNamespace.candidateUid,
            gid: ctx.contract.userNamespace.candidateGid, groups: [], capabilities: '0', noNewPrivileges: true, seccomp: 2 } })
          for (const root of Object.values(saved.worker.directories) as { path: string }[]) {
            expect((await readFile(join(root.path, 'cgroup.procs'), 'utf8')).trim().split('\n')).toContain(String(saved.candidateIdentity.pid))
          }
          expect((await readFile(`/proc/${saved.candidateIdentity.pid}/cmdline`, 'utf8'))).toContain('/dsh-candidate-entry.py')
          return true
        } })
      expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({ status: 'succeeded', quiescent: true, stdout: 'identity-built' })
      expect(recorded).toHaveLength(1)
      expect(outcome.resources).toEqual(recorded[0])
      expect(outcome.artifacts[0]?.bytes.equals(ctx.archive.bytes)).toBe(true)
      expect(outcome.receipt).toMatchObject({ schemaVersion: 3, resources: { schemaVersion: 2 } })
      expect(linuxExecutionReceiptBinding(outcome.receipt!)).toMatchObject({ requestDigest: ctx.intent.requestDigest })
      expect((await readLinuxRepositoryReceipt(ctx))!.receipt).toEqual(outcome.receipt)
      expect((await runLinuxRepositoryExecution({ ...ctx, signal: new AbortController().signal,
        recordResources: async () => { throw new Error('replay') }, authorizeStart: () => { throw new Error('replay') } })).receipt).toEqual(outcome.receipt)
      await absent(ctx)
      await evidence('normal', { intent: ctx.intent, resources: outcome.resources, journal: await journal(ctx), receipt: outcome.receipt })
    } finally { await dispose(ctx) }
  }, 90_000)

  test.each(['mapping', 'snapshot', 'implementation', 'cancel'] as const)('rejects %s before any resource callback or candidate admission', async kind => {
    const configured = await contract()
    if (kind === 'mapping') configured.userNamespace = { ...configured.userNamespace, helpers: { ...configured.userNamespace.helpers,
      uid: { path: '/usr/bin/newuidmap', sha256: '0'.repeat(64) } } }
    if (kind === 'snapshot') configured.systemSnapshot = { ...configured.systemSnapshot, manifestSha256: '0'.repeat(64) }
    if (kind === 'implementation') configured.implementationDigest = '0'.repeat(64)
    const ctx = await fixture(configured)
    let records = 0, starts = 0
    try {
      const outcome = await runLinuxRepositoryExecution({ ...ctx, signal: kind === 'cancel' ? AbortSignal.abort() : new AbortController().signal,
        recordResources: async () => { records++ }, authorizeStart: () => { starts++; return true } })
      expect(outcome.result.status).not.toBe('succeeded')
      expect(outcome.result.quiescent).toBe(true)
      expect(outcome.partialProof).toBeDefined()
      expect(records).toBe(0); expect(starts).toBe(0)
      expect(await readdir(join(ctx.stateRoot, 'namespaces'))).toEqual([])
    } finally { await dispose(ctx) }
  }, 90_000)

  test.each(['recorded', 'user-namespace-ready', 'candidate-ready'] as const)('a failed %s journal rename never grants candidate exec and preserves a readable negative receipt', async phase => {
    const ctx = await fixture()
    let starts = 0, records = 0
    try {
      Object.assign(fault, { journal: journalPath(ctx), phase, fired: false })
      const outcome = await runLinuxRepositoryExecution({ ...ctx, signal: new AbortController().signal,
        recordResources: async () => { records++ }, authorizeStart: () => { starts++; return true } })
      expect(fault.fired).toBe(true)
      expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({ status: 'unknown', quiescent: true, stdout: '' })
      expect(starts).toBe(0)
      expect(records).toBe(phase === 'candidate-ready' ? 1 : 0)
      expect(outcome.receipt).toBeDefined()
      expect(outcome.resources).toMatchObject({ schemaVersion: 2, userNamespace: phase === 'recorded' ? null : expect.any(Object) })
      expect((await readLinuxRepositoryReceipt(ctx))!.receipt).toEqual(outcome.receipt)
      await evidence('journal-failure', { phase, receipt: outcome.receipt, journal: await journal(ctx) })
    } finally { await dispose(ctx) }
  }, 90_000)

  test('lost resource acknowledgement retains the anchor, prohibits START, and is recovery-only', async () => {
    const ctx = await fixture(), recorded: LinuxExecutionResources[] = []
    let starts = 0
    try {
      const outcome = await runLinuxRepositoryExecution({ ...ctx, signal: new AbortController().signal,
        recordResources: async resources => { recorded.push(resources); throw new Error('lost resources ACK') },
        authorizeStart: () => { starts++; return true } })
      expect(outcome.result, JSON.stringify(outcome.result)).toMatchObject({ status: 'unknown', quiescent: true, stdout: '' })
      expect(recorded).toHaveLength(1); expect(starts).toBe(0)
      expect(outcome.resources).toEqual(recorded[0])
      expect((await reconcileLinuxRepositoryExecution(ctx)).receipt).toEqual(outcome.receipt)
      expect((await run(ctx)).result.status).toBe('unknown')
    } finally { await dispose(ctx) }
  }, 90_000)

  test.each(['revoke', 'cancel', 'pipe', 'keeper-death'] as const)('closes the dropped entry gate on %s without candidate code', async mode => {
    const ctx = await fixture(), controller = new AbortController()
    try {
      const outcome = await runLinuxRepositoryExecution({ ...ctx, signal: controller.signal, recordResources: async () => {},
        authorizeStart: async () => {
          expect((await journal(ctx)).phase).toBe('candidate-ready')
          if (mode === 'cancel') controller.abort()
          if (mode === 'pipe') { expect(fault.keeper?.stdin).toBeDefined(); fault.keeper!.stdin!.end(); await pause(20) }
          if (mode === 'keeper-death') { expect(fault.keeper?.pid).toBeDefined(); fault.keeper!.kill('SIGKILL'); await pause(20) }
          return mode !== 'revoke'
        } })
      expect(outcome.result.status).not.toBe('succeeded')
      expect(outcome.result.quiescent, JSON.stringify(outcome.result)).toBe(true)
      expect(outcome.result.stdout).toBe('')
      expect(outcome.artifacts).toEqual([])
      expect((await readLinuxRepositoryReceipt(ctx))!.receipt).toEqual(outcome.receipt)
    } finally { await dispose(ctx) }
  }, 90_000)

  test('rejects mismatched frozen mapping, namespace and candidate witnesses in private evidence', async () => {
    const ctx = await fixture()
    try {
      await run(ctx)
      const original = await readFile(journalPath(ctx), 'utf8'), saved = JSON.parse(original)
      for (const changed of [
        { ...saved, userNamespace: { ...saved.userNamespace, mapping: { ...saved.userNamespace.mapping, candidateUid: saved.userNamespace.mapping.candidateUid + 1 } } },
        { ...saved, userNamespace: { ...saved.userNamespace, namespace: { ...saved.userNamespace.namespace, ino: saved.userNamespace.namespace.ino + 1 } } },
        { ...saved, candidateIdentity: { ...saved.candidateIdentity, uid: uid } },
        { ...saved, candidateIdentity: null },
      ]) {
        await writeFile(journalPath(ctx), JSON.stringify(changed))
        await expect(readLinuxRepositoryReceipt(ctx)).rejects.toThrow()
        await expect(reconcileLinuxRepositoryExecution(ctx)).rejects.toThrow()
      }
      await writeFile(journalPath(ctx), original)
      expect((await readLinuxRepositoryReceipt(ctx))!.receipt.result.status).toBe('succeeded')
    } finally { await dispose(ctx) }
  }, 90_000)

  test('foreign job, anchor and mapping proofs cannot signal either blocked candidate', async () => {
    const configured = await contract(), first = await fixture(configured), second = await fixture(configured)
    const controller = new AbortController()
    let release: () => void = () => {}
    const blocked = new Promise<void>(resolveBlocked => { release = resolveBlocked })
    const pending = [first, second].map(ctx => runLinuxRepositoryExecution({ ...ctx, signal: controller.signal,
      recordResources: async () => {}, authorizeStart: async () => { await blocked; return true } }))
    try {
      let left: Record<string, any> | undefined, right: Record<string, any> | undefined
      for (const deadline = Date.now() + 45_000; Date.now() < deadline;) {
        left = await journal(first); right = await journal(second)
        if (left.phase === 'candidate-ready' && right.phase === 'candidate-ready') break
        await pause(50)
      }
      expect(left?.phase).toBe('candidate-ready'); expect(right?.phase).toBe('candidate-ready')
      const witness = left!.userNamespace
      for (const changed of [right!.userNamespace,
        { ...witness, namespace: { ...witness.namespace, ino: witness.namespace.ino + 1 } },
        { ...witness, mapping: { ...witness.mapping, candidateUid: witness.mapping.candidateUid + 1 } },
      ]) {
        const lease = await LinuxCgroupLease.recover(left!.worker, { witness: changed })
        await expect(lease.terminateAndProve(3000)).rejects.toThrow()
        const current = (await readFile(join(left!.worker.directories.freezer.path, 'cgroup.procs'), 'utf8')).trim().split('\n')
        expect(current).toContain(String(left!.candidateIdentity.pid))
        expect((await readFile(`/proc/${right!.candidateIdentity.pid}/cmdline`, 'utf8'))).toContain('/dsh-candidate-entry.py')
      }
      await evidence('foreign-proof-rejected', { first: left, second: right })
    } finally {
      controller.abort(); release()
      for (const outcome of await Promise.all(pending)) expect(outcome.result).toMatchObject({ status: 'cancelled', quiescent: true, stdout: '' })
      await dispose(first); await dispose(second)
    }
  }, 90_000)

  test('eligible mapped recovery preserves live entry and original journal on implementation drift', async () => {
    const configured = await contract(), stateRoot = await mkdtemp(join(tmpdir(), 'dsh-identity-drift-'))
    const entry = pathToFileURL(join(import.meta.dirname, '../src/linux-execution.ts')).href
    const script = `import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){try{return next(specifier,context)}catch(error){if(specifier.startsWith('.')&&specifier.endsWith('.js'))return next(specifier.slice(0,-3)+'.ts',context);throw error}}});
const {prepareLinuxRepositoryIntent}=await import(${JSON.stringify(entry)});
const {writeFile}=await import('node:fs/promises');const {randomUUID,randomBytes,createHash}=await import('node:crypto');
const stateRoot=${JSON.stringify(stateRoot)},contract=${JSON.stringify(configured)},id=randomUUID();
const request={argv:['/bin/true'],archive:{bytes:Buffer.from('source'),sha256:createHash('sha256').update('source').digest('hex')},artifacts:[]};
const intent=await prepareLinuxRepositoryIntent({stateRoot,contract,...request,job:{id,requestDigest:'b'.repeat(64),nativeResourceId:'linux-'+id,nativeNonce:randomBytes(16).toString('hex'),deadline:Date.now()+60000}});
await writeFile(stateRoot+'/context.json',JSON.stringify({stateRoot,contract,intent}),{mode:0o600});`
    const creator = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostic = ''
    creator.stderr!.on('data', chunk => { diagnostic += String(chunk) })
    const exit = await new Promise<number | null>(resolveExit => { creator.once('close', resolveExit) })
    expect(exit, diagnostic).toBe(0)
    const ctx = JSON.parse(await readFile(join(stateRoot, 'context.json'), 'utf8')) as LinuxRepositoryExecutionContext
    const saved = await journal(ctx)
    await expect(lstat(`/proc/${saved.creator.pid}`)).rejects.toMatchObject({ code: 'ENOENT' })
    const create = (keeper: boolean) => LinuxCgroupLease.create({ roots: configured.cgroupRoots, jobId: ctx.intent.jobId,
      nonce: keeper ? ctx.intent.keeperNonce : ctx.intent.workerNonce, deadline: ctx.intent.deadline,
      limits: keeper ? configured.keeperLimits : { memoryMiB: configured.limits.memoryMiB, pidsLimit: configured.limits.pidsLimit, cpus: configured.limits.cpus } })
    const worker = await create(false), keeper = await create(true)
    saved.worker = worker.snapshot; saved.keeper = keeper.snapshot; saved.phase = 'recorded'
    const persist = async () => { await writeFile(journalPath(ctx), JSON.stringify(saved)) }
    await persist()
    const controller = new AbortController()
    let release: () => void = () => {}, ready: (identity: LinuxCandidateIdentity) => void = () => {}
    const blocked = new Promise<void>(resolveBlocked => { release = resolveBlocked })
    const admitted = new Promise<LinuxCandidateIdentity>(resolveReady => { ready = resolveReady })
    const bytes = Buffer.from('source')
    // The real creator is dead and this primitive has no engine active-run entry.
    // Kernel witnesses are persisted by trusted fixture code, making recovery
    // eligible while the actual subordinate entry remains blocked before exec.
    const running = runLinuxRepositoryNamespace({ stateRoot: join(stateRoot, 'namespaces'),
      namespaceId: `${ctx.intent.jobId}-${ctx.intent.nativeNonce}`, userNamespace: configured.userNamespace,
      systemSnapshot: configured.systemSnapshot, argv: ['/bin/true'], archive: { bytes, sha256: sha(bytes) }, artifacts: [],
      workspaceBytes: 8 * 1024 ** 2, workspaceInodes: 256, tmpBytes: 8 * 1024 ** 2, tmpInodes: 128,
      timeoutMs: 45_000, maxOutputBytes: 4096, signal: controller.signal,
      beforeKeeperStart: async identity => {
        const info = await lstat(ctx.intent.namespacePath)
        saved.namespace = { path: ctx.intent.namespacePath, dev: info.dev, ino: info.ino }
        saved.keeperIdentity = { ...identity, startTicks: String(identity.startTicks), uid, bootId: ctx.intent.bootId }
        await keeper.admit(saved.keeperIdentity); saved.phase = 'keeper-admitted'; await persist()
      }, onUserNamespaceReady: async identity => {
        saved.userNamespace = await inspectLinuxUserNamespace(configured.userNamespace, identity)
        worker.bindUserNamespace({ witness: saved.userNamespace })
        keeper.bindUserNamespace({ witness: saved.userNamespace, outsideGate: saved.keeperIdentity })
        saved.phase = 'user-namespace-ready'; await persist()
      }, beforeStart: async identity => {
        saved.workerIdentity = { ...identity, startTicks: String(identity.startTicks), uid, bootId: ctx.intent.bootId }
        await worker.admit(saved.workerIdentity); saved.phase = 'worker-admitted'; await persist()
      }, beforeCandidateExec: async identity => {
        saved.candidateIdentity = await inspectLinuxRepositoryCandidate(saved.userNamespace, identity)
        saved.phase = 'unknown'; saved.result = { jobId: ctx.intent.jobId, status: 'unknown', quiescent: false,
          stdout: 'original orphan output', stderr: '', artifacts: [], reason: 'original orphan uncertainty' }
        await persist(); ready(identity); await blocked
      }, afterExit: () => { throw new Error('candidate must never receive exec ACK') }, onStop: () => {},
    })
    try {
      const identity = await Promise.race([admitted, running.then(value => { throw new Error(`entry not reached: ${JSON.stringify(value)}`) })])
      const originalJournal = await readFile(journalPath(ctx), 'utf8')
      fault.implementationDigest = '0'.repeat(64)
      const cleanupSpy = vi.spyOn(LinuxCgroupLease.prototype, 'terminateAndProve'), recoverSpy = vi.spyOn(LinuxCgroupLease, 'recover')
      let denied: Awaited<ReturnType<typeof reconcileLinuxRepositoryExecution>>
      try {
        denied = await reconcileLinuxRepositoryExecution(ctx)
        expect(recoverSpy).not.toHaveBeenCalled(); expect(cleanupSpy).not.toHaveBeenCalled()
      } finally { cleanupSpy.mockRestore(); recoverSpy.mockRestore() }
      expect(denied).toMatchObject({ quiescent: false, artifacts: [] }); expect(denied.receipt).toBeUndefined()
      expect(await readFile(journalPath(ctx), 'utf8')).toBe(originalJournal)
      expect(await inspectLinuxRepositoryCandidate(saved.userNamespace, identity)).toEqual(saved.candidateIdentity)
      for (const lease of [worker, keeper]) for (const directory of Object.values(lease.snapshot.directories)) {
        expect((await lstat(directory.path)).isDirectory()).toBe(true)
      }
      expect((await worker.observe()).quiescent).toBe(false)
      fault.implementationDigest = ''
      const firstCleanup = await reconcileLinuxRepositoryExecution(ctx)
      release(); await running
      const recovered = firstCleanup.quiescent ? firstCleanup : await reconcileLinuxRepositoryExecution(ctx)
      expect(recovered).toMatchObject({ quiescent: true, receipt: { result: { status: 'unknown' } } })
      fault.implementationDigest = '0'.repeat(64)
      expect((await readLinuxRepositoryReceipt(ctx))!.receipt).toEqual(recovered.receipt)
      expect((await reconcileLinuxRepositoryExecution(ctx)).receipt).toEqual(recovered.receipt)
      fault.implementationDigest = ''
      await absent(ctx)
      await evidence('eligible-drift-fence', { intent: ctx.intent, originalJournal: JSON.parse(originalJournal), denied, recovered })
    } finally {
      fault.implementationDigest = ''; controller.abort(); release(); await running
      await dispose(ctx)
    }
  }, 90_000)

  test('Host SIGKILL recovery kills subordinate setsid and nested userns descendants using original proof without replay', async () => {
    const configured = await contract(), stateRoot = await mkdtemp(join(tmpdir(), 'dsh-identity-crash-'))
    const entry = pathToFileURL(join(import.meta.dirname, '../src/linux-execution.ts')).href
    const command = `import os,subprocess,time
subprocess.Popen(['/usr/bin/setsid','/bin/sh','-c','sleep 60 & wait'])
subprocess.Popen(['/usr/bin/bwrap','--unshare-all','--uid','0','--gid','0','--ro-bind','/','/','--proc','/proc','--dev','/dev','/bin/sh','-c','sleep 60 & wait'])
time.sleep(60)`
    const script = `import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){try{return next(specifier,context)}catch(error){if(specifier.startsWith('.')&&specifier.endsWith('.js'))return next(specifier.slice(0,-3)+'.ts',context);throw error}}});
const {prepareLinuxRepositoryIntent,runLinuxRepositoryExecution}=await import(${JSON.stringify(entry)});
const {writeFile,appendFile}=await import('node:fs/promises');const {randomUUID,randomBytes,createHash}=await import('node:crypto');
const stateRoot=${JSON.stringify(stateRoot)},contract=${JSON.stringify(configured)},id=randomUUID();
const request={argv:['/usr/bin/python3','-I','-S','-c',${JSON.stringify(command)}],archive:{bytes:Buffer.from('source'),sha256:createHash('sha256').update('source').digest('hex')},artifacts:[]};
const intent=await prepareLinuxRepositoryIntent({stateRoot,contract,...request,job:{id,requestDigest:'b'.repeat(64),nativeResourceId:'linux-'+id,nativeNonce:randomBytes(16).toString('hex'),deadline:Date.now()+60000}});
await writeFile(stateRoot+'/context.json',JSON.stringify({stateRoot,contract,intent}),{mode:0o600});
await runLinuxRepositoryExecution({stateRoot,contract,intent,...request,signal:new AbortController().signal,recordResources:async()=>{},authorizeStart:async()=>{await appendFile(stateRoot+'/starts','START\\n',{mode:0o600});return true}});`
    const host = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostic = '', ctx: LinuxRepositoryExecutionContext | undefined
    host.stderr!.on('data', chunk => { diagnostic += String(chunk) })
    try {
      let members: string[] = [], saved: Record<string, any> | undefined
      for (const deadline = Date.now() + 45_000; Date.now() < deadline;) {
        try {
          ctx = JSON.parse(await readFile(join(stateRoot, 'context.json'), 'utf8'))
          saved = await journal(ctx!)
          if (saved.phase === 'running') {
            members = (await readFile(join(saved.worker.directories.freezer.path, 'cgroup.procs'), 'utf8')).trim().split('\n')
            if (members.length >= 7) break
          }
        } catch { /* Await the actual independent gates and descendants. */ }
        await pause(50)
      }
      expect(saved?.phase, diagnostic).toBe('running')
      expect(members.length, diagnostic).toBeGreaterThanOrEqual(7)
      const statuses = await Promise.all(members.map(pid => readFile(`/proc/${pid}/status`, 'utf8')))
      expect(statuses.filter(status => new RegExp(`^Uid:\\s+${configured.userNamespace.candidateUid}\\s`, 'mu').test(status)).length).toBeGreaterThanOrEqual(5)
      expect(statuses.some(status => /^NSpid:\s+\d+\s+\d+\s+\d+/mu.test(status))).toBe(true)
      expect(await reconcileLinuxRepositoryExecution(ctx!)).toMatchObject({ quiescent: false })
      const closed = new Promise<void>(resolveClosed => { host.once('close', () => resolveClosed()) })
      host.kill('SIGKILL'); await closed
      const recovered = await reconcileLinuxRepositoryExecution(ctx!)
      expect(recovered, JSON.stringify(recovered)).toMatchObject({ quiescent: true, artifacts: [], receipt: { schemaVersion: 3, result: { status: 'unknown' } } })
      expect(await readFile(join(stateRoot, 'starts'), 'utf8')).toBe('START\n')
      expect((await reconcileLinuxRepositoryExecution(ctx!)).receipt).toEqual(recovered.receipt)
      await absent(ctx!)
      await evidence('host-death', { members, statuses, journal: saved, recovered })
    } finally {
      host.kill('SIGKILL')
      if (ctx) await dispose(ctx)
      else await rm(stateRoot, { recursive: true, force: true })
    }
  }, 90_000)
})
