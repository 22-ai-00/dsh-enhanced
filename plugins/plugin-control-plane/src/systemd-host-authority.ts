/** Finite owner authorization for the external systemd Host attestor. */
import { closeSync, constants as fsConstants, fsyncSync, openSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Ed25519ApprovalAuthority } from './approval.js'
import { validateLiveQualificationTerms, type LiveQualificationTerms } from './live-qualification.js'
import { sourceAuthorityCanonicalSafePath, sourceAuthorityReadSafeFile } from './source-approval-authority.js'
import { parseRuntimeEpochRequest, type RuntimeEpochRequest } from './runtime-epoch.js'
import { controlPlaneDigest, readOwnerHostAttestationContext, readOwnerRuntimeEpochContext, validateHostDeploymentInputs } from './store.js'
import { PROTECTED_PLUGIN_DENYLIST } from './source-workspace.js'
import { loadTrustConfig, resolveTrustKey } from './trust.js'
import type { SourceJobOwnerReceipt } from './source-job-types.js'
import type { HostAttestationRequest } from './types.js'
import type { RuntimeObserverConfig } from './runtime-observer-protocol.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const PACKAGE = /^@dsh-enhanced\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/u
const MAX_REQUEST_BYTES = 65_536
const MAX_CONFIG_BYTES = 65_536

type Pin = { path: string; sha256: string }
type Template = {
  authority: string; keyId: string; privateKeyPath: string; stateRoot: string
  executable: Pin; interpreter: Pin; processHelper: Pin
  systemctl: Pin & { interpreter: Pin | null }
  scope: 'user' | 'system'; unit: string
  unitProperties: Record<'FragmentPath' | 'DropInPaths' | 'ExecStart' | 'Environment' | 'WorkingDirectory' | 'User' | 'Group' | 'Type' | 'KillMode', string>
  timeoutMs: number; stableWindowMs: number; pollIntervalMs: number
  readiness: { client: Pin; observer: RuntimeObserverConfig }
  recoveryReadiness: { client: Pin; observer: RuntimeObserverConfig }
}
type Owner = Pick<SourceJobOwnerReceipt, 'authorityId' | 'authorityHash' | 'principalId' | 'principalRecordId' | 'principalVersion' | 'workspace' | 'agentPreset'>

export interface SystemdHostAuthorityConfig {
  schemaVersion: 1
  statePath: string
  controlDatabasePath: string
  trustPath: string
  grant: {
    id: string; notBefore: number; expiresAt: number; maximumReloads: number
    owner: Owner
    profile: { name: string; path: string }
    packages: readonly string[]
    coordinatorId: string
    hostDeploymentInputs: readonly string[]
    liveQualification: LiveQualificationTerms
  }
  template: Template
}

export class SystemdHostAuthorityError extends Error {
  constructor() { super('systemd Host authority refused the request'); this.name = 'SystemdHostAuthorityError' }
}
function fail(): never { throw new SystemdHostAuthorityError() }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail()
}
function same(a: unknown, b: unknown): boolean { return controlPlaneDigest(a) === controlPlaneDigest(b) }
function text(value: unknown, pattern = ID, max = 4096): string {
  if (typeof value !== 'string' || value.normalize('NFC').trim() !== value || !pattern.test(value)
    || Buffer.byteLength(value) > max || /[\p{Cc}]/u.test(value)) fail()
  return value
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail()
  return Number(value)
}
function path(value: unknown): string {
  const pathname = text(value, /^[\s\S]+$/u)
  if (!isAbsolute(pathname) || pathname === '/' || resolve(pathname) !== pathname) fail()
  return pathname
}
function pin(value: unknown): Pin {
  const item = object(value); exact(item, ['path', 'sha256'])
  return { path: path(item.path), sha256: text(item.sha256, DIGEST, 64) }
}
function owner(value: unknown): Owner {
  const item = object(value)
  exact(item, ['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset'])
  return { authorityId: text(item.authorityId), authorityHash: text(item.authorityHash, DIGEST, 64),
    principalId: text(item.principalId, /^[\s\S]+$/u, 512), principalRecordId: text(item.principalRecordId, /^[\s\S]+$/u, 512),
    principalVersion: integer(item.principalVersion, 1), workspace: path(item.workspace), agentPreset: text(item.agentPreset) }
}

