import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { grantDigest, IsolationLedger } from './ledger.js'
import { linuxRunnerStateSchemaDigest, resealLinuxRunnerState, validateLinuxRunnerStateSeal,
  type LinuxRunnerStateSeal } from './linux-runner-state.js'
import type { IsolationGrant } from './types.js'

/**
 * Authorized Docker (or macOS seatbelt) -> linux-native backend handover for a
 * single verifier runner ledger, executed offline against a disposable staging
 * copy of the owner home.
 *
 * Guarantees:
 *  - the grant keeps id 'verification' / revision 1; only its identity five,
 *    terms and digest are rewritten, with the exact freeze-order byte formula
 *    syncGrants uses, so the native runner's first sync is a no-op;
 *  - historical job rows keep their identity five columns and are only flagged
 *    migrated=1. The unique eight-tuple therefore never collides with a native
 *    request (new authority digest) while grant_id-keyed usage keeps counting;
 *  - prepared/running rows are settled to unknown/quiescent:false by direct
 *    SQL identical to settle()'s terminal update, and their Docker creation
 *    witnesses are retired to isolation_audit rather than carried forward;
 *  - the Docker-era controller lease is expired inside the same transaction, so
 *    the first linux-native claim fences forward immediately instead of waiting
 *    for the old owner's wall-clock TTL to lapse;
 *  - the ledger is checkpointed with no sidecars and resealed over the staging
 *    file identities while recording the logical live paths.
 *
 * A caller that must publish the seal before the handover (so the new authority
 * digest can be recomputed from it) first calls
 * prepareLinuxVerifierHandoverState, which upgrades the staged ledger to v9 and
 * publishes the seal over it (it never reads a clock and performs no audited
 * write). It then passes that ref as `existingSeal` to the handover itself. The primitive then proves the staged
 * seal is that exact reference and that its body still binds the staging tree,
 * performs the same rewrite, and returns the reusable ref instead of resealing.
 * Without `existingSeal` nothing changes: a staged seal is still refused.
 *
 * The primitive never reads a clock and never opens a runner: the orchestrator
 * supplies every value after recompiling the owner authority itself. Because the
 * rewritten grant is pinned to revision 1, the orchestrator must also pass the
 * exact expiresAt/maxRuns/maxTotalDurationMs the upgraded owner configuration
 * grants: a later syncGrants with different terms fails as a revision-digest
 * mismatch, which would only surface after the cutover.
 *
 * Not covered: a linux-native runner whose seal was written under schema 8 is
 * refused (its jobs are native history, and seals require ledgerSchemaVersion 9).
 * Such a state needs an explicit resealLinuxRunnerState({ requireEmpty: false })
 * caller, or discard-and-reinstall; this primitive never silently reinterprets it.
 */

const DIGEST = /^[a-f0-9]{64}$/u
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const SEAL_KEYS = ['schemaVersion', 'protocol', 'id', 'kind', 'uid', 'stateRoot', 'ledger', 'ledgerSchemaVersion', 'schemaSha256']
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

function fail(message: string): never { throw new Error(`Linux runner handover: ${message}`) }
function canonical(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && resolve(value) === value && value !== '/' && !/[\p{Cc}\\]/u.test(value)
}
function positive(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximum
}
function privateDirectory(path: string): void {
  const info = lstatSync(path)
  if (realpathSync(path) !== path || !info.isDirectory() || info.isSymbolicLink()
    || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) fail('staging directory is not private and canonical')
}
function privateSealParent(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
  privateDirectory(path)
}
function present(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return false
  }
}
function removeSidecar(path: string): void {
  let info
  try { info = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.())
    fail('ledger sidecar is not a private regular file')
  unlinkSync(path)
}

interface SealIdentity { path: string; dev: number; ino: number }
interface SealBody {
  schemaVersion: 1
  protocol: 'dsh-linux-runner-state/v1'
  id: string
  kind: 'verification'
  uid: number
  stateRoot: SealIdentity
  ledger: SealIdentity
  ledgerSchemaVersion: 9
  schemaSha256: string
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && 'value' in item)
}
function sealIdentity(value: unknown): value is SealIdentity {
  return exact(value, ['path', 'dev', 'ino']) && canonical(value.path)
    && Number.isSafeInteger(value.dev) && Number(value.dev) >= 0
    && Number.isSafeInteger(value.ino) && Number(value.ino) >= 0
}
/** Read back a staged seal written by resealLinuxRunnerState. The body records
 * physical staging dev/ino next to the logical live paths, so this proves the
 * reusable ref, the tree and the ledger all still describe the same state. */
