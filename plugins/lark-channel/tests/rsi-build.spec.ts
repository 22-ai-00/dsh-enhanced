import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:net'
import { prepareRsiBuildEnvironment, readRsiBuildEnvironment, verifyRsiBuildEnvironmentReady, RsiBuildUnavailableError } from '../src/rsi-build.js'
import type { RsiSourceWorkspace } from '../src/rsi-source.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const isolation = join(repositoryRoot, 'scripts', 'isolation')
const IMAGE = `sha256:${'a'.repeat(64)}`
const pins = { 'build-source-image.mjs': '0f17e5976f7c7e689ca1cd965d7b24a8e2032c216a12c321af90c172e0e8b51b',
  'source-builder.Dockerfile': 'b3b7d88cf3cf648db2082c49189ec0480bf6969be911448293cf202216be6906',
  'source-builder-seccomp.json': 'b1e4b5b709578785bd2aff4a3a344301997571ad0e8ae5747aec176571ddc342' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}

async function fixture(architecture: 'x64' | 'arm64' = 'x64') {
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
  const imageArch = architecture === 'arm64' ? 'arm64' : 'amd64'
  const otherArch = architecture === 'arm64' ? 'amd64' : 'arm64'
  const executable = `#!${process.execPath}\nconst fs=require('node:fs')\nconst raw=process.argv.slice(2)\nconst args=raw[0]==='--config'?raw.slice(4):raw\n` +
    `const state=fs.readFileSync(${JSON.stringify(state)},'utf8').trim()\n` +
    `const safe=process.env.DOCKER_CONFIG&&fs.statSync(process.env.DOCKER_CONFIG).isDirectory()` +
    `&&!process.env.DOCKER_HOST&&!process.env.DOCKER_CONTEXT\n` +
    `fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,raw,safe})+'\\n')\n` +
    `if(!safe)process.exit(91)\n` +
    `if(args[0]==='version'){if(state==='daemon-down')process.exit(6);if(state==='probe-wait')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);console.log((state==='wrong-runtime'?'28.0.0':'29.4.1')+'/linux/${imageArch}');process.exit(0)}\n` +
    `if(args[0]==='info'){console.log(state==='wrong-daemon'?'BAD-DAEMON-0000':'TEST-DAEMON-0000');process.exit(0)}\n` +
    `if(args[0]==='build'){if(state==='build-fail')process.exit(4);` +
    `if(state==='build-wait')setTimeout(()=>process.exit(0),30000);else process.exit(0)}\n` +
    `if(args[0]==='image'&&args[1]==='inspect'){if(state==='missing-image')process.exit(5);` +
    `console.log(state==='bad-inspect'?'invalid':state==='bad-platform'?${JSON.stringify(IMAGE + '/linux/' + otherArch)}:${JSON.stringify(IMAGE + '/linux/' + imageArch)});process.exit(0)}\nprocess.exit(90)\n`
  await writeFile(docker, executable, { mode: 0o700 })
  await chmod(docker, 0o700)
  return { root, home, repository, source, docker, calls, state,
    args: { dshHome: home, profile: 'owner', source, dockerPath: docker } }
}

async function calls(path: string): Promise<{ args: string[]; raw: string[]; safe: boolean }[]> {
  return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[]; raw: string[]; safe: boolean })
}

async function immutableBuildFiles(root: string): Promise<unknown[]> {
  const rows: unknown[] = []
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name), info = await lstat(path, { bigint: true })
    rows.push([name, String(info.dev), String(info.ino), String(info.mode), String(info.mtimeNs), String(info.ctimeNs),
      (await readFile(path)).toString('base64')])
  }
  return rows
}

async function architectureNode(root: string, architecture: 'x64' | 'arm64', platform: 'darwin' | 'linux'): Promise<string> {
  const nativeNode = process.execPath
  const preload = join(root, `${platform}-${architecture}.cjs`), launcher = join(root, `node-${platform}-${architecture}.cjs`)
  await writeFile(preload, `Object.defineProperty(process, 'arch', { value: ${JSON.stringify(architecture)}, configurable: true })\n` +
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)}, configurable: true })\n`)
  await writeFile(launcher, `#!${nativeNode}\nconst { spawnSync } = require('node:child_process')\n` +
    `const result = spawnSync(process.execPath, ['--require', ${JSON.stringify(preload)}, ...process.argv.slice(2)], { stdio: 'inherit' })\n` +
    `process.exit(result.status ?? 1)\n`, { mode: 0o700 })
  await chmod(launcher, 0o700)
  return launcher
}

