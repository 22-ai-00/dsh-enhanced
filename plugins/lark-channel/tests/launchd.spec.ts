import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { createLaunchAgent, installDshLaunchAgent, launchAgentPaths } from '../src/launchd.ts'

describe('DSH profile LaunchAgent', () => {
  test('runs one profile headlessly with a stable label and no ambient secrets', () => {
    const paths = launchAgentPaths({
      home: '/Users/test',
      dshHome: '/Users/test/.dsh',
      profile: 'web',
    })
    expect(paths).toEqual({
      label: 'ai.deepseek.dsh.profile.web',
      plistPath: '/Users/test/Library/LaunchAgents/ai.deepseek.dsh.profile.web.plist',
      stdoutPath: '/Users/test/.dsh/logs/web-host.log',
      stderrPath: '/Users/test/.dsh/logs/web-host.error.log',
    })

    const plist = createLaunchAgent({
      ...paths,
      dshHome: '/Users/test/.dsh',
      profile: 'web',
      profileDirectory: '/Users/test/.dsh/profiles/web',
      nodePath: '/opt/homebrew/bin/node',
      dshPath: '/Users/test/.npm-global/bin/dsh',
      path: '/opt/homebrew/bin:/Users/test/.npm-global/bin:/usr/bin:/bin',
    })

    expect(plist).toContain('<string>ai.deepseek.dsh.profile.web</string>')
    expect(plist).toContain('<string>--disable-warning=ExperimentalWarning</string>')
    expect(plist).toContain('<string>--profile</string>\n    <string>web</string>\n    <string>--no-open</string>')
    expect(plist).toContain('<key>DSH_HOME</key>\n      <string>/Users/test/.dsh</string>')
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>')
    expect(plist).not.toMatch(/TOKEN|SECRET|PASSWORD/u)
  })

  test('escapes filesystem values before writing XML', () => {
    const plist = createLaunchAgent({
      label: 'ai.deepseek.dsh.profile.web',
      plistPath: '/tmp/service.plist',
      stdoutPath: '/tmp/a&b.log',
      stderrPath: '/tmp/error.log',
      dshHome: '/Users/a&b/.dsh',
      profile: 'web',
      profileDirectory: '/Users/a&b/.dsh/profiles/web',
      nodePath: '/opt/homebrew/bin/node',
      dshPath: '/tmp/<dsh>',
      path: '/usr/bin:/bin',
    })
    expect(plist).toContain('/Users/a&amp;b/.dsh')
    expect(plist).toContain('/tmp/&lt;dsh&gt;')
    expect(plist).not.toContain('/Users/a&b/.dsh')
  })

  test('atomically installs a private plist and replaces the user service', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-launchd-'))
    const dshHome = join(home, '.dsh')
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    const commands: Array<{ command: string; args: readonly string[] }> = []
    const wait = vi.fn(async (_milliseconds: number) => {})
    const run = vi.fn((command: string, args: readonly string[]) => {
      commands.push({ command, args })
      return { status: command === '/bin/launchctl' && args[0] === 'bootout' ? 3 : 0, stderr: '' }
    })

    const installed = await installDshLaunchAgent({ dshHome, profile: 'web' }, {
      home,
      uid: 501,
      nodePath: '/opt/homebrew/bin/node',
      dshPath: '/Users/test/.npm-global/bin/dsh',
      path: '/usr/bin:/bin',
      platform: 'darwin',
      run,
      wait,
    })

    expect(installed.target).toBe('gui/501/ai.deepseek.dsh.profile.web')
    expect((await stat(installed.plistPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(installed.plistPath, 'utf8')).toContain('<string>--no-open</string>')
    expect(commands.map(command => [command.command, ...command.args])).toEqual([
      ['/usr/bin/plutil', '-lint', expect.stringContaining('.plist.tmp-')],
      ['/bin/launchctl', 'bootout', installed.target],
      ['/bin/launchctl', 'enable', installed.target],
      ['/bin/launchctl', 'bootstrap', 'gui/501', installed.plistPath],
      ['/bin/launchctl', 'print', installed.target],
      ['/bin/launchctl', 'print', installed.target],
    ])
    expect(wait).toHaveBeenCalledWith(250)
  })

  test('recovers from a transient launchd bootstrap EIO after confirming the job is still absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-launchd-eio-'))
    const dshHome = join(home, '.dsh')
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    const commands: Array<{ command: string; args: readonly string[] }> = []
    let bootstrapAttempts = 0
    const run = vi.fn((command: string, args: readonly string[]) => {
      commands.push({ command, args })
      if (command === '/bin/launchctl' && args[0] === 'bootout') return { status: 3, stderr: 'not loaded' }
      if (command === '/bin/launchctl' && args[0] === 'print') {
        return bootstrapAttempts >= 2
          ? { status: 0, stderr: '' }
          : { status: 3, stderr: 'not loaded' }
      }
      if (command === '/bin/launchctl' && args[0] === 'bootstrap') {
        bootstrapAttempts += 1
        return bootstrapAttempts === 1
          ? { status: 5, stderr: 'Bootstrap failed: 5: Input/output error' }
          : { status: 0, stderr: '' }
      }
      return { status: 0, stderr: '' }
    })
    const wait = vi.fn(async (_milliseconds: number) => {})

    await expect(installDshLaunchAgent({ dshHome, profile: 'web' }, {
      home,
      uid: 501,
      nodePath: '/opt/homebrew/bin/node',
      dshPath: '/Users/test/.npm-global/bin/dsh',
      path: '/usr/bin:/bin',
      platform: 'darwin',
      run,
      wait,
    })).resolves.toMatchObject({ target: 'gui/501/ai.deepseek.dsh.profile.web' })

    expect(wait).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenNthCalledWith(1, 250)
    expect(wait).toHaveBeenNthCalledWith(2, 250)
    expect(commands.filter(command => command.args[0] === 'bootstrap')).toHaveLength(2)
    expect(commands.some(command => command.args[0] === 'print'
      && command.args[1] === 'gui/501/ai.deepseek.dsh.profile.web')).toBe(true)
  })

  test('retries when bootstrap reports success but the job is not registered', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-launchd-missing-'))
    const dshHome = join(home, '.dsh')
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    let bootstrapAttempts = 0
    let firstAttemptPrints = 0
    const run = vi.fn((command: string, args: readonly string[]) => {
      if (command === '/bin/launchctl' && args[0] === 'bootout') return { status: 0, stderr: '' }
      if (command === '/bin/launchctl' && args[0] === 'bootstrap') {
        bootstrapAttempts += 1
        return { status: 0, stderr: '' }
      }
      if (command === '/bin/launchctl' && args[0] === 'print') {
        if (bootstrapAttempts >= 2) return { status: 0, stderr: '' }
        firstAttemptPrints += 1
        return firstAttemptPrints === 1
          ? { status: 0, stderr: '' }
          : { status: 3, stderr: 'not loaded' }
      }
      return { status: 0, stderr: '' }
    })
    const wait = vi.fn(async (_milliseconds: number) => {})

    await expect(installDshLaunchAgent({ dshHome, profile: 'web' }, {
      home,
      uid: 501,
      nodePath: '/opt/homebrew/bin/node',
      dshPath: '/Users/test/.npm-global/bin/dsh',
      path: '/usr/bin:/bin',
      platform: 'darwin',
      run,
      wait,
    })).resolves.toMatchObject({ target: 'gui/501/ai.deepseek.dsh.profile.web' })

    expect(bootstrapAttempts).toBe(2)
    expect(wait).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenNthCalledWith(1, 250)
    expect(wait).toHaveBeenNthCalledWith(2, 250)
  })
})
