import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { IsolationGrant } from './types.js'

export type IsolationGrantDiagnosticReason =
  | 'database-missing' | 'database-unavailable' | 'database-corrupt' | 'schema-unsupported'
  | 'grant-missing' | 'grant-config-mismatch' | 'grant-revoked' | 'grant-expired'
  | 'max-runs-exhausted' | 'duration-budget-exhausted'

export interface IsolationGrantDiagnostic {
  readonly status: 'available' | 'ineligible' | 'unavailable'
  readonly reasons: readonly IsolationGrantDiagnosticReason[]
  readonly runsUsed: number | null
  readonly durationReservedMs: number | null
  readonly remainingRuns: number | null
  readonly remainingDurationMs: number | null
  readonly activeJobs: number | null
  readonly unknownJobs: number | null
}

const DIGEST = /^[a-f0-9]{64}$/u
const TEXT = /^[^\p{Cc}]{1,4096}$/u
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) freeze(item)
    Object.freeze(value)
  }
  return value
}
function unavailable(reason: Extract<IsolationGrantDiagnosticReason, 'database-missing' | 'database-unavailable' | 'database-corrupt' | 'schema-unsupported'>): IsolationGrantDiagnostic {
  return freeze({ status: 'unavailable', reasons: freeze([reason]), runsUsed: null, durationReservedMs: null,
    remainingRuns: null, remainingDurationMs: null, activeJobs: null, unknownJobs: null })
}
function validate(input: { stateRoot: string; grant: IsolationGrant; now?: number }): { stateRoot: string; grant: IsolationGrant; now: number } {
  const grantKeys = ['id', 'revision', 'principalDigest', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset', 'expiresAt', 'maxRuns', 'maxTotalDurationMs']
  if (input === null || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => key !== 'stateRoot' && key !== 'grant' && key !== 'now')
    || typeof input.stateRoot !== 'string' || !isAbsolute(input.stateRoot) || resolve(input.stateRoot) !== input.stateRoot || input.stateRoot === '/' || /[\p{Cc}]/u.test(input.stateRoot)
    || !input.grant || typeof input.grant !== 'object' || Object.getPrototypeOf(input.grant) !== Object.prototype || Object.keys(input.grant).length !== grantKeys.length || grantKeys.some(key => !Object.hasOwn(input.grant, key))) throw new Error('invalid isolation grant diagnostic input')
  const grant = input.grant
  if (typeof grant.id !== 'string' || !TEXT.test(grant.id) || !positive(grant.revision) || typeof grant.principalDigest !== 'string' || !DIGEST.test(grant.principalDigest) || typeof grant.principalRecordId !== 'string' || !TEXT.test(grant.principalRecordId)
    || !positive(grant.principalVersion) || typeof grant.workspace !== 'string' || !isAbsolute(grant.workspace) || resolve(grant.workspace) !== grant.workspace || /[\p{Cc}]/u.test(grant.workspace)
    || typeof grant.agentPreset !== 'string' || !TEXT.test(grant.agentPreset) || !positive(grant.expiresAt) || !positive(grant.maxRuns) || !positive(grant.maxTotalDurationMs)) throw new Error('invalid isolation grant diagnostic input')
  const now = input.now ?? Date.now()
  if (!timestamp(now)) throw new Error('invalid isolation grant diagnostic clock')
  return { stateRoot: input.stateRoot, grant: freeze({ ...grant }), now }
}
function safeCount(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined }

