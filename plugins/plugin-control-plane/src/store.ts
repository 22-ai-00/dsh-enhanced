import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { basename, isAbsolute } from 'node:path'
import { discover, parseCatalog, type CatalogEntry, type LoadedCapabilityCatalog } from './catalog.js'
import { parseApprovalReceipt } from './approval.js'
import { parseSourcePublishReconciliationReceipt, parseSourcePublishReconciliationRequest, parseSourceReleaseAuthorization,
  parseSourceReleaseReceipt, parseSourceReleaseRequest, parseVerifiedSourceReleaseAuthorization } from './release.js'
import { controlPlaneOperationReceiptDigest, controlPlaneSchemaVersion, openControlPlaneDatabase } from './sqlite.js'
import { validateSourceBuildConfig } from './source-build.js'
import { validateScopedPluginFiles } from './source-workspace.js'
import type { SourceJobCompletion, SourceJobIntent, SourceJobRecord, SourceJobStatus } from './source-job-types.js'
import type { OwnerTaskFailureReference } from './owner-task-gap-types.js'
import { assertForegroundDeployment, assertForegroundTask, type ForegroundDeploymentRecord } from './foreground-deployment.js'
import type {
  ActivationRetractionAuthority,
  ActivationRetractionReceipt,
  ActivationWatch,
  ActivationWatchEvidenceRecord,
  ApprovalAuthority,
  ApprovalReceipt,
  CapabilityGapInput,
  HostAttestationAuthority,
  HostAttestationOperation,
  HostAttestationPhase,
  HostAttestationReceipt,
  HostAttestationRequest,
  HostAttestationRequirements,
  OperationReceipt,
  PlanStatus,
  PluginActivationPlan,
  PluginControlPlaneHealth,
  PluginSourcePlan,
  PostActivationObservationAuthority,
  PostActivationObservationReceipt,
  SourcePublishReconciliationAuthority,
  SourcePublishReconciliationReceipt,
  SourcePublishReconciliationRequest,
  SourceReleaseAdapterIdentity,
  SourceReleaseArtifact,
  SourceReleaseAuthorization,
  SourceReleaseAuthorizationAuthority,
  SourceReleaseAuthority,
  SourceReleaseOperation,
  SourceReleasePhase,
  SourceReleaseReceipt,
  SourceReleaseRequest,
  SourceReleaseSuccessEvidence,
  SourcePlanStatus,
  SourcePreparedEvidence,
  StoredHostAttestationRequest,
  StoredCapabilityGap,
  VerifiedApprovalReceipt,
  VerifiedSourceReleaseAuthorization,
} from './types.js'

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const PLUGIN_NAME = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const DIGEST = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const SOURCE_STATUSES = new Set<SourcePlanStatus>(['expired', 'pending-approval', 'approved', 'running-local-checks', 'ready-for-human-review',
  'local-checks-failed', 'awaiting-pr', 'awaiting-review', 'awaiting-merge', 'awaiting-build', 'awaiting-sign', 'awaiting-publish',
  'awaiting-registry-verify', 'awaiting-catalog-admission', 'release-complete', 'release-failed', 'publish-ambiguous'])
const SOURCE_PLAN_KEYS = ['schemaVersion', 'kind', 'id', 'gapId', 'gapSnapshot', 'status', 'revision', 'createdAt',
  'expiresAt', 'digest', 'repository', 'worktree', 'baseCommit', 'name', 'generatorDigest', 'scope'] as const
const ACTIVATION_PLAN_KEYS = ['schemaVersion', 'kind', 'id', 'gapId', 'gapSnapshot', 'status', 'revision', 'createdAt',
  'expiresAt', 'profile', 'candidate', 'dossier', 'installationId', 'ledger', 'target', 'executor', 'digest'] as const
const ACTIVATION_STATUSES = new Set<PlanStatus>(['pending-approval', 'approved', 'staging', 'awaiting-reload', 'awaiting-readiness',
  'awaiting-effect-blocked-replay', 'awaiting-shadow', 'awaiting-canary', 'awaiting-soak', 'awaiting-health', 'commit-pending',
  'rollback-pending', 'activated', 'rolled-back'])

