import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { runtimeConfigDigest, type RuntimeObservation, type RuntimeObserverConfig } from '@dsh-enhanced/plugin-control-plane'
import { createLaunchAgent, launchAgentPaths } from '../src/launchd.ts'
import { assertNativeLaunchdPlist, assertNativeRuntimeObservation, inspectNativeLaunchd, startNativeLaunchd, stopNativeLaunchd,
  type NativeLaunchdCommand, type NativeLaunchdIdentity } from '../src/rsi-native-launchd.ts'

let root: string, input: NativeLaunchdIdentity, paths: ReturnType<typeof launchAgentPaths>, target: string, foreignPath: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-native-launchd-'))
  const dshHome = join(root, '.dsh'), profile = 'web', dshPath = join(root, 'dsh.mjs')
  await mkdir(join(dshHome, 'profiles', profile), { recursive: true, mode: 0o700 })
  await writeFile(dshPath, 'setInterval(() => {}, 1000)\n', { mode: 0o700 })
  foreignPath = join(root, 'foreign.mjs')
  await writeFile(foreignPath, 'setInterval(() => {}, 1000)\n', { mode: 0o700 })
  input = { dshHome, profile, home: root, uid: process.getuid?.() ?? 501,
    nodePath: realpathSync(process.execPath), dshPath: realpathSync(dshPath),
    dshSha256: createHash('sha256').update(await readFile(dshPath)).digest('hex') }
  paths = launchAgentPaths(input); target = `gui/${input.uid}/${paths.label}`
})
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })
function argumentsForLoaded(): string[] {
  return [input.nodePath!, '--disable-warning=ExperimentalWarning', input.dshPath!, '--profile', input.profile, '--no-open']
}
function loaded(overrides: Record<string, string> = {}, args = argumentsForLoaded()): string {
  const fields = { path: paths.plistPath, 'working directory': join(input.dshHome, 'profiles', input.profile),
    DSH_HOME: input.dshHome, program: input.nodePath!, pid: '1234', ...overrides }
  return `path = ${fields.path}\nworking directory = ${fields['working directory']}\nDSH_HOME => ${fields.DSH_HOME}\nprogram = ${fields.program}\narguments = {\n${args.map(arg => `  ${arg}`).join('\n')}\n}\npid = ${fields.pid}\n`
}
function validPlist() {
  return { Label: paths.label, WorkingDirectory: join(input.dshHome, 'profiles', input.profile),
    EnvironmentVariables: { DSH_HOME: input.dshHome, PATH: '/usr/bin:/bin' }, ProgramArguments: argumentsForLoaded(),
    StandardOutPath: paths.stdoutPath, StandardErrorPath: paths.stderrPath, LimitLoadToSessionType: 'Aqua',
    ProcessType: 'Background', RunAtLoad: true, KeepAlive: true, ThrottleInterval: 10, ExitTimeOut: 30, Umask: 63 }
}
function command(stdout: string, status = 0, stderr = ''): NativeLaunchdCommand {
  return (_binary, args) => {
    expect(args).toEqual(['print', target])
    return { status, stdout, stderr }
  }
}

