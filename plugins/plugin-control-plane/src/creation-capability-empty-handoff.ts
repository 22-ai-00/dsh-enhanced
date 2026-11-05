import type { DatabaseSync } from 'node:sqlite'
import { encode, freeze, handoffPrimitives, hash, type AdoptionAuthorityIdentity, type FileIdentity,
  type FileSnapshot } from './creation-capability-handoff-common.js'
import type { CreationCapabilityConfig } from './creation-capability-types.js'

const PROTOCOL = 'dsh-empty-creation-adoption-handoff/v1' as const
const AUDIT = 'creation_empty_authority_handoff'
const AUDIT_SQL = `CREATE TABLE ${AUDIT} (singleton INTEGER PRIMARY KEY CHECK(singleton=1), proof_json TEXT NOT NULL, proof_digest TEXT NOT NULL CHECK(length(proof_digest)=64)) STRICT`
const NO_UPDATE = `CREATE TRIGGER creation_empty_handoff_no_update BEFORE UPDATE ON ${AUDIT} BEGIN SELECT RAISE(ABORT,'immutable empty authority handoff'); END`
const NO_DELETE = `CREATE TRIGGER creation_empty_handoff_no_delete BEFORE DELETE ON ${AUDIT} BEGIN SELECT RAISE(ABORT,'immutable empty authority handoff'); END`
function fail(message: string): never { throw new Error(`empty adoption authority handoff: ${message}`) }
const common = handoffPrimitives(fail)
const { identity, bytes, identities, textRows, authority, empty, openExisting, exact } = common
const AUDIT_SCHEMA = { table: AUDIT, statements: [AUDIT_SQL, NO_UPDATE, NO_DELETE] }
const schema = (db: DatabaseSync, audited: boolean) => common.schema(db, AUDIT_SCHEMA, audited)
export type EmptyAdoptionIdentity = AdoptionAuthorityIdentity
/** Trusted stopped-Host caller must independently verify the source copy and old/next configuration,
 * and bind that provenance in hostAnchor. Freeze the generated plan digest separately. This API does not
 * attest that an arbitrary empty clone originated from a particular live Home. */
