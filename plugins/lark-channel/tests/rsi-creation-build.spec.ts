import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import { prepareRsiBuildEnvironment } from '../src/rsi-build.js'
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

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rsi-creation-build-'))); roots.push(root)
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
  await writeFile(state, 'ready')
  const executable = `#!${process.execPath}\nconst fs=require('node:fs')\nconst path=require('node:path')\nconst args=process.argv.slice(2)\n` +
    `const state=fs.readFileSync(${JSON.stringify(state)},'utf8').trim()\n` +
    `const safe=process.env.DOCKER_CONFIG&&fs.statSync(process.env.DOCKER_CONFIG).isDirectory()&&!process.env.DOCKER_HOST&&!process.env.DOCKER_CONTEXT\n` +
    `fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,safe})+'\\n')\nif(!safe)process.exit(91)\n` +
    `if(args[0]==='version'){console.log('29.4.1/linux/amd64');process.exit(0)}\n` +
    `if(args[0]==='build'){const behavior=args.some(a=>a.endsWith('/plugin-verifier.Dockerfile'));` +
    `if(behavior){const context=args.at(-1);if(fs.existsSync(path.join(context,'plugins/assistant-verifier/src'))` +
    `||!fs.existsSync(path.join(context,'worker.mjs'))||!fs.existsSync(path.join(context,'candidate.mjs')))process.exit(77)}` +
    `if(state==='build-wait'&&behavior)setTimeout(()=>process.exit(0),30000);` +
    `else process.exit(state==='build-fail'&&behavior?4:0)}\n` +
    `if(args[0]==='image'&&args[1]==='tag')process.exit(0)\n` +
    `if(args[0]==='image'&&args[1]==='rm')process.exit(0)\n` +
    `if(args[0]==='image'&&args[1]==='inspect'){const target=args.at(-1);` +
    `if(state==='missing-behavior'&&target===${JSON.stringify(behaviorImage)})process.exit(5);` +
    `console.log(target===${JSON.stringify(behaviorImage)}||target.startsWith('dsh-plugin-verifier:')?${JSON.stringify(behaviorImage)}:${JSON.stringify(sourceImage)});process.exit(0)}\nprocess.exit(90)\n`
  await writeFile(docker, executable, { mode: 0o700 }); await chmod(docker, 0o700)
  const build = await prepareRsiBuildEnvironment({ dshHome: home, profile: 'owner', source, dockerPath: docker })
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

describe.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('private RSI plugin behavior image preparation', () => {
  test('materializes only a newly verified candidate image into a stopped logical Home receipt', async () => {
    const f = await fixture()
    await prepareRsiCreationBuildEnvironment(f.args)
    const stagePhysicalHome = join(f.root, 'stage'), logicalHome = join(f.root, 'logical')
    await cp(f.home, stagePhysicalHome, { recursive: true })
    const candidatePath = join(f.home, 'rsi-creation-builds', 'owner', 'bootstrap.json')
    const stagePath = join(stagePhysicalHome, 'rsi-creation-builds', 'owner', 'bootstrap.json')
    const candidateBefore = await readFile(candidatePath)
    const stageInput = { logicalHome, stagePhysicalHome, profile: 'owner',
      stagedSource: { ...f.source, repository: join(logicalHome, 'rsi-sources', 'owner', 'checkout') },
      stagedBuild: f.args.build }
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
    const candidatePath = join(f.home, 'rsi-creation-builds', 'owner', 'bootstrap.json')
    const stagePath = join(stagePhysicalHome, 'rsi-creation-builds', 'owner', 'bootstrap.json')
    const before = await readFile(stagePath)
    const input = { candidateHome: f.home, stagePhysicalHome, logicalHome, profile: 'owner',
      candidateSource: f.source, candidateBuild: f.args.build,
      stagedSource: { ...f.source, repository: join(logicalHome, 'rsi-sources', 'owner', 'checkout') },
      stagedBuild: f.args.build }
    await expect(materializeRsiCreationBuildInStage({ ...input,
      stagedSource: { ...input.stagedSource, sourceCommit: '0'.repeat(40) } })).rejects.toThrow('binding differs')
    await writeFile(join(stagePhysicalHome, 'rsi-sources', 'owner', 'checkout', 'pnpm-lock.yaml'), 'changed')
    await expect(materializeRsiCreationBuildInStage(input)).rejects.toThrow('staged source inputs differ')
    expect(await readFile(stagePath)).toEqual(before)
    await writeFile(f.state, 'missing-behavior')
    await cp(f.home, stagePhysicalHome, { recursive: true, force: true })
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
