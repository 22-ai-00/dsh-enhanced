import { describe, expect, test, vi } from 'vitest'
import { runInstall } from '../src/install.ts'
import { PurgeError } from '../src/purge.ts'
import { main, parseArgs, type MainDeps } from '../src/index.ts'

const fakeReport = {
  scope: 'full' as const,
  profiles: ['web'],
  serviceProfiles: ['web'],
  removedPaths: ['/.dsh'],
  removedCredentials: [],
  credentialErrors: [],
  skippedServiceFiles: [],
  serviceErrors: [],
  keptCheckouts: [],
  hostRemoved: false,
  dryRun: false,
}

type InstallFn = NonNullable<MainDeps['install']>
type PurgeFn = NonNullable<MainDeps['purge']>
type SelfUpdateFn = NonNullable<MainDeps['selfUpdate']>

function makeDeps(installCalls: unknown[], purgeCalls: unknown[] = []): Required<MainDeps> {
  return {
    install: (async options => {
      installCalls.push(options)
      return 0
    }) as InstallFn,
    purge: (async options => {
      purgeCalls.push(options)
      return fakeReport
    }) as PurgeFn,
    // 这些测试不走 update 路径；注入假实现只为满足 Required<MainDeps>，
    // 同时确保任何意外调用都不会打到真实 npm registry。
    selfUpdate: (async () => ({
      fromVersion: '0.0.0', selector: 'latest', alreadyCurrent: true, actions: [],
    })) as SelfUpdateFn,
  }
}

describe('runInstall（薄委托）', () => {
  test('npm 形态：按 release ref 拼 URL 下载，bash 执行并透传参数与 DSH_HOME', async () => {
    const downloads: string[] = []
    const runs: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = []
    const code = await runInstall({
      mode: 'npm',
      releaseRef: 'v0.1.37',
      passthrough: ['--scenario', 'core', '--yes'],
      dshHome: '/custom/.dsh',
      executor: {
        download: vi.fn(async url => {
          downloads.push(url)
          return '#!/usr/bin/env bash\n'
        }),
        runInherited: vi.fn(async (command, args, options) => {
          runs.push({ command, args, env: options.env })
          return 0
        }),
      },
    })
    expect(code).toBe(0)
    expect(downloads).toEqual([
      'https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/v0.1.37/scripts/install/install-npm.sh',
    ])
    expect(runs).toHaveLength(1)
    expect(runs[0]!.command).toBe('bash')
    expect(runs[0]!.args.slice(1)).toEqual(['--scenario', 'core', '--yes'])
    expect(runs[0]!.args[0]).toMatch(/install-npm\.sh$/u)
    expect(runs[0]!.env.DSH_HOME).toBe('/custom/.dsh')
  })

  test('local 形态：执行 checkout 内 install-local.sh，不下载', async () => {
    const download = vi.fn(async () => '')
    const runs: Array<{ command: string; args: readonly string[] }> = []
    const code = await runInstall({
      mode: 'local',
      localRepositoryRoot: '/repo/dsh-enhanced',
      releaseRef: 'v0.1.37',
      passthrough: ['--scenario', 'web'],
      executor: {
        download,
        runInherited: vi.fn(async (command, args) => {
          runs.push({ command, args })
          return 0
        }),
      },
    })
    expect(code).toBe(0)
    expect(download).not.toHaveBeenCalled()
    expect(runs[0]!.command).toBe('bash')
    expect(runs[0]!.args[0]).toBe('/repo/dsh-enhanced/scripts/install/install-local.sh')
    expect(runs[0]!.args.slice(1)).toEqual(['--scenario', 'web'])
  })

  test('local 形态缺 checkout 目录时报 PurgeError', async () => {
    await expect(
      runInstall({
        mode: 'local',
        releaseRef: 'v0.1.37',
        passthrough: [],
        executor: { download: vi.fn(), runInherited: vi.fn() },
      }),
    ).rejects.toBeInstanceOf(PurgeError)
  })

  test('非法 release ref 拒绝执行', async () => {
    await expect(
      runInstall({
        mode: 'npm',
        releaseRef: 'latest',
        passthrough: [],
        executor: { download: vi.fn(), runInherited: vi.fn() },
      }),
    ).rejects.toBeInstanceOf(PurgeError)
  })

  test('下载失败包装为中文 PurgeError', async () => {
    await expect(
      runInstall({
        mode: 'npm',
        releaseRef: 'v0.1.37',
        passthrough: [],
        executor: {
          download: vi.fn(async () => {
            throw new Error('HTTP 404')
          }),
          runInherited: vi.fn(),
        },
      }),
    ).rejects.toThrow(/下载 install-npm\.sh 失败/u)
  })

  test('安装器非零退出码原样返回', async () => {
    const code = await runInstall({
      mode: 'local',
      localRepositoryRoot: '/repo',
      releaseRef: 'v0.1.37',
      passthrough: [],
      executor: {
        download: vi.fn(),
        runInherited: vi.fn(async () => 3),
      },
    })
    expect(code).toBe(3)
  })
})

