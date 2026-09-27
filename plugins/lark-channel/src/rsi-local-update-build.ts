import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareRsiBuildEnvironment, rsiBuildResources as io } from './rsi-build.js'
import { prepareRsiReleaseBuildEnvironment } from './rsi-release-build.js'
import type { RsiSourceWorkspace } from './rsi-source.js'
import type { RsiLocalCohortPorts } from './rsi-local-cohort.js'

/** Only the digest-pinned manifest/image preparation runs on the host. Updated
 * repository build/pack scripts run with the release adapter's existing offline
 * bwrap mounts, without the live Home, source Git directories or credentials. */
export async function prepareRsiLocalUpdateBuild(input: {
  dshHome: string; profile: string; source: RsiSourceWorkspace; signal: AbortSignal
}) {
  const require = createRequire(import.meta.url)
  const packageRoot = dirname(require.resolve('@dsh-enhanced/plugin-control-plane/package.json'))
  const adapterPath = join(packageRoot, 'bin', 'dsh-local-release-adapter.js')
  const adapter = await import(pathToFileURL(adapterPath).href) as { buildLocalUpdateCohort?: unknown }
  if (typeof adapter.buildLocalUpdateCohort !== 'function') throw new Error('rsi local update: Control Plane lacks isolated cohort preparation')
  const build = await prepareRsiBuildEnvironment(input)
  const release = await prepareRsiReleaseBuildEnvironment({ ...input, build })
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
