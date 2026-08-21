import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { createWindowsLauncher, installDshWindowsTask, windowsTaskPaths } from '../src/windows-task.ts'

describe('DSH profile Windows scheduled task', () => {
  test('creates a secret-free launcher for one profile', () => {
    const launcher = createWindowsLauncher({
      dshHome: 'C:\\Users\\test\\.dsh',
      profile: 'web',
      profileDirectory: 'C:\\Users\\test\\.dsh\\profiles\\web',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      dshPath: 'C:\\Users\\test\\AppData\\Roaming\\npm\\dsh.cmd',
      stdoutPath: 'C:\\Users\\test\\.dsh\\logs\\web-host.log',
      stderrPath: 'C:\\Users\\test\\.dsh\\logs\\web-host.error.log',
    })

    expect(launcher).toContain('set "DSH_HOME=C:\\Users\\test\\.dsh"')
    expect(launcher).toContain('call "C:\\Users\\test\\AppData\\Roaming\\npm\\dsh.cmd"')
    expect(launcher).toContain('--profile "web" --no-open')
    expect(launcher).not.toMatch(/TOKEN|SECRET|PASSWORD/u)
  })

  test('writes a private launcher and replaces the current-user logon task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-windows-task-'))
    const dshHome = join(root, '.dsh')
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    const paths = windowsTaskPaths({ dshHome, profile: 'web' })
    const commands: Array<{ command: string; args: readonly string[] }> = []
    const run = vi.fn((command: string, args: readonly string[]) => {
      commands.push({ command, args })
      return { status: args[0] === '/End' ? 1 : 0, stderr: '' }
    })

    const installed = await installDshWindowsTask({ dshHome, profile: 'web' }, {
      platform: 'win32',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      dshPath: 'C:\\Users\\test\\AppData\\Roaming\\npm\\dsh.cmd',
      run,
    })

    expect(installed.target).toBe('DSH profile web')
    expect((await stat(paths.launcherPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(paths.launcherPath, 'utf8')).not.toMatch(/TOKEN|SECRET|PASSWORD/u)
    expect(commands.map(command => [command.command, ...command.args])).toEqual([
      ['schtasks.exe', '/Create', '/F', '/SC', 'ONLOGON', '/TN', 'DSH profile web', '/TR',
        `cmd.exe /d /c "${paths.launcherPath}"`],
      ['schtasks.exe', '/End', '/TN', 'DSH profile web'],
      ['schtasks.exe', '/Run', '/TN', 'DSH profile web'],
      ['schtasks.exe', '/Query', '/TN', 'DSH profile web'],
    ])
  })
})
