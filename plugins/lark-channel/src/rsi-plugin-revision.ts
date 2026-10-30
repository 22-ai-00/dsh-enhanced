import { createPrivateKey, createPublicKey } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { validateRevisionAcceptanceAuthorityRef, validateRevisionRegressionAcceptanceAuthorityRef,
  type RevisionAcceptanceAuthorityRef, type RevisionRegressionAcceptanceAuthorityRef } from '@dsh-enhanced/assistant-growth-contract'
import type { RevisionReviewConfig, RevisionRegressionReviewConfig } from '@dsh-enhanced/assistant-verifier'
import type { LinuxRunnerStateSeal } from '@dsh-enhanced/assistant-isolation'
import type { Config as ControlPlaneConfig, CreationCapabilityOwner } from '@dsh-enhanced/plugin-control-plane'
import { rsiAuthorityRoles, type RsiAuthorityResources } from './rsi-authority-resources.js'
import type { LinuxRsiCreationBuildEnvironment } from './rsi-linux-creation-build.js'

export type SourceRevisionGrant = NonNullable<NonNullable<ControlPlaneConfig['sourceJobs']>['revision']>
export interface RsiPluginRevisionSetup {
  reviews: RevisionReviewConfig
  regressions: RevisionRegressionReviewConfig
  revision: SourceRevisionGrant
  verifications: { authority: RevisionAcceptanceAuthorityRef; publicKey: string }
  regressionVerifications: { authority: RevisionRegressionAcceptanceAuthorityRef; publicKey: string }
}

const limits = { revisions: 32, verifications: 32, cases: 4, reviewRuns: 160, regressionRuns: 320,
  runnerDurationMs: 30_000, outputBytes: 262_144, reviewInputBytes: 262_144, reviewOutputTokens: 8_192,
  durationMs: 300_000, receiptTtlMs: 86_400_000 } as const
const policy = 'Derive concrete held-out behavior cases from the current authenticated task and feedback. Independently check the exact adopted parent, candidate patch, outputs, scope and lifecycle ownership. Reject ambiguous behavior, unsafe scope and missing evidence; retained parent cases are independently checked by the paired regression authority.'
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const ownerFields = ['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset'] as const
function fail(message: string): never { throw new Error(`rsi plugin revision: ${message}`) }
function exact(value: unknown, fields: readonly string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Reflect.ownKeys(value).length === fields.length
    && Object.keys(descriptors).sort().join('\0') === [...fields].sort().join('\0')
    && Object.values(descriptors).every(field => field.enumerable && 'value' in field)
}
function privateDirectory(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || /[\p{Cc}\\]/u.test(path)
    || realpathSync(path) !== path) fail('private directory differs')
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) {
    fail('private directory differs')
  }
}
function publicKeyAt(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || /[\p{Cc}\\]/u.test(path)
    || realpathSync(path) !== path) fail('signing identity path differs')
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > 8192
    || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) fail('signing identity is not private')
  const key = createPrivateKey(readFileSync(path))
  if (key.asymmetricKeyType !== 'ed25519') fail('signing identity must be Ed25519')
  return createPublicKey(key).export({ format: 'pem', type: 'spki' }).toString()
}
const requirePeer = createRequire(import.meta.url)
function validators(): {
  compileRevisionReviewConfig: typeof import('@dsh-enhanced/assistant-verifier').compileRevisionReviewConfig
  compileRevisionRegressionReviewConfig: typeof import('@dsh-enhanced/assistant-verifier').compileRevisionRegressionReviewConfig
} {
  const name = '@dsh-enhanced/assistant-verifier'
  try { requirePeer.resolve(name) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND' || (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      fail(`opted-in plugin revision requires installed peer ${name}`)
    }
    throw error
  }
  const peer = requirePeer(name) as typeof import('@dsh-enhanced/assistant-verifier')
  if (typeof peer.compileRevisionReviewConfig !== 'function' || typeof peer.compileRevisionRegressionReviewConfig !== 'function') {
    fail('installed revision validators are unavailable; update the verifier peer')
  }
  return { compileRevisionReviewConfig: peer.compileRevisionReviewConfig,
    compileRevisionRegressionReviewConfig: peer.compileRevisionRegressionReviewConfig }
}

