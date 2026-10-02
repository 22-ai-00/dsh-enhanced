import { createPrivateKey, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { validateCreationAcceptanceAuthorityRef, type CreationAcceptanceAuthorityRef } from '@dsh-enhanced/assistant-growth-contract'
import type { CreationReviewConfig } from '@dsh-enhanced/assistant-verifier'
import type { Config as ControlPlaneConfig, CreationCapabilityConfig, CreationCapabilityOwner } from '@dsh-enhanced/plugin-control-plane'
import type { RsiAuthorityResources } from './rsi-authority-resources.js'
import type { RsiCreationBuildEnvironment } from './rsi-creation-build.js'

export type SourceCreationGrant = NonNullable<NonNullable<ControlPlaneConfig['sourceJobs']>['creation']>

export interface RsiPluginCreationSetup {
  reviews: CreationReviewConfig
  creation: SourceCreationGrant
  capabilities: CreationCapabilityConfig
  verifications: { authority: CreationAcceptanceAuthorityRef; publicKey: string }
}

const limits = {
  creates: 32, verifications: 32, adoptions: 32, cases: 4, tools: 8,
  callsPerAdoption: 30, callRecords: 960, inputBytes: 65_536,
  reviewInputBytes: 262_144, reviewOutputTokens: 8_192, reviewDurationMs: 300_000,
  receiptTtlMs: 86_400_000, runnerDurationMs: 30_000,
  reviewRuns: 160, adoptionRuns: 1_024,
} as const
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u

function fail(message: string): never { throw new Error(`rsi plugin creation: ${message}`) }
const requirePeer = createRequire(import.meta.url)
function installedPeer<T>(name: string): T {
  try { requirePeer.resolve(name) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND'
      || (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') fail(`opted-in plugin creation requires installed peer ${name}`)
    throw error
  }
  return requirePeer(name) as T
}

/** Optional peers are loaded only for an opted-in creation setup. */
export function getRsiPluginCreationValidators(): {
  compileCreationReviewConfig: typeof import('@dsh-enhanced/assistant-verifier').compileCreationReviewConfig
  validateCreationCapabilityConfig: typeof import('@dsh-enhanced/plugin-control-plane').validateCreationCapabilityConfig
} {
  const verifier = installedPeer<typeof import('@dsh-enhanced/assistant-verifier')>('@dsh-enhanced/assistant-verifier')
  const controlPlane = installedPeer<typeof import('@dsh-enhanced/plugin-control-plane')>('@dsh-enhanced/plugin-control-plane')
  if (typeof verifier.compileCreationReviewConfig !== 'function'
    || typeof controlPlane.validateCreationCapabilityConfig !== 'function') {
    fail('installed creation validators are unavailable; update the verifier and control-plane peers')
  }
  return { compileCreationReviewConfig: verifier.compileCreationReviewConfig,
    validateCreationCapabilityConfig: controlPlane.validateCreationCapabilityConfig }
}

function exact(value: unknown, fields: readonly string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Reflect.ownKeys(value).length === fields.length
    && Object.keys(descriptors).sort().join('\0') === [...fields].sort().join('\0')
    && Object.values(descriptors).every(field => field.enumerable && 'value' in field)
}

function publicKeyAt(path: string): string {
  return createPublicKey(createPrivateKey(readFileSync(path))).export({ format: 'pem', type: 'spki' }).toString()
}

/** Admission of a complete finite chain; no resource is created or reset here. */
export function validateRsiPluginCreationSetup(input: unknown, expectedOwner: CreationCapabilityOwner,
  now = Date.now()): RsiPluginCreationSetup {
  if (!Number.isSafeInteger(now) || now < 0) fail('invalid validation time')
  if (!exact(expectedOwner, ['authorityId', 'authorityHash', 'principalId', 'principalRecordId',
    'principalVersion', 'workspace', 'agentPreset'])) fail('invalid expected owner')
  if (!exact(input, ['reviews', 'creation', 'capabilities', 'verifications'])) fail('invalid setup fields')
  const setup = input as RsiPluginCreationSetup
  const validators: ReturnType<typeof getRsiPluginCreationValidators> = getRsiPluginCreationValidators()
  const { config: reviews, authority, publicKey } = validators.compileCreationReviewConfig(setup.reviews)
  validators.validateCreationCapabilityConfig(setup.capabilities)
  const capabilities = structuredClone(setup.capabilities)
  if (!isDeepStrictEqual(reviews.owner, expectedOwner) || !isDeepStrictEqual(capabilities.owner, expectedOwner)) {
    fail('creation owner differs from current owner route')
  }
  if (!exact(setup.creation, ['id', 'expiresAt', 'maxCreates', 'namePrefix'])
    || typeof setup.creation.id !== 'string'
    || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(setup.creation.id)
    || !Number.isSafeInteger(setup.creation.expiresAt)
    || setup.creation.expiresAt <= now
    || setup.creation.maxCreates !== limits.creates) fail('invalid finite source creation grant')
  const creation = structuredClone(setup.creation)
  const installationId = creation.id.startsWith('creation-source-') ? creation.id.slice('creation-source-'.length) : ''
  if (!uuid.test(installationId)
    || creation.namePrefix !== `owner-${installationId.slice(0, 8)}-`
    || reviews.namePrefix !== creation.namePrefix || capabilities.namePrefix !== creation.namePrefix) {
    fail('creation namespace differs')
  }
  if (reviews.expiresAt !== creation.expiresAt || capabilities.expiresAt !== creation.expiresAt
    || reviews.runner.expiresAt !== creation.expiresAt || capabilities.runner.expiresAt !== creation.expiresAt) {
    fail('creation authority expiry differs')
  }
  if (reviews.authorityId !== `creation-review-${installationId}`
    || capabilities.authorityId !== `creation-adoption-${installationId}`
    || reviews.keyId !== `${reviews.authorityId}-key` || capabilities.keyId !== `${capabilities.authorityId}-key`
    || new Set([creation.id, reviews.authorityId, capabilities.authorityId, expectedOwner.authorityId]).size !== 4
    || reviews.keyPath === capabilities.keyPath) {
    fail('creation authorities must be independent')
  }
  const authorityRoot = dirname(dirname(reviews.keyPath))
  if (reviews.keyPath !== join(authorityRoot, 'identities', 'review.pem')
    || capabilities.keyPath !== join(authorityRoot, 'identities', 'adoption.pem')
    || reviews.runner.stateRoot !== join(authorityRoot, 'state', 'creation-review-runner')
    || capabilities.runner.stateRoot !== join(authorityRoot, 'state', 'creation-adoption-runner')) {
    fail('creation private roots differ from prepared identities')
  }
  if (reviews.maxVerifications !== limits.verifications || reviews.maxCases !== limits.cases
    || reviews.maxInputBytes !== limits.reviewInputBytes || reviews.maxOutputTokens !== limits.reviewOutputTokens
    || reviews.maxDurationMs !== limits.reviewDurationMs || reviews.receiptTtlMs !== limits.receiptTtlMs
    || capabilities.maxAdoptions !== limits.adoptions || capabilities.maxTools !== limits.tools
    || capabilities.maxCallsPerAdoption !== limits.callsPerAdoption
    || capabilities.maxCallRecords !== limits.callRecords || capabilities.maxInputBytes !== limits.inputBytes) {
    fail('creation finite limits differ')
  }
  if (reviews.runner.maxRuns !== limits.reviewRuns || reviews.runner.maxDurationMs !== limits.runnerDurationMs
    || reviews.runner.maxTotalDurationMs !== limits.reviewRuns * limits.runnerDurationMs
    || reviews.runner.maxOutputBytes !== 262_144
    || capabilities.runner.maxRuns !== limits.adoptionRuns || capabilities.runner.maxDurationMs !== limits.runnerDurationMs
    || capabilities.runner.maxTotalDurationMs !== 86_400_000 || capabilities.runner.maxOutputBytes !== 65_536
    || reviews.runner.maxRuns < reviews.maxVerifications * (reviews.maxCases + 1)
    || capabilities.runner.maxRuns < capabilities.maxAdoptions + capabilities.maxCallRecords
    || capabilities.maxCallRecords < capabilities.maxAdoptions * capabilities.maxCallsPerAdoption
    || reviews.runner.image !== capabilities.runner.image || reviews.runner.dockerPath !== capabilities.runner.dockerPath) {
    fail('creation runner limits cannot cover finite grants')
  }
  if (!exact(setup.verifications, ['authority', 'publicKey'])) fail('invalid creation verification fields')
  validateCreationAcceptanceAuthorityRef(setup.verifications.authority)
  if (!isDeepStrictEqual(setup.verifications.authority, authority)
    || setup.verifications.publicKey !== publicKey) fail('creation verification authority digest or key differs')
  if (publicKeyAt(capabilities.keyPath) === publicKey) fail('verification and adoption signing keys must be separate')
  return { reviews, creation, capabilities, verifications: { authority, publicKey } }
}

/** Compile one stable installation grant from the already prepared private identities. */
export function createRsiPluginCreationSetup(input: {
  resources: RsiAuthorityResources; build: RsiCreationBuildEnvironment; owner: CreationCapabilityOwner;
  expiresAt: number; now: number
}): RsiPluginCreationSetup {
  const { resources, build, owner, expiresAt, now } = input
  if (resources?.schemaVersion !== 1 || build?.schemaVersion !== 1
    || !uuid.test(resources.installationId)
    || !Number.isSafeInteger(expiresAt) || expiresAt <= now) fail('invalid installation or expiry')
  const prefix = `owner-${resources.installationId.slice(0, 8)}-`
  const creation: SourceCreationGrant = { id: `creation-source-${resources.installationId}`, expiresAt,
    maxCreates: limits.creates, namePrefix: prefix }
  const reviews: CreationReviewConfig = {
    authorityId: `creation-review-${resources.installationId}`, owner, namePrefix: prefix,
    keyId: `creation-review-${resources.installationId}-key`, keyPath: resources.identities.review.keyPath,
    expiresAt, maxVerifications: limits.verifications,
    runner: { stateRoot: join(resources.stateRoot, 'creation-review-runner'), image: build.image,
      dockerPath: build.dockerPath, expiresAt, maxRuns: limits.reviewRuns,
      maxTotalDurationMs: limits.reviewRuns * limits.runnerDurationMs, maxDurationMs: limits.runnerDurationMs,
      maxOutputBytes: 262_144 },
    policy: 'Derive concrete held-out behavior cases from the current authenticated task and feedback. Independently check exact outputs and the checked source patch. Reject ambiguous behavior, unsafe scope, and missing evidence.',
    maxInputBytes: limits.reviewInputBytes, maxOutputTokens: limits.reviewOutputTokens,
    maxDurationMs: limits.reviewDurationMs, maxCases: limits.cases, receiptTtlMs: limits.receiptTtlMs,
  }
  const capabilities: CreationCapabilityConfig = {
    authorityId: `creation-adoption-${resources.installationId}`,
    keyId: `creation-adoption-${resources.installationId}-key`, keyPath: resources.identities.adoption.keyPath,
    owner, namePrefix: prefix, expiresAt, maxAdoptions: limits.adoptions,
    maxTools: limits.tools, maxCallsPerAdoption: limits.callsPerAdoption,
    maxCallRecords: limits.callRecords, maxInputBytes: limits.inputBytes,
    runner: { stateRoot: join(resources.stateRoot, 'creation-adoption-runner'), image: build.image,
      dockerPath: build.dockerPath, expiresAt, maxRuns: limits.adoptionRuns,
      maxTotalDurationMs: 86_400_000, maxDurationMs: limits.runnerDurationMs, maxOutputBytes: 65_536 },
  }
  const { compileCreationReviewConfig } = getRsiPluginCreationValidators()
  const { authority, publicKey } = compileCreationReviewConfig(reviews)
  const setup = validateRsiPluginCreationSetup({ reviews, creation, capabilities,
    verifications: { authority, publicKey } }, owner, now)
  if (setup.verifications.publicKey !== resources.identities.review.publicKeyPem
    || publicKeyAt(setup.capabilities.keyPath) !== resources.identities.adoption.publicKeyPem) {
    fail('prepared signing identities differ')
  }
  return setup
}
