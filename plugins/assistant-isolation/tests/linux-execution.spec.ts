import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { describe, expect, test, vi } from 'vitest'
import { LinuxCgroupLease } from '../src/linux-cgroups.js'
import { linuxExecutionReceiptBinding, prepareLinuxExecutionIntent, readLinuxExecutionReceipt, readLinuxExecutionPartialCleanupProof,
  reconcileLinuxExecution, runLinuxExecution } from '../src/linux-execution.js'
import { linuxExecutionIntentDigest, linuxExecutionResourcesDigest,
  type LinuxExecutionContract, type LinuxExecutionIntent, type LinuxExecutionResources } from '../src/linux-execution-contract.js'

// Fail only reads of this test's real kernel cgroup inventory. Recovery later
// reads the actual kernel again; no successful quiet/absence result is mocked.
const failedInventory = vi.hoisted(() => ({ path: '' }))
const failedPersistence = vi.hoisted(() => ({ path: '', stage: '', renamed: false, phase: '' }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: unknown[]) => {
    if (args[0] === failedPersistence.path && failedPersistence.stage === 'open' && typeof args[1] === 'number' && (args[1] & 64) !== 0) {
      throw Object.assign(new Error('injected receipt creation EIO'), { code: 'EIO' })
    }
    const handle = await Reflect.apply(actual.open, actual, args)
    if (failedPersistence.stage === 'sync' && failedPersistence.renamed && args[0] === failedPersistence.path.slice(0, failedPersistence.path.lastIndexOf('/'))) {
      handle.sync = async () => { throw Object.assign(new Error('injected directory fsync EIO'), { code: 'EIO' }) }
    }
    return handle
  }, rename: async (...args: unknown[]) => {
    const target = args[1] === failedPersistence.path && (!failedPersistence.phase
      || JSON.parse(await actual.readFile(String(args[0]), 'utf8')).phase === failedPersistence.phase)
    if (target && failedPersistence.stage === 'rename') throw Object.assign(new Error('injected receipt rename EIO'), { code: 'EIO' })
    const result = await Reflect.apply(actual.rename, actual, args)
    if (target && failedPersistence.stage === 'sync') failedPersistence.renamed = true
    return result
  }, readFile: async (...args: unknown[]) => {
    if (failedInventory.path && args[0] === failedInventory.path) throw Object.assign(new Error('injected inventory EIO'), { code: 'EIO' })
    return Reflect.apply(actual.readFile, actual, args)
  } }
})

const uid = process.getuid?.() ?? 0
const real = process.env.DSH_NATIVE_CGROUP_REAL === '1' && process.platform === 'linux' && uid > 0
const contract = (overrides: Partial<LinuxExecutionContract['limits']> = {}): LinuxExecutionContract => ({ schemaVersion: 1,
  backend: 'linux-native', runtimeDigest: 'a'.repeat(64), profile: 'ordinary',
  limits: { maxDurationMs: 5000, maxInputBytes: 4096, maxOutputBytes: 4096, maxArtifactBytes: 4096, maxFiles: 8,
    memoryMiB: 128, workspaceMiB: 4, workspaceInodes: 256, pidsLimit: 32, cpus: 0.5, ...overrides },
  keeperLimits: { memoryMiB: 128, pidsLimit: 48, cpus: 0.5 },
  cgroupRoots: { mode: 'v1', cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`,
    memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`, pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`,
    freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}` } })
