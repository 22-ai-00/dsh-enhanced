import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Config as ControlPlaneConfig } from '@dsh-enhanced/plugin-control-plane'
import { readRsiSourceWorkspace, type RsiSourceWorkspace } from './rsi-source.js'

type SourceBuild = NonNullable<ControlPlaneConfig['sourceBuild']>
const COMMIT = /^[a-f0-9]{40}$/u
const IMAGE = /^sha256:[a-f0-9]{64}$/u
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const SECCOMP_SHA = 'b1e4b5b709578785bd2aff4a3a344301997571ad0e8ae5747aec176571ddc342'
const BUILDER_SHA = '7b7eb0797e1ca543fb1ffa0463eb78b3ecad14f28fe4bfca25651640aac4669b'
const DOCKERFILE_SHA = 'c936e136517c5bc85603e7187fe74691e32f954f57b5076946dc42fed33c65f5'
const BASE_IMAGE = 'node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9'
const PACKAGE_MANAGER = 'pnpm@11.7.0'
const MAX_OUTPUT = 65_536

export class RsiBuildUnavailableError extends Error {
  readonly code = 'rsi-build-unavailable'
  constructor(message: string) { super(`rsi build unavailable: ${message}`) }
}

export interface RsiBuildEnvironment {
  schemaVersion: 1
  sourceCommit: string
  sourceBuild: SourceBuild
}

interface Receipt extends RsiBuildEnvironment {
  dshHome: string
  profile: string
  repository: string
  dockerSha256: string
  inputHashes: Record<string, string>
  contextFiles: string[]
  lockSha256: string
  receiptDigest: string
}

function fail(message: string): never { throw new Error(`rsi build: ${message}`) }
function digest(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function exactPath(path: string): boolean { return isAbsolute(path) && resolve(path) === path && !path.includes('\0') }
function diagnosticTail(value: string): string {
  const redacted = value.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/giu, 'https://[redacted]@')
    .replace(/authorization\s*:\s*[^\s]+/giu, 'authorization: [redacted]')
  return Array.from(redacted).map(char => {
    const code = char.codePointAt(0)!
    return code < 32 || code === 127 ? ' ' : char
  }).join('').slice(-2_048).trim()
}

async function directory(path: string, privateMode = true): Promise<void> {
  const item = await lstat(path)
  if (!item.isDirectory() || item.isSymbolicLink() || item.mode & (privateMode ? 0o077 : 0o022)
    || process.getuid && item.uid !== process.getuid() || await realpath(path) !== path) fail(`unsafe directory: ${path}`)
}
async function readStable(path: string, maximum: number, privateMode = false, allowRoot = false): Promise<Buffer> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await fd.stat()
    if (!before.isFile() || before.size > maximum || privateMode && before.mode & 0o077
      || process.getuid && before.uid !== process.getuid() && !(allowRoot && before.uid === 0)) fail(`unsafe file: ${path}`)
    const bytes = await fd.readFile(), after = await fd.stat(), name = await lstat(path)
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || name.dev !== before.dev || name.ino !== before.ino || name.isSymbolicLink()) fail(`file changed during read: ${path}`)
    return bytes
  } finally { await fd.close() }
}
async function writeExclusive(path: string, bytes: string | Buffer): Promise<void> {
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await fd.writeFile(bytes); await fd.sync() } finally { await fd.close() }
}
async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await fd.sync() } finally { await fd.close() }
}

