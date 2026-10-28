// Host orchestration fixtures: real Git trees and archives, mocked isolated
// runner outcomes. These do not establish full repository runtime acceptance.
import { execFileSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { LinuxRepositoryRunner, LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { DatabaseSync } from 'node:sqlite'
import { LinuxRepositoryRunner as ActualLinuxRepositoryRunner, linuxJobResourceReservation, linuxRuntimeDigest, type LinuxRepositoryExecutionContract } from '@dsh-enhanced/assistant-isolation'
import { runLinuxPreparedChecks, LINUX_PREPARED_SOURCE_BUILD_SCRIPT, LINUX_SOURCE_PACK_PATH } from '../src/linux-source-build.js'
import { PREPARED_SOURCE_BUILD_SCRIPT, validateSourceBuildConfig, type LinuxSourceBuildConfig } from '../src/source-build.js'

import { consumeLinuxSourceNotStarted } from '../src/linux-source-preflight.js'
import * as sourceBuild from '../src/source-build.js'

import { linuxRuntimeFixture } from './helpers/linux-source-preflight-runtime-fixture.js'
import { IsolationLedger } from '../../assistant-isolation/lib/ledger.js'
import { linuxSourceConfig } from './helpers/linux-source-build-fixture.js'

const archiveFault = vi.hoisted(() => ({ enabled: false, count: 0, oversize: false }))
const preparationGate = vi.hoisted(() => ({ fifo: '', calls: [] as Array<{
  args: readonly string[]; child: ChildProcess; closed: Promise<void>; index: string
}> }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { Transform } = await import('node:stream')
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const index = args[2]?.env?.GIT_INDEX_FILE
    const preparation = !!preparationGate.fifo && args[0] === '/usr/bin/git'
      && typeof index === 'string' && index.includes('/dsh-source-build-index-')
    const child = preparation && args[1]?.[0] === 'read-tree'
      ? actual.spawn(args[0], args[1], { ...args[2], env: { ...args[2]?.env, GIT_TRACE2_EVENT: preparationGate.fifo } })
      : actual.spawn(...args)
    if (preparation) preparationGate.calls.push({ args: args[1] ?? [], child,
      closed: new Promise<void>(resolveClosed => child.once('close', () => resolveClosed())), index: index! })
    if ((archiveFault.enabled || archiveFault.oversize) && args[0] === '/usr/bin/git' && Array.isArray(args[1]) && args[1].includes('archive')
      && (++archiveFault.count === 2 || archiveFault.oversize) && child.stdout) {
      let changed = false
      const transformed = child.stdout.pipe(new Transform({ transform(chunk: Buffer, _encoding, callback) {
        const bytes = Buffer.from(chunk)
        if (!changed && archiveFault.oversize) { changed = true; callback(null, Buffer.alloc(64 * 1024 ** 2 + 1)); return }
        if (!changed) { bytes[0] = bytes[0]! ^ 1; changed = true }
        callback(null, bytes)
      } }))
      Object.defineProperty(child, 'stdout', { value: transformed })
    }
    return child
  } }
})
vi.mock('@dsh-enhanced/assistant-isolation', async importOriginal => {
  const actual = await importOriginal<typeof import('@dsh-enhanced/assistant-isolation')>()
  return { ...actual, verifyLinuxRuntime: vi.fn(async (value: LinuxRuntime) => value) }
})
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const roots: string[] = []
afterEach(async () => { preparationGate.fifo = ''; preparationGate.calls = []; archiveFault.enabled = false; archiveFault.count = 0; archiveFault.oversize = false; vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

test('validates Linux, Mac and Docker configurations independently without a runtime value dependency', async () => {
  const valid = linuxSourceConfig()
  expect(() => validateSourceBuildConfig(valid)).not.toThrow()
  expect(() => validateSourceBuildConfig({ ...valid, timeoutMs: 1800000, maxTotalDurationMs: 1800000, memoryMiB: 16384, cpus: 16,
    pidsLimit: 1024, workspaceMiB: 8192, temporaryMiB: 4096, workspaceInodes: 1000000, temporaryInodes: 1000000 })).not.toThrow()
  for (const patch of [{ backend: 'unknown' }, { timeoutMs: 59999 }, { timeoutMs: 1800001 }, { memoryMiB: 127 },
    { cpus: 16.1 }, { pidsLimit: 1025 }, { workspaceMiB: 8193 }, { temporaryMiB: 4097 }, { workspaceInodes: 15 },
    { temporaryInodes: 1000001 }, { cgroupRoots: { ...valid.cgroupRoots, cpu: `/sys/fs/cgroup/memory/dsh-native/uid-${process.getuid?.()}` } }, { outputBytes: 1048577 }, { maxRuns: 0 }, { maxTotalDurationMs: 86400001 },
    { stateRoot: '/unsafe\0state' }, { runtime: { ...valid.runtime, nodePath: '/other/node' } },
    { runtime: { ...valid.runtime, unexpected: true } }, { dockerPath: '/usr/bin/docker' }]) {
    expect(() => validateSourceBuildConfig({ ...valid, ...patch } as LinuxSourceBuildConfig)).toThrow()
  }
  expect(() => validateSourceBuildConfig({ dockerPath: '/usr/bin/docker', image: 'sha256:' + 'a'.repeat(64),
    timeoutMs: 60000, memoryMiB: 512, cpus: 1, pidsLimit: 64, workspaceMiB: 128, outputBytes: 4096 })).not.toThrow()
  expect(() => validateSourceBuildConfig({ dockerPath: '/usr/bin/docker', image: 'sha256:' + 'a'.repeat(64),
    timeoutMs: 60000, memoryMiB: 512, cpus: 1, pidsLimit: 64, workspaceMiB: 128, outputBytes: 4096,
    unexpected: true } as unknown as LinuxSourceBuildConfig)).toThrow()
  const source = await readFile(new URL('../src/source-build.ts', import.meta.url), 'utf8')
  for (const line of source.split('\n').filter(line => line.includes("from '@dsh-enhanced/assistant-isolation'"))) expect(line).toMatch(/^import type /u)
})

test('retains the complete repository script, fixed baseline and native binary transport', () => {
  expect(LINUX_PREPARED_SOURCE_BUILD_SCRIPT).toContain("checked check /bin/sh -ceu 'umask 022; exec pnpm check'")
  expect(LINUX_PREPARED_SOURCE_BUILD_SCRIPT).toContain('pnpm install --offline --frozen-lockfile --ignore-scripts')
  expect(LINUX_PREPARED_SOURCE_BUILD_SCRIPT).toContain('/runtime/0/pnpm-lock.yaml')
  expect(LINUX_PREPARED_SOURCE_BUILD_SCRIPT).toContain('cp -R /runtime/0/store/.')
  expect(LINUX_PREPARED_SOURCE_BUILD_SCRIPT).toContain('test ! -e node_modules')
  expect(LINUX_PREPARED_SOURCE_BUILD_SCRIPT).not.toContain('DSH_PREPARED_PACK_BYTES_V1')
  expect(LINUX_PREPARED_SOURCE_BUILD_SCRIPT).not.toContain('/opt/dsh-source-baseline')
  expect(PREPARED_SOURCE_BUILD_SCRIPT).toContain('DSH_PREPARED_PACK_BYTES_V1')
  expect(PREPARED_SOURCE_BUILD_SCRIPT).toContain('/opt/dsh-source-baseline')
})

async function fixture(mode = 'success') {
  const worktree = await mkdtemp(join(tmpdir(), 'linux-source-build-')); roots.push(worktree)
  await mkdir(join(worktree, 'plugins', 'helper'), { recursive: true })
  await writeFile(join(worktree, 'plugins', 'helper', 'package.json'), '{"name":"helper","version":"1.0.0"}\n')
  await writeFile(join(worktree, 'plugins', 'helper', 'index.js'), 'old\n')
  await writeFile(join(worktree, 'unrelated'), 'base\n')
  const environment = { PATH: process.env.PATH, HOME: worktree }
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: worktree, env: environment, encoding: 'utf8' }).trim()
  git('init', '-q'); git('add', '--all'); git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
  const baseCommit = git('rev-parse', 'HEAD')
  await writeFile(join(worktree, 'plugins', 'helper', 'index.js'), 'new\n')
  await writeFile(join(worktree, 'unrelated'), 'excluded edit\n')
  const settings = linuxSourceConfig(), bytes = Buffer.from([0, 255, 128, 10]), artifactSha = hash(bytes)
  let archived: Buffer | undefined
  const run = vi.fn(async (_key, request, loadArchive, signal: AbortSignal) => {
    if (mode === 'delayed archive') await new Promise(resolve => setTimeout(resolve, 1100))
    archived = Buffer.from(await loadArchive(new AbortController().signal))
    if (mode === 'deadline') await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
    expect(archived.length).toBe(request.archive.bytes)
    expect(hash(archived)).toBe(request.archive.sha256)
    expect(execFileSync('/usr/bin/tar', ['-xOf', '-', 'plugins/helper/index.js'], { input: archived, encoding: 'utf8' })).toBe('new\n')
    expect(execFileSync('/usr/bin/tar', ['-xOf', '-', 'unrelated'], { input: archived, encoding: 'utf8' })).toBe('base\n')
    expect(request.argv).toContain('DSH_TEST_PNPM_ROOT=/runtime/0/pnpm-native')
    expect(request.argv).toContain('PATH=/runtime/0/bin:/runtime/0/pnpm-native:/usr/bin:/bin')
    if (mode === 'source drift') await writeFile(join(worktree, 'plugins', 'helper', 'index.js'), 'changed while building\n')
    return { result: { status: mode === 'failure' ? 'failed' : 'succeeded', quiescent: mode !== 'unquiet', exitCode: mode === 'failure' ? 1 : 0,
      stdout: `DSH_PREPARED_PACK\thelper-1.0.0.tgz\t${bytes.length}\t${mode === 'digest' ? '0'.repeat(64) : artifactSha}\tv22.23.2\t11.7.0\n`, stderr: '' },
    artifacts: [{ path: mode === 'path' ? '../unsafe' : LINUX_SOURCE_PACK_PATH, bytes, sha256: artifactSha }],
    receiptBinding: mode === 'receipt' ? undefined : { requestDigest: 'a'.repeat(64), nativeNonce: 'b'.repeat(32),
      nativeResourceId: 'linux-11111111-1111-4111-8111-111111111111', intentDigest: 'c'.repeat(64), resourcesDigest: 'd'.repeat(64), receiptDigest: 'e'.repeat(64) },
    contractDigest: 'f'.repeat(64), runtimeDigest: linuxRuntimeDigest(settings.runtime) }
  })
  const runner = { run, runtimeDigest: linuxRuntimeDigest(settings.runtime), contractDigest: 'f'.repeat(64) } as unknown as LinuxRepositoryRunner
  return { worktree, run, archived: () => archived, input: { config: settings, runner, worktree, baseCommit, name: 'helper',
    scope: ['plugins/helper'], environment, signal: new AbortController().signal, assertCurrent: async () => {}, preparedAt: Date.now(),
    sourceJob: { id: 'source-job-' + '1'.repeat(64) }, capturePack: true as const } }
}

