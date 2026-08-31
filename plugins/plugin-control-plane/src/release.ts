import { spawn } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { parseCatalog } from './catalog.js'
import { ControlPlaneStoreError } from './store.js'
import { inheritedReleaseAdapterEnvironment, inspectTrustedExecutable, type PluginControlTrustConfig } from './trust.js'
import type {
  PluginSourcePlan,
  SourceReleaseArtifact,
  SourceReleaseAuthority,
  SourceReleasePhase,
  SourceReleaseReceipt,
  SourceReleaseRequest,
  SourceReleaseSuccessEvidence,
  VerifiedSourceReleaseReceipt,
} from './types.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/u
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
function absolutePath(value: unknown, label: string): string {
  const result = opaqueLine(value, label)
  if (!result.startsWith('/') || result === '/') throw new ControlPlaneStoreError('invalid-input', `${label} is invalid`)
  return result
}
function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new ControlPlaneStoreError('invalid-input', `${label} must be a bounded integer`)
  return Number(value)
}

const artifactFields = ['packageName', 'packageVersion', 'tarballPath', 'tarballBytes', 'tarballSha256', 'tarballIntegrity',
  'sbomPath', 'sbomSha256', 'provenancePath', 'provenanceSha256', 'mergedCommit', 'dshBaseline', 'capabilities', 'authorities', 'requires'] as const

function artifact(value: unknown, exactObject = true): SourceReleaseArtifact {
  const item = record(value, 'release artifact')
  if (exactObject) exact(item, artifactFields, 'release artifact')
  const candidate = parseCatalog({ schemaVersion: 1, entries: [{ id: 'released-artifact', package: item.packageName,
    version: item.packageVersion, integrity: item.tarballIntegrity, requires: item.requires,
    dshBaseline: item.dshBaseline, capabilities: item.capabilities, authorities: item.authorities }] }).entries[0]!
  const tarballPath = absolutePath(item.tarballPath, 'tarballPath'); const sbomPath = absolutePath(item.sbomPath, 'sbomPath')
  const provenancePath = absolutePath(item.provenancePath, 'provenancePath')
  return { packageName: candidate.package, packageVersion: candidate.version, tarballPath,
    tarballBytes: integer(item.tarballBytes, 'tarballBytes', 1), tarballSha256: text(item.tarballSha256, 'tarballSha256', DIGEST),
    tarballIntegrity: candidate.integrity, sbomPath, sbomSha256: text(item.sbomSha256, 'sbomSha256', DIGEST),
    provenancePath, provenanceSha256: text(item.provenanceSha256, 'provenanceSha256', DIGEST),
    mergedCommit: text(item.mergedCommit, 'mergedCommit', COMMIT), dshBaseline: candidate.dshBaseline,
    capabilities: candidate.capabilities, authorities: candidate.authorities, requires: candidate.requires }
}

