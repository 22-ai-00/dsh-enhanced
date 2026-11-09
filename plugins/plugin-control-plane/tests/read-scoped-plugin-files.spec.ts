import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readScopedPluginFiles } from '../src/source-workspace.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'cp-read-scoped-'))
  roots.push(value)
  return value
}

describe('readScopedPluginFiles', () => {
  it('reads README.md, src/ and tests/ recursively into POSIX relative paths', async () => {
    const dir = await root()
    await mkdir(join(dir, 'src', 'nested'), { recursive: true })
    await mkdir(join(dir, 'tests'), { recursive: true })
    await writeFile(join(dir, 'README.md'), '# demo\n')
    await writeFile(join(dir, 'src', 'index.ts'), 'export const a = 1\n')
    await writeFile(join(dir, 'src', 'nested', 'b.ts'), 'export const b = 2\n')
    await writeFile(join(dir, 'tests', 'index.spec.ts'), 'it("x", () => {})\n')
    const files = await readScopedPluginFiles(dir)
    expect(files.map(file => file.path).sort()).toEqual(['README.md', 'src/index.ts', 'src/nested/b.ts', 'tests/index.spec.ts'])
    expect(files.find(file => file.path === 'src/nested/b.ts')?.content).toBe('export const b = 2\n')
  })

  it('rejects symlinks anywhere in the tree', async () => {
    const dir = await root()
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'README.md'), '# demo\n')
    await symlink('/etc/passwd', join(dir, 'src', 'leak.ts'))
    await expect(readScopedPluginFiles(dir)).rejects.toThrow(/symlink is not allowed/u)
  })

  it('rejects a .git entry', async () => {
    const dir = await root()
    await mkdir(join(dir, '.git'), { recursive: true })
    await writeFile(join(dir, 'README.md'), '# demo\n')
    await expect(readScopedPluginFiles(dir)).rejects.toThrow(/\.git/u)
  })

  it('resolves a symlinked root via realpath and reads its real contents', async () => {
    const real = await root()
    await writeFile(join(real, 'README.md'), '# demo\n')
    const linkParent = await root()
    const link = join(linkParent, 'linked')
    await symlink(real, link)
    // realpath canonicalizes a symlinked root before the walk; the resolved read
    // returns the real directory's contents rather than following anything inside.
    await expect(readScopedPluginFiles(link)).resolves.toEqual([{ path: 'README.md', content: '# demo\n' }])
  })

  it('fails closed on an empty directory (below the 1-file minimum)', async () => {
    const dir = await root()
    await expect(readScopedPluginFiles(dir)).rejects.toThrow(/1\.\.64 files|must carry/u)
  })

  it('rejects an over-bound single file', async () => {
    const dir = await root()
    await writeFile(join(dir, 'README.md'), 'x'.repeat(65_537))
    await expect(readScopedPluginFiles(dir)).rejects.toThrow(/exceeds/u)
  })
})
