import { spawn } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, posix, resolve } from 'node:path'
import { catalogAdmissionId, parseCatalog, type CapabilityCatalog, type CatalogEntry } from './catalog.js'
import { ControlPlaneStoreError } from './store.js'
import { inheritedReleaseAdapterEnvironment, openTrustedExecutable, verifyOpenTrustedExecutable,
  type OpenTrustedExecutable, type PluginControlTrustConfig } from './trust.js'
import type {
  PluginSourcePlan,
  SourcePublishReconciliationAuthority,
  SourcePublishReconciliationEvidence,
  SourcePublishReconciliationReceipt,
  SourcePublishReconciliationRequest,
  SourceReleaseArtifact,
  SourceReleaseAuthorization,
  SourceReleaseAuthorizationAuthority,
  SourceReleaseAuthority,
  SourceReleasePhase,
  SourceReleaseReceipt,
  SourceReleaseRequest,
  SourceReleaseSuccessEvidence,
  SourceReleasePolicy,
  VerifiedSourceReleaseAuthorization,
  VerifiedSourceReleaseReceipt,
  VerifiedSourcePublishReconciliationReceipt,
} from './types.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/u
const PACKAGE = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u
const SOURCE_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u
const phases = new Set<SourceReleasePhase>(['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'])

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ControlPlaneStoreError('invalid-input', `${label} must be an object`)
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) throw new ControlPlaneStoreError('invalid-input', `${label} has unknown or missing fields`)
}
function text(value: unknown, label: string, pattern = ID, maximum = 2_000): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum || !pattern.test(value)) throw new ControlPlaneStoreError('invalid-input', `${label} is invalid`)
  return value
}
function opaqueLine(value: unknown, label: string, maximum = 2_000): string {
  const result = text(value, label, /^.+$/u, maximum)
  if (result.includes('\0') || result.includes('\r') || result.includes('\n')) {
    throw new ControlPlaneStoreError('invalid-input', `${label} is invalid`)
  }
  return result
}
function branch(value: unknown, label: string): string {
  const result = opaqueLine(value, label, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(result) || result.includes('..') || result.includes('//')
    || result.endsWith('/') || result.endsWith('.') || result.endsWith('.lock') || result.includes('@{')) {
    throw new ControlPlaneStoreError('invalid-input', `${label} is not a canonical branch name`)
  }
  return result
}
function absolutePath(value: unknown, label: string): string {
  const result = opaqueLine(value, label)
  if (!result.startsWith('/') || result === '/') throw new ControlPlaneStoreError('invalid-input', `${label} is invalid`)
  return result
}
function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new ControlPlaneStoreError('invalid-input', `${label} must be a bounded integer`)
  return Number(value)
}
function same(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right) }
function digestText(value: unknown, label: string): string { return text(value, label, DIGEST) }
function commit(value: unknown, label: string): string { return text(value, label, COMMIT) }
function signature(value: unknown, label: string): string {
  const result = text(value, label, SIGNATURE, 16_384)
  const bytes = Buffer.from(result, 'base64')
  if (bytes.length !== 64 || bytes.toString('base64') !== result) throw new ControlPlaneStoreError('invalid-input', `${label} must be one canonical Ed25519 signature`)
  return result
}
function integrity(value: unknown, label: string): string {
  const result = text(value, label, /^sha512-[A-Za-z0-9+/]+={0,2}$/u)
  const encoded = result.slice('sha512-'.length); const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== 64 || bytes.toString('base64') !== encoded) throw new ControlPlaneStoreError('invalid-input', `${label} must be one canonical SHA-512 integrity`)
  return result
}
function relativePath(value: unknown, label: string): string {
  const result = opaqueLine(value, label, 500)
  if (!SOURCE_PATH.test(result) || result.startsWith('.') || posix.normalize(result) !== result
    || result.split('/').some(part => part === '.' || part === '..')) throw new ControlPlaneStoreError('invalid-input', `${label} is not a canonical repository-relative path`)
  return result
}
function stringList(value: unknown, label: string, maximum = 64): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) throw new ControlPlaneStoreError('invalid-input', `${label} must be a bounded non-empty array`)
  const result = value.map((item, index) => {
    const raw = opaqueLine(item, `${label}[${index}]`, 500); const normalized = raw.normalize('NFC').trim()
    if (raw !== normalized || normalized === '') throw new ControlPlaneStoreError('invalid-input', `${label} must use canonical text`)
    return normalized
  })
  const sorted = [...result].sort()
  if (new Set(result).size !== result.length || !result.every((item, index) => item === sorted[index])) {
    throw new ControlPlaneStoreError('invalid-input', `${label} must be unique and sorted`)
  }
  return Object.freeze(result)
}
function scopeList(value: unknown): readonly string[] { return Object.freeze(stringList(value, 'scope', 32).map((item, index) => relativePath(item, `scope[${index}]`))) }
function requirements(value: unknown, primaryPackage: string, label: string): SourceReleasePolicy['requires'] {
  if (!Array.isArray(value) || value.length > 64) throw new ControlPlaneStoreError('invalid-input', `${label} must be a bounded array`)
  const parsed = parseCatalog({ schemaVersion: 1, entries: [{ id: 'release-policy', package: primaryPackage, version: '0.0.0',
    integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, dshBaseline: '0.0.0', capabilities: ['placeholder'],
    authorities: ['placeholder'], requires: value }] }).entries[0]!.requires
  if (!same(value, parsed)) throw new ControlPlaneStoreError('invalid-input', `${label} must be canonical and sorted`)
  return parsed
}
function catalogEntry(value: unknown, label: string): CatalogEntry {
  const item = record(value, label)
  exact(item, ['id', 'package', 'version', 'integrity', ...(item.registry === undefined ? [] : ['registry']),
    'requires', 'dshBaseline', 'capabilities', 'authorities'], label)
  const parsed = parseCatalog({ schemaVersion: 1, entries: [item] }).entries[0]!
  if (!same(item, parsed)) throw new ControlPlaneStoreError('invalid-input', `${label} must use canonical values and ordering`)
  const integrityBytes = Buffer.from(parsed.integrity.slice('sha512-'.length), 'base64')
  if (integrityBytes.length !== 64 || `sha512-${integrityBytes.toString('base64')}` !== parsed.integrity) {
    throw new ControlPlaneStoreError('invalid-input', `${label}.integrity must be one canonical SHA-512 integrity`)
  }
  return parsed
}

function releasePolicy(value: unknown): SourceReleasePolicy {
  const item = record(value, 'release policy')
  exact(item, ['targetBranch', 'candidateId', 'packageName', 'packageVersion', 'packagePath', 'dshBaseline', 'capabilities',
    'authorities', 'requires', 'registryId', 'registryLocator', 'registryReference', 'catalogId', 'catalogPath',
    'minimumReproducibleBuilds'], 'release policy')
  const candidateId = text(item.candidateId, 'releasePolicy.candidateId', /^[a-z0-9][a-z0-9-]{0,63}$/u)
  const packageName = text(item.packageName, 'releasePolicy.packageName', PACKAGE)
  const packageVersion = text(item.packageVersion, 'releasePolicy.packageVersion', VERSION)
  const dshBaseline = text(item.dshBaseline, 'releasePolicy.dshBaseline', VERSION)
  const capabilities = stringList(item.capabilities, 'releasePolicy.capabilities')
  const authorities = stringList(item.authorities, 'releasePolicy.authorities')
  const minimumReproducibleBuilds = integer(item.minimumReproducibleBuilds, 'releasePolicy.minimumReproducibleBuilds', 2)
  if (minimumReproducibleBuilds > 16) throw new ControlPlaneStoreError('invalid-input', 'releasePolicy.minimumReproducibleBuilds is too large')
  return Object.freeze({ targetBranch: branch(item.targetBranch, 'releasePolicy.targetBranch'), candidateId, packageName, packageVersion,
    packagePath: relativePath(item.packagePath, 'releasePolicy.packagePath'), dshBaseline, capabilities, authorities,
    requires: requirements(item.requires, packageName, 'releasePolicy.requires'), registryId: text(item.registryId, 'releasePolicy.registryId'),
    registryLocator: opaqueLine(item.registryLocator, 'releasePolicy.registryLocator'),
    registryReference: opaqueLine(item.registryReference, 'releasePolicy.registryReference'), catalogId: text(item.catalogId, 'releasePolicy.catalogId'),
    catalogPath: absolutePath(item.catalogPath, 'releasePolicy.catalogPath'),
    minimumReproducibleBuilds })
}

const authorizationFields = ['schemaVersion', 'kind', 'authorizationId', 'authority', 'keyId', 'planId', 'planDigest', 'baseCommit',
  'checkedTreeDigest', 'checkedPatchDigest', 'scope', 'releasePolicy', 'authorizedAt', 'expiresAt', 'signature'] as const

export function parseSourceReleaseAuthorization(value: unknown): SourceReleaseAuthorization {
  const item = record(value, 'source release authorization'); exact(item, authorizationFields, 'source release authorization')
  if (item.schemaVersion !== 1 || item.kind !== 'dsh-source-release-authorization') throw new ControlPlaneStoreError('invalid-input', 'unsupported source release authorization schema')
  const authorization: SourceReleaseAuthorization = { schemaVersion: 1, kind: 'dsh-source-release-authorization',
    authorizationId: text(item.authorizationId, 'authorizationId'), authority: text(item.authority, 'authority'), keyId: text(item.keyId, 'keyId'),
    planId: text(item.planId, 'planId'), planDigest: digestText(item.planDigest, 'planDigest'), baseCommit: commit(item.baseCommit, 'baseCommit'),
    checkedTreeDigest: digestText(item.checkedTreeDigest, 'checkedTreeDigest'), checkedPatchDigest: digestText(item.checkedPatchDigest, 'checkedPatchDigest'),
    scope: scopeList(item.scope), releasePolicy: releasePolicy(item.releasePolicy), authorizedAt: integer(item.authorizedAt, 'authorizedAt'),
    expiresAt: integer(item.expiresAt, 'expiresAt'), signature: signature(item.signature, 'authorization signature') }
  if (authorization.expiresAt <= authorization.authorizedAt || authorization.expiresAt - authorization.authorizedAt > 86_400_000) {
    throw new ControlPlaneStoreError('invalid-input', 'source release authorization validity interval is invalid')
  }
  return Object.freeze(authorization)
}

export function parseVerifiedSourceReleaseAuthorization(value: unknown): VerifiedSourceReleaseAuthorization {
  const item = record(value, 'verified source release authorization')
  exact(item, [...authorizationFields, 'signatureDigest'], 'verified source release authorization')
  const { signatureDigest: rawSignatureDigest, ...unsignedVerification } = item
  const authorization = parseSourceReleaseAuthorization(unsignedVerification)
  const signatureDigest = digestText(rawSignatureDigest, 'signatureDigest')
  if (signatureDigest !== createHash('sha256').update(Buffer.from(authorization.signature, 'base64')).digest('hex')) {
    throw new ControlPlaneStoreError('invalid-input', 'verified source release authorization signature digest is invalid')
  }
  return Object.freeze({ ...authorization, signatureDigest })
}

function canonicalAuthorization(authorization: SourceReleaseAuthorization): string {
  const { signature: _signature, ...fields } = authorization
  return canonical(fields)
}

export function sourceReleaseAuthorizationSigningPayload(authorization: Omit<SourceReleaseAuthorization, 'signature'>): string {
  return canonicalAuthorization({ ...authorization, signature: '' })
}

function pathAllowedByScope(path: string, scope: readonly string[]): boolean {
  return scope.some(root => path === root || path.startsWith(`${root}/`))
}

