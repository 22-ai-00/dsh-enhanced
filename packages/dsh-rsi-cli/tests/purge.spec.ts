import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createFakeBin, type FakeBin } from './fake-bin.ts'
import {
  listLifecycleResiduals,
  listProfiles,
  listProfilePlugins,
} from '../src/paths.ts'
import { scanCredentialLocators } from '../src/secrets.ts'
import { runPurge, PurgeError } from '../src/purge.ts'
import type { CommandRunner } from '../src/run.ts'
import { withLaunchdProfileLock } from '../src/launchd-lock.ts'

const lockTrace = vi.hoisted(() => ({ home: false, profiles: new Set<string>(), order: [] as string[] }))
vi.mock('../src/launchd-lock.ts', () => ({ withLaunchdProfileLock: (profile: string,
  operation: () => Promise<unknown>) => {
  if (lockTrace.profiles.has(profile)) throw new Error(`busy target ${profile}`)
  lockTrace.profiles.add(profile)
  lockTrace.order.push(profile)
  return operation().finally(() => { lockTrace.profiles.delete(profile) })
} }))
vi.mock('../src/home-lifecycle-lock.ts', () => ({ withDshHomeLifecycleLock: (_home: string,
  operation: () => Promise<unknown>) => {
  if (lockTrace.home) throw new Error('busy home')
  lockTrace.home = true
  return operation().finally(() => { lockTrace.home = false })
} }))

interface Fixture {
  root: string
  home: string
  dshHome: string
  checkout: string
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'rsi-cli-test-'))
  const home = join(root, 'home')
  const dshHome = join(home, '.dsh')
  const checkout = join(root, 'checkout')
  await mkdir(join(dshHome, 'profiles', 'web', 'node_modules', '@dsh-enhanced', 'assistant-policy'), { recursive: true })
  await writeFile(join(dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }))
  await mkdir(join(dshHome, 'profiles', 'web', 'node_modules', '@dsh-enhanced', 'lark-channel'), { recursive: true })
  await mkdir(join(dshHome, 'logs'), { recursive: true })
  await mkdir(join(checkout, 'plugins', 'personal-assistant'), { recursive: true })
  // npm 实体副本 + local 符号链接两种形态
  await symlink(
    join(checkout, 'plugins', 'personal-assistant'),
    join(dshHome, 'profiles', 'web', 'node_modules', '@dsh-enhanced', 'personal-assistant'),
  )
  // lark setup journal：含 keychain / secret-service locator 与一个 protected-file（应被忽略）
  await writeFile(
    join(dshHome, 'profiles', 'web', 'cordis.patch.yml.lark-setup.journal.json'),
    JSON.stringify({
      version: 1,
      dshHome,
      profile: 'web',
      patchPath: join(dshHome, 'profiles', 'web', 'cordis.patch.yml'),
      locators: [
        { provider: 'linux-secret-service', service: 'dsh/lark/web/acct1/versions/v1', account: 'acct1' },
        { provider: 'macos-keychain', service: 'dsh/lark/web/acct2', account: 'acct2' },
        { provider: 'linux-protected-file', path: join(dshHome, 'credentials-keychain', 'lark-web-a-v1.secret') },
      ],
      sha256: 'x',
    }),
  )
  await writeFile(join(dshHome, 'logs', 'web-host.log'), 'stdout')
  await writeFile(join(dshHome, 'logs', 'web-host.error.log'), 'boom')
  return { root, home, dshHome, checkout }
}

/** 经假 PATH 执行；tar 等未造假的命令落到真实 /usr/bin。绝对路径的凭据命令改写为假命令。 */
function fakeRunner(fakeBin: FakeBin): CommandRunner {
  return (command, args) => {
    const resolved = command.startsWith('/usr/bin/') ? join(fakeBin.bin, command.slice('/usr/bin/'.length)) : command
    const result = spawnSync(resolved, [...args], {
      env: { ...process.env, PATH: `${fakeBin.bin}:${process.env.PATH ?? '/usr/bin:/bin'}` },
      maxBuffer: 16 * 1024 * 1024,
    })
    return {
      status: result.status,
      stdout: result.stdout?.toString() ?? '',
      stderr: result.stderr?.toString() ?? '',
    }
  }
}

