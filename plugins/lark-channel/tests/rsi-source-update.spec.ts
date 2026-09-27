import { execFileSync } from 'node:child_process'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { prepareRsiLocalCohort } from '../src/rsi-local-cohort.js'
import { prepareRsiSourceUpdate, readRsiSourceUpdate } from '../src/rsi-source-update.js'
import { localCohortFixture } from './fixtures/rsi-local-cohort.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function git(cwd: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } }).trim()
}
async function committed(cwd: string, file: string, contents: string): Promise<string> {
  await writeFile(join(cwd, file), contents)
  git(cwd, 'add', file)
  git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', file)
  return git(cwd, 'rev-parse', 'HEAD')
}
async function fixture() {
  const f = await localCohortFixture()
  roots.push(f.root)
  await prepareRsiLocalCohort({ dshHome: f.home, profile: f.profile, source: f.source,
    bundles: ['target'] }, f.ports)
  return { ...f, input: { dshHome: f.home, profile: f.profile, sourceRepository: f.sourceRepository,
    candidateRoot: join(f.root, 'candidate') } }
}
async function advanceRepair(f: Awaited<ReturnType<typeof fixture>>, filename: string, contents: string): Promise<string> {
  const clone = join(f.root, 'repair-clone')
  execFileSync('/usr/bin/git', ['clone', '--no-hardlinks', '--quiet', f.source.repository, clone])
  const repair = await committed(clone, filename, contents)
  git(f.source.repository, 'fetch', '--no-tags', clone, `+${repair}:refs/dsh-source/repairs`)
  git(f.source.baseline.remote, 'fetch', '--no-tags', clone, `+${repair}:refs/heads/repairs`)
  return repair
}