function readStagedSeal(path: string): { body: SealBody; bytes: Buffer } {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.()
    || (info.mode & 0o777) !== 0o600 || info.size > 16_384) fail('existing seal is not a private canonical file')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (opened.dev !== info.dev || opened.ino !== info.ino) fail('existing seal changed while being read')
    const bytes = readFileSync(fd)
    const body: unknown = JSON.parse(bytes.toString('utf8'))
    if (!exact(body, SEAL_KEYS) || body.schemaVersion !== 1 || body.protocol !== 'dsh-linux-runner-state/v1'
      || typeof body.id !== 'string' || !UUID.test(body.id) || body.kind !== 'verification'
      || body.uid !== process.getuid?.() || !sealIdentity(body.stateRoot) || !sealIdentity(body.ledger)
      || body.ledgerSchemaVersion !== 9 || typeof body.schemaSha256 !== 'string' || !DIGEST.test(body.schemaSha256))
      fail('existing seal body differs')
    const after = lstatSync(path)
    if (after.dev !== info.dev || after.ino !== info.ino || after.nlink !== 1) fail('existing seal changed while being read')
    return { body: body as unknown as SealBody, bytes }
  } finally { closeSync(fd) }
}
/** Prove `ref` is the staged seal and still binds the staging copy and the live
 * locations. Runs before any ledger mutation and again before returning it. */
function assertReusableSeal(input: LinuxVerifierHandoverInput, value: unknown): LinuxRunnerStateSeal {
  let ref: LinuxRunnerStateSeal
  try { ref = validateLinuxRunnerStateSeal(value) } catch { fail('invalid handover input') }
  if (ref.path !== input.liveSealPath) fail('existing seal does not bind the live seal path')
  if (!present(input.stageSealPath)) fail('existing seal is missing from the staging copy')
  const { body, bytes } = readStagedSeal(input.stageSealPath)
  if (sha(bytes) !== ref.sha256) fail('existing seal reference differs from the staged seal')
  const ledgerPath = join(input.stageStateRoot, 'ledger.sqlite')
  if (body.stateRoot.path !== input.liveStateRoot || body.ledger.path !== join(input.liveStateRoot, 'ledger.sqlite'))
    fail('existing seal logical locations differ from the handover')
  let digest: string
  try { digest = linuxRunnerStateSchemaDigest(ledgerPath) } catch (error) {
    fail(`existing seal ledger is not sealable (${(error as Error).message})`)
  }
  if (body.schemaSha256 !== digest) fail('existing seal schema digest differs from the staged ledger')
  const root = lstatSync(input.stageStateRoot), ledger = lstatSync(ledgerPath)
  if (body.stateRoot.dev !== root.dev || body.stateRoot.ino !== root.ino
    || body.ledger.dev !== ledger.dev || body.ledger.ino !== ledger.ino)
    fail('existing seal identities differ from the staging copy')
  return ref
}

export interface LinuxVerifierHandoverInput {
  /** Runner role directory name (audit only); paths are supplied explicitly. */
  name: string
  /** Physical private state root inside the staging copy (cp target). */
  stageStateRoot: string
  /** Physical seal destination inside the staging copy. */
  stageSealPath: string
  /** Logical live state root recorded as the new grant workspace and in the seal. */
  liveStateRoot: string
  /** Logical live seal path returned in the ref for the owner config. */
  liveSealPath: string
  /** Digest currently frozen in the staged grant; binds the copy to live authority. */
  oldAuthorityDigest: string
  /** Recomputed owner authority digest; must differ so request keys never collide. */
  newAuthorityDigest: string
  /** Pre-upgrade workspace when the home itself is being relocated. */
  oldWorkspace?: string
  /** Seal the caller already published with resealLinuxRunnerState over the same
   * staging tree. Optional: omitting it keeps the original reseal-on-handover
   * behavior and still refuses a pre-existing staged seal. */
  existingSeal?: LinuxRunnerStateSeal
  expiresAt: number
  maxRuns: number
  maxTotalDurationMs: number
  /** Injected settlement timestamp; the primitive never reads a clock. */
  now: number
}

