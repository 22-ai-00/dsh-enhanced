import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { canOpenBrowser, openWebProfile } from '../src/open.ts'
import type { CommandRunner } from '../src/run.ts'

const roots: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

async function seedProfile(dshHome: string, profile: string, withConsole = true): Promise<void> {
  const profileDir = join(dshHome, 'profiles', profile)
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: `dsh-profile-${profile}` }))
  if (withConsole) {
    await mkdir(join(profileDir, 'node_modules', '@dsh-ray', 'owner-console'), { recursive: true })
  }
}

function captureStreams() {
  let out = ''
  let err = ''
  return {
    stdout: { write: (chunk: string) => { out += chunk } },
    stderr: { write: (chunk: string) => { err += chunk } },
    readOut: () => out,
    readErr: () => err,
  }
}

afterEach(async () => {
  while (roots.length > 0) {
    const dir = roots.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

describe('canOpenBrowser', () => {
  test('macOS 允许打开浏览器，无桌面环境变量的 Linux 跳过，支持 DISPLAY/WAYLAND_DISPLAY 的 Linux 允许', () => {
    expect(canOpenBrowser('darwin', {})).toEqual({ ok: true })
    expect(canOpenBrowser('linux', {})).toMatchObject({ ok: false })
    expect(canOpenBrowser('linux', { DISPLAY: ':0' })).toEqual({ ok: true })
    expect(canOpenBrowser('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toEqual({ ok: true })
  })
})

describe('openWebProfile', () => {
  test('缺少 profile 或多 profile 无 web 时报错指引', async () => {
    const home = await makeTempDir('dsh-open-empty-')
    const streams1 = captureStreams()
    const empty = await openWebProfile({
      dshHome: home, home, platform: 'linux', stdout: streams1.stdout, stderr: streams1.stderr,
    })
    expect(empty.exitCode).toBe(1)
    expect(streams1.readErr()).toContain('没有任何 profile')

    await seedProfile(home, 'core', false)
    await seedProfile(home, 'lark', false)
    const streams2 = captureStreams()
    const ambiguous = await openWebProfile({
      dshHome: home, home, platform: 'linux', stdout: streams2.stdout, stderr: streams2.stderr,
    })
    expect(ambiguous.exitCode).toBe(1)
    expect(streams2.readErr()).toContain('--profile')
  })

  test('多 profile 包含 web 时自动选中 web，且校验损坏的 .dsh-ray-host.json fail-closed', async () => {
    const home = await makeTempDir('dsh-open-bound-')
    await seedProfile(home, 'core', false)
    await seedProfile(home, 'web', true)
    await writeFile(join(home, '.dsh-ray-host.json'), '{"schemaVersion":1,"cacheRoot":"relative"}\n', { mode: 0o600 })

    const streams = captureStreams()
    const res = await openWebProfile({
      dshHome: home,
      home,
      platform: 'linux',
      stdout: streams.stdout,
      stderr: streams.stderr,
    })
    expect(res.exitCode).toBe(1)
    expect(streams.readErr()).toContain('私有 Host 绑定异常')
  })

  test('无常驻服务的按需 profile 使用私有 Host dshPath 启动并打印 URL 与文鳐提示', async () => {
    const home = await makeTempDir('dsh-open-fg-')
    const cacheRoot = join(home, 'cache')
    const binDir = join(cacheRoot, '0.2.2-rc.5', 'node_modules', '.bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, 'dsh'), '#!/bin/sh\n', { mode: 0o755 })
    await seedProfile(home, 'web', true)
    const digest = 'a'.repeat(64)
    await writeFile(join(home, '.dsh-ray-host.json'), JSON.stringify({
      schemaVersion: 1,
      cacheRoot,
      version: '0.2.2-rc.5',
      receiptDigest: digest,
    }), { mode: 0o600 })

    const streams = captureStreams()
    const openedUrls: string[] = []
    const launched: { executable: string; args: readonly string[]; dshHome?: string | undefined }[] = []
    const runner: CommandRunner = () => ({ status: 1, stdout: '', stderr: '' })

    const outcome = await openWebProfile({
      dshHome: home,
      home,
      platform: 'linux',
      env: { DISPLAY: ':0', PATH: '/usr/bin' },
      runner,
      readHostRuntime: async () => ({
        version: '0.2.2-rc.5',
        root: join(cacheRoot, '0.2.2-rc.5'),
        dshPath: join(binDir, 'dsh'),
        binDirectory: binDir,
        integrity: 'sha512-x',
        receiptDigest: digest,
      }),
      openBrowser: url => {
        openedUrls.push(url)
        return { opened: true }
      },
      launchForegroundHost: async input => {
        launched.push({ executable: input.executable, args: input.args, dshHome: input.env.DSH_HOME })
        input.onUrl('http://127.0.0.1:43210/?token=live-secret-token')
        return 0
      },
      stdout: streams.stdout,
      stderr: streams.stderr,
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.mode).toBe('foreground')
    expect(outcome.profile).toBe('web')
    expect(outcome.url).toBe('http://127.0.0.1:43210/?token=live-secret-token')
    expect(launched).toEqual([{
      executable: join(binDir, 'dsh'),
      args: ['--profile', 'web', '--no-open'],
      dshHome: home,
    }])
    expect(openedUrls).toEqual(['http://127.0.0.1:43210/?token=live-secret-token'])
    expect(streams.readOut()).toContain('http://127.0.0.1:43210/?token=live-secret-token')
    expect(streams.readOut()).toContain('文鳐')
  })

  test('受管常驻服务轮询获取 URL 后按 --no-browser 控制是否拉起浏览器', async () => {
    const home = await makeTempDir('dsh-open-managed-')
    await seedProfile(home, 'supervised', false)
    const unitDir = join(home, '.config', 'systemd', 'user')
    await mkdir(unitDir, { recursive: true })
    await writeFile(
      join(unitDir, 'dsh-profile-supervised.service'),
      '[Service]\n# DeepSeek Harness profile supervised\nExecStart=/usr/bin/dsh --profile supervised --no-open\n',
    )

    let attempts = 0
    const browserSpy = vi.fn(() => ({ opened: true }))
    const streams = captureStreams()

    const outcome = await openWebProfile({
      dshHome: home,
      home,
      platform: 'linux',
      profile: 'supervised',
      noBrowser: true,
      waitSeconds: 2,
      sleep: async () => {},
      resolveWebUrl: async () => {
        attempts += 1
        if (attempts < 2) {
          return { profile: 'supervised', notice: 'starting', errors: [] }
        }
        return { profile: 'supervised', url: 'http://127.0.0.1:3080/?token=tok2', source: 'journal', errors: [] }
      },
      openBrowser: browserSpy,
      stdout: streams.stdout,
      stderr: streams.stderr,
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.mode).toBe('managed')
    expect(outcome.ownerConsoleInstalled).toBe(false)
    expect(attempts).toBe(2)
    expect(browserSpy).not.toHaveBeenCalled()
    expect(streams.readOut()).toContain('http://127.0.0.1:3080/?token=tok2')
    expect(streams.readOut()).toContain('--with console')
    expect(streams.readOut()).toContain('--no-browser')
  })

  test('symbolic link .dsh-ray-host.json 被 inspectBoundHostRuntime 拒绝为 invalid', async () => {
    const home = await makeTempDir('dsh-open-symlink-')
    await seedProfile(home, 'web', true)
    const target = join(home, 'target.json')
    await writeFile(target, '{}')
    await symlink(target, join(home, '.dsh-ray-host.json'))

    const streams = captureStreams()
    const outcome = await openWebProfile({
      dshHome: home, home, platform: 'linux', stdout: streams.stdout, stderr: streams.stderr,
    })
    expect(outcome.exitCode).toBe(1)
    expect(streams.readErr()).toContain('私有 Host 绑定异常')
  })
})
