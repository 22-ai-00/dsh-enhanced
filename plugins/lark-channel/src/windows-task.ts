import { accessSync, constants } from 'node:fs'
import { access, chmod, mkdir, open, rename } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, win32 } from 'node:path'
import { spawnSync } from 'node:child_process'

const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

export interface WindowsTaskPaths {
  taskName: string
  launcherPath: string
  taskXmlPath: string
  stdoutPath: string
  stderrPath: string
}

export interface WindowsLauncherInput {
  dshHome: string
  profile: string
  profileDirectory: string
  nodePath: string
  dshPath: string
  stdoutPath: string
  stderrPath: string
}

export interface InstalledWindowsTask extends WindowsTaskPaths {
  target: string
  logCommand: string
}

export interface WindowsTaskInstallOptions {
  platform?: NodeJS.Platform
  nodePath?: string
  dshPath?: string
  path?: string
  run?: (command: string, args: readonly string[]) => { status: number | null; stderr: string }
}

function absolute(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value)
}

function cmdValue(value: string): string {
  if (value.includes('\0') || /[\r\n"]/u.test(value)) throw new Error('lark-channel setup: invalid Windows task value')
  return value.replace(/%/gu, '%%')
}

function findExecutable(names: readonly string[], pathValue = process.env.PATH): string {
  for (const directory of (pathValue ?? '').split(delimiter)) {
    if (directory === '' || !absolute(directory)) continue
    for (const name of names) {
      const candidate = join(directory, name)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {}
    }
  }
  throw new Error(`lark-channel setup: cannot find ${names[0]} on PATH`)
}

export function windowsTaskPaths(input: { dshHome: string; profile: string }): WindowsTaskPaths {
  if (!profilePattern.test(input.profile)) throw new Error('lark-channel setup: invalid profile')
  if (!absolute(input.dshHome)) throw new Error('lark-channel setup: DSH_HOME must be absolute')
  const serviceDirectory = join(input.dshHome, 'services')
  const logsDirectory = join(input.dshHome, 'logs')
  return {
    taskName: `DSH profile ${input.profile}`,
    launcherPath: join(serviceDirectory, `${input.profile}.cmd`),
    taskXmlPath: join(serviceDirectory, `${input.profile}.task.xml`),
    stdoutPath: join(logsDirectory, `${input.profile}-host.log`),
    stderrPath: join(logsDirectory, `${input.profile}-host.error.log`),
  }
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** A current-user task which restarts the launcher after abnormal exits. */
export function createWindowsTaskXml(input: WindowsTaskPaths): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>cmd.exe</Command><Arguments>/d /c &quot;${xml(input.launcherPath)}&quot;</Arguments></Exec></Actions>
</Task>
`
}

export function createWindowsLauncher(input: WindowsLauncherInput): string {
  if (!profilePattern.test(input.profile)) throw new Error('lark-channel setup: invalid profile')
  for (const value of [input.dshHome, input.profileDirectory, input.nodePath, input.dshPath,
    input.stdoutPath, input.stderrPath]) {
    if (!absolute(value)) throw new Error('lark-channel setup: Windows task paths must be absolute')
  }
  const dsh = cmdValue(input.dshPath)
  const command = /\.(?:bat|cmd)$/iu.test(input.dshPath)
    ? `call "${dsh}"`
    : /\.exe$/iu.test(input.dshPath)
      ? `"${dsh}"`
      : `"${cmdValue(input.nodePath)}" "${dsh}"`
  return `@echo off\r
setlocal DisableDelayedExpansion\r
set "DSH_HOME=${cmdValue(input.dshHome)}"\r
set "NODE_OPTIONS=--disable-warning=ExperimentalWarning"\r
cd /d "${cmdValue(input.profileDirectory)}"\r
${command} --profile "${input.profile}" --no-open >> "${cmdValue(input.stdoutPath)}" 2>> "${cmdValue(input.stderrPath)}"\r
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
    encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  })
  return { status: result.status, stderr: typeof result.stderr === 'string' ? result.stderr : '' }
}

export async function installDshWindowsTask(
  input: { dshHome: string; profile: string },
  options: WindowsTaskInstallOptions = {},
): Promise<InstalledWindowsTask> {
  if ((options.platform ?? process.platform) !== 'win32') {
    throw new Error('lark-channel setup: Windows task installer requires Windows')
  }
  const paths = windowsTaskPaths(input)
  const profileDirectory = join(input.dshHome, 'profiles', input.profile)
  await access(profileDirectory, constants.R_OK)
  const nodePath = options.nodePath ?? findExecutable(['node.exe', 'node'], options.path)
  const dshPath = options.dshPath ?? findExecutable(['dsh.cmd', 'dsh.exe', 'dsh'], options.path)
  await mkdir(dirname(paths.launcherPath), { recursive: true, mode: 0o700 })
  await mkdir(dirname(paths.stdoutPath), { recursive: true, mode: 0o700 })
  await atomicWrite(paths.launcherPath, createWindowsLauncher({
    ...paths, dshHome: input.dshHome, profile: input.profile, profileDirectory, nodePath, dshPath,
  }))
  await atomicWrite(paths.taskXmlPath, createWindowsTaskXml(paths))
  const run = options.run ?? defaultRun
  const create = run('schtasks.exe', [
    '/Create', '/F', '/TN', paths.taskName, '/XML', paths.taskXmlPath,
  ])
  if (create.status !== 0) throw new Error('lark-channel setup: Windows scheduled task creation failed')
  run('schtasks.exe', ['/End', '/TN', paths.taskName])
  const start = run('schtasks.exe', ['/Run', '/TN', paths.taskName])
  if (start.status !== 0) throw new Error('lark-channel setup: Windows scheduled task start failed')
  const query = run('schtasks.exe', ['/Query', '/TN', paths.taskName])
  if (query.status !== 0) throw new Error('lark-channel setup: Windows scheduled task verification failed')
  return {
    ...paths,
    target: paths.taskName,
    logCommand: `Get-Content -Wait '${paths.stderrPath.replace(/'/gu, "''")}'`,
  }
}
