import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { fstatSync, readSync } from 'node:fs'
import { chmod, copyFile, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { invokeConfiguredHostAttestor } from '../src/host-attestor.ts'
import type { PluginControlTrustConfig } from '../src/trust.ts'
import type { HostAttestationRequest } from '../src/types.ts'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, realpath: vi.fn(actual.realpath) }
})

const originalPlatform = process.platform
const roots: string[] = []
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.mocked(spawn).mockReset()
  vi.mocked(realpath).mockReset()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(realpath).mockImplementation(actual.realpath)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(script: boolean) {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const root = await actual.realpath(await mkdtemp(join(tmpdir(), 'host-attestor-pinned-')))
  roots.push(root)
  const path = join(root, 'attestor')
  const interpreterPath = join(root, 'interpreter')
  const source = script ? `#!${interpreterPath}\ntrusted script\n` : 'trusted executable\n'
  await writeFile(path, source, { mode: 0o700 })
  await chmod(path, 0o700)
  await writeFile(interpreterPath, 'trusted interpreter\n', { mode: 0o700 })
  await chmod(interpreterPath, 0o700)
  const attestor = { id: 'test-attestor', version: 'test-1', path, sha256: hash(source),
    interpreter: script ? { path: interpreterPath, sha256: hash('trusted interpreter\n') } : null,
    environmentAllowlist: [], authority: 'host', keyId: 'key-1', timeoutMs: 1_000 }
  // Invocation checks only the configured issuer. Receipt validation and full
  // request binding are exercised by the real Linux staged CLI suite.
  const trust = { hostAttestor: attestor } as unknown as PluginControlTrustConfig
  const request = { issuer: { mode: 'configured-executable', ...attestor } } as unknown as HostAttestationRequest
  return { trust, request, path, interpreterPath, source }
}

function descriptorText(fd: number): string {
  const buffer = Buffer.alloc(fstatSync(fd).size)
  readSync(fd, buffer, 0, buffer.length, 0)
  return buffer.toString('utf8')
}

async function emulateLinuxProcfs(): Promise<void> {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(realpath).mockImplementation(async path => path === '/proc/self/fd' ? '/proc/self/fd' : actual.realpath(path))
}

describe('Host attestor descriptor lifetime', () => {
  test.each([false, true])('retains verified executable and interpreter through both subprocesses (script=%s)', async script => {
    const value = await fixture(script)
    await emulateLinuxProcfs()
    const descriptors = new Set<number>()
    let calls = 0
    vi.mocked(spawn).mockImplementation(((command: string, args: string[], options: { stdio: unknown[] }) => {
      calls += 1
      const executableFd = options.stdio[3] as number
      descriptors.add(executableFd)
      expect(command).toBe(script ? '/proc/self/fd/4' : '/proc/self/fd/3')
      expect(args).toEqual(script ? ['/proc/self/fd/3', calls === 1 ? '--version' : 'attest'] : [calls === 1 ? '--version' : 'attest'])
      expect(descriptorText(executableFd)).toBe(value.source)
      if (script) {
        const interpreterFd = options.stdio[4] as number
        descriptors.add(interpreterFd)
        expect(descriptorText(interpreterFd)).toBe('trusted interpreter\n')
      }
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() })
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(calls === 1 ? 'test-1\n' : 'not-json'))
        child.emit('close', 0)
      })
      return child as unknown as ChildProcess
    }) as typeof spawn)
    await expect(invokeConfiguredHostAttestor(value.trust, value.request)).rejects.toMatchObject({ code: 'FAILED' })
    expect(calls).toBe(2)
    expect(descriptors.size).toBe(script ? 2 : 1)
    for (const fd of descriptors) expect(() => fstatSync(fd)).toThrow()
  })

  test('a pathname replacement between version and attest never selects the replacement inode', async () => {
    const value = await fixture(true)
    await emulateLinuxProcfs()
    let calls = 0
    let selectedReplacement = false
    vi.mocked(spawn).mockImplementation(((command: string, _args: string[], options: { stdio: unknown[] }) => {
      calls += 1
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() })
      void (async () => {
        await Promise.resolve()
        if (calls === 1) {
          await rename(value.path, `${value.path}.original`)
          await writeFile(value.path, 'replacement executable\n', { mode: 0o700 })
        } else {
          const selected = command.startsWith('/proc/self/fd/')
            ? descriptorText(options.stdio[3] as number) : await readFile(value.path, 'utf8')
          selectedReplacement = selected.includes('replacement executable')
        }
        child.stdout.emit('data', Buffer.from(calls === 1 ? 'test-1\n' : '{}'))
        child.emit('close', 0)
      })()
      return child as unknown as ChildProcess
    }) as typeof spawn)
    await expect(invokeConfiguredHostAttestor(value.trust, value.request)).rejects.toBeDefined()
    expect(selectedReplacement).toBe(false)
  })

  test('does not fall back to pathname execution without Linux descriptor support', async () => {
    const value = await fixture(false)
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    await expect(invokeConfiguredHostAttestor(value.trust, value.request)).rejects.toMatchObject({ code: 'FAILED' })
    expect(spawn).not.toHaveBeenCalled()
  })

  test.runIf(originalPlatform === 'linux')('real subprocess never executes a replacement attestor installed by its version probe', async () => {
    const value = await fixture(true)
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    vi.mocked(spawn).mockImplementation(actual.spawn)
    await copyFile(process.execPath, value.interpreterPath)
    await chmod(value.interpreterPath, 0o700)
    const marker = `${value.path}.evil-ran`
    const evil = `#!${value.interpreterPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); console.log('{}');\n`
    const source = `#!${value.interpreterPath}\nconst fs = require('node:fs');
if (process.argv[2] === '--version') {
  fs.renameSync(${JSON.stringify(value.path)}, ${JSON.stringify(`${value.path}.original`)});
  fs.writeFileSync(${JSON.stringify(value.path)}, ${JSON.stringify(evil)}, { mode: 0o700 });
  console.log('test-1');
} else console.log('{}');\n`
    await writeFile(value.path, source, { mode: 0o700 })
    const attestor = { ...value.trust.hostAttestor!, sha256: hash(source),
      interpreter: { path: value.interpreterPath,
        sha256: createHash('sha256').update(await readFile(value.interpreterPath)).digest('hex') } }
    const trust = { ...value.trust, hostAttestor: attestor }
    const request = { ...value.request, issuer: { mode: 'configured-executable' as const, ...attestor } }
    await expect(invokeConfiguredHostAttestor(trust, request)).rejects.toMatchObject({ code: 'EXECUTABLE_CHANGED' })
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
