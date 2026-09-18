import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { assertRepairWorkspacePath, repairFilePath } from '../src/repair-workspace-path.ts'

// ENGINEERING-LAYER BOUNDARY TESTS, NOT REAL EXTERNAL-AUTHORITY EVIDENCE:
// `repairFilePath`/`assertRepairWorkspacePath` guard the owner-repair agent's
// native file tools. Their `arguments` are fully model-controlled JSON, so every
// malformed/traversing shape below is a reachable dispatch input, not a forged
// one. These pins exercise the pure fail-closed gates in-process only.

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function workspace(): Promise<string> {
  const value = await realpath(await mkdtemp(join(tmpdir(), 'repair-path-workspace-')))
  roots.push(value)
  return value
}

const invalid = /invalid owner repair file tool arguments/u
const outside = /outside its workspace/u

describe('repairFilePath', () => {
  test('accepts well-formed arguments for every pinned file tool and returns the path', () => {
    expect(repairFilePath('read', { file_path: 'a.txt' })).toBe('a.txt')
    expect(repairFilePath('read_image', { file_path: 'image.png' })).toBe('image.png')
    expect(repairFilePath('write', { file_path: 'a.txt', content: 'x' })).toBe('a.txt')
    expect(repairFilePath('edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' })).toBe('a.txt')
    expect(repairFilePath('edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b', replace_all: false })).toBe('a.txt')
  })

  test.each([
    ['a non file tool is rejected', 'bash', { file_path: 'a.txt' }],
    ['a control tool is rejected', 'skill_run', { file_path: 'a.txt' }],
    ['null arguments are rejected', 'read', null],
    ['array arguments are rejected', 'read', ['a.txt']],
    ['a missing file_path is rejected', 'read', {}],
    ['a non-string file_path is rejected', 'read', { file_path: 42 }],
    ['write without a string content is rejected', 'write', { file_path: 'a.txt' }],
    ['write with non-string content is rejected', 'write', { file_path: 'a.txt', content: 1 }],
    ['edit without old/new strings is rejected', 'edit', { file_path: 'a.txt' }],
    ['edit with a non-string new_string is rejected', 'edit', { file_path: 'a.txt', old_string: 'a', new_string: 2 }],
    ['edit with an illegal replace_all type is rejected', 'edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b', replace_all: 'yes' }],
  ])('%s', (_label, name, arguments_) => {
    expect(() => repairFilePath(name, arguments_ as never)).toThrow(invalid)
  })
})

describe('assertRepairWorkspacePath', () => {
  test('admits an existing or not-yet-created file contained in the workspace', async () => {
    const ws = await workspace()
    await writeFile(join(ws, 'existing.txt'), 'x')
    await expect(assertRepairWorkspacePath(ws, 'existing.txt')).resolves.toBeUndefined()
    // A brand-new file under a not-yet-existing directory must also be admitted
    // without following any link (ENOENT stops the component walk).
    await expect(assertRepairWorkspacePath(ws, join('brand', 'new', 'file.txt'))).resolves.toBeUndefined()
  })

  test('rejects an empty or non-string workspace or path value', async () => {
    const ws = await workspace()
    await expect(assertRepairWorkspacePath('', 'a.txt')).rejects.toThrow(outside)
    await expect(assertRepairWorkspacePath(ws, '')).rejects.toThrow(outside)
    await expect(assertRepairWorkspacePath(ws, 42 as unknown as string)).rejects.toThrow(outside)
  })

  test.each([
    ['parent prefix', '../escape.txt'],
    ['mid-walk escape', 'a/../../escape.txt'],
    ['trailing parent', 'sub/..'],
    ['bare parent', '..'],
    ['collapsed parent segment', 'foo/../bar'],
    ['backslash parent segment', '..\\escape.txt'],
  ])('rejects a parent-directory traversal (%s)', async (_label, value) => {
    const ws = await workspace()
    await expect(assertRepairWorkspacePath(ws, value)).rejects.toThrow(outside)
  })

  test('rejects an absolute path that resolves outside the workspace', async () => {
    const ws = await workspace()
    const target = join(tmpdir(), `repair-path-escape-${process.pid}-${ws.length}.txt`)
    expect(isAbsolute(target)).toBe(true)
    await expect(assertRepairWorkspacePath(ws, target)).rejects.toThrow(outside)
  })

  test('rejects when the configured workspace is not a real directory', async () => {
    const ws = await workspace()
    const file = join(ws, 'not-a-workspace')
    await writeFile(file, 'x')
    await expect(assertRepairWorkspacePath(file, 'a.txt')).rejects.toThrow(outside)
  })

  test('rejects a symlinked path component even when the final name stays inside', async () => {
    const ws = await workspace()
    const external = await workspace()
    await mkdir(join(external, 'inside'))
    await symlink(external, join(ws, 'link'))
    // The component walk lstat's `link` itself before ever descending, so the
    // out-of-workspace target is rejected at the link.
    await expect(assertRepairWorkspacePath(ws, join('link', 'inside', 'x.txt'))).rejects.toThrow(outside)
  })
})