describe('paths 枚举', () => {
  test('区分 npm 实体副本与 local 符号链接', async () => {
    const fixture = await makeFixture()
    try {
      expect(await listProfiles(fixture.dshHome)).toEqual(['web'])
      const plugins = await listProfilePlugins(fixture.dshHome, 'web')
      expect(plugins.map(p => [p.name, p.kind])).toEqual([
        ['@dsh-enhanced/assistant-policy', 'npm'],
        ['@dsh-enhanced/lark-channel', 'npm'],
        ['@dsh-enhanced/personal-assistant', 'local'],
      ])
      expect(plugins.find(p => p.name === '@dsh-enhanced/personal-assistant')?.linkTarget)
        .toBe(join(fixture.checkout, 'plugins', 'personal-assistant'))
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('忽略 profiles/node_modules、缓存目录和不含 manifest 的普通目录', async () => {
    const fixture = await makeFixture()
    try {
      await mkdir(join(fixture.dshHome, 'profiles', 'node_modules'), { recursive: true })
      await mkdir(join(fixture.dshHome, 'profiles', '.cache'), { recursive: true })
      await mkdir(join(fixture.dshHome, 'profiles', 'staging-without-manifest'), { recursive: true })
      expect(await listProfiles(fixture.dshHome)).toEqual(['web'])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('拒绝把符号链接目录或符号链接 package.json 当作 profile', async () => {
    const fixture = await makeFixture()
    try {
      const external = join(fixture.root, 'external-profile')
      await mkdir(external)
      await writeFile(join(external, 'package.json'), '{}')
      await symlink(external, join(fixture.dshHome, 'profiles', 'linked-profile'))
      const fake = join(fixture.dshHome, 'profiles', 'fake')
      await mkdir(fake)
      await symlink(join(external, 'package.json'), join(fake, 'package.json'))
      expect(await listProfiles(fixture.dshHome)).toEqual(['web'])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('识别事务/诊断目录、home 锁与 rendezvous 锁', async () => {
    const fixture = await makeFixture()
    try {
      const uid = process.getuid!()
      const parent = await readdir(fixture.home)
      const residuals = await listLifecycleResiduals(fixture.dshHome, parent, [], uid)
      expect(residuals).toEqual([])

      await mkdir(join(fixture.home, '.dsh.dsh-enhanced-transaction'))
      await mkdir(join(fixture.home, '.dsh.dsh-enhanced-transaction.failed-web-20260921T000000Z-123'))
      await writeFile(join(fixture.home, '.dsh.dsh-enhanced-lifecycle.lock'), '')
      const { createHash } = await import('node:crypto')
      const rendezvous = `.dsh-enhanced-lifecycle-${uid}-${createHash('sha256').update(fixture.dshHome).digest('hex')}.lock`
      const withLocks = await listLifecycleResiduals(
        fixture.dshHome, await readdir(fixture.home), [rendezvous, 'unrelated.txt'], uid,
      )
      expect(withLocks.sort()).toEqual([
        join(fixture.home, '.dsh.dsh-enhanced-lifecycle.lock'),
        join(fixture.home, '.dsh.dsh-enhanced-transaction'),
        join(fixture.home, '.dsh.dsh-enhanced-transaction.failed-web-20260921T000000Z-123'),
        join('/tmp', rendezvous),
      ].sort())
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})

describe('scanCredentialLocators', () => {
  test('只收录受管外部凭据库条目并去重', async () => {
    const fixture = await makeFixture()
    try {
      await writeFile(
        join(fixture.dshHome, 'profiles', 'web', 'cordis.patch.yml.lark-credential-cleanup.json'),
        JSON.stringify({ locators: [
          { provider: 'linux-secret-service', service: 'dsh/lark/web/old/versions/v0', account: 'old' },
          { provider: 'linux-secret-service', service: 'dsh/lark/web/acct1/versions/v1', account: 'acct1' },
        ] }),
      )
      const locators = await scanCredentialLocators(fixture.dshHome)
      expect(locators.map(l => l.service).sort()).toEqual([
        'dsh/lark/web/acct1/versions/v1',
        'dsh/lark/web/acct2',
        'dsh/lark/web/old/versions/v0',
      ])
      // 单 profile 过滤
      expect(await scanCredentialLocators(fixture.dshHome, ['other'])).toEqual([])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})

describe('runPurge', () => {
  let fixture: Fixture
  let fakeBin: FakeBin

  beforeEach(async () => {
    fixture = await makeFixture()
    fakeBin = await createFakeBin()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
    await fakeBin.cleanup()
    lockTrace.order.length = 0
  })

  const purge = (override: Partial<Parameters<typeof runPurge>[0]> = {}) => runPurge({
    dshHome: fixture.dshHome,
    home: fixture.home,
    platform: 'linux',
    backup: true,
    keepKeychain: false,
    removeHost: false,
    dryRun: false,
    runner: fakeRunner(fakeBin),
    ...override,
  })

  test('dry-run 不删除任何文件并给出完整计划', async () => {
    const report = await purge({ dryRun: true })
    expect(existsSync(fixture.dshHome)).toBe(true)
    expect(existsSync(join(fixture.dshHome, 'profiles', 'web'))).toBe(true)
    expect(report.removedPaths).toContain(fixture.dshHome)
    expect(report.removedCredentials.some(c => c.includes('dsh/lark/web/acct1'))).toBe(true)
    expect(report.keptCheckouts).toEqual([join(fixture.checkout, 'plugins', 'personal-assistant')])
    expect(report.backup?.archivePath).toMatch(/dsh-purge-backup-.*\.tar\.gz$/)
  })

  test('活动进程时拒绝 purge 且不动数据', async () => {
    process.env.FAKE_PGREP_ACTIVE = join(fakeBin.state, 'active')
    await writeFile(process.env.FAKE_PGREP_ACTIVE, '')
    try {
      await expect(purge()).rejects.toBeInstanceOf(PurgeError)
      expect(existsSync(fixture.dshHome)).toBe(true)
      expect(existsSync(join(fixture.dshHome, 'profiles', 'web'))).toBe(true)
    } finally {
      delete process.env.FAKE_PGREP_ACTIVE
    }
  })

  test('macOS：bootout 失败时中止 purge，保留 plist、Home 与凭据记录', async () => {
    const plistPath = join(fixture.home, 'Library', 'LaunchAgents', 'ai.deepseek.dsh.profile.web.plist')
    await mkdir(join(fixture.home, 'Library', 'LaunchAgents'), { recursive: true })
    const args = ['/usr/bin/node', '/opt/dsh/bin/dsh.js', '--profile', 'web', '--no-open']
    const plist = { Label: 'ai.deepseek.dsh.profile.web', ProgramArguments: args,
      WorkingDirectory: join(fixture.dshHome, 'profiles', 'web'),
      EnvironmentVariables: { DSH_HOME: fixture.dshHome, PATH: '/usr/bin' },
      StandardOutPath: join(fixture.dshHome, 'logs', 'web-host.log'),
      StandardErrorPath: join(fixture.dshHome, 'logs', 'web-host.error.log'),
      LimitLoadToSessionType: 'Aqua', ProcessType: 'Background', RunAtLoad: true,
      KeepAlive: true, ThrottleInterval: 10, ExitTimeOut: 30, Umask: 63 }
    await writeFile(plistPath, JSON.stringify(plist))
    const loaded = `path = ${plistPath}\nworking directory = ${plist.WorkingDirectory}\nDSH_HOME => ${fixture.dshHome}\n`
      + `program = /usr/bin/node\narguments = {\n${args.map(arg => `  ${arg}`).join('\n')}\n}\npid = 123\n`
    const runner: CommandRunner = (command, commandArgs) => {
      if (command === '/usr/bin/plutil') return { status: 0, stdout: readFileSync(plistPath, 'utf8'), stderr: '' }
      if (command === 'launchctl' && commandArgs[0] === 'print') return { status: 0, stdout: loaded, stderr: '' }
      if (command === 'launchctl' && commandArgs[0] === 'bootout') return { status: 5, stdout: '', stderr: 'failure' }
      throw new Error(`unexpected command ${command}`)
    }
    await expect(purge({ platform: 'darwin', runner, backup: false })).rejects.toThrow(/bootout 失败/)
    expect(existsSync(plistPath)).toBe(true)
    expect(existsSync(fixture.dshHome)).toBe(true)
    expect(existsSync(join(fixture.dshHome, 'profiles', 'web', 'cordis.patch.yml.lark-setup.journal.json'))).toBe(true)
  })

  test('macOS：本 Home 的未加载 plist 可正常注销并完成 purge', async () => {
    const plistPath = join(fixture.home, 'Library', 'LaunchAgents', 'ai.deepseek.dsh.profile.web.plist')
    await mkdir(join(fixture.home, 'Library', 'LaunchAgents'), { recursive: true })
    await writeFile(plistPath, JSON.stringify({ Label: 'ai.deepseek.dsh.profile.web',
      ProgramArguments: ['/usr/bin/node', '/opt/dsh/bin/dsh.js', '--profile', 'web', '--no-open'],
      WorkingDirectory: join(fixture.dshHome, 'profiles', 'web'),
      EnvironmentVariables: { DSH_HOME: fixture.dshHome, PATH: '/usr/bin' },
      StandardOutPath: join(fixture.dshHome, 'logs', 'web-host.log'),
      StandardErrorPath: join(fixture.dshHome, 'logs', 'web-host.error.log'),
      LimitLoadToSessionType: 'Aqua', ProcessType: 'Background', RunAtLoad: true,
      KeepAlive: true, ThrottleInterval: 10, ExitTimeOut: 30, Umask: 63 }))
    const fallback = fakeRunner(fakeBin)
    const runner: CommandRunner = (command, commandArgs) => {
      if (command === '/usr/bin/plutil') return { status: 0, stdout: readFileSync(plistPath, 'utf8'), stderr: '' }
      if (command === 'launchctl' && commandArgs[0] === 'print') {
        return { status: 113, stdout: '', stderr: 'Could not find service' }
      }
      return fallback(command, commandArgs)
    }
    const report = await purge({ platform: 'darwin', runner, backup: false, keepKeychain: true })
    expect(report.serviceErrors).toEqual([])
    expect(existsSync(plistPath)).toBe(false)
    expect(existsSync(fixture.dshHome)).toBe(false)
  })

  test('macOS：--yes 不根据同名 dsh 命令行杀其他 Home 进程或删除数据', async () => {
    const calls: string[] = []
    const runner: CommandRunner = (command, args) => {
      calls.push([command, ...args].join(' '))
      if (command === 'launchctl') return { status: 113, stdout: '', stderr: 'Could not find service' }
      if (command === 'pgrep') return { status: 0, stdout: '12345\n', stderr: '' }
      if (command === 'ps') return { status: 0, stdout: 'node /other/home/bin/dsh --profile web --no-open\n', stderr: '' }
      throw new Error(`unexpected command ${command}`)
    }
    await expect(purge({ platform: 'darwin', runner, backup: false, assumeYes: true })).rejects.toThrow(/无法证明归属/)
    expect(calls.some(call => call.startsWith('kill '))).toBe(false)
    expect(existsSync(fixture.dshHome)).toBe(true)
  })

  test('macOS：Home→全部profile锁贯穿停服、备份、删除与凭据清理；不unlink共享锁inode', async () => {
    await mkdir(join(fixture.dshHome, 'profiles', 'alpha'), { recursive: true })
    await writeFile(join(fixture.dshHome, 'profiles', 'alpha', 'package.json'), '{}')
    const rendezvous = `/tmp/.dsh-enhanced-lifecycle-${process.getuid?.()}-${createHash('sha256').update(fixture.dshHome).digest('hex')}.lock`
    await writeFile(rendezvous, '')
    const seen = new Set<string>()
    const fallback = fakeRunner(fakeBin)
    const runner: CommandRunner = (command, args) => {
      if (command === 'launchctl') return { status: 113, stdout: '', stderr: 'Could not find service' }
      if (['pgrep', 'tar', '/usr/bin/security', '/usr/bin/secret-tool'].includes(command)) {
        expect(lockTrace.home).toBe(true)
        expect([...lockTrace.profiles].sort()).toEqual(['alpha', 'web'])
        expect(() => withLaunchdProfileLock('web', async () => {})).toThrow(/busy target web/)
        seen.add(command)
      }
      if (command === '/usr/bin/security') expect(existsSync(fixture.dshHome)).toBe(false)
      return fallback(command, args)
    }
    try {
      const report = await purge({ platform: 'darwin', runner })
      expect(report.removedPaths).not.toContain(rendezvous)
      expect(existsSync(rendezvous)).toBe(true)
      expect(seen).toEqual(new Set(['pgrep', 'tar', '/usr/bin/security', '/usr/bin/secret-tool']))
      expect(lockTrace.order).toEqual(['alpha', 'web'])
      expect(lockTrace.home).toBe(false)
      expect(lockTrace.profiles.size).toBe(0)
    } finally {
      await rm(rendezvous, { force: true })
    }
  })

  test('全量 purge：备份、删除 home/残留/凭据，保留 checkout', async () => {
    await mkdir(join(fixture.home, '.dsh.dsh-enhanced-transaction'))
    const report = await purge()
    expect(existsSync(fixture.dshHome)).toBe(false)
    expect(existsSync(join(fixture.home, '.dsh.dsh-enhanced-transaction'))).toBe(false)
    // checkout 源码保留
    expect(existsSync(join(fixture.checkout, 'plugins', 'personal-assistant'))).toBe(true)
    // 备份真实生成且非空
    expect(report.backup).toBeDefined()
    expect(report.backup!.bytes).toBeGreaterThan(0)
    expect(existsSync(report.backup!.archivePath)).toBe(true)
    // 备份内含被删 profile
    const tar = spawnSync('tar', ['-tzf', report.backup!.archivePath], { encoding: 'utf8' })
    expect(tar.stdout).toContain(join('.dsh', 'profiles', 'web'))
    // 凭据删除走 secret-tool/security（各至少一条）
    const secretCalls = await readFile(join(fakeBin.state, 'secret-tool.log'), 'utf8').catch(() => '')
    const securityCalls = await readFile(join(fakeBin.state, 'security.log'), 'utf8').catch(() => '')
    expect(secretCalls).toContain('dsh/lark/web/acct1/versions/v1')
    expect(securityCalls).toContain('dsh/lark/web/acct2')
    // systemctl 停用
    const systemdCalls = await readFile(join(fakeBin.state, 'systemctl.log'), 'utf8')
    expect(systemdCalls).toContain('disable --now dsh-profile-web.service')
    // host 保留：未调 npm uninstall
    expect(existsSync(join(fakeBin.state, 'npm.log'))).toBe(false)
  })

  test('单 profile purge：只删该 profile 与其日志、失败诊断，保留兄弟 profile 与共享事务', async () => {
    await mkdir(join(fixture.dshHome, 'profiles', 'other'), { recursive: true })
    await mkdir(join(fixture.home, '.dsh.dsh-enhanced-transaction'))
    await mkdir(join(fixture.home, '.dsh.dsh-enhanced-transaction.failed-web-stamp-1'))
    await mkdir(join(fixture.home, '.dsh.dsh-enhanced-transaction.failed-other-stamp-2'))
    const report = await purge({ profile: 'web' })
    expect(existsSync(join(fixture.dshHome, 'profiles', 'web'))).toBe(false)
    expect(existsSync(join(fixture.dshHome, 'profiles', 'other'))).toBe(true)
    expect(existsSync(join(fixture.dshHome, 'logs', 'web-host.error.log'))).toBe(false)
    expect(existsSync(join(fixture.home, '.dsh.dsh-enhanced-transaction'))).toBe(true)
    expect(existsSync(join(fixture.home, '.dsh.dsh-enhanced-transaction.failed-web-stamp-1'))).toBe(false)
    expect(existsSync(join(fixture.home, '.dsh.dsh-enhanced-transaction.failed-other-stamp-2'))).toBe(true)
    // DSH home 本身保留
    expect(report.removedPaths).not.toContain(fixture.dshHome)
    expect(existsSync(fixture.dshHome)).toBe(true)
    // 凭据只清 web 归属
    const secretCalls = await readFile(join(fakeBin.state, 'secret-tool.log'), 'utf8').catch(() => '')
    expect(secretCalls).toContain('dsh/lark/web/acct1/versions/v1')
  })

  test('--remove-host 全量 purge 调 npm uninstall；单 profile 组合被拒', async () => {
    const report = await purge({ removeHost: true })
    expect(report.hostRemoved).toBe(true)
    const npmCalls = await readFile(join(fakeBin.state, 'npm.log'), 'utf8')
    expect(npmCalls).toContain('uninstall -g @deepseek-ai/dsh')
    await expect(purge({ profile: 'web', removeHost: true })).rejects.toBeInstanceOf(PurgeError)
  })

  test('非受管 systemd unit 内容时保留文件（fail-closed）', async () => {
    const unitDirectory = join(fixture.home, '.config', 'systemd', 'user')
    await mkdir(unitDirectory, { recursive: true })
    const unitPath = join(unitDirectory, 'dsh-profile-web.service')
    await writeFile(unitPath, '[Unit]\nDescription=someone else wrote this\n')
    await purge()
    expect(existsSync(unitPath)).toBe(true)
  })

  test('受管 systemd unit 被删除', async () => {
    const unitDirectory = join(fixture.home, '.config', 'systemd', 'user')
    await mkdir(unitDirectory, { recursive: true })
    const unitPath = join(unitDirectory, 'dsh-profile-web.service')
    await writeFile(unitPath, '[Unit]\nDescription=DeepSeek Harness profile web\n[Service]\nExecStart=/x --profile web --no-open\n')
    await purge()
    expect(existsSync(unitPath)).toBe(false)
  })

  test('仅支持 macOS/Linux', async () => {
    await expect(purge({ platform: 'win32' })).rejects.toThrow(/仅支持/)
  })
})