export class ControlPlaneStoreError extends Error {
  constructor(readonly code: 'conflict' | 'expired' | 'invalid-input' | 'invalid-state' | 'not-found', message: string) {
    super(message)
    this.name = 'ControlPlaneStoreError'
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function controlPlaneDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function bounded(value: string, field: string, maximum = 1_000): string {
  if (typeof value !== 'string') throw new ControlPlaneStoreError('invalid-input', `${field} must be text`)
  const result = value.normalize('NFC').trim()
  const control = [...result].some(character => {
    const point = character.codePointAt(0)!
    return point <= 0x1f || point === 0x7f
  })
  if (result === '' || Buffer.byteLength(result) > maximum || control) throw new ControlPlaneStoreError('invalid-input', `${field} must be bounded printable text`)
  return result
}

function finite(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new ControlPlaneStoreError('invalid-input', `${field} is outside its accepted range`)
  return value
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new ControlPlaneStoreError('invalid-input', `${field} must be a positive safe integer`)
  return value
}

/**
 * 'modify' plans never run scripts/create-plugin; their generator binding is a
 * protocol constant rather than a scaffolding-tool digest.
 */
export const MODIFY_GENERATOR_DIGEST = createHash('sha256').update('dsh-source-modify-no-generator-v1').digest('hex')

function expectedSourceScope(name: string, mode: 'create' | 'modify'): readonly string[] {
  return mode === 'create'
    ? Object.freeze(['plugins/README.md', `plugins/${name}`].sort())
    : Object.freeze([`plugins/${name}`])
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ControlPlaneStoreError('invalid-state', `${label} is corrupt`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) {
    throw new ControlPlaneStoreError('invalid-state', `${label} has unknown or missing fields`)
  }
}

function verifiedApprovalFromStored(value: unknown, planId: string, planDigest: string, createdAt: number, expiresAt: number): VerifiedApprovalReceipt {
  const item = objectRecord(value, 'stored source approval')
  exactKeys(item, ['schemaVersion', 'approvalId', 'authority', 'keyId', 'planId', 'planDigest', 'decision', 'principal',
    'decidedAt', 'expiresAt', 'signatureDigest'], 'stored source approval')
  if (item['schemaVersion'] !== 1 || item['decision'] !== 'approved' || item['planId'] !== planId
    || item['planDigest'] !== planDigest || typeof item['approvalId'] !== 'string' || !KEY.test(item['approvalId'])
    || typeof item['authority'] !== 'string' || !KEY.test(item['authority']) || typeof item['keyId'] !== 'string'
    || !KEY.test(item['keyId']) || typeof item['principal'] !== 'string' || item['principal'].normalize('NFC').trim() !== item['principal']
    || item['principal'] === '' || item['principal'].length > 256 || !Number.isSafeInteger(item['decidedAt'])
    || !Number.isSafeInteger(item['expiresAt']) || Number(item['expiresAt']) <= Number(item['decidedAt'])
    || Number(item['decidedAt']) < createdAt || Number(item['decidedAt']) > expiresAt
    || !DIGEST.test(String(item['signatureDigest']))) {
    throw new ControlPlaneStoreError('invalid-state', 'stored source approval is corrupt or plan-mismatched')
  }
  return item as unknown as VerifiedApprovalReceipt
}

function projectedApproval(receipt: ApprovalReceipt): VerifiedApprovalReceipt {
  const { signature, ...fields } = receipt
  return { ...fields, principal: fields.principal.normalize('NFC').trim(),
    signatureDigest: createHash('sha256').update(Buffer.from(signature, 'base64')).digest('hex') }
}

async function reverifySourceReleaseAuthorization(authorization: VerifiedSourceReleaseAuthorization, plan: PluginSourcePlan,
  resolveAuthority: (authorization: SourceReleaseAuthorization) => SourceReleaseAuthorizationAuthority): Promise<void> {
  const { signatureDigest: _signatureDigest, ...signedAuthorization } = authorization
  const verified = await resolveAuthority(signedAuthorization).verify(signedAuthorization, plan)
  if (controlPlaneDigest(verified) !== controlPlaneDigest(authorization)) {
    throw new ControlPlaneStoreError('conflict', 'source release authorization changed during verification')
  }
}

function activationSnapshotFromStored(value: unknown): PluginActivationPlan {
  const item = objectRecord(value, 'stored activation plan snapshot')
  const optional = ['approval', 'activation'].filter(key => Object.hasOwn(item, key))
  exactKeys(item, [...ACTIVATION_PLAN_KEYS, ...optional], 'stored activation plan snapshot')
  const gapSnapshot = objectRecord(item['gapSnapshot'], 'stored activation gap snapshot')
  exactKeys(gapSnapshot, ['revision', 'inputDigest', 'roi', 'capability'], 'stored activation gap snapshot')
  const dossier = objectRecord(item['dossier'], 'stored activation dossier')
  exactKeys(dossier, ['catalogDigest', 'catalogProvenance', 'matchedCapabilities', 'authorities', 'packages'], 'stored activation dossier')
  const ledger = objectRecord(item['ledger'], 'stored activation ledger'); exactKeys(ledger, ['id', 'path'], 'stored activation ledger')
  const target = objectRecord(item['target'], 'stored activation target'); exactKeys(target, ['dshHome', 'profile', 'profilePath'], 'stored activation target')
  const executor = objectRecord(item['executor'], 'stored activation executor'); exactKeys(executor, ['id', 'version', 'path', 'sha256'], 'stored activation executor')
  let candidate: CatalogEntry
  try { candidate = parseCatalog({ schemaVersion: 1, entries: [item['candidate']] }).entries[0]! }
  catch { throw new ControlPlaneStoreError('invalid-state', 'stored activation candidate snapshot is corrupt') }
  if (item['schemaVersion'] !== 4 || item['kind'] !== 'activation' || typeof item['id'] !== 'string'
    || typeof item['gapId'] !== 'string' || typeof item['status'] !== 'string' || !ACTIVATION_STATUSES.has(item['status'] as PlanStatus)
    || !Number.isSafeInteger(item['revision']) || Number(item['revision']) < 1 || !Number.isSafeInteger(item['createdAt'])
    || !Number.isSafeInteger(item['expiresAt']) || Number(item['expiresAt']) <= Number(item['createdAt'])
    || typeof item['profile'] !== 'string' || !PROFILE.test(item['profile']) || typeof item['installationId'] !== 'string'
    || !UUID.test(item['installationId']) || typeof item['digest'] !== 'string' || !DIGEST.test(item['digest'])
    || controlPlaneDigest(item['candidate']) !== controlPlaneDigest(candidate)
    || !Number.isSafeInteger(gapSnapshot['revision']) || typeof gapSnapshot['inputDigest'] !== 'string'
    || !DIGEST.test(gapSnapshot['inputDigest']) || typeof gapSnapshot['roi'] !== 'number' || !Number.isFinite(gapSnapshot['roi'])
    || typeof gapSnapshot['capability'] !== 'string' || typeof dossier['catalogDigest'] !== 'string'
    || !DIGEST.test(dossier['catalogDigest']) || dossier['catalogProvenance'] !== 'owner-provided-integrity-pinned'
    || !Array.isArray(dossier['matchedCapabilities']) || !Array.isArray(dossier['authorities']) || !Array.isArray(dossier['packages'])
    || typeof ledger['id'] !== 'string' || !UUID.test(ledger['id']) || typeof ledger['path'] !== 'string' || !isAbsolute(ledger['path'])
    || target['profile'] !== item['profile'] || typeof target['dshHome'] !== 'string' || !isAbsolute(target['dshHome'])
    || typeof target['profilePath'] !== 'string' || !isAbsolute(target['profilePath']) || typeof executor['id'] !== 'string'
    || typeof executor['version'] !== 'string' || typeof executor['path'] !== 'string' || !isAbsolute(executor['path'])
    || typeof executor['sha256'] !== 'string' || !DIGEST.test(executor['sha256'])) {
    throw new ControlPlaneStoreError('invalid-state', 'stored activation plan snapshot is corrupt')
  }
  const immutable = { schemaVersion: 4, kind: 'activation', id: item['id'], gapId: item['gapId'], gapSnapshot,
    profile: item['profile'], candidate, dossier, installationId: item['installationId'], ledger, target, executor,
    createdAt: item['createdAt'], expiresAt: item['expiresAt'] }
  if (controlPlaneDigest(immutable) !== item['digest']) throw new ControlPlaneStoreError('invalid-state', 'stored activation snapshot digest is corrupt')
  const approval = item['approval'] === undefined ? undefined : verifiedApprovalFromStored(item['approval'], item['id'], item['digest'],
    Number(item['createdAt']), Number(item['expiresAt']))
  let activation: PluginActivationPlan['activation']
  if (item['activation'] !== undefined) {
    const stored = objectRecord(item['activation'], 'stored activation identity')
    const activationOptional = ['targetOriginallyExisted', 'targetBaselineFiles', 'hostRecoveryRequired', 'rollbackProfileRestored', 'failureCode'].filter(key => Object.hasOwn(stored, key))
    exactKeys(stored, ['id', 'fence', 'updatedAt', ...activationOptional], 'stored activation identity')
    if (typeof stored['id'] !== 'string' || !KEY.test(stored['id']) || !Number.isSafeInteger(stored['fence'])
      || Number(stored['fence']) < 1 || !Number.isSafeInteger(stored['updatedAt'])
      || Number(stored['updatedAt']) < Number(item['createdAt'])
      || (stored['targetOriginallyExisted'] !== undefined && typeof stored['targetOriginallyExisted'] !== 'boolean')
      || (stored['targetBaselineFiles'] !== undefined && (!Array.isArray(stored['targetBaselineFiles']) || ![0, 3].includes(stored['targetBaselineFiles'].length)
        || stored['targetBaselineFiles'].some(file => typeof file !== 'object' || file === null || Array.isArray(file)
          || Object.keys(file as object).sort().join('\0') !== 'path\0sha256' || typeof (file as { path?: unknown }).path !== 'string'
          || !isAbsolute((file as { path: string }).path) || ((file as { sha256?: unknown }).sha256 !== null && !DIGEST.test((file as { sha256: string }).sha256)))))
      || (stored['hostRecoveryRequired'] !== undefined && stored['hostRecoveryRequired'] !== true)
      || (stored['rollbackProfileRestored'] !== undefined && stored['rollbackProfileRestored'] !== true)
      || (stored['failureCode'] !== undefined && typeof stored['failureCode'] !== 'string')) {
      throw new ControlPlaneStoreError('invalid-state', 'stored activation identity is corrupt')
    }
    activation = stored as unknown as NonNullable<PluginActivationPlan['activation']>
  }
  const status = item['status'] as PlanStatus; const requiresApproval = status !== 'pending-approval'
  const requiresActivation = !['pending-approval', 'approved'].includes(status)
  if (requiresApproval !== (approval !== undefined) || requiresActivation !== (activation !== undefined)) {
    throw new ControlPlaneStoreError('invalid-state', 'stored activation snapshot fields do not match its status')
  }
  return { ...immutable, digest: item['digest'], status, revision: Number(item['revision']),
    ...(approval === undefined ? {} : { approval }), ...(activation === undefined ? {} : { activation }) } as unknown as PluginActivationPlan
}

interface GapRow extends Record<string, unknown> {
  id: string; idempotency_key: string; input_digest: string; capability: string; context: string
  expected_value: number; frequency: number; estimated_cost: number; risk: number; roi: number
  status: StoredCapabilityGap['status']; candidate_id: string | null; revision: number; created_at: number; updated_at: number
}

interface OwnerTaskFailureGapRow {
  reference_json: string
  reference_digest: string
}

interface ActivationRow {
  id: string; plan_digest: string; gap_id: string; gap_snapshot_json: string; profile: string
  candidate_json: string; dossier_json: string; installation_id: string; dsh_home: string; target_path: string
  ledger_id: string; ledger_path: string; executor_id: string; executor_version: string; executor_path: string
  executor_digest: string; status: PlanStatus; revision: number; created_at: number; expires_at: number
  approval_json: string | null; approval_receipt_json: string | null; activation_id: string | null; activation_fence: number
  activation_lease_until: number | null; activation_target_existed: number | null; activation_target_baseline_json: string | null
  host_recovery_required: number; rollback_profile_restored: number; failure_code: string | null; updated_at: number
}

interface SourceRow {
  id: string; plan_digest: string; gap_id: string; gap_snapshot_json: string; repository: string; worktree: string
  base_commit: string; plugin_name: string; generator_digest: string; scope_json: string
  mode: 'create' | 'modify'; status: SourcePlanStatus
  revision: number; created_at: number; expires_at: number; approval_json: string | null
  checked_tree_digest: string | null; checked_patch_digest: string | null; checked_at: number | null
  prepared_evidence_json: string | null
  release_authorization_json: string | null; release_authorization_digest: string | null
  release_id: string | null; release_fence: number; release_failure_phase: SourceReleasePhase | null
  release_failure_code: string | null; updated_at: number
}

interface SourceJobRow {
  id: string; automation_id: string; authority_id: string; idempotency_key: string
  intent_json: string; intent_digest: string; status: SourceJobStatus; revision: number
  created_at: number; expires_at: number; definition_hash: string | null; occurrence_id: string | null
  plan_id: string | null; failure_code: string | null; updated_at: number
}

interface HostAttestationOperationRow {
  plan_id: string; phase: HostAttestationPhase; operation_id: string; binding_digest: string; request_digest: string
  request_json: string; status: HostAttestationOperation['status']; receipt_digest: string | null; receipt_json: string | null
  created_at: number; completed_at: number | null; applied_at: number | null
}

interface SourceReleaseOperationRow {
  plan_id: string; phase: SourceReleasePhase; release_id: string; release_fence: number; attempt: number
  operation_id: string; binding_digest: string; request_digest: string; request_json: string
  status: SourceReleaseOperation['status']; receipt_digest: string | null; receipt_json: string | null
  created_at: number; completed_at: number | null; applied_at: number | null
}

interface SourceReleaseDispatchRow {
  operation_id: string
  status: 'claimed' | 'completed'
  claimed_at: number
  completed_at: number | null
}

interface SourcePublishReconciliationRow {
  plan_id: string; release_id: string; release_fence: number; attempt: number; operation_id: string
  binding_digest: string; request_digest: string; request_json: string; status: SourceReleaseOperation['status']
  receipt_digest: string | null; receipt_json: string | null; created_at: number; completed_at: number | null; applied_at: number | null
}

interface WatchRow {
  plan_id: string; package_name: string; package_version: string; package_integrity: string
  activation_id: string; fence: number; state: ActivationWatch['state']; revision: number
  last_host_generation: number; healthy_observations: number
  close_disposition: 'regressed' | 'retracted' | null; close_at: number | null
  close_evidence_id: string | null; close_signature_digest: string | null
  started_at: number; updated_at: number
}

interface WatchEvidenceRow {
  observation_id: string; plan_id: string; disposition: ActivationWatchEvidenceRecord['disposition']
  receipt_digest: string; signature_digest: string; receipt_json: string
  host_generation: number; failures: number; checks: number; created_at: number
}

interface ActivationDeploymentCheckpointRow {
  plan_id: string; baseline_json: string; exposure_order: number; successful_order: number | null
  recorded_at: number; succeeded_at: number | null
}

function gapFromRow(row: GapRow): StoredCapabilityGap {
  if (!DIGEST.test(row.input_digest) || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new ControlPlaneStoreError('invalid-state', 'stored capability gap is corrupt')
  return {
    id: row.id, idempotencyKey: row.idempotency_key, inputDigest: row.input_digest,
    capability: row.capability, context: row.context, expectedValue: row.expected_value,
    frequency: row.frequency, estimatedCost: row.estimated_cost, risk: row.risk, roi: row.roi,
    status: row.status, revision: row.revision, ...(row.candidate_id === null ? {} : { candidateId: row.candidate_id }),
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function watchFromRow(row: WatchRow): ActivationWatch {
  const exact = { package: row.package_name, version: row.package_version, integrity: row.package_integrity }
  const watch: ActivationWatch = {
    planId: row.plan_id, exact, activationId: row.activation_id, fence: row.fence,
    state: row.state, revision: row.revision, startedAt: row.started_at, updatedAt: row.updated_at,
    lastHostGeneration: row.last_host_generation, healthyObservations: row.healthy_observations,
  }
  if (row.close_disposition === null) {
    if (row.state !== 'watching' || row.close_at !== null || row.close_evidence_id !== null || row.close_signature_digest !== null) {
      throw new ControlPlaneStoreError('invalid-state', 'stored post-activation watch closure is corrupt')
    }
  } else {
    if (row.close_at === null || row.close_evidence_id === null || row.close_signature_digest === null
      || !DIGEST.test(row.close_signature_digest)
      || (row.state !== 'closed-regressed' && row.state !== 'closed-retracted')) {
      throw new ControlPlaneStoreError('invalid-state', 'stored post-activation watch closure is corrupt')
    }
    watch.close = { disposition: row.close_disposition, at: row.close_at, evidenceId: row.close_evidence_id, signatureDigest: row.close_signature_digest }
  }
  return watch
}

function watchEvidenceFromRow(row: WatchEvidenceRow): ActivationWatchEvidenceRecord {
  if (!DIGEST.test(row.receipt_digest) || !DIGEST.test(row.signature_digest)) {
    throw new ControlPlaneStoreError('invalid-state', 'stored post-activation evidence is corrupt')
  }
  return {
    observationId: row.observation_id, planId: row.plan_id, disposition: row.disposition,
    receiptDigest: row.receipt_digest, signatureDigest: row.signature_digest, hostGeneration: row.host_generation,
    failures: row.failures, checks: row.checks, createdAt: row.created_at,
  }
}

function watchFromStored(value: unknown): ActivationWatch {
  const item = objectRecord(value, 'stored post-activation watch')
  const exactItem = objectRecord(item.exact, 'stored post-activation watch exact target')
  const watch: ActivationWatch = {
    planId: boundedString(item.planId, 'planId'),
    exact: {
      package: boundedString(exactItem.package, 'package'), version: boundedString(exactItem.version, 'version'),
      integrity: boundedString(exactItem.integrity, 'integrity'),
    },
    activationId: boundedString(item.activationId, 'activationId'),
    fence: storedInteger(item.fence, 'fence', 1),
    state: item.state === 'watching' || item.state === 'closed-regressed' || item.state === 'closed-retracted'
      ? item.state : (() => { throw new ControlPlaneStoreError('invalid-state', 'stored post-activation watch state is corrupt') })(),
    revision: storedInteger(item.revision, 'revision', 1),
    startedAt: storedInteger(item.startedAt, 'startedAt', 0),
    updatedAt: storedInteger(item.updatedAt, 'updatedAt', 0),
    lastHostGeneration: storedInteger(item.lastHostGeneration, 'lastHostGeneration', 0),
    healthyObservations: storedInteger(item.healthyObservations, 'healthyObservations', 0),
  }
  if (item.close !== undefined) {
    if (item.close === null) throw new ControlPlaneStoreError('invalid-state', 'stored post-activation watch closure is corrupt')
    const close = objectRecord(item.close, 'stored post-activation watch closure')
    if (close.disposition !== 'regressed' && close.disposition !== 'retracted') throw new ControlPlaneStoreError('invalid-state', 'stored post-activation watch closure is corrupt')
    watch.close = {
      disposition: close.disposition, at: storedInteger(close.at, 'close.at', 0),
      evidenceId: boundedString(close.evidenceId, 'close.evidenceId'),
      signatureDigest: digestField(close.signatureDigest, 'close.signatureDigest'),
    }
  }
  return watch
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new ControlPlaneStoreError('invalid-state', `stored post-activation watch ${label} is corrupt`)
  return value
}

function storedInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new ControlPlaneStoreError('invalid-state', `stored post-activation watch ${label} is corrupt`)
  return Number(value)
}

function digestField(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new ControlPlaneStoreError('invalid-state', `stored post-activation watch ${label} is corrupt`)
  return value
}

function activationCoreFiles(value: unknown, targetPath: string, label: string): readonly { path: string; sha256: string | null }[] {
  const expectedPaths = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].map(name => `${targetPath}/${name}`)
  if (!Array.isArray(value) || value.length !== 3 || value.some((item, index) => typeof item !== 'object' || item === null || Array.isArray(item)
    || Object.keys(item as object).sort().join('\0') !== 'path\0sha256' || (item as { path?: unknown }).path !== expectedPaths[index]
    || ((item as { sha256?: unknown }).sha256 !== null && !DIGEST.test((item as { sha256: string }).sha256)))) {
    throw new ControlPlaneStoreError('invalid-state', `${label} is corrupt`)
  }
  return value as readonly { path: string; sha256: string | null }[]
}

function activationFromRow(row: ActivationRow): PluginActivationPlan {
  const candidate = parseCatalog({ schemaVersion: 1, entries: [JSON.parse(row.candidate_json) as unknown] }).entries[0]
  const gapSnapshot = JSON.parse(row.gap_snapshot_json) as PluginActivationPlan['gapSnapshot']
  const dossier = JSON.parse(row.dossier_json) as PluginActivationPlan['dossier']
  if (candidate === undefined || !DIGEST.test(row.plan_digest) || !UUID.test(row.installation_id)
    || !DIGEST.test(gapSnapshot.inputDigest) || !DIGEST.test(dossier.catalogDigest)) throw new ControlPlaneStoreError('invalid-state', 'stored activation plan is corrupt')
  const immutable = {
    schemaVersion: 4, kind: 'activation', id: row.id, gapId: row.gap_id, gapSnapshot,
    profile: row.profile, candidate, dossier, installationId: row.installation_id,
    ledger: { id: row.ledger_id, path: row.ledger_path },
    target: { dshHome: row.dsh_home, profile: row.profile, profilePath: row.target_path },
    executor: { id: row.executor_id, version: row.executor_version, path: row.executor_path, sha256: row.executor_digest },
    createdAt: row.created_at, expiresAt: row.expires_at,
  } as const
  if (controlPlaneDigest(immutable) !== row.plan_digest) throw new ControlPlaneStoreError('invalid-state', 'stored activation plan digest does not match its immutable dossier')
  let approval: PluginActivationPlan['approval']
  if (row.approval_json !== null) {
    let storedApproval: unknown
    try { storedApproval = JSON.parse(row.approval_json) as unknown }
    catch { throw new ControlPlaneStoreError('invalid-state', 'stored activation approval is corrupt') }
    approval = verifiedApprovalFromStored(storedApproval, row.id, row.plan_digest, row.created_at, row.expires_at)
  }
  let baselineFiles: readonly { path: string; sha256: string | null }[] | undefined
  if (row.activation_target_baseline_json !== null) {
    let value: unknown
    try { value = JSON.parse(row.activation_target_baseline_json) as unknown } catch { throw new ControlPlaneStoreError('invalid-state', 'stored activation baseline is corrupt') }
    if (!Array.isArray(value) || ![0, 3].includes(value.length)) {
      throw new ControlPlaneStoreError('invalid-state', 'stored activation baseline is corrupt')
    }
    baselineFiles = value.length === 0 ? [] : activationCoreFiles(value, row.target_path, 'stored activation baseline')
  }
  const requiresApproval = row.status !== 'pending-approval'
  const requiresActivation = !['pending-approval', 'approved'].includes(row.status)
  if (requiresApproval !== (approval !== undefined) || requiresActivation !== (row.activation_id !== null)
    || (row.activation_id === null && (row.activation_fence !== 0 || row.activation_lease_until !== null
      || row.activation_target_existed !== null || row.activation_target_baseline_json !== null || row.host_recovery_required !== 0
      || row.rollback_profile_restored !== 0 || row.failure_code !== null))
    || (row.activation_id !== null && (!KEY.test(row.activation_id) || row.activation_fence < 1))
    || (['rolled-back', 'activated'].includes(row.status) && row.activation_lease_until !== null)) {
    throw new ControlPlaneStoreError('invalid-state', 'stored activation state is corrupt or incomplete')
  }
  return {
    ...immutable, digest: row.plan_digest, status: row.status, revision: row.revision,
    ...(approval === undefined ? {} : { approval }),
    ...(row.activation_id === null ? {} : { activation: { id: row.activation_id, fence: row.activation_fence,
      ...(row.activation_target_existed === null ? {} : { targetOriginallyExisted: row.activation_target_existed === 1 }),
      ...(baselineFiles === undefined ? {} : { targetBaselineFiles: baselineFiles }),
      ...(row.host_recovery_required === 0 ? {} : { hostRecoveryRequired: true }),
      ...(row.rollback_profile_restored === 0 ? {} : { rollbackProfileRestored: true }),
      ...(row.failure_code === null ? {} : { failureCode: row.failure_code }), updatedAt: row.updated_at } }),
  }
}

function preparedEvidenceFromStored(value: unknown): SourcePreparedEvidence {
  const item = objectRecord(value, 'stored source prepared evidence')
  exactKeys(item, ['schemaVersion', 'kind', 'environment', 'commands', 'pack', 'preparedAt'], 'stored source prepared evidence')
  const environment = objectRecord(item['environment'], 'stored source prepared evidence environment')
  exactKeys(environment, ['npmConfigIgnoreScripts', 'frozenLockfile', 'offline', 'nodeVersion', 'pnpmVersion'],
    'stored source prepared evidence environment')
  if (item['schemaVersion'] !== 1 || item['kind'] !== 'dsh-source-prepared-evidence'
    || environment['npmConfigIgnoreScripts'] !== true || environment['frozenLockfile'] !== true
    || typeof environment['offline'] !== 'boolean'
    || typeof environment['nodeVersion'] !== 'string' || environment['nodeVersion'] === '' || environment['nodeVersion'].length > 64
    || typeof environment['pnpmVersion'] !== 'string' || environment['pnpmVersion'] === '' || environment['pnpmVersion'].length > 64
    || !Array.isArray(item['commands']) || item['commands'].length === 0 || item['commands'].length > 16
    || !Number.isSafeInteger(item['preparedAt']) || Number(item['preparedAt']) < 0) {
    throw new ControlPlaneStoreError('invalid-state', 'stored source prepared evidence is corrupt')
  }
  const commands = item['commands'].map((entry, index) => {
    const command = objectRecord(entry, `stored source prepared evidence command ${index}`)
    exactKeys(command, ['command', 'args', 'exitCode', 'durationMs', 'logDigest'], `stored source prepared evidence command ${index}`)
    if (typeof command['command'] !== 'string' || command['command'] === '' || command['command'].length > 64
      || !Array.isArray(command['args']) || command['args'].length > 64
      || command['args'].some(arg => typeof arg !== 'string' || arg.length > 4096)
      || command['exitCode'] !== 0
      || !Number.isSafeInteger(command['durationMs']) || Number(command['durationMs']) < 0
      || !DIGEST.test(String(command['logDigest']))) {
      throw new ControlPlaneStoreError('invalid-state', `stored source prepared evidence command ${index} is corrupt`)
    }
    return Object.freeze({ command: String(command['command']), args: Object.freeze([...command['args'] as string[]]),
      exitCode: 0 as const, durationMs: Number(command['durationMs']), logDigest: String(command['logDigest']) })
  })
  const pack = objectRecord(item['pack'], 'stored source prepared evidence pack')
  exactKeys(pack, ['name', 'version', 'sizeBytes', 'sha256'], 'stored source prepared evidence pack')
  if (typeof pack['name'] !== 'string' || pack['name'] === '' || pack['name'].length > 214
    || typeof pack['version'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+=-]{0,63}$/u.test(pack['version'])
    || !Number.isSafeInteger(pack['sizeBytes']) || Number(pack['sizeBytes']) < 0
    || !DIGEST.test(String(pack['sha256']))) {
    throw new ControlPlaneStoreError('invalid-state', 'stored source prepared evidence pack is corrupt')
  }
  return Object.freeze({ schemaVersion: 1 as const, kind: 'dsh-source-prepared-evidence' as const,
    environment: Object.freeze({ npmConfigIgnoreScripts: true as const, frozenLockfile: true as const,
      offline: environment['offline'] === true, nodeVersion: String(environment['nodeVersion']), pnpmVersion: String(environment['pnpmVersion']) }),
    commands: Object.freeze(commands),
    pack: Object.freeze({ name: String(pack['name']), version: String(pack['version']),
      sizeBytes: Number(pack['sizeBytes']), sha256: String(pack['sha256']) }),
    preparedAt: Number(item['preparedAt']) })
}

function sourceFromRow(row: SourceRow): PluginSourcePlan {
  if (row.mode !== 'create' && row.mode !== 'modify') {
    throw new ControlPlaneStoreError('invalid-state', 'stored source plan has an unknown mode')
  }
  const gapSnapshot = JSON.parse(row.gap_snapshot_json) as PluginSourcePlan['gapSnapshot']
  const scope = JSON.parse(row.scope_json) as readonly string[]
  const immutable = { schemaVersion: 1, kind: 'source', id: row.id, gapId: row.gap_id, gapSnapshot,
    repository: row.repository, worktree: row.worktree, baseCommit: row.base_commit, name: row.plugin_name,
    generatorDigest: row.generator_digest, scope, createdAt: row.created_at, expiresAt: row.expires_at } as const
  if (!COMMIT.test(row.base_commit) || !DIGEST.test(row.generator_digest) || !DIGEST.test(gapSnapshot.inputDigest)
    || controlPlaneDigest(scope) !== controlPlaneDigest(expectedSourceScope(row.plugin_name, row.mode))) throw new ControlPlaneStoreError('invalid-state', 'stored source plan is corrupt or digest-mismatched')
  let preparedEvidence: PluginSourcePlan['preparedEvidence']
  if (row.prepared_evidence_json !== null) {
    try { preparedEvidence = preparedEvidenceFromStored(JSON.parse(row.prepared_evidence_json) as unknown) }
    catch (error) {
      if (error instanceof ControlPlaneStoreError) {
        throw new ControlPlaneStoreError('invalid-state', `stored source prepared evidence is corrupt: ${error.message}`)
      }
      throw new ControlPlaneStoreError('invalid-state', 'stored source prepared evidence is corrupt')
    }
  }
  if ((row.mode === 'modify') !== (preparedEvidence !== undefined)
    || (row.mode === 'modify' && (row.checked_tree_digest === null || row.checked_patch_digest === null || row.checked_at === null))
    || (row.mode === 'modify' && ['running-local-checks', 'local-checks-failed'].includes(row.status))) {
    throw new ControlPlaneStoreError('invalid-state', 'stored source plan mode does not match its evidence or status')
  }
  let approval: PluginSourcePlan['approval']
  if (row.approval_json !== null) {
    let storedApproval: unknown
    try { storedApproval = JSON.parse(row.approval_json) as unknown }
    catch { throw new ControlPlaneStoreError('invalid-state', 'stored source approval is corrupt') }
    approval = verifiedApprovalFromStored(storedApproval, row.id, row.plan_digest, row.created_at, row.expires_at)
  }
  const sourceCheck = row.checked_tree_digest === null ? undefined : { treeDigest: row.checked_tree_digest,
    patchDigest: row.checked_patch_digest!, checkedAt: row.checked_at! }
  if ((row.checked_tree_digest === null) !== (row.checked_patch_digest === null)
    || (row.checked_tree_digest === null) !== (row.checked_at === null)
    || (sourceCheck !== undefined && (!DIGEST.test(sourceCheck.treeDigest) || !DIGEST.test(sourceCheck.patchDigest)
      || !Number.isSafeInteger(sourceCheck.checkedAt) || sourceCheck.checkedAt < 0))) {
    throw new ControlPlaneStoreError('invalid-state', 'stored source check evidence is corrupt')
  }
  const digestBinding = row.mode === 'modify'
    ? { ...immutable, mode: row.mode, sourceCheck, preparedEvidence }
    : immutable
  if (controlPlaneDigest(digestBinding) !== row.plan_digest) {
    throw new ControlPlaneStoreError('invalid-state', 'stored source plan is corrupt or digest-mismatched')
  }
  let releaseAuthorization: PluginSourcePlan['releaseAuthorization']
  if (row.release_authorization_json !== null) {
    try { releaseAuthorization = parseVerifiedSourceReleaseAuthorization(JSON.parse(row.release_authorization_json) as unknown) }
    catch { throw new ControlPlaneStoreError('invalid-state', 'stored source release authorization is corrupt') }
    if (!DIGEST.test(row.release_authorization_digest ?? '')
      || controlPlaneDigest(releaseAuthorization) !== row.release_authorization_digest || releaseAuthorization.planId !== row.id
      || releaseAuthorization.planDigest !== row.plan_digest || releaseAuthorization.baseCommit !== row.base_commit
      || releaseAuthorization.checkedTreeDigest !== row.checked_tree_digest || releaseAuthorization.checkedPatchDigest !== row.checked_patch_digest
      || controlPlaneDigest(releaseAuthorization.scope) !== controlPlaneDigest(scope)) {
      throw new ControlPlaneStoreError('invalid-state', 'stored source release authorization is not bound to its source plan')
    }
  }
  if ((row.release_authorization_json === null) !== (row.release_authorization_digest === null)) {
    throw new ControlPlaneStoreError('invalid-state', 'stored source release authorization digest is corrupt')
  }
  const activeRelease = expectedSourceRelease(row.status) !== undefined || row.status === 'publish-ambiguous' || row.status === 'release-complete'
  if ((row.release_id === null) !== (row.release_fence === 0) || (activeRelease
    && (row.release_id === null || releaseAuthorization === undefined || sourceCheck === undefined))) {
    throw new ControlPlaneStoreError('invalid-state', 'stored source release state is incomplete')
  }
  return { ...immutable, mode: row.mode, digest: row.plan_digest, status: row.status, revision: row.revision,
    ...(approval === undefined ? {} : { approval }),
    ...(sourceCheck === undefined ? {} : { sourceCheck }),
    ...(preparedEvidence === undefined ? {} : { preparedEvidence }),
    ...(releaseAuthorization === undefined ? {} : { releaseAuthorization }),
    ...(row.release_id === null ? {} : { release: { id: row.release_id, fence: row.release_fence,
      ...(row.release_failure_phase === null ? {} : { failurePhase: row.release_failure_phase }),
      ...(row.release_failure_code === null ? {} : { failureCode: row.release_failure_code }), updatedAt: row.updated_at } }) }
}

function sourceSnapshotFromStored(value: unknown): PluginSourcePlan {
  const item = objectRecord(value, 'stored source plan snapshot')
  // `mode` was introduced in schema v13; receipt rows written by older binaries
  // omit it and are backfilled to 'create'. `preparedEvidence` exists only on
  // 'modify' plans.
  const optional = ['approval', 'sourceCheck', 'preparedEvidence', 'releaseAuthorization', 'release']
    .filter(key => Object.hasOwn(item, key))
  exactKeys(item, [...SOURCE_PLAN_KEYS, 'mode', ...optional], 'stored source plan snapshot')
  const rawMode = item['mode']; const mode: 'create' | 'modify' = rawMode === undefined
    ? 'create'
    : rawMode === 'create' || rawMode === 'modify' ? rawMode : 'create'
  const modeValid = rawMode === undefined || rawMode === 'create' || rawMode === 'modify'
  const gapSnapshot = objectRecord(item['gapSnapshot'], 'stored source gap snapshot')
  exactKeys(gapSnapshot, ['revision', 'inputDigest', 'roi', 'capability'], 'stored source gap snapshot')
  if (item['schemaVersion'] !== 1 || item['kind'] !== 'source' || typeof item['id'] !== 'string'
    || typeof item['gapId'] !== 'string' || typeof item['status'] !== 'string' || !SOURCE_STATUSES.has(item['status'] as SourcePlanStatus)
    || !modeValid
    || !Number.isSafeInteger(item['revision']) || Number(item['revision']) < 1 || !Number.isSafeInteger(item['createdAt'])
    || !Number.isSafeInteger(item['expiresAt']) || Number(item['expiresAt']) <= Number(item['createdAt'])
    || typeof item['digest'] !== 'string' || !DIGEST.test(item['digest']) || typeof item['repository'] !== 'string'
    || typeof item['worktree'] !== 'string' || typeof item['baseCommit'] !== 'string' || !COMMIT.test(item['baseCommit'])
    || typeof item['name'] !== 'string' || !PLUGIN_NAME.test(item['name']) || typeof item['generatorDigest'] !== 'string'
    || !DIGEST.test(item['generatorDigest']) || !Array.isArray(item['scope'])
    || controlPlaneDigest(item['scope']) !== controlPlaneDigest(expectedSourceScope(item['name'], mode))
    || (mode === 'modify' && item['preparedEvidence'] === undefined)
    || (mode === 'create' && item['preparedEvidence'] !== undefined)
    || !Number.isSafeInteger(gapSnapshot['revision']) || Number(gapSnapshot['revision']) < 1
    || typeof gapSnapshot['inputDigest'] !== 'string' || !DIGEST.test(gapSnapshot['inputDigest'])
    || typeof gapSnapshot['roi'] !== 'number' || !Number.isFinite(gapSnapshot['roi']) || typeof gapSnapshot['capability'] !== 'string') {
    throw new ControlPlaneStoreError('invalid-state', 'stored source plan snapshot is corrupt')
  }
  const immutable = { schemaVersion: 1, kind: 'source', id: item['id'], gapId: item['gapId'], gapSnapshot,
    repository: item['repository'], worktree: item['worktree'], baseCommit: item['baseCommit'], name: item['name'],
    generatorDigest: item['generatorDigest'], scope: item['scope'], createdAt: item['createdAt'], expiresAt: item['expiresAt'] }
  const preparedEvidence = item['preparedEvidence'] === undefined ? undefined : preparedEvidenceFromStored(item['preparedEvidence'])
  const approval = item['approval'] === undefined ? undefined : verifiedApprovalFromStored(item['approval'], item['id'], item['digest'],
    Number(item['createdAt']), Number(item['expiresAt']))
  let sourceCheck: PluginSourcePlan['sourceCheck']
  if (item['sourceCheck'] !== undefined) {
    const check = objectRecord(item['sourceCheck'], 'stored source check snapshot')
    exactKeys(check, ['treeDigest', 'patchDigest', 'checkedAt'], 'stored source check snapshot')
    if (typeof check['treeDigest'] !== 'string' || !DIGEST.test(check['treeDigest'])
      || typeof check['patchDigest'] !== 'string' || !DIGEST.test(check['patchDigest'])
      || !Number.isSafeInteger(check['checkedAt']) || Number(check['checkedAt']) < 0) {
      throw new ControlPlaneStoreError('invalid-state', 'stored source check snapshot is corrupt')
    }
    sourceCheck = check as unknown as NonNullable<PluginSourcePlan['sourceCheck']>
  }
  const digestBinding = mode === 'modify' ? { ...immutable, mode, sourceCheck, preparedEvidence } : immutable
  if (controlPlaneDigest(digestBinding) !== item['digest']) throw new ControlPlaneStoreError('invalid-state', 'stored source plan snapshot digest is corrupt')
  let releaseAuthorization: PluginSourcePlan['releaseAuthorization']
  if (item['releaseAuthorization'] !== undefined) {
    try { releaseAuthorization = parseVerifiedSourceReleaseAuthorization(item['releaseAuthorization']) }
    catch { throw new ControlPlaneStoreError('invalid-state', 'stored source authorization snapshot is corrupt') }
    if (releaseAuthorization.planId !== item['id'] || releaseAuthorization.planDigest !== item['digest']
      || releaseAuthorization.baseCommit !== item['baseCommit'] || sourceCheck === undefined
      || releaseAuthorization.checkedTreeDigest !== sourceCheck.treeDigest
      || releaseAuthorization.checkedPatchDigest !== sourceCheck.patchDigest
      || controlPlaneDigest(releaseAuthorization.scope) !== controlPlaneDigest(item['scope'])) {
      throw new ControlPlaneStoreError('invalid-state', 'stored source authorization snapshot is plan-mismatched')
    }
  }
  let release: PluginSourcePlan['release']
  if (item['release'] !== undefined) {
    const stored = objectRecord(item['release'], 'stored source release snapshot')
    const releaseOptional = ['failurePhase', 'failureCode'].filter(key => Object.hasOwn(stored, key))
    exactKeys(stored, ['id', 'fence', 'updatedAt', ...releaseOptional], 'stored source release snapshot')
    if (typeof stored['id'] !== 'string' || !KEY.test(stored['id']) || !Number.isSafeInteger(stored['fence'])
      || Number(stored['fence']) < 1 || !Number.isSafeInteger(stored['updatedAt'])
      || Number(stored['updatedAt']) < Number(item['createdAt'])
      || (stored['failurePhase'] !== undefined && !['pr', 'review', 'merge', 'build', 'sign', 'publish',
        'registry-verify', 'catalog-admission'].includes(String(stored['failurePhase'])))
      || (stored['failureCode'] !== undefined && (typeof stored['failureCode'] !== 'string' || stored['failureCode'] === ''))) {
      throw new ControlPlaneStoreError('invalid-state', 'stored source release snapshot is corrupt')
    }
    release = stored as unknown as NonNullable<PluginSourcePlan['release']>
  }
  const status = item['status'] as SourcePlanStatus
  const requiresApproval = status !== 'pending-approval'
  // 'create' plans acquire checked digests only after the post-approval scaffold
  // run; 'modify' plans carry them from the pending state and never enter the
  // running-local-checks / local-checks-failed states.
  const postCheckStates: readonly SourcePlanStatus[] = ['ready-for-human-review', 'release-complete',
    'release-failed', 'publish-ambiguous']
  const requiresCheck = mode === 'modify'
    || expectedSourceRelease(status) !== undefined || postCheckStates.includes(status)
  const requiresRelease = expectedSourceRelease(status) !== undefined || ['release-complete', 'release-failed', 'publish-ambiguous'].includes(status)
  if ((mode === 'modify' && (['running-local-checks', 'local-checks-failed'].includes(status) || sourceCheck === undefined))
    || (status !== 'expired' && requiresApproval !== (approval !== undefined))
    || (status === 'expired' && mode !== 'modify')
    || requiresCheck !== (sourceCheck !== undefined)
    || requiresRelease !== (releaseAuthorization !== undefined && release !== undefined)
    || (!requiresRelease && (releaseAuthorization !== undefined || release !== undefined))) {
    throw new ControlPlaneStoreError('invalid-state', 'stored source plan snapshot fields do not match its status')
  }
  return { ...immutable, mode, digest: item['digest'], status: item['status'] as SourcePlanStatus, revision: Number(item['revision']),
    ...(approval === undefined ? {} : { approval }), ...(sourceCheck === undefined ? {} : { sourceCheck }),
    ...(preparedEvidence === undefined ? {} : { preparedEvidence }),
    ...(releaseAuthorization === undefined ? {} : { releaseAuthorization }),
    ...(release === undefined ? {} : { release }) } as unknown as PluginSourcePlan
}

export interface ControlPlaneStoreOptions {
  path: string; now?: () => number
  /** Host-owned synchronous source fence for an activation worker connection. */
  withOwnerActivationFence?: <T>(gapId: string, callback: () => T) => T
}

export interface CreateActivationPlanInput {
  candidate: CatalogEntry
  catalog: Pick<LoadedCapabilityCatalog, 'digest' | 'provenance'>
  matchedCapabilities: readonly string[]
  profile: string
  target: PluginActivationPlan['target']
  installationId: string
  ledger: PluginActivationPlan['ledger']
  executor: PluginActivationPlan['executor']
  ttlMs: number
  gapId: string
  idempotencyKey: string
  /** Exact completed owner repair; persisted atomically with its activation plan. */
  sourcePlanId?: string
}

export interface CreateSourcePlanInput {
  gapId: string; repository: string; worktree: string; baseCommit: string; name: string
  generatorDigest: string; scope: readonly string[]; ttlMs: number; idempotencyKey: string
  /** Defaults to 'create' (the legacy post-approval scaffold flow). */
  mode?: 'create' | 'modify'
  /** Required exactly for 'modify': the patch was already built and checked in isolation. */
  prepared?: {
    treeDigest: string
    patchDigest: string
    checkedAt: number
    evidence: SourcePreparedEvidence
  }
  /** Durable completion fence for a background source job. */
  sourceJob?: SourceJobCompletion
}

export interface PrepareSourceReleaseOperationInput {
  /** Host-only, synchronous owner admission for owner-task source plans. */
  withSourceFence?: <T>(callback: () => T) => T
  planId: string
  expectedRevision: number
  expectedFence: number
  installationId: string
  ledger: { id: string; path: string }
  registry: { id: string; locator: string }
  catalog: { id: string; path: string; expectedBeforeDigest?: string; expectedAfterDigest?: string }
  adapter: SourceReleaseAdapterIdentity
  receiptTtlMs: number
  resolveAuthorizationAuthority: (authorization: SourceReleaseAuthorization) => SourceReleaseAuthorizationAuthority
}

export interface PrepareSourcePublishReconciliationInput {
  planId: string; expectedRevision: number; expectedFence: number; installationId: string
  ledger: { id: string; path: string }; registry: { id: string; locator: string }
  adapter: SourceReleaseAdapterIdentity; receiptTtlMs: number
  resolveAuthorizationAuthority: (authorization: SourceReleaseAuthorization) => SourceReleaseAuthorizationAuthority
}

const expectedAttestation: Readonly<Record<string, { phase: HostAttestationPhase; next: PlanStatus }>> = Object.freeze({
  'awaiting-reload': { phase: 'reload', next: 'awaiting-readiness' },
  'awaiting-readiness': { phase: 'readiness', next: 'awaiting-effect-blocked-replay' },
  'awaiting-effect-blocked-replay': { phase: 'effect-blocked-replay', next: 'awaiting-shadow' },
  'awaiting-shadow': { phase: 'shadow', next: 'awaiting-canary' },
  'awaiting-canary': { phase: 'canary', next: 'awaiting-soak' },
  'awaiting-soak': { phase: 'soak', next: 'awaiting-health' },
  'awaiting-health': { phase: 'health', next: 'commit-pending' },
  'rollback-pending': { phase: 'rollback', next: 'rolled-back' },
})

const predecessorPhase: Readonly<Partial<Record<HostAttestationPhase, HostAttestationPhase>>> = Object.freeze({
  readiness: 'reload',
  'effect-blocked-replay': 'readiness',
  shadow: 'effect-blocked-replay',
  canary: 'shadow',
  soak: 'canary',
  health: 'soak',
})

export function expectedHostAttestation(status: PlanStatus): { phase: HostAttestationPhase; next: PlanStatus } | undefined {
  return expectedAttestation[status]
}

function requestBinding(request: StoredHostAttestationRequest): Record<string, unknown> {
  const { operationId: _operationId, requestedAt: _requestedAt, ...binding } = request
  return binding
}

const hostPhases = new Set<HostAttestationPhase>(['reload', 'readiness', 'effect-blocked-replay', 'shadow', 'canary', 'soak', 'health', 'rollback'])

function isBoundHostRequest(request: StoredHostAttestationRequest): request is HostAttestationRequest {
  if (request.schemaVersion !== 2 || !hostPhases.has(request.phase)) return false
  const predecessor = request.predecessor
  if (predecessor === null) return request.phase === 'reload' || request.phase === 'rollback'
  return typeof predecessor === 'object' && predecessor !== null
    && typeof predecessor.operationId === 'string' && KEY.test(predecessor.operationId)
    && typeof predecessor.receiptId === 'string' && KEY.test(predecessor.receiptId)
    && typeof predecessor.phase === 'string' && hostPhases.has(predecessor.phase)
    && typeof predecessor.receiptDigest === 'string' && DIGEST.test(predecessor.receiptDigest)
    && Number.isSafeInteger(predecessor.hostGeneration) && predecessor.hostGeneration >= 1
    && predecessor.operationId !== request.operationId && predecessor.phase !== request.phase
}

function hostOperationFromRow(row: HostAttestationOperationRow): HostAttestationOperation {
  const request = JSON.parse(row.request_json) as StoredHostAttestationRequest
  if (request.operationId !== row.operation_id || request.plan.id !== row.plan_id || request.phase !== row.phase
    || controlPlaneDigest(request) !== row.request_digest || controlPlaneDigest(requestBinding(request)) !== row.binding_digest
    || (row.status === 'pending') !== (row.receipt_json === null)) {
    throw new ControlPlaneStoreError('invalid-state', 'stored Host attestation operation is corrupt')
  }
  const receipt = row.receipt_json === null ? undefined : JSON.parse(row.receipt_json) as HostAttestationReceipt
  if (receipt !== undefined && (receipt.operationId !== row.operation_id || controlPlaneDigest(receipt) !== row.receipt_digest)) {
    throw new ControlPlaneStoreError('invalid-state', 'stored Host attestation receipt is corrupt')
  }
  return { planId: row.plan_id, phase: row.phase, operationId: row.operation_id, bindingDigest: row.binding_digest,
    requestDigest: row.request_digest, request, status: row.status, ...(receipt === undefined ? {} : { receipt }),
    createdAt: row.created_at, ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.applied_at === null ? {} : { appliedAt: row.applied_at }) }
}

function releaseRequestBinding(request: SourceReleaseRequest): Omit<SourceReleaseRequest, 'operationId' | 'requestedAt'> {
  const { operationId: _operationId, requestedAt: _requestedAt, ...binding } = request
  return binding
}

function sourceReleaseOperationFromRow(row: SourceReleaseOperationRow): SourceReleaseOperation {
  let request: SourceReleaseRequest
  try { request = parseSourceReleaseRequest(JSON.parse(row.request_json) as unknown) }
  catch (error) {
    if (error instanceof ControlPlaneStoreError) throw new ControlPlaneStoreError('invalid-state', `stored source release request is corrupt: ${error.message}`)
    throw new ControlPlaneStoreError('invalid-state', 'stored source release request is corrupt')
  }
  const timestampsValid = Number.isSafeInteger(row.created_at) && row.created_at >= 0
    && (row.completed_at === null || (Number.isSafeInteger(row.completed_at) && row.completed_at >= row.created_at))
    && (row.applied_at === null || (row.completed_at !== null && Number.isSafeInteger(row.applied_at) && row.applied_at >= row.completed_at))
  const stateValid = row.status === 'pending'
    ? row.receipt_digest === null && row.receipt_json === null && row.completed_at === null && row.applied_at === null
    : row.status === 'completed'
      ? row.receipt_digest !== null && row.receipt_json !== null && row.completed_at !== null && row.applied_at === null
      : row.status === 'applied' && row.receipt_digest !== null && row.receipt_json !== null
        && row.completed_at !== null && row.applied_at !== null
  if (!timestampsValid || !stateValid || !DIGEST.test(row.binding_digest) || !DIGEST.test(row.request_digest)
    || !Number.isSafeInteger(row.release_fence) || row.release_fence < 1 || !Number.isSafeInteger(row.attempt) || row.attempt < 1
    || request.operationId !== row.operation_id || request.plan.id !== row.plan_id || request.phase !== row.phase
    || request.release.id !== row.release_id || request.release.fence !== row.release_fence || request.attempt !== row.attempt
    || controlPlaneDigest(request) !== row.request_digest || controlPlaneDigest(releaseRequestBinding(request)) !== row.binding_digest) {
    throw new ControlPlaneStoreError('invalid-state', 'stored source release operation is corrupt')
  }
  let receipt: SourceReleaseReceipt | undefined
  if (row.receipt_json !== null) {
    try { receipt = parseSourceReleaseReceipt(JSON.parse(row.receipt_json) as unknown) }
    catch (error) {
      if (error instanceof ControlPlaneStoreError) throw new ControlPlaneStoreError('invalid-state', `stored source release receipt is corrupt: ${error.message}`)
      throw new ControlPlaneStoreError('invalid-state', 'stored source release receipt is corrupt')
    }
    if (receipt.operationId !== row.operation_id || receipt.planId !== row.plan_id || receipt.phase !== row.phase
      || receipt.releaseId !== row.release_id || receipt.fence !== row.release_fence
      || receipt.requestDigest !== row.request_digest || controlPlaneDigest(receipt) !== row.receipt_digest) {
      throw new ControlPlaneStoreError('invalid-state', 'stored source release receipt is not bound to its operation')
    }
  }
  return { planId: row.plan_id, phase: row.phase, operationId: row.operation_id, attempt: row.attempt, fence: row.release_fence,
    bindingDigest: row.binding_digest, requestDigest: row.request_digest, request, status: row.status,
    ...(receipt === undefined ? {} : { receipt }), createdAt: row.created_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.applied_at === null ? {} : { appliedAt: row.applied_at }) }
}

export interface SourcePublishReconciliationOperation {
  planId: string; releaseId: string; fence: number; attempt: number; operationId: string
  bindingDigest: string; requestDigest: string; request: SourcePublishReconciliationRequest
  status: 'pending' | 'completed' | 'applied'; receipt?: SourcePublishReconciliationReceipt
  createdAt: number; completedAt?: number; appliedAt?: number
}

function reconciliationBinding(request: SourcePublishReconciliationRequest): Omit<SourcePublishReconciliationRequest, 'operationId' | 'requestedAt'> {
  const { operationId: _operationId, requestedAt: _requestedAt, ...binding } = request
  return binding
}

function sourcePublishReconciliationFromRow(row: SourcePublishReconciliationRow): SourcePublishReconciliationOperation {
  let request: SourcePublishReconciliationRequest
  try { request = parseSourcePublishReconciliationRequest(JSON.parse(row.request_json) as unknown) }
  catch { throw new ControlPlaneStoreError('invalid-state', 'stored publish reconciliation request is corrupt') }
  const stateValid = row.status === 'pending'
    ? row.receipt_digest === null && row.receipt_json === null && row.completed_at === null && row.applied_at === null
    : row.status === 'completed'
      ? row.receipt_digest !== null && row.receipt_json !== null && row.completed_at !== null && row.applied_at === null
      : row.status === 'applied' && row.receipt_digest !== null && row.receipt_json !== null && row.completed_at !== null && row.applied_at !== null
  if (!stateValid || !Number.isSafeInteger(row.attempt) || row.attempt < 1 || request.operationId !== row.operation_id
    || request.plan.id !== row.plan_id || request.release.id !== row.release_id || request.release.fence !== row.release_fence
    || request.attempt !== row.attempt
    || controlPlaneDigest(request) !== row.request_digest || controlPlaneDigest(reconciliationBinding(request)) !== row.binding_digest) {
    throw new ControlPlaneStoreError('invalid-state', 'stored publish reconciliation operation is corrupt')
  }
  let receipt: SourcePublishReconciliationReceipt | undefined
  if (row.receipt_json !== null) {
    try { receipt = parseSourcePublishReconciliationReceipt(JSON.parse(row.receipt_json) as unknown) }
    catch { throw new ControlPlaneStoreError('invalid-state', 'stored publish reconciliation receipt is corrupt') }
    if (receipt.operationId !== row.operation_id || receipt.planId !== row.plan_id || receipt.releaseId !== row.release_id
      || receipt.fence !== row.release_fence || receipt.requestDigest !== row.request_digest
      || controlPlaneDigest(receipt) !== row.receipt_digest) throw new ControlPlaneStoreError('invalid-state', 'stored publish reconciliation receipt is not bound')
  }
  return { planId: row.plan_id, releaseId: row.release_id, fence: row.release_fence, attempt: row.attempt,
    operationId: row.operation_id, bindingDigest: row.binding_digest, requestDigest: row.request_digest, request, status: row.status,
    ...(receipt === undefined ? {} : { receipt }), createdAt: row.created_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }), ...(row.applied_at === null ? {} : { appliedAt: row.applied_at }) }
}

const expectedRelease: Readonly<Record<string, { phase: SourceReleasePhase; next: SourcePlanStatus }>> = Object.freeze({
  'awaiting-pr': { phase: 'pr', next: 'awaiting-review' },
  'awaiting-review': { phase: 'review', next: 'awaiting-merge' },
  'awaiting-merge': { phase: 'merge', next: 'awaiting-build' },
  'awaiting-build': { phase: 'build', next: 'awaiting-sign' },
  'awaiting-sign': { phase: 'sign', next: 'awaiting-publish' },
  'awaiting-publish': { phase: 'publish', next: 'awaiting-registry-verify' },
  'awaiting-registry-verify': { phase: 'registry-verify', next: 'awaiting-catalog-admission' },
  'awaiting-catalog-admission': { phase: 'catalog-admission', next: 'release-complete' },
})

export function expectedSourceRelease(status: SourcePlanStatus): { phase: SourceReleasePhase; next: SourcePlanStatus } | undefined {
  return expectedRelease[status]
}

function releaseArtifact(evidence: SourceReleaseSuccessEvidence): SourceReleaseArtifact {
  if (evidence.kind !== 'build') throw new ControlPlaneStoreError('invalid-state', 'durable build evidence is missing')
  return { candidateId: evidence.candidateId, sourceName: evidence.sourceName, packagePath: evidence.packagePath,
    packageName: evidence.packageName, packageVersion: evidence.packageVersion, tarballPath: evidence.tarballPath,
    tarballBytes: evidence.tarballBytes, tarballSha256: evidence.tarballSha256, tarballIntegrity: evidence.tarballIntegrity,
    sbomPath: evidence.sbomPath, sbomSha256: evidence.sbomSha256, provenancePath: evidence.provenancePath,
    provenanceSha256: evidence.provenanceSha256, mergedCommit: evidence.mergedCommit, dshBaseline: evidence.dshBaseline,
    capabilities: evidence.capabilities, authorities: evidence.authorities, requires: evidence.requires }
}