export class Ed25519SourceReleaseAuthorizationAuthority implements SourceReleaseAuthorizationAuthority {
  constructor(readonly publicKey: string | Buffer, readonly expectedAuthority: string, readonly expectedKeyId: string,
    readonly now: () => number = Date.now) {}

  async verify(input: SourceReleaseAuthorization, plan: PluginSourcePlan): Promise<VerifiedSourceReleaseAuthorization> {
    const authorization = parseSourceReleaseAuthorization(input); const now = this.now()
    if (authorization.authority !== this.expectedAuthority || authorization.keyId !== this.expectedKeyId
      || authorization.planId !== plan.id || authorization.planDigest !== plan.digest || authorization.baseCommit !== plan.baseCommit
      || !same(authorization.scope, plan.scope) || plan.sourceCheck === undefined
      || authorization.checkedTreeDigest !== plan.sourceCheck.treeDigest || authorization.checkedPatchDigest !== plan.sourceCheck.patchDigest
      || authorization.releasePolicy.candidateId !== plan.name || !pathAllowedByScope(authorization.releasePolicy.packagePath, plan.scope)) {
      throw new ControlPlaneStoreError('conflict', 'release authorization is not bound to the exact checked source plan and policy')
    }
    if (!Number.isSafeInteger(plan.sourceCheck.checkedAt) || plan.sourceCheck.checkedAt < 0
      || authorization.authorizedAt < plan.sourceCheck.checkedAt || authorization.authorizedAt > now || now > authorization.expiresAt) {
      throw new ControlPlaneStoreError('expired', 'release authorization is outside its post-check validity interval')
    }
    const signatureBytes = Buffer.from(authorization.signature, 'base64')
    if (!verify(null, Buffer.from(canonicalAuthorization(authorization)), createPublicKey(this.publicKey), signatureBytes)) {
      throw new ControlPlaneStoreError('invalid-input', 'release authorization signature is invalid')
    }
    return Object.freeze({ ...authorization, signatureDigest: createHash('sha256').update(signatureBytes).digest('hex') })
  }
}

const reconciliationRequestFields = ['schemaVersion', 'kind', 'operationId', 'attempt', 'requestedAt', 'receiptTtlMs', 'installationId',
  'ledger', 'plan', 'release', 'authorization', 'adapter', 'registry', 'ambiguousPublish', 'artifact',
  'expectedArtifactStatementDigest', 'expectedArtifactSignatureDigest', 'expectedRegistryReference'] as const

export function parseSourcePublishReconciliationRequest(value: unknown): SourcePublishReconciliationRequest {
  const item = record(value, 'source publish reconciliation request')
  exact(item, reconciliationRequestFields, 'source publish reconciliation request')
  if (item.schemaVersion !== 1 || item.kind !== 'dsh-source-publish-reconciliation-request') {
    throw new ControlPlaneStoreError('invalid-input', 'unsupported source publish reconciliation request schema')
  }
  const ledger = record(item.ledger, 'reconciliation ledger'); exact(ledger, ['id', 'path'], 'reconciliation ledger')
  const plan = record(item.plan, 'reconciliation plan'); exact(plan, ['id', 'digest', 'revision'], 'reconciliation plan')
  const release = record(item.release, 'reconciliation release'); exact(release, ['id', 'fence'], 'reconciliation release')
  const registry = record(item.registry, 'reconciliation registry'); exact(registry, ['id', 'locator'], 'reconciliation registry')
  const ambiguous = record(item.ambiguousPublish, 'ambiguous publish binding')
  exact(ambiguous, ['operationId', 'receiptId', 'receiptDigest', 'evidenceDigest'], 'ambiguous publish binding')
  const rawArtifact = record(item.artifact, 'reconciliation artifact')
  exact(rawArtifact, ['packageName', 'packageVersion', 'tarballSha256', 'tarballIntegrity'], 'reconciliation artifact')
  const encodedIntegrity = integrity(rawArtifact.tarballIntegrity, 'artifact.tarballIntegrity')
  const authorization = parseVerifiedSourceReleaseAuthorization(item.authorization)
  const request: SourcePublishReconciliationRequest = Object.freeze({ schemaVersion: 1, kind: 'dsh-source-publish-reconciliation-request',
    operationId: text(item.operationId, 'operationId'), attempt: integer(item.attempt, 'attempt', 1),
    requestedAt: integer(item.requestedAt, 'requestedAt'),
    receiptTtlMs: integer(item.receiptTtlMs, 'receiptTtlMs', 1_000),
    installationId: text(item.installationId, 'installationId', /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u),
    ledger: Object.freeze({ id: text(ledger.id, 'ledger.id'), path: absolutePath(ledger.path, 'ledger.path') }),
    plan: Object.freeze({ id: text(plan.id, 'plan.id'), digest: digestText(plan.digest, 'plan.digest'), revision: integer(plan.revision, 'plan.revision', 1) }),
    release: Object.freeze({ id: text(release.id, 'release.id'), fence: integer(release.fence, 'release.fence', 1) }), authorization,
    adapter: adapterIdentity(item.adapter), registry: Object.freeze({ id: text(registry.id, 'registry.id'), locator: opaqueLine(registry.locator, 'registry.locator') }),
    ambiguousPublish: Object.freeze({ operationId: text(ambiguous.operationId, 'ambiguousPublish.operationId'),
      receiptId: text(ambiguous.receiptId, 'ambiguousPublish.receiptId'), receiptDigest: digestText(ambiguous.receiptDigest, 'ambiguousPublish.receiptDigest'),
      evidenceDigest: digestText(ambiguous.evidenceDigest, 'ambiguousPublish.evidenceDigest') }),
    artifact: Object.freeze({ packageName: text(rawArtifact.packageName, 'artifact.packageName', PACKAGE),
      packageVersion: text(rawArtifact.packageVersion, 'artifact.packageVersion', VERSION),
      tarballSha256: digestText(rawArtifact.tarballSha256, 'artifact.tarballSha256'), tarballIntegrity: encodedIntegrity }),
    expectedArtifactStatementDigest: digestText(item.expectedArtifactStatementDigest, 'expectedArtifactStatementDigest'),
    expectedArtifactSignatureDigest: digestText(item.expectedArtifactSignatureDigest, 'expectedArtifactSignatureDigest'),
    expectedRegistryReference: opaqueLine(item.expectedRegistryReference, 'expectedRegistryReference') })
  const policy = authorization.releasePolicy
  if (request.receiptTtlMs > 300_000 || request.requestedAt < authorization.authorizedAt || request.requestedAt > authorization.expiresAt
    || request.plan.id !== authorization.planId || request.plan.digest !== authorization.planDigest
    || request.registry.id !== policy.registryId || request.registry.locator !== policy.registryLocator
    || request.expectedRegistryReference !== policy.registryReference
    || request.artifact.packageName !== policy.packageName || request.artifact.packageVersion !== policy.packageVersion) {
    throw new ControlPlaneStoreError('conflict', 'publish reconciliation request is not bound to the authorized release')
  }
  return request
}

function parseSourcePublishReconciliationEvidence(value: unknown): SourcePublishReconciliationEvidence {
  const item = record(value, 'source publish reconciliation evidence')
  exact(item, ['kind', 'outcome', 'registryId', 'registryReference', 'packageName', 'packageVersion', 'expectedTarballSha256',
    'expectedTarballIntegrity', 'expectedArtifactStatementDigest', 'expectedArtifactSignatureDigest',
    'observedTarballSha256', 'observedTarballIntegrity', 'observedArtifactStatementDigest',
    'observedArtifactSignatureDigest', 'ambiguousPublishOperationId',
    'ambiguousPublishReceiptDigest', 'detailDigest'], 'source publish reconciliation evidence')
  if (item.kind !== 'publish-reconciliation' || !['exists-match', 'absent', 'unknown', 'digest-conflict'].includes(String(item.outcome))) {
    throw new ControlPlaneStoreError('invalid-input', 'publish reconciliation evidence outcome is invalid')
  }
  const nullableDigest = (raw: unknown, label: string): string | null => raw === null ? null : digestText(raw, label)
  const nullableIntegrity = (raw: unknown): string | null => {
    if (raw === null) return null
    return integrity(raw, 'observedTarballIntegrity')
  }
  const evidence: SourcePublishReconciliationEvidence = { kind: 'publish-reconciliation',
    outcome: item.outcome as SourcePublishReconciliationEvidence['outcome'], registryId: text(item.registryId, 'registryId'),
    registryReference: item.registryReference === null ? null : opaqueLine(item.registryReference, 'registryReference'),
    packageName: text(item.packageName, 'packageName', PACKAGE), packageVersion: text(item.packageVersion, 'packageVersion', VERSION),
    expectedTarballSha256: digestText(item.expectedTarballSha256, 'expectedTarballSha256'),
    expectedTarballIntegrity: integrity(item.expectedTarballIntegrity, 'expectedTarballIntegrity'),
    expectedArtifactStatementDigest: digestText(item.expectedArtifactStatementDigest, 'expectedArtifactStatementDigest'),
    expectedArtifactSignatureDigest: digestText(item.expectedArtifactSignatureDigest, 'expectedArtifactSignatureDigest'),
    observedTarballSha256: nullableDigest(item.observedTarballSha256, 'observedTarballSha256'),
    observedTarballIntegrity: nullableIntegrity(item.observedTarballIntegrity),
    observedArtifactStatementDigest: nullableDigest(item.observedArtifactStatementDigest, 'observedArtifactStatementDigest'),
    observedArtifactSignatureDigest: nullableDigest(item.observedArtifactSignatureDigest, 'observedArtifactSignatureDigest'),
    ambiguousPublishOperationId: text(item.ambiguousPublishOperationId, 'ambiguousPublishOperationId'),
    ambiguousPublishReceiptDigest: digestText(item.ambiguousPublishReceiptDigest, 'ambiguousPublishReceiptDigest'),
    detailDigest: digestText(item.detailDigest, 'detailDigest') }
  if (evidence.outcome === 'exists-match' && (evidence.registryReference === null
    || evidence.observedTarballSha256 !== evidence.expectedTarballSha256
    || evidence.observedTarballIntegrity !== evidence.expectedTarballIntegrity
    || evidence.observedArtifactStatementDigest !== evidence.expectedArtifactStatementDigest
    || evidence.observedArtifactSignatureDigest !== evidence.expectedArtifactSignatureDigest)) {
    throw new ControlPlaneStoreError('invalid-input', 'exists-match reconciliation does not prove the exact artifact')
  }
  if (evidence.outcome === 'absent' && (evidence.registryReference !== null || evidence.observedTarballSha256 !== null
    || evidence.observedTarballIntegrity !== null || evidence.observedArtifactStatementDigest !== null
    || evidence.observedArtifactSignatureDigest !== null)) throw new ControlPlaneStoreError('invalid-input', 'absent reconciliation contains observed registry state')
  if (evidence.outcome === 'digest-conflict' && (evidence.registryReference === null || evidence.observedTarballSha256 === null
    || evidence.observedTarballIntegrity === null || evidence.observedArtifactStatementDigest === null
    || evidence.observedArtifactSignatureDigest === null
    || (evidence.observedTarballSha256 === evidence.expectedTarballSha256
      && evidence.observedTarballIntegrity === evidence.expectedTarballIntegrity
      && evidence.observedArtifactStatementDigest === evidence.expectedArtifactStatementDigest
      && evidence.observedArtifactSignatureDigest === evidence.expectedArtifactSignatureDigest))) {
    throw new ControlPlaneStoreError('invalid-input', 'digest-conflict reconciliation does not prove a conflicting artifact')
  }
  return Object.freeze(evidence)
}

export function sourcePublishReconciliationRequestDigest(value: SourcePublishReconciliationRequest): string { return digest(value) }
export function sourcePublishReconciliationEvidenceDigest(value: SourcePublishReconciliationEvidence): string { return digest(value) }

