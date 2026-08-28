import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
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

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

async function protectedFile(value: string | Buffer = 'protected-value\n') {
  const root = await mkdtemp(join(tmpdir(), 'credentials-protected-file-'))
  roots.push(root)
  const path = join(root, 'lark.secret')
  await writeFile(path, value, { mode: 0o600 })
  const handle: CredentialHandle = {
    id: 'linux-file', provider: 'linux-protected-file', path,
    consumers: ['plugin'], purposes: ['connect'], maxLeaseMs: 10_000,
  }
  return { handle, path, root }
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

  test('reads a bounded Linux protected file without invoking a subprocess', async () => {
    if (process.platform !== 'linux') return
    const fixture = await protectedFile()
    const run = runner()
    const wipe = vi.spyOn(Buffer.prototype, 'fill')
    try {
      await expect(readCredential(fixture.handle, { env: { HOME: '/not-used', TOKEN: 'not-used' }, run,
        timeoutMs: 1_000, maxSecretBytes: 1_024 })).resolves.toBe('protected-value')
      expect(run).not.toHaveBeenCalled()
      expect(wipe).toHaveBeenCalledWith(0)
    } finally {
      wipe.mockRestore()
    }
  })

  test('rejects unsafe protected-file directories, files, links and oversized values', async () => {
    if (process.platform !== 'linux') return
    const unsafeDirectory = await protectedFile()
    await chmod(unsafeDirectory.root, 0o755)
    await expect(readCredential(unsafeDirectory.handle, { env: {}, run: runner(), timeoutMs: 1_000,
      maxSecretBytes: 1_024 })).rejects.toEqual(expect.objectContaining({ code: 'provider-failed' }))

    const unsafeFile = await protectedFile()
    await chmod(unsafeFile.path, 0o644)
    await expect(readCredential(unsafeFile.handle, { env: {}, run: runner(), timeoutMs: 1_000,
      maxSecretBytes: 1_024 })).rejects.toEqual(expect.objectContaining({ code: 'provider-failed' }))

    const hardLinked = await protectedFile()
    await link(hardLinked.path, join(hardLinked.root, 'alias.secret'))
    await expect(readCredential(hardLinked.handle, { env: {}, run: runner(), timeoutMs: 1_000,
      maxSecretBytes: 1_024 })).rejects.toEqual(expect.objectContaining({ code: 'provider-failed' }))

    const linkedDirectoryRoot = await mkdtemp(join(tmpdir(), 'credentials-protected-link-'))
    roots.push(linkedDirectoryRoot)
    const realDirectory = join(linkedDirectoryRoot, 'real')
    const linkedDirectory = join(linkedDirectoryRoot, 'linked')
    await mkdir(realDirectory, { mode: 0o700 })
    await writeFile(join(realDirectory, 'lark.secret'), 'linked-secret', { mode: 0o600 })
    await symlink(realDirectory, linkedDirectory, 'dir')
    await expect(readCredential({ ...hardLinked.handle, path: join(linkedDirectory, 'lark.secret') }, {
      env: {}, run: runner(), timeoutMs: 1_000, maxSecretBytes: 1_024,
    })).rejects.toEqual(expect.objectContaining({ code: 'provider-failed' }))

    const linkedFile = await protectedFile()
    const target = join(linkedFile.root, 'target.secret')
    await writeFile(target, 'linked-secret', { mode: 0o600 })
    await rm(linkedFile.path)
    await symlink(target, linkedFile.path)
    await expect(readCredential(linkedFile.handle, { env: {}, run: runner(), timeoutMs: 1_000,
      maxSecretBytes: 1_024 })).rejects.toEqual(expect.objectContaining({ code: 'provider-failed' }))

    const oversized = await protectedFile('not-a-small-secret')
    await expect(readCredential(oversized.handle, { env: {}, run: runner(), timeoutMs: 1_000,
      maxSecretBytes: 4 })).rejects.toEqual(expect.objectContaining({ code: 'oversize' }))
  })

  test('keeps protected-file failures free of credential contents and paths', async () => {
    if (process.platform !== 'linux') return
    const fixture = await protectedFile('')
    const failure = readCredential(fixture.handle, { env: {}, run: runner(), timeoutMs: 1_000,
      maxSecretBytes: 1_024 })
    await expect(failure).rejects.toEqual(expect.objectContaining({ code: 'not-found' }))
    await expect(failure).rejects.not.toThrow(new RegExp(fixture.path, 'u'))
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