export function validateSystemdHostAuthorityConfig(value: unknown): asserts value is SystemdHostAuthorityConfig {
  const item = object(value); exact(item, ['schemaVersion', 'statePath', 'controlDatabasePath', 'trustPath', 'grant', 'template'])
  if (item.schemaVersion !== 1) fail()
  const statePath = path(item.statePath), controlPath = path(item.controlDatabasePath), trustPath = path(item.trustPath)
  if (new Set([statePath, controlPath, trustPath]).size !== 3) fail()
  const grant = object(item.grant)
  exact(grant, ['id', 'notBefore', 'expiresAt', 'maximumReloads', 'owner', 'profile', 'packages', 'coordinatorId', 'hostDeploymentInputs', 'liveQualification'])
  text(grant.id); const notBefore = integer(grant.notBefore, 0)
  integer(grant.expiresAt, notBefore + 1); integer(grant.maximumReloads, 1, 1000)
  owner(grant.owner)
  const profile = object(grant.profile); exact(profile, ['name', 'path'])
  const profileName = text(profile.name, /^[a-z0-9][a-z0-9-]{0,63}$/u, 64)
  const profilePath = path(profile.path)
  if (dirname(profilePath) === profilePath || resolve(profilePath) !== profilePath
    || profilePath !== `${dirname(profilePath)}/${profileName}` || !dirname(profilePath).endsWith('/profiles')) fail()
  if ([statePath, controlPath, trustPath].some(value => value === profilePath || value.startsWith(`${profilePath}/`))) fail()
  text(grant.coordinatorId)
  if (!Array.isArray(grant.packages) || grant.packages.length < 1 || grant.packages.length > 32) fail()
  const packages = grant.packages.map(item => text(item, PACKAGE, 128))
  if (new Set(packages).size !== packages.length || packages.some(item => PROTECTED_PLUGIN_DENYLIST.has(item.slice('@dsh-enhanced/'.length)))) fail()
  validateHostDeploymentInputs(grant.hostDeploymentInputs)
  validateLiveQualificationTerms(grant.liveQualification)
  const template = object(item.template)
  exact(template, ['authority', 'keyId', 'privateKeyPath', 'stateRoot', 'executable', 'interpreter', 'processHelper', 'systemctl',
    'scope', 'unit', 'unitProperties', 'timeoutMs', 'stableWindowMs', 'pollIntervalMs', 'readiness', 'recoveryReadiness'])
  text(template.authority); text(template.keyId); path(template.privateKeyPath); path(template.stateRoot)
  pin(template.executable); pin(template.interpreter); pin(template.processHelper)
  const systemctl = object(template.systemctl); exact(systemctl, ['path', 'sha256', 'interpreter'])
  path(systemctl.path); text(systemctl.sha256, DIGEST, 64)
  if (systemctl.interpreter !== null) pin(systemctl.interpreter)
  if (template.scope !== 'user' && template.scope !== 'system') fail()
  if (template.unit !== `dsh-profile-${profile.name}.service`) fail()
  const unitProperties = object(template.unitProperties)
  exact(unitProperties, ['FragmentPath', 'DropInPaths', 'ExecStart', 'Environment', 'WorkingDirectory', 'User', 'Group', 'Type', 'KillMode'])
  for (const value of Object.values(unitProperties)) text(value, /^[^\r\n]*$/u)
  const timeout = integer(template.timeoutMs, 1000, 60000)
  const stable = integer(template.stableWindowMs, 50, 10000), poll = integer(template.pollIntervalMs, 25, 1000)
  if (stable + poll >= timeout) fail()
  for (const field of ['readiness', 'recoveryReadiness'] as const) {
    const readiness = object(template[field]); exact(readiness, ['client', 'observer'])
    pin(readiness.client)
    const observer = object(readiness.observer)
    exact(observer, ['socketPath', 'keyPath', 'profilePath', 'targets'])
    path(observer.socketPath); path(observer.keyPath)
    if (observer.profilePath !== profile.path || !Array.isArray(observer.targets) || observer.targets.length < 1 || observer.targets.length > 32) fail()
  }
}

function contextFor(controlPath: string, operationId: string): ReturnType<typeof readOwnerHostAttestationContext> {
  const db = new DatabaseSync(sourceAuthorityCanonicalSafePath(controlPath, 'file'), { readOnly: true })
  try { db.exec('PRAGMA query_only=ON; BEGIN;'); const context = readOwnerHostAttestationContext(db, operationId); db.exec('COMMIT'); return context }
  catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
  finally { db.close() }
}

