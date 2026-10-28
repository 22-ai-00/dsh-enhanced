import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, rmdir, writeFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { LinuxCgroupLease, type LinuxCgroupRoots } from '../src/linux-cgroups.js'

// Delay one real controller read so cancellation interleavings are repeatable.
// All filesystem operations still go to the actual kernel cgroup mounts.
const barrier = vi.hoisted(() => ({ path: '', skip: 0, wait: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (...args: unknown[]) => {
    if (args[0] === barrier.path && barrier.wait) {
      if (barrier.skip > 0) barrier.skip--
      else {
        const waiting = barrier.wait
        barrier.wait = undefined
        barrier.entered?.()
        await waiting
      }
    }
    return Reflect.apply(actual.readFile, actual, args)
  } }
})

const owner = process.getuid?.() ?? 0
const supported = process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch) && owner > 0
const roots: LinuxCgroupRoots = { mode: 'v1', cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${owner}`,
  memory: `/sys/fs/cgroup/memory/dsh-native/uid-${owner}`, pids: `/sys/fs/cgroup/pids/dsh-native/uid-${owner}`,
  freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${owner}` }
const create = (overrides: Record<string, unknown> = {}) => LinuxCgroupLease.create({ roots, jobId: randomUUID(),
  nonce: randomBytes(16).toString('hex'), limits: { memoryMiB: 128, pidsLimit: 32, cpus: 0.5 }, deadline: Date.now() + 30_000,
  ...overrides })

function blockedChild(): ChildProcess {
  return spawn('/usr/bin/python3', ['-c', 'import sys,time;sys.stdin.buffer.read(1);time.sleep(30)'],
    { stdio: ['pipe', 'ignore', 'pipe'] })
}
async function identity(lease: LinuxCgroupLease, child: ChildProcess) {
  const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8')
  return { pid: child.pid!, startTicks: stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/u)[19]!,
    bootId: lease.snapshot.bootId, uid: owner }
}
function delayRead(path: string, skip = 0): { entered: Promise<void>; release(): void } {
  let release!: () => void
  const entered = new Promise<void>(resolveEntered => { barrier.entered = resolveEntered })
  barrier.path = path
  barrier.skip = skip
  barrier.wait = new Promise<void>(resolveWait => { release = resolveWait })
  return { entered, release: () => {
    release()
    barrier.wait = undefined
    barrier.entered = undefined
    barrier.path = ''
  } }
}

