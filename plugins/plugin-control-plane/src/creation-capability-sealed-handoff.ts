import { createPublicKey, randomBytes, verify } from 'node:crypto'
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync,
  unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { validatePluginCreationVerificationCertificate, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { SOURCE_ARCHIVE_DOMAIN, SOURCE_ARCHIVE_LIMIT, verifyCreationCapabilityReceipt } from './creation-capability-journal.js'
import { validateCreationCapabilitySource } from './creation-capability-source.js'
import { RESERVED_OUTPUTS, validateSourceCreationFiles } from './source-creation.js'
import { encode, freeze, handoffPrimitives, hash, sha, type AdoptionAuthorityIdentity, type FileIdentity,
  type FileSnapshot } from './creation-capability-handoff-common.js'
import { SEALED_ADOPTION_AUDIT, SEALED_ADOPTION_AUDIT_STATEMENTS, SEALED_ADOPTION_HANDOFF_PROTOCOL as PROTOCOL,
  SEALED_PROOF_KEYS, readSealedAdoptionAudit, sealedAdoptionInheritedUsage, sealedAdoptionPlanIds } from './creation-capability-sealed-audit.js'
import type { EmptyAdoptionScope } from './creation-capability-empty-handoff.js'
import type { CreationCapabilityReceipt } from './creation-capability-types.js'

function fail(message: string): never { throw new Error(`sealed adoption handoff: ${message}`) }
const common = handoffPrimitives(fail)
const { identity, directory, absolute, read, bytes, identities, text, authority, swapAuthority, businessCounts, openExisting, exact } = common
const AUDIT_SCHEMA = { table: SEALED_ADOPTION_AUDIT, statements: SEALED_ADOPTION_AUDIT_STATEMENTS }
const schema = (db: DatabaseSync, audited: boolean) => common.schema(db, AUDIT_SCHEMA, audited)
const MAX_FILE = 64 * 1024 * 1024
const SEALED_DIRECTORY = 'creation-adoptions.sealed'
const SHA = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
const ADOPTION_STATUSES = ['claimed', 'authorized', 'active', 'closed', 'unknown', 'rejected'] as const
const FILE_KEYS = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink']
const ZERO = { adoptions: 0 as const, calls: 0 as const, sourceArchives: 0 as const }

export type SealedAdoptionStatus = 'active' | 'closed' | 'rejected' | 'unknown'
/** Facts read from raw TEXT bytes. claimed/authorized/unknown adoptions and claimed/unknown calls
 * cannot be reconciled after the Docker runner retires, so they are sealed as `unknown`. */
export interface SealedAdoptionRow {
  planId: string
  status: SealedAdoptionStatus
  originalStatus: typeof ADOPTION_STATUSES[number]
  reason: string | null
  certificate: { protocol: string; digest: string }
  artifactSha256: string
  receiptDigest: string | null
  callCount: number
  completedCalls: number
  unknownCalls: number
  sourceArchiveDigest: string | null
}
export interface SealedAdoptionHistory {
  counts: { adoptions: number; calls: number; sourceArchives: number }
  byStatus: Record<SealedAdoptionStatus, number>
  rows: SealedAdoptionRow[]
  rowsDigest: string
}
/** Active Docker adoptions the next authority must independently re-verify before any reuse. */
export interface SealedPendingReverification {
  planId: string
  certificateDigest: string
  receiptDigest: string
  artifactSha256: string
  toolsDigest: string
}
export interface SealedAdoptionScope extends EmptyAdoptionScope {
  archiveLogicalPath: string
  archivePhysicalPath: string
}
export interface SealedAdoptionPlan {
  protocol: typeof PROTOCOL
  transactionId: string
  hostAnchor: string
  physicalPath: string
  oldIdentity: AdoptionAuthorityIdentity
  nextIdentity: AdoptionAuthorityIdentity
  snapshot: FileSnapshot
  archive: { logicalPath: string; physicalPath: string }
  history: SealedAdoptionHistory
  pendingReverification: SealedPendingReverification[]
  inheritedUsage: { adoptions: number; calls: number }
  createdAt: number
  expiresAt: number
  digest: string
}
export interface SealedAdoptionProof {
  protocol: typeof PROTOCOL
  plan: SealedAdoptionPlan
  fileIdentity: FileIdentity
  archive: { logicalPath: string; fileIdentity: FileIdentity; bytes: number; digest: string; mode: 0o400 }
  liveBusiness: { adoptions: 0; calls: 0; sourceArchives: 0 }
  inheritedUsage: { adoptions: number; calls: number }
  digest: string
}

function archivePlacement(journal: string, authorityDigest: string) {
  return join(dirname(journal), SEALED_DIRECTORY, `${authorityDigest}.sqlite`)
}
function nullable(raw: unknown): string | null { return raw === null ? null : text(raw) }
function canonical(raw: string, label: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(raw) } catch { fail(`invalid ${label} JSON`) }
  if (!value || typeof value !== 'object' || Array.isArray(value) || encode(value) !== raw) fail(`noncanonical ${label} JSON`)
  return value as Record<string, unknown>
}