test('archives an exact scoped Git tree and binds binary pack bytes and private receipt without Docker', async () => {
  const f = await fixture()
  const result = await runLinuxPreparedChecks(f.input)
  expect(result.evidence).toMatchObject({ schemaVersion: 3, boundary: 'linux-native-repository-v1',
    runtimeDigest: linuxRuntimeDigest(f.input.config.runtime), executionContractDigest: 'f'.repeat(64),
    archive: { sizeBytes: f.archived()!.length, sha256: hash(f.archived()!) } })
  expect(result.packArtifact?.equals(Buffer.from([0, 255, 128, 10]))).toBe(true)
  expect(f.run).toHaveBeenCalledOnce()
})

test.each(['digest', 'path', 'receipt', 'unquiet', 'failure', 'source drift'])('rejects %s without prepared evidence', async mode => {
  const f = await fixture(mode)
  await expect(runLinuxPreparedChecks(f.input)).rejects.toThrow(/Linux source build/u)
})

test('freezes archive metadata across distinct wall-clock seconds', async () => {
  const f = await fixture('delayed archive')
  expect((await runLinuxPreparedChecks(f.input)).evidence.schemaVersion).toBe(3)
})

test('rejects second-pass archive bytes differing from the declared digest', async () => {
  const f = await fixture()
  archiveFault.enabled = true
  await expect(runLinuxPreparedChecks(f.input)).rejects.toThrow('archive changed before admission')
  expect(archiveFault.count).toBe(2)
})

