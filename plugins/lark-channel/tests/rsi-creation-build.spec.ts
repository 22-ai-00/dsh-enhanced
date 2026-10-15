import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:net'
import { parse } from 'yaml'
import { prepareRsiBuildEnvironment, type RsiBuildEnvironment } from '../src/rsi-build.js'
import { materializeRsiCreationBuildInStage, prepareRsiCreationBuildEnvironment, readRsiCreationBuildInStage,
  readRsiCreationBuildEnvironment } from '../src/rsi-creation-build.js'
import type { RsiSourceWorkspace } from '../src/rsi-source.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const sourceImage = `sha256:${'a'.repeat(64)}`
const behaviorImage = `sha256:${'b'.repeat(64)}`

test('behavior verifier recipe pins the exact workspace and lockfile native versions', async () => {
  const workspace = parse(await readFile(join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8')) as {
    catalog: Record<string, string>
  }
  const lock = parse(await readFile(join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8')) as {
    catalogs: { default: Record<string, { specifier: string; version: string }> }
  }
  const recipe = await readFile(join(repositoryRoot, 'scripts/isolation/plugin-verifier.Dockerfile'), 'utf8')
  for (const [name, version] of [
    ['@deepseek-ai/cordis', '4.0.4'],
    ['@deepseek-ai/dsh-tools', '0.2.0-rc.2'],
    ['@deepseek-ai/dsh-system-prompt', '0.2.0-rc.2'],
  ] as const) {
    expect(workspace.catalog[name]).toBe(version)
    expect(lock.catalogs.default[name]).toEqual({ specifier: version, version })
    expect(recipe).toContain(`test "$(node -p 'require("./node_modules/${name}/package.json").version')" = ${version}`)
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
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

async function fixture(architecture: 'x64' | 'arm64' = 'x64', rootParent = tmpdir()) {
  const root = await realpath(await mkdtemp(join(rootParent, 'rsi-creation-build-'))); roots.push(root)
  const home = join(root, 'home'), repository = join(home, 'rsi-sources', 'owner', 'checkout')
  const bare = join(home, 'rsi-sources', 'owner', 'release.git')
  await mkdir(repository, { recursive: true, mode: 0o700 }); await mkdir(bare, { mode: 0o700 })
  git(repository, 'init', '--object-format=sha1', '--initial-branch=repairs', '.')
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'dsh-enhanced', version: '0.1.48', packageManager: 'pnpm@11.7.0', type: 'module' }),
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n', 'pnpm-workspace.yaml': 'packages:\n  - plugins/*\n',
    'plugins/fixture/package.json': JSON.stringify({ name: '@dsh-enhanced/fixture', version: '0.1.48' }),
    'plugins/assistant-verifier/package.json': JSON.stringify({ name: '@dsh-enhanced/assistant-verifier', version: '0.1.48' }),
    'packages/helper/package.json': JSON.stringify({ name: '@dsh-enhanced/helper', version: '0.1.48' }),
  }
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(repository, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes)
  }
  const pinned = [
    'scripts/isolation/build-source-image.mjs', 'scripts/isolation/source-builder.Dockerfile',
    'scripts/isolation/source-builder-seccomp.json', 'scripts/isolation/build-plugin-verifier-image.mjs',
    'scripts/isolation/plugin-verifier.Dockerfile', 'scripts/isolation/plugin-observer-launcher.c',
    'plugins/assistant-verifier/src/plugin-behavior-runner.ts',
  ]
  for (const name of pinned) {
    const path = join(repository, name); await mkdir(dirname(path), { recursive: true }); await copyFile(join(repositoryRoot, name), path)
  }
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'pinned source')
  const sourceCommit = git(repository, 'rev-parse', 'HEAD')
  const source: RsiSourceWorkspace = { schemaVersion: 1, version: '0.1.48', sourceCommit,
    origin: { kind: 'local-head', locator: repository, ref: 'HEAD' }, repository,
    baseline: { ref: 'refs/dsh-source/repairs', remote: bare, targetBranch: 'repairs', initialCommit: sourceCommit } }
  const docker = join(root, 'docker'), calls = join(root, 'docker-calls'), state = join(root, 'docker-state')
  const dockerArch = join(root, 'docker-arch')
  await writeFile(state, 'ready')
  await writeFile(dockerArch, 'amd64')
  const executable = `#!${process.execPath}\nconst fs=require('node:fs')\nconst path=require('node:path')\nconst raw=process.argv.slice(2)\nconst args=raw[0]==='--config'?raw.slice(4):raw\n` +
    `const state=fs.readFileSync(${JSON.stringify(state)},'utf8').trim()\n` +
    `const arch=fs.readFileSync(${JSON.stringify(dockerArch)},'utf8').trim()\n` +
    `const otherArch=arch==='arm64'?'amd64':'arm64'\n` +
    `const safe=process.env.DOCKER_CONFIG&&fs.statSync(process.env.DOCKER_CONFIG).isDirectory()&&!process.env.DOCKER_HOST&&!process.env.DOCKER_CONTEXT\n` +
    `fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,raw,safe})+'\\n')\nif(!safe)process.exit(91)\n` +
    `if(args[0]==='version'){console.log('29.4.1/linux/'+arch);process.exit(0)}\n` +
    `if(args[0]==='info'){console.log(state==='wrong-daemon'?'BAD-DAEMON-0000':'TEST-DAEMON-0000');process.exit(0)}\n` +
    `if(args[0]==='build'){const behavior=args.some(a=>a.endsWith('/plugin-verifier.Dockerfile'));` +
    `if(behavior){const context=args.at(-1);if(fs.existsSync(path.join(context,'plugins/assistant-verifier/src'))` +
    `||!fs.existsSync(path.join(context,'worker.mjs'))||!fs.existsSync(path.join(context,'candidate.mjs')))process.exit(77)}` +
    `if(state==='build-wait'&&behavior)setTimeout(()=>process.exit(0),30000);` +
    `else process.exit(state==='build-fail'&&behavior?4:0)}\n` +
    `if(args[0]==='image'&&args[1]==='tag')process.exit(0)\n` +
    `if(args[0]==='image'&&args[1]==='rm')process.exit(0)\n` +
    `if(args[0]==='image'&&args[1]==='inspect'){const target=args.at(-1);` +
    `if(state==='missing-behavior'&&target===${JSON.stringify(behaviorImage)})process.exit(5);` +
    `console.log((target===${JSON.stringify(behaviorImage)}||target.startsWith('dsh-plugin-verifier:')?${JSON.stringify(behaviorImage)}:${JSON.stringify(sourceImage)})+'/linux/'+(state==='bad-platform'?otherArch:arch));process.exit(0)}\nprocess.exit(90)\n`
  await writeFile(docker, executable, { mode: 0o700 }); await chmod(docker, 0o700)
  // Seed the trusted Linux source image before the portable Mac test switches
  // to its native architecture. Linux-only tests continue to use this path.
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const originalArch = Object.getOwnPropertyDescriptor(process, 'arch')!
  const originalExecPath = Object.getOwnPropertyDescriptor(process, 'execPath')!
  const node = await architectureNode(root, 'x64', 'linux')
  let build: RsiBuildEnvironment
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    Object.defineProperty(process, 'execPath', { value: node, configurable: true })
    build = await prepareRsiBuildEnvironment({ dshHome: home, profile: 'owner', source, dockerPath: docker })
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform)
    Object.defineProperty(process, 'arch', originalArch)
    Object.defineProperty(process, 'execPath', originalExecPath)
  }
  await writeFile(dockerArch, architecture === 'arm64' ? 'arm64' : 'amd64')
  const args = { dshHome: home, profile: 'owner', source, build }
  return { root, home, repository, source, docker, calls, state, args }
}

async function calls(path: string): Promise<{ args: string[]; safe: boolean }[]> {
  return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[]; safe: boolean })
}
function behaviorBuilds(items: { args: string[] }[]): number {
  return items.filter(item => item.args[0] === 'build' && item.args.includes('--file')
    && item.args.some(arg => arg.endsWith('plugin-verifier.Dockerfile'))).length
}

test.each(['x64', 'arm64'] as const)('portable behavior image binds the same macOS %s socket, daemon and Linux image platform', async architecture => {
  // Keep the real Unix socket below macOS's path bound even with a long TMPDIR.
  const f = await fixture(architecture, await realpath('/tmp'))
  await rm(join(f.home, 'rsi-builds'), { recursive: true, force: true })
  const previousHome = process.env.HOME
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
  const execPath = Object.getOwnPropertyDescriptor(process, 'execPath')!
  const node = await architectureNode(f.root, architecture, 'darwin')
  const imageArch = architecture === 'arm64' ? 'arm64' : 'amd64'
  const socket = join(f.root, '.docker', 'run', 'docker.sock')
  expect(Buffer.byteLength(socket)).toBeLessThan(104)
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 })
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  try {
    process.env.HOME = f.root
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    Object.defineProperty(process, 'arch', { value: architecture, configurable: true })
    Object.defineProperty(process, 'execPath', { value: node, configurable: true })
    const build = await prepareRsiBuildEnvironment({ dshHome: f.home, profile: 'owner', source: f.source,
      dockerPath: f.docker, socketPath: socket })
    const input = { ...f.args, build }
    const prepared = await prepareRsiCreationBuildEnvironment(input)
    expect(prepared).toEqual({ schemaVersion: 1, sourceCommit: f.source.sourceCommit,
      sourceImage, image: behaviorImage, dockerPath: f.docker, socketPath: socket })
    expect(await readRsiCreationBuildEnvironment(input)).toEqual(prepared)
    const observed = await calls(f.calls) as { args: string[]; raw: string[]; safe: boolean }[]
    expect(observed.filter(item => item.raw[0] === '--config').every(item => item.raw[2] === '-H'
      && item.raw[3] === `unix://${socket}` && item.safe)).toBe(true)
    expect(observed.some(item => item.args[0] === 'build' && item.args.includes(`linux/${imageArch}`))).toBe(true)
    expect(await prepareRsiCreationBuildEnvironment(input)).toEqual(prepared)
    const stagePhysicalHome = join(f.root, 'portable-stage'), logicalHome = join(f.root, 'portable-logical')
    await cp(f.home, stagePhysicalHome, { recursive: true })
    const stagedBuild = await rebaseStageBuild({ ...f, args: input }, stagePhysicalHome, logicalHome)
    const stagedSource = { ...f.source, repository: join(logicalHome, 'rsi-sources', 'owner', 'checkout') }
    const relocated = await materializeRsiCreationBuildInStage({ candidateHome: f.home, stagePhysicalHome,
      logicalHome, profile: 'owner', candidateSource: f.source, candidateBuild: build,
      stagedSource, stagedBuild })
    expect(relocated.creationBuild.socketPath).toBe(socket)
    expect(await readRsiCreationBuildInStage({ logicalHome, stagePhysicalHome, profile: 'owner',
      stagedSource, stagedBuild })).toEqual(prepared)
    await writeFile(f.state, 'wrong-daemon')
    await expect(prepareRsiCreationBuildEnvironment(input)).rejects.toThrow('receipt differs')
    await writeFile(f.state, 'bad-platform')
    await expect(prepareRsiCreationBuildEnvironment(input)).rejects.toThrow('platform differs')
  } finally {
    Object.defineProperty(process, 'platform', platform)
    Object.defineProperty(process, 'arch', arch)
    Object.defineProperty(process, 'execPath', execPath)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

async function rebaseStageBuild(f: Awaited<ReturnType<typeof fixture>>, stagePhysicalHome: string,
  logicalHome: string): Promise<RsiBuildEnvironment> {
  const buildPath = join(stagePhysicalHome, 'rsi-builds', 'owner', 'bootstrap.json')
  const receipt = JSON.parse(await readFile(buildPath, 'utf8')) as Record<string, unknown>
  const sourceBuild = { ...f.args.build.sourceBuild, repositorySandbox: {
    ...f.args.build.sourceBuild.repositorySandbox,
    seccompPath: join(logicalHome, 'rsi-builds', 'owner', 'seccomp.json') } }
  const { receiptDigest: _previousDigest, ...body } = receipt
  const relocated = { ...body, dshHome: logicalHome,
    repository: join(logicalHome, 'rsi-sources', 'owner', 'checkout'), sourceBuild }
  await writeFile(buildPath, JSON.stringify({ ...relocated,
    receiptDigest: createHash('sha256').update(JSON.stringify(relocated)).digest('hex') }))
  return { ...f.args.build, sourceBuild }
}

describe.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('private RSI plugin behavior image preparation', () => {
  test('materializes only a newly verified candidate image into a stopped logical Home receipt', async () => {
    const f = await fixture()
    await prepareRsiCreationBuildEnvironment(f.args)
    const stagePhysicalHome = join(f.root, 'stage'), logicalHome = join(f.root, 'logical')
    await cp(f.home, stagePhysicalHome, { recursive: true })
    const stagedBuild = await rebaseStageBuild(f, stagePhysicalHome, logicalHome)
    const candidatePath = join(f.home, 'rsi-creation-builds', 'owner', 'bootstrap.json')
    const stagePath = join(stagePhysicalHome, 'rsi-creation-builds', 'owner', 'bootstrap.json')
    const candidateBefore = await readFile(candidatePath)
    const stageInput = { logicalHome, stagePhysicalHome, profile: 'owner',
      stagedSource: { ...f.source, repository: join(logicalHome, 'rsi-sources', 'owner', 'checkout') },
      stagedBuild }
    const result = await materializeRsiCreationBuildInStage({ ...stageInput,
      candidateHome: f.home, candidateSource: f.source, candidateBuild: f.args.build })
    const stage = JSON.parse(await readFile(stagePath, 'utf8')) as Record<string, unknown>
    expect(stage.dshHome).toBe(logicalHome)
    expect(stage.sourceCommit).toBe(f.source.sourceCommit)
    expect(stage.image).toBe(behaviorImage)
    expect(stage.receiptDigest).toBe(createHash('sha256').update(JSON.stringify(Object.fromEntries(
      Object.entries(stage).filter(([key]) => key !== 'receiptDigest')))).digest('hex'))
    expect(result.candidateReceiptSha256).toBe(createHash('sha256').update(candidateBefore).digest('hex'))
    expect(result.receiptSha256).toBe(createHash('sha256').update(await readFile(stagePath)).digest('hex'))
    expect(await readFile(candidatePath)).toEqual(candidateBefore)
    expect(await readRsiCreationBuildInStage(stageInput)).toEqual(result.creationBuild)
    await writeFile(stagePath, JSON.stringify({ ...stage, image: sourceImage }))
    await expect(readRsiCreationBuildInStage(stageInput)).rejects.toThrow('receipt differs')
  })

  test('creation stage rejects source, image, and receipt drift without changing either Home', async () => {
    const f = await fixture()
    await prepareRsiCreationBuildEnvironment(f.args)
    const stagePhysicalHome = join(f.root, 'stage'), logicalHome = join(f.root, 'logical')
    await cp(f.home, stagePhysicalHome, { recursive: true })
    const stagedBuild = await rebaseStageBuild(f, stagePhysicalHome, logicalHome)
    const candidatePath = join(f.home, 'rsi-creation-builds', 'owner', 'bootstrap.json')
    const stagePath = join(stagePhysicalHome, 'rsi-creation-builds', 'owner', 'bootstrap.json')
    const before = await readFile(stagePath)
    const input = { candidateHome: f.home, stagePhysicalHome, logicalHome, profile: 'owner',
      candidateSource: f.source, candidateBuild: f.args.build,
      stagedSource: { ...f.source, repository: join(logicalHome, 'rsi-sources', 'owner', 'checkout') },
      stagedBuild }
    await expect(materializeRsiCreationBuildInStage({ ...input,
      stagedSource: { ...input.stagedSource, sourceCommit: '0'.repeat(40) } })).rejects.toThrow('binding differs')
    await expect(materializeRsiCreationBuildInStage({ ...input,
      stagedBuild: { ...stagedBuild, sourceBuild: { ...stagedBuild.sourceBuild,
        repositorySandbox: { seccompPath: join(f.root, 'unexpected.json') } } } }))
      .rejects.toThrow('outside the approved seccomp relocation')
    await expect(materializeRsiCreationBuildInStage({ ...input,
      stagedBuild: { ...stagedBuild, sourceBuild: { ...stagedBuild.sourceBuild, image: behaviorImage } } }))
      .rejects.toThrow('outside the approved seccomp relocation')
    const stageSeccompPath = join(stagePhysicalHome, 'rsi-builds', 'owner', 'seccomp.json')
    const seccompBefore = await readFile(stageSeccompPath)
    await writeFile(stageSeccompPath, '{}')
    await expect(materializeRsiCreationBuildInStage(input)).rejects.toThrow('staged build receipt or seccomp differs')
    await writeFile(stageSeccompPath, seccompBefore)
    const buildPath = join(stagePhysicalHome, 'rsi-builds', 'owner', 'bootstrap.json')
    const buildBefore = await readFile(buildPath)
    await writeFile(buildPath, buildBefore.toString('utf8').replace('"profile":"owner"', '"profile":"wrong"'))
    await expect(materializeRsiCreationBuildInStage(input)).rejects.toThrow('staged build receipt or seccomp differs')
    await writeFile(buildPath, buildBefore)
    const candidateBuildPath = join(f.home, 'rsi-builds', 'owner', 'bootstrap.json')
    const candidateBuildBefore = await readFile(candidateBuildPath)
    await writeFile(candidateBuildPath, candidateBuildBefore.toString('utf8').replace('"profile":"owner"', '"profile":"wrong"'))
    await expect(materializeRsiCreationBuildInStage(input)).rejects.toThrow('build receipt differs')
    await writeFile(candidateBuildPath, candidateBuildBefore)
    await writeFile(join(stagePhysicalHome, 'rsi-sources', 'owner', 'checkout', 'pnpm-lock.yaml'), 'changed')
    await expect(materializeRsiCreationBuildInStage(input)).rejects.toThrow('staged source inputs differ')
    expect(await readFile(stagePath)).toEqual(before)
    await writeFile(f.state, 'missing-behavior')
    await cp(f.home, stagePhysicalHome, { recursive: true, force: true })
    await rebaseStageBuild(f, stagePhysicalHome, logicalHome)
    await expect(materializeRsiCreationBuildInStage(input)).rejects.toThrow('subprocess failed')
    expect(await readFile(stagePath)).toEqual(before)
    await writeFile(f.state, 'ready')
    await writeFile(candidatePath, before.toString('utf8').replace(behaviorImage, sourceImage))
    await expect(materializeRsiCreationBuildInStage(input)).rejects.toThrow('receipt differs')
    expect(await readFile(stagePath)).toEqual(before)
  })
  test('builds once from pinned fixed assets, replays the immutable image, and reads without Docker', async () => {
    const f = await fixture()
    const first = await prepareRsiCreationBuildEnvironment(f.args)
    expect(first).toEqual({ schemaVersion: 1, sourceCommit: f.source.sourceCommit,
      sourceImage, image: behaviorImage, dockerPath: f.docker })
    const initial = await calls(f.calls)
    expect(initial.every(call => call.safe)).toBe(true)
    expect(behaviorBuilds(initial)).toBe(1)
    expect((await lstat(join(f.home, 'rsi-creation-builds', 'owner', 'bootstrap.json'))).mode & 0o777).toBe(0o600)
    const before = await readFile(f.calls)
    expect(await readRsiCreationBuildEnvironment(f.args)).toEqual(first)
    expect(await readFile(f.calls)).toEqual(before)
    expect(await prepareRsiCreationBuildEnvironment(f.args)).toEqual(first)
    expect(behaviorBuilds(await calls(f.calls))).toBe(1)
  })

  test('missing image, receipt drift, and incomplete publication fail without another build', async () => {
    const f = await fixture()
    await prepareRsiCreationBuildEnvironment(f.args)
    const receipt = join(f.home, 'rsi-creation-builds', 'owner', 'bootstrap.json')
    await writeFile(f.state, 'missing-behavior')
    await expect(prepareRsiCreationBuildEnvironment(f.args)).rejects.toThrow('subprocess failed')
    await writeFile(f.state, 'ready')
    const bytes = await readFile(receipt, 'utf8')
    await writeFile(receipt, bytes.replace(behaviorImage, sourceImage))
    await expect(readRsiCreationBuildEnvironment(f.args)).rejects.toThrow('receipt differs')
    const parsed = JSON.parse(bytes) as Record<string, unknown>
    const { receiptDigest: _ignored, ...content } = parsed
    content.sourceImage = behaviorImage
    await writeFile(receipt, JSON.stringify({ ...content, receiptDigest: createHash('sha256').update(JSON.stringify(content)).digest('hex') }))
    await expect(readRsiCreationBuildEnvironment(f.args)).rejects.toThrow('receipt differs')
    await writeFile(receipt, bytes)
    const old = JSON.parse(bytes) as Record<string, unknown>
    const oldHashes = old.inputHashes as Record<string, string>
    oldHashes['scripts/isolation/plugin-verifier.Dockerfile'] = '4a73ede3ae1ca943a5e661e72f0f8b80ef2876b4ec530023e4b61f3d17ea121b'
    const { receiptDigest: _oldDigest, ...oldContent } = old
    await writeFile(receipt, JSON.stringify({ ...oldContent,
      receiptDigest: createHash('sha256').update(JSON.stringify(oldContent)).digest('hex') }))
    await expect(readRsiCreationBuildEnvironment(f.args)).rejects.toThrow('receipt differs')
    await writeFile(receipt, bytes)
    await chmod(receipt, 0o644)
    await expect(readRsiCreationBuildEnvironment(f.args)).rejects.toThrow('unsafe file')
    await chmod(receipt, 0o600)
    await unlink(receipt)
    const copy = join(f.root, 'receipt-copy')
    await writeFile(copy, bytes, { mode: 0o600 })
    await symlink(copy, receipt)
    await expect(readRsiCreationBuildEnvironment(f.args)).rejects.toThrow()
    await unlink(receipt)
    await expect(prepareRsiCreationBuildEnvironment(f.args)).rejects.toThrow('incomplete')
    expect(behaviorBuilds(await calls(f.calls))).toBe(1)
  })

  test('asset drift, source bounds, and cancellation reject without publication', async () => {
    const drift = await fixture()
    await writeFile(join(drift.repository, 'scripts/isolation/plugin-verifier.Dockerfile'), 'FROM scratch\n')
    await expect(prepareRsiCreationBuildEnvironment(drift.args)).rejects.toThrow('trusted asset changed')
    await expect(lstat(join(drift.home, 'rsi-creation-builds'))).rejects.toMatchObject({ code: 'ENOENT' })
    const mismatch = await fixture()
    await expect(prepareRsiCreationBuildEnvironment({ ...mismatch.args,
      build: { ...mismatch.args.build, sourceCommit: '0'.repeat(40) } })).rejects.toThrow('invalid source build binding')
    const abort = await fixture(), controller = new AbortController()
    await writeFile(abort.state, 'build-wait')
    const pending = prepareRsiCreationBuildEnvironment({ ...abort.args, signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    await expect(pending).rejects.toThrow()
    await expect(lstat(join(abort.home, 'rsi-creation-builds', 'owner'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(join(abort.home, 'rsi-creation-builds')))).toEqual([])
  })

  test('failed behavior build leaves no receipt and later asset drift prevents replay', async () => {
    const failed = await fixture()
    await writeFile(failed.state, 'build-fail')
    await expect(prepareRsiCreationBuildEnvironment(failed.args)).rejects.toThrow('subprocess failed')
    await expect(lstat(join(failed.home, 'rsi-creation-builds', 'owner'))).rejects.toMatchObject({ code: 'ENOENT' })
    const drift = await fixture()
    await prepareRsiCreationBuildEnvironment(drift.args)
    await writeFile(join(drift.repository, 'scripts/isolation/plugin-observer-launcher.c'), 'changed\n')
    await expect(prepareRsiCreationBuildEnvironment(drift.args)).rejects.toThrow('trusted asset changed')
    expect(behaviorBuilds(await calls(drift.calls))).toBe(1)
  })
})
