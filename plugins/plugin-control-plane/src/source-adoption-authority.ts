import { validateLiveQualificationTerms, type LiveQualificationTerms } from './live-qualification.js'
import { validateAdoptionHandoffTerms, type AdoptionHandoffTerms } from './adoption-handoff.js'
/** Finite owner signer for the durable source-release to activation binding. */
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { approvalSigningPayload, parseApprovalReceipt } from './approval.js'
import { loadCatalogWithMetadata, parseCatalog, type CatalogEntry, type CatalogPackage } from './catalog.js'
import { sourceAuthorityCanonicalSafePath, sourceAuthorityReadSafeFile } from './source-approval-authority.js'
import { controlPlaneDigest, readOwnerSourceAdoptionPlan } from './store.js'
import { PROTECTED_PLUGIN_DENYLIST } from './source-workspace.js'
import type { SourceJobOwnerReceipt } from './source-job-types.js'
import type { ApprovalReceipt } from './types.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const MAX_CONFIG_BYTES = 65_536; const MAX_REQUEST_BYTES = 8_192; const MAX_KEY_BYTES = 32_768

type AdoptionPolicy = {
  candidateId: string; packageName: string; dshBaseline: string; capabilities: readonly string[]; authorities: readonly string[]
  requires: readonly CatalogPackage[]; registryId: string; registryLocator: string
}

export interface SourceAdoptionAuthorityRequest {
  protocol: 'dsh-source-adoption/v1'
  /** The activation plan id. */
  planId: string
  planDigest: string
  sourceReferenceDigest: string
}

export interface SourceAdoptionAuthorityConfig {
  schemaVersion: 1
  authority: string
  keyId: string
  keyPath: string
  statePath: string
  controlDatabasePath: string
  grant: {
    id: string; expiresAt: number; maxAdoptions: number
    owner: Pick<SourceJobOwnerReceipt, 'authorityId' | 'authorityHash' | 'principalId' | 'principalRecordId' | 'principalVersion' | 'workspace' | 'agentPreset'>
    installationId: string
    ledger: { id: string; path: string }
    target: { dshHome: string; profile: string; profilePath: string }
    executor: { id: string; version: string; path: string; sha256: string }
    catalogPath: string
    receiptTtlMs: number
    handoff?: AdoptionHandoffTerms
    liveQualification?: LiveQualificationTerms
    policies: readonly AdoptionPolicy[]
  }
}

export class SourceAdoptionAuthorityError extends Error {
  constructor(message = 'source adoption authority refused the request') { super(message); this.name = 'SourceAdoptionAuthorityError' }
}
function fail(): never { throw new SourceAdoptionAuthorityError() }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); return value as Record<string, unknown> }
function keys(value: Record<string, unknown>, expected: readonly string[]): void { if (Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) fail() }
function text(value: unknown, pattern = ID, max = 4_096): string { if (typeof value !== 'string' || value.normalize('NFC').trim() !== value || !pattern.test(value) || Buffer.byteLength(value) > max || /[\p{Cc}]/u.test(value)) fail(); return value }
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(); return Number(value) }
function path(value: unknown): string { const result = text(value, /^[\s\S]+$/u); if (!result.startsWith('/') || result === '/' || sourceAuthorityCanonicalSafePath(result, 'file') !== result) fail(); return result }
function configuredPath(value: unknown): string { const result = text(value, /^[\s\S]+$/u); if (!result.startsWith('/') || result === '/' || resolve(result) !== result) fail(); return result }
function same(left: unknown, right: unknown): boolean { return controlPlaneDigest(left) === controlPlaneDigest(right) }

function sameOwner(left: SourceJobOwnerReceipt, right: SourceAdoptionAuthorityConfig['grant']['owner']): boolean {
  return left.authorityId === right.authorityId && left.authorityHash === right.authorityHash && left.principalId === right.principalId
    && left.principalRecordId === right.principalRecordId && left.principalVersion === right.principalVersion
    && left.workspace === right.workspace && left.agentPreset === right.agentPreset
}