function readHistory(db: DatabaseSync, old: AdoptionAuthorityIdentity) {
  const config = old.config
  const adoptions = db.prepare(`SELECT CAST(plan_id AS BLOB) AS plan_id, CAST(status AS BLOB) AS status, CAST(reason AS BLOB) AS reason,
    CAST(certificate_json AS BLOB) AS certificate_json, CAST(certificate_digest AS BLOB) AS certificate_digest, artifact,
    CAST(artifact_sha AS BLOB) AS artifact_sha, CAST(tools_digest AS BLOB) AS tools_digest, CAST(receipt_json AS BLOB) AS receipt_json
    FROM adoptions ORDER BY plan_id`).all()
  const calls = db.prepare('SELECT CAST(plan_id AS BLOB) AS plan_id, CAST(status AS BLOB) AS status FROM calls').all()
  const archives = db.prepare('SELECT CAST(plan_id AS BLOB) AS plan_id, CAST(archive_json AS BLOB) AS archive_json FROM source_archives').all()
  const counts = { adoptions: adoptions.length, calls: calls.length, sourceArchives: archives.length }
  if (!counts.adoptions && !counts.calls && !counts.sourceArchives) fail('empty history requires the empty adoption handoff')
  if (counts.adoptions > config.maxAdoptions || counts.calls > config.maxCallRecords) fail('history exceeds the grant limits')
  const tally = new Map<string, { callCount: number; completedCalls: number; unknownCalls: number }>()
  for (const call of calls) {
    const planId = text(call.plan_id), status = text(call.status)
    const entry = tally.get(planId) ?? { callCount: 0, completedCalls: 0, unknownCalls: 0 }
    entry.callCount++
    if (status === 'completed') entry.completedCalls++
    else if (status === 'claimed' || status === 'unknown') entry.unknownCalls++ // never replayed, never refunded
    else fail('invalid call status')
    tally.set(planId, entry)
  }
  const sources = new Map<string, string>()
  for (const archive of archives) sources.set(text(archive.plan_id), sha(text(archive.archive_json)))
  const byStatus: Record<SealedAdoptionStatus, number> = { active: 0, closed: 0, rejected: 0, unknown: 0 }
  const rows: SealedAdoptionRow[] = [], pendingReverification: SealedPendingReverification[] = []
  for (const row of adoptions) {
    const planId = text(row.plan_id), originalStatus = text(row.status) as SealedAdoptionRow['originalStatus']
    const reason = nullable(row.reason), certificateJson = text(row.certificate_json), certificateDigest = text(row.certificate_digest)
    const artifactSha256 = text(row.artifact_sha), toolsDigest = nullable(row.tools_digest), receiptJson = nullable(row.receipt_json)
    const unsettled = ['claimed', 'authorized', 'active'].includes(originalStatus)
    if (!ID.test(planId) || !ADOPTION_STATUSES.includes(originalStatus) || !SHA.test(certificateDigest)
      || certificateDigest !== sha(certificateJson) || !SHA.test(artifactSha256) || !(row.artifact instanceof Uint8Array)
      || sha(Buffer.from(row.artifact)) !== artifactSha256 || (reason === null) !== unsettled
      || (['authorized', 'active'].includes(originalStatus) && (receiptJson === null || toolsDigest === null))) fail('invalid adoption row')
    const certificate = canonical(certificateJson, 'certificate')
    const receipt = receiptJson === null ? undefined : canonical(receiptJson, 'receipt')
    if (typeof certificate.protocol !== 'string') fail('invalid certificate protocol')
    const status: SealedAdoptionStatus = originalStatus === 'active' || originalStatus === 'closed' || originalStatus === 'rejected'
      ? originalStatus : 'unknown'
    const usage = tally.get(planId) ?? { callCount: 0, completedCalls: 0, unknownCalls: 0 }
    tally.delete(planId)
    if (usage.callCount > config.maxCallsPerAdoption) fail('history exceeds the grant limits')
    const sourceArchiveDigest = sources.get(planId) ?? null
    sources.delete(planId)
    if (status === 'active') {
      try { validatePluginCreationVerificationCertificate(certificate) } catch { fail('active adoption certificate is invalid') }
      if (certificate.protocol !== 'assistant-growth/creation-verification/v1') fail('active adoption requires the Docker v1 certificate protocol')
      const signed = receipt as unknown as CreationCapabilityReceipt
      const plan = certificate.plan as { id: string; digest: string }
      if (!verifyCreationCapabilityReceipt(signed, old.authorityDigest, old.publicKey, signed.adoptedAt)
        || signed.authorityId !== config.authorityId || signed.keyId !== config.keyId || signed.planId !== planId
        || plan.id !== planId || signed.planDigest !== plan.digest || signed.verificationDigest !== certificateDigest
        || signed.artifactSha256 !== artifactSha256 || signed.toolsDigest !== toolsDigest) fail('active adoption receipt does not verify under the old authority')
      pendingReverification.push({ planId, certificateDigest, receiptDigest: sha(receiptJson!), artifactSha256, toolsDigest: toolsDigest! })
    }
    byStatus[status]++
    rows.push({ planId, status, originalStatus, reason, certificate: { protocol: certificate.protocol, digest: certificateDigest },
      artifactSha256, receiptDigest: receiptJson === null ? null : sha(receiptJson), ...usage, sourceArchiveDigest })
  }
  if (tally.size || sources.size) fail('orphan business rows')
  return { history: { counts, byStatus, rows, rowsDigest: hash(rows) }, pendingReverification,
    inheritedUsage: { adoptions: counts.adoptions, calls: counts.calls } }
}