describe('private RSI source update candidate', () => {
  test('fast-forwards to an exact upstream commit and replays without touching live refs', async () => {
    const f = await fixture()
    const upstream = await committed(f.sourceRepository, 'upstream.txt', 'upstream work\n')
    const result = await prepareRsiSourceUpdate(f.input)
    expect(result).toMatchObject({ schemaVersion: 1, root: f.input.candidateRoot,
      repository: join(f.input.candidateRoot, 'repository'), version: f.version,
      upstreamCommit: upstream, repairCommit: f.source.sourceCommit, sourceCommit: upstream })
    expect(await readRsiSourceUpdate(f.input)).toEqual(result)
    expect(await prepareRsiSourceUpdate(f.input)).toEqual(result)
    expect(git(f.source.repository, 'rev-parse', 'HEAD')).toBe(f.source.sourceCommit)
    expect(git(f.source.repository, 'rev-parse', f.source.baseline.ref)).toBe(f.source.sourceCommit)
    expect(git(f.source.baseline.remote, 'rev-parse', 'refs/heads/repairs')).toBe(f.source.sourceCommit)
    expect(await readFile(join(result.repository, 'upstream.txt'), 'utf8')).toBe('upstream work\n')
  })

  test('merges divergent nonconflicting upstream and repair commits reproducibly', async () => {
    const f = await fixture()
    const repair = await advanceRepair(f, 'repair.txt', 'owner repair\n')
    const upstream = await committed(f.sourceRepository, 'upstream.txt', 'upstream work\n')
    const result = await prepareRsiSourceUpdate(f.input)
    expect(result.repairCommit).toBe(repair)
    expect(result.upstreamCommit).toBe(upstream)
    expect(result.sourceCommit).not.toBe(repair)
    expect(result.sourceCommit).not.toBe(upstream)
    expect(git(result.repository, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toEqual([result.sourceCommit, repair, upstream])
    expect(await readFile(join(result.repository, 'repair.txt'), 'utf8')).toBe('owner repair\n')
    expect(await readFile(join(result.repository, 'upstream.txt'), 'utf8')).toBe('upstream work\n')
    expect(git(f.source.repository, 'rev-parse', f.source.baseline.ref)).toBe(repair)
    expect(git(f.source.baseline.remote, 'rev-parse', 'refs/heads/repairs')).toBe(repair)
  })

  test('pins a newer upstream package version and rejects a repair result with another version', async () => {
    const f = await fixture()
    const packagePath = join(f.sourceRepository, 'package.json')
    const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>
    const nextVersion = '0.1.49'
    manifest.version = nextVersion
    const upstream = await committed(f.sourceRepository, 'package.json', `${JSON.stringify(manifest, null, 2)}\n`)
    const result = await prepareRsiSourceUpdate(f.input)
    expect(result.version).toBe(nextVersion)
    expect(result.sourceCommit).toBe(upstream)
    expect((await readRsiSourceUpdate(f.input)).version).toBe(nextVersion)

    const other = await fixture()
    const repairManifest = JSON.parse(await readFile(join(other.sourceRepository, 'package.json'), 'utf8')) as Record<string, unknown>
    repairManifest.version = '0.1.50'
    await advanceRepair(other, 'package.json', `${JSON.stringify(repairManifest, null, 2)}\n`)
    await committed(other.sourceRepository, 'upstream.txt', 'upstream work\n')
    await expect(prepareRsiSourceUpdate(other.input)).rejects.toThrow('merged package version differs from upstream')
    await expect(lstat(other.input.candidateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects a conflicting merge and leaves both live refs and candidate root unchanged', async () => {
    const f = await fixture()
    const repair = await advanceRepair(f, 'plugins/target/README.md', 'owner repair\n')
    await committed(f.sourceRepository, 'plugins/target/README.md', 'upstream replacement\n')
    await expect(prepareRsiSourceUpdate(f.input)).rejects.toThrow('cannot be merged without conflict')
    await expect(lstat(f.input.candidateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(git(f.source.repository, 'rev-parse', f.source.baseline.ref)).toBe(repair)
    expect(git(f.source.baseline.remote, 'rev-parse', 'refs/heads/repairs')).toBe(repair)
  })

  test('ignores caller Git hooks/config and rejects changed original refs on replay', async () => {
    const f = await fixture()
    const hooks = join(f.root, 'hostile-hooks'), marker = join(f.root, 'hook-ran')
    await mkdir(hooks)
    await writeFile(join(hooks, 'post-checkout'), `#!/bin/sh\necho ran > ${marker}\n`, { mode: 0o755 })
    const config = join(f.root, 'hostile-git-config')
    await writeFile(config, `[core]\n\thooksPath = ${hooks}\n`)
    const before = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = config
    try {
      const result = await prepareRsiSourceUpdate(f.input)
      expect(result.sourceCommit).toBe(f.source.sourceCommit)
      await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      await advanceRepair(f, 'repair.txt', 'new repair\n')
      await expect(readRsiSourceUpdate(f.input)).rejects.toThrow('candidate original source changed')
      expect(git(result.repository, 'rev-parse', 'HEAD')).toBe(result.sourceCommit)
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = before
    }
  })

  test('does not execute candidate-local fsmonitor config during replay', async () => {
    const f = await fixture()
    const result = await prepareRsiSourceUpdate(f.input)
    const marker = join(f.root, 'fsmonitor-ran')
    const monitor = join(f.root, 'fsmonitor')
    await writeFile(monitor, `#!/bin/sh\necho ran > ${marker}\nexit 1\n`, { mode: 0o755 })
    git(result.repository, 'config', 'core.fsmonitor', monitor)
    await expect(readRsiSourceUpdate(f.input)).rejects.toThrow('candidate Git config changed')
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects an unsafe root or cancellation without publishing a candidate', async () => {
    const f = await fixture()
    await expect(prepareRsiSourceUpdate({ ...f.input, candidateRoot: join(f.home, 'candidate') }))
      .rejects.toThrow('candidate scope is invalid')
    await expect(prepareRsiSourceUpdate({ ...f.input, candidateRoot: join(f.sourceRepository, 'candidate') }))
      .rejects.toThrow('candidate scope is invalid')
    const controller = new AbortController(); controller.abort()
    await expect(prepareRsiSourceUpdate({ ...f.input, signal: controller.signal })).rejects.toThrow()
    await expect(lstat(f.input.candidateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects symbolic repair refs and HTTP object alternates', async () => {
    const symbolic = await fixture()
    git(symbolic.source.repository, 'symbolic-ref', 'refs/dsh-source/repairs', 'refs/heads/main')
    await expect(prepareRsiSourceUpdate(symbolic.input)).rejects.toThrow(/managed release ref|missing or symbolic/u)
    await expect(lstat(symbolic.input.candidateRoot)).rejects.toMatchObject({ code: 'ENOENT' })

    const bare = await fixture()
    git(bare.source.baseline.remote, 'symbolic-ref', 'refs/heads/repairs', 'refs/heads/missing')
    await expect(prepareRsiSourceUpdate(bare.input)).rejects.toThrow(/release repository changed identity|missing or symbolic/u)
    await expect(lstat(bare.input.candidateRoot)).rejects.toMatchObject({ code: 'ENOENT' })

    const alternate = await fixture()
    await writeFile(join(alternate.sourceRepository, '.git', 'objects', 'info', 'http-alternates'), 'https://example.invalid/objects\n')
    await expect(prepareRsiSourceUpdate(alternate.input)).rejects.toThrow('external Git object alternates')
    await expect(lstat(alternate.input.candidateRoot)).rejects.toMatchObject({ code: 'ENOENT' })

    const bareAlternate = await fixture()
    await writeFile(join(bareAlternate.source.baseline.remote, 'objects', 'info', 'http-alternates'), 'https://example.invalid/objects\n')
    await expect(prepareRsiSourceUpdate(bareAlternate.input)).rejects.toThrow('external Git object alternates')
    await expect(lstat(bareAlternate.input.candidateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
