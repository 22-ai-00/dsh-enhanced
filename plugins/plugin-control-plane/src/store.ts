import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import { discover, parseCatalog, type CatalogEntry, type LoadedCapabilityCatalog } from './catalog.js'
import { parseApprovalReceipt } from './approval.js'
import { parseSourcePublishReconciliationReceipt, parseSourcePublishReconciliationRequest, parseSourceReleaseAuthorization,
  parseSourceReleaseReceipt, parseSourceReleaseRequest, parseVerifiedSourceReleaseAuthorization } from './release.js'
import { controlPlaneOperationReceiptDigest, openControlPlaneDatabase } from './sqlite.js'
import type {
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
const SOURCE_STATUSES = new Set<SourcePlanStatus>(['pending-approval', 'approved', 'running-local-checks', 'ready-for-human-review',
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

function expectedSourceScope(name: string): readonly string[] {
  return Object.freeze(['plugins/README.md', `plugins/${name}`].sort())
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
    const activationOptional = ['targetOriginallyExisted', 'failureCode'].filter(key => Object.hasOwn(stored, key))
    exactKeys(stored, ['id', 'fence', 'updatedAt', ...activationOptional], 'stored activation identity')
    if (typeof stored['id'] !== 'string' || !KEY.test(stored['id']) || !Number.isSafeInteger(stored['fence'])
      || Number(stored['fence']) < 1 || !Number.isSafeInteger(stored['updatedAt'])
      || Number(stored['updatedAt']) < Number(item['createdAt'])
      || (stored['targetOriginallyExisted'] !== undefined && typeof stored['targetOriginallyExisted'] !== 'boolean')
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

interface ActivationRow {
  id: string; plan_digest: string; gap_id: string; gap_snapshot_json: string; profile: string
  candidate_json: string; dossier_json: string; installation_id: string; dsh_home: string; target_path: string
  ledger_id: string; ledger_path: string; executor_id: string; executor_version: string; executor_path: string
  executor_digest: string; status: PlanStatus; revision: number; created_at: number; expires_at: number
  approval_json: string | null; approval_receipt_json: string | null; activation_id: string | null; activation_fence: number
  activation_lease_until: number | null; activation_target_existed: number | null; failure_code: string | null; updated_at: number
}

interface SourceRow {
  id: string; plan_digest: string; gap_id: string; gap_snapshot_json: string; repository: string; worktree: string
  base_commit: string; plugin_name: string; generator_digest: string; scope_json: string; status: SourcePlanStatus
  revision: number; created_at: number; expires_at: number; approval_json: string | null
  checked_tree_digest: string | null; checked_patch_digest: string | null; checked_at: number | null
  release_authorization_json: string | null; release_authorization_digest: string | null
  release_id: string | null; release_fence: number; release_failure_phase: SourceReleasePhase | null
  release_failure_code: string | null; updated_at: number
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

interface SourcePublishReconciliationRow {
  plan_id: string; release_id: string; release_fence: number; attempt: number; operation_id: string
  binding_digest: string; request_digest: string; request_json: string; status: SourceReleaseOperation['status']
  receipt_digest: string | null; receipt_json: string | null; created_at: number; completed_at: number | null; applied_at: number | null
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
  const requiresApproval = row.status !== 'pending-approval'
  const requiresActivation = !['pending-approval', 'approved'].includes(row.status)
  if (requiresApproval !== (approval !== undefined) || requiresActivation !== (row.activation_id !== null)
    || (row.activation_id === null && (row.activation_fence !== 0 || row.activation_lease_until !== null
      || row.activation_target_existed !== null || row.failure_code !== null))
    || (row.activation_id !== null && (!KEY.test(row.activation_id) || row.activation_fence < 1))
    || (['rolled-back', 'activated'].includes(row.status) && row.activation_lease_until !== null)) {
    throw new ControlPlaneStoreError('invalid-state', 'stored activation state is corrupt or incomplete')
  }
  return {
    ...immutable, digest: row.plan_digest, status: row.status, revision: row.revision,
    ...(approval === undefined ? {} : { approval }),
    ...(row.activation_id === null ? {} : { activation: { id: row.activation_id, fence: row.activation_fence,
      ...(row.activation_target_existed === null ? {} : { targetOriginallyExisted: row.activation_target_existed === 1 }),
      ...(row.failure_code === null ? {} : { failureCode: row.failure_code }), updatedAt: row.updated_at } }),
  }
}

function sourceFromRow(row: SourceRow): PluginSourcePlan {
  const gapSnapshot = JSON.parse(row.gap_snapshot_json) as PluginSourcePlan['gapSnapshot']
  const scope = JSON.parse(row.scope_json) as readonly string[]
  const immutable = { schemaVersion: 1, kind: 'source', id: row.id, gapId: row.gap_id, gapSnapshot,
    repository: row.repository, worktree: row.worktree, baseCommit: row.base_commit, name: row.plugin_name,
    generatorDigest: row.generator_digest, scope, createdAt: row.created_at, expiresAt: row.expires_at } as const
  if (!COMMIT.test(row.base_commit) || !DIGEST.test(row.generator_digest) || !DIGEST.test(gapSnapshot.inputDigest)
    || controlPlaneDigest(scope) !== controlPlaneDigest(expectedSourceScope(row.plugin_name))
    || controlPlaneDigest(immutable) !== row.plan_digest) throw new ControlPlaneStoreError('invalid-state', 'stored source plan is corrupt or digest-mismatched')
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
  return { ...immutable, digest: row.plan_digest, status: row.status, revision: row.revision, ...(approval === undefined ? {} : { approval }),
    ...(sourceCheck === undefined ? {} : { sourceCheck }),
    ...(releaseAuthorization === undefined ? {} : { releaseAuthorization }),
    ...(row.release_id === null ? {} : { release: { id: row.release_id, fence: row.release_fence,
      ...(row.release_failure_phase === null ? {} : { failurePhase: row.release_failure_phase }),
      ...(row.release_failure_code === null ? {} : { failureCode: row.release_failure_code }), updatedAt: row.updated_at } }) }
}

function sourceSnapshotFromStored(value: unknown): PluginSourcePlan {
  const item = objectRecord(value, 'stored source plan snapshot')
  const optional = ['approval', 'sourceCheck', 'releaseAuthorization', 'release']
    .filter(key => Object.hasOwn(item, key))
  exactKeys(item, [...SOURCE_PLAN_KEYS, ...optional], 'stored source plan snapshot')
  const gapSnapshot = objectRecord(item['gapSnapshot'], 'stored source gap snapshot')
  exactKeys(gapSnapshot, ['revision', 'inputDigest', 'roi', 'capability'], 'stored source gap snapshot')
  if (item['schemaVersion'] !== 1 || item['kind'] !== 'source' || typeof item['id'] !== 'string'
    || typeof item['gapId'] !== 'string' || typeof item['status'] !== 'string' || !SOURCE_STATUSES.has(item['status'] as SourcePlanStatus)
    || !Number.isSafeInteger(item['revision']) || Number(item['revision']) < 1 || !Number.isSafeInteger(item['createdAt'])
    || !Number.isSafeInteger(item['expiresAt']) || Number(item['expiresAt']) <= Number(item['createdAt'])
    || typeof item['digest'] !== 'string' || !DIGEST.test(item['digest']) || typeof item['repository'] !== 'string'
    || typeof item['worktree'] !== 'string' || typeof item['baseCommit'] !== 'string' || !COMMIT.test(item['baseCommit'])
    || typeof item['name'] !== 'string' || !PLUGIN_NAME.test(item['name']) || typeof item['generatorDigest'] !== 'string'
    || !DIGEST.test(item['generatorDigest']) || !Array.isArray(item['scope'])
    || controlPlaneDigest(item['scope']) !== controlPlaneDigest(expectedSourceScope(item['name']))
    || !Number.isSafeInteger(gapSnapshot['revision']) || Number(gapSnapshot['revision']) < 1
    || typeof gapSnapshot['inputDigest'] !== 'string' || !DIGEST.test(gapSnapshot['inputDigest'])
    || typeof gapSnapshot['roi'] !== 'number' || !Number.isFinite(gapSnapshot['roi']) || typeof gapSnapshot['capability'] !== 'string') {
    throw new ControlPlaneStoreError('invalid-state', 'stored source plan snapshot is corrupt')
  }
  const immutable = { schemaVersion: 1, kind: 'source', id: item['id'], gapId: item['gapId'], gapSnapshot,
    repository: item['repository'], worktree: item['worktree'], baseCommit: item['baseCommit'], name: item['name'],
    generatorDigest: item['generatorDigest'], scope: item['scope'], createdAt: item['createdAt'], expiresAt: item['expiresAt'] }
  if (controlPlaneDigest(immutable) !== item['digest']) throw new ControlPlaneStoreError('invalid-state', 'stored source plan snapshot digest is corrupt')
  const approval = item['approval'] === undefined ? undefined : verifiedApprovalFromStored(item['approval'], item['id'], item['digest'],
    Number(item['createdAt']), Number(item['expiresAt']))
  let sourceCheck: PluginSourcePlan['sourceCheck']
  if (item['sourceCheck'] !== undefined) {
    const check = objectRecord(item['sourceCheck'], 'stored source check snapshot')
    exactKeys(check, ['treeDigest', 'patchDigest', 'checkedAt'], 'stored source check snapshot')
    if (typeof check['treeDigest'] !== 'string' || !DIGEST.test(check['treeDigest'])
      || typeof check['patchDigest'] !== 'string' || !DIGEST.test(check['patchDigest'])
      || !Number.isSafeInteger(check['checkedAt']) || Number(check['checkedAt']) < Number(item['createdAt'])) {
      throw new ControlPlaneStoreError('invalid-state', 'stored source check snapshot is corrupt')
    }
    sourceCheck = check as unknown as NonNullable<PluginSourcePlan['sourceCheck']>
  }
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
  const requiresCheck = expectedSourceRelease(status) !== undefined || ['ready-for-human-review', 'release-complete',
    'release-failed', 'publish-ambiguous'].includes(status)
  const requiresRelease = expectedSourceRelease(status) !== undefined || ['release-complete', 'release-failed', 'publish-ambiguous'].includes(status)
  if (requiresApproval !== (approval !== undefined) || requiresCheck !== (sourceCheck !== undefined)
    || requiresRelease !== (releaseAuthorization !== undefined && release !== undefined)
    || (!requiresRelease && (releaseAuthorization !== undefined || release !== undefined))) {
    throw new ControlPlaneStoreError('invalid-state', 'stored source plan snapshot fields do not match its status')
  }
  return { ...immutable, digest: item['digest'], status: item['status'] as SourcePlanStatus, revision: Number(item['revision']),
    ...(approval === undefined ? {} : { approval }), ...(sourceCheck === undefined ? {} : { sourceCheck }),
    ...(releaseAuthorization === undefined ? {} : { releaseAuthorization }),
    ...(release === undefined ? {} : { release }) } as unknown as PluginSourcePlan
}

export interface ControlPlaneStoreOptions { path: string; now?: () => number }

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
}

export interface CreateSourcePlanInput {
  gapId: string; repository: string; worktree: string; baseCommit: string; name: string
  generatorDigest: string; scope: readonly string[]; ttlMs: number; idempotencyKey: string
}

export interface PrepareSourceReleaseOperationInput {
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
})

export function expectedHostAttestation(status: PlanStatus): { phase: HostAttestationPhase; next: PlanStatus } | undefined {
  return expectedAttestation[status]
}

function requestBinding(request: HostAttestationRequest): Omit<HostAttestationRequest, 'operationId' | 'requestedAt'> {
  const { operationId: _operationId, requestedAt: _requestedAt, ...binding } = request
  return binding
}

function hostOperationFromRow(row: HostAttestationOperationRow): HostAttestationOperation {
  const request = JSON.parse(row.request_json) as HostAttestationRequest
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

export class ControlPlaneStore {
  readonly #database: DatabaseSync
  readonly #now: () => number

  constructor(options: ControlPlaneStoreOptions) { this.#database = openControlPlaneDatabase(options.path); this.#now = options.now ?? Date.now }
  close(): void { this.#database.close() }

  recordGap(input: CapabilityGapInput): StoredCapabilityGap {
    const normalized = {
      idempotencyKey: bounded(input.idempotencyKey, 'idempotencyKey', 160), capability: bounded(input.capability, 'capability', 300),
      context: bounded(input.context, 'context', 4_000), expectedValue: finite(input.expectedValue, 'expectedValue', 0, 1_000_000_000),
      frequency: finite(input.frequency, 'frequency', 0.000_001, 1_000_000), estimatedCost: finite(input.estimatedCost, 'estimatedCost', 0.000_001, 1_000_000_000),
      risk: finite(input.risk, 'risk', 0, 1),
    }
    if (!KEY.test(normalized.idempotencyKey)) throw new ControlPlaneStoreError('invalid-input', 'idempotencyKey has invalid syntax')
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
    return (this.#database.prepare(`SELECT * FROM capability_gaps WHERE status = 'open' ORDER BY roi DESC, created_at, id LIMIT ?`).all(limit) as unknown as GapRow[]).map(gapFromRow)
  }

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
      ledger: input.ledger, executor: input.executor, ttlMs: input.ttlMs }
    const inputDigest = controlPlaneDigest(requestBinding)
    const prior = this.#activationPlanReceiptByKey(idempotencyKey, 'create-activation-plan', inputDigest)
    if (prior !== undefined) return prior
    const gap = this.getGap(input.gapId)
    if (gap.status !== 'open') throw new ControlPlaneStoreError('invalid-state', 'only an open gap can create an activation plan')
    if (gap.candidateId !== undefined && gap.candidateId !== candidate.id) {
      throw new ControlPlaneStoreError('conflict', 'released capability gap is reserved for its exact admitted candidate')
    }
    if (!discover({ schemaVersion: 1, entries: [candidate] }, gap.capability).some(item => item.id === candidate.id)
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
      const receipt = { idempotencyKey, operation: 'create-activation-plan', inputDigest, result: plan, createdAt: now }
      this.#insertReceipt(receipt); this.#database.exec('COMMIT'); return receipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  getPlan(id: string): PluginActivationPlan {
    const row = this.#database.prepare('SELECT * FROM activation_plans WHERE id = ?').get(id) as unknown as ActivationRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('not-found', 'activation plan not found')
    return activationFromRow(row)
  }

  createSourcePlan(input: CreateSourcePlanInput): OperationReceipt<PluginSourcePlan> {
    const key = bounded(input.idempotencyKey, 'idempotencyKey', 160); const name = bounded(input.name, 'name', 64)
    if (!KEY.test(key) || !PLUGIN_NAME.test(name) || !COMMIT.test(input.baseCommit) || !DIGEST.test(input.generatorDigest)
      || input.scope.length === 0 || input.scope.length > 32) throw new ControlPlaneStoreError('invalid-input', 'source plan binding is invalid')
    positiveInteger(input.ttlMs, 'ttlMs'); if (input.ttlMs < 60_000 || input.ttlMs > 86_400_000) throw new ControlPlaneStoreError('invalid-input', 'ttlMs is invalid')
    const scope = Object.freeze([...new Set(input.scope.map(value => bounded(value, 'scope', 500)))].sort())
    if (controlPlaneDigest(scope) !== controlPlaneDigest(expectedSourceScope(name))) {
      throw new ControlPlaneStoreError('invalid-input', 'source plan scope must bind the plugin tree and plugins catalog row exactly')
    }
    const requestBinding = { operation: 'create-source-plan', gapId: input.gapId, repository: input.repository,
      worktree: input.worktree, baseCommit: input.baseCommit, name, generatorDigest: input.generatorDigest, scope, ttlMs: input.ttlMs }
    const inputDigest = controlPlaneDigest(requestBinding); const prior = this.#sourcePlanReceiptByKey(key, 'create-source-plan', inputDigest)
    if (prior !== undefined) return prior
    const gap = this.getGap(input.gapId); if (gap.status !== 'open' || gap.candidateId !== undefined) {
      throw new ControlPlaneStoreError('invalid-state', 'only an unreserved open gap can create a source plan')
    }
    const gapSnapshot = Object.freeze({ revision: gap.revision, inputDigest: gap.inputDigest, roi: gap.roi, capability: gap.capability })
    const now = this.#now(); const id = `source-${randomUUID()}`; const expiresAt = now + input.ttlMs
    const immutable = { schemaVersion: 1 as const, kind: 'source' as const, id, gapId: gap.id, gapSnapshot,
      repository: input.repository, worktree: input.worktree, baseCommit: input.baseCommit, name,
      generatorDigest: input.generatorDigest, scope, createdAt: now, expiresAt }
    const digest = controlPlaneDigest(immutable)
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#database.prepare('INSERT INTO gap_plan_claims (gap_id, plan_id, plan_kind, claimed_at) VALUES (?, ?, ?, ?)').run(gap.id, id, 'source', now)
      this.#database.prepare(`INSERT INTO source_plans (id, plan_digest, gap_id, gap_snapshot_json, repository, worktree,
        base_commit, plugin_name, generator_digest, scope_json, status, revision, created_at, expires_at, approval_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending-approval', 1, ?, ?, NULL, ?)`).run(id, digest, gap.id,
        JSON.stringify(gapSnapshot), input.repository, input.worktree, input.baseCommit, name, input.generatorDigest, JSON.stringify(scope), now, expiresAt, now)
      this.#database.prepare(`UPDATE capability_gaps SET status = 'matched', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`).run(now, gap.id, gap.revision)
      const plan = this.getSourcePlan(id); const receipt = { idempotencyKey: key, operation: 'create-source-plan', inputDigest, result: plan, createdAt: now }
      this.#insertReceipt(receipt); this.#database.exec('COMMIT'); return receipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  getSourcePlan(id: string): PluginSourcePlan {
    const row = this.#database.prepare('SELECT * FROM source_plans WHERE id = ?').get(id) as unknown as SourceRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('not-found', 'source plan not found')
    return sourceFromRow(row)
  }

  async approve(input: { planId: string; expectedRevision: number; receipt: ApprovalReceipt; resolveAuthority: (receipt: ApprovalReceipt) => ApprovalAuthority; idempotencyKey: string }): Promise<OperationReceipt<PluginActivationPlan>> {
    return this.#approvePlan('activation', input) as Promise<OperationReceipt<PluginActivationPlan>>
  }

  async approveSource(input: { planId: string; expectedRevision: number; receipt: ApprovalReceipt; resolveAuthority: (receipt: ApprovalReceipt) => ApprovalAuthority; idempotencyKey: string }): Promise<OperationReceipt<PluginSourcePlan>> {
    return this.#approvePlan('source', input) as Promise<OperationReceipt<PluginSourcePlan>>
  }

  async #approvePlan(kind: 'activation' | 'source', input: { planId: string; expectedRevision: number; receipt: ApprovalReceipt; resolveAuthority: (receipt: ApprovalReceipt) => ApprovalAuthority; idempotencyKey: string }): Promise<OperationReceipt<PluginActivationPlan | PluginSourcePlan>> {
    const inputDigest = controlPlaneDigest({ operation: 'approve-plan', kind, planId: input.planId, expectedRevision: input.expectedRevision, receipt: input.receipt })
    if (kind === 'source') {
      const prior = this.#sourcePlanReceipt(input.idempotencyKey, 'approve-plan', inputDigest, input.planId)
      if (prior !== undefined) {
        if (prior.result.status !== 'approved' || prior.result.revision !== input.expectedRevision + 1
          || controlPlaneDigest(prior.result.approval) !== controlPlaneDigest(projectedApproval(input.receipt))
          || prior.result.sourceCheck !== undefined || prior.result.releaseAuthorization !== undefined || prior.result.release !== undefined) {
          throw new ControlPlaneStoreError('invalid-state', 'stored source approval receipt is corrupt')
        }
        return prior
      }
    } else {
      const prior = this.#activationPlanReceipt(input.idempotencyKey, 'approve-plan', inputDigest, input.planId)
      if (prior !== undefined) {
        if (prior.result.status !== 'approved' || prior.result.revision !== input.expectedRevision + 1
          || controlPlaneDigest(prior.result.approval) !== controlPlaneDigest(projectedApproval(input.receipt))
          || prior.result.activation !== undefined) throw new ControlPlaneStoreError('invalid-state', 'stored activation approval receipt is corrupt')
        return prior
      }
    }
    const plan = kind === 'activation' ? this.getPlan(input.planId) : this.getSourcePlan(input.planId)
    const verified = await input.resolveAuthority(input.receipt).verify(input.receipt, plan)
    if (plan.revision !== input.expectedRevision) throw new ControlPlaneStoreError('conflict', 'plan revision conflict')
    if (plan.status !== 'pending-approval') throw new ControlPlaneStoreError('invalid-state', 'plan is not pending approval')
    if (this.#now() > plan.expiresAt || verified.decision !== 'approved') throw new ControlPlaneStoreError(verified.decision === 'approved' ? 'expired' : 'invalid-state', 'plan approval is not currently applicable')
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
  }

  async claimActivation(input: { planId: string; expectedRevision: number; leaseMs: number;
    resolveApprovalAuthority: (receipt: ApprovalReceipt) => ApprovalAuthority }): Promise<PluginActivationPlan> {
    const now = this.#now(); positiveInteger(input.leaseMs, 'leaseMs')
    if (input.leaseMs < 5_000 || input.leaseMs > 300_000) throw new ControlPlaneStoreError('invalid-input', 'leaseMs is invalid')
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
      const recoverable = plan.status === 'staging' || plan.status === 'rollback-pending' || plan.status === 'commit-pending'
      if (plan.status === 'approved') {
        if (now > plan.expiresAt) throw new ControlPlaneStoreError('expired', 'activation plan expired before its first claim')
        const targetOwner = this.#database.prepare(`SELECT id FROM activation_plans WHERE target_path = ? AND id <> ? AND status IN (
          'staging', 'awaiting-reload', 'awaiting-readiness', 'awaiting-effect-blocked-replay', 'awaiting-shadow',
          'awaiting-canary', 'awaiting-soak', 'awaiting-health', 'commit-pending', 'rollback-pending') LIMIT 1`).get(plan.target.profilePath, plan.id)
        if (targetOwner !== undefined) throw new ControlPlaneStoreError('conflict', 'target profile already has an active activation')
      } else if (!(recoverable && Number(row.activation_lease_until ?? 0) < now)) throw new ControlPlaneStoreError('invalid-state', 'activation plan cannot be claimed')
      const activationId = row.activation_id ?? `activation-${randomUUID()}`; const status = plan.status === 'approved' ? 'staging' : plan.status
      const result = this.#database.prepare(`UPDATE activation_plans SET status = ?, revision = revision + 1, activation_id = ?,
        activation_fence = activation_fence + 1, activation_lease_until = ?, updated_at = ? WHERE id = ? AND revision = ?`).run(
        status, activationId, now + input.leaseMs, now, plan.id, input.expectedRevision)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'activation plan changed while being claimed')
      const claimed = this.getPlan(plan.id); this.#database.exec('COMMIT'); return claimed
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  heartbeatActivation(input: { planId: string; expectedRevision: number; fence: number; leaseMs: number }): PluginActivationPlan {
    const now = this.#now(); positiveInteger(input.leaseMs, 'leaseMs')
    const result = this.#database.prepare(`UPDATE activation_plans SET activation_lease_until = ?, updated_at = ?
      WHERE id = ? AND revision = ? AND activation_fence = ? AND status IN ('staging', 'rollback-pending', 'commit-pending') AND activation_lease_until >= ?`).run(
      now + input.leaseMs, now, input.planId, input.expectedRevision, input.fence, now)
    if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'activation heartbeat lost its revision/fence/lease')
    return this.getPlan(input.planId)
  }

  recordActivationTargetBaseline(input: { planId: string; expectedRevision: number; fence: number; existed: boolean }): PluginActivationPlan {
    const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#database.prepare('SELECT * FROM activation_plans WHERE id = ?').get(input.planId) as unknown as ActivationRow | undefined
      if (row === undefined) throw new ControlPlaneStoreError('not-found', 'activation plan not found')
      const plan = activationFromRow(row)
      if (plan.revision !== input.expectedRevision || plan.activation?.fence !== input.fence || plan.status !== 'staging'
        || Number(row.activation_lease_until ?? 0) < now) throw new ControlPlaneStoreError('conflict', 'activation lost its claim before recording the target baseline')
      if (row.activation_target_existed !== null && (row.activation_target_existed === 1) !== input.existed) {
        throw new ControlPlaneStoreError('conflict', 'activation target baseline is immutable')
      }
      if (row.activation_target_existed === null) {
        this.#database.prepare(`UPDATE activation_plans SET activation_target_existed = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND activation_fence = ? AND activation_target_existed IS NULL`).run(
          input.existed ? 1 : 0, now, plan.id, plan.revision, input.fence)
      }
      const result = this.getPlan(plan.id)
      this.#database.exec('COMMIT')
      return result
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
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
      assertOwner(true)
      const started = this.#now()
      this.#database.prepare('UPDATE activation_plans SET activation_lease_until = ?, updated_at = ? WHERE id = ?').run(
        started + input.leaseMs, started, input.planId)
      const result = await action()
      assertOwner(false)
      const finished = this.#now()
      this.#database.prepare('UPDATE activation_plans SET activation_lease_until = ?, updated_at = ? WHERE id = ?').run(
        finished + input.leaseMs, finished, input.planId)
      this.#database.exec('COMMIT')
      return result
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
    const plan = this.getPlan(input.planId)
    if (plan.revision !== input.expectedRevision || plan.activation?.fence !== input.fence || !input.statuses.includes(plan.status)) throw new ControlPlaneStoreError('conflict', 'activation no longer owns the exact revision/fence/status')
    return plan
  }

  prepareHostAttestationOperation(input: { planId: string; expectedRevision: number; expectedFence: number;
    issuer: HostAttestationRequest['issuer']; requirements: HostAttestationRequirements; receiptTtlMs: number }): HostAttestationOperation {
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
        const previous = this.#database.prepare(`SELECT max(attestation.host_generation) AS generation
          FROM host_attestations AS attestation JOIN activation_plans AS activation ON activation.id = attestation.plan_id
          WHERE activation.installation_id = ?`).get(plan.installationId) as { generation: number | null }
        if (input.requirements.kind !== 'reload' || input.requirements.previousHostGeneration !== (previous.generation ?? 0)) {
          throw new ControlPlaneStoreError('conflict', 'reload operation does not bind the durable prior Host generation')
        }
      }
      const operationId = `host-operation-${randomUUID()}`
      const request: HostAttestationRequest = { schemaVersion: 1, kind: 'dsh-host-attestation-request', operationId,
        requestedAt: now, receiptTtlMs: input.receiptTtlMs, installationId: plan.installationId, ledger: plan.ledger, plan: { id: plan.id, digest: plan.digest },
        activation: { id: plan.activation.id, fence: plan.activation.fence }, profile: { name: plan.profile, path: plan.target.profilePath },
        issuer: input.issuer, phase: expected.phase, requirements: input.requirements }
      const bindingDigest = controlPlaneDigest(requestBinding(request))
      const priorRow = this.#database.prepare('SELECT * FROM host_attestation_operations WHERE plan_id = ? AND phase = ?')
        .get(plan.id, expected.phase) as unknown as HostAttestationOperationRow | undefined
      if (priorRow !== undefined) {
        const prior = hostOperationFromRow(priorRow)
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
  }

  getHostAttestationOperation(operationId: string): HostAttestationOperation {
    const row = this.#database.prepare('SELECT * FROM host_attestation_operations WHERE operation_id = ?').get(operationId) as unknown as HostAttestationOperationRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('not-found', 'Host attestation operation not found')
    return hostOperationFromRow(row)
  }

  latestHostGeneration(installationId: string): number {
    if (!UUID.test(installationId)) throw new ControlPlaneStoreError('invalid-input', 'installation id is invalid')
    const row = this.#database.prepare(`SELECT max(attestation.host_generation) AS generation
      FROM host_attestations AS attestation JOIN activation_plans AS activation ON activation.id = attestation.plan_id
      WHERE activation.installation_id = ?`).get(installationId) as { generation: number | null }
    return row.generation ?? 0
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
      if (operation.receipt !== undefined) { this.#database.exec('COMMIT'); return operation.receipt }
      const receipt = await input.execute(operation.request)
      await input.resolveAuthority(receipt).verify(receipt, plan, operation.request)
      const now = this.#now()
      const result = this.#database.prepare(`UPDATE host_attestation_operations SET status = 'completed', receipt_digest = ?,
        receipt_json = ?, completed_at = ? WHERE operation_id = ? AND status = 'pending' AND request_digest = ?`).run(
        controlPlaneDigest(receipt), JSON.stringify(receipt), now, operation.operationId, operation.requestDigest)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'Host attestation operation completion lost its single-flight')
      this.#database.exec('COMMIT')
      return receipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  advanceActivation(input: { planId: string; expectedRevision: number; fence: number; from: PlanStatus; to: PlanStatus; failureCode?: string }): PluginActivationPlan {
    const allowed: Record<string, readonly PlanStatus[]> = { staging: ['awaiting-reload', 'rollback-pending'],
      'rollback-pending': ['rolled-back'], 'commit-pending': ['activated', 'rollback-pending'] }
    if (!allowed[input.from]?.includes(input.to)) throw new ControlPlaneStoreError('invalid-input', 'invalid activation transition')
    const now = this.#now(); this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#database.prepare(`UPDATE activation_plans SET status = ?, revision = revision + 1,
        activation_lease_until = CASE
          WHEN ? IN ('rolled-back', 'activated', 'awaiting-reload') THEN NULL
          ELSE activation_lease_until END,
        failure_code = COALESCE(?, failure_code), updated_at = ?
        WHERE id = ? AND revision = ? AND activation_fence = ? AND status = ? AND activation_lease_until >= ?`).run(
        input.to, input.to, input.failureCode ?? null, now, input.planId, input.expectedRevision, input.fence, input.from, now)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'activation transition lost its CAS/fencing claim')
      const plan = this.getPlan(input.planId)
      if (input.to === 'rolled-back' || input.to === 'activated') {
        if (input.to === 'activated') this.#database.prepare(`UPDATE capability_gaps SET status = 'closed', revision = revision + 1, updated_at = ? WHERE id = ?`).run(now, plan.gapId)
        this.#finishActivation(plan, input.fence, now)
      }
      this.#database.exec('COMMIT'); return plan
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  async applyHostAttestation(input: { planId: string; expectedRevision: number; expectedFence: number; receipt: HostAttestationReceipt;
    resolveAuthority: (receipt: HostAttestationReceipt) => HostAttestationAuthority; idempotencyKey: string }): Promise<OperationReceipt<PluginActivationPlan>> {
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
        || replay.result.activation.failureCode !== expectedFailure || replay.result.activation.updatedAt !== replay.createdAt) {
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
    const verified = await input.resolveAuthority(input.receipt).verify(input.receipt, plan, operation.request)
    const now = this.#now(); const nextStatus: PlanStatus = verified.outcome === 'passed' ? expected.next : 'rollback-pending'
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const previousGeneration = this.#database.prepare(`SELECT max(attestation.host_generation) AS generation
        FROM host_attestations AS attestation JOIN activation_plans AS activation ON activation.id = attestation.plan_id
        WHERE activation.installation_id = ?`).get(plan.installationId) as { generation: number | null }
      if (previousGeneration.generation !== null && verified.hostGeneration < previousGeneration.generation) throw new ControlPlaneStoreError('conflict', 'host generation regressed')
      this.#database.prepare(`INSERT INTO host_attestations (plan_id, phase, receipt_id, receipt_digest, receipt_json, host_generation, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(plan.id, verified.phase, verified.receiptId, controlPlaneDigest(input.receipt), JSON.stringify(verified), verified.hostGeneration, now)
      const result = this.#database.prepare(`UPDATE activation_plans SET status = ?, revision = revision + 1,
        activation_lease_until = NULL,
        failure_code = CASE WHEN ? = 'rollback-pending' THEN 'host-attestation-failed' ELSE failure_code END, updated_at = ?
        WHERE id = ? AND status = ? AND revision = ? AND activation_fence = ?`).run(nextStatus, nextStatus, now, plan.id, plan.status, plan.revision, input.expectedFence)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'host attestation lost its plan CAS')
      const applied = this.#database.prepare(`UPDATE host_attestation_operations SET status = 'applied', applied_at = ?
        WHERE operation_id = ? AND status = 'completed' AND receipt_digest = ?`).run(now, operation.operationId, controlPlaneDigest(input.receipt))
      if (Number(applied.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'Host attestation operation lost its apply CAS')
      const output = this.getPlan(plan.id)
      const operationReceipt = { idempotencyKey: input.idempotencyKey, operation: 'host-attestation', inputDigest, result: output, createdAt: now }
      this.#insertReceipt(operationReceipt); this.#database.exec('COMMIT'); return operationReceipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  #finishActivation(plan: PluginActivationPlan, fence: number, now: number): void {
    const activationId = plan.activation?.id
    if (activationId === undefined) throw new ControlPlaneStoreError('invalid-state', 'terminal activation has no identity')
    const inputDigest = controlPlaneDigest({ planId: plan.id, planDigest: plan.digest, activationId, fence, status: plan.status, failureCode: plan.activation?.failureCode })
    this.#insertReceipt({ idempotencyKey: `activation:${activationId}`, operation: 'activate-plan', inputDigest, result: plan, createdAt: now })
    if (plan.status === 'rolled-back') {
      this.#database.prepare('DELETE FROM gap_plan_claims WHERE gap_id = ? AND plan_id = ?').run(plan.gapId, plan.id)
      this.#database.prepare(`UPDATE capability_gaps SET status = 'open', candidate_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ?`).run(now, plan.gapId)
    }
  }

  beginSourceChecks(input: { planId: string; expectedRevision: number }): PluginSourcePlan {
    const now = this.#now()
    const result = this.#database.prepare(`UPDATE source_plans SET status = 'running-local-checks', revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND status = 'approved'`).run(now, input.planId, input.expectedRevision)
    if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source plan changed before local checks')
    return this.getSourcePlan(input.planId)
  }

  finishSourceChecks(input: { planId: string; expectedRevision: number; succeeded: boolean;
    checkedTreeDigest?: string; checkedPatchDigest?: string }): PluginSourcePlan {
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

  async startSourceRelease(input: { planId: string; expectedRevision: number; authorization: SourceReleaseAuthorization;
    resolveAuthority: (authorization: SourceReleaseAuthorization) => SourceReleaseAuthorizationAuthority;
    idempotencyKey: string }): Promise<OperationReceipt<PluginSourcePlan>> {
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
      return replay
    }
    const plan = this.getSourcePlan(input.planId)
    if (plan.revision !== input.expectedRevision) throw new ControlPlaneStoreError('conflict', 'source release authorization targets a stale plan revision')
    if (plan.status !== 'ready-for-human-review' || plan.sourceCheck === undefined) {
      throw new ControlPlaneStoreError('invalid-state', 'source release requires completed checks and fresh human review')
    }
    const verified = await input.resolveAuthority(input.authorization).verify(input.authorization, plan)
    const now = this.#now()
    if (now > plan.expiresAt || now > verified.expiresAt) throw new ControlPlaneStoreError('expired', 'source release authorization is no longer applicable')
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const releaseId = `release-${randomUUID()}`
      const result = this.#database.prepare(`UPDATE source_plans SET status = 'awaiting-pr', revision = revision + 1,
        release_authorization_json = ?, release_authorization_digest = ?, release_id = ?, release_fence = release_fence + 1,
        release_failure_phase = NULL, release_failure_code = NULL, updated_at = ?
        WHERE id = ? AND status = 'ready-for-human-review' AND revision = ? AND plan_digest = ?
          AND checked_tree_digest = ? AND checked_patch_digest = ? AND release_id IS NULL`).run(
        JSON.stringify(verified), controlPlaneDigest(verified), releaseId, now, plan.id, input.expectedRevision, plan.digest,
        plan.sourceCheck.treeDigest, plan.sourceCheck.patchDigest)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source plan changed while release authorization was applied')
      const output = this.getSourcePlan(plan.id)
      const operationReceipt = { idempotencyKey: key, operation: 'start-source-release', inputDigest, result: output, createdAt: now }
      this.#insertReceipt(operationReceipt)
      this.#database.exec('COMMIT')
      return operationReceipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  async prepareSourceReleaseOperation(input: PrepareSourceReleaseOperationInput): Promise<SourceReleaseOperation> {
    const now = this.#now()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const plan = this.getSourcePlan(input.planId); const expected = expectedSourceRelease(plan.status)
      if (expected === undefined) throw new ControlPlaneStoreError('invalid-state', 'source plan is not awaiting a release operation')
      if (plan.revision !== input.expectedRevision || plan.release?.fence !== input.expectedFence) {
        throw new ControlPlaneStoreError('conflict', 'source release operation targets a stale revision/fence')
      }
      if (plan.releaseAuthorization === undefined || plan.sourceCheck === undefined) {
        throw new ControlPlaneStoreError('invalid-state', 'source release operation has no durable post-check authorization')
      }
      await reverifySourceReleaseAuthorization(plan.releaseAuthorization, plan, input.resolveAuthorizationAuthority)
      this.#assertReleaseEnvironment(input, expected.phase)
      const previous = this.#previousReleaseEvidence(plan, expected.phase)
      const priorRow = this.#database.prepare(`SELECT * FROM source_release_operations WHERE plan_id = ? AND phase = ?
        ORDER BY attempt DESC LIMIT 1`).get(plan.id, expected.phase) as unknown as SourceReleaseOperationRow | undefined
      const attempt = priorRow !== undefined && priorRow.release_fence === plan.release.fence
        ? priorRow.attempt : (priorRow?.attempt ?? 0) + 1
      if (priorRow !== undefined && priorRow.release_fence === plan.release.fence) {
        const prior = sourceReleaseOperationFromRow(priorRow)
        const expectedRequest = this.#sourceReleaseRequest(plan, expected.phase, prior.operationId, prior.attempt,
          prior.request.requestedAt, input, previous)
        if (prior.bindingDigest !== controlPlaneDigest(releaseRequestBinding(expectedRequest))) {
          throw new ControlPlaneStoreError('conflict', 'durable release operation payload changed for the same phase/fence')
        }
        this.#database.exec('COMMIT')
        return prior
      }
      const operationId = `release-operation-${randomUUID()}`
      const request = this.#sourceReleaseRequest(plan, expected.phase, operationId, attempt, now, input, previous)
      const bindingDigest = controlPlaneDigest(releaseRequestBinding(request))
      this.#database.prepare(`INSERT INTO source_release_operations (plan_id, phase, release_id, release_fence, attempt,
        operation_id, binding_digest, request_digest, request_json, status, receipt_digest, receipt_json, created_at, completed_at, applied_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, NULL)`).run(plan.id, expected.phase,
        plan.release.id, plan.release.fence, attempt, operationId, bindingDigest, controlPlaneDigest(request), JSON.stringify(request), now)
      const operation = this.getSourceReleaseOperation(operationId)
      this.#database.exec('COMMIT')
      return operation
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  getSourceReleaseOperation(operationId: string): SourceReleaseOperation {
    const row = this.#database.prepare('SELECT * FROM source_release_operations WHERE operation_id = ?').get(operationId) as unknown as SourceReleaseOperationRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('not-found', 'source release operation not found')
    return sourceReleaseOperationFromRow(row)
  }

  sourceReleaseCandidate(planId: string): CatalogEntry {
    const plan = this.getSourcePlan(planId)
    if (plan.status !== 'release-complete') {
      throw new ControlPlaneStoreError('invalid-state', 'source candidate is not admitted until release completes')
    }
    const row = this.#database.prepare(`SELECT * FROM source_release_operations WHERE plan_id = ? AND phase = 'build'
      AND status = 'applied' ORDER BY attempt DESC LIMIT 1`).get(plan.id) as unknown as SourceReleaseOperationRow | undefined
    if (row === undefined) throw new ControlPlaneStoreError('invalid-state', 'source release has no applied build artifact')
    const operation = sourceReleaseOperationFromRow(row); const evidence = operation.receipt?.evidence
    if (operation.receipt?.outcome !== 'passed' || evidence?.kind !== 'build') {
      throw new ControlPlaneStoreError('invalid-state', 'source release build evidence is not successful')
    }
    const authorization = plan.releaseAuthorization
    if (authorization === undefined) throw new ControlPlaneStoreError('invalid-state', 'source release has no verified authorization')
    const artifact = releaseArtifact(evidence)
    return parseCatalog({ schemaVersion: 1, entries: [{ id: artifact.candidateId, package: artifact.packageName,
      version: artifact.packageVersion, integrity: artifact.tarballIntegrity, dshBaseline: artifact.dshBaseline,
      registry: { id: authorization.releasePolicy.registryId, locator: authorization.releasePolicy.registryLocator,
        reference: authorization.releasePolicy.registryReference },
      capabilities: artifact.capabilities, authorities: artifact.authorities, requires: artifact.requires }] }).entries[0]!
  }

  async runSourceReleaseOperation(input: { operationId: string; expectedRevision: number; expectedFence: number;
    execute: (request: SourceReleaseRequest) => Promise<SourceReleaseReceipt>;
    resolveAuthority: (receipt: SourceReleaseReceipt) => SourceReleaseAuthority;
    resolveAuthorizationAuthority: (authorization: SourceReleaseAuthorization) => SourceReleaseAuthorizationAuthority }): Promise<SourceReleaseReceipt> {
    try { this.#database.exec('BEGIN IMMEDIATE') } catch { throw new ControlPlaneStoreError('conflict', 'source release single-flight is held') }
    try {
      const operation = this.getSourceReleaseOperation(input.operationId)
      const plan = this.getSourcePlan(operation.planId); const expected = expectedSourceRelease(plan.status)
      if (plan.revision !== input.expectedRevision || plan.release?.fence !== input.expectedFence
        || operation.fence !== input.expectedFence || expected?.phase !== operation.phase
        || operation.requestDigest !== controlPlaneDigest(operation.request)) {
        throw new ControlPlaneStoreError('conflict', 'source release operation lost its plan revision/fence/phase')
      }
      if (operation.receipt !== undefined) { this.#database.exec('COMMIT'); return operation.receipt }
      await reverifySourceReleaseAuthorization(operation.request.authorization, plan, input.resolveAuthorizationAuthority)
      const receipt = await input.execute(operation.request)
      await input.resolveAuthority(receipt).verify(receipt, plan, operation.request)
      const now = this.#now()
      const result = this.#database.prepare(`UPDATE source_release_operations SET status = 'completed', receipt_digest = ?,
        receipt_json = ?, completed_at = ? WHERE operation_id = ? AND status = 'pending' AND request_digest = ?
          AND release_fence = ?`).run(controlPlaneDigest(receipt), JSON.stringify(receipt), now, operation.operationId,
        operation.requestDigest, input.expectedFence)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source release completion lost its single-flight')
      this.#database.exec('COMMIT')
      return receipt
    } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  async applySourceRelease(input: { planId: string; expectedRevision: number; expectedFence: number;
    receipt: SourceReleaseReceipt; resolveAuthority: (receipt: SourceReleaseReceipt) => SourceReleaseAuthority;
    idempotencyKey: string }): Promise<OperationReceipt<PluginSourcePlan>> {
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
      return replay
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
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#database.prepare(`UPDATE source_plans SET status = ?, revision = revision + 1,
        release_failure_phase = ?, release_failure_code = ?, updated_at = ?
        WHERE id = ? AND status = ? AND revision = ? AND release_id = ? AND release_fence = ?`).run(
        nextStatus, failurePhase, failureCode, now, plan.id, plan.status, plan.revision, plan.release.id, input.expectedFence)
      if (Number(result.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source release receipt lost its plan CAS')
      const applied = this.#database.prepare(`UPDATE source_release_operations SET status = 'applied', applied_at = ?
        WHERE operation_id = ? AND status = 'completed' AND receipt_digest = ? AND release_fence = ?`).run(
        now, operation.operationId, controlPlaneDigest(input.receipt), input.expectedFence)
      if (Number(applied.changes) !== 1) throw new ControlPlaneStoreError('conflict', 'source release operation lost its apply CAS')
      const output = this.getSourcePlan(plan.id)
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
      (SELECT count(*) FROM activation_plans WHERE status = 'rollback-pending') AS rollback_pending`).get() as {
        gaps: number; ready_plans: number; active_activations: number; failed: number; rollback_pending: number
      }
    return { gaps: row.gaps, readyPlans: row.ready_plans, activeActivations: row.active_activations, failed: row.failed, rollbackPending: row.rollback_pending }
  }

  #sourcePlanReceipt(idempotencyKey: string, operation: string, inputDigest: string, planId: string): OperationReceipt<PluginSourcePlan> | undefined {
    const receipt = this.#receipt<unknown>(idempotencyKey, operation, inputDigest)
    if (receipt === undefined) return undefined
    const result = sourceSnapshotFromStored(receipt.result); const authoritative = this.getSourcePlan(planId)
    if (result.id !== planId || result.digest !== authoritative.digest || result.gapId !== authoritative.gapId
      || result.revision > authoritative.revision
      || (result.approval !== undefined && controlPlaneDigest(result.approval) !== controlPlaneDigest(authoritative.approval))
      || (result.sourceCheck !== undefined && controlPlaneDigest(result.sourceCheck) !== controlPlaneDigest(authoritative.sourceCheck))
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
      || snapshot.approval !== undefined || snapshot.sourceCheck !== undefined || snapshot.releaseAuthorization !== undefined
      || snapshot.release !== undefined || controlPlaneDigest(replayBinding) !== inputDigest) {
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
    const replayBinding = { operation: 'create-activation-plan', gapId: snapshot.gapId, candidate: snapshot.candidate,
      catalog: { digest: snapshot.dossier.catalogDigest, provenance: snapshot.dossier.catalogProvenance },
      matchedCapabilities: snapshot.dossier.matchedCapabilities, profile: snapshot.profile, target: snapshot.target,
      installationId: snapshot.installationId, ledger: snapshot.ledger, executor: snapshot.executor,
      ttlMs: snapshot.expiresAt - snapshot.createdAt }
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