function planBody(plan: SealedAdoptionPlan) { const { digest: _digest, ...body } = plan; return body }
function validatePlan(plan: SealedAdoptionPlan) {
  exact(plan, ['protocol','transactionId','hostAnchor','physicalPath','oldIdentity','nextIdentity','snapshot','archive',
    'history','pendingReverification','inheritedUsage','createdAt','expiresAt','digest'])
  for (const identity of [plan.oldIdentity, plan.nextIdentity]) exact(identity, ['logicalPath','config','authorityDigest','publicKey','keyFingerprint'])
  absolute(plan.physicalPath)
  if (plan.physicalPath === plan.oldIdentity.logicalPath) fail('staged copy must be separate from logical source')
  exact(plan.snapshot, ['identity','bytes','digest'])
  exact(plan.snapshot.identity, FILE_KEYS)
  exact(plan.archive, ['logicalPath','physicalPath'])
  exact(plan.history, ['counts','byStatus','rows','rowsDigest'])
  exact(plan.history.counts, ['adoptions','calls','sourceArchives'])
  exact(plan.history.byStatus, ['active','closed','rejected','unknown'])
  exact(plan.inheritedUsage, ['adoptions','calls'])
  if (!Array.isArray(plan.history.rows) || !Array.isArray(plan.pendingReverification)) fail('invalid plan')
  if (plan.protocol !== PROTOCOL || plan.digest !== hash(planBody(plan))
    || !SHA.test(plan.hostAnchor) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(plan.transactionId)
    || !Number.isSafeInteger(plan.createdAt) || !Number.isSafeInteger(plan.expiresAt)
    || plan.createdAt < 1 || plan.expiresAt <= plan.createdAt || plan.expiresAt - plan.createdAt > 300_000
    || plan.expiresAt > Math.min(plan.oldIdentity.config.expiresAt, plan.nextIdentity.config.expiresAt,
      plan.oldIdentity.config.runner.expiresAt, plan.nextIdentity.config.runner.expiresAt)
    || plan.history.rowsDigest !== hash(plan.history.rows)
    || plan.inheritedUsage.adoptions !== plan.history.counts.adoptions || plan.inheritedUsage.calls !== plan.history.counts.calls) fail('invalid plan')
  const actual = identities(plan.oldIdentity.logicalPath, plan.oldIdentity.config, plan.nextIdentity.config)
  if (encode(actual) !== encode({ oldIdentity: plan.oldIdentity, nextIdentity: plan.nextIdentity })) fail('public identity changed')
  if (plan.archive.logicalPath !== archivePlacement(plan.oldIdentity.logicalPath, plan.oldIdentity.authorityDigest)
    || plan.archive.physicalPath !== archivePlacement(plan.physicalPath, plan.oldIdentity.authorityDigest)) fail('archive path is not the sealed placement')
}

