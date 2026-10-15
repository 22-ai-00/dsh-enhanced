import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { inspectLaunchdDefinition, inspectLoadedLaunchd } from '../packages/dsh-rsi-cli/src/launchd-service.ts'
import { controlManagedService, stopManagedService } from '../packages/dsh-rsi-cli/src/services.ts'
import { defaultRunner } from '../packages/dsh-rsi-cli/src/run.ts'
import { installDshLaunchAgent, launchAgentPaths } from '../plugins/lark-channel/src/launchd.ts'

test.skipIf(process.platform !== 'darwin' || process.env.DSH_NATIVE_LAUNCHD_TEST !== '1')(
  'real GUI launchd shares service identity between installer and CLI restart/stop', async context => {
    const uid = process.getuid?.()
    if (uid === undefined || uid === 0) {
      console.warn('cross-package launchd smoke skipped: non-root GUI user unavailable')
      context.skip(); return
    }
    const domain = `gui/${uid}`
    const gui = spawnSync('/bin/launchctl', ['print', domain], { encoding: 'utf8', timeout: 10_000 })
    if (gui.status !== 0) {
      console.warn(`cross-package launchd smoke skipped: GUI domain ${domain} unavailable`)
      context.skip(); return
    }
    const home = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-cli-launchd-smoke-')))
    const dshHome = join(home, '.dsh'), profile = `cli-smoke-${randomUUID().slice(0, 8)}`
    const dshPath = join(home, 'resident.mjs')
    const paths = launchAgentPaths({ home, dshHome, profile })
    const target = `${domain}/${paths.label}`
    let attempted = false
    try {
      await mkdir(join(dshHome, 'profiles', profile), { recursive: true, mode: 0o700 })
      await writeFile(dshPath, 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)\n', { mode: 0o700 })
      const absent = spawnSync('/bin/launchctl', ['print', target], { encoding: 'utf8', timeout: 10_000 })
      expect(absent.status).toBe(113)
      expect(absent.stderr).toMatch(/Could not find service/iu)
      attempted = true
      await installDshLaunchAgent({ dshHome, profile }, {
        home, uid, nodePath: realpathSync(process.execPath), dshPath,
      })
      const checked = await inspectLaunchdDefinition(home, dshHome, profile)
      expect(checked.error).toBeUndefined()
      expect(checked.definition).toBeDefined()
      const definition = checked.definition!
      const before = inspectLoadedLaunchd(definition, dshHome)
      expect(before).toMatchObject({ registered: true, running: true })
      expect(before.error).toBeUndefined()
      const restarted = await controlManagedService('darwin', home, profile, 'restart', defaultRunner, false, dshHome)
      expect(restarted.errors).toEqual([])
      const after = inspectLoadedLaunchd(definition, dshHome)
      expect(after).toMatchObject({ registered: true, running: true })
      expect(after.error).toBeUndefined()
      expect(after.pid).not.toBe(before.pid)
      const stopped = await stopManagedService('darwin', home, profile, defaultRunner, false, dshHome)
      expect(stopped.errors).toEqual([])
      expect(stopped.skipped).toEqual([])
      expect(inspectLoadedLaunchd(definition, dshHome)).toEqual({ registered: false, pid: 0, running: false })
      await expect(readFile(paths.plistPath)).rejects.toMatchObject({ code: 'ENOENT' })
      console.info(`cross-package launchd smoke passed: running PID ${before.pid} -> ${after.pid}; CLI stop removed job and plist`)
    } catch (error) {
      // This service and all paths are private disposable fixtures; diagnostics
      // contain no user installation or credential environment.
      const detail = spawnSync('/bin/launchctl', ['print', target], { encoding: 'utf8', timeout: 10_000 })
      console.error('cross-package launchd fixture:', detail.stdout?.slice(0, 12_000), detail.stderr)
      console.error('fixture stderr:', (await readFile(paths.stderrPath, 'utf8').catch(() => '')).slice(-4_000))
      throw error
    } finally {
      if (attempted) spawnSync('/bin/launchctl', ['bootout', target], { encoding: 'utf8', timeout: 10_000 })
      await rm(home, { recursive: true, force: true })
      if (attempted) await rm(`/tmp/.dsh-enhanced-launchd-${uid}-${profile}.lock`, { force: true })
    }
  }, 150_000,
)
