// Engineering fixtures run a fake Docker executable. These tests exercise Host
// admission, process bounds and daemon failure handling, not OS isolation.
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runDockerPreparedChecks, type SourceBuildConfig } from '../src/source-build.ts'

const indices = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdtemp: async (prefix: string) => {
    const path = await actual.mkdtemp(prefix)
    if (prefix.includes('dsh-source-build-index-')) indices.push(path)
    return path
  } }
})

const roots: string[] = []
afterEach(async () => { indices.length = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const marker = `printf 'DSH_PREPARED_PACK\\thelper-1.0.0-rc.1.tgz\\t13\\t${'d'.repeat(64)}\\tv24.0.0\\t11.7.0\\n'`
async function fixture(run = marker, control = 'exit 0') {
  const root = await mkdtemp(join(tmpdir(), 'source-builder-test-')); roots.push(root)
  const repository = join(root, 'repo'); const plugin = join(repository, 'plugins', 'helper')
  await mkdir(plugin, { recursive: true })
  await writeFile(join(plugin, 'package.json'), '{"name":"helper","version":"1.0.0-rc.1"}')
  await writeFile(join(plugin, 'index.js'), 'old')
  const environment = { PATH: process.env.PATH, HOME: root }
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repository, env: environment, encoding: 'utf8' }).trim()
  git('init', '-q'); git('add', '--all'); git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture')
  const baseCommit = git('rev-parse', 'HEAD')
  await writeFile(join(plugin, 'index.js'), 'new')
  const dockerPath = join(root, 'docker')
  await writeFile(dockerPath, `#!/bin/sh\nif [ "$1" = run ]; then\ncat >/dev/null\n${run}\nelse\n${control}\nfi\n`)
  await chmod(dockerPath, 0o700)
  const config: SourceBuildConfig = { dockerPath, image: `sha256:${'a'.repeat(64)}`, timeoutMs: 60_000,
    memoryMiB: 512, cpus: 1, pidsLimit: 64, workspaceMiB: 128, outputBytes: 4_096 }
  return { root, repository, plugin, dockerPath, config, input: { config, worktree: repository, baseCommit,
    name: 'helper', scope: ['plugins/helper'], environment, signal: new AbortController().signal,
    assertCurrent: async () => {}, preparedAt: Date.now() } }
}

it('records the immutable prerelease package version and configured image', async () => {
  const f = await fixture()
  const result = await runDockerPreparedChecks(f.input)
  expect(result.evidence.pack.version).toBe('1.0.0-rc.1')
  expect(result.evidence.commands[0]?.args).toContain(f.config.image)
})

it.each([
  ['daemon unavailable', 'exit 1'],
  ['container remains', 'if [ "$1" = container ]; then echo still-running; fi; exit 0'],
])('refuses success when cleanup cannot prove absence: %s', async (_label, control) => {
  const f = await fixture(marker, control)
  await expect(runDockerPreparedChecks(f.input)).rejects.toThrow(/cleanup could not prove quiescence/)
})

it('rejects candidate-spoofed extra evidence output', async () => {
  const f = await fixture(`${marker}\n${marker}`)
  await expect(runDockerPreparedChecks(f.input)).rejects.toThrow(/unexpected evidence output/)
})

it('stops excessive output and settles instead of buffering until the deadline', async () => {
  const f = await fixture('exec /usr/bin/yes x')
  const started = Date.now()
  await expect(runDockerPreparedChecks(f.input)).rejects.toThrow(/output bound/)
  expect(Date.now() - started).toBeLessThan(5_000)
})

it('cancels a running client and checks daemon cleanup before settling', async () => {
  const f = await fixture(': > "$0.started"\nexec /bin/sleep 60')
  const abort = new AbortController()
  const pending = runDockerPreparedChecks({ ...f.input, signal: abort.signal })
  void pending.catch(() => undefined)
  try {
    await vi.waitFor(async () => { expect((await lstat(`${f.dockerPath}.started`)).isFile()).toBe(true) }, { timeout: 5_000 })
    abort.abort(new Error('owner stopped'))
    await expect(pending).rejects.toThrow(/cancelled|archive exited/)
  } finally { abort.abort(); await pending.catch(() => undefined) }
})

it('refuses a Host worktree change made after the archive was consumed', async () => {
  const f = await fixture()
  await writeFile(f.dockerPath, `#!/bin/sh\nif [ "$1" = run ]; then\ncat >/dev/null\nprintf changed > '${join(f.plugin, 'index.js')}'\n${marker}\nfi\n`)
  await expect(runDockerPreparedChecks(f.input)).rejects.toThrow(/source changed/)
  expect(await readFile(join(f.plugin, 'index.js'), 'utf8')).toBe('changed')
})

it('removes the immutable index if malformed package metadata fails before Docker starts', async () => {
  const f = await fixture()
  await writeFile(join(f.plugin, 'package.json'), '{invalid json')
  await expect(runDockerPreparedChecks(f.input)).rejects.toThrow()
  expect(indices).toHaveLength(1)
  await expect(lstat(indices[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
})
