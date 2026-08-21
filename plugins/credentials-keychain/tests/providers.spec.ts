import { describe, expect, test, vi } from 'vitest'
import { CredentialProviderError, readCredential, runCredentialCommand } from '../src/providers.ts'
import type { CredentialCommandRunner, CredentialHandle } from '../src/types.ts'

const mac: CredentialHandle = {
  id: 'mac-secret', provider: 'macos-keychain', service: 'dsh/lark', account: 'personal',
  consumers: ['plugin'], purposes: ['connect'], maxLeaseMs: 10_000,
}
const linux: CredentialHandle = {
  id: 'linux-secret', provider: 'linux-secret-service', service: 'dsh/lark', account: 'personal',
  consumers: ['plugin'], purposes: ['connect'], maxLeaseMs: 10_000,
}
const windows: CredentialHandle = {
  id: 'windows-secret', provider: 'windows-dpapi',
  path: 'C:\\Users\\test\\.dsh\\credentials-keychain\\lark-primary.clixml',
  consumers: ['plugin'], purposes: ['connect'], maxLeaseMs: 10_000,
}

function runner(result = { code: 0, stdout: Buffer.from('secret-value\n'), stderr: Buffer.alloc(0) }) {
  return vi.fn(async () => result) as CredentialCommandRunner
}

describe('credential providers', () => {
  test('reads exactly one named environment entry', async () => {
    await expect(readCredential({
      id: 'env', provider: 'environment', environmentName: 'LARK_SECRET',
      consumers: ['plugin'], purposes: ['connect'], maxLeaseMs: 10_000,
    }, { env: { LARK_SECRET: 'secret-value', UNRELATED: 'do-not-read' }, run: runner(), timeoutMs: 1_000,
      maxSecretBytes: 1_024 })).resolves.toBe('secret-value')
  })

  test('uses fixed no-shell macOS Keychain argv and a minimal environment', async () => {
    const run = runner()
    await expect(readCredential(mac, { env: { HOME: '/secret-home', TOKEN: 'unrelated' }, run,
      timeoutMs: 1_000, maxSecretBytes: 1_024 })).resolves.toBe('secret-value')
    expect(run).toHaveBeenCalledWith({
      executable: '/usr/bin/security',
      args: ['find-generic-password', '-w', '-s', 'dsh/lark', '-a', 'personal'],
      env: { PATH: '/usr/bin:/bin' }, timeoutMs: 1_000, maxOutputBytes: 1_025,
    })
  })

  test('passes only required desktop-session variables to Linux Secret Service', async () => {
    const run = runner()
    await readCredential(linux, { env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus',
      XDG_RUNTIME_DIR: '/run/user/1', HOME: '/private', TOKEN: 'no' }, run, timeoutMs: 1_000, maxSecretBytes: 1_024 })
    expect(run).toHaveBeenCalledWith({
      executable: '/usr/bin/secret-tool', args: ['lookup', 'service', 'dsh/lark', 'account', 'personal'],
      env: { PATH: '/usr/bin:/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus', XDG_RUNTIME_DIR: '/run/user/1' },
      timeoutMs: 1_000, maxOutputBytes: 1_025,
    })
  })

  test('decrypts one fixed DPAPI file with a fixed no-shell PowerShell command', async () => {
    const run = runner()
    await readCredential(windows, { env: { HOME: 'C:\\private', TOKEN: 'no' }, run,
      timeoutMs: 1_000, maxSecretBytes: 1_024 })
    expect(run).toHaveBeenCalledWith({
      executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        '$credential = Import-Clixml -LiteralPath $args[0]; [Console]::Out.Write($credential.GetNetworkCredential().Password)',
        'C:\\Users\\test\\.dsh\\credentials-keychain\\lark-primary.clixml',
      ],
      env: { PATH: 'C:\\Windows\\System32;C:\\Windows', SystemRoot: 'C:\\Windows' },
      timeoutMs: 1_000,
      maxOutputBytes: 1_025,
    })
  })

  test('returns stable secret-free failures for missing, oversized and provider errors', async () => {
    const envHandle: CredentialHandle = { id: 'env', provider: 'environment', environmentName: 'MISSING',
      consumers: ['plugin'], purposes: ['connect'], maxLeaseMs: 10_000 }
    await expect(readCredential(envHandle, { env: {}, run: runner(), timeoutMs: 1_000, maxSecretBytes: 8 }))
      .rejects.toEqual(expect.objectContaining({ code: 'not-found' }))
    await expect(readCredential(mac, { env: {}, run: runner({ code: 0, stdout: Buffer.from('too-long-secret'),
      stderr: Buffer.from('secret diagnostic') }), timeoutMs: 1_000, maxSecretBytes: 4 }))
      .rejects.toEqual(expect.objectContaining({ code: 'oversize' }))
    const failure = readCredential(mac, { env: {}, run: runner({ code: 44, stdout: Buffer.alloc(0),
      stderr: Buffer.from('super-secret provider text') }), timeoutMs: 1_000, maxSecretBytes: 1_024 })
    await expect(failure).rejects.toEqual(expect.objectContaining({ code: 'provider-failed' }))
    await expect(failure).rejects.not.toThrow(/super-secret/)
    expect(CredentialProviderError).toBeTypeOf('function')
  })

  test('runs fixed argv without a shell, bounds output and terminates on timeout', async () => {
    await expect(runCredentialCommand({ executable: '/usr/bin/printf', args: ['safe-output'],
      env: { PATH: '/usr/bin:/bin' }, timeoutMs: 1_000, maxOutputBytes: 64 })).resolves.toMatchObject({
      code: 0, stdout: Buffer.from('safe-output'),
    })
    await expect(runCredentialCommand({ executable: '/bin/sleep', args: ['1'], env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 10, maxOutputBytes: 64 })).rejects.toEqual(expect.objectContaining({ code: 'timeout' }))
    await expect(runCredentialCommand({ executable: '/usr/bin/printf', args: ['x'.repeat(65)],
      env: { PATH: '/usr/bin:/bin' }, timeoutMs: 1_000, maxOutputBytes: 64 }))
      .rejects.toEqual(expect.objectContaining({ code: 'oversize' }))
  })
})
