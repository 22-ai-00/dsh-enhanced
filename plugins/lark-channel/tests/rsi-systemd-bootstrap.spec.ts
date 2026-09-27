import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { captureRsiSystemdUnitProperties, parseRsiSystemdShow, readRsiSystemdUnitProperties,
  type RsiSystemdCaptureOptions, type RsiSystemdCommand, type RsiSystemdResult } from '../src/rsi-systemd-bootstrap.js'
import { systemdServicePaths } from '../src/systemd.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const exec = '{ path=/usr/bin/node ; argv[]=/usr/bin/node --profile web ; ignore_errors=no ; start_time=[Mon 2026-09-28 01:00:00 UTC] }'
async function fixture(original: Buffer | null = Buffer.from('[Service]\nType=simple\n')) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'rsi-systemd-capture-')); roots.push(home)
  const dshHome = join(home, '.dsh'), profile = 'web'
  await mkdir(join(dshHome, 'profiles', profile), { recursive: true, mode: 0o700 })
  const { unitPath, unitName } = systemdServicePaths({ dshHome, profile, home })
  await mkdir(dirname(unitPath), { recursive: true, mode: 0o700 })
  if (original) await writeFile(unitPath, original, { mode: 0o640 })
  const systemctlPath = await realpath('/usr/bin/true')
  const systemctl = { path: systemctlPath, sha256: createHash('sha256').update(await readFile(systemctlPath)).digest('hex'), interpreter: null }
  const commands: string[][] = []
  let failStatusAt = 0, statusCount = 0
  const run = async (request: RsiSystemdCommand): Promise<RsiSystemdResult> => {
    commands.push([...request.args])
    if (request.args.includes('daemon-reload')) return { status: 0, stdout: '', stderr: '' }
    if (request.args.includes('show')) {
      const keys = request.args.filter(arg => arg.startsWith('--property=')).map(arg => arg.slice('--property='.length))
      if (!keys.includes('FragmentPath')) {
        statusCount++
        if (statusCount === failStatusAt) return { status: 1, stdout: '', stderr: 'injected failure' }
      }
      const present = await stat(unitPath).then(() => true, () => false)
      const values: Record<string, string> = {
        Id: unitName, LoadState: present ? 'loaded' : 'not-found', ActiveState: 'inactive', SubState: 'dead',
        MainPID: '0', ControlPID: '0', ControlGroup: '', Job: '0',
        FragmentPath: present ? unitPath : '', DropInPaths: '', ExecStart: exec,
        Environment: 'DSH_HOME=/test PATH=/usr/bin', WorkingDirectory: join(dshHome, 'profiles', profile),
        User: '', Group: '', Type: 'simple', KillMode: 'control-group',
      }
      return { status: 0, stdout: keys.map(key => `${key}=${values[key]}`).join('\n') + '\n', stderr: '' }
    }
    throw new Error(`unexpected systemctl command ${request.args.join(' ')}`)
  }
  const options: RsiSystemdCaptureOptions = { home, nodePath: '/usr/bin/node', dshPath: '/usr/bin/dsh',
    path: '/usr/bin:/bin', systemctl, run }
  return { home, dshHome, profile, unitPath, unitName, commands, options,
    failNextRestoreStatus() { failStatusAt = statusCount + 2 },
    journalPath: join(dshHome, '.rsi-systemd-capture-journal.json') }
}