describe('native launchd service identity', () => {
  test('accepts only the loaded job owned by this Home and profile', () => {
    expect(inspectNativeLaunchd(input, command(loaded()))).toEqual({ registered: true, pid: 1234 })
    expect(inspectNativeLaunchd(input, command('', 113, 'Could not find service'))).toEqual({ registered: false, pid: 0 })
    expect(() => inspectNativeLaunchd(input, command('', 5, 'I/O error'))).toThrow('cannot inspect')
    for (const fields of [{ path: '/Users/other/Library/LaunchAgents/foreign.plist' },
      { 'working directory': '/Users/other/.dsh/profiles/web' }, { DSH_HOME: '/Users/other/.dsh' }]) {
      expect(() => inspectNativeLaunchd(input, command(loaded(fields)))).toThrow('another installation')
    }
    expect(() => inspectNativeLaunchd(input, command(loaded({ pid: '1' })))).toThrow('invalid service process identity')
    expect(() => inspectNativeLaunchd(input, command(loaded({ program: input.dshPath! })))).toThrow('program differs')
    expect(() => inspectNativeLaunchd(input, command(loaded({}, [foreignPath, input.dshPath!, '--profile', 'web', '--no-open'])))).toThrow('service command differs')
    expect(() => inspectNativeLaunchd(input, command(loaded({}, [input.nodePath!, foreignPath, '--profile', 'web', '--no-open'])))).toThrow('service command differs')
    expect(() => inspectNativeLaunchd(input, command(loaded({}, [...argumentsForLoaded(), '--foreign'])))).toThrow('service command differs')
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'LD_LIBRARY_PATH']) {
      expect(() => inspectNativeLaunchd(input, command(`${loaded()}\tenvironment = {\n\t\t${name} => ${foreignPath}\n\t}\n`)))
        .toThrow('unexpected execution environment')
    }
  })

  test('rejects a foreign or structurally changed LaunchAgent plist', () => {
    const valid = validPlist()
    const check = (value: object) => assertNativeLaunchdPlist('<plist/>', input,
      (binary, args) => { expect(binary).toBe('/usr/bin/plutil'); expect(args).toEqual(['-convert', 'json', '-o', '-', '--', '-'])
        return { status: 0, stdout: JSON.stringify(value), stderr: '' } })
    expect(() => check(valid)).not.toThrow()
    for (const change of [{ Program: foreignPath }, { RootDirectory: root }, { KeepAlive: false },
      { EnvironmentVariables: { ...valid.EnvironmentVariables, NODE_OPTIONS: `--require ${foreignPath}` } },
      { EnvironmentVariables: { ...valid.EnvironmentVariables, DYLD_INSERT_LIBRARIES: foreignPath } },
      { EnvironmentVariables: { ...valid.EnvironmentVariables, PATH: '.:/usr/bin' } }]) {
      expect(() => check({ ...valid, ...change })).toThrow('execution settings differ')
    }
    for (const change of [{ Label: 'foreign' }, { WorkingDirectory: '/Users/other/.dsh/profiles/web' },
      { EnvironmentVariables: { DSH_HOME: '/Users/other/.dsh', PATH: '/usr/bin:/bin' } },
      { ProgramArguments: [input.nodePath!, input.dshPath!, '--profile', 'other', '--no-open'] }]) {
      const error = 'ProgramArguments' in change ? 'service command differs' : 'another installation'
      expect(() => check({ ...valid, ...change })).toThrow(error)
    }
    for (const args of [[input.nodePath!, foreignPath, '--profile', 'web', '--no-open'],
      [foreignPath, input.dshPath!, '--profile', 'web', '--no-open'],
      [...argumentsForLoaded(), '--foreign']]) {
      expect(() => check({ ...valid, ProgramArguments: args })).toThrow('service command differs')
    }
  })

  test('rejects a changed DSH executable even when launchd paths and arguments still match', async () => {
    const original = await readFile(input.dshPath!)
    try {
      await writeFile(input.dshPath!, 'setInterval(() => {}, 2000)\n', { mode: 0o700 })
      expect(() => inspectNativeLaunchd(input, command(loaded()))).toThrow('service command differs')
      const valid = validPlist()
      expect(() => assertNativeLaunchdPlist('<plist/>', input,
        () => ({ status: 0, stdout: JSON.stringify(valid), stderr: '' }))).toThrow('service command differs')
    } finally { await writeFile(input.dshPath!, original, { mode: 0o700 }) }
  })

  test('will not boot out or bootstrap a foreign loaded service', async () => {
    for (const stdout of [loaded({ DSH_HOME: '/Users/other/.dsh' }),
      loaded({}, [input.nodePath!, foreignPath, '--profile', 'web', '--no-open']),
      loaded({}, [...argumentsForLoaded(), '--foreign'])]) {
      const calls: string[] = []
      const foreign: NativeLaunchdCommand = (_binary, args) => {
        calls.push(args[0]!)
        return { status: 0, stdout, stderr: '' }
      }
      const signal = new AbortController().signal
      await expect(stopNativeLaunchd(input, signal, foreign)).rejects.toThrow()
      await expect(startNativeLaunchd(input, signal, foreign)).rejects.toThrow()
      expect(calls).toEqual(['print', 'print'])
    }
  })

  test('waits for the old Host PID to exit after launchd removes its registration', async () => {
    let registered = true, checks = 0
    const calls: string[] = []
    const local: NativeLaunchdCommand = (_binary, args) => {
      calls.push(args[0]!)
      if (args[0] === 'bootout') { registered = false; return { status: 0, stdout: '', stderr: '' } }
      return registered ? { status: 0, stdout: loaded(), stderr: '' }
        : { status: 113, stdout: '', stderr: 'Could not find service' }
    }
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      expect(signal).toBe(0)
      if (++checks < 2) return true
      throw Object.assign(new Error('exited'), { code: 'ESRCH' })
    })
    try {
      await expect(stopNativeLaunchd(input, new AbortController().signal, local)).resolves.toBeUndefined()
      expect(checks).toBe(2)
      expect(calls).toEqual(['print', 'bootout', 'print', 'print'])
      expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
    } finally { kill.mockRestore() }
  })
})

