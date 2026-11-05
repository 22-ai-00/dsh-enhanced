import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { canonicalGrowthJson } from '@dsh-enhanced/assistant-growth-contract'

// Kept free of journal imports: CreationCapabilityJournal reads this audit to count inherited usage.
export const SEALED_ADOPTION_HANDOFF_PROTOCOL = 'dsh-sealed-creation-adoption-handoff/v1' as const
export const SEALED_ADOPTION_AUDIT = 'creation_sealed_adoption_handoff'
const AUDIT_SQL = `CREATE TABLE ${SEALED_ADOPTION_AUDIT} (singleton INTEGER PRIMARY KEY CHECK(singleton=1), proof_json TEXT NOT NULL, proof_digest TEXT NOT NULL CHECK(length(proof_digest)=64)) STRICT`
const NO_UPDATE = `CREATE TRIGGER creation_sealed_handoff_no_update BEFORE UPDATE ON ${SEALED_ADOPTION_AUDIT} BEGIN SELECT RAISE(ABORT,'immutable sealed adoption handoff'); END`
const NO_DELETE = `CREATE TRIGGER creation_sealed_handoff_no_delete BEFORE DELETE ON ${SEALED_ADOPTION_AUDIT} BEGIN SELECT RAISE(ABORT,'immutable sealed adoption handoff'); END`
export const SEALED_ADOPTION_AUDIT_STATEMENTS: readonly string[] = [AUDIT_SQL, NO_UPDATE, NO_DELETE]
const OBJECTS = [['table', SEALED_ADOPTION_AUDIT, AUDIT_SQL], ['trigger', 'creation_sealed_handoff_no_delete', NO_DELETE],
  ['trigger', 'creation_sealed_handoff_no_update', NO_UPDATE]] as const
export const SEALED_PROOF_KEYS = ['protocol','plan','fileIdentity','archive','liveBusiness','inheritedUsage','digest'] as const

function fail(message: string): never { throw new Error(`sealed adoption audit: ${message}`) }
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
function text(raw: unknown): string {
  if (!(raw instanceof Uint8Array)) fail('non-text bytes')
  let decoded: string
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { fail('invalid UTF-8 text') }
  if (decoded.includes('\0') || !Buffer.from(decoded, 'utf8').equals(raw)) fail('noncanonical text bytes')
  return decoded
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail('unexpected fields')
  return value as Record<string, unknown>
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1024) fail('invalid inherited usage')
  return Number(value)
}

/** Exact immutable audit objects and a canonical, self-digested singleton proof; undefined when absent. */
export function readSealedAdoptionAudit(db: DatabaseSync): { proof: Record<string, unknown>; json: string } | undefined {
  const names = [SEALED_ADOPTION_AUDIT, ...OBJECTS.map(([, name]) => name)]
  const objects = db.prepare(`SELECT CAST(type AS BLOB) AS type, CAST(name AS BLOB) AS name, CAST(sql AS BLOB) AS sql
    FROM sqlite_schema WHERE tbl_name=? OR name IN (${names.map(() => '?').join(',')}) ORDER BY type, name`).all(SEALED_ADOPTION_AUDIT, ...names)
  if (objects.length === 0) return undefined
  if (objects.length !== OBJECTS.length || objects.some((row, index) => text(row.type) !== OBJECTS[index]![0]
    || text(row.name) !== OBJECTS[index]![1] || text(row.sql) !== OBJECTS[index]![2])) fail('unexpected audit schema')
  const rows = db.prepare(`SELECT singleton, typeof(singleton) AS kind, CAST(proof_json AS BLOB) AS proof_json,
    CAST(proof_digest AS BLOB) AS proof_digest FROM ${SEALED_ADOPTION_AUDIT}`).all()
  if (rows.length !== 1 || rows[0]!.kind !== 'integer' || rows[0]!.singleton !== 1) fail('missing immutable proof')
  const json = text(rows[0]!.proof_json), column = text(rows[0]!.proof_digest)
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { fail('invalid proof JSON') }
  const proof = record(parsed, SEALED_PROOF_KEYS)
  if (canonicalGrowthJson(proof) !== json) fail('noncanonical proof JSON')
  const { digest, ...body } = proof
  if (proof.protocol !== SEALED_ADOPTION_HANDOFF_PROTOCOL || typeof digest !== 'string'
    || digest !== sha(canonicalGrowthJson(body)) || digest !== column) fail('proof digest mismatch')
  return { proof, json }
}

/** Plan ids archived by the sealed handoff. A sealed id can never be claimed again under the next
 * authority: an old tool returns only under a new plan id with a fresh linux-native certificate. */
export function sealedAdoptionPlanIds(db: DatabaseSync, authorityDigest: string): ReadonlySet<string> {
  if (sealedAdoptionInheritedUsage(db, authorityDigest) === undefined) return new Set()
  const plan = readSealedAdoptionAudit(db)!.proof.plan as { history?: { rows?: unknown } }
  const rows = plan.history?.rows
  if (!Array.isArray(rows)) fail('invalid sealed history rows')
  const ids = new Set<string>()
  for (const row of rows) {
    const planId = (row as { planId?: unknown } | null)?.planId
    if (typeof planId !== 'string' || planId.length === 0 || ids.has(planId)) fail('invalid sealed history rows')
    ids.add(planId)
  }
  return ids
}

/** Usage a journal must keep counting after its history was sealed away. Never refunded. */
export function sealedAdoptionInheritedUsage(db: DatabaseSync, authorityDigest: string): { adoptions: number; calls: number } | undefined {
  const audit = readSealedAdoptionAudit(db)
  if (!audit) return undefined
  const { proof } = audit
  const plan = proof.plan as Record<string, unknown> | null
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('invalid plan')
  const { digest, ...planBody } = plan
  const next = plan.nextIdentity as Record<string, unknown> | null
  const history = plan.history as { counts?: Record<string, unknown> } | null
  if (plan.protocol !== SEALED_ADOPTION_HANDOFF_PROTOCOL || typeof digest !== 'string' || digest !== sha(canonicalGrowthJson(planBody))
    || !next || typeof next !== 'object' || next.authorityDigest !== authorityDigest) fail('proof authority mismatch')
  const usage = record(proof.inheritedUsage, ['adoptions','calls'])
  const result = { adoptions: count(usage.adoptions), calls: count(usage.calls) }
  const planned = record(plan.inheritedUsage, ['adoptions','calls'])
  const live = record(proof.liveBusiness, ['adoptions','calls','sourceArchives'])
  if (planned.adoptions !== result.adoptions || planned.calls !== result.calls
    || history?.counts?.adoptions !== result.adoptions || history.counts.calls !== result.calls
    || live.adoptions !== 0 || live.calls !== 0 || live.sourceArchives !== 0) fail('inherited usage mismatch')
  return result
}
