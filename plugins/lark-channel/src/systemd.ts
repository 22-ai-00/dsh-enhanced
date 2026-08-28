import { accessSync, constants, lstatSync } from 'node:fs'
import { access, chmod, mkdir, open, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

export interface SystemdServicePathsInput {
  home?: string
  dshHome: string
  profile: string
}

export interface SystemdServicePaths {
  unitName: string
  unitPath: string
}

export interface SystemdUnitInput extends SystemdServicePaths {
  dshHome: string
  profile: string
  profileDirectory: string
  nodePath: string
  dshPath: string
  path: string
}

export interface InstalledSystemdService extends SystemdServicePaths {
  target: string
  logCommand: string
}

export interface SystemdInstallOptions {
  home?: string
  platform?: NodeJS.Platform
  uid?: number
  nodePath?: string
  dshPath?: string
  loginctlPath?: string
  systemctlPath?: string
  path?: string
  run?: SystemdCommandRunner
}

export interface SystemdCommandResult {
  status: number | null
  stdout?: string
  stderr: string
  errorCode?: string
}

export type SystemdCommandRunner = (
  command: string,
  args: readonly string[],
) => SystemdCommandResult

export interface PreparedSystemdUserService {
  enabledLinger: boolean
}

function requireAbsolute(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`lark-channel setup: ${label} must be absolute`)
  return value
}

