import { createHash } from 'node:crypto'
import type { IsolationResult } from '@dsh-enhanced/assistant-isolation'
import { beforeEach, expect, it, vi } from 'vitest'

const seam = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(), verify: vi.fn(), configs: [] as unknown[] }))
vi.mock('@dsh-enhanced/assistant-isolation', async importOriginal => ({
  ...await importOriginal<typeof import('@dsh-enhanced/assistant-isolation')>(),
  LinuxVerifierRunner: class {
    constructor(config: unknown) { seam.configs.push(config) }
    run(...args: unknown[]) { return seam.run(...args) }
    close() { return seam.close() }
  },
}))
vi.mock('../src/linux-behavior-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/linux-behavior-runtime.js')>(),
  verifyLinuxPluginBehaviorRuntime: (...args: unknown[]) => seam.verify(...args),
}))

import { LINUX_BEHAVIOR_BOUNDARY, LINUX_BEHAVIOR_COMMAND, PluginBehaviorRunner,
  linuxPluginBehaviorRuntimeDigest, validatePluginBehaviorDeploymentConfig, validatePluginBehaviorRunnerConfig,
  type LinuxPluginBehaviorRunnerConfig } from '../src/plugin-behavior-runner.js'

const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const artifact = Buffer.from('opaque tgz: host parser belongs to the fixed parent observer')
const artifactSha256 = sha(artifact)
const schemas = [{ name: 'native_probe', parameters: { type: 'object', properties: {} } }]
const schemaDigest = sha(JSON.stringify(schemas))
const environment = { node: 'v22.23.2' as const, cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' }
const signal = new AbortController().signal
function config(): LinuxPluginBehaviorRunnerConfig {
  const path = '/private/linux-behavior/runtime'
  return { backend: 'linux-native', stateRoot: '/private/linux-behavior-state', authorityDigest: 'a'.repeat(64),
    expiresAt: Date.now() + 120_000, maxRuns: 3, maxTotalDurationMs: 30_000, maxDurationMs: 10_000, maxOutputBytes: 65_536,
    cgroupRoots: { mode: 'v1', cpu: '/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-1000',
      memory: '/sys/fs/cgroup/memory/dsh-native/uid-1000', pids: '/sys/fs/cgroup/pids/dsh-native/uid-1000',
      freezer: '/sys/fs/cgroup/freezer/dsh-native/uid-1000' },
    runtime: { schemaVersion: 1, runtime: { schemaVersion: 1, backend: 'linux-native',
      platform: `linux-${process.arch}` as 'linux-x64' | 'linux-arm64', sourceCommit: '1'.repeat(40),
      lockSha256: 'b'.repeat(64), nodeSha256: 'c'.repeat(64), root: { path, dev: 1, ino: 2, sha256: 'd'.repeat(64) },
      nodePath: path + '/bin/node', pnpmPath: path + '/pnpm/bin/pnpm.mjs', nativePnpmRoot: path + '/pnpm-native',
      nativePnpmPath: path + '/pnpm-native/pnpm', modulesPath: path + '/node_modules',
      storePath: path + '/store', cachePath: path + '/cache', versions: { ...environment, pnpm: '11.7.0', typescript: '6.0.3' } },
    observer: { schemaVersion: 1, sourceSha256: 'e'.repeat(64), workerSha256: '1'.repeat(64), candidateSha256: '2'.repeat(64),
      launcherSha256: '3'.repeat(64), parentProtectSha256: '4'.repeat(64), childProtectSha256: '5'.repeat(64) } } }
}
const frame = (extra: Record<string, unknown> = {}) => ({ schemaVersion: 2, boundary: 'process-seccomp-v1',
  status: 'observed', artifactSha256, quiescent: true, environment, schemaDigest, schemas, ...extra })
const result = (value: unknown): IsolationResult => ({ status: 'succeeded', jobId: 'job-linux-1', quiescent: true,
  exitCode: 0, stdout: JSON.stringify(value) + '\n', stderr: '', artifacts: [] })
const input = (key = 'linux-discover', caller = signal) => ({ key, artifact, operation: { kind: 'discover' as const }, signal: caller })
beforeEach(() => {
  seam.configs.length = 0
  seam.run.mockReset().mockResolvedValue(result(frame()))
  seam.verify.mockReset().mockImplementation(async value => value)
  seam.close.mockReset().mockResolvedValue(undefined)
})

it('accepts only a private Linux runner config and keeps deployment reviews closed', () => {
  const authority = config(), checked = validatePluginBehaviorRunnerConfig(authority)
  expect(checked).toEqual(authority)
  expect(checked).not.toBe(authority)
  const { authorityDigest: _digest, ...deployment } = authority
  expect(() => validatePluginBehaviorDeploymentConfig(deployment)).toThrow('invalid plugin behavior deployment config')
  expect(seam.configs).toEqual([])
  expect(seam.verify).not.toHaveBeenCalled()
})

it.each(['command', 'source', 'image', 'limits', 'socketPath', 'extra'])('rejects caller %s before constructing a runner', field => {
  expect(() => new PluginBehaviorRunner({ ...config(), [field]: 'caller-controlled' } as never)).toThrow()
  expect(seam.configs).toEqual([])
})

it.each([
  (value: LinuxPluginBehaviorRunnerConfig) => ({ ...value, maxOutputBytes: 65_535 }),
  (value: LinuxPluginBehaviorRunnerConfig) => ({ ...value, stateRoot: '/' }),
  (value: LinuxPluginBehaviorRunnerConfig) => ({ ...value, maxDurationMs: value.maxTotalDurationMs + 1 }),
  (value: LinuxPluginBehaviorRunnerConfig) => ({ ...value, cgroupRoots: { mode: 'v2', unified: '/sys/fs/cgroup/dsh-native/uid-1000' } }),
  (value: LinuxPluginBehaviorRunnerConfig) => ({ ...value, cgroupRoots: { ...value.cgroupRoots, extra: true } }),
  (value: LinuxPluginBehaviorRunnerConfig) => ({ ...value, runtime: { ...value.runtime, extra: true } }),
  (value: LinuxPluginBehaviorRunnerConfig) => ({ ...value, runtime: { ...value.runtime, observer: { ...value.runtime.observer, workerSha256: 'bad' } } }),
  (value: LinuxPluginBehaviorRunnerConfig) => ({ ...value, runtime: { ...value.runtime, runtime: { ...value.runtime.runtime, sourceCommit: '0'.repeat(40) } } }),
])('rejects invalid finite authority, cgroups and runtime shapes', change => {
  expect(() => validatePluginBehaviorRunnerConfig(change(config()))).toThrow()
})

it.each(['backend', 'runtime', 'observer', 'versions', 'cgroupRoots', 'cpu'])('rejects %s accessors without evaluating them', field => {
  const authority = config(), getter = vi.fn(() => { throw new Error('getter executed') })
  const target = field === 'observer' ? authority.runtime : field === 'versions' ? authority.runtime.runtime
    : field === 'cpu' ? authority.cgroupRoots : authority
  Object.defineProperty(target, field, { enumerable: true, get: getter })
  expect(() => validatePluginBehaviorRunnerConfig(authority)).toThrow()
  expect(getter).not.toHaveBeenCalled()
})

it('rejects hidden and symbol config fields, including nested runtime metadata', () => {
  for (const target of ['top', 'runtime', 'observer', 'versions', 'root', 'cgroups']) {
    for (const field of ['hidden', Symbol('authority')]) {
      const authority = config()
      const object = target === 'runtime' ? authority.runtime : target === 'observer' ? authority.runtime.observer
        : target === 'versions' ? authority.runtime.runtime.versions : target === 'root' ? authority.runtime.runtime.root
          : target === 'cgroups' ? authority.cgroupRoots : authority
      Object.defineProperty(object, field, { value: true, enumerable: false })
      expect(() => validatePluginBehaviorRunnerConfig(authority)).toThrow()
    }
  }
})

it('uses fixed parent/candidate command, exact runtime environment and the ordinary durable runner', async () => {
  const authority = config(), digest = linuxPluginBehaviorRuntimeDigest(authority.runtime)
  const runner = new PluginBehaviorRunner(authority)
  authority.runtime.runtime.versions.tools = 'mutated-after-construction'
  const observation = await runner.run(input())
  expect(observation).toMatchObject({ status: 'observed', quiescent: true, boundary: LINUX_BEHAVIOR_BOUNDARY,
    runtimeDigest: digest, artifactSha256, schemaDigest, environment })
  const received = seam.configs[0] as Record<string, unknown>
  expect(received).toMatchObject({ backend: 'linux-native', command: LINUX_BEHAVIOR_COMMAND,
    maxRuns: 3, maxTotalDurationMs: 30_000, runtime: { versions: environment } })
  expect(received).not.toHaveProperty('limits')
  expect(received).not.toHaveProperty('source')
  expect(seam.verify).toHaveBeenCalledOnce()
  expect(seam.run).toHaveBeenCalledWith('linux-discover', artifact.toString('base64'), JSON.stringify({
    schemaVersion: 1, sha256: artifactSha256, sizeBytes: artifact.length, operation: { kind: 'discover' },
  }), expect.any(AbortSignal))
  await runner.close()
})

it('verifies again before each dispatch and does not admit drift or retry the failure', async () => {
  const runner = new PluginBehaviorRunner(config())
  expect((await runner.run(input('first'))).status).toBe('observed')
  seam.verify.mockRejectedValueOnce(new Error('worker asset drift'))
  expect(await runner.run(input('second'))).toMatchObject({ status: 'unknown', quiescent: false,
    reason: 'plugin-behavior-runtime-invalid' })
  expect(seam.verify).toHaveBeenCalledTimes(2)
  expect(seam.run).toHaveBeenCalledOnce()
  await runner.close()
})

it.each([
  ['wrong worker boundary', frame({ boundary: LINUX_BEHAVIOR_BOUNDARY })],
  ['macOS single process boundary', frame({ boundary: 'macos-seatbelt-single-process-v1' })],
  ['wrong schema version', frame({ schemaVersion: 1 })],
  ['wrong environment version', frame({ environment: { ...environment, node: 'v22.0.0' } })],
  ['extra environment field', frame({ environment: { ...environment, injected: 'candidate' } })],
  ['extra parent field', frame({ candidateClaim: 'approved' })],
  ['candidate protocol frame', { wireVersion: 1, status: 'result', schemas }],
  ['wrong artifact', frame({ artifactSha256: '0'.repeat(64) })],
  ['wrong schema digest', frame({ schemaDigest: '0'.repeat(64) })],
  ['empty schemas', frame({ schemas: [] })],
])('rejects %s without fabricating an observation', async (_label, value) => {
  seam.run.mockResolvedValue(result(value))
  const runner = new PluginBehaviorRunner(config())
  expect((await runner.run(input())).status).toBe('unknown')
  expect(seam.run).toHaveBeenCalledOnce()
  await runner.close()
})

it.each(['pollution', 'oversize', 'no-newline', 'two-frames'])('rejects %s in the fixed parent output', async mode => {
  const valid = JSON.stringify(frame())
  const stdout = mode === 'pollution' ? 'candidate says observed\n' + valid + '\n'
    : mode === 'oversize' ? ' '.repeat(65_536) + valid + '\n' : mode === 'no-newline' ? valid : valid + '\n' + valid + '\n'
  seam.run.mockResolvedValue({ ...result(frame()), stdout })
  const runner = new PluginBehaviorRunner(config())
  expect(await runner.run(input())).toMatchObject({ status: 'unknown', reason: 'plugin-worker-output-invalid' })
  await runner.close()
})

it('passes identical same-key bytes to durable history and never retries an unknown execution', async () => {
  const runner = new PluginBehaviorRunner(config())
  seam.run.mockResolvedValue({ ...result(frame()), status: 'unknown', quiescent: false, reason: 'verification-in-progress-no-replay' })
  for (let attempt = 0; attempt < 2; attempt++) expect(await runner.run(input('same-key')))
    .toMatchObject({ status: 'unknown', quiescent: false, reason: 'verification-in-progress-no-replay' })
  expect(seam.run).toHaveBeenCalledTimes(2)
  expect(seam.run.mock.calls[0]!.slice(0, 3)).toEqual(seam.run.mock.calls[1]!.slice(0, 3))
  await runner.close()
})

it('does not claim historical same-key resources are quiescent when a later observer check fails', async () => {
  const runner = new PluginBehaviorRunner(config())
  seam.run.mockResolvedValue({ ...result(frame()), status: 'unknown', quiescent: false, reason: 'verification-dispatch-unconfirmed' })
  expect(await runner.run(input('historical-unknown'))).toMatchObject({ status: 'unknown', quiescent: false })
  seam.verify.mockRejectedValueOnce(new Error('drift'))
  expect(await runner.run(input('historical-unknown'))).toMatchObject({ status: 'unknown', quiescent: false,
    reason: 'plugin-behavior-runtime-invalid' })
  expect(seam.run).toHaveBeenCalledOnce()
  await runner.close()
})

it('retains the frozen invoke operation while asynchronous runtime verification is pending', async () => {
  let release!: () => void
  seam.verify.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
  const operation = { kind: 'invoke' as const, schemaDigest, calls: [{ id: 'original', toolName: 'native_probe', arguments: { text: 'original' } }] }
  seam.run.mockResolvedValue(result(frame({ schemas: undefined, calls: [{ id: 'original', toolName: 'native_probe', result: 'original' }] })))
  const runner = new PluginBehaviorRunner(config())
  const pending = runner.run({ ...input(), operation })
  operation.calls[0]!.id = 'mutated'
  operation.calls[0]!.arguments.text = 'mutated'
  release()
  expect(await pending).toMatchObject({ status: 'observed', calls: [{ id: 'original', result: 'original' }] })
  expect(JSON.parse(seam.run.mock.calls[0]![2]).operation.calls[0]).toEqual({ id: 'original', toolName: 'native_probe', arguments: { text: 'original' } })
  await runner.close()
})

it.each(['caller', 'close'] as const)('cancels pending verification on %s and waits for its cleanup before closing', async mode => {
  let finish!: () => void, observedAbort = false, verificationFinished = false, closed = false
  seam.verify.mockImplementation((_runtime: unknown, verifying: AbortSignal) => new Promise<void>((_resolve, reject) => {
    verifying.addEventListener('abort', () => {
      observedAbort = true
      finish = () => { verificationFinished = true; reject(new Error('aborted verification')) }
    }, { once: true })
  }))
  const runner = new PluginBehaviorRunner(config()), abort = new AbortController()
  const pending = runner.run(input('cancel', abort.signal))
  if (mode === 'caller') abort.abort()
  const closing = runner.close().then(() => { closed = true })
  await Promise.resolve()
  expect(observedAbort).toBe(true)
  expect(closed).toBe(false)
  expect(verificationFinished).toBe(false)
  expect(seam.run).not.toHaveBeenCalled()
  finish()
  expect(await pending).toMatchObject({ status: 'unknown', quiescent: false })
  await closing
  await runner.close()
  expect(closed).toBe(true)
  expect(verificationFinished).toBe(true)
  expect(seam.close).toHaveBeenCalledOnce()
  expect((await runner.run(input('late'))).status).toBe('unknown')
  expect(seam.verify).toHaveBeenCalledOnce()
})

it('forwards cancellation into admitted execution and suppresses a late successful frame', async () => {
  let finish!: () => void
  seam.run.mockImplementation((_key: string, _artifact: string, _stdin: string, executing: AbortSignal) => new Promise<IsolationResult>(resolve => {
    executing.addEventListener('abort', () => { finish = () => resolve(result(frame())) }, { once: true })
  }))
  const runner = new PluginBehaviorRunner(config()), abort = new AbortController()
  const pending = runner.run(input('late-result', abort.signal))
  await vi.waitFor(() => expect(seam.run).toHaveBeenCalledOnce())
  abort.abort()
  finish()
  expect(await pending).toMatchObject({ status: 'unknown', quiescent: true, reason: 'plugin-behavior-unavailable' })
  await runner.close()
})

it('bounds verification by authority expiry without detaching its cleanup', async () => {
  vi.useFakeTimers()
  try {
    let verifying: AbortSignal | undefined
    seam.verify.mockImplementation((_runtime: unknown, current: AbortSignal) => {
      verifying = current
      return new Promise<void>((_resolve, reject) => current.addEventListener('abort', () => reject(new Error('expired')), { once: true }))
    })
    const runner = new PluginBehaviorRunner({ ...config(), expiresAt: Date.now() + 100 })
    const pending = runner.run(input())
    await vi.advanceTimersByTimeAsync(100)
    expect(verifying?.aborted).toBe(true)
    expect(await pending).toMatchObject({ status: 'unknown', quiescent: false, reason: 'plugin-behavior-unavailable' })
    expect(seam.run).not.toHaveBeenCalled()
    await runner.close()
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