test('runtime readiness compares PID, profile path, entry module, config and service instances', () => {
  const observer: RuntimeObserverConfig = { socketPath: '/Users/owner/.dsh/observe.sock', keyPath: '/Users/owner/.dsh/observe.key',
    profilePath: '/Users/owner/.dsh/profiles/web/cordis.patch.yml',
    targets: [{ entryId: 'dsh-enhanced-personal-assistant', module: '@dsh-enhanced/personal-assistant',
      configDigest: 'a'.repeat(64), services: ['personalMemory'] }] }
  const now = Date.now(), instance = { uid: 1, epoch: 1 }
  const observation = { schemaVersion: 1, kind: 'dsh-runtime-observation', observerId: 'observer', challenge: 'b'.repeat(64),
    observerConfigDigest: runtimeConfigDigest(observer), processId: 1234, invocationId: null,
    profilePath: observer.profilePath, observedAt: now,
    entries: [{ entryId: observer.targets[0]!.entryId, module: observer.targets[0]!.module,
      configDigest: observer.targets[0]!.configDigest, active: true, instance, dependencies: [],
      services: [{ name: 'personalMemory', instance }] }] } as RuntimeObservation
  expect(() => assertNativeRuntimeObservation(observation, observer, 1234, now)).not.toThrow()
  for (const change of [{ processId: 9999 }, { profilePath: '/Users/other/patch.yml' },
    { observerConfigDigest: '0'.repeat(64) }, { observedAt: now - 6_000 }]) {
    expect(() => assertNativeRuntimeObservation({ ...observation, ...change }, observer, 1234, now)).toThrow()
  }
  for (const change of [{ module: '@other/module' }, { configDigest: '0'.repeat(64) },
    { active: false }, { services: [{ name: 'personalMemory', instance: null }] }]) {
    const entries = [{ ...observation.entries[0]!, ...change }]
    expect(() => assertNativeRuntimeObservation({ ...observation, entries }, observer, 1234, now)).toThrow()
  }
})

test.skipIf(process.platform !== 'darwin' || process.env.DSH_NATIVE_LAUNCHD_TEST !== '1')(
  'real GUI launchd validates, boots, inspects and stops one private disposable service', async context => {
    const uid = process.getuid?.()
    if (uid === undefined || uid === 0) { console.warn('native launchd smoke skipped: non-root GUI user unavailable'); context.skip(); return }
    const domain = `gui/${uid}`
    const gui = spawnSync('/bin/launchctl', ['print', domain], { encoding: 'utf8', timeout: 10_000 })
    if (gui.status !== 0) { console.warn(`native launchd smoke skipped: GUI domain ${domain} unavailable: ${gui.stderr?.trim() ?? ''}`); context.skip(); return }
    const smokeHome = await mkdtemp(join(tmpdir(), 'dsh-native-launchd-smoke-'))
    const profile = `rsi-smoke-${randomUUID().slice(0, 8)}`, dshHome = join(smokeHome, '.dsh')
    const smokeInput: NativeLaunchdIdentity = { dshHome, profile, home: smokeHome, uid,
      nodePath: realpathSync(process.execPath), dshPath: join(smokeHome, 'resident.mjs'), dshSha256: '' }
    const smokePaths = launchAgentPaths(smokeInput)
    let attempted = false
    try {
      await mkdir(join(dshHome, 'profiles', profile), { recursive: true, mode: 0o700 })
      await mkdir(join(dshHome, 'logs'), { mode: 0o700 })
      await mkdir(join(smokeHome, 'Library', 'LaunchAgents'), { recursive: true, mode: 0o700 })
      const script = 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)\n'
      await writeFile(smokeInput.dshPath!, script, { mode: 0o700 })
      smokeInput.dshSha256 = createHash('sha256').update(script).digest('hex')
      const absent = spawnSync('/bin/launchctl', ['print', `${domain}/${smokePaths.label}`], { encoding: 'utf8', timeout: 10_000 })
      expect(absent.status).toBe(113)
      expect(absent.stderr).toMatch(/Could not find service/iu)
      const plist = createLaunchAgent({ ...smokePaths, dshHome, profile,
        profileDirectory: join(dshHome, 'profiles', profile), nodePath: smokeInput.nodePath!, dshPath: smokeInput.dshPath!,
        path: `${join(smokeHome, 'bin')}:/usr/bin:/bin` })
      await writeFile(smokePaths.plistPath, plist, { mode: 0o600 })
      const checked = spawnSync('/usr/bin/plutil', ['-lint', smokePaths.plistPath], { encoding: 'utf8', timeout: 10_000 })
      expect(checked.status, checked.stderr).toBe(0)
      assertNativeLaunchdPlist(plist, smokeInput)
      attempted = true
      await startNativeLaunchd(smokeInput, AbortSignal.timeout(30_000))
      await expect.poll(() => inspectNativeLaunchd(smokeInput).pid, { timeout: 10_000 }).toBeGreaterThan(1)
      await stopNativeLaunchd(smokeInput, AbortSignal.timeout(45_000))
      expect(inspectNativeLaunchd(smokeInput)).toEqual({ registered: false, pid: 0 })
    } finally {
      if (attempted) spawnSync('/bin/launchctl', ['bootout', domain, smokePaths.plistPath], { encoding: 'utf8', timeout: 10_000 })
      await rm(smokeHome, { recursive: true, force: true })
    }
  }, 90_000)
