import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createSystemdUserUnit,
  installDshSystemdService,
  prepareDshSystemdUserService,
  renderDshSystemdService,
  systemdServicePaths,
} from '../src/systemd.ts'
import { rsiServiceEnvironmentPath } from '../src/rsi-service-environment.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function temporaryHome(prefix: string): Promise<string> {
  const path = await mkdtemp(join(await realpath(tmpdir()), prefix)); roots.push(path); return path
}

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
    expect(unit).toContain('WorkingDirectory=/home/test/.dsh/profiles/web')
    expect(unit).toContain('Environment="DSH_HOME=/home/test/.dsh"')
    expect(unit).toContain('Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus"')
    expect(unit).toContain('StartLimitIntervalSec=0')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('TimeoutStopSec=30')
    expect(unit).toContain('UMask=0077')
    expect(unit).not.toMatch(/TOKEN|SECRET|PASSWORD/u)
  })

  test('writes literal dynamic values in syntax accepted by systemd 252', () => {
    const unit = createSystemdUserUnit({
      unitName: 'dsh-profile-web.service',
      unitPath: '/home/test/.config/systemd/user/dsh-profile-web.service',
      dshHome: '/home/test user/quote"/slash\\/100%/.dsh',
      profile: 'web',
      profileDirectory: '/home/test user/quote"/slash\\/100%/.dsh/profiles/web',
      nodePath: '/home/test user/quote"/slash\\/100%/bin/node',
      dshPath: '/home/test user/quote"/slash\\/100%/bin/dsh',
      path: '/home/test user/quote"/slash\\/100%/bin:/usr/bin:/bin',
    })

    expect(unit).toContain(String.raw`WorkingDirectory=/home/test user/quote"/slash\/100%%/.dsh/profiles/web` + '\n')
    expect(unit).not.toContain('WorkingDirectory="')
    expect(unit).toContain(String.raw`Environment="DSH_HOME=/home/test user/quote\"/slash\\/100%%/.dsh"`)
    expect(unit).toContain(String.raw`Environment="PATH=/home/test user/quote\"/slash\\/100%%/bin:/usr/bin:/bin"`)
    expect(unit).toContain(String.raw`ExecStart="/home/test user/quote\"/slash\\/100%%/bin/node" --disable-warning=ExperimentalWarning "/home/test user/quote\"/slash\\/100%%/bin/dsh"`)
    expect(unit).toContain('Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus"')
    expect(unit).toContain('Environment="XDG_RUNTIME_DIR=%t"')
  })

  test('enables lingering without sudo and verifies the user manager before onboarding', async () => {
    let linger = false
    const commands: Array<readonly string[]> = []
    const run = vi.fn((command: string, args: readonly string[]) => {
      commands.push([command, ...args])
      if (command.endsWith('/loginctl') && args[0] === 'show-user') {
        return { status: 0, stdout: linger ? 'yes\n' : 'no\n', stderr: '' }
      }
      if (command.endsWith('/loginctl') && args[0] === '--no-ask-password') linger = true
      return { status: 0, stdout: '', stderr: '' }
    })

    await expect(prepareDshSystemdUserService({
      dshHome: '/home/test/.dsh',
      profile: 'web',
    }, {
      home: '/home/test',
      platform: 'linux',
      uid: 1000,
      loginctlPath: '/usr/bin/loginctl',
      systemctlPath: '/usr/bin/systemctl',
      run,
    })).resolves.toEqual({ enabledLinger: true })

    expect(commands).toEqual([
      ['/usr/bin/loginctl', 'show-user', '1000', '--property=Linger', '--value'],
      ['/usr/bin/loginctl', '--no-ask-password', 'enable-linger', '1000'],
      ['/usr/bin/loginctl', 'show-user', '1000', '--property=Linger', '--value'],
      ['/usr/bin/systemctl', '--user', 'show-environment'],
    ])
    expect(commands.flat()).not.toContain('sudo')
  })

  test('stops before OAuth with one explicit command when lingering needs administrator approval', async () => {
    const run = vi.fn((command: string, args: readonly string[]) => {
      if (command.endsWith('/loginctl') && args[0] === 'show-user') {
        return { status: 0, stdout: 'no\n', stderr: '' }
      }
      return { status: 1, stdout: '', stderr: 'authorization required' }
    })

    await expect(prepareDshSystemdUserService({
      dshHome: '/home/test/.dsh',
      profile: 'web',
    }, {
      home: '/home/test',
      platform: 'linux',
      uid: 1000,
      loginctlPath: '/usr/bin/loginctl',
      systemctlPath: '/usr/bin/systemctl',
      run,
    })).rejects.toThrow('run `sudo loginctl enable-linger "$(id -u)"` and retry')
    expect(run.mock.calls.some(([command]) => command === '/usr/bin/systemctl')).toBe(false)
  })

  test('rejects an unreachable systemd user manager after persistence is ready', async () => {
    const run = vi.fn((command: string) => command.endsWith('/loginctl')
      ? { status: 0, stdout: 'yes\n', stderr: '' }
      : { status: 1, stdout: '', stderr: 'Failed to connect to bus' })

    await expect(prepareDshSystemdUserService({
      dshHome: '/home/test/.dsh',
      profile: 'web',
    }, {
      home: '/home/test',
      platform: 'linux',
      uid: 1000,
      loginctlPath: '/usr/bin/loginctl',
      systemctlPath: '/usr/bin/systemctl',
      run,
    })).rejects.toThrow('systemd user manager is unavailable')
  })

  test.each([
    ['ENOENT', 'disappeared before Linux logout-persistence check'],
    ['ETIMEDOUT', 'Linux logout-persistence check timed out'],
  ])('reports a static diagnostic when loginctl fails to start with %s', async (errorCode, expected) => {
    const run = vi.fn(() => ({
      status: null,
      stdout: '',
      stderr: 'untrusted provider detail',
      errorCode,
    }))

    const promise = prepareDshSystemdUserService({
      dshHome: '/home/test/.dsh',
      profile: 'web',
    }, {
      home: '/home/test',
      platform: 'linux',
      uid: 1000,
      loginctlPath: '/opt/systemd/bin/loginctl',
      systemctlPath: '/opt/systemd/bin/systemctl',
      run,
    })
    await expect(promise).rejects.toThrow(expected)
    await expect(promise).rejects.not.toThrow('untrusted provider detail')
  })

  test('atomically installs, enables, restarts, and verifies the user unit', async () => {
    const home = await temporaryHome('dsh-systemd-')
    const dshHome = join(home, '.dsh')
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    const commands: Array<{ command: string; args: readonly string[] }> = []
    const run = vi.fn((command: string, args: readonly string[]) => {
      commands.push({ command, args })
      return {
        status: 0,
        stdout: command.endsWith('/loginctl') ? 'yes\n' : '',
        stderr: '',
      }
    })

    const installed = await installDshSystemdService({ dshHome, profile: 'web' }, {
      home,
      platform: 'linux',
      nodePath: '/usr/bin/node',
      dshPath: '/home/test/.local/bin/dsh',
      path: '/home/test/.local/bin:/usr/bin:/bin',
      uid: 1000,
      loginctlPath: '/usr/bin/loginctl',
      systemctlPath: '/usr/bin/systemctl',
      run,
    })

    expect(installed.target).toBe('dsh-profile-web.service')
    expect(installed.logCommand).toBe('journalctl --user -u dsh-profile-web.service -f')
    expect((await stat(installed.unitPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(installed.unitPath, 'utf8')).toContain('Restart=always')
    expect(commands.map(command => [command.command, ...command.args])).toEqual([
      ['/usr/bin/loginctl', 'show-user', '1000', '--property=Linger', '--value'],
      ['/usr/bin/systemctl', '--user', 'show-environment'],
      ['/usr/bin/systemctl', '--user', 'daemon-reload'],
      ['/usr/bin/systemctl', '--user', 'enable', 'dsh-profile-web.service'],
      ['/usr/bin/systemctl', '--user', 'restart', 'dsh-profile-web.service'],
      ['/usr/bin/systemctl', '--user', 'is-active', '--quiet', 'dsh-profile-web.service'],
    ])
  })

  test('renders persisted RSI paths in sorted order and preserves them on reinstall', async () => {
    const home = await temporaryHome('dsh-systemd-rsi-')
    const dshHome = join(home, 'dsh 100%')
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    await mkdir(join(dshHome, 'rsi-service-environments'), { mode: 0o700 })
    const config = join(home, 'private config 100% "quoted".json')
    await writeFile(config, '{}', { mode: 0o600 })
    await writeFile(rsiServiceEnvironmentPath(dshHome, 'web'), JSON.stringify({
      schemaVersion: 1, dshHome, profile: 'web', environment: {
        DSH_SYSTEMD_HOST_ATTESTOR_CONFIG: config,
        DSH_RELEASE_PR_CONFIG: config,
      },
    }), { mode: 0o600 })
    const options = {
      home, platform: 'linux' as const, nodePath: '/usr/bin/node', dshPath: '/usr/bin/dsh',
      path: '/usr/bin:/bin', uid: 1000, loginctlPath: '/usr/bin/loginctl', systemctlPath: '/usr/bin/systemctl',
      run: vi.fn((command: string) => ({ status: 0, stdout: command.endsWith('/loginctl') ? 'yes\n' : '', stderr: '' })),
    }
    const rendered = await renderDshSystemdService({ dshHome, profile: 'web' }, options)
    const expectedLine = `Environment="DSH_RELEASE_PR_CONFIG=${config.replace(/%/gu, '%%').replace(/"/gu, '\\"')}"`
    expect(rendered.source).toContain(expectedLine)
    expect(rendered.source.indexOf('DSH_RELEASE_PR_CONFIG')).toBeLessThan(rendered.source.indexOf('DSH_SYSTEMD_HOST_ATTESTOR_CONFIG'))
    expect(rendered.source.indexOf('DSH_SYSTEMD_HOST_ATTESTOR_CONFIG')).toBeLessThan(rendered.source.indexOf('ExecStart='))
    const first = await installDshSystemdService({ dshHome, profile: 'web' }, options)
    expect(await readFile(first.unitPath, 'utf8')).toBe(rendered.source)
    const second = await installDshSystemdService({ dshHome, profile: 'web' }, options)
    expect(await readFile(second.unitPath, 'utf8')).toBe(rendered.source)
  })

  test('uses an explicit transaction environment and ignores ambient RSI variables', async () => {
    const home = await temporaryHome('dsh-systemd-rsi-render-')
    const dshHome = join(home, '.dsh')
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    const input = { dshHome, profile: 'web' }
    const options = { home, platform: 'linux' as const, nodePath: '/usr/bin/node', dshPath: '/usr/bin/dsh', path: '/usr/bin:/bin' }
    vi.stubEnv('DSH_RELEASE_BUILD_CONFIG', '/ambient/private.json')
    try {
      const legacy = await renderDshSystemdService(input, options)
      expect(legacy.source).not.toContain('DSH_RELEASE_BUILD_CONFIG')
      const explicit = await renderDshSystemdService(input, {
        ...options, environment: { DSH_RELEASE_BUILD_CONFIG: '/explicit/private.json' },
      })
      expect(explicit.source).toContain('Environment="DSH_RELEASE_BUILD_CONFIG=/explicit/private.json"')
    } finally { vi.unstubAllEnvs() }
  })

  test('rejects a malformed existing binding before invoking systemd commands or writing a unit', async () => {
    const home = await temporaryHome('dsh-systemd-rsi-bad-')
    const dshHome = join(home, '.dsh')
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    await mkdir(join(dshHome, 'rsi-service-environments'), { mode: 0o700 })
    await writeFile(rsiServiceEnvironmentPath(dshHome, 'web'), '{', { mode: 0o600 })
    const run = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }))
    const paths = systemdServicePaths({ home, dshHome, profile: 'web' })
    await expect(installDshSystemdService({ dshHome, profile: 'web' }, {
      home, platform: 'linux', nodePath: '/usr/bin/node', dshPath: '/usr/bin/dsh',
      loginctlPath: '/usr/bin/loginctl', systemctlPath: '/usr/bin/systemctl', run,
    })).rejects.toThrow('invalid environment JSON')
    expect(run).not.toHaveBeenCalled()
    await expect(readFile(paths.unitPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