/** Validate only existing private resources; compilation never creates a ledger or a key. */
function preparedIdentities(resources: RsiAuthorityResources): void {
  if (!exact(resources, ['schemaVersion', 'root', 'installationId', 'ledgerId', 'identities', 'registry', 'catalog', 'stateRoot', 'configRoot'])
    || resources.schemaVersion !== 1 || typeof resources.root !== 'string' || !uuid.test(resources.installationId) || !uuid.test(resources.ledgerId)
    || resources.installationId === resources.ledgerId || !exact(resources.identities, rsiAuthorityRoles)
    || resources.stateRoot !== join(resources.root, 'state') || resources.configRoot !== join(resources.root, 'config')
    || !exact(resources.registry, ['id', 'root', 'locator']) || resources.registry.id !== `registry-${resources.installationId}`
    || resources.registry.root !== join(resources.root, 'registry') || resources.registry.locator !== pathToFileURL(resources.registry.root).href
    || !exact(resources.catalog, ['id', 'path']) || resources.catalog.id !== `catalog-${resources.installationId}`
    || resources.catalog.path !== join(resources.root, 'catalog.json')) fail('prepared resource identity differs')
  privateDirectory(resources.root); privateDirectory(resources.stateRoot); privateDirectory(resources.configRoot)
  for (const role of rsiAuthorityRoles) {
    const identity = resources.identities[role], authority = `${role}-${resources.installationId}`
    if (!exact(identity, ['authority', 'keyId', 'keyPath', 'publicKeyPem']) || identity.authority !== authority
      || identity.keyId !== `${authority}-key` || identity.keyPath !== join(resources.root, 'identities', `${role}.pem`)
      || typeof identity.publicKeyPem !== 'string') fail('prepared signing identity differs')
  }
  const review = publicKeyAt(resources.identities.review.keyPath), adoption = publicKeyAt(resources.identities.adoption.keyPath)
  if (review !== resources.identities.review.publicKeyPem || adoption !== resources.identities.adoption.publicKeyPem
    || review === adoption) fail('prepared signing identities differ or are not independent')
}