/** Drain a cancelled builder, giving its own finally block time to remove its context. */
async function command(executable: string, args: readonly string[], environment: NodeJS.ProcessEnv,
  signal: AbortSignal, timeoutMs: number, outputLimit = MAX_OUTPUT): Promise<string> {
  signal.throwIfAborted()
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  return new Promise<string>((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>
    try { child = spawn(executable, [...args], { env: environment, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', windowsHide: true }) }
    catch { reject(new Error('rsi build: subprocess could not start')); return }
    let stdoutBytes = 0, overLimit = false, spawnError = false
    const stdout: Buffer[] = []
    let stderrTail = ''
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const group = (signalName: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        if (process.platform === 'win32') child.kill(signalName)
        else process.kill(-child.pid, signalName)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signalName) }
    }
    const abort = () => {
      group('SIGTERM')
      killTimer ??= setTimeout(() => group('SIGKILL'), 5_000)
      killTimer.unref?.()
    }
    deadline.addEventListener('abort', abort, { once: true })
    if (deadline.aborted) abort()
    const collect = (data: Buffer, keep: boolean) => {
      if (keep) {
        stdoutBytes += data.length
        if (stdoutBytes > outputLimit) { overLimit = true; group('SIGKILL'); return }
        stdout.push(data)
      } else {
        // Docker build progress can be large. Drain it without logging it or
        // treating normal progress as a malformed JSON result.
        stderrTail = (stderrTail + data.toString('utf8')).slice(-8_192)
      }
    }
    child.stdout!.on('data', data => collect(data, true))
    child.stderr!.on('data', data => collect(data, false))
    child.once('error', () => { spawnError = true; group('SIGKILL') })
    child.once('close', (code, killed) => {
      deadline.removeEventListener('abort', abort)
      if (killTimer) clearTimeout(killTimer)
      if (spawnError || overLimit || deadline.aborted || code !== 0 || killed !== null) {
        const stage = executable === process.execPath ? 'source-image-builder'
          : args[0] === 'image' ? 'image-inspect' : args[0] ?? 'command'
        const tail = diagnosticTail(stderrTail)
        reject(new Error(`rsi build: subprocess failed, was cancelled, or exceeded its bound (stage=${stage}, exit=${code ?? 'signal'}${tail ? `, stderr=${tail}` : ''})`))
      }
      else resolvePromise(Buffer.concat(stdout).toString('utf8').trim())
    })
  })
}

function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: home, DOCKER_CONFIG: join(home, 'docker-config'),
    DOCKER_BUILDKIT: '1' }
}

// Shared by the release-toolchain preparer; these helpers never change a profile.
export const rsiBuildResources = { directory, readStable, writeExclusive, syncDirectory, command, isolatedEnvironment }

