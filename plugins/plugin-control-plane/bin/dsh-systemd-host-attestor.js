#!/usr/bin/node
// Owner-operated supervisor boundary. This executable never runs in the Host Fiber.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { closeSync, constants as F, existsSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

export const SYSTEMD_HOST_ATTESTOR_VERSION = 'dsh-systemd-host-attestor-3'
const DIGEST = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const UNIT_PROPERTIES = ['FragmentPath', 'DropInPaths', 'ExecStart', 'Environment', 'WorkingDirectory', 'User', 'Group', 'Type', 'KillMode']
const STATUS_PROPERTIES = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlPID', 'InvocationID', 'NRestarts', 'ControlGroup']
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = value => hash(canonical(value))
const fail = message => { throw new Error(`systemd Host attestor: ${message}`) }
const within = (root, path) => path === root || path.startsWith(`${root}/`)
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail(`${label} fields are invalid`)
  return value
}
function text(value, label, pattern = /^[^\r\n]*$/u) {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 16384 || !pattern.test(value)) fail(`${label} is invalid`)
  return value
}
function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} is invalid`)
  return value
}
function canonicalPath(path, label) {
  text(path, label)
  if (!isAbsolute(path) || path === '/' || resolve(path) !== path || realpathSync(path) !== path) fail(`${label} is not canonical`)
  return path
}
function privateDirectory(path) {
  canonicalPath(path, 'private directory'); const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail('directory is not owner-private')
}
function syncDirectory(path) {
  const fd = openSync(path, F.O_RDONLY | F.O_DIRECTORY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function descriptorBytes(fd, maximum) {
  const before = fstatSync(fd, { bigint: true })
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum) || (before.mode & 0o022n) !== 0n
    || ![0n, BigInt(process.getuid())].includes(before.uid)) fail('unsafe file descriptor')
  const bytes = Buffer.alloc(Number(before.size)); let offset = 0
  while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) fail('short file read'); offset += count }
  const after = fstatSync(fd, { bigint: true })
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('file changed during read')
  return bytes
}
function readSafe(path, maximum = 65536, privateMode = false) {
  canonicalPath(path, 'file'); const before = lstatSync(path, { bigint: true })
  if (privateMode) {
    privateDirectory(dirname(path))
    if (before.uid !== BigInt(process.getuid()) || (before.mode & 0o077n) !== 0n) fail('file is not owner-private')
  }
  const fd = openSync(path, F.O_RDONLY | F.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd, { bigint: true }); const bytes = descriptorBytes(fd, maximum); const after = lstatSync(path, { bigint: true })
    if (before.dev !== opened.dev || before.ino !== opened.ino || after.dev !== opened.dev || after.ino !== opened.ino) fail('file pathname changed')
    return bytes
  } finally { closeSync(fd) }
}
function pin(spec, label, executable = false) {
  object(spec, ['path', 'sha256'], label); text(spec.sha256, `${label} digest`, DIGEST)
  if (hash(readSafe(spec.path, 268435456)) !== spec.sha256) fail(`${label} digest changed`)
  if (executable && (lstatSync(spec.path).mode & 0o111) === 0) fail(`${label} is not executable`)
  return spec
}
function runningHash(path) {
  const match = path.match(/^\/proc\/self\/fd\/(\d+)$/u)
  return hash(match ? descriptorBytes(Number(match[1]), 268435456) : readSafe(path, 268435456))
}
function parseJson(bytes, label) { try { return JSON.parse(bytes.toString('utf8')) } catch { fail(`${label} JSON is invalid`) } }

function loadConfig(environment, request) {
  const config = parseJson(readSafe(environment.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG, 65536, true), 'config')
  object(config, ['schemaVersion', 'authority', 'keyId', 'privateKeyPath', 'stateRoot', 'executable', 'interpreter', 'processHelper',
    'systemctl', 'scope', 'unit', 'unitProperties', 'profileFiles', 'authorization', 'timeoutMs', 'stableWindowMs', 'pollIntervalMs',
    ...(config.schemaVersion === 2 ? ['readiness'] : [])], 'config')
  if (![1, 2].includes(config.schemaVersion)) fail('config schema is unsupported')
  text(config.authority, 'authority', ID); text(config.keyId, 'keyId', ID)
  integer(config.timeoutMs, 'timeout', 1000, 60000); integer(config.stableWindowMs, 'stable window', 50, 10000)
  integer(config.pollIntervalMs, 'poll interval', 25, 1000)
  if (config.stableWindowMs + config.pollIntervalMs >= config.timeoutMs) fail('window exceeds deadline')
  if (!['user', 'system'].includes(config.scope)) fail('unsupported supervisor scope')
  const auth = object(config.authorization, ['installationId', 'ledger', 'profile', 'plan', 'activation', config.schemaVersion === 1 ? 'previousHostGeneration' : 'hostGeneration', 'requestDigest', 'notBefore', 'expiresAt'], 'authorization')
  text(auth.requestDigest, 'authorized request digest', DIGEST)
  if (digest(request) !== auth.requestDigest) fail('exact request is not authorized')
  object(auth.ledger, ['id', 'path'], 'ledger'); object(auth.profile, ['name', 'path'], 'profile')
  object(auth.plan, ['id', 'digest'], 'plan'); object(auth.activation, ['id', 'fence'], 'activation')
  text(auth.installationId, 'installation', /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
  for (const value of [auth.ledger.id, auth.plan.id, auth.activation.id]) text(value, 'identity', ID)
  text(auth.plan.digest, 'plan digest', DIGEST); text(auth.profile.name, 'profile name', /^[a-z0-9][a-z0-9-]{0,63}$/u)
  canonicalPath(auth.profile.path, 'profile'); canonicalPath(auth.ledger.path, 'ledger')
  if (basename(auth.profile.path) !== auth.profile.name || basename(dirname(auth.profile.path)) !== 'profiles') fail('profile path and name differ')
  integer(auth.activation.fence, 'fence', 1)
  integer(config.schemaVersion === 1 ? auth.previousHostGeneration : auth.hostGeneration, 'authorized generation', config.schemaVersion === 1 ? 0 : 1, Number.MAX_SAFE_INTEGER - 1)
  integer(auth.notBefore, 'authorization start'); integer(auth.expiresAt, 'authorization expiry', auth.notBefore + 1)
  if (config.unit !== `dsh-profile-${auth.profile.name}.service`) fail('unit does not bind the profile')
  object(config.unitProperties, UNIT_PROPERTIES, 'unit properties')
  for (const property of UNIT_PROPERTIES) text(config.unitProperties[property], property)
  if (!['simple', 'exec', 'notify'].includes(config.unitProperties.Type) || config.unitProperties.KillMode !== 'control-group') fail('unsupported unit lifecycle')
  if (!Array.isArray(config.profileFiles) || config.profileFiles.length < 3 || config.profileFiles.length > 32) fail('profile pins are invalid')
  const paths = config.profileFiles.map(spec => {
    pin(spec, 'profile file')
    if (!within(auth.profile.path, spec.path)) fail('profile pin is outside profile')
    return spec.path
  })
  if (new Set(paths).size !== paths.length || !['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].every(name => paths.includes(join(auth.profile.path, name)))) fail('profile manifest, lockfile and patch pins are required')
  privateDirectory(config.stateRoot)
  for (const path of [environment.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG, config.privateKeyPath, config.stateRoot]) {
    if (within(auth.profile.path, path)) fail('attestor authority must be outside the candidate profile')
  }
  const privateKey = createPrivateKey(readSafe(config.privateKeyPath, 16384, true))
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('signing key must be Ed25519')
  pin(config.executable, 'attestor executable', true); pin(config.interpreter, 'attestor interpreter', true); pin(config.processHelper, 'process helper')
  if (runningHash(process.argv[1]) !== config.executable.sha256 || runningHash(process.execPath) !== config.interpreter.sha256) fail('running attestor identity differs')
  object(config.systemctl, ['path', 'sha256', 'interpreter'], 'systemctl')
  pin({ path: config.systemctl.path, sha256: config.systemctl.sha256 }, 'systemctl', true)
  if (config.systemctl.interpreter !== null) pin(config.systemctl.interpreter, 'systemctl interpreter', true)
  object(request, ['schemaVersion', 'kind', 'operationId', 'requestedAt', 'receiptTtlMs', 'installationId', 'ledger', 'plan', 'activation', 'profile', 'issuer', 'phase', 'requirements'], 'request')
  if (request.schemaVersion !== 1 || request.kind !== 'dsh-host-attestation-request'
    || request.phase !== (config.schemaVersion === 1 ? 'reload' : 'readiness')) fail('phase does not match configured authority')
  if (config.schemaVersion === 1) {
    object(request.requirements, ['kind', 'previousHostGeneration'], 'requirements')
    if (request.requirements.kind !== 'reload' || request.requirements.previousHostGeneration !== auth.previousHostGeneration) fail('generation is not authorized')
  } else {
    object(request.requirements, ['kind', 'minimumChecks'], 'requirements')
    if (request.requirements.kind !== 'readiness') fail('readiness requirements required')
    integer(request.requirements.minimumChecks, 'minimum checks', 1, 256)
    const ready = object(config.readiness, ['client', 'observer', 'deploymentFiles', 'reloadOperationId'], 'readiness')
    text(ready.reloadOperationId, 'reload operation', ID); pin(ready.client, 'observer client')
    if (!Array.isArray(ready.deploymentFiles) || !ready.deploymentFiles.length || ready.deploymentFiles.length > 128) fail('deployment pins required')
    for (const spec of ready.deploymentFiles) pin(spec, 'deployment file')
    if (new Set(ready.deploymentFiles.map(spec => spec.path)).size !== ready.deploymentFiles.length) fail('duplicate deployment pin')
    if (ready.observer?.profilePath !== auth.profile.path) fail('observer profile differs')
  }
  text(request.operationId, 'operation', ID)
  if (request.operationId.length > 152) fail('operation is too long for receipt identity')
  integer(request.requestedAt, 'requestedAt'); integer(request.receiptTtlMs, 'receipt TTL', 1, 3600000)
  for (const field of ['installationId', 'ledger', 'profile', 'plan', 'activation']) if (canonical(request[field]) !== canonical(auth[field])) fail(`${field} is not authorized`)
  object(request.issuer, ['mode', 'id', 'version', 'path', 'sha256', 'interpreter', 'authority', 'keyId'], 'issuer')
  text(request.issuer.id, 'issuer ID', ID)
  if (request.issuer.mode !== 'configured-executable' || request.issuer.version !== SYSTEMD_HOST_ATTESTOR_VERSION
    || request.issuer.path !== config.executable.path || request.issuer.sha256 !== config.executable.sha256
    || canonical(request.issuer.interpreter) !== canonical(config.interpreter)
    || request.issuer.authority !== config.authority || request.issuer.keyId !== config.keyId) fail('issuer differs from owner configuration')
  assertCurrent(config, request)
  return { config, privateKey }
}
function assertCurrent(config, request) {
  const now = Date.now(); const auth = config.authorization
  if (request.requestedAt < auth.notBefore || request.requestedAt > now || now > auth.expiresAt) fail('authorization expired or not yet valid')
}
function assertProfile(config) {
  for (const spec of config.profileFiles) pin(spec, 'profile file')
  for (const spec of config.readiness?.deploymentFiles ?? []) pin(spec, 'deployment file')
}
function remaining(deadline) { const value = Math.floor(deadline - performance.now()); if (value <= 0) fail('observation deadline exceeded; outcome needs reconciliation'); return value }
function normalizeExecStart(value) {
  // systemctl appends per-invocation runtime fields after ignore_errors.
  const match = value.match(/^(\{ path=[^\r\n]* ; argv\[\]=[^\r\n]* ; ignore_errors=(?:yes|no)) ; (?:start_time=[^\r\n]* )?\}$/u)
  if (!match || value.split('{ path=').length !== 2) fail('unsupported ExecStart representation')
  return `${match[1]} ; }`
}
async function command(config, execute, args, deadline) {
  const specs = [{ path: config.systemctl.path, sha256: config.systemctl.sha256 }, ...(config.systemctl.interpreter ? [config.systemctl.interpreter] : [])]
  const descriptors = []
  try {
    for (const spec of specs) {
      pin(spec, 'systemctl command', true)
      const fd = openSync(spec.path, F.O_RDONLY | F.O_NOFOLLOW); descriptors.push(fd)
      if (hash(descriptorBytes(fd, 268435456)) !== spec.sha256) fail('command inode changed')
    }
    const env = { LANG: 'C', LC_ALL: 'C', SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0' }
    if (config.scope === 'user') {
      const runtime = `/run/user/${process.getuid()}`; privateDirectory(runtime)
      env.XDG_RUNTIME_DIR = runtime; env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtime}/bus`
    }
    const result = await execute({ command: descriptors.length === 2 ? '/proc/self/fd/4' : '/proc/self/fd/3',
      args: [...(descriptors.length === 2 ? ['/proc/self/fd/3'] : []), `--${config.scope}`, ...args], env,
      stdio: ['pipe', 'pipe', 'ignore', ...descriptors], stdin: undefined, maximumOutput: 65536, timeoutMs: remaining(deadline) })
    for (let index = 0; index < descriptors.length; index++) if (hash(descriptorBytes(descriptors[index], 268435456)) !== specs[index].sha256) fail('command mutated')
    remaining(deadline)
    return result
  } finally { for (const fd of descriptors) closeSync(fd) }
}
async function observe(config, execute, deadline) {
  const keys = [...STATUS_PROPERTIES, ...UNIT_PROPERTIES]
  const source = await command(config, execute, ['show', config.unit, '--no-pager', ...keys.map(key => `--property=${key}`)], deadline)
  const fields = {}
  for (const line of source.trimEnd().split('\n')) {
    const separator = line.indexOf('='); const key = line.slice(0, separator)
    if (separator < 0 || !keys.includes(key) || Object.hasOwn(fields, key)) fail('invalid or duplicate supervisor property')
    fields[key] = line.slice(separator + 1)
  }
  object(fields, keys, 'supervisor observation')
  if (fields.Id !== config.unit || fields.LoadState !== 'loaded') fail('unit identity or load state changed')
  fields.ExecStart = normalizeExecStart(fields.ExecStart)
  for (const key of UNIT_PROPERTIES) if (fields[key] !== config.unitProperties[key]) fail('effective unit configuration drifted')
  for (const key of ['MainPID', 'ControlPID', 'NRestarts']) {
    if (!/^(0|[1-9]\d*)$/u.test(fields[key])) fail('invalid supervisor counter')
    fields[key] = integer(Number(fields[key]), key)
  }
  if (!/^\/[A-Za-z0-9_.@:/\\-]+$/u.test(fields.ControlGroup) || fields.ControlGroup.includes('..')) fail('invalid unit cgroup')
  const memberships = readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n')
  let ownHierarchyObserved = false
  for (const line of memberships) {
    const match = line.match(/^\d+:([^:]*):(.*)$/u)
    if (match && (match[1] === '' || match[1].split(',').includes('name=systemd'))) {
      if (!match[2].startsWith('/') || match[2].includes('..')) fail('cannot establish attestor cgroup membership')
      ownHierarchyObserved = true
      if (within(fields.ControlGroup, match[2])) fail('attestor must run outside the target service cgroup')
    }
  }
  if (!ownHierarchyObserved) fail('cannot establish attestor cgroup membership')
  assertProfile(config)
  return fields
}
function active(observation) {
  return observation.ActiveState === 'active' && observation.SubState === 'running' && observation.MainPID > 0
    && observation.ControlPID === 0 && /^[a-f0-9]{32}$/u.test(observation.InvocationID) && !/^0+$/u.test(observation.InvocationID)
}
function journal(config) {
  const path = join(config.stateRoot, 'reload.sqlite')
  for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(path + suffix)) readSafe(path + suffix, 67108864, true)
  const oldMask = process.umask(0o077); let db
  try { db = new DatabaseSync(path) } finally { process.umask(oldMask) }
  try {
    db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS reloads (
        operation_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, config_digest TEXT NOT NULL,
        scope_id TEXT NOT NULL, generation INTEGER NOT NULL, activation_id TEXT NOT NULL,
        prior TEXT NOT NULL, observation TEXT, receipt TEXT, request TEXT, config TEXT,
        UNIQUE(scope_id, generation), UNIQUE(scope_id, activation_id));`)
    transaction(db, () => {
      const columns = db.prepare('PRAGMA table_info(reloads)').all().map(column => column.name)
      for (const name of ['request', 'config']) if (!columns.includes(name)) db.exec(`ALTER TABLE reloads ADD COLUMN ${name} TEXT`)
      db.exec(`CREATE TABLE IF NOT EXISTS readiness (
        operation_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, config_digest TEXT NOT NULL,
        reload_id TEXT NOT NULL UNIQUE, observation TEXT, receipt TEXT);`)
    })
    syncDirectory(config.stateRoot)
    return db
  } catch { db.close(); fail('private supervisor journal could not be opened') }
}
function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE')
  try { const result = action(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
}
function cachedReceipt(row, request, config, privateKey) {
  if (row.request_digest !== digest(request) || row.config_digest !== digest(config)) fail('operation identity changed')
  if (row.receipt === null) return undefined
  const receipt = parseJson(Buffer.from(row.receipt), 'cached receipt'); const { signature, ...unsigned } = receipt
  if (receipt.requestDigest !== row.request_digest || !verify(null, Buffer.from(canonical(unsigned)), createPublicKey(privateKey), Buffer.from(signature, 'base64'))) fail('cached receipt is invalid')
  if (Date.now() > receipt.expiresAt) fail('cached receipt expired; owner reconciliation required')
  return receipt
}
function boundReload(db, request, config, privateKey) {
  const row = db.prepare('SELECT * FROM reloads WHERE scope_id = ? ORDER BY generation DESC LIMIT 1')
    .get(digest({ installation: request.installationId }))
  if (!row || row.operation_id !== config.readiness.reloadOperationId || row.generation !== config.authorization.hostGeneration
    || !row.receipt || !row.observation || !row.request || !row.config) fail('latest reload is unresolved, superseded or lacks retained context')
  const priorRequest = parseJson(Buffer.from(row.request), 'reload request')
  const priorConfig = parseJson(Buffer.from(row.config), 'reload config')
  for (const field of ['installationId', 'ledger', 'profile', 'plan', 'activation']) {
    if (canonical(priorRequest[field]) !== canonical(request[field])) fail('reload context differs')
  }
  for (const field of ['authority', 'keyId', 'privateKeyPath', 'stateRoot', 'scope', 'unit', 'unitProperties', 'profileFiles', 'systemctl']) {
    if (canonical(priorConfig[field]) !== canonical(config[field])) fail('reload deployment differs')
  }
  const receipt = cachedReceipt(row, priorRequest, priorConfig, privateKey)
  const observation = parseJson(Buffer.from(row.observation), 'reload observation')
  if (priorRequest.phase !== 'reload' || priorRequest.operationId !== row.operation_id
    || receipt.phase !== 'reload' || receipt.outcome !== 'passed' || receipt.hostGeneration !== row.generation
    || receipt.operationId !== row.operation_id || receipt.installationId !== request.installationId
    || receipt.planId !== request.plan.id || receipt.planDigest !== request.plan.digest
    || receipt.activationId !== request.activation.id || receipt.fence !== request.activation.fence
    || receipt.authority !== config.authority || receipt.keyId !== config.keyId
    || receipt.evidenceDigest !== digest(receipt.evidence) || receipt.evidence.kind !== 'reload'
    || receipt.evidence.reloaded !== true || receipt.evidence.currentHostGeneration !== row.generation
    || receipt.evidence.previousHostGeneration !== priorRequest.requirements.previousHostGeneration
    || receipt.evidence.probeDigest !== digest(observation) || observation.requestDigest !== row.request_digest
    || observation.configDigest !== row.config_digest || !active(observation.successor)) fail('reload evidence binding is invalid')
  return { operationId: row.operation_id, generation: row.generation, receiptDigest: digest(receipt), successor: observation.successor }
}

async function attestReadiness(request, config, privateKey, db, execute, deadline) {
  const ready = config.readiness
  const bytes = readSafe(ready.client.path, 1048576)
  if (hash(bytes) !== ready.client.sha256) fail('observer client changed')
  const client = await import(`data:text/javascript;base64,${bytes.toString('base64')}`)
  client.validateRuntimeObserverConfig(ready.observer)
  const observerDigest = client.runtimeConfigDigest(ready.observer)
  // Pin the channel key as well as its configured path for this entire attempt.
  const channelDigest = hash(readSafe(ready.observer.keyPath, 32, true))
  const reload = boundReload(db, request, config, privateKey)
  const reserved = transaction(db, () => {
    const row = db.prepare('SELECT * FROM readiness WHERE operation_id = ?').get(request.operationId)
    if (row) { cachedReceipt(row, request, config, privateKey); return row }
    db.prepare('INSERT INTO readiness(operation_id, request_digest, config_digest, reload_id) VALUES (?, ?, ?, ?)')
      .run(request.operationId, digest(request), digest(config), reload.operationId)
    return db.prepare('SELECT * FROM readiness WHERE operation_id = ?').get(request.operationId)
  })
  const cached = cachedReceipt(reserved, request, config, privateKey)
  const retained = cached ? parseJson(Buffer.from(reserved.observation), 'readiness observation') : undefined
  if (retained && (cached.evidence.probeDigest !== digest(retained) || canonical(retained.reload) !== canonical(reload))) fail('retained readiness binding differs')
  let stable; let started; let failures = 0; const samples = []; const challenges = new Set()
  for (;;) {
    assertCurrent(config, request); remaining(deadline)
    if (canonical(boundReload(db, request, config, privateKey)) !== canonical(reload)) fail('reload changed during readiness')
    const before = await observe(config, execute, deadline)
    if (canonical(before) !== canonical(reload.successor)) fail('supervisor no longer matches the reload successor')
    if (hash(readSafe(ready.observer.keyPath, 32, true)) !== channelDigest) fail('observer key changed')
    const queryStarted = Date.now()
    const sample = await client.queryRuntimeObserver({ ...ready.observer, signal: AbortSignal.timeout(remaining(deadline)) })
    if (sample.profilePath !== request.profile.path || sample.observerConfigDigest !== observerDigest
      || sample.processId !== before.MainPID || sample.invocationId !== before.InvocationID
      || sample.observedAt < queryStarted || sample.observedAt > Date.now() || challenges.has(sample.challenge)
      || sample.entries.length !== ready.observer.targets.length) fail('observer identity or freshness differs')
    challenges.add(sample.challenge)
    let sampleFailed = false
    for (const target of ready.observer.targets) {
      const entry = sample.entries.find(item => item.entryId === target.entryId)
      if (!entry || entry.module !== target.module || entry.configDigest !== target.configDigest
        || canonical(entry.services.map(service => service.name).sort()) !== canonical([...target.services].sort())) fail('candidate identity differs')
      if (entry.active === true) {
        if (!entry.instance || [...entry.dependencies, ...entry.services].some(service => !service.instance)) fail('active candidate is not ready')
      } else if (entry.active === false) {
        // A disabled or pending Fiber has no instance by contract.  It is a
        // signed negative result only after the complete authenticated identity
        // remains stable for the full window; malformed identities still abort.
        sampleFailed = true
      } else fail('candidate active state is invalid')
    }
    const { challenge: _challenge, observedAt: _observedAt, ...identity } = sample
    if (stable === undefined) { stable = identity; started = performance.now() }
    else if (canonical(identity) !== canonical(stable)) fail('runtime instance changed during readiness')
    if (retained && canonical(identity) !== canonical(retained.runtime)) fail('cached readiness runtime changed')
    samples.push({ challenge: sample.challenge, observedAt: sample.observedAt, digest: digest(sample) })
    if (sampleFailed) failures++
    const after = await observe(config, execute, deadline)
    if (canonical(after) !== canonical(reload.successor)) fail('supervisor changed during runtime query')
    if (samples.length >= Math.max(2, request.requirements.minimumChecks) && performance.now() - started >= config.stableWindowMs) break
    if (samples.length >= 256) fail('readiness sample limit exceeded')
    await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(config.pollIntervalMs, remaining(deadline))))
  }
  assertCurrent(config, request); assertProfile(config); remaining(deadline)
  if (hash(readSafe(ready.observer.keyPath, 32, true)) !== channelDigest) fail('observer key changed')
  const observation = { schemaVersion: 1, requestDigest: digest(request), configDigest: digest(config), reload,
    channelDigest, runtime: stable, samples, stableWindowMs: config.stableWindowMs, observedAt: Date.now() }
  const evidence = { kind: 'readiness', checks: samples.length, failures, probeDigest: digest(observation) }
  const unsigned = { schemaVersion: 2, receiptId: `receipt:${request.operationId}`, authority: config.authority, keyId: config.keyId,
    installationId: request.installationId, planId: request.plan.id, planDigest: request.plan.digest,
    activationId: request.activation.id, fence: request.activation.fence, operationId: request.operationId,
    requestDigest: digest(request), phase: 'readiness', outcome: failures === 0 ? 'passed' : 'failed', hostGeneration: reload.generation,
    evidence, evidenceDigest: digest(evidence), observedAt: observation.observedAt,
    expiresAt: Math.min(observation.observedAt + request.receiptTtlMs, config.authorization.expiresAt) }
  if (unsigned.expiresAt <= unsigned.observedAt) fail('authorization expired before signing')
  return transaction(db, () => {
    assertCurrent(config, request); remaining(deadline)
    if (canonical(boundReload(db, request, config, privateKey)) !== canonical(reload)) fail('reload superseded before signing')
    const row = db.prepare('SELECT * FROM readiness WHERE operation_id = ?').get(request.operationId)
    const replay = cachedReceipt(row, request, config, privateKey)
    if (replay) {
      const prior = parseJson(Buffer.from(row.observation), 'readiness observation')
      if (replay.evidence.probeDigest !== digest(prior) || canonical(prior.runtime) !== canonical(stable)
        || canonical(prior.reload) !== canonical(reload) || prior.channelDigest !== channelDigest) fail('concurrent readiness binding differs')
      return replay
    }
    const receipt = { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), privateKey).toString('base64') }
    db.prepare('UPDATE readiness SET observation = ?, receipt = ? WHERE operation_id = ? AND receipt IS NULL')
      .run(canonical(observation), canonical(receipt), request.operationId)
    return cachedReceipt(db.prepare('SELECT * FROM readiness WHERE operation_id = ?').get(request.operationId), request, config, privateKey)
  })
}
async function attest(request, config, privateKey) {
  const helperBytes = readSafe(config.processHelper.path, 1048576)
  if (hash(helperBytes) !== config.processHelper.sha256) fail('process helper changed')
  const { executeControlledProcess: execute } = await import(`data:text/javascript;base64,${helperBytes.toString('base64')}`)
  if (typeof execute !== 'function') fail('process helper contract is unavailable')
  const deadline = performance.now() + config.timeoutMs
  const db = journal(config)
  try {
    if (request.phase === 'readiness') return await attestReadiness(request, config, privateKey, db, execute, deadline)
    const existing = db.prepare('SELECT * FROM reloads WHERE operation_id = ?').get(request.operationId)
    if (existing) { const receipt = cachedReceipt(existing, request, config, privateKey); if (receipt) return receipt }
    const observed = await observe(config, execute, deadline)
    if (!existing && !active(observed)) fail('target service is not stably active before restart')
    // Control Plane generations are installation-wide, including when its
    // profiles alternate. The retained request/config digests bind each unit.
    const scopeId = digest({ installation: request.installationId })
    const activationId = digest({ plan: request.plan, activation: request.activation })
    const reserved = transaction(db, () => {
      const row = db.prepare('SELECT * FROM reloads WHERE operation_id = ?').get(request.operationId)
      if (row) { cachedReceipt(row, request, config, privateKey); return { row, dispatch: false } }
      const latest = db.prepare('SELECT * FROM reloads WHERE scope_id = ? ORDER BY generation DESC LIMIT 1').get(scopeId)
      if (latest && (latest.receipt === null || latest.generation !== request.requirements.previousHostGeneration)) fail('previous generation is unresolved or stale')
      const generation = request.requirements.previousHostGeneration + 1
      db.prepare('INSERT INTO reloads(operation_id, request_digest, config_digest, scope_id, generation, activation_id, prior, request, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(request.operationId, digest(request), digest(config), scopeId, generation, activationId, canonical(observed), canonical(request), canonical(config))
      return { row: db.prepare('SELECT * FROM reloads WHERE operation_id = ?').get(request.operationId), dispatch: true }
    })
    const replay = cachedReceipt(reserved.row, request, config, privateKey); if (replay) return replay
    const prior = parseJson(Buffer.from(reserved.row.prior), 'prior observation')
    if (reserved.dispatch) {
      // Reservation is durable before crossing the supervisor boundary. Any
      // later failure is ambiguous; replay must never call restart again.
      syncDirectory(config.stateRoot); assertCurrent(config, request); assertProfile(config)
      await command(config, execute, ['restart', config.unit, '--no-ask-password', '--job-mode=fail'], deadline)
    }
    let successor; let stableAt = 0; let samples = 0
    for (;;) {
      assertCurrent(config, request); remaining(deadline)
      const current = await observe(config, execute, deadline)
      if (active(current) && current.InvocationID !== prior.InvocationID && current.MainPID !== prior.MainPID) {
        if (successor === undefined) { successor = current; stableAt = performance.now(); samples = 1 }
        else if (canonical(current) !== canonical(successor)) fail('successor changed during the stability window')
        else samples++
        if (performance.now() - stableAt >= config.stableWindowMs && samples >= 2) break
      } else if (successor !== undefined) fail('successor left the active state')
      await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(config.pollIntervalMs, remaining(deadline))))
    }
    assertCurrent(config, request); assertProfile(config); remaining(deadline)
    const observation = { schemaVersion: 1, requestDigest: digest(request), configDigest: digest(config), prior, successor, samples,
      stableWindowMs: config.stableWindowMs, observedAt: Date.now() }
    const evidence = { kind: 'reload', reloaded: true, previousHostGeneration: request.requirements.previousHostGeneration,
      currentHostGeneration: reserved.row.generation, probeDigest: digest(observation) }
    const unsigned = { schemaVersion: 2, receiptId: `receipt:${request.operationId}`, authority: config.authority, keyId: config.keyId,
      installationId: request.installationId, planId: request.plan.id, planDigest: request.plan.digest,
      activationId: request.activation.id, fence: request.activation.fence, operationId: request.operationId,
      requestDigest: digest(request), phase: 'reload', outcome: 'passed', hostGeneration: reserved.row.generation,
      evidence, evidenceDigest: digest(evidence), observedAt: observation.observedAt,
      expiresAt: Math.min(observation.observedAt + request.receiptTtlMs, config.authorization.expiresAt) }
    if (unsigned.expiresAt <= unsigned.observedAt) fail('authorization expired before signing')
    const receipt = { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), privateKey).toString('base64') }
    return transaction(db, () => {
      db.prepare('UPDATE reloads SET observation = ?, receipt = ? WHERE operation_id = ? AND receipt IS NULL')
        .run(canonical(observation), canonical(receipt), request.operationId)
      return cachedReceipt(db.prepare('SELECT * FROM reloads WHERE operation_id = ?').get(request.operationId), request, config, privateKey)
    })
  } finally { db.close() }
}

export async function runSystemdHostAttestor(argv = process.argv.slice(2), environment = process.env) {
  if (argv.length === 1 && argv[0] === '--version') return SYSTEMD_HOST_ATTESTOR_VERSION
  if (process.platform !== 'linux' || argv.length !== 1 || argv[0] !== 'attest') fail('Linux attest command required')
  let bytes = 0; const chunks = []
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 65536) fail('request exceeds byte limit'); chunks.push(chunk) }
  const request = parseJson(Buffer.concat(chunks), 'request')
  if (!['reload', 'readiness'].includes(request?.phase)) fail('only reload and readiness requests are supported')
  const { config, privateKey } = loadConfig(environment, request)
  return attest(request, config, privateKey)
}
if (process.argv[1] && (/^\/proc\/self\/fd\/\d+$/u.test(process.argv[1]) || realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) {
  try { const result = await runSystemdHostAttestor(); process.stdout.write(`${typeof result === 'string' ? result : JSON.stringify(result)}\n`) }
  catch (error) {
    const reason = error instanceof Error && error.message.startsWith('systemd Host attestor:') ? error.message
      : 'systemd Host attestor refused the request; inspect owner configuration and durable observations before retrying'
    process.stderr.write(`${reason}\n`); process.exitCode = 1
  }
}
