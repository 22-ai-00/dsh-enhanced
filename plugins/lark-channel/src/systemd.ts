import { accessSync, constants } from 'node:fs'
import { access, chmod, mkdir, open, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { spawnSync } from 'node:child_process'

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
  nodePath?: string
  dshPath?: string
  path?: string
  run?: (command: string, args: readonly string[]) => { status: number | null; stderr: string }
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

[Install]
WantedBy=default.target
`
}

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`
  const file = await open(temporary, 'w', 0o600)
  try {
    await file.writeFile(value, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
  await chmod(path, 0o600)
}

function defaultRun(command: string, args: readonly string[]): { status: number | null; stderr: string } {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin',
      ...(process.env.DBUS_SESSION_BUS_ADDRESS === undefined
        ? {} : { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }),
      ...(process.env.XDG_RUNTIME_DIR === undefined ? {} : { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }) },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  return { status: result.status, stderr: typeof result.stderr === 'string' ? result.stderr : '' }
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
  const path = servicePath(nodePath, dshPath, options.path ?? process.env.PATH)
  const run = options.run ?? defaultRun
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
    const result = run('/usr/bin/systemctl', args)
    if (result.status !== 0) throw new Error('lark-channel setup: systemd user service operation failed')
  }
  return {
    ...paths,
    target: paths.unitName,
    logCommand: `journalctl --user -u ${paths.unitName} -f`,
  }
}
