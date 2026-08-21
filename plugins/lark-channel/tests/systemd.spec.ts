import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { createSystemdUserUnit, installDshSystemdService, systemdServicePaths } from '../src/systemd.ts'

describe('DSH profile systemd user service', () => {
  test('creates a restartable user unit with a minimal explicit environment', () => {
    const paths = systemdServicePaths({
      home: '/home/test',
      dshHome: '/home/test/.dsh',
      profile: 'web',
    })
    expect(paths).toEqual({
      unitName: 'dsh-profile-web.service',
      unitPath: '/home/test/.config/systemd/user/dsh-profile-web.service',
    })

    const unit = createSystemdUserUnit({
      ...paths,
      dshHome: '/home/test/.dsh',
      profile: 'web',
      profileDirectory: '/home/test/.dsh/profiles/web',
      nodePath: '/usr/bin/node',
      dshPath: '/home/test/.local/bin/dsh',
      path: '/home/test/.local/bin:/usr/bin:/bin',
    })

    expect(unit).toContain('ExecStart="/usr/bin/node" --disable-warning=ExperimentalWarning "/home/test/.local/bin/dsh" --profile web --no-open')
    expect(unit).toContain('Environment="DSH_HOME=/home/test/.dsh"')
    expect(unit).toContain('Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus"')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).not.toMatch(/TOKEN|SECRET|PASSWORD/u)
  })

  test('atomically installs, enables, restarts, and verifies the user unit', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-systemd-'))
    const dshHome = join(home, '.dsh')
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    const commands: Array<{ command: string; args: readonly string[] }> = []
    const run = vi.fn((command: string, args: readonly string[]) => {
      commands.push({ command, args })
      return { status: 0, stderr: '' }
    })

    const installed = await installDshSystemdService({ dshHome, profile: 'web' }, {
      home,
      platform: 'linux',
      nodePath: '/usr/bin/node',
      dshPath: '/home/test/.local/bin/dsh',
      path: '/home/test/.local/bin:/usr/bin:/bin',
      run,
    })

    expect(installed.target).toBe('dsh-profile-web.service')
    expect(installed.logCommand).toBe('journalctl --user -u dsh-profile-web.service -f')
    expect((await stat(installed.unitPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(installed.unitPath, 'utf8')).toContain('Restart=on-failure')
    expect(commands.map(command => [command.command, ...command.args])).toEqual([
      ['/usr/bin/systemctl', '--user', 'daemon-reload'],
      ['/usr/bin/systemctl', '--user', 'enable', 'dsh-profile-web.service'],
      ['/usr/bin/systemctl', '--user', 'restart', 'dsh-profile-web.service'],
      ['/usr/bin/systemctl', '--user', 'is-active', '--quiet', 'dsh-profile-web.service'],
    ])
  })
})
