import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertSourceReviewHead, inspectSourceReviewGit, type SourceReviewGitConfig, type SourceReviewGitRequest } from '../src/source-review-git.ts'

// On macOS /usr/bin/git is a developer-tool shim. Resolve it once so the
// reader's minimal environment does not repeat toolchain discovery per command.
// Pin the canonical executable itself, not the shim that selects another binary.
const git = process.platform === 'darwin'
  ? realpathSync(execFileSync('/usr/bin/xcrun', ['--find', 'git'], { encoding: 'utf8' }).trim())
  : '/usr/bin/git'
const roots: string[] = []
const run = (cwd: string, ...args: string[]): Buffer => execFileSync(git, args, { cwd, encoding: 'buffer' })
const text = (cwd: string, ...args: string[]) => run(cwd, ...args).toString('utf8').trim()
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function snapshot(bare: string, baseCommit: string, scope: readonly string[]) {
  const indexRoot = await mkdtemp(join(tmpdir(), 'source-review-test-index-'))
  try {
    const environment = { ...process.env, GIT_INDEX_FILE: join(indexRoot, 'index') }
    execFileSync(git, ['--git-dir', bare, 'read-tree', 'refs/dsh-release/pulls/pr-1/head'], { env: environment })
    const tree = execFileSync(git, ['--git-dir', bare, '--literal-pathspecs', '-c', 'core.quotepath=false', 'ls-files', '--stage', '-z', '--', ...scope], { env: environment })
    const patch = execFileSync(git, ['--git-dir', bare, '--literal-pathspecs', '-c', 'core.quotepath=false', 'diff', '--cached', '--binary', '--full-index', '--no-color', baseCommit, '--', ...scope], { env: environment })
    const binding = `${baseCommit}\0${JSON.stringify([...scope].sort())}\0`
    return { checkedTreeDigest: createHash('sha256').update('dsh-source-tree-v2\0').update(binding).update(tree).digest('hex'),
      checkedPatchDigest: createHash('sha256').update('dsh-source-patch-v2\0').update(binding).update(patch).digest('hex') }
  } finally { await rm(indexRoot, { recursive: true, force: true }) }
}

async function fixture() {
  // macOS 上 os.tmpdir() 经 /var → /private/var；review 根有 canonical 校验。
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-review-git-'))); roots.push(root)
  const work = join(root, 'work'), bare = join(root, 'source.git')
  run(root, 'init', '-q', work); run(work, 'config', 'user.email', 'test@example.invalid'); run(work, 'config', 'user.name', 'Tests')
  await writeFile(join(work, 'README.md'), 'base\n'); await writeFile(join(work, 'plugins-marker'), '')
  await mkdir(join(work, 'plugins', 'sample'), { recursive: true })
  await writeFile(join(work, 'plugins/sample/index.ts'), 'export const base = true\n')
  run(work, 'add', '--all'); run(work, 'commit', '-qm', 'base'); const baseCommit = text(work, 'rev-parse', 'HEAD')
  await writeFile(join(work, 'plugins/sample/index.ts'), 'export const reviewed = true\n')
  run(work, 'add', '--all'); run(work, 'commit', '-qm', 'review'); const headCommit = text(work, 'rev-parse', 'HEAD')
  run(root, 'clone', '--bare', '-q', work, bare); run(root, '--git-dir', bare, 'update-ref', 'refs/dsh-release/pulls/pr-1/head', headCommit)
  const checked = await snapshot(bare, baseCommit, ['plugins/sample'])
  const config: SourceReviewGitConfig = { repository: resolve(bare), git: { path: resolve(git), sha256: sha(await readFile(git)) }, maxChangedFiles: 8, maxInputBytes: 1_048_576 }
  const request: SourceReviewGitRequest = { name: 'sample', baseCommit, headCommit, prId: 'pr-1', scope: ['plugins/sample'],
    checkedTreeDigest: checked.checkedTreeDigest, checkedPatchDigest: checked.checkedPatchDigest }
  return { root, work, bare, config, request }
}

describe('bounded bare Git source review', () => {
  it('recreates the control-plane snapshot from the exact release head', async () => {
    const f = await fixture(); const result = await inspectSourceReviewGit(f.config, f.request)
    expect(result.changedPaths).toEqual(['plugins/sample/index.ts'])
    expect(result.digest).toBe(f.request.checkedPatchDigest)
    expect(result.patch).toContain('export const reviewed = true')
    expect(() => assertSourceReviewHead(f.config, f.request)).not.toThrow()
  })

  it('rejects a moved PR head, a wrong single parent, and a mismatched digest', async () => {
    const f = await fixture()
    await writeFile(join(f.work, 'plugins/sample/next.ts'), 'next\n'); run(f.work, 'add', '--all'); run(f.work, 'commit', '-qm', 'moved')
    run(f.work, 'push', '-q', f.bare, 'HEAD:refs/dsh-release/pulls/pr-1/head')
    await expect(inspectSourceReviewGit(f.config, f.request)).rejects.toThrow('head changed')
    expect(() => assertSourceReviewHead(f.config, f.request)).toThrow('head changed')
    const original = await fixture()
    await expect(inspectSourceReviewGit(original.config, { ...original.request, baseCommit: 'a'.repeat(40) })).rejects.toThrow('parent changed')
    await expect(inspectSourceReviewGit(original.config, { ...original.request, checkedPatchDigest: '0'.repeat(64) })).rejects.toThrow('snapshot changed')
  })

  it('rejects files outside scope and configured byte bounds', async () => {
    const f = await fixture()
    run(f.work, 'reset', '--hard', f.request.baseCommit)
    await writeFile(join(f.work, 'outside.txt'), 'outside\n'); run(f.work, 'add', '--all'); run(f.work, 'commit', '-qm', 'outside')
    const outside = text(f.work, 'rev-parse', 'HEAD'); run(f.work, 'push', '-q', f.bare, '+HEAD:refs/dsh-release/pulls/pr-1/head')
    const request = { ...f.request, headCommit: outside }
    await expect(inspectSourceReviewGit(f.config, request)).rejects.toThrow('outside')
    const bounded = await fixture()
    await expect(inspectSourceReviewGit({ ...bounded.config, maxInputBytes: 1 }, bounded.request)).rejects.toThrow('byte limit')
  })

  it('rejects symbolic links in the reviewed tree', async () => {
    const f = await fixture(); run(f.work, 'reset', '--hard', f.request.baseCommit); await symlink('index.ts', join(f.work, 'plugins/sample/link.ts'))
    run(f.work, 'add', '--all'); run(f.work, 'commit', '-qm', 'link'); const head = text(f.work, 'rev-parse', 'HEAD')
    run(f.work, 'push', '-q', f.bare, '+HEAD:refs/dsh-release/pulls/pr-1/head')
    const checked = await snapshot(f.bare, f.request.baseCommit, f.request.scope)
    await expect(inspectSourceReviewGit(f.config, { ...f.request, headCommit: head, ...checked })).rejects.toThrow('symbolic links')
  })

  it('honors an already-aborted signal before invoking Git', async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort(new Error('stop-review'))
    await expect(inspectSourceReviewGit(f.config, f.request, controller.signal)).rejects.toThrow('stop-review')
  })
})