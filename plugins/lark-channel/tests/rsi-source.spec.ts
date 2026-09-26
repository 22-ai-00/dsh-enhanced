import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { prepareRsiSourceWorkspace } from '../src/rsi-source.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

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

describe('private RSI source workspace', () => {
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
    const f = await fixture(), bin = join(f.root, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'git'), '#!/bin/sh\nsleep 30 &\nwait\n', { mode: 0o700 })
    const originalPath = process.env.PATH
    const controller = new AbortController()
    try {
      process.env.PATH = `${bin}:${originalPath ?? ''}`
      const pending = prepareRsiSourceWorkspace({ ...f.args, signal: controller.signal })
      setTimeout(() => controller.abort(), 100)
      await expect(pending).rejects.toThrow('Git command failed')
      await expect(lstat(join(f.home, 'rsi-sources', 'owner'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { process.env.PATH = originalPath }
  })

  test('passes only standard proxy and CA routing while excluding caller Git config and askpass', async () => {
    const f = await fixture(), bin = join(f.root, 'bin'), marker = join(f.root, 'environment-result')
    await mkdir(bin)
    const allowed = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy',
      'NO_PROXY', 'no_proxy', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE'] as const
    const values = Object.fromEntries(allowed.map((key, index) => [key, `test-route-${index}`]))
    const script = `#!${process.execPath}\nconst fs=require('node:fs')\nconst expected=${JSON.stringify(values)}\n` +
      `const allowed=Object.entries(expected).every(([key,value])=>process.env[key]===value)\n` +
      `const isolated=process.env.GIT_CONFIG_COUNT==='0'&&process.env.GIT_CONFIG_GLOBAL==='/dev/null'` +
      `&&process.env.GIT_ASKPASS==='/bin/false'&&process.env.GIT_CONFIG_KEY_0===undefined` +
      `&&process.env.GIT_CONFIG_VALUE_0===undefined&&process.env.GIT_SSL_NO_VERIFY===undefined\n` +
      `fs.writeFileSync(${JSON.stringify(marker)},allowed&&isolated?'pass':'fail')\nprocess.exit(13)\n`
    await writeFile(join(bin, 'git'), script, { mode: 0o700 })
    const keys = [...allowed, 'PATH', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_ASKPASS', 'GIT_SSL_NO_VERIFY']
    const before = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    try {
      Object.assign(process.env, values, { PATH: `${bin}:${process.env.PATH ?? ''}`, GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/tmp/untrusted-hooks',
        GIT_ASKPASS: '/tmp/untrusted-askpass', GIT_SSL_NO_VERIFY: 'true' })
      await expect(prepareRsiSourceWorkspace(f.args)).rejects.toThrow('Git command failed')
      expect(await readFile(marker, 'utf8')).toBe('pass')
    } finally {
      for (const key of keys) {
        const value = before[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
