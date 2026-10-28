import { resolve } from 'node:path'
import { canonicalGrowthJson, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { nativeMacRuntimeDigest, type NativeMacRuntime } from '@dsh-enhanced/assistant-isolation'
import { linuxPluginBehaviorRuntimeDigest, type LinuxPluginBehaviorRuntime } from '@dsh-enhanced/assistant-verifier/linux-behavior-runtime'
import { afterEach, beforeEach, expect, test as nativeTest, vi } from 'vitest'
import { creationCapabilityExecutionMatches, validateLinuxCreationCapabilityRunner,
  verifyCreationCapabilityExecution } from '../src/creation-capability-execution.js'
import type { CreationCapabilityConfig } from '../src/creation-capability-types.js'

// These descriptors intentionally require Linux canonical paths and cgroup roots.
const test = nativeTest.runIf(process.platform === 'linux')

const verifier = vi.hoisted(() => ({ verify: vi.fn() }))
vi.mock('@dsh-enhanced/assistant-verifier/linux-behavior-runtime', async importOriginal => ({
  ...await importOriginal<typeof import('@dsh-enhanced/assistant-verifier/linux-behavior-runtime')>(),
  verifyLinuxPluginBehaviorAdoptionRuntime: verifier.verify,
}))
beforeEach(() => { verifier.verify.mockReset().mockResolvedValue(undefined) })
afterEach(() => { vi.restoreAllMocks() })

const hash = (character: string) => character.repeat(64)
function fixture() {
  const root = resolve('fixture-execution-observer/runtime'), now = Date.now()
  const runtime: LinuxPluginBehaviorRuntime = { schemaVersion: 1,
    runtime: { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as 'linux-x64' | 'linux-arm64',
      sourceCommit: '1'.repeat(40), lockSha256: hash('2'), root: { path: root, dev: 1, ino: 2, sha256: hash('3') },
      nodePath: resolve(root, 'bin/node'), nodeSha256: hash('4'), pnpmPath: resolve(root, 'pnpm/bin/pnpm.mjs'),
      nativePnpmPath: resolve(root, 'pnpm-native/pnpm'), nativePnpmRoot: resolve(root, 'pnpm-native'),
      modulesPath: resolve(root, 'node_modules'), storePath: resolve(root, 'store'), cachePath: resolve(root, 'cache'),
      versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5',
        tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } },
    observer: { schemaVersion: 1, sourceSha256: hash('5'), workerSha256: hash('6'), candidateSha256: hash('7'),
      launcherSha256: hash('8'), parentProtectSha256: hash('9'), childProtectSha256: hash('a') } }
  const runner = { backend: 'linux-native' as const, runtime, stateRoot: resolve(root, '../../state'),
    cgroupRoots: { mode: 'v1' as const, cpu: '/sys/fs/cgroup/cpu/dsh-native/uid-1000', memory: '/sys/fs/cgroup/memory/dsh-native/uid-1000',
      pids: '/sys/fs/cgroup/pids/dsh-native/uid-1000', freezer: '/sys/fs/cgroup/freezer/dsh-native/uid-1000' },
    expiresAt: now + 300_000, maxRuns: 8, maxTotalDurationMs: 60_000, maxDurationMs: 10_000, maxOutputBytes: 65_536 }
  // Signature authenticity is the journal's boundary. This helper receives the
  // complete already-validated payload and checks execution/provenance only.
  const certificate: PluginCreationVerificationCertificate = {
    protocol: 'assistant-growth/creation-verification/v3', verificationId: 'verification-1',
    authority: { protocol: 'assistant-growth/creation-acceptance-authority/v1', authorityId: 'verifier',
      keyId: 'fixture-key', authorityDigest: hash('b'), namePrefix: 'tool-', expiresAt: now + 60_000 },
    plan: { id: 'plan-1', digest: hash('a'), name: 'tool-example', sourceTreeDigest: hash('1'),
      sourcePatchDigest: hash('2'), artifactSha256: hash('3'), artifactBytes: 10, generatorDigest: hash('4') },
    source: { referenceDigest: hash('4'), ownerDigest: hash('5'), growthRunDigest: hash('6') },
    contractDigest: hash('7'), schemaDigest: hash('8'), environment: { node: 'v22.23.2', cordis: '4.0.5',
      tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' }, model: { provider: 'fixture', model: 'fixture' },
    budget: { modelCalls: 2, maxOutputTokens: 1_024, maxDurationMs: 10_000, maxCases: 2 },
    sessions: { contract: 'contract-1', sourceReview: 'review-1' }, observations: [
      { caseId: 'case-1', jobId: 'job-1', operationDigest: hash('8'), observationDigest: hash('9') },
      { caseId: 'case-2', jobId: 'job-2', operationDigest: hash('a'), observationDigest: hash('b') }],
    execution: { boundary: 'linux-native-process-seccomp-v1', runtimeDigest: linuxPluginBehaviorRuntimeDigest(runtime),
      buildEvidenceDigest: hash('c'), buildRuntimeDigest: hash('d'), observerPreparationDigest: hash('e') },
    reviewDigest: hash('c'), verifiedAt: now, expiresAt: now + 60_000, signature: 'journal-validated-fixture',
  }
  return { certificate, runner, runtime, signal: new AbortController().signal }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('Linux matching and deployment validation are synchronous, resource-free and exact', () => {
  const f = fixture(), before = canonicalGrowthJson({ certificate: f.certificate, runner: f.runner })
  // AbortSignal is intentionally outside the protocol snapshot.
  expect(creationCapabilityExecutionMatches(f.certificate, f.runner)).toBe(true)
  expect(() => validateLinuxCreationCapabilityRunner(f.runner)).not.toThrow()
  expect(verifier.verify).not.toHaveBeenCalled()
  expect(canonicalGrowthJson({ certificate: f.certificate, runner: f.runner })).toBe(before)
  f.runtime.observer.workerSha256 = hash('f')
  expect(creationCapabilityExecutionMatches(f.certificate, f.runner)).toBe(false)
  expect(() => validateLinuxCreationCapabilityRunner({ ...f.runner, authorityDigest: hash('a') })).toThrow()
})

test('Linux validation receives an independent descriptor clone and the signed preparation/base digests', async () => {
  const f = fixture()
  await verifyCreationCapabilityExecution(f.certificate, f.runner, f.signal)
  expect(verifier.verify).toHaveBeenCalledOnce()
  const input = verifier.verify.mock.calls[0]![0] as { runtime: LinuxPluginBehaviorRuntime; buildRuntimeDigest: string; preparationDigest: string }
  expect(input.runtime).toEqual(f.runtime)
  expect(input.runtime).not.toBe(f.runtime)
  expect(input.runtime.runtime).not.toBe(f.runtime.runtime)
  expect(input.runtime.observer).not.toBe(f.runtime.observer)
  expect(linuxPluginBehaviorRuntimeDigest(input.runtime)).toBe(f.certificate.execution!.runtimeDigest)
  expect(input).toMatchObject({ buildRuntimeDigest: hash('d'), preparationDigest: hash('e') })
})

const mutations = {
  buildEvidenceDigest: (f: ReturnType<typeof fixture>) => { f.certificate.execution!.buildEvidenceDigest = hash('f') },
  buildRuntimeDigest: (f: ReturnType<typeof fixture>) => {
    if (f.certificate.execution!.boundary === 'linux-native-process-seccomp-v1') f.certificate.execution!.buildRuntimeDigest = hash('f')
  },
  observerPreparationDigest: (f: ReturnType<typeof fixture>) => {
    if (f.certificate.execution!.boundary === 'linux-native-process-seccomp-v1') f.certificate.execution!.observerPreparationDigest = hash('f')
  },
  certificateOwner: (f: ReturnType<typeof fixture>) => { f.certificate.source.ownerDigest = hash('f') },
  certificateSignature: (f: ReturnType<typeof fixture>) => { f.certificate.signature = 'replacement-signature' },
  runnerBudget: (f: ReturnType<typeof fixture>) => { f.runner.maxRuns++ },
  runnerDeadline: (f: ReturnType<typeof fixture>) => { f.runner.expiresAt++ },
  runnerStateRoot: (f: ReturnType<typeof fixture>) => { f.runner.stateRoot += '-replacement' },
  cgroupAuthority: (f: ReturnType<typeof fixture>) => { f.runner.cgroupRoots.cpu += '-replacement' },
  runtimeDescriptor: (f: ReturnType<typeof fixture>) => { f.runtime.observer.workerSha256 = hash('f') },
}
test.each(Object.keys(mutations) as (keyof typeof mutations)[])('Linux %s mutation while verification awaits cannot pass', async name => {
  const f = fixture(), entered = deferred(), release = deferred()
  verifier.verify.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
  const checking = verifyCreationCapabilityExecution(f.certificate, f.runner, f.signal)
  const denied = expect(checking).rejects.toThrow('runtime authority changed')
  await entered.promise
  mutations[name](f)
  release.resolve()
  await denied
})

test('retained verification accepts an already expired certificate without rereading the original build', async () => {
  const f = fixture()
  f.certificate.expiresAt = Date.now() - 1
  f.certificate.authority.expiresAt = Date.now() - 1
  await expect(verifyCreationCapabilityExecution(f.certificate, f.runner, f.signal)).resolves.toBeUndefined()
  expect(verifier.verify).toHaveBeenCalledOnce()
})

test('pre-aborted or expired runner authority never enters provenance verification', async () => {
  const f = fixture(), cancellation = new AbortController()
  cancellation.abort()
  await expect(verifyCreationCapabilityExecution(f.certificate, f.runner, cancellation.signal)).rejects.toThrow()
  f.runner.expiresAt = Date.now() - 1
  await expect(verifyCreationCapabilityExecution(f.certificate, f.runner, f.signal)).rejects.toThrow('runner expired')
  expect(verifier.verify).not.toHaveBeenCalled()
})

test('cancellation reaches the verifier and late successful verification is suppressed', async () => {
  const f = fixture(), cancellation = new AbortController(), entered = deferred()
  verifier.verify.mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
    entered.resolve()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  const checking = verifyCreationCapabilityExecution(f.certificate, f.runner, cancellation.signal)
  const denied = expect(checking).rejects.toThrow()
  await entered.promise
  cancellation.abort()
  await denied
})

test('the finite deadline aborts verification and suppresses its late successful return', async () => {
  const f = fixture(), deadline = new AbortController(), entered = deferred()
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  verifier.verify.mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
    entered.resolve()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  const checking = verifyCreationCapabilityExecution(f.certificate, f.runner, f.signal)
  const denied = expect(checking).rejects.toThrow('controlled deadline expired')
  await entered.promise
  deadline.abort(new Error('controlled deadline expired'))
  await denied
})

test('read-only provenance verification failure is propagated without accepting the runtime', async () => {
  const f = fixture()
  verifier.verify.mockRejectedValueOnce(new Error('signed preparation identity differs'))
  await expect(verifyCreationCapabilityExecution(f.certificate, f.runner, f.signal)).rejects.toThrow('signed preparation identity differs')
  expect(verifier.verify).toHaveBeenCalledOnce()
})

test.each([5_000, 300_000])('Linux verification deadline is bounded by runner authority and 120 seconds (%i ms)', async lifetime => {
  const f = fixture(), now = Date.now(), timeout = vi.spyOn(AbortSignal, 'timeout')
  vi.spyOn(Date, 'now').mockReturnValue(now)
  f.runner.expiresAt = now + lifetime
  await verifyCreationCapabilityExecution(f.certificate, f.runner, f.signal)
  expect(timeout).toHaveBeenCalledWith(Math.min(120_000, lifetime))
})

test('runner expiry during a successful asynchronous verification suppresses completion', async () => {
  const f = fixture(), now = Date.now(), entered = deferred(), release = deferred()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  verifier.verify.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
  const checking = verifyCreationCapabilityExecution(f.certificate, f.runner, f.signal)
  const denied = expect(checking).rejects.toThrow('runtime authority changed')
  await entered.promise
  clock.mockReturnValue(f.runner.expiresAt)
  release.resolve()
  await denied
})

test('legacy Docker/macOS execution retains its protocol fence without Linux verification', async () => {
  const f = fixture(), root = resolve('fixture-macos-runtime')
  const mac: NativeMacRuntime = { schemaVersion: 1, platform: `darwin-${process.arch}` as NativeMacRuntime['platform'],
    nodePath: resolve(root, 'node'), nodeSha256: hash('a'), modulesPath: resolve(root, 'node_modules'),
    roots: [{ path: root, dev: 1, ino: 2, sha256: hash('b') }], versions: { ...f.certificate.environment, typescript: '6.0.3' } }
  const { backend: _backend, runtime: _runtime, cgroupRoots: _cgroups, ...common } = f.runner
  const docker: CreationCapabilityConfig['runner'] = { ...common, dockerPath: '/usr/bin/docker', image: 'sha256:' + hash('a') }
  const macRunner: CreationCapabilityConfig['runner'] = { ...common, backend: 'macos-seatbelt', runtime: mac }
  const certificate = structuredClone(f.certificate)
  certificate.protocol = 'assistant-growth/creation-verification/v1'
  delete certificate.execution
  expect(creationCapabilityExecutionMatches(certificate, docker)).toBe(true)
  expect(creationCapabilityExecutionMatches(certificate, f.runner)).toBe(false)
  await verifyCreationCapabilityExecution(certificate, docker, f.signal)
  certificate.protocol = 'assistant-growth/creation-verification/v2'
  certificate.execution = { boundary: 'macos-seatbelt-single-process-v1', runtimeDigest: nativeMacRuntimeDigest(mac), buildEvidenceDigest: hash('c') }
  expect(creationCapabilityExecutionMatches(certificate, macRunner)).toBe(true)
  expect(creationCapabilityExecutionMatches(certificate, docker)).toBe(false)
  await verifyCreationCapabilityExecution(certificate, macRunner, f.signal)
  const matchingMacDigest = { ...f.certificate, execution: { ...f.certificate.execution!, runtimeDigest: nativeMacRuntimeDigest(mac) } }
  expect(creationCapabilityExecutionMatches(matchingMacDigest, macRunner)).toBe(false)
  expect(creationCapabilityExecutionMatches(f.certificate, docker)).toBe(false)
  await expect(verifyCreationCapabilityExecution(f.certificate, macRunner, f.signal)).rejects.toThrow('runtime changed')
  expect(verifier.verify).not.toHaveBeenCalled()
})
