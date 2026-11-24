import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeBrokerCredentialSpec, readBrokerCredential } from '../src/broker-credentials.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Cross-Platform Broker Credentials (broker-credentials.ts)', () => {
  it('reads linux-protected-file and posix-protected-file with race & permission checks', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cred-xplat-')))
    roots.push(root)
    const credDir = join(root, 'creds')
    await mkdir(credDir, { mode: 0o700 })
    await chmod(credDir, 0o700)
    const filePath = join(credDir, 'token.txt')
    await writeFile(filePath, 'secret_tok_123\n', { mode: 0o600 })
    await chmod(filePath, 0o600)

    if (process.platform === 'linux') {
      const linuxSpec = normalizeBrokerCredentialSpec({ id: 'c1', provider: 'linux-protected-file', path: filePath, maxLeaseMs: 5_000 }, 'linux')
      await expect(readBrokerCredential(linuxSpec, 1024, { platform: 'linux' })).resolves.toBe('secret_tok_123')
    }

    const posixSpec = normalizeBrokerCredentialSpec({ id: 'c2', provider: 'posix-protected-file', path: filePath, maxLeaseMs: 5_000 }, 'darwin')
    // Simulated darwin path without /proc/self/fd works on POSIX filesystem
    await expect(readBrokerCredential(posixSpec, 1024, { platform: 'darwin' })).resolves.toBe('secret_tok_123')

    // Permission downgrade fails closed
    await chmod(filePath, 0o644)
    await expect(readBrokerCredential(posixSpec, 1024, { platform: 'darwin' })).rejects.toThrow(/ownership or permissions invalid/)
  })

  it('supports macos-keychain, windows-dpapi, windows-protected-file, and injected-lease providers', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cred-win-')))
    roots.push(root)
    const winFile = join(root, 'win.token')
    await writeFile(winFile, 'win_protected_secret\r\n')

    const macSpec = normalizeBrokerCredentialSpec({
      id: 'mac',
      provider: 'macos-keychain',
      service: 'dsh-broker',
      account: 'lark-bot',
      maxLeaseMs: 10_000,
    }, 'darwin')
    const macSecret = await readBrokerCredential(macSpec, 1024, {
      platform: 'darwin',
      commandRunner: async (file, args) => {
        expect(file).toBe('/usr/bin/security')
        expect(args).toEqual(['find-generic-password', '-w', '-s', 'dsh-broker', '-a', 'lark-bot'])
        return { stdout: 'mac_keychain_secret\n', stderr: '' }
      },
    })
    expect(macSecret).toBe('mac_keychain_secret')

    // Fail closed on non-darwin without runner override
    await expect(readBrokerCredential(macSpec, 1024, { platform: 'linux' })).rejects.toThrow(/requires darwin/)

    const dpapiSpec = normalizeBrokerCredentialSpec({
      id: 'dpapi',
      provider: 'windows-dpapi',
      path: winFile,
      maxLeaseMs: 10_000,
    }, 'win32')
    const dpapiSecret = await readBrokerCredential(dpapiSpec, 1024, {
      platform: 'win32',
      checkWindowsAcl: () => ({ ownerSid: 'S-1-5-21-1', protectedDacl: true, allowsNonOwner: false }),
      commandRunner: async (file, args) => {
        expect(file).toBe('powershell.exe')
        expect(args[0]).toBe('-NoProfile')
        return { stdout: 'dpapi_secret_xyz\r\n', stderr: '' }
      },
    })
    expect(dpapiSecret).toBe('dpapi_secret_xyz')

    const winFileSpec = normalizeBrokerCredentialSpec({
      id: 'winf',
      provider: 'windows-protected-file',
      path: winFile,
      expectedOwnerSid: 'S-1-5-21-1',
      maxLeaseMs: 10_000,
    }, 'win32')
    const winRead = await readBrokerCredential(winFileSpec, 1024, {
      platform: 'win32',
      checkWindowsAcl: () => ({ ownerSid: 'S-1-5-21-1', protectedDacl: true, allowsNonOwner: false }),
    })
    expect(winRead).toBe('win_protected_secret')

    // Permissive Windows DACL fails closed
    await expect(readBrokerCredential(winFileSpec, 1024, {
      platform: 'win32',
      checkWindowsAcl: () => ({ ownerSid: 'S-1-5-21-1', protectedDacl: true, allowsNonOwner: true }),
    })).rejects.toThrow(/windows-protected-file read failed/)

    // Omitted checkWindowsAcl on simulated win32 on Linux fails closed
    if (process.platform !== 'win32') {
      await expect(readBrokerCredential(dpapiSpec, 1024, {
        platform: 'win32',
        commandRunner: async () => ({ stdout: 'should_not_run', stderr: '' }),
      })).rejects.toThrow(/windows-dpapi path failed security verification/)

      await expect(readBrokerCredential(winFileSpec, 1024, {
        platform: 'win32',
      })).rejects.toThrow(/windows-protected-file read failed/)
    }

    const injected = normalizeBrokerCredentialSpec({ id: 'inj', provider: 'injected-lease', maxLeaseMs: 5_000 }, 'linux')
    await expect(readBrokerCredential(injected, 1024)).resolves.toBe('')
  })
})
