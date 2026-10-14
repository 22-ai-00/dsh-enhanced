import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { dshHomeLifecycleRendezvousPath, withDshHomeLifecycleLock } from '../src/setup.ts'

const supportedHost = process.platform === 'linux' || process.platform === 'darwin'
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const roots: string[] = []
const lockPaths: string[] = []

async function homeFixture(): Promise<{ root: string; home: string; alias: string; lockPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-lifecycle-lock-'))
  roots.push(root)
  const home = join(root, 'home')
  const alias = join(root, 'home-alias')
  await mkdir(home)
  await symlink(home, alias)
  const lockPath = dshHomeLifecycleRendezvousPath(home)
  lockPaths.push(lockPath)
  return { root, home, alias, lockPath }
}

function useDarwinBranch(): void {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
}

function perlContender(lockPath: string): ReturnType<typeof spawnSync> {
  return spawnSync('/usr/bin/perl', ['-MFcntl=:flock', '-MErrno=EAGAIN,EWOULDBLOCK', '-e',
    'open(F, "+<", $ARGV[0]) or exit 74; flock(F, LOCK_EX|LOCK_NB) or exit(($! == EAGAIN || $! == EWOULDBLOCK) ? 75 : 74);',
    lockPath], { encoding: 'utf8', timeout: 5_000 })
}

async function startPerlHolder(lockPath: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn('/usr/bin/perl', ['-MFcntl=:flock', '-e',
    '$| = 1; open(F, "+<", $ARGV[0]) or die $!; flock(F, LOCK_EX) or die $!; print "locked\\n"; sleep 30;',
    lockPath], { stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Perl lock holder did not become ready')), 5_000)
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.off('error', onError)
        child.off('close', onClose)
        if (error) reject(error)
        else resolve()
      }
      const onData = (chunk: Buffer): void => {
        if (chunk.toString('utf8').includes('locked\n')) finish()
      }
      const onError = (error: Error): void => finish(error)
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        finish(new Error(`Perl lock holder exited before readiness: ${code ?? signal}`))
      }
      child.stdout.on('data', onData)
      child.once('error', onError)
      child.once('close', onClose)
    })
    return child
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  }
}

afterEach(async () => {
  Object.defineProperty(process, 'platform', originalPlatform)
  for (const lockPath of lockPaths.splice(0)) await rm(lockPath, { force: true })
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe.runIf(supportedHost)('Darwin DSH_HOME lifecycle lock', () => {
  test('holds the same lock across processes and canonical Home aliases until operation returns', async () => {
    const { home, alias, lockPath } = await homeFixture()
    expect(dshHomeLifecycleRendezvousPath(alias)).toBe(lockPath)
    useDarwinBranch()
    let release!: () => void
    let entered!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    const holder = withDshHomeLifecycleLock(home, async () => {
      entered()
      await hold
      return 'completed'
    })
    try {
      await ready
      expect(perlContender(lockPath).status).toBe(75)
      const operation = vi.fn(async () => 'unexpected')
      await expect(withDshHomeLifecycleLock(alias, operation)).rejects.toThrow('DSH_HOME lifecycle is busy')
      expect(operation).not.toHaveBeenCalled()
    } finally {
      release()
    }
    await expect(holder).resolves.toBe('completed')
    expect(perlContender(lockPath).status).toBe(0)
  })

  test('rejects a contended lock and reacquires it after its other process is killed', async () => {
    const { home, lockPath } = await homeFixture()
    useDarwinBranch()
    await withDshHomeLifecycleLock(home, async () => {})
    const child = await startPerlHolder(lockPath)
    try {
      const operation = vi.fn(async () => 'unexpected')
      await expect(withDshHomeLifecycleLock(home, operation)).rejects.toThrow('DSH_HOME lifecycle is busy')
      expect(operation).not.toHaveBeenCalled()
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child.once('close', (code, signal) => resolve({ code, signal }))
      })
      expect(child.kill('SIGKILL')).toBe(true)
      await expect(closed).resolves.toEqual({ code: null, signal: 'SIGKILL' })
      await expect(withDshHomeLifecycleLock(home, async () => 'recovered')).resolves.toBe('recovered')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })

  test('rejects a symlink rendezvous file before invoking the operation', async () => {
    const { root, home, lockPath } = await homeFixture()
    const target = join(root, 'target')
    await writeFile(target, 'untouched')
    await symlink(target, lockPath)
    useDarwinBranch()
    const operation = vi.fn(async () => 'unexpected')
    await expect(withDshHomeLifecycleLock(home, operation)).rejects.toThrow('lifecycle rendezvous lock is unsafe')
    expect(operation).not.toHaveBeenCalled()
  })
})