describe.skipIf(process.platform !== 'linux')('RSI systemd unit property capture', () => {
  test('loads rendered bytes at the actual target path, reads nine properties, and restores original bytes and mode', async () => {
    const original = Buffer.from('[Service]\nType=simple\n# original exact bytes\n')
    const f = await fixture(original)
    const observed = await captureRsiSystemdUnitProperties(f, f.options)
    expect(observed).toEqual({ FragmentPath: f.unitPath, DropInPaths: '',
      ExecStart: '{ path=/usr/bin/node ; argv[]=/usr/bin/node --profile web ; ignore_errors=no ; }',
      Environment: 'DSH_HOME=/test PATH=/usr/bin', WorkingDirectory: join(f.dshHome, 'profiles', 'web'),
      User: '', Group: '', Type: 'simple', KillMode: 'control-group' })
    expect(await readFile(f.unitPath)).toEqual(original)
    expect((await stat(f.unitPath)).mode & 0o777).toBe(0o640)
    await expect(stat(f.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.commands.filter(args => args.includes('daemon-reload'))).toHaveLength(2)
    expect(f.commands.flat()).not.toContain('start')
    expect(f.commands.flat()).not.toContain('restart')
  })

  test('restores interrupted capture on retry before collecting again', async () => {
    const f = await fixture()
    const original = await readFile(f.unitPath)
    f.failNextRestoreStatus()
    await expect(captureRsiSystemdUnitProperties(f, f.options)).rejects.toThrow('systemctl show failed')
    expect(await stat(f.journalPath)).toBeTruthy()
    expect(await readFile(f.unitPath)).not.toEqual(original)
    await expect(captureRsiSystemdUnitProperties(f, f.options)).resolves.toHaveProperty('FragmentPath', f.unitPath)
    expect(await readFile(f.unitPath)).toEqual(original)
    await expect(stat(f.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('refuses external unit drift while retaining the recovery journal', async () => {
    const f = await fixture(null)
    f.failNextRestoreStatus()
    await expect(captureRsiSystemdUnitProperties(f, f.options)).rejects.toThrow('systemctl show failed')
    const rogue = Buffer.from('[Service]\nExecStart=/bin/rogue\n')
    await writeFile(f.unitPath, rogue)
    await expect(captureRsiSystemdUnitProperties(f, f.options)).rejects.toThrow('unit changed outside capture')
    expect(await readFile(f.unitPath)).toEqual(rogue)
    expect(await stat(f.journalPath)).toBeTruthy()
  })

  test('rejects duplicate or incomplete show output and never accepts an active Host', async () => {
    expect(() => parseRsiSystemdShow('Id=one\nId=two\n', ['Id'])).toThrow('duplicate')
    expect(() => parseRsiSystemdShow('Id=one\n', ['Id', 'LoadState'])).toThrow('missing')
    const f = await fixture()
    const original = f.options.run!
    f.options.run = async request => {
      const result = await original(request)
      if (request.args.includes('show')) return { ...result, stdout: result.stdout.replace('ActiveState=inactive', 'ActiveState=active') }
      return result
    }
    const before = await readFile(f.unitPath)
    await expect(captureRsiSystemdUnitProperties(f, f.options)).rejects.toThrow('not fully stopped')
    expect(await readFile(f.unitPath)).toEqual(before)
    await expect(stat(f.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('reads loaded properties after start and rejects a drop-in override', async () => {
    const f = await fixture()
    const original = f.options.run!
    f.options.run = async request => {
      const result = await original(request)
      if (request.args.includes('show')) return { ...result, stdout: result.stdout.replace('ActiveState=inactive', 'ActiveState=active') }
      return result
    }
    await expect(readRsiSystemdUnitProperties(f, f.options)).resolves.toHaveProperty('FragmentPath', f.unitPath)
    const active = f.options.run!
    f.options.run = async request => {
      const result = await active(request)
      return { ...result, stdout: result.stdout.replace('DropInPaths=\n', 'DropInPaths=/etc/systemd/override.conf\n') }
    }
    await expect(readRsiSystemdUnitProperties(f, f.options)).rejects.toThrow('loaded unit differs')
    expect(f.commands.filter(args => args.includes('daemon-reload'))).toHaveLength(0)
  })
})

test.skipIf(process.platform !== 'linux' || process.env.RSI_SYSTEMD_LIVE_PROBE !== '1')(
  'live isolated user-manager capture probe never starts the temporary unit', async () => {
    const home = homedir()
    const dshHome = await mkdtemp(join(await realpath(tmpdir()), 'rsi-systemd-live-'))
    const profile = `rsi-probe-${randomBytes(6).toString('hex')}`
    const { unitName, unitPath } = systemdServicePaths({ home, dshHome, profile })
    const systemctlPath = await realpath('/usr/bin/systemctl')
    const systemctl = { path: systemctlPath,
      sha256: createHash('sha256').update(await readFile(systemctlPath)).digest('hex'), interpreter: null }
    const manager = spawnSync(systemctlPath, ['--user', 'show-environment'], { timeout: 5000, encoding: 'utf8' })
    if (manager.status !== 0 || manager.error) throw new Error('isolated live probe requires a running user manager')
    await expect(stat(unitPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await mkdir(join(dshHome, 'profiles', profile), { recursive: true, mode: 0o700 })
    try {
      const properties = await captureRsiSystemdUnitProperties({ dshHome, profile }, {
        home, nodePath: process.execPath, dshPath: systemctlPath, systemctl,
      })
      expect(properties).toMatchObject({ FragmentPath: unitPath, DropInPaths: '', Type: 'simple', KillMode: 'control-group' })
      await expect(stat(unitPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const status = spawnSync(systemctlPath, ['--user', 'show', unitName, '--property=ActiveState', '--value'],
        { timeout: 5000, encoding: 'utf8' })
      expect(status.status).toBe(0)
      expect(status.stdout.trim()).toBe('inactive')
    } finally {
      await rm(unitPath, { force: true })
      const reload = spawnSync(systemctlPath, ['--user', 'daemon-reload'], { timeout: 5000, encoding: 'utf8' })
      expect(reload.status).toBe(0)
      expect(reload.error).toBeUndefined()
      await rm(dshHome, { recursive: true, force: true })
    }
  }, 30_000)
