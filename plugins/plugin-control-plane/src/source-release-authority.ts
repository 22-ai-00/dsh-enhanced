/** Owner-operated finite signer for a checked local source release authorization. It never executes a release phase. */
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseSourceReleaseAuthorization, sourceReleaseAuthorizationSigningPayload } from './release.js'
import {
  sourceAuthorityCanonicalSafePath, sourceAuthorityReadSafeFile, sourceAuthorityValidatePrepared,
  sourceAuthorityValidateWorktree, sourceAuthorityEnvironment, type SourceAuthorityWorktreeGrant,
} from './source-approval-authority.js'
import { controlPlaneDigest, readOwnerPreparedSourcePlan } from './store.js'
import { verifyManagedPatchVersion } from './source-versioning.js'
import { PROTECTED_PLUGIN_DENYLIST } from './source-workspace.js'
import type { SourceJobOwnerReceipt } from './source-job-types.js'
import type { SourceReleaseAuthorization, SourceReleasePolicy } from './types.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const MAX_CONFIG_BYTES = 65_536; const MAX_REQUEST_BYTES = 8_192; const MAX_KEY_BYTES = 32_768
type PolicyConfig = Omit<SourceReleasePolicy, 'packageVersion' | 'registryReference'>

export interface SourceReleaseAuthorityRequest {
  protocol: 'dsh-source-release-authorization/v1'
  planId: string
  planDigest: string
  sourceReferenceDigest: string
}

export interface SourceReleaseAuthorityConfig {
  schemaVersion: 1
  authority: string
  keyId: string
  keyPath: string
  statePath: string
  controlDatabasePath: string
  grant: SourceAuthorityWorktreeGrant & {
    id: string; expiresAt: number; maxReleases: number
    owner: Pick<SourceJobOwnerReceipt, 'authorityId' | 'authorityHash' | 'principalId' | 'principalRecordId' | 'principalVersion' | 'workspace' | 'agentPreset'>
    receiptTtlMs: number; versioning: 'patch'; policies: readonly PolicyConfig[]
  }
}

export class SourceReleaseAuthorityError extends Error {
  constructor(message = 'source release authority refused the request') { super(message); this.name = 'SourceReleaseAuthorityError' }
}
function fail(): never { throw new SourceReleaseAuthorityError() }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); return value as Record<string, unknown> }
function keys(value: Record<string, unknown>, expected: readonly string[]): void { if (Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) fail() }
function text(value: unknown, pattern = ID, max = 4096): string { if (typeof value !== 'string' || value.normalize('NFC').trim() !== value || !pattern.test(value) || Buffer.byteLength(value) > max || /[\p{Cc}]/u.test(value)) fail(); return value }
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(); return Number(value) }
function path(value: unknown): string { const result = text(value, /^[\s\S]+$/u); if (!result.startsWith('/') || resolve(result) !== result) fail(); return result }
function sameOwner(left: SourceJobOwnerReceipt, right: SourceReleaseAuthorityConfig['grant']['owner']): boolean {
  return left.authorityId === right.authorityId && left.authorityHash === right.authorityHash && left.principalId === right.principalId
    && left.principalRecordId === right.principalRecordId && left.principalVersion === right.principalVersion
    && left.workspace === right.workspace && left.agentPreset === right.agentPreset
}

