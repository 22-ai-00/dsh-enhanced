import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { hashLinuxRuntimeTree, type LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { linuxPluginBehaviorRuntimeDigest, prepareLinuxPluginBehaviorRuntime, readLinuxPluginBehaviorRuntime,
  validateLinuxPluginBehaviorRuntime, verifyLinuxPluginBehaviorRuntime, type LinuxPluginBehaviorRuntime } from '../src/linux-behavior-runtime.js'

const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
let home: string, base: LinuxRuntime, descriptor: LinuxPluginBehaviorRuntime
const makeBase = async (root: string): Promise<LinuxRuntime> => {
  await mkdir(root, { mode: 0o700 })
  const write = async (name: string, value: string, mode = 0o444): Promise<void> => {
    await mkdir(dirname(join(root, name)), { recursive: true, mode: 0o700 })
    await writeFile(join(root, name), value, { mode })
  }
  await write('pnpm/bin/pnpm.mjs', 'console.log("11.7.0")\n')
  await write('pnpm-native/pnpm', '#!/bin/sh\nprintf "11.7.0\\n"\n', 0o555)
  await write('pnpm-native/package.json', '{"name":"@pnpm/exe","version":"11.7.0"}')
  await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
  await write('source/retained.txt', 'source snapshot retained verbatim\n')
  for (const [name, version] of Object.entries({ typescript: '6.0.3', '@deepseek-ai/cordis': '4.0.5',
    '@deepseek-ai/dsh-tools': '0.2.1-rc.2', '@deepseek-ai/dsh-system-prompt': '0.2.1-rc.2' })) {
    await write(`node_modules/${name}/package.json`, JSON.stringify({ version }))
  }
  for (const name of ['bin', 'store', 'cache']) await mkdir(join(root, name), { mode: 0o700 })
  for (const name of ['bin/node', 'pnpm-native/node']) {
    await copyFile('/usr/bin/node', join(root, name)); await chmod(join(root, name), 0o555)
  }
  await symlink('retained.txt', join(root, 'source', 'internal-link'))
  const info = await lstat(root)
  return { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: '1'.repeat(40), lockSha256: sha(await readFile(join(root, 'pnpm-lock.yaml'))),
    root: { path: root, dev: info.dev, ino: info.ino, sha256: await hashLinuxRuntimeTree(root) },
    nodePath: join(root, 'bin/node'), nodeSha256: sha(await readFile(join(root, 'bin/node'))),
    pnpmPath: join(root, 'pnpm/bin/pnpm.mjs'), nativePnpmRoot: join(root, 'pnpm-native'), nativePnpmPath: join(root, 'pnpm-native/pnpm'),
    modulesPath: join(root, 'node_modules'), storePath: join(root, 'store'), cachePath: join(root, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } }
}

// Requires the actual pinned /usr/bin/node v22.23.2 and a root-owned Linux C
// toolchain; generic CI Node versions and other platforms are not substitutes.
describe.runIf(process.platform === 'linux' && process.env.DSH_LINUX_BEHAVIOR_PREPARE_REAL === '1')('Linux behavior runtime preparation (offline)', () => {
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'linux-behavior-runtime-'))
    await chmod(home, 0o700)
    base = await makeBase(join(home, 'base'))
    descriptor = await prepareLinuxPluginBehaviorRuntime({ runtime: base, root: join(home, 'observer') })
  }, 120_000)
  afterAll(async () => { if (home) await rm(home, { recursive: true, force: true }) })

  it('creates an independent private clone and reopens the same receipt without writes', async () => {
    expect(await hashLinuxRuntimeTree(base.root.path)).toBe(base.root.sha256)
    expect(await readdir(join(home, 'observer'))).toEqual(['behavior.json', 'runtime'])
    expect((await lstat(descriptor.runtime.root.path)).mode & 0o777).toBe(0o700)
    const clone = join(descriptor.runtime.root.path, 'source', 'retained.txt'), original = join(base.root.path, 'source', 'retained.txt')
    expect(await readFile(clone)).toEqual(await readFile(original))
    expect((await lstat(clone)).ino).not.toBe((await lstat(original)).ino)
    expect((await lstat(clone)).nlink).toBe(1); expect((await lstat(clone)).mode & 0o777).toBe(0o444)
    expect(await realpath(join(descriptor.runtime.root.path, 'source', 'internal-link'))).toBe(clone)
    expect(await realpath(join(descriptor.runtime.root.path, 'dsh-plugin-verifier', 'node_modules'))).toBe(descriptor.runtime.modulesPath)
    const receipt = await readFile(join(home, 'observer', 'behavior.json'))
    expect(await prepareLinuxPluginBehaviorRuntime({ runtime: base, root: join(home, 'observer') })).toEqual(descriptor)
    expect(await readLinuxPluginBehaviorRuntime({ runtime: base, root: join(home, 'observer') })).toEqual(descriptor)
    expect(await readFile(join(home, 'observer', 'behavior.json'))).toEqual(receipt)
    expect(await verifyLinuxPluginBehaviorRuntime(descriptor)).toEqual(descriptor)
    expect(linuxPluginBehaviorRuntimeDigest(descriptor)).toMatch(/^[a-f0-9]{64}$/u)
  }, 120_000)

  it('validates synchronously and rejects shape, getters, overlap and unsafe paths', async () => {
    expect(validateLinuxPluginBehaviorRuntime(descriptor)).toEqual(descriptor)
    for (const value of [{ ...descriptor, extra: true }, { ...descriptor, observer: { ...descriptor.observer, sourceSha256: 'x' } },
      Object.defineProperty({ ...descriptor }, 'observer', { enumerable: true, get() { throw new Error('getter executed') } })]) {
      expect(() => validateLinuxPluginBehaviorRuntime(value)).toThrow()
    }
    for (const root of ['/', join(home, '..', 'escape'), base.root.path, join(base.root.path, 'child')]) {
      await expect(prepareLinuxPluginBehaviorRuntime({ runtime: base, root })).rejects.toThrow()
    }
    await mkdir(join(home, 'occupied'), { mode: 0o700 })
    await writeFile(join(home, 'occupied', 'sentinel'), 'keep')
    await expect(prepareLinuxPluginBehaviorRuntime({ runtime: base, root: join(home, 'occupied') })).rejects.toThrow('inventory')
    expect(await readFile(join(home, 'occupied', 'sentinel'), 'utf8')).toBe('keep')
    await mkdir(join(home, 'empty'), { mode: 0o700 })
    await expect(prepareLinuxPluginBehaviorRuntime({ runtime: base, root: join(home, 'empty') })).rejects.toThrow('inventory')
    expect(await readdir(join(home, 'empty'))).toEqual([])
  })

  it('excludes a concurrent prepare and never removes another owner lock', async () => {
    const root = join(home, 'concurrent')
    const results = await Promise.allSettled([
      prepareLinuxPluginBehaviorRuntime({ runtime: base, root }),
      prepareLinuxPluginBehaviorRuntime({ runtime: base, root }),
    ])
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(value => value.status === 'rejected')).toHaveLength(1)
    const lockedRoot = join(home, 'locked'), lock = join(home, '.locked.linux-behavior-lock')
    await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'sentinel'), 'keep')
    await expect(prepareLinuxPluginBehaviorRuntime({ runtime: base, root: lockedRoot })).rejects.toThrow('EEXIST')
    expect(await readFile(join(lock, 'sentinel'), 'utf8')).toBe('keep')
    expect((await readdir(home)).filter(name => name.endsWith('.linux-behavior-lock'))).toEqual(['.locked.linux-behavior-lock'])
  }, 120_000)

  it('rejects compiled helper and source drift even when a tree receipt is resealed', async () => {
    for (const name of ['worker.mjs', 'candidate-launcher', 'parent-protect.so', 'child-protect.so']) {
      const path = join(descriptor.runtime.root.path, 'dsh-plugin-verifier', name), bytes = await readFile(path)
      const mode = (await lstat(path)).mode & 0o777
      await chmod(path, 0o600); await writeFile(path, 'tampered'); await chmod(path, mode)
      try {
        const altered = { ...descriptor, runtime: { ...descriptor.runtime, root: { ...descriptor.runtime.root,
          sha256: await hashLinuxRuntimeTree(descriptor.runtime.root.path) } } }
        await expect(verifyLinuxPluginBehaviorRuntime(altered)).rejects.toThrow('asset differs')
      } finally { await chmod(path, 0o600); await writeFile(path, bytes); await chmod(path, mode) }
    }
    const root = join(home, 'observer'), path = join(root, 'behavior.json'), original = await readFile(path)
    const receipt = JSON.parse(original.toString()) as Record<string, unknown>
    delete receipt.receiptDigest; receipt.compilerSha256 = '0'.repeat(64)
    const changed = { ...receipt, receiptDigest: sha(JSON.stringify(receipt)) }
    await chmod(path, 0o600); await writeFile(path, JSON.stringify(changed)); await chmod(path, 0o444)
    try { await expect(readLinuxPluginBehaviorRuntime({ runtime: base, root })).rejects.toThrow('compiler identity differs') }
    finally { await chmod(path, 0o600); await writeFile(path, original); await chmod(path, 0o444) }
  }, 120_000)

  it('rejects escaping base links and cleans a failed clone without changing the base', async () => {
    const source = join(base.root.path, 'source'), evil = join(source, 'evil')
    await symlink('../../outside-secret', evil)
    await writeFile(join(home, 'outside-secret'), 'must never be copied')
    try {
      await expect(prepareLinuxPluginBehaviorRuntime({ runtime: base, root: join(home, 'escape') })).rejects.toThrow('escaped')
      expect(await readdir(home)).not.toContain('escape')
    } finally { await rm(evil) }
    const collision = join(base.root.path, 'dsh-plugin-verifier')
    await mkdir(collision, { mode: 0o700 })
    const altered = { ...base, root: { ...base.root, sha256: await hashLinuxRuntimeTree(base.root.path) } }
    try {
      await expect(prepareLinuxPluginBehaviorRuntime({ runtime: altered, root: join(home, 'failure') })).rejects.toThrow('EEXIST')
      expect((await readdir(home)).filter(name => name.startsWith('.linux-behavior-stage-') || name === 'failure')).toEqual([])
    } finally { await rm(collision, { recursive: true }) }
    expect(await hashLinuxRuntimeTree(base.root.path)).toBe(base.root.sha256)
    const abort = new AbortController(); abort.abort()
    await expect(prepareLinuxPluginBehaviorRuntime({ runtime: base, root: join(home, 'aborted'), signal: abort.signal })).rejects.toThrow()
    expect(await readdir(home)).not.toContain('aborted')
  }, 120_000)
})