export function parseSourcePublishReconciliationReceipt(value: unknown): SourcePublishReconciliationReceipt {
  const item = record(value, 'source publish reconciliation receipt')
  exact(item, ['schemaVersion', 'kind', 'receiptId', 'authority', 'keyId', 'installationId', 'planId', 'planDigest', 'releaseId',
    'fence', 'operationId', 'requestDigest', 'evidence', 'evidenceDigest', 'observedAt', 'expiresAt', 'signature'], 'source publish reconciliation receipt')
  if (item.schemaVersion !== 1 || item.kind !== 'dsh-source-publish-reconciliation-receipt') {
    throw new ControlPlaneStoreError('invalid-input', 'unsupported source publish reconciliation receipt schema')
  }
  const evidence = parseSourcePublishReconciliationEvidence(item.evidence)
  const receipt: SourcePublishReconciliationReceipt = { schemaVersion: 1, kind: 'dsh-source-publish-reconciliation-receipt',
    receiptId: text(item.receiptId, 'receiptId'), authority: text(item.authority, 'authority'), keyId: text(item.keyId, 'keyId'),
    installationId: text(item.installationId, 'installationId', /^[a-f0-9-]{36}$/u), planId: text(item.planId, 'planId'),
    planDigest: digestText(item.planDigest, 'planDigest'), releaseId: text(item.releaseId, 'releaseId'), fence: integer(item.fence, 'fence', 1),
    operationId: text(item.operationId, 'operationId'), requestDigest: digestText(item.requestDigest, 'requestDigest'), evidence,
    evidenceDigest: digestText(item.evidenceDigest, 'evidenceDigest'), observedAt: integer(item.observedAt, 'observedAt'),
    expiresAt: integer(item.expiresAt, 'expiresAt'), signature: signature(item.signature, 'publish reconciliation receipt signature') }
  if (receipt.expiresAt <= receipt.observedAt || receipt.evidenceDigest !== sourcePublishReconciliationEvidenceDigest(evidence)) {
    throw new ControlPlaneStoreError('invalid-input', 'publish reconciliation evidence digest or validity interval is invalid')
  }
  return Object.freeze(receipt)
}

function canonicalReconciliationReceipt(receipt: SourcePublishReconciliationReceipt): string {
  const { signature: _signature, ...fields } = receipt
  return canonical(fields)
}

export function sourcePublishReconciliationSigningPayload(receipt: Omit<SourcePublishReconciliationReceipt, 'signature'>): string {
  return canonicalReconciliationReceipt({ ...receipt, signature: '' })
}

export class Ed25519SourcePublishReconciliationAuthority implements SourcePublishReconciliationAuthority {
  constructor(readonly publicKey: string | Buffer, readonly expectedAuthority: string, readonly expectedKeyId: string,
    readonly now: () => number = Date.now) {}

  async verify(input: SourcePublishReconciliationReceipt, plan: PluginSourcePlan, rawRequest: SourcePublishReconciliationRequest):
  Promise<VerifiedSourcePublishReconciliationReceipt> {
    const request = parseSourcePublishReconciliationRequest(rawRequest); const receipt = parseSourcePublishReconciliationReceipt(input)
    const evidence = receipt.evidence; const now = this.now()
    if (receipt.authority !== this.expectedAuthority || receipt.keyId !== this.expectedKeyId
      || receipt.authority !== request.adapter.authority || receipt.keyId !== request.adapter.keyId
      || receipt.installationId !== request.installationId || receipt.planId !== plan.id || receipt.planDigest !== plan.digest
      || request.plan.id !== plan.id || request.plan.digest !== plan.digest || request.plan.revision !== plan.revision
      || plan.releaseAuthorization === undefined || !same(request.authorization, plan.releaseAuthorization)
      || plan.release?.id !== request.release.id || plan.release.fence !== request.release.fence
      || receipt.releaseId !== request.release.id || receipt.fence !== request.release.fence || receipt.operationId !== request.operationId
      || receipt.requestDigest !== sourcePublishReconciliationRequestDigest(request)
      || evidence.registryId !== request.registry.id || evidence.packageName !== request.artifact.packageName
      || evidence.packageVersion !== request.artifact.packageVersion || evidence.expectedTarballSha256 !== request.artifact.tarballSha256
      || evidence.expectedTarballIntegrity !== request.artifact.tarballIntegrity
      || evidence.expectedArtifactStatementDigest !== request.expectedArtifactStatementDigest
      || evidence.expectedArtifactSignatureDigest !== request.expectedArtifactSignatureDigest
      || (evidence.outcome === 'exists-match' && (evidence.observedArtifactStatementDigest !== request.expectedArtifactStatementDigest
        || evidence.observedArtifactSignatureDigest !== request.expectedArtifactSignatureDigest))
      || evidence.ambiguousPublishOperationId !== request.ambiguousPublish.operationId
      || evidence.ambiguousPublishReceiptDigest !== request.ambiguousPublish.receiptDigest
      || (evidence.registryReference !== null && evidence.registryReference !== request.expectedRegistryReference)) {
      throw new ControlPlaneStoreError('conflict', 'publish reconciliation receipt is not bound to the exact ambiguous publish and artifact')
    }
    if (receipt.observedAt < request.requestedAt || receipt.observedAt > now || now > receipt.expiresAt
      || now > request.authorization.expiresAt || receipt.expiresAt > request.authorization.expiresAt
      || receipt.expiresAt - receipt.observedAt > request.receiptTtlMs) {
      throw new ControlPlaneStoreError('expired', 'publish reconciliation receipt is outside its request-bound validity interval')
    }
    const signatureBytes = Buffer.from(receipt.signature, 'base64')
    if (!verify(null, Buffer.from(canonicalReconciliationReceipt(receipt)), createPublicKey(this.publicKey), signatureBytes)) {
      throw new ControlPlaneStoreError('invalid-input', 'publish reconciliation receipt signature is invalid')
    }
    const { signature: _signature, ...fields } = receipt
    return Object.freeze({ ...fields, signatureDigest: createHash('sha256').update(signatureBytes).digest('hex') })
  }
}

const artifactFields = ['candidateId', 'sourceName', 'packagePath', 'packageName', 'packageVersion', 'tarballPath', 'tarballBytes', 'tarballSha256', 'tarballIntegrity',
  'sbomPath', 'sbomSha256', 'provenancePath', 'provenanceSha256', 'mergedCommit', 'dshBaseline', 'capabilities', 'authorities', 'requires'] as const

function artifact(value: unknown, exactObject = true): SourceReleaseArtifact {
  const item = record(value, 'release artifact')
  if (exactObject) exact(item, artifactFields, 'release artifact')
  const candidate = parseCatalog({ schemaVersion: 1, entries: [{ id: 'released-artifact', package: item.packageName,
    version: item.packageVersion, integrity: item.tarballIntegrity, requires: item.requires,
    dshBaseline: item.dshBaseline, capabilities: item.capabilities, authorities: item.authorities }] }).entries[0]!
  const tarballPath = absolutePath(item.tarballPath, 'tarballPath'); const sbomPath = absolutePath(item.sbomPath, 'sbomPath')
  const provenancePath = absolutePath(item.provenancePath, 'provenancePath')
  const integrityBytes = Buffer.from(candidate.integrity.slice('sha512-'.length), 'base64')
  if (integrityBytes.length !== 64 || `sha512-${integrityBytes.toString('base64')}` !== candidate.integrity) throw new ControlPlaneStoreError('invalid-input', 'tarballIntegrity is not canonical SHA-512')
  if (!same(item.capabilities, candidate.capabilities) || !same(item.authorities, candidate.authorities) || !same(item.requires, candidate.requires)) {
    throw new ControlPlaneStoreError('invalid-input', 'release artifact metadata must be canonical and sorted')
  }
  return { candidateId: text(item.candidateId, 'candidateId', /^[a-z0-9][a-z0-9-]{0,63}$/u),
    sourceName: text(item.sourceName, 'sourceName', /^[a-z0-9][a-z0-9-]{0,63}$/u), packagePath: relativePath(item.packagePath, 'packagePath'),
    packageName: candidate.package, packageVersion: candidate.version, tarballPath,
    tarballBytes: integer(item.tarballBytes, 'tarballBytes', 1), tarballSha256: text(item.tarballSha256, 'tarballSha256', DIGEST),
    tarballIntegrity: candidate.integrity, sbomPath, sbomSha256: text(item.sbomSha256, 'sbomSha256', DIGEST),
    provenancePath, provenanceSha256: text(item.provenanceSha256, 'provenanceSha256', DIGEST),
    mergedCommit: text(item.mergedCommit, 'mergedCommit', COMMIT), dshBaseline: candidate.dshBaseline,
    capabilities: candidate.capabilities, authorities: candidate.authorities, requires: candidate.requires }
}

function adapterIdentity(value: unknown): SourceReleaseRequest['adapter'] {
  const item = record(value, 'release adapter identity')
  exact(item, ['id', 'version', 'path', 'sha256', 'interpreter', 'authority', 'keyId'], 'release adapter identity')
  let interpreter: SourceReleaseRequest['adapter']['interpreter'] = null
  if (item.interpreter !== null) {
    const raw = record(item.interpreter, 'release adapter interpreter')
    exact(raw, ['path', 'sha256'], 'release adapter interpreter')
    interpreter = Object.freeze({ path: absolutePath(raw.path, 'adapter.interpreter.path'),
      sha256: digestText(raw.sha256, 'adapter.interpreter.sha256') })
  }
  return Object.freeze({ id: text(item.id, 'adapter.id'), version: text(item.version, 'adapter.version', /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u),
    path: absolutePath(item.path, 'adapter.path'), sha256: digestText(item.sha256, 'adapter.sha256'), interpreter,
    authority: text(item.authority, 'adapter.authority'), keyId: text(item.keyId, 'adapter.keyId') })
}

function artifactMatchesPolicy(value: SourceReleaseArtifact, policy: SourceReleasePolicy): boolean {
  return value.candidateId === policy.candidateId && value.sourceName === policy.candidateId && value.packagePath === policy.packagePath
    && value.packageName === policy.packageName && value.packageVersion === policy.packageVersion
    && value.dshBaseline === policy.dshBaseline && same(value.capabilities, policy.capabilities)
    && same(value.authorities, policy.authorities) && same(value.requires, policy.requires)
}

function requestBase(value: Record<string, unknown>): Omit<SourceReleaseRequest, 'phase' | 'input'> {
  const ledger = record(value.ledger, 'release request ledger'); exact(ledger, ['id', 'path'], 'release request ledger')
  const plan = record(value.plan, 'release request plan'); exact(plan, ['id', 'digest', 'revision'], 'release request plan')
  const release = record(value.release, 'release request release'); exact(release, ['id', 'fence'], 'release request release')
  const registry = record(value.registry, 'release request registry'); exact(registry, ['id', 'locator'], 'release request registry')
  const catalog = record(value.catalog, 'release request catalog'); exact(catalog, ['id', 'path'], 'release request catalog')
  const authorization = parseVerifiedSourceReleaseAuthorization(value.authorization)
  const result = { schemaVersion: 1 as const, kind: 'dsh-source-release-request' as const, operationId: text(value.operationId, 'operationId'),
    attempt: integer(value.attempt, 'attempt', 1), requestedAt: integer(value.requestedAt, 'requestedAt'),
    receiptTtlMs: integer(value.receiptTtlMs, 'receiptTtlMs', 1_000),
    installationId: text(value.installationId, 'installationId', /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u),
    ledger: Object.freeze({ id: text(ledger.id, 'ledger.id'), path: absolutePath(ledger.path, 'ledger.path') }),
    plan: Object.freeze({ id: text(plan.id, 'plan.id'), digest: digestText(plan.digest, 'plan.digest'), revision: integer(plan.revision, 'plan.revision', 1) }),
    release: Object.freeze({ id: text(release.id, 'release.id'), fence: integer(release.fence, 'release.fence', 1) }),
    authorization, adapter: adapterIdentity(value.adapter),
    registry: Object.freeze({ id: text(registry.id, 'registry.id'), locator: opaqueLine(registry.locator, 'registry.locator') }),
    catalog: Object.freeze({ id: text(catalog.id, 'catalog.id'), path: absolutePath(catalog.path, 'catalog.path') }) }
  if (result.receiptTtlMs > 300_000 || authorization.planId !== result.plan.id || authorization.planDigest !== result.plan.digest
    || result.requestedAt < authorization.authorizedAt || result.requestedAt > authorization.expiresAt
    || authorization.releasePolicy.registryId !== result.registry.id || authorization.releasePolicy.registryLocator !== result.registry.locator
    || authorization.releasePolicy.catalogId !== result.catalog.id || authorization.releasePolicy.catalogPath !== result.catalog.path) {
    throw new ControlPlaneStoreError('conflict', 'release request is not bound to its authorization, plan, registry, and catalog')
  }
  return result
}

