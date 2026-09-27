import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { configureRsiSetup, parseRsiSetupArgs, runRsiSetup } from '../src/rsi-setup.js'
import { version } from '../src/version.js'
import * as buildSetup from '../src/rsi-build.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('RSI source preparation CLI', () => {
  test('requires a target and separates source preparation from profile transactions', async () => {
    const base = ['--prepare-source', '--profile', 'web', '--dsh-home', '/tmp/home']
    expect(parseRsiSetupArgs(base)).toMatchObject({ prepareSource: true, profile: 'web', manifestPath: '', apply: false })
    for (const flags of [['--apply'], ['--rollback'], ['--start'], ['--confirm-hosts-stopped'], ['--manifest', '/tmp/m.json']]) {
      expect(() => parseRsiSetupArgs([...base, ...flags])).toThrow('cannot be combined')
    }
    expect(() => parseRsiSetupArgs(['--prepare-source'])).toThrow('requires --profile')
    expect(() => parseRsiSetupArgs([...base, '--profile', 'other'])).toThrow('duplicate')
    expect(() => parseRsiSetupArgs(['--prepare-source', '--profile', '../escape'])).toThrow('requires --profile')
    expect(() => parseRsiSetupArgs([...base, '--source-repository', 'relative'])).toThrow('must be absolute')
    expect(() => parseRsiSetupArgs(['--manifest', '/tmp/m.json', '--profile', 'web'])).toThrow('require --prepare-source')
    await expect(configureRsiSetup(parseRsiSetupArgs(base))).rejects.toThrow('separate setup operation')
    const build = ['--prepare-build', '--profile', 'web', '--dsh-home', '/tmp/home']
    expect(parseRsiSetupArgs([...build, '--optional-build', '--docker-path', '/usr/bin/docker'])).toMatchObject({ prepareBuild: true, optionalBuild: true, dockerPath: '/usr/bin/docker' })
    expect(() => parseRsiSetupArgs([...base, '--prepare-build'])).toThrow('cannot be combined')
    expect(() => parseRsiSetupArgs([...base, '--optional-build'])).toThrow('require --prepare-build')
    expect(() => parseRsiSetupArgs([...build, '--docker-path', 'relative'])).toThrow('must be absolute')
    expect(() => parseRsiSetupArgs([...build, '--apply'])).toThrow('cannot be combined')
    const authorities = ['--prepare-authorities', '--profile', 'web', '--dsh-home', '/tmp/home']
    expect(parseRsiSetupArgs(authorities)).toMatchObject({ prepareAuthorities: true, profile: 'web', manifestPath: '' })
    for (const flags of [['--apply'], ['--prepare-source'], ['--prepare-build'], ['--source-repository', '/tmp/source']]) {
      expect(() => parseRsiSetupArgs([...authorities, ...flags])).toThrow()
    }
    await expect(configureRsiSetup(parseRsiSetupArgs(authorities))).rejects.toThrow('separate setup operation')
  })

  test('prepares and replays a real local checkout at the installed version without a manifest or profile writes', async () => {
    const home = await mkdtemp(join(await realpath(tmpdir()), 'rsi-source-cli-')); roots.push(home)
    const source = join(home, 'original')
    await mkdir(source, { mode: 0o700 })
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: source, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim()
    git('init', '--quiet')
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'dsh-enhanced', version }))
    git('add', 'package.json')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial')
    const initial = git('rev-parse', 'HEAD')
    const dirty = JSON.stringify({ name: 'dsh-enhanced', version: '99.0.0' })
    await writeFile(join(source, 'package.json'), dirty)
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const args = ['--prepare-source', '--profile', 'web', '--dsh-home', home, '--source-repository', source]
    await runRsiSetup(args)
    const first = JSON.parse(String(output.mock.calls.at(-1)![0]))
    expect(first).toMatchObject({ schemaVersion: 1, version, sourceCommit: initial,
      repository: join(home, 'rsi-sources', 'web', 'checkout'), baseline: { initialCommit: initial } })
    expect(JSON.parse(await readFile(join(first.repository, 'package.json'), 'utf8')).version).toBe(version)
    expect(await readFile(join(source, 'package.json'), 'utf8')).toBe(dirty)
    await runRsiSetup(args)
    expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual(first)
    await expect(readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('optional build reports unavailable prerequisites but preserves actual build failures', async () => {
    const home = await mkdtemp(join(await realpath(tmpdir()), 'rsi-build-cli-')); roots.push(home)
    const source = join(home, 'original'); await mkdir(source, { mode: 0o700 })
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: source, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    })
    git('init', '--quiet')
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'dsh-enhanced', version }))
    git('add', 'package.json')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial')
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const build = vi.spyOn(buildSetup, 'prepareRsiBuildEnvironment').mockRejectedValue(new buildSetup.RsiBuildUnavailableError('daemon unavailable'))
    const args = ['--prepare-build', '--profile', 'web', '--dsh-home', home, '--source-repository', source]
    await expect(runRsiSetup(args)).rejects.toThrow('daemon unavailable')
    await runRsiSetup([...args, '--optional-build'])
    const result = JSON.parse(String(output.mock.calls.at(-1)![0]))
    expect(result).toMatchObject({ version, buildUnavailable: expect.stringContaining('daemon unavailable'), repository: join(home, 'rsi-sources', 'web', 'checkout') })
    expect(result.sourceBuild).toBeUndefined()
    if (process.platform === 'linux') {
      expect(result.authorityResources.identities.host.publicKeyPem).toContain('PUBLIC KEY')
      expect(result.authorityRuntime.executables.hostAttestor.path).toContain('rsi-authority-runtimes')
    } else expect(result.authorityResourcesUnavailable).toContain('requires Linux')
    expect(build.mock.calls.at(-1)![0]).toMatchObject({ profile: 'web', dshHome: home, source: { version } })
    build.mockRejectedValue(new Error('image build failed'))
    await expect(runRsiSetup([...args, '--optional-build'])).rejects.toThrow('image build failed')
    await expect(readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test.skipIf(process.platform !== 'linux')('prepares authority tools and stable identities without Git, Docker, a manifest or profile changes', async () => {
    const home = await mkdtemp(join(await realpath(tmpdir()), 'rsi-authority-cli-')); roots.push(home)
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const args = ['--prepare-authorities', '--profile', 'web', '--dsh-home', home]
    await runRsiSetup(args)
    const first = JSON.parse(String(output.mock.calls.at(-1)![0]))
    expect(first.authorityRuntime.packageVersion).toBe(version)
    expect(Object.keys(first.authorityRuntime.releaseAdapters)).toHaveLength(8)
    expect(Object.keys(first.authorityResources.identities)).toHaveLength(14)
    await runRsiSetup(args)
    expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual(first)
    await expect(readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(home, 'rsi-sources', 'web', 'bootstrap.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