function policy(value: unknown): AdoptionPolicy {
  const item = object(value); keys(item, ['candidateId', 'packageName', 'dshBaseline', 'capabilities', 'authorities', 'requires', 'registryId', 'registryLocator'])
  const candidateId = text(item.candidateId, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, 64)
  const packageName = text(item.packageName, /^@dsh-enhanced\/[a-z][a-z0-9-]*$/u, 128)
  if (packageName !== `@dsh-enhanced/${candidateId}` || PROTECTED_PLUGIN_DENYLIST.has(candidateId)) fail()
  const dshBaseline = text(item.dshBaseline, /^[0-9A-Za-z.+-]+$/u, 128)
  const registryId = text(item.registryId); const registryLocator = text(item.registryLocator, /^[\s\S]+$/u)
  if (!Array.isArray(item.capabilities) || !Array.isArray(item.authorities) || !Array.isArray(item.requires)) fail()
  // The catalog parser supplies the exact package and dependency grammar and
  // canonical dependency ordering used by a real admitted catalog entry.
  let parsed: CatalogEntry
  try {
    parsed = parseCatalog({ schemaVersion: 1, entries: [{ id: candidateId, package: packageName, version: '0.0.0', integrity: 'sha512-YQ==',
      dshBaseline, capabilities: item.capabilities, authorities: item.authorities, requires: item.requires }] }).entries[0]!
  } catch { fail() }
  if (new Set(parsed.capabilities).size !== parsed.capabilities.length || new Set(parsed.authorities).size !== parsed.authorities.length) fail()
  return Object.freeze({ candidateId, packageName, dshBaseline, capabilities: parsed.capabilities, authorities: parsed.authorities,
    requires: parsed.requires, registryId, registryLocator })
}

export function validateSourceAdoptionAuthorityConfig(value: unknown): asserts value is SourceAdoptionAuthorityConfig {
  const item = object(value); keys(item, ['schemaVersion', 'authority', 'keyId', 'keyPath', 'statePath', 'controlDatabasePath', 'grant'])
  if (item.schemaVersion !== 1) fail(); text(item.authority); text(item.keyId)
  const keyPath = path(item.keyPath); const statePath = configuredPath(item.statePath); const control = path(item.controlDatabasePath)
  if (new Set([keyPath, statePath, control]).size !== 3) fail()
  const grant = object(item.grant); keys(grant, ['id', 'expiresAt', 'maxAdoptions', 'owner', 'installationId', 'ledger', 'target', 'executor', 'catalogPath', 'receiptTtlMs', 'policies', ...(Object.hasOwn(grant, 'handoff') ? ['handoff'] : []), ...(Object.hasOwn(grant, 'liveQualification') ? ['liveQualification'] : [])])
  if (Object.hasOwn(grant, 'handoff')) validateAdoptionHandoffTerms(grant.handoff)
  if (Object.hasOwn(grant, 'liveQualification')) { validateLiveQualificationTerms(grant.liveQualification); if (!grant.handoff) fail() }
  text(grant.id); integer(grant.expiresAt, 1); integer(grant.maxAdoptions, 1, 10_000); text(grant.installationId)
  const owner = object(grant.owner); keys(owner, ['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset'])
  text(owner.authorityId); text(owner.authorityHash, DIGEST, 64); text(owner.principalId, /^[\s\S]+$/u, 512); text(owner.principalRecordId, /^[\s\S]+$/u, 512); integer(owner.principalVersion, 1); configuredPath(owner.workspace); text(owner.agentPreset)
  const ledger = object(grant.ledger); keys(ledger, ['id', 'path']); text(ledger.id); configuredPath(ledger.path)
  const target = object(grant.target); keys(target, ['dshHome', 'profile', 'profilePath']); configuredPath(target.dshHome); text(target.profile, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u, 64); configuredPath(target.profilePath)
  const executor = object(grant.executor); keys(executor, ['id', 'version', 'path', 'sha256']); text(executor.id); text(executor.version); configuredPath(executor.path); text(executor.sha256, DIGEST, 64)
  path(grant.catalogPath); integer(grant.receiptTtlMs, 1_000, 86_400_000)
  if (!Array.isArray(grant.policies) || grant.policies.length === 0 || grant.policies.length > 32) fail()
  const policies = grant.policies.map(policy); if (new Set(policies.map(item => item.candidateId)).size !== policies.length) fail()
}

function request(value: unknown): SourceAdoptionAuthorityRequest {
  const item = object(value); keys(item, ['protocol', 'planId', 'planDigest', 'sourceReferenceDigest'])
  if (item.protocol !== 'dsh-source-adoption/v1') fail()
  return Object.freeze({ protocol: 'dsh-source-adoption/v1', planId: text(item.planId), planDigest: text(item.planDigest, DIGEST, 64), sourceReferenceDigest: text(item.sourceReferenceDigest, DIGEST, 64) })
}

