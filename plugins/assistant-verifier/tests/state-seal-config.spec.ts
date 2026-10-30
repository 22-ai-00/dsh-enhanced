import { expect, test, vi } from 'vitest'
import { validateCreationBehaviorDeploymentConfig, validatePluginBehaviorDeploymentConfig,
  validatePluginBehaviorRunnerConfig, type LinuxPluginBehaviorRunnerConfig } from '../src/plugin-behavior-config.js'

// This deployment validator must stay usable in copied programs without loading
// Isolation's runtime or acquiring any state/kernel resources.
vi.mock('@dsh-enhanced/assistant-isolation', () => { throw new Error('unexpected Isolation runtime import') })

function linux(): LinuxPluginBehaviorRunnerConfig {
  const path = '/approved/behavior-runtime'
  return { backend: 'linux-native', stateRoot: '/approved/runner', authorityDigest: 'a'.repeat(64),
    expiresAt: Date.now() + 60_000, maxRuns: 2, maxTotalDurationMs: 60_000, maxDurationMs: 10_000, maxOutputBytes: 65_536,
    cgroupRoots: { mode: 'v1', cpu: '/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-1000',
      memory: '/sys/fs/cgroup/memory/dsh-native/uid-1000', pids: '/sys/fs/cgroup/pids/dsh-native/uid-1000',
      freezer: '/sys/fs/cgroup/freezer/dsh-native/uid-1000' },
    runtime: { schemaVersion: 1, runtime: { schemaVersion: 1, backend: 'linux-native',
      platform: `linux-${process.arch}` as 'linux-x64' | 'linux-arm64', sourceCommit: '1'.repeat(40),
      lockSha256: 'b'.repeat(64), nodeSha256: 'c'.repeat(64), root: { path, dev: 1, ino: 2, sha256: 'd'.repeat(64) },
      nodePath: path + '/bin/node', pnpmPath: path + '/pnpm/bin/pnpm.mjs', nativePnpmRoot: path + '/pnpm-native',
      nativePnpmPath: path + '/pnpm-native/pnpm', modulesPath: path + '/node_modules',
      storePath: path + '/store', cachePath: path + '/cache', versions: {
        node: 'v22.23.2', pnpm: '11.7.0', typescript: '6', cordis: '4', tools: '1', systemPrompt: '1' } },
      observer: { schemaVersion: 1, sourceSha256: 'e'.repeat(64), workerSha256: '1'.repeat(64), candidateSha256: '2'.repeat(64),
        launcherSha256: '3'.repeat(64), parentProtectSha256: '4'.repeat(64), childProtectSha256: '5'.repeat(64) } } }
}
const seal = () => ({ path: '/approved/seals/runner.json', sha256: 'a'.repeat(64) })

test('clones the optional Linux state seal while keeping unsealed and deployment configurations compatible', () => {
  const legacy = linux(), original = { ...legacy, stateSeal: seal() }
  expect(validatePluginBehaviorRunnerConfig(legacy)).toEqual(legacy)
  expect(validatePluginBehaviorRunnerConfig(legacy)).not.toHaveProperty('stateSeal')
  const checked = validatePluginBehaviorRunnerConfig(original)
  expect(checked).toEqual(original)
  expect(checked).not.toBe(original)
  expect('backend' in checked && checked.backend === 'linux-native' && checked.stateSeal).not.toBe(original.stateSeal)
  original.stateSeal.sha256 = 'b'.repeat(64)
  expect('backend' in checked && checked.backend === 'linux-native' && checked.stateSeal).toEqual(seal())
  const { authorityDigest: _authorityDigest, ...deployment } = { ...legacy, stateSeal: seal() }
  expect(validateCreationBehaviorDeploymentConfig(deployment)).toEqual(deployment)
  expect(() => validatePluginBehaviorDeploymentConfig(deployment)).toThrow('invalid plugin behavior deployment config')
})