export function parseSourceReleaseRequest(value: unknown): SourceReleaseRequest {
  const item = record(value, 'source release request')
  exact(item, ['schemaVersion', 'kind', 'operationId', 'attempt', 'requestedAt', 'receiptTtlMs', 'installationId', 'ledger', 'plan',
    'release', 'authorization', 'adapter', 'registry', 'catalog', 'phase', 'input'], 'source release request')
  if (item.schemaVersion !== 1 || item.kind !== 'dsh-source-release-request' || typeof item.phase !== 'string'
    || !phases.has(item.phase as SourceReleasePhase)) throw new ControlPlaneStoreError('invalid-input', 'source release request fields are invalid')
  const base = requestBase(item); const input = record(item.input, `${item.phase} request input`); const policy = base.authorization.releasePolicy
  let result: SourceReleaseRequest
  if (item.phase === 'pr') {
    exact(input, ['repository', 'worktree', 'baseCommit', 'name', 'scope', 'expectedTreeDigest', 'expectedPatchDigest'], 'PR request input')
    result = { ...base, phase: 'pr', input: { repository: absolutePath(input.repository, 'repository'), worktree: absolutePath(input.worktree, 'worktree'),
      baseCommit: commit(input.baseCommit, 'baseCommit'), name: text(input.name, 'name', /^[a-z0-9][a-z0-9-]{0,63}$/u), scope: scopeList(input.scope),
      expectedTreeDigest: digestText(input.expectedTreeDigest, 'expectedTreeDigest'), expectedPatchDigest: digestText(input.expectedPatchDigest, 'expectedPatchDigest') } }
    if (result.input.baseCommit !== base.authorization.baseCommit || result.input.name !== policy.candidateId
      || !same(result.input.scope, base.authorization.scope) || result.input.expectedTreeDigest !== base.authorization.checkedTreeDigest
      || result.input.expectedPatchDigest !== base.authorization.checkedPatchDigest) throw new ControlPlaneStoreError('conflict', 'PR request does not bind the authorized checked source')
  } else if (item.phase === 'review') {
    exact(input, ['prId', 'headCommit', 'baseCommit', 'prEvidenceDigest'], 'review request input')
    result = { ...base, phase: 'review', input: { prId: text(input.prId, 'prId'), headCommit: commit(input.headCommit, 'headCommit'),
      baseCommit: commit(input.baseCommit, 'baseCommit'), prEvidenceDigest: digestText(input.prEvidenceDigest, 'prEvidenceDigest') } }
    if (result.input.baseCommit !== base.authorization.baseCommit) throw new ControlPlaneStoreError('conflict', 'review request does not bind the authorized base commit')
  } else if (item.phase === 'merge') {
    exact(input, ['prId', 'headCommit', 'reviewId', 'reviewEvidenceDigest', 'targetBranch'], 'merge request input')
    result = { ...base, phase: 'merge', input: { prId: text(input.prId, 'prId'), headCommit: commit(input.headCommit, 'headCommit'),
      reviewId: text(input.reviewId, 'reviewId'), reviewEvidenceDigest: digestText(input.reviewEvidenceDigest, 'reviewEvidenceDigest'),
      targetBranch: branch(input.targetBranch, 'targetBranch') } }
    if (result.input.targetBranch !== policy.targetBranch) throw new ControlPlaneStoreError('conflict', 'merge request does not bind the authorized target branch')
  } else if (item.phase === 'build') {
    exact(input, ['repository', 'mergeCommit', 'mergeEvidenceDigest', 'name', 'expectedCandidateId', 'expectedPackageName',
      'expectedPackageVersion', 'expectedPackagePath', 'expectedDshBaseline', 'expectedCapabilities', 'expectedAuthorities', 'expectedRequires'], 'build request input')
    result = { ...base, phase: 'build', input: { repository: absolutePath(input.repository, 'repository'), mergeCommit: commit(input.mergeCommit, 'mergeCommit'),
      mergeEvidenceDigest: digestText(input.mergeEvidenceDigest, 'mergeEvidenceDigest'), name: text(input.name, 'name', /^[a-z0-9][a-z0-9-]{0,63}$/u),
      expectedCandidateId: text(input.expectedCandidateId, 'expectedCandidateId', /^[a-z0-9][a-z0-9-]{0,63}$/u),
      expectedPackageName: text(input.expectedPackageName, 'expectedPackageName', PACKAGE), expectedPackageVersion: text(input.expectedPackageVersion, 'expectedPackageVersion', VERSION),
      expectedPackagePath: relativePath(input.expectedPackagePath, 'expectedPackagePath'), expectedDshBaseline: text(input.expectedDshBaseline, 'expectedDshBaseline', VERSION),
      expectedCapabilities: stringList(input.expectedCapabilities, 'expectedCapabilities'), expectedAuthorities: stringList(input.expectedAuthorities, 'expectedAuthorities'),
      expectedRequires: requirements(input.expectedRequires, String(input.expectedPackageName), 'expectedRequires') } }
    if (result.input.name !== policy.candidateId || result.input.expectedCandidateId !== policy.candidateId
      || result.input.expectedPackageName !== policy.packageName || result.input.expectedPackageVersion !== policy.packageVersion
      || result.input.expectedPackagePath !== policy.packagePath || result.input.expectedDshBaseline !== policy.dshBaseline
      || !same(result.input.expectedCapabilities, policy.capabilities) || !same(result.input.expectedAuthorities, policy.authorities)
      || !same(result.input.expectedRequires, policy.requires)) throw new ControlPlaneStoreError('conflict', 'build request does not bind the authorized candidate policy')
  } else if (item.phase === 'sign') {
    exact(input, ['artifact', 'buildEvidenceDigest'], 'sign request input')
    result = { ...base, phase: 'sign', input: { artifact: artifact(input.artifact), buildEvidenceDigest: digestText(input.buildEvidenceDigest, 'buildEvidenceDigest') } }
  } else if (item.phase === 'publish') {
    exact(input, ['artifact', 'artifactStatementDigest', 'artifactSignature', 'signEvidenceDigest'], 'publish request input')
    result = { ...base, phase: 'publish', input: { artifact: artifact(input.artifact), artifactStatementDigest: digestText(input.artifactStatementDigest, 'artifactStatementDigest'),
      artifactSignature: signature(input.artifactSignature, 'artifactSignature'), signEvidenceDigest: digestText(input.signEvidenceDigest, 'signEvidenceDigest') } }
  } else if (item.phase === 'registry-verify') {
    exact(input, ['artifact', 'artifactStatementDigest', 'artifactSignature', 'registryReference', 'publishEvidenceDigest'], 'registry verification request input')
    result = { ...base, phase: 'registry-verify', input: { artifact: artifact(input.artifact), artifactStatementDigest: digestText(input.artifactStatementDigest, 'artifactStatementDigest'),
      artifactSignature: signature(input.artifactSignature, 'artifactSignature'), registryReference: opaqueLine(input.registryReference, 'registryReference'),
      publishEvidenceDigest: digestText(input.publishEvidenceDigest, 'publishEvidenceDigest') } }
  } else {
    exact(input, ['artifact', 'artifactStatementDigest', 'artifactSignature', 'registryReference', 'registryVerificationRequest',
      'registryVerificationReceipt', 'verificationEvidenceDigest',
      'expectedBeforeCatalogDigest', 'expectedAfterCatalogDigest', 'candidate'], 'catalog admission request input')
    const rawRegistryVerificationRequest = record(input.registryVerificationRequest, 'registry verification request')
    if (rawRegistryVerificationRequest.phase !== 'registry-verify') {
      throw new ControlPlaneStoreError('invalid-input', 'nested registry verification request must use registry-verify phase')
    }
    const registryVerificationRequest = parseSourceReleaseRequest(rawRegistryVerificationRequest)
    if (registryVerificationRequest.phase !== 'registry-verify') {
      throw new ControlPlaneStoreError('invalid-input', 'nested registry verification request must use registry-verify phase')
    }
    const registryVerificationReceipt = parseSourceReleaseReceipt(input.registryVerificationReceipt)
    result = { ...base, phase: 'catalog-admission', input: { artifact: artifact(input.artifact), artifactStatementDigest: digestText(input.artifactStatementDigest, 'artifactStatementDigest'),
      artifactSignature: signature(input.artifactSignature, 'artifactSignature'), registryReference: opaqueLine(input.registryReference, 'registryReference'),
      registryVerificationRequest, registryVerificationReceipt,
      verificationEvidenceDigest: digestText(input.verificationEvidenceDigest, 'verificationEvidenceDigest'),
      expectedBeforeCatalogDigest: digestText(input.expectedBeforeCatalogDigest, 'expectedBeforeCatalogDigest'),
      expectedAfterCatalogDigest: digestText(input.expectedAfterCatalogDigest, 'expectedAfterCatalogDigest'), candidate: catalogEntry(input.candidate, 'catalog candidate') } }
    if (result.input.expectedBeforeCatalogDigest === result.input.expectedAfterCatalogDigest) throw new ControlPlaneStoreError('invalid-input', 'catalog admission must authorize one exact catalog change')
  }
  if ('artifact' in result.input && !artifactMatchesPolicy(result.input.artifact, policy)) {
    throw new ControlPlaneStoreError('conflict', 'release artifact does not match the authorized candidate policy')
  }
  if ('artifact' in result.input && 'artifactStatementDigest' in result.input
    && result.input.artifactStatementDigest !== sourceArtifactStatementDigest(result.input.artifact)) {
    throw new ControlPlaneStoreError('conflict', 'release request statement digest does not match its exact artifact')
  }
  if ((result.phase === 'registry-verify' || result.phase === 'catalog-admission') && result.input.registryReference !== policy.registryReference) {
    throw new ControlPlaneStoreError('conflict', 'release request does not bind the authorized immutable registry reference')
  }
  if (result.phase === 'catalog-admission') {
    const registryReceipt = result.input.registryVerificationReceipt
    const registryRequest = result.input.registryVerificationRequest
    const registryEvidence = registryReceipt.evidence
    const artifactSignatureDigest = createHash('sha256').update(Buffer.from(result.input.artifactSignature, 'base64')).digest('hex')
    if (registryReceipt.phase !== 'registry-verify' || registryReceipt.outcome !== 'passed' || registryEvidence.kind !== 'registry-verify'
      || registryReceipt.installationId !== result.installationId || registryReceipt.planId !== result.plan.id
      || registryReceipt.planDigest !== result.plan.digest || registryReceipt.releaseId !== result.release.id
      || registryReceipt.fence !== result.release.fence || registryReceipt.evidenceDigest !== result.input.verificationEvidenceDigest
      || registryReceipt.operationId !== registryRequest.operationId
      || registryReceipt.requestDigest !== sourceReleaseRequestDigest(registryRequest)
      || registryRequest.installationId !== result.installationId || registryRequest.plan.id !== result.plan.id
      || registryRequest.plan.digest !== result.plan.digest || registryRequest.plan.revision + 1 !== result.plan.revision
      || registryRequest.requestedAt < registryRequest.authorization.authorizedAt
      || registryRequest.requestedAt > registryRequest.authorization.expiresAt
      || registryRequest.release.id !== result.release.id
      || registryRequest.release.fence !== result.release.fence
      || registryReceipt.observedAt < registryRequest.requestedAt
      || registryReceipt.expiresAt > registryRequest.authorization.expiresAt
      || registryReceipt.expiresAt - registryReceipt.observedAt > registryRequest.receiptTtlMs
      || registryReceipt.authority !== registryRequest.adapter.authority || registryReceipt.keyId !== registryRequest.adapter.keyId
      || !same(registryRequest.authorization, result.authorization) || !same(registryRequest.ledger, result.ledger)
      || !same(registryRequest.registry, result.registry) || !same(registryRequest.catalog, result.catalog)
      || !same(registryRequest.input.artifact, result.input.artifact)
      || registryRequest.input.registryReference !== result.input.registryReference
      || registryRequest.input.artifactStatementDigest !== result.input.artifactStatementDigest
      || registryRequest.input.artifactSignature !== result.input.artifactSignature
      || registryEvidence.registryId !== result.registry.id || registryEvidence.registryReference !== result.input.registryReference
      || registryEvidence.downloadedBytes !== result.input.artifact.tarballBytes
      || registryEvidence.downloadedSha256 !== result.input.artifact.tarballSha256
      || registryEvidence.downloadedIntegrity !== result.input.artifact.tarballIntegrity
      || registryEvidence.artifactStatementDigest !== result.input.artifactStatementDigest
      || registryEvidence.artifactSignatureDigest !== artifactSignatureDigest
      || registryEvidence.publishEvidenceDigest !== registryRequest.input.publishEvidenceDigest) {
      throw new ControlPlaneStoreError('conflict', 'catalog admission registry verification receipt does not bind the exact request, release fence, and signed artifact')
    }
    const expectedCandidate = { id: policy.candidateId, package: policy.packageName, version: policy.packageVersion,
      integrity: result.input.artifact.tarballIntegrity, registry: { id: policy.registryId, locator: policy.registryLocator,
        reference: policy.registryReference }, requires: policy.requires, dshBaseline: policy.dshBaseline,
      capabilities: policy.capabilities, authorities: policy.authorities }
    if (!same(result.input.candidate, expectedCandidate)) throw new ControlPlaneStoreError('conflict', 'catalog candidate does not match the authorized verified artifact')
  }
  return Object.freeze(result)
}