function runtimeEpochContextFor(controlPath: string, operationId: string): ReturnType<typeof readOwnerRuntimeEpochContext> {
  const db = new DatabaseSync(sourceAuthorityCanonicalSafePath(controlPath, 'file'), { readOnly: true })
  try { db.exec('PRAGMA query_only=ON; BEGIN;'); const context = readOwnerRuntimeEpochContext(db, operationId); db.exec('COMMIT'); return context }
  catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
  finally { db.close() }
}

function sameOwner(actual: SourceJobOwnerReceipt, expected: Owner): boolean {
  return actual.authorityId === expected.authorityId && actual.authorityHash === expected.authorityHash
    && actual.principalId === expected.principalId && actual.principalRecordId === expected.principalRecordId
    && actual.principalVersion === expected.principalVersion && actual.workspace === expected.workspace && actual.agentPreset === expected.agentPreset
}

type ExactConfig = Record<string, unknown>

async function derive(config: SystemdHostAuthorityConfig, request: HostAttestationRequest, now: number): Promise<{ result: ExactConfig; witnessDigest: string; contextDigest: string; trustDigest: string }> {
  const trust = await loadTrustConfig(config.trustPath)
  const context = contextFor(config.controlDatabasePath, request.operationId)
  const { plan, source, released, handoff, approvalReceipt, operation, dispatch, witness } = context
  if (request.schemaVersion !== 2 || !['reload', 'readiness', 'rollback'].includes(request.phase)
    || !same(operation.request, request) || operation.requestDigest !== controlPlaneDigest(request)
    || dispatch.status !== 'claimed' || !Number.isSafeInteger(dispatch.claimedAt)
    || plan.id !== request.plan.id || plan.digest !== request.plan.digest
    || plan.activation?.id !== request.activation.id || plan.activation.fence !== request.activation.fence
    || plan.installationId !== request.installationId || !same(plan.ledger, request.ledger)
    || plan.profile !== request.profile.name || plan.target.profilePath !== request.profile.path
    || !sameOwner(source.owner, config.grant.owner) || !same(released, plan.candidate)
    || !config.grant.packages.includes(released.package) || PROTECTED_PLUGIN_DENYLIST.has(released.id)
    || plan.dossier.catalogProvenance !== 'owner-provided-integrity-pinned'
    || !same(plan.dossier.hostDeploymentInputs, config.grant.hostDeploymentInputs)
    || !same(plan.dossier.liveQualification, config.grant.liveQualification)
    || !plan.dossier.handoff || plan.dossier.handoff.coordinatorId !== config.grant.coordinatorId
    || handoff.coordinatorId !== config.grant.coordinatorId || handoff.planId !== plan.id || handoff.planDigest !== plan.digest
    || trust.installationId !== request.installationId || !same(trust.ledger, request.ledger)
    || trust.dshHome !== plan.target.dshHome || trust.ledger.path !== config.controlDatabasePath
    || trust.hostAttestor === undefined || request.issuer.mode !== 'configured-executable'
    || !same({ mode: 'configured-executable', id: trust.hostAttestor.id, version: trust.hostAttestor.version, path: trust.hostAttestor.path,
      sha256: trust.hostAttestor.sha256, interpreter: trust.hostAttestor.interpreter, authority: trust.hostAttestor.authority,
      keyId: trust.hostAttestor.keyId }, request.issuer)
    || !same({ authority: config.template.authority, keyId: config.template.keyId,
      executable: config.template.executable, interpreter: config.template.interpreter },
    { authority: trust.hostAttestor.authority, keyId: trust.hostAttestor.keyId,
      executable: { path: trust.hostAttestor.path, sha256: trust.hostAttestor.sha256 }, interpreter: trust.hostAttestor.interpreter })) fail()
  if (config.grant.profile.name !== plan.profile || config.grant.profile.path !== plan.target.profilePath) fail()
  const key = resolveTrustKey(trust, 'approval', approvalReceipt.authority, approvalReceipt.keyId)
  const recovering = request.phase === 'rollback'
  const verifiedAt = recovering ? witness?.createdAt : dispatch.claimedAt
  if (verifiedAt === undefined) fail()
  const verified = await new Ed25519ApprovalAuthority(key.publicKeyPem, key.authority, key.keyId, () => verifiedAt).verify(approvalReceipt, plan)
  if (!same(verified, plan.approval)) fail()

  if (!recovering) {
    if (now < config.grant.notBefore || now >= config.grant.expiresAt || request.requestedAt < config.grant.notBefore
      || request.requestedAt > now || dispatch.claimedAt < config.grant.notBefore || dispatch.claimedAt >= config.grant.expiresAt
      || handoff.revokedAt !== undefined || handoff.expiresAt <= now || plan.expiresAt <= now
      || approvalReceipt.expiresAt <= now || !witness || witness.activationId !== request.activation.id
      || witness.fence !== request.activation.fence || witness.planDigest !== plan.digest
      || !same(witness.inputs, config.grant.hostDeploymentInputs)) fail()
  } else if (request.requirements.kind !== 'rollback' || !witness || !plan.activation.hostRecoveryRequired
    || !plan.activation.rollbackProfileRestored || !plan.activation.targetBaselineFiles
    || !same(request.requirements.baselineFiles, plan.activation.targetBaselineFiles)
    || request.requirements.action !== (plan.activation.targetOriginallyExisted ? 'restore' : 'stop')
    || (request.requirements.action === 'restore' && !witness)) fail()

  const forwardExpiry = Math.min(config.grant.expiresAt, plan.expiresAt, approvalReceipt.expiresAt, handoff.expiresAt)
  // Physical recovery is a separate, exact, short-lived obligation after an
  // already exposed plan. It does not renew forward installation authority.
  const expiresAt = recovering ? dispatch.claimedAt + Math.max(config.template.timeoutMs + 1000, request.receiptTtlMs) : forwardExpiry
  if (expiresAt <= now) fail()
  const auth = { installationId: request.installationId, ledger: request.ledger, profile: request.profile,
    plan: request.plan, activation: request.activation,
    ...(request.phase === 'readiness' ? { hostGeneration: request.predecessor?.hostGeneration }
      : { previousHostGeneration: request.requirements.kind === 'reload' || request.requirements.kind === 'rollback'
        ? request.requirements.previousHostGeneration : undefined }),
    requestDigest: controlPlaneDigest(request), notBefore: recovering ? request.requestedAt : config.grant.notBefore,
    expiresAt }
  let profileFiles: readonly { path: string; sha256: string | null }[]
  let readiness: Record<string, unknown> | null | undefined
  if (request.phase === 'rollback') {
    profileFiles = plan.activation.targetBaselineFiles!
    readiness = request.requirements.kind === 'rollback' && request.requirements.action === 'restore'
      ? { ...config.template.recoveryReadiness, deploymentFiles: witness!.baselineDeploymentFiles.map(item => ({ path: item.path, sha256: item.sha256 })) }
      : null
  } else {
    profileFiles = witness!.profileFiles
    if (request.phase === 'readiness') readiness = { ...config.template.readiness,
      deploymentFiles: witness!.deploymentFiles.map(item => ({ path: item.path, sha256: item.sha256 })),
      reloadOperationId: request.predecessor?.operationId }
  }
  const { readiness: _readiness, recoveryReadiness: _recoveryReadiness, ...base } = config.template
  const result = { schemaVersion: request.phase === 'reload' ? 1 : request.phase === 'readiness' ? 2 : 3,
    ...base, profileFiles, authorization: auth, ...(readiness === undefined ? {} : { readiness }) }
  return { result, witnessDigest: witness?.digest ?? controlPlaneDigest({ baseline: plan.activation.targetBaselineFiles }),
    contextDigest: controlPlaneDigest(context), trustDigest: controlPlaneDigest(trust) }
}