export interface LinuxVerifierHandoverResult {
  readonly seal: LinuxRunnerStateSeal
  readonly jobsMigrated: number
  readonly activeSettled: number
}

export function migrateLinuxVerifierRunnerState(input: LinuxVerifierHandoverInput): LinuxVerifierHandoverResult {
  if (process.platform !== 'linux' || !process.getuid?.()) fail('requires non-root Linux')
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).some(key => !['name', 'stageStateRoot', 'stageSealPath', 'liveStateRoot', 'liveSealPath',
      'oldAuthorityDigest', 'newAuthorityDigest', 'oldWorkspace', 'existingSeal', 'expiresAt', 'maxRuns',
      'maxTotalDurationMs', 'now'].includes(String(key)))
    || typeof input.name !== 'string' || !NAME.test(input.name)
    || !canonical(input.stageStateRoot) || !canonical(input.stageSealPath)
    || !canonical(input.liveStateRoot) || !canonical(input.liveSealPath)
    || (input.oldWorkspace !== undefined && !canonical(input.oldWorkspace))
    || !DIGEST.test(input.oldAuthorityDigest) || !DIGEST.test(input.newAuthorityDigest)
    || input.oldAuthorityDigest === input.newAuthorityDigest
    || !positive(input.expiresAt, Number.MAX_SAFE_INTEGER)
    || !positive(input.maxRuns, 10_000) || !positive(input.maxTotalDurationMs, 86_400_000)
    || !Number.isSafeInteger(input.now) || input.now < 0) fail('invalid handover input')
  const oldWorkspace = input.oldWorkspace ?? input.liveStateRoot
  if (input.stageSealPath === input.stageStateRoot || input.stageSealPath.startsWith(input.stageStateRoot + '/')
    || input.stageStateRoot.startsWith(input.stageSealPath + '/')
    || input.liveSealPath === input.liveStateRoot || input.liveSealPath.startsWith(input.liveStateRoot + '/')
    || input.liveStateRoot.startsWith(input.liveSealPath + '/')) fail('state and seal paths are nested')

  privateDirectory(input.stageStateRoot)
  privateDirectory(dirname(input.stageStateRoot))
  const ledgerPath = join(input.stageStateRoot, 'ledger.sqlite')
  let staged
  try { staged = lstatSync(ledgerPath) } catch { fail('verifier ledger is missing from the staging copy') }
  if (!staged.isFile() || staged.isSymbolicLink() || staged.uid !== process.getuid() || (staged.mode & 0o777) !== 0o600 || staged.nlink !== 1)
    fail('verifier ledger is not private and canonical')
  // Reuse path: the staged seal is expected, but only the exact caller-published
  // reference that still binds this copy and the live locations is accepted.
  const existingSeal = input.existingSeal === undefined ? undefined : assertReusableSeal(input, input.existingSeal)
  if (existingSeal === undefined && present(input.stageSealPath)) fail('staging state was already handed over')

  // Opening through the current ledger brings any older schema to v9 (adding the
  // migrated column) using the shipped migration chain; the handover then only
  // performs its own audited, authority-specific rewrite.
  const migrated = new IsolationLedger(ledgerPath, { now: () => input.now })
  migrated.close()

  let activeSettled = 0, jobsMigrated = 0
  const database = new DatabaseSync(ledgerPath, { enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;')
    database.exec('BEGIN IMMEDIATE')
    try {
      if (database.prepare('PRAGMA user_version').get()?.user_version !== 9
        || database.prepare("SELECT value FROM schema_meta WHERE key='schema-version'").get()?.value !== '9') fail('ledger is not schema 9')

      const grant = database.prepare('SELECT digest, revision, expires_at, max_runs, max_total_duration_ms, revoked, principal_digest, principal_record_id, principal_version, workspace, agent_preset FROM isolation_grants WHERE id=?').get('verification') as Record<string, unknown> | undefined
      if (!grant) fail('verification grant is missing from the staged ledger')
      if (grant.revision !== 1 || grant.principal_version !== 1 || grant.agent_preset !== 'verification'
        || grant.principal_digest !== input.oldAuthorityDigest
        || grant.principal_record_id !== `verification:${input.oldAuthorityDigest}`
        || grant.workspace !== oldWorkspace) fail('staged verification grant does not match the live authority')

      if (database.prepare("SELECT 1 FROM isolation_jobs WHERE backend_kind='linux-native' LIMIT 1").get())
        fail('staged ledger already contains linux-native jobs')
      const counts = database.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN migrated=1 THEN 1 ELSE 0 END),0) AS done FROM isolation_jobs').get() as { total: number; done: number }
      if (counts.total > 0 && counts.done === counts.total) fail('staged ledger was already handed over')
      if (counts.done !== 0) fail('staged ledger is partially migrated')
      jobsMigrated = counts.total

      const active = database.prepare("SELECT id, version, backend_kind, dispatch_attempted, creation_witness_json FROM isolation_jobs WHERE status IN ('prepared','running')").all() as Array<{ id: string; version: number; backend_kind: string; dispatch_attempted: number; creation_witness_json: string | null }>
      const audit = database.prepare('INSERT INTO isolation_audit(occurred_at, action, job_id, grant_id, detail) VALUES (?, ?, ?, ?, ?)')
      const settle = database.prepare("UPDATE isolation_jobs SET status='unknown', result_json=?, creation_witness_json=NULL, version=version+1, updated_at=? WHERE id=? AND version=? AND status IN ('prepared','running')")
      for (const job of active) {
        audit.run(input.now, 'backend-handover-witness-retired', job.id, 'verification',
          JSON.stringify({ backend: job.backend_kind, dispatchAttempted: job.dispatch_attempted,
            witnessSha256: job.creation_witness_json === null ? null : sha(job.creation_witness_json) }))
        const result = { jobId: job.id, status: 'unknown' as const, quiescent: false, stdout: '', stderr: '', artifacts: [], reason: 'verification-recovery-no-replay' }
        const changed = settle.run(JSON.stringify(result), input.now, job.id, job.version)
        if (changed.changes !== 1) fail('active job settlement changed an unexpected row')
        activeSettled += 1
      }

      // Identity five columns of every historical row stay untouched; the row is
      // only fenced from replay, capacity and recovery. Terminal rows keep their
      // witnesses and results byte-for-byte.
      const flagged = database.prepare('UPDATE isolation_jobs SET migrated=1 WHERE migrated=0').run()
      if (flagged.changes !== jobsMigrated) fail('job migration count differs')

      const next: IsolationGrant = {
        principalDigest: input.newAuthorityDigest,
        principalRecordId: `verification:${input.newAuthorityDigest}`,
        principalVersion: 1,
        workspace: input.liveStateRoot,
        agentPreset: 'verification',
        id: 'verification', revision: 1,
        expiresAt: input.expiresAt, maxRuns: input.maxRuns, maxTotalDurationMs: input.maxTotalDurationMs,
      }
      const rewritten = database.prepare('UPDATE isolation_grants SET digest=?, revision=1, expires_at=?, max_runs=?, max_total_duration_ms=?, revoked=0, revoke_reason=NULL, principal_digest=?, principal_record_id=?, principal_version=?, workspace=?, agent_preset=? WHERE id=?')
        .run(grantDigest(next), input.expiresAt, input.maxRuns, input.maxTotalDurationMs,
          next.principalDigest, next.principalRecordId, next.principalVersion, next.workspace, next.agentPreset, 'verification')
      if (rewritten.changes !== 1) fail('verification grant rewrite changed an unexpected row')

      // Retire the Docker-era controller lease in the same transaction. The
      // staged row still names the old owner UUID with a wall-clock expiry, so
      // claimController would reject the new owner until that TTL lapsed; an
      // expired lease makes the first native claim fence forward immediately.
      const retired = database.prepare('UPDATE isolation_controller SET expires_at=? WHERE singleton=1').run(input.now)
      if (retired.changes > 1) fail('controller retirement changed an unexpected row')

      const backends = database.prepare('SELECT DISTINCT backend_kind AS backend FROM isolation_jobs ORDER BY backend_kind').all() as Array<{ backend: string }>
      audit.run(input.now, 'backend-handover-controller-retired', null, 'verification',
        JSON.stringify({ leasesRetired: retired.changes }))
      audit.run(input.now, 'backend-handover', null, 'verification',
        JSON.stringify({ name: input.name, from: backends.map(item => item.backend), to: 'linux-native',
          jobs: jobsMigrated, active: activeSettled,
          fromAuthority: input.oldAuthorityDigest, toAuthority: input.newAuthorityDigest }))

      database.exec('COMMIT')
    } catch (error) {
      try { database.exec('ROLLBACK') } catch { /* Preserve the original failure. */ }
      throw error
    }
    const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined
    if (!checkpoint || checkpoint.busy !== 0) fail('ledger checkpoint did not complete')
  } finally {
    database.close()
  }
  if (present(`${ledgerPath}-journal`)) fail('staged ledger left a rollback journal behind')
  removeSidecar(`${ledgerPath}-wal`)
  removeSidecar(`${ledgerPath}-shm`)
  chmodSync(ledgerPath, 0o600)

  if (existingSeal !== undefined) {
    // The published seal is returned unchanged, so prove the rewrite left the
    // sealed identities and schema exactly as they were before the transaction.
    return Object.freeze({ seal: assertReusableSeal(input, existingSeal), jobsMigrated, activeSettled })
  }
  privateSealParent(dirname(input.stageSealPath))
  const seal = resealLinuxRunnerState({
    stateRoot: input.stageStateRoot, sealPath: input.stageSealPath, kind: 'verification',
    logicalStateRoot: input.liveStateRoot, logicalSealPath: input.liveSealPath,
  })
  return Object.freeze({ seal, jobsMigrated, activeSettled })
}