test('rejects parsed export-subst from the frozen tree before runner admission', async () => {
  const f = await fixture()
  await writeFile(join(f.worktree, '.gitattributes'), 'plugins/helper/index.js export-subst\n')
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: f.worktree, env: f.input.environment, encoding: 'utf8' }).trim()
  git('add', '.gitattributes'); git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'attributes baseline')
  f.input.baseCommit = git('rev-parse', 'HEAD')
  await expect(runLinuxPreparedChecks(f.input)).rejects.toThrow('export-subst cannot preserve exact source bytes')
  expect(f.run).not.toHaveBeenCalled()
})

test('rejects a first-pass archive above 64MiB before runner admission', async () => {
  const f = await fixture()
  archiveFault.oversize = true
  await expect(runLinuxPreparedChecks(f.input)).rejects.toThrow('archive exceeds 64MiB')
  expect(f.run).not.toHaveBeenCalled()
})

test('propagates a shorter per-call deadline into the admitted runner signal', async () => {
  const f = await fixture('deadline'), timeout = new AbortController()
  const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
  const operation = runLinuxPreparedChecks(f.input)
  const rejected = expect(operation).rejects.toThrow('per-call deadline')
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce())
  expect(spy).toHaveBeenCalledWith(60000)
  timeout.abort(new Error('per-call deadline'))
  await rejected
  expect(f.run.mock.calls[0]![3].aborted).toBe(true)
  expect(f.input.signal.aborted).toBe(false)
})

