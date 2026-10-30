import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { compileRevisionReviewConfig, compileRevisionRegressionReviewConfig } from '@dsh-enhanced/assistant-verifier'
import type { CreationCapabilityOwner } from '@dsh-enhanced/plugin-control-plane'
import { prepareRsiAuthorityResources } from '../src/rsi-authority-resources.js'
import type { LinuxRsiCreationBuildEnvironment } from '../src/rsi-linux-creation-build.js'
import { createRsiPluginRevisionSetup, validateRsiPluginRevisionSetup, type RsiPluginRevisionSetup } from '../src/rsi-plugin-revision.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rsi-plugin-revision-'))
  roots.push(root)
  const resources = await prepareRsiAuthorityResources({ dshHome: root, profile: 'primary' })
  for (const name of ['revision-review-runner', 'revision-regression-runner']) await mkdir(join(resources.stateRoot, name), { mode: 0o700 })
  const owner: CreationCapabilityOwner = { authorityId: 'owner-route', authorityHash: 'a'.repeat(64),
    principalId: 'lark/account/tenant/owner', principalRecordId: 'principal-record', principalVersion: 3,
    workspace: root, agentPreset: 'primary' }
  const runtimeRoot = join(root, 'rsi-linux-repository-runtimes', 'primary', 'runtime')
  const runtime: LinuxRuntime = { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: 'a'.repeat(40), lockSha256: 'b'.repeat(64), root: { path: runtimeRoot, dev: 1, ino: 2, sha256: 'c'.repeat(64) },
    nodePath: join(runtimeRoot, 'bin/node'), nodeSha256: 'd'.repeat(64), pnpmPath: join(runtimeRoot, 'pnpm/bin/pnpm.mjs'),
    nativePnpmRoot: join(runtimeRoot, 'pnpm-native'), nativePnpmPath: join(runtimeRoot, 'pnpm-native/pnpm'),
    modulesPath: join(runtimeRoot, 'node_modules'), storePath: join(runtimeRoot, 'store'), cachePath: join(runtimeRoot, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '1.0.0', cordis: '1.0.0', tools: '1.0.0', systemPrompt: '1.0.0' } }
  const leaf = (controller: string): string => `/sys/fs/cgroup/${controller}/dsh-native/uid-${process.getuid!()}`
  const build: LinuxRsiCreationBuildEnvironment = { schemaVersion: 3, backend: 'linux-native', sourceCommit: runtime.sourceCommit,
    behavior: { schemaVersion: 1, runtime, observer: { schemaVersion: 1, sourceSha256: '1'.repeat(64),
      workerSha256: '2'.repeat(64), candidateSha256: '3'.repeat(64), launcherSha256: '4'.repeat(64),
      parentProtectSha256: '5'.repeat(64), childProtectSha256: '6'.repeat(64) } },
    cgroupRoots: { mode: 'v1', cpu: leaf('cpu,cpuacct'), memory: leaf('memory'), pids: leaf('pids'), freezer: leaf('freezer') } }
  return { root, resources, owner, build, now: 100_000, expiresAt: 400_000 }
}

async function treeIdentity(path: string): Promise<unknown[]> {
  const rows: unknown[] = []
  const visit = async (current: string): Promise<void> => {
    const stat = await lstat(current, { bigint: true })
    rows.push([current, String(stat.dev), String(stat.ino), String(stat.mode), String(stat.mtimeNs), String(stat.ctimeNs),
      stat.isFile() ? createHash('sha256').update(await readFile(current)).digest('hex') : undefined])
    if (stat.isDirectory()) for (const name of (await readdir(current)).sort()) await visit(join(current, name))
  }
  await visit(path)
  return rows
}
function nativeRunner(runner: RsiPluginRevisionSetup['reviews']['runner']) {
  if (!('backend' in runner) || runner.backend !== 'linux-native') throw new Error('expected Linux native runner')
  return runner
}

