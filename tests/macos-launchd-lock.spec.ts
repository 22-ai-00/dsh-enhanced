import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { withLaunchdProfileLock } from '../packages/dsh-rsi-cli/src/launchd-lock.ts'
import { withLaunchAgentTargetLock } from '../plugins/lark-channel/src/launchd-target-lock.ts'
import { dshHomeLifecycleRendezvousPath as cliHomeLockPath,
  withDshHomeLifecycleLock as withCliHomeLock } from '../packages/dsh-rsi-cli/src/home-lifecycle-lock.ts'
import { dshHomeLifecycleRendezvousPath as installerHomeLockPath,
  withDshHomeLifecycleLock as withInstallerHomeLock } from '../plugins/lark-channel/src/setup.ts'

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'CLI and installer exclude each other on the same launchd target and release on failure', async () => {
    const profile = `lock-test-${process.pid}-${randomBytes(6).toString('hex')}`
    const path = `/tmp/.dsh-enhanced-launchd-${process.getuid?.()}-${profile}.lock`
    try {
      await withLaunchdProfileLock(profile, async () => {
        await expect(withLaunchAgentTargetLock({ profile }, async () => 'unexpected')).rejects.toThrow('busy')
      })
      await expect(withLaunchAgentTargetLock({ profile }, async () => {
        await expect(withLaunchdProfileLock(profile, async () => 'unexpected')).rejects.toThrow('正忙')
        throw new Error('operation failed')
      })).rejects.toThrow('operation failed')
      await expect(withLaunchdProfileLock(profile, async () => 'released')).resolves.toBe('released')
    } finally {
      // The fixture owns this random target; production locks are never unlinked.
      await rm(path, { force: true })
    }
  },
)

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'purge and setup share the Home lock across aliases, missing Homes and failures', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mac-home-lock-')))
    const parent = join(root, 'parent'), alias = join(root, 'alias'), home = join(parent, 'home')
    await mkdir(home, { recursive: true })
    await symlink(parent, alias)
    const aliasHome = join(alias, 'home'), path = cliHomeLockPath(home)
    try {
      expect(cliHomeLockPath(aliasHome)).toBe(path)
      expect(installerHomeLockPath(aliasHome)).toBe(path)
      await withCliHomeLock(home, async () => {
        await expect(withInstallerHomeLock(aliasHome, async () => 'unexpected')).rejects.toThrow('busy')
        await rm(home, { recursive: true })
        expect(cliHomeLockPath(aliasHome)).toBe(path)
        expect(installerHomeLockPath(aliasHome)).toBe(path)
        await expect(withInstallerHomeLock(aliasHome, async () => 'unexpected')).rejects.toThrow('busy')
      })
      await expect(withInstallerHomeLock(aliasHome, async () => {
        await expect(withCliHomeLock(home, async () => 'unexpected')).rejects.toThrow(/busy|正忙/u)
        throw new Error('setup failed')
      })).rejects.toThrow('setup failed')
      await expect(withCliHomeLock(home, async () => 'released')).resolves.toBe('released')
    } finally {
      await rm(path, { force: true })
      await rm(root, { recursive: true, force: true })
    }
  },
)
