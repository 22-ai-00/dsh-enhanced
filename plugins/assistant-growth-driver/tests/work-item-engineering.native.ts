import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { prepareRsiSourceWorkspace } from '../../lark-channel/lib/rsi-source.js'
import { nativeRsiCreationBuild, prepareNativeRsiRuntime } from '../../lark-channel/lib/rsi-native-runtime-bootstrap.js'

/** Production preparation, not a synthetic runtime descriptor. All writes are
 * below one caller-owned temporary root; official pinned archive/dependency
 * downloads are performed only by the production bootstrap implementation. */
export async function prepareEngineeringMacRuntime(input: { repository: string; commit?: string; root?: string }) {
  if (process.platform !== 'darwin') throw new Error('Mac preparation requires Darwin; Linux resources use the production Linux creation bootstrap')
  const repository = await realpath(input.repository)
  const root = input.root === undefined
    ? await realpath(await mkdtemp(join(tmpdir(), 'work-item-engineering-runtime-')))
    : await realpath(input.root)
  await chmod(root, 0o700)
  const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', timeout: 120000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1',
      GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' },
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 }).trim()
  const commit = git(repository, 'rev-parse', `${input.commit ?? '876f4b66'}^{commit}`)
  const snapshot = join(root, 'committed-baseline')
  git(root, 'clone', '--quiet', '--local', '--no-hardlinks', '--no-checkout', repository, snapshot)
  git(snapshot, 'checkout', '--quiet', '--detach', commit)
  if (git(snapshot, 'rev-parse', 'HEAD') !== commit) throw new Error('committed baseline differs')
  const manifest = JSON.parse(await readFile(join(snapshot, 'package.json'), 'utf8')) as { version: string }
  const home = join(root, 'home'); await mkdir(home, { mode: 0o700 })
  const source = await prepareRsiSourceWorkspace({ dshHome: home, profile: 'engineering', version: manifest.version,
    sourceRepository: snapshot, signal: AbortSignal.timeout(180000) })
  if (source.sourceCommit !== commit || git(source.repository, 'rev-parse', 'HEAD') !== commit) {
    throw new Error('production source preparation selected a different committed baseline')
  }
  const build = await prepareNativeRsiRuntime({ dshHome: home, profile: 'engineering', source,
    signal: AbortSignal.timeout(1200000) })
  if (build.sourceCommit !== source.sourceCommit || !isDeepStrictEqual(build.sourceBuild.runtime, build.runtime)) {
    throw new Error('production native build does not match its source/runtime baseline')
  }
  const resources = { protocol: 'work-item-engineering-native-fixture/v1' as const, root, home,
    repository: source.repository, baselineCommit: commit, source, sourceBuild: build.sourceBuild,
    creationBuild: nativeRsiCreationBuild(build) }
  const path = join(root, 'native-resources.json')
  await writeFile(path, JSON.stringify(resources, null, 2) + '\n', { mode: 0o600 })
  return { path, resources }
}

/** Explicit Linux counterpart, using the production repository and creation
 * bootstraps under a temporary Home lock. Requires the host's existing user
 * namespace helpers and delegated cgroup roots; never changes host settings. */
export async function prepareEngineeringLinuxRuntime(input: { repository: string; commit: string }) {
  if (process.platform !== 'linux') throw new Error('Linux preparation requires Linux')
  const repository = await realpath(input.repository)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'work-item-engineering-runtime-')))
  await chmod(root, 0o700)
  const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', timeout: 120000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1',
      GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' },
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 }).trim()
  const commit = git(repository, 'rev-parse', `${input.commit}^{commit}`)
  const snapshot = join(root, 'committed-baseline')
  git(root, 'clone', '--quiet', '--local', '--no-hardlinks', '--no-checkout', repository, snapshot)
  git(snapshot, 'checkout', '--quiet', '--detach', commit)
  if (git(snapshot, 'rev-parse', 'HEAD') !== commit) throw new Error('committed baseline differs')
  const { version } = JSON.parse(await readFile(join(snapshot, 'package.json'), 'utf8')) as { version: string }
  const home = join(root, 'home'), stateRoot = join(root, 'authority-state')
  await mkdir(home, { mode: 0o700 }); await mkdir(stateRoot, { mode: 0o700 })
  const { withDshHomeLifecycleLock } = await import('../../lark-channel/lib/setup.js')
  const { prepareLinuxRsiRepositoryRuntime } = await import('../../lark-channel/lib/rsi-linux-repository-bootstrap.js')
  const { prepareLinuxRsiCreationBuildEnvironment } = await import('../../lark-channel/lib/rsi-linux-creation-build.js')
  const { discoverLinuxCgroupRoots } = await import('../../lark-channel/lib/rsi-linux-cgroup-roots.js')
  const resources = await withDshHomeLifecycleLock(home, async () => {
    const signal = AbortSignal.timeout(2400000)
    const source = await prepareRsiSourceWorkspace({ dshHome: home, profile: 'engineering', version,
      sourceRepository: snapshot, signal })
    if (source.sourceCommit !== commit || git(source.repository, 'rev-parse', 'HEAD') !== commit) throw new Error('production source preparation selected a different committed baseline')
    const preparation = { dshHome: home, profile: 'engineering', source, signal }
    const prepared = await prepareLinuxRsiRepositoryRuntime(preparation)
    const cgroupRoots = await discoverLinuxCgroupRoots({ signal })
    const creationBuild = await prepareLinuxRsiCreationBuildEnvironment({ ...preparation, stateRoot })
    if (prepared.sourceCommit !== commit || creationBuild.sourceCommit !== commit
      || !isDeepStrictEqual(creationBuild.cgroupRoots, cgroupRoots)) throw new Error('production Linux runtime/source or cgroup identity differs')
    return { protocol: 'work-item-engineering-native-fixture/v1' as const, root, home, repository: source.repository,
      baselineCommit: commit, source, sourceBuild: { backend: 'linux-native' as const, repository: prepared, cgroupRoots }, creationBuild }
  })
  const path = join(root, 'native-resources.json')
  await writeFile(path, JSON.stringify(resources, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  return { path, resources }
}

// Explicit preparation command only; ordinary Vitest imports perform no setup.
if (process.argv[2] === '--prepare-macos' && process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = process.argv[3] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const result = await prepareEngineeringMacRuntime({ repository, ...(process.argv[4] ? { commit: process.argv[4] } : {}) })
  process.stdout.write(JSON.stringify({ resourcePath: result.path, baselineCommit: result.resources.baselineCommit }) + '\n')
}

if (process.argv[2] === '--prepare-linux' && process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[3] || !process.argv[4]) throw new Error('--prepare-linux requires explicit repository and commit')
  const result = await prepareEngineeringLinuxRuntime({ repository: process.argv[3], commit: process.argv[4] })
  process.stdout.write(JSON.stringify({ resourcePath: result.path, baselineCommit: result.resources.baselineCommit }) + '\n')
}
