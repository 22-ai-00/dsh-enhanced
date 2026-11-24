import { EventEmitter } from 'node:events'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, test } from 'vitest'
import {
  buildIsolatedSubprocessPlan,
  createIsolatedSubprocessRunner,
  runIsolatedSubprocess,
  type IsolatedSubprocessRequest,
} from '../src/index.js'

const roots: string[] = []
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  await chmod(dir, 0o700)
  roots.push(dir)
  return dir
}

function bwrapFunctional(): boolean {
  if (process.platform !== 'linux') return false
  try {
    accessSync('/usr/bin/bwrap', constants.X_OK)
    return true
  } catch {
    return false
  }
}

describe('standalone cross-platform isolated subprocess API', () => {
  test('buildIsolatedSubprocessPlan generates deterministic OS plans across Linux, macOS, and Windows', () => {
    // Linux offline vs outbound-https
    const linuxOffline = buildIsolatedSubprocessPlan({
      command: '/usr/bin/node',
      args: ['/opt/app/worker.mjs'],
      cwd: '/var/tmp/learn-1',
      env: { PATH: '/usr/bin:/bin', HTTP_PROXY: 'http://127.0.0.1:8080', CUSTOM: '1' },
      network: 'none',
      readOnlyPaths: ['/opt/app'],
      timeoutMs: 5000,
    }, { platform: 'linux', backend: 'auto' })

    expect(linuxOffline.backend).toBe('linux-native')
    expect(linuxOffline.executable).toBe('/usr/bin/bwrap')
    expect(linuxOffline.args).toContain('--unshare-net')
    expect(linuxOffline.args).toContain('--ro-bind')
    expect(linuxOffline.args).toContain('/opt/app')
    expect(linuxOffline.args).toContain('--bind')
    expect(linuxOffline.args).toContain('/var/tmp/learn-1')
    expect(linuxOffline.env.HTTP_PROXY).toBeUndefined()
    expect(linuxOffline.env.CUSTOM).toBe('1')

    const linuxOnline = buildIsolatedSubprocessPlan({
      command: '/usr/bin/node',
      args: ['/opt/app/worker.mjs'],
      cwd: '/var/tmp/learn-1',
      env: { PATH: '/usr/bin:/bin', HTTPS_PROXY: 'https://proxy.local:8443' },
      network: 'outbound-https',
      readOnlyPaths: ['/opt/app'],
      timeoutMs: 5000,
    }, { platform: 'linux', backend: 'linux-native' })

    expect(linuxOnline.args).not.toContain('--unshare-net')
    expect(linuxOnline.args).not.toContain('--unshare-all')
    expect(linuxOnline.env.HTTPS_PROXY).toBe('https://proxy.local:8443')

    // macOS offline vs outbound-https
    const macOffline = buildIsolatedSubprocessPlan({
      command: '/opt/homebrew/bin/node',
      args: ['/Users/alice/app/worker.mjs'],
      cwd: '/private/tmp/learn-mac',
      env: { PATH: '/usr/bin:/bin' },
      network: 'none',
      readOnlyPaths: ['/Users/alice/app'],
      writablePaths: ['/private/tmp/learn-mac', '/private/tmp/extra-w'],
      timeoutMs: 5000,
    }, { platform: 'darwin', backend: 'auto' })
    expect(macOffline.backend).toBe('macos-seatbelt')
    expect(macOffline.executable).toBe('/usr/bin/sandbox-exec')
    expect(macOffline.seatbeltProfile).toContain('(deny default)')
    expect(macOffline.seatbeltProfile).toContain('(subpath "/private/tmp/extra-w")')
    expect(macOffline.seatbeltProfile).not.toContain('(allow network-outbound)')
    expect(macOffline.limitsEnforced).toEqual({ memoryMiB: false, pidsLimit: false, cpus: false })

    const macOnline = buildIsolatedSubprocessPlan({
      command: '/opt/homebrew/bin/node',
      args: ['/Users/alice/app/worker.mjs'],
      cwd: '/private/tmp/learn-mac',
      env: { PATH: '/usr/bin:/bin' },
      network: 'outbound-https',
      readOnlyPaths: ['/Users/alice/app'],
      timeoutMs: 5000,
    }, { platform: 'darwin', backend: 'macos-seatbelt' })
    expect(macOnline.seatbeltProfile).toContain('(allow network-outbound)')

    // Windows offline vs outbound-https
    const winPlan = buildIsolatedSubprocessPlan({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\app\\worker.mjs'],
      cwd: 'C:\\Users\\alice\\AppData\\Local\\Temp\\learn-win',
      env: { HTTP_PROXY: 'http://127.0.0.1:8080', CUSTOM_WIN: 'yes' },
      network: 'none',
      limits: { memoryMiB: 512, pidsLimit: 16, cpus: 1 },
      timeoutMs: 5000,
    }, { platform: 'win32', backend: 'auto' })
    expect(winPlan.backend).toBe('windows-job')
    expect(winPlan.windowsJobLimits?.killOnJobClose).toBe(true)
    expect(winPlan.windowsJobLimits?.breakawayAllowed).toBe(false)
    expect(winPlan.windowsJobLimits?.memoryLimitBytes).toBe(512 * 1024 * 1024)
    expect(winPlan.limitsEnforced).toEqual({ memoryMiB: true, pidsLimit: true, cpus: true })
    expect(winPlan.env.HTTP_PROXY).toBeUndefined()
    expect(winPlan.env.CUSTOM_WIN).toBe('yes')

    // Locks PATH/HOME/TMPDIR/NODE_OPTIONS/LD_*/DYLD_* case-insensitively on Linux, macOS, and Windows
    const linuxLocked = buildIsolatedSubprocessPlan({
      command: '/usr/bin/node',
      args: ['-e', '0'],
      cwd: '/var/tmp/learn-lock',
      env: {
        PATH: '/tmp/evil-bin',
        path: '/tmp/evil-lower',
        HOME: '/tmp/evil-home',
        home: '/tmp/evil-lower-home',
        TMPDIR: '/tmp/evil-tmp',
        NODE_OPTIONS: '--require /tmp/evil.js',
        node_options: '--require /tmp/evil2.js',
        LD_AUDIT: '/tmp/evil.so',
        ld_preload: '/tmp/evil2.so',
        DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
        SAFE_KEY: 'ok',
      },
      limits: { memoryMiB: 256, pidsLimit: 16, cpus: 1 },
      timeoutMs: 5000,
    }, { platform: 'linux', backend: 'linux-native' })
    expect(linuxLocked.env.PATH).toBe('/usr/local/bin:/usr/bin:/bin')
    expect(linuxLocked.env.path).toBeUndefined()
    expect(linuxLocked.env.HOME).toBe('/var/tmp/learn-lock')
    expect(linuxLocked.env.home).toBeUndefined()
    expect(linuxLocked.env.TMPDIR).toBe('/var/tmp/learn-lock')
    expect(linuxLocked.env.NODE_OPTIONS).toBeUndefined()
    expect(linuxLocked.env.node_options).toBeUndefined()
    expect(linuxLocked.env.LD_AUDIT).toBeUndefined()
    expect(linuxLocked.env.ld_preload).toBeUndefined()
    expect(linuxLocked.env.DYLD_INSERT_LIBRARIES).toBeUndefined()
    expect(linuxLocked.env.SAFE_KEY).toBe('ok')
    expect(linuxLocked.limitsEnforced).toEqual({ memoryMiB: false, pidsLimit: false, cpus: true })
    expect(linuxLocked.args).toContain('/usr/bin/prlimit')
    expect(linuxLocked.args).toContain('--cpu=5')

    // Platform/backend mismatch rejected
    expect(() => buildIsolatedSubprocessPlan({
      command: '/usr/bin/node',
      args: [],
      cwd: '/tmp/ws',
      env: {},
      timeoutMs: 1000,
    }, { platform: 'linux', backend: 'macos-seatbelt' })).toThrow(/incompatible with platform/i)
  })

  test('fails closed when OS sandbox primitive is unavailable (never degrades to unsandboxed spawn)', async () => {
    const cwd = await makeTempDir('subproc-fail-closed-')
    let spawnCalled = false
    const failingSpawn = (() => {
      spawnCalled = true
      throw new Error('should not spawn unsandboxed')
    }) as never

    const linuxMissing = await runIsolatedSubprocess({
      command: process.execPath,
      args: ['-e', 'console.log("unsafe")'],
      cwd,
      env: {},
      timeoutMs: 2000,
      network: 'none',
    }, {
      backend: 'linux-native',
      adapter: {
        platform: 'linux',
        verifyExecutable: () => false,
        spawn: failingSpawn,
      },
    })
    expect(spawnCalled).toBe(false)
    expect(linuxMissing).toMatchObject({
      backend: 'linux-native',
      sandboxed: false,
      status: 'failed',
      reason: 'sandbox-unavailable:bwrap',
    })

    const macMissing = await runIsolatedSubprocess({
      command: process.execPath,
      args: ['-e', 'console.log("unsafe")'],
      cwd,
      env: {},
      timeoutMs: 2000,
      network: 'none',
    }, {
      backend: 'macos-seatbelt',
      adapter: {
        platform: 'darwin',
        uid: 501,
        macos: {
          platform: 'darwin',
          uid: 501,
          verifySandboxExec: async () => false,
          spawn: failingSpawn,
        },
      },
    })
    expect(spawnCalled).toBe(false)
    expect(macMissing).toMatchObject({
      backend: 'macos-seatbelt',
      sandboxed: false,
      status: 'failed',
      reason: 'sandbox-exec-unavailable',
    })

    const winMissing = await runIsolatedSubprocess({
      command: process.execPath,
      args: ['-e', 'console.log("unsafe")'],
      cwd,
      env: {},
      timeoutMs: 2000,
      network: 'none',
    }, {
      backend: 'windows-job',
      adapter: {
        platform: 'win32',
        windows: {
          platform: 'win32',
          verifyRunner: async () => false,
          spawn: failingSpawn,
        },
      },
    })
    expect(spawnCalled).toBe(false)
    expect(winMissing).toMatchObject({
      backend: 'windows-job',
      sandboxed: false,
      status: 'failed',
      reason: 'windows-job-runner-unavailable',
    })
  })

  test('executes cleanly across mocked adapters and enforces stdout bounds', async () => {
    const cwd = await makeTempDir('subproc-adapter-')
    const runner = createIsolatedSubprocessRunner({
      backend: 'linux-native',
      adapter: {
        platform: 'linux',
        verifyExecutable: () => true,
        spawn: ((_cmd: string, args: readonly string[]) => {
          expect(args).toContain('--unshare-net')
          const proc = new EventEmitter() as EventEmitter & {
            pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean
          }
          proc.pid = 7777
          proc.stdin = new PassThrough()
          proc.stdout = new PassThrough()
          proc.stderr = new PassThrough()
          proc.kill = () => { proc.emit('close', null, 'SIGTERM'); return true }
          let stdinData = ''
          proc.stdin.on('data', chunk => { stdinData += chunk.toString('utf8') })
          proc.stdin.on('end', () => {
            proc.stdout.end(`echo:${stdinData}`)
            proc.emit('close', 0, null)
          })
          return proc as never
        }) as never,
      },
    })

    const req: IsolatedSubprocessRequest = {
      command: process.execPath,
      args: ['-e', '0'],
      cwd,
      env: { PATH: '/usr/bin:/bin' },
      stdin: '{"hello":"world"}',
      network: 'none',
      timeoutMs: 5000,
    }
    const res = await runner.run(req)
    expect(res).toMatchObject({
      backend: 'linux-native',
      sandboxed: true,
      status: 'succeeded',
      exitCode: 0,
      stdout: 'echo:{"hello":"world"}',
    })
  })

  test('merges partial top-level adapter fields with macos/windows adapters, forwards writablePaths, and enforces private cwd consistently', async () => {
    const root = await makeTempDir('subproc-merge-')
    const cwd = join(root, 'ws')
    const extraW = join(root, 'extra-w')
    const openDir = join(root, 'open-0755')
    const { mkdir: mkdirAsync } = await import('node:fs/promises')
    await mkdirAsync(cwd, { mode: 0o700 })
    await mkdirAsync(extraW, { mode: 0o700 })
    await mkdirAsync(openDir, { mode: 0o755 })

    // Partial Windows adapter: platform at top-level, runJob inside adapter.windows
    let winJobRan = false
    const winPartial = await runIsolatedSubprocess({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/c', 'echo ok'],
      cwd,
      env: { PATH: 'C:\\evil', CustomKey: '1' },
      timeoutMs: 5000,
    }, {
      backend: 'windows-job',
      adapter: {
        platform: 'win32',
        windows: {
          verifyRunner: async () => true,
          runJob: async spec => {
            winJobRan = true
            expect(spec.env.PATH).not.toBe('C:\\evil')
            expect(spec.env.CustomKey).toBe('1')
            return { status: 'succeeded', quiescent: true, exitCode: 0, stdout: 'win-partial-ok', stderr: '', artifacts: [] }
          },
        },
      },
    })
    expect(winJobRan).toBe(true)
    expect(winPartial).toMatchObject({ backend: 'windows-job', sandboxed: true, status: 'succeeded', stdout: 'win-partial-ok' })

    // Partial macOS adapter: platform + uid at top-level, runCommand inside adapter.macos + writablePaths forwarded
    let macPolicy = ''
    const macPartial = await runIsolatedSubprocess({
      command: '/usr/bin/env',
      args: ['true'],
      cwd,
      writablePaths: [cwd, extraW],
      env: { PATH: '/tmp/evil', NODE_OPTIONS: '--require /tmp/evil.js' },
      timeoutMs: 5000,
    }, {
      backend: 'macos-seatbelt',
      adapter: {
        platform: 'darwin',
        uid: 501,
        macos: {
          verifySandboxExec: async () => true,
          runCommand: async (input, policy) => {
            macPolicy = policy
            expect(input.env?.PATH).toBe('/usr/bin:/bin')
            expect(input.env?.NODE_OPTIONS).toBeUndefined()
            return { status: 'succeeded', quiescent: true, exitCode: 0, stdout: 'mac-partial-ok', stderr: '', artifacts: [] }
          },
        },
      },
    })
    expect(macPolicy).toContain(`(subpath ${JSON.stringify(extraW)})`)
    expect(macPartial).toMatchObject({ backend: 'macos-seatbelt', sandboxed: true, status: 'succeeded', stdout: 'mac-partial-ok' })

    // Consistent 0o700 cwd enforcement across linux-native, macos-seatbelt, and windows-job
    const linuxOpen = await runIsolatedSubprocess({
      command: process.execPath,
      args: ['-e', '0'],
      cwd: openDir,
      env: {},
      timeoutMs: 5000,
    }, {
      backend: 'linux-native',
      adapter: { platform: 'linux', verifyExecutable: () => true },
    })
    const macOpen = await runIsolatedSubprocess({
      command: '/usr/bin/env',
      args: ['true'],
      cwd: openDir,
      env: {},
      timeoutMs: 5000,
    }, {
      backend: 'macos-seatbelt',
      adapter: { platform: 'darwin', uid: 501, macos: { verifySandboxExec: async () => true } },
    })
    const winOpen = await runIsolatedSubprocess({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/c', 'echo ok'],
      cwd: openDir,
      env: {},
      timeoutMs: 5000,
    }, {
      backend: 'windows-job',
      adapter: { platform: 'win32', windows: { verifyRunner: async () => true } },
    })
    expect(linuxOpen).toMatchObject({ sandboxed: false, status: 'failed', reason: 'invalid-private-workspace' })
    expect(macOpen).toMatchObject({ sandboxed: false, status: 'failed', reason: 'invalid-private-workspace' })
    expect(winOpen).toMatchObject({ sandboxed: false, status: 'failed', reason: 'invalid-private-workspace' })
  })
})

