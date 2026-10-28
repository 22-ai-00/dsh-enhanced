import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import type { LinuxRuntime } from '../src/linux-runtime.js'

const barrier = vi.hoisted(() => ({ verify: vi.fn() }))
vi.mock('../src/linux-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/linux-runtime.js')>(),
  verifyLinuxRuntime: barrier.verify,
}))
import { LinuxVerifierRunner } from '../src/linux-verifier-runner.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

// The controlled verification barrier is below the behavior wrapper. It proves
// that cancelling this second, pre-admission check cannot spend a run or keep
// the actual SQLite/controller lifecycle open. No candidate is launched.
test.runIf(process.platform === 'linux' && !!process.getuid?.()).each(['caller', 'close'] as const)(
  '%s cancels underlying runtime validation and drains without admission', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'linux-verifier-cancel-')), uid = process.getuid!()
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const runtimeRoot = join(root, 'toolchain')
    const runtime: LinuxRuntime = { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as LinuxRuntime['platform'],
      sourceCommit: '1'.repeat(40), lockSha256: '2'.repeat(64), nodeSha256: '3'.repeat(64),
      root: { path: runtimeRoot, dev: 1, ino: 1, sha256: '4'.repeat(64) }, nodePath: join(runtimeRoot, 'bin/node'),
      pnpmPath: join(runtimeRoot, 'pnpm/bin/pnpm.mjs'), nativePnpmPath: join(runtimeRoot, 'pnpm-native/pnpm'),
      nativePnpmRoot: join(runtimeRoot, 'pnpm-native'), modulesPath: join(runtimeRoot, 'node_modules'),
      storePath: join(runtimeRoot, 'store'), cachePath: join(runtimeRoot, 'cache'),
      versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } }
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    barrier.verify.mockImplementation((_runtime: LinuxRuntime, signal?: AbortSignal) => new Promise((_resolve, reject) => {
      if (!signal) { reject(new Error('missing validation cancellation')); return }
      const abort = () => reject(new Error('runtime validation cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      entered()
      if (signal.aborted) abort()
    }))
    const stateRoot = join(root, 'state')
    const runner = new LinuxVerifierRunner({ backend: 'linux-native', stateRoot, runtime,
      authorityDigest: 'a'.repeat(64), command: 'exit 0', expiresAt: Date.now() + 60_000,
      maxRuns: 1, maxTotalDurationMs: 1000, maxDurationMs: 1000, maxOutputBytes: 4096,
      cgroupRoots: { mode: 'v1', cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`,
        memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`, pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`,
        freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}` } })
    cleanups.push(() => runner.close())
    const caller = new AbortController()
    const pending = expect(runner.run('cancel-before-admission', '', '', caller.signal)).rejects.toThrow('runtime validation cancelled')
    await started
    if (mode === 'caller') caller.abort()
    else await runner.close()
    await pending
    await runner.close()
    const db = new DatabaseSync(join(stateRoot, 'ledger.sqlite'), { readOnly: true })
    try { expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(0) }
    finally { db.close() }
  }, 5000)
