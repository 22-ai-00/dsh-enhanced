import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import { LinuxCgroupLease } from '../src/linux-cgroups.js'
import { LINUX_REPOSITORY_STORAGE_BYTES, linuxExecutionContractDigest, linuxExecutionIntentDigest, linuxJobResourceReservation,
  validateLinuxExecutionContract, validateLinuxExecutionIntent, type LinuxRepositoryExecutionContract } from '../src/linux-execution-contract.js'
import { linuxExecutionReceiptBinding, prepareLinuxExecutionIntent, prepareLinuxRepositoryIntent, readLinuxRepositoryReceipt,
  reconcileLinuxRepositoryExecution, runLinuxExecution, runLinuxRepositoryExecution, type LinuxRepositoryExecutionContext } from '../src/linux-execution.js'

const faults = vi.hoisted(() => ({ inventory: '', target: '', stage: '', renamed: false, phase: '' }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (...args: unknown[]) => {
    if (faults.inventory && args[0] === faults.inventory) throw Object.assign(new Error('injected inventory EIO'), { code: 'EIO' })
    return Reflect.apply(actual.readFile, actual, args)
  }, open: async (...args: unknown[]) => {
    const path = String(args[0])
    if (faults.stage === 'open' && path === faults.target && typeof args[1] === 'number' && (args[1] & 64) !== 0) throw new Error('injected spool/receipt open EIO')
    const handle = await Reflect.apply(actual.open, actual, args)
    if (faults.stage === 'write' && path.startsWith(faults.target) && path.endsWith('.tmp')) handle.writeFile = async () => { throw new Error('injected spool write EIO') }
    if (faults.stage === 'filesync' && path.startsWith(faults.target) && path.endsWith('.tmp')) handle.sync = async () => { throw new Error('injected spool file fsync EIO') }
    if (faults.stage === 'sync' && faults.renamed && path === faults.target.slice(0, faults.target.lastIndexOf('/'))) handle.sync = async () => { throw new Error('injected directory fsync EIO') }
    return handle
  }, rename: async (...args: unknown[]) => {
    const targeted = args[1] === faults.target && (!faults.phase || JSON.parse(await actual.readFile(String(args[0]), 'utf8')).phase === faults.phase)
    if (targeted && faults.stage === 'rename') throw new Error('injected spool/receipt rename EIO')
    const result = await Reflect.apply(actual.rename, actual, args)
    if (targeted && faults.stage === 'sync') faults.renamed = true
    return result
  } }
})
const clearFaults = (): void => { Object.assign(faults, { inventory: '', target: '', stage: '', renamed: false, phase: '' }) }
const uid = process.getuid?.() ?? 0
const real = process.env.DSH_NATIVE_CGROUP_REAL === '1' && process.platform === 'linux' && uid > 0
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
function contract(): LinuxRepositoryExecutionContract {
  return { schemaVersion: 2, backend: 'linux-native', runtimeDigest: 'a'.repeat(64), profile: 'repository',
    limits: { maxDurationMs: 10_000, maxInputBytes: 64 * 1024 ** 2, maxOutputBytes: 4096, maxArtifactBytes: 32 * 1024 ** 2,
      maxFiles: 8, memoryMiB: 128, workspaceMiB: 4, workspaceInodes: 256, tmpMiB: 4, tmpInodes: 128,
      inputMiB: 65, inputInodes: 16, pidsLimit: 32, cpus: 0.5 },
    keeperLimits: { memoryMiB: 256, pidsLimit: 64, cpus: 0.5 },
    cgroupRoots: { mode: 'v1', cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`,
      memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`, pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`,
      freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}` } }
}
const request = (command = 'cp /input/source.tar package.tgz; printf built', bytes = Buffer.from([0, 255, 128, 3])) => ({
  argv: ['/bin/sh', '-c', command], archive: { bytes, sha256: sha(bytes) }, artifacts: ['package.tgz'], readOnlyRoots: [],
})
async function fixture(configured = contract(), supplied = request()) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-repository-durable-')), id = randomUUID()
  const job = { id, requestDigest: 'b'.repeat(64), nativeResourceId: `linux-${id}`, nativeNonce: randomBytes(16).toString('hex'), deadline: Date.now() + configured.limits.maxDurationMs }
  const intent = await prepareLinuxRepositoryIntent({ stateRoot, contract: configured, job, ...supplied })
  return { stateRoot, contract: configured, intent, ...supplied }
}
const journalPath = (ctx: LinuxRepositoryExecutionContext): string => join(ctx.stateRoot, 'jobs', `${ctx.intent.jobId}-${ctx.intent.nativeNonce}.json`)
const spoolPath = (ctx: LinuxRepositoryExecutionContext): string => join(ctx.stateRoot, 'artifacts', `${ctx.intent.jobId}-${ctx.intent.nativeNonce}`)
const receiptPath = (ctx: LinuxRepositoryExecutionContext): string => join(ctx.stateRoot, 'receipts', `${ctx.intent.jobId}-${ctx.intent.nativeNonce}.json`)
const run = (ctx: Awaited<ReturnType<typeof fixture>>) => runLinuxRepositoryExecution({ ...ctx, signal: new AbortController().signal, recordResources: async () => {}, authorizeStart: () => true })
async function absent(ctx: LinuxRepositoryExecutionContext): Promise<void> {
  for (const nonce of [ctx.intent.workerNonce, ctx.intent.keeperNonce]) for (const root of Object.values(ctx.intent.roots)) {
    await expect(lstat(join(root.path, `job-${ctx.intent.jobId}-${nonce}`))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  await expect(lstat(ctx.intent.namespacePath)).rejects.toMatchObject({ code: 'ENOENT' })
}

test('V2 freezes full repository limits and reserves every mount plus private storage', () => {
  const configured = contract()
  Object.assign(configured.limits, { memoryMiB: 16_384, workspaceMiB: 8192, tmpMiB: 4096, pidsLimit: 1024, cpus: 16, maxDurationMs: 1_800_000 })
  expect(validateLinuxExecutionContract(configured)).toEqual(configured)
  expect(linuxJobResourceReservation(configured)).toEqual({ memoryMiB: 28_994, workspaceInodes: 4528, storageBytes: LINUX_REPOSITORY_STORAGE_BYTES })
  for (const limits of [{ inputMiB: 64 }, { inputInodes: 15 }, { tmpMiB: 4097 }, { workspaceMiB: 8193 }, { maxDurationMs: 1_800_001 }]) {
    expect(() => validateLinuxExecutionContract({ ...configured, limits: { ...configured.limits, ...limits } })).toThrow()
  }
  expect(() => validateLinuxExecutionContract({ ...configured, keeperLimits: { memoryMiB: 128, pidsLimit: 64, cpus: 0.5 } })).toThrow()
  expect(() => validateLinuxExecutionContract({ ...configured, schemaVersion: 1 })).toThrow()
})

describe.skipIf(!real)('durable repository execution on actual cgroup v1', () => {
  test('binary output beyond text bounds lives only in private spool, and reopening never dispatches', async () => {
    const payload = Buffer.alloc(2 * 1024 ** 2, 255), ctx = await fixture(contract(), request(undefined, payload))
    try {
      expect(JSON.parse(await readFile(journalPath(ctx), 'utf8'))).toMatchObject({ schemaVersion: 2, phase: 'prepared', repositoryArtifacts: null })
      expect(await reconcileLinuxRepositoryExecution(ctx)).toEqual({ quiescent: false, artifacts: [] })
      const outcome = await run(ctx)
      expect(outcome.result).toMatchObject({ status: 'succeeded', quiescent: true, stdout: 'built', artifacts: [] })
      expect(outcome.artifacts).toHaveLength(1)
      expect(outcome.artifacts[0]!.bytes.equals(payload)).toBe(true)
      expect(outcome.artifacts[0]!.sha256).toBe(sha(payload))
      expect(outcome.receipt).toMatchObject({ schemaVersion: 2, repositoryArtifacts: [{ path: 'package.tgz', bytes: payload.length, sha256: sha(payload) }] })
      expect(linuxExecutionReceiptBinding(outcome.receipt!)).toMatchObject({ intentDigest: linuxExecutionIntentDigest(ctx.intent), requestDigest: ctx.intent.requestDigest })
      expect((await lstat(join(spoolPath(ctx), '0.bin'))).mode & 0o777).toBe(0o600)
      expect((await lstat(spoolPath(ctx))).mode & 0o777).toBe(0o700)
      expect((await readFile(receiptPath(ctx))).length).toBeLessThan(20_000)
      expect((await readFile(journalPath(ctx))).length).toBeLessThan(20_000)
      const restored = await readLinuxRepositoryReceipt(ctx)
      expect(restored!.receipt).toEqual(outcome.receipt)
      expect(restored!.artifacts[0]!.bytes.equals(payload)).toBe(true)
      const repeated = await runLinuxRepositoryExecution({ ...ctx, signal: new AbortController().signal,
        recordResources: async () => { throw new Error('must never redispatch') }, authorizeStart: () => { throw new Error('must never redispatch') } })
      expect(repeated.result).toEqual(outcome.result)
      expect(repeated.receipt).toEqual(outcome.receipt)
      expect(repeated.artifacts[0]!.bytes.equals(payload)).toBe(true)
      await absent(ctx)
    } finally { await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test('archive digest, command, roots and fixed artifact paths are bound before dispatch', async () => {
    const ctx = await fixture()
    try {
      for (const changed of [{ argv: ['/bin/false'] }, { artifacts: ['other.tgz'] }, { readOnlyRoots: ['/usr'] },
        { archive: { bytes: Buffer.from('changed'), sha256: sha(Buffer.from('changed')) } }]) {
        await expect(runLinuxRepositoryExecution({ ...ctx, ...changed, signal: new AbortController().signal,
          recordResources: async () => {}, authorizeStart: () => true })).rejects.toThrow('binding differs')
      }
      await expect(runLinuxRepositoryExecution({ ...ctx, archive: { bytes: ctx.archive.bytes, sha256: 'f'.repeat(64) }, signal: new AbortController().signal,
        recordResources: async () => {}, authorizeStart: () => true })).rejects.toThrow('request differs')
      const altered = { ...ctx.intent, repository: { ...ctx.intent.repository, archive: { bytes: 0, sha256: ctx.archive.sha256 } } }
      expect(() => validateLinuxExecutionIntent(altered, ctx.contract)).toThrow()
      expect(() => validateLinuxExecutionIntent(ctx.intent, { ...ctx.contract, runtimeDigest: 'c'.repeat(64) })).toThrow()
      expect(ctx.intent.contractDigest).toBe(linuxExecutionContractDigest(ctx.contract))
      await expect(runLinuxExecution({ ...ctx, files: [], signal: new AbortController().signal, recordResources: async () => {}, authorizeStart: () => true })).rejects.toThrow('repository API')
      await expect(prepareLinuxExecutionIntent({ ...ctx, job: { id: randomUUID(), requestDigest: 'b'.repeat(64), nativeResourceId: ctx.intent.nativeResourceId,
        nativeNonce: ctx.intent.nativeNonce, deadline: Date.now() + 1000 } })).rejects.toThrow('repository API')
      expect(JSON.parse(await readFile(journalPath(ctx), 'utf8')).phase).toBe('prepared')
      await absent(ctx)
    } finally { await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test.each(['failed', 'cancelled'] as const)('a %s job never persists or returns binary artifacts', async status => {
    const ctx = await fixture(contract(), request('cp /input/source.tar package.tgz; exit 1')), controller = new AbortController()
    if (status === 'cancelled') controller.abort()
    try {
      const outcome = await runLinuxRepositoryExecution({ ...ctx, signal: controller.signal, recordResources: async () => {}, authorizeStart: () => true })
      expect(outcome.result).toMatchObject({ status, quiescent: true, artifacts: [] })
      expect(outcome.artifacts).toEqual([])
      expect(await readdir(join(ctx.stateRoot, 'artifacts'))).toEqual([])
      if (outcome.receipt) expect(outcome.receipt).toMatchObject({ repositoryArtifacts: [] })
      else expect(outcome.partialProof).toBeDefined()
      await absent(ctx)
    } finally { await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test.each(['corrupt', 'symlink', 'hardlink', 'mode'] as const)('rejects %s spool evidence and never returns bytes', async kind => {
    const ctx = await fixture()
    try {
      await run(ctx)
      const path = join(spoolPath(ctx), '0.bin')
      if (kind === 'corrupt') await writeFile(path, Buffer.from([1, 2, 3, 4]))
      if (kind === 'mode') await chmod(path, 0o640)
      if (kind === 'hardlink') await link(path, join(ctx.stateRoot, 'linked'))
      if (kind === 'symlink') { await unlink(path); await symlink('/etc/passwd', path) }
      await expect(readLinuxRepositoryReceipt(ctx)).rejects.toThrow()
      await expect(reconcileLinuxRepositoryExecution(ctx)).rejects.toThrow()
    } finally { await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test('a valid spool cannot substitute for namespace absence', async () => {
    const ctx = await fixture()
    try {
      await run(ctx)
      await mkdir(ctx.intent.namespacePath, { mode: 0o700 })
      await expect(readLinuxRepositoryReceipt(ctx)).rejects.toThrow('resources still present')
      await rm(ctx.intent.namespacePath, { recursive: true })
      expect((await readLinuxRepositoryReceipt(ctx))!.artifacts[0]!.bytes).toEqual(ctx.archive.bytes)
    } finally { await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test('unknown cleanup retains all binary bytes and can retry cleanup without redispatch', async () => {
    const ctx = await fixture()
    try {
      const outcome = await runLinuxRepositoryExecution({ ...ctx, signal: new AbortController().signal, recordResources: async () => {},
        authorizeStart: () => { faults.inventory = join(ctx.intent.roots.freezer!.path, `job-${ctx.intent.jobId}-${ctx.intent.workerNonce}`, 'cgroup.procs'); return true } })
      expect(outcome.result).toMatchObject({ status: 'unknown', quiescent: false })
      expect(outcome.artifacts).toEqual([])
      expect(outcome.receipt).toBeUndefined()
      clearFaults()
      const recovered = await reconcileLinuxRepositoryExecution(ctx)
      expect(recovered).toMatchObject({ quiescent: true, artifacts: [], receipt: { result: { status: 'unknown' }, repositoryArtifacts: [] } })
      await expect(run(ctx)).resolves.toMatchObject({ result: { status: 'unknown' }, artifacts: [] })
      await absent(ctx)
    } finally { clearFaults(); await reconcileLinuxRepositoryExecution(ctx); await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test.each(['write', 'filesync', 'rename', 'sync'] as const)('spool %s failure recovers as unknown with no bytes and removes the orphan', async stage => {
    const ctx = await fixture()
    try {
      faults.target = join(spoolPath(ctx), '0.bin'); faults.stage = stage
      await expect(run(ctx)).rejects.toThrow('injected')
      clearFaults()
      await expect(run(ctx)).rejects.toThrow('single-use')
      const recovered = await reconcileLinuxRepositoryExecution(ctx)
      expect(recovered).toMatchObject({ quiescent: true, artifacts: [], receipt: { result: { status: 'unknown' }, repositoryArtifacts: [] } })
      await expect(lstat(spoolPath(ctx))).rejects.toMatchObject({ code: 'ENOENT' })
      await absent(ctx)
    } finally { clearFaults(); await reconcileLinuxRepositoryExecution(ctx); await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test.each(['open', 'rename', 'sync'] as const)('receipt %s failure preserves proof or recovers unknown without replay', async stage => {
    const ctx = await fixture()
    try {
      faults.target = receiptPath(ctx); faults.stage = stage
      await expect(run(ctx)).rejects.toThrow('injected')
      clearFaults()
      const recovered = await reconcileLinuxRepositoryExecution(ctx)
      expect(recovered.quiescent).toBe(true)
      expect(recovered.receipt?.result.status).toBe(stage === 'sync' ? 'succeeded' : 'unknown')
      expect(recovered.artifacts).toHaveLength(stage === 'sync' ? 1 : 0)
      await absent(ctx)
    } finally { clearFaults(); await reconcileLinuxRepositoryExecution(ctx); await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test('late Host authorization cannot restart or mutate a cancelled repository journal', async () => {
    const ctx = await fixture(), controller = new AbortController()
    let release = (): void => {}
    const blocked = new Promise<void>(resolve => { release = resolve })
    try {
      const outcome = await runLinuxRepositoryExecution({ ...ctx, signal: controller.signal, recordResources: async () => {},
        authorizeStart: async () => { setTimeout(() => controller.abort(), 30); await blocked; return true } })
      expect(outcome).toMatchObject({ result: { status: 'cancelled', quiescent: true }, artifacts: [] })
      const original = await readFile(journalPath(ctx), 'utf8')
      release(); await pause(40)
      expect(await readFile(journalPath(ctx), 'utf8')).toBe(original)
      await absent(ctx)
    } finally { release(); await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test('SIGKILL recovery rejects a live creator, drains both groups after death, and never replays', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-repository-crash-'))
    const entry = pathToFileURL(join(import.meta.dirname, '../src/linux-execution.ts')).href
    const script = `import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){try{return next(specifier,context)}catch(error){if(specifier.startsWith('.')&&specifier.endsWith('.js'))return next(specifier.slice(0,-3)+'.ts',context);throw error}}});
const {prepareLinuxRepositoryIntent,runLinuxRepositoryExecution}=await import(${JSON.stringify(entry)});
const {writeFile,appendFile}=await import('node:fs/promises');const {randomUUID,randomBytes,createHash}=await import('node:crypto');
const stateRoot=${JSON.stringify(stateRoot)},contract=${JSON.stringify(contract())},id=randomUUID();contract.limits.maxDurationMs=20000;
const request={argv:['/bin/sh','-c','sleep 30'],archive:{bytes:Buffer.from('source'),sha256:createHash('sha256').update('source').digest('hex')},artifacts:[]};
const job={id,requestDigest:'b'.repeat(64),nativeResourceId:'linux-'+id,nativeNonce:randomBytes(16).toString('hex'),deadline:Date.now()+20000};
const intent=await prepareLinuxRepositoryIntent({stateRoot,contract,job,...request});
await writeFile(stateRoot+'/context.json',JSON.stringify({stateRoot,contract,intent}),{mode:0o600});
await runLinuxRepositoryExecution({stateRoot,contract,intent,...request,signal:new AbortController().signal,recordResources:async()=>{},authorizeStart:async()=>{await appendFile(stateRoot+'/starts','START\\n',{mode:0o600});return true}});`
    const host = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostic = ''; host.stderr.on('data', chunk => { diagnostic += String(chunk) })
    let ctx: LinuxRepositoryExecutionContext | undefined
    try {
      let running = false
      for (const deadline = Date.now() + 8000; Date.now() < deadline;) {
        try { ctx = JSON.parse(await readFile(join(stateRoot, 'context.json'), 'utf8')); running = JSON.parse(await readFile(journalPath(ctx!), 'utf8')).phase === 'running'; if (running) break } catch { /* atomic context publication */ }
        await pause(25)
      }
      expect(running, diagnostic).toBe(true)
      expect(await reconcileLinuxRepositoryExecution(ctx!)).toMatchObject({ quiescent: false, artifacts: [] })
      const closed = new Promise<void>(resolve => { host.once('close', () => resolve()) }); host.kill('SIGKILL'); await closed
      const recovered = await reconcileLinuxRepositoryExecution(ctx!)
      expect(recovered).toMatchObject({ quiescent: true, artifacts: [], receipt: { result: { status: 'unknown' } } })
      expect(await readFile(join(stateRoot, 'starts'), 'utf8')).toBe('START\n')
      expect(await reconcileLinuxRepositoryExecution(ctx!)).toEqual(recovered)
      await absent(ctx!)
    } finally { host.kill('SIGKILL'); if (ctx) await reconcileLinuxRepositoryExecution(ctx); await rm(stateRoot, { recursive: true, force: true }) }
  }, 15_000)

  test.each(['rename', 'sync'] as const)('terminal repository journal %s failure preserves recovery with no artifact replay', async stage => {
    const ctx = await fixture()
    try {
      faults.target = journalPath(ctx); faults.stage = stage; faults.phase = 'settled'
      await expect(run(ctx)).rejects.toThrow('injected')
      clearFaults()
      await expect(run(ctx)).rejects.toThrow('single-use')
      const recovered = await reconcileLinuxRepositoryExecution(ctx)
      expect(recovered).toMatchObject({ quiescent: true, artifacts: [], receipt: { result: { status: 'unknown' }, repositoryArtifacts: [] } })
      await expect(lstat(spoolPath(ctx))).rejects.toMatchObject({ code: 'ENOENT' })
      await absent(ctx)
    } finally { clearFaults(); await reconcileLinuxRepositoryExecution(ctx); await rm(ctx.stateRoot, { recursive: true, force: true }) }
  })

  test.each([false, true])('a dead creator with one unrecorded resource only releases proven empty groups (populated=%s)', async populated => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-repository-partial-'))
    const entry = pathToFileURL(join(import.meta.dirname, '../src/linux-execution.ts')).href
    const cgroupEntry = pathToFileURL(join(import.meta.dirname, '../src/linux-cgroups.ts')).href
    const script = `import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){try{return next(specifier,context)}catch(error){if(specifier.startsWith('.')&&specifier.endsWith('.js'))return next(specifier.slice(0,-3)+'.ts',context);throw error}}});
const {prepareLinuxRepositoryIntent}=await import(${JSON.stringify(entry)});const {LinuxCgroupLease}=await import(${JSON.stringify(cgroupEntry)});
const {readFile,writeFile}=await import('node:fs/promises');const {randomUUID,randomBytes,createHash}=await import('node:crypto');const {spawn}=await import('node:child_process');
const stateRoot=${JSON.stringify(stateRoot)},contract=${JSON.stringify(contract())},id=randomUUID();contract.limits.maxDurationMs=20000;
const request={argv:['/bin/true'],archive:{bytes:Buffer.from('source'),sha256:createHash('sha256').update('source').digest('hex')},artifacts:[]};
const job={id,requestDigest:'b'.repeat(64),nativeResourceId:'linux-'+id,nativeNonce:randomBytes(16).toString('hex'),deadline:Date.now()+20000};
const intent=await prepareLinuxRepositoryIntent({stateRoot,contract,job,...request});
const lease=await LinuxCgroupLease.create({roots:contract.cgroupRoots,jobId:id,nonce:intent.workerNonce,deadline:intent.deadline,limits:{memoryMiB:128,pidsLimit:32,cpus:0.5}});
let pid;if(${populated}){const child=spawn('/usr/bin/python3',['-I','-S','-c','import time;time.sleep(30)'],{stdio:'ignore'});pid=child.pid;
const raw=await readFile('/proc/'+pid+'/stat','utf8');await lease.admit({pid,startTicks:raw.slice(raw.lastIndexOf(') ')+2).trim().split(/\\s+/)[19],uid:intent.uid,bootId:intent.bootId});}
await writeFile(stateRoot+'/context.json',JSON.stringify({stateRoot,contract,intent,snapshot:lease.snapshot,pid}),{mode:0o600});setInterval(()=>{},1000);`
    const host = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostic = ''; host.stderr.on('data', chunk => { diagnostic += String(chunk) })
    let ctx: (LinuxRepositoryExecutionContext & { snapshot: LinuxCgroupLease['snapshot']; pid?: number }) | undefined
    try {
      for (const deadline = Date.now() + 5000; Date.now() < deadline && !ctx;) {
        try { ctx = JSON.parse(await readFile(join(stateRoot, 'context.json'), 'utf8')) } catch { await pause(20) }
      }
      expect(ctx, diagnostic).toBeDefined()
      expect(await reconcileLinuxRepositoryExecution(ctx!)).toEqual({ quiescent: false, artifacts: [] })
      const closed = new Promise<void>(resolve => { host.once('close', () => resolve()) }); host.kill('SIGKILL'); await closed
      const recovered = await reconcileLinuxRepositoryExecution(ctx!)
      if (populated) {
        expect(recovered).toEqual({ quiescent: false, artifacts: [] })
        expect(await readFile(`/proc/${ctx!.pid}/comm`, 'utf8')).toContain('python3')
      } else {
        expect(recovered).toMatchObject({ quiescent: true, partialProof: { workerAbsent: true, keeperAbsent: true }, artifacts: [] })
        await absent(ctx!)
      }
    } finally {
      host.kill('SIGKILL')
      if (ctx) {
        const lease = await LinuxCgroupLease.recover(ctx.snapshot)
        expect(await lease.terminateAndProve(1000)).toBe(true); expect(await lease.removeWhenEmpty()).toBe(true)
      }
      await rm(stateRoot, { recursive: true, force: true })
    }
  }, 12_000)
})