function policy(value: unknown, plugins: readonly string[]): PolicyConfig {
  const item = object(value); const fields = ['targetBranch', 'candidateId', 'packageName', 'packagePath', 'dshBaseline', 'capabilities', 'authorities', 'requires', 'registryId', 'registryLocator', 'catalogId', 'catalogPath', 'minimumReproducibleBuilds']
  keys(item, fields)
  const candidateId = text(item.candidateId, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, 64)
  if (!plugins.includes(candidateId) || item.packageName !== `@dsh-enhanced/${candidateId}` || item.packagePath !== `plugins/${candidateId}`) fail()
  const locator = text(item.registryLocator, /^[\s\S]+$/u); registryRoot(locator)
  sourceAuthorityCanonicalSafePath(path(item.catalogPath), 'file')
  // Parse a complete envelope through the production policy parser now. The
  // two deliberately dynamic fields are replaced before the real signature.
  const envelope = { schemaVersion: 1, kind: 'dsh-source-release-authorization', authorizationId: 'config-policy', authority: 'config', keyId: 'config',
    planId: 'config-plan', planDigest: 'a'.repeat(64), baseCommit: 'b'.repeat(40), checkedTreeDigest: 'c'.repeat(64), checkedPatchDigest: 'd'.repeat(64),
    scope: [`plugins/${candidateId}`], releasePolicy: { ...item, packageVersion: '0.0.1', registryReference: 'file:///configured-reference' },
    authorizedAt: 1, expiresAt: 2, signature: Buffer.alloc(64).toString('base64') }
  try {
    const parsed = parseSourceReleaseAuthorization(envelope)
    const { packageVersion: _version, registryReference: _reference, ...staticPolicy } = parsed.releasePolicy
    return Object.freeze(staticPolicy)
  } catch { fail() }
}

export function validateSourceReleaseAuthorityConfig(value: unknown): asserts value is SourceReleaseAuthorityConfig {
  const item = object(value); keys(item, ['schemaVersion', 'authority', 'keyId', 'keyPath', 'statePath', 'controlDatabasePath', 'grant'])
  if (item.schemaVersion !== 1) fail(); text(item.authority); text(item.keyId)
  const keyPath = path(item.keyPath); const statePath = path(item.statePath); const control = path(item.controlDatabasePath)
  if (new Set([keyPath, statePath, control]).size !== 3) fail()
  const grant = object(item.grant); keys(grant, ['id', 'expiresAt', 'maxReleases', 'repository', 'worktreeRoot', 'owner', 'plugins', 'maxChangedFiles', 'maxChangedBytes', 'receiptTtlMs', 'versioning', 'policies'])
  text(grant.id); integer(grant.expiresAt, 1); integer(grant.maxReleases, 1, 10_000); path(grant.repository); path(grant.worktreeRoot)
  integer(grant.maxChangedFiles, 1, 256); integer(grant.maxChangedBytes, 1, 16 * 1024 * 1024); integer(grant.receiptTtlMs, 1_000, 86_400_000)
  if (grant.versioning !== 'patch' || !Array.isArray(grant.plugins) || grant.plugins.length === 0 || grant.plugins.length > 32) fail()
  const plugins = grant.plugins.map(value => text(value, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, 64)); if (new Set(plugins).size !== plugins.length || plugins.some(value => PROTECTED_PLUGIN_DENYLIST.has(value))) fail()
  const owner = object(grant.owner); keys(owner, ['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset'])
  text(owner.authorityId); text(owner.authorityHash, DIGEST, 64); text(owner.principalId, /^[\s\S]+$/u, 512); text(owner.principalRecordId, /^[\s\S]+$/u, 512); integer(owner.principalVersion, 1); path(owner.workspace); text(owner.agentPreset)
  if (!Array.isArray(grant.policies) || grant.policies.length !== plugins.length) fail()
  const policies = grant.policies.map(value => policy(value, plugins)); if (new Set(policies.map(value => value.candidateId)).size !== policies.length) fail()
}

function request(value: unknown): SourceReleaseAuthorityRequest {
  const item = object(value); keys(item, ['protocol', 'planId', 'planDigest', 'sourceReferenceDigest'])
  if (item.protocol !== 'dsh-source-release-authorization/v1') fail()
  return Object.freeze({ protocol: 'dsh-source-release-authorization/v1', planId: text(item.planId), planDigest: text(item.planDigest, DIGEST, 64), sourceReferenceDigest: text(item.sourceReferenceDigest, DIGEST, 64) })
}

function registryRoot(locator: string): string {
  let raw: string
  try { raw = fileURLToPath(locator) } catch { fail() }
  const canonical = sourceAuthorityCanonicalSafePath(raw, 'directory')
  if (pathToFileURL(canonical).href !== locator) fail()
  return canonical
}