export interface LinuxRepositoryHandoverInput {
  stageStateRoot: string
  stageSealPath: string
  liveStateRoot: string
  liveSealPath: string
}

/** The repository runner is linux-native only: its state is a brand-new empty
 * sealed ledger, even when verifier ledgers carry migrated Docker history. */
export function prepareLinuxRepositoryHandoverState(input: LinuxRepositoryHandoverInput): LinuxRunnerStateSeal {
  if (process.platform !== 'linux' || !process.getuid?.()) fail('requires non-root Linux')
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== 4
    || !canonical(input.stageStateRoot) || !canonical(input.stageSealPath)
    || !canonical(input.liveStateRoot) || !canonical(input.liveSealPath)) fail('invalid repository handover input')
  privateDirectory(dirname(input.stageStateRoot))
  mkdirSync(input.stageStateRoot, { recursive: true, mode: 0o700 })
  chmodSync(input.stageStateRoot, 0o700)
  privateDirectory(input.stageStateRoot)
  privateSealParent(dirname(input.stageSealPath))
  return resealLinuxRunnerState({
    stateRoot: input.stageStateRoot, sealPath: input.stageSealPath, kind: 'repository', requireEmpty: true,
    logicalStateRoot: input.liveStateRoot, logicalSealPath: input.liveSealPath,
  })
}