function parseSuccessEvidence(value: Record<string, unknown>): SourceReleaseSuccessEvidence {
  const kind = value.kind
  if (kind === 'pr') {
    exact(value, ['kind', 'prId', 'baseCommit', 'headCommit', 'treeDigest', 'patchDigest', 'repositoryDigest'], 'PR evidence')
    return { kind, prId: text(value.prId, 'prId'), baseCommit: text(value.baseCommit, 'baseCommit', COMMIT),
      headCommit: text(value.headCommit, 'headCommit', COMMIT), treeDigest: digestText(value.treeDigest, 'treeDigest'),
      patchDigest: digestText(value.patchDigest, 'patchDigest'), repositoryDigest: digestText(value.repositoryDigest, 'repositoryDigest') }
  }
  if (kind === 'review') {
    exact(value, ['kind', 'prId', 'headCommit', 'reviewId', 'decision', 'reviewerPrincipalDigest', 'prEvidenceDigest'], 'review evidence')
    if (value.decision !== 'approved') throw new ControlPlaneStoreError('invalid-input', 'review decision is not approved')
    return { kind, prId: text(value.prId, 'prId'), headCommit: text(value.headCommit, 'headCommit', COMMIT),
      reviewId: text(value.reviewId, 'reviewId'), decision: value.decision,
      reviewerPrincipalDigest: digestText(value.reviewerPrincipalDigest, 'reviewerPrincipalDigest'),
      prEvidenceDigest: digestText(value.prEvidenceDigest, 'prEvidenceDigest') }
  }
  if (kind === 'merge') {
    exact(value, ['kind', 'prId', 'reviewedHeadCommit', 'reviewId', 'reviewEvidenceDigest', 'mergeCommit', 'targetBranch'], 'merge evidence')
    return { kind, prId: text(value.prId, 'prId'), reviewedHeadCommit: text(value.reviewedHeadCommit, 'reviewedHeadCommit', COMMIT),
      reviewId: text(value.reviewId, 'reviewId'), reviewEvidenceDigest: digestText(value.reviewEvidenceDigest, 'reviewEvidenceDigest'),
      mergeCommit: text(value.mergeCommit, 'mergeCommit', COMMIT), targetBranch: opaqueLine(value.targetBranch, 'targetBranch', 255) }
  }
  if (kind === 'build') {
    exact(value, ['kind', 'isolated', 'reproducibleBuilds', 'firstBuildSha256', 'secondBuildSha256', 'mergeEvidenceDigest', ...artifactFields], 'build evidence')
    if (value.isolated !== true) throw new ControlPlaneStoreError('invalid-input', 'build was not isolated')
    return { kind, isolated: true, reproducibleBuilds: integer(value.reproducibleBuilds, 'reproducibleBuilds', 2),
      firstBuildSha256: text(value.firstBuildSha256, 'firstBuildSha256', DIGEST), secondBuildSha256: text(value.secondBuildSha256, 'secondBuildSha256', DIGEST),
      mergeEvidenceDigest: digestText(value.mergeEvidenceDigest, 'mergeEvidenceDigest'), ...artifact(value, false) }
  }
  if (kind === 'sign') {
    exact(value, ['kind', 'artifactStatementDigest', 'artifactSignature', 'artifactSignatureDigest', 'buildEvidenceDigest'], 'sign evidence')
    const artifactSignature = signature(value.artifactSignature, 'artifactSignature')
    return { kind, artifactStatementDigest: text(value.artifactStatementDigest, 'artifactStatementDigest', DIGEST), artifactSignature,
      artifactSignatureDigest: text(value.artifactSignatureDigest, 'artifactSignatureDigest', DIGEST),
      buildEvidenceDigest: digestText(value.buildEvidenceDigest, 'buildEvidenceDigest') }
  }
  if (kind === 'publish') {
    exact(value, ['kind', 'registryId', 'registryReference', 'packageName', 'packageVersion', 'tarballSha256', 'tarballIntegrity',
      'artifactStatementDigest', 'artifactSignatureDigest', 'signEvidenceDigest', 'immutable'], 'publish evidence')
    if (value.immutable !== true) throw new ControlPlaneStoreError('invalid-input', 'registry publication is not immutable')
    return { kind, registryId: text(value.registryId, 'registryId'), registryReference: opaqueLine(value.registryReference, 'registryReference'),
      packageName: text(value.packageName, 'packageName', /^[a-z0-9@/._-]+$/u), packageVersion: text(value.packageVersion, 'packageVersion', /^[A-Za-z0-9._+-]+$/u),
      tarballSha256: text(value.tarballSha256, 'tarballSha256', DIGEST), tarballIntegrity: integrity(value.tarballIntegrity, 'tarballIntegrity'),
      artifactStatementDigest: text(value.artifactStatementDigest, 'artifactStatementDigest', DIGEST),
      artifactSignatureDigest: text(value.artifactSignatureDigest, 'artifactSignatureDigest', DIGEST),
      signEvidenceDigest: digestText(value.signEvidenceDigest, 'signEvidenceDigest'), immutable: true }
  }
  if (kind === 'registry-verify') {
    exact(value, ['kind', 'registryId', 'registryReference', 'independentlyDownloaded', 'downloadedBytes', 'downloadedSha256',
      'downloadedIntegrity', 'artifactStatementDigest', 'artifactSignatureDigest', 'publishEvidenceDigest'], 'registry verification evidence')
    if (value.independentlyDownloaded !== true) throw new ControlPlaneStoreError('invalid-input', 'artifact was not independently downloaded')
    return { kind, registryId: text(value.registryId, 'registryId'), registryReference: opaqueLine(value.registryReference, 'registryReference'),
      independentlyDownloaded: true, downloadedBytes: integer(value.downloadedBytes, 'downloadedBytes', 1),
      downloadedSha256: text(value.downloadedSha256, 'downloadedSha256', DIGEST), downloadedIntegrity: integrity(value.downloadedIntegrity, 'downloadedIntegrity'),
      artifactStatementDigest: text(value.artifactStatementDigest, 'artifactStatementDigest', DIGEST),
      artifactSignatureDigest: text(value.artifactSignatureDigest, 'artifactSignatureDigest', DIGEST),
      publishEvidenceDigest: digestText(value.publishEvidenceDigest, 'publishEvidenceDigest') }
  }
  if (kind === 'catalog-admission') {
    exact(value, ['kind', 'admissionId', 'catalogId', 'beforeCatalogDigest', 'afterCatalogDigest', 'registryReference',
      'artifactStatementDigest', 'artifactSignatureDigest', 'verificationEvidenceDigest', 'candidate'], 'catalog admission evidence')
    const candidate = catalogEntry(value.candidate, 'catalog admission candidate')
    return { kind, admissionId: text(value.admissionId, 'admissionId'), catalogId: text(value.catalogId, 'catalogId'),
      beforeCatalogDigest: text(value.beforeCatalogDigest, 'beforeCatalogDigest', DIGEST), afterCatalogDigest: text(value.afterCatalogDigest, 'afterCatalogDigest', DIGEST),
      registryReference: opaqueLine(value.registryReference, 'registryReference'), artifactStatementDigest: digestText(value.artifactStatementDigest, 'artifactStatementDigest'),
      artifactSignatureDigest: digestText(value.artifactSignatureDigest, 'artifactSignatureDigest'),
      verificationEvidenceDigest: text(value.verificationEvidenceDigest, 'verificationEvidenceDigest', DIGEST), candidate }
  }
  throw new ControlPlaneStoreError('invalid-input', 'release success evidence kind is invalid')
}

export function sourceReleaseEvidenceDigest(value: SourceReleaseReceipt['evidence']): string { return digest(value) }
export function sourceReleaseRequestDigest(value: SourceReleaseRequest): string { return digest(value) }
export function sourceArtifactStatementDigest(value: SourceReleaseArtifact): string { return digest(value) }
export function sourceArtifactSigningPayload(value: SourceReleaseArtifact): string { return canonical({ schemaVersion: 1, kind: 'dsh-release-artifact', artifact: value }) }