describe('parseArgs：install/reinstall 透传', () => {
  test('install 后安装器参数（含带值）原样透传，未知参数不报错', () => {
    const args = parseArgs(
      ['install', '--scenario', 'core', '--workspace', 'ws-a', '--yes', '--bogus-flag', 'x'],
      { HOME: '/h' },
    )
    expect(args.command).toBe('install')
    expect(args.passthrough).toEqual([
      '--scenario', 'core', '--workspace', 'ws-a', '--yes', '--bogus-flag', 'x',
    ])
  })

  test('--local 由 rsi 消费不透传，--dsh-home 经环境变量', () => {
    const args = parseArgs(['install', '--local', '/repo', '--scenario', 'lark'], { HOME: '/h' })
    expect(args.local).toBe('/repo')
    expect(args.passthrough).toEqual(['--scenario', 'lark'])
  })

  test('命令位置之前的全局选项也生效', () => {
    const args = parseArgs(['--dsh-home', '/x/.dsh', '--yes', 'install', '--dry-run'], { HOME: '/h' })
    expect(args.dshHome).toBe('/x/.dsh')
    expect(args.yes).toBe(true)
    expect(args.passthrough).toEqual(['--dry-run'])
  })

  test('reinstall 的 purge 选项被 rsi 消费，--yes/--dry-run 同时透传', () => {
    const args = parseArgs(
      ['reinstall', '--yes', '--no-backup', '--profile', 'web', '--scenario', 'core'],
      { HOME: '/h' },
    )
    expect(args.command).toBe('reinstall')
    expect(args.yes).toBe(true)
    expect(args.backup).toBe(false)
    expect(args.profile).toBe('web')
    // --profile 被 rsi 作为 purge 范围消费，buildInstallOptions 再补透传给安装器。
    expect(args.passthrough).toEqual(['--yes', '--scenario', 'core'])
  })

  test('--local 缺值时报错', () => {
    expect(() => parseArgs(['install', '--local'], { HOME: '/h' })).toThrow(/需要一个值/u)
  })

  test('install --help/-h 透传给安装器（薄委托展示安装器帮助），reinstall --help 显示 rsi 帮助', () => {
    expect(parseArgs(['install', '--help'], { HOME: '/h' }).passthrough).toEqual(['--help'])
    expect(parseArgs(['install', '-h'], { HOME: '/h' }).passthrough).toEqual(['-h'])
    const reinstall = parseArgs(['reinstall', '--help'], { HOME: '/h' })
    expect(reinstall.help).toBe(true)
    expect(reinstall.passthrough).toEqual([])
  })
})

describe('main：install / reinstall 分发', () => {
  test('install：npm 形态，releaseRef 锁自身版本，参数完整透传', async () => {
    const installCalls: unknown[] = []
    const code = await main(
      ['--dsh-home', '/x/.dsh', 'install', '--scenario', 'core', '--yes'],
      { HOME: '/h' },
      makeDeps(installCalls),
    )
    expect(code).toBe(0)
    const options = installCalls[0] as Record<string, unknown>
    expect(options.mode).toBe('npm')
    expect(options.releaseRef).toMatch(/^v\d+\.\d+\.\d+$/u)
    expect(options.dshHome).toBe('/x/.dsh')
    expect(options.passthrough).toEqual(['--scenario', 'core', '--yes'])
  })

  test('install --local：local 形态带 checkout 根', async () => {
    const installCalls: unknown[] = []
    const code = await main(
      ['install', '--local', '/repo/dsh-enhanced', '--scenario', 'web'],
      { HOME: '/h' },
      makeDeps(installCalls),
    )
    expect(code).toBe(0)
    const options = installCalls[0] as Record<string, unknown>
    expect(options.mode).toBe('local')
    expect(options.localRepositoryRoot).toBe('/repo/dsh-enhanced')
    expect(options.passthrough).toEqual(['--scenario', 'web'])
  })

  test('reinstall --yes：先 purge（同 profile/备份开关）后 install', async () => {
    const order: string[] = []
    const installCalls: unknown[] = []
    const purgeCalls: unknown[] = []
    const code = await main(
      ['reinstall', '--yes', '--profile', 'web', '--no-backup'],
      { HOME: '/h' },
      {
        install: (async options => {
          order.push('install')
          installCalls.push(options)
          return 0
        }) as InstallFn,
        purge: (async options => {
          order.push('purge')
          purgeCalls.push(options)
          return fakeReport
        }) as PurgeFn,
      },
    )
    expect(code).toBe(0)
    expect(order).toEqual(['purge', 'install'])
    expect(purgeCalls[0]).toMatchObject({ profile: 'web', backup: false, dryRun: false })
    const options = installCalls[0] as Record<string, unknown>
    expect(options.passthrough).toEqual(['--yes', '--profile', 'web'])
  })

  test('reinstall --dry-run：purge 与 install 均为 dry-run', async () => {
    const installCalls: unknown[] = []
    const purgeCalls: unknown[] = []
    const code = await main(
      ['reinstall', '--dry-run'],
      { HOME: '/h' },
      makeDeps(installCalls, purgeCalls),
    )
    expect(code).toBe(0)
    expect(purgeCalls[0]).toMatchObject({ dryRun: true })
    expect((installCalls[0] as Record<string, unknown>).passthrough).toEqual(['--dry-run'])
  })

  test('install 失败（安装器退出码 42）透传退出码', async () => {
    const code = await main(['install', '--scenario', 'core'], { HOME: '/h' }, {
      install: (async () => 42) as InstallFn,
      purge: makeDeps([]).purge,
    })
    expect(code).toBe(42)
  })

  test('install 抛 PurgeError 时退出码 1', async () => {
    const code = await main(['install'], { HOME: '/h' }, {
      install: (async () => {
        throw new PurgeError('下载 install-npm.sh 失败：x')
      }) as InstallFn,
      purge: makeDeps([]).purge,
    })
    expect(code).toBe(1)
  })
})