export interface LinuxVerifierHandoverPreparationInput {
  /** Runner role directory name (audit only); paths are supplied explicitly. */
  name: string
  /** Physical private state root inside the staging copy (cp target). */
  stageStateRoot: string
  /** Physical seal destination inside the staging copy. */
  stageSealPath: string
  /** Logical live state root recorded in the seal and returned as the grant workspace. */
  liveStateRoot: string
  /** Logical live seal path returned in the ref for the owner config. */
  liveSealPath: string
}

export interface LinuxVerifierHandoverPreparation {
  readonly seal: LinuxRunnerStateSeal
  /** Identity of the staging copy's Docker-era grant. `principalDigest` is the
   * `oldAuthorityDigest` the handover expects; the numeric fields are
   * cross-checks only, because the caller supplies freshly compiled new terms. */
  readonly grant: {
    readonly principalDigest: string
    readonly revision: number
    readonly expiresAt: number
    readonly maxRuns: number
    readonly maxTotalDurationMs: number
  }
}

/**
 * Publish the verification seal over an unsealed staging copy before the new
 * owner authority digest is compiled, then let migrateLinuxVerifierRunnerState
 * (given this exact ref as `existingSeal`) perform the audited rewrite.
 *
 * Opening through the shipped ledger upgrades an older staging copy to v9 with
 * the same chain the handover would use; that path is data-only, so the schema
 * digest sealed here survives the later grant/job rewrite. One-shot by design:
 * an existing staged seal means the handover already ran, and a staging copy
 * whose grant is not the live Docker-era owner grant is never sealed.
 */
