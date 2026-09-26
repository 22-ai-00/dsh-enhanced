import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { captureHostInputFiles, materializeHostInputFiles } from '../src/host-inputs.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-host-inputs-'))); roots.push(root)
  const stage = join(root, 'stage'), target = join(root, 'target')
  await mkdir(join(stage, 'node_modules/.store/pkg'), { recursive: true })
  await writeFile(join(stage, 'node_modules/.store/pkg/index.js'), 'export default {}\n', { mode: 0o600 })
  await symlink('.store/pkg', join(stage, 'node_modules/pkg'))
  return { root, stage, target }
}

test('captures staged module through its package link and remaps physical pins to the future target', async () => {
  const f = await fixture()
  expect(await captureHostInputFiles(f.stage, f.target, ['node_modules/pkg/index.js'])).toEqual([
    { input: 'node_modules/pkg/index.js', path: join(f.target, 'node_modules/.store/pkg/index.js'),
      sha256: createHash('sha256').update('export default {}\n').digest('hex') },
  ])
})

test('rejects traversal, module links outside the profile, and aliases', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'outside.js'), 'outside')
  await symlink(join(f.root, 'outside.js'), join(f.stage, 'outside.js'))
  await expect(captureHostInputFiles(f.stage, f.target, ['../outside.js'])).rejects.toThrow('invalid')
  await expect(captureHostInputFiles(f.stage, f.target, ['outside.js'])).rejects.toThrow('escapes')
  await expect(captureHostInputFiles(f.stage, f.target, ['node_modules/pkg/index.js', 'node_modules/.store/pkg/index.js'])).rejects.toThrow('alias')
})

test('rejects files writable by other users and multi-link inodes', async () => {
  const f = await fixture(), entry = join(f.stage, 'node_modules/.store/pkg/index.js')
  await chmod(entry, 0o666)
  await expect(captureHostInputFiles(f.stage, f.target, ['node_modules/pkg/index.js'])).rejects.toThrow('trusted regular')
  await chmod(entry, 0o600)
  await link(entry, join(f.stage, 'duplicate.js'))
  await expect(captureHostInputFiles(f.stage, f.target, ['node_modules/pkg/index.js'])).rejects.toThrow('trusted regular')
})

test('materializes only a declared pnpm-style hardlink with identical bytes and mode', async () => {
  const f = await fixture(), input = 'node_modules/pkg/index.js'
  const entry = join(f.stage, 'node_modules/.store/pkg/index.js'), original = join(f.root, 'pnpm-store-index.js')
  await chmod(entry, 0o755)
  await link(entry, original)
  const originalBefore = await lstat(original, { bigint: true })
  await expect(captureHostInputFiles(f.stage, f.target, [input])).rejects.toThrow('trusted regular')
  await materializeHostInputFiles(f.stage, [input])
  const detached = await lstat(entry, { bigint: true }), originalAfter = await lstat(original, { bigint: true })
  expect(detached.ino).not.toBe(originalAfter.ino)
  expect(detached.nlink).toBe(1n)
  expect(detached.mode & 0o777n).toBe(0o755n)
  expect(originalAfter.ino).toBe(originalBefore.ino)
  expect(originalAfter.nlink).toBe(1n)
  expect(await readFile(original, 'utf8')).toBe('export default {}\n')
  expect(await readFile(entry, 'utf8')).toBe('export default {}\n')
  expect((await captureHostInputFiles(f.stage, f.target, [input]))[0]?.sha256)
    .toBe(createHash('sha256').update('export default {}\n').digest('hex'))
  await materializeHostInputFiles(f.stage, [input])
  expect((await lstat(entry, { bigint: true })).ino).toBe(detached.ino)
})

test('materialization rejects escaping links and never alters their target', async () => {
  const f = await fixture(), outside = join(f.root, 'outside.js')
  await writeFile(outside, 'external data', { mode: 0o600 })
  await symlink(outside, join(f.stage, 'escape.js'))
  await expect(materializeHostInputFiles(f.stage, ['escape.js'])).rejects.toThrow('escapes')
  expect(await readFile(outside, 'utf8')).toBe('external data')
  expect(await lstat(outside)).toMatchObject({ nlink: 1 })
})