function archiveDirectory(dir: string) {
  // directory() rejects links, aliases, foreign owners and group/other bits; also require exact 0700.
  directory(dir)
  if ((lstatSync(dir).mode & 0o777) !== 0o700) fail('unsafe archive directory')
}
function syncDirectory(dir: string) {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
/** Exact 0400 private copy of the planned snapshot bytes. */
function checkArchive(file: string, snapshot: FileSnapshot): FileSnapshot {
  archiveDirectory(dirname(file))
  const archived = bytes(file, MAX_FILE)
  if (archived.bytes !== snapshot.bytes || archived.digest !== snapshot.digest || (archived.identity.mode & 0o777) !== 0o400) fail('archive mismatch')
  return archived
}
function writeArchive(plan: SealedAdoptionPlan, value: Buffer): FileSnapshot {
  const file = plan.archive.physicalPath, dir = dirname(file)
  directory(dirname(dir))
  let created = false
  try { mkdirSync(dir, { mode: 0o700 }); created = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  if (created) { chmodSync(dir, 0o700); syncDirectory(dirname(dir)) }
  archiveDirectory(dir)
  // A crash may leave a private temp (possibly still hard-linked to the final name); drop it first.
  removeArchiveTemps(dir, file)
  if (present(file)) {
    // Retry after a failure between archive link and commit: only the identical 0400 bytes are accepted.
    const existing = read(file, MAX_FILE).snapshot
    if (existing.bytes !== plan.snapshot.bytes || existing.digest !== plan.snapshot.digest
      || (existing.identity.mode & 0o777) !== 0o400) fail('pre-existing archive differs')
  } else {
    // The final name only ever appears complete: write+fsync+0400 under a private temp, then link().
    const temp = join(dir, `${archiveTempPrefix(file)}${randomBytes(16).toString('hex')}`)
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      try {
        for (let offset = 0; offset < value.length;) offset += writeSync(fd, value, offset, value.length - offset)
        fsyncSync(fd); fchmodSync(fd, 0o400); fsyncSync(fd)
      } finally { closeSync(fd) }
      linkSync(temp, file) // EEXIST when the final name appeared meanwhile
    } finally { unlinkSync(temp) }
  }
  syncDirectory(dir)
  return checkArchive(file, plan.snapshot)
}
function present(file: string): boolean {
  try { lstatSync(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
const archiveTempPrefix = (file: string) => `.${basename(file)}.tmp-`
/** Remove crash leftovers named `.<archive>.tmp-<32 hex>`; anything else under that name fails closed. */
function removeArchiveTemps(dir: string, file: string) {
  const prefix = archiveTempPrefix(file)
  let removed = false
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue
    const temp = join(dir, name), stat = lstatSync(temp)
    if (!/^[a-f0-9]{32}$/u.test(name.slice(prefix.length)) || !stat.isFile() || stat.uid !== process.getuid?.()) fail('unsafe archive temp')
    unlinkSync(temp); removed = true
  }
  if (removed) syncDirectory(dir)
}
/** Stopped apply only: recover what a crash inside or right after BEGIN IMMEDIATE leaves behind, either a
 * lone hot rollback `-journal` or a WAL pair (`-wal` + `-shm`; staged journals are WAL mode). One read-write
 * open lets SQLite roll back the journal or discard uncommitted WAL frames; closing it checkpoints a committed
 * WAL. Afterwards no sidecar may remain. Without the audit the file must equal the plan snapshot exactly; with
 * it (the crash came after COMMIT) the normal retry branch validates the stored proof. Any other sidecar set
 * fails closed. */
function recoverCrashedApply(plan: SealedAdoptionPlan) {
  const file = plan.physicalPath
  const journal = present(`${file}-journal`), wal = present(`${file}-wal`), shm = present(`${file}-shm`)
  if (!journal && !wal && !shm) return
  if (journal ? wal || shm : !(wal && shm)) fail('sidecar requires stopped checkpointed database')
  if (basename(file) !== 'creation-adoptions.sqlite') fail('invalid physical journal')
  directory(dirname(file))
  for (const suffix of journal ? ['-journal'] : ['-wal', '-shm']) identity(file + suffix)
  const expected = identity(file), locator = pathToFileURL(file)
  locator.searchParams.set('mode', 'rw')
  const db = new DatabaseSync(locator)
  let audited = false
  try {
    if (encode(identity(file)) !== encode(expected)) fail('named identity changed')
    // The first read under a shared lock rolls a hot journal back or recovers the WAL index.
    db.exec('PRAGMA busy_timeout=0')
    audited = db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get(SEALED_ADOPTION_AUDIT) !== undefined
    if (wal) db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally { db.close() }
  for (const suffix of ['-wal', '-shm', '-journal']) if (present(file + suffix)) fail('sidecar requires stopped checkpointed database')
  if (encode(identity(file)) !== encode(expected)) fail('named identity changed')
  if (!audited && encode(bytes(file, MAX_FILE)) !== encode(plan.snapshot)) fail('recovered journal differs from the plan snapshot')
}

function storedProof(db: DatabaseSync, plan: SealedAdoptionPlan): SealedAdoptionProof {
  schema(db, true)
  const audit = readSealedAdoptionAudit(db)
  if (!audit) fail('missing immutable proof')
  const proof = audit.proof as unknown as SealedAdoptionProof
  exact(proof, SEALED_PROOF_KEYS)
  exact(proof.fileIdentity, FILE_KEYS)
  exact(proof.archive, ['logicalPath','fileIdentity','bytes','digest','mode'])
  exact(proof.archive.fileIdentity, FILE_KEYS)
  exact(proof.liveBusiness, ['adoptions','calls','sourceArchives'])
  exact(proof.inheritedUsage, ['adoptions','calls'])
  if (encode(proof.plan) !== encode(plan) || encode(proof.fileIdentity) !== encode(plan.snapshot.identity)
    || proof.archive.logicalPath !== plan.archive.logicalPath || proof.archive.bytes !== plan.snapshot.bytes
    || proof.archive.digest !== plan.snapshot.digest || proof.archive.mode !== 0o400
    || encode(proof.liveBusiness) !== encode(ZERO) || encode(proof.inheritedUsage) !== encode(plan.inheritedUsage)) fail('proof mismatch')
  authority(db, plan.nextIdentity)
  if (encode(sealedAdoptionInheritedUsage(db, plan.nextIdentity.authorityDigest)) !== encode(plan.inheritedUsage)) fail('proof mismatch')
  if (encode(businessCounts(db)) !== encode(ZERO)) fail('nonempty business journal after sealed handoff')
  return proof
}
function sameArchive(file: string, proof: SealedAdoptionProof) {
  const archived = checkArchive(file, proof.plan.snapshot)
  if (encode(archived.identity) !== encode(proof.archive.fileIdentity)) fail('archive identity mismatch')
}

/** Plan sealing a stopped staged Docker journal whose history is non-empty. Same caller duties as the
 * empty handoff: independently verify the source copy and both configurations, bind them in hostAnchor
 * and freeze the plan digest outside this file. */
export function planSealedAdoptionHandoff(scope: SealedAdoptionScope): Readonly<SealedAdoptionPlan> {
  const pair = identities(scope.logicalPath, scope.oldConfig, scope.nextConfig)
  absolute(scope.physicalPath); absolute(scope.archiveLogicalPath); absolute(scope.archivePhysicalPath)
  if (scope.archiveLogicalPath !== archivePlacement(scope.logicalPath, pair.oldIdentity.authorityDigest)
    || scope.archivePhysicalPath !== archivePlacement(scope.physicalPath, pair.oldIdentity.authorityDigest)) fail('archive path is not the sealed placement')
  const deadline = Math.min(scope.oldConfig.expiresAt, scope.nextConfig.expiresAt, scope.oldConfig.runner.expiresAt, scope.nextConfig.runner.expiresAt)
  if (scope.now >= deadline || scope.expiresAt > deadline) fail('expired grant or plan')
  const snapshot = bytes(scope.physicalPath, MAX_FILE)
  const facts = openExisting(scope.physicalPath, db => {
    db.exec('BEGIN')
    try {
      schema(db, false); authority(db, pair.oldIdentity)
      const result = readHistory(db, pair.oldIdentity)
      if (encode(bytes(scope.physicalPath, MAX_FILE)) !== encode(snapshot)) fail('plan snapshot drift')
      return result
    } finally { db.exec('ROLLBACK') }
  })
  const body = { protocol: PROTOCOL, transactionId: scope.transactionId, hostAnchor: scope.hostAnchor,
    physicalPath: scope.physicalPath, ...pair, snapshot,
    archive: { logicalPath: scope.archiveLogicalPath, physicalPath: scope.archivePhysicalPath }, ...facts,
    createdAt: scope.now, expiresAt: scope.expiresAt }
  const plan: SealedAdoptionPlan = { ...body, digest: hash(body) }
  validatePlan(plan)
  return freeze(plan)
}

export function applySealedAdoptionHandoff(plan: SealedAdoptionPlan,
  input: { now: number; expectedPlanDigest: string; expectedHostAnchor: string }): Readonly<SealedAdoptionProof> {
  validatePlan(plan)
  if (plan.digest !== input.expectedPlanDigest || plan.hostAnchor !== input.expectedHostAnchor) fail('external plan anchor mismatch')
  const now = input.now
  if (!Number.isSafeInteger(now) || now < plan.createdAt) fail('invalid apply time')
  absolute(plan.physicalPath); recoverCrashedApply(plan)
  return openExisting(plan.physicalPath, db => {
    db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
    try {
      if (db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(SEALED_ADOPTION_AUDIT)) {
        const proof = storedProof(db, plan) // acknowledgement only, never a new handoff
        if (encode(identity(plan.physicalPath)) !== encode(proof.fileIdentity)) fail('retry file identity mismatch')
        sameArchive(plan.archive.physicalPath, proof)
        db.exec('ROLLBACK'); return freeze(proof)
      }
      if (now > plan.expiresAt) fail('stale plan')
      schema(db, false); authority(db, plan.oldIdentity)
      if (encode(readHistory(db, plan.oldIdentity)) !== encode({ history: plan.history,
        pendingReverification: plan.pendingReverification, inheritedUsage: plan.inheritedUsage })) fail('history drift')
      const { value, snapshot } = read(plan.physicalPath, MAX_FILE)
      if (encode(snapshot) !== encode(plan.snapshot)) fail('apply snapshot drift')
      const archived = writeArchive(plan, value)
      if (encode(bytes(plan.physicalPath, MAX_FILE)) !== encode(plan.snapshot)) fail('apply snapshot drift')
      // Rows leave the live business tables only; their bytes stay in SQLite free pages until a
      // later VACUUM. The 0400 archive, not this file, is the retained historical record.
      db.exec('DELETE FROM calls; DELETE FROM source_archives; DELETE FROM adoptions')
      swapAuthority(db, plan.oldIdentity, plan.nextIdentity)
      if (encode(identity(plan.physicalPath)) !== encode(plan.snapshot.identity)) fail('apply file identity drift')
      const body = { protocol: PROTOCOL, plan: structuredClone(plan), fileIdentity: identity(plan.physicalPath),
        archive: { logicalPath: plan.archive.logicalPath, fileIdentity: archived.identity, bytes: archived.bytes,
          digest: archived.digest, mode: 0o400 as const },
        liveBusiness: { ...ZERO }, inheritedUsage: { ...plan.inheritedUsage } }
      const proof: SealedAdoptionProof = { ...body, digest: hash(body) }
      db.exec(`${SEALED_ADOPTION_AUDIT_STATEMENTS.join(';')};`)
      db.prepare(`INSERT INTO ${SEALED_ADOPTION_AUDIT} VALUES (1,?,?)`).run(encode(proof), proof.digest)
      if (encode(storedProof(db, plan)) !== encode(proof)) fail('proof readback mismatch')
      if (encode(identity(plan.physicalPath)) !== encode(plan.snapshot.identity)) fail('commit file identity drift')
      db.exec('COMMIT')
      return freeze(proof)
    } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
  }, true)
}

/** Read-only Host cross-check of a possibly live journal (WAL sidecars allowed). Returns the stored
 * sealed proof digest after the same audit validation the journal performs, or null when no audit
 * object exists. The journal alone cannot detect a wholly dropped audit; the caller compares this
 * result with its signed proof digest and refuses on any difference. */
export function readSealedAdoptionHandoffDigest(input: { physicalPath: string }): string | null {
  const file = input?.physicalPath
  return readJournal(file, db => {
    const audit = readSealedAdoptionAudit(db)
    if (!audit) return null
    const rows = db.prepare('SELECT CAST(authority_digest AS BLOB) AS authority_digest FROM authority').all()
    if (rows.length !== 1) fail('authority singleton mismatch')
    const authorityDigest = text(rows[0]!.authority_digest)
    // Same checks as the journal constructor: authority binding, inherited usage and sealed plan ids.
    sealedAdoptionInheritedUsage(db, authorityDigest); sealedAdoptionPlanIds(db, authorityDigest)
    return audit.proof.digest as string
  })
}
/** Read-only snapshot of a stopped or live journal. A stopped journal (no sidecars) is opened immutable so
 * the read never creates -wal/-shm in a stage; a live Host's existing WAL sidecars need the ordinary
 * read-only open to see committed frames. */
function readJournal<T>(file: string, action: (db: DatabaseSync) => T): T {
  absolute(file)
  if (basename(file) !== 'creation-adoptions.sqlite') fail('invalid physical journal')
  directory(dirname(file)); identity(file)
  const wal = present(file + '-wal'), shm = present(file + '-shm'), hot = present(file + '-journal')
  // A live WAL journal always has both sidecars. A lone -wal would make the read-only open create -shm in
  // a stopped stage, a lone -shm is stale, and a hot rollback journal cannot be recovered read-only.
  if (hot || wal !== shm) fail('journal sidecars are incomplete; stop the Host cleanly or checkpoint the stopped database, then retry')
  const live = wal
  const locator = pathToFileURL(file)
  locator.searchParams.set('mode', 'ro')
  if (!live) locator.searchParams.set('immutable', '1')
  const db = new DatabaseSync(locator, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN')
    try { return action(db) } finally { db.exec('ROLLBACK') }
  } finally { db.close() }
}

/** Stopped-stage / post-cutover BEFORE START acceptance only. The live file may have been renamed on
 * the same inode; the archive must sit in the same relative placement and keep its exact identity. */
export function verifySealedAdoptionHandoff(input: { physicalPath: string; archivePhysicalPath: string;
  plan: SealedAdoptionPlan; expectedProofDigest: string }): Readonly<SealedAdoptionProof> {
  validatePlan(input.plan)
  absolute(input.physicalPath); absolute(input.archivePhysicalPath)
  if (input.archivePhysicalPath !== join(dirname(input.physicalPath), SEALED_DIRECTORY, basename(input.plan.archive.physicalPath))) fail('archive path is not the sealed placement')
  return openExisting(input.physicalPath, db => {
    db.exec('BEGIN')
    try {
      const proof = storedProof(db, input.plan)
      if (!SHA.test(input.expectedProofDigest) || proof.digest !== input.expectedProofDigest
        || encode(identity(input.physicalPath)) !== encode(proof.fileIdentity)) fail('external anchor or file identity mismatch')
      sameArchive(input.archivePhysicalPath, proof)
      return freeze(proof)
    } finally { db.exec('ROLLBACK') }
  })
}

/** Provenance of one sealed Docker-era tool's archived source, re-rooted relative to `plugins/<name>/`. */
export interface SealedReverificationSource {
  planId: string
  name: string
  /** Candidate-authority files only (README.md, src/**, tests/**); Host-generated metadata is omitted. */
  files: { path: string; content: string }[]
  /** sha256 of the stored source-archive JSON, equal to the sealed history row's sourceArchiveDigest. */
  archiveRowDigest: string
  filesDigest: string
  oldAuthorityDigest: string
}
const SOURCE_ARCHIVE_KEYS = ['protocol','authorityId','authorityDigest','keyId','planId','certificateDigest','artifactSha256','source','signature']

/** Immutable read of the exact 0400 archive the proof names. The binding is sameArchive() (dev/ino, mode,
 * bytes and digest) before and after the read; SQLite reopens by path, so the held O_NOFOLLOW fd only refuses
 * a symlink at open time and is not itself the binding. */
function readArchive<T>(file: string, proof: SealedAdoptionProof, action: (db: DatabaseSync) => T): T {
  sameArchive(file, proof)
  for (const suffix of ['-wal', '-shm', '-journal']) if (present(file + suffix)) fail('archive sidecar')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let db: DatabaseSync | undefined
  try {
    const held = fstatSync(fd)
    if (String(held.dev) !== proof.archive.fileIdentity.dev || String(held.ino) !== proof.archive.fileIdentity.ino) fail('archive identity mismatch')
    const locator = pathToFileURL(file)
    locator.searchParams.set('mode', 'ro'); locator.searchParams.set('immutable', '1')
    db = new DatabaseSync(locator, { readOnly: true })
    db.exec('PRAGMA query_only=ON')
    const result = action(db)
    sameArchive(file, proof)
    return result
  } finally { db?.close(); closeSync(fd) }
}

/** The journal's immutable sealed proof, bound to the caller's signed proof digest and re-validated against
 * its plan, archive, next authority, inherited usage and the journal's own file identity. */
function anchoredProof(db: DatabaseSync, file: string, expectedProofDigest: string): SealedAdoptionProof {
  schema(db, true)
  const audit = readSealedAdoptionAudit(db)
  if (!audit) fail('missing immutable proof')
  const stored = audit.proof as unknown as SealedAdoptionProof
  if (stored.digest !== expectedProofDigest) fail('external proof anchor mismatch')
  exact(stored, SEALED_PROOF_KEYS)
  exact(stored.fileIdentity, FILE_KEYS)
  exact(stored.archive, ['logicalPath','fileIdentity','bytes','digest','mode'])
  exact(stored.archive.fileIdentity, FILE_KEYS)
  validatePlan(stored.plan)
  if (stored.archive.logicalPath !== stored.plan.archive.logicalPath || stored.archive.bytes !== stored.plan.snapshot.bytes
    || stored.archive.digest !== stored.plan.snapshot.digest || stored.archive.mode !== 0o400) fail('proof mismatch')
  authority(db, stored.plan.nextIdentity)
  if (encode(sealedAdoptionInheritedUsage(db, stored.plan.nextIdentity.authorityDigest)) !== encode(stored.plan.inheritedUsage)) fail('proof mismatch')
  if (encode(identity(file)) !== encode(stored.fileIdentity)) fail('journal file identity mismatch')
  return structuredClone(stored)
}

/** Comparison form of a plan id. Plan ids are ASCII (`ID`), so case folding is the only aliasing: SQLite
 * compares them exactly, but two ids differing only in case would still read as the same tool name. */
function planIdNameForm(planId: string): string {
  return planId.toLowerCase()
}

/** Proof that a new replay plan id is isolated from the sealed handoff's history. */
export interface SealedReplayPlanIdIsolation {
  protocol: 'dsh-sealed-replay-plan-id-isolation/v1'
  planId: string
  proofDigest: string
  sealedRows: number
}

/** S2 naming isolation for sealed tool replay (check and refuse only; nothing adopts with it yet).
 *
 * A replayed sealed tool must return under a NEW plan id. Bound to the caller's signed proof digest, this
 * refuses `planId` when it names any sealed history row (every status, not only pending reverification),
 * equals one ignoring case, or already names a row of the live journal under the next authority.
 * It reads the journal only and grants nothing: passing it is necessary for a replay plan, never sufficient. */
export function assertSealedReplayPlanIdIsolated(input: { physicalPath: string; expectedProofDigest: string;
  planId: string }): Readonly<SealedReplayPlanIdIsolation> {
  const file = input?.physicalPath, planId = input?.planId
  if (typeof input?.expectedProofDigest !== 'string' || !SHA.test(input.expectedProofDigest)) fail('invalid expected proof digest')
  if (typeof planId !== 'string' || !ID.test(planId)) fail('invalid plan id')
  return readJournal(file, db => {
    const proof = anchoredProof(db, file, input.expectedProofDigest)
    const form = planIdNameForm(planId)
    for (const row of proof.plan.history.rows) {
      if (typeof row?.planId !== 'string') fail('invalid sealed row')
      if (row.planId === planId) fail('plan id names a sealed row')
      if (planIdNameForm(row.planId) === form) fail('plan id collides with a sealed row')
    }
    for (const row of proof.plan.pendingReverification) {
      if (typeof row?.planId !== 'string' || planIdNameForm(row.planId) === form) fail('plan id collides with a sealed row')
    }
    const live = db.prepare('SELECT CAST(plan_id AS BLOB) AS plan_id FROM adoptions').all()
    if (live.some(row => planIdNameForm(text(row.plan_id)) === form)) fail('plan id already names a live adoption')
    return freeze({ protocol: 'dsh-sealed-replay-plan-id-isolation/v1' as const, planId, proofDigest: proof.digest,
      sealedRows: proof.plan.history.rows.length })
  })
}

/** Read-only provenance reader for re-verifying one sealed `pendingReverification` tool. It binds the live
 * or stopped journal's immutable proof to the caller's signed proof digest, reads the exact sealed 0400
 * archive under the OLD authority and returns only candidate source files. It grants nothing: no
 * certificate, artifact, receipt or tools leave this function, and re-verification itself is the caller's. */
export function readSealedReverificationSource(input: { physicalPath: string; expectedProofDigest: string;
  planId: string }): Readonly<SealedReverificationSource> {
  const file = input?.physicalPath, planId = input?.planId
  if (typeof input?.expectedProofDigest !== 'string' || !SHA.test(input.expectedProofDigest)) fail('invalid expected proof digest')
  if (typeof planId !== 'string' || !ID.test(planId)) fail('invalid plan id')
  const proof = readJournal(file, db => anchoredProof(db, file, input.expectedProofDigest))
  const pending = proof.plan.pendingReverification.find(row => row?.planId === planId)
  if (!pending) fail('plan is not pending reverification')
  const row = proof.plan.history.rows.find(row => row?.planId === planId)
  if (!row || row.status !== 'active' || row.originalStatus !== 'active') fail('sealed row is not active')
  if (row.sourceArchiveDigest === null) fail('no archived source')
  if (typeof row.sourceArchiveDigest !== 'string' || !SHA.test(row.sourceArchiveDigest)) fail('invalid sealed row')
  const old = proof.plan.oldIdentity
  return readArchive(join(dirname(file), SEALED_DIRECTORY, `${old.authorityDigest}.sqlite`), proof, db => {
    schema(db, false); authority(db, old)
    const adoptions = db.prepare(`SELECT CAST(status AS BLOB) AS status, CAST(certificate_json AS BLOB) AS certificate_json,
      CAST(certificate_digest AS BLOB) AS certificate_digest, CAST(artifact_sha AS BLOB) AS artifact_sha FROM adoptions WHERE plan_id=?`).all(planId)
    if (adoptions.length !== 1) fail('archived adoption mismatch')
    const adoption = adoptions[0]!, certificateJson = text(adoption.certificate_json)
    if (text(adoption.status) !== 'active' || sha(certificateJson) !== pending.certificateDigest
      || text(adoption.certificate_digest) !== pending.certificateDigest || text(adoption.artifact_sha) !== pending.artifactSha256) fail('archived adoption mismatch')
    const certificate = canonical(certificateJson, 'certificate') as unknown as PluginCreationVerificationCertificate
    try { validatePluginCreationVerificationCertificate(certificate) } catch { fail('archived certificate is invalid') }
    const sources = db.prepare('SELECT CAST(archive_json AS BLOB) AS archive_json FROM source_archives WHERE plan_id=?').all(planId)
    if (sources.length !== 1) fail('no archived source')
    const raw = text(sources[0]!.archive_json)
    if (Buffer.byteLength(raw) > SOURCE_ARCHIVE_LIMIT) fail('archived source too large')
    const archiveRowDigest = sha(raw)
    if (archiveRowDigest !== row.sourceArchiveDigest) fail('archived source digest mismatch')
    const item = canonical(raw, 'source archive')
    exact(item, SOURCE_ARCHIVE_KEYS)
    if (item.protocol !== 'dsh-created-capability-source-archive/v1' || item.authorityId !== old.config.authorityId
      || item.authorityDigest !== old.authorityDigest || item.keyId !== old.config.keyId || item.planId !== planId
      || item.certificateDigest !== pending.certificateDigest || item.artifactSha256 !== pending.artifactSha256
      || certificate.plan.id !== planId || certificate.plan.artifactSha256 !== pending.artifactSha256) fail('archived source authority mismatch')
    const signature = item.signature
    const { signature: _signature, ...body } = item
    if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(signature)
      || Buffer.from(signature, 'base64url').toString('base64url') !== signature
      || !verify(null, Buffer.from(SOURCE_ARCHIVE_DOMAIN + encode(body)), createPublicKey(old.publicKey),
        Buffer.from(signature, 'base64url'))) fail('archived source signature mismatch')
    try { validateCreationCapabilitySource(item.source, certificate) } catch { fail('archived source is invalid') }
    const name = certificate.plan.name, root = `plugins/${name}/`, files: { path: string; content: string }[] = []
    for (const entry of item.source.files) {
      if (typeof entry?.path !== 'string' || typeof entry.content !== 'string' || !entry.path.startsWith(root)) fail('archived source file outside the plugin')
      // Same order as source-revision parentFiles: a replayed file carries no mode, so only 100644 is admissible.
      if (entry.mode !== '100644') fail('archived source file mode')
      const path = entry.path.slice(root.length)
      // Host-generated metadata is regenerated by the source job, never taken from the archive.
      if ((RESERVED_OUTPUTS as readonly string[]).includes(path)) continue
      try { validateSourceCreationFiles([{ path, content: entry.content }]) } catch { fail(`archived source file outside candidate authority: ${JSON.stringify(path)}`) }
      files.push({ path, content: entry.content })
    }
    if (!files.length) fail('archived source has no candidate files')
    try { validateSourceCreationFiles(files) } catch { fail('archived source exceeds candidate bounds') }
    return freeze({ planId, name, files, archiveRowDigest, filesDigest: hash(files), oldAuthorityDigest: old.authorityDigest })
  })
}
