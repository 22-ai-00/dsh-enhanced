import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

/** Match lark-channel setup's canonicalMissingAllowed-style lock key, including a deleted Home. */
function canonicalMissingAllowed(path: string): string {
  try { return realpathSync(path) } catch {
    const parent = dirname(path)
    if (parent === path) return join(path)
    return join(canonicalMissingAllowed(parent), basename(path))
  }
}

export function dshHomeLifecycleRendezvousPath(dshHome: string, uid = process.getuid?.()): string {
  if (!isAbsolute(dshHome)) throw new Error('DSH_HOME 必须是绝对路径')
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) throw new Error('无法确定 Home 锁 UID')
  const digest = createHash('sha256').update(canonicalMissingAllowed(dshHome)).digest('hex')
  return `/tmp/.dsh-enhanced-lifecycle-${uid}-${digest}.lock`
}

/** Shared with lark-channel: kernel lock remains held while purge removes the Home. */
export async function withDshHomeLifecycleLock<T>(dshHome: string, operation: () => Promise<T>): Promise<T> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return operation()
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) throw new Error('无法确定 Home 锁 UID')
  const physicalTmp = process.platform === 'darwin' ? realpathSync('/tmp') : '/tmp'
  const temporary = await lstat(physicalTmp)
  if (!temporary.isDirectory() || temporary.isSymbolicLink() || temporary.uid !== 0
    || (temporary.mode & 0o7777) !== 0o1777) throw new Error('Home 锁目录 /tmp 不安全')
  const path = dshHomeLifecycleRendezvousPath(dshHome, uid)
  const descriptor = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    const verify = async (): Promise<void> => {
      const [opened, linked] = await Promise.all([descriptor.stat(), lstat(path)])
      if (!opened.isFile() || !linked.isFile() || linked.isSymbolicLink()
        || opened.uid !== uid || linked.uid !== uid || opened.nlink !== 1 || linked.nlink !== 1
        || (opened.mode & 0o777) !== 0o600 || (linked.mode & 0o777) !== 0o600
        || opened.dev !== linked.dev || opened.ino !== linked.ino) throw new Error(`Home 锁文件不安全：${path}`)
    }
    await verify()
    const mac = process.platform === 'darwin'
    const acquired = spawnSync(mac ? '/usr/bin/perl' : '/usr/bin/flock', mac
      ? ['-MFcntl=:flock', '-MErrno=EAGAIN,EWOULDBLOCK', '-e',
        'open(F, "<&", 3) or exit 74; flock(F, LOCK_EX|LOCK_NB) or exit(($! == EAGAIN || $! == EWOULDBLOCK) ? 75 : 74);']
      : ['-n', '-E', '75', '3'], {
      encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe', descriptor.fd],
      env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 10_000,
    })
    if (acquired.status === 75) throw new Error(`DSH_HOME 正忙：${path}`)
    if (acquired.status !== 0) throw new Error(`无法获取 Home 锁：${acquired.stderr?.trim() || acquired.status}`)
    await verify()
    return await operation()
  } finally {
    await descriptor.close()
  }
}