describe('Linux cgroup boundary', () => {
  it.runIf(!supported)('rejects unsupported hosts before accessing controller files', async () => {
    await expect(create()).rejects.toThrow('non-root Linux x64/arm64 is required')
  })
  it.runIf(supported)('rejects malformed and expired job authority before touching controllers', async () => {
    await expect(create({ jobId: 'not-a-uuid' })).rejects.toThrow('invalid job identity')
    await expect(create({ deadline: Date.now() - 1 })).rejects.toThrow('invalid job identity')
    await expect(create({ roots: { ...roots, cpu: '/sys/fs/cgroup/pids/dsh-native/uid-1' } })).rejects.toThrow('delegated root')
    await expect(create({ limits: { memoryMiB: 0, pidsLimit: 32, cpus: 1 } })).rejects.toThrow('invalid resource limits')
    await expect(create({ roots: { mode: 'v2', unified: `/sys/fs/cgroup/dsh-native/uid-${owner}` } })).rejects.toThrow('v2 process placement is not yet verified')
  })

  it.runIf(process.env.DSH_NATIVE_CGROUP_REAL === '1')('consumes one admission attempt before any asynchronous verification', async () => {
    const lease = await create(), first = blockedChild(), second = blockedChild()
    try {
      const [firstIdentity, secondIdentity] = await Promise.all([identity(lease, first), identity(lease, second)])
      const firstAdmission = lease.admit(firstIdentity)
      const secondAdmission = lease.admit(secondIdentity)
      const outcomes = await Promise.allSettled([firstAdmission, secondAdmission])
      expect(outcomes[0].status).toBe('fulfilled')
      expect(outcomes[1].status).toBe('rejected')
      expect((await lease.observe()).processes.freezer).toEqual([first.pid])
    } finally {
      first.kill('SIGKILL'); second.kill('SIGKILL')
      expect(await lease.terminateAndProve(5_000)).toBe(true)
      expect(await lease.removeWhenEmpty()).toBe(true)
    }
  }, 15_000)

  it.runIf(process.env.DSH_NATIVE_CGROUP_REAL === '1')('waits for pending admission before termination and deletion', async () => {
    const lease = await create(), child = blockedChild()
    const childIdentity = await identity(lease, child)
    const delayed = delayRead('/proc/sys/kernel/random/boot_id')
    const admission = lease.admit(childIdentity).then(() => 'admitted', () => 'rejected')
    let settled = false
    let termination: Promise<boolean> | undefined, removal: Promise<boolean> | undefined
    try {
      await delayed.entered
      termination = lease.terminateAndProve(5_000)
      removal = lease.removeWhenEmpty().then(value => { settled = true; return value })
      await pause(40)
      expect(settled).toBe(false)
      delayed.release()
      expect(await admission).toBe('rejected')
      expect(await termination).toBe(true)
      expect(await removal).toBe(true)
      await expect(lease.admit(childIdentity)).rejects.toThrow('no longer admits')
    } finally {
      delayed.release()
      child.kill('SIGKILL')
      await admission
      await Promise.allSettled([termination, removal])
      expect(await lease.terminateAndProve(5_000)).toBe(true)
      expect(await lease.removeWhenEmpty()).toBe(true)
    }
  }, 15_000)

  it.runIf(process.env.DSH_NATIVE_CGROUP_REAL === '1')('rejects a late admission result and kills its already admitted gate', async () => {
    const lease = await create(), child = blockedChild()
    const childIdentity = await identity(lease, child)
    const delayed = delayRead(`${lease.snapshot.directories.memory!.path}/memory.limit_in_bytes`, 1)
    const admission = lease.admit(childIdentity).then(() => 'admitted', () => 'rejected')
    let termination: Promise<boolean> | undefined
    try {
      await delayed.entered
      const membership = await readFile(`/proc/${child.pid}/cgroup`, 'utf8')
      expect(membership).toContain(`freezer:/dsh-native/uid-${owner}/job-${lease.snapshot.jobId}-${lease.snapshot.nonce}`)
      termination = lease.terminateAndProve(5_000)
      delayed.release()
      expect(await admission).toBe('rejected')
      expect(await termination).toBe(true)
      expect((await lease.observe()).quiescent).toBe(true)
      expect(await lease.removeWhenEmpty()).toBe(true)
    } finally {
      delayed.release()
      child.kill('SIGKILL')
      await admission
      await termination
      expect(await lease.terminateAndProve(5_000)).toBe(true)
      expect(await lease.removeWhenEmpty()).toBe(true)
    }
  }, 15_000)

  it.runIf(process.env.DSH_NATIVE_CGROUP_REAL === '1')('keeps a failed identity check closed to subsequent admission attempts', async () => {
    const lease = await create(), child = blockedChild()
    try {
      const expected = await identity(lease, child)
      await expect(lease.admit({ ...expected, startTicks: `${Number(expected.startTicks) + 1}` })).rejects.toThrow('process identity differs')
      await expect(lease.admit(expected)).rejects.toThrow('no longer admits')
    } finally {
      child.kill('SIGKILL')
      expect(await lease.terminateAndProve(5_000)).toBe(true)
      expect(await lease.removeWhenEmpty()).toBe(true)
    }
  }, 15_000)

  it.runIf(process.env.DSH_NATIVE_CGROUP_REAL === '1')('rechecks the admission deadline after its asynchronous controller verification', async () => {
    const lease = await create(), child = blockedChild()
    const childIdentity = await identity(lease, child)
    const delayed = delayRead(`${lease.snapshot.directories.memory!.path}/memory.limit_in_bytes`, 1)
    const admission = lease.admit(childIdentity).then(() => 'admitted', () => 'rejected')
    let clock: ReturnType<typeof vi.spyOn> | undefined
    try {
      await delayed.entered
      clock = vi.spyOn(Date, 'now').mockReturnValue(lease.snapshot.deadline)
      delayed.release()
      expect(await admission).toBe('rejected')
    } finally {
      delayed.release()
      clock?.mockRestore()
      child.kill('SIGKILL')
      await admission
      expect(await lease.terminateAndProve(5_000)).toBe(true)
      expect(await lease.removeWhenEmpty()).toBe(true)
    }
  }, 15_000)

  it.runIf(process.env.DSH_NATIVE_CGROUP_REAL === '1')('enforces real limits, process identity, descendant termination, and resource cleanup', async () => {
    const lease = await create()
    let removed = false
    const child = spawn('/usr/bin/python3', ['-c', 'import subprocess,sys,time; sys.stdin.buffer.read(1); subprocess.Popen(["/usr/bin/sleep","30"]); time.sleep(30)'],
      { stdio: ['pipe', 'ignore', 'pipe'] })
    try {
      const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8')
      const ticks = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/u)[19]!
      await lease.admit({ pid: child.pid!, startTicks: ticks, bootId: lease.snapshot.bootId, uid: owner })
      await expect(LinuxCgroupLease.recover({ ...lease.snapshot, directories: {
        ...lease.snapshot.directories, cpu: { ...lease.snapshot.directories.cpu!, ino: lease.snapshot.directories.cpu!.ino + 1 },
      } })).rejects.toThrow('identity changed')
      await expect(LinuxCgroupLease.recover(lease.snapshot)).resolves.toBeDefined()
      const group = await readFile(`/proc/${child.pid}/cgroup`, 'utf8')
      expect(group).toContain(`freezer:/dsh-native/uid-${owner}/job-${lease.snapshot.jobId}-${lease.snapshot.nonce}`)
      expect(lease.snapshot.limits).toEqual({ memoryMiB: 128, pidsLimit: 32, cpus: 0.5 })
      child.stdin?.write('x')
      await pause(200)
      expect((await lease.observe()).quiescent).toBe(false)
      expect(await lease.terminateAndProve(5_000)).toBe(true)
      expect(await lease.removeWhenEmpty()).toBe(true)
      removed = true
      const recovered = await LinuxCgroupLease.recover(lease.snapshot)
      expect(await recovered.removeWhenEmpty()).toBe(true)
    } finally {
      child.kill('SIGKILL')
      if (!removed) {
        const stopped = await lease.terminateAndProve(5_000).catch(() => false)
        if (stopped) await lease.removeWhenEmpty().catch(() => undefined)
      }
    }
  }, 15_000)

  it.runIf(process.env.DSH_NATIVE_CGROUP_REAL === '1')('enforces the kernel PID limit on children', async () => {
    const lease = await create({ limits: { memoryMiB: 128, pidsLimit: 2, cpus: 0.5 } })
    let removed = false
    const code = 'import subprocess,sys,time; sys.stdin.buffer.read(1); first=subprocess.Popen(["/usr/bin/sleep","30"]);\ntry: second=subprocess.Popen(["/usr/bin/sleep","30"]); print("unexpected",flush=True)\nexcept OSError: print("blocked",flush=True)\ntime.sleep(30)'
    const child = spawn('/usr/bin/python3', ['-c', code], { stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8')
      const ticks = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/u)[19]!
      await lease.admit({ pid: child.pid!, startTicks: ticks, bootId: lease.snapshot.bootId, uid: owner })
      const response = new Promise<string>((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error('child did not report PID limit')), 3000)
        child.stdout?.once('data', (chunk: Buffer) => { clearTimeout(timer); resolvePromise(chunk.toString('utf8').trim()) })
      })
      child.stdin?.write('x')
      expect(await response).toBe('blocked')
      expect(await lease.terminateAndProve(5_000)).toBe(true)
      expect(await lease.removeWhenEmpty()).toBe(true)
      removed = true
    } finally {
      child.kill('SIGKILL')
      if (!removed) {
        const stopped = await lease.terminateAndProve(5_000).catch(() => false)
        if (stopped) await lease.removeWhenEmpty().catch(() => undefined)
      }
    }
  }, 15_000)

  it.runIf(process.env.DSH_NATIVE_CGROUP_REAL === '1')('enforces memory and swap limits rather than relying on readback', async () => {
    const lease = await create({ limits: { memoryMiB: 32, pidsLimit: 8, cpus: 1 } })
    let removed = false
    const child = spawn('/usr/bin/python3', ['-c', 'import sys;sys.stdin.buffer.read(1);memory=bytearray(128*1024*1024);memory[:]=b"x"*len(memory)'],
      { stdio: ['pipe', 'ignore', 'pipe'] })
    try {
      const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8')
      const ticks = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/u)[19]!
      await lease.admit({ pid: child.pid!, startTicks: ticks, bootId: lease.snapshot.bootId, uid: owner })
      const memory = lease.snapshot.directories.memory!.path
      const before = Number((await readFile(`${memory}/memory.failcnt`, 'utf8')).trim())
      const beforeSwap = Number((await readFile(`${memory}/memory.memsw.failcnt`, 'utf8')).trim())
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error('memory-limit process did not exit')), 5_000)
        child.once('exit', (code, signal) => { clearTimeout(timer); resolvePromise({ code, signal }) })
      })
      child.stdin?.write('x')
      expect((await exited).signal).toBe('SIGKILL')
      const failures = Number((await readFile(`${memory}/memory.failcnt`, 'utf8')).trim()) - before
        + Number((await readFile(`${memory}/memory.memsw.failcnt`, 'utf8')).trim()) - beforeSwap
      expect(failures).toBeGreaterThan(0)
      expect(await lease.terminateAndProve(5_000)).toBe(true)
      expect(await lease.removeWhenEmpty()).toBe(true)
      removed = true
    } finally {
      child.kill('SIGKILL')
      if (!removed) {
        const stopped = await lease.terminateAndProve(5_000).catch(() => false)
        if (stopped) await lease.removeWhenEmpty().catch(() => undefined)
      }
    }
  }, 15_000)

  it.runIf(process.env.DSH_NATIVE_CGROUP_REAL === '1')('enforces the CPU quota with kernel throttling', async () => {
    const lease = await create({ limits: { memoryMiB: 128, pidsLimit: 8, cpus: 0.1 } })
    let removed = false
    const child = spawn('/usr/bin/python3', ['-c', 'import sys,time;sys.stdin.buffer.read(1);end=time.monotonic()+1.0\nwhile time.monotonic()<end: pass'],
      { stdio: ['pipe', 'ignore', 'pipe'] })
    try {
      const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8')
      const ticks = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/u)[19]!
      await lease.admit({ pid: child.pid!, startTicks: ticks, bootId: lease.snapshot.bootId, uid: owner })
      const cpu = lease.snapshot.directories.cpu!.path
      const throttled = async (): Promise<number> => {
        const value = /(?:^|\n)nr_throttled\s+(\d+)/u.exec(await readFile(`${cpu}/cpu.stat`, 'utf8'))
        if (!value) throw new Error('CPU throttling counter unavailable')
        return Number(value[1])
      }
      const before = await throttled()
      const exited = new Promise<number | null>((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error('CPU-limit process did not exit')), 5_000)
        child.once('exit', code => { clearTimeout(timer); resolvePromise(code) })
      })
      child.stdin?.write('x')
      expect(await exited).toBe(0)
      expect(await throttled()).toBeGreaterThan(before)
      expect(await lease.terminateAndProve(5_000)).toBe(true)
      expect(await lease.removeWhenEmpty()).toBe(true)
      removed = true
    } finally {
      child.kill('SIGKILL')
      if (!removed) {
        const stopped = await lease.terminateAndProve(5_000).catch(() => false)
        if (stopped) await lease.removeWhenEmpty().catch(() => undefined)
      }
    }
  }, 15_000)

  it.runIf(process.env.DSH_NATIVE_CGROUP_REAL === '1')('refuses nested cgroups that could hide live children', async () => {
    const lease = await create()
    const nested = `${lease.snapshot.directories.freezer!.path}/nested`
    await mkdir(nested)
    try { await expect(lease.observe()).rejects.toThrow('nested or linked cgroup') }
    finally { await rmdir(nested); expect(await lease.removeWhenEmpty()).toBe(true) }
  }, 15_000)

  it.runIf(process.env.DSH_NATIVE_CGROUP_REAL === '1')('recovers a partially removed empty resource set without replay', async () => {
    const lease = await create()
    await rmdir(lease.snapshot.directories.cpu!.path)
    const recovered = await LinuxCgroupLease.recover(lease.snapshot)
    expect((await recovered.observe()).quiescent).toBe(true)
    expect(await recovered.terminateAndProve(5_000)).toBe(true)
    expect(await recovered.removeWhenEmpty()).toBe(true)
    expect(await recovered.terminateAndProve(5_000)).toBe(true)
    expect(await recovered.removeWhenEmpty()).toBe(true)
  }, 15_000)

  it.runIf(process.env.DSH_NATIVE_CGROUP_REAL === '1')('does not prove termination with a missing freezer and a live process in another controller', async () => {
    const lease = await create(), child = blockedChild()
    const closed = new Promise<void>(resolveClosed => child.once('close', () => resolveClosed()))
    try {
      // Simulate a historical partial placement. The retained ChildProcess is
      // the only safe authority to stop a gate absent from the freezer group.
      await writeFile(`${lease.snapshot.directories.cpu!.path}/cgroup.procs`, `${child.pid}\n`)
      await rmdir(lease.snapshot.directories.freezer!.path)
      const recovered = await LinuxCgroupLease.recover(lease.snapshot)
      expect(await recovered.terminateAndProve(100)).toBe(false)
      expect(await recovered.removeWhenEmpty()).toBe(false)
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()
    } finally {
      child.kill('SIGKILL')
      await closed
      const recovered = await LinuxCgroupLease.recover(lease.snapshot)
      expect(await recovered.terminateAndProve(5_000)).toBe(true)
      expect(await recovered.removeWhenEmpty()).toBe(true)
    }
  }, 15_000)
})