function releaseAuthorization(config: SourceReleaseAuthorityConfig, plan: ReturnType<typeof readOwnerPreparedSourcePlan>['plan'], policyInput: PolicyConfig,
  version: string, privateKey: ReturnType<typeof createPrivateKey>, now: number, expiresAt: number): SourceReleaseAuthorization {
  const root = registryRoot(policyInput.registryLocator)
  sourceAuthorityCanonicalSafePath(policyInput.catalogPath, 'file')
  const packageName = `@dsh-enhanced/${plan.name}`
  const registryReference = pathToFileURL(join(root, 'packages', encodeURIComponent(packageName), version, 'package.tgz')).href
  const releasePolicy = { ...policyInput, candidateId: plan.name, packageName, packagePath: `plugins/${plan.name}`, packageVersion: version, registryReference }
  const unsigned = { schemaVersion: 1 as const, kind: 'dsh-source-release-authorization' as const,
    authorizationId: `source-release-${controlPlaneDigest({ grant: config.grant.id, plan: plan.id, version }).slice(0, 40)}`,
    authority: config.authority, keyId: config.keyId, planId: plan.id, planDigest: plan.digest, baseCommit: plan.baseCommit,
    checkedTreeDigest: plan.sourceCheck!.treeDigest, checkedPatchDigest: plan.sourceCheck!.patchDigest, scope: plan.scope,
    releasePolicy, authorizedAt: now, expiresAt }
  const authorization = { ...unsigned, signature: sign(null, Buffer.from(sourceReleaseAuthorizationSigningPayload(unsigned)), privateKey).toString('base64') }
  try { return parseSourceReleaseAuthorization(authorization) } catch { fail() }
}