test.each([
  undefined, null, [], false,
  { path: 'relative/seal.json', sha256: 'a'.repeat(64) },
  { path: '/approved/seals/../seal.json', sha256: 'a'.repeat(64) },
  { path: '/approved/runner', sha256: 'a'.repeat(64) },
  { path: '/approved/runner/seal.json', sha256: 'a'.repeat(64) },
  { path: '/approved/seal\t.json', sha256: 'a'.repeat(64) },
  { path: '/approved/seal\x7f.json', sha256: 'a'.repeat(64) },
  { path: '/approved/seal\\name.json', sha256: 'a'.repeat(64) },
  { path: '/', sha256: 'a'.repeat(64) },
  { path: '/approved/seal.json', sha256: 'A'.repeat(64) },
  { path: '/approved/seal.json', sha256: 'a'.repeat(63) },
  { path: '/approved/seal.json', sha256: 'z'.repeat(64) },
  { path: '/approved/seal.json', sha256: 'a'.repeat(64), extra: true },
])('rejects a malformed Linux behavior state seal %#', stateSeal => {
  expect(() => validatePluginBehaviorRunnerConfig({ ...linux(), stateSeal })).toThrow('Linux state seal')
})

test.each(['stateSeal', 'path', 'sha256'])('rejects %s accessors without evaluating them', field => {
  const stateSeal = seal(), config = { ...linux(), stateSeal }
  const getter = vi.fn(() => { throw new Error('getter executed') })
  Object.defineProperty(field === 'stateSeal' ? config : stateSeal, field, { enumerable: true, get: getter })
  expect(() => validatePluginBehaviorRunnerConfig(config)).toThrow()
  const { authorityDigest: _authorityDigest, ...deployment } = field === 'stateSeal'
    ? { ...linux(), stateSeal: seal() } : config
  if (field === 'stateSeal') Object.defineProperty(deployment, 'stateSeal', { enumerable: true, get: getter })
  expect(() => validateCreationBehaviorDeploymentConfig(deployment)).toThrow()
  expect(getter).not.toHaveBeenCalled()
})

test('rejects hidden fields, symbols and inherited seal authority', () => {
  for (const extra of ['hidden', Symbol('authority')]) {
    const stateSeal = seal()
    Object.defineProperty(stateSeal, extra, { value: true, enumerable: false })
    expect(() => validatePluginBehaviorRunnerConfig({ ...linux(), stateSeal })).toThrow('Linux state seal')
  }
  const stateSeal = Object.assign(Object.create({ inherited: true }) as object, seal())
  expect(() => validatePluginBehaviorRunnerConfig({ ...linux(), stateSeal })).toThrow('Linux state seal')
})

test('keeps Docker and macOS behavior configurations closed to Linux state seals', () => {
  const common = { stateRoot: '/approved/runner', authorityDigest: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
    maxRuns: 2, maxTotalDurationMs: 60_000, maxDurationMs: 10_000, maxOutputBytes: 65_536 }
  const docker = { ...common, dockerPath: '/usr/bin/docker', image: 'sha256:' + 'a'.repeat(64) }
  const native = { ...common, backend: 'macos-seatbelt' as const, runtime: { schemaVersion: 1 as const,
    platform: `darwin-${process.arch}` as 'darwin-x64' | 'darwin-arm64', nodePath: '/approved/mac-runtime/bin/node',
    nodeSha256: 'a'.repeat(64), modulesPath: '/approved/mac-runtime/node_modules',
    roots: [{ path: '/approved/mac-runtime', dev: 1, ino: 2, sha256: 'b'.repeat(64) }],
    versions: { node: 'v22.23.2', typescript: '6', cordis: '4', tools: '1', systemPrompt: '1' } } }
  for (const original of [docker, native]) {
    expect(validatePluginBehaviorRunnerConfig(original)).toEqual(original)
    expect(() => validatePluginBehaviorRunnerConfig({ ...original, stateSeal: seal() })).toThrow('runner config')
    const { authorityDigest: _authorityDigest, ...deployment } = original
    expect(validateCreationBehaviorDeploymentConfig(deployment)).toEqual(deployment)
    expect(() => validateCreationBehaviorDeploymentConfig({ ...deployment, stateSeal: seal() })).toThrow('runner config')
  }
})
