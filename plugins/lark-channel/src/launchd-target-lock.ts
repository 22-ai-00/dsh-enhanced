import { spawnSync } from 'node:child_process'
import { constants, realpathSync } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

/** The launchd label is shared by every DSH_HOME for this GUI user. */
export async function withLaunchAgentTargetLock<T>(
  input: { profile: string; uid?: number }, operation: () => Promise<T>,
): Promise<T> {
  const uid = input.uid ?? process.getuid?.()
  if (!profilePattern.test(input.profile) || !Number.isSafeInteger(uid) || uid === undefined || uid < 1) {
    throw new Error('lark-channel setup: invalid launchd target lock identity')
  }
  const temporary = await lstat(realpathSync('/tmp'))
  if (!temporary.isDirectory() || temporary.isSymbolicLink() || temporary.uid !== 0
    || (temporary.mode & 0o7777) !== 0o1777) {
    throw new Error('lark-channel setup: unsafe launchd target lock directory')
  }
  const lockPath = `/tmp/.dsh-enhanced-launchd-${uid}-${input.profile}.lock`
  let descriptor: Awaited<ReturnType<typeof open>> | undefined
  try {
    descriptor = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    const assertIdentity = async () => {
      const [opened, linked] = await Promise.all([descriptor!.stat(), lstat(lockPath)])
      if (!opened.isFile() || !linked.isFile() || linked.isSymbolicLink()
        || opened.uid !== uid || linked.uid !== uid || opened.nlink !== 1 || linked.nlink !== 1
        || (opened.mode & 0o777) !== 0o600 || (linked.mode & 0o777) !== 0o600
        || opened.dev !== linked.dev || opened.ino !== linked.ino) {
        throw new Error(`lark-channel setup: unsafe launchd target lock: ${lockPath}`)
      }
    }
    await assertIdentity()
    const acquired = spawnSync('/usr/bin/perl', ['-MFcntl=:flock', '-MErrno=EAGAIN,EWOULDBLOCK', '-e',
      'open(F, "<&", 3) or exit 74; flock(F, LOCK_EX|LOCK_NB) or exit(($! == EAGAIN || $! == EWOULDBLOCK) ? 75 : 74);'], {
      encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe', descriptor.fd],
      env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 10_000,
    })
    if (acquired.status === 75) throw new Error(`lark-channel setup: launchd target is busy: ${lockPath}`)
    if (acquired.status !== 0) {
      const detail = acquired.stderr?.trim().slice(0, 1_000)
      throw new Error(`lark-channel setup: cannot acquire launchd target lock${detail ? `: ${detail}` : ''}`)
    }
    await assertIdentity()
    return await operation()
  } finally {
    await descriptor?.close()
  }
}