export interface EmptyAdoptionScope {
  physicalPath: string
  logicalPath: string
  transactionId: string
  hostAnchor: string
  oldConfig: CreationCapabilityConfig
  nextConfig: CreationCapabilityConfig
  now: number
  expiresAt: number
}
export interface EmptyAdoptionPlan {
  protocol: typeof PROTOCOL
  transactionId: string
  hostAnchor: string
  physicalPath: string
  oldIdentity: EmptyAdoptionIdentity
  nextIdentity: EmptyAdoptionIdentity
  snapshot: FileSnapshot
  createdAt: number
  expiresAt: number
  digest: string
}
export interface EmptyAdoptionProof {
  protocol: typeof PROTOCOL
  plan: EmptyAdoptionPlan
  fileIdentity: FileIdentity
  emptyBusiness: { adoptions: 0; calls: 0; sourceArchives: 0 }
  digest: string
}
function planBody(plan: EmptyAdoptionPlan) { const { digest: _digest, ...body } = plan; return body }
function validatePlan(plan: EmptyAdoptionPlan) {
  exact(plan, ['protocol','transactionId','hostAnchor','physicalPath','oldIdentity','nextIdentity','snapshot','createdAt','expiresAt','digest'])
  for (const identity of [plan.oldIdentity, plan.nextIdentity]) exact(identity, ['logicalPath','config','authorityDigest','publicKey','keyFingerprint'])
  if (plan.physicalPath === plan.oldIdentity.logicalPath) fail('staged copy must be separate from logical source')
  exact(plan.snapshot, ['identity','bytes','digest'])
  exact(plan.snapshot.identity, ['dev','ino','uid','gid','mode','nlink'])
  if (!plan || plan.protocol !== PROTOCOL || plan.digest !== hash(planBody(plan))
    || !/^[a-f0-9]{64}$/u.test(plan.hostAnchor) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(plan.transactionId)
    || !Number.isSafeInteger(plan.createdAt) || !Number.isSafeInteger(plan.expiresAt)
    || plan.createdAt < 1 || plan.expiresAt <= plan.createdAt || plan.expiresAt - plan.createdAt > 300_000
    || plan.expiresAt > Math.min(plan.oldIdentity.config.expiresAt, plan.nextIdentity.config.expiresAt,
      plan.oldIdentity.config.runner.expiresAt, plan.nextIdentity.config.runner.expiresAt)) fail('invalid plan')
  const actual = identities(plan.oldIdentity.logicalPath, plan.oldIdentity.config, plan.nextIdentity.config)
  if (encode(actual) !== encode({ oldIdentity: plan.oldIdentity, nextIdentity: plan.nextIdentity })) fail('public identity changed')
}
export function planEmptyAdoptionHandoff(scope: EmptyAdoptionScope): Readonly<EmptyAdoptionPlan> {
  const pair = identities(scope.logicalPath, scope.oldConfig, scope.nextConfig)
  const body = { protocol: PROTOCOL, transactionId: scope.transactionId, hostAnchor: scope.hostAnchor,
    physicalPath: scope.physicalPath, ...pair, snapshot: bytes(scope.physicalPath, 64 * 1024 * 1024), createdAt: scope.now, expiresAt: scope.expiresAt }
  const plan: EmptyAdoptionPlan = { ...body, digest: hash(body) }; validatePlan(plan)
  if (scope.now >= Math.min(scope.oldConfig.expiresAt, scope.nextConfig.expiresAt,
    scope.oldConfig.runner.expiresAt, scope.nextConfig.runner.expiresAt) || scope.expiresAt > Math.min(scope.oldConfig.expiresAt, scope.nextConfig.expiresAt,
      scope.oldConfig.runner.expiresAt, scope.nextConfig.runner.expiresAt)) fail('expired grant or plan')
  openExisting(scope.physicalPath, db => {
    db.exec('BEGIN')
    try { schema(db, false); authority(db, pair.oldIdentity); empty(db)
      if (encode(bytes(scope.physicalPath, 64 * 1024 * 1024)) !== encode(plan.snapshot)) fail('plan snapshot drift')
    } finally { db.exec('ROLLBACK') }
  })
  return freeze(plan)
}
function storedProof(db: DatabaseSync, plan: EmptyAdoptionPlan): EmptyAdoptionProof {
  schema(db, true)
  const rows = textRows(db, AUDIT, ['proof_json', 'proof_digest'])
  if (rows.length !== 1 || typeof rows[0]!.proof_json !== 'string') fail('missing immutable proof')
  const proof = JSON.parse(rows[0]!.proof_json!) as EmptyAdoptionProof
  exact(proof, ['protocol','plan','fileIdentity','emptyBusiness','digest'])
  exact(proof.fileIdentity, ['dev','ino','uid','gid','mode','nlink'])
  exact(proof.emptyBusiness, ['adoptions','calls','sourceArchives'])
  if (encode(proof) !== rows[0]!.proof_json) fail('noncanonical proof JSON')
  const { digest: _digest, ...body } = proof
  if (proof.protocol !== PROTOCOL || proof.digest !== hash(body) || proof.digest !== rows[0]!.proof_digest
    || encode(proof.plan) !== encode(plan) || encode(proof.fileIdentity) !== encode(plan.snapshot.identity)
    || encode(proof.emptyBusiness) !== encode({ adoptions: 0, calls: 0, sourceArchives: 0 })) fail('proof mismatch')
  authority(db, plan.nextIdentity)
  return proof
}
export function applyEmptyAdoptionHandoff(plan: EmptyAdoptionPlan, input: { now: number; expectedPlanDigest: string; expectedHostAnchor: string }): Readonly<EmptyAdoptionProof> {
  validatePlan(plan)
  if (plan.digest !== input.expectedPlanDigest || plan.hostAnchor !== input.expectedHostAnchor) fail('external plan anchor mismatch')
  const now = input.now
  if (!Number.isSafeInteger(now) || now < plan.createdAt) fail('invalid apply time')
  return openExisting(plan.physicalPath, db => {
    db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
    try {
      if (db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(AUDIT)) {
        const proof = storedProof(db, plan)
        empty(db) // stopped empty acknowledgement only, never a new handoff
        if (encode(identity(plan.physicalPath)) !== encode(proof.fileIdentity)) fail('retry file identity mismatch')
        db.exec('ROLLBACK'); return freeze(proof)
      }
      if (!Number.isSafeInteger(now) || now < plan.createdAt || now > plan.expiresAt) fail('stale plan')
      schema(db, false); authority(db, plan.oldIdentity); empty(db)
      if (encode(bytes(plan.physicalPath, 64 * 1024 * 1024)) !== encode(plan.snapshot)) fail('apply snapshot drift')
      const result = db.prepare('UPDATE authority SET authority_digest=?,config_json=? WHERE authority_id=? AND authority_digest=? AND key_id=? AND public_key=? AND config_json=?')
        .run(plan.nextIdentity.authorityDigest, encode(plan.nextIdentity.config), plan.oldIdentity.config.authorityId,
          plan.oldIdentity.authorityDigest, plan.oldIdentity.config.keyId, plan.oldIdentity.publicKey, encode(plan.oldIdentity.config))
      if (result.changes !== 1) fail('authority compare-and-swap failed')
      if (encode(identity(plan.physicalPath)) !== encode(plan.snapshot.identity)) fail('apply file identity drift')
      const body = { protocol: PROTOCOL, plan: structuredClone(plan), fileIdentity: identity(plan.physicalPath),
        emptyBusiness: { adoptions: 0 as const, calls: 0 as const, sourceArchives: 0 as const } }
      const proof: EmptyAdoptionProof = { ...body, digest: hash(body) }
      db.exec(`${AUDIT_SQL};${NO_UPDATE};${NO_DELETE};`)
      db.prepare(`INSERT INTO ${AUDIT} VALUES (1,?,?)`).run(encode(proof), proof.digest)
      schema(db, true); authority(db, plan.nextIdentity); empty(db)
      if (encode(identity(plan.physicalPath)) !== encode(plan.snapshot.identity)) fail('commit file identity drift')
      db.exec('COMMIT')
      return freeze(proof)
    } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
  }, true)
}
/** Stopped-stage / post-cutover BEFORE START acceptance only: prove current emptiness again.
 * Do not call this after ordinary Host work begins. Later legitimate business is governed by
 * the normal constructor; a general historical proof reader is outside this empty-only API.
 * Rename on the same inode is allowed; copying needs a separate authorized contract. */
export function verifyEmptyAdoptionHandoff(input: { physicalPath: string; plan: EmptyAdoptionPlan; expectedProofDigest: string }): Readonly<EmptyAdoptionProof> {
  validatePlan(input.plan)
  return openExisting(input.physicalPath, db => {
    db.exec('BEGIN')
    try {
      const proof = storedProof(db, input.plan)
      empty(db)
      if (proof.digest !== input.expectedProofDigest || !/^[a-f0-9]{64}$/u.test(input.expectedProofDigest)
        || encode(identity(input.physicalPath)) !== encode(proof.fileIdentity)) fail('external anchor or file identity mismatch')
      return freeze(proof)
    } finally { db.exec('ROLLBACK') }
  })
}