/** Standing authority observes a fresh Host instance of an already successful deployment. */
async function deriveRuntimeEpoch(config: SystemdHostAuthorityConfig, request: RuntimeEpochRequest, now: number): Promise<{
  result: ExactConfig; witnessDigest: string; contextDigest: string; trustDigest: string
}> {
  const trust = await loadTrustConfig(config.trustPath)
  const context = runtimeEpochContextFor(config.controlDatabasePath, request.operationId)
  const { plan, source, released, handoff, approvalReceipt, witness, readiness } = context
  const receipt = readiness.receipt
  if (!same(context.request, request) || context.status !== 'claimed' || context.createdAt !== request.requestedAt
    || plan.id !== request.plan.id || plan.digest !== request.plan.digest
    || plan.activation?.id !== request.activation.id || plan.activation.fence !== request.activation.fence
    || plan.installationId !== request.installationId || !same(plan.ledger, request.ledger)
    || plan.profile !== request.profile.name || plan.target.profilePath !== request.profile.path
    || config.grant.profile.name !== plan.profile || config.grant.profile.path !== plan.target.profilePath
    || !sameOwner(source.owner, config.grant.owner) || !same(released, plan.candidate)
    || !config.grant.packages.includes(released.package) || PROTECTED_PLUGIN_DENYLIST.has(released.id)
    || plan.dossier.catalogProvenance !== 'owner-provided-integrity-pinned'
    || !same(plan.dossier.hostDeploymentInputs, config.grant.hostDeploymentInputs)
    || !same(plan.dossier.liveQualification, config.grant.liveQualification)
    || !plan.dossier.handoff || plan.dossier.handoff.coordinatorId !== config.grant.coordinatorId
    || handoff.coordinatorId !== config.grant.coordinatorId || handoff.planId !== plan.id || handoff.planDigest !== plan.digest
    || handoff.revokedAt !== undefined
    || !witness || witness.activationId !== request.activation.id || witness.fence !== request.activation.fence
    || witness.planDigest !== plan.digest || !same(witness.inputs, config.grant.hostDeploymentInputs)
    || readiness.status !== 'applied' || readiness.phase !== 'readiness' || !receipt || receipt.outcome !== 'passed'
    || !Number.isSafeInteger(readiness.createdAt) || readiness.createdAt < plan.createdAt
    || readiness.operationId !== request.predecessor.operationId
    || controlPlaneDigest(receipt) !== request.predecessor.receiptDigest
    || receipt.hostGeneration !== request.predecessor.hostGeneration
    || receipt.planId !== plan.id || receipt.planDigest !== plan.digest
    || receipt.activationId !== request.activation.id || receipt.fence !== request.activation.fence
    || trust.installationId !== request.installationId || !same(trust.ledger, request.ledger)
    || trust.dshHome !== plan.target.dshHome || trust.ledger.path !== config.controlDatabasePath
    || trust.hostAttestor === undefined
    || !same({ mode: 'configured-executable', id: trust.hostAttestor.id, version: trust.hostAttestor.version,
      path: trust.hostAttestor.path, sha256: trust.hostAttestor.sha256, interpreter: trust.hostAttestor.interpreter,
      authority: trust.hostAttestor.authority, keyId: trust.hostAttestor.keyId }, request.issuer)
    || !same({ authority: config.template.authority, keyId: config.template.keyId,
      executable: config.template.executable, interpreter: config.template.interpreter },
    { authority: trust.hostAttestor.authority, keyId: trust.hostAttestor.keyId,
      executable: { path: trust.hostAttestor.path, sha256: trust.hostAttestor.sha256 }, interpreter: trust.hostAttestor.interpreter })) fail()

  const key = resolveTrustKey(trust, 'approval', approvalReceipt.authority, approvalReceipt.keyId)
  const verified = await new Ed25519ApprovalAuthority(key.publicKeyPem, key.authority, key.keyId,
    () => readiness.createdAt).verify(approvalReceipt, plan)
  if (!same(verified, plan.approval)) fail()
  const expiresAt = Math.min(config.grant.expiresAt, request.requestedAt + request.receiptTtlMs)
  if (now < config.grant.notBefore || now >= expiresAt || request.requestedAt < config.grant.notBefore
    || request.requestedAt > now || expiresAt <= request.requestedAt) fail()

  const { readiness: _readiness, recoveryReadiness: _recoveryReadiness, ...base } = config.template
  const result = { schemaVersion: context.maintenance.length ? 6 : 5, ...base, profileFiles: witness.profileFiles,
    ...(context.maintenance.length ? { maintenance: context.maintenance } : {}),
    authorization: { installationId: request.installationId, ledger: request.ledger, profile: request.profile,
      plan: request.plan, activation: request.activation, hostGeneration: request.predecessor.hostGeneration,
      requestDigest: controlPlaneDigest(request), notBefore: config.grant.notBefore, expiresAt },
    readiness: { ...config.template.readiness,
      deploymentFiles: witness.deploymentFiles.map(item => ({ path: item.path, sha256: item.sha256 })) } }
  return { result, witnessDigest: witness.digest, contextDigest: controlPlaneDigest(context), trustDigest: controlPlaneDigest(trust) }
}

