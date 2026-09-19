import * as childProcess from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runLocalCommand } from '../src/source-workspace.ts'
import { awaitSourceSignal, inspectSourceContext } from '../src/source-context.ts'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const roots: string[] = []
afterEach(async () => { vi.resetAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cp-source-context-')); roots.push(root)
  await mkdir(join(root, 'plugins', 'health-helper', 'src'), { recursive: true })
  await writeFile(join(root, 'plugins', 'health-helper', 'src', 'index.ts'), 'export const committed = true\n')
  await writeFile(join(root, 'plugins', 'health-helper', 'README.md'), '# helper\n')
  await writeFile(join(root, 'plugins', 'health-helper', 'blob.bin'), Buffer.from([0, 1, 2]))
  await writeFile(join(root, 'plugins', 'health-helper', 'src', 'binary.ts'), Buffer.from([0x66, 0x80]))
  await symlink('index.ts', join(root, 'plugins', 'health-helper', 'src', 'link.ts'))
  execFileSync('/usr/bin/git', ['init', root]); execFileSync('/usr/bin/git', ['-C', root, 'config', 'user.email', 'test@example.invalid']); execFileSync('/usr/bin/git', ['-C', root, 'config', 'user.name', 'Test'])
  execFileSync('/usr/bin/git', ['-C', root, 'add', '.']); execFileSync('/usr/bin/git', ['-C', root, 'commit', '-m', 'fixture'])
  const head = execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  return { root, head }
}

function inspect(repository: string, paths: readonly string[] = [], baseCommit?: string) {
  const signal = new AbortController()
  return inspectSourceContext({ repository, name: 'health-helper', paths, ...(baseCommit === undefined ? {} : { baseCommit }), environment: process.env, signal: signal.signal,
    assertCurrent: async () => { signal.signal.throwIfAborted() } })
}

describe('source context', () => {
  it('reads committed Git blobs and ignores dirty worktree bytes', async () => {
    const value = await fixture(); await writeFile(join(value.root, 'plugins', 'health-helper', 'src', 'index.ts'), 'export const dirty = true\n')
    const result = await inspect(value.root, ['src/index.ts'], value.head)
    expect(result.contents).toEqual([{ path: 'src/index.ts', content: 'export const committed = true\n' }])
    expect(result.files.find(file => file.path === 'README.md')?.bytes).toBe(9)
    expect(result.files.map(file => file.path)).toEqual(['README.md', 'src/binary.ts', 'src/index.ts'])
  })

  it('requires the exact current HEAD and rejects protected, binary, and escaping requests', async () => {
    const value = await fixture()
    await expect(inspect(value.root, ['src/index.ts'], 'a'.repeat(40))).rejects.toThrow('stale')
    await expect(inspectSourceContext({ repository: value.root, name: 'assistant-policy', paths: [], environment: process.env,
      signal: new AbortController().signal, assertCurrent: async () => undefined })).rejects.toThrow('protected')
    await expect(inspect(value.root, ['blob.bin'], value.head)).rejects.toThrow('unavailable')
    await expect(inspect(value.root, ['src/binary.ts'], value.head)).rejects.toThrow('UTF-8')
    await expect(inspect(value.root, ['src/link.ts'], value.head)).rejects.toThrow('unavailable')
    await expect(inspect(value.root, ['../package.json'], value.head)).rejects.toThrow('escapes')
  })

  it('omits submodules and generated/hidden files while reading executable UTF-8 text', async () => {
    const value = await fixture()
    const root = join(value.root, 'plugins/health-helper')
    await mkdir(join(root, 'lib'))
    await writeFile(join(root, 'lib/generated.ts'), 'generated')
    await writeFile(join(root, '.secret.json'), '{"private":true}')
    await writeFile(join(root, 'run.sh'), '#!/bin/sh\n# valid replacement character: �\n')
    await chmod(join(root, 'run.sh'), 0o755)
    execFileSync('/usr/bin/git', ['-C', value.root, 'add', '.'])
    execFileSync('/usr/bin/git', ['-C', value.root, 'update-index', '--add', '--cacheinfo', `160000,${value.head},plugins/health-helper/vendor.ts`])
    execFileSync('/usr/bin/git', ['-C', value.root, 'commit', '-m', 'tracked boundaries'])
    const result = await inspect(value.root, ['run.sh'])
    expect(result.contents[0]?.content).toContain('�')
    expect(result.files.map(file => file.path)).not.toContain('vendor.ts')
    expect(result.files.map(file => file.path)).not.toContain('.secret.json')
    expect(result.files.map(file => file.path)).not.toContain('lib/generated.ts')
    await expect(inspect(value.root, ['vendor.ts'])).rejects.toThrow('unavailable')
  })

  it('rejects file, aggregate and path-count bounds before returning content', async () => {
    const value = await fixture()
    const root = join(value.root, 'plugins/health-helper')
    await writeFile(join(root, 'large.ts'), 'x'.repeat(65_537))
    await writeFile(join(root, 'nul.ts'), 'abc\0def')
    await Promise.all(Array.from({ length: 5 }, (_, i) => writeFile(join(root, `part${i}.ts`), 'x'.repeat(60_000))))
    execFileSync('/usr/bin/git', ['-C', value.root, 'add', '.'])
    execFileSync('/usr/bin/git', ['-C', value.root, 'commit', '-m', 'content bounds'])
    await expect(inspect(value.root, ['large.ts'])).rejects.toThrow('exceeds')
    await expect(inspect(value.root, Array.from({ length: 5 }, (_, i) => `part${i}.ts`))).rejects.toThrow('exceeds')
    await expect(inspect(value.root, ['nul.ts'])).rejects.toThrow('binary')
    await expect(inspect(value.root, Array.from({ length: 65 }, (_, i) => `part${i}.ts`))).rejects.toThrow('too many')
    await expect(inspect(join(value.root, 'plugins/health-helper'))).rejects.toThrow('top-level')
  })

  it('bounds the manifest instead of silently omitting tracked files', async () => {
    const value = await fixture()
    await Promise.all(Array.from({ length: 1025 }, (_, i) => writeFile(join(value.root, 'plugins/health-helper', `f${i}.ts`), 'x')))
    execFileSync('/usr/bin/git', ['-C', value.root, 'add', '.'])
    execFileSync('/usr/bin/git', ['-C', value.root, 'commit', '-m', 'manifest bound'])
    await expect(inspect(value.root)).rejects.toThrow('manifest')
  })

  it('settles a hung async fence on cancellation and ignores its late success', async () => {
    const abort = new AbortController()
    let release!: () => void
    const fence = new Promise<void>(resolve => { release = resolve })
    const running = awaitSourceSignal(abort.signal, () => fence).catch(error => error)
    await new Promise(resolve => setImmediate(resolve))
    abort.abort(new Error('source deadline exceeded'))
    expect((await running).message).toBe('source deadline exceeded')
    release()
    await new Promise(resolve => setImmediate(resolve))
    expect((await running).message).toBe('source deadline exceeded')
  })

  it('cancels a running child and settles only after it closes', async () => {
    const value = await fixture()
    const actualSpawn = (await vi.importActual<typeof childProcess>('node:child_process')).spawn
    let pid: number | undefined
    let closed = false
    vi.mocked(childProcess.spawn).mockImplementation(((_command: unknown, _args: unknown, options: unknown) => {
      const child = actualSpawn('/bin/sleep', ['60'], options as childProcess.SpawnOptionsWithoutStdio)
      pid = child.pid
      child.once('close', () => { closed = true })
      return child
    }) as typeof childProcess.spawn)
    const abort = new AbortController()
    const running = runLocalCommand('git', ['rev-parse', 'HEAD'], value.root, process.env, { capture: true, signal: abort.signal })
    const settled = running.catch(error => error)
    await vi.waitFor(() => expect(pid).toBeDefined())
    abort.abort(new Error('inspection cancelled'))
    expect((await settled).message).toBe('inspection cancelled')
    expect(closed).toBe(true)
    expect(() => process.kill(pid!, 0)).toThrow()
  })
})