interface StoredRelease { request_digest: string; grant_id: string; config_digest: string; plan_id: string; plan_digest: string; receipt_json: string; receipt_digest: string }
function ledger(path: string): DatabaseSync {
  sourceAuthorityCanonicalSafePath(path, 'file', true)
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS source_release_grants (grant_id TEXT PRIMARY KEY, config_digest TEXT NOT NULL, key_fingerprint TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS source_release_receipts (request_digest TEXT PRIMARY KEY, grant_id TEXT NOT NULL, config_digest TEXT NOT NULL, plan_id TEXT NOT NULL UNIQUE, plan_digest TEXT NOT NULL, receipt_json TEXT NOT NULL, receipt_digest TEXT NOT NULL) STRICT;`)
  return db
}

export async function authorizePreparedSourceRelease(configInput: SourceReleaseAuthorityConfig, requestInput: SourceReleaseAuthorityRequest): Promise<SourceReleaseAuthorization> {
  try {
    validateSourceReleaseAuthorityConfig(configInput); const config = configInput; const requested = request(requestInput); const now = Date.now(); if (now >= config.grant.expiresAt) fail()
    const keyBytes = sourceAuthorityReadSafeFile(config.keyPath, MAX_KEY_BYTES); let privateKey: ReturnType<typeof createPrivateKey>
    try { privateKey = createPrivateKey(keyBytes) } catch { fail() }; if (privateKey.asymmetricKeyType !== 'ed25519') fail()
    const configDigest = controlPlaneDigest(config); const keyFingerprint = createHash('sha256').update(keyBytes).digest('hex')
    const control = new DatabaseSync(sourceAuthorityCanonicalSafePath(config.controlDatabasePath, 'file'), { readOnly: true })
    let source: ReturnType<typeof readOwnerPreparedSourcePlan>; let version: string
    try {
      control.exec('PRAGMA query_only = ON;'); source = readOwnerPreparedSourcePlan(control, requested.planId)
      if (source.plan.digest !== requested.planDigest || controlPlaneDigest(source.source) !== requested.sourceReferenceDigest || !sameOwner(source.source.owner, config.grant.owner)) fail()
      if (source.plan.approval === undefined || source.plan.approval.decision !== 'approved') fail(); sourceAuthorityValidatePrepared(source.plan, now, 'ready-for-human-review'); await sourceAuthorityValidateWorktree(source.plan, config.grant)
      version = (await verifyManagedPatchVersion({ worktree: source.plan.worktree, baseCommit: source.plan.baseCommit, name: source.plan.name,
        environment: sourceAuthorityEnvironment() })).version
      if (source.plan.preparedEvidence!.pack.version !== version) fail()
      const final = readOwnerPreparedSourcePlan(control, requested.planId)
      if (final.plan.status !== 'ready-for-human-review' || final.plan.digest !== source.plan.digest || controlPlaneDigest(final.source) !== controlPlaneDigest(source.source)) fail()
    } finally { control.close() }
    const selected = config.grant.policies.find(value => value.candidateId === source.plan.name); if (!selected) fail()
    const state = ledger(config.statePath)
    try {
      state.exec('BEGIN IMMEDIATE')
      try {
        const current = Date.now(); if (current >= config.grant.expiresAt) fail(); sourceAuthorityValidatePrepared(source.plan, current, 'ready-for-human-review')
        const expiresAt = Math.min(current + config.grant.receiptTtlMs, config.grant.expiresAt, source.plan.expiresAt); if (expiresAt <= current) fail()
        const grant = state.prepare('SELECT config_digest, key_fingerprint FROM source_release_grants WHERE grant_id = ?').get(config.grant.id) as { config_digest: string; key_fingerprint: string } | undefined
        if (!grant) state.prepare('INSERT INTO source_release_grants (grant_id, config_digest, key_fingerprint) VALUES (?, ?, ?)').run(config.grant.id, configDigest, keyFingerprint)
        else if (grant.config_digest !== configDigest || grant.key_fingerprint !== keyFingerprint) fail()
        const digest = controlPlaneDigest(requested); const prior = state.prepare('SELECT * FROM source_release_receipts WHERE request_digest = ?').get(digest) as StoredRelease | undefined
        if (prior) {
          if (prior.grant_id !== config.grant.id || prior.config_digest !== configDigest || prior.plan_id !== requested.planId || prior.plan_digest !== requested.planDigest || prior.receipt_digest !== controlPlaneDigest(prior.receipt_json)) fail()
          const replay = parseSourceReleaseAuthorization(JSON.parse(prior.receipt_json) as unknown); if (replay.expiresAt <= current || replay.authority !== config.authority || replay.keyId !== config.keyId) fail()
          state.exec('COMMIT'); return replay
        }
        if (state.prepare('SELECT 1 FROM source_release_receipts WHERE plan_id = ?').get(requested.planId) || (state.prepare('SELECT COUNT(*) AS count FROM source_release_receipts WHERE grant_id = ?').get(config.grant.id) as { count: number }).count >= config.grant.maxReleases) fail()
        const authorization = releaseAuthorization(config, source.plan, selected, version, privateKey, current, expiresAt); const json = JSON.stringify(authorization)
        state.prepare('INSERT INTO source_release_receipts (request_digest, grant_id, config_digest, plan_id, plan_digest, receipt_json, receipt_digest) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(digest, config.grant.id, configDigest, requested.planId, requested.planDigest, json, controlPlaneDigest(json)); state.exec('COMMIT'); return authorization
      } catch (error) { try { state.exec('ROLLBACK') } catch {} throw error }
    } finally { state.close() }
  } catch (error) { if (error instanceof SourceReleaseAuthorityError) throw error; throw new SourceReleaseAuthorityError() }
}

export async function runSourceReleaseAuthority(argv = process.argv.slice(2)): Promise<void> {
  try {
    if (argv.length !== 2 || argv[0] !== '--config') fail(); const bytes = sourceAuthorityReadSafeFile(path(argv[1]), MAX_CONFIG_BYTES)
    const chunks: Buffer[] = []; let size = 0; for await (const chunk of process.stdin) { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); if ((size += value.length) > MAX_REQUEST_BYTES) fail(); chunks.push(value) }
    const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown
    process.stdout.write(`${JSON.stringify(await authorizePreparedSourceRelease(config as SourceReleaseAuthorityConfig, input as SourceReleaseAuthorityRequest))}\n`)
  } catch { throw new SourceReleaseAuthorityError() }
}
