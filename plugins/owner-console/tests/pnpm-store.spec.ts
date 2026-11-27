import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/index.ts'
import { reconcileProfilePnpmStore, type PnpmStoreSpawnFn, type PnpmStoreSpawnProcessLike } from '../src/pnpm-store.ts'
import { applyInstall, isUnexpectedStoreError, OwnerConsoleService } from '../src/service.ts'

const ESC = '\u001b'
const dirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function createMockSpawn(exitCode: number, emitError?: Error) {
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = []
  const spawnFn: PnpmStoreSpawnFn = (command, args, options) => {
    calls.push({ command, args, options: options as unknown as Record<string, unknown> })
    const emitter = new EventEmitter() as EventEmitter & { kill: (signal?: NodeJS.Signals | number) => boolean }
    emitter.kill = vi.fn(() => true)
    queueMicrotask(() => {
      if (emitError !== undefined) {
        emitter.emit('error', emitError)
      } else {
        emitter.emit('close', exitCode)
      }
    })
    return emitter as unknown as PnpmStoreSpawnProcessLike
  }
  return { spawnFn, calls }
}

describe('isUnexpectedStoreError', () => {
  it('matches ERR_PNPM_UNEXPECTED_STORE and ERR_PNPM_MODULES_BREAKING_CHANGE across diagnostic and output', () => {
    expect(isUnexpectedStoreError({
      changed: false,
      application: 'failed',
      target: '@dsh-ray/lark-channel',
      error: {
        code: 'operation-error',
        diagnostic: `${ESC}[41m${ESC}[31m[${ESC}[39m${ESC}[49mERR_PNPM_UNEXPECTED_STORE] Unexpected store location`,
      },
    })).toBe(true)

    expect(isUnexpectedStoreError({
      changed: false,
      application: 'failed',
      target: '@dsh-ray/lark-channel',
      error: { code: 'operation-error', diagnostic: 'failed' },
      packageResult: { output: 'ERR_PNPM_MODULES_BREAKING_CHANGE: modules directory was created with incompatible pnpm' },
    })).toBe(true)

    expect(isUnexpectedStoreError({
      changed: false,
      application: 'failed',
      target: '@dsh-ray/lark-channel',
      error: { code: 'operation-error', diagnostic: 'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY' },
      packageResult: { output: 'ERR_PNPM_IGNORED_BUILDS' },
    })).toBe(false)
  })
})

