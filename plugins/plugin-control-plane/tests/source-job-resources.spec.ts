import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createIsolatedWorktree, removeSourceJobWorktree } from '../src/source-workspace.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-job-resources-'))); roots.push(root)
  const repository = join(root, 'repo'); const stateRoot = join(root, 'private')
  await mkdir(repository); await mkdir(stateRoot, { mode: 0o700 })
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repository, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'base')
  const baseCommit = git('rev-parse', 'HEAD')
  const worktreeName = `worktree-job-${'a'.repeat(64)}`
  const input = { repository, stateRoot, baseCommit, worktreeName, environment: process.env }
  return { ...input, input, worktree: join(stateRoot, worktreeName) }
}

it('allocates one exact worktree exclusively and reconciles only its registered base/repository', async () => {
  const f = await fixture()
  const tree = await createIsolatedWorktree(f.input)
  expect(tree.worktree).toBe(f.worktree)
  await expect(createIsolatedWorktree(f.input)).rejects.toMatchObject({ code: 'EEXIST' })
  await expect(removeSourceJobWorktree({ ...f, baseCommit: 'b'.repeat(40) })).rejects.toThrow(/base identity/)
  expect((await lstat(f.worktree)).isDirectory()).toBe(true)
  await removeSourceJobWorktree(f)
  await expect(lstat(f.worktree)).rejects.toMatchObject({ code: 'ENOENT' })
  await removeSourceJobWorktree(f)
})

it('preserves unregistered foreign content at a matching planned resource path', async () => {
  const f = await fixture()
  await mkdir(f.worktree, { mode: 0o700 }); await writeFile(join(f.worktree, 'keep'), 'foreign content')
  await expect(removeSourceJobWorktree(f)).rejects.toThrow(/registration is unproven/)
  expect(await readFile(join(f.worktree, 'keep'), 'utf8')).toBe('foreign content')
})

it('uses exact reconciliation during failed-build disposal too', async () => {
  const f = await fixture()
  const tree = await createIsolatedWorktree(f.input)
  await removeSourceJobWorktree(f)
  await mkdir(f.worktree, { mode: 0o700 }); await writeFile(join(f.worktree, 'keep'), 'replacement content')
  await expect(tree.remove()).rejects.toThrow(/registration is unproven/)
  await expect(tree.remove()).rejects.toThrow(/registration is unproven/)
  expect(await readFile(join(f.worktree, 'keep'), 'utf8')).toBe('replacement content')
})
