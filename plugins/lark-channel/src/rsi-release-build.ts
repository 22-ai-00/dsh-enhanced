import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { linuxRuntimeDigest, validateLinuxRuntime, verifyLinuxRuntime, type LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { rsiBuildResources as io, type RsiBuildEnvironment } from './rsi-build.js'
import type { LinuxRsiBuildEnvironment } from './rsi-linux-runtime-bootstrap.js'

interface Pin { path: string; sha256: string }
export interface RsiReleaseBuildConfig {
  sandboxExecutable: Pin; tarExecutable: Pin; nodeExecutable: Pin; pnpmExecutable: Pin
  pnpmRoot: Pin; storeRoot: Pin; cacheRoot: Pin;
}
export interface RsiReleaseBuildEnvironment {
  schemaVersion: 1; sourceCommit: string; image: string; releaseBuild: RsiReleaseBuildConfig
}
/** Native replacement for the immutable Docker image export: the release trees
 * are copied from the independently verified schema 3 Linux runtime, and the
 * receipt binds that runtime's content digest instead of an image reference. */
export interface NativeRsiReleaseBuildEnvironment {
  schemaVersion: 2; backend: 'linux-native'; sourceCommit: string
  runtimeDigest: string; releaseBuild: RsiReleaseBuildConfig
}
export type PreparedReleaseBuildEnvironment = RsiReleaseBuildEnvironment | NativeRsiReleaseBuildEnvironment
export type ReleaseBuildInput = RsiBuildEnvironment | LinuxRsiBuildEnvironment
type Receipt = (RsiReleaseBuildEnvironment | NativeRsiReleaseBuildEnvironment) & {
  dshHome: string; profile: string; receiptDigest: string
}

export class RsiReleaseBuildUnavailableError extends Error {
  constructor(message: string) { super(`rsi release build unavailable: ${message}`) }
}
function fail(message: string): never { throw new Error(`rsi release build: ${message}`) }
function digest(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

async function inspect(root: string): Promise<RsiReleaseBuildConfig> {
  const require = createRequire(import.meta.url)
  const packageRoot = dirname(require.resolve('@dsh-enhanced/plugin-control-plane/package.json'))
  const adapter = await import(pathToFileURL(join(packageRoot, 'bin', 'dsh-local-release-adapter.js')).href) as {
    inspectLocalReleaseBuildEnvironment?: (paths: { pnpmRoot: string; storeRoot: string; cacheRoot: string }) => RsiReleaseBuildConfig
  }
  if (typeof adapter.inspectLocalReleaseBuildEnvironment !== 'function') fail('installed Control Plane lacks release environment inspection')
  return adapter.inspectLocalReleaseBuildEnvironment({ pnpmRoot: join(root, 'toolchain'),
    storeRoot: join(root, 'store'), cacheRoot: join(root, 'cache') })
}

function nativeRuntime(build: ReleaseBuildInput): LinuxRuntime | undefined {
  return build.schemaVersion === 3 && build.backend === 'linux-native' ? build.runtime : undefined
}

/** Verify existing exported inputs only; never creates a container, copies
 * assets or repairs a missing export. The caller separately verifies the source
 * image evidence or the schema 3 Linux runtime. */
export async function readRsiReleaseBuildEnvironment(input: {
  dshHome: string; profile: string; build: ReleaseBuildInput; signal?: AbortSignal
}): Promise<PreparedReleaseBuildEnvironment> {
  if (!isAbsolute(input.dshHome) || resolve(input.dshHome) !== input.dshHome
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.profile)) fail('invalid resource binding')
  input.signal?.throwIfAborted()
  await io.directory(input.dshHome, false)
  const parent = join(input.dshHome, 'rsi-release-builds'), final = join(parent, input.profile)
  await io.directory(parent); await io.directory(final)
  if (!isDeepStrictEqual((await readdir(final)).sort(), ['bootstrap.json', 'cache', 'store', 'toolchain'])) fail('existing release environment is incomplete')
  const receipt = JSON.parse((await io.readStable(join(final, 'bootstrap.json'), 65_536, true)).toString('utf8')) as Receipt
  const { receiptDigest, ...content } = receipt
  const matchesInput = receipt.schemaVersion === 1
    ? input.build.schemaVersion === 1 && receipt.image === input.build.sourceBuild.image
    : receipt.schemaVersion === 2 && (() => {
        const runtime = nativeRuntime(input.build)
        return runtime !== undefined && receipt.backend === 'linux-native'
          && receipt.runtimeDigest === linuxRuntimeDigest(runtime)
      })()
  // A Docker plan may never be continued by a native receipt or the reverse.
  if (!matchesInput || receipt.dshHome !== input.dshHome || receipt.profile !== input.profile
    || receipt.sourceCommit !== input.build.sourceCommit
    || digest(JSON.stringify(content)) !== receiptDigest
    || !isDeepStrictEqual(receipt.releaseBuild, await inspect(final))) fail('release environment differs from its receipt')
  input.signal?.throwIfAborted()
  return receipt.schemaVersion === 1
    ? { schemaVersion: 1, sourceCommit: receipt.sourceCommit, image: receipt.image, releaseBuild: receipt.releaseBuild }
    : { schemaVersion: 2, backend: 'linux-native', sourceCommit: receipt.sourceCommit,
      runtimeDigest: receipt.runtimeDigest, releaseBuild: receipt.releaseBuild }
}

// Docker cp preserves image mode bits and the native runtime trees are already
// owner-private. Make exported resources private, reject links/devices, and
// separate any hard links before the adapter pins the trees.
async function harden(root: string, signal: AbortSignal): Promise<void> {
  let entries = 0, bytes = 0
  const visit = async (path: string): Promise<void> => {
    signal.throwIfAborted()
    if (++entries > 100_000) fail('export contains too many entries')
    const item = await lstat(path)
    if (item.isSymbolicLink() || process.getuid && item.uid !== process.getuid()) fail('export contains an unsafe entry')
    if (item.isDirectory()) {
      await chmod(path, 0o700)
      for (const name of await readdir(path)) await visit(join(path, name))
    } else if (item.isFile()) {
      bytes += item.size
      if (item.size > 268_435_456 || bytes > 2_147_483_648) fail('export exceeds its size bound')
      if (item.nlink !== 1) {
        const temporary = `${path}.copy-${randomUUID()}`
        try { await copyFile(path, temporary); await rename(temporary, path) }
        finally { await rm(temporary, { force: true }) }
      }
      await chmod(path, item.mode & 0o111 ? 0o700 : 0o600)
    } else fail('export contains a nonregular entry')
  }
  await visit(root)
}

/** Copy the three release trees from the verified immutable Linux runtime. The
 * runtime is the native equivalent of the never-started image: its whole-tree
 * digest is rechecked before any byte is read, and copies never follow links. */
async function exportNativeAssets(assets: string, runtime: LinuxRuntime, signal: AbortSignal): Promise<void> {
  await verifyLinuxRuntime(runtime, signal)
  for (const [source, target] of [[runtime.nativePnpmRoot, join(assets, 'toolchain')],
    [runtime.storePath, join(assets, 'store')], [runtime.cachePath, join(assets, 'cache')]] as const) {
    const item = await lstat(source)
    if (!item.isDirectory() || item.isSymbolicLink() || process.getuid && item.uid !== process.getuid()) fail('runtime release tree is unsafe')
    await cp(source, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
  }
  // A freshly prepared runtime store has no project registry yet; the adapter
  // requires one and every release keeps its own, never stale runtime links.
  await mkdir(join(assets, 'store', 'v11', 'projects'), { recursive: true, mode: 0o700 })
}

/** Caller holds the home lifecycle lock. A Docker build exports fixed assets
 * from the already prepared immutable image (the container is never started);
 * a schema 3 native build copies the same three trees from the verified Linux
 * runtime. Neither path needs a Docker CLI, daemon, socket or image. */
export async function prepareRsiReleaseBuildEnvironment(input: {
  dshHome: string; profile: string; build: ReleaseBuildInput; signal?: AbortSignal
}): Promise<PreparedReleaseBuildEnvironment> {
  const dockerBuild = input.build.schemaVersion === 1 ? input.build : undefined
  const runtime = nativeRuntime(input.build)
  if ((dockerBuild === undefined) === (runtime === undefined)) fail('unsupported release build backend')
  if (!isAbsolute(input.dshHome) || resolve(input.dshHome) !== input.dshHome
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.profile)
    || !/^[a-f0-9]{40}$/u.test(input.build.sourceCommit)) fail('invalid resource binding')
  if (dockerBuild && !/^sha256:[a-f0-9]{64}$/u.test(dockerBuild.sourceBuild.image)) fail('invalid resource binding')
  if (runtime) validateLinuxRuntime(runtime)
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    throw new RsiReleaseBuildUnavailableError('Linux x64/arm64 is required')
  }
  await io.directory(input.dshHome, false)
  for (const path of ['/usr/bin/bwrap', '/usr/bin/tar']) {
    try { await lstat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RsiReleaseBuildUnavailableError(`${path} is required`)
      throw error
    }
  }
  const parent = join(input.dshHome, 'rsi-release-builds')
  try { await mkdir(parent, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await io.directory(parent)
  const final = join(parent, input.profile)
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(600_000)])
  try {
    await lstat(final)
    return await readRsiReleaseBuildEnvironment({ ...input, signal })
  } catch (error) {
    // Only absence of the root permits creation. A missing child is drift.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try { await lstat(final); fail('existing release environment is incomplete') }
    catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing }
  }
  const stage = await mkdtemp(join(parent, `.${input.profile}-stage-`))
  await chmod(stage, 0o700)
  const assets = join(stage, 'assets'), token = randomUUID(), container = `dsh-release-assets-${token}`
  const docker = dockerBuild?.sourceBuild.dockerPath
  let containerMayExist = false, claimed: { dev: number; ino: number } | undefined
  const run = (args: string[], cleanup = false) => io.command(docker!, args, io.isolatedEnvironment(stage),
    cleanup ? new AbortController().signal : signal, cleanup ? 30_000 : 180_000)
  const cleanupContainer = async (): Promise<void> => {
    if (!containerMayExist || !docker) return
    // Generated name and unguessable label bind cleanup even if create's reply
    // was lost. Do not delete a replacement container with another label.
    const ids = await run(['ps', '-a', '--filter', `name=^/${container}$`, '--format', '{{.ID}}'], true)
    if (!ids) { containerMayExist = false; return }
    const label = await run(['inspect', '--format', '{{index .Config.Labels "org.dsh.release-assets"}}', container], true)
    if (label !== token) fail('export container ownership changed')
    await run(['rm', '-f', container], true)
    containerMayExist = false
  }
  try {
    await mkdir(join(stage, 'docker-config'), { mode: 0o700 })
    await mkdir(assets, { mode: 0o700 })
    if (dockerBuild) {
      const image = dockerBuild.sourceBuild.image
      for (const name of ['toolchain', 'store', 'cache']) await mkdir(join(assets, name), { mode: 0o700 })
      await mkdir(join(assets, 'store', 'v11', 'files'), { recursive: true, mode: 0o700 })
      containerMayExist = true
      await run(['create', '--name', container, '--label', `org.dsh.release-assets=${token}`,
        '--network', 'none', '--read-only', '--entrypoint', '/bin/false', image])
      for (const [source, target] of [
        ['/opt/pnpm-native/node_modules/@pnpm/exe/.', join(assets, 'toolchain')],
        ['/usr/local/bin/node', join(assets, 'toolchain', 'node')],
        // The image's projects registry points at its deleted /seed checkout.
        // Each release uses a fresh writable registry, never those stale links.
        ['/opt/pnpm-store/v11/files/.', join(assets, 'store', 'v11', 'files')],
        ['/opt/pnpm-store/v11/index.db', join(assets, 'store', 'v11', 'index.db')],
        ['/opt/pnpm-cache/.', join(assets, 'cache')],
      ] as const) await run(['cp', `${container}:${source}`, target])
      await cleanupContainer()
      await mkdir(join(assets, 'store', 'v11', 'projects'), { recursive: true, mode: 0o700 })
    } else {
      await exportNativeAssets(assets, runtime!, signal)
    }
    await harden(assets, signal)
    const toolchain = join(assets, 'toolchain')
    const environment = { PATH: `${toolchain}:/usr/bin:/bin`, HOME: stage, LANG: 'C', LC_ALL: 'C' }
    const nodeVersion = await io.command(join(toolchain, 'node'), ['--version'], environment, signal, 10_000)
    const pnpmVersion = await io.command(join(toolchain, 'pnpm'), ['--version'], environment, signal, 10_000)
    if (nodeVersion !== 'v22.23.2' || pnpmVersion !== '11.7.0') fail('image toolchain version differs from the approved runtime')
    await inspect(assets)
    signal.throwIfAborted()
    await mkdir(final, { mode: 0o700 })
    const identity = await lstat(final); claimed = { dev: identity.dev, ino: identity.ino }
    for (const name of ['toolchain', 'store', 'cache']) await rename(join(assets, name), join(final, name))
    const result: PreparedReleaseBuildEnvironment = dockerBuild
      ? { schemaVersion: 1, sourceCommit: input.build.sourceCommit,
        image: dockerBuild.sourceBuild.image, releaseBuild: await inspect(final) }
      : { schemaVersion: 2, backend: 'linux-native', sourceCommit: input.build.sourceCommit,
        runtimeDigest: linuxRuntimeDigest(runtime!), releaseBuild: await inspect(final) }
    const content = { ...result, dshHome: input.dshHome, profile: input.profile }
    await io.writeExclusive(join(final, 'bootstrap.json'), JSON.stringify({ ...content, receiptDigest: digest(JSON.stringify(content)) }))
    await io.syncDirectory(final); await io.syncDirectory(parent)
    return result
  } catch (error) {
    if (claimed) {
      const current = await lstat(final).catch(() => undefined)
      if (current?.isDirectory() && current.dev === claimed.dev && current.ino === claimed.ino) await rm(final, { recursive: true, force: true })
    }
    throw error
  } finally {
    // A cleanup failure is surfaced and leaves the labelled container visible.
    try { await cleanupContainer() } finally { await rm(stage, { recursive: true, force: true }); await io.syncDirectory(parent) }
  }
}