/** Recompute both purpose-separated authorities from normalized public peer compilers. */
export function validateRsiPluginRevisionSetup(input: unknown, expectedOwner: CreationCapabilityOwner,
  now = Date.now()): RsiPluginRevisionSetup {
  if (!Number.isSafeInteger(now) || now < 0) fail('invalid validation time')
  if (!exact(expectedOwner, ownerFields)) fail('invalid expected owner')
  if (!exact(input, ['reviews', 'regressions', 'revision', 'verifications', 'regressionVerifications'])) fail('invalid setup fields')
  const setup = input as RsiPluginRevisionSetup
  const peer = validators()
  const reviewed = peer.compileRevisionReviewConfig(setup.reviews)
  const regressed = peer.compileRevisionRegressionReviewConfig(setup.regressions)
  const { config: reviews } = reviewed, { config: regressions } = regressed
  if (!isDeepStrictEqual(reviews.owner, expectedOwner) || !isDeepStrictEqual(regressions.owner, expectedOwner)) fail('revision owner differs')
  if (!exact(setup.revision, ['id', 'expiresAt', 'maxRevisions', 'namePrefix'])
    || typeof setup.revision.id !== 'string' || !Number.isSafeInteger(setup.revision.expiresAt)
    || setup.revision.expiresAt <= now || setup.revision.maxRevisions !== limits.revisions) fail('invalid finite source revision grant')
  const revision = structuredClone(setup.revision)
  const installation = revision.id.startsWith('revision-source-') ? revision.id.slice('revision-source-'.length) : ''
  if (!uuid.test(installation) || revision.namePrefix !== `owner-${installation.slice(0, 8)}-`
    || reviews.namePrefix !== revision.namePrefix || regressions.namePrefix !== revision.namePrefix) fail('revision namespace differs')
  if (reviews.expiresAt !== revision.expiresAt || regressions.expiresAt !== revision.expiresAt
    || reviews.runner.expiresAt !== revision.expiresAt || regressions.runner.expiresAt !== revision.expiresAt) fail('revision authority expiry differs')
  if (reviews.authorityId !== `revision-review-${installation}` || regressions.authorityId !== `revision-regression-${installation}`
    || reviews.keyId !== `${reviews.authorityId}-key` || regressions.keyId !== `${regressions.authorityId}-key`
    || new Set([revision.id, reviews.authorityId, regressions.authorityId, expectedOwner.authorityId]).size !== 4) fail('revision authority identity differs')
  const root = dirname(dirname(reviews.keyPath))
  if (reviews.keyPath !== join(root, 'identities', 'review.pem') || regressions.keyPath !== reviews.keyPath
    || reviews.runner.stateRoot !== join(root, 'state', 'revision-review-runner')
    || regressions.runner.stateRoot !== join(root, 'state', 'revision-regression-runner')) fail('revision private roots differ')
  privateDirectory(reviews.runner.stateRoot); privateDirectory(regressions.runner.stateRoot)
  if (reviews.maxVerifications !== limits.verifications || regressions.maxVerifications !== limits.verifications
    || reviews.maxCases !== limits.cases || regressions.maxCases !== limits.cases
    || reviews.maxDurationMs !== limits.durationMs || regressions.maxDurationMs !== limits.durationMs
    || reviews.receiptTtlMs !== limits.receiptTtlMs || regressions.receiptTtlMs !== limits.receiptTtlMs
    || reviews.maxInputBytes !== limits.reviewInputBytes || reviews.maxOutputTokens !== limits.reviewOutputTokens
    || reviews.policy !== policy) fail('revision finite limits or policy differ')
  for (const [runner, runs] of [[reviews.runner, limits.reviewRuns], [regressions.runner, limits.regressionRuns]] as const) {
    if (runner.maxRuns !== runs || runner.maxDurationMs !== limits.runnerDurationMs
      || runner.maxTotalDurationMs !== runs * limits.runnerDurationMs || runner.maxOutputBytes !== limits.outputBytes) fail('revision runner limits differ')
  }
  const reviewRunner = reviews.runner, regressionRunner = regressions.runner
  if (!('backend' in reviewRunner) || reviewRunner.backend !== 'linux-native'
    || !('backend' in regressionRunner) || regressionRunner.backend !== 'linux-native'
    || !isDeepStrictEqual(reviewRunner.runtime, regressionRunner.runtime)
    || !isDeepStrictEqual(reviewRunner.cgroupRoots, regressionRunner.cgroupRoots)) fail('revision runners must share the Linux native family')
  if (!exact(setup.verifications, ['authority', 'publicKey']) || !exact(setup.regressionVerifications, ['authority', 'publicKey'])) fail('invalid revision verification fields')
  validateRevisionAcceptanceAuthorityRef(setup.verifications.authority)
  validateRevisionRegressionAcceptanceAuthorityRef(setup.regressionVerifications.authority)
  if (!isDeepStrictEqual(setup.verifications.authority, reviewed.authority) || setup.verifications.publicKey !== reviewed.publicKey
    || !isDeepStrictEqual(setup.regressionVerifications.authority, regressed.authority)
    || setup.regressionVerifications.publicKey !== regressed.publicKey || reviewed.publicKey !== regressed.publicKey) fail('revision verification authority digest or key differs')
  if (publicKeyAt(join(root, 'identities', 'adoption.pem')) === reviewed.publicKey) fail('revision review and adoption signing keys must be independent')
  return { reviews, regressions, revision, verifications: { authority: reviewed.authority, publicKey: reviewed.publicKey },
    regressionVerifications: { authority: regressed.authority, publicKey: regressed.publicKey } }
}