describe('reconcileProfilePnpmStore', () => {
  it('persists confirmModulesPurge: false and prefers manager.profile.packageManager over fallbacks', async () => {
    const dir = await makeTempDir('owner-console-store-pm-')
    const { spawnFn, calls } = createMockSpawn(0)
    const manager = {
      profile: {
        packageManager: {
          command: '/custom/node',
          args: ['/custom/pnpm.cjs'],
          env: { CUSTOM_PM_VAR: 'preserved', SECRET_OK: 'from-pm' },
        },
      },
      pnpmCommand: '/ignored/pnpm',
    }

    const ok = await reconcileProfilePnpmStore(dir, manager, {
      spawnFn,
      env: { PATH: '', SECRET_TOKEN: 'leaked', HOME: dir },
      platform: 'darwin',
      osHome: dir,
    })

    expect(ok).toBe(true)
    expect(parse(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8'))).toEqual({
      confirmModulesPurge: false,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.command).toBe('/custom/node')
    expect(calls[0]!.args).toEqual([
      '/custom/pnpm.cjs',
      'install',
      '--dir',
      dir,
      '--no-frozen-lockfile',
      '--ignore-scripts',
      '--config.confirmModulesPurge=false',
    ])
    expect(calls[0]!.options['shell']).toBe(false)
    const spawnedEnv = calls[0]!.options['env'] as NodeJS.ProcessEnv
    expect(spawnedEnv['CI']).toBe('true')
    expect(spawnedEnv['CUSTOM_PM_VAR']).toBe('preserved')
    expect(spawnedEnv['SECRET_TOKEN']).toBeUndefined()
  })

  it('uses manager.pnpmCommand when profile.packageManager.command is absent', async () => {
    const dir = await makeTempDir('owner-console-store-cmd-')
    const { spawnFn, calls } = createMockSpawn(0)

    const ok = await reconcileProfilePnpmStore(dir, { pnpmCommand: '/opt/pnpm-bin/pnpm' }, {
      spawnFn,
      env: { PATH: '', HOME: dir },
      platform: 'linux',
      osHome: dir,
    })

    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.command).toBe('/opt/pnpm-bin/pnpm')
    expect(calls[0]!.args).toEqual([
      'install',
      '--dir',
      dir,
      '--no-frozen-lockfile',
      '--ignore-scripts',
      '--config.confirmModulesPurge=false',
    ])
  })

  it('resolves darwin DeepSeek Harness.app bundled pnpm.cjs/pnpm.mjs via DSH_DESKTOP_NODE_EXECUTABLE and keeps temp osHome hermetic', async () => {
    const root = await makeTempDir('owner-console-store-mac-')
    const dir = join(root, 'profile')
    const osHome = join(root, 'os-home')
    await mkdir(dir, { recursive: true })
    await mkdir(osHome, { recursive: true })

    const appContents = join(root, 'Custom', 'DeepSeek Harness.app', 'Contents')
    const electronExec = join(appContents, 'MacOS', 'DeepSeek Harness')
    const bundledCjs = join(appContents, 'Resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')
    await mkdir(join(appContents, 'MacOS'), { recursive: true })
    await mkdir(join(appContents, 'Resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin'), { recursive: true })
    await writeFile(electronExec, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await chmod(electronExec, 0o755)
    await writeFile(bundledCjs, '// pnpm.cjs\n', { mode: 0o644 })

    const { spawnFn, calls } = createMockSpawn(0)
    const ok = await reconcileProfilePnpmStore(dir, {}, {
      spawnFn,
      env: { PATH: '', HOME: osHome, DSH_DESKTOP_NODE_EXECUTABLE: electronExec },
      platform: 'darwin',
      osHome,
    })

    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.command).toBe(electronExec)
    expect(calls[0]!.args).toEqual([
      bundledCjs,
      'install',
      '--dir',
      dir,
      '--no-frozen-lockfile',
      '--ignore-scripts',
      '--config.confirmModulesPurge=false',
    ])
    const env = calls[0]!.options['env'] as NodeJS.ProcessEnv
    expect(env['CI']).toBe('true')
    expect(env['ELECTRON_RUN_AS_NODE']).toBe('1')

    // Confirm temp osHome !== homedir() never hits global /Applications even if osHome/Applications is absent,
    // falling back to discovered pnpm binary (or bare 'pnpm') with buildUpgradeProbeEnv.
    expect(osHome).not.toBe(homedir())
    const { spawnFn: fallbackSpawn, calls: fallbackCalls } = createMockSpawn(1)
    const failed = await reconcileProfilePnpmStore(dir, {}, {
      spawnFn: fallbackSpawn,
      env: { PATH: '', HOME: osHome },
      platform: 'darwin',
      osHome,
      execPath: process.execPath,
    })
    expect(failed).toBe(false)
    expect(fallbackCalls[0]!.command).toMatch(/(?:^|[\\/])pnpm$/u)
    expect(fallbackCalls[0]!.args).toEqual([
      'install',
      '--dir',
      dir,
      '--no-frozen-lockfile',
      '--ignore-scripts',
      '--config.confirmModulesPurge=false',
    ])

    // When ~/Library/pnpm/pnpm exists on darwin without bundled DeepSeek Harness.app, it wins deterministically
    const userPnpmDir = join(osHome, 'Library', 'pnpm')
    const userPnpm = join(userPnpmDir, 'pnpm')
    await mkdir(userPnpmDir, { recursive: true })
    await writeFile(userPnpm, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await chmod(userPnpm, 0o755)
    const { spawnFn: userPnpmSpawn, calls: userPnpmCalls } = createMockSpawn(0)
    expect(await reconcileProfilePnpmStore(dir, {}, {
      spawnFn: userPnpmSpawn,
      env: { PATH: '', HOME: osHome },
      platform: 'darwin',
      osHome,
      execPath: process.execPath,
    })).toBe(true)
    expect(userPnpmCalls[0]!.command).toBe(userPnpm)

    // Spawn error resolves cleanly to false instead of throwing
    const { spawnFn: errSpawn } = createMockSpawn(0, new Error('ENOENT'))
    expect(await reconcileProfilePnpmStore(dir, { pnpmCommand: 'pnpm' }, {
      spawnFn: errSpawn,
      env: { PATH: '', HOME: osHome },
      platform: 'linux',
      osHome,
    })).toBe(false)
  })

  it('spawns a real child process with CI=true and returns true iff exit code === 0', async () => {
    const dir = await makeTempDir('owner-console-store-real-')
    const captureFile = join(dir, 'captured.json')
    const scriptPath = join(dir, 'fake-pnpm.cjs')
    await writeFile(scriptPath, [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ argv: process.argv.slice(2), ci: process.env.CI }));`,
      'process.exit(Number(process.env.FAKE_PNPM_EXIT || 0));',
    ].join('\n'), { mode: 0o644 })

    const ok = await reconcileProfilePnpmStore(dir, {
      profile: { packageManager: { command: process.execPath, args: [scriptPath], env: { FAKE_PNPM_EXIT: '0' } } },
    }, { env: { HOME: dir, PATH: process.env['PATH'] ?? '' } })
    expect(ok).toBe(true)
    expect(JSON.parse(await readFile(captureFile, 'utf8'))).toEqual({
      argv: ['install', '--dir', dir, '--no-frozen-lockfile', '--ignore-scripts', '--config.confirmModulesPurge=false'],
      ci: 'true',
    })

    const fail = await reconcileProfilePnpmStore(dir, {
      profile: { packageManager: { command: process.execPath, args: [scriptPath], env: { FAKE_PNPM_EXIT: '2' } } },
    }, { env: { HOME: dir, PATH: process.env['PATH'] ?? '' } })
    expect(fail).toBe(false)
  })
})

describe('OwnerConsoleService store mismatch reconciliation', () => {
  async function mountWithManager(dir: string | undefined, manager: unknown, reconcileStore: (d: string, m: unknown) => Promise<boolean>) {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    if (dir !== undefined) ctx.provide('profileContext' as never, { dir } as never)
    ctx.provide('pluginManager' as never, manager as never)
    const service = new OwnerConsoleService(
      ctx,
      Config({ feishuAppId: '' }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { reconcileStore },
    )
    return { ctx, service }
  }

  it('reconciles store and retries installProjectBundle once on ERR_PNPM_UNEXPECTED_STORE and handles combined NO_TTY', async () => {
    const dir = await makeTempDir('owner-console-install-reconcile-')
    let calls = 0
    const manager = {
      listBundles: vi.fn(async () => []),
      listPlugins: vi.fn(async () => []),
      installBundle: vi.fn(async (spec: string) => {
        calls += 1
        if (calls === 1) {
          return {
            changed: false,
            application: 'failed' as const,
            target: spec,
            error: {
              code: 'operation-error',
              diagnostic: '[ERR_PNPM_UNEXPECTED_STORE] Unexpected store location: store/v10 vs store/v11',
            },
          }
        }
        if (calls === 2) {
          // Simulate hitting NO_TTY after store reconcile when yaml lost confirmModulesPurge
          await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8')
          return {
            changed: false,
            application: 'failed' as const,
            target: spec,
            error: {
              code: 'operation-error',
              diagnostic: 'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY',
            },
          }
        }
        return { changed: true, application: 'restart-required' as const, target: spec }
      }),
      removeBundle: vi.fn(),
    }
    const reconcileStore = vi.fn(async () => true)
    const { ctx, service } = await mountWithManager(dir, manager, reconcileStore)
    try {
      const res = await service.installProjectBundle('@dsh-ray/lark-channel')
      expect(res).toMatchObject({ applied: true, entry: '@dsh-ray/lark-channel' })
      expect(reconcileStore).toHaveBeenCalledExactlyOnceWith(dir, manager)
      expect(manager.installBundle).toHaveBeenCalledTimes(3)
      expect(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('confirmModulesPurge: false')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reconciles store and retries removeProjectBundle once on ERR_PNPM_MODULES_BREAKING_CHANGE', async () => {
    const dir = await makeTempDir('owner-console-remove-reconcile-')
    let calls = 0
    const manager = {
      listBundles: vi.fn(async () => []),
      listPlugins: vi.fn(async () => []),
      installBundle: vi.fn(),
      removeBundle: vi.fn(async (name: string) => {
        calls += 1
        if (calls === 1) {
          return {
            changed: false,
            application: 'failed' as const,
            target: name,
            error: { code: 'operation-error', diagnostic: 'failed' },
            packageResult: { output: 'ERR_PNPM_MODULES_BREAKING_CHANGE' },
          }
        }
        return { changed: true, application: 'restart-required' as const, target: name }
      }),
    }
    const reconcileStore = vi.fn(async () => true)
    const { ctx, service } = await mountWithManager(dir, manager, reconcileStore)
    try {
      const res = await service.removeProjectBundle('@dsh-ray/lark-channel')
      expect(res).toMatchObject({ applied: true, entry: '@dsh-ray/lark-channel' })
      expect(reconcileStore).toHaveBeenCalledExactlyOnceWith(dir, manager)
      expect(manager.removeBundle).toHaveBeenCalledTimes(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('returns clear Chinese manual recovery note when store reconciliation fails or dir is missing', async () => {
    const dir = await makeTempDir('owner-console-install-unrecovered-')
    const manager = {
      listBundles: vi.fn(async () => []),
      listPlugins: vi.fn(async () => []),
      installBundle: vi.fn(async (spec: string) => ({
        changed: false,
        application: 'failed' as const,
        target: spec,
        error: {
          code: 'operation-error',
          diagnostic: '[ERR_PNPM_UNEXPECTED_STORE] Unexpected store location: store/v10 vs store/v11',
        },
        packageResult: { logPath: join(dir, '.plugin-manager', 'logs', 'pnpm.log') },
      })),
      removeBundle: vi.fn(),
    }
    const reconcileStore = vi.fn(async () => false)
    const { ctx, service } = await mountWithManager(dir, manager, reconcileStore)
    try {
      const res = await service.installProjectBundle('@dsh-ray/lark-channel')
      expect(res.applied).toBe(false)
      expect(reconcileStore).toHaveBeenCalledOnce()
      expect(manager.installBundle).toHaveBeenCalledOnce()
      expect(res.note).toContain('v10/v11')
      expect(res.note).toContain(`pnpm install --dir "${dir}" --config.confirmModulesPurge=false`)
      expect(res.note).toContain('pnpm.log')

      const direct = applyInstall({
        changed: false,
        application: 'failed',
        target: '@dsh-ray/hello',
        error: { code: 'operation-error', diagnostic: 'ERR_PNPM_UNEXPECTED_STORE' },
      }, '/tmp/prof')
      expect(direct.applied).toBe(false)
      expect(direct.note).toContain('v10/v11')
      expect(direct.note).toContain('pnpm install --dir "/tmp/prof" --config.confirmModulesPurge=false')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
