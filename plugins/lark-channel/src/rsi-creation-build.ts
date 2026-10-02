import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { rsiBuildResources as io, readRsiBuildEnvironment, type RsiBuildEnvironment } from './rsi-build.js'
import type { RsiSourceWorkspace } from './rsi-source.js'

const COMMIT = /^[a-f0-9]{40}$/u
const IMAGE = /^sha256:[a-f0-9]{64}$/u
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const PACKAGE_MANAGER = 'pnpm@11.7.0'
const FIXED = {
  'scripts/isolation/build-plugin-verifier-image.mjs': 'ae615696e51f88be9ad1e5f1b2a8769b951d8f0632b13547fcfa8f23ab837802',
  'scripts/isolation/plugin-verifier.Dockerfile': '4a73ede3ae1ca943a5e661e72f0f8b80ef2876b4ec530023e4b61f3d17ea121b',
  'scripts/isolation/plugin-observer-launcher.c': '90bb335432a74778d442e2fcab50a19fc4441191343eaa76beed09287515b0ce',
  'plugins/assistant-verifier/src/plugin-behavior-runner.ts': '1a7f5d9a686cc8615e403a9f5536701d759fc40ef9fa5fe7c29cbddb2891c187',
} as const
const WORKER_SHA = '0394f3974410fe00538fbd99e643a86672a7dfad7a1471af7280dce36668eef4'
const CANDIDATE_SHA = '051e76a0e45c50e434be757913f89a2be0ee5cac6941797924fb13b316695109'

export interface RsiCreationBuildEnvironment {
  schemaVersion: 1
  sourceCommit: string
  sourceImage: string
  image: string
  dockerPath: string
}

interface Receipt extends RsiCreationBuildEnvironment {
  dshHome: string
  profile: string
  dockerSha256: string
  inputHashes: Record<string, string>
  contextFiles: string[]
  contextDigest: string
  lockSha256: string
  receiptDigest: string
}

interface Input { dshHome: string; profile: string; source: RsiSourceWorkspace; build: RsiBuildEnvironment; signal?: AbortSignal }
interface Inputs {
  files: Map<string, Buffer>
  hashes: Record<string, string>
  contextFiles: string[]
  contextDigest: string
  lockSha256: string
}

function fail(message: string): never { throw new Error(`rsi creation build: ${message}`) }
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function validPath(value: string): boolean { return isAbsolute(value) && resolve(value) === value && !value.includes('\0') }

async function base(input: Input): Promise<RsiBuildEnvironment> {
  if (!validPath(input.dshHome) || !PROFILE.test(input.profile)
    || input.source.schemaVersion !== 1 || !COMMIT.test(input.source.sourceCommit)
    || input.build.schemaVersion !== 1 || input.build.sourceCommit !== input.source.sourceCommit
    || !IMAGE.test(input.build.sourceBuild?.image ?? '')) fail('invalid source build binding')
  input.signal?.throwIfAborted()
  const recorded = await readRsiBuildEnvironment({ dshHome: input.dshHome, profile: input.profile,
    source: input.source, ...(input.signal ? { signal: input.signal } : {}) })
  if (!isDeepStrictEqual(recorded, input.build)) fail('source build differs from recorded approved environment')
  return recorded
}