/** Read-only ledger inspection for an operator doctor. It never creates, migrates, leases, or consumes grants. */
export function inspectIsolationGrant(input: { stateRoot: string; grant: IsolationGrant; now?: number }): IsolationGrantDiagnostic {
  const { stateRoot, grant, now } = validate(input)
  const path = join(stateRoot, 'ledger.sqlite')
  if (!existsSync(path) && !existsSync(stateRoot)) return unavailable('database-missing')
  try {
    const root = lstatSync(stateRoot)
    if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(stateRoot) !== stateRoot
      || root.uid !== process.getuid?.() || (root.mode & 0o077) !== 0) return unavailable('database-unavailable')
    const file = lstatSync(path)
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.()) return unavailable('database-unavailable')
  } catch {
    return existsSync(stateRoot) ? unavailable('database-unavailable') : unavailable('database-missing')
  }
  let database: DatabaseSync | undefined
  let transaction = false
  try {
    database = new DatabaseSync(path, { readOnly: true })
    database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250; BEGIN;'); transaction = true
    const version = (database.prepare('PRAGMA user_version').get() as { user_version?: unknown }).user_version
    if (version !== 6) return unavailable('schema-unsupported')
    const schema = database.prepare("SELECT value FROM schema_meta WHERE key='schema-version'").get() as { value?: unknown } | undefined
    if (schema?.value !== '6') return unavailable('schema-unsupported')
    const row = database.prepare('SELECT revision, expires_at, max_runs, max_total_duration_ms, revoked, principal_digest, principal_record_id, principal_version, workspace, agent_preset FROM isolation_grants WHERE id=?').get(grant.id) as Record<string, unknown> | undefined
    if (row !== undefined) {
      const positiveFields = ['revision', 'expires_at', 'max_runs', 'max_total_duration_ms', 'principal_version'] as const
      if (positiveFields.some(key => !positive(row[key])) || (row.revoked !== 0 && row.revoked !== 1) || typeof row.principal_digest !== 'string' || typeof row.principal_record_id !== 'string' || typeof row.workspace !== 'string' || typeof row.agent_preset !== 'string') return unavailable('database-corrupt')
    }
    const usage = database.prepare('SELECT COUNT(*) AS runs, COALESCE(SUM(reserved_duration_ms), 0) AS duration FROM isolation_jobs WHERE grant_id=?').get(grant.id) as { runs?: unknown; duration?: unknown }
    const active = database.prepare("SELECT COUNT(*) AS active FROM isolation_jobs WHERE grant_id=? AND (status IN ('prepared','running') OR (result_json IS NOT NULL AND json_extract(result_json, '$.quiescent')=0))").get(grant.id) as { active?: unknown }
    const unknown = database.prepare("SELECT COUNT(*) AS unknown_jobs FROM isolation_jobs WHERE grant_id=? AND (status='unknown' OR (result_json IS NOT NULL AND json_extract(result_json, '$.status')='unknown'))").get(grant.id) as { unknown_jobs?: unknown }
    const runsUsed = safeCount(usage.runs); const durationReservedMs = safeCount(usage.duration); const activeJobs = safeCount(active.active); const unknownJobs = safeCount(unknown.unknown_jobs)
    if (runsUsed === undefined || durationReservedMs === undefined || activeJobs === undefined || unknownJobs === undefined) return unavailable('database-corrupt')
    const remainingRuns = Math.max(0, grant.maxRuns - runsUsed); const remainingDurationMs = Math.max(0, grant.maxTotalDurationMs - durationReservedMs)
    const reasons: IsolationGrantDiagnosticReason[] = []
    if (row === undefined) reasons.push('grant-missing')
    else {
      const mismatch = row.revision !== grant.revision || row.expires_at !== grant.expiresAt || row.max_runs !== grant.maxRuns || row.max_total_duration_ms !== grant.maxTotalDurationMs
        || row.principal_digest !== grant.principalDigest || row.principal_record_id !== grant.principalRecordId || row.principal_version !== grant.principalVersion || row.workspace !== grant.workspace || row.agent_preset !== grant.agentPreset
      if (mismatch) reasons.push('grant-config-mismatch')
      if (row.revoked === 1) reasons.push('grant-revoked')
    }
    if (grant.expiresAt <= now) reasons.push('grant-expired')
    if (runsUsed >= grant.maxRuns) reasons.push('max-runs-exhausted')
    if (durationReservedMs >= grant.maxTotalDurationMs) reasons.push('duration-budget-exhausted')
    return freeze({ status: reasons.length === 0 ? 'available' : 'ineligible', reasons: freeze(reasons), runsUsed, durationReservedMs,
      remainingRuns, remainingDurationMs, activeJobs, unknownJobs })
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : ''
    return unavailable(message.includes('malformed') || message.includes('database disk image') || message.includes('not a database') ? 'database-corrupt' : 'database-unavailable')
  } finally {
    if (transaction) try { database?.exec('COMMIT') } catch { try { database?.exec('ROLLBACK') } catch {} }
    database?.close()
  }
}