async function fixture(limits: Partial<LinuxExecutionContract['limits']> = {}, root?: string) {
  const stateRoot = root ?? await mkdtemp(join(tmpdir(), 'dsh-linux-execution-'))
  const id = randomUUID(), configured = contract(limits)
  const job = { id, requestDigest: 'b'.repeat(64), nativeResourceId: `linux-${id}`,
    nativeNonce: randomBytes(16).toString('hex'), deadline: Date.now() + configured.limits.maxDurationMs }
  const intent = await prepareLinuxExecutionIntent({ stateRoot, contract: configured, job })
  return { stateRoot, contract: configured, intent, job }
}
const journalPath = (ctx: { stateRoot: string; intent: LinuxExecutionIntent }): string => join(ctx.stateRoot, 'jobs', `${ctx.intent.jobId}-${ctx.intent.nativeNonce}.json`)
async function absent(ctx: { intent: LinuxExecutionIntent }, complete: LinuxExecutionResources): Promise<void> {
  for (const snapshot of [complete.worker, complete.keeper]) for (const directory of Object.values(snapshot.directories)) {
    await expect(lstat(directory.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }
  await expect(lstat(ctx.intent.namespacePath)).rejects.toMatchObject({ code: 'ENOENT' })
}

// The real tests opt in explicitly; these are actual delegated kernel roots,
// never fake cgroup files or a success inferred from mocked process exits.
describe.skipIf(!real)('durable Linux execution with real cgroup v1', () => {
  test('journals before creating and requires both snapshots before admitting either gate', async () => {
    const ctx = await fixture()
    let recorded: LinuxExecutionResources | undefined
    try {
      expect(await reconcileLinuxExecution(ctx)).toEqual({ quiescent: false })
      expect((await readdir(join(ctx.stateRoot, 'namespaces')))).toEqual([])
      const outcome = await runLinuxExecution({ ...ctx, argv: ['/bin/sh', '-c', 'printf hello; printf saved > "中文 结果.txt"'],
        files: [], artifacts: ['中文 结果.txt'], signal: new AbortController().signal,
        recordResources: async value => {
          recorded = value
          const journal = JSON.parse(await readFile(journalPath(ctx), 'utf8'))
          expect(journal).toMatchObject({ phase: 'recorded', workerIdentity: null, keeperIdentity: null, namespace: null })
          expect(await readdir(join(ctx.stateRoot, 'namespaces'))).toEqual([])
        }, authorizeStart: () => { expect(recorded).toBeDefined(); return true } })
      expect(outcome.result).toMatchObject({ status: 'succeeded', quiescent: true, stdout: 'hello', artifacts: [{ path: '中文 结果.txt', content: 'saved' }] })
      expect(outcome.resources).toEqual(recorded)
      expect(outcome.receipt).toBeDefined()
      expect(linuxExecutionReceiptBinding(outcome.receipt!)).toMatchObject({ requestDigest: ctx.job.requestDigest,
        nativeNonce: ctx.job.nativeNonce, nativeResourceId: ctx.job.nativeResourceId,
        intentDigest: linuxExecutionIntentDigest(ctx.intent), resourcesDigest: linuxExecutionResourcesDigest(recorded!) })
      expect(await readLinuxExecutionReceipt(ctx)).toEqual(outcome.receipt)
      await absent(ctx, recorded!)
      await expect(runLinuxExecution({ ...ctx, argv: ['/usr/bin/true'], files: [], signal: new AbortController().signal,
        recordResources: async () => {}, authorizeStart: () => true })).rejects.toThrow('single-use')
    } finally { await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test.each(['output', 'artifact'] as const)('enforces finite %s and still proves both groups removed', async kind => {
    const ctx = await fixture({ maxOutputBytes: 3, maxArtifactBytes: 3 })
    try {
      const outcome = await runLinuxExecution({ ...ctx, argv: ['/bin/sh', '-c', kind === 'output' ? 'printf abcdef' : 'printf abcdef > report'],
        files: [], artifacts: kind === 'artifact' ? ['report'] : [], signal: new AbortController().signal,
        recordResources: async () => {}, authorizeStart: () => true })
      expect(outcome.result.status).not.toBe('succeeded')
      expect(outcome.result.quiescent).toBe(true)
      expect(outcome.result.artifacts).toEqual([])
      expect(outcome.receipt).toBeDefined()
      await absent(ctx, outcome.resources!)
    } finally { await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test.each(['cancelled', 'timed-out'] as const)('cleans entire trees on %s', async expected => {
    const ctx = await fixture({ maxDurationMs: expected === 'timed-out' ? 1400 : 5000 })
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = await runLinuxExecution({ ...ctx, argv: ['/bin/sh', '-c', 'sleep 30 & wait'], files: [], signal: controller.signal,
        recordResources: async () => {}, authorizeStart: () => {
          if (expected === 'cancelled') timer = setTimeout(() => controller.abort(), 100)
          return true
        } })
      expect(outcome.result).toMatchObject({ status: expected, quiescent: true })
      expect(outcome.receipt).toBeDefined()
      await absent(ctx, outcome.resources!)
    } finally { clearTimeout(timer); await rm(ctx.stateRoot, { recursive: true, force: true }) }
  }, 12_000)

  test('refuses dispatch when ledger persistence or final Host authorization fails', async () => {
    for (const failure of ['ledger', 'authorization']) {
      const ctx = await fixture()
      try {
        const outcome = await runLinuxExecution({ ...ctx, argv: ['/usr/bin/true'], files: [], signal: new AbortController().signal,
          recordResources: async () => { if (failure === 'ledger') throw new Error('ledger refused resources') }, authorizeStart: () => false })
        expect(outcome.result).toMatchObject({ status: 'unknown', quiescent: true })
        const journal = JSON.parse(await readFile(journalPath(ctx), 'utf8'))
        expect(journal.workerIdentity === null || failure === 'authorization').toBe(true)
        await absent(ctx, outcome.resources!)
      } finally { await rm(ctx.stateRoot, { recursive: true, force: true }) }
    }
  })

  test('bounds a stalled ledger callback and fences late Host start authorization after cancellation', async () => {
    for (const phase of ['ledger', 'start']) {
      const ctx = await fixture(), controller = new AbortController()
      let release: () => void = () => {}
      const blocked = new Promise<void>(resolveBlocked => { release = resolveBlocked })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const outcome = await runLinuxExecution({ ...ctx, argv: ['/usr/bin/true'], files: [], signal: controller.signal,
          recordResources: async () => {
            if (phase === 'ledger') { timer = setTimeout(() => controller.abort(), 50); await blocked }
          }, authorizeStart: async () => {
            timer = setTimeout(() => controller.abort(), 50); await blocked; return true
          } })
        expect(outcome.result).toMatchObject({ status: 'cancelled', quiescent: true })
        await absent(ctx, outcome.resources!)
        const journal = await readFile(journalPath(ctx), 'utf8')
        release(); await pause(40)
        expect(await readFile(journalPath(ctx), 'utf8')).toBe(journal)
      } finally { release(); clearTimeout(timer); await rm(ctx.stateRoot, { recursive: true, force: true }) }
    }
  })

  test('same Host can retry a terminal unknown cleanup after kernel inventory becomes readable', async () => {
    const ctx = await fixture()
    let complete: LinuxExecutionResources | undefined
    try {
      const outcome = await runLinuxExecution({ ...ctx, argv: ['/usr/bin/true'], files: [], signal: new AbortController().signal,
        recordResources: async value => { complete = value }, authorizeStart: () => {
          failedInventory.path = join(complete!.worker.directories.freezer!.path, 'cgroup.procs')
          return true
        } })
      expect(outcome.result).toMatchObject({ status: 'unknown', quiescent: false })
      expect(outcome.receipt).toBeUndefined()
      expect(JSON.parse(await readFile(journalPath(ctx), 'utf8'))).toMatchObject({ phase: 'unknown', result: { quiescent: false } })
      failedInventory.path = ''
      const competing = await Promise.all([reconcileLinuxExecution(ctx), reconcileLinuxExecution(ctx), reconcileLinuxExecution(ctx)])
      const recovered = competing.find(value => value.quiescent)!
      expect(recovered).toMatchObject({ quiescent: true, receipt: { result: { status: 'unknown', quiescent: true } } })
      expect(await readLinuxExecutionReceipt(ctx)).toEqual(recovered.receipt)
      expect(JSON.parse(await readFile(journalPath(ctx), 'utf8'))).toMatchObject({ phase: 'settled', result: { quiescent: true } })
      await absent(ctx, complete!)
    } finally { failedInventory.path = ''; await reconcileLinuxExecution(ctx); await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test.each(['missing', 'placeholder'] as const)('reissues an unknown cleanup receipt after interrupted %s receipt persistence', async interruption => {
    const ctx = await fixture()
    try {
      const path = join(ctx.stateRoot, 'receipts', `${ctx.intent.jobId}-${ctx.intent.nativeNonce}.json`)
      failedPersistence.path = path; failedPersistence.stage = interruption === 'missing' ? 'open' : 'rename'
      await expect(runLinuxExecution({ ...ctx, argv: ['/bin/sh', '-c', 'printf original'], files: [], signal: new AbortController().signal,
        recordResources: async () => {}, authorizeStart: () => true })).rejects.toThrow('injected receipt')
      failedPersistence.path = ''; failedPersistence.stage = ''
      const journal = JSON.parse(await readFile(journalPath(ctx), 'utf8'))
      expect(journal).toMatchObject({ phase: 'settled', result: { status: 'succeeded', stdout: 'original' } })
      if (interruption === 'placeholder') expect((await lstat(path)).size).toBe(0)
      else await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readLinuxExecutionReceipt(ctx)).toBeUndefined()
      const recovered = await reconcileLinuxExecution(ctx)
      expect(recovered).toMatchObject({ quiescent: true, receipt: { result: { status: 'unknown', stdout: '', quiescent: true } } })
      expect(await readLinuxExecutionReceipt(ctx)).toEqual(recovered.receipt)
      await absent(ctx, recovered.resources!)
    } finally { failedPersistence.path = ''; failedPersistence.stage = ''; await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test('repairs a private partial-proof placeholder without treating nonempty corruption as proof', async () => {
    const ctx = await fixture(), controller = new AbortController()
    controller.abort()
    try {
      const path = join(ctx.stateRoot, 'receipts', `${ctx.intent.jobId}-${ctx.intent.nativeNonce}.partial.json`)
      failedPersistence.path = path; failedPersistence.stage = 'rename'
      await expect(runLinuxExecution({ ...ctx, argv: ['/usr/bin/true'], files: [], signal: controller.signal,
        recordResources: async () => {}, authorizeStart: () => false })).rejects.toThrow('injected receipt rename')
      failedPersistence.path = ''; failedPersistence.stage = ''
      const recovered = await reconcileLinuxExecution(ctx)
      expect(recovered).toMatchObject({ quiescent: true, partialProof: { workerAbsent: true } })
      await writeFile(path, 'corrupt')
      await expect(reconcileLinuxExecution(ctx)).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe('corrupt')
    } finally { failedPersistence.path = ''; failedPersistence.stage = ''; await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test.each([
    ['full', 'rename'], ['full', 'sync'], ['partial', 'rename'], ['partial', 'sync'],
  ])('same Host drain witness recovers first %s terminal journal %s failure', async (kind, stage) => {
    const ctx = await fixture(), controller = new AbortController()
    if (kind === 'partial') controller.abort()
    try {
      failedPersistence.path = journalPath(ctx); failedPersistence.stage = stage!; failedPersistence.renamed = false
      failedPersistence.phase = kind === 'partial' ? 'prestart-quiesced' : 'settled'
      await expect(runLinuxExecution({ ...ctx, argv: ['/usr/bin/true'], files: [], signal: controller.signal,
        recordResources: async () => {}, authorizeStart: () => true })).rejects.toThrow('injected')
      failedPersistence.path = ''; failedPersistence.stage = ''; failedPersistence.phase = ''; failedPersistence.renamed = false
      const journal = JSON.parse(await readFile(journalPath(ctx), 'utf8'))
      expect(journal.phase).toBe(stage === 'rename' ? kind === 'partial' ? 'prepared' : 'running' : kind === 'partial' ? 'prestart-quiesced' : 'settled')
      await expect(runLinuxExecution({ ...ctx, argv: ['/usr/bin/true'], files: [], signal: new AbortController().signal,
        recordResources: async () => {}, authorizeStart: () => true })).rejects.toThrow('single-use')
      const recovered = await reconcileLinuxExecution(ctx)
      expect(recovered.quiescent).toBe(true)
      if (kind === 'partial') expect(recovered.partialProof).toBeDefined()
      else expect(recovered.receipt).toMatchObject({ result: { status: 'unknown', quiescent: true } })
    } finally { failedPersistence.path = ''; failedPersistence.stage = ''; failedPersistence.phase = ''; failedPersistence.renamed = false; await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test.each([
    ['full', 'journal', 'rename'], ['full', 'journal', 'sync'], ['full', 'receipt', 'rename'], ['full', 'receipt', 'sync'],
    ['partial', 'journal', 'rename'], ['partial', 'journal', 'sync'], ['partial', 'receipt', 'rename'], ['partial', 'receipt', 'sync'],
  ])('retains recoverable terminal state after %s %s %s publication failure', async (kind, target, stage) => {
    const ctx = await fixture(), controller = new AbortController()
    if (kind === 'partial') controller.abort()
    const receipt = join(ctx.stateRoot, 'receipts', `${ctx.intent.jobId}-${ctx.intent.nativeNonce}${kind === 'partial' ? '.partial' : ''}.json`)
    try {
      // First stop at the actual initial receipt open, leaving a terminal
      // journal with no receipt, rather than fabricating a completed result.
      failedPersistence.path = receipt; failedPersistence.stage = 'open'; failedPersistence.renamed = false
      await expect(runLinuxExecution({ ...ctx, argv: ['/usr/bin/true'], files: [], signal: controller.signal,
        recordResources: async () => {}, authorizeStart: () => true })).rejects.toThrow('injected receipt creation')
      failedPersistence.path = target === 'journal' ? journalPath(ctx) : receipt
      failedPersistence.stage = stage!; failedPersistence.renamed = false
      expect((await reconcileLinuxExecution(ctx)).quiescent).toBe(false)
      failedPersistence.path = ''; failedPersistence.stage = ''; failedPersistence.renamed = false
      expect(JSON.parse(await readFile(journalPath(ctx), 'utf8')).phase).toBe(kind === 'partial' ? 'prestart-quiesced' : 'settled')
      const recovered = await reconcileLinuxExecution(ctx)
      expect(recovered.quiescent).toBe(true)
      if (kind === 'partial') expect(await readLinuxExecutionPartialCleanupProof(ctx)).toEqual(recovered.partialProof)
      else expect(await readLinuxExecutionReceipt(ctx)).toEqual(recovered.receipt)
    } finally { failedPersistence.path = ''; failedPersistence.stage = ''; failedPersistence.renamed = false; await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test('rejects receipt output tampering and checks actual resource absence on every receipt read', async () => {
    const ctx = await fixture()
    let replacement: LinuxCgroupLease | undefined
    try {
      const outcome = await runLinuxExecution({ ...ctx, argv: ['/usr/bin/true'], files: [], signal: new AbortController().signal,
        recordResources: async () => {}, authorizeStart: () => true })
      const path = join(ctx.stateRoot, 'receipts', `${ctx.intent.jobId}-${ctx.intent.nativeNonce}.json`)
      const original = await readFile(path, 'utf8'), changed = JSON.parse(original)
      changed.result.stdout = 'forged'
      await writeFile(path, JSON.stringify(changed))
      await expect(readLinuxExecutionReceipt(ctx)).rejects.toThrow('receipt content differs')
      await writeFile(path, original)
      replacement = await LinuxCgroupLease.create({ roots: ctx.contract.cgroupRoots, jobId: ctx.intent.jobId,
        nonce: ctx.intent.workerNonce, limits: outcome.resources!.worker.limits, deadline: ctx.intent.deadline })
      await expect(readLinuxExecutionReceipt(ctx)).rejects.toThrow('resources still present')
    } finally {
      if (replacement) { await replacement.terminateAndProve(1000); await replacement.removeWhenEmpty() }
      await rm(ctx.stateRoot, { recursive: true, force: true })
    }
  })

  test('rejects private-record links, permission drift, extra fields, nonce and root identity tampering', async () => {
    const ctx = await fixture(), path = journalPath(ctx), original = await readFile(path)
    try {
      await chmod(path, 0o644)
      await expect(reconcileLinuxExecution(ctx)).rejects.toThrow('private record identity')
      await chmod(path, 0o600)
      await link(path, `${path}.linked`)
      await expect(reconcileLinuxExecution(ctx)).rejects.toThrow('private record identity')
      await unlink(`${path}.linked`)
      await unlink(path); await symlink('/etc/passwd', path)
      await expect(reconcileLinuxExecution(ctx)).rejects.toThrow()
      await unlink(path); await writeFile(path, original, { mode: 0o600 })
      const journal = JSON.parse(original.toString('utf8'))
      await writeFile(path, JSON.stringify({ ...journal, unexpected: true }))
      await expect(reconcileLinuxExecution(ctx)).rejects.toThrow('fields differ')
      await writeFile(path, original)
      await expect(reconcileLinuxExecution({ ...ctx, intent: { ...ctx.intent, workerNonce: 'f'.repeat(32) } })).rejects.toThrow('journal intent')
      const roots = structuredClone(ctx.intent.roots)
      roots.cpu!.ino++
      await expect(reconcileLinuxExecution({ ...ctx, intent: { ...ctx.intent, roots } })).rejects.toThrow('root changed')
    } finally { await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test('rejects state overlap, exceeded input and v2 before dispatch', async () => {
    for (const failure of ['input', 'overlap', 'runtime-drift']) {
      const ctx = await fixture({ maxInputBytes: 1 })
      try {
        await expect(prepareLinuxExecutionIntent({ ...ctx, contract: { ...ctx.contract, cgroupRoots: { mode: 'v2', unified: `/sys/fs/cgroup/dsh-native/uid-${uid}` } } })).rejects.toThrow('v2')
        for (const limits of [{ workspaceMiB: 4097 }, { maxDurationMs: 1_800_001 }]) {
          await expect(prepareLinuxExecutionIntent({ ...ctx, contract: { ...ctx.contract, limits: { ...ctx.contract.limits, ...limits } } })).rejects.toThrow('namespace limits')
        }
        const outcome = await runLinuxExecution({ ...ctx, argv: ['/usr/bin/true'], files: failure === 'input' ? [{ path: 'x', content: 'xx' }] : [],
          readOnlyRoots: failure === 'overlap' ? [ctx.stateRoot] : failure === 'runtime-drift' ? [join(ctx.stateRoot, 'missing-runtime')] : [],
          signal: new AbortController().signal, recordResources: async () => { throw new Error('must not admit') }, authorizeStart: () => false })
        expect(outcome.result).toMatchObject({ status: 'unknown', quiescent: true })
        expect(outcome.resources).toBeUndefined()
        expect(outcome.partialProof).toBeDefined()
        expect((JSON.parse(await readFile(journalPath(ctx), 'utf8'))).phase).toBe('prestart-quiesced')
        expect(await reconcileLinuxExecution(ctx)).toEqual({ quiescent: true, partialProof: outcome.partialProof })
      } finally { await rm(ctx.stateRoot, { recursive: true, force: true }) }
    }
  })

  test('persists a prestart cleanup proof readable while its creating Host is still alive', async () => {
    const ctx = await fixture(), controller = new AbortController()
    controller.abort()
    try {
      const outcome = await runLinuxExecution({ ...ctx, argv: ['/usr/bin/true'], files: [], signal: controller.signal,
        recordResources: async () => { throw new Error('must not record resources') }, authorizeStart: () => { throw new Error('must not dispatch') } })
      expect(outcome.result).toMatchObject({ status: 'cancelled', quiescent: true })
      expect(outcome.resources).toBeUndefined()
      expect(outcome.partialProof).toMatchObject({ jobId: ctx.job.id, requestDigest: ctx.job.requestDigest,
        intentDigest: linuxExecutionIntentDigest(ctx.intent), workerAbsent: true, keeperAbsent: true, namespaceAbsent: true })
      expect(await readLinuxExecutionPartialCleanupProof(ctx)).toEqual(outcome.partialProof)
      expect(await reconcileLinuxExecution(ctx)).toEqual({ quiescent: true, partialProof: outcome.partialProof })
      expect((JSON.parse(await readFile(journalPath(ctx), 'utf8'))).phase).toBe('prestart-quiesced')
    } finally { await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test.each([false, true])('missing-snapshot recovery only deletes empty groups (live=%s)', async populated => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-linux-execution-partial-'))
    const entry = pathToFileURL(join(import.meta.dirname, '../src/linux-execution.ts')).href
    const cgroupEntry = pathToFileURL(join(import.meta.dirname, '../src/linux-cgroups.ts')).href
    const script = `import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){try{return next(specifier,context)}catch(error){if(specifier.startsWith('.')&&specifier.endsWith('.js'))return next(specifier.slice(0,-3)+'.ts',context);throw error}}});
const {prepareLinuxExecutionIntent}=await import(${JSON.stringify(entry)});
const {LinuxCgroupLease}=await import(${JSON.stringify(cgroupEntry)});
const {readFile,writeFile}=await import('node:fs/promises');
const {randomUUID,randomBytes}=await import('node:crypto');
const {spawn}=await import('node:child_process');
const stateRoot=${JSON.stringify(stateRoot)},contract=${JSON.stringify(contract({ maxDurationMs: 20_000 }))};
const id=randomUUID(),job={id,requestDigest:'b'.repeat(64),nativeResourceId:'linux-'+id,nativeNonce:randomBytes(16).toString('hex'),deadline:Date.now()+20000};
const intent=await prepareLinuxExecutionIntent({stateRoot,contract,job});
const lease=await LinuxCgroupLease.create({roots:contract.cgroupRoots,jobId:id,nonce:intent.workerNonce,limits:{memoryMiB:contract.limits.memoryMiB,pidsLimit:contract.limits.pidsLimit,cpus:contract.limits.cpus},deadline:intent.deadline});
let pid;
if(${populated}){const child=spawn('/usr/bin/python3',['-I','-S','-c','import time;time.sleep(30)'],{stdio:'ignore'});pid=child.pid;
const stat=await readFile('/proc/'+pid+'/stat','utf8');
await lease.admit({pid,startTicks:stat.slice(stat.lastIndexOf(') ')+2).trim().split(/\\s+/)[19],bootId:intent.bootId,uid:intent.uid});}
await writeFile(stateRoot+'/context.json',JSON.stringify({stateRoot,contract,intent,snapshot:lease.snapshot,pid}),{mode:0o600});
setInterval(()=>{},1000);`
    const host = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostic = ''; host.stderr.on('data', chunk => { diagnostic += String(chunk) })
    let ctx: Awaited<ReturnType<typeof fixture>> & { snapshot: LinuxExecutionResources['worker']; pid?: number } | undefined
    try {
      for (const deadline = Date.now() + 5000; Date.now() < deadline && !ctx;) {
        try { ctx = JSON.parse(await readFile(join(stateRoot, 'context.json'), 'utf8')) } catch { await pause(20) }
      }
      expect(ctx, diagnostic).toBeDefined()
      expect(await reconcileLinuxExecution(ctx!)).toEqual({ quiescent: false })
      const stopped = new Promise<void>(resolveStopped => host.once('close', () => resolveStopped()))
      host.kill('SIGKILL'); await stopped
      const outcome = await reconcileLinuxExecution(ctx!)
      if (populated) {
        expect(outcome).toEqual({ quiescent: false })
        expect(await readFile(`/proc/${ctx!.pid}/comm`, 'utf8')).toContain('python3')
        expect(await readLinuxExecutionPartialCleanupProof(ctx!)).toBeUndefined()
      } else {
        expect(outcome).toMatchObject({ quiescent: true, partialProof: { workerAbsent: true, keeperAbsent: true, namespaceAbsent: true } })
        expect(outcome.resources).toBeUndefined()
        expect(outcome.receipt).toBeUndefined()
        expect(await reconcileLinuxExecution(ctx!)).toEqual(outcome)
      }
    } finally {
      host.kill('SIGKILL')
      if (ctx) {
        const lease = await LinuxCgroupLease.recover(ctx.snapshot)
        expect(await lease.terminateAndProve(1000)).toBe(true)
        expect(await lease.removeWhenEmpty()).toBe(true)
      }
      await rm(stateRoot, { recursive: true, force: true })
    }
  }, 12_000)

  test('SIGKILL recovery cleans existing resources, retains unknown outcome and never starts a second command', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-linux-execution-crash-'))
    const entry = pathToFileURL(join(import.meta.dirname, '../src/linux-execution.ts')).href
    // Source-only child execution resolves local .js references to their .ts
    // files, without a concurrent build or writing generated source into Git.
    const script = `import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){try{return next(specifier,context)}catch(error){if(specifier.startsWith('.')&&specifier.endsWith('.js'))return next(specifier.slice(0,-3)+'.ts',context);throw error}}});
const {prepareLinuxExecutionIntent,runLinuxExecution}=await import(${JSON.stringify(entry)});
const {writeFile,appendFile}=await import('node:fs/promises');
const {randomUUID,randomBytes}=await import('node:crypto');
const stateRoot=${JSON.stringify(stateRoot)}, contract=${JSON.stringify(contract({ maxDurationMs: 20_000 }))};
const id=randomUUID(),job={id,requestDigest:'b'.repeat(64),nativeResourceId:'linux-'+id,nativeNonce:randomBytes(16).toString('hex'),deadline:Date.now()+20000};
const intent=await prepareLinuxExecutionIntent({stateRoot,contract,job});
await writeFile(stateRoot+'/context.json',JSON.stringify({stateRoot,contract,intent}),{mode:0o600});
await runLinuxExecution({stateRoot,contract,intent,files:[],argv:['/bin/sh','-c','printf once; sleep 30 & wait'],signal:new AbortController().signal,recordResources:async()=>{},authorizeStart:async()=>{await appendFile(stateRoot+'/dispatch-count','START\\n',{mode:0o600});return true}});`
    const host: ChildProcess = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostic = ''; host.stderr?.on('data', chunk => { diagnostic += String(chunk) })
    let ctx: { stateRoot: string; contract: LinuxExecutionContract; intent: LinuxExecutionIntent } | undefined
    try {
      let running = false
      for (const deadline = Date.now() + 8000; Date.now() < deadline;) {
        try {
          ctx = JSON.parse(await readFile(join(stateRoot, 'context.json'), 'utf8'))
          const journal = JSON.parse(await readFile(journalPath(ctx!), 'utf8'))
          if (journal.phase === 'running') { running = true; break }
        } catch { /* context and journal are atomically published asynchronously */ }
        await pause(25)
      }
      expect(running, diagnostic).toBe(true)
      expect(await readFile(join(stateRoot, 'dispatch-count'), 'utf8')).toBe('START\n')
      expect((await reconcileLinuxExecution(ctx!)).quiescent).toBe(false)
      const original = JSON.parse(await readFile(journalPath(ctx!), 'utf8'))
      const closed = new Promise<void>(resolveClosed => host.once('close', () => resolveClosed()))
      host.kill('SIGKILL'); await closed
      const outcome = await reconcileLinuxExecution(ctx!)
      expect(outcome).toMatchObject({ quiescent: true, receipt: { result: { status: 'unknown', quiescent: true } } })
      await absent(ctx!, outcome.resources!)
      const recovered = JSON.parse(await readFile(journalPath(ctx!), 'utf8'))
      expect(recovered.workerIdentity).toEqual(original.workerIdentity)
      expect(recovered.keeperIdentity).toEqual(original.keeperIdentity)
      expect(await reconcileLinuxExecution(ctx!)).toEqual(outcome)
      expect(await readFile(join(stateRoot, 'dispatch-count'), 'utf8')).toBe('START\n')
      expect((await readLinuxExecutionReceipt(ctx!))?.result.stdout).toBe('')
      await expect(runLinuxExecution({ ...ctx!, argv: ['/usr/bin/true'], files: [], signal: new AbortController().signal,
        recordResources: async () => {}, authorizeStart: () => true })).rejects.toThrow('single-use')
    } finally { host.kill('SIGKILL'); if (ctx) await reconcileLinuxExecution(ctx).catch(() => {}); await rm(stateRoot, { recursive: true, force: true }) }
  }, 15_000)
})