export function prepareLinuxVerifierHandoverState(
  input: LinuxVerifierHandoverPreparationInput,
): LinuxVerifierHandoverPreparation {
  if (process.platform !== 'linux' || !process.getuid?.()) fail('requires non-root Linux')
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== 5
    || !['name', 'stageStateRoot', 'stageSealPath', 'liveStateRoot', 'liveSealPath'].every(key => Object.hasOwn(input, key))
    || typeof input.name !== 'string' || !NAME.test(input.name)
    || !canonical(input.stageStateRoot) || !canonical(input.stageSealPath)
    || !canonical(input.liveStateRoot) || !canonical(input.liveSealPath)) fail('invalid verifier handover preparation input')
  if (input.stageSealPath === input.stageStateRoot || input.stageSealPath.startsWith(input.stageStateRoot + '/')
    || input.stageStateRoot.startsWith(input.stageSealPath + '/')
    || input.liveSealPath === input.liveStateRoot || input.liveSealPath.startsWith(input.liveStateRoot + '/')
    || input.liveStateRoot.startsWith(input.liveSealPath + '/')) fail('state and seal paths are nested')

  privateDirectory(input.stageStateRoot)
  privateDirectory(dirname(input.stageStateRoot))
  const ledgerPath = join(input.stageStateRoot, 'ledger.sqlite')
  let staged
  try { staged = lstatSync(ledgerPath) } catch { fail('verifier ledger is missing from the staging copy') }
  if (!staged.isFile() || staged.isSymbolicLink() || staged.uid !== process.getuid() || (staged.mode & 0o777) !== 0o600 || staged.nlink !== 1)
    fail('verifier ledger is not private and canonical')
  // Publish exactly once: a staged seal is the handover's fingerprint, so it is
  // never replaced on trust (reseal would otherwise unlink it).
  if (present(input.stageSealPath)) fail('staging state was already handed over')

  // The caller's `now` belongs to the audited handover; this pre-seal step only
  // brings the schema forward, so it deliberately uses the ledger's own clock.
  new IsolationLedger(ledgerPath).close()

  const database = new DatabaseSync(ledgerPath, { enableForeignKeyConstraints: true })
  let grant: Record<string, unknown> | undefined
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;')
    grant = database.prepare('SELECT revision, expires_at, max_runs, max_total_duration_ms, revoked, principal_digest,'
      + ' principal_record_id, principal_version, agent_preset FROM isolation_grants WHERE id=?').get('verification') as Record<string, unknown> | undefined
  } finally {
    try { database.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* Sidecars are probed below. */ }
    database.close()
  }
  removeSidecar(`${ledgerPath}-wal`)
  removeSidecar(`${ledgerPath}-shm`)
  chmodSync(ledgerPath, 0o600)

  if (!grant) fail('verifier grant is not the staged owner grant')
  const { revision, expires_at: expiresAt, max_runs: maxRuns, max_total_duration_ms: maxTotalDurationMs,
    revoked, principal_digest: principalDigest, principal_record_id: principalRecordId,
    principal_version: principalVersion, agent_preset: preset } = grant
  if (revision !== 1 || principalVersion !== 1 || preset !== 'verification' || revoked !== 0
    || typeof principalDigest !== 'string' || !DIGEST.test(principalDigest)
    || principalRecordId !== `verification:${principalDigest}`)
    fail('verifier grant is not the staged owner grant')
  // The caps are the ceilings the native runner config can express, so oversized
  // Docker-era terms are refused with their own cause instead of being reported
  // as an identity mismatch.
  if (!positive(expiresAt, Number.MAX_SAFE_INTEGER)
    || !positive(maxRuns, 10_000) || !positive(maxTotalDurationMs, 86_400_000))
    fail('verifier grant exceeds the native handover budget')

  privateSealParent(dirname(input.stageSealPath))
  const seal = resealLinuxRunnerState({
    stateRoot: input.stageStateRoot, sealPath: input.stageSealPath, kind: 'verification', requireEmpty: false,
    logicalStateRoot: input.liveStateRoot, logicalSealPath: input.liveSealPath,
  })
  return Object.freeze({
    seal,
    grant: Object.freeze({ principalDigest, revision: 1, expiresAt, maxRuns, maxTotalDurationMs }),
  })
}
