import { describe, expect, test } from 'vitest'
import {
  buildIsolatedSubprocessPlan,
  Config,
  resolveIsolationBackend,
  validateConfig,
} from '../src/index.js'

describe('cross-platform backend resolution and Config validation', () => {
  test('resolveIsolationBackend maps auto across linux, darwin, win32 and rejects unsupported platforms/backends', () => {
    expect(resolveIsolationBackend('auto', 'linux')).toBe('linux-native')
    expect(resolveIsolationBackend(undefined, 'linux')).toBe('linux-native')
    expect(resolveIsolationBackend('auto', 'darwin')).toBe('macos-seatbelt')
    expect(resolveIsolationBackend('auto', 'win32')).toBe('windows-job')
    expect(resolveIsolationBackend('linux-native', 'linux')).toBe('linux-native')
    expect(resolveIsolationBackend('macos-seatbelt', 'darwin')).toBe('macos-seatbelt')
    expect(resolveIsolationBackend('windows-job', 'win32')).toBe('windows-job')

    expect(() => resolveIsolationBackend('auto', 'freebsd')).toThrow(/unsupported platform freebsd/i)
    expect(() => resolveIsolationBackend('docker' as never, 'linux')).toThrow(/unsupported isolation backend/i)
    expect(() => resolveIsolationBackend('arbitrary' as never, 'win32')).toThrow(/unsupported isolation backend/i)
  })

  test('validates auto and explicit macos-seatbelt deterministically on Linux', () => {
    const validated = validateConfig({
      backend: 'auto',
      stateRoot: '/var/tmp/dsh-mac-state',
      macos: {
        readOnlyRoots: ['/opt/homebrew/Cellar/node/24.0.0'],
        sandboxExecPath: '/usr/bin/sandbox-exec',
      },
      grants: [{
        id: 'mac-grant',
        revision: 1,
        principalDigest: 'a'.repeat(64),
        principalRecordId: 'owner-1',
        principalVersion: 1,
        workspace: '/Users/alice/project',
        agentPreset: 'primary',
        expiresAt: Date.now() + 60_000,
        maxRuns: 5,
        maxTotalDurationMs: 60_000,
      }],
    }, { platform: 'darwin', uid: 501 })

    expect(validated.backend).toBe('macos-seatbelt')
    expect(validated.configuredBackend).toBe('auto')
    expect(validated.macos?.readOnlyRoots).toEqual(['/opt/homebrew/Cellar/node/24.0.0'])
    expect(validated.macos?.sandboxExecPath).toBe('/usr/bin/sandbox-exec')

    expect(() => validateConfig({
      backend: 'macos-seatbelt',
      stateRoot: 'C:\\Users\\alice\\state',
    }, { platform: 'darwin', uid: 501 })).toThrow(/canonical absolute state root/i)

    expect(() => validateConfig({
      backend: 'macos-seatbelt',
      stateRoot: '/var/tmp/dsh-mac-state',
      macos: { readOnlyRoots: ['/Users'] },
    }, { platform: 'darwin', uid: 501 })).toThrow(/overbroad macOS read-only root/i)

    expect(() => validateConfig({
      backend: 'macos-seatbelt',
      stateRoot: '/var/tmp/dsh-mac-state',
    }, { platform: 'darwin', uid: 0 })).toThrow(/non-root macOS/i)
  })

  test('validates auto and explicit windows-job with canonical Windows C:\\... paths deterministically', () => {
    const validated = validateConfig({
      backend: 'auto',
      stateRoot: 'C:\\Users\\alice\\.dsh\\assistant-isolation',
      windows: {
        powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        shell: 'powershell',
      },
      grants: [{
        id: 'win-grant',
        revision: 1,
        principalDigest: 'b'.repeat(64),
        principalRecordId: 'owner-1',
        principalVersion: 1,
        workspace: 'C:\\Users\\alice\\workspace',
        agentPreset: 'primary',
        expiresAt: Date.now() + 60_000,
        maxRuns: 5,
        maxTotalDurationMs: 60_000,
      }],
    }, { platform: 'win32' })

    expect(validated.backend).toBe('windows-job')
    expect(validated.configuredBackend).toBe('auto')
    expect(validated.stateRoot).toBe('C:\\Users\\alice\\.dsh\\assistant-isolation')
    expect(validated.windows?.shell).toBe('powershell')

    expect(() => validateConfig({
      backend: 'windows-job',
      stateRoot: 'C:\\',
    }, { platform: 'win32' })).toThrow(/canonical absolute state root/i)

    expect(() => validateConfig({
      backend: 'windows-job',
      stateRoot: 'relative\\path',
    }, { platform: 'win32' })).toThrow(/canonical absolute state root/i)

    expect(() => validateConfig({
      backend: 'windows-job',
      stateRoot: 'C:\\Users\\alice\\.dsh\\isolation',
      windows: { powershellPath: 'powershell.exe' },
    }, { platform: 'win32' })).toThrow(/canonical Windows powershellPath/i)

    // Defaults to a valid Win32 stateRoot even if stateRoot is omitted
    const defaulted = validateConfig({ backend: 'auto' }, { platform: 'win32' })
    expect(defaulted.backend).toBe('windows-job')
    expect(defaulted.stateRoot).toMatch(/^[A-Za-z]:\\/u)
  })

  test('rejects cross-platform mismatches, docker, and invalid backends synchronously', () => {
    expect(() => validateConfig({
      backend: 'windows-job',
      stateRoot: 'C:\\Users\\alice\\state',
    }, { platform: 'linux', uid: 1000 })).toThrow(/requires Windows/i)

    expect(() => validateConfig({
      backend: 'macos-seatbelt',
      stateRoot: '/var/tmp/state',
    }, { platform: 'linux', uid: 1000 })).toThrow(/requires non-root macOS/i)

    const dockerResult = Config['~standard'].validate({ backend: 'docker' })
    expect(dockerResult).not.toBeInstanceOf(Promise)
    expect('issues' in dockerResult && dockerResult.issues).toBeDefined()

    const unknownResult = Config['~standard'].validate({ backend: 'podman' })
    expect(unknownResult).not.toBeInstanceOf(Promise)
    expect('issues' in unknownResult && unknownResult.issues).toBeDefined()

    expect(() => buildIsolatedSubprocessPlan({
      command: '/usr/bin/node',
      args: [],
      cwd: '/var/tmp/ws',
      env: {},
      limits: { memoryMiB: -1 },
      timeoutMs: 1000,
    }, { platform: 'linux', backend: 'linux-native' })).toThrow(/invalid subprocess memoryMiB limit/i)

    expect(() => buildIsolatedSubprocessPlan({
      command: '/usr/bin/node',
      args: [],
      cwd: '/var/tmp/ws',
      env: {},
      limits: { pidsLimit: 0 },
      timeoutMs: 1000,
    }, { platform: 'linux', backend: 'linux-native' })).toThrow(/invalid subprocess pidsLimit/i)

    expect(() => buildIsolatedSubprocessPlan({
      command: '/usr/bin/node',
      args: [],
      cwd: '/var/tmp/ws',
      env: {},
      limits: { cpus: 0 },
      timeoutMs: 1000,
    }, { platform: 'linux', backend: 'linux-native' })).toThrow(/invalid subprocess cpus limit/i)
  })
})
