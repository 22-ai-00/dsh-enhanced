import { closeSync, fstatSync, lstatSync, realpathSync } from 'node:fs'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { openTrustedCatalogCommitInterpreter } from '../src/catalog-interpreter.ts'

const roots = new Set<string>()

afterEach(async () => {
  await Promise.all([...roots].map(async root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

// Containers may map all files to a non-root uid; the trust checks require uid 0 directories.
const rootOwnsSystemDirs = process.platform === 'linux'
  && lstatSync('/usr/bin', { bigint: true }).uid === 0n

describe.runIf(rootOwnsSystemDirs)('catalog commit interpreter portability', () => {
  test('resolves the fixed generic launcher and pins its canonical minor-version target', () => {
    const expectedPath = realpathSync('/usr/bin/python3')
    const interpreter = openTrustedCatalogCommitInterpreter('/usr/bin/python3')
    try {
      const expected = lstatSync(expectedPath, { bigint: true })
      const opened = fstatSync(interpreter.descriptor, { bigint: true })
      expect(interpreter.canonicalPath).toBe(expectedPath)
      expect(opened.isFile()).toBe(true)
      expect({ dev: opened.dev, ino: opened.ino }).toEqual({ dev: expected.dev, ino: expected.ino })
    } finally {
      closeSync(interpreter.descriptor)
    }
  })

  test('rejects an interpreter reached through a user-controlled directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'catalog-python-')); roots.add(root)
    await chmod(root, 0o700)
    const target = join(root, 'python3.99')
    const launcher = join(root, 'python3')
    await writeFile(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await symlink('python3.99', launcher)

    expect(() => openTrustedCatalogCommitInterpreter(launcher)).toThrow('unsafe canonical directory')
  })

  test('rejects a root-owned path that is not an executable interpreter', () => {
    expect(() => openTrustedCatalogCommitInterpreter('/etc/passwd'))
      .toThrow('launcher is not a trusted root-owned file or symbolic link')
  })
})