function exactPolicy(candidate: CatalogEntry, configured: AdoptionPolicy): boolean {
  return candidate.id === configured.candidateId && candidate.package === configured.packageName && candidate.dshBaseline === configured.dshBaseline
    && same(candidate.capabilities, configured.capabilities) && same(candidate.authorities, configured.authorities) && same(candidate.requires, configured.requires)
    && candidate.registry?.id === configured.registryId && candidate.registry.locator === configured.registryLocator
}

function receiptFor(config: SourceAdoptionAuthorityConfig, request: SourceAdoptionAuthorityRequest, privateKey: ReturnType<typeof createPrivateKey>, now: number, expiresAt: number): ApprovalReceipt {
  const unsigned: Omit<ApprovalReceipt, 'signature'> = { schemaVersion: 1, approvalId: `source-adoption-${controlPlaneDigest({ grant: config.grant.id, request }).slice(0, 40)}`,
    authority: config.authority, keyId: config.keyId, planId: request.planId, planDigest: request.planDigest, decision: 'approved', principal: config.grant.owner.principalId, decidedAt: now, expiresAt }
  try { return parseApprovalReceipt({ ...unsigned, signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), privateKey).toString('base64') }) } catch { fail() }
}

interface StoredAdoption { request_digest: string; grant_id: string; config_digest: string; plan_id: string; plan_digest: string; receipt_json: string; receipt_digest: string }
function ledger(pathname: string): DatabaseSync {
  sourceAuthorityCanonicalSafePath(pathname, 'file', true)
  const db = new DatabaseSync(pathname)
  db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS source_adoption_grants (grant_id TEXT PRIMARY KEY, config_digest TEXT NOT NULL, key_fingerprint TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS source_adoption_receipts (request_digest TEXT PRIMARY KEY, grant_id TEXT NOT NULL, config_digest TEXT NOT NULL, plan_id TEXT NOT NULL UNIQUE, plan_digest TEXT NOT NULL, receipt_json TEXT NOT NULL, receipt_digest TEXT NOT NULL) STRICT;`)
  return db
}

/** Signs only a pending activation that is durably bound to a completed source release. */
export async function authorizeSourceAdoption(configInput: SourceAdoptionAuthorityConfig, requestInput: SourceAdoptionAuthorityRequest): Promise<ApprovalReceipt> {
  try {
    validateSourceAdoptionAuthorityConfig(configInput); const config = configInput; const requested = request(requestInput); const initialNow = Date.now(); if (initialNow >= config.grant.expiresAt) fail()
    const keyBytes = sourceAuthorityReadSafeFile(config.keyPath, MAX_KEY_BYTES); let privateKey: ReturnType<typeof createPrivateKey>
    try { privateKey = createPrivateKey(keyBytes) } catch { fail() }; if (privateKey.asymmetricKeyType !== 'ed25519') fail()
    const configDigest = controlPlaneDigest(config); const keyFingerprint = createHash('sha256').update(keyBytes).digest('hex')
    const control = new DatabaseSync(sourceAuthorityCanonicalSafePath(config.controlDatabasePath, 'file'), { readOnly: true })
    let bound: ReturnType<typeof readOwnerSourceAdoptionPlan>
    try {
      control.exec('PRAGMA query_only = ON;'); bound = readOwnerSourceAdoptionPlan(control, requested.planId)
      const { plan, sourcePlan, source, released } = bound
      if (plan.digest !== requested.planDigest || controlPlaneDigest(source) !== requested.sourceReferenceDigest || plan.status !== 'pending-approval' || sourcePlan.status !== 'release-complete' || !sameOwner(source.owner, config.grant.owner)) fail()
      if (plan.installationId !== config.grant.installationId || !same(plan.ledger, config.grant.ledger) || !same(plan.target, config.grant.target) || !same(plan.executor, config.grant.executor)) fail()
      if (!same(plan.dossier.handoff ?? null, config.grant.handoff ?? null) || !same(plan.dossier.liveQualification ?? null, config.grant.liveQualification ?? null)) fail()
      if (!same(plan.candidate, released) || plan.dossier.catalogProvenance !== 'owner-provided-integrity-pinned') fail()
      const selected = config.grant.policies.map(policy).find(value => value.candidateId === released.id); if (!selected || !exactPolicy(released, selected)) fail()
      sourceAuthorityCanonicalSafePath(config.grant.catalogPath, 'file'); const catalog = await loadCatalogWithMetadata(config.grant.catalogPath)
      const current = catalog.catalog.entries.find(entry => entry.id === released.id)
      if (catalog.digest !== plan.dossier.catalogDigest || current === undefined || !same(current, released)) fail()
      const final = readOwnerSourceAdoptionPlan(control, requested.planId)
      if (!same(final.plan, plan) || !same(final.sourcePlan, sourcePlan) || !same(final.source, source) || !same(final.released, released)) fail()
    } finally { control.close() }
    const state = ledger(config.statePath)
    try {
      state.exec('BEGIN IMMEDIATE')
      try {
        const now = Date.now(); if (now >= config.grant.expiresAt || now > bound.plan.expiresAt) fail()
        const expiresAt = Math.min(now + config.grant.receiptTtlMs, config.grant.expiresAt, bound.plan.expiresAt); if (expiresAt <= now) fail()
        const frozen = state.prepare('SELECT config_digest, key_fingerprint FROM source_adoption_grants WHERE grant_id = ?').get(config.grant.id) as { config_digest: string; key_fingerprint: string } | undefined
        if (!frozen) state.prepare('INSERT INTO source_adoption_grants (grant_id, config_digest, key_fingerprint) VALUES (?, ?, ?)').run(config.grant.id, configDigest, keyFingerprint)
        else if (frozen.config_digest !== configDigest || frozen.key_fingerprint !== keyFingerprint) fail()
        const requestDigest = controlPlaneDigest(requested); const prior = state.prepare('SELECT * FROM source_adoption_receipts WHERE request_digest = ?').get(requestDigest) as StoredAdoption | undefined
        if (prior) {
          if (prior.grant_id !== config.grant.id || prior.config_digest !== configDigest || prior.plan_id !== requested.planId || prior.plan_digest !== requested.planDigest || prior.receipt_digest !== controlPlaneDigest(prior.receipt_json)) fail()
          const replay = parseApprovalReceipt(JSON.parse(prior.receipt_json) as unknown); if (replay.expiresAt <= now || replay.authority !== config.authority || replay.keyId !== config.keyId) fail()
          state.exec('COMMIT'); return replay
        }
        if (state.prepare('SELECT 1 FROM source_adoption_receipts WHERE plan_id = ?').get(requested.planId) || (state.prepare('SELECT COUNT(*) AS count FROM source_adoption_receipts WHERE grant_id = ?').get(config.grant.id) as { count: number }).count >= config.grant.maxAdoptions) fail()
        const receipt = receiptFor(config, requested, privateKey, now, expiresAt); const json = JSON.stringify(receipt)
        state.prepare('INSERT INTO source_adoption_receipts (request_digest, grant_id, config_digest, plan_id, plan_digest, receipt_json, receipt_digest) VALUES (?, ?, ?, ?, ?, ?, ?)').run(requestDigest, config.grant.id, configDigest, requested.planId, requested.planDigest, json, controlPlaneDigest(json))
        state.exec('COMMIT'); return receipt
      } catch (error) { try { state.exec('ROLLBACK') } catch {} throw error }
    } finally { state.close() }
  } catch (error) { if (error instanceof SourceAdoptionAuthorityError) throw error; throw new SourceAdoptionAuthorityError() }
}

/** CLI entrypoint: exactly --config <private absolute path>, one bounded JSON request, one JSON receipt. */
export async function runSourceAdoptionAuthority(argv = process.argv.slice(2)): Promise<void> {
  try {
    if (argv.length !== 2 || argv[0] !== '--config') fail()
    const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sourceAuthorityReadSafeFile(configuredPath(argv[1]), MAX_CONFIG_BYTES))) as unknown
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of process.stdin) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); if ((size += bytes.length) > MAX_REQUEST_BYTES) fail(); chunks.push(bytes) }
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown
    process.stdout.write(`${JSON.stringify(await authorizeSourceAdoption(config as SourceAdoptionAuthorityConfig, input as SourceAdoptionAuthorityRequest))}\n`)
  } catch { throw new SourceAdoptionAuthorityError() }
}
