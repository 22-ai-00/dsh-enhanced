/** Fixed-purpose, read-only empty-history gate. Caller authenticates ownerUpdate
 * and the actual Docker→Linux edge; this helper neither authorizes nor migrates. */
import fs, { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const SHA = /^[a-f0-9]{64}$/u
const ADOPTION_SCHEMA = 'f91ee0ecdbb43d7a4305075d70f13bfa492f7d46c1ff3d3f59e1ca1a155f23a8'
const MAX_MAIN = 268435456, MAX_SIDECAR = 67108864
const hash = value => createHash('sha256').update(value).digest('hex')
function fail(code) { const error = new Error(`owner empty creation history: ${code}`); error.code = code; throw error }
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !d.enumerable || !('value' in d))) fail('invalid-config-data')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}
const equal = (left, right) => left === undefined || right === undefined ? left === right : canonical(left) === canonical(right)
function absolute(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path === '/' || /[\p{Cc}]/u.test(path) || path.normalize('NFC') !== path) fail('invalid-path')
  return path
}
function inside(root, path) { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) }
function physical(home, target, path) { absolute(path); if (!inside(home, path)) fail('path-outside-home'); return join(target, relative(home, path)) }
function statKey(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].map(String).join(':') }
function identity(stat, sha256) { return { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), sha256 } }
function safeStat(stat, kind) {
  if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())
    || stat.uid !== BigInt(process.getuid()) || stat.mode & 0o077n) fail('unsafe-source-path')
}
function optionalStat(path) { try { return fs.lstatSync(path, { bigint: true }) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
function bytes(fd, size) {
  if (size > MAX_MAIN) fail('database-too-large')
  const result = Buffer.alloc(Number(size)); let offset = 0
  while (offset < result.length) { const n = fs.readSync(fd, result, offset, Math.min(1048576, result.length - offset), offset); if (!n) fail('source-short-read'); offset += n }
  return result
}
function pinFile(path, bound, expected) {
  const named = optionalStat(path)
  if (expected !== undefined && (expected === null ? named !== null : named === null || statKey(named) !== statKey(expected))) fail('source-file-race')
  if (!named) return null
  safeStat(named, 'file'); if (named.size > BigInt(bound)) fail('database-too-large')
  const fd = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (constants.O_NOATIME ?? 0))
  try {
    const stat = fs.fstatSync(fd, { bigint: true }); if (statKey(stat) !== statKey(named)) fail('source-file-race')
    const data = bytes(fd, stat.size), digest = hash(data)
    if (statKey(fs.fstatSync(fd, { bigint: true })) !== statKey(stat)) fail('source-file-race')
    return { path, fd, stat, data, digest }
  } catch (error) { fs.closeSync(fd); throw error }
}
function unchanged(file) {
  const named = optionalStat(file.path)
  if (!named || statKey(named) !== statKey(file.stat) || statKey(fs.fstatSync(file.fd, { bigint: true })) !== statKey(file.stat)
    || hash(bytes(file.fd, file.stat.size)) !== file.digest) fail('source-file-race')
}
function pinParentChain(root, path) {
  const pins = []; let cursor = root
  try {
    for (const part of ['', ...relative(root, dirname(path)).split(sep).filter(Boolean)]) {
      if (part) cursor = join(cursor, part)
      const named = fs.lstatSync(cursor, { bigint: true }); safeStat(named, 'directory')
      if (fs.realpathSync(cursor) !== cursor) fail('unsafe-source-parent')
      const fd = fs.openSync(cursor, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      if (statKey(fs.fstatSync(fd, { bigint: true })) !== statKey(named)) { fs.closeSync(fd); fail('source-parent-race') }
      pins.push({ path: cursor, fd, stat: named })
    }
    return pins
  } catch (error) { for (const pin of pins) fs.closeSync(pin.fd); throw error }
}
function sameParents(pins) {
  for (const pin of pins) if (statKey(fs.lstatSync(pin.path, { bigint: true })) !== statKey(pin.stat)
    || statKey(fs.fstatSync(pin.fd, { bigint: true })) !== statKey(pin.stat) || fs.realpathSync(pin.path) !== pin.path) fail('source-parent-race')
}
function textRows(db, table, columns, order = '') {
  return db.prepare(`SELECT ${columns.map(column => `CAST(${column} AS BLOB) AS ${column}`).join(',')} FROM ${table} ${order}`).all().map(row => Object.fromEntries(columns.map(column => {
    const raw = row[column]
    if (raw === null && table === 'sqlite_schema' && column === 'sql') return [column, null]
    if (!(raw instanceof Uint8Array) || raw.includes(0)) fail('invalid-sqlite-text')
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { fail('invalid-sqlite-text') }
    if (!Buffer.from(text).equals(Buffer.from(raw))) fail('invalid-sqlite-text')
    return [column, text]
  })))
}
function inspectSchema(db, kind) {
  const app = db.prepare('PRAGMA application_id').get().application_id, version = db.prepare('PRAGMA user_version').get().user_version
  if (db.prepare('PRAGMA quick_check').all().map(row => row.quick_check).join() !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('database-corrupt')
  const objects = textRows(db, 'sqlite_schema', ['type', 'name', 'tbl_name', 'sql'], 'ORDER BY type,name')
  if (kind === 'adoption') {
    if (app !== 0x44534341 || version !== 3 || hash(JSON.stringify(objects)) !== ADOPTION_SCHEMA) fail('adoption-schema-unsupported')
  } else {
    if (app !== 0 || version !== 0) fail('review-schema-unsupported')
    const expected = new DatabaseSync(':memory:')
    try {
      expected.exec('CREATE TABLE grants(authority TEXT PRIMARY KEY,digest TEXT NOT NULL,maximum INTEGER NOT NULL,used INTEGER NOT NULL); CREATE TABLE verifications(plan TEXT PRIMARY KEY,binding TEXT NOT NULL,authority TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);')
      const normalize = rows => rows.map(row => ({ ...row, sql: row.sql?.replace(/\s+/gu, '').toLowerCase() ?? null }))
      if (!equal(normalize(objects), normalize(textRows(expected, 'sqlite_schema', ['type', 'name', 'tbl_name', 'sql'], 'ORDER BY type,name')))) fail('review-schema-unsupported')
    } finally { expected.close() }
  }
  return { schemaVersion: version, schemaDigest: hash(JSON.stringify(objects)) }
}
function snapshot(path, root, inspect) {
  const pins = pinParentChain(root, path), held = [], sidecars = {}
  let temporary, tempPin, db, output, initialStats, initialSet
  const names = [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]
  const set = () => names.map(name => optionalStat(name) !== null)
  const verify = () => {
    if (initialSet && !equal(set(), initialSet)) fail('source-sidecar-race')
    for (const file of held) unchanged(file)
    sameParents(pins)
  }
  try {
    initialStats = names.map(optionalStat); initialSet = initialStats.map(stat => stat !== null)
    if (initialSet[3]) fail('rollback-journal-present')
    const source = pinFile(path, MAX_MAIN, initialStats[0])
    if (!source) { if (initialSet.slice(1).some(Boolean)) fail('orphan-sidecar'); fail('database-missing') }
    held.push(source)
    for (const [index, suffix] of ['wal', 'shm'].entries()) { const file = pinFile(`${path}-${suffix}`, MAX_SIDECAR, initialStats[index + 1]); sidecars[suffix] = file; if (file) held.push(file) }
    if (Boolean(sidecars.wal) !== Boolean(sidecars.shm)) fail('incomplete-sidecar-set')
    verify()
    temporary = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'owner-empty-history-'))
    fs.chmodSync(temporary, 0o700)
    const tempStat = fs.lstatSync(temporary, { bigint: true }); safeStat(tempStat, 'directory')
    tempPin = { path: temporary, stat: tempStat, fd: fs.openSync(temporary, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) }
    const checkTemp = () => {
      const named = fs.lstatSync(temporary, { bigint: true }), opened = fs.fstatSync(tempPin.fd, { bigint: true })
      if (named.dev !== tempStat.dev || named.ino !== tempStat.ino || opened.dev !== tempStat.dev || opened.ino !== tempStat.ino || named.mode !== tempStat.mode || named.uid !== tempStat.uid || fs.realpathSync(temporary) !== temporary) fail('copy-parent-race')
    }
    checkTemp()
    const copy = join(temporary, 'snapshot.sqlite'), copyPins = []
    for (const file of [source, sidecars.wal].filter(Boolean)) {
      const target = file === source ? copy : `${copy}-wal`
      const fd = fs.openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { fs.writeFileSync(fd, file.data); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      checkTemp()
      const stat = fs.lstatSync(target, { bigint: true }); safeStat(stat, 'file')
      if (hash(fs.readFileSync(target)) !== file.digest) fail('copy-content-race')
      copyPins.push({ path: target, stat, digest: file.digest })
    }
    verify()
    checkTemp()
    const verifyCopy = () => {
      checkTemp()
      for (const file of copyPins) if (statKey(fs.lstatSync(file.path, { bigint: true })) !== statKey(file.stat) || hash(fs.readFileSync(file.path)) !== file.digest) fail('copy-content-race')
    }
    verifyCopy()
    db = new DatabaseSync(copy, { readOnly: true })
    verifyCopy()
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0; BEGIN')
    output = inspect(db)
    verifyCopy()
    db.exec('ROLLBACK'); db.close(); db = undefined
    verify()
    const project = file => file ? identity(file.stat, file.digest) : null
    return { ...output, storageDigest: hash(canonical({ main: source.digest, wal: sidecars.wal?.digest ?? null })),
      file: project(source), sidecars: { wal: project(sidecars.wal), shm: project(sidecars.shm) } }
  } finally {
    if (db) db.close()
    try { verify() } finally {
      for (const file of held) fs.closeSync(file.fd)
      for (const pin of pins) fs.closeSync(pin.fd)
      if (tempPin) {
        const named = optionalStat(temporary), held = fs.fstatSync(tempPin.fd, { bigint: true })
        fs.closeSync(tempPin.fd)
        if (named && named.dev === held.dev && named.ino === held.ino) fs.rmSync(temporary, { recursive: true, force: true })
      }
    }
  }
}
function configRows(api, ownerUpdate) {
  const home = absolute(ownerUpdate.homePath), original = ownerUpdate.original, manifest = original.manifest
  const document = api.yaml.parseDocument(original.effective.targetEffective, { uniqueKeys: true })
  if (document.errors.length || !api.yaml.isSeq(document.contents)) fail('effective-config-invalid')
  const row = id => {
    const found = document.contents.items.filter(item => api.yaml.isMap(item) && item.get('id') === id)
    if (found.length !== 1 || found[0].get('disabled') === true || !api.yaml.isMap(found[0].get('config', true))) fail('effective-config-row-invalid')
    return found[0].get('config', true)
  }
  const verifier = row('dsh-enhanced-assistant-verifier'); row('dsh-enhanced-plugin-control-plane')
  const decoded = document.toJS({ maxAliasCount: 64 })
  for (const id of ['dsh-enhanced-assistant-verifier', 'dsh-enhanced-plugin-control-plane']) if (decoded.filter(item => item?.id === id).length !== 1) fail('effective-config-row-invalid')
  const verifierConfig = decoded.find(item => item.id === 'dsh-enhanced-assistant-verifier').config
  const controlConfig = decoded.find(item => item.id === 'dsh-enhanced-plugin-control-plane').config
  const config = key => verifierConfig[key]
  const lanes = [['creation-reviews', 'creationReviews', manifest.pluginCreation?.reviews],
    ['revision-reviews', 'revisionReviews', manifest.pluginRevision?.reviews], ['revision-regressions', 'revisionRegressions', manifest.pluginRevision?.regressions]]
  if (!equal(config('sourceReviews'), manifest.sourceReviews) || lanes.some(([, key, expected]) => !equal(config(key), expected))) fail('review-config-mismatch')
  const db = verifier.get('databasePath', true)
  if (!api.yaml.isScalar(db) || typeof db.value !== 'string') fail('database-path-invalid')
  let base = db.value
  if (db.tag === 'tag:yaml.org,2002:js') {
    const match = /^dshHomePath\((['"])([A-Za-z0-9._/-]+)\1\)$/u.exec(base), rel = match?.[2]
    if (!rel || rel.split('/').some(part => !part || part === '.' || part === '..')) fail('database-expression-unsupported')
    base = join(home, rel)
  } else if (db.tag && db.tag !== 'tag:yaml.org,2002:str') fail('database-expression-unsupported')
  absolute(base); if (!inside(home, base)) fail('path-outside-home')
  const statePath = manifest.controlPlane?.statePath, capabilities = manifest.pluginCreation?.capabilities
  if (!capabilities || statePath !== join(original.resources.stateRoot, 'control-plane') || !inside(home, absolute(statePath))
    || controlConfig.statePath !== statePath || !equal(controlConfig.creationCapabilities, capabilities)
    || !equal(manifest.controlPlane.creationCapabilities, capabilities)) fail('adoption-config-mismatch')
  return { home, base, lanes, logicalPath: join(statePath, 'creation-adoptions.sqlite'), capabilities }
}
export async function inspectOwnerEmptyCreationHistory({ ownerUpdate, physicalHome = ownerUpdate.homePath, api }) {
  return inspectHistory({ ownerUpdate, physicalHome, api, classify: false })
}

const REVIEW_STATES = ['discover-claimed', 'contract-claimed', 'contract-ready', 'case-claimed', 'cases-ready',
  'review-claimed', 'certificate', 'rejected', 'unknown']
const ADOPTION_STATUSES = ['claimed', 'authorized', 'active', 'closed', 'unknown', 'rejected']
const CALL_STATUSES = ['claimed', 'completed', 'unknown']
/** Fail-closed status histogram: every stored value must be TEXT, valid UTF-8 without NUL,
 * in `allowed`, and appear in exactly one group; the groups must add up to `total`. */
function grouped(db, table, column, allowed, code, total) {
  const rows = db.prepare(`SELECT typeof(${column}) AS t, CAST(${column} AS BLOB) AS value, COUNT(*) AS n
    FROM ${table} GROUP BY typeof(${column}), CAST(${column} AS BLOB) ORDER BY 1, 2`).all()
  const result = Object.fromEntries(allowed.map(value => [value, 0])), seen = new Set()
  let sum = 0
  for (const row of rows) {
    if (row.t !== 'text' || !(row.value instanceof Uint8Array) || row.value.includes(0)) fail(code)
    let value
    try { value = new TextDecoder('utf-8', { fatal: true }).decode(row.value) } catch { fail(code) }
    if (!allowed.includes(value) || !Buffer.from(value).equals(Buffer.from(row.value)) || seen.has(value)) fail(code)
    seen.add(value); result[value] = row.n; sum += row.n
  }
  if (sum !== total) fail(code)
  return result
}
// Every CHECK constraint of the journal tables (creation-capability-journal.ts), single-column and
// cross-column, re-evaluated explicitly. The private copy is opened read-only and SQLite's
// quick_check does not verify CHECK constraints there, so a forged or corrupted row would
// otherwise be archived and counted. NULL results count as invalid.
const json = (column, max) => `(${column} IS NULL OR (json_valid(${column}) AND length(${column})<=${max}))`
const ADOPTION_VALID = `json_valid(certificate_json) AND length(certificate_json)<=65536 AND length(certificate_digest)=64
  AND length(artifact)>0 AND length(artifact)<=524288 AND length(artifact_sha)=64
  AND ${json('tools_json', 65536)} AND ${json('receipt_json', 65536)} AND (reason IS NULL OR (length(reason)>0 AND length(reason)<=64))
  AND ((status='claimed' AND tools_json IS NULL AND tools_digest IS NULL AND receipt_json IS NULL AND reason IS NULL)
    OR (status IN ('authorized','active') AND tools_json IS NOT NULL AND tools_digest IS NOT NULL AND receipt_json IS NOT NULL AND reason IS NULL)
    OR (status IN ('closed','unknown','rejected') AND reason IS NOT NULL))`
const CALL_VALID = `length(arguments_digest)=64 AND ${json('result_json', 65536)} AND ${json('foreground_json', 4096)}
  AND ((status='claimed' AND result_json IS NULL AND job_id IS NULL) OR status IN ('completed','unknown'))`
const SOURCE_ARCHIVE_VALID = 'json_valid(archive_json) AND length(archive_json)<=2097152'
function invariant(db, table, valid, code) {
  if (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE NOT COALESCE((${valid}), 0)`).get().n !== 0) fail(code)
}

/** Read-only classification for the sealed-history Docker→linux-native handoff.
 * `empty` keeps the existing empty protocol; `sealable` only reports what a later
 * stopped-Host seal would archive. It authorizes, settles and migrates nothing. */
export async function inspectOwnerCreationHistory({ ownerUpdate, physicalHome = ownerUpdate.homePath, api }) {
  return inspectHistory({ ownerUpdate, physicalHome, api, classify: true })
}

async function inspectHistory({ ownerUpdate, physicalHome, api, classify }) {
  const { home, base, lanes, logicalPath, capabilities } = configRows(api, ownerUpdate)
  absolute(physicalHome); if (fs.realpathSync(physicalHome) !== physicalHome) fail('unsafe-physical-home')
  const control = api.control
  if (typeof control?.creationCapabilityAuthorityDigest !== 'function' || typeof control?.creationCapabilityPublicKey !== 'function') fail('old-control-api-unavailable')
  // Actual original validator/key reader; no constructor, migration or checkpoint.
  const authorityDigest = control.creationCapabilityAuthorityDigest({ path: logicalPath, config: capabilities })
  const publicKey = control.creationCapabilityPublicKey(capabilities)
  if (!SHA.test(authorityDigest) || typeof publicKey !== 'string') fail('old-authority-invalid')
  const reviews = lanes.map(([lane, , expected]) => {
    if (expected === undefined) return { lane, status: 'disabled' }
    const logical = `${base}.${lane}`, path = physical(home, physicalHome, logical)
    try {
      const result = snapshot(path, physicalHome, db => {
        const schema = inspectSchema(db, 'review'), counts = { grants: db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, verifications: db.prepare('SELECT COUNT(*) AS n FROM verifications').get().n }
        if (!classify) {
          if (counts.grants !== 0 || counts.verifications !== 0) fail('review-history-present')
          return { ...schema, counts }
        }
        // Review history is carried in place by the existing grant handoff v2 (used/maximum kept),
        // so every state, including terminal unknown and crash-left in-progress rows, is reported.
        return { ...schema, counts, byState: grouped(db, 'verifications', 'state', REVIEW_STATES, 'review-state-invalid', counts.verifications) }
      })
      const status = result.counts.grants === 0 && result.counts.verifications === 0 ? 'empty' : 'sealable'
      return { lane, status, logicalPath: logical, physicalPath: path, ...result }
    } catch (error) { if (error.code === 'database-missing' || error.code === 'ENOENT') fail('review-database-missing'); throw error }
  })
  const adoptionPath = physical(home, physicalHome, logicalPath)
  let adoption
  try { adoption = snapshot(adoptionPath, physicalHome, db => {
    const schema = inspectSchema(db, 'adoption')
    const rows = textRows(db, 'authority', ['authority_id', 'authority_digest', 'key_id', 'public_key', 'config_json'])
    if (rows.length !== 1 || !equal(rows[0], { authority_id: capabilities.authorityId, authority_digest: authorityDigest,
      key_id: capabilities.keyId, public_key: publicKey, config_json: canonical(capabilities) })) fail('adoption-authority-mismatch')
    const counts = { authority: 1, adoptions: db.prepare('SELECT COUNT(*) AS n FROM adoptions').get().n,
      calls: db.prepare('SELECT COUNT(*) AS n FROM calls').get().n, sourceArchives: db.prepare('SELECT COUNT(*) AS n FROM source_archives').get().n }
    if (!classify) {
      if (Object.entries(counts).some(([key, value]) => key !== 'authority' && value !== 0)) fail('adoption-history-present')
      return { ...schema, counts, authorityDigest }
    }
    // Every status is sealable: claimed/authorized/unknown are archived as "never eligible",
    // never replayed, and still counted against the inherited adoption and call budget.
    const byStatus = grouped(db, 'adoptions', 'status', ADOPTION_STATUSES, 'adoption-status-invalid', counts.adoptions)
    const callsByStatus = grouped(db, 'calls', 'status', CALL_STATUSES, 'call-status-invalid', counts.calls)
    invariant(db, 'adoptions', ADOPTION_VALID, 'adoption-row-invalid')
    invariant(db, 'calls', CALL_VALID, 'call-row-invalid')
    invariant(db, 'source_archives', SOURCE_ARCHIVE_VALID, 'source-archive-row-invalid')
    return { ...schema, counts, authorityDigest, byStatus, callsByStatus }
  })
  } catch (error) { if (error.code === 'database-missing' || error.code === 'ENOENT') fail('adoption-database-missing'); throw error }
  if (!classify) {
    const result = { protocol: 'dsh-owner-empty-creation-history/v1', status: 'empty', installationId: ownerUpdate.original.resources.installationId,
      profile: ownerUpdate.profile, logicalHome: home, physicalHome, reviews,
      adoption: { status: 'empty', logicalPath, physicalPath: adoptionPath, ...adoption } }
    return { ...result, digest: hash(canonical(result)) }
  }
  const adoptionStatus = adoption.counts.adoptions === 0 && adoption.counts.calls === 0 && adoption.counts.sourceArchives === 0
    ? 'empty' : 'sealable'
  const status = adoptionStatus === 'empty' && reviews.every(review => review.status !== 'sealable') ? 'empty' : 'sealable'
  const result = { protocol: 'dsh-owner-creation-history/v2', status, installationId: ownerUpdate.original.resources.installationId,
    profile: ownerUpdate.profile, logicalHome: home, physicalHome, reviews,
    adoption: { status: adoptionStatus, logicalPath, physicalPath: adoptionPath, ...adoption } }
  return { ...result, digest: hash(canonical(result)) }
}