/** This produces a candidate grant; installation decides whether new revision authority is authorized. */
export function createRsiPluginRevisionSetup(input: {
  resources: RsiAuthorityResources; build: LinuxRsiCreationBuildEnvironment; owner: CreationCapabilityOwner; now: number; expiresAt: number
  stateSeals?: { review: LinuxRunnerStateSeal; regression: LinuxRunnerStateSeal }
}): RsiPluginRevisionSetup {
  const { resources, build, owner, now, expiresAt } = input
  if (input.stateSeals && !exact(input.stateSeals, ['review', 'regression'])) fail('incomplete revision state seals')
  preparedIdentities(resources)
  const hasBuildDigest = !!build && typeof build === 'object' && Object.hasOwn(build, 'buildRuntimeDigest')
  const buildDigest = hasBuildDigest ? Object.getOwnPropertyDescriptor(build, 'buildRuntimeDigest')?.value : undefined
  if (!exact(build, ['schemaVersion', 'backend', 'sourceCommit', 'behavior', 'cgroupRoots', ...(hasBuildDigest ? ['buildRuntimeDigest'] : [])])
    || build.schemaVersion !== 3 || build.backend !== 'linux-native' || !/^[a-f0-9]{40}$/u.test(build.sourceCommit)
    || hasBuildDigest && (typeof buildDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(buildDigest))
    || !Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(now) || now < 0 || expiresAt <= now) fail('invalid native build or expiry')
  const installation = resources.installationId, namePrefix = `owner-${installation.slice(0, 8)}-`
  const runner = { backend: 'linux-native' as const, runtime: build.behavior, cgroupRoots: build.cgroupRoots,
    expiresAt, maxDurationMs: limits.runnerDurationMs, maxOutputBytes: limits.outputBytes }
  const reviews: RevisionReviewConfig = { authorityId: `revision-review-${installation}`, owner, namePrefix,
    keyId: `revision-review-${installation}-key`, keyPath: resources.identities.review.keyPath, expiresAt,
    maxVerifications: limits.verifications, runner: { ...runner, stateRoot: join(resources.stateRoot, 'revision-review-runner'),
      ...(input.stateSeals ? { stateSeal: input.stateSeals.review } : {}),
      maxRuns: limits.reviewRuns, maxTotalDurationMs: limits.reviewRuns * limits.runnerDurationMs },
    policy, maxInputBytes: limits.reviewInputBytes, maxOutputTokens: limits.reviewOutputTokens,
    maxDurationMs: limits.durationMs, maxCases: limits.cases, receiptTtlMs: limits.receiptTtlMs }
  const regressions: RevisionRegressionReviewConfig = { authorityId: `revision-regression-${installation}`, owner, namePrefix,
    keyId: `revision-regression-${installation}-key`, keyPath: resources.identities.review.keyPath, expiresAt,
    maxVerifications: limits.verifications, runner: { ...runner, stateRoot: join(resources.stateRoot, 'revision-regression-runner'),
      ...(input.stateSeals ? { stateSeal: input.stateSeals.regression } : {}),
      maxRuns: limits.regressionRuns, maxTotalDurationMs: limits.regressionRuns * limits.runnerDurationMs },
    maxDurationMs: limits.durationMs, maxCases: limits.cases, receiptTtlMs: limits.receiptTtlMs }
  const peer = validators(), reviewed = peer.compileRevisionReviewConfig(reviews), regressed = peer.compileRevisionRegressionReviewConfig(regressions)
  const setup = validateRsiPluginRevisionSetup({ reviews: reviewed.config, regressions: regressed.config,
    revision: { id: `revision-source-${installation}`, expiresAt, maxRevisions: limits.revisions, namePrefix },
    verifications: { authority: reviewed.authority, publicKey: reviewed.publicKey },
    regressionVerifications: { authority: regressed.authority, publicKey: regressed.publicKey } }, owner, now)
  const native = setup.reviews.runner
  if (!('backend' in native) || native.backend !== 'linux-native' || native.runtime.runtime.sourceCommit !== build.sourceCommit
    || setup.verifications.publicKey !== resources.identities.review.publicKeyPem) fail('prepared revision build or signing identity differs')
  return setup
}