export function parseSourceReleaseReceipt(value: unknown): SourceReleaseReceipt {
  const item = record(value, 'source release receipt')
  exact(item, ['schemaVersion', 'receiptId', 'authority', 'keyId', 'installationId', 'planId', 'planDigest', 'releaseId', 'fence',
    'operationId', 'requestDigest', 'phase', 'outcome', 'evidence', 'evidenceDigest', 'observedAt', 'expiresAt', 'signature'], 'source release receipt')
  if (item.schemaVersion !== 1 || typeof item.phase !== 'string' || !phases.has(item.phase as SourceReleasePhase)
    || !['passed', 'failed', 'ambiguous'].includes(String(item.outcome))) {
    throw new ControlPlaneStoreError('invalid-input', 'source release receipt fields are invalid')
  }
  const evidenceItem = record(item.evidence, 'source release evidence')
  let evidence: SourceReleaseReceipt['evidence']
  if (item.outcome === 'passed') evidence = parseSuccessEvidence(evidenceItem)
  else if (item.outcome === 'failed') {
    exact(evidenceItem, ['kind', 'phase', 'code', 'remoteState', 'detailDigest'], 'release failure evidence')
    if (evidenceItem.kind !== 'failure' || evidenceItem.phase !== item.phase
      || !['unchanged', 'created-not-reverted', 'unknown'].includes(String(evidenceItem.remoteState))) throw new ControlPlaneStoreError('invalid-input', 'release failure evidence is invalid')
    evidence = { kind: 'failure', phase: item.phase as SourceReleasePhase, code: text(evidenceItem.code, 'failure code'),
      remoteState: evidenceItem.remoteState as 'unchanged' | 'created-not-reverted' | 'unknown', detailDigest: text(evidenceItem.detailDigest, 'detailDigest', DIGEST) }
  } else {
    exact(evidenceItem, ['kind', 'registryId', 'packageName', 'packageVersion', 'tarballSha256', 'detailDigest'], 'publish ambiguity evidence')
    if (item.phase !== 'publish' || evidenceItem.kind !== 'publish-ambiguity') throw new ControlPlaneStoreError('invalid-input', 'only publish may be ambiguous')
    evidence = { kind: 'publish-ambiguity', registryId: text(evidenceItem.registryId, 'registryId'),
      packageName: text(evidenceItem.packageName, 'packageName', /^[a-z0-9@/._-]+$/u), packageVersion: text(evidenceItem.packageVersion, 'packageVersion', /^[A-Za-z0-9._+-]+$/u),
      tarballSha256: text(evidenceItem.tarballSha256, 'tarballSha256', DIGEST), detailDigest: text(evidenceItem.detailDigest, 'detailDigest', DIGEST) }
  }
  const receipt: SourceReleaseReceipt = { schemaVersion: 1, receiptId: text(item.receiptId, 'receiptId'), authority: text(item.authority, 'authority'),
    keyId: text(item.keyId, 'keyId'), installationId: text(item.installationId, 'installationId', /^[a-f0-9-]{36}$/u), planId: text(item.planId, 'planId'),
    planDigest: text(item.planDigest, 'planDigest', DIGEST), releaseId: text(item.releaseId, 'releaseId'), fence: integer(item.fence, 'fence', 1),
    operationId: text(item.operationId, 'operationId'), requestDigest: text(item.requestDigest, 'requestDigest', DIGEST), phase: item.phase as SourceReleasePhase,
    outcome: item.outcome as SourceReleaseReceipt['outcome'], evidence, evidenceDigest: text(item.evidenceDigest, 'evidenceDigest', DIGEST),
    observedAt: integer(item.observedAt, 'observedAt'), expiresAt: integer(item.expiresAt, 'expiresAt'),
    signature: signature(item.signature, 'release receipt signature') }
  if (receipt.expiresAt <= receipt.observedAt || sourceReleaseEvidenceDigest(evidence) !== receipt.evidenceDigest) throw new ControlPlaneStoreError('invalid-input', 'release evidence digest or validity interval is invalid')
  return receipt
}

function canonicalReceipt(receipt: SourceReleaseReceipt): string {
  const { signature: _signature, ...fields } = receipt
  return canonical(fields)
}
export function sourceReleaseSigningPayload(receipt: Omit<SourceReleaseReceipt, 'signature'>): string {
  return canonicalReceipt({ ...receipt, signature: '' })
}

interface StableFileSnapshot {
  bytes: Buffer
  device: bigint
  inode: bigint
  parentDevice: bigint
  parentInode: bigint
  parentMtimeNs: bigint
  parentCtimeNs: bigint
}
interface OpenStableFileSnapshot extends StableFileSnapshot { path: string; handle: FileHandle; maximum: number }

async function snapshotStableFile(path: string, handle: FileHandle, maximum: number): Promise<StableFileSnapshot> {
  const parentPath = dirname(path); const parentBefore = await lstat(parentPath, { bigint: true }); const uid = process.getuid?.()
  const expectedUid = uid === undefined ? undefined : BigInt(uid)
  const before = await handle.stat({ bigint: true }); const pathBefore = await lstat(path, { bigint: true })
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink() || (parentBefore.mode & 0o022n) !== 0n
    || (expectedUid !== undefined && parentBefore.uid !== expectedUid && parentBefore.uid !== 0n)
    || await realpath(parentPath) !== resolve(parentPath)) throw new ControlPlaneStoreError('invalid-input', 'artifact evidence directory is unsafe')
  if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum) || (before.mode & 0o022n) !== 0n
    || (expectedUid !== undefined && before.uid !== expectedUid && before.uid !== 0n) || !pathBefore.isFile() || pathBefore.isSymbolicLink()
    || pathBefore.dev !== before.dev || pathBefore.ino !== before.ino) throw new ControlPlaneStoreError('invalid-input', 'artifact evidence file is unsafe')
  const bytes = Buffer.alloc(Number(before.size)); let offset = 0
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset)
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }
  const after = await handle.stat({ bigint: true }); const pathAfter = await lstat(path, { bigint: true })
  const parentAfter = await lstat(parentPath, { bigint: true })
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs
    || after.ctimeNs !== before.ctimeNs || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || BigInt(offset) !== before.size
    || parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino) {
    throw new ControlPlaneStoreError('invalid-input', 'artifact evidence file changed or its path was replaced during verification')
  }
  return { bytes, device: before.dev, inode: before.ino, parentDevice: parentAfter.dev, parentInode: parentAfter.ino,
    parentMtimeNs: parentAfter.mtimeNs, parentCtimeNs: parentAfter.ctimeNs }
}

async function openStableFile(path: string, maximum: number): Promise<OpenStableFileSnapshot> {
  if (!isAbsolute(path) || await realpath(path) !== resolve(path)) throw new ControlPlaneStoreError('invalid-input', 'artifact evidence path is not canonical')
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    return { path, handle, maximum, ...await snapshotStableFile(path, handle, maximum) }
  } catch (error) { await handle.close(); throw error }
}

async function readStableFile(path: string, maximum: number): Promise<StableFileSnapshot> {
  const opened = await openStableFile(path, maximum)
  try { return opened } finally { await opened.handle.close() }
}

async function digestFile(path: string, maximum: number): Promise<{ bytes: number; sha256: string; integrity: string; device: bigint; inode: bigint;
  parentDevice: bigint; parentInode: bigint; parentMtimeNs: bigint; parentCtimeNs: bigint }> {
  const snapshot = await readStableFile(path, maximum)
  return { bytes: snapshot.bytes.length, sha256: createHash('sha256').update(snapshot.bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(snapshot.bytes).digest('base64')}`, device: snapshot.device, inode: snapshot.inode,
    parentDevice: snapshot.parentDevice, parentInode: snapshot.parentInode, parentMtimeNs: snapshot.parentMtimeNs, parentCtimeNs: snapshot.parentCtimeNs }
}

interface ArtifactSnapshot {
  tarball: Awaited<ReturnType<typeof digestFile>>
  sbom: Awaited<ReturnType<typeof digestFile>>
  provenance: Awaited<ReturnType<typeof digestFile>>
}
type OpenArtifactFileSnapshot = ArtifactSnapshot['tarball'] & Pick<OpenStableFileSnapshot, 'path' | 'maximum'>
interface OpenArtifactSnapshot {
  tarball: OpenArtifactFileSnapshot
  sbom: OpenArtifactFileSnapshot
  provenance: OpenArtifactFileSnapshot
  handles: readonly [FileHandle, FileHandle, FileHandle]
}

async function artifactSnapshot(value: SourceReleaseArtifact): Promise<ArtifactSnapshot> {
  const tarball = await digestFile(value.tarballPath, 268_435_456); const sbom = await digestFile(value.sbomPath, 16_777_216)
  const provenance = await digestFile(value.provenancePath, 16_777_216)
  const identities = new Set([`${tarball.device}:${tarball.inode}`, `${sbom.device}:${sbom.inode}`, `${provenance.device}:${provenance.inode}`])
  if (identities.size !== 3 || tarball.bytes !== value.tarballBytes || tarball.sha256 !== value.tarballSha256
    || tarball.integrity !== value.tarballIntegrity || sbom.sha256 !== value.sbomSha256 || provenance.sha256 !== value.provenanceSha256) {
    throw new ControlPlaneStoreError('invalid-input', 'artifact/SBOM/provenance bytes do not match signed evidence')
  }
  return Object.freeze({ tarball, sbom, provenance })
}

async function openArtifactSnapshot(value: SourceReleaseArtifact): Promise<OpenArtifactSnapshot> {
  const opened: OpenStableFileSnapshot[] = []
  try {
    opened.push(await openStableFile(value.tarballPath, 268_435_456))
    opened.push(await openStableFile(value.sbomPath, 16_777_216))
    opened.push(await openStableFile(value.provenancePath, 16_777_216))
    const [tarballOpen, sbomOpen, provenanceOpen] = opened as [OpenStableFileSnapshot, OpenStableFileSnapshot, OpenStableFileSnapshot]
    const tarball = { ...tarballOpen, bytes: tarballOpen.bytes.length, sha256: createHash('sha256').update(tarballOpen.bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(tarballOpen.bytes).digest('base64')}` }
    const sbom = { ...sbomOpen, bytes: sbomOpen.bytes.length, sha256: createHash('sha256').update(sbomOpen.bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(sbomOpen.bytes).digest('base64')}` }
    const provenance = { ...provenanceOpen, bytes: provenanceOpen.bytes.length, sha256: createHash('sha256').update(provenanceOpen.bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(provenanceOpen.bytes).digest('base64')}` }
    const identities = new Set([`${tarball.device}:${tarball.inode}`, `${sbom.device}:${sbom.inode}`, `${provenance.device}:${provenance.inode}`])
    if (identities.size !== 3 || tarball.bytes !== value.tarballBytes || tarball.sha256 !== value.tarballSha256
      || tarball.integrity !== value.tarballIntegrity || sbom.sha256 !== value.sbomSha256 || provenance.sha256 !== value.provenanceSha256) {
      throw new ControlPlaneStoreError('invalid-input', 'artifact/SBOM/provenance bytes do not match signed evidence')
    }
    return { tarball, sbom, provenance, handles: [tarballOpen.handle, sbomOpen.handle, provenanceOpen.handle] }
  } catch (error) { await Promise.all(opened.map(async item => item.handle.close())); throw error }
}