function journal(pathname: string): DatabaseSync {
  sourceAuthorityCanonicalSafePath(dirname(pathname), 'directory')
  sourceAuthorityCanonicalSafePath(pathname, 'file', true)
  const directory = openSync(dirname(pathname), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
  const db = new DatabaseSync(pathname)
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS systemd_host_grants (grant_id TEXT PRIMARY KEY, grant_digest TEXT NOT NULL, config_digest TEXT NOT NULL, trust_digest TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS systemd_host_operations (operation_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, phase TEXT NOT NULL,
      request_digest TEXT NOT NULL, config_digest TEXT NOT NULL, witness_digest TEXT NOT NULL, context_digest TEXT NOT NULL,
      config_json TEXT NOT NULL, UNIQUE(grant_id, operation_id)) STRICT;`)
  return db
}

export async function resolveSystemdHostAuthority(configInput: SystemdHostAuthorityConfig,
  requestInput: HostAttestationRequest | RuntimeEpochRequest): Promise<ExactConfig> {
  try {
    validateSystemdHostAuthorityConfig(configInput)
    const config = configInput
    if (!requestInput || typeof requestInput !== 'object') fail()
    const runtimeEpoch = requestInput.kind === 'dsh-runtime-epoch-request'
    if (!runtimeEpoch && requestInput.kind !== 'dsh-host-attestation-request') fail()
    const request = runtimeEpoch ? parseRuntimeEpochRequest(requestInput) : requestInput
    const deriveRequest = () => runtimeEpoch
      ? deriveRuntimeEpoch(config, request as RuntimeEpochRequest, Date.now())
      : derive(config, request as HostAttestationRequest, Date.now())
    const first = await deriveRequest()
    const db = journal(config.statePath)
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        const second = await deriveRequest()
        if (!same(first, second)) fail()
        const configDigest = controlPlaneDigest(config)
        const grantDigest = controlPlaneDigest(config.grant)
        const row = db.prepare('SELECT * FROM systemd_host_grants WHERE grant_id=?').get(config.grant.id) as
          { grant_digest: string; config_digest: string; trust_digest: string } | undefined
        if (row === undefined) db.prepare('INSERT INTO systemd_host_grants VALUES (?,?,?,?)').run(config.grant.id, grantDigest, configDigest, second.trustDigest)
        else if (row.grant_digest !== grantDigest || row.config_digest !== configDigest || row.trust_digest !== second.trustDigest) fail()
        const previous = db.prepare('SELECT * FROM systemd_host_operations WHERE operation_id=?').get(request.operationId) as
          { grant_id: string; phase: string; request_digest: string; config_digest: string; witness_digest: string;
            context_digest: string; config_json: string } | undefined
        const phase = runtimeEpoch ? 'runtime-epoch' : (request as HostAttestationRequest).phase
        const requestDigest = controlPlaneDigest(request), outputDigest = controlPlaneDigest(second.result)
        if (previous !== undefined) {
          if (previous.grant_id !== config.grant.id || previous.phase !== phase || previous.request_digest !== requestDigest
            || previous.config_digest !== outputDigest || previous.witness_digest !== second.witnessDigest
            || previous.context_digest !== second.contextDigest || controlPlaneDigest(JSON.parse(previous.config_json)) !== outputDigest) fail()
          db.exec('COMMIT'); return JSON.parse(previous.config_json) as ExactConfig
        }
        if ((phase === 'reload' || phase === 'runtime-epoch') && (db.prepare('SELECT COUNT(*) AS n FROM systemd_host_operations WHERE grant_id=? AND phase=?')
          .get(config.grant.id, phase) as { n: number }).n >= config.grant.maximumReloads) fail()
        const json = JSON.stringify(second.result)
        if (Buffer.byteLength(json) + 1 > 524_288) fail()
        db.prepare('INSERT INTO systemd_host_operations VALUES (?,?,?,?,?,?,?,?)').run(request.operationId, config.grant.id,
          phase, requestDigest, outputDigest, second.witnessDigest, second.contextDigest, json)
        db.exec('COMMIT'); return second.result
      } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
    } finally { db.close() }
  } catch { throw new SystemdHostAuthorityError() }
}

/** One bounded request in, one exact schema-1/2/3/5 configuration out. */
export async function runSystemdHostAuthority(argv = process.argv.slice(2)): Promise<void> {
  try {
    if (argv.length !== 2 || argv[0] !== '--config') fail()
    const configPath = path(argv[1])
    const config = JSON.parse(sourceAuthorityReadSafeFile(configPath, MAX_CONFIG_BYTES).toString('utf8')) as SystemdHostAuthorityConfig
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if ((size += bytes.length) > MAX_REQUEST_BYTES) fail()
      chunks.push(bytes)
    }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HostAttestationRequest | RuntimeEpochRequest
    process.stdout.write(`${JSON.stringify(await resolveSystemdHostAuthority(config, request))}\n`)
  } catch { throw new SystemdHostAuthorityError() }
}