async function inputs(source: RsiSourceWorkspace): Promise<Inputs> {
  await io.directory(source.repository)
  const contextFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'scripts/isolation/plugin-verifier.Dockerfile', 'scripts/isolation/plugin-observer-launcher.c']
  for (const folder of ['plugins', 'packages']) {
    await io.directory(join(source.repository, folder), false)
    for (const entry of await readdir(join(source.repository, folder), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const packageDirectory = join(source.repository, folder, entry.name)
      await io.directory(packageDirectory, false)
      const name = `${folder}/${entry.name}/package.json`
      try { await lstat(join(source.repository, name)); contextFiles.push(name) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
  contextFiles.sort()
  if (contextFiles.length > 256) fail('manifest count exceeds bound')
  const files = new Map<string, Buffer>()
  for (const name of [...contextFiles, ...Object.keys(FIXED)]) {
    await io.directory(dirname(join(source.repository, name)), false)
    files.set(name, await io.readStable(join(source.repository, name), 4_194_304))
  }
  for (const [name, expected] of Object.entries(FIXED)) {
    if (digest(files.get(name)!) !== expected) fail(`trusted asset changed: ${name}`)
  }
  const manifest = JSON.parse(files.get('package.json')!.toString('utf8')) as Record<string, unknown>
  if (manifest.name !== 'dsh-enhanced' || manifest.version !== source.version
    || manifest.packageManager !== PACKAGE_MANAGER) fail('root manifest differs from source cohort')
  const raw = files.get('plugins/assistant-verifier/src/plugin-behavior-runner.ts')!.toString('utf8')
  const fixedAsset = (name: 'WORKER' | 'CANDIDATE'): string => {
    const begin = `/* DSH_PLUGIN_VERIFIER_${name}_START\n`
    const end = `\nDSH_PLUGIN_VERIFIER_${name}_END */`
    const first = raw.indexOf(begin), last = raw.indexOf(end, first + begin.length)
    if (first < 0 || last < 0 || raw.indexOf(begin, first + 1) >= 0 || raw.indexOf(end, last + 1) >= 0)
      fail(`fixed ${name.toLowerCase()} markers invalid`)
    const content = raw.slice(first + begin.length, last) + '\n'
    if (Buffer.byteLength(content) > 32_768) fail(`fixed ${name.toLowerCase()} exceeds bound`)
    return content
  }
  const worker = fixedAsset('WORKER'), candidate = fixedAsset('CANDIDATE')
  if (digest(worker) !== WORKER_SHA || digest(candidate) !== CANDIDATE_SHA) fail('fixed worker content changed')
  // The approved builder extracts marker bodies from this file. Keep the
  // snapshot limited to those bodies, without the surrounding app source.
  const extraction = (name: string, body: string) => `/* DSH_PLUGIN_VERIFIER_${name}_START\n${body.trimEnd()}\nDSH_PLUGIN_VERIFIER_${name}_END */\n`
  files.set('plugins/assistant-verifier/src/plugin-behavior-runner.ts',
    Buffer.from(extraction('WORKER', worker) + extraction('CANDIDATE', candidate)))
  const hashes = Object.fromEntries([...files].map(([name, bytes]) => [name, digest(bytes)]))
  const lockSha256 = digest(files.get('pnpm-lock.yaml')!)
  const contextDigest = digest(JSON.stringify({ contextFiles, hashes, lockSha256, workerSha256: WORKER_SHA, candidateSha256: CANDIDATE_SHA }))
  return { files, hashes, contextFiles, contextDigest, lockSha256 }
}

async function snapshot(root: string, files: Map<string, Buffer>): Promise<void> {
  for (const [name, bytes] of files) {
    const path = join(root, name)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await io.writeExclusive(path, bytes)
  }
}

function parseOutput(raw: string, expected: Inputs, sourceImage: string): string {
  if (Buffer.byteLength(raw) > 16_384) fail('builder output exceeds bound')
  const value = JSON.parse(raw) as Record<string, unknown>
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !isDeepStrictEqual(Object.keys(value).sort(), ['image', 'tag', 'sourceImage', 'lockSha256',
      'workerSha256', 'candidateSha256', 'launcherSourceSha256', 'dockerfileSha256', 'contextFiles'].sort())
    || typeof value.image !== 'string' || !IMAGE.test(value.image)
    || value.sourceImage !== sourceImage || value.lockSha256 !== expected.lockSha256
    || value.workerSha256 !== WORKER_SHA || value.candidateSha256 !== CANDIDATE_SHA
    || value.launcherSourceSha256 !== FIXED['scripts/isolation/plugin-observer-launcher.c']
    || value.dockerfileSha256 !== FIXED['scripts/isolation/plugin-verifier.Dockerfile']
    || !isDeepStrictEqual(value.contextFiles, [...expected.contextFiles, 'worker.mjs', 'candidate.mjs'].sort()))
    fail('builder output differs from frozen source inputs')
  return value.image
}

async function imageExists(dockerPath: string, image: string, scratch: string, signal: AbortSignal): Promise<void> {
  const actual = await io.command(dockerPath, ['image', 'inspect', '--format', '{{.Id}}', image],
    io.isolatedEnvironment(scratch), signal, 30_000, 4096)
  if (actual !== image) fail('Docker image content ID differs from receipt')
}

async function replay(final: string, input: Input, expected: Inputs, dockerSha256: string,
  scratch?: string, signal?: AbortSignal): Promise<RsiCreationBuildEnvironment> {
  await io.directory(final)
  if (!isDeepStrictEqual(await readdir(final), ['bootstrap.json'])) fail('behavior workspace incomplete or unexpected')
  const value = JSON.parse((await io.readStable(join(final, 'bootstrap.json'), 65_536, true)).toString('utf8')) as Receipt
  const { receiptDigest, ...content } = value
  if (!isDeepStrictEqual(Object.keys(content).sort(), ['schemaVersion', 'sourceCommit', 'sourceImage', 'image',
    'dockerPath', 'dshHome', 'profile', 'dockerSha256', 'inputHashes', 'contextFiles', 'contextDigest', 'lockSha256'].sort())
    || value.schemaVersion !== 1 || digest(JSON.stringify(content)) !== receiptDigest
    || value.dshHome !== input.dshHome || value.profile !== input.profile
    || value.sourceCommit !== input.source.sourceCommit || value.sourceImage !== input.build.sourceBuild.image
    || !IMAGE.test(value.image) || value.dockerPath !== input.build.sourceBuild.dockerPath
    || value.dockerSha256 !== dockerSha256 || !isDeepStrictEqual(value.inputHashes, expected.hashes)
    || !isDeepStrictEqual(value.contextFiles, expected.contextFiles)
    || value.contextDigest !== expected.contextDigest || value.lockSha256 !== expected.lockSha256)
    fail('behavior receipt differs from approved source, assets, or Docker client')
  if (scratch && signal) {
    await imageExists(value.dockerPath, value.sourceImage, scratch, signal)
    await imageExists(value.dockerPath, value.image, scratch, signal)
  }
  signal?.throwIfAborted()
  return { schemaVersion: 1, sourceCommit: value.sourceCommit, sourceImage: value.sourceImage,
    image: value.image, dockerPath: value.dockerPath }
}

/** Verify frozen local inputs only. This reader never invokes Docker. */
export async function readRsiCreationBuildEnvironment(input: Input): Promise<RsiCreationBuildEnvironment> {
  await base(input)
  const expected = await inputs(input.source)
  const dockerSha256 = digest(await io.readStable(input.build.sourceBuild.dockerPath, 100_000_000, false, true))
  const parent = join(input.dshHome, 'rsi-creation-builds'), final = join(parent, input.profile)
  await io.directory(parent)
  return replay(final, input, expected, dockerSha256, undefined, input.signal)
}

/** Caller holds the DSH_HOME lifecycle lock. Build or replay an immutable image. */
export async function prepareRsiCreationBuildEnvironment(input: Input): Promise<RsiCreationBuildEnvironment> {
  if (process.platform !== 'linux' || process.arch !== 'x64') fail('Linux x64 is required')
  await base(input)
  const expected = await inputs(input.source)
  const dockerPath = input.build.sourceBuild.dockerPath
  const dockerSha256 = digest(await io.readStable(dockerPath, 100_000_000, false, true))
  const parent = join(input.dshHome, 'rsi-creation-builds')
  try { await mkdir(parent, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await io.directory(parent)
  const final = join(parent, input.profile)
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(1_860_000)])
  const stage = await mkdtemp(join(parent, `.${input.profile}-stage-`))
  await chmod(stage, 0o700)
  let claimed: { dev: number; ino: number } | undefined
  try {
    await mkdir(join(stage, 'docker-config'), { mode: 0o700 })
    const version = await io.command(dockerPath, ['version', '--format', '{{.Server.Version}}/{{.Server.Os}}/{{.Server.Arch}}'],
      io.isolatedEnvironment(stage), signal, 10_000, 4096)
    if (version !== '29.4.1/linux/amd64') fail('Docker runtime version differs from approved runtime')
    const present = await lstat(final).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    })
    if (present) return await replay(final, input, expected, dockerSha256, stage, signal)
    await imageExists(dockerPath, input.build.sourceBuild.image, stage, signal)
    const context = join(stage, 'source')
    await mkdir(context, { mode: 0o700 })
    await snapshot(context, expected.files)
    const builder = join(context, 'scripts/isolation/build-plugin-verifier-image.mjs')
    const raw = await io.command(process.execPath, [builder, '--docker-path', dockerPath,
      '--source-image', input.build.sourceBuild.image, '--timeout-ms', '1800000'],
    { ...io.isolatedEnvironment(stage), TMPDIR: stage }, signal, 1_810_000)
    const image = parseOutput(raw, expected, input.build.sourceBuild.image)
    await imageExists(dockerPath, image, stage, signal)
    await base(input)
    const fresh = await inputs(input.source)
    if (!isDeepStrictEqual(fresh.hashes, expected.hashes) || fresh.contextDigest !== expected.contextDigest)
      fail('source inputs changed during behavior image build')
    signal.throwIfAborted()
    await mkdir(final, { mode: 0o700 })
    const identity = await stat(final); claimed = { dev: identity.dev, ino: identity.ino }
    const result: RsiCreationBuildEnvironment = { schemaVersion: 1, sourceCommit: input.source.sourceCommit,
      sourceImage: input.build.sourceBuild.image, image, dockerPath }
    const content = { ...result, dshHome: input.dshHome, profile: input.profile, dockerSha256,
      inputHashes: expected.hashes, contextFiles: expected.contextFiles,
      contextDigest: expected.contextDigest, lockSha256: expected.lockSha256 }
    await io.writeExclusive(join(final, 'bootstrap.json'), JSON.stringify({ ...content, receiptDigest: digest(JSON.stringify(content)) }))
    await io.syncDirectory(final); await io.syncDirectory(parent)
    return result
  } catch (error) {
    if (claimed) {
      const current = await lstat(final).catch(() => undefined)
      if (current?.isDirectory() && current.dev === claimed.dev && current.ino === claimed.ino
        && (await readdir(final)).every(name => name === 'bootstrap.json')) await rm(final, { recursive: true, force: true })
    }
    throw error
  } finally { await rm(stage, { recursive: true, force: true }); await io.syncDirectory(parent) }
}
