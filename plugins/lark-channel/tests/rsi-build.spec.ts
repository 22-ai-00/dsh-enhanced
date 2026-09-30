import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { prepareRsiBuildEnvironment, readRsiBuildEnvironment, RsiBuildUnavailableError } from '../src/rsi-build.js'
import type { RsiSourceWorkspace } from '../src/rsi-source.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const isolation = join(repositoryRoot, 'scripts', 'isolation')
const IMAGE = `sha256:${'a'.repeat(64)}`
const pins = { 'build-source-image.mjs': '7b7eb0797e1ca543fb1ffa0463eb78b3ecad14f28fe4bfca25651640aac4669b',
  'source-builder.Dockerfile': 'c936e136517c5bc85603e7187fe74691e32f954f57b5076946dc42fed33c65f5',
  'source-builder-seccomp.json': 'b1e4b5b709578785bd2aff4a3a344301997571ad0e8ae5747aec176571ddc342' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rsi-build-'))); roots.push(root)
  const home = join(root, 'home'), repository = join(home, 'rsi-sources', 'owner', 'checkout')
  const bare = join(home, 'rsi-sources', 'owner', 'release.git')
  await mkdir(repository, { recursive: true, mode: 0o700 })
  await mkdir(bare, { mode: 0o700 })
  git(repository, 'init', '--object-format=sha1', '--initial-branch=repairs', '.')
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'dsh-enhanced', version: '0.1.48', packageManager: 'pnpm@11.7.0', type: 'module' }),
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n', 'pnpm-workspace.yaml': 'packages:\n  - plugins/*\n',
    'plugins/fixture/package.json': JSON.stringify({ name: '@dsh-enhanced/fixture', version: '0.1.48' }),
    'packages/helper/package.json': JSON.stringify({ name: '@dsh-enhanced/helper', version: '0.1.48' }),
  }
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(repository, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes)
  }
  for (const [name, expected] of Object.entries(pins)) {
    const original = await readFile(join(isolation, name))
    expect(createHash('sha256').update(original).digest('hex')).toBe(expected)
    const path = join(repository, 'scripts', 'isolation', name)
    await mkdir(dirname(path), { recursive: true }); await copyFile(join(isolation, name), path)
  }
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'pinned source')
  const sourceCommit = git(repository, 'rev-parse', 'HEAD')
  const source: RsiSourceWorkspace = { schemaVersion: 1, version: '0.1.48', sourceCommit,
    origin: { kind: 'local-head', locator: repository, ref: 'HEAD' }, repository,
    baseline: { ref: 'refs/dsh-source/repairs', remote: bare, targetBranch: 'repairs', initialCommit: sourceCommit } }
  const docker = join(root, 'docker'), calls = join(root, 'docker-calls'), state = join(root, 'docker-state')
  await writeFile(state, 'ready')
  const executable = `#!${process.execPath}\nconst fs=require('node:fs')\nconst args=process.argv.slice(2)\n` +
    `const state=fs.readFileSync(${JSON.stringify(state)},'utf8').trim()\n` +
    `const safe=process.env.DOCKER_CONFIG&&fs.statSync(process.env.DOCKER_CONFIG).isDirectory()` +
    `&&!process.env.DOCKER_HOST&&!process.env.DOCKER_CONTEXT\n` +
    `fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,safe})+'\\n')\n` +
    `if(!safe)process.exit(91)\n` +
    `if(args[0]==='version'){console.log(state==='wrong-runtime'?'28.0.0/linux/amd64':'29.4.1/linux/amd64');process.exit(0)}\n` +
    `if(args[0]==='build'){if(state==='build-fail')process.exit(4);` +
    `if(state==='build-wait')setTimeout(()=>process.exit(0),30000);else process.exit(0)}\n` +
    `if(args[0]==='image'&&args[1]==='inspect'){if(state==='missing-image')process.exit(5);` +
    `console.log(state==='bad-inspect'?'invalid':${JSON.stringify(IMAGE)});process.exit(0)}\nprocess.exit(90)\n`
  await writeFile(docker, executable, { mode: 0o700 })
  await chmod(docker, 0o700)
  return { root, home, repository, source, docker, calls, state,
    args: { dshHome: home, profile: 'owner', source, dockerPath: docker } }
}

async function calls(path: string): Promise<{ args: string[]; safe: boolean }[]> {
  return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[]; safe: boolean })
}

describe('private RSI repository builder', () => {
  test('reads pinned inputs without Docker calls and refuses missing or changed resources', async () => {
    const f = await fixture()
    await expect(readRsiBuildEnvironment(f.args)).rejects.toThrow()
    await expect(lstat(join(f.home, 'rsi-builds'))).rejects.toMatchObject({ code: 'ENOENT' })
    const prepared = await prepareRsiBuildEnvironment(f.args)
    const before = await readFile(f.calls)
    expect(await readRsiBuildEnvironment(f.args)).toEqual(prepared)
    expect(await readFile(f.calls)).toEqual(before)
    await writeFile(join(f.home, 'rsi-builds', 'owner', 'seccomp.json'), 'changed')
    await expect(readRsiBuildEnvironment(f.args)).rejects.toThrow('seccomp changed')
    expect(await readFile(f.calls)).toEqual(before)
  })

  test('runs the pinned trusted builder with an empty Docker config and reuses its immutable image', async () => {
    const f = await fixture()
    const first = await prepareRsiBuildEnvironment(f.args)
    expect(first).toEqual({ schemaVersion: 1, sourceCommit: f.source.sourceCommit,
      sourceBuild: { dockerPath: f.docker, image: IMAGE, timeoutMs: 1_800_000, memoryMiB: 16_384,
        cpus: 8, pidsLimit: 1_024, workspaceMiB: 4_096, temporaryMiB: 2_048,
        outputBytes: 65_536, versioning: 'patch', profile: 'repository',
        repositorySandbox: { seccompPath: join(f.home, 'rsi-builds', 'owner', 'seccomp.json') } } })
    const initialCalls = await calls(f.calls)
    expect(initialCalls.every(call => call.safe)).toBe(true)
    expect(initialCalls.some(call => call.args[0] === 'build' && call.args.includes('--pull=false'))).toBe(true)
    expect(initialCalls.some(call => call.args[0] === 'image' && call.args[1] === 'inspect')).toBe(true)
    expect((await lstat(join(f.home, 'rsi-builds', 'owner', 'bootstrap.json'))).mode & 0o777).toBe(0o600)
    expect(await prepareRsiBuildEnvironment(f.args)).toEqual(first)
    expect((await calls(f.calls)).filter(call => call.args[0] === 'build')).toHaveLength(1)
  })

  test('replay rejects changed lock, missing image, and private seccomp drift without rebuilding', async () => {
    const f = await fixture(), first = await prepareRsiBuildEnvironment(f.args)
    await writeFile(f.state, 'missing-image')
    await expect(prepareRsiBuildEnvironment(f.args)).rejects.toThrow('subprocess failed')
    await writeFile(f.state, 'ready')
    await writeFile(join(f.repository, 'pnpm-lock.yaml'), 'changed-lock\n')
    await expect(prepareRsiBuildEnvironment(f.args)).rejects.toThrow('build receipt differs')
    await writeFile(join(f.repository, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    await writeFile(first.sourceBuild.repositorySandbox!.seccompPath, '{}')
    await expect(prepareRsiBuildEnvironment(f.args)).rejects.toThrow('private repository seccomp changed')
    expect((await calls(f.calls)).filter(call => call.args[0] === 'build')).toHaveLength(1)
  })

  test('an incomplete existing publication refuses replay without starting another build', async () => {
    const f = await fixture()
    await prepareRsiBuildEnvironment(f.args)
    await unlink(join(f.home, 'rsi-builds', 'owner', 'bootstrap.json'))
    await expect(prepareRsiBuildEnvironment(f.args)).rejects.toThrow('incomplete or unexpected')
    expect((await calls(f.calls)).filter(call => call.args[0] === 'build')).toHaveLength(1)
  })

  test('an unavailable Docker runtime is a distinct pre-build result', async () => {
    const f = await fixture()
    await writeFile(f.state, 'wrong-runtime')
    await expect(prepareRsiBuildEnvironment(f.args)).rejects.toBeInstanceOf(RsiBuildUnavailableError)
    await expect(lstat(join(f.home, 'rsi-builds', 'owner'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(prepareRsiBuildEnvironment({ ...f.args, dockerPath: join(f.root, 'missing') })).rejects.toBeInstanceOf(RsiBuildUnavailableError)
  })

  test('refuses a changed builder before executing the Docker client', async () => {
    const f = await fixture()
    await writeFile(join(f.repository, 'scripts', 'isolation', 'build-source-image.mjs'), 'process.exit(0)\n')
    await expect(prepareRsiBuildEnvironment(f.args)).rejects.toThrow('trusted builder')
    await expect(lstat(f.calls)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('builder failure and malformed image inspection never publish a receipt', async () => {
    for (const state of ['build-fail', 'bad-inspect']) {
      const f = await fixture()
      await writeFile(f.state, state)
      await expect(prepareRsiBuildEnvironment(f.args)).rejects.toThrow()
      await expect(lstat(join(f.home, 'rsi-builds', 'owner'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readdir(join(f.home, 'rsi-builds'))).resolves.toEqual([])
    }
  })

  test('cancellation during the builder stays a hard failure and leaves no published workspace', async () => {
    const f = await fixture(), controller = new AbortController()
    await writeFile(f.state, 'build-wait')
    const pending = prepareRsiBuildEnvironment({ ...f.args, signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    await expect(pending).rejects.not.toBeInstanceOf(RsiBuildUnavailableError)
    await expect(lstat(join(f.home, 'rsi-builds', 'owner'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