function unitQuote(value: string): string {
  if (value.includes('\0') || /[\r\n]/u.test(value)) throw new Error('lark-channel setup: invalid systemd value')
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

function unitLiteralQuote(value: string): string {
  return unitQuote(value.replace(/%/gu, '%%'))
}

function unitWorkingDirectory(value: string): string {
  if (value.includes('\0') || /[\r\n]/u.test(value)) throw new Error('lark-channel setup: invalid systemd value')
  // systemd 252 parses this directive as one raw path: quotes and C escapes would become literal path characters.
  const escaped = value.replace(/%/gu, '%%')
  return /[\t \\]$/u.test(escaped) ? `${escaped}/` : escaped
}

function findExecutable(command: string, pathValue = process.env.PATH): string {
  for (const directory of (pathValue ?? '').split(delimiter)) {
    if (directory === '' || !isAbsolute(directory)) continue
    const candidate = join(directory, command)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  throw new Error(`lark-channel setup: cannot find ${command} on PATH`)
}

function servicePath(nodePath: string, dshPath: string, currentPath?: string): string {
  const values = [dirname(nodePath), dirname(dshPath), ...(currentPath ?? '').split(delimiter), '/usr/bin', '/bin']
    .filter((value, index, all) => value !== '' && isAbsolute(value) && all.indexOf(value) === index)
  return values.join(delimiter)
}

export function systemdServicePaths(input: SystemdServicePathsInput): SystemdServicePaths {
  if (!profilePattern.test(input.profile)) throw new Error('lark-channel setup: invalid profile')
  const home = requireAbsolute(input.home ?? homedir(), 'home')
  requireAbsolute(input.dshHome, 'DSH_HOME')
  const unitName = `dsh-profile-${input.profile}.service`
  return { unitName, unitPath: join(home, '.config', 'systemd', 'user', unitName) }
}

export function createSystemdUserUnit(input: SystemdUnitInput): string {
  for (const [label, value] of Object.entries({
    dshHome: input.dshHome,
    profileDirectory: input.profileDirectory,
    nodePath: input.nodePath,
    dshPath: input.dshPath,
  })) requireAbsolute(value, label)
  if (!profilePattern.test(input.profile)) throw new Error('lark-channel setup: invalid profile')
  return `[Unit]
Description=DeepSeek Harness profile ${input.profile}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${unitWorkingDirectory(input.profileDirectory)}
Environment=${unitLiteralQuote(`DSH_HOME=${input.dshHome}`)}
Environment=${unitLiteralQuote(`PATH=${input.path}`)}
Environment=${unitQuote('DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus')}
Environment=${unitQuote('XDG_RUNTIME_DIR=%t')}
ExecStart=${unitLiteralQuote(input.nodePath)} --disable-warning=ExperimentalWarning ${unitLiteralQuote(input.dshPath)} --profile ${input.profile} --no-open
# A deliberate systemctl user stop remains stopped, while every process
# exit (including a clean but unintended Host exit) is restarted.  Disabling
# systemd's start-rate limiter keeps a long-lived personal assistant from
# becoming permanently inactive after a transient dependency outage.
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGINT
UMask=0077

[Install]
WantedBy=default.target
`
}

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(16).toString('hex')}`
  let created = false
  try {
    const file = await open(temporary, 'wx', 0o600)
    created = true
    try {
      await file.writeFile(value, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    await chmod(path, 0o600)
    const directory = await open(dirname(path), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch (error) {
    if (!created) throw error
    try {
      await unlink(temporary)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw new AggregateError([error, cleanupError],
        'lark-channel setup: systemd unit write and temporary cleanup both failed')
    }
    throw error
  }
}

function defaultRun(command: string, args: readonly string[]): SystemdCommandResult {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const standardRuntimeDirectory = uid === undefined ? undefined : `/run/user/${uid}`
  const safeStandardRuntimeDirectory = (() => {
    if (uid === undefined || standardRuntimeDirectory === undefined) return undefined
    try {
      const status = lstatSync(standardRuntimeDirectory)
      return status.isDirectory() && status.uid === uid ? standardRuntimeDirectory : undefined
    } catch {
      return undefined
    }
  })()
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR
    ?? safeStandardRuntimeDirectory
  const safeStandardSessionBus = (() => {
    if (uid === undefined || runtimeDirectory !== safeStandardRuntimeDirectory) return undefined
    const path = `${runtimeDirectory}/bus`
    try {
      const status = lstatSync(path)
      return status.isSocket() && status.uid === uid ? `unix:path=${path}` : undefined
    } catch {
      return undefined
    }
  })()
  const sessionBus = process.env.DBUS_SESSION_BUS_ADDRESS
    ?? safeStandardSessionBus
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      ...(sessionBus === undefined ? {} : { DBUS_SESSION_BUS_ADDRESS: sessionBus }),
      ...(runtimeDirectory === undefined ? {} : { XDG_RUNTIME_DIR: runtimeDirectory }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: 128 * 1024,
  })
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    ...(errorCode === undefined ? {} : { errorCode }),
  }
}

function effectiveUid(value?: number): number {
  const uid = value ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error('lark-channel setup: cannot determine the Linux user id')
  }
  return uid
}

function commandUnavailable(result: SystemdCommandResult, command: string, operation: string): Error {
  if (result.errorCode === 'ENOENT') {
    return new Error(`lark-channel setup: ${command} disappeared before ${operation}`)
  }
  if (result.errorCode === 'ETIMEDOUT') {
    return new Error(`lark-channel setup: ${operation} timed out`)
  }
  return new Error(`lark-channel setup: ${operation} could not start`)
}

/**
 * Makes a Linux user service viable before cloud onboarding starts. The
 * unprivileged loginctl attempt succeeds on systems that allow a user to
 * enable their own lingering. It deliberately never invokes sudo or an
 * interactive policy agent; installations that require administrator approval
 * fail with one explicit command before any OAuth/app mutation occurs.
 */
export async function prepareDshSystemdUserService(
  input: { dshHome: string; profile: string },
  options: Pick<SystemdInstallOptions,
    'home' | 'platform' | 'run' | 'uid' | 'path' | 'loginctlPath' | 'systemctlPath'> = {},
): Promise<PreparedSystemdUserService> {
  if ((options.platform ?? process.platform) !== 'linux') {
    throw new Error('lark-channel setup: systemd installer requires Linux')
  }
  systemdServicePaths({
    ...(options.home === undefined ? {} : { home: options.home }),
    dshHome: input.dshHome,
    profile: input.profile,
  })
  const uid = String(effectiveUid(options.uid))
  const run = options.run ?? defaultRun
  const loginctlPath = options.loginctlPath ?? findExecutable('loginctl', options.path)
  const systemctlPath = options.systemctlPath ?? findExecutable('systemctl', options.path)
  const readLinger = (): SystemdCommandResult => run(
    loginctlPath,
    ['show-user', uid, '--property=Linger', '--value'],
  )
  let linger = readLinger()
  if (linger.status === null) {
    throw commandUnavailable(linger, loginctlPath, 'Linux logout-persistence check')
  }
  let enabledLinger = false
  if (linger.status !== 0 || linger.stdout?.trim() !== 'yes') {
    const enabled = run(loginctlPath, ['--no-ask-password', 'enable-linger', uid])
    if (enabled.status === null) {
      throw commandUnavailable(enabled, loginctlPath, 'Linux logout-persistence enablement')
    }
    if (enabled.status !== 0) {
      throw new Error('lark-channel setup: Linux logout persistence requires administrator approval; '
        + 'run `sudo loginctl enable-linger "$(id -u)"` and retry')
    }
    enabledLinger = true
    linger = readLinger()
    if (linger.status !== 0 || linger.stdout?.trim() !== 'yes') {
      throw new Error('lark-channel setup: loginctl did not confirm Linux logout persistence after enabling it')
    }
  }
  const manager = run(systemctlPath, ['--user', 'show-environment'])
  if (manager.status === null) {
    throw commandUnavailable(manager, systemctlPath, 'systemd user-manager check')
  }
  if (manager.status !== 0) {
    throw new Error('lark-channel setup: systemd user manager is unavailable; log in as the target user '
      + '(not through sudo/su), then verify `systemctl --user show-environment` and retry')
  }
  return { enabledLinger }
}

export async function installDshSystemdService(
  input: { dshHome: string; profile: string },
  options: SystemdInstallOptions = {},
): Promise<InstalledSystemdService> {
  if ((options.platform ?? process.platform) !== 'linux') {
    throw new Error('lark-channel setup: systemd installer requires Linux')
  }
  const paths = systemdServicePaths({
    ...(options.home === undefined ? {} : { home: options.home }),
    dshHome: input.dshHome,
    profile: input.profile,
  })
  const profileDirectory = join(input.dshHome, 'profiles', input.profile)
  await access(profileDirectory, constants.R_OK)
  const nodePath = options.nodePath ?? findExecutable('node', options.path)
  const dshPath = options.dshPath ?? findExecutable('dsh', options.path)
  const loginctlPath = options.loginctlPath ?? findExecutable('loginctl', options.path)
  const systemctlPath = options.systemctlPath ?? findExecutable('systemctl', options.path)
  const path = servicePath(nodePath, dshPath, options.path ?? process.env.PATH)
  const run = options.run ?? defaultRun
  await prepareDshSystemdUserService(input, {
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.uid === undefined ? {} : { uid: options.uid }),
    ...(options.path === undefined ? {} : { path: options.path }),
    loginctlPath,
    systemctlPath,
    run,
  })
  await mkdir(dirname(paths.unitPath), { recursive: true, mode: 0o700 })
  await atomicWrite(paths.unitPath, createSystemdUserUnit({
    ...paths, dshHome: input.dshHome, profile: input.profile, profileDirectory, nodePath, dshPath, path,
  }))
  const commands: Array<readonly string[]> = [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', paths.unitName],
    ['--user', 'restart', paths.unitName],
    ['--user', 'is-active', '--quiet', paths.unitName],
  ]
  for (const args of commands) {
    const result = run(systemctlPath, args)
    if (result.status !== 0) throw new Error('lark-channel setup: systemd user service operation failed')
  }
  return {
    ...paths,
    target: paths.unitName,
    logCommand: `journalctl --user -u ${paths.unitName} -f`,
  }
}
