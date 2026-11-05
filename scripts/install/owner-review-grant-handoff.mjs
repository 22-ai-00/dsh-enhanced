/** Internal stopped-owner installer seam for review lanes that keep history in place.
 * The caller authenticates the owner update, stops writers, stages private copies and
 * supplies both reviewed public identities; this module only drives the verifier's own
 * dsh-review-grant-handoff/v2 on those staged files. It never creates, refills or
 * settles grants and never rewrites verification rows.
 * A non-empty lane must hold exactly one grant row, owned by the old identity's authority:
 * the v2 handoff is a single-authority CAS (one grants.digest old→new for oldIdentity's
 * authorityId), so a second grant row would be neither handed off nor inherited and is refused. */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual as same } from 'node:util'
import { DatabaseSync } from 'node:sqlite'

const protocol = 'dsh-owner-review-grant-handoffs/v1'
const LANES = ['creation-reviews', 'revision-reviews', 'revision-regressions']
const SHA = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
const AUDIT = 'creation_review_grant_handoffs'
const PREFIX = 'owner review grant handoff: '
function fail(code, cause) {
  const error = new Error(`${PREFIX}${code}`, cause === undefined ? undefined : { cause })
  error.code = code; throw error
}
const own = error => typeof error?.message === 'string' && error.message.startsWith(PREFIX) && typeof error.code === 'string'
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !d.enumerable || !('value' in d))) fail('invalid-public-evidence')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))

export function assertOwnerReviewGrantHandoffApi(api) {
  if (typeof api?.verifier?.CreationReviewStore?.openExistingForMaintenance !== 'function'
    || typeof api?.verifier?.lineageHash !== 'function') fail('reviewed-maintenance-api-unavailable')
}

function checkLanes(lanes) {
  if (!Array.isArray(lanes) || lanes.length === 0 || lanes.length > LANES.length) fail('invalid-lanes')
  const seen = new Set()
  for (const entry of lanes) {
    const keys = plainObject(entry) ? Object.keys(entry).sort().join(',') : ''
    if (![
      'configurationEvidence,lane,logicalDatabaseScope,nextIdentity,oldIdentity,physicalPath',
      'configurationEvidence,lane,logicalDatabaseScope,nextIdentity,oldIdentity,physicalPath,previousHeadDigest',
    ].includes(keys) || !LANES.includes(entry.lane) || seen.has(entry.lane)) fail('invalid-lanes')
    seen.add(entry.lane)
    const path = entry.physicalPath
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path.includes('\0')
      || path.normalize('NFC') !== path || !path.endsWith(`.${entry.lane}`)) fail('invalid-lane-path')
    if (!plainObject(entry.oldIdentity) || !plainObject(entry.nextIdentity)) fail('invalid-lane-identity')
  }
}

