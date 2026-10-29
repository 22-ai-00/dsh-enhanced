import { lstat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareRsiBuildEnvironment, rsiBuildResources as io,
  readRsiBuildEnvironment, type RsiBuildEnvironment } from './rsi-build.js'
import { prepareRsiReleaseBuildEnvironment,
  type PreparedReleaseBuildEnvironment } from './rsi-release-build.js'
import { prepareLinuxRsiRuntime, readLinuxRsiRuntime,
  type LinuxRsiBuildEnvironment } from './rsi-linux-runtime-bootstrap.js'
import type { RsiSourceWorkspace } from './rsi-source.js'
import type { RsiLocalCohortPorts } from './rsi-local-cohort.js'

export type LocalUpdateSourceBuild = RsiBuildEnvironment | LinuxRsiBuildEnvironment
export interface RsiLocalUpdateBuildEvidence {
  sourceBuild: LocalUpdateSourceBuild
  releaseBuild: PreparedReleaseBuildEnvironment
}
const fail = (message: string): never => { throw new Error(`rsi local update: ${message}`) }

async function loadAdapter(): Promise<{ adapterPath: string }> {
  const require = createRequire(import.meta.url)
  const packageRoot = dirname(require.resolve('@dsh-enhanced/plugin-control-plane/package.json'))
  const adapterPath = join(packageRoot, 'bin', 'dsh-local-release-adapter.js')
  const adapter = await import(pathToFileURL(adapterPath).href) as { buildLocalUpdateCohort?: unknown }
  if (typeof adapter.buildLocalUpdateCohort !== 'function') throw new Error('rsi local update: Control Plane lacks isolated cohort preparation')
  return { adapterPath }
}

/** Only the digest-pinned manifest/runtime preparation runs on the host. Updated
 * repository build/pack scripts run with the release adapter's existing offline
 * bwrap mounts, without the live Home, source Git directories or credentials.
 * Linux prepares the schema 3 native runtime by default; an explicit absolute
 * --docker-path keeps the legacy image builder available during coexistence. */
export async function prepareRsiLocalUpdateBuild(input: {
  dshHome: string; profile: string; source: RsiSourceWorkspace; signal: AbortSignal
  dockerPath?: string
}): Promise<{ ports: RsiLocalCohortPorts; evidence: RsiLocalUpdateBuildEvidence }> {
  const { adapterPath } = await loadAdapter()
  const build: LocalUpdateSourceBuild = process.platform === 'linux' && !input.dockerPath
    ? await prepareLinuxRsiRuntime({ dshHome: input.dshHome, profile: input.profile,
      source: input.source, signal: input.signal })
    : await prepareRsiBuildEnvironment(input)
  const release = await prepareRsiReleaseBuildEnvironment({ dshHome: input.dshHome,
    profile: input.profile, build, signal: input.signal })
  const ports: RsiLocalCohortPorts = { build: async (workspace, output, packagePaths, signal) => {
    // Keep the synchronous adapter in a separate, bounded process so cancel and
    // timeout can drain its bwrap child through --die-with-parent.
    // The adapter also has a CLI entry guard. Clear this eval process's argv
    // after capturing the data so importing it cannot be mistaken for its CLI.
    const program = "const [url,source]=process.argv.slice(1);process.argv.length=1;const m=await import(url);m.buildLocalUpdateCohort(JSON.parse(source));"
    await io.command(process.execPath, ['--input-type=module', '--eval', program,
      pathToFileURL(adapterPath).href, JSON.stringify({ build: release.releaseBuild, workspace, output, packagePaths })],
    { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' }, signal, 1_800_000, 2_097_152)
  } }
  return { ports, evidence: { sourceBuild: build, releaseBuild: release } }
}

async function present(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
}

/** Read the signed source build of a prepared candidate Home without creating
 * resources. Exactly one backend tree may exist: the native schema 3 runtime
 * under rsi-linux-runtimes or the legacy Docker schema 1 receipt under
 * rsi-builds. A candidate that somehow contains both is unreplayable drift, and
 * a Docker plan can never be continued by a native receipt or the reverse. */
export async function readRsiLocalUpdateSourceBuild(input: {
  dshHome: string; profile: string; source: RsiSourceWorkspace; signal?: AbortSignal
}): Promise<LocalUpdateSourceBuild> {
  const nativeFinal = join(input.dshHome, 'rsi-linux-runtimes', input.profile)
  const dockerFinal = join(input.dshHome, 'rsi-builds', input.profile)
  const [native, docker] = await Promise.all([present(nativeFinal), present(dockerFinal)])
  if (native && docker) fail('candidate contains both linux-native and Docker build receipts')
  if (native) return readLinuxRsiRuntime({ dshHome: input.dshHome, profile: input.profile,
    source: input.source, ...(input.signal ? { signal: input.signal } : {}) })
  if (docker) return readRsiBuildEnvironment({ dshHome: input.dshHome, profile: input.profile,
    source: input.source, ...(input.signal ? { signal: input.signal } : {}) })
  return fail('candidate build environment is missing')
}