test.each(['x64', 'arm64'] as const)('macOS %s portable repository build binds local socket, daemon and image platform across replay', async architecture => {
  const f = await fixture(architecture)
  const previousHome = process.env.HOME
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
  const execPath = Object.getOwnPropertyDescriptor(process, 'execPath')!
  const node = await architectureNode(f.root, architecture, 'darwin')
  const imageArch = architecture === 'arm64' ? 'arm64' : 'amd64'
  const otherArch = architecture === 'arm64' ? 'amd64' : 'arm64'
  const socket = join(f.root, '.docker', 'run', 'docker.sock')
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 })
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  try {
    process.env.HOME = f.root
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    Object.defineProperty(process, 'arch', { value: architecture, configurable: true })
    Object.defineProperty(process, 'execPath', { value: node, configurable: true })
    const first = await prepareRsiBuildEnvironment({ ...f.args, socketPath: socket })
    expect(first.sourceBuild).toMatchObject({ profile: 'portable-repository', socketPath: socket,
      daemonId: 'TEST-DAEMON-0000', image: IMAGE, temporaryMiB: 4_096 })
    expect(first.sourceBuild.repositorySandbox).toEqual({ seccompPath: join(f.home, 'rsi-builds', 'owner', 'seccomp.json') })
    expect((await readdir(join(f.home, 'rsi-builds', 'owner'))).sort()).toEqual(['bootstrap.json', 'seccomp.json'])
    expect(await readRsiBuildEnvironment(f.args)).toEqual(first)
    expect(await verifyRsiBuildEnvironmentReady(f.args)).toEqual(first)
    const receiptPath = join(f.home, 'rsi-builds', 'owner', 'bootstrap.json')
    const receiptBytes = await readFile(receiptPath)
    const receipt = JSON.parse(receiptBytes.toString('utf8')) as Record<string, unknown>
    const { receiptDigest: _digest, ...body } = receipt
    const wrongPlatform = { ...body, imagePlatform: `linux/${otherArch}` }
    await writeFile(receiptPath, JSON.stringify({ ...wrongPlatform,
      receiptDigest: createHash('sha256').update(JSON.stringify(wrongPlatform)).digest('hex') }))
    await expect(readRsiBuildEnvironment(f.args)).rejects.toThrow('receipt differs')
    await writeFile(receiptPath, receiptBytes)
    const observed = await calls(f.calls)
    expect(observed.every(item => item.safe && item.raw[0] === '--config' && item.raw[2] === '-H'
      && item.raw[3] === `unix://${socket}`)).toBe(true)
    expect(observed.some(item => item.args[0] === 'build' && item.args.includes('--platform')
      && item.args.includes(`linux/${imageArch}`))).toBe(true)
    expect(await prepareRsiBuildEnvironment({ ...f.args, socketPath: socket })).toEqual(first)
    await writeFile(f.state, 'wrong-daemon')
    await expect(verifyRsiBuildEnvironmentReady(f.args)).rejects.toThrow('daemon differs')
    await expect(prepareRsiBuildEnvironment({ ...f.args, socketPath: socket })).rejects.toThrow('build receipt differs')
    await writeFile(f.state, 'ready')
    await writeFile(f.state, 'bad-platform')
    await expect(verifyRsiBuildEnvironmentReady(f.args)).rejects.toThrow('platform differs')
    await expect(prepareRsiBuildEnvironment({ ...f.args, socketPath: socket })).rejects.toThrow('platform differs')
  } finally {
    Object.defineProperty(process, 'platform', platform)
    Object.defineProperty(process, 'arch', arch)
    Object.defineProperty(process, 'execPath', execPath)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('missing macOS Docker Desktop socket reports build unavailable before creating a receipt', async () => {
  const f = await fixture()
  const previousHome = process.env.HOME
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    process.env.HOME = f.root
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    await expect(prepareRsiBuildEnvironment({ ...f.args,
      socketPath: join(f.root, '.docker', 'run', 'docker.sock') })).rejects.toBeInstanceOf(RsiBuildUnavailableError)
    await expect(lstat(join(f.home, 'rsi-builds'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    Object.defineProperty(process, 'platform', platform)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
})

describe.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('private RSI repository builder', () => {
  test('readiness queries the exact retained image without changing receipts or building resources', async () => {
    const f = await fixture()
    await expect(verifyRsiBuildEnvironmentReady(f.args)).rejects.toThrow()
    await expect(lstat(join(f.home, 'rsi-builds'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(f.calls)).rejects.toMatchObject({ code: 'ENOENT' })
    const prepared = await prepareRsiBuildEnvironment(f.args), start = (await calls(f.calls)).length
    const final = join(f.home, 'rsi-builds', 'owner'), before = await immutableBuildFiles(final)
    expect(await verifyRsiBuildEnvironmentReady(f.args)).toEqual(prepared)
    const observed = (await calls(f.calls)).slice(start)
    expect(observed.every(call => call.safe && ['version', 'info', 'image'].includes(call.args[0]!))).toBe(true)
    expect(observed.filter(call => call.args[0] === 'image').map(call => call.args))
      .toEqual([['image', 'inspect', '--format', '{{.Id}}/{{.Os}}/{{.Architecture}}', IMAGE]])
    expect(await immutableBuildFiles(final)).toEqual(before)
    expect(await readdir(join(f.home, 'rsi-builds'))).toEqual(['owner'])
  })

  test('readiness keeps missing runtime or image separate from integrity drift and never rebuilds', async () => {
    const f = await fixture(); await prepareRsiBuildEnvironment(f.args)
    const final = join(f.home, 'rsi-builds', 'owner'), before = await immutableBuildFiles(final)
    const start = (await calls(f.calls)).length
    for (const state of ['daemon-down', 'wrong-runtime', 'missing-image']) {
      await writeFile(f.state, state)
      await expect(verifyRsiBuildEnvironmentReady(f.args)).rejects.toBeInstanceOf(RsiBuildUnavailableError)
      expect(await immutableBuildFiles(final)).toEqual(before)
    }
    for (const state of ['bad-inspect', 'bad-platform']) {
      await writeFile(f.state, state)
      await expect(verifyRsiBuildEnvironmentReady(f.args)).rejects.not.toBeInstanceOf(RsiBuildUnavailableError)
      expect(await immutableBuildFiles(final)).toEqual(before)
    }
    expect((await calls(f.calls)).slice(start).every(call => ['version', 'info', 'image'].includes(call.args[0]!))).toBe(true)
    expect(await readdir(join(f.home, 'rsi-builds'))).toEqual(['owner'])
  })

  test('readiness refuses changed inputs before probing and preserves receipts when cancelled in a query', async () => {
    const f = await fixture(); await prepareRsiBuildEnvironment(f.args)
    const final = join(f.home, 'rsi-builds', 'owner'), before = await immutableBuildFiles(final)
    const start = await readFile(f.calls)
    const lock = join(f.repository, 'pnpm-lock.yaml')
    await writeFile(lock, 'changed-lock\n')
    await expect(verifyRsiBuildEnvironmentReady(f.args)).rejects.toThrow('receipt differs')
    expect(await readFile(f.calls)).toEqual(start)
    await writeFile(lock, 'lockfileVersion: 9.0\n')
    const preaborted = AbortSignal.abort(new Error('pre-cancelled readiness'))
    await expect(verifyRsiBuildEnvironmentReady({ ...f.args, signal: preaborted })).rejects.toThrow('pre-cancelled readiness')
    expect(await readFile(f.calls)).toEqual(start)
    await writeFile(f.state, 'probe-wait')
    const controller = new AbortController(), pending = verifyRsiBuildEnvironmentReady({ ...f.args, signal: controller.signal })
    const timer = setTimeout(() => controller.abort(new Error('cancelled readiness')), 300)
    try { await expect(pending).rejects.toThrow('cancelled readiness') }
    finally { clearTimeout(timer) }
    const observed = (await calls(f.calls)).slice(start.toString('utf8').trim().split('\n').length)
    expect(observed.map(call => call.args[0])).toEqual(['version'])
    expect(await immutableBuildFiles(final)).toEqual(before)
    expect(await readdir(join(f.home, 'rsi-builds'))).toEqual(['owner'])
  })

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

  test('replays an existing Linux receipt whose trusted builder predates the portable assets', async () => {
    const f = await fixture()
    const prepared = await prepareRsiBuildEnvironment(f.args)
    const receiptPath = join(f.home, 'rsi-builds', 'owner', 'bootstrap.json')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>
    const hashes = receipt.inputHashes as Record<string, string>
    const legacyPins = {
      'build-source-image.mjs': '7b7eb0797e1ca543fb1ffa0463eb78b3ecad14f28fe4bfca25651640aac4669b',
      'source-builder.Dockerfile': 'c936e136517c5bc85603e7187fe74691e32f954f57b5076946dc42fed33c65f5',
    }
    for (const [name, expected] of Object.entries(legacyPins)) {
      const relative = `scripts/isolation/${name}`
      const bytes = await readFile(new URL(`./fixtures/legacy-linux-source-build/${name}`, import.meta.url))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected)
      await writeFile(join(f.repository, relative), bytes)
      hashes[relative] = expected
    }
    const { receiptDigest: _ignored, ...body } = receipt
    await writeFile(receiptPath, JSON.stringify({ ...body,
      receiptDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex') }))
    expect(await readRsiBuildEnvironment(f.args)).toEqual(prepared)
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