async function verifyOpenArtifactSnapshot(value: OpenArtifactSnapshot): Promise<void> {
  const [tarball, sbom, provenance] = await Promise.all([snapshotStableFile(value.tarball.path, value.handles[0], value.tarball.maximum),
    snapshotStableFile(value.sbom.path, value.handles[1], value.sbom.maximum),
    snapshotStableFile(value.provenance.path, value.handles[2], value.provenance.maximum)])
  const current: ArtifactSnapshot = {
    tarball: { ...tarball, bytes: tarball.bytes.length, sha256: createHash('sha256').update(tarball.bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(tarball.bytes).digest('base64')}` },
    sbom: { ...sbom, bytes: sbom.bytes.length, sha256: createHash('sha256').update(sbom.bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(sbom.bytes).digest('base64')}` },
    provenance: { ...provenance, bytes: provenance.bytes.length, sha256: createHash('sha256').update(provenance.bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(provenance.bytes).digest('base64')}` },
  }
  if (!sameArtifactSnapshot(value, current)) throw new ControlPlaneStoreError('invalid-input', 'artifact descriptors changed during adapter execution')
}

function sameArtifactSnapshot(left: ArtifactSnapshot, right: ArtifactSnapshot): boolean {
  const file = (first: ArtifactSnapshot['tarball'], second: ArtifactSnapshot['tarball']): boolean =>
    first.bytes === second.bytes && first.sha256 === second.sha256 && first.integrity === second.integrity
      && first.device === second.device && first.inode === second.inode && first.parentDevice === second.parentDevice
      && first.parentInode === second.parentInode && first.parentMtimeNs === second.parentMtimeNs
      && first.parentCtimeNs === second.parentCtimeNs
  return file(left.tarball, right.tarball) && file(left.sbom, right.sbom) && file(left.provenance, right.provenance)
}

async function verifyArtifactFiles(value: SourceReleaseArtifact): Promise<void> { await artifactSnapshot(value) }

async function loadCatalogSnapshot(path: string): Promise<{ catalog: CapabilityCatalog; digest: string }> {
  const { bytes } = await readStableFile(path, 1_048_576)
  let raw: unknown
  try { raw = JSON.parse(bytes.toString('utf8')) as unknown } catch { throw new ControlPlaneStoreError('invalid-input', 'admitted catalog is not valid JSON') }
  const catalog = parseCatalog(raw)
  if (!same(raw, catalog)) throw new ControlPlaneStoreError('invalid-input', 'admitted catalog is not a canonical exact catalog')
  if (new Set(catalog.entries.map(entry => entry.package)).size !== catalog.entries.length) {
    throw new ControlPlaneStoreError('invalid-input', 'admitted catalog has ambiguous package identities')
  }
  return Object.freeze({ catalog, digest: createHash('sha256').update(JSON.stringify(catalog)).digest('hex') })
}

function success(receipt: SourceReleaseReceipt): SourceReleaseSuccessEvidence {
  if (receipt.outcome !== 'passed' || receipt.evidence.kind === 'failure' || receipt.evidence.kind === 'publish-ambiguity') throw new ControlPlaneStoreError('invalid-input', 'release success evidence is missing')
  return receipt.evidence
}

export class Ed25519SourceReleaseAuthority implements SourceReleaseAuthority {
  constructor(readonly publicKey: string | Buffer, readonly expectedAuthority: string, readonly expectedKeyId: string,
    readonly now: () => number = Date.now,
    readonly resolveRegistryVerifier?: (authority: string, keyId: string) => string | Buffer | undefined) {}

  async verify(input: SourceReleaseReceipt, plan: PluginSourcePlan, request: SourceReleaseRequest): Promise<VerifiedSourceReleaseReceipt> {
    const parsedRequest = parseSourceReleaseRequest(request); const receipt = parseSourceReleaseReceipt(input); const now = this.now()
    if (receipt.authority !== this.expectedAuthority || receipt.keyId !== this.expectedKeyId
      || receipt.authority !== parsedRequest.adapter.authority || receipt.keyId !== parsedRequest.adapter.keyId
      || receipt.installationId !== parsedRequest.installationId || receipt.planId !== plan.id || receipt.planDigest !== plan.digest
      || parsedRequest.plan.id !== plan.id || parsedRequest.plan.digest !== plan.digest || parsedRequest.plan.revision !== plan.revision
      || plan.releaseAuthorization === undefined || !same(parsedRequest.authorization, plan.releaseAuthorization)
      || plan.release?.id !== parsedRequest.release.id || plan.release.fence !== parsedRequest.release.fence
      || receipt.releaseId !== parsedRequest.release.id || receipt.fence !== parsedRequest.release.fence || receipt.operationId !== parsedRequest.operationId
      || receipt.requestDigest !== sourceReleaseRequestDigest(parsedRequest) || receipt.phase !== parsedRequest.phase) throw new ControlPlaneStoreError('conflict', 'release receipt is not bound to the exact adapter/request/plan/release fence')
    if (receipt.observedAt < parsedRequest.requestedAt || receipt.observedAt > now || now > receipt.expiresAt
      || now > parsedRequest.authorization.expiresAt || receipt.expiresAt > parsedRequest.authorization.expiresAt
      || receipt.expiresAt - receipt.observedAt > parsedRequest.receiptTtlMs) throw new ControlPlaneStoreError('expired', 'release receipt is outside its request-bound validity interval')
    const signature = Buffer.from(receipt.signature, 'base64')
    if (!verify(null, Buffer.from(canonicalReceipt(receipt)), createPublicKey(this.publicKey), signature)) throw new ControlPlaneStoreError('invalid-input', 'release receipt signature is invalid')
    if (parsedRequest.phase === 'catalog-admission') {
      const registryReceipt = parsedRequest.input.registryVerificationReceipt
      const registryRequest = parsedRequest.input.registryVerificationRequest
      const registryKey = this.resolveRegistryVerifier?.(registryReceipt.authority, registryReceipt.keyId)
      if (registryKey === undefined || registryReceipt.authority !== registryRequest.adapter.authority
        || registryReceipt.keyId !== registryRequest.adapter.keyId
        || !verify(null, Buffer.from(canonicalReceipt(registryReceipt)),
        createPublicKey(registryKey), Buffer.from(registryReceipt.signature, 'base64'))) {
        throw new ControlPlaneStoreError('invalid-input', 'catalog admission registry verification receipt signature is invalid')
      }
      if (registryReceipt.observedAt < registryRequest.requestedAt || registryReceipt.observedAt > parsedRequest.requestedAt
        || registryReceipt.expiresAt > parsedRequest.authorization.expiresAt
        || registryReceipt.expiresAt - registryReceipt.observedAt > registryRequest.receiptTtlMs) {
        throw new ControlPlaneStoreError('expired', 'catalog admission registry verification receipt is outside its release-bound validity interval')
      }
    }
    if (receipt.outcome === 'passed') {
      const evidence = success(receipt)
      if (evidence.kind !== parsedRequest.phase) throw new ControlPlaneStoreError('conflict', 'release evidence is for a different phase')
      if (evidence.kind === 'pr' && parsedRequest.phase === 'pr' && (evidence.baseCommit !== parsedRequest.input.baseCommit
        || evidence.headCommit === evidence.baseCommit || evidence.treeDigest !== parsedRequest.input.expectedTreeDigest
        || evidence.patchDigest !== parsedRequest.input.expectedPatchDigest)) throw new ControlPlaneStoreError('invalid-input', 'PR evidence does not bind the exact checked source and new head commit')
      if (evidence.kind === 'review' && parsedRequest.phase === 'review' && (evidence.prId !== parsedRequest.input.prId
        || evidence.headCommit !== parsedRequest.input.headCommit || evidence.prEvidenceDigest !== parsedRequest.input.prEvidenceDigest)) {
        throw new ControlPlaneStoreError('invalid-input', 'review evidence does not bind the exact PR evidence and head')
      }
      if (evidence.kind === 'merge' && parsedRequest.phase === 'merge' && (evidence.prId !== parsedRequest.input.prId
        || evidence.reviewedHeadCommit !== parsedRequest.input.headCommit || evidence.reviewId !== parsedRequest.input.reviewId
        || evidence.reviewEvidenceDigest !== parsedRequest.input.reviewEvidenceDigest || evidence.targetBranch !== parsedRequest.input.targetBranch)) {
        throw new ControlPlaneStoreError('invalid-input', 'merge evidence does not bind the exact review, head, and target branch')
      }
      if (evidence.kind === 'build' && parsedRequest.phase === 'build') {
        if (evidence.mergedCommit !== parsedRequest.input.mergeCommit || evidence.mergeEvidenceDigest !== parsedRequest.input.mergeEvidenceDigest
          || evidence.reproducibleBuilds < parsedRequest.authorization.releasePolicy.minimumReproducibleBuilds
          || evidence.firstBuildSha256 !== evidence.secondBuildSha256 || evidence.firstBuildSha256 !== evidence.tarballSha256
          || !artifactMatchesPolicy(evidence, parsedRequest.authorization.releasePolicy)) throw new ControlPlaneStoreError('invalid-input', 'build is not reproducible or merge/candidate-bound')
        await verifyArtifactFiles(evidence)
      }
      if (evidence.kind === 'sign' && parsedRequest.phase === 'sign') {
        await verifyArtifactFiles(parsedRequest.input.artifact)
        const signatureBytes = Buffer.from(evidence.artifactSignature, 'base64')
        if (evidence.buildEvidenceDigest !== parsedRequest.input.buildEvidenceDigest
          || evidence.artifactStatementDigest !== sourceArtifactStatementDigest(parsedRequest.input.artifact)
          || evidence.artifactSignatureDigest !== createHash('sha256').update(signatureBytes).digest('hex')
          || !verify(null, Buffer.from(sourceArtifactSigningPayload(parsedRequest.input.artifact)), createPublicKey(this.publicKey), signatureBytes)) {
          throw new ControlPlaneStoreError('invalid-input', 'artifact signature does not verify against the exact build statement')
        }
      }
      if (evidence.kind === 'publish' && parsedRequest.phase === 'publish'
        && (evidence.registryId !== parsedRequest.registry.id || evidence.registryReference !== parsedRequest.authorization.releasePolicy.registryReference
          || evidence.packageName !== parsedRequest.input.artifact.packageName || evidence.packageVersion !== parsedRequest.input.artifact.packageVersion
          || evidence.tarballSha256 !== parsedRequest.input.artifact.tarballSha256 || evidence.tarballIntegrity !== parsedRequest.input.artifact.tarballIntegrity
          || evidence.artifactStatementDigest !== parsedRequest.input.artifactStatementDigest || evidence.signEvidenceDigest !== parsedRequest.input.signEvidenceDigest
          || evidence.artifactSignatureDigest !== createHash('sha256').update(Buffer.from(parsedRequest.input.artifactSignature, 'base64')).digest('hex'))) {
        throw new ControlPlaneStoreError('invalid-input', 'publish evidence does not bind the signed artifact and immutable registry target')
      }
      if (evidence.kind === 'registry-verify' && parsedRequest.phase === 'registry-verify'
        && (evidence.registryId !== parsedRequest.registry.id || evidence.registryReference !== parsedRequest.input.registryReference
          || evidence.downloadedBytes !== parsedRequest.input.artifact.tarballBytes || evidence.downloadedSha256 !== parsedRequest.input.artifact.tarballSha256
          || evidence.downloadedIntegrity !== parsedRequest.input.artifact.tarballIntegrity || evidence.artifactStatementDigest !== parsedRequest.input.artifactStatementDigest
          || evidence.publishEvidenceDigest !== parsedRequest.input.publishEvidenceDigest
          || evidence.artifactSignatureDigest !== createHash('sha256').update(Buffer.from(parsedRequest.input.artifactSignature, 'base64')).digest('hex'))) {
        throw new ControlPlaneStoreError('invalid-input', 'independent registry download does not match the exact signed artifact bytes')
      }
      if (evidence.kind === 'catalog-admission' && parsedRequest.phase === 'catalog-admission') {
        const signatureDigest = createHash('sha256').update(Buffer.from(parsedRequest.input.artifactSignature, 'base64')).digest('hex')
        const expectedAdmissionId = catalogAdmissionId({ catalog: parsedRequest.catalog, installationId: parsedRequest.installationId,
          registry: parsedRequest.registry,
          operationId: parsedRequest.operationId, plan: parsedRequest.plan, release: parsedRequest.release,
          expectedBeforeCatalogDigest: parsedRequest.input.expectedBeforeCatalogDigest, expectedAfterCatalogDigest: parsedRequest.input.expectedAfterCatalogDigest,
          registryReference: parsedRequest.input.registryReference, artifactStatementDigest: parsedRequest.input.artifactStatementDigest,
          artifactSignature: parsedRequest.input.artifactSignature, verificationEvidenceDigest: parsedRequest.input.verificationEvidenceDigest,
          candidate: parsedRequest.input.candidate })
        if (evidence.admissionId !== expectedAdmissionId || evidence.catalogId !== parsedRequest.catalog.id
          || evidence.beforeCatalogDigest !== parsedRequest.input.expectedBeforeCatalogDigest
          || evidence.afterCatalogDigest !== parsedRequest.input.expectedAfterCatalogDigest || evidence.registryReference !== parsedRequest.input.registryReference
          || evidence.artifactStatementDigest !== parsedRequest.input.artifactStatementDigest || evidence.artifactSignatureDigest !== signatureDigest
          || evidence.verificationEvidenceDigest !== parsedRequest.input.verificationEvidenceDigest || !same(evidence.candidate, parsedRequest.input.candidate)) {
          throw new ControlPlaneStoreError('invalid-input', 'catalog admission does not bind the independently verified candidate and catalog transition')
        }
        const loaded = await loadCatalogSnapshot(parsedRequest.catalog.path)
        const admitted = loaded.catalog.entries.find(candidate => candidate.id === parsedRequest.input.candidate.id)
        if (loaded.digest !== parsedRequest.input.expectedAfterCatalogDigest || admitted === undefined || !same(admitted, parsedRequest.input.candidate)) {
          throw new ControlPlaneStoreError('invalid-input', 'catalog admission result is not present in the exact owner catalog snapshot')
        }
      }
    }
    if (receipt.outcome === 'ambiguous' && parsedRequest.phase === 'publish') {
      const evidence = receipt.evidence
      if (evidence.kind !== 'publish-ambiguity' || evidence.registryId !== parsedRequest.registry.id
        || evidence.packageName !== parsedRequest.input.artifact.packageName || evidence.packageVersion !== parsedRequest.input.artifact.packageVersion
        || evidence.tarballSha256 !== parsedRequest.input.artifact.tarballSha256) throw new ControlPlaneStoreError('invalid-input', 'publish ambiguity does not bind the exact artifact')
    }
    const { signature: _signature, ...fields } = receipt
    return Object.freeze({ ...fields, signatureDigest: createHash('sha256').update(signature).digest('hex') })
  }
}

export type ReleaseAdapterErrorCode = 'NOT_CONFIGURED' | 'FAILED' | 'OUTPUT_LIMIT' | 'TIMEOUT' | 'VERSION_MISMATCH' | 'EXECUTABLE_CHANGED'
export class ReleaseAdapterError extends Error {
  constructor(readonly code: ReleaseAdapterErrorCode, readonly phase: SourceReleasePhase, message: string) {
    super(`plugin-control-plane release-adapter[${phase}:${code}]: ${message}`); this.name = 'ReleaseAdapterError'
  }
}

async function executePinned(executable: OpenTrustedExecutable, interpreter: OpenTrustedExecutable | undefined, args: readonly string[],
  environment: NodeJS.ProcessEnv, timeoutMs: number, stdin: string | undefined, maximumOutput: number, phase: SourceReleasePhase,
  inherited: readonly FileHandle[] = []): Promise<string> {
  if (process.platform !== 'linux') throw new ReleaseAdapterError('FAILED', phase, 'descriptor-pinned adapters require Linux')
  try { await realpath('/proc/self/fd') } catch { throw new ReleaseAdapterError('FAILED', phase, 'descriptor-pinned adapters require /proc/self/fd') }
  return new Promise((resolvePromise, reject) => {
    const executableFd = 3 + inherited.length; const interpreterFd = interpreter === undefined ? undefined : executableFd + 1
    const command = `/proc/self/fd/${interpreterFd ?? executableFd}`
    const commandArguments = interpreter === undefined ? [...args] : [`/proc/self/fd/${executableFd}`, ...args]
    const stdio: Array<'pipe' | 'ignore' | number> = ['pipe', 'pipe', 'ignore', ...inherited.map(handle => handle.fd), executable.handle.fd]
    if (interpreter !== undefined) stdio.push(interpreter.handle.fd)
    const child = spawn(command, commandArguments, { env: environment, shell: false, stdio })
    const chunks: Buffer[] = []; let bytes = 0; let timedOut = false; let outputLimit = false; let settled = false
    child.stdout!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maximumOutput) { outputLimit = true; child.kill('SIGKILL') } else chunks.push(chunk) })
    child.once('error', () => { if (!settled) { settled = true; reject(new ReleaseAdapterError('FAILED', phase, 'adapter could not start')) } })
    child.once('close', code => {
      if (settled) return; settled = true
      if (timedOut) reject(new ReleaseAdapterError('TIMEOUT', phase, 'adapter exceeded its deadline'))
      else if (outputLimit) reject(new ReleaseAdapterError('OUTPUT_LIMIT', phase, 'adapter exceeded its output bound'))
      else if (code !== 0) reject(new ReleaseAdapterError('FAILED', phase, 'adapter returned a non-zero status'))
      else resolvePromise(Buffer.concat(chunks).toString('utf8'))
    })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs); child.once('close', () => clearTimeout(timer))
    child.stdin!.end(stdin, 'utf8')
  })
}

async function assertPinnedAdapterCapabilities(executable: OpenTrustedExecutable, interpreter: OpenTrustedExecutable | undefined,
  adapter: NonNullable<NonNullable<PluginControlTrustConfig['releaseAdapters']>[SourceReleasePhase]>, phase: SourceReleasePhase,
  environment: NodeJS.ProcessEnv): Promise<void> {
  const source = await executePinned(executable, interpreter, ['--capabilities'], environment, adapter.timeoutMs, undefined, 1_024, phase)
  let value: unknown
  try { value = JSON.parse(source) as unknown } catch { throw new ReleaseAdapterError('FAILED', phase, 'adapter did not declare the pinned-fd contract') }
  const item = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  if (item === undefined || Object.keys(item).sort().join('\0') !== ['artifactInput', 'schemaVersion'].join('\0')
    || item.schemaVersion !== 1 || item.artifactInput !== 'inherited-fd-v1') {
    throw new ReleaseAdapterError('FAILED', phase, 'adapter does not support the required pinned-fd contract')
  }
}

async function withPinnedAdapter<T>(adapter: NonNullable<NonNullable<PluginControlTrustConfig['releaseAdapters']>[SourceReleasePhase]>,
  phase: SourceReleasePhase, action: (executable: OpenTrustedExecutable, interpreter: OpenTrustedExecutable | undefined) => Promise<T>): Promise<T> {
  const executable = await openTrustedExecutable(adapter.path, adapter.sha256)
  let interpreter: OpenTrustedExecutable | undefined
  try {
    interpreter = adapter.interpreter === null ? undefined : await openTrustedExecutable(adapter.interpreter.path, adapter.interpreter.sha256)
    const result = await action(executable, interpreter)
    await verifyOpenTrustedExecutable(executable)
    if (interpreter !== undefined) await verifyOpenTrustedExecutable(interpreter)
    return result
  } catch (error) {
    if (error instanceof ReleaseAdapterError || error instanceof ControlPlaneStoreError) throw error
    throw new ReleaseAdapterError('EXECUTABLE_CHANGED', phase, error instanceof Error ? error.message : 'adapter identity could not be retained')
  } finally {
    await interpreter?.handle.close(); await executable.handle.close()
  }
}

export async function invokeSourceReleaseAdapter(trust: PluginControlTrustConfig, request: SourceReleaseRequest): Promise<SourceReleaseReceipt> {
  const parsedRequest = parseSourceReleaseRequest(request)
  const adapter = trust.releaseAdapters?.[parsedRequest.phase]
  if (adapter === undefined) throw new ReleaseAdapterError('NOT_CONFIGURED', parsedRequest.phase, 'no owner-configured adapter is registered')
  const identity = { id: adapter.id, version: adapter.version, path: adapter.path, sha256: adapter.sha256,
    interpreter: adapter.interpreter, authority: adapter.authority, keyId: adapter.keyId }
  if (digest(identity) !== digest(parsedRequest.adapter)) throw new ReleaseAdapterError('FAILED', parsedRequest.phase, 'durable request is not bound to the configured adapter')
  return withPinnedAdapter(adapter, parsedRequest.phase, async (executable, interpreter) => {
    const environment = inheritedReleaseAdapterEnvironment(trust, parsedRequest.phase)
    const version = (await executePinned(executable, interpreter, ['--version'], environment, adapter.timeoutMs, undefined, 1_024, parsedRequest.phase)).trim()
    if (version !== adapter.version) throw new ReleaseAdapterError('VERSION_MISMATCH', parsedRequest.phase, 'adapter reported a different version')
    await assertPinnedAdapterCapabilities(executable, interpreter, adapter, parsedRequest.phase, environment)
    const artifact = 'artifact' in parsedRequest.input ? await openArtifactSnapshot(parsedRequest.input.artifact) : undefined
    try {
      const artifactEnvironment = artifact === undefined ? environment : { ...environment, DSH_RELEASE_TARBALL_FD: '3',
        DSH_RELEASE_SBOM_FD: '4', DSH_RELEASE_PROVENANCE_FD: '5' }
      const source = await executePinned(executable, interpreter, ['release'], artifactEnvironment, adapter.timeoutMs,
        `${JSON.stringify(parsedRequest)}\n`, 262_144, parsedRequest.phase, artifact?.handles ?? [])
      if (artifact !== undefined) await verifyOpenArtifactSnapshot(artifact)
      let value: unknown
      try { value = JSON.parse(source) as unknown } catch { throw new ReleaseAdapterError('FAILED', parsedRequest.phase, 'adapter did not return one JSON receipt') }
      return parseSourceReleaseReceipt(value)
    } finally { if (artifact !== undefined) await Promise.all(artifact.handles.map(async handle => handle.close())) }
  })
}

export async function invokeSourcePublishReconciliationAdapter(trust: PluginControlTrustConfig,
  request: SourcePublishReconciliationRequest): Promise<SourcePublishReconciliationReceipt> {
  const parsedRequest = parseSourcePublishReconciliationRequest(request)
  const adapter = trust.releaseAdapters?.['registry-verify']
  if (adapter === undefined) throw new ReleaseAdapterError('NOT_CONFIGURED', 'registry-verify', 'no independent registry verifier is registered')
  const identity = { id: adapter.id, version: adapter.version, path: adapter.path, sha256: adapter.sha256,
    interpreter: adapter.interpreter, authority: adapter.authority, keyId: adapter.keyId }
  if (!same(identity, parsedRequest.adapter)) throw new ReleaseAdapterError('FAILED', 'registry-verify', 'reconciliation request is not bound to the configured verifier')
  return withPinnedAdapter(adapter, 'registry-verify', async (executable, interpreter) => {
    const environment = inheritedReleaseAdapterEnvironment(trust, 'registry-verify')
    const version = (await executePinned(executable, interpreter, ['--version'], environment, adapter.timeoutMs, undefined, 1_024, 'registry-verify')).trim()
    if (version !== adapter.version) throw new ReleaseAdapterError('VERSION_MISMATCH', 'registry-verify', 'adapter reported a different version')
    await assertPinnedAdapterCapabilities(executable, interpreter, adapter, 'registry-verify', environment)
    const source = await executePinned(executable, interpreter, ['reconcile'], environment, adapter.timeoutMs,
      `${JSON.stringify(parsedRequest)}\n`, 262_144, 'registry-verify')
    let value: unknown
    try { value = JSON.parse(source) as unknown } catch {
      throw new ReleaseAdapterError('FAILED', 'registry-verify', 'adapter did not return one JSON reconciliation receipt')
    }
    return parseSourcePublishReconciliationReceipt(value)
  })
}
