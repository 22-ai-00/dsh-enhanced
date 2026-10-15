import { realpathSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createLaunchAgent, inspectDshLaunchAgent, installDshLaunchAgent, launchAgentPaths } from '../src/launchd.ts'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(existing = false, profile = `launchd-${process.pid}-${randomUUID().slice(0, 8)}`) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-launchd-'))
  roots.push(home)
  const dshHome = join(home, '.dsh'), uid = process.getuid!()
  const oldDsh = join(home, 'old.mjs'), newDsh = join(home, 'new.mjs'), nodePath = realpathSync(process.execPath)
  await mkdir(join(dshHome, 'profiles', profile), { recursive: true })
  await writeFile(oldDsh, 'setInterval(() => {}, 1000)\n')
  await writeFile(newDsh, 'setInterval(() => {}, 2000)\n')
  const paths = launchAgentPaths({ home, dshHome, profile })
  const plist = (dshPath: string, homeValue = dshHome) => createLaunchAgent({ ...paths, dshHome: homeValue, profile,
    profileDirectory: join(homeValue, 'profiles', profile), nodePath, dshPath, path: '/usr/bin:/bin' })
  const oldPlist = plist(oldDsh)
  if (existing) {
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    await writeFile(paths.plistPath, oldPlist, { mode: 0o600 })
  }
  const value = (dshPath: string, homeValue = dshHome) => ({ Label: paths.label,
    ProgramArguments: [nodePath, '--disable-warning=ExperimentalWarning', dshPath, '--profile', profile, '--no-open'],
    EnvironmentVariables: { DSH_HOME: homeValue, PATH: '/usr/bin:/bin' },
    WorkingDirectory: join(homeValue, 'profiles', profile), StandardOutPath: paths.stdoutPath,
    StandardErrorPath: paths.stderrPath, LimitLoadToSessionType: 'Aqua', ProcessType: 'Background',
    RunAtLoad: true, KeepAlive: true, ThrottleInterval: 10, ExitTimeOut: 30, Umask: 63 })
  const loaded = (dshPath: string, homeValue = dshHome, pid = 0, forceWaiting = false) =>
    `path = ${paths.plistPath}\nworking directory = ${join(homeValue, 'profiles', profile)}\nDSH_HOME => ${homeValue}\nprogram = ${nodePath}\narguments = {\n  ${nodePath}\n  --disable-warning=ExperimentalWarning\n  ${dshPath}\n  --profile\n  ${profile}\n  --no-open\n}\nstate = ${pid > 1 && !forceWaiting ? 'running' : 'waiting'}\npid = ${pid}\n`
  const calls: string[] = []
  let registered = existing, currentDsh = oldDsh, currentHome = dshHome, parsedHome = dshHome, pid = 0
  let bootstrapPid = 90_000_000, forceWaiting = false
  let inspectionError = false, bootoutFails = false, bootstrapFails = false, bootstrapEio = false
  const run = (command: string, args: readonly string[]) => {
    calls.push(`${command} ${args.join(' ')}`)
    if (command === '/usr/bin/plutil') return args[0] === '-convert'
      ? { status: 0, stdout: JSON.stringify(value(readFileSync(paths.plistPath, 'utf8').includes(newDsh)
        ? newDsh : oldDsh, parsedHome)), stderr: '' }
      : { status: 0, stdout: '', stderr: '' }
    if (args[0] === 'print') return inspectionError
      ? { status: 5, stdout: '', stderr: 'I/O error' }
      : registered ? { status: 0, stdout: loaded(currentDsh, currentHome, pid, forceWaiting), stderr: '' }
        : { status: 113, stdout: '', stderr: 'Could not find service' }
    if (args[0] === 'bootout') {
      if (bootoutFails) return { status: 5, stdout: '', stderr: 'I/O error' }
      registered = false; return { status: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'bootstrap') {
      if (bootstrapFails) return { status: 7, stdout: '', stderr: 'bootstrap failed' }
      registered = true
      currentDsh = readFileSync(paths.plistPath, 'utf8').includes(newDsh) ? newDsh : oldDsh
      currentHome = dshHome
      pid = bootstrapPid
      return { status: bootstrapEio ? 5 : 0, stdout: '', stderr: bootstrapEio ? 'Bootstrap failed: 5: Input/output error' : '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  const options = { home, uid, nodePath, dshPath: newDsh, path: '/usr/bin:/bin', platform: 'darwin' as const,
    run, wait: async (_ms: number) => {} }
  return { home, dshHome, profile, paths, oldDsh, newDsh, oldPlist, value, calls, run, options,
    setRegistered(value: boolean) { registered = value }, setCurrentDsh(value: string) { currentDsh = value },
    setCurrentHome(value: string) { currentHome = value }, setPid(value: number) { pid = value },
    setBootstrapPid(value: number) { bootstrapPid = value }, setForceWaiting(value: boolean) { forceWaiting = value },
    setParsedHome(value: string) { parsedHome = value },
    setInspectionError(value: boolean) { inspectionError = value }, setBootoutFails(value: boolean) { bootoutFails = value },
    setBootstrapFails(value: boolean) { bootstrapFails = value }, setBootstrapEio(value: boolean) { bootstrapEio = value } }
}

describe('DSH profile LaunchAgent', () => {
  test('escapes values and runs the chosen profile headlessly', () => {
    const paths = launchAgentPaths({ home: '/Users/test', dshHome: '/Users/a&b/.dsh', profile: 'web' })
    const plist = createLaunchAgent({ ...paths, dshHome: '/Users/a&b/.dsh', profile: 'web',
      profileDirectory: '/Users/a&b/.dsh/profiles/web', nodePath: '/usr/bin/node', dshPath: '/tmp/<dsh>', path: '/usr/bin:/bin' })
    expect(plist).toContain('/Users/a&amp;b/.dsh')
    expect(plist).toContain('/tmp/&lt;dsh&gt;')
    expect(plist).toContain('<string>--profile</string>\n    <string>web</string>\n    <string>--no-open</string>')
  })

  test('installs from a truly absent job only after observing the running command twice', async () => {
    const f = await fixture()
    const result = await installDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, f.options)
    expect(result.target).toBe(`gui/${f.options.uid}/${f.paths.label}`)
    expect((await stat(result.plistPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(result.plistPath, 'utf8')).toContain(f.newDsh)
    expect(f.calls.filter(call => call.includes(' bootstrap '))).toHaveLength(1)
    expect(f.calls.some(call => call.includes(' bootout '))).toBe(false)
    expect(f.calls.filter(call => call.includes(' print ')).length).toBeGreaterThanOrEqual(3)
  })

  test('accepts bootstrap EIO only when the new job identity is loaded', async () => {
    const f = await fixture(); f.setBootstrapEio(true)
    await expect(installDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, f.options)).resolves.toBeDefined()
    expect(f.calls.filter(call => call.includes(' bootstrap '))).toHaveLength(1)
  })

  test('waits for a registered Host to become running before reporting success', async () => {
    const f = await fixture(); f.setBootstrapPid(0)
    let waits = 0
    await expect(installDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, {
      ...f.options, wait: async () => { if (++waits === 3) f.setPid(90_000_001) },
    })).resolves.toBeDefined()
    expect(waits).toBeGreaterThanOrEqual(4)
    expect(f.calls.filter(call => call.includes(' bootstrap '))).toHaveLength(1)
    expect((await inspectDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, f.options)).running).toBe(true)
  })

  test('requires the running PID to remain the same across two observations', async () => {
    const f = await fixture()
    let waits = 0
    await expect(installDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, {
      ...f.options, wait: async () => {
        waits += 1
        if (waits <= 2) f.setPid(90_000_000 + waits)
      },
    })).resolves.toBeDefined()
    expect(waits).toBe(3)
    expect(f.calls.filter(call => call.includes(' bootstrap '))).toHaveLength(1)
  })

  test('rejects a Host whose running PID keeps changing', async () => {
    const f = await fixture()
    let waits = 0
    await expect(installDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, {
      ...f.options, wait: async () => { f.setPid(90_000_000 + ++waits) },
    })).rejects.toThrow('did not become running')
    expect(waits).toBe(120)
    await expect(readFile(f.paths.plistPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test.each([false, true])('does not accept a registered but non-running Host (PID present: %s)', async pidPresent => {
    const f = await fixture()
    if (pidPresent) f.setForceWaiting(true)
    else f.setBootstrapPid(0)
    await expect(installDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, f.options))
      .rejects.toThrow('did not become running')
    await expect(readFile(f.paths.plistPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.calls.filter(call => call.includes(' bootstrap '))).toHaveLength(1)
  })

  test('rejects a foreign Home in the plist or loaded job before stopping or writing', async () => {
    for (const kind of ['plist', 'loaded']) {
      const f = await fixture(true)
      if (kind === 'plist') {
        f.setParsedHome('/Users/foreign/.dsh')
        await writeFile(f.paths.plistPath, createLaunchAgent({ ...f.paths,
          dshHome: '/Users/foreign/.dsh', profile: f.profile, profileDirectory: '/Users/foreign/.dsh/profiles/web',
          nodePath: f.options.nodePath, dshPath: f.oldDsh, path: '/usr/bin:/bin' }), { mode: 0o600 })
      }
      else f.setCurrentHome('/Users/foreign/.dsh')
      const before = await readFile(f.paths.plistPath)
      await expect(installDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, f.options)).rejects.toThrow()
      expect(await readFile(f.paths.plistPath)).toEqual(before)
      expect(f.calls.some(call => call.includes(' bootout ') || call.includes(' bootstrap '))).toBe(false)
    }
  })

  test('distinguishes a missing job from a failed launchctl inspection', async () => {
    const absent = await fixture()
    expect(await inspectDshLaunchAgent({ dshHome: absent.dshHome, profile: absent.profile }, absent.options))
      .toMatchObject({ registered: false, pid: 0, running: false, identity: null })
    const failed = await fixture(); failed.setInspectionError(true)
    await expect(installDshLaunchAgent({ dshHome: failed.dshHome, profile: failed.profile }, failed.options))
      .rejects.toThrow('cannot inspect')
    expect(failed.calls.some(call => call.includes(' bootout ') || call.includes(' bootstrap '))).toBe(false)
  })

  test('does not replace a job when bootout fails and it remains registered', async () => {
    const f = await fixture(true); f.setBootoutFails(true)
    await expect(installDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, f.options)).rejects.toThrow('service did not stop')
    expect(await readFile(f.paths.plistPath, 'utf8')).toBe(f.oldPlist)
    expect(f.calls.some(call => call.includes(' bootstrap '))).toBe(false)
  })

  test('does not replace while the old PID remains alive after bootout', async () => {
    const f = await fixture(true); f.setPid(44321)
    vi.spyOn(process, 'kill').mockReturnValue(true)
    const result = installDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, {
      ...f.options, signal: AbortSignal.timeout(200),
    })
    await expect(result).rejects.toThrow()
    expect(await readFile(f.paths.plistPath, 'utf8')).toBe(f.oldPlist)
    expect(f.calls.some(call => call.includes(' bootstrap '))).toBe(false)
  })

  test('restores original plist and registered job after bootstrap failure', async () => {
    const f = await fixture(true)
    let first = true
    const run = (command: string, args: readonly string[]) => {
      if (args[0] === 'bootstrap' && first) { first = false; return { status: 7, stdout: '', stderr: 'bootstrap failed' } }
      return f.run(command, args)
    }
    await expect(installDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, { ...f.options, run }))
      .rejects.toThrow('launchd bootstrap failed')
    expect(await readFile(f.paths.plistPath, 'utf8')).toBe(f.oldPlist)
    expect((await inspectDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, f.options)).registered).toBe(true)
  })

  test('rollback restores a previously running Host to running', async () => {
    const f = await fixture(true); f.setPid(90_000_002)
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('exited'), { code: 'ESRCH' }) })
    let first = true
    const run = (command: string, args: readonly string[]) => {
      if (args[0] === 'bootstrap' && first) { first = false; return { status: 7, stdout: '', stderr: 'bootstrap failed' } }
      return f.run(command, args)
    }
    await expect(installDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, { ...f.options, run }))
      .rejects.toThrow('launchd bootstrap failed')
    expect(await readFile(f.paths.plistPath, 'utf8')).toBe(f.oldPlist)
    expect(await inspectDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, f.options))
      .toMatchObject({ registered: true, running: true })
  })

  test('rollback preserves a previously registered but waiting Host', async () => {
    const f = await fixture(true); f.setBootstrapPid(0)
    const before = await inspectDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, f.options)
    expect(before).toMatchObject({ registered: true, running: false })
    await expect(installDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, f.options))
      .rejects.toThrow('did not become running')
    expect(await readFile(f.paths.plistPath, 'utf8')).toBe(f.oldPlist)
    expect(await inspectDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, f.options))
      .toMatchObject({ registered: true, running: false })
  })

  test('restarts the old job if replacement plist validation fails after bootout', async () => {
    const f = await fixture(true)
    let first = true
    const run = (command: string, args: readonly string[]) => {
      if (command === '/usr/bin/plutil' && args[0] === '-lint' && first) {
        first = false
        return { status: 1, stdout: '', stderr: 'invalid plist' }
      }
      return f.run(command, args)
    }
    await expect(installDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, { ...f.options, run }))
      .rejects.toThrow('plist validation failed')
    expect(await readFile(f.paths.plistPath, 'utf8')).toBe(f.oldPlist)
    expect((await inspectDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, f.options)).registered).toBe(true)
  })

  test('removes a newly created plist when bootstrap fails from an absent state', async () => {
    const f = await fixture()
    f.setBootstrapFails(true)
    await expect(installDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, f.options))
      .rejects.toThrow('launchd bootstrap failed')
    await expect(readFile(f.paths.plistPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await inspectDshLaunchAgent({ dshHome: f.dshHome, profile: f.profile }, f.options)).registered).toBe(false)
  })

  test('same GUI target cannot be installed concurrently from another Home', async () => {
    const first = await fixture(), second = await fixture(false, first.profile)
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let arrived!: () => void
    const waiting = new Promise<void>(resolve => { arrived = resolve })
    const primary = installDshLaunchAgent({ dshHome: first.dshHome, profile: first.profile }, {
      ...first.options, wait: async () => { arrived(); await held },
    })
    await waiting
    await expect(installDshLaunchAgent({ dshHome: second.dshHome, profile: second.profile }, second.options))
      .rejects.toThrow('launchd target is busy')
    release()
    await expect(primary).resolves.toBeDefined()
    expect(second.calls).toHaveLength(0)
  })
})