function sourceJobIntentFromStored(value: unknown): SourceJobIntent {
  const intent = objectRecord(value, 'source job intent')
  exactKeys(intent, ['authority', 'owner', 'ownerDigest', 'trustDigest', 'repository', 'name', 'gapId', 'gapRevision', 'gapDigest',
    'baseCommit', 'files', 'ttlMs', 'build', 'worktree', 'containerName'], 'source job intent')
  const authority = objectRecord(intent['authority'], 'source job authority')
  exactKeys(authority, ['id', 'digest', 'expiresAt', 'maxSubmissions'], 'source job authority')
  const owner = objectRecord(intent['owner'], 'source job owner')
  exactKeys(owner, ['receiptVersion', 'authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion',
    'workspace', 'agentPreset', 'bindingVersion', 'generation'], 'source job owner')
  if (typeof authority['id'] !== 'string' || !KEY.test(authority['id']) || typeof authority['digest'] !== 'string' || !DIGEST.test(authority['digest'])
    || !Number.isSafeInteger(authority['expiresAt']) || Number(authority['expiresAt']) < 0
    || !Number.isSafeInteger(authority['maxSubmissions']) || Number(authority['maxSubmissions']) < 1 || Number(authority['maxSubmissions']) > 1_000
    || owner['receiptVersion'] !== 2 || typeof owner['authorityId'] !== 'string' || typeof owner['authorityHash'] !== 'string' || !DIGEST.test(owner['authorityHash'])
    || typeof owner['principalId'] !== 'string' || typeof owner['principalRecordId'] !== 'string' || !Number.isSafeInteger(owner['principalVersion'])
    || typeof owner['workspace'] !== 'string' || typeof owner['agentPreset'] !== 'string' || !Number.isSafeInteger(owner['bindingVersion'])
    || !Number.isSafeInteger(owner['generation']) || typeof intent['ownerDigest'] !== 'string' || !DIGEST.test(intent['ownerDigest'] as string)
    || typeof intent['trustDigest'] !== 'string' || !DIGEST.test(intent['trustDigest'] as string)
    || typeof intent['repository'] !== 'string' || !isAbsolute(intent['repository'] as string)
    || typeof intent['worktree'] !== 'string' || !isAbsolute(intent['worktree'] as string)
    || typeof intent['name'] !== 'string' || !PLUGIN_NAME.test(intent['name'] as string)
    || typeof intent['gapId'] !== 'string' || !KEY.test(intent['gapId'] as string) || !Number.isSafeInteger(intent['gapRevision']) || Number(intent['gapRevision']) < 1
    || typeof intent['gapDigest'] !== 'string' || !DIGEST.test(intent['gapDigest'] as string)
    || typeof intent['baseCommit'] !== 'string' || !COMMIT.test(intent['baseCommit'] as string)
    || !Array.isArray(intent['files']) || intent['files'].length === 0 || intent['files'].length > 64
    || !Number.isSafeInteger(intent['ttlMs']) || Number(intent['ttlMs']) < 60_000 || Number(intent['ttlMs']) > 86_400_000
    || typeof intent['containerName'] !== 'string' || !/^dsh-source-job-[a-f0-9]{64}$/u.test(intent['containerName'] as string)) {
    throw new ControlPlaneStoreError('invalid-input', 'source job intent is invalid')
  }
  if (Number(owner['principalVersion']) < 1 || Number(owner['bindingVersion']) < 1 || Number(owner['generation']) < 1) {
    throw new ControlPlaneStoreError('invalid-input', 'source job owner version is invalid')
  }
  if (controlPlaneDigest(owner) !== intent['ownerDigest']) throw new ControlPlaneStoreError('invalid-input', 'source job owner digest is invalid')
  const files = intent['files'].map((item, index) => {
    const file = objectRecord(item, `source job file ${index}`)
    exactKeys(file, ['path', 'content'], `source job file ${index}`)
    if (typeof file['path'] !== 'string' || file['path'] === '' || file['path'].length > 512 || file['path'].startsWith('/')
      || file['path'].split('/').some(part => part === '' || part === '.' || part === '..')
      || typeof file['content'] !== 'string' || Buffer.byteLength(file['content']) > 65_536) {
      throw new ControlPlaneStoreError('invalid-input', 'source job file is invalid')
    }
    return Object.freeze({ path: file['path'], content: file['content'] })
  })
  if (new Set(files.map(file => file.path)).size !== files.length) throw new ControlPlaneStoreError('invalid-input', 'source job files are duplicated')
  try { validateScopedPluginFiles(files) }
  catch { throw new ControlPlaneStoreError('invalid-input', 'source job files are invalid') }
  try { validateSourceBuildConfig(intent['build'] as SourceJobIntent['build']) }
  catch { throw new ControlPlaneStoreError('invalid-input', 'source job build configuration is invalid') }
  return Object.freeze({ authority: Object.freeze({ id: authority['id'], digest: authority['digest'], expiresAt: Number(authority['expiresAt']), maxSubmissions: Number(authority['maxSubmissions']) }),
    owner: Object.freeze({ receiptVersion: 2, authorityId: owner['authorityId'] as string, authorityHash: owner['authorityHash'] as string,
      principalId: owner['principalId'] as string, principalRecordId: owner['principalRecordId'] as string, principalVersion: Number(owner['principalVersion']),
      workspace: owner['workspace'] as string, agentPreset: owner['agentPreset'] as string, bindingVersion: Number(owner['bindingVersion']), generation: Number(owner['generation']) }),
    ownerDigest: intent['ownerDigest'] as string, trustDigest: intent['trustDigest'] as string, repository: intent['repository'] as string,
    name: intent['name'] as string, gapId: intent['gapId'] as string, gapRevision: Number(intent['gapRevision']), gapDigest: intent['gapDigest'] as string,
    baseCommit: intent['baseCommit'] as string, files: Object.freeze(files), ttlMs: Number(intent['ttlMs']), build: intent['build'] as SourceJobIntent['build'],
    worktree: intent['worktree'] as string, containerName: intent['containerName'] as string })
}

function exactInputRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ControlPlaneStoreError('invalid-input', `${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function exactInputKeys(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) {
    throw new ControlPlaneStoreError('invalid-input', `${label} has unknown or missing fields`)
  }
}

function exactText(value: unknown, field: string, maximum = 512): string {
  if (typeof value !== 'string' || bounded(value, field, maximum) !== value) {
    throw new ControlPlaneStoreError('invalid-input', `${field} is invalid`)
  }
  return value
}

function ownerTaskFailureReferenceFromStored(value: unknown, errorCode: 'invalid-input' | 'invalid-state' = 'invalid-input'): OwnerTaskFailureReference {
  try {
    const reference = errorCode === 'invalid-input' ? exactInputRecord(value, 'owner task failure reference') : objectRecord(value, 'owner task failure reference')
    const keys = errorCode === 'invalid-input' ? exactInputKeys : exactKeys
    keys(reference, ['schemaVersion', 'owner', 'outcomeId', 'projection', 'sourceDigest'], 'owner task failure reference')
    const owner = errorCode === 'invalid-input' ? exactInputRecord(reference['owner'], 'owner task failure owner') : objectRecord(reference['owner'], 'owner task failure owner')
    keys(owner, ['receiptVersion', 'authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion',
      'workspace', 'agentPreset', 'bindingVersion', 'generation'], 'owner task failure owner')
    const projection = errorCode === 'invalid-input' ? exactInputRecord(reference['projection'], 'owner task failure projection') : objectRecord(reference['projection'], 'owner task failure projection')
    const projectionFields = ['subjectKind', 'subjectRef', 'version', 'digest', 'disposition',
      ...(Object.hasOwn(projection, 'evidenceOutcomeId') ? ['evidenceOutcomeId'] : [])]
    keys(projection, projectionFields, 'owner task failure projection')
    const text = errorCode === 'invalid-input' ? exactText : (item: unknown, field: string, maximum?: number) => {
      if (typeof item !== 'string' || bounded(item, field, maximum) !== item) throw new ControlPlaneStoreError('invalid-state', `${field} is invalid`)
      return item
    }
    if (reference['schemaVersion'] !== 1 || owner['receiptVersion'] !== 2
      || !KEY.test(text(owner['authorityId'], 'owner authorityId', 160)) || !DIGEST.test(text(owner['authorityHash'], 'owner authorityHash', 64))
      || !isAbsolute(text(owner['workspace'], 'owner workspace', 4_096)) || !KEY.test(text(owner['agentPreset'], 'owner agentPreset', 160))
      || !KEY.test(text(reference['outcomeId'], 'outcomeId', 160)) || projection['subjectKind'] !== 'foreground-turn'
      || !KEY.test(text(projection['subjectRef'], 'projection subjectRef', 160)) || projection['disposition'] !== 'upsert'
      || !DIGEST.test(text(projection['digest'], 'projection digest', 64)) || !DIGEST.test(text(reference['sourceDigest'], 'sourceDigest', 64))
      || !Number.isSafeInteger(owner['principalVersion']) || Number(owner['principalVersion']) < 1
      || !Number.isSafeInteger(owner['bindingVersion']) || Number(owner['bindingVersion']) < 1
      || !Number.isSafeInteger(owner['generation']) || Number(owner['generation']) < 1
      || !Number.isSafeInteger(projection['version']) || Number(projection['version']) < 1) {
      throw new ControlPlaneStoreError(errorCode, 'owner task failure reference is invalid')
    }
    const principalId = text(owner['principalId'], 'owner principalId', 512)
    const principalRecordId = text(owner['principalRecordId'], 'owner principalRecordId', 512)
    if (projection['evidenceOutcomeId'] !== undefined && !KEY.test(text(projection['evidenceOutcomeId'], 'projection evidenceOutcomeId', 160))) {
      throw new ControlPlaneStoreError(errorCode, 'owner task failure reference is invalid')
    }
    return Object.freeze({ schemaVersion: 1, owner: Object.freeze({ receiptVersion: 2,
      authorityId: owner['authorityId'] as string, authorityHash: owner['authorityHash'] as string,
      principalId, principalRecordId, principalVersion: Number(owner['principalVersion']), workspace: owner['workspace'] as string,
      agentPreset: owner['agentPreset'] as string, bindingVersion: Number(owner['bindingVersion']), generation: Number(owner['generation']) }),
    outcomeId: reference['outcomeId'] as string, projection: Object.freeze({ subjectKind: 'foreground-turn',
      subjectRef: projection['subjectRef'] as string, version: Number(projection['version']), digest: projection['digest'] as string,
      disposition: 'upsert', ...(projection['evidenceOutcomeId'] === undefined ? {} : { evidenceOutcomeId: projection['evidenceOutcomeId'] as string }) }),
    sourceDigest: reference['sourceDigest'] as string })
  } catch (error) {
    if (error instanceof ControlPlaneStoreError) throw error
    throw new ControlPlaneStoreError(errorCode, 'owner task failure reference is invalid')
  }
}

function sourceJobFromRow(row: SourceJobRow): SourceJobRecord {
  let intent: SourceJobIntent
  try { intent = sourceJobIntentFromStored(JSON.parse(row.intent_json) as unknown) }
  catch (error) { if (error instanceof ControlPlaneStoreError) throw error; throw new ControlPlaneStoreError('invalid-state', 'stored source job intent is corrupt') }
  if (!DIGEST.test(row.intent_digest) || controlPlaneDigest(intent) !== row.intent_digest || row.authority_id !== intent.authority.id
    || row.expires_at !== intent.authority.expiresAt || !KEY.test(row.idempotency_key) || !Number.isSafeInteger(row.revision) || row.revision < 1
    || !Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.updated_at) || row.updated_at < row.created_at
    || !['queued', 'running', 'prepared', 'failed', 'unknown'].includes(row.status)
    || (row.definition_hash !== null && !DIGEST.test(row.definition_hash)) || (row.occurrence_id !== null && !KEY.test(row.occurrence_id))
    || (row.plan_id !== null && !/^source-[a-f0-9-]{36}$/u.test(row.plan_id)) || (row.failure_code !== null && !KEY.test(row.failure_code))) {
    throw new ControlPlaneStoreError('invalid-state', 'stored source job is corrupt')
  }
  const active = row.status === 'queued' || row.status === 'running' || row.status === 'unknown'
  if ((row.status === 'queued' && (row.occurrence_id !== null || row.plan_id !== null || row.failure_code !== null))
    || (row.status === 'running' && (row.definition_hash === null || row.occurrence_id === null || row.plan_id !== null || row.failure_code !== null))
    || (row.status === 'prepared' && (row.definition_hash === null || row.occurrence_id === null || row.plan_id === null || row.failure_code !== null))
    || (row.status === 'unknown' && (row.definition_hash === null || row.occurrence_id === null || row.plan_id !== null || row.failure_code === null))
    || (row.status === 'failed' && (row.plan_id !== null || row.failure_code === null))
    || (!active && row.status !== 'prepared' && row.plan_id !== null)) throw new ControlPlaneStoreError('invalid-state', 'stored source job state is corrupt')
  return Object.freeze({ id: row.id, automationId: row.automation_id, idempotencyKey: row.idempotency_key, intent, intentDigest: row.intent_digest,
    status: row.status, revision: row.revision, createdAt: row.created_at, expiresAt: row.expires_at, updatedAt: row.updated_at,
    ...(row.definition_hash === null ? {} : { definitionHash: row.definition_hash }), ...(row.occurrence_id === null ? {} : { occurrenceId: row.occurrence_id }),
    ...(row.plan_id === null ? {} : { planId: row.plan_id }), ...(row.failure_code === null ? {} : { failureCode: row.failure_code }) })
}

function readOwnerTaskFailureReference(database: DatabaseSync, gapId: string): OwnerTaskFailureReference | undefined {
  if (typeof gapId !== 'string' || !KEY.test(gapId)) throw new ControlPlaneStoreError('invalid-input', 'gap id is invalid')
  const row = database.prepare('SELECT reference_json, reference_digest FROM owner_task_failure_gaps WHERE gap_id = ?')
    .get(gapId) as OwnerTaskFailureGapRow | undefined
  const gap = database.prepare('SELECT idempotency_key FROM capability_gaps WHERE id = ?').get(gapId) as { idempotency_key: string } | undefined
  if (row === undefined) {
    if (gap?.idempotency_key.startsWith('owner-task-failure:')) throw new ControlPlaneStoreError('invalid-state', 'owner task failure gap sidecar is missing')
    return undefined
  }
  if (gap?.idempotency_key !== `owner-task-failure:${row.reference_digest}`) throw new ControlPlaneStoreError('invalid-state', 'owner task failure gap identity is corrupt')
  if (!DIGEST.test(row.reference_digest)) throw new ControlPlaneStoreError('invalid-state', 'owner task failure gap digest is corrupt')
  let reference: OwnerTaskFailureReference
  try { reference = ownerTaskFailureReferenceFromStored(JSON.parse(row.reference_json) as unknown, 'invalid-state') }
  catch (error) { if (error instanceof ControlPlaneStoreError) throw error; throw new ControlPlaneStoreError('invalid-state', 'owner task failure gap reference is corrupt') }
  if (controlPlaneDigest(reference) !== row.reference_digest) throw new ControlPlaneStoreError('invalid-state', 'owner task failure gap digest is corrupt')
  return reference
}

/** Read-only broker seam: parse existing authoritative rows without opening a migrating Store. */
export function readOwnerPreparedSourcePlan(database: DatabaseSync, planId: string): {
  plan: PluginSourcePlan; source: OwnerTaskFailureReference
} {
  if (database.prepare('PRAGMA user_version').get()?.user_version !== controlPlaneSchemaVersion
    || typeof planId !== 'string' || !KEY.test(planId)) {
    throw new ControlPlaneStoreError('invalid-state', 'source authorization database or plan identity is invalid')
  }
  const row = database.prepare('SELECT * FROM source_plans WHERE id = ?').get(planId) as unknown as SourceRow | undefined
  if (!row) throw new ControlPlaneStoreError('not-found', 'source authorization plan is absent')
  const plan = sourceFromRow(row)
  const source = readOwnerTaskFailureReference(database, plan.gapId)
  if (!source || plan.mode !== 'modify' || !plan.sourceCheck || !plan.preparedEvidence) {
    throw new ControlPlaneStoreError('invalid-state', 'source authorization requires an owner-bound prepared modification')
  }
  return { plan, source }
}

function readReleaseCandidate(database: DatabaseSync, plan: PluginSourcePlan): CatalogEntry {
  const row = database.prepare(`SELECT * FROM source_release_operations WHERE plan_id = ? AND phase = 'build'
    AND status = 'applied' ORDER BY attempt DESC LIMIT 1`).get(plan.id) as unknown as SourceReleaseOperationRow | undefined
  if (!row) throw new ControlPlaneStoreError('invalid-state', 'source release has no applied build artifact')
  const operation = sourceReleaseOperationFromRow(row), evidence = operation.receipt?.evidence
  if (operation.receipt?.outcome !== 'passed' || evidence?.kind !== 'build' || !plan.releaseAuthorization) throw new ControlPlaneStoreError('invalid-state', 'source release build evidence is not successful')
  const artifact = releaseArtifact(evidence), policy = plan.releaseAuthorization.releasePolicy
  return parseCatalog({ schemaVersion: 1, entries: [{ id: artifact.candidateId, package: artifact.packageName,
    version: artifact.packageVersion, integrity: artifact.tarballIntegrity, dshBaseline: artifact.dshBaseline,
    registry: { id: policy.registryId, locator: policy.registryLocator, reference: policy.registryReference },
    capabilities: artifact.capabilities, authorities: artifact.authorities, requires: artifact.requires }] }).entries[0]!
}

function adoptionBinding(sourcePlan: PluginSourcePlan, source: OwnerTaskFailureReference, plan: PluginActivationPlan) {
  return { sourcePlanId: sourcePlan.id, sourcePlanDigest: sourcePlan.digest, releaseId: sourcePlan.release!.id,
    releaseFence: sourcePlan.release!.fence, activationPlanId: plan.id, activationPlanDigest: plan.digest,
    sourceReferenceDigest: controlPlaneDigest(source), candidateDigest: controlPlaneDigest(plan.candidate) }
}

/** Read-only signer seam; no migration or unbound caller candidate is admitted. */
export function readOwnerSourceAdoptionPlan(database: DatabaseSync, activationPlanId: string): {
  plan: PluginActivationPlan; sourcePlan: PluginSourcePlan; source: OwnerTaskFailureReference; released: CatalogEntry
} {
  if (database.prepare('PRAGMA user_version').get()?.user_version !== controlPlaneSchemaVersion) throw new ControlPlaneStoreError('invalid-state', 'source adoption database version is invalid')
  const link = database.prepare('SELECT * FROM source_adoptions WHERE activation_plan_id = ?').get(activationPlanId) as
    { source_plan_id: string; activation_plan_id: string; binding_json: string; binding_digest: string } | undefined
  const row = database.prepare('SELECT * FROM activation_plans WHERE id = ?').get(activationPlanId) as unknown as ActivationRow | undefined
  if (!link || !row) throw new ControlPlaneStoreError('not-found', 'owner source adoption binding absent')
  const plan = activationFromRow(row), { plan: sourcePlan, source } = readOwnerPreparedSourcePlan(database, link.source_plan_id)
  if (sourcePlan.status !== 'release-complete' || !sourcePlan.release || plan.gapId !== sourcePlan.gapId) throw new ControlPlaneStoreError('invalid-state', 'source adoption requires a completed owner release')
  const expected = adoptionBinding(sourcePlan, source, plan), released = readReleaseCandidate(database, sourcePlan)
  if (controlPlaneDigest(JSON.parse(link.binding_json)) !== link.binding_digest || controlPlaneDigest(expected) !== link.binding_digest
    || controlPlaneDigest(plan.candidate) !== controlPlaneDigest(released)) throw new ControlPlaneStoreError('invalid-state', 'source adoption binding changed')
  return { plan, sourcePlan, source, released }
}

export class ControlPlaneStore {
  readonly #database: DatabaseSync
  readonly #now: () => number
  #ownerTaskFailureGapAdmission: string | undefined
  #foregroundDeploymentAdmission: string | undefined
  readonly #withOwnerActivationFence: ControlPlaneStoreOptions['withOwnerActivationFence']

  constructor(options: ControlPlaneStoreOptions) { this.#database = openControlPlaneDatabase(options.path); this.#now = options.now ?? Date.now; this.#withOwnerActivationFence = options.withOwnerActivationFence }
  close(): void { this.#database.close() }

  recordGap(input: CapabilityGapInput): StoredCapabilityGap {
    const normalized = {
      idempotencyKey: bounded(input.idempotencyKey, 'idempotencyKey', 160), capability: bounded(input.capability, 'capability', 300),
      context: bounded(input.context, 'context', 4_000), expectedValue: finite(input.expectedValue, 'expectedValue', 0, 1_000_000_000),
      frequency: finite(input.frequency, 'frequency', 0.000_001, 1_000_000), estimatedCost: finite(input.estimatedCost, 'estimatedCost', 0.000_001, 1_000_000_000),
      risk: finite(input.risk, 'risk', 0, 1),
    }
    if (!KEY.test(normalized.idempotencyKey)) throw new ControlPlaneStoreError('invalid-input', 'idempotencyKey has invalid syntax')
    if (normalized.idempotencyKey.startsWith('owner-task-failure:')) {
      throw new ControlPlaneStoreError('invalid-input', 'owner task failure gap keys are reserved')
    }
    const inputDigest = controlPlaneDigest(normalized)
    const prior = this.#database.prepare('SELECT * FROM capability_gaps WHERE idempotency_key = ?').get(normalized.idempotencyKey) as unknown as GapRow | undefined
    if (prior !== undefined) {
      if (prior.input_digest !== inputDigest) throw new ControlPlaneStoreError('conflict', 'capability gap idempotency key was reused with different input')
      return gapFromRow(prior)
    }
    const now = this.#now(); const id = `gap-${randomUUID()}`
    const roi = Math.min(1_000_000_000, (normalized.expectedValue * normalized.frequency * (1 - normalized.risk)) / normalized.estimatedCost)
    try {
      this.#database.prepare(`INSERT INTO capability_gaps (id, idempotency_key, input_digest, capability, context,
        expected_value, frequency, estimated_cost, risk, roi, status, candidate_id, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, 1, ?, ?)`).run(id, normalized.idempotencyKey, inputDigest,
        normalized.capability, normalized.context, normalized.expectedValue, normalized.frequency, normalized.estimatedCost, normalized.risk, roi, now, now)
    } catch (error) {
      const raced = this.#database.prepare('SELECT * FROM capability_gaps WHERE idempotency_key = ?').get(normalized.idempotencyKey) as unknown as GapRow | undefined
      if (raced !== undefined && raced.input_digest === inputDigest) return gapFromRow(raced)
      throw error
    }
    return this.getGap(id)
  }

  getGap(id: string): StoredCapabilityGap {
    const row = this.#database.prepare('SELECT * FROM capability_gaps WHERE id = ?').get(id) as unknown as GapRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('not-found', 'capability gap not found')
    return gapFromRow(row)
  }

  listGaps(limit = 20): readonly StoredCapabilityGap[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ControlPlaneStoreError('invalid-input', 'gap limit must be 1..100')
    return (this.#database.prepare(`SELECT gap.* FROM capability_gaps gap
      WHERE gap.status = 'open' AND gap.idempotency_key NOT LIKE 'owner-task-failure:%'
        AND NOT EXISTS (SELECT 1 FROM owner_task_failure_gaps sidecar WHERE sidecar.gap_id = gap.id)
      ORDER BY gap.roi DESC, gap.created_at, gap.id LIMIT ?`).all(limit) as unknown as GapRow[]).map(gapFromRow)
  }

  recordOwnerTaskFailureGap(referenceInput: OwnerTaskFailureReference): StoredCapabilityGap {
    const reference = ownerTaskFailureReferenceFromStored(referenceInput)
    const referenceDigest = controlPlaneDigest(reference)
    const idempotencyKey = `owner-task-failure:${referenceDigest}`
    const normalized = { idempotencyKey, capability: 'foreground-task-repair',
      context: 'Owner-verified foreground task failure. Private source reference retained.',
      expectedValue: 0, frequency: 1, estimatedCost: 1, risk: 1 }
    const inputDigest = controlPlaneDigest(normalized)
    const now = this.#now(); const id = `gap-${randomUUID()}`
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const prior = this.#database.prepare('SELECT * FROM capability_gaps WHERE idempotency_key = ?').get(idempotencyKey) as unknown as GapRow | undefined
      if (prior !== undefined) {
        if (prior.input_digest !== inputDigest) throw new ControlPlaneStoreError('conflict', 'owner task failure gap idempotency is corrupt')
        const stored = this.getOwnerTaskFailureReference(prior.id)
        if (stored === undefined || controlPlaneDigest(stored) !== referenceDigest) {
          throw new ControlPlaneStoreError('invalid-state', 'owner task failure gap sidecar is corrupt')
        }
        this.#database.exec('COMMIT')
        return gapFromRow(prior)
      }
      this.#database.prepare(`INSERT INTO capability_gaps (id, idempotency_key, input_digest, capability, context,
        expected_value, frequency, estimated_cost, risk, roi, status, candidate_id, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, 1, 1, 1, 0, 'open', NULL, 1, ?, ?)`).run(
        id, idempotencyKey, inputDigest, normalized.capability, normalized.context, now, now)
      this.#database.prepare(`INSERT INTO owner_task_failure_gaps (gap_id, reference_json, reference_digest)
        VALUES (?, ?, ?)`).run(id, JSON.stringify(reference), referenceDigest)
      const gap = this.getGap(id)
      this.#database.exec('COMMIT')
      return gap
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  getOwnerTaskFailureReference(gapId: string): OwnerTaskFailureReference | undefined {
    return readOwnerTaskFailureReference(this.#database, gapId)
  }

  withOwnerTaskFailureGapAdmission<T>(gapId: string, callback: () => T): T {
    if (typeof gapId !== 'string' || !KEY.test(gapId) || typeof callback !== 'function') {
      throw new ControlPlaneStoreError('invalid-input', 'owner task failure gap admission is invalid')
    }
    if (callback.constructor.name === 'AsyncFunction') throw new ControlPlaneStoreError('invalid-input', 'owner task failure gap admission must be synchronous')
    if (this.#ownerTaskFailureGapAdmission !== undefined) throw new ControlPlaneStoreError('conflict', 'owner task failure gap admission is already active')
    if (this.getOwnerTaskFailureReference(gapId) === undefined) throw new ControlPlaneStoreError('not-found', 'owner task failure gap is absent')
    this.#ownerTaskFailureGapAdmission = gapId
    try {
      const result = callback()
      if (typeof (result as { then?: unknown } | null)?.then === 'function') {
        throw new ControlPlaneStoreError('invalid-input', 'owner task failure gap admission must be synchronous')
      }
      return result
    } finally { this.#ownerTaskFailureGapAdmission = undefined }
  }

  #assertOwnerTaskFailureGapAdmission(gapId: string): void {
    if (this.getOwnerTaskFailureReference(gapId) !== undefined && this.#ownerTaskFailureGapAdmission !== gapId) {
      throw new ControlPlaneStoreError('invalid-state', 'owner task failure gap requires Host admission')
    }
  }

  #withActivationSource<T>(planId: string, callback: () => T, recovery = false): T {
    const plan = this.getPlan(planId)
    if (!this.getOwnerTaskFailureReference(plan.gapId) || recovery || plan.status === 'rollback-pending' || plan.status === 'rolled-back') return callback()
    if (this.#ownerTaskFailureGapAdmission === plan.gapId) return callback()
    if (!this.#withOwnerActivationFence) throw new ControlPlaneStoreError('invalid-state', 'owner activation requires current Host source admission')
    return this.#withOwnerActivationFence(plan.gapId, () => this.withOwnerTaskFailureGapAdmission(plan.gapId, callback))
  }

  /** Only the Host worker connection can advance a task-bound deployment. */
  assertOwnerActivationSource(planId: string): void { this.#withActivationSource(planId, () => {}) }

  createPlan(input: CreateActivationPlanInput): OperationReceipt<PluginActivationPlan> {
    const profile = bounded(input.profile, 'profile', 64); const idempotencyKey = bounded(input.idempotencyKey, 'idempotencyKey', 160)
    if (!PROFILE.test(profile) || !KEY.test(idempotencyKey) || !UUID.test(input.installationId) || !UUID.test(input.ledger.id)
      || !DIGEST.test(input.catalog.digest) || !DIGEST.test(input.executor.sha256)
      || !isAbsolute(input.ledger.path) || !isAbsolute(input.executor.path)) throw new ControlPlaneStoreError('invalid-input', 'activation plan binding is invalid')
    positiveInteger(input.ttlMs, 'ttlMs'); if (input.ttlMs < 60_000 || input.ttlMs > 86_400_000) throw new ControlPlaneStoreError('invalid-input', 'ttlMs is invalid')
    const candidate = parseCatalog({ schemaVersion: 1, entries: [input.candidate] }).entries[0]!
    const matchedCapabilities = [...new Set(input.matchedCapabilities.map(value => bounded(value, 'matched capability', 300)))].sort()
    if (matchedCapabilities.length === 0) throw new ControlPlaneStoreError('invalid-input', 'candidate must match the bound capability gap')
    const packages = Object.freeze([{ package: candidate.package, version: candidate.version, integrity: candidate.integrity,
      ...(candidate.registry === undefined ? {} : { registry: candidate.registry }) }, ...candidate.requires])
    const requestBinding = { operation: 'create-activation-plan', gapId: input.gapId, candidate, catalog: input.catalog,
      matchedCapabilities, profile, target: input.target, installationId: input.installationId,
      ledger: input.ledger, executor: input.executor, ttlMs: input.ttlMs,
      ...(input.sourcePlanId === undefined ? {} : { sourcePlanId: input.sourcePlanId }) }
    this.#assertOwnerTaskFailureGapAdmission(input.gapId)
    const source = input.sourcePlanId === undefined ? undefined : readOwnerPreparedSourcePlan(this.#database, input.sourcePlanId)
    if (source && (source.plan.status !== 'release-complete' || source.plan.gapId !== input.gapId
      || controlPlaneDigest(readReleaseCandidate(this.#database, source.plan)) !== controlPlaneDigest(candidate))) {
      throw new ControlPlaneStoreError('conflict', 'activation does not match the exact owner release')
    }
    const inputDigest = controlPlaneDigest(requestBinding)
    const prior = this.#activationPlanReceiptByKey(idempotencyKey, 'create-activation-plan', inputDigest)
    if (prior !== undefined) {
      if (source) readOwnerSourceAdoptionPlan(this.#database, prior.result.id)
      return prior
    }
    const gap = this.getGap(input.gapId)
    if (gap.status !== 'open') throw new ControlPlaneStoreError('invalid-state', 'only an open gap can create an activation plan')
    if (gap.candidateId !== undefined && gap.candidateId !== candidate.id) {
      throw new ControlPlaneStoreError('conflict', 'released capability gap is reserved for its exact admitted candidate')
    }
    if ((!source && !discover({ schemaVersion: 1, entries: [candidate] }, gap.capability).some(item => item.id === candidate.id))
      || matchedCapabilities.some(value => !candidate.capabilities.includes(value))) {
      throw new ControlPlaneStoreError('invalid-input', 'candidate dossier does not match the exact gap capability')
    }
    const gapSnapshot = Object.freeze({ revision: gap.revision, inputDigest: gap.inputDigest, roi: gap.roi, capability: gap.capability })
    const dossier = Object.freeze({ catalogDigest: input.catalog.digest, catalogProvenance: input.catalog.provenance,
      matchedCapabilities: Object.freeze(matchedCapabilities), authorities: Object.freeze([...candidate.authorities]), packages })
    const now = this.#now(); const id = `plugin-${randomUUID()}`; const expiresAt = now + input.ttlMs
    const immutable = { schemaVersion: 4 as const, kind: 'activation' as const, id, gapId: gap.id, gapSnapshot,
      profile, candidate, dossier, installationId: input.installationId, ledger: input.ledger,
      target: input.target, executor: input.executor,
      createdAt: now, expiresAt }
    const planDigest = controlPlaneDigest(immutable)
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const raced = this.#activationPlanReceiptByKey(idempotencyKey, 'create-activation-plan', inputDigest)
      if (raced !== undefined) { this.#database.exec('COMMIT'); return raced }
      const currentGap = this.getGap(gap.id)
      if (currentGap.revision !== gap.revision || currentGap.inputDigest !== gap.inputDigest || currentGap.roi !== gap.roi
        || currentGap.status !== 'open' || currentGap.candidateId !== gap.candidateId) {
        throw new ControlPlaneStoreError('conflict', 'capability gap changed before plan creation')
      }
      this.#database.prepare('INSERT INTO gap_plan_claims (gap_id, plan_id, plan_kind, claimed_at) VALUES (?, ?, ?, ?)').run(gap.id, id, 'activation', now)
      this.#database.prepare(`INSERT INTO activation_plans (id, plan_digest, gap_id, gap_snapshot_json, profile, candidate_json,
        dossier_json, installation_id, ledger_id, ledger_path, dsh_home, target_path, executor_id, executor_version,
        executor_path, executor_digest, status, revision, created_at,
        expires_at, approval_json, activation_id, activation_fence, activation_lease_until, activation_target_existed, failure_code, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending-approval', 1, ?, ?, NULL, NULL, 0, NULL, NULL, NULL, ?)`).run(
        id, planDigest, gap.id, JSON.stringify(gapSnapshot), profile, JSON.stringify(candidate), JSON.stringify(dossier), input.installationId,
        input.ledger.id, input.ledger.path, input.target.dshHome, input.target.profilePath, input.executor.id,
        input.executor.version, input.executor.path, input.executor.sha256, now, expiresAt, now)
      this.#database.prepare(`UPDATE capability_gaps SET status = 'matched', candidate_id = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`).run(candidate.id, now, gap.id, gap.revision)
      const plan = this.getPlan(id)
      if (source) {
        const binding = adoptionBinding(source.plan, source.source, plan)
        this.#database.prepare('INSERT INTO source_adoptions (source_plan_id, activation_plan_id, binding_json, binding_digest, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(source.plan.id, plan.id, JSON.stringify(binding), controlPlaneDigest(binding), now)
      }
      const receipt = { idempotencyKey, operation: 'create-activation-plan', inputDigest, result: plan, createdAt: now }
      this.#insertReceipt(receipt); this.#database.exec('COMMIT'); return receipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  getPlan(id: string): PluginActivationPlan {
    const row = this.#database.prepare('SELECT * FROM activation_plans WHERE id = ?').get(id) as unknown as ActivationRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('not-found', 'activation plan not found')
    return activationFromRow(row)
  }

  findSourceAdoption(sourcePlanId: string): PluginActivationPlan | undefined {
    const row = this.#database.prepare('SELECT activation_plan_id FROM source_adoptions WHERE source_plan_id = ?').get(sourcePlanId) as { activation_plan_id: string } | undefined
    return row === undefined ? undefined : readOwnerSourceAdoptionPlan(this.#database, row.activation_plan_id).plan
  }

  enqueueSourceJob(input: { id: string; automationId: string; idempotencyKey: string; intent: SourceJobIntent }): SourceJobRecord {
    if (!/^source-job-[a-f0-9]{64}$/u.test(input.id) || input.automationId !== input.id) {
      throw new ControlPlaneStoreError('invalid-input', 'source job identity is invalid')
    }
    const idempotencyKey = bounded(input.idempotencyKey, 'idempotencyKey', 160)
    if (!KEY.test(idempotencyKey)) throw new ControlPlaneStoreError('invalid-input', 'source job idempotencyKey has invalid syntax')
    const intent = sourceJobIntentFromStored(input.intent); const intentDigest = controlPlaneDigest(intent); const now = this.#now()
    this.#assertOwnerTaskFailureGapAdmission(intent.gapId)
    if (intent.containerName !== `dsh-${input.id}` || basename(intent.worktree) !== `worktree-job-${input.id.slice('source-job-'.length)}`) {
      throw new ControlPlaneStoreError('invalid-input', 'source job resource identity is invalid')
    }
    if (now >= intent.authority.expiresAt) throw new ControlPlaneStoreError('expired', 'source job authority is expired')
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const prior = this.#database.prepare('SELECT * FROM source_jobs WHERE authority_id = ? AND idempotency_key = ?')
        .get(intent.authority.id, idempotencyKey) as unknown as SourceJobRow | undefined
      if (prior !== undefined) {
        const record = sourceJobFromRow(prior)
        if (record.intentDigest !== intentDigest || record.id !== input.id || record.automationId !== input.automationId) {
          throw new ControlPlaneStoreError('conflict', 'source job idempotency key was reused with different input')
        }
        this.#database.exec('COMMIT'); return record
      }
      const authority = this.#database.prepare('SELECT * FROM source_job_authorities WHERE authority_id = ?').get(intent.authority.id) as {
        authority_digest: string; expires_at: number; max_submissions: number; submissions: number
      } | undefined
      if (authority !== undefined && (authority.authority_digest !== intent.authority.digest || authority.expires_at !== intent.authority.expiresAt
        || authority.max_submissions !== intent.authority.maxSubmissions)) {
        throw new ControlPlaneStoreError('conflict', 'source job authority configuration is immutable')
      }
      if (authority !== undefined && authority.submissions >= authority.max_submissions) throw new ControlPlaneStoreError('invalid-state', 'source job authority submission quota is exhausted')
      if (authority === undefined) {
        this.#database.prepare(`INSERT INTO source_job_authorities (authority_id, authority_digest, expires_at, max_submissions, submissions)
          VALUES (?, ?, ?, ?, 0)`).run(intent.authority.id, intent.authority.digest, intent.authority.expiresAt, intent.authority.maxSubmissions)
      }
      this.#database.prepare('UPDATE source_job_authorities SET submissions = submissions + 1 WHERE authority_id = ? AND submissions < max_submissions')
        .run(intent.authority.id)
      this.#database.prepare(`INSERT INTO source_jobs (id, automation_id, authority_id, idempotency_key, intent_json, intent_digest,
        status, revision, created_at, expires_at, definition_hash, occurrence_id, plan_id, failure_code, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, NULL, NULL, NULL, NULL, ?)`).run(input.id, input.automationId, intent.authority.id,
        idempotencyKey, JSON.stringify(intent), intentDigest, now, intent.authority.expiresAt, now)
      const record = this.getSourceJob(input.id)
      if (record === undefined) throw new ControlPlaneStoreError('invalid-state', 'inserted source job could not be read')
      this.#database.exec('COMMIT'); return record
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  getSourceJob(id: string): SourceJobRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM source_jobs WHERE id = ?').get(id) as unknown as SourceJobRow | undefined
    return row === undefined ? undefined : sourceJobFromRow(row)
  }

  getSourceJobByAutomation(automationId: string): SourceJobRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM source_jobs WHERE automation_id = ?').get(automationId) as unknown as SourceJobRow | undefined
    return row === undefined ? undefined : sourceJobFromRow(row)
  }

  /** Outstanding jobs sort first so restart reconciliation cannot be hidden by history. */
  listSourceJobs(limit = 100): readonly SourceJobRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ControlPlaneStoreError('invalid-input', 'source job limit must be 1..100')
    return (this.#database.prepare(`SELECT * FROM source_jobs ORDER BY CASE WHEN status IN ('queued', 'running', 'unknown') THEN 0 ELSE 1 END,
      created_at DESC, id DESC LIMIT ?`).all(limit) as unknown as SourceJobRow[]).map(sourceJobFromRow)
  }

  /** Prepared owner continuations have a bounded recovery query, independent of job history. */
  listPreparedSourceApprovalJobs(includeRelease = false, includeExecution = false, includeAdoption = false): readonly SourceJobRecord[] {
    return (this.#database.prepare(`SELECT j.* FROM source_jobs j JOIN source_plans p ON p.id = j.plan_id
      JOIN owner_task_failure_gaps g ON g.gap_id = p.gap_id
      LEFT JOIN source_adoptions a ON a.source_plan_id = p.id
      LEFT JOIN activation_plans ap ON ap.id = a.activation_plan_id
      WHERE j.status = 'prepared' AND (p.status = 'pending-approval' OR (? = 1 AND p.status IN ('approved', 'ready-for-human-review'))
        OR (? = 1 AND p.status IN ('awaiting-pr', 'awaiting-review', 'awaiting-merge', 'awaiting-build', 'awaiting-sign', 'awaiting-publish',
          'awaiting-registry-verify', 'awaiting-catalog-admission'))
        OR (? = 1 AND p.status = 'release-complete' AND (ap.id IS NULL OR ap.status NOT IN ('activated', 'rolled-back', 'rejected')))) AND (p.expires_at > ? OR ap.status IN ('staging', 'awaiting-reload', 'awaiting-readiness', 'awaiting-effect-blocked-replay', 'awaiting-shadow', 'awaiting-canary', 'awaiting-soak', 'awaiting-health', 'commit-pending', 'rollback-pending'))
      ORDER BY j.created_at, j.id LIMIT 1000`).all(includeRelease ? 1 : 0, includeExecution ? 1 : 0, includeAdoption ? 1 : 0, this.#now()) as unknown as SourceJobRow[]).map(sourceJobFromRow)
  }

  bindSourceJobDefinition(input: { id: string; revision: number; definitionHash: string }): SourceJobRecord {
    if (!Number.isSafeInteger(input.revision) || input.revision < 1 || !DIGEST.test(input.definitionHash)) throw new ControlPlaneStoreError('invalid-input', 'source job definition binding is invalid')
    const now = this.#now(); const result = this.#database.prepare(`UPDATE source_jobs SET definition_hash = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND status = 'queued' AND definition_hash IS NULL AND expires_at > ?`).run(input.definitionHash, now, input.id, input.revision, now)
    if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source job definition binding lost its queued CAS')
    return this.getSourceJob(input.id)!
  }

  claimSourceJob(input: { id: string; revision: number; definitionHash: string; occurrenceId: string }): SourceJobRecord {
    if (!Number.isSafeInteger(input.revision) || input.revision < 1 || !DIGEST.test(input.definitionHash) || !KEY.test(input.occurrenceId)) {
      throw new ControlPlaneStoreError('invalid-input', 'source job claim is invalid')
    }
    const now = this.#now(); const result = this.#database.prepare(`UPDATE source_jobs SET status = 'running', occurrence_id = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND status = 'queued' AND definition_hash = ? AND occurrence_id IS NULL AND expires_at > ?`).run(input.occurrenceId, now, input.id, input.revision, input.definitionHash, now)
    if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source job claim lost its queued CAS')
    return this.getSourceJob(input.id)!
  }

  settleSourceJob(input: { id: string; revision: number; status: 'failed' | 'unknown'; failureCode: string }): SourceJobRecord {
    if (!Number.isSafeInteger(input.revision) || input.revision < 1 || (input.status !== 'failed' && input.status !== 'unknown') || !KEY.test(input.failureCode)) throw new ControlPlaneStoreError('invalid-input', 'source job settlement is invalid')
    const permitted = input.status === 'unknown' ? "status = 'running'" : "status IN ('queued', 'running', 'unknown')"
    const now = this.#now(); const result = this.#database.prepare(`UPDATE source_jobs SET status = ?, failure_code = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND ${permitted}`).run(input.status, input.failureCode, now, input.id, input.revision)
    if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source job settlement lost its state CAS')
    return this.getSourceJob(input.id)!
  }

  interruptSourceJobs(): number {
    const now = this.#now(); const result = this.#database.prepare(`UPDATE source_jobs SET status = 'unknown', failure_code = 'interrupted',
      revision = revision + 1, updated_at = ? WHERE status = 'running'`).run(now)
    return Number(result.changes)
  }

  createSourcePlan(input: CreateSourcePlanInput): OperationReceipt<PluginSourcePlan> {
    const mode = input.mode ?? 'create'
    if (input.sourceJob !== undefined && mode !== 'modify') throw new ControlPlaneStoreError('invalid-input', 'source jobs only complete checked modify plans')
    const key = bounded(input.idempotencyKey, 'idempotencyKey', 160); const name = bounded(input.name, 'name', 64)
    if (!KEY.test(key) || !PLUGIN_NAME.test(name) || !COMMIT.test(input.baseCommit) || !DIGEST.test(input.generatorDigest)
      || input.scope.length === 0 || input.scope.length > 32) throw new ControlPlaneStoreError('invalid-input', 'source plan binding is invalid')
    if (mode === 'modify' && input.generatorDigest !== MODIFY_GENERATOR_DIGEST) {
      throw new ControlPlaneStoreError('invalid-input', 'modify source plans must bind the modify generator constant')
    }
    let preparedEvidence: SourcePreparedEvidence | undefined
    if (mode === 'modify') {
      if (input.prepared === undefined) {
        throw new ControlPlaneStoreError('invalid-input', 'modify source plan requires prepared check evidence')
      }
      if (!DIGEST.test(input.prepared.treeDigest) || !DIGEST.test(input.prepared.patchDigest)
        || !Number.isSafeInteger(input.prepared.checkedAt) || input.prepared.checkedAt < 0) {
        throw new ControlPlaneStoreError('invalid-input', 'modify source plan prepared digests are invalid')
      }
      preparedEvidence = preparedEvidenceFromStored(input.prepared.evidence)
    } else if (input.prepared !== undefined) {
      throw new ControlPlaneStoreError('invalid-input', 'create source plans cannot carry prepared evidence')
    }
    positiveInteger(input.ttlMs, 'ttlMs'); if (input.ttlMs < 60_000 || input.ttlMs > 86_400_000) throw new ControlPlaneStoreError('invalid-input', 'ttlMs is invalid')
    const scope = Object.freeze([...new Set(input.scope.map(value => bounded(value, 'scope', 500)))].sort())
    if (controlPlaneDigest(scope) !== controlPlaneDigest(expectedSourceScope(name, mode))) {
      throw new ControlPlaneStoreError('invalid-input', 'source plan scope must bind exactly the paths allowed for its mode')
    }
    if (input.sourceJob !== undefined && (!Number.isSafeInteger(input.sourceJob.jobRevision) || input.sourceJob.jobRevision < 1
      || !KEY.test(input.sourceJob.jobId) || !KEY.test(input.sourceJob.occurrenceId))) {
      throw new ControlPlaneStoreError('invalid-input', 'source job completion is invalid')
    }
    const requestBinding = { operation: 'create-source-plan', gapId: input.gapId, repository: input.repository,
      worktree: input.worktree, baseCommit: input.baseCommit, name, generatorDigest: input.generatorDigest, scope, ttlMs: input.ttlMs }
    this.#assertOwnerTaskFailureGapAdmission(input.gapId)
    const sourceJobBinding = input.sourceJob === undefined ? undefined : { jobId: input.sourceJob.jobId, jobRevision: input.sourceJob.jobRevision,
      occurrenceId: input.sourceJob.occurrenceId }
    const inputDigest = controlPlaneDigest({ ...(mode === 'modify' ? { ...requestBinding, mode, prepared: input.prepared } : requestBinding),
      ...(sourceJobBinding === undefined ? {} : { sourceJob: sourceJobBinding }) })
    const prior = this.#sourcePlanReceiptByKey(key, 'create-source-plan', inputDigest)
    if (prior !== undefined) return prior
    const gap = this.getGap(input.gapId); if (gap.status !== 'open' || gap.candidateId !== undefined) {
      throw new ControlPlaneStoreError('invalid-state', 'only an unreserved open gap can create a source plan')
    }
    const gapSnapshot = Object.freeze({ revision: gap.revision, inputDigest: gap.inputDigest, roi: gap.roi, capability: gap.capability })
    const now = this.#now(); const id = `source-${randomUUID()}`; const expiresAt = now + input.ttlMs
    const immutable = { schemaVersion: 1 as const, kind: 'source' as const, id, gapId: gap.id, gapSnapshot,
      repository: input.repository, worktree: input.worktree, baseCommit: input.baseCommit, name,
      generatorDigest: input.generatorDigest, scope, createdAt: now, expiresAt }
    const digest = controlPlaneDigest(mode === 'modify'
      ? { ...immutable, mode, sourceCheck: { treeDigest: input.prepared!.treeDigest, patchDigest: input.prepared!.patchDigest,
        checkedAt: input.prepared!.checkedAt }, preparedEvidence }
      : immutable)
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const currentGap = this.getGap(gap.id)
      if (currentGap.revision !== gap.revision || currentGap.inputDigest !== gap.inputDigest || currentGap.status !== 'open'
        || currentGap.candidateId !== undefined) throw new ControlPlaneStoreError('conflict', 'capability gap changed before source plan creation')
      let sourceJob: SourceJobRecord | undefined
      if (sourceJobBinding !== undefined) {
        sourceJob = this.getSourceJob(sourceJobBinding.jobId)
        if (sourceJob === undefined || sourceJob.status !== 'running' || sourceJob.revision !== sourceJobBinding.jobRevision
          || sourceJob.occurrenceId !== sourceJobBinding.occurrenceId || sourceJob.intent.gapId !== gap.id
          || sourceJob.intent.gapRevision !== currentGap.revision || sourceJob.intent.gapDigest !== controlPlaneDigest(currentGap)
          || sourceJob.intent.baseCommit !== input.baseCommit || sourceJob.intent.name !== name
          || sourceJob.intent.repository !== input.repository || sourceJob.intent.worktree !== input.worktree || sourceJob.intent.ttlMs !== input.ttlMs) {
          throw new ControlPlaneStoreError('conflict', 'source job completion lost its immutable running binding')
        }
        if (now >= sourceJob.expiresAt) throw new ControlPlaneStoreError('expired', 'source job authority is expired')
      }
      this.#database.prepare('INSERT INTO gap_plan_claims (gap_id, plan_id, plan_kind, claimed_at) VALUES (?, ?, ?, ?)').run(gap.id, id, 'source', now)
      // 'modify' rows carry their checked digests and frozen-build evidence from
      // creation; 'create' rows leave all four columns NULL until the
      // post-approval scaffold run finishes.
      this.#database.prepare(`INSERT INTO source_plans (id, plan_digest, gap_id, gap_snapshot_json, repository, worktree,
        base_commit, plugin_name, generator_digest, scope_json, mode, status, revision, created_at, expires_at,
        approval_json, checked_tree_digest, checked_patch_digest, checked_at, prepared_evidence_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending-approval', 1, ?, ?, NULL, ?, ?, ?, ?, ?)`).run(
        id, digest, gap.id, JSON.stringify(gapSnapshot), input.repository, input.worktree, input.baseCommit, name,
        input.generatorDigest, JSON.stringify(scope), mode, now, expiresAt,
        input.prepared?.treeDigest ?? null, input.prepared?.patchDigest ?? null, input.prepared?.checkedAt ?? null,
        preparedEvidence === undefined ? null : JSON.stringify(preparedEvidence), now)
      const matched = this.#database.prepare(`UPDATE capability_gaps SET status = 'matched', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`).run(now, gap.id, gap.revision)
      if (Number(matched.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'capability gap changed while source plan was created')
      if (sourceJob !== undefined) {
        const occurrenceId = sourceJob.occurrenceId
        if (occurrenceId === undefined) throw new ControlPlaneStoreError('invalid-state', 'running source job has no occurrence')
        const prepared = this.#database.prepare(`UPDATE source_jobs SET status = 'prepared', plan_id = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'running' AND revision = ? AND occurrence_id = ?`).run(id, now, sourceJob.id, sourceJob.revision, occurrenceId)
        if (Number(prepared.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source job completion lost its prepared CAS')
      }
      const plan = this.getSourcePlan(id); const receipt = { idempotencyKey: key, operation: 'create-source-plan', inputDigest, result: plan, createdAt: now }
      this.#insertReceipt(receipt); this.#database.exec('COMMIT'); return receipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  getSourcePlan(id: string): PluginSourcePlan {
    const row = this.#database.prepare('SELECT * FROM source_plans WHERE id = ?').get(id) as unknown as SourceRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('not-found', 'source plan not found')
    return sourceFromRow(row)
  }

  /**
   * Enumerate 'modify' plans for isolated-worktree garbage collection. Only
   * modify plans own control-plane-created worktrees under the state root;
   * create plans bind externally prepared worktrees and must never be removed
   * by the control plane.
   */
  listModifySourcePlans(filter?: { expiredBefore?: number }): readonly PluginSourcePlan[] {
    const rows = filter?.expiredBefore === undefined
      ? (this.#database.prepare(`SELECT * FROM source_plans WHERE mode = 'modify' ORDER BY created_at, id`).all() as unknown as SourceRow[])
      : (this.#database.prepare(`SELECT * FROM source_plans WHERE mode = 'modify' AND expires_at < ? ORDER BY created_at, id`)
        .all(filter.expiredBefore) as unknown as SourceRow[])
    return rows.map(sourceFromRow)
  }

  /** Retire an expired prepared plan before removing its worktree. The CAS
   * fences owner approval/review, and releases only this plan's gap claim. */
  expirePreparedSourcePlan(input: { planId: string; expectedRevision: number; now: number }): PluginSourcePlan {
    if (!Number.isSafeInteger(input.now) || input.now < 0) throw new ControlPlaneStoreError('invalid-input', 'expiry time is invalid')
    const plan = this.getSourcePlan(input.planId)
    if (plan.mode !== 'modify') throw new ControlPlaneStoreError('invalid-state', 'only prepared modify plans may expire here')
    const expiryDigest = controlPlaneDigest({ planId: plan.id, planDigest: plan.digest, expiresAt: plan.expiresAt })
    if (plan.status === 'expired') {
      const receipt = this.#sourcePlanReceipt(`source-expired:${plan.id}`, 'source-expired', expiryDigest, plan.id)
      if (receipt?.result.status !== 'expired') throw new ControlPlaneStoreError('invalid-state', 'expired source receipt is missing')
      return receipt.result
    }
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const retired = this.#database.prepare(`UPDATE source_plans SET status = 'expired', revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND mode = 'modify' AND status IN ('pending-approval', 'approved') AND expires_at < ?`)
        .run(input.now, plan.id, input.expectedRevision, input.now)
      if (Number(retired.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'prepared plan changed or is not expired')
      const released = this.#database.prepare(`DELETE FROM gap_plan_claims WHERE gap_id = ? AND plan_id = ? AND plan_kind = 'source'`)
        .run(plan.gapId, plan.id)
      if (Number(released.changes) === 1) {
        this.#database.prepare(`UPDATE capability_gaps SET status = 'open', candidate_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ?`)
          .run(input.now, plan.gapId)
      }
      const result = this.getSourcePlan(plan.id)
      this.#insertReceipt({ idempotencyKey: `source-expired:${plan.id}`, operation: 'source-expired',
        inputDigest: expiryDigest, result, createdAt: input.now })
      this.#database.exec('COMMIT')
      return result
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  async approve(input: { withSourceFence?: <T>(callback: () => T) => T; planId: string; expectedRevision: number; receipt: ApprovalReceipt; resolveAuthority: (receipt: ApprovalReceipt) => ApprovalAuthority; idempotencyKey: string }): Promise<OperationReceipt<PluginActivationPlan>> {
    return this.#approvePlan('activation', input) as Promise<OperationReceipt<PluginActivationPlan>>
  }

  async approveSource(input: { withSourceFence?: <T>(callback: () => T) => T; planId: string; expectedRevision: number; receipt: ApprovalReceipt; resolveAuthority: (receipt: ApprovalReceipt) => ApprovalAuthority; idempotencyKey: string }): Promise<OperationReceipt<PluginSourcePlan>> {
    return this.#approvePlan('source', input) as Promise<OperationReceipt<PluginSourcePlan>>
  }

  async #approvePlan(kind: 'activation' | 'source', input: { withSourceFence?: <T>(callback: () => T) => T; planId: string; expectedRevision: number; receipt: ApprovalReceipt; resolveAuthority: (receipt: ApprovalReceipt) => ApprovalAuthority; idempotencyKey: string }): Promise<OperationReceipt<PluginActivationPlan | PluginSourcePlan>> {
    const inputDigest = controlPlaneDigest({ operation: 'approve-plan', kind, planId: input.planId, expectedRevision: input.expectedRevision, receipt: input.receipt })
    const withCurrentSource = <T>(gapId: string, callback: () => T): T => {
      const commit = () => { this.#assertOwnerTaskFailureGapAdmission(gapId); return callback() }
      return input.withSourceFence ? input.withSourceFence(commit)
        : kind === 'activation' ? this.#withActivationSource(input.planId, callback) : commit()
    }
    if (kind === 'source') {
      const prior = this.#sourcePlanReceipt(input.idempotencyKey, 'approve-plan', inputDigest, input.planId)
      if (prior !== undefined) {
        const expectedPrepared = prior.result.mode === 'modify'
        if (prior.result.status !== 'approved' || prior.result.revision !== input.expectedRevision + 1
          || controlPlaneDigest(prior.result.approval) !== controlPlaneDigest(projectedApproval(input.receipt))
          || (expectedPrepared
            ? (prior.result.sourceCheck === undefined || prior.result.preparedEvidence === undefined)
            : (prior.result.sourceCheck !== undefined || prior.result.preparedEvidence !== undefined))
          || prior.result.releaseAuthorization !== undefined || prior.result.release !== undefined) {
          throw new ControlPlaneStoreError('invalid-state', 'stored source approval receipt is corrupt')
        }
        return withCurrentSource(prior.result.gapId, () => prior)
      }
    } else {
      const prior = this.#activationPlanReceipt(input.idempotencyKey, 'approve-plan', inputDigest, input.planId)
      if (prior !== undefined) {
        if (prior.result.status !== 'approved' || prior.result.revision !== input.expectedRevision + 1
          || controlPlaneDigest(prior.result.approval) !== controlPlaneDigest(projectedApproval(input.receipt))
          || prior.result.activation !== undefined) throw new ControlPlaneStoreError('invalid-state', 'stored activation approval receipt is corrupt')
        return withCurrentSource(prior.result.gapId, () => prior)
      }
    }
    const plan = kind === 'activation' ? this.getPlan(input.planId) : this.getSourcePlan(input.planId)
    const verified = await input.resolveAuthority(input.receipt).verify(input.receipt, plan)
    return withCurrentSource(plan.gapId, () => {
      if (plan.revision !== input.expectedRevision) throw new ControlPlaneStoreError('conflict', 'plan revision conflict')
      if (plan.status !== 'pending-approval') throw new ControlPlaneStoreError('invalid-state', 'plan is not pending approval')
      if (this.#now() > plan.expiresAt || this.#now() > verified.expiresAt || verified.decision !== 'approved') throw new ControlPlaneStoreError(verified.decision === 'approved' ? 'expired' : 'invalid-state', 'plan approval is not currently applicable')
      const table = kind === 'activation' ? 'activation_plans' : 'source_plans'; const now = this.#now()
      this.#database.exec('BEGIN IMMEDIATE')
      try {
        const statement = this.#database.prepare(`UPDATE ${table} SET status = 'approved', revision = revision + 1, approval_json = ?,
          ${kind === 'activation' ? 'approval_receipt_json = ?,' : ''} updated_at = ?
          WHERE id = ? AND status = 'pending-approval' AND revision = ? AND plan_digest = ?`)
        const result = kind === 'activation'
          ? statement.run(JSON.stringify(verified), JSON.stringify(input.receipt), now, plan.id, input.expectedRevision, plan.digest)
          : statement.run(JSON.stringify(verified), now, plan.id, input.expectedRevision, plan.digest)
        if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'plan changed while approval was being applied')
        const output = kind === 'activation' ? this.getPlan(plan.id) : this.getSourcePlan(plan.id)
        const receipt = { idempotencyKey: input.idempotencyKey, operation: 'approve-plan', inputDigest, result: output, createdAt: now }
        this.#insertReceipt(receipt); this.#database.exec('COMMIT'); return receipt
      } catch (error) { this.#database.exec('ROLLBACK'); throw error }
    })
  }

  async claimActivation(input: { planId: string; expectedRevision: number; leaseMs: number;
    resolveApprovalAuthority: (receipt: ApprovalReceipt) => ApprovalAuthority }): Promise<PluginActivationPlan> {
    const now = this.#now(); positiveInteger(input.leaseMs, 'leaseMs')
    if (input.leaseMs < 5_000 || input.leaseMs > 300_000) throw new ControlPlaneStoreError('invalid-input', 'leaseMs is invalid')
    this.assertOwnerActivationSource(input.planId)
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#database.prepare('SELECT * FROM activation_plans WHERE id = ?').get(input.planId) as unknown as ActivationRow | undefined
      if (row === undefined) throw new ControlPlaneStoreError('not-found', 'activation plan not found')
      const plan = activationFromRow(row); if (plan.revision !== input.expectedRevision) throw new ControlPlaneStoreError('conflict', 'activation plan revision conflict')
      if (row.approval_receipt_json === null || plan.approval === undefined) {
        throw new ControlPlaneStoreError('invalid-state', 'activation approval signature is unavailable')
      }
      let approvalReceipt: ApprovalReceipt
      try { approvalReceipt = parseApprovalReceipt(JSON.parse(row.approval_receipt_json) as unknown) }
      catch { throw new ControlPlaneStoreError('invalid-state', 'stored activation approval receipt is corrupt') }
      const verifiedApproval = await input.resolveApprovalAuthority(approvalReceipt).verify(approvalReceipt, plan)
      if (controlPlaneDigest(verifiedApproval) !== controlPlaneDigest(plan.approval)) {
        throw new ControlPlaneStoreError('conflict', 'activation approval changed during claim verification')
      }
      return this.#withActivationSource(input.planId, () => {
      const recoverable = plan.status === 'staging' || plan.status === 'rollback-pending' || plan.status === 'commit-pending'
      if (plan.status === 'approved') {
        if (now > plan.expiresAt) throw new ControlPlaneStoreError('expired', 'activation plan expired before its first claim')
        const targetOwner = this.#database.prepare(`SELECT id FROM activation_plans WHERE target_path = ? AND id <> ? AND status IN (
          'staging', 'awaiting-reload', 'awaiting-readiness', 'awaiting-effect-blocked-replay', 'awaiting-shadow',
          'awaiting-canary', 'awaiting-soak', 'awaiting-health', 'commit-pending', 'rollback-pending') LIMIT 1`).get(plan.target.profilePath, plan.id)
        if (targetOwner !== undefined) throw new ControlPlaneStoreError('conflict', 'target profile already has an active activation')
      } else if (plan.status === 'rollback-pending' && plan.activation?.rollbackProfileRestored) {
        throw new ControlPlaneStoreError('invalid-state', 'physical Host rollback recovery is pending')
      } else if (!(recoverable && Number(row.activation_lease_until ?? 0) < now)) throw new ControlPlaneStoreError('invalid-state', 'activation plan cannot be claimed')
      const activationId = row.activation_id ?? `activation-${randomUUID()}`; const status = plan.status === 'approved' ? 'staging' : plan.status
      const result = this.#database.prepare(`UPDATE activation_plans SET status = ?, revision = revision + 1, activation_id = ?,
        activation_fence = activation_fence + 1, activation_lease_until = ?, updated_at = ? WHERE id = ? AND revision = ?`).run(
        status, activationId, now + input.leaseMs, now, plan.id, input.expectedRevision)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'activation plan changed while being claimed')
      const claimed = this.getPlan(plan.id); this.#database.exec('COMMIT'); return claimed
      })
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  heartbeatActivation(input: { planId: string; expectedRevision: number; fence: number; leaseMs: number }): PluginActivationPlan {
    return this.#withActivationSource(input.planId, () => {
      const now = this.#now(); positiveInteger(input.leaseMs, 'leaseMs')
      const result = this.#database.prepare(`UPDATE activation_plans SET activation_lease_until = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND activation_fence = ? AND status IN ('staging', 'rollback-pending', 'commit-pending') AND activation_lease_until >= ?`).run(
        now + input.leaseMs, now, input.planId, input.expectedRevision, input.fence, now)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'activation heartbeat lost its revision/fence/lease')
      return this.getPlan(input.planId)
    })
  }

  recordActivationTargetBaseline(input: { planId: string; expectedRevision: number; fence: number; existed: boolean;
    baselineFiles: readonly { path: string; sha256: string | null }[] }): PluginActivationPlan {
    return this.#withActivationSource(input.planId, () => {
      const now = this.#now()
      this.#database.exec('BEGIN IMMEDIATE')
      try {
        const row = this.#database.prepare('SELECT * FROM activation_plans WHERE id = ?').get(input.planId) as unknown as ActivationRow | undefined
        if (row === undefined) throw new ControlPlaneStoreError('not-found', 'activation plan not found')
        const plan = activationFromRow(row)
        if (plan.revision !== input.expectedRevision || plan.activation?.fence !== input.fence || plan.status !== 'staging'
          || Number(row.activation_lease_until ?? 0) < now) throw new ControlPlaneStoreError('conflict', 'activation lost its claim before recording the target baseline')
        const expectedPaths = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].map(name => `${plan.target.profilePath}/${name}`)
        if (input.baselineFiles.length !== (input.existed ? 3 : 0) || input.baselineFiles.some((file, index) => file.path !== expectedPaths[index]
          || (file.sha256 !== null && !DIGEST.test(file.sha256)))) throw new ControlPlaneStoreError('invalid-input', 'activation target baseline is invalid')
        const baseline = JSON.stringify(input.baselineFiles)
        if (row.activation_target_existed !== null && ((row.activation_target_existed === 1) !== input.existed
          || row.activation_target_baseline_json !== baseline)) {
          throw new ControlPlaneStoreError('conflict', 'activation target baseline is immutable')
        }
        if (row.activation_target_existed === null) {
          this.#database.prepare(`UPDATE activation_plans SET activation_target_existed = ?, activation_target_baseline_json = ?, updated_at = ?
            WHERE id = ? AND revision = ? AND activation_fence = ? AND activation_target_existed IS NULL AND activation_target_baseline_json IS NULL`).run(
            input.existed ? 1 : 0, baseline, now, plan.id, plan.revision, input.fence)
        }
        const result = this.getPlan(plan.id)
        this.#database.exec('COMMIT')
        return result
      } catch (error) { this.#database.exec('ROLLBACK'); throw error }
    })
  }

  /**
   * Freeze the exact candidate profile after all normal Host gates passed but
   * before terminal promotion. This is a mutable deployment checkpoint, not a
   * field in the signed immutable plan: it is the compare-and-restore fence for
   * a later quality-triggered rollback.
   */
  recordActivationInstalledBaseline(input: { planId: string; expectedRevision: number; fence: number;
    baselineFiles: readonly { path: string; sha256: string | null }[] }): PluginActivationPlan {
    return this.#withActivationSource(input.planId, () => {
      const now = this.#now()
      this.#database.exec('BEGIN IMMEDIATE')
      try {
        const row = this.#database.prepare('SELECT * FROM activation_plans WHERE id = ?').get(input.planId) as unknown as ActivationRow | undefined
        if (row === undefined) throw new ControlPlaneStoreError('not-found', 'activation plan not found')
        const plan = activationFromRow(row)
        if (plan.revision !== input.expectedRevision || plan.activation?.fence !== input.fence || plan.status !== 'commit-pending'
          || Number(row.activation_lease_until ?? 0) < now) {
          throw new ControlPlaneStoreError('conflict', 'activation lost its claim before recording the installed baseline')
        }
        let files: readonly { path: string; sha256: string | null }[]
        try { files = activationCoreFiles(input.baselineFiles, plan.target.profilePath, 'activation installed baseline') }
        catch (error) {
          if (error instanceof ControlPlaneStoreError) throw new ControlPlaneStoreError('invalid-input', 'activation installed baseline is invalid')
          throw error
        }
        const baseline = JSON.stringify(files)
        const existing = this.#database.prepare('SELECT * FROM activation_deployment_checkpoints WHERE plan_id = ?')
          .get(plan.id) as ActivationDeploymentCheckpointRow | undefined
        if (existing !== undefined) {
          if (existing.baseline_json !== baseline) throw new ControlPlaneStoreError('conflict', 'activation installed baseline is immutable')
        } else {
          const sequence = this.#database.prepare('SELECT next_exposure_order FROM activation_deployment_sequence WHERE singleton = 1')
            .get() as { next_exposure_order: number } | undefined
          if (sequence === undefined || !Number.isSafeInteger(sequence.next_exposure_order) || sequence.next_exposure_order < 1) {
            throw new ControlPlaneStoreError('invalid-state', 'activation deployment sequence is corrupt')
          }
          const advanced = this.#database.prepare(`UPDATE activation_deployment_sequence SET next_exposure_order = next_exposure_order + 1
            WHERE singleton = 1 AND next_exposure_order = ?`).run(sequence.next_exposure_order)
          if (Number(advanced.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'activation deployment sequence changed')
          this.#database.prepare(`INSERT INTO activation_deployment_checkpoints (plan_id, baseline_json, exposure_order,
            successful_order, recorded_at, succeeded_at) VALUES (?, ?, ?, NULL, ?, NULL)`).run(plan.id, baseline, sequence.next_exposure_order, now)
        }
        const output = this.getPlan(plan.id)
        this.#database.exec('COMMIT')
        return output
      } catch (error) { this.#database.exec('ROLLBACK'); throw error }
    })
  }

  getActivationInstalledBaseline(planId: string): readonly { path: string; sha256: string | null }[] | undefined {
    const plan = this.getPlan(planId)
    const row = this.#database.prepare('SELECT * FROM activation_deployment_checkpoints WHERE plan_id = ?').get(plan.id) as ActivationDeploymentCheckpointRow | undefined
    if (row === undefined) return undefined
    let value: unknown
    try { value = JSON.parse(row.baseline_json) as unknown } catch { throw new ControlPlaneStoreError('invalid-state', 'stored installed activation baseline is corrupt') }
    return activationCoreFiles(value, plan.target.profilePath, 'stored installed activation baseline')
  }

  /** Move a signed closed deployment watch into the existing physical rollback lifecycle. */
  beginPostActivationRollback(input: { planId: string; expectedRevision: number }): PluginActivationPlan {
    const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#database.prepare('SELECT * FROM activation_plans WHERE id = ?').get(input.planId) as unknown as ActivationRow | undefined
      if (row === undefined) throw new ControlPlaneStoreError('not-found', 'activation plan not found')
      const plan = activationFromRow(row)
      if (plan.revision !== input.expectedRevision) throw new ControlPlaneStoreError('conflict', 'activation plan revision conflict')
      // A restart or retry must retain the original rollback identity and never
      // manufacture another rollback from a now-closed watch.
      if ((plan.status === 'rollback-pending' || plan.status === 'rolled-back') && this.#hasPostActivationRollbackProvenance(plan)) {
        this.#database.exec('COMMIT')
        return plan
      }
      if (plan.status !== 'activated' || plan.activation === undefined) {
        throw new ControlPlaneStoreError('invalid-state', 'only an activated deployment can enter post-activation rollback')
      }
      const watch = this.getActivationWatch(plan.id)
      if ((watch.state !== 'closed-regressed' && watch.state !== 'closed-retracted')
        || watch.activationId !== plan.activation.id || watch.fence !== plan.activation.fence || watch.close === undefined) {
        throw new ControlPlaneStoreError('invalid-state', 'post-activation rollback requires an exact signed closed watch')
      }
      if (!plan.activation.hostRecoveryRequired || plan.activation.targetBaselineFiles === undefined) {
        throw new ControlPlaneStoreError('invalid-state', 'post-activation rollback lacks its original recovery baseline')
      }
      const checkpoint = this.#database.prepare('SELECT * FROM activation_deployment_checkpoints WHERE plan_id = ?').get(plan.id) as ActivationDeploymentCheckpointRow | undefined
      if (checkpoint === undefined || checkpoint.successful_order !== checkpoint.exposure_order) {
        throw new ControlPlaneStoreError('invalid-state', 'post-activation rollback lacks a successful installed baseline checkpoint')
      }
      this.getActivationInstalledBaseline(plan.id)
      const active = this.#database.prepare(`SELECT id FROM activation_plans WHERE target_path = ? AND id <> ? AND status IN (
        'staging', 'awaiting-reload', 'awaiting-readiness', 'awaiting-effect-blocked-replay', 'awaiting-shadow',
        'awaiting-canary', 'awaiting-soak', 'awaiting-health', 'commit-pending', 'rollback-pending') LIMIT 1`)
        .get(plan.target.profilePath, plan.id)
      if (active !== undefined) throw new ControlPlaneStoreError('conflict', 'a newer activation currently owns the target profile')
      const superseded = this.#database.prepare(`SELECT checkpoint.plan_id FROM activation_deployment_checkpoints AS checkpoint
        JOIN activation_plans AS candidate ON candidate.id = checkpoint.plan_id
        WHERE candidate.target_path = ? AND checkpoint.successful_order IS NOT NULL
          AND checkpoint.exposure_order > ? LIMIT 1`).get(plan.target.profilePath, checkpoint.exposure_order)
      if (superseded !== undefined) throw new ControlPlaneStoreError('conflict', 'a newer successful deployment permanently superseded this rollback target')
      const failureCode = watch.state === 'closed-regressed' ? 'post-activation-regressed' : 'post-activation-retracted'
      const updated = this.#database.prepare(`UPDATE activation_plans SET status = 'rollback-pending', revision = revision + 1,
        activation_lease_until = NULL, rollback_profile_restored = 0, failure_code = ?, updated_at = ?
        WHERE id = ? AND status = 'activated' AND revision = ? AND activation_id = ? AND activation_fence = ?`).run(
        failureCode, now, plan.id, plan.revision, plan.activation.id, plan.activation.fence)
      if (Number(updated.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'post-activation rollback lost its activation CAS')
      const output = this.getPlan(plan.id)
      this.#database.exec('COMMIT')
      return output
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  /** Backups safe to delete only after `currentPlanId` is terminally promoted. */
  listRetiredActivationBackups(currentPlanId: string): readonly PluginActivationPlan[] {
    const current = this.getPlan(currentPlanId)
    if (current.status !== 'activated') throw new ControlPlaneStoreError('invalid-state', 'only a successful deployment may retire older backups')
    const checkpoint = this.#database.prepare('SELECT * FROM activation_deployment_checkpoints WHERE plan_id = ?').get(current.id) as ActivationDeploymentCheckpointRow | undefined
    if (checkpoint === undefined || checkpoint.successful_order !== checkpoint.exposure_order) return []
    const rows = this.#database.prepare(`SELECT activation.* FROM activation_deployment_checkpoints AS older
      JOIN activation_plans AS activation ON activation.id = older.plan_id
      WHERE activation.target_path = ? AND activation.id <> ? AND activation.status = 'activated'
        AND older.successful_order IS NOT NULL AND older.exposure_order < ?
      ORDER BY older.exposure_order`).all(current.target.profilePath, current.id, checkpoint.exposure_order) as unknown as ActivationRow[]
    return rows.map(activationFromRow)
  }

  /** Freeze recovery obligation before the profile can become Host-visible. */
  markActivationHostExposure(input: { planId: string; expectedRevision: number; fence: number }): PluginActivationPlan {
    return this.#withActivationSource(input.planId, () => {
      const now = this.#now()
      const result = this.#database.prepare(`UPDATE activation_plans SET host_recovery_required = 1, updated_at = ?
        WHERE id = ? AND revision = ? AND activation_fence = ? AND status = 'staging'
          AND activation_target_baseline_json IS NOT NULL AND activation_target_existed IS NOT NULL
          AND activation_lease_until >= ?`).run(now, input.planId, input.expectedRevision, input.fence, now)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'Host exposure lost its claim or original baseline')
      return this.getPlan(input.planId)
    })
  }

  markRollbackProfileRestored(input: { planId: string; expectedRevision: number; fence: number }): PluginActivationPlan {
    const now = this.#now()
    const result = this.#database.prepare(`UPDATE activation_plans SET rollback_profile_restored = 1, activation_lease_until = NULL, updated_at = ?
      WHERE id = ? AND revision = ? AND activation_fence = ? AND status = 'rollback-pending'
        AND host_recovery_required = 1 AND rollback_profile_restored = 0 AND activation_target_baseline_json IS NOT NULL
        AND activation_lease_until >= ?`).run(now, input.planId, input.expectedRevision, input.fence, now)
    if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'rollback restoration marker lost its fence or baseline')
    return this.getPlan(input.planId)
  }

  /**
   * Hold SQLite's cross-process write lock for the complete command or
   * destructive filesystem operation. A lease timeout is therefore never a
   * licence for another worker to mutate the profile while this callback is
   * still running: its claim must first acquire the same kernel-backed DB lock.
   */
  async withActivationFileSystemGuard<T>(input: { planId: string; expectedRevision: number; fence: number;
    status: PlanStatus; leaseMs: number }, action: () => Promise<T>): Promise<T> {
    positiveInteger(input.leaseMs, 'leaseMs')
    try { this.#database.exec('BEGIN IMMEDIATE') } catch { throw new ControlPlaneStoreError('conflict', 'activation filesystem mutex is held') }
    try {
      const assertOwner = (requireLiveLease: boolean): ActivationRow => {
        const row = this.#database.prepare('SELECT * FROM activation_plans WHERE id = ?').get(input.planId) as unknown as ActivationRow | undefined
        if (row === undefined) throw new ControlPlaneStoreError('not-found', 'activation plan not found')
        const plan = activationFromRow(row)
        if (plan.revision !== input.expectedRevision || plan.activation?.fence !== input.fence || plan.status !== input.status
          || (requireLiveLease && Number(row.activation_lease_until ?? 0) < this.#now())) throw new ControlPlaneStoreError('conflict', 'activation no longer owns the filesystem fence')
        return row
      }
      this.assertOwnerActivationSource(input.planId)
      assertOwner(true)
      const started = this.#now()
      this.#database.prepare('UPDATE activation_plans SET activation_lease_until = ?, updated_at = ? WHERE id = ?').run(
        started + input.leaseMs, started, input.planId)
      const result = await action()
      return this.#withActivationSource(input.planId, () => {
      assertOwner(false)
      const finished = this.#now()
      this.#database.prepare('UPDATE activation_plans SET activation_lease_until = ?, updated_at = ? WHERE id = ?').run(
        finished + input.leaseMs, finished, input.planId)
      this.#database.exec('COMMIT')
      return result
      })
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  /** Serialize lock-file lifecycle operations even after a plan became terminal. */
  async withExclusiveWrite<T>(action: () => Promise<T>): Promise<T> {
    try { this.#database.exec('BEGIN IMMEDIATE') } catch { throw new ControlPlaneStoreError('conflict', 'control-plane mutex is held') }
    try {
      const result = await action()
      this.#database.exec('COMMIT')
      return result
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  assertActivationFence(input: { planId: string; expectedRevision: number; fence: number; statuses: readonly PlanStatus[] }): PluginActivationPlan {
    this.assertOwnerActivationSource(input.planId)
    const plan = this.getPlan(input.planId)
    if (plan.revision !== input.expectedRevision || plan.activation?.fence !== input.fence || !input.statuses.includes(plan.status)) throw new ControlPlaneStoreError('conflict', 'activation no longer owns the exact revision/fence/status')
    return plan
  }

  prepareHostAttestationOperation(input: { planId: string; expectedRevision: number; expectedFence: number;
    issuer: HostAttestationRequest['issuer']; requirements: HostAttestationRequirements; receiptTtlMs: number }): HostAttestationOperation {
    return this.#withActivationSource(input.planId, () => {
      const now = this.#now()
      this.#database.exec('BEGIN IMMEDIATE')
      try {
        const plan = this.getPlan(input.planId); const expected = expectedAttestation[plan.status]
        if (expected === undefined) throw new ControlPlaneStoreError('invalid-state', 'activation is not awaiting a Host attestation operation')
        if (plan.revision !== input.expectedRevision || plan.activation?.fence !== input.expectedFence) {
          throw new ControlPlaneStoreError('conflict', 'Host attestation operation targets a stale activation revision/fence')
        }
        if (input.requirements.kind !== expected.phase) throw new ControlPlaneStoreError('invalid-input', 'Host attestation requirements do not match the awaited phase')
        if (!Number.isSafeInteger(input.receiptTtlMs) || input.receiptTtlMs < 1_000 || input.receiptTtlMs > 300_000) {
          throw new ControlPlaneStoreError('invalid-input', 'Host attestation receipt TTL is invalid')
        }
        if (expected.phase === 'reload') {
          const previous = this.latestHostGeneration(plan.installationId)
          if (input.requirements.kind !== 'reload' || input.requirements.previousHostGeneration !== previous) {
            throw new ControlPlaneStoreError('conflict', 'reload operation does not bind the durable prior Host generation')
          }
        }
        if (expected.phase === 'rollback') {
          if (!plan.activation?.hostRecoveryRequired || !plan.activation.rollbackProfileRestored || plan.activation.targetBaselineFiles === undefined) {
            throw new ControlPlaneStoreError('invalid-state', 'rollback physical recovery has not been durably restored and bound')
          }
          const previous = this.latestHostGeneration(plan.installationId)
          if (input.requirements.kind !== 'rollback' || input.requirements.previousHostGeneration !== previous
            || input.requirements.baselineFiles.length !== plan.activation.targetBaselineFiles.length
            || controlPlaneDigest(input.requirements.baselineFiles) !== controlPlaneDigest(plan.activation.targetBaselineFiles)
            || input.requirements.action !== (plan.activation.targetOriginallyExisted ? 'restore' : 'stop')) {
            throw new ControlPlaneStoreError('conflict', 'rollback operation does not bind the durable recovery baseline')
          }
        }
        const predecessor = this.#appliedHostPredecessor(plan, expected.phase)
        if (expected.phase !== 'rollback' && expected.phase !== 'reload' && predecessor === null) {
          throw new ControlPlaneStoreError('conflict', 'normal Host attestation phase has no applied predecessor')
        }
        const operationId = `host-operation-${randomUUID()}`
        const request: HostAttestationRequest = { schemaVersion: 2, kind: 'dsh-host-attestation-request', operationId,
          requestedAt: now, receiptTtlMs: input.receiptTtlMs, installationId: plan.installationId, ledger: plan.ledger, plan: { id: plan.id, digest: plan.digest },
          activation: { id: plan.activation.id, fence: plan.activation.fence }, profile: { name: plan.profile, path: plan.target.profilePath },
          issuer: input.issuer, phase: expected.phase, requirements: input.requirements, predecessor }
        const bindingDigest = controlPlaneDigest(requestBinding(request))
        const priorRow = this.#database.prepare('SELECT * FROM host_attestation_operations WHERE plan_id = ? AND phase = ?')
          .get(plan.id, expected.phase) as unknown as HostAttestationOperationRow | undefined
        if (priorRow !== undefined) {
          const prior = hostOperationFromRow(priorRow)
          if (!isBoundHostRequest(prior.request)) {
            throw new ControlPlaneStoreError('invalid-state', 'legacy Host attestation operation requires reconciliation before upgrade')
          }
          if (prior.bindingDigest !== bindingDigest) throw new ControlPlaneStoreError('conflict', 'durable Host operation payload changed for the same phase')
          this.#database.exec('COMMIT')
          return prior
        }
        this.#database.prepare(`INSERT INTO host_attestation_operations (plan_id, phase, operation_id, binding_digest,
          request_digest, request_json, status, receipt_digest, receipt_json, created_at, completed_at, applied_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, NULL)`).run(plan.id, expected.phase, operationId,
          bindingDigest, controlPlaneDigest(request), JSON.stringify(request), now)
        const operation = this.getHostAttestationOperation(operationId)
        this.#database.exec('COMMIT')
        return operation
      } catch (error) { this.#database.exec('ROLLBACK'); throw error }
    })
  }

  getHostAttestationOperation(operationId: string): HostAttestationOperation {
    const row = this.#database.prepare('SELECT * FROM host_attestation_operations WHERE operation_id = ?').get(operationId) as unknown as HostAttestationOperationRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('not-found', 'Host attestation operation not found')
    return hostOperationFromRow(row)
  }

  /** Same synchronous transaction owns current-profile selection and capture. */
  withForegroundDeployment<T>(task: ForegroundDeploymentRecord['task'], profilePath: string,
    callback: (plan: PluginActivationPlan, operation: HostAttestationOperation) => T): T {
    assertForegroundTask(task)
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const active = this.#database.prepare(`SELECT id FROM activation_plans WHERE target_path = ? AND status IN (
        'staging', 'awaiting-reload', 'awaiting-readiness', 'awaiting-effect-blocked-replay', 'awaiting-shadow',
        'awaiting-canary', 'awaiting-soak', 'awaiting-health', 'commit-pending', 'rollback-pending') LIMIT 1`).get(profilePath)
      if (active) throw new ControlPlaneStoreError('conflict', 'profile has an unsettled activation')
      const latest = this.#database.prepare(`SELECT checkpoint.plan_id, checkpoint.exposure_order, checkpoint.successful_order
        FROM activation_deployment_checkpoints checkpoint JOIN activation_plans plan ON plan.id = checkpoint.plan_id
        WHERE plan.target_path = ? ORDER BY checkpoint.exposure_order DESC LIMIT 1`).get(profilePath) as
        { plan_id: string; exposure_order: number; successful_order: number | null } | undefined
      if (!latest || latest.exposure_order !== latest.successful_order) throw new ControlPlaneStoreError('invalid-state', 'profile has no current successful deployment')
      const plan = this.getPlan(latest.plan_id), watch = this.getActivationWatch(plan.id)
      if (plan.status !== 'activated' || !plan.activation || watch.state !== 'watching'
        || watch.activationId !== plan.activation.id || watch.fence !== plan.activation.fence || watch.startedAt > task.dispatchedAt) {
        throw new ControlPlaneStoreError('invalid-state', 'task did not begin under a watched deployment')
      }
      const source = readOwnerSourceAdoptionPlan(this.#database, plan.id).source
      const owner = source.owner
      if (owner.principalRecordId !== task.owner.principalRecordId || owner.principalVersion !== task.owner.principalVersion
        || owner.workspace !== task.scope.workspace || owner.agentPreset !== task.scope.preset) {
        throw new ControlPlaneStoreError('conflict', 'foreground task owner differs from adopted source owner')
      }
      const row = this.#database.prepare(`SELECT operation.* FROM host_attestation_operations operation
        JOIN host_attestations attestation ON attestation.plan_id = operation.plan_id AND attestation.phase = operation.phase
          AND attestation.receipt_digest = operation.receipt_digest
        WHERE operation.plan_id = ? AND operation.phase = 'readiness' AND operation.status = 'applied'`).get(plan.id) as
        HostAttestationOperationRow | undefined
      if (!row) throw new ControlPlaneStoreError('invalid-state', 'deployment has no applied readiness receipt')
      this.#foregroundDeploymentAdmission = plan.id
      const result = callback(plan, hostOperationFromRow(row))
      if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) throw new ControlPlaneStoreError('invalid-input', 'foreground capture must be synchronous')
      this.#database.exec('COMMIT')
      return result
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
    finally { this.#foregroundDeploymentAdmission = undefined }
  }

  beginForegroundDeployment(record: ForegroundDeploymentRecord): void {
    assertForegroundDeployment(record)
    if (this.#foregroundDeploymentAdmission !== record.readiness.planId) throw new ControlPlaneStoreError('conflict', 'foreground deployment lacks current admission')
    if (record.state !== 'pending') throw new ControlPlaneStoreError('invalid-input', 'foreground deployment must begin pending')
    const encoded = JSON.stringify(record)
    if (Buffer.byteLength(encoded) > 262_144) throw new ControlPlaneStoreError('invalid-input', 'foreground deployment exceeds storage bound')
    this.#database.prepare(`INSERT INTO foreground_deployments (inbox_id, plan_id, record_json, record_digest)
      VALUES (?, ?, ?, ?)`).run(record.task.inboxId, record.readiness.planId, encoded, controlPlaneDigest(record))
  }

  getForegroundDeployment(inboxId: string): ForegroundDeploymentRecord | undefined {
    const row = this.#database.prepare('SELECT record_json, record_digest, plan_id FROM foreground_deployments WHERE inbox_id = ?').get(inboxId) as
      { record_json: string; record_digest: string; plan_id: string } | undefined
    if (!row) return undefined
    if (Buffer.byteLength(row.record_json) > 262_144) throw new ControlPlaneStoreError('invalid-state', 'stored foreground deployment exceeds storage bound')
    const record = JSON.parse(row.record_json) as ForegroundDeploymentRecord
    if (controlPlaneDigest(record) !== row.record_digest || record.task.inboxId !== inboxId || record.readiness.planId !== row.plan_id) {
      throw new ControlPlaneStoreError('invalid-state', 'stored foreground deployment changed')
    }
    assertForegroundDeployment(record)
    return record
  }

  finishForegroundDeployment(record: ForegroundDeploymentRecord): void {
    assertForegroundDeployment(record)
    if (record.state === 'observed' && this.#foregroundDeploymentAdmission !== record.readiness.planId) throw new ControlPlaneStoreError('conflict', 'foreground deployment lacks current admission')
    const prior = this.getForegroundDeployment(record.task.inboxId)
    if (!prior || prior.state !== 'pending' || record.state === 'pending'
      || controlPlaneDigest(prior.task) !== controlPlaneDigest(record.task)
      || controlPlaneDigest(prior.readiness) !== controlPlaneDigest(record.readiness)
      || controlPlaneDigest(prior.begin) !== controlPlaneDigest(record.begin)) throw new ControlPlaneStoreError('conflict', 'foreground deployment completion changed')
    const encoded = JSON.stringify(record)
    if (Buffer.byteLength(encoded) > 262_144) throw new ControlPlaneStoreError('invalid-input', 'foreground deployment exceeds storage bound')
    const result = this.#database.prepare(`UPDATE foreground_deployments SET record_json = ?, record_digest = ?
      WHERE inbox_id = ? AND record_digest = ?`).run(encoded, controlPlaneDigest(record), record.task.inboxId, controlPlaneDigest(prior))
    if (result.changes !== 1) throw new ControlPlaneStoreError('conflict', 'foreground deployment completion lost its fence')
  }

  latestHostGeneration(installationId: string): number {
    if (!UUID.test(installationId)) throw new ControlPlaneStoreError('invalid-input', 'installation id is invalid')
    const row = this.#database.prepare(`SELECT max(generation) AS generation FROM (
      SELECT max(attestation.host_generation) AS generation
        FROM host_attestations AS attestation JOIN activation_plans AS activation ON activation.id = attestation.plan_id
        WHERE activation.installation_id = ?
      UNION ALL
      SELECT max(watch.last_host_generation) AS generation
        FROM activation_watch AS watch JOIN activation_plans AS activation ON activation.id = watch.plan_id
        WHERE activation.installation_id = ?
    )`).get(installationId, installationId) as { generation: number | null }
    return row.generation ?? 0
  }

  #appliedHostPredecessor(plan: PluginActivationPlan, phase: HostAttestationPhase): HostAttestationRequest['predecessor'] {
    if (phase === 'reload') return null
    const priorPhase = phase === 'rollback' ? undefined : predecessorPhase[phase]
    const row = this.#database.prepare(`SELECT operation.* FROM host_attestation_operations AS operation
      JOIN host_attestations AS attestation ON attestation.plan_id = operation.plan_id
        AND attestation.phase = operation.phase AND attestation.receipt_digest = operation.receipt_digest
      WHERE operation.plan_id = ? AND operation.status = 'applied'
        ${priorPhase === undefined ? '' : 'AND operation.phase = ?'}
      ORDER BY operation.applied_at DESC,
        CASE operation.phase WHEN 'reload' THEN 1 WHEN 'readiness' THEN 2 WHEN 'effect-blocked-replay' THEN 3
          WHEN 'shadow' THEN 4 WHEN 'canary' THEN 5 WHEN 'soak' THEN 6 WHEN 'health' THEN 7 WHEN 'rollback' THEN 8 END DESC`).all(
      ...(priorPhase === undefined ? [plan.id] : [plan.id, priorPhase])) as unknown as HostAttestationOperationRow[]
    for (const candidate of row) {
      const operation = hostOperationFromRow(candidate); const receipt = operation.receipt
      if (receipt === undefined || candidate.receipt_digest === null) throw new ControlPlaneStoreError('invalid-state', 'applied Host predecessor lacks its receipt')
      const postActivationRollback = phase === 'rollback' && this.#isPostActivationRollback(plan)
      if (operation.request.activation.id !== plan.activation?.id || receipt.activationId !== plan.activation.id
        || (!postActivationRollback && (operation.request.activation.fence !== plan.activation.fence || receipt.fence !== plan.activation.fence))
        || (postActivationRollback && (operation.request.activation.fence >= plan.activation.fence || receipt.fence >= plan.activation.fence))) continue
      return { operationId: operation.operationId, receiptId: receipt.receiptId, phase: operation.phase,
        receiptDigest: candidate.receipt_digest, hostGeneration: receipt.hostGeneration }
    }
    return null
  }

  #isPostActivationRollback(plan: PluginActivationPlan): boolean {
    if (plan.status !== 'rollback-pending' || plan.activation === undefined || plan.activation.failureCode === undefined
      || !['post-activation-regressed', 'post-activation-retracted'].includes(plan.activation.failureCode)) return false
    const checkpoint = this.#database.prepare('SELECT successful_order, exposure_order FROM activation_deployment_checkpoints WHERE plan_id = ?')
      .get(plan.id) as { successful_order: number | null; exposure_order: number } | undefined
    return checkpoint !== undefined && checkpoint.successful_order === checkpoint.exposure_order
  }

  #hasPostActivationRollbackProvenance(plan: PluginActivationPlan): boolean {
    if (plan.activation === undefined || !['post-activation-regressed', 'post-activation-retracted'].includes(plan.activation.failureCode ?? '')) return false
    const checkpoint = this.#database.prepare('SELECT successful_order, exposure_order FROM activation_deployment_checkpoints WHERE plan_id = ?')
      .get(plan.id) as { successful_order: number | null; exposure_order: number } | undefined
    if (checkpoint === undefined || checkpoint.successful_order !== checkpoint.exposure_order) return false
    const watch = this.#database.prepare('SELECT activation_id, fence, state, close_signature_digest FROM activation_watch WHERE plan_id = ?').get(plan.id) as
      { activation_id: string; fence: number; state: ActivationWatch['state']; close_signature_digest: string | null } | undefined
    return watch !== undefined && (watch.state === 'closed-regressed' || watch.state === 'closed-retracted')
      && watch.close_signature_digest !== null && watch.activation_id === plan.activation.id && watch.fence <= plan.activation.fence
  }

  #assertHostAttestationChain(operation: HostAttestationOperation, plan: PluginActivationPlan): HostAttestationRequest {
    const request = operation.request
    if (!isBoundHostRequest(request)) throw new ControlPlaneStoreError('invalid-state', 'legacy Host attestation request requires reconciliation before dispatch or apply')
    if (request.phase !== operation.phase || request.activation.id !== plan.activation?.id || request.activation.fence !== plan.activation.fence) {
      throw new ControlPlaneStoreError('conflict', 'Host attestation request lost its activation binding')
    }
    const latest = this.latestHostGeneration(plan.installationId)
    if (operation.phase === 'reload') {
      if (request.predecessor !== null || request.requirements.kind !== 'reload'
        || request.requirements.previousHostGeneration !== latest) {
        throw new ControlPlaneStoreError('conflict', 'reload Host generation advanced after request reservation')
      }
      return request
    }
    const rollbackRequirements = request.requirements.kind === 'rollback' ? request.requirements : undefined
    if (operation.phase === 'rollback' && rollbackRequirements === undefined) {
      throw new ControlPlaneStoreError('conflict', 'rollback Host request requirements changed')
    }
    if (operation.phase === 'rollback' && rollbackRequirements !== undefined && rollbackRequirements.previousHostGeneration !== latest) {
      throw new ControlPlaneStoreError('conflict', 'rollback Host generation advanced after request reservation')
    }
    const predecessor = request.predecessor
    const actual = this.#appliedHostPredecessor(plan, operation.phase)
    if (predecessor === null) {
      if (operation.phase !== 'rollback' || actual !== null) {
        throw new ControlPlaneStoreError('conflict', 'Host attestation predecessor is missing or was added after reservation')
      }
      return request
    }
    if (actual === null || actual.operationId !== predecessor.operationId || actual.receiptId !== predecessor.receiptId
      || actual.phase !== predecessor.phase || actual.receiptDigest !== predecessor.receiptDigest
      || actual.hostGeneration !== predecessor.hostGeneration) {
      throw new ControlPlaneStoreError('conflict', 'Host attestation predecessor does not match the applied receipt ledger')
    }
    if (operation.phase !== 'rollback') {
      if (predecessor.phase !== predecessorPhase[operation.phase] || latest !== predecessor.hostGeneration) {
        throw new ControlPlaneStoreError('conflict', 'Host generation changed after predecessor binding')
      }
      const row = this.#database.prepare('SELECT receipt_json FROM host_attestation_operations WHERE operation_id = ?').get(predecessor.operationId) as { receipt_json: string } | undefined
      const receipt = row === undefined ? undefined : JSON.parse(row.receipt_json) as HostAttestationReceipt
      if (receipt?.outcome !== 'passed') throw new ControlPlaneStoreError('conflict', 'normal Host phase predecessor was not passed')
    }
    return request
  }

  /**
   * Keep the SQLite writer mutex for the complete external attestor call. The
   * operation id was committed before this method, so process death retries the
   * same request while concurrent workers cannot cause a second canary call.
   */
  async runHostAttestationOperation(input: { operationId: string; expectedRevision: number; expectedFence: number;
    execute: (request: HostAttestationRequest) => Promise<HostAttestationReceipt>;
    resolveAuthority: (receipt: HostAttestationReceipt) => HostAttestationAuthority }): Promise<HostAttestationReceipt> {
    try { this.#database.exec('BEGIN IMMEDIATE') } catch { throw new ControlPlaneStoreError('conflict', 'Host attestation single-flight is held') }
    try {
      const operation = this.getHostAttestationOperation(input.operationId)
      const plan = this.getPlan(operation.planId); const expected = expectedAttestation[plan.status]
      if (plan.revision !== input.expectedRevision || plan.activation?.fence !== input.expectedFence
        || expected?.phase !== operation.phase || operation.requestDigest !== controlPlaneDigest(operation.request)) {
        throw new ControlPlaneStoreError('conflict', 'Host attestation operation lost its plan revision/fence/phase')
      }
      this.assertOwnerActivationSource(plan.id)
      const request = this.#assertHostAttestationChain(operation, plan)
      if (operation.receipt !== undefined) { this.#database.exec('COMMIT'); return operation.receipt }
      const receipt = await input.execute(request)
      await input.resolveAuthority(receipt).verify(receipt, plan, request)
      if (operation.phase !== 'reload' && operation.phase !== 'rollback'
        && receipt.hostGeneration !== request.predecessor!.hostGeneration) {
        throw new ControlPlaneStoreError('conflict', 'non-transition Host receipt changed generation from its predecessor')
      }
      if (operation.phase === 'rollback' && receipt.outcome !== 'passed') {
        throw new ControlPlaneStoreError('conflict', 'failed physical rollback receipt cannot consume the durable recovery operation')
      }
      return this.#withActivationSource(plan.id, () => {
      const now = this.#now()
      const result = this.#database.prepare(`UPDATE host_attestation_operations SET status = 'completed', receipt_digest = ?,
        receipt_json = ?, completed_at = ? WHERE operation_id = ? AND status = 'pending' AND request_digest = ?`).run(
        controlPlaneDigest(receipt), JSON.stringify(receipt), now, operation.operationId, operation.requestDigest)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'Host attestation operation completion lost its single-flight')
      this.#database.exec('COMMIT')
      return receipt
      })
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  /** Stop an exposed deployment between phases, or after its previous installer lease expired. */
  requestActivationRollback(input: { planId: string; expectedRevision: number; fence: number; failureCode: string }): PluginActivationPlan {
    const code = bounded(input.failureCode, 'failureCode', 160)
    if (!KEY.test(code)) throw new ControlPlaneStoreError('invalid-input', 'invalid rollback failure code')
    const result = this.#database.prepare(`UPDATE activation_plans SET status = 'rollback-pending', revision = revision + 1,
      failure_code = ?, activation_lease_until = NULL, updated_at = ? WHERE id = ? AND revision = ? AND activation_fence = ?
      AND (status IN ('awaiting-reload', 'awaiting-readiness', 'awaiting-effect-blocked-replay', 'awaiting-shadow',
        'awaiting-canary', 'awaiting-soak', 'awaiting-health')
        OR (status IN ('staging', 'commit-pending') AND COALESCE(activation_lease_until, 0) < ?))`).run(code, this.#now(), input.planId, input.expectedRevision, input.fence, this.#now())
    if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'activation recovery request lost its waiting-phase fence')
    return this.getPlan(input.planId)
  }

  advanceActivation(input: { planId: string; expectedRevision: number; fence: number; from: PlanStatus; to: PlanStatus; failureCode?: string }): PluginActivationPlan {
    return this.#withActivationSource(input.planId, () => {
      const allowed: Record<string, readonly PlanStatus[]> = { staging: ['awaiting-reload', 'rollback-pending'],
        'rollback-pending': ['rolled-back'], 'commit-pending': ['activated', 'rollback-pending'] }
      if (!allowed[input.from]?.includes(input.to)) throw new ControlPlaneStoreError('invalid-input', 'invalid activation transition')
      const now = this.#now(); this.#database.exec('BEGIN IMMEDIATE')
      try {
        const result = this.#database.prepare(`UPDATE activation_plans SET status = ?, revision = revision + 1,
          activation_lease_until = CASE
            WHEN ? IN ('rolled-back', 'activated', 'awaiting-reload') THEN NULL
            ELSE activation_lease_until END,
          host_recovery_required = CASE WHEN ? = 'awaiting-reload' THEN 1 ELSE host_recovery_required END,
          failure_code = COALESCE(?, failure_code), updated_at = ?
          WHERE id = ? AND revision = ? AND activation_fence = ? AND status = ? AND activation_lease_until >= ?
            AND NOT (? = 'rolled-back' AND host_recovery_required = 1)`).run(
          input.to, input.to, input.to, input.failureCode ?? null, now, input.planId, input.expectedRevision, input.fence, input.from, now, input.to)
        if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'activation transition lost its CAS/fencing claim')
        const plan = this.getPlan(input.planId)
        if (input.to === 'rolled-back' || input.to === 'activated') {
          if (input.to === 'activated') this.#database.prepare(`UPDATE capability_gaps SET status = 'closed', revision = revision + 1, updated_at = ? WHERE id = ?`).run(now, plan.gapId)
          this.#finishActivation(plan, input.fence, now)
        }
        this.#database.exec('COMMIT'); return plan
      } catch (error) { this.#database.exec('ROLLBACK'); throw error }
    }, input.to === 'rollback-pending' || input.to === 'rolled-back')
  }

  async applyHostAttestation(input: { planId: string; expectedRevision: number; expectedFence: number; receipt: HostAttestationReceipt;
    resolveAuthority: (receipt: HostAttestationReceipt) => HostAttestationAuthority; idempotencyKey: string }): Promise<OperationReceipt<PluginActivationPlan>> {
    const recovery = input.receipt.phase === 'rollback' || input.receipt.outcome !== 'passed'
    this.#withActivationSource(input.planId, () => {}, recovery)
    const inputDigest = controlPlaneDigest({ operation: 'host-attestation', planId: input.planId,
      expectedRevision: input.expectedRevision, expectedFence: input.expectedFence, receipt: input.receipt })
    const replay = this.#activationPlanReceipt(input.idempotencyKey, 'host-attestation', inputDigest, input.planId)
    if (replay !== undefined) {
      const transition = Object.values(expectedAttestation).find(item => item.phase === input.receipt.phase)
      const expectedStatus: PlanStatus = input.receipt.outcome === 'passed' && transition !== undefined
        ? transition.next : 'rollback-pending'
      const expectedFailure = input.receipt.outcome === 'passed' ? undefined : 'host-attestation-failed'
      if (replay.result.status !== expectedStatus || replay.result.revision !== input.expectedRevision + 1
        || replay.result.activation?.id !== input.receipt.activationId || replay.result.activation.fence !== input.expectedFence
        || (input.receipt.phase !== 'rollback' && replay.result.activation.failureCode !== expectedFailure) || replay.result.activation.updatedAt !== replay.createdAt) {
        throw new ControlPlaneStoreError('invalid-state', 'stored Host attestation operation receipt is corrupt')
      }
      return replay
    }
    const plan = this.getPlan(input.planId); const expected = expectedAttestation[plan.status]
    if (expected === undefined) throw new ControlPlaneStoreError('invalid-state', 'activation is not awaiting a host attestation')
    if (plan.revision !== input.expectedRevision || plan.activation?.fence !== input.expectedFence) throw new ControlPlaneStoreError('conflict', 'host attestation targets a stale activation revision/fence')
    const operation = this.getHostAttestationOperation(input.receipt.operationId)
    if (operation.planId !== plan.id || operation.phase !== expected.phase || operation.status !== 'completed'
      || operation.receipt === undefined || controlPlaneDigest(operation.receipt) !== controlPlaneDigest(input.receipt)) {
      throw new ControlPlaneStoreError('conflict', 'Host attestation was not completed by the durable phase operation')
    }
    const request = this.#assertHostAttestationChain(operation, plan)
    const verified = await input.resolveAuthority(input.receipt).verify(input.receipt, plan, request)
    if (operation.phase !== 'reload' && operation.phase !== 'rollback'
      && verified.hostGeneration !== request.predecessor!.hostGeneration) {
      throw new ControlPlaneStoreError('conflict', 'non-transition Host receipt changed generation from its predecessor')
    }
    const now = this.#now(); const nextStatus: PlanStatus = verified.outcome === 'passed' ? expected.next : 'rollback-pending'
    return this.#withActivationSource(input.planId, () => {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const lockedOperation = this.getHostAttestationOperation(input.receipt.operationId)
      const lockedPlan = this.getPlan(input.planId)
      if (lockedOperation.status !== 'completed' || lockedPlan.revision !== input.expectedRevision
        || lockedPlan.activation?.fence !== input.expectedFence || lockedPlan.status !== plan.status) {
        throw new ControlPlaneStoreError('conflict', 'Host attestation changed before apply')
      }
      this.#assertHostAttestationChain(lockedOperation, lockedPlan)
      const previousGeneration = this.latestHostGeneration(plan.installationId)
      if (verified.hostGeneration < previousGeneration) throw new ControlPlaneStoreError('conflict', 'host generation regressed')
      this.#database.prepare(`INSERT INTO host_attestations (plan_id, phase, receipt_id, receipt_digest, receipt_json, host_generation, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(plan.id, verified.phase, verified.receiptId, controlPlaneDigest(input.receipt), JSON.stringify(verified), verified.hostGeneration, now)
      const result = this.#database.prepare(`UPDATE activation_plans SET status = ?, revision = revision + 1,
        activation_lease_until = NULL,
        failure_code = CASE WHEN ? = 'rollback-pending' AND (failure_code IS NULL OR failure_code NOT IN ('post-activation-regressed', 'post-activation-retracted'))
          THEN 'host-attestation-failed' ELSE failure_code END, updated_at = ?
        WHERE id = ? AND status = ? AND revision = ? AND activation_fence = ?`).run(nextStatus, nextStatus, now, plan.id, plan.status, plan.revision, input.expectedFence)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'host attestation lost its plan CAS')
      const applied = this.#database.prepare(`UPDATE host_attestation_operations SET status = 'applied', applied_at = ?
        WHERE operation_id = ? AND status = 'completed' AND receipt_digest = ?`).run(now, operation.operationId, controlPlaneDigest(input.receipt))
      if (Number(applied.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'Host attestation operation lost its apply CAS')
      const output = this.getPlan(plan.id)
      if (nextStatus === 'rolled-back') this.#finishActivation(output, input.expectedFence, now)
      const operationReceipt = { idempotencyKey: input.idempotencyKey, operation: 'host-attestation', inputDigest, result: output, createdAt: now }
      this.#insertReceipt(operationReceipt); this.#database.exec('COMMIT'); return operationReceipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
    }, recovery)
  }

  // -------------------------------------------------------------------------
  // Post-activation quality watch (deployment cohort monitoring). This is an
  // evidence lifecycle before a rollback worker claims physical recovery:
  // Host-signed observations append evidence and a `regressed` probe closes the
  // exact pinned version, while an owner-signed retraction closes the watch.
  // `beginPostActivationRollback()` later turns that signed closure into the
  // existing fenced recovery lifecycle. Healthy evidence never closes a watch.
  // -------------------------------------------------------------------------

  getActivationWatch(planId: string): ActivationWatch {
    const row = this.#database.prepare('SELECT * FROM activation_watch WHERE plan_id = ?').get(planId) as WatchRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('not-found', 'post-activation watch not found')
    return watchFromRow(row)
  }

  listActivationWatches(limit = 50): readonly ActivationWatch[] {
    const rows = this.#database.prepare('SELECT * FROM activation_watch ORDER BY started_at, plan_id LIMIT ?').all(limit) as unknown as WatchRow[]
    return rows.map(watchFromRow)
  }

  listActivationWatchEvidence(planId: string, limit = 100): readonly ActivationWatchEvidenceRecord[] {
    const rows = this.#database.prepare(`SELECT * FROM activation_watch_evidence WHERE plan_id = ?
      ORDER BY created_at, observation_id LIMIT ?`).all(planId, limit) as unknown as WatchEvidenceRow[]
    return rows.map(watchEvidenceFromRow)
  }

  async recordPostActivationObservation(input: { idempotencyKey: string; expectedRevision?: number;
    receipt: PostActivationObservationReceipt;
    resolveAuthority: (receipt: PostActivationObservationReceipt) => PostActivationObservationAuthority }):
    Promise<OperationReceipt<ActivationWatch>> {
    const key = bounded(input.idempotencyKey, 'idempotencyKey', 160)
    if (!KEY.test(key)) throw new ControlPlaneStoreError('invalid-input', 'idempotencyKey has invalid syntax')
    const inputDigest = controlPlaneDigest({ operation: 'post-activation-observation', planId: input.receipt.planId,
      observationId: input.receipt.observationId, receipt: input.receipt })
    const replay = this.#watchReceipt(key, 'post-activation-observation', inputDigest)
    if (replay !== undefined) return replay
    const plan = this.getPlan(input.receipt.planId)
    const watch = this.getActivationWatch(plan.id)
    if (watch.state !== 'watching') throw new ControlPlaneStoreError('conflict', 'post-activation watch is already closed')
    if (input.expectedRevision !== undefined && watch.revision !== input.expectedRevision) {
      throw new ControlPlaneStoreError('conflict', 'post-activation observation targets a stale watch revision')
    }
    const verified = await input.resolveAuthority(input.receipt).verify(input.receipt, plan, watch.exact)
    const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#database.prepare('SELECT * FROM activation_watch WHERE plan_id = ?').get(plan.id) as unknown as WatchRow
      if (current.state !== 'watching') throw new ControlPlaneStoreError('conflict', 'post-activation watch closed while evidence was verified')
      if (verified.hostGeneration < current.last_host_generation) throw new ControlPlaneStoreError('conflict', 'host generation regressed')
      this.#insertWatchEvidence(verified.observationId, plan.id, verified.disposition, controlPlaneDigest(input.receipt),
        verified.signatureDigest, verified, verified.hostGeneration, verified.evidence.failures, verified.evidence.checks, now)
      if (verified.disposition === 'regressed') {
        const closed = this.#database.prepare(`UPDATE activation_watch SET state = 'closed-regressed', revision = revision + 1,
          last_host_generation = ?, updated_at = ?, close_disposition = 'regressed', close_at = ?,
          close_evidence_id = ?, close_signature_digest = ?
          WHERE plan_id = ? AND state = 'watching' AND revision = ?`).run(verified.hostGeneration, now, now,
          verified.observationId, verified.signatureDigest, plan.id, current.revision)
        if (Number(closed.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'post-activation regression lost its watch CAS')
      } else {
        const acknowledged = this.#database.prepare(`UPDATE activation_watch SET revision = revision + 1, last_host_generation = ?,
          healthy_observations = healthy_observations + 1, updated_at = ? WHERE plan_id = ? AND state = 'watching' AND revision = ?`).run(
          verified.hostGeneration, now, plan.id, current.revision)
        if (Number(acknowledged.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'post-activation observation lost its watch CAS')
      }
      const output = this.getActivationWatch(plan.id)
      const operationReceipt = { idempotencyKey: key, operation: 'post-activation-observation' as const, inputDigest, result: output, createdAt: now }
      this.#insertReceipt(operationReceipt); this.#database.exec('COMMIT'); return operationReceipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  async retractActivation(input: { idempotencyKey: string; expectedRevision?: number;
    receipt: ActivationRetractionReceipt;
    resolveAuthority: (receipt: ActivationRetractionReceipt) => ActivationRetractionAuthority }):
    Promise<OperationReceipt<ActivationWatch>> {
    const key = bounded(input.idempotencyKey, 'idempotencyKey', 160)
    if (!KEY.test(key)) throw new ControlPlaneStoreError('invalid-input', 'idempotencyKey has invalid syntax')
    const inputDigest = controlPlaneDigest({ operation: 'activation-retraction', planId: input.receipt.planId,
      retractionId: input.receipt.retractionId, receipt: input.receipt })
    const replay = this.#watchReceipt(key, 'activation-retraction', inputDigest)
    if (replay !== undefined) return replay
    const plan = this.getPlan(input.receipt.planId)
    const watch = this.getActivationWatch(plan.id)
    if (watch.state === 'closed-retracted') throw new ControlPlaneStoreError('conflict', 'activation is already retracted')
    if (input.expectedRevision !== undefined && watch.revision !== input.expectedRevision) {
      throw new ControlPlaneStoreError('conflict', 'activation retraction targets a stale watch revision')
    }
    const verified = await input.resolveAuthority(input.receipt).verify(input.receipt, plan, watch.exact)
    const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#database.prepare('SELECT * FROM activation_watch WHERE plan_id = ?').get(plan.id) as unknown as WatchRow
      if (current.state === 'closed-retracted') throw new ControlPlaneStoreError('conflict', 'activation retracted while the decision was verified')
      this.#insertWatchEvidence(verified.retractionId, plan.id, 'retracted', controlPlaneDigest(input.receipt),
        verified.signatureDigest, verified, current.last_host_generation, 0, 0, now)
      const closed = this.#database.prepare(`UPDATE activation_watch SET state = 'closed-retracted', revision = revision + 1,
        updated_at = ?, close_disposition = 'retracted', close_at = ?, close_evidence_id = ?, close_signature_digest = ?
        WHERE plan_id = ? AND state IN ('watching', 'closed-regressed') AND revision = ?`).run(now, now,
        verified.retractionId, verified.signatureDigest, plan.id, current.revision)
      if (Number(closed.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'activation retraction lost its watch CAS')
      // Owner withdrawal may race a fresh plan created after an earlier
      // retraction. Only reopen when this historic plan remains the sole claim.
      this.#reopenGapAfterActivation(plan, now)
      const output = this.getActivationWatch(plan.id)
      const operationReceipt = { idempotencyKey: key, operation: 'activation-retraction' as const, inputDigest, result: output, createdAt: now }
      this.#insertReceipt(operationReceipt); this.#database.exec('COMMIT'); return operationReceipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  #insertWatchEvidence(observationId: string, planId: string, disposition: 'regressed' | 'healthy' | 'retracted',
    receiptDigest: string, signatureDigest: string, verified: object, hostGeneration: number,
    failures: number, checks: number, now: number): void {
    this.#database.prepare(`INSERT INTO activation_watch_evidence (observation_id, plan_id, disposition, receipt_digest,
      signature_digest, receipt_json, host_generation, failures, checks, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(observationId, planId, disposition, receiptDigest, signatureDigest,
      JSON.stringify(verified), hostGeneration, failures, checks, now)
  }

  #watchReceipt(idempotencyKey: string, operation: string, inputDigest: string): OperationReceipt<ActivationWatch> | undefined {
    const receipt = this.#receipt<unknown>(idempotencyKey, operation, inputDigest)
    if (receipt === undefined) return undefined
    const snapshot = watchFromStored(receipt.result)
    const authoritative = this.getActivationWatch(snapshot.planId)
    // The watch may have advanced (or closed) after this operation was applied; a
    // replay returns the snapshot recorded at the time, so only the immutable
    // exact binding and the monotone revision are cross-checked, not the state.
    if (controlPlaneDigest(snapshot.exact) !== controlPlaneDigest(authoritative.exact)
      || snapshot.activationId !== authoritative.activationId || snapshot.fence !== authoritative.fence
      || snapshot.revision > authoritative.revision || snapshot.updatedAt !== receipt.createdAt) {
      throw new ControlPlaneStoreError('invalid-state', 'stored watch operation receipt is not bound to authoritative state')
    }
    return { ...receipt, result: snapshot }
  }

  #finishActivation(plan: PluginActivationPlan, fence: number, now: number): void {
    const activationId = plan.activation?.id
    if (activationId === undefined) throw new ControlPlaneStoreError('invalid-state', 'terminal activation has no identity')
    const inputDigest = controlPlaneDigest({ planId: plan.id, planDigest: plan.digest, activationId, fence, status: plan.status, failureCode: plan.activation?.failureCode })
    const checkpoint = this.#database.prepare('SELECT successful_order, exposure_order FROM activation_deployment_checkpoints WHERE plan_id = ?')
      .get(plan.id) as { successful_order: number | null; exposure_order: number } | undefined
    const postActivationRollback = plan.status === 'rolled-back' && checkpoint !== undefined && checkpoint.successful_order === checkpoint.exposure_order
    this.#insertReceipt({ idempotencyKey: postActivationRollback ? `post-activation-rollback:${activationId}:${fence}` : `activation:${activationId}`,
      operation: postActivationRollback ? 'post-activation-rollback' : 'activate-plan', inputDigest, result: plan, createdAt: now })
    if (plan.status === 'rolled-back') {
      this.#reopenGapAfterActivation(plan, now)
    } else if (plan.status === 'activated') {
      if (checkpoint !== undefined) {
        const marked = this.#database.prepare(`UPDATE activation_deployment_checkpoints SET successful_order = exposure_order,
          succeeded_at = ? WHERE plan_id = ? AND successful_order IS NULL`).run(now, plan.id)
        if (Number(marked.changes) !== 1) throw new ControlPlaneStoreError('invalid-state', 'activation installed baseline success marker is corrupt')
      }
      const result = this.#database.prepare(`INSERT INTO activation_watch (plan_id, package_name, package_version,
        package_integrity, activation_id, fence, state, revision, last_host_generation, healthy_observations,
        started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'watching', 1, 0, 0, ?, ?)
        ON CONFLICT(plan_id) DO NOTHING`).run(plan.id, plan.candidate.package, plan.candidate.version,
        plan.candidate.integrity, activationId, fence, now, now)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('invalid-state', 'activated plan has no post-activation watch')
    }
  }

  #reopenGapAfterActivation(plan: PluginActivationPlan, now: number): void {
    this.#database.prepare('DELETE FROM gap_plan_claims WHERE gap_id = ? AND plan_id = ?').run(plan.gapId, plan.id)
    // A later owner may already have claimed the gap while a historic closed
    // watch was being reconciled. Preserve that newer owner and its candidate.
    this.#database.prepare(`UPDATE capability_gaps SET status = 'open', candidate_id = NULL, revision = revision + 1, updated_at = ?
      WHERE id = ? AND NOT EXISTS (SELECT 1 FROM gap_plan_claims WHERE gap_id = ?)`)
      .run(now, plan.gapId, plan.gapId)
  }

  beginSourceChecks(input: { planId: string; expectedRevision: number }): PluginSourcePlan {
    const existing = this.getSourcePlan(input.planId)
    if (existing.mode !== 'create') throw new ControlPlaneStoreError('invalid-state', 'modify source plans are verified, not locally scaffolded')
    const now = this.#now()
    const result = this.#database.prepare(`UPDATE source_plans SET status = 'running-local-checks', revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND status = 'approved' AND mode = 'create'`).run(now, input.planId, input.expectedRevision)
    if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source plan changed before local checks')
    return this.getSourcePlan(input.planId)
  }

  finishSourceChecks(input: { planId: string; expectedRevision: number; succeeded: boolean;
    checkedTreeDigest?: string; checkedPatchDigest?: string }): PluginSourcePlan {
    const existing = this.getSourcePlan(input.planId)
    if (existing.mode !== 'create') throw new ControlPlaneStoreError('invalid-state', 'modify source plans are verified, not locally scaffolded')
    const now = this.#now(); const status = input.succeeded ? 'ready-for-human-review' : 'local-checks-failed'
    if (input.succeeded && (!DIGEST.test(input.checkedTreeDigest ?? '') || !DIGEST.test(input.checkedPatchDigest ?? ''))) {
      throw new ControlPlaneStoreError('invalid-input', 'successful source checks require exact tree and patch digests')
    }
    if (!input.succeeded && (input.checkedTreeDigest !== undefined || input.checkedPatchDigest !== undefined)) {
      throw new ControlPlaneStoreError('invalid-input', 'failed source checks cannot carry successful check evidence')
    }
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#database.prepare(`UPDATE source_plans SET status = ?, revision = revision + 1,
        checked_tree_digest = ?, checked_patch_digest = ?, checked_at = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND status = 'running-local-checks'`).run(status, input.checkedTreeDigest ?? null,
        input.checkedPatchDigest ?? null, input.succeeded ? now : null, now, input.planId, input.expectedRevision)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source plan changed while local checks ran')
      const output = this.getSourcePlan(input.planId)
      if (!input.succeeded) {
        this.#database.prepare('DELETE FROM gap_plan_claims WHERE gap_id = ? AND plan_id = ?').run(output.gapId, output.id)
        this.#database.prepare(`UPDATE capability_gaps SET status = 'open', revision = revision + 1, updated_at = ? WHERE id = ?`).run(now, output.gapId)
      }
      const digest = controlPlaneDigest({ planId: output.id, planDigest: output.digest, status, sourceCheck: output.sourceCheck })
      this.#insertReceipt({ idempotencyKey: `source-checks:${output.id}`, operation: 'source-local-checks', inputDigest: digest, result: output, createdAt: now })
      this.#database.exec('COMMIT'); return output
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  /**
   * Owner-side verification of a 'modify' plan: the owner recomputes the tree
   * and patch digests on the unchanged isolated worktree and they must match the
   * pending evidence *exactly*. On match the plan advances approved ->
   * ready-for-human-review without ever entering running-local-checks. No
   * approval, signature or release authority is reachable from this method.
   */
  verifyPreparedSourcePlan(input: { withSourceFence?: <T>(callback: () => T) => T; planId: string; expectedRevision: number
    recheckedTreeDigest: string; recheckedPatchDigest: string }): OperationReceipt<PluginSourcePlan> {
    if (!DIGEST.test(input.recheckedTreeDigest) || !DIGEST.test(input.recheckedPatchDigest)) {
      throw new ControlPlaneStoreError('invalid-input', 'rechecked source digests must be 64-char hex')
    }
    const plan = this.getSourcePlan(input.planId)
    if (plan.mode !== 'modify') throw new ControlPlaneStoreError('invalid-state', 'only modify source plans are verified from prepared evidence')
    if (plan.revision !== input.expectedRevision) throw new ControlPlaneStoreError('conflict', 'source plan revision conflict')
    if (plan.status !== 'approved') throw new ControlPlaneStoreError('invalid-state', 'prepared source plan must be approved before verification')
    if (plan.sourceCheck === undefined || plan.preparedEvidence === undefined) {
      throw new ControlPlaneStoreError('invalid-state', 'approved modify plan is missing its prepared evidence')
    }
    const now = this.#now()
    if (now > plan.expiresAt) throw new ControlPlaneStoreError('expired', 'source plan verification is no longer applicable')
    if (plan.sourceCheck.treeDigest !== input.recheckedTreeDigest || plan.sourceCheck.patchDigest !== input.recheckedPatchDigest) {
      throw new ControlPlaneStoreError('conflict', 'rechecked source tree or patch drifted from the prepared evidence')
    }
    const commit = (): OperationReceipt<PluginSourcePlan> => {
      this.#assertOwnerTaskFailureGapAdmission(plan.gapId)
      this.#database.exec('BEGIN IMMEDIATE')
      try {
        const result = this.#database.prepare(`UPDATE source_plans SET status = 'ready-for-human-review', revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ? AND status = 'approved' AND mode = 'modify'
            AND checked_tree_digest = ? AND checked_patch_digest = ? AND plan_digest = ?`).run(
          now, plan.id, input.expectedRevision, input.recheckedTreeDigest, input.recheckedPatchDigest, plan.digest)
        if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source plan changed while prepared verification was applied')
        const output = this.getSourcePlan(plan.id)
        const inputDigest = controlPlaneDigest({ operation: 'source-verify-prepared', planId: output.id,
          planDigest: output.digest, recheckedTreeDigest: input.recheckedTreeDigest, recheckedPatchDigest: input.recheckedPatchDigest })
        const receipt = { idempotencyKey: `source-verify-prepared:${output.id}:${output.revision}`,
          operation: 'source-verify-prepared', inputDigest, result: output, createdAt: now }
        this.#insertReceipt(receipt)
        this.#database.exec('COMMIT')
        return receipt
      } catch (error) { this.#database.exec('ROLLBACK'); throw error }
    }
    return input.withSourceFence ? input.withSourceFence(commit) : commit()
  }

  async startSourceRelease(input: { planId: string; expectedRevision: number; authorization: SourceReleaseAuthorization;
    resolveAuthority: (authorization: SourceReleaseAuthorization) => SourceReleaseAuthorizationAuthority;
    idempotencyKey: string; withSourceFence?: <T>(callback: () => T) => T }): Promise<OperationReceipt<PluginSourcePlan>> {
    const withCurrentSource = <T>(gapId: string, callback: () => T): T => {
      const commit = () => { this.#assertOwnerTaskFailureGapAdmission(gapId); return callback() }
      return input.withSourceFence ? input.withSourceFence(commit) : commit()
    }
    const key = bounded(input.idempotencyKey, 'idempotencyKey', 160)
    if (!KEY.test(key)) throw new ControlPlaneStoreError('invalid-input', 'idempotencyKey has invalid syntax')
    const inputDigest = controlPlaneDigest({ operation: 'start-source-release', planId: input.planId,
      expectedRevision: input.expectedRevision, authorization: input.authorization })
    const replay = this.#sourcePlanReceipt(key, 'start-source-release', inputDigest, input.planId)
    if (replay !== undefined) {
      let verifiedAuthorization: PluginSourcePlan['releaseAuthorization']
      try {
        const parsed = parseSourceReleaseAuthorization(input.authorization)
        verifiedAuthorization = { ...parsed, signatureDigest: createHash('sha256')
          .update(Buffer.from(parsed.signature, 'base64')).digest('hex') }
      } catch { throw new ControlPlaneStoreError('invalid-state', 'source release replay authorization is corrupt') }
      if (replay.result.status !== 'awaiting-pr' || replay.result.revision !== input.expectedRevision + 1
        || replay.result.release?.fence !== 1 || replay.result.release.failureCode !== undefined
        || replay.result.release.failurePhase !== undefined || replay.result.release.updatedAt !== replay.createdAt
        || controlPlaneDigest(replay.result.releaseAuthorization) !== controlPlaneDigest(verifiedAuthorization)) {
        throw new ControlPlaneStoreError('invalid-state', 'stored source release start receipt is corrupt')
      }
      return withCurrentSource(replay.result.gapId, () => replay)
    }
    const plan = this.getSourcePlan(input.planId)
    if (plan.revision !== input.expectedRevision) throw new ControlPlaneStoreError('conflict', 'source release authorization targets a stale plan revision')
    if (plan.status !== 'ready-for-human-review' || plan.sourceCheck === undefined) {
      throw new ControlPlaneStoreError('invalid-state', 'source release requires verified source and a release authorization')
    }
    withCurrentSource(plan.gapId, () => {})
    const verified = await input.resolveAuthority(input.authorization).verify(input.authorization, plan)
    const now = this.#now()
    if (now > plan.expiresAt || now > verified.expiresAt) throw new ControlPlaneStoreError('expired', 'source release authorization is no longer applicable')
    return withCurrentSource(plan.gapId, () => {
      this.#database.exec('BEGIN IMMEDIATE')
      try {
        const releaseId = `release-${randomUUID()}`
        const result = this.#database.prepare(`UPDATE source_plans SET status = 'awaiting-pr', revision = revision + 1,
          release_authorization_json = ?, release_authorization_digest = ?, release_id = ?, release_fence = release_fence + 1,
          release_failure_phase = NULL, release_failure_code = NULL, updated_at = ?
          WHERE id = ? AND status = 'ready-for-human-review' AND revision = ? AND plan_digest = ?
            AND checked_tree_digest = ? AND checked_patch_digest = ? AND release_id IS NULL`).run(
          JSON.stringify(verified), controlPlaneDigest(verified), releaseId, now, plan.id, input.expectedRevision, plan.digest,
          plan.sourceCheck!.treeDigest, plan.sourceCheck!.patchDigest)
        if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source plan changed while release authorization was applied')
        const output = this.getSourcePlan(plan.id)
        const operationReceipt = { idempotencyKey: key, operation: 'start-source-release', inputDigest, result: output, createdAt: now }
        this.#insertReceipt(operationReceipt)
        this.#database.exec('COMMIT')
        return operationReceipt
      } catch (error) { this.#database.exec('ROLLBACK'); throw error }
    })
  }

  async prepareSourceReleaseOperation(input: PrepareSourceReleaseOperationInput): Promise<SourceReleaseOperation> {
    const withCurrentSource = <T>(gapId: string, callback: () => T): T => {
      const commit = () => { this.#assertOwnerTaskFailureGapAdmission(gapId); return callback() }
      return input.withSourceFence ? input.withSourceFence(commit) : commit()
    }
    const plan = this.getSourcePlan(input.planId); const expected = expectedSourceRelease(plan.status)
    if (expected === undefined) throw new ControlPlaneStoreError('invalid-state', 'source plan is not awaiting a release operation')
    if (plan.revision !== input.expectedRevision || plan.release?.fence !== input.expectedFence) {
      throw new ControlPlaneStoreError('conflict', 'source release operation targets a stale revision/fence')
    }
    if (plan.releaseAuthorization === undefined || plan.sourceCheck === undefined) {
      throw new ControlPlaneStoreError('invalid-state', 'source release operation has no durable post-check authorization')
    }
    withCurrentSource(plan.gapId, () => {})
    await reverifySourceReleaseAuthorization(plan.releaseAuthorization, plan, input.resolveAuthorizationAuthority)
    return withCurrentSource(plan.gapId, () => {
      const now = this.#now()
      this.#database.exec('BEGIN IMMEDIATE')
      try {
        const current = this.getSourcePlan(plan.id); const currentExpected = expectedSourceRelease(current.status)
        if (current.revision !== input.expectedRevision || current.release?.fence !== input.expectedFence
          || current.status !== plan.status || current.digest !== plan.digest || currentExpected?.phase !== expected.phase) {
          throw new ControlPlaneStoreError('conflict', 'source release operation changed during authorization verification')
        }
        this.#assertReleaseEnvironment(input, expected.phase)
        const previous = this.#previousReleaseEvidence(current, expected.phase)
        const priorRow = this.#database.prepare(`SELECT * FROM source_release_operations WHERE plan_id = ? AND phase = ?
          ORDER BY attempt DESC LIMIT 1`).get(current.id, expected.phase) as unknown as SourceReleaseOperationRow | undefined
        const attempt = priorRow !== undefined && priorRow.release_fence === current.release.fence
          ? priorRow.attempt : (priorRow?.attempt ?? 0) + 1
        if (priorRow !== undefined && priorRow.release_fence === current.release.fence) {
          const prior = sourceReleaseOperationFromRow(priorRow)
          const expectedRequest = this.#sourceReleaseRequest(current, expected.phase, prior.operationId, prior.attempt,
            prior.request.requestedAt, input, previous)
          if (prior.bindingDigest !== controlPlaneDigest(releaseRequestBinding(expectedRequest))) {
            throw new ControlPlaneStoreError('conflict', 'durable release operation payload changed for the same phase/fence')
          }
          this.#database.exec('COMMIT'); return prior
        }
        const operationId = `release-operation-${randomUUID()}`
        const request = this.#sourceReleaseRequest(current, expected.phase, operationId, attempt, now, input, previous)
        const bindingDigest = controlPlaneDigest(releaseRequestBinding(request))
        this.#database.prepare(`INSERT INTO source_release_operations (plan_id, phase, release_id, release_fence, attempt,
          operation_id, binding_digest, request_digest, request_json, status, receipt_digest, receipt_json, created_at, completed_at, applied_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, NULL)`).run(current.id, expected.phase,
          current.release.id, current.release.fence, attempt, operationId, bindingDigest, controlPlaneDigest(request), JSON.stringify(request), now)
        const operation = this.getSourceReleaseOperation(operationId)
        this.#database.exec('COMMIT'); return operation
      } catch (error) { this.#database.exec('ROLLBACK'); throw error }
    })
  }

  getSourceReleaseOperation(operationId: string): SourceReleaseOperation {
    const row = this.#database.prepare('SELECT * FROM source_release_operations WHERE operation_id = ?').get(operationId) as unknown as SourceReleaseOperationRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('not-found', 'source release operation not found')
    return sourceReleaseOperationFromRow(row)
  }

  findSourceReleaseOperation(planId: string, phase: SourceReleasePhase, fence: number): SourceReleaseOperation | undefined {
    const row = this.#database.prepare(`SELECT * FROM source_release_operations WHERE plan_id = ? AND phase = ?
      AND release_fence = ? ORDER BY attempt DESC LIMIT 1`).get(planId, phase, fence) as unknown as SourceReleaseOperationRow | undefined
    return row === undefined ? undefined : sourceReleaseOperationFromRow(row)
  }

  getSourceReleaseDispatchStatus(operationId: string): 'claimed' | 'completed' | undefined {
    const row = this.#database.prepare('SELECT * FROM source_release_dispatches WHERE operation_id = ?').get(operationId) as unknown as SourceReleaseDispatchRow | undefined
    if (row === undefined) return undefined
    if ((row.status !== 'claimed' && row.status !== 'completed') || !Number.isSafeInteger(row.claimed_at) || row.claimed_at < 0
      || (row.status === 'claimed') !== (row.completed_at === null)
      || (row.completed_at !== null && (!Number.isSafeInteger(row.completed_at) || row.completed_at < row.claimed_at))) {
      throw new ControlPlaneStoreError('invalid-state', 'stored source release dispatch is corrupt')
    }
    return row.status
  }

  sourceReleaseCandidate(planId: string): CatalogEntry {
    const plan = this.getSourcePlan(planId)
    if (plan.status !== 'release-complete') {
      throw new ControlPlaneStoreError('invalid-state', 'source candidate is not admitted until release completes')
    }
    return this.#releaseCandidate(plan)
  }

  previewSourceReleaseCandidate(planId: string): CatalogEntry {
    const plan = this.getSourcePlan(planId)
    if (plan.status !== 'awaiting-catalog-admission') {
      throw new ControlPlaneStoreError('invalid-state', 'source candidate is not ready for catalog admission')
    }
    return this.#releaseCandidate(plan)
  }

  #releaseCandidate(plan: PluginSourcePlan): CatalogEntry {
    return readReleaseCandidate(this.#database, plan)
  }

  async runSourceReleaseOperation(input: { withSourceFence?: <T>(callback: () => T) => T; operationId: string; expectedRevision: number; expectedFence: number;
    execute: (request: SourceReleaseRequest) => Promise<SourceReleaseReceipt>;
    resolveAuthority: (receipt: SourceReleaseReceipt) => SourceReleaseAuthority;
    resolveAuthorizationAuthority: (authorization: SourceReleaseAuthorization) => SourceReleaseAuthorizationAuthority }): Promise<SourceReleaseReceipt> {
    const withCurrentSource = <T>(gapId: string, callback: () => T): T => {
      const commit = () => { this.#assertOwnerTaskFailureGapAdmission(gapId); return callback() }
      return input.withSourceFence ? input.withSourceFence(commit) : commit()
    }
    const operation = this.getSourceReleaseOperation(input.operationId)
    const plan = this.getSourcePlan(operation.planId)
    const assertCurrent = (current: PluginSourcePlan, currentOperation: SourceReleaseOperation): void => {
      const currentExpected = expectedSourceRelease(current.status)
      if (current.revision !== input.expectedRevision || current.release?.fence !== input.expectedFence
        || currentOperation.fence !== input.expectedFence || currentExpected?.phase !== currentOperation.phase
        || currentOperation.requestDigest !== controlPlaneDigest(currentOperation.request)) {
        throw new ControlPlaneStoreError('conflict', 'source release operation lost its plan revision/fence/phase')
      }
    }
    assertCurrent(plan, operation)
    if (operation.receipt !== undefined) return withCurrentSource(plan.gapId, () => operation.receipt!)
    withCurrentSource(plan.gapId, () => {})
    await reverifySourceReleaseAuthorization(operation.request.authorization, plan, input.resolveAuthorizationAuthority)
    const claimed = withCurrentSource(plan.gapId, () => {
      this.#database.exec('BEGIN IMMEDIATE')
      try {
        const current = this.getSourcePlan(plan.id); const currentOperation = this.getSourceReleaseOperation(operation.operationId)
        assertCurrent(current, currentOperation)
        if (currentOperation.receipt !== undefined) { this.#database.exec('COMMIT'); return false }
        const dispatch = this.#database.prepare('SELECT * FROM source_release_dispatches WHERE operation_id = ?').get(operation.operationId) as unknown as SourceReleaseDispatchRow | undefined
        if (dispatch !== undefined) {
          this.getSourceReleaseDispatchStatus(operation.operationId)
          throw new ControlPlaneStoreError('conflict', 'source release operation outcome is unknown; receipt reconciliation is required')
        }
        this.#database.prepare(`INSERT INTO source_release_dispatches (operation_id, status, claimed_at, completed_at)
          VALUES (?, 'claimed', ?, NULL)`).run(operation.operationId, this.#now())
        this.#database.exec('COMMIT'); return true
      } catch (error) { this.#database.exec('ROLLBACK'); throw error }
    })
    if (!claimed) return this.getSourceReleaseOperation(operation.operationId).receipt!
    const receipt = await input.execute(operation.request)
    await input.resolveAuthority(receipt).verify(receipt, plan, operation.request)
    return withCurrentSource(plan.gapId, () => {
      this.#database.exec('BEGIN IMMEDIATE')
      try {
        const current = this.getSourcePlan(plan.id); const currentOperation = this.getSourceReleaseOperation(operation.operationId)
        assertCurrent(current, currentOperation)
        const dispatch = this.#database.prepare('SELECT * FROM source_release_dispatches WHERE operation_id = ?').get(operation.operationId) as unknown as SourceReleaseDispatchRow | undefined
        if (dispatch === undefined || dispatch.status !== 'claimed') throw new ControlPlaneStoreError('conflict', 'source release completion lost its dispatch claim')
        const now = this.#now()
        const result = this.#database.prepare(`UPDATE source_release_operations SET status = 'completed', receipt_digest = ?,
          receipt_json = ?, completed_at = ? WHERE operation_id = ? AND status = 'pending' AND request_digest = ?
            AND release_fence = ?`).run(controlPlaneDigest(receipt), JSON.stringify(receipt), now, operation.operationId,
          operation.requestDigest, input.expectedFence)
        if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source release completion lost its single-flight')
        const completed = this.#database.prepare(`UPDATE source_release_dispatches SET status = 'completed', completed_at = ?
          WHERE operation_id = ? AND status = 'claimed'`).run(now, operation.operationId)
        if (Number(completed.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source release completion lost its dispatch claim')
        this.#database.exec('COMMIT'); return receipt
      } catch (error) { this.#database.exec('ROLLBACK'); throw error }
    })
  }

  /**
   * Reconciles a signed receipt for a durably claimed dispatch without
   * invoking an adapter again. This is the only recovery path for a lost
   * adapter response.
   */
  async acceptSourceReleaseReceipt(input: { withSourceFence?: <T>(callback: () => T) => T; operationId: string; expectedRevision: number; expectedFence: number;
    receipt: SourceReleaseReceipt; resolveAuthority: (receipt: SourceReleaseReceipt) => SourceReleaseAuthority;
    resolveAuthorizationAuthority: (authorization: SourceReleaseAuthorization) => SourceReleaseAuthorizationAuthority }): Promise<SourceReleaseReceipt> {
    const withCurrentSource = <T>(gapId: string, callback: () => T): T => {
      const commit = () => { this.#assertOwnerTaskFailureGapAdmission(gapId); return callback() }
      return input.withSourceFence ? input.withSourceFence(commit) : commit()
    }
    const operation = this.getSourceReleaseOperation(input.operationId), plan = this.getSourcePlan(operation.planId)
    const assertCurrent = (current: PluginSourcePlan, currentOperation: SourceReleaseOperation): void => {
      const expected = expectedSourceRelease(current.status)
      if (current.revision !== input.expectedRevision || current.release?.fence !== input.expectedFence
        || currentOperation.fence !== input.expectedFence || expected?.phase !== currentOperation.phase
        || currentOperation.requestDigest !== controlPlaneDigest(currentOperation.request)) {
        throw new ControlPlaneStoreError('conflict', 'source release receipt lost its plan revision/fence/phase')
      }
    }
    assertCurrent(plan, operation)
    if (operation.receipt !== undefined) {
      if (controlPlaneDigest(operation.receipt) !== controlPlaneDigest(input.receipt)) throw new ControlPlaneStoreError('conflict', 'source release receipt differs from completed operation')
      return withCurrentSource(plan.gapId, () => operation.receipt!)
    }
    withCurrentSource(plan.gapId, () => {})
    await reverifySourceReleaseAuthorization(operation.request.authorization, plan, input.resolveAuthorizationAuthority)
    await input.resolveAuthority(input.receipt).verify(input.receipt, plan, operation.request)
    return withCurrentSource(plan.gapId, () => {
      this.#database.exec('BEGIN IMMEDIATE')
      try {
        const current = this.getSourcePlan(plan.id), currentOperation = this.getSourceReleaseOperation(operation.operationId)
        assertCurrent(current, currentOperation)
        if (currentOperation.receipt !== undefined) {
          if (controlPlaneDigest(currentOperation.receipt) !== controlPlaneDigest(input.receipt)) throw new ControlPlaneStoreError('conflict', 'source release receipt differs from completed operation')
          this.#database.exec('COMMIT'); return currentOperation.receipt
        }
        const dispatch = this.#database.prepare('SELECT * FROM source_release_dispatches WHERE operation_id = ?').get(operation.operationId) as unknown as SourceReleaseDispatchRow | undefined
        if (dispatch !== undefined && dispatch.status !== 'claimed') throw new ControlPlaneStoreError('conflict', 'source release receipt has no unresolved dispatch claim')
        const now = this.#now()
        const result = this.#database.prepare(`UPDATE source_release_operations SET status = 'completed', receipt_digest = ?, receipt_json = ?, completed_at = ?
          WHERE operation_id = ? AND status = 'pending' AND request_digest = ? AND release_fence = ?`).run(
          controlPlaneDigest(input.receipt), JSON.stringify(input.receipt), now, operation.operationId, operation.requestDigest, input.expectedFence)
        if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source release receipt lost its completion CAS')
        if (dispatch !== undefined) {
          const completed = this.#database.prepare(`UPDATE source_release_dispatches SET status = 'completed', completed_at = ?
            WHERE operation_id = ? AND status = 'claimed'`).run(now, operation.operationId)
          if (Number(completed.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source release receipt lost its dispatch claim')
        }
        this.#database.exec('COMMIT'); return input.receipt
      } catch (error) { this.#database.exec('ROLLBACK'); throw error }
    })
  }

  async applySourceRelease(input: { withSourceFence?: <T>(callback: () => T) => T; planId: string; expectedRevision: number; expectedFence: number;
    receipt: SourceReleaseReceipt; resolveAuthority: (receipt: SourceReleaseReceipt) => SourceReleaseAuthority;
    idempotencyKey: string }): Promise<OperationReceipt<PluginSourcePlan>> {
    const withCurrentSource = <T>(gapId: string, callback: () => T): T => {
      const commit = () => { this.#assertOwnerTaskFailureGapAdmission(gapId); return callback() }
      return input.withSourceFence ? input.withSourceFence(commit) : commit()
    }
    const key = bounded(input.idempotencyKey, 'idempotencyKey', 160)
    if (!KEY.test(key)) throw new ControlPlaneStoreError('invalid-input', 'idempotencyKey has invalid syntax')
    const inputDigest = controlPlaneDigest({ operation: 'source-release', planId: input.planId, expectedRevision: input.expectedRevision,
      expectedFence: input.expectedFence, receipt: input.receipt })
    const replay = this.#sourcePlanReceipt(key, 'source-release', inputDigest, input.planId)
    if (replay !== undefined) {
      const expectedStatus: SourcePlanStatus = input.receipt.outcome === 'passed'
        ? Object.values(expectedRelease).find(item => item.phase === input.receipt.phase)?.next ?? 'release-failed'
        : input.receipt.outcome === 'ambiguous' ? 'publish-ambiguous' : 'release-failed'
      const expectedFailure = input.receipt.outcome === 'failed' && input.receipt.evidence.kind === 'failure'
        ? `${input.receipt.evidence.code}${input.receipt.evidence.remoteState === 'unchanged' ? '' : `:${input.receipt.evidence.remoteState}`}`
        : input.receipt.outcome === 'ambiguous' ? 'publish-ambiguous' : undefined
      if (replay.result.status !== expectedStatus || replay.result.revision !== input.expectedRevision + 1
        || replay.result.release?.fence !== input.expectedFence || replay.result.release.failureCode !== expectedFailure
        || replay.result.release.failurePhase !== (input.receipt.outcome === 'passed' ? undefined : input.receipt.phase)
        || replay.result.release.updatedAt !== replay.createdAt) {
        throw new ControlPlaneStoreError('invalid-state', 'stored source release apply receipt is corrupt')
      }
      return withCurrentSource(replay.result.gapId, () => replay)
    }
    const plan = this.getSourcePlan(input.planId); const expected = expectedSourceRelease(plan.status)
    if (expected === undefined) throw new ControlPlaneStoreError('invalid-state', 'source plan is not awaiting a release receipt')
    if (plan.revision !== input.expectedRevision || plan.release?.fence !== input.expectedFence) {
      throw new ControlPlaneStoreError('conflict', 'source release receipt targets a stale revision/fence')
    }
    const operation = this.getSourceReleaseOperation(input.receipt.operationId)
    if (operation.planId !== plan.id || operation.phase !== expected.phase || operation.fence !== input.expectedFence
      || operation.status !== 'completed' || operation.receipt === undefined
      || controlPlaneDigest(operation.receipt) !== controlPlaneDigest(input.receipt)) {
      throw new ControlPlaneStoreError('conflict', 'release receipt was not completed by the durable fenced phase operation')
    }
    withCurrentSource(plan.gapId, () => {})
    const verified = await input.resolveAuthority(input.receipt).verify(input.receipt, plan, operation.request)
    let nextStatus: SourcePlanStatus
    let failurePhase: SourceReleasePhase | null = null; let failureCode: string | null = null
    if (verified.outcome === 'passed') nextStatus = expected.next
    else if (verified.outcome === 'ambiguous') {
      if (expected.phase !== 'publish') throw new ControlPlaneStoreError('invalid-state', 'only publish may enter ambiguous state')
      nextStatus = 'publish-ambiguous'; failurePhase = 'publish'; failureCode = 'publish-ambiguous'
    } else {
      nextStatus = 'release-failed'; failurePhase = expected.phase
      failureCode = verified.evidence.kind === 'failure'
        ? `${verified.evidence.code}${verified.evidence.remoteState === 'unchanged' ? '' : `:${verified.evidence.remoteState}`}` : 'release-failed'
    }
    const now = this.#now()
    return withCurrentSource(plan.gapId, () => {
      this.#database.exec('BEGIN IMMEDIATE')
      try {
      const current = this.getSourcePlan(plan.id)
      const currentExpected = expectedSourceRelease(current.status)
      if (current.revision !== input.expectedRevision || current.release?.fence !== input.expectedFence
        || current.status !== plan.status || current.digest !== plan.digest || currentExpected?.phase !== expected.phase) {
        throw new ControlPlaneStoreError('conflict', 'source release receipt changed during verification')
      }
      const currentOperation = this.getSourceReleaseOperation(input.receipt.operationId)
      if (currentOperation.planId !== current.id || currentOperation.phase !== expected.phase || currentOperation.fence !== input.expectedFence
        || currentOperation.status !== 'completed' || currentOperation.receipt === undefined
        || controlPlaneDigest(currentOperation.receipt) !== controlPlaneDigest(input.receipt)) {
        throw new ControlPlaneStoreError('conflict', 'release receipt changed during verification')
      }
      const result = this.#database.prepare(`UPDATE source_plans SET status = ?, revision = revision + 1,
        release_failure_phase = ?, release_failure_code = ?, updated_at = ?
        WHERE id = ? AND status = ? AND revision = ? AND release_id = ? AND release_fence = ?`).run(
        nextStatus, failurePhase, failureCode, now, current.id, current.status, current.revision, current.release.id, input.expectedFence)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source release receipt lost its plan CAS')
      const applied = this.#database.prepare(`UPDATE source_release_operations SET status = 'applied', applied_at = ?
        WHERE operation_id = ? AND status = 'completed' AND receipt_digest = ? AND release_fence = ?`).run(
        now, currentOperation.operationId, controlPlaneDigest(input.receipt), input.expectedFence)
      if (Number(applied.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source release operation lost its apply CAS')
      const output = this.getSourcePlan(current.id)
      if (nextStatus === 'release-complete') {
        const candidateId = verified.evidence.kind === 'catalog-admission' ? verified.evidence.candidate.id : undefined
        if (candidateId === undefined) throw new ControlPlaneStoreError('invalid-state', 'release completion has no admitted candidate')
        this.#database.prepare(`UPDATE capability_gaps SET status = 'open', candidate_id = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'matched'`).run(candidateId, now, output.gapId)
        this.#database.prepare('DELETE FROM gap_plan_claims WHERE gap_id = ? AND plan_id = ?').run(output.gapId, output.id)
      } else if (nextStatus === 'release-failed' && verified.evidence.kind === 'failure'
        && verified.evidence.remoteState === 'unchanged') {
        this.#database.prepare('DELETE FROM gap_plan_claims WHERE gap_id = ? AND plan_id = ?').run(output.gapId, output.id)
        this.#database.prepare(`UPDATE capability_gaps SET status = 'open', candidate_id = NULL, revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'matched'`).run(now, output.gapId)
      }
      const operationReceipt = { idempotencyKey: key, operation: 'source-release', inputDigest, result: output, createdAt: now }
      this.#insertReceipt(operationReceipt)
      this.#database.exec('COMMIT')
      return operationReceipt
      } catch (error) { this.#database.exec('ROLLBACK'); throw error }
    })
  }

  async prepareSourcePublishReconciliation(input: PrepareSourcePublishReconciliationInput): Promise<SourcePublishReconciliationOperation> {
    const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const plan = this.getSourcePlan(input.planId)
      if (plan.status !== 'publish-ambiguous' || plan.revision !== input.expectedRevision || plan.release?.fence !== input.expectedFence) {
        throw new ControlPlaneStoreError('conflict', 'publish reconciliation targets a stale ambiguous release')
      }
      if (plan.releaseAuthorization === undefined) throw new ControlPlaneStoreError('invalid-state', 'publish reconciliation lacks release authorization')
      await reverifySourceReleaseAuthorization(plan.releaseAuthorization, plan, input.resolveAuthorizationAuthority)
      this.#assertReconciliationEnvironment(input)
      const publishRow = this.#database.prepare(`SELECT * FROM source_release_operations WHERE plan_id = ? AND phase = 'publish'
        AND release_fence = ? ORDER BY attempt DESC LIMIT 1`).get(plan.id, input.expectedFence) as unknown as SourceReleaseOperationRow | undefined
      if (publishRow === undefined) throw new ControlPlaneStoreError('invalid-state', 'ambiguous release has no durable publish operation')
      const publish = sourceReleaseOperationFromRow(publishRow)
      if (publish.status !== 'applied' || publish.receipt?.outcome !== 'ambiguous' || publish.receipt.evidence.kind !== 'publish-ambiguity') {
        throw new ControlPlaneStoreError('invalid-state', 'publish reconciliation has no durable ambiguity evidence')
      }
      if (publish.request.phase !== 'publish') throw new ControlPlaneStoreError('invalid-state', 'ambiguous operation is not publish')
      const priorRow = this.#database.prepare(`SELECT * FROM source_publish_reconciliations WHERE plan_id = ?
        ORDER BY attempt DESC LIMIT 1`).get(plan.id) as unknown as SourcePublishReconciliationRow | undefined
      const reusable = priorRow?.release_fence === plan.release.fence && priorRow.status !== 'applied'
      const attempt = reusable ? priorRow.attempt : (priorRow?.attempt ?? 0) + 1
      const operationId = reusable ? priorRow.operation_id : `publish-reconciliation-${randomUUID()}`
      const requestedAt = reusable ? priorRow.created_at : now
      const request: SourcePublishReconciliationRequest = { schemaVersion: 1, kind: 'dsh-source-publish-reconciliation-request',
        operationId, attempt, requestedAt, receiptTtlMs: input.receiptTtlMs, installationId: input.installationId, ledger: input.ledger,
        plan: { id: plan.id, digest: plan.digest, revision: plan.revision }, release: { id: plan.release.id, fence: plan.release.fence },
        authorization: plan.releaseAuthorization, adapter: input.adapter, registry: input.registry,
        ambiguousPublish: { operationId: publish.operationId, receiptId: publish.receipt.receiptId,
          receiptDigest: controlPlaneDigest(publish.receipt), evidenceDigest: publish.receipt.evidenceDigest },
        artifact: { packageName: publish.request.input.artifact.packageName, packageVersion: publish.request.input.artifact.packageVersion,
          tarballSha256: publish.request.input.artifact.tarballSha256, tarballIntegrity: publish.request.input.artifact.tarballIntegrity },
        expectedArtifactStatementDigest: publish.request.input.artifactStatementDigest,
        expectedArtifactSignatureDigest: createHash('sha256').update(Buffer.from(publish.request.input.artifactSignature, 'base64')).digest('hex'),
        expectedRegistryReference: plan.releaseAuthorization.releasePolicy.registryReference }
      const parsed = parseSourcePublishReconciliationRequest(request); const bindingDigest = controlPlaneDigest(reconciliationBinding(parsed))
      if (reusable && priorRow !== undefined) {
        const prior = sourcePublishReconciliationFromRow(priorRow)
        if (prior.bindingDigest !== bindingDigest) throw new ControlPlaneStoreError('conflict', 'durable publish reconciliation payload changed')
        this.#database.exec('COMMIT'); return prior
      }
      this.#database.prepare(`INSERT INTO source_publish_reconciliations (plan_id, release_id, release_fence, attempt, operation_id,
        binding_digest, request_digest, request_json, status, receipt_digest, receipt_json, created_at, completed_at, applied_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, NULL)`).run(plan.id, plan.release.id, plan.release.fence,
        attempt, operationId, bindingDigest, controlPlaneDigest(parsed), JSON.stringify(parsed), now)
      const operation = this.getSourcePublishReconciliationOperation(operationId)
      this.#database.exec('COMMIT'); return operation
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  getSourcePublishReconciliationOperation(operationId: string): SourcePublishReconciliationOperation {
    const row = this.#database.prepare('SELECT * FROM source_publish_reconciliations WHERE operation_id = ?').get(operationId) as unknown as SourcePublishReconciliationRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('not-found', 'publish reconciliation operation not found')
    return sourcePublishReconciliationFromRow(row)
  }

  async runSourcePublishReconciliation(input: { operationId: string; expectedRevision: number; expectedFence: number;
    execute: (request: SourcePublishReconciliationRequest) => Promise<SourcePublishReconciliationReceipt>;
    resolveAuthority: (receipt: SourcePublishReconciliationReceipt) => SourcePublishReconciliationAuthority;
    resolveAuthorizationAuthority: (authorization: SourceReleaseAuthorization) => SourceReleaseAuthorizationAuthority }): Promise<SourcePublishReconciliationReceipt> {
    try { this.#database.exec('BEGIN IMMEDIATE') } catch { throw new ControlPlaneStoreError('conflict', 'publish reconciliation single-flight is held') }
    try {
      const operation = this.getSourcePublishReconciliationOperation(input.operationId); const plan = this.getSourcePlan(operation.planId)
      if (plan.status !== 'publish-ambiguous' || plan.revision !== input.expectedRevision || plan.release?.fence !== input.expectedFence
        || operation.fence !== input.expectedFence) throw new ControlPlaneStoreError('conflict', 'publish reconciliation lost its revision/fence')
      if (operation.receipt !== undefined) { this.#database.exec('COMMIT'); return operation.receipt }
      await reverifySourceReleaseAuthorization(operation.request.authorization, plan, input.resolveAuthorizationAuthority)
      const receipt = await input.execute(operation.request)
      await input.resolveAuthority(receipt).verify(receipt, plan, operation.request)
      const now = this.#now(); const result = this.#database.prepare(`UPDATE source_publish_reconciliations SET status = 'completed',
        receipt_digest = ?, receipt_json = ?, completed_at = ? WHERE operation_id = ? AND status = 'pending' AND request_digest = ?`).run(
        controlPlaneDigest(receipt), JSON.stringify(receipt), now, operation.operationId, operation.requestDigest)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'publish reconciliation completion lost single-flight')
      this.#database.exec('COMMIT'); return receipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  async reconcileSourcePublish(input: { planId: string; expectedRevision: number; expectedFence: number;
    receipt: SourcePublishReconciliationReceipt; resolveAuthority: (receipt: SourcePublishReconciliationReceipt) => SourcePublishReconciliationAuthority;
    idempotencyKey: string }): Promise<OperationReceipt<PluginSourcePlan>> {
    const inputDigest = controlPlaneDigest({ operation: 'reconcile-source-publish', planId: input.planId, expectedRevision: input.expectedRevision,
      expectedFence: input.expectedFence, receipt: input.receipt })
    const replay = this.#sourcePlanReceipt(input.idempotencyKey, 'reconcile-source-publish', inputDigest, input.planId)
    if (replay !== undefined) {
      const outcome = input.receipt.evidence.outcome
      const expectedStatus: SourcePlanStatus = outcome === 'exists-match' ? 'awaiting-registry-verify'
        : outcome === 'absent' ? 'awaiting-publish' : outcome === 'digest-conflict' ? 'release-failed' : 'publish-ambiguous'
      const expectedFence = outcome === 'absent' ? input.expectedFence + 1 : input.expectedFence
      const expectedFailure = outcome === 'digest-conflict' ? 'publish-digest-conflict'
        : outcome === 'unknown' ? 'publish-ambiguous' : undefined
      if (replay.result.status !== expectedStatus || replay.result.revision !== input.expectedRevision + 1
        || replay.result.release?.fence !== expectedFence || replay.result.release.failureCode !== expectedFailure
        || replay.result.release.failurePhase !== (outcome === 'exists-match' || outcome === 'absent' ? undefined : 'publish')
        || replay.result.release.updatedAt !== replay.createdAt) {
        throw new ControlPlaneStoreError('invalid-state', 'stored publish reconciliation apply receipt is corrupt')
      }
      return replay
    }
    const plan = this.getSourcePlan(input.planId); const operation = this.getSourcePublishReconciliationOperation(input.receipt.operationId)
    if (plan.status !== 'publish-ambiguous' || plan.revision !== input.expectedRevision || plan.release?.fence !== input.expectedFence
      || operation.planId !== plan.id || operation.fence !== input.expectedFence || operation.status !== 'completed'
      || operation.receipt === undefined || controlPlaneDigest(operation.receipt) !== controlPlaneDigest(input.receipt)) {
      throw new ControlPlaneStoreError('conflict', 'publish reconciliation receipt is not the completed fenced operation')
    }
    const verified = await input.resolveAuthority(input.receipt).verify(input.receipt, plan, operation.request)
    const outcome = verified.evidence.outcome; const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      let nextStatus: SourcePlanStatus = 'publish-ambiguous'; let nextFence = input.expectedFence
      let failurePhase: SourceReleasePhase | null = 'publish'; let failureCode: string | null = 'publish-ambiguous'
      if (outcome === 'exists-match') {
        nextStatus = 'awaiting-registry-verify'; failurePhase = null; failureCode = null
      } else if (outcome === 'absent') {
        nextStatus = 'awaiting-publish'; nextFence += 1; failurePhase = null; failureCode = null
      } else if (outcome === 'digest-conflict') {
        nextStatus = 'release-failed'; failureCode = 'publish-digest-conflict'
      }
      const result = this.#database.prepare(`UPDATE source_plans SET status = ?, revision = revision + 1, release_fence = ?,
        release_failure_phase = ?, release_failure_code = ?, updated_at = ?
        WHERE id = ? AND status = 'publish-ambiguous' AND revision = ? AND release_id = ? AND release_fence = ?`).run(
        nextStatus, nextFence, failurePhase, failureCode, now, plan.id, input.expectedRevision, plan.release.id, input.expectedFence)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'publish reconciliation lost its CAS/fence')
      const applied = this.#database.prepare(`UPDATE source_publish_reconciliations SET status = 'applied', applied_at = ?
        WHERE operation_id = ? AND status = 'completed' AND receipt_digest = ?`).run(now, operation.operationId, controlPlaneDigest(input.receipt))
      if (Number(applied.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'publish reconciliation lost its apply CAS')
      const output = this.getSourcePlan(plan.id)
      const operationReceipt = { idempotencyKey: input.idempotencyKey, operation: 'reconcile-source-publish', inputDigest, result: output, createdAt: now }
      this.#insertReceipt(operationReceipt)
      this.#database.exec('COMMIT')
      return operationReceipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  #assertReconciliationEnvironment(input: PrepareSourcePublishReconciliationInput): void {
    if (!UUID.test(input.installationId) || !UUID.test(input.ledger.id) || !isAbsolute(input.ledger.path)
      || !KEY.test(input.registry.id) || !KEY.test(input.adapter.id) || !DIGEST.test(input.adapter.sha256)
      || !isAbsolute(input.adapter.path) || input.adapter.id === '' || input.receiptTtlMs < 1_000 || input.receiptTtlMs > 300_000) {
      throw new ControlPlaneStoreError('invalid-input', 'publish reconciliation environment is invalid')
    }
  }

  #assertReleaseEnvironment(input: PrepareSourceReleaseOperationInput, phase: SourceReleasePhase): void {
    if (!UUID.test(input.installationId) || !UUID.test(input.ledger.id) || !isAbsolute(input.ledger.path)
      || !KEY.test(bounded(input.registry.id, 'registry.id', 160)) || !KEY.test(bounded(input.catalog.id, 'catalog.id', 160))
      || !isAbsolute(input.catalog.path) || !KEY.test(bounded(input.adapter.id, 'adapter.id', 160))
      || !DIGEST.test(input.adapter.sha256) || !isAbsolute(input.adapter.path)
      || !KEY.test(bounded(input.adapter.authority, 'adapter.authority', 160)) || !KEY.test(bounded(input.adapter.keyId, 'adapter.keyId', 160))
      || (input.adapter.interpreter !== null && (!isAbsolute(input.adapter.interpreter.path) || !DIGEST.test(input.adapter.interpreter.sha256)))) {
      throw new ControlPlaneStoreError('invalid-input', 'source release environment binding is invalid')
    }
    bounded(input.ledger.path, 'ledger.path', 2_000); bounded(input.registry.locator, 'registry.locator', 2_000)
    bounded(input.catalog.path, 'catalog.path', 2_000); bounded(input.adapter.version, 'adapter.version', 160)
    if (!Number.isSafeInteger(input.receiptTtlMs) || input.receiptTtlMs < 1_000 || input.receiptTtlMs > 300_000) {
      throw new ControlPlaneStoreError('invalid-input', 'source release receipt TTL is invalid')
    }
    if (phase === 'catalog-admission' && (!DIGEST.test(input.catalog.expectedBeforeDigest ?? '')
      || !DIGEST.test(input.catalog.expectedAfterDigest ?? '') || input.catalog.expectedBeforeDigest === input.catalog.expectedAfterDigest)) {
      throw new ControlPlaneStoreError('invalid-input', 'catalog admission requires exact distinct before/after catalog digests')
    }
  }

  #previousReleaseEvidence(plan: PluginSourcePlan, phase: SourceReleasePhase): Partial<Record<SourceReleasePhase, SourceReleaseSuccessEvidence>> {
    const ordered: readonly SourceReleasePhase[] = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission']
    const before = ordered.slice(0, ordered.indexOf(phase))
    const result: Partial<Record<SourceReleasePhase, SourceReleaseSuccessEvidence>> = {}
    for (const previousPhase of before) {
      const row = this.#database.prepare(`SELECT * FROM source_release_operations WHERE plan_id = ? AND phase = ?
        AND status = 'applied' ORDER BY attempt DESC LIMIT 1`).get(plan.id, previousPhase) as unknown as SourceReleaseOperationRow | undefined
      if (row === undefined) throw new ControlPlaneStoreError('invalid-state', `source release is missing applied ${previousPhase} evidence`)
      const operation = sourceReleaseOperationFromRow(row); const receipt = operation.receipt
      if (receipt === undefined || receipt.outcome !== 'passed' || receipt.evidence.kind === 'failure'
        || receipt.evidence.kind === 'publish-ambiguity') {
        if (previousPhase === 'publish' && receipt?.outcome === 'ambiguous'
          && this.#hasMatchingPublishReconciliation(plan.id, operation.fence)) continue
        throw new ControlPlaneStoreError('invalid-state', `source release has no successful ${previousPhase} evidence`)
      }
      result[previousPhase] = receipt.evidence
    }
    return result
  }

  #sourceReleaseRequest(plan: PluginSourcePlan, phase: SourceReleasePhase, operationId: string, attempt: number,
    requestedAt: number, binding: PrepareSourceReleaseOperationInput,
    evidence: Partial<Record<SourceReleasePhase, SourceReleaseSuccessEvidence>>): SourceReleaseRequest {
    if (plan.release === undefined || plan.releaseAuthorization === undefined || plan.sourceCheck === undefined) {
      throw new ControlPlaneStoreError('invalid-state', 'source release request is missing durable authorization bindings')
    }
    const base = { schemaVersion: 1 as const, kind: 'dsh-source-release-request' as const, operationId, attempt, requestedAt,
      receiptTtlMs: binding.receiptTtlMs, installationId: binding.installationId, ledger: binding.ledger,
      plan: { id: plan.id, digest: plan.digest, revision: plan.revision }, release: { id: plan.release.id, fence: plan.release.fence },
      authorization: plan.releaseAuthorization, adapter: binding.adapter, registry: binding.registry,
      catalog: { id: binding.catalog.id, path: binding.catalog.path } }
    const pr = evidence.pr; const review = evidence.review; const merge = evidence.merge; const build = evidence.build
    const signed = evidence.sign; const verified = evidence['registry-verify']
    const published = evidence.publish ?? ((phase === 'registry-verify' || phase === 'catalog-admission')
      && build?.kind === 'build' && signed?.kind === 'sign' ? this.#reconciledPublishEvidence(plan, build, signed) : undefined)
    if (phase === 'pr') return { ...base, phase, input: { repository: plan.repository, worktree: plan.worktree,
      baseCommit: plan.baseCommit, name: plan.name, scope: plan.scope, expectedTreeDigest: plan.sourceCheck.treeDigest,
      expectedPatchDigest: plan.sourceCheck.patchDigest } }
    if (phase === 'review' && pr?.kind === 'pr') return { ...base, phase, input: { prId: pr.prId,
      headCommit: pr.headCommit, baseCommit: pr.baseCommit, prEvidenceDigest: controlPlaneDigest(pr) } }
    if (phase === 'merge' && pr?.kind === 'pr' && review?.kind === 'review') return { ...base, phase, input: { prId: pr.prId,
      headCommit: pr.headCommit, reviewId: review.reviewId, reviewEvidenceDigest: controlPlaneDigest(review),
      targetBranch: plan.releaseAuthorization.releasePolicy.targetBranch } }
    if (phase === 'build' && merge?.kind === 'merge') {
      const policy = plan.releaseAuthorization.releasePolicy
      return { ...base, phase, input: { repository: plan.repository, mergeCommit: merge.mergeCommit,
        mergeEvidenceDigest: controlPlaneDigest(merge), name: plan.name, expectedCandidateId: policy.candidateId,
        expectedPackageName: policy.packageName, expectedPackageVersion: policy.packageVersion, expectedPackagePath: policy.packagePath,
        expectedDshBaseline: policy.dshBaseline, expectedCapabilities: policy.capabilities, expectedAuthorities: policy.authorities,
        expectedRequires: policy.requires } }
    }
    if (phase === 'sign' && build?.kind === 'build') return { ...base, phase, input: { artifact: releaseArtifact(build),
      buildEvidenceDigest: controlPlaneDigest(build) } }
    if (phase === 'publish' && build?.kind === 'build' && signed?.kind === 'sign') return { ...base, phase, input: {
      artifact: releaseArtifact(build), artifactStatementDigest: signed.artifactStatementDigest,
      artifactSignature: signed.artifactSignature, signEvidenceDigest: controlPlaneDigest(signed) } }
    if (phase === 'registry-verify' && build?.kind === 'build' && signed?.kind === 'sign') {
      const publish = published?.kind === 'publish' ? published : this.#reconciledPublishEvidence(plan, build, signed)
      return { ...base, phase, input: { artifact: releaseArtifact(build), artifactStatementDigest: signed.artifactStatementDigest,
        artifactSignature: signed.artifactSignature, registryReference: publish.registryReference,
        publishEvidenceDigest: controlPlaneDigest(publish) } }
    }
    if (phase === 'catalog-admission' && build?.kind === 'build' && signed?.kind === 'sign' && published?.kind === 'publish'
      && verified?.kind === 'registry-verify' && binding.catalog.expectedBeforeDigest !== undefined
      && binding.catalog.expectedAfterDigest !== undefined) {
      const registryVerification = this.#successfulSourceReleaseOperation(plan, 'registry-verify')
      if (registryVerification.request.phase !== 'registry-verify') {
        throw new ControlPlaneStoreError('invalid-state', 'durable registry verification request has the wrong phase')
      }
      const artifact = releaseArtifact(build)
      const candidate = parseCatalog({ schemaVersion: 1, entries: [{ id: artifact.candidateId, package: artifact.packageName,
        version: artifact.packageVersion, integrity: artifact.tarballIntegrity, dshBaseline: artifact.dshBaseline,
        registry: { id: plan.releaseAuthorization.releasePolicy.registryId, locator: plan.releaseAuthorization.releasePolicy.registryLocator,
          reference: published.registryReference },
        capabilities: artifact.capabilities, authorities: artifact.authorities, requires: artifact.requires }] }).entries[0]!
      return { ...base, phase, input: { artifact, artifactStatementDigest: signed.artifactStatementDigest,
        artifactSignature: signed.artifactSignature, registryReference: published.registryReference,
        registryVerificationRequest: registryVerification.request, registryVerificationReceipt: registryVerification.receipt,
        verificationEvidenceDigest: controlPlaneDigest(verified), expectedBeforeCatalogDigest: binding.catalog.expectedBeforeDigest,
        expectedAfterCatalogDigest: binding.catalog.expectedAfterDigest, candidate } }
    }
    throw new ControlPlaneStoreError('invalid-state', `source release cannot derive the exact ${phase} request`)
  }

  #successfulSourceReleaseOperation(plan: PluginSourcePlan, phase: SourceReleasePhase):
  SourceReleaseOperation & { receipt: SourceReleaseReceipt } {
    const row = this.#database.prepare(`SELECT * FROM source_release_operations WHERE plan_id = ? AND phase = ?
      AND status = 'applied' ORDER BY attempt DESC LIMIT 1`).get(plan.id, phase) as unknown as SourceReleaseOperationRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('invalid-state', `source release is missing applied ${phase} receipt`)
    const operation = sourceReleaseOperationFromRow(row); const receipt = operation.receipt
    if (receipt === undefined || receipt.outcome !== 'passed' || receipt.phase !== phase
      || operation.request.release.id !== plan.release?.id || operation.request.release.fence !== plan.release.fence) {
      throw new ControlPlaneStoreError('invalid-state', `source release has no current successful ${phase} receipt`)
    }
    return { ...operation, receipt }
  }

  #reconciledPublishEvidence(plan: PluginSourcePlan, build: Extract<SourceReleaseSuccessEvidence, { kind: 'build' }>,
    signed: Extract<SourceReleaseSuccessEvidence, { kind: 'sign' }>): Extract<SourceReleaseSuccessEvidence, { kind: 'publish' }> {
    const row = this.#database.prepare(`SELECT * FROM source_publish_reconciliations WHERE plan_id = ? AND release_id = ?
      AND status = 'applied' ORDER BY attempt DESC LIMIT 1`).get(plan.id, plan.release!.id) as unknown as SourcePublishReconciliationRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('invalid-state', 'registry verification has no publish or reconciliation evidence')
    const reconciliation = sourcePublishReconciliationFromRow(row); const evidence = reconciliation.receipt?.evidence
    if (reconciliation.receipt === undefined || evidence?.outcome !== 'exists-match' || evidence.registryReference === null) {
      throw new ControlPlaneStoreError('invalid-state', 'publish reconciliation did not prove an exact registry match')
    }
    const policy = plan.releaseAuthorization!.releasePolicy
    return { kind: 'publish', registryId: policy.registryId,
      registryReference: evidence.registryReference, packageName: build.packageName,
      packageVersion: build.packageVersion, tarballSha256: build.tarballSha256, tarballIntegrity: build.tarballIntegrity,
      artifactStatementDigest: signed.artifactStatementDigest,
      artifactSignatureDigest: signed.artifactSignatureDigest, signEvidenceDigest: controlPlaneDigest(signed), immutable: true }
  }

  #hasMatchingPublishReconciliation(planId: string, fence: number): boolean {
    const row = this.#database.prepare(`SELECT * FROM source_publish_reconciliations WHERE plan_id = ? AND release_fence = ?
      AND status = 'applied' ORDER BY attempt DESC LIMIT 1`).get(planId, fence) as unknown as SourcePublishReconciliationRow | undefined
    if (row === undefined) return false
    return sourcePublishReconciliationFromRow(row).receipt?.evidence.outcome === 'exists-match'
  }

  health(): PluginControlPlaneHealth {
    const row = this.#database.prepare(`SELECT
      (SELECT count(*) FROM capability_gaps WHERE status = 'open') AS gaps,
      (SELECT count(*) FROM activation_plans WHERE status = 'approved') + (SELECT count(*) FROM source_plans WHERE status = 'approved') AS ready_plans,
      (SELECT count(*) FROM activation_plans WHERE status IN ('staging', 'awaiting-reload', 'awaiting-readiness',
        'awaiting-effect-blocked-replay', 'awaiting-shadow', 'awaiting-canary', 'awaiting-soak', 'awaiting-health', 'commit-pending')) AS active_activations,
      (SELECT count(*) FROM activation_plans WHERE status = 'rolled-back') +
        (SELECT count(*) FROM source_plans WHERE status IN ('local-checks-failed', 'release-failed')) AS failed,
      (SELECT count(*) FROM activation_plans WHERE status = 'rollback-pending') AS rollback_pending,
      (SELECT count(*) FROM activation_watch WHERE state = 'watching') AS watching_activations,
      (SELECT count(*) FROM activation_watch WHERE state = 'closed-regressed') AS closed_regressed,
      (SELECT count(*) FROM activation_watch WHERE state = 'closed-retracted') AS closed_retracted`).get() as {
        gaps: number; ready_plans: number; active_activations: number; failed: number; rollback_pending: number
        watching_activations: number; closed_regressed: number; closed_retracted: number
      }
    return { gaps: row.gaps, readyPlans: row.ready_plans, activeActivations: row.active_activations, failed: row.failed,
      rollbackPending: row.rollback_pending, watchingActivations: row.watching_activations,
      closedRegressed: row.closed_regressed, closedRetracted: row.closed_retracted }
  }

  #sourcePlanReceipt(idempotencyKey: string, operation: string, inputDigest: string, planId: string): OperationReceipt<PluginSourcePlan> | undefined {
    const receipt = this.#receipt<unknown>(idempotencyKey, operation, inputDigest)
    if (receipt === undefined) return undefined
    const result = sourceSnapshotFromStored(receipt.result); const authoritative = this.getSourcePlan(planId)
    if (result.id !== planId || result.digest !== authoritative.digest || result.gapId !== authoritative.gapId
      || result.revision > authoritative.revision
      || (result.approval !== undefined && controlPlaneDigest(result.approval) !== controlPlaneDigest(authoritative.approval))
      || (result.sourceCheck !== undefined && controlPlaneDigest(result.sourceCheck) !== controlPlaneDigest(authoritative.sourceCheck))
      || (result.preparedEvidence !== undefined
        && controlPlaneDigest(result.preparedEvidence) !== controlPlaneDigest(authoritative.preparedEvidence))
      || (result.releaseAuthorization !== undefined
        && controlPlaneDigest(result.releaseAuthorization) !== controlPlaneDigest(authoritative.releaseAuthorization))
      || (result.release !== undefined && (result.release.id !== authoritative.release?.id
        || result.release.fence > (authoritative.release?.fence ?? 0) || result.release.updatedAt !== receipt.createdAt))) {
      throw new ControlPlaneStoreError('invalid-state', 'stored source operation receipt is not bound to authoritative state')
    }
    return { ...receipt, result }
  }

  #sourcePlanReceiptByKey(idempotencyKey: string, operation: string, inputDigest: string): OperationReceipt<PluginSourcePlan> | undefined {
    const receipt = this.#receipt<unknown>(idempotencyKey, operation, inputDigest)
    if (receipt === undefined) return undefined
    const snapshot = sourceSnapshotFromStored(receipt.result)
    const authoritative = this.getSourcePlan(snapshot.id)
    const replayBinding = { operation: 'create-source-plan', gapId: snapshot.gapId, repository: snapshot.repository,
      worktree: snapshot.worktree, baseCommit: snapshot.baseCommit, name: snapshot.name, generatorDigest: snapshot.generatorDigest,
      scope: snapshot.scope, ttlMs: snapshot.expiresAt - snapshot.createdAt }
    if (snapshot.digest !== authoritative.digest || snapshot.gapId !== authoritative.gapId
      || snapshot.revision !== 1 || snapshot.status !== 'pending-approval' || snapshot.createdAt !== receipt.createdAt
      || snapshot.approval !== undefined || snapshot.releaseAuthorization !== undefined
      || snapshot.release !== undefined || controlPlaneDigest(snapshot.mode === 'modify' ? { ...replayBinding, mode: snapshot.mode,
        prepared: { treeDigest: snapshot.sourceCheck!.treeDigest, patchDigest: snapshot.sourceCheck!.patchDigest,
          checkedAt: snapshot.sourceCheck!.checkedAt, evidence: snapshot.preparedEvidence } } : replayBinding) !== inputDigest
      || (snapshot.mode === 'create' && (snapshot.sourceCheck !== undefined || snapshot.preparedEvidence !== undefined))
      || (snapshot.mode === 'modify' && (snapshot.sourceCheck === undefined || snapshot.preparedEvidence === undefined
        || controlPlaneDigest(snapshot.sourceCheck) !== controlPlaneDigest(authoritative.sourceCheck)))) {
      throw new ControlPlaneStoreError('invalid-state', 'stored source operation receipt is not bound to authoritative state')
    }
    return { ...receipt, result: snapshot }
  }

  #activationPlanReceipt(idempotencyKey: string, operation: string, inputDigest: string, planId: string): OperationReceipt<PluginActivationPlan> | undefined {
    const receipt = this.#receipt<unknown>(idempotencyKey, operation, inputDigest)
    if (receipt === undefined) return undefined
    const snapshot = activationSnapshotFromStored(receipt.result); const authoritative = this.getPlan(planId)
    if (snapshot.id !== planId || snapshot.digest !== authoritative.digest || snapshot.gapId !== authoritative.gapId
      || snapshot.revision > authoritative.revision
      || (snapshot.approval !== undefined && controlPlaneDigest(snapshot.approval) !== controlPlaneDigest(authoritative.approval))
      || (snapshot.activation !== undefined && (snapshot.activation.id !== authoritative.activation?.id
        || snapshot.activation.fence > (authoritative.activation?.fence ?? 0)))) {
      throw new ControlPlaneStoreError('invalid-state', 'stored activation operation receipt is not bound to authoritative state')
    }
    return { ...receipt, result: snapshot }
  }

  #activationPlanReceiptByKey(idempotencyKey: string, operation: string, inputDigest: string): OperationReceipt<PluginActivationPlan> | undefined {
    const receipt = this.#receipt<unknown>(idempotencyKey, operation, inputDigest)
    if (receipt === undefined) return undefined
    const snapshot = activationSnapshotFromStored(receipt.result); const authoritative = this.getPlan(snapshot.id)
    const adoption = this.#database.prepare('SELECT source_plan_id FROM source_adoptions WHERE activation_plan_id = ?').get(snapshot.id) as { source_plan_id: string } | undefined
    if (adoption) readOwnerSourceAdoptionPlan(this.#database, snapshot.id)
    const replayBinding = { operation: 'create-activation-plan', gapId: snapshot.gapId, candidate: snapshot.candidate,
      catalog: { digest: snapshot.dossier.catalogDigest, provenance: snapshot.dossier.catalogProvenance },
      matchedCapabilities: snapshot.dossier.matchedCapabilities, profile: snapshot.profile, target: snapshot.target,
      installationId: snapshot.installationId, ledger: snapshot.ledger, executor: snapshot.executor,
      ttlMs: snapshot.expiresAt - snapshot.createdAt, ...(adoption ? { sourcePlanId: adoption.source_plan_id } : {}) }
    if (snapshot.digest !== authoritative.digest || snapshot.gapId !== authoritative.gapId || snapshot.revision !== 1
      || snapshot.status !== 'pending-approval' || snapshot.createdAt !== receipt.createdAt
      || snapshot.approval !== undefined || snapshot.activation !== undefined || controlPlaneDigest(replayBinding) !== inputDigest) {
      throw new ControlPlaneStoreError('invalid-state', 'stored activation creation receipt is not bound to authoritative state')
    }
    return { ...receipt, result: snapshot }
  }

  #receipt<T>(idempotencyKey: string, operation: string, inputDigest: string): OperationReceipt<T> | undefined {
    const row = this.#database.prepare('SELECT * FROM operation_receipts WHERE idempotency_key = ?').get(idempotencyKey) as {
      operation: string; input_digest: string; result_json: string; result_digest: string | null; created_at: number
    } | undefined
    if (row === undefined) return undefined
    if (row.operation !== operation || row.input_digest !== inputDigest) throw new ControlPlaneStoreError('conflict', 'operation idempotency key was reused with different input')
    if (!DIGEST.test(row.result_digest ?? '') || controlPlaneOperationReceiptDigest(idempotencyKey, row.operation, row.input_digest,
      row.result_json, row.created_at) !== row.result_digest) {
      throw new ControlPlaneStoreError('invalid-state', 'stored operation receipt result is corrupt')
    }
    return { idempotencyKey, operation, inputDigest, result: JSON.parse(row.result_json) as T, createdAt: row.created_at }
  }

  #insertReceipt(receipt: OperationReceipt<unknown>): void {
    const resultJson = JSON.stringify(receipt.result)
    this.#database.prepare(`INSERT INTO operation_receipts
      (idempotency_key, operation, input_digest, result_json, result_digest, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(receipt.idempotencyKey, receipt.operation, receipt.inputDigest, resultJson, controlPlaneOperationReceiptDigest(
        receipt.idempotencyKey, receipt.operation, receipt.inputDigest, resultJson, receipt.createdAt), receipt.createdAt)
  }
}