describe.skipIf(!bwrapFunctional())('real Linux bwrap execution via runIsolatedSubprocess', () => {
  test('runs real node subprocess inside bwrap with scrubbed env, isolated cwd, and network isolation', async () => {
    const cwd = await makeTempDir('subproc-real-bwrap-')
    const nodeDir = dirname(process.execPath)
    const script = [
      'const fs = require("node:fs");',
      'const net = require("node:net");',
      'let input = "";',
      'process.stdin.on("data", c => input += c);',
      'process.stdin.on("end", () => {',
      '  fs.writeFileSync("proof.txt", "inside");',
      '  const keys = Object.keys(process.env).sort();',
      '  console.log(JSON.stringify({ cwd: process.cwd(), keys, input }));',
      '});',
    ].join(' ')

    const res = await runIsolatedSubprocess({
      command: process.execPath,
      args: ['-e', script],
      cwd,
      env: {
        PATH: '/tmp/evil-path',
        HOME: '/tmp/evil-home',
        NODE_OPTIONS: '--require /tmp/does-not-exist.js',
        LD_AUDIT: '/tmp/does-not-exist.so',
        HTTP_PROXY: 'http://127.0.0.1:9999',
        ALLOWED_KEY: 'ok',
      },
      stdin: 'ping-stdin',
      network: 'none',
      readOnlyPaths: [nodeDir],
      writablePaths: [cwd],
      limits: { memoryMiB: 256, pidsLimit: 16, cpus: 1 },
      timeoutMs: 10_000,
    })

    expect(res.sandboxed).toBe(true)
    expect(res.status).toBe('succeeded')
    expect(res.exitCode).toBe(0)
    const parsed = JSON.parse(res.stdout) as { cwd: string; keys: string[]; input: string }
    expect(parsed.cwd).toBe(cwd)
    expect(parsed.input).toBe('ping-stdin')
    expect(parsed.keys).toContain('ALLOWED_KEY')
    expect(parsed.keys).not.toContain('HTTP_PROXY')
    expect(parsed.keys).not.toContain('NODE_OPTIONS')
    expect(parsed.keys).not.toContain('LD_AUDIT')
  })
})
