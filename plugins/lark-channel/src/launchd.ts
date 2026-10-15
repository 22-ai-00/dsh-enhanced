import { accessSync, constants, realpathSync, readFileSync } from 'node:fs'
import { access, chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { assertNativeLaunchdPlist, inspectNativeLaunchd, inspectNativeLaunchdDetail, stopNativeLaunchd,
  type NativeLaunchdCommand, type NativeLaunchdIdentity } from './launchd-identity.js'
import { withLaunchAgentTargetLock } from './launchd-target-lock.js'

const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

export interface LaunchAgentPathsInput {
  home?: string
  dshHome: string
  profile: string
}

export interface LaunchAgentPaths {
  label: string
  plistPath: string
  stdoutPath: string
  stderrPath: string
}

export interface LaunchAgentInput extends LaunchAgentPaths {
  dshHome: string
  profile: string
  profileDirectory: string
  nodePath: string
  dshPath: string
  path: string
}

export interface InstalledLaunchAgent extends LaunchAgentPaths {
  target: string
}

interface CommandResult {
  status: number | null
  stdout?: string | Buffer
  stderr?: string | Buffer
}

export interface LaunchAgentInstallOptions {
  home?: string
  uid?: number
  nodePath?: string
  dshPath?: string
  path?: string
  platform?: NodeJS.Platform
  run?: (command: string, args: readonly string[]) => CommandResult
  wait?: (milliseconds: number) => Promise<void>
  signal?: AbortSignal
}

export interface DshLaunchAgentInspection {
  target: string
  plistPath: string
  registered: boolean
  pid: number
  running: boolean
  identity: { nodePath: string; dshPath: string; dshSha256: string } | null
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function requireAbsolute(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`lark-channel setup: ${label} must be absolute`)
  return value
}

export function launchAgentPaths(input: LaunchAgentPathsInput): LaunchAgentPaths {
  if (!profilePattern.test(input.profile)) throw new Error('lark-channel setup: invalid profile')
  const home = requireAbsolute(input.home ?? homedir(), 'home')
  const dshHome = requireAbsolute(input.dshHome, 'DSH_HOME')
  const label = `ai.deepseek.dsh.profile.${input.profile}`
  return {
    label,
    plistPath: join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    stdoutPath: join(dshHome, 'logs', `${input.profile}-host.log`),
    stderrPath: join(dshHome, 'logs', `${input.profile}-host.error.log`),
  }
}

export function createLaunchAgent(input: LaunchAgentInput): string {
  const strings = [input.dshHome, input.profileDirectory, input.nodePath, input.dshPath,
    input.stdoutPath, input.stderrPath]
  if (strings.some(value => !isAbsolute(value))) {
    throw new Error('lark-channel setup: LaunchAgent paths must be absolute')
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(input.nodePath)}</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>${xml(input.dshPath)}</string>
    <string>--profile</string>
    <string>${xml(input.profile)}</string>
    <string>--no-open</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DSH_HOME</key>
      <string>${xml(input.dshHome)}</string>
    <key>PATH</key>
      <string>${xml(input.path)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(input.profileDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${xml(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(input.stderrPath)}</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Background</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>Umask</key>
  <integer>63</integer>
</dict>
</plist>
`
}

function findExecutable(name: string, pathValue: string | undefined): string {
  for (const directory of (pathValue ?? '').split(':')) {
    if (!isAbsolute(directory)) continue
    const candidate = join(directory, name)
    try {
      // Synchronous resolution happens once during setup and avoids invoking a shell.
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  throw new Error(`lark-channel setup: cannot find ${name} in PATH`)
}

function servicePath(nodePath: string, dshPath: string, current: string | undefined): string {
  const values = [dirname(nodePath), dirname(dshPath), ...(current ?? '').split(':'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  return [...new Set(values.filter(value => isAbsolute(value)))].join(':')
}

function defaultRun(command: string, args: readonly string[]): CommandResult {
  return spawnSync(command, [...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
    maxBuffer: 256 * 1024,
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function commandError(action: string, result: CommandResult): Error {
  const stderr = typeof result.stderr === 'string' ? result.stderr : result.stderr?.toString('utf8')
  const detail = stderr?.trim().slice(0, 1_000)
  return new Error(`lark-channel setup: ${action} failed${detail ? `: ${detail}` : ''}`)
}

function isBootstrapEio(result: CommandResult): boolean {
  const stderr = typeof result.stderr === 'string' ? result.stderr : result.stderr?.toString('utf8')
  return result.status === 5 || /Bootstrap failed:\s*5:\s*Input\/output error/iu.test(stderr ?? '')
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function writePlist(path: string, value: string | Buffer, run: NonNullable<LaunchAgentInstallOptions['run']>): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`
  try {
    const file = await open(temporary, 'w', 0o600)
    try {
      await file.writeFile(value)
      await file.sync()
    } finally {
      await file.close()
    }
    const validation = run('/usr/bin/plutil', ['-lint', temporary])
    if (validation.status !== 0) throw commandError('LaunchAgent plist validation', validation)
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

function nativeCommand(run: NonNullable<LaunchAgentInstallOptions['run']>): NativeLaunchdCommand {
  return (command, args) => {
    const result = run(command, args)
    return { status: result.status, stdout: result.stdout?.toString() ?? '', stderr: result.stderr?.toString() ?? '' }
  }
}

function executableIdentity(nodePath: string, dshPath: string): DshLaunchAgentInspection['identity'] {
  const node = realpathSync(nodePath), dsh = realpathSync(dshPath)
  return { nodePath: node, dshPath: dsh,
    dshSha256: createHash('sha256').update(readFileSync(dsh)).digest('hex') }
}

async function inspectWithPaths(input: { dshHome: string; profile: string },
  paths: LaunchAgentPaths, uid: number, run: NonNullable<LaunchAgentInstallOptions['run']>): Promise<DshLaunchAgentInspection> {
  const target = `gui/${uid}/${paths.label}`
  let bytes: Buffer | null
  try {
    const entry = await lstat(paths.plistPath)
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) {
      throw new Error('lark-channel setup: existing LaunchAgent plist is unsafe')
    }
    bytes = await readFile(paths.plistPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    bytes = null
  }
  let identity: DshLaunchAgentInspection['identity'] = null
  if (bytes !== null) {
    const parsed = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', paths.plistPath])
    if (parsed.status !== 0) throw commandError('existing LaunchAgent plist inspection', parsed)
    let value: { ProgramArguments?: unknown }
    try { value = JSON.parse(parsed.stdout?.toString() ?? '') as { ProgramArguments?: unknown } }
    catch { throw new Error('lark-channel setup: existing LaunchAgent plist is invalid') }
    const args = value.ProgramArguments
    if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) {
      throw new Error('lark-channel setup: existing LaunchAgent command is invalid')
    }
    const offset = args[1] === '--disable-warning=ExperimentalWarning' ? 2 : 1
    if (typeof args[0] !== 'string' || typeof args[offset] !== 'string') {
      throw new Error('lark-channel setup: existing LaunchAgent command is invalid')
    }
    identity = executableIdentity(args[0], args[offset])
    const expected: NativeLaunchdIdentity = { ...input, ...identity, home: dirname(dirname(dirname(paths.plistPath))), uid }
    assertNativeLaunchdPlist(bytes.toString('utf8'), expected, (command, arguments_) => command === '/usr/bin/plutil'
      ? { status: parsed.status, stdout: parsed.stdout?.toString() ?? '', stderr: parsed.stderr?.toString() ?? '' }
      : nativeCommand(run)(command, arguments_))
    // plutil parsed the pathname. Verify it still denotes the bytes checked above.
    if (!(await readFile(paths.plistPath)).equals(bytes)) {
      throw new Error('lark-channel setup: LaunchAgent plist changed during inspection')
    }
  }
  const expected: NativeLaunchdIdentity = { ...input, ...identity,
    home: dirname(dirname(dirname(paths.plistPath))), uid }
  const state = inspectNativeLaunchdDetail(expected, nativeCommand(run))
  if (state.registered && identity === null) {
    throw new Error('lark-channel setup: loaded LaunchAgent has no trusted plist')
  }
  return { target, plistPath: paths.plistPath, ...state, identity }
}

export async function inspectDshLaunchAgent(input: { dshHome: string; profile: string },
  options: Pick<LaunchAgentInstallOptions, 'home' | 'uid' | 'platform' | 'run'> = {}): Promise<DshLaunchAgentInspection> {
  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new Error('lark-channel setup: LaunchAgent inspection requires macOS')
  }
  const uid = options.uid ?? process.getuid?.()
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 1) {
    throw new Error('lark-channel setup: cannot resolve the launchd user domain')
  }
  const paths = launchAgentPaths({ ...input, ...(options.home === undefined ? {} : { home: options.home }) })
  return inspectWithPaths(input, paths, uid, options.run ?? defaultRun)
}

async function startVerified(input: NativeLaunchdIdentity, paths: LaunchAgentPaths, uid: number,
  run: NonNullable<LaunchAgentInstallOptions['run']>, wait: NonNullable<LaunchAgentInstallOptions['wait']>,
  requireRunning = true): Promise<void> {
  const command = nativeCommand(run), target = `gui/${uid}/${paths.label}`, domain = `gui/${uid}`
  if (inspectNativeLaunchd(input, command).registered) throw new Error('lark-channel setup: service remained registered before bootstrap')
  const enable = run('/bin/launchctl', ['enable', target])
  if (enable.status !== 0) throw commandError('launchd enable', enable)
  const delays = [250, 750] as const
  let bootstrap: CommandResult = { status: null }
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    bootstrap = run('/bin/launchctl', ['bootstrap', domain, paths.plistPath])
    if (bootstrap.status !== 0 && !isBootstrapEio(bootstrap)) throw commandError('launchd bootstrap', bootstrap)
    let consecutiveRunning = 0, previousRunningPid = 0, registered = false
    let lastState = 'absent', lastPid = 0, lastExitCode: string | null = null
    // launchd can register before the Host reaches running. Keep polling the
    // same job; a second bootstrap while it remains registered is not safe.
    for (let observation = 0; observation < 120; observation += 1) {
      const state = inspectNativeLaunchdDetail(input, command)
      registered = state.registered
      lastState = state.state ?? 'unknown'
      lastPid = state.pid
      lastExitCode = state.lastExitCode
      if (registered && !requireRunning) return
      if (state.running) {
        consecutiveRunning = state.pid === previousRunningPid ? consecutiveRunning + 1 : 1
        previousRunningPid = state.pid
      } else {
        consecutiveRunning = 0
        previousRunningPid = 0
      }
      if (consecutiveRunning >= 2) return
      if (!registered && observation >= 2) break
      await wait(250)
    }
    if (registered) {
      throw new Error(`lark-channel setup: LaunchAgent registered but the Host did not become running (state=${lastState.slice(0, 40)}, pid=${lastPid}, lastExitCode=${lastExitCode?.slice(0, 40) ?? 'unknown'})`)
    }
    const delayMs = delays[attempt]
    if (delayMs !== undefined) await wait(delayMs)
  }
  if (bootstrap.status !== 0) throw commandError('launchd bootstrap', bootstrap)
  throw new Error('lark-channel setup: launchd bootstrap succeeded but the service was not registered')
}

export async function installDshLaunchAgent(
  input: { dshHome: string; profile: string },
  options: LaunchAgentInstallOptions = {},
): Promise<InstalledLaunchAgent> {
  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new Error('lark-channel setup: automatic resident service currently requires macOS launchd')
  }
  const uid = options.uid ?? process.getuid?.()
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 1) {
    throw new Error('lark-channel setup: cannot resolve the launchd user domain')
  }
  const paths = launchAgentPaths({
    ...(options.home === undefined ? {} : { home: options.home }),
    dshHome: input.dshHome,
    profile: input.profile,
  })
  const profileDirectory = join(input.dshHome, 'profiles', input.profile)
  await access(profileDirectory, constants.R_OK)
  const currentPath = options.path ?? process.env.PATH
  const nodePath = realpathSync(options.nodePath ?? findExecutable('node', currentPath))
  const dshPath = realpathSync(options.dshPath ?? findExecutable('dsh', currentPath))
  const path = servicePath(nodePath, dshPath, currentPath)
  const run = options.run ?? defaultRun
  const wait = options.wait ?? defaultWait

  const target = `gui/${uid}/${paths.label}`
  const newIdentity: NativeLaunchdIdentity = { ...input,
    ...(options.home === undefined ? {} : { home: options.home }), uid,
    ...executableIdentity(nodePath, dshPath) }
  return withLaunchAgentTargetLock({ profile: input.profile, uid }, async () => {
    const before = await inspectWithPaths(input, paths, uid, run)
    const original = before.identity === null ? null : await readFile(paths.plistPath)
    const oldIdentity: NativeLaunchdIdentity = { ...input,
      ...(options.home === undefined ? {} : { home: options.home }), uid,
      ...before.identity }
    if (before.registered) {
      await stopNativeLaunchd(oldIdentity, AbortSignal.any([
        options.signal ?? new AbortController().signal, AbortSignal.timeout(45_000),
      ]), nativeCommand(run))
    }
    // A concurrent actor outside our target lock must not silently replace
    // the plist after inspection or while launchd is removing the old job.
    const current = await readFile(paths.plistPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (current === null ? original !== null : original === null || !current.equals(original)) {
      throw new Error('lark-channel setup: LaunchAgent plist changed during service replacement')
    }
    const replacement = createLaunchAgent({ ...paths, dshHome: input.dshHome, profile: input.profile,
      profileDirectory, nodePath, dshPath, path })
    let replaced = false
    try {
      await mkdir(dirname(paths.plistPath), { recursive: true, mode: 0o700 })
      await mkdir(dirname(paths.stdoutPath), { recursive: true, mode: 0o700 })
      await writePlist(paths.plistPath, replacement, run)
      replaced = true
      await startVerified(newIdentity, paths, uid, run, wait)
      return { ...paths, target }
    } catch (error) {
      try {
        // A failed bootstrap can have committed the new job. Only remove a
        // job whose full identity is known; preserve unknown state for review.
        if (replaced) await stopNativeLaunchd(newIdentity, AbortSignal.timeout(45_000), nativeCommand(run))
        const now = await readFile(paths.plistPath).catch((readError: NodeJS.ErrnoException) => {
          if (readError.code === 'ENOENT') return null
          throw readError
        })
        if (replaced ? now?.toString('utf8') !== replacement
          : now === null ? original !== null : original === null || !now.equals(original)) {
          throw new Error('lark-channel setup: LaunchAgent plist changed before rollback')
        }
        if (replaced) {
          if (original === null) await unlink(paths.plistPath)
          else await writePlist(paths.plistPath, original, run)
        }
        if (before.registered) await startVerified(oldIdentity, paths, uid, run, wait, before.running)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError],
          'lark-channel setup: LaunchAgent replacement failed and rollback requires reconciliation')
      }
      throw error
    }
  })
}