function privateFile(path) {
  const stat = fs.lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o077
    || stat.uid !== process.getuid() || fs.realpathSync(path) !== path) fail('review-lane-unsafe')
}
const exists = path => { try { fs.lstatSync(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }

/** Read-only raw view. Without sidecars the copy is opened immutable so no -wal/-shm is
 * created; with sidecars a plain read-only connection sees committed WAL frames. */
function inspectLane(path, transactionId) {
  try { privateFile(path) } catch (error) { if (own(error)) throw error; fail('review-lane-missing', error) }
  for (const suffix of ['-wal', '-shm']) if (exists(path + suffix)) privateFile(path + suffix)
  if (exists(`${path}-journal`)) fail('review-lane-unsafe')
  const sidecars = exists(`${path}-wal`) || exists(`${path}-shm`)
  let db
  try {
    db = sidecars ? new DatabaseSync(path, { readOnly: true })
      : new DatabaseSync(`${pathToFileURL(path).href}?mode=ro&immutable=1`, { readOnly: true })
    const check = db.prepare('PRAGMA quick_check').all()
    if (check.length !== 1 || check[0].quick_check !== 'ok') fail('review-lane-corrupt')
    const grants = db.prepare(`SELECT typeof(authority) AS ta, authority, typeof(digest) AS td, digest,
      typeof(maximum) AS tm, maximum, typeof(used) AS tu, used FROM grants ORDER BY authority COLLATE BINARY`).all()
    const verifications = db.prepare('SELECT COUNT(*) AS n FROM verifications').get().n
    // Raw stored bytes of every verification row; NULL and empty are kept distinct.
    const rows = createHash('sha256')
    for (const row of db.prepare(`SELECT CAST(plan AS BLOB) AS plan, CAST(binding AS BLOB) AS binding,
      CAST(authority AS BLOB) AS authority, CAST(state AS BLOB) AS state, CAST(data AS BLOB) AS data
      FROM verifications ORDER BY plan COLLATE BINARY`).iterate()) {
      for (const column of ['plan', 'binding', 'authority', 'state', 'data']) {
        const value = row[column]
        if (value === null) rows.update('N')
        else if (value instanceof Uint8Array) rows.update(`B${value.length}:`).update(value)
        else fail('review-lane-corrupt')
      }
    }
    const rowsDigest = rows.digest('hex')
    const audit = db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get(AUDIT)
    const prior = audit ? db.prepare(`SELECT typeof(proof) AS t, proof FROM ${AUDIT} WHERE transaction_id=?`).get(transactionId) : undefined
    const audits = audit ? db.prepare(`SELECT COUNT(*) AS n FROM ${AUDIT}`).get().n : 0
    if (prior && prior.t !== 'text') fail('review-lane-corrupt')
    return { grants, verifications, rowsDigest, audits, priorProof: prior?.proof }
  } catch (error) { if (own(error)) throw error; fail('review-lane-corrupt', error) } finally { db?.close() }
}

function grantRange(grants) {
  for (const row of grants) {
    if (row.ta !== 'text' || !ID.test(row.authority) || row.td !== 'text' || !SHA.test(row.digest)) fail('review-lane-corrupt')
    if (row.tm !== 'integer' || row.tu !== 'integer' || !Number.isSafeInteger(row.maximum) || !Number.isSafeInteger(row.used)
      // Same bounds as CreationReviewStore's snapshot: a grant row exists only after a claim.
      || row.maximum < 1 || row.maximum > 1000 || row.used < 1 || row.used > row.maximum) fail('review-grant-range-invalid')
  }
  return grants.map(row => ({ authority: row.authority, maximum: row.maximum, used: row.used }))
}

function scopeFor(entry, { transactionId, installationId, profileId }) {
  return { transactionId, installationId, profileId, lane: entry.lane, logicalDatabaseScope: entry.logicalDatabaseScope,
    oldIdentity: entry.oldIdentity, newIdentity: entry.nextIdentity, configurationEvidence: entry.configurationEvidence,
    previousHeadDigest: entry.previousHeadDigest ?? null }
}

/** Read-only refusal checks for one lane; never writes. Every lane is preflighted before any lane
 * (or the caller's verifier grant migration) writes to the stage. */
function preflightLane(entry, context) {
  const before = inspectLane(entry.physicalPath, context.transactionId)
  const grants = grantRange(before.grants)
  if (grants.length === 0) {
    if (before.verifications !== 0 || before.audits !== 0) fail('review-history-invalid')
    return { entry, before, grants, empty: true }
  }
  const oldAuthority = entry.oldIdentity.authority?.authorityId
  if (grants.length !== 1 || grants[0].authority !== oldAuthority) fail('review-grant-authority-mismatch')
  // The v2 scope only tolerates an authorityDigest change; the backend-neutral runner bounds are
  // projected from two different runners, so a change is refused explicitly instead of by the store.
  if (!same(entry.oldIdentity.runner, entry.nextIdentity.runner)) fail('review-runner-projection-changed')
  // A handoff recorded by another transaction would need its head as previousHeadDigest, which
  // no signed record carries yet; only this transaction's own retry may find an audit row.
  if (before.audits !== (before.priorProof === undefined ? 0 : 1) || entry.previousHeadDigest !== undefined
    && entry.previousHeadDigest !== null) fail('review-lineage-chain-unsupported')
  if (!Number.isSafeInteger(entry.nextIdentity.authority?.expiresAt) || entry.nextIdentity.authority.expiresAt <= context.now) fail('review-identity-expired')
  return { entry, before, grants, empty: false }
}

function stageLane({ entry, before, grants, empty }, context, api) {
  if (empty) return { lane: entry.lane, status: 'empty', headDigest: null, grants: [] }
  const scope = scopeFor(entry, context)
  let proof
  try {
    const store = api.verifier.CreationReviewStore.openExistingForMaintenance(entry.physicalPath)
    try {
      if (before.priorProof !== undefined) {
        // Retry: the grant already carries the new digest, so a fresh plan cannot exist.
        // Re-apply the recorded plan; the store returns the stored proof or fails on drift.
        let prior
        try { prior = JSON.parse(before.priorProof) } catch { fail('review-handoff-retry-conflict') }
        if (!plainObject(prior?.plan) || !same(prior.plan.scope, scope)) fail('review-handoff-retry-conflict')
        proof = store.applyGrantHandoffV2(prior.plan)
      } else proof = store.applyGrantHandoffV2(store.planGrantHandoffV2(scope))
    } finally { store.close() }
  } catch (error) { if (own(error)) throw error; fail('review-handoff-rejected', error) }
  const after = inspectLane(entry.physicalPath, context.transactionId)
  const kept = grantRange(after.grants)
  let stored
  try { stored = JSON.parse(after.priorProof) } catch { fail('review-handoff-unrecorded') }
  if (!same(kept, grants) || after.grants[0].digest !== entry.nextIdentity.authority.authorityDigest) fail('review-grant-changed')
  // The handoff must leave every verification row byte-identical, not just the row count.
  if (after.verifications !== before.verifications || after.rowsDigest !== before.rowsDigest) fail('review-lane-changed')
  if (!same(stored, JSON.parse(JSON.stringify(proof)))) fail('review-handoff-unrecorded')
  return { lane: entry.lane, status: 'handed-off', headDigest: api.verifier.lineageHash(proof), grants }
}

/** Stage dsh-review-grant-handoff/v2 on every non-empty staged review lane. Retry with the
 * same transaction and identities returns the identical result and adds no audit row. */
export async function stageOwnerReviewGrantHandoffs({ lanes, api, transactionId, installationId, profileId, now }) {
  assertOwnerReviewGrantHandoffApi(api)
  for (const value of [transactionId, installationId, profileId]) if (typeof value !== 'string' || !ID.test(value)) fail('invalid-scope')
  if (!Number.isSafeInteger(now) || now < 1) fail('invalid-scope')
  checkLanes(lanes)
  const context = { transactionId, installationId, profileId, now }
  const checked = lanes.map(entry => preflightLane(entry, context))
  const body = { protocol, transactionId, lanes: checked.map(item => stageLane(item, context, api)) }
  return { ...body, digest: digest(body) }
}

/** Run every read-only refusal check over all lanes without writing; callers use it before any
 * other stage mutation that must agree with the review handoff. Returns the lanes' statuses. */
export function preflightOwnerReviewGrantHandoffs({ lanes, api, transactionId, now }) {
  assertOwnerReviewGrantHandoffApi(api)
  if (typeof transactionId !== 'string' || !ID.test(transactionId) || !Number.isSafeInteger(now) || now < 1) fail('invalid-scope')
  checkLanes(lanes)
  return lanes.map(entry => ({ lane: entry.lane, status: preflightLane(entry, { transactionId, now }).empty ? 'empty' : 'sealable' }))
}

/** Re-read each staged lane and prove it still matches the staged result. */
export async function verifyOwnerReviewGrantHandoffs({ result, lanes, api }) {
  assertOwnerReviewGrantHandoffApi(api)
  checkLanes(lanes)
  if (!plainObject(result) || Object.keys(result).sort().join(',') !== 'digest,lanes,protocol,transactionId'
    || result.protocol !== protocol || typeof result.transactionId !== 'string' || !ID.test(result.transactionId)
    || !Array.isArray(result.lanes) || result.lanes.length !== lanes.length) fail('invalid-result')
  const { digest: claimed, ...body } = result
  if (typeof claimed !== 'string' || !SHA.test(claimed) || digest(body) !== claimed) fail('review-handoff-digest-mismatch')
  lanes.forEach((entry, index) => {
    const staged = result.lanes[index]
    if (!plainObject(staged) || staged.lane !== entry.lane || !Array.isArray(staged.grants)) fail('invalid-result')
    const now = inspectLane(entry.physicalPath, result.transactionId), grants = grantRange(now.grants)
    if (staged.status === 'empty') {
      if (staged.headDigest !== null || staged.grants.length || grants.length || now.verifications || now.audits) fail('review-lane-changed')
      return
    }
    if (staged.status !== 'handed-off' || typeof staged.headDigest !== 'string' || !SHA.test(staged.headDigest)) fail('invalid-result')
    if (!same(grants, staged.grants) || grants.length !== 1 || now.grants[0].digest !== entry.nextIdentity.authority?.authorityDigest
      || now.verifications !== grants[0].used) fail('review-grant-changed')
    let proof
    try { proof = JSON.parse(now.priorProof) } catch { fail('review-handoff-unrecorded') }
    if (api.verifier.lineageHash(proof) !== staged.headDigest
      || !same(proof?.plan?.scope?.oldIdentity, entry.oldIdentity) || !same(proof?.plan?.scope?.newIdentity, entry.nextIdentity)
      || proof.plan.scope.lane !== entry.lane || proof.plan.scope.transactionId !== result.transactionId) fail('review-head-mismatch')
  })
  return { protocol, transactionId: result.transactionId, digest: claimed }
}
