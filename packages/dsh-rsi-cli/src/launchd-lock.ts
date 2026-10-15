import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'

/** Shared with lark-channel: one launchd label per GUI uid/profile, across all Homes. */
export async function withLaunchdProfileLock<T>(profile: string, operation: () => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile)) throw new Error('非法 launchd profile 名')
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 1) throw new Error('无法确定非 root launchd 用户 UID')
  const physicalTmp = realpathSync('/tmp')
  const temporary = await lstat(physicalTmp)
  if (!temporary.isDirectory() || temporary.isSymbolicLink() || temporary.uid !== 0
    || (temporary.mode & 0o7777) !== 0o1777) throw new Error('launchd 锁目录 /tmp 不安全')
  const path = join('/tmp', `.dsh-enhanced-launchd-${uid}-${profile}.lock`)
  const descriptor = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    const verify = async (): Promise<void> => {
      const [opened, linked] = await Promise.all([descriptor.stat(), lstat(path)])
      if (!opened.isFile() || !linked.isFile() || opened.uid !== uid || linked.uid !== uid
        || opened.nlink !== 1 || linked.nlink !== 1
        || (opened.mode & 0o777) !== 0o600 || (linked.mode & 0o777) !== 0o600
        || opened.dev !== linked.dev || opened.ino !== linked.ino) throw new Error(`launchd 锁文件不安全：${path}`)
    }
    await verify()
    const result = spawnSync('/usr/bin/perl', ['-MFcntl=:flock', '-MErrno=EAGAIN,EWOULDBLOCK', '-e',
      'open(F, "<&", 3) or exit 74; flock(F, LOCK_EX|LOCK_NB) or exit(($! == EAGAIN || $! == EWOULDBLOCK) ? 75 : 74);'], {
      encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe', descriptor.fd],
      env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 10_000,
    })
    if (result.status === 75) throw new Error(`launchd profile 正忙：${path}`)
    if (result.status !== 0) throw new Error(`无法获取 launchd 锁：${result.stderr?.trim() || result.status}`)
    await verify()
    return await operation()
  } finally {
    await descriptor.close()
  }
}