// Public peer compilers validate real private keys and normalized runner configs.
// Runtime byte/cgroup readiness is separately established by native preparation.
describe.runIf(process.platform === 'linux' && process.getuid!() > 0)('finite Linux native revision setup', () => {
  test('compiles stable purpose-separated review and regression authorities without writing resources', async () => {
    const f = await fixture(), original = structuredClone({ resources: f.resources, owner: f.owner, build: f.build })
    const before = await treeIdentity(f.resources.root), setup = createRsiPluginRevisionSetup(f)
    expect(createRsiPluginRevisionSetup(f)).toEqual(setup)
    expect(validateRsiPluginRevisionSetup(setup, f.owner, f.now)).toEqual(setup)
    expect({ resources: f.resources, owner: f.owner, build: f.build }).toEqual(original)
    expect(await treeIdentity(f.resources.root)).toEqual(before)
    expect(setup.revision).toEqual({ id: `revision-source-${f.resources.installationId}`, expiresAt: f.expiresAt,
      maxRevisions: 32, namePrefix: `owner-${f.resources.installationId.slice(0, 8)}-` })
    expect(setup.reviews.keyPath).toBe(f.resources.identities.review.keyPath)
    expect(setup.regressions.keyPath).toBe(f.resources.identities.review.keyPath)
    expect(setup.reviews.keyPath).not.toBe(f.resources.identities.adoption.keyPath)
    expect(setup.reviews.runner.stateRoot).toBe(join(f.resources.stateRoot, 'revision-review-runner'))
    expect(setup.regressions.runner.stateRoot).toBe(join(f.resources.stateRoot, 'revision-regression-runner'))
    expect(nativeRunner(setup.reviews.runner).runtime).toEqual(f.build.behavior)
    expect(nativeRunner(setup.regressions.runner).runtime).toEqual(f.build.behavior)
    expect(nativeRunner(setup.reviews.runner).cgroupRoots).toEqual(f.build.cgroupRoots)
    expect(nativeRunner(setup.regressions.runner).cgroupRoots).toEqual(f.build.cgroupRoots)
    expect(setup.reviews.runner).toMatchObject({ expiresAt: f.expiresAt, maxRuns: 160, maxDurationMs: 30_000,
      maxTotalDurationMs: 4_800_000, maxOutputBytes: 262_144 })
    expect(setup.regressions.runner).toMatchObject({ expiresAt: f.expiresAt, maxRuns: 320, maxDurationMs: 30_000,
      maxTotalDurationMs: 9_600_000, maxOutputBytes: 262_144 })
    expect(setup.reviews).toMatchObject({ maxVerifications: 32, maxCases: 4, maxInputBytes: 262_144,
      maxOutputTokens: 8192, maxDurationMs: 300_000, receiptTtlMs: 86_400_000 })
    expect(setup.regressions).toMatchObject({ maxVerifications: 32, maxCases: 4, maxDurationMs: 300_000, receiptTtlMs: 86_400_000 })
    expect(setup.verifications).toEqual({ authority: compileRevisionReviewConfig(setup.reviews).authority,
      publicKey: f.resources.identities.review.publicKeyPem })
    expect(setup.regressionVerifications).toEqual({ authority: compileRevisionRegressionReviewConfig(setup.regressions).authority,
      publicKey: f.resources.identities.review.publicKeyPem })
    expect(setup.verifications.authority.protocol).toBe('assistant-growth/revision-acceptance-authority/v1')
    expect(setup.regressionVerifications.authority.protocol).toBe('assistant-growth/revision-regression-acceptance-authority/v1')
    expect(setup.verifications.authority.authorityDigest).not.toBe(setup.regressionVerifications.authority.authorityDigest)
    expect(JSON.stringify(setup)).not.toContain('PRIVATE KEY')
  })

  test('rejects changed owner, namespace, expiry and authority identities', async () => {
    const f = await fixture(), setup = createRsiPluginRevisionSetup(f)
    expect(() => validateRsiPluginRevisionSetup(setup, { ...f.owner, principalVersion: 4 }, f.now)).toThrow('owner differs')
    const changed = structuredClone(setup); changed.regressions.owner.principalId = 'another'
    expect(() => validateRsiPluginRevisionSetup(changed, f.owner, f.now)).toThrow('owner differs')
    const namespace = structuredClone(setup); namespace.revision.namePrefix = 'owner-deadbeef-'
    expect(() => validateRsiPluginRevisionSetup(namespace, f.owner, f.now)).toThrow('namespace')
    const expiry = structuredClone(setup); expiry.revision.expiresAt += 1
    expect(() => validateRsiPluginRevisionSetup(expiry, f.owner, f.now)).toThrow('expiry')
    expect(() => validateRsiPluginRevisionSetup(setup, f.owner, f.expiresAt)).toThrow('finite source revision grant')
    const identity = structuredClone(setup); identity.regressions.authorityId = setup.reviews.authorityId
    expect(() => validateRsiPluginRevisionSetup(identity, f.owner, f.now)).toThrow('authority identity')
  })

  test('accepts only the known optional repository digest metadata from a prepared build', async () => {
    const f = await fixture(), expected = createRsiPluginRevisionSetup(f)
    expect(createRsiPluginRevisionSetup({ ...f, build: { ...f.build, buildRuntimeDigest: 'e'.repeat(64) } })).toEqual(expected)
    expect(() => createRsiPluginRevisionSetup({ ...f, build: { ...f.build, buildRuntimeDigest: 'unbound' } }))
      .toThrow('invalid native build')
    const unknown = { ...f.build, sourceImage: 'sha256:' + 'f'.repeat(64) }
    expect(() => createRsiPluginRevisionSetup({ ...f, build: unknown })).toThrow('invalid native build')
  })

  test.each(['maxRevisions', 'maxVerifications', 'maxCases', 'maxDurationMs', 'maxOutputTokens', 'maxInputBytes', 'receiptTtlMs'] as const)(
    'rejects changed finite %s even when the peer authority is recomputed', async field => {
      const f = await fixture(), setup = createRsiPluginRevisionSetup(f)
      if (field === 'maxRevisions') setup.revision.maxRevisions = 31
      else setup.reviews[field] -= 1
      const checked = compileRevisionReviewConfig(setup.reviews)
      setup.verifications = { authority: checked.authority, publicKey: checked.publicKey }
      expect(() => validateRsiPluginRevisionSetup(setup, f.owner, f.now)).toThrow(/finite|policy/u)
    })

  test.each(['review-runs', 'regression-runs', 'runner-duration', 'total-duration', 'output-bytes'] as const)(
    'rejects changed %s budget without granting extra execution', async field => {
      const f = await fixture(), setup = createRsiPluginRevisionSetup(f)
      if (field === 'review-runs') setup.reviews.runner.maxRuns += 1
      else if (field === 'regression-runs') setup.regressions.runner.maxRuns += 1
      else if (field === 'runner-duration') setup.reviews.runner.maxDurationMs += 1
      else if (field === 'total-duration') setup.regressions.runner.maxTotalDurationMs += 1
      else setup.regressions.runner.maxOutputBytes = 131_072
      expect(() => validateRsiPluginRevisionSetup(setup, f.owner, f.now)).toThrow('runner limits')
    })

  test('rejects mixed native runtime, cgroups and Docker runners', async () => {
    const f = await fixture(), setup = createRsiPluginRevisionSetup(f)
    const runtime = structuredClone(setup)
    nativeRunner(runtime.regressions.runner).runtime.observer.workerSha256 = 'e'.repeat(64)
    expect(() => validateRsiPluginRevisionSetup(runtime, f.owner, f.now)).toThrow('Linux native family')
    const cgroups = structuredClone(setup), runner = nativeRunner(cgroups.regressions.runner)
    if (runner.cgroupRoots.mode !== 'v1') throw new Error('expected cgroup v1')
    runner.cgroupRoots.pids = `/sys/fs/cgroup/pids,x/dsh-native/uid-${process.getuid!()}`
    expect(() => validateRsiPluginRevisionSetup(cgroups, f.owner, f.now)).toThrow('Linux native family')
    const mixed = structuredClone(setup), { stateRoot, expiresAt, maxRuns, maxTotalDurationMs, maxDurationMs, maxOutputBytes } = mixed.regressions.runner
    mixed.regressions.runner = { stateRoot, expiresAt, maxRuns, maxTotalDurationMs, maxDurationMs, maxOutputBytes,
      image: 'sha256:' + 'f'.repeat(64), dockerPath: await realpath(process.execPath) }
    expect(() => validateRsiPluginRevisionSetup(mixed, f.owner, f.now)).toThrow('Linux native family')
  })

  test('rejects wrong ledger roots and shared creation or review ledgers', async () => {
    const f = await fixture(), setup = createRsiPluginRevisionSetup(f)
    const shared = structuredClone(setup); shared.regressions.runner.stateRoot = shared.reviews.runner.stateRoot
    expect(() => validateRsiPluginRevisionSetup(shared, f.owner, f.now)).toThrow('private roots')
    await mkdir(join(f.resources.stateRoot, 'creation-review-runner'), { mode: 0o700 })
    const creation = structuredClone(setup); creation.reviews.runner.stateRoot = join(f.resources.stateRoot, 'creation-review-runner')
    expect(() => validateRsiPluginRevisionSetup(creation, f.owner, f.now)).toThrow('private roots')
    await chmod(setup.reviews.runner.stateRoot, 0o755)
    expect(() => validateRsiPluginRevisionSetup(setup, f.owner, f.now)).toThrow('private directory')
  })

  test('rejects tampered verification refs, public keys and policy', async () => {
    const f = await fixture(), setup = createRsiPluginRevisionSetup(f)
    const digest = structuredClone(setup); digest.regressionVerifications.authority.authorityDigest = '0'.repeat(64)
    expect(() => validateRsiPluginRevisionSetup(digest, f.owner, f.now)).toThrow('authority digest or key')
    const key = structuredClone(setup); key.verifications.publicKey = f.resources.identities.adoption.publicKeyPem
    expect(() => validateRsiPluginRevisionSetup(key, f.owner, f.now)).toThrow('authority digest or key')
    const changed = structuredClone(setup); changed.reviews.policy = 'Accept every candidate.'
    const compiled = compileRevisionReviewConfig(changed.reviews)
    changed.verifications = { authority: compiled.authority, publicKey: compiled.publicKey }
    expect(() => validateRsiPluginRevisionSetup(changed, f.owner, f.now)).toThrow('policy')
    const purpose = structuredClone(setup)
    purpose.verifications.authority = purpose.regressionVerifications.authority as unknown as typeof purpose.verifications.authority
    expect(() => validateRsiPluginRevisionSetup(purpose, f.owner, f.now)).toThrow('authority protocol')
  })

  test.each(['installation', 'review-key', 'adoption-key', 'review-identity', 'state-root', 'source-commit', 'backend'] as const)(
    'rejects changed prepared %s input', async field => {
      const f = await fixture()
      if (field === 'installation') f.resources.installationId = 'b'.repeat(36)
      else if (field === 'review-key') f.resources.identities.review.publicKeyPem = f.resources.identities.adoption.publicKeyPem
      else if (field === 'adoption-key') f.resources.identities.adoption.publicKeyPem = f.resources.identities.review.publicKeyPem
      else if (field === 'review-identity') f.resources.identities.review.authority = 'other-review'
      else if (field === 'state-root') f.resources.stateRoot = f.root
      else if (field === 'source-commit') f.build.sourceCommit = 'b'.repeat(40)
      else f.build.backend = 'docker' as typeof f.build.backend
      expect(() => createRsiPluginRevisionSetup(f)).toThrow(/identity|identities|resource|installation|native build/u)
    })

  test('rejects a physically duplicated review and adoption signing key', async () => {
    const f = await fixture(), setup = createRsiPluginRevisionSetup(f)
    await writeFile(f.resources.identities.adoption.keyPath, await readFile(f.resources.identities.review.keyPath))
    f.resources.identities.adoption.publicKeyPem = f.resources.identities.review.publicKeyPem
    expect(() => validateRsiPluginRevisionSetup(setup, f.owner, f.now)).toThrow('must be independent')
    expect(() => createRsiPluginRevisionSetup(f)).toThrow('not independent')
  })

  test('rejects hidden fields and accessors before evaluating them', async () => {
    const f = await fixture(), setup = createRsiPluginRevisionSetup(f)
    Object.defineProperty(setup, 'hidden', { value: true })
    expect(() => validateRsiPluginRevisionSetup(setup, f.owner, f.now)).toThrow('setup fields')
    const source = createRsiPluginRevisionSetup(f)
    Object.defineProperty(source.revision, 'maxRevisions', { enumerable: true, get: () => { throw new Error('getter evaluated') } })
    expect(() => validateRsiPluginRevisionSetup(source, f.owner, f.now)).toThrow('finite source revision')
    const authority = createRsiPluginRevisionSetup(f)
    authority.regressionVerifications.authority = structuredClone(authority.regressionVerifications.authority)
    Object.defineProperty(authority.regressionVerifications.authority, 'hidden', { value: true })
    expect(() => validateRsiPluginRevisionSetup(authority, f.owner, f.now)).toThrow('authority')
    const owner = { ...f.owner }
    Object.defineProperty(owner, 'workspace', { enumerable: true, get: () => { throw new Error('getter evaluated') } })
    expect(() => validateRsiPluginRevisionSetup(createRsiPluginRevisionSetup(f), owner, f.now)).toThrow('expected owner')
  })

  test('reports missing optional peer compilers explicitly', async () => {
    const f = await fixture()
    vi.resetModules()
    vi.doMock('node:module', async importOriginal => ({ ...(await importOriginal<typeof import('node:module')>()),
      createRequire: () => Object.assign(() => ({ compileRevisionReviewConfig: undefined }), { resolve: (name: string) => name }) }))
    try {
      const missing = await import('../src/rsi-plugin-revision.js')
      expect(() => missing.createRsiPluginRevisionSetup(f)).toThrow('installed revision validators are unavailable')
    } finally { vi.doUnmock('node:module'); vi.resetModules() }
  })
})