test.runIf(process.platform === 'linux')('cancels a stopped actual read-tree before add/write-tree and removes its private index', async () => {
  const f = await fixture(), abort = new AbortController()
  const fifo = join(f.worktree, 'git-trace.fifo')
  execFileSync('/usr/bin/mkfifo', [fifo])
  preparationGate.fifo = fifo
  const operation = runLinuxPreparedChecks({ ...f.input, signal: abort.signal })
  const rejected = expect(operation).rejects.toThrow('cancel source preparation')
  let stage: (typeof preparationGate.calls)[number] | undefined
  try {
    await vi.waitFor(() => { expect(preparationGate.calls).toHaveLength(1) })
    stage = preparationGate.calls[0]!
    expect(stage.args[0]).toBe('read-tree')
    // Trace2 blocks this actual Git process opening the private FIFO before it
    // can change the index. Stop that same PID, then cancel the preparation.
    expect(await readFile(`/proc/${stage.child.pid}/cmdline`, 'utf8')).toContain('read-tree')
    process.kill(stage.child.pid!, 'SIGSTOP')
    await vi.waitFor(async () => {
      const stat = await readFile(`/proc/${stage!.child.pid}/stat`, 'utf8')
      expect(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[0]).toBe('T')
    })
    abort.abort(new Error('cancel source preparation'))
    await rejected
    await stage.closed
    expect(stage.child.signalCode).toBe('SIGKILL')
    expect(preparationGate.calls.map(call => call.args[0])).toEqual(['read-tree'])
    await expect(readFile(`/proc/${stage.child.pid}/stat`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(stage.index)).rejects.toMatchObject({ code: 'ENOENT' })
    const { stat } = await import('node:fs/promises')
    await expect(stat(join(stage.index, '..'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.run).not.toHaveBeenCalled()
  } finally {
    abort.abort(new Error('cancel source preparation'))
    stage?.child.kill('SIGKILL')
    if (stage) await stage.closed
    await operation.catch(() => {})
  }
})


test('certifies this-call archive rejection before admission, with private one-use runner/key binding', async () => {
  const f = await fixture(); archiveFault.oversize = true
  const error = await runLinuxPreparedChecks(f.input).catch(error => error)
  expect(error).toBeInstanceOf(Error)
  expect(error.message).toContain('archive exceeds 64MiB')
  expect(f.run).not.toHaveBeenCalled()
  expect(consumeLinuxSourceNotStarted(new Error(error.message), { runner: f.input.runner, key: f.input.sourceJob.id })).toBe(false)
  expect(consumeLinuxSourceNotStarted(error, { runner: {}, key: f.input.sourceJob.id })).toBe(false)
  expect(consumeLinuxSourceNotStarted(error, { runner: f.input.runner, key: 'other' })).toBe(false)
  expect(consumeLinuxSourceNotStarted(error, { runner: f.input.runner, key: f.input.sourceJob.id })).toBe(true)
  expect(consumeLinuxSourceNotStarted(error, { runner: f.input.runner, key: f.input.sourceJob.id })).toBe(false)
})

test('does not certify arbitrary runner failure or a failed private index cleanup', async () => {
  const f = await fixture()
  f.run.mockRejectedValueOnce(new Error('budget exhausted'))
  const error = await runLinuxPreparedChecks(f.input).catch(error => error)
  expect(consumeLinuxSourceNotStarted(error, { runner: f.input.runner, key: f.input.sourceJob.id })).toBe(false)
  const original = sourceBuild.sourceTree
  vi.spyOn(sourceBuild, 'sourceTree').mockImplementationOnce(async (...args) => {
    const snapshot = await original(...args)
    return { ...snapshot, cleanup: async () => { await snapshot.cleanup(); throw new Error('private index cleanup uncertain') } }
  })
  archiveFault.oversize = true
  const uncertain = await runLinuxPreparedChecks(f.input).catch(error => error)
  expect(uncertain.message).toContain('private index cleanup uncertain')
  expect(consumeLinuxSourceNotStarted(uncertain, { runner: f.input.runner, key: f.input.sourceJob.id })).toBe(false)
  expect(f.run).toHaveBeenCalledOnce()
})


test.skipIf(process.platform !== 'linux' || !process.getuid?.())('consumes a genuine runner budget refusal after confirmed rollback, without loading or executing the candidate', async () => {
  const f = await fixture(), root = await mkdtemp(join(tmpdir(), 'linux-adapter-admission-')); roots.push(root)
  const { runtime, cgroupRoots } = await linuxRuntimeFixture(root)
  const config = { ...f.input.config, runtime, cgroupRoots, stateRoot: join(root, 'state'), maxRuns: 1, maxTotalDurationMs: 60000 }
  const limits = { maxDurationMs: config.timeoutMs, maxInputBytes: 64 * 1024 ** 2, maxOutputBytes: config.outputBytes,
    maxArtifactBytes: 32 * 1024 ** 2, maxFiles: 128, memoryMiB: config.memoryMiB, workspaceMiB: config.workspaceMiB,
    workspaceInodes: config.workspaceInodes, tmpMiB: config.temporaryMiB, tmpInodes: config.temporaryInodes,
    inputMiB: 65 as const, inputInodes: 16 as const, pidsLimit: config.pidsLimit, cpus: config.cpus }
  const runner = new ActualLinuxRepositoryRunner({ backend: 'linux-native', runtime, cgroupRoots, stateRoot: config.stateRoot,
    authorityDigest: config.authorityDigest, expiresAt: config.expiresAt, maxRuns: 1, maxTotalDurationMs: 60000, limits })
  try {
    await runner.inspectQuiescence('ready')
    const db = new DatabaseSync(join(config.stateRoot, 'ledger.sqlite'))
    const row = db.prepare('SELECT owner_id,fence FROM isolation_controller').get()!; db.close()
    const authority = { ownerId: String(row.owner_id), fence: Number(row.fence) }
    const contract: LinuxRepositoryExecutionContract = { schemaVersion: 2, backend: 'linux-native', profile: 'repository',
      runtimeDigest: linuxRuntimeDigest(runtime), limits, cgroupRoots, keeperLimits: { memoryMiB: 256, pidsLimit: 64, cpus: 0.5 } }
    const reservation = linuxJobResourceReservation(contract), ledger = new IsolationLedger(join(config.stateRoot, 'ledger.sqlite'))
    try {
      const spent = ledger.prepare({ identity: { principalDigest: config.authorityDigest, principalRecordId: `repository:${config.authorityDigest}`,
        principalVersion: 1, workspace: config.stateRoot, agentPreset: 'repository' }, sessionId: `authority:${config.authorityDigest}`,
        grantId: 'repository', idempotencyKey: 'spent', requestDigest: 'b'.repeat(64), durationMs: 60000, authority,
        backend: 'linux-native', linuxContract: contract, resourceReservation: { memoryMiB: reservation.memoryMiB, workspaceInodes: reservation.workspaceInodes,
          maxMemoryMiB: 32768, maxWorkspaceInodes: 3000000 }, storageBudget: { reservedBytes: reservation.storageBytes,
          maxStateBytes: 1024 ** 3, maxJobRecords: 10000, observation: { bytes: 0, observedAt: Date.now() } } }).job
      ledger.settle(spent.id, spent.version, { jobId: spent.id, status: 'failed', quiescent: true, stdout: '', stderr: '', artifacts: [] }, authority)
    } finally { ledger.close() }
    const run = vi.spyOn(runner, 'run')
    const error = await runLinuxPreparedChecks({ ...f.input, config, runner }).catch(error => error)
    expect(error.message).toContain('grant budget exhausted')
    expect(run).toHaveBeenCalledOnce()
    expect(consumeLinuxSourceNotStarted(error, { runner, key: f.input.sourceJob.id })).toBe(true)
    expect(consumeLinuxSourceNotStarted(error, { runner, key: f.input.sourceJob.id })).toBe(false)
    expect(await runner.inspectQuiescence(f.input.sourceJob.id)).toBe('unknown')
    const observed = new DatabaseSync(join(config.stateRoot, 'ledger.sqlite'))
    try { expect(observed.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(1) } finally { observed.close() }
  } finally { await runner.close() }
}, 15_000)
