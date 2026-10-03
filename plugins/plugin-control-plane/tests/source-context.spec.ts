import * as childProcess from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runLocalCommand } from '../src/source-workspace.ts'
import { awaitSourceSignal, inspectSourceContext, inspectSourceTargetsContext } from '../src/source-context.ts'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const roots: string[] = []
afterEach(async () => { vi.resetAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cp-source-context-'))); roots.push(root)
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

async function targetFixture() {
  const value = await fixture()
  await writeFile(join(value.root, 'plugins/health-helper/package.json'), JSON.stringify({ name: '@dsh-enhanced/health-helper', description: 'Committed helper' }))
  execFileSync('/usr/bin/git', ['-C', value.root, 'add', '.'])
  execFileSync('/usr/bin/git', ['-C', value.root, 'commit', '-m', 'plugin manifest'])
  return { root: value.root, head: execFileSync('/usr/bin/git', ['-C', value.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
}

function targets(repository: string, options: { baseCommit?: string; baselineCommit?: string; signal?: AbortSignal; assertCurrent?: () => Promise<void> } = {}) {
  return inspectSourceTargetsContext({ repository, environment: process.env, signal: options.signal ?? new AbortController().signal,
    assertCurrent: options.assertCurrent ?? (async () => undefined),
    ...(options.baseCommit === undefined ? {} : { baseCommit: options.baseCommit }),
    ...(options.baselineCommit === undefined ? {} : { baselineCommit: options.baselineCommit }) })
}

function commit(root: string, message: string): string {
  execFileSync('/usr/bin/git', ['-C', root, 'add', '.'])
  execFileSync('/usr/bin/git', ['-C', root, 'commit', '-m', message])
  return execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
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

  it('reads the resolved managed baseline while preserving the checkout and rejects a stale inspected base', async () => {
    const value = await fixture(), file = join(value.root, 'plugins/health-helper/src/index.ts')
    await writeFile(file, 'export const secondVersion = true\n')
    execFileSync('/usr/bin/git', ['-C', value.root, 'add', '.'])
    execFileSync('/usr/bin/git', ['-C', value.root, 'commit', '-m', 'next released version'])
    const released = execFileSync('/usr/bin/git', ['-C', value.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    execFileSync('/usr/bin/git', ['-C', value.root, 'checkout', '--detach', value.head])
    await writeFile(file, 'private uncommitted edit\n')
    const input = { repository: value.root, name: 'health-helper', paths: ['src/index.ts'], environment: process.env,
      baselineCommit: released, baseCommit: released, signal: new AbortController().signal, assertCurrent: async () => {} }
    expect((await inspectSourceContext(input)).contents).toEqual([{ path: 'src/index.ts', content: 'export const secondVersion = true\n' }])
    expect(await readFile(file, 'utf8')).toBe('private uncommitted edit\n')
    expect(execFileSync('/usr/bin/git', ['-C', value.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(value.head)
    await expect(inspectSourceContext({ ...input, baseCommit: value.head })).rejects.toThrow('stale')
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

describe('committed source targets', () => {
  it('lists only eligible committed plugin identities and ignores dirty, untracked, protected, and linked manifests', async () => {
    const { root, head } = await targetFixture()
    await mkdir(join(root, 'plugins/assistant-policy'))
    await writeFile(join(root, 'plugins/assistant-policy/package.json'), '{"name":"@dsh-enhanced/assistant-policy"}')
    await mkdir(join(root, 'plugins/Bad_Name'))
    await writeFile(join(root, 'plugins/Bad_Name/package.json'), '{"name":"@dsh-enhanced/Bad_Name"}')
    await mkdir(join(root, 'plugins/linked-helper'))
    await symlink('../health-helper/package.json', join(root, 'plugins/linked-helper/package.json'))
    await mkdir(join(root, 'plugins/new-helper'))
    await writeFile(join(root, 'plugins/new-helper/package.json'), '{"name":"@dsh-enhanced/new-helper"}')
    execFileSync('/usr/bin/git', ['-C', root, 'add', 'plugins/assistant-policy', 'plugins/Bad_Name', 'plugins/linked-helper'])
    execFileSync('/usr/bin/git', ['-C', root, 'update-index', '--add', '--cacheinfo', `160000,${head},plugins/gitlink-helper`])
    execFileSync('/usr/bin/git', ['-C', root, 'commit', '-m', 'ineligible plugin roots'])
    await writeFile(join(root, 'plugins/health-helper/package.json'), '{"name":"@dsh-enhanced/health-helper","description":"dirty"}')
    const result = await targets(root)
    expect(result.plugins).toEqual([{ name: 'health-helper', description: 'Committed helper' }])
    expect(result.baseCommit).toBe(execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
    expect(Object.isFrozen(result.plugins)).toBe(true)
  })

  it('uses the resolved managed commit without changing checkout and rejects stale bases or noncanonical roots', async () => {
    const { root, head } = await targetFixture()
    await writeFile(join(root, 'plugins/health-helper/package.json'), '{"name":"@dsh-enhanced/health-helper","description":"released"}')
    const released = commit(root, 'released plugin')
    execFileSync('/usr/bin/git', ['-C', root, 'checkout', '--detach', head])
    await writeFile(join(root, 'plugins/health-helper/package.json'), '{"name":"@dsh-enhanced/health-helper","description":"dirty"}')
    expect(await targets(root, { baselineCommit: released, baseCommit: released })).toEqual({
      baseCommit: released, plugins: [{ name: 'health-helper', description: 'released' }],
    })
    expect(await readFile(join(root, 'plugins/health-helper/package.json'), 'utf8')).toContain('dirty')
    await expect(targets(root, { baselineCommit: released, baseCommit: head })).rejects.toThrow('stale')
    await expect(targets(root, { baseCommit: released })).rejects.toThrow('stale')
    await expect(targets(join(root, 'plugins/health-helper'))).rejects.toThrow('top-level')
  })

  it('rejects malformed, mismatched, binary and invalid description manifests', async () => {
    const { root } = await targetFixture()
    const path = join(root, 'plugins/health-helper/package.json')
    for (const content of [
      '{',
      JSON.stringify({ name: '@dsh-enhanced/other-helper' }),
      JSON.stringify({ name: '@dsh-enhanced/health-helper', description: 'a\nb' }),
      JSON.stringify({ name: '@dsh-enhanced/health-helper', description: '界'.repeat(171) }),
      Buffer.from([0x7b, 0x80, 0x7d]),
    ]) {
      await writeFile(path, content)
      commit(root, 'invalid plugin manifest')
      await expect(targets(root)).rejects.toThrow(/manifest|description/u)
    }
  })

  it('rejects per-manifest, aggregate and eligible count bounds rather than returning a partial directory', async () => {
    const { root } = await targetFixture()
    const path = join(root, 'plugins/health-helper/package.json')
    await writeFile(path, JSON.stringify({ name: '@dsh-enhanced/health-helper', padding: 'x'.repeat(16_384) }))
    commit(root, 'oversized manifest')
    await expect(targets(root)).rejects.toThrow('bound')
    await writeFile(path, JSON.stringify({ name: '@dsh-enhanced/health-helper' }))
    for (let i = 0; i < 129; i++) {
      const name = `helper-${i}`
      await mkdir(join(root, 'plugins', name))
      await writeFile(join(root, 'plugins', name, 'package.json'), JSON.stringify({ name: `@dsh-enhanced/${name}` }))
    }
    commit(root, 'too many plugins')
    await expect(targets(root)).rejects.toThrow('count')
    for (let i = 0; i < 129; i++) await rm(join(root, 'plugins', `helper-${i}`), { recursive: true })
    for (let i = 0; i < 33; i++) {
      const name = `aggregate-${i}`
      await mkdir(join(root, 'plugins', name))
      await writeFile(join(root, 'plugins', name, 'package.json'), JSON.stringify({ name: `@dsh-enhanced/${name}`, padding: 'x'.repeat(16_000) }))
    }
    commit(root, 'too many manifest bytes')
    await expect(targets(root)).rejects.toThrow('aggregate')
  })

  it('cancels a stalled currentness check and never publishes its late result', async () => {
    const { root } = await targetFixture()
    const controller = new AbortController()
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const running = targets(root, { signal: controller.signal, assertCurrent: () => blocked }).catch(error => error)
    await new Promise(resolve => setImmediate(resolve))
    controller.abort(new Error('target inspection cancelled'))
    expect((await running).message).toBe('target inspection cancelled')
    release()
    await new Promise(resolve => setImmediate(resolve))
    expect((await running).message).toBe('target inspection cancelled')
  })
})
