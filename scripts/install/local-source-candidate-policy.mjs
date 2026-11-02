import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_LOCK_BYTES = 32 * 1024 * 1024
const MAX_MARKER_BYTES = 1024 * 1024
const MAX_EVENTS = 50000
const MAX_CANDIDATES = 1000000
const MAX_ELAPSED_MS = 24 * 60 * 60 * 1000
const DEPENDENCIES = ['dependencies', 'devDependencies', 'optionalDependencies']
function fail(reason) { throw new Error(`local source candidate policy: ${reason}`) }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype }
function text(value, maximum, label) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum || value.includes('\0')) fail(`invalid ${label}`)
  return value
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function canonical(value, depth = 0, budget = { remaining: 100000 }) {
  if (--budget.remaining < 0 || depth > 64) fail('policy structure exceeds bounds')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(entry => canonical(entry, depth + 1, budget)).join(',')}]`
  if (!object(value)) fail('policy must contain only JSON values')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1, budget)}`).join(',')}}`
}
function freeze(value) {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
function exclusions(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 10000 || value.some(entry => typeof entry !== 'string' || entry.length === 0 || entry.length > 4096)) fail('invalid verifier exclusions')
  return [...new Set(value)].sort()
}
function currentMarkerPolicy(policy) {
  if (!object(policy) || policy.ignoreScripts !== true || policy.ignorePnpmfile !== true || policy.trustLockfile !== false) fail('unsafe effective policy')
  const age = policy.minimumReleaseAge ?? 0, trust = policy.trustPolicy ?? null, ignoreAfter = policy.trustPolicyIgnoreAfter ?? null
  if (!Number.isFinite(age) || age < 0 || trust !== null && trust !== 'no-downgrade'
    || ignoreAfter !== null && (!Number.isFinite(ignoreAfter) || ignoreAfter < 0)) fail('invalid verifier policy')
  return { tarballUrlBinding: true, minimumReleaseAge: age, minimumReleaseAgeExclude: exclusions(policy.minimumReleaseAgeExclude), trustPolicy: trust,
    trustPolicyExclude: exclusions(policy.trustPolicyExclude), trustPolicyIgnoreAfter: ignoreAfter, resolutionShapeCheck: true, dependencyAliasCheck: true }
}
function finalStat(stats, size) {
  if (!Array.isArray(stats) || stats.length < 1 || stats.length > 32) fail('missing final lockfile stat')
  for (const stat of stats) {
    if (!object(stat) || !Number.isSafeInteger(stat.size) || stat.size < 0 || typeof stat.inode !== 'string' || !/^[0-9]{1,30}$/u.test(stat.inode)
      || typeof stat.mtimeNs !== 'string' || !/^[0-9]{1,30}$/u.test(stat.mtimeNs)) fail('invalid lockfile stat')
  }
  const final = stats.at(-1)
  if (final.size !== size) fail('final stat does not bind raw size')
  return { size: final.size, inode: final.inode, mtimeNs: final.mtimeNs }
}
function parseLines(source, maximum, label) {
  text(source, maximum, label)
  const lines = source.split('\n').filter(line => line.trim() !== '')
  if (lines.length > MAX_EVENTS) fail(`${label} exceeds event bound`)
  return lines.map(line => {
    let event
    try { event = JSON.parse(line) } catch { fail(`invalid ${label} NDJSON`) }
    if (!object(event)) fail(`invalid ${label} event`)
    return event
  })
}
function lockGraph(source, parseYaml) {
  if (typeof parseYaml !== 'function') fail('missing YAML parser')
  let lock
  try { lock = parseYaml(source) } catch { fail('invalid lockfile YAML') }
  if (!object(lock) || !['9', '9.0'].includes(String(lock.lockfileVersion))) fail('unsupported raw lockfile schema')
  for (const field of ['packages', 'snapshots']) if (lock[field] !== undefined && !object(lock[field])) fail(`invalid raw ${field}`)
  if (!object(lock.importers) || Object.keys(lock.importers).length === 0) fail('missing raw importers')
  for (const importer of Object.values(lock.importers)) if (!object(importer)) fail('invalid raw importer')
  return lock
}
function assertEmptyGraph(lock) {
  if (Object.keys(lock.packages ?? {}).length || Object.keys(lock.snapshots ?? {}).length) fail('no fresh events for a nonempty raw graph')
  // No manifest identity input exists here. Even link:/workspace: edges are deliberately unsupported.
  for (const [name, importer] of Object.entries(lock.importers)) {
    if (!(name === '.' || /^(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+$/u.test(name) && !name.split('/').some(part => part === '.' || part === '..'))) fail('unsafe empty-graph importer path')
    if (Object.keys(importer).some(key => !DEPENDENCIES.includes(key))) fail('unknown empty-graph importer field')
    for (const group of DEPENDENCIES) {
      if (importer[group] !== undefined && (!object(importer[group]) || Object.keys(importer[group]).length)) fail('empty-graph proof does not support dependency edges, including link/workspace')
    }
  }
  const allowed = new Set(['lockfileVersion', 'settings', 'importers', 'packages', 'snapshots'])
  if (Object.keys(lock).some(key => !allowed.has(key))) fail('unknown empty-graph lockfile field')
  if (lock.settings !== undefined && !object(lock.settings)) fail('invalid raw settings')
}
function markerIdentity(source, path, stat, policy, required) {
  if (source === undefined) { if (required) fail('fresh verification is missing its marker'); return null }
  const records = parseLines(source, MAX_MARKER_BYTES, 'marker')
  if (!records.length) fail('empty marker')
  let matched = false, hash
  for (const record of records) {
    const lock = record.lockfile
    if (!object(lock) || lock.path !== path || typeof lock.hash !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(lock.hash)
      || Buffer.from(lock.hash, 'base64').toString('base64') !== lock.hash || canonical(record.policy) !== canonical(policy)) fail('marker path, semantic hash or current policy mismatch')
    if (hash !== undefined && hash !== lock.hash) fail('marker contains conflicting semantic identities')
    hash = lock.hash
    if (lock.size === stat.size && lock.inode === stat.inode && lock.mtimeNs === stat.mtimeNs) matched = true
  }
  if (!matched) fail('marker does not bind final lockfile stat')
  return hash
}
/** Pure judgment only. Caller must pin pnpm/runtime, create an empty verification cache,
 * attribute all output/marker to that one process, and fence raw bytes/filesystem identity
 * before and after it. The semantic hash below is observed pnpm identity, NOT recomputed. */
export function verifyLocalSourceCandidatePolicy({ output, lockfileSource, markerSource, lockfilePath, lockStats, effectivePolicy, parseYaml,
  exitCode, outputTruncated, pnpmVersion, verifierConfigured }) {
  if (exitCode !== 0 || outputTruncated !== false || pnpmVersion !== '11.7.0' || verifierConfigured !== true) fail('requires successful untruncated pinned pnpm with a configured verifier')
  text(lockfileSource, MAX_LOCK_BYTES, 'lockfile source')
  if (typeof lockfilePath !== 'string' || !isAbsolute(lockfilePath) || normalize(lockfilePath) !== lockfilePath || ['\0', '\r', '\n'].some(character => lockfilePath.includes(character))) fail('invalid final lockfile path')
  const policyJson = canonical(effectivePolicy), policy = JSON.parse(policyJson), markerPolicy = currentMarkerPolicy(policy)
  const stat = finalStat(lockStats, Buffer.byteLength(lockfileSource)), graph = lockGraph(lockfileSource, parseYaml)
  const events = parseLines(output, MAX_OUTPUT_BYTES, 'output')
  const verification = events.filter(event => event.name === 'pnpm:lockfile-verification')
  if (events.some(event => event.level === 'error')) fail('pnpm emitted an error event')
  let applicability, entries = 0, elapsedMs = null
  if (verification.length === 0) { assertEmptyGraph(graph); applicability = 'empty-graph' }
  else {
    if (verification.length !== 2) fail('requires exactly one fresh started/done pair')
    const [started, done] = verification
    if (started.status !== 'started' || done.status !== 'done' || started.lockfilePath !== lockfilePath || done.lockfilePath !== lockfilePath) fail('not a fresh same-path started/done verification')
    if (!Number.isSafeInteger(started.entries) || started.entries < 1 || started.entries > MAX_CANDIDATES || done.entries !== started.entries
      || !Number.isFinite(done.elapsedMs) || done.elapsedMs < 0 || done.elapsedMs > MAX_ELAPSED_MS) fail('invalid verification counts or elapsed time')
    if (!Object.keys(graph.snapshots ?? {}).length) fail('candidate events contradict an empty raw snapshot graph')
    applicability = 'fresh-candidates'; entries = started.entries; elapsedMs = done.elapsedMs
  }
  const observedSemanticHash = markerIdentity(markerSource, lockfilePath, stat, markerPolicy, applicability === 'fresh-candidates')
  return freeze({ version: 1, pnpmVersion, applicability,
    lockfile: { path: lockfilePath, rawSha256: sha256(lockfileSource), size: stat.size, stat, observedSemanticHash },
    effectivePolicy: policy, effectivePolicySha256: sha256(policyJson), markerPolicy: observedSemanticHash === null ? null : markerPolicy,
    verification: { candidateEntries: entries, eventCount: verification.length, elapsedMs, scope: applicability === 'fresh-candidates' ? 'pnpm-verifier-fanout' : 'no-dependencies' } })
}