function parseSuccessEvidence(value: Record<string, unknown>): SourceReleaseSuccessEvidence {
  const kind = value.kind
  if (kind === 'pr') {
    exact(value, ['kind', 'prId', 'baseCommit', 'headCommit', 'repositoryDigest'], 'PR evidence')
    return { kind, prId: text(value.prId, 'prId'), baseCommit: text(value.baseCommit, 'baseCommit', COMMIT),
      headCommit: text(value.headCommit, 'headCommit', COMMIT), repositoryDigest: text(value.repositoryDigest, 'repositoryDigest', DIGEST) }
  }
  if (kind === 'review') {
    exact(value, ['kind', 'prId', 'headCommit', 'reviewId', 'decision', 'reviewerPrincipalDigest'], 'review evidence')
    if (value.decision !== 'approved') throw new ControlPlaneStoreError('invalid-input', 'review decision is not approved')
    return { kind, prId: text(value.prId, 'prId'), headCommit: text(value.headCommit, 'headCommit', COMMIT),
      reviewId: text(value.reviewId, 'reviewId'), decision: value.decision,
      reviewerPrincipalDigest: text(value.reviewerPrincipalDigest, 'reviewerPrincipalDigest', DIGEST) }
  }
  if (kind === 'merge') {
    exact(value, ['kind', 'prId', 'reviewedHeadCommit', 'mergeCommit', 'targetBranch'], 'merge evidence')
    return { kind, prId: text(value.prId, 'prId'), reviewedHeadCommit: text(value.reviewedHeadCommit, 'reviewedHeadCommit', COMMIT),
      mergeCommit: text(value.mergeCommit, 'mergeCommit', COMMIT), targetBranch: text(value.targetBranch, 'targetBranch') }
  }
  if (kind === 'build') {
    exact(value, ['kind', 'isolated', 'reproducibleBuilds', 'firstBuildSha256', 'secondBuildSha256', ...artifactFields], 'build evidence')
    if (value.isolated !== true) throw new ControlPlaneStoreError('invalid-input', 'build was not isolated')
    return { kind, isolated: true, reproducibleBuilds: integer(value.reproducibleBuilds, 'reproducibleBuilds', 2),
      firstBuildSha256: text(value.firstBuildSha256, 'firstBuildSha256', DIGEST), secondBuildSha256: text(value.secondBuildSha256, 'secondBuildSha256', DIGEST),
      ...artifact(value, false) }
  }
  if (kind === 'sign') {
    exact(value, ['kind', 'artifactStatementDigest', 'artifactSignature', 'artifactSignatureDigest'], 'sign evidence')
    const artifactSignature = text(value.artifactSignature, 'artifactSignature', SIGNATURE, 16_384)
    return { kind, artifactStatementDigest: text(value.artifactStatementDigest, 'artifactStatementDigest', DIGEST), artifactSignature,
      artifactSignatureDigest: text(value.artifactSignatureDigest, 'artifactSignatureDigest', DIGEST) }
  }
  if (kind === 'publish') {
    exact(value, ['kind', 'registryId', 'registryReference', 'packageName', 'packageVersion', 'tarballSha256', 'tarballIntegrity',
      'artifactStatementDigest', 'artifactSignatureDigest', 'immutable'], 'publish evidence')
    if (value.immutable !== true) throw new ControlPlaneStoreError('invalid-input', 'registry publication is not immutable')
    return { kind, registryId: text(value.registryId, 'registryId'), registryReference: opaqueLine(value.registryReference, 'registryReference'),
      packageName: text(value.packageName, 'packageName', /^[a-z0-9@/._-]+$/u), packageVersion: text(value.packageVersion, 'packageVersion', /^[A-Za-z0-9._+-]+$/u),
      tarballSha256: text(value.tarballSha256, 'tarballSha256', DIGEST), tarballIntegrity: text(value.tarballIntegrity, 'tarballIntegrity', /^sha512-[A-Za-z0-9+/]+={0,2}$/u),
      artifactStatementDigest: text(value.artifactStatementDigest, 'artifactStatementDigest', DIGEST),
      artifactSignatureDigest: text(value.artifactSignatureDigest, 'artifactSignatureDigest', DIGEST), immutable: true }
  }
  if (kind === 'registry-verify') {
    exact(value, ['kind', 'registryId', 'registryReference', 'independentlyDownloaded', 'downloadedBytes', 'downloadedSha256',
      'downloadedIntegrity', 'artifactStatementDigest', 'artifactSignatureDigest'], 'registry verification evidence')
    if (value.independentlyDownloaded !== true) throw new ControlPlaneStoreError('invalid-input', 'artifact was not independently downloaded')
    return { kind, registryId: text(value.registryId, 'registryId'), registryReference: opaqueLine(value.registryReference, 'registryReference'),
      independentlyDownloaded: true, downloadedBytes: integer(value.downloadedBytes, 'downloadedBytes', 1),
      downloadedSha256: text(value.downloadedSha256, 'downloadedSha256', DIGEST), downloadedIntegrity: text(value.downloadedIntegrity, 'downloadedIntegrity', /^sha512-[A-Za-z0-9+/]+={0,2}$/u),
      artifactStatementDigest: text(value.artifactStatementDigest, 'artifactStatementDigest', DIGEST),
      artifactSignatureDigest: text(value.artifactSignatureDigest, 'artifactSignatureDigest', DIGEST) }
  }
  if (kind === 'catalog-admission') {
    exact(value, ['kind', 'admissionId', 'catalogId', 'beforeCatalogDigest', 'afterCatalogDigest', 'verificationEvidenceDigest', 'candidate'], 'catalog admission evidence')
    const candidate = parseCatalog({ schemaVersion: 1, entries: [value.candidate] }).entries[0]!
    return { kind, admissionId: text(value.admissionId, 'admissionId'), catalogId: text(value.catalogId, 'catalogId'),
      beforeCatalogDigest: text(value.beforeCatalogDigest, 'beforeCatalogDigest', DIGEST), afterCatalogDigest: text(value.afterCatalogDigest, 'afterCatalogDigest', DIGEST),
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
    || !['passed', 'failed', 'ambiguous'].includes(String(item.outcome)) || typeof item.signature !== 'string' || !SIGNATURE.test(item.signature)) {
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
    observedAt: integer(item.observedAt, 'observedAt'), expiresAt: integer(item.expiresAt, 'expiresAt'), signature: item.signature }
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

async function digestFile(path: string, maximum: number): Promise<{ bytes: number; sha256: string; integrity: string }> {
  if (!isAbsolute(path) || await realpath(path) !== resolve(path)) throw new ControlPlaneStoreError('invalid-input', 'artifact evidence path is not canonical')
  const metadata = await lstat(path); const uid = process.getuid?.()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > maximum
    || (metadata.mode & 0o022) !== 0 || (uid !== undefined && metadata.uid !== uid && metadata.uid !== 0)) {
    throw new ControlPlaneStoreError('invalid-input', 'artifact evidence file is unsafe')
  }
  const bytes = await readFile(path)
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` }
}

function success(receipt: SourceReleaseReceipt): SourceReleaseSuccessEvidence {
  if (receipt.outcome !== 'passed' || receipt.evidence.kind === 'failure' || receipt.evidence.kind === 'publish-ambiguity') throw new ControlPlaneStoreError('invalid-input', 'release success evidence is missing')
  return receipt.evidence
}

export class Ed25519SourceReleaseAuthority implements SourceReleaseAuthority {
  constructor(readonly publicKey: string | Buffer, readonly expectedAuthority: string, readonly expectedKeyId: string,
    readonly now: () => number = Date.now) {}

  async verify(input: SourceReleaseReceipt, plan: PluginSourcePlan, request: SourceReleaseRequest): Promise<VerifiedSourceReleaseReceipt> {
    const receipt = parseSourceReleaseReceipt(input); const now = this.now()
    if (receipt.authority !== this.expectedAuthority || receipt.keyId !== this.expectedKeyId
      || receipt.authority !== request.adapter.authority || receipt.keyId !== request.adapter.keyId
      || receipt.installationId !== request.installationId || receipt.planId !== plan.id || receipt.planDigest !== plan.digest
      || receipt.releaseId !== request.release.id || receipt.fence !== request.release.fence || receipt.operationId !== request.operationId
      || receipt.requestDigest !== sourceReleaseRequestDigest(request) || receipt.phase !== request.phase) throw new ControlPlaneStoreError('conflict', 'release receipt is not bound to the exact adapter/request/plan/release fence')
    if (receipt.observedAt < request.requestedAt || receipt.observedAt > now || now > receipt.expiresAt
      || receipt.expiresAt - receipt.observedAt > request.receiptTtlMs) throw new ControlPlaneStoreError('expired', 'release receipt is outside its request-bound validity interval')
    const signature = Buffer.from(receipt.signature, 'base64')
    if (!verify(null, Buffer.from(canonicalReceipt(receipt)), createPublicKey(this.publicKey), signature)) throw new ControlPlaneStoreError('invalid-input', 'release receipt signature is invalid')
    if (receipt.outcome === 'passed') {
      const evidence = success(receipt)
      if (evidence.kind !== request.phase) throw new ControlPlaneStoreError('conflict', 'release evidence is for a different phase')
      if (evidence.kind === 'pr' && request.phase === 'pr' && (evidence.baseCommit !== request.input.baseCommit || evidence.headCommit === evidence.baseCommit)) throw new ControlPlaneStoreError('invalid-input', 'PR evidence does not bind a new exact head commit')
      if (evidence.kind === 'review' && request.phase === 'review' && (evidence.prId !== request.input.prId || evidence.headCommit !== request.input.headCommit)) throw new ControlPlaneStoreError('invalid-input', 'review evidence does not bind the exact PR head')
      if (evidence.kind === 'merge' && request.phase === 'merge' && (evidence.prId !== request.input.prId || evidence.reviewedHeadCommit !== request.input.headCommit)) throw new ControlPlaneStoreError('invalid-input', 'merge evidence does not bind the reviewed head')
      if (evidence.kind === 'build' && request.phase === 'build') {
        if (evidence.mergedCommit !== request.input.mergeCommit || evidence.firstBuildSha256 !== evidence.secondBuildSha256
          || evidence.firstBuildSha256 !== evidence.tarballSha256) throw new ControlPlaneStoreError('invalid-input', 'build is not reproducible or merge-bound')
        const tarball = await digestFile(evidence.tarballPath, 268_435_456); const sbom = await digestFile(evidence.sbomPath, 16_777_216)
        const provenance = await digestFile(evidence.provenancePath, 16_777_216)
        if (tarball.bytes !== evidence.tarballBytes || tarball.sha256 !== evidence.tarballSha256 || tarball.integrity !== evidence.tarballIntegrity
          || sbom.sha256 !== evidence.sbomSha256 || provenance.sha256 !== evidence.provenanceSha256) throw new ControlPlaneStoreError('invalid-input', 'build artifact/SBOM/provenance bytes do not match signed evidence')
      }
      if (evidence.kind === 'sign' && request.phase === 'sign') {
        const signatureBytes = Buffer.from(evidence.artifactSignature, 'base64')
        if (evidence.artifactStatementDigest !== sourceArtifactStatementDigest(request.input.artifact)
          || evidence.artifactSignatureDigest !== createHash('sha256').update(signatureBytes).digest('hex')
          || !verify(null, Buffer.from(sourceArtifactSigningPayload(request.input.artifact)), createPublicKey(this.publicKey), signatureBytes)) {
          throw new ControlPlaneStoreError('invalid-input', 'artifact signature does not verify against the exact build statement')
        }
      }
      if (evidence.kind === 'publish' && request.phase === 'publish'
        && (evidence.registryId !== request.registry.id || evidence.packageName !== request.input.artifact.packageName
          || evidence.packageVersion !== request.input.artifact.packageVersion || evidence.tarballSha256 !== request.input.artifact.tarballSha256
          || evidence.tarballIntegrity !== request.input.artifact.tarballIntegrity || evidence.artifactStatementDigest !== request.input.artifactStatementDigest
          || evidence.artifactSignatureDigest !== createHash('sha256').update(Buffer.from(request.input.artifactSignature, 'base64')).digest('hex'))) {
        throw new ControlPlaneStoreError('invalid-input', 'publish evidence does not bind the signed artifact and immutable registry target')
      }
      if (evidence.kind === 'registry-verify' && request.phase === 'registry-verify'
        && (evidence.registryId !== request.registry.id || evidence.registryReference !== request.input.registryReference
          || evidence.downloadedBytes !== request.input.artifact.tarballBytes || evidence.downloadedSha256 !== request.input.artifact.tarballSha256
          || evidence.downloadedIntegrity !== request.input.artifact.tarballIntegrity || evidence.artifactStatementDigest !== request.input.artifactStatementDigest
          || evidence.artifactSignatureDigest !== createHash('sha256').update(Buffer.from(request.input.artifactSignature, 'base64')).digest('hex'))) {
        throw new ControlPlaneStoreError('invalid-input', 'independent registry download does not match the exact signed artifact bytes')
      }
      if (evidence.kind === 'catalog-admission' && request.phase === 'catalog-admission') {
        if (evidence.catalogId !== request.catalog.id || evidence.verificationEvidenceDigest !== request.input.verificationEvidenceDigest
          || digest(evidence.candidate) !== digest(request.input.candidate)) throw new ControlPlaneStoreError('invalid-input', 'catalog admission does not bind the independently verified candidate')
      }
    }
    if (receipt.outcome === 'ambiguous' && request.phase === 'publish') {
      const evidence = receipt.evidence
      if (evidence.kind !== 'publish-ambiguity' || evidence.registryId !== request.registry.id
        || evidence.packageName !== request.input.artifact.packageName || evidence.packageVersion !== request.input.artifact.packageVersion
        || evidence.tarballSha256 !== request.input.artifact.tarballSha256) throw new ControlPlaneStoreError('invalid-input', 'publish ambiguity does not bind the exact artifact')
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

async function execute(path: string, args: readonly string[], environment: NodeJS.ProcessEnv, timeoutMs: number,
  stdin: string | undefined, maximumOutput: number, phase: SourceReleasePhase): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(path, [...args], { env: environment, shell: false, stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []; let bytes = 0; let timedOut = false; let outputLimit = false; let settled = false
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maximumOutput) { outputLimit = true; child.kill('SIGKILL') } else chunks.push(chunk) })
    child.once('error', () => { if (!settled) { settled = true; reject(new ReleaseAdapterError('FAILED', phase, 'adapter could not start')) } })
    child.once('close', code => {
      if (settled) return; settled = true
      if (timedOut) reject(new ReleaseAdapterError('TIMEOUT', phase, 'adapter exceeded its deadline'))
      else if (outputLimit) reject(new ReleaseAdapterError('OUTPUT_LIMIT', phase, 'adapter exceeded its output bound'))
      else if (code !== 0) reject(new ReleaseAdapterError('FAILED', phase, 'adapter returned a non-zero status'))
      else resolvePromise(Buffer.concat(chunks).toString('utf8'))
    })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs); child.once('close', () => clearTimeout(timer))
    child.stdin.end(stdin, 'utf8')
  })
}

export async function invokeSourceReleaseAdapter(trust: PluginControlTrustConfig, request: SourceReleaseRequest): Promise<SourceReleaseReceipt> {
  const adapter = trust.releaseAdapters?.[request.phase]
  if (adapter === undefined) throw new ReleaseAdapterError('NOT_CONFIGURED', request.phase, 'no owner-configured adapter is registered')
  const identity = { id: adapter.id, version: adapter.version, path: adapter.path, sha256: adapter.sha256,
    interpreter: adapter.interpreter, authority: adapter.authority, keyId: adapter.keyId }
  if (digest(identity) !== digest(request.adapter)) throw new ReleaseAdapterError('FAILED', request.phase, 'durable request is not bound to the configured adapter')
  const before = await inspectTrustedExecutable(adapter.path, adapter.sha256)
  const interpreterBefore = adapter.interpreter === null ? undefined : await inspectTrustedExecutable(adapter.interpreter.path, adapter.interpreter.sha256)
  const environment = inheritedReleaseAdapterEnvironment(trust, request.phase)
  const version = (await execute(adapter.path, ['--version'], environment, adapter.timeoutMs, undefined, 1_024, request.phase)).trim()
  if (version !== adapter.version) throw new ReleaseAdapterError('VERSION_MISMATCH', request.phase, 'adapter reported a different version')
  const source = await execute(adapter.path, ['release'], environment, adapter.timeoutMs, `${JSON.stringify(request)}\n`, 262_144, request.phase)
  const after = await inspectTrustedExecutable(adapter.path, adapter.sha256)
  const interpreterAfter = adapter.interpreter === null ? undefined : await inspectTrustedExecutable(adapter.interpreter.path, adapter.interpreter.sha256)
  if (after.device !== before.device || after.inode !== before.inode || after.sha256 !== before.sha256
    || (interpreterBefore !== undefined && interpreterAfter !== undefined
      && (interpreterAfter.device !== interpreterBefore.device || interpreterAfter.inode !== interpreterBefore.inode || interpreterAfter.sha256 !== interpreterBefore.sha256))) {
    throw new ReleaseAdapterError('EXECUTABLE_CHANGED', request.phase, 'adapter or interpreter changed during execution')
  }
  let value: unknown
  try { value = JSON.parse(source) as unknown } catch { throw new ReleaseAdapterError('FAILED', request.phase, 'adapter did not return one JSON receipt') }
  return parseSourceReleaseReceipt(value)
}