async function dockerExecutable(requested?: string): Promise<{ path: string; sha256: string }> {
  let path = requested
  if (path === undefined) {
    for (const folder of (process.env.PATH ?? '').split(':')) {
      if (!folder || !exactPath(folder)) continue
      const candidate = join(folder, 'docker')
      try { await lstat(candidate); path = candidate; break } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    path ??= '/usr/bin/docker'
  }
  if (!exactPath(path)) fail('Docker path must be absolute')
  let canonical: string
  try { canonical = await realpath(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RsiBuildUnavailableError('Docker executable was not found')
    throw error
  }
  const file = await lstat(canonical), parent = await lstat(dirname(canonical)), uid = process.getuid?.()
  if (!file.isFile() || file.isSymbolicLink() || file.mode & 0o022 || !(file.mode & 0o111)
    || !parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o002
    || uid !== undefined && file.uid !== uid && file.uid !== 0) fail('Docker executable is not owner-safe')
  return { path: canonical, sha256: digest(await readStable(canonical, 100_000_000, false, true)) }
}

async function runtime(dockerPath: string, scratch: string, signal: AbortSignal): Promise<void> {
  let output: string
  try { output = await command(dockerPath, ['version', '--format', '{{.Server.Version}}/{{.Server.Os}}/{{.Server.Arch}}'],
    isolatedEnvironment(scratch), signal, 10_000, 4096) }
  catch {
    if (signal.aborted) signal.throwIfAborted()
    throw new RsiBuildUnavailableError('local Docker daemon is unavailable')
  }
  if (output !== '29.4.1/linux/amd64') throw new RsiBuildUnavailableError('Docker Server 29.4.1/linux/amd64 is required')
}

async function sourceInputs(source: RsiSourceWorkspace, expectedRepository: string): Promise<{
  files: Map<string, Buffer>; hashes: Record<string, string>; contextFiles: string[]; lockSha256: string
}> {
  if (source.schemaVersion !== 1 || !COMMIT.test(source.sourceCommit) || source.repository !== expectedRepository
    || !COMMIT.test(source.baseline.initialCommit)
    || source.baseline.ref !== 'refs/dsh-source/repairs' || source.baseline.targetBranch !== 'repairs'
    || source.baseline.remote !== join(dirname(expectedRepository), 'release.git')) fail('source workspace binding is invalid')
  if (source.baseline.initialCommit !== source.sourceCommit) {
    // A newer checkout must be derived from retained, Host-signed maintenance
    // history. A caller-supplied commit alone cannot replace the original root.
    const current = await readRsiSourceWorkspace({ dshHome: dirname(dirname(dirname(expectedRepository))),
      profile: basename(dirname(expectedRepository)),
      ...(source.origin.kind === 'local-head' ? { sourceRepository: source.origin.locator } : {}) })
    if (!isDeepStrictEqual(current, source)) fail('source workspace differs from signed maintenance history')
  }
  await directory(source.repository)
  const files = new Map<string, Buffer>()
  const contextFiles = ['scripts/isolation/source-builder.Dockerfile', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
  for (const folder of ['plugins', 'packages']) {
    for (const entry of await readdir(join(source.repository, folder), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const name = `${folder}/${entry.name}/package.json`
      try { await lstat(join(source.repository, name)); contextFiles.push(name) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
  contextFiles.sort()
  if (contextFiles.length > 256) fail('source context file count exceeds bound')
  const inputs = [...contextFiles, 'scripts/isolation/build-source-image.mjs', 'scripts/isolation/source-builder-seccomp.json']
  for (const name of inputs) files.set(name, await readStable(join(source.repository, name), 4_194_304))
  const manifest = JSON.parse(files.get('package.json')!.toString('utf8')) as Record<string, unknown>
  if (manifest.name !== 'dsh-enhanced' || manifest.version !== source.version || manifest.packageManager !== PACKAGE_MANAGER) fail('source manifest differs from installed cohort')
  if (digest(files.get('scripts/isolation/build-source-image.mjs')!) !== BUILDER_SHA
    || digest(files.get('scripts/isolation/source-builder.Dockerfile')!) !== DOCKERFILE_SHA) fail('source builder differs from installed trusted builder')
  if (digest(files.get('scripts/isolation/source-builder-seccomp.json')!) !== SECCOMP_SHA) fail('repository seccomp differs from approved runtime profile')
  const hashes = Object.fromEntries([...files].map(([name, bytes]) => [name, digest(bytes)]))
  return { files, hashes, contextFiles, lockSha256: digest(files.get('pnpm-lock.yaml')!) }
}

async function snapshot(root: string, files: Map<string, Buffer>): Promise<void> {
  for (const [name, bytes] of files) {
    const path = join(root, name)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeExclusive(path, bytes)
  }
}

function parseBuildOutput(raw: string, expected: { contextFiles: string[]; lockSha256: string }): string {
  if (Buffer.byteLength(raw) > 16_384) fail('builder output exceeds bound')
  const value = JSON.parse(raw) as Record<string, unknown>
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== ['image', 'tag', 'baseImage', 'packageManager', 'lockSha256', 'contextFiles'].sort().join('\0')
    || typeof value.image !== 'string' || !IMAGE.test(value.image)
    || value.baseImage !== BASE_IMAGE || value.packageManager !== PACKAGE_MANAGER
    || value.lockSha256 !== expected.lockSha256
    || JSON.stringify(value.contextFiles) !== JSON.stringify(expected.contextFiles)) fail('builder output does not match frozen source inputs')
  return value.image
}

function buildConfig(dockerPath: string, image: string, seccompPath: string): SourceBuild {
  return { dockerPath, image, timeoutMs: 1_800_000, memoryMiB: 16_384, cpus: 8, pidsLimit: 1_024,
    workspaceMiB: 4_096, temporaryMiB: 2_048, outputBytes: 65_536,
    versioning: 'patch', profile: 'repository', repositorySandbox: { seccompPath } }
}

async function imageExists(dockerPath: string, image: string, scratch: string, signal: AbortSignal): Promise<void> {
  const actual = await command(dockerPath, ['image', 'inspect', '--format', '{{.Id}}', image],
    isolatedEnvironment(scratch), signal, 30_000, 4096)
  if (actual !== image) fail('Docker image content ID differs from builder receipt')
}

async function replay(final: string, expected: { dshHome: string; profile: string; repository: string;
  sourceCommit: string; dockerPath: string; dockerSha256: string; inputHashes: Record<string, string>;
  contextFiles: string[]; lockSha256: string }, scratch: string | undefined, signal: AbortSignal): Promise<RsiBuildEnvironment> {
  await directory(final)
  if (JSON.stringify((await readdir(final)).sort()) !== JSON.stringify(['bootstrap.json', 'seccomp.json'])) fail('build workspace incomplete or unexpected')
  const value = JSON.parse((await readStable(join(final, 'bootstrap.json'), 65_536, true)).toString('utf8')) as Receipt
  const { receiptDigest, ...content } = value
  if (value.schemaVersion !== 1 || digest(JSON.stringify(content)) !== receiptDigest
    || value.dshHome !== expected.dshHome || value.profile !== expected.profile
    || value.repository !== expected.repository || value.sourceCommit !== expected.sourceCommit
    || value.dockerSha256 !== expected.dockerSha256 || value.sourceBuild?.dockerPath !== expected.dockerPath
    || !IMAGE.test(value.sourceBuild?.image ?? '')
    || JSON.stringify(value.inputHashes) !== JSON.stringify(expected.inputHashes)
    || JSON.stringify(value.contextFiles) !== JSON.stringify(expected.contextFiles)
    || value.lockSha256 !== expected.lockSha256
    || JSON.stringify(value.sourceBuild) !== JSON.stringify(buildConfig(expected.dockerPath, value.sourceBuild.image, join(final, 'seccomp.json')))) fail('build receipt differs from frozen source or Docker client')
  if (digest(await readStable(join(final, 'seccomp.json'), 65_536, true)) !== SECCOMP_SHA) fail('private repository seccomp changed')
  if (scratch !== undefined) await imageExists(expected.dockerPath, value.sourceBuild.image, scratch, signal)
  signal.throwIfAborted()
  return { schemaVersion: 1, sourceCommit: value.sourceCommit, sourceBuild: value.sourceBuild }
}

/** Read recorded build inputs without creating resources or running Docker.
 * Image availability is checked separately by preparation/execution. */
export async function readRsiBuildEnvironment(input: { dshHome: string; profile: string;
  source: RsiSourceWorkspace; signal?: AbortSignal }): Promise<RsiBuildEnvironment> {
  if (!exactPath(input.dshHome) || !PROFILE.test(input.profile)) fail('invalid DSH_HOME or profile')
  await directory(input.dshHome, false)
  const repository = join(input.dshHome, 'rsi-sources', input.profile, 'checkout')
  const source = await sourceInputs(input.source, repository)
  const parent = join(input.dshHome, 'rsi-builds'), final = join(parent, input.profile)
  await directory(parent); await directory(final)
  const saved = JSON.parse((await readStable(join(final, 'bootstrap.json'), 65_536, true)).toString('utf8')) as Receipt
  if (typeof saved.sourceBuild?.dockerPath !== 'string') fail('recorded Docker path is absent')
  const docker = await dockerExecutable(saved.sourceBuild.dockerPath)
  const signal = input.signal ?? new AbortController().signal
  return replay(final, { dshHome: input.dshHome, profile: input.profile, repository,
    sourceCommit: input.source.sourceCommit, dockerPath: docker.path, dockerSha256: docker.sha256,
    inputHashes: source.hashes, contextFiles: source.contextFiles, lockSha256: source.lockSha256 }, undefined, signal)
}

/** Caller holds the DSH_HOME lifecycle lock; no profile or service is changed here. */
export async function prepareRsiBuildEnvironment(input: { dshHome: string; profile: string; source: RsiSourceWorkspace;
  dockerPath?: string | undefined; signal?: AbortSignal }): Promise<RsiBuildEnvironment> {
  if (!exactPath(input.dshHome) || !PROFILE.test(input.profile)) fail('invalid DSH_HOME or profile')
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new RsiBuildUnavailableError('Linux x64 is required')
  await directory(input.dshHome, false)
  const repository = join(input.dshHome, 'rsi-sources', input.profile, 'checkout')
  const source = await sourceInputs(input.source, repository)
  const docker = await dockerExecutable(input.dockerPath)
  const parent = join(input.dshHome, 'rsi-builds')
  try { await mkdir(parent, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await directory(parent)
  const final = join(parent, input.profile), signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(1_860_000)])
  const stage = await mkdtemp(join(parent, `.${input.profile}-stage-`))
  await chmod(stage, 0o700)
  let claimed: { dev: number; ino: number } | undefined
  try {
    await mkdir(join(stage, 'docker-config'), { mode: 0o700 })
    await runtime(docker.path, stage, signal)
    const expected = { dshHome: input.dshHome, profile: input.profile, repository, sourceCommit: input.source.sourceCommit,
      dockerPath: docker.path, dockerSha256: docker.sha256, inputHashes: source.hashes,
      contextFiles: source.contextFiles, lockSha256: source.lockSha256 }
    const present = await lstat(final).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    })
    if (present) return await replay(final, expected, stage, signal)
    const sourceSnapshot = join(stage, 'source')
    await mkdir(sourceSnapshot, { mode: 0o700 })
    await snapshot(sourceSnapshot, source.files)
    const builder = join(sourceSnapshot, 'scripts', 'isolation', 'build-source-image.mjs')
    const raw = await command(process.execPath, [builder, '--docker-path', docker.path, '--timeout-ms', '1800000'],
      isolatedEnvironment(stage), signal, 1_810_000)
    const image = parseBuildOutput(raw, source)
    await imageExists(docker.path, image, stage, signal)
    const fresh = await sourceInputs(input.source, repository)
    if (JSON.stringify(fresh.hashes) !== JSON.stringify(source.hashes)) fail('source inputs changed during Docker build')
    await mkdir(final, { mode: 0o700 })
    const identity = await stat(final); claimed = { dev: identity.dev, ino: identity.ino }
    await writeExclusive(join(stage, 'seccomp.json'), source.files.get('scripts/isolation/source-builder-seccomp.json')!)
    await rename(join(stage, 'seccomp.json'), join(final, 'seccomp.json'))
    const result: RsiBuildEnvironment = { schemaVersion: 1, sourceCommit: input.source.sourceCommit,
      sourceBuild: buildConfig(docker.path, image, join(final, 'seccomp.json')) }
    const content = { ...result, dshHome: input.dshHome, profile: input.profile, repository,
      dockerSha256: docker.sha256, inputHashes: source.hashes, contextFiles: source.contextFiles, lockSha256: source.lockSha256 }
    await writeExclusive(join(final, 'bootstrap.json'), JSON.stringify({ ...content, receiptDigest: digest(JSON.stringify(content)) }))
    await syncDirectory(final); await syncDirectory(parent)
    return result
  } catch (error) {
    if (claimed) {
      const current = await lstat(final).catch(() => undefined)
      if (current?.isDirectory() && current.dev === claimed.dev && current.ino === claimed.ino) {
        const names = await readdir(final).catch(() => [])
        if (names.every(name => ['seccomp.json', 'bootstrap.json'].includes(name))) await rm(final, { recursive: true, force: true })
      }
    }
    throw error
  } finally { await rm(stage, { recursive: true, force: true }); await syncDirectory(parent) }
}
