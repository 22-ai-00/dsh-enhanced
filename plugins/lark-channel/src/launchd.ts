import { accessSync, constants } from 'node:fs'
import { access, chmod, mkdir, open, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { spawnSync } from 'node:child_process'

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
    stdio: ['ignore', 'ignore', 'pipe'],
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

async function writePlist(path: string, value: string, run: NonNullable<LaunchAgentInstallOptions['run']>): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`
  const file = await open(temporary, 'w', 0o600)
  try {
    await file.writeFile(value, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
  const validation = run('/usr/bin/plutil', ['-lint', temporary])
  if (validation.status !== 0) {
    await unlink(temporary).catch(() => {})
    throw commandError('LaunchAgent plist validation', validation)
  }
  await rename(temporary, path)
  await chmod(path, 0o600)
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
  const nodePath = options.nodePath ?? findExecutable('node', currentPath)
  const dshPath = options.dshPath ?? findExecutable('dsh', currentPath)
  const path = servicePath(nodePath, dshPath, currentPath)
  const run = options.run ?? defaultRun
  const wait = options.wait ?? defaultWait

  await mkdir(dirname(paths.plistPath), { recursive: true, mode: 0o700 })
  await mkdir(dirname(paths.stdoutPath), { recursive: true, mode: 0o700 })
  await writePlist(paths.plistPath, createLaunchAgent({
    ...paths,
    dshHome: input.dshHome,
    profile: input.profile,
    profileDirectory,
    nodePath,
    dshPath,
    path,
  }), run)

  const domain = `gui/${uid}`
  const target = `${domain}/${paths.label}`
  run('/bin/launchctl', ['bootout', target])
  const enable = run('/bin/launchctl', ['enable', target])
  if (enable.status !== 0) throw commandError('launchd enable', enable)
  const retryDelays = [250, 750] as const
  let bootstrap: CommandResult = { status: null }
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    bootstrap = run('/bin/launchctl', ['bootstrap', domain, paths.plistPath])
    if (bootstrap.status !== 0 && !isBootstrapEio(bootstrap)) {
      throw commandError('launchd bootstrap', bootstrap)
    }
    // `bootstrap` may return EIO after committing the job, or even return zero
    // while an earlier bootout is still removing it. The job registry is the
    // source of truth; require it to remain visible across a short settle window.
    if (run('/bin/launchctl', ['print', target]).status === 0) {
      await wait(250)
      if (run('/bin/launchctl', ['print', target]).status === 0) {
        return { ...paths, target }
      }
      continue
    }
    const delayMs = retryDelays[attempt]
    if (delayMs !== undefined) await wait(delayMs)
  }
  if (bootstrap.status !== 0) throw commandError('launchd bootstrap', bootstrap)
  throw new Error('lark-channel setup: launchd bootstrap succeeded but the service was not registered')
}
