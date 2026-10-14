import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { prepareRsiSourceWorkspace } from '../src/rsi-source.js'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } }).trim()
}

async function fixture(version = '0.1.48') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rsi-source-'))); roots.push(root)
  const home = join(root, 'home'), source = join(root, 'source')
  await mkdir(home, { mode: 0o700 }); await mkdir(source)
  git(source, 'init', '--object-format=sha1', '--initial-branch=main', '.')
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'dsh-enhanced', version }))
  await writeFile(join(source, 'README.md'), 'initial\n')
  git(source, 'add', 'package.json', 'README.md'); git(source, 'commit', '-m', 'initial')
  const head = git(source, 'rev-parse', 'HEAD')
  return { root, home, source, head, args: { dshHome: home, profile: 'owner', version, sourceRepository: source } }
}

async function legacyMacFixture() {
  const f = await fixture('0.1.49')
  const old = await prepareRsiSourceWorkspace(f.args)
  const receiptPath = join(f.home, 'rsi-sources', 'owner', 'bootstrap.json')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, any>
  // The known official commit is part of the admission contract. A local
  // fixture cannot reproduce that object, so model it using the receipt's
  // digest envelope and a Git output adapter scoped to this test.
  const knownCommit = '172bc31ddf0c00a6f0b3252354f2170a14dd7fc2'
  const { receiptDigest: _digest, ...body } = receipt
  body.origin = { kind: 'official-tag', locator: 'https://github.com/22-ai-00/dsh-enhanced.git', ref: 'refs/tags/v0.1.49' }
  body.sourceCommit = knownCommit
  body.baseline.initialCommit = knownCommit
  await writeFile(receiptPath, JSON.stringify({ ...body, receiptDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex') }))
  return { ...f, old, receiptPath, knownCommit }
}

async function withLegacyMacGit<T>(f: Awaited<ReturnType<typeof legacyMacFixture>>, run: () => Promise<T>): Promise<T> {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const nativeSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn
  const script = `
    const {spawnSync}=require('node:child_process');
    const [actual,known,command,...args]=process.argv.slice(1);
    const mapped=args.map(value=>value.replaceAll(known,actual));
    const result=spawnSync(command,mapped,{cwd:process.cwd(),env:process.env,encoding:'utf8',maxBuffer:1048576});
    process.stdout.write((result.stdout||'').replaceAll(actual,known));
    process.stderr.write(result.stderr||'');
    process.exit(result.status===null?1:result.status);
  `
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  vi.mocked(spawn).mockImplementation((command, args, options) => nativeSpawn(process.execPath,
    ['-e', script, f.head, f.knownCommit, String(command), ...(args as string[])], options))
  try { return await run() }
  finally {
    vi.mocked(spawn).mockImplementation(nativeSpawn)
    Object.defineProperty(process, 'platform', platform)
  }
}

async function withPlatform<T>(value: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...previous, value })
  try { return await run() }
  finally { Object.defineProperty(process, 'platform', previous) }
}

describe('private RSI source workspace', () => {
  test('archives only the verified unused official 0.1.49 Mac source before preparing a new local identity', async () => {
    const f = await legacyMacFixture()
    const oldReceipt = await readFile(f.receiptPath)
    await mkdir(join(f.home, 'rsi-source-archives', 'owner'), { recursive: true, mode: 0o700 })
    await writeFile(join(f.source, 'package.json'), JSON.stringify({ name: 'dsh-enhanced', version: '0.1.50' }))
    git(f.source, 'add', 'package.json'); git(f.source, 'commit', '-m', 'next version')
    const next = git(f.source, 'rev-parse', 'HEAD')
    await withLegacyMacGit(f, async () => {
      const request = { ...f.args, version: '0.1.50' }
      const prepared = await prepareRsiSourceWorkspace(request)
      expect(prepared.sourceCommit).toBe(next)
      expect(prepared.origin).toEqual({ kind: 'local-head', locator: f.source, ref: 'HEAD' })
      const archiveRoot = join(f.home, 'rsi-source-archives', 'owner')
      const archives = await readdir(archiveRoot)
      expect(archives).toHaveLength(1)
      const archived = join(archiveRoot, archives[0]!)
      expect(await readFile(join(archived, 'bootstrap.json'))).toEqual(oldReceipt)
      expect(await readFile(join(archived, 'checkout', 'README.md'), 'utf8')).toBe('initial\n')
      expect(git(join(archived, 'release.git'), 'rev-parse', 'refs/heads/repairs')).toBe(f.head)
      expect(await prepareRsiSourceWorkspace(request)).toEqual(prepared)
      expect(await readdir(archiveRoot)).toEqual(archives)
    })
  })

  test.each(['advanced', 'unknown-ref', 'unknown-file', 'dirty', 'authority', 'build-stage',
    'source-stage', 'observer'] as const)('%s blocks legacy Mac archiving', async obstruction => {
      const f = await legacyMacFixture()
      await withLegacyMacGit(f, async () => {
        if (obstruction === 'advanced') {
          await writeFile(join(f.old.repository, 'README.md'), 'changed\n')
          git(f.old.repository, 'add', 'README.md'); git(f.old.repository, 'commit', '-m', 'repair')
          git(f.old.repository, 'update-ref', 'refs/dsh-source/repairs', git(f.old.repository, 'rev-parse', 'HEAD'))
        } else if (obstruction === 'unknown-ref') {
          git(f.old.repository, 'update-ref', 'refs/dsh-source/candidate', f.head)
        } else if (obstruction === 'unknown-file') {
          await writeFile(join(f.home, 'rsi-sources', 'owner', 'candidate.json'), '{}')
        } else if (obstruction === 'dirty') {
          await writeFile(join(f.old.repository, 'README.md'), 'dirty\n')
        } else if (obstruction === 'authority') {
          await mkdir(join(f.home, 'rsi-authorities', 'owner'), { recursive: true })
        } else if (obstruction === 'build-stage') {
          await mkdir(join(f.home, 'rsi-builds', '.owner-stage-abandoned'), { recursive: true })
        } else if (obstruction === 'source-stage') {
          await mkdir(join(f.home, 'rsi-sources', '.owner-stage-abandoned'), { mode: 0o700 })
        } else {
          await mkdir(join(f.home, `.rsi-${createHash('sha256').update('owner').digest('hex').slice(0, 12)}`), { mode: 0o700 })
        }
        const original = await readFile(f.receiptPath)
        await expect(prepareRsiSourceWorkspace({ ...f.args, version: '0.1.50' })).rejects.toThrow()
        expect(await readFile(f.receiptPath)).toEqual(original)
        await expect(lstat(join(f.home, 'rsi-source-archives'))).rejects.toMatchObject({ code: 'ENOENT' })
      })
  })

  test('Linux does not archive, and a failed Mac replacement retains one archive for retry', async () => {
    const f = await legacyMacFixture()
    await withPlatform('linux', async () => {
      await expect(prepareRsiSourceWorkspace({ ...f.args, version: '0.1.50' })).rejects.toThrow()
    })
    await expect(lstat(join(f.home, 'rsi-source-archives'))).rejects.toMatchObject({ code: 'ENOENT' })
    await withLegacyMacGit(f, async () => {
      const request = { ...f.args, version: '0.1.50' }
      await expect(prepareRsiSourceWorkspace(request)).rejects.toThrow('untouched legacy source is retained at')
      const archiveRoot = join(f.home, 'rsi-source-archives', 'owner')
      const archives = await readdir(archiveRoot)
      expect(archives).toHaveLength(1)
      expect(await readFile(join(archiveRoot, archives[0]!, 'bootstrap.json'))).toBeTruthy()
      await expect(lstat(join(f.home, 'rsi-sources', 'owner'))).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(join(f.source, 'package.json'), JSON.stringify({ name: 'dsh-enhanced', version: '0.1.50' }))
      git(f.source, 'add', 'package.json'); git(f.source, 'commit', '-m', 'next version')
      const prepared = await prepareRsiSourceWorkspace(request)
      expect(prepared.version).toBe('0.1.50')
      expect(await readdir(archiveRoot)).toEqual(archives)
    })
  })

  test('Mac replay with an omitted repository preserves an existing local-head source', async () => {
    const f = await fixture()
    const prepared = await prepareRsiSourceWorkspace(f.args)
    await withPlatform('darwin', async () => {
      expect(await prepareRsiSourceWorkspace({ dshHome: f.home, profile: 'owner', version: f.args.version })).toEqual(prepared)
    })
    await expect(lstat(join(f.home, 'rsi-source-archives'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('an existing archive blocks another legacy migration without moving the source', async () => {
    const f = await legacyMacFixture()
    const archive = join(f.home, 'rsi-source-archives', 'owner', 'prior')
    await mkdir(archive, { recursive: true, mode: 0o700 })
    await withLegacyMacGit(f, async () => {
      await expect(prepareRsiSourceWorkspace({ ...f.args, version: '0.1.50' })).rejects.toThrow('existing archive')
      expect(await readFile(f.receiptPath)).toBeTruthy()
      expect(await readdir(join(f.home, 'rsi-source-archives', 'owner'))).toEqual(['prior'])
    })
  })
  test('imports only committed HEAD and publishes a private checkout, bare branch and managed ref', async () => {
    const f = await fixture()
    await writeFile(join(f.source, 'README.md'), 'dirty source retained\n')
    const prepared = await prepareRsiSourceWorkspace(f.args)
    expect(prepared).toEqual({ schemaVersion: 1, version: f.args.version,
      origin: { kind: 'local-head', locator: f.source, ref: 'HEAD' }, sourceCommit: f.head,
      repository: join(f.home, 'rsi-sources', 'owner', 'checkout'),
      baseline: { ref: 'refs/dsh-source/repairs', remote: join(f.home, 'rsi-sources', 'owner', 'release.git'), targetBranch: 'repairs', initialCommit: f.head } })
    expect(git(prepared.repository, 'rev-parse', 'HEAD')).toBe(f.head)
    expect(git(prepared.repository, 'rev-parse', prepared.baseline.ref)).toBe(f.head)
    expect(git(prepared.baseline.remote, 'rev-parse', 'refs/heads/repairs')).toBe(f.head)
    expect(await readFile(join(prepared.repository, 'README.md'), 'utf8')).toBe('initial\n')
    expect(await readFile(join(f.source, 'README.md'), 'utf8')).toBe('dirty source retained\n')
    expect((await lstat(join(f.home, 'rsi-sources', 'owner', 'bootstrap.json'))).mode & 0o777).toBe(0o600)
  })

  test('replay keeps later release branch and managed ref progress', async () => {
    const f = await fixture(), prepared = await prepareRsiSourceWorkspace(f.args)
    await writeFile(join(f.source, 'README.md'), 'second\n')
    git(f.source, 'add', 'README.md'); git(f.source, 'commit', '-m', 'second')
    const next = git(f.source, 'rev-parse', 'HEAD')
    git(prepared.baseline.remote, 'fetch', f.source, '+HEAD:refs/heads/repairs')
    git(prepared.repository, 'fetch', prepared.baseline.remote, next)
    git(prepared.repository, 'update-ref', prepared.baseline.ref, next, f.head)
    expect(await prepareRsiSourceWorkspace(f.args)).toEqual(prepared)
    expect(git(prepared.baseline.remote, 'rev-parse', 'refs/heads/repairs')).toBe(next)
    expect(git(prepared.repository, 'rev-parse', prepared.baseline.ref)).toBe(next)
    expect(git(prepared.repository, 'rev-parse', 'HEAD')).toBe(f.head)
  })

  test('rejects wrong installed version and leaves no published workspace', async () => {
    const f = await fixture()
    await expect(prepareRsiSourceWorkspace({ ...f.args, version: '0.1.49' })).rejects.toThrow('source package name/version')
    await expect(lstat(join(f.home, 'rsi-sources', 'owner'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(join(f.home, 'rsi-sources'))).resolves.toEqual([])
  })

  test('rejects missing, noncanonical or symlink source and destination', async () => {
    const f = await fixture()
    await expect(prepareRsiSourceWorkspace({ ...f.args, sourceRepository: join(f.root, 'missing') })).rejects.toThrow()
    await symlink(f.source, join(f.root, 'source-link'))
    await expect(prepareRsiSourceWorkspace({ ...f.args, sourceRepository: join(f.root, 'source-link') })).rejects.toThrow()
    await mkdir(join(f.home, 'rsi-sources'), { mode: 0o700 })
    await symlink(f.source, join(f.home, 'rsi-sources', 'owner'))
    await expect(prepareRsiSourceWorkspace(f.args)).rejects.toThrow('unsafe private directory')
  })

  test('replay rejects a changed receipt, checkout content, and bare branch ancestry', async () => {
    const f = await fixture(), value = await prepareRsiSourceWorkspace(f.args)
    const receipt = join(f.home, 'rsi-sources', 'owner', 'bootstrap.json')
    const original = await readFile(receipt, 'utf8')
    await writeFile(receipt, original.replace('0.1.48', '0.1.49'))
    await expect(prepareRsiSourceWorkspace(f.args)).rejects.toThrow('receipt provenance')
    await writeFile(receipt, original)
    await writeFile(join(value.repository, 'README.md'), 'changed\n')
    await expect(prepareRsiSourceWorkspace(f.args)).rejects.toThrow('checkout provenance')
    await writeFile(join(value.repository, 'README.md'), 'initial\n')
    const bareConfig = join(value.baseline.remote, 'config')
    await writeFile(bareConfig, `${await readFile(bareConfig, 'utf8')}\n[core]\n\tsharedRepository = group\n`)
    await expect(prepareRsiSourceWorkspace(f.args)).rejects.toThrow('static Git files changed')
    await writeFile(bareConfig, (await readFile(bareConfig, 'utf8')).replace('\n[core]\n\tsharedRepository = group\n', ''))
    git(value.baseline.remote, 'update-ref', '-d', 'refs/heads/repairs')
    await expect(prepareRsiSourceWorkspace(f.args)).rejects.toThrow('managed release ref')
  })

  test('aborted preparation does not publish, and a failed run can be retried', async () => {
    const f = await fixture(), controller = new AbortController()
    controller.abort()
    await expect(prepareRsiSourceWorkspace({ ...f.args, signal: controller.signal })).rejects.toThrow()
    await expect(lstat(join(f.home, 'rsi-sources', 'owner'))).rejects.toMatchObject({ code: 'ENOENT' })
    const value = await prepareRsiSourceWorkspace(f.args)
    expect(value.sourceCommit).toBe(f.head)
  })

  test('accepts a canonical read-only-public home but keeps the source tree private', async () => {
    const f = await fixture()
    await chmod(f.home, 0o755)
    const value = await prepareRsiSourceWorkspace(f.args)
    expect((await lstat(value.repository)).mode & 0o777).toBe(0o700)
    await chmod(f.home, 0o777)
    await expect(prepareRsiSourceWorkspace(f.args)).rejects.toThrow('unsafe DSH_HOME')
  })

  test('cancels a running Git subprocess before returning and leaves no published workspace', async () => {
    const f = await fixture()
    const nativeSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn
    const controller = new AbortController()
    vi.mocked(spawn).mockImplementationOnce((_file, _args, options) => nativeSpawn('/bin/sh', ['-c', 'sleep 30 & wait'], options))
    const pending = prepareRsiSourceWorkspace({ ...f.args, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toThrow('Git command failed')
    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe('/usr/bin/git')
    await expect(lstat(join(f.home, 'rsi-sources', 'owner'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('passes only standard proxy and CA routing while excluding caller Git config and askpass', async () => {
    const f = await fixture(), marker = join(f.root, 'environment-result')
    const nativeSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn
    const allowed = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy',
      'NO_PROXY', 'no_proxy', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE'] as const
    const values = Object.fromEntries(allowed.map((key, index) => [key, `test-route-${index}`]))
    const script = `#!${process.execPath}\nconst fs=require('node:fs')\nconst expected=${JSON.stringify(values)}\n` +
      `const allowed=Object.entries(expected).every(([key,value])=>process.env[key]===value)\n` +
      `const isolated=process.env.GIT_CONFIG_COUNT==='0'&&process.env.GIT_CONFIG_GLOBAL==='/dev/null'` +
      `&&process.env.GIT_ASKPASS==='/bin/false'&&process.env.PATH==='/usr/bin:/bin'&&process.env.GIT_CONFIG_KEY_0===undefined` +
      `&&process.env.GIT_CONFIG_VALUE_0===undefined&&process.env.GIT_SSL_NO_VERIFY===undefined\n` +
      `fs.writeFileSync(${JSON.stringify(marker)},allowed&&isolated?'pass':'fail')\nprocess.exit(13)\n`
    for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value)
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.hooksPath')
    vi.stubEnv('GIT_CONFIG_VALUE_0', '/tmp/untrusted-hooks')
    vi.stubEnv('GIT_ASKPASS', '/tmp/untrusted-askpass')
    vi.stubEnv('GIT_SSL_NO_VERIFY', 'true')
    vi.mocked(spawn).mockImplementationOnce((_file, _args, options) => nativeSpawn(process.execPath, ['-e', script], options))
    await expect(prepareRsiSourceWorkspace(f.args)).rejects.toThrow('Git command failed')
    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe('/usr/bin/git')
    expect(await readFile(marker, 'utf8')).toBe('pass')
  })

  test('ignores a caller PATH executable during a real source checkout', async () => {
    const f = await fixture(), bin = join(f.root, 'bin'), marker = join(f.root, 'path-git-ran')
    await mkdir(bin)
    await writeFile(join(bin, 'git'), `#!/bin/sh\necho ran > ${marker}\nexit 13\n`, { mode: 0o700 })
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`)
    const value = await prepareRsiSourceWorkspace(f.args)
    expect(value.sourceCommit).toBe(f.head)
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
