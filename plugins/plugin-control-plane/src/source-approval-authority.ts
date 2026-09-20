/**
 * Owner-operated, finite source-approval boundary.
 *
 * This module has no Cordis service and never executes a candidate.  It can
 * only sign one pending, owner-bound prepared source plan after independently
 * re-reading the control database and the checked Git worktree.
 */
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { approvalSigningPayload, parseApprovalReceipt } from './approval.js'
import { PREPARED_SOURCE_BUILD_SCRIPT } from './source-build.js'
import { controlPlaneDigest, readOwnerPreparedSourcePlan } from './store.js'
import { PROTECTED_PLUGIN_DENYLIST, changedSourcePaths, checkedSourceSnapshot, runLocalCommand } from './source-workspace.js'
import { verifyManagedPatchVersion } from './source-versioning.js'
import type { SourceJobOwnerReceipt } from './source-job-types.js'
import type { ApprovalReceipt, PluginSourcePlan } from './types.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const SOURCE_FILE = /^plugins\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/src\/.+\.(?:ts|js|mts|mjs)$/u
const SOURCE_TEST_PATH = /(?:^|\/)(?:__tests__|test|tests)(?:\/|$)|\.(?:spec|test)\.(?:ts|js|mts|mjs)$/u
const MAX_CONFIG_BYTES = 32_768
const MAX_REQUEST_BYTES = 8_192
const MAX_KEY_BYTES = 32_768

export interface SourceApprovalRequest {
  protocol: 'dsh-source-approval/v1'
  planId: string
  planDigest: string
  sourceReferenceDigest: string
}

export interface SourceApprovalAuthorityConfig {
  schemaVersion: 1
  authority: string
  keyId: string
  keyPath: string
  statePath: string
  controlDatabasePath: string
  grant: {
    id: string
    expiresAt: number
    maxApprovals: number
    repository: string
    worktreeRoot: string
    owner: Pick<SourceJobOwnerReceipt, 'authorityId' | 'authorityHash' | 'principalId' | 'principalRecordId' | 'principalVersion' | 'workspace' | 'agentPreset'>
    plugins: readonly string[]
    maxChangedFiles: number
    maxChangedBytes: number
    receiptTtlMs: number
    /** Independently authorize only the deterministic Host-owned version delta. */
    versioning?: 'patch'
  }
}

class SourceApprovalAuthorityError extends Error {
  constructor(message = 'source approval authority refused the request') { super(message); this.name = 'SourceApprovalAuthorityError' }
}

function fail(): never { throw new SourceApprovalAuthorityError() }

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) fail()
}

function text(value: unknown, pattern = ID, maximum = 160): string {
  if (typeof value !== 'string' || value.normalize('NFC').trim() !== value || !pattern.test(value)
    || Buffer.byteLength(value) > maximum || /[\p{Cc}]/u.test(value)) fail()
  return value
}

function pathText(value: unknown): string {
  const path = text(value, /^[\s\S]+$/u, 4_096)
  if (!isAbsolute(path) || path === '/' || resolve(path) !== path) fail()
  return path
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail()
  return value as number
}

function canonicalSafePath(path: string, kind: 'file' | 'directory', createFile = false): string {
  const uid = process.getuid?.()
  const parent = dirname(path)
  let parentStat: ReturnType<typeof lstatSync>
  try { parentStat = lstatSync(parent) } catch { fail() }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
    || (kind === 'file' && ((parentStat.mode & 0o077) !== 0 || (uid !== undefined && parentStat.uid !== uid)))) fail()
  if (createFile) {
    try { const created = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR, 0o600); closeSync(created) } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') fail()
    }
  }
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(path) } catch { fail() }
  if ((kind === 'file' ? !stat.isFile() : !stat.isDirectory()) || stat.isSymbolicLink() || (kind === 'file' && stat.nlink !== 1)
    || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid) || realpathSync(path) !== path) fail()
  return path
}

function canonicalRepository(path: string): string {
  const uid = process.getuid?.()
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(path) } catch { fail() }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
    || (uid !== undefined && stat.uid !== uid) || realpathSync(path) !== path) fail()
  return path
}

function readSafeFile(path: string, maximum: number): Buffer {
  canonicalSafePath(path, 'file')
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd, { bigint: true }); const named = lstatSync(path, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum) || before.dev !== named.dev || before.ino !== named.ino) fail()
    const bytes = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true }); const namedAfter = lstatSync(path, { bigint: true })
    if (bytes.length > maximum || before.dev !== after.dev || before.ino !== after.ino || after.dev !== namedAfter.dev || after.ino !== namedAfter.ino) fail()
    return bytes
  } finally { closeSync(fd) }
}

function equivalentOwner(left: SourceJobOwnerReceipt, right: SourceApprovalAuthorityConfig['grant']['owner']): boolean {
  return left.authorityId === right.authorityId && left.authorityHash === right.authorityHash
    && left.principalId === right.principalId && left.principalRecordId === right.principalRecordId
    && left.principalVersion === right.principalVersion && left.workspace === right.workspace && left.agentPreset === right.agentPreset
}

function sourceEnvironment(): NodeJS.ProcessEnv {
  const path = process.env.PATH
  if (path === undefined || path === '') fail()
  return Object.freeze({ PATH: path, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', HOME: '/nonexistent' })
}

function validateRequest(value: unknown): SourceApprovalRequest {
  const item = record(value); exactKeys(item, ['protocol', 'planId', 'planDigest', 'sourceReferenceDigest'])
  if (item.protocol !== 'dsh-source-approval/v1') fail()
  const planId = text(item.planId); const planDigest = text(item.planDigest, DIGEST, 64); const sourceReferenceDigest = text(item.sourceReferenceDigest, DIGEST, 64)
  return Object.freeze({ protocol: 'dsh-source-approval/v1', planId, planDigest, sourceReferenceDigest })
}

export function validateSourceApprovalAuthorityConfig(value: unknown): asserts value is SourceApprovalAuthorityConfig {
  const item = record(value); exactKeys(item, ['schemaVersion', 'authority', 'keyId', 'keyPath', 'statePath', 'controlDatabasePath', 'grant'])
  if (item.schemaVersion !== 1) fail()
  const grant = record(item.grant)
  exactKeys(grant, ['id', 'expiresAt', 'maxApprovals', 'repository', 'worktreeRoot', 'owner', 'plugins', 'maxChangedFiles', 'maxChangedBytes', 'receiptTtlMs',
    ...(Object.hasOwn(grant, 'versioning') ? ['versioning'] : [])])
  if (Object.hasOwn(grant, 'versioning') && grant.versioning !== 'patch') fail()
  text(item.authority); text(item.keyId); const keyPath = pathText(item.keyPath); const statePath = pathText(item.statePath); const controlDatabasePath = pathText(item.controlDatabasePath)
  if (new Set([keyPath, statePath, controlDatabasePath]).size !== 3) fail()
  text(grant.id); integer(grant.expiresAt, 1); integer(grant.maxApprovals, 1, 10_000); pathText(grant.repository); pathText(grant.worktreeRoot)
  const owner = record(grant.owner); exactKeys(owner, ['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset'])
  text(owner.authorityId); text(owner.authorityHash, DIGEST, 64); text(owner.principalId, /^[\s\S]+$/u, 512)
  text(owner.principalRecordId, /^[\s\S]+$/u, 512); integer(owner.principalVersion, 1); pathText(owner.workspace); text(owner.agentPreset)
  if (!Array.isArray(grant.plugins) || grant.plugins.length === 0 || grant.plugins.length > 32) fail()
  const plugins = grant.plugins.map(plugin => text(plugin, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, 64))
  if (new Set(plugins).size !== plugins.length || plugins.some(plugin => PROTECTED_PLUGIN_DENYLIST.has(plugin))) fail()
  integer(grant.maxChangedFiles, 1, 256); integer(grant.maxChangedBytes, 1, 16 * 1024 * 1024); integer(grant.receiptTtlMs, 1_000, 86_400_000)
}

function validatePrepared(plan: PluginSourcePlan, now: number): void {
  if (plan.status !== 'pending-approval' || plan.mode !== 'modify' || plan.sourceCheck === undefined || plan.preparedEvidence === undefined
    || now > plan.expiresAt || plan.preparedEvidence.preparedAt > plan.sourceCheck.checkedAt || plan.sourceCheck.checkedAt > plan.createdAt
    || plan.preparedEvidence.preparedAt > now || plan.preparedEvidence.environment.npmConfigIgnoreScripts !== true
    || plan.preparedEvidence.environment.frozenLockfile !== true || plan.preparedEvidence.environment.offline !== true
    || plan.preparedEvidence.commands.length !== 1)
    fail()
  const command = plan.preparedEvidence.commands[0]!
  const pairs = (left: string, right: string): boolean => command.args.some((value, index) => value === left && command.args[index + 1] === right)
  if (command.command !== 'docker' || command.args[0] !== 'run' || command.args[1] !== '-i' || command.args[2] !== '--pull'
    || command.args[3] !== 'never' || !pairs('--network', 'none') || !command.args.includes('--read-only')
    || !pairs('--cap-drop', 'ALL') || !pairs('--user', '65534:65534') || !pairs('--entrypoint', '/bin/sh')
    || !pairs('--env', `PLUGIN_ROOT=plugins/${plan.name}`) || command.args.at(-2) !== '-ceu'
    || command.args.at(-1) !== PREPARED_SOURCE_BUILD_SCRIPT) fail()
}

async function validateWorktree(plan: PluginSourcePlan, config: SourceApprovalAuthorityConfig): Promise<void> {
  if (!COMMIT.test(plan.baseCommit) || PROTECTED_PLUGIN_DENYLIST.has(plan.name) || !config.grant.plugins.includes(plan.name)) fail()
  const repository = canonicalRepository(config.grant.repository); const worktreeRoot = canonicalSafePath(config.grant.worktreeRoot, 'directory')
  const worktree = canonicalSafePath(plan.worktree, 'directory')
  const worktreeRelative = relative(worktreeRoot, worktree)
  if (plan.repository !== repository || worktreeRelative === '' || worktreeRelative === '..' || worktreeRelative.startsWith(`..${sep}`) || isAbsolute(worktreeRelative)) fail()
  const environment = sourceEnvironment()
  const head = (await runLocalCommand('git', ['rev-parse', '--verify', 'HEAD^{commit}'], worktree, environment, { capture: true })).trim()
  if (head !== plan.baseCommit) fail()
  const repositoryCommon = (await runLocalCommand('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], repository, environment, { capture: true })).trim()
  const worktreeCommon = (await runLocalCommand('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], worktree, environment, { capture: true })).trim()
  if (!isAbsolute(repositoryCommon) || !isAbsolute(worktreeCommon) || realpathSync(repositoryCommon) !== realpathSync(worktreeCommon)) fail()
  const paths = await changedSourcePaths(worktree, plan.baseCommit, environment)
  if (paths.length === 0 || paths.length > config.grant.maxChangedFiles) fail()
  const manifestPath = `plugins/${plan.name}/package.json`
  if (config.grant.versioning === 'patch') {
    if (!paths.includes(manifestPath) || !paths.includes(`plugins/${plan.name}/src/version.ts`)) fail()
    const managed = await verifyManagedPatchVersion({ worktree, baseCommit: plan.baseCommit, name: plan.name, environment })
    if (plan.preparedEvidence?.pack.version !== managed.version) fail()
  }
  let bytes = 0
  for (const path of paths) {
    const match = SOURCE_FILE.exec(path)
    const managedManifest = config.grant.versioning === 'patch' && path === manifestPath
    if (!managedManifest && (!match || match[1] !== plan.name || SOURCE_TEST_PATH.test(path))) fail()
    const target = resolve(worktree, path)
    if (relative(worktree, target).startsWith(`..${sep}`) || target === worktree) fail()
    let stat: ReturnType<typeof lstatSync>
    try { stat = lstatSync(target) } catch { fail() }
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(target) !== target) fail()
    bytes += stat.size
    if (bytes > config.grant.maxChangedBytes) fail()
  }
  const checked = await checkedSourceSnapshot(worktree, plan.baseCommit, plan.scope, environment)
  if (checked.checkedTreeDigest !== plan.sourceCheck!.treeDigest || checked.checkedPatchDigest !== plan.sourceCheck!.patchDigest) fail()
}

interface StoredApproval { request_digest: string; grant_id: string; config_digest: string; plan_id: string; plan_digest: string; receipt_json: string; receipt_digest: string }

function openLedger(path: string): DatabaseSync {
  canonicalSafePath(path, 'file', true)
  const database = new DatabaseSync(path)
  database.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS source_approval_grants (
      grant_id TEXT PRIMARY KEY, config_digest TEXT NOT NULL, key_fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS source_approval_receipts (
      request_digest TEXT PRIMARY KEY, grant_id TEXT NOT NULL, config_digest TEXT NOT NULL, plan_id TEXT NOT NULL UNIQUE, plan_digest TEXT NOT NULL,
      receipt_json TEXT NOT NULL, receipt_digest TEXT NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;`)
  return database
}

function receiptFor(config: SourceApprovalAuthorityConfig, request: SourceApprovalRequest, privateKey: ReturnType<typeof createPrivateKey>, now: number, expiresAt: number): ApprovalReceipt {
  const unsigned: Omit<ApprovalReceipt, 'signature'> = { schemaVersion: 1,
    approvalId: `source-approval-${controlPlaneDigest({ grant: config.grant.id, request }).slice(0, 40)}`,
    authority: config.authority, keyId: config.keyId, planId: request.planId, planDigest: request.planDigest,
    decision: 'approved', principal: config.grant.owner.principalId, decidedAt: now, expiresAt }
  return Object.freeze({ ...unsigned, signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), privateKey).toString('base64') })
}

/** Sign a finite, freshly rechecked source approval. It cannot approve a release or activation. */
export async function authorizePreparedSource(configInput: SourceApprovalAuthorityConfig, requestInput: SourceApprovalRequest): Promise<ApprovalReceipt> {
  try {
    validateSourceApprovalAuthorityConfig(configInput); const config = configInput; const request = validateRequest(requestInput)
    if (Date.now() >= config.grant.expiresAt) fail()
    const sourcePath = canonicalSafePath(config.controlDatabasePath, 'file')
    const keyBytes = readSafeFile(config.keyPath, MAX_KEY_BYTES)
    let privateKey: ReturnType<typeof createPrivateKey>
    try { privateKey = createPrivateKey(keyBytes) } catch { fail() }
    if (privateKey.asymmetricKeyType !== 'ed25519') fail()
    const keyFingerprint = createHash('sha256').update(keyBytes).digest('hex')
    const configDigest = controlPlaneDigest(config)
    const database = new DatabaseSync(sourcePath, { readOnly: true })
    let source: ReturnType<typeof readOwnerPreparedSourcePlan>
    try {
      database.exec('PRAGMA query_only = ON;')
      source = readOwnerPreparedSourcePlan(database, request.planId)
      if (source.plan.digest !== request.planDigest || controlPlaneDigest(source.source) !== request.sourceReferenceDigest
        || !equivalentOwner(source.source.owner, config.grant.owner)) fail()
      validatePrepared(source.plan, Date.now()); await validateWorktree(source.plan, config)
      const final = readOwnerPreparedSourcePlan(database, request.planId)
      if (final.plan.digest !== source.plan.digest || controlPlaneDigest(final.source) !== controlPlaneDigest(source.source) || final.plan.status !== 'pending-approval') fail()
    } finally { database.close() }
    const requestDigest = controlPlaneDigest(request)
    const ledger = openLedger(config.statePath)
    try {
      ledger.exec('BEGIN IMMEDIATE')
      try {
        const now = Date.now(); if (now >= config.grant.expiresAt) fail()
        validatePrepared(source.plan, now)
        const receiptExpiry = Math.min(now + config.grant.receiptTtlMs, config.grant.expiresAt, source.plan.expiresAt)
        if (receiptExpiry <= now) fail()
        const grant = ledger.prepare('SELECT config_digest, key_fingerprint FROM source_approval_grants WHERE grant_id = ?').get(config.grant.id) as { config_digest: string; key_fingerprint: string } | undefined
        if (grant === undefined) ledger.prepare('INSERT INTO source_approval_grants (grant_id, config_digest, key_fingerprint, created_at) VALUES (?, ?, ?, ?)')
          .run(config.grant.id, configDigest, keyFingerprint, now)
        else if (grant.config_digest !== configDigest || grant.key_fingerprint !== keyFingerprint) fail()
        const existing = ledger.prepare('SELECT request_digest, grant_id, config_digest, plan_id, plan_digest, receipt_json, receipt_digest FROM source_approval_receipts WHERE request_digest = ?')
          .get(requestDigest) as StoredApproval | undefined
        if (existing !== undefined) {
          if (existing.grant_id !== config.grant.id || existing.config_digest !== configDigest || existing.plan_id !== request.planId
            || existing.plan_digest !== request.planDigest || existing.receipt_digest !== controlPlaneDigest(existing.receipt_json)) fail()
          const receipt = parseApprovalReceipt(JSON.parse(existing.receipt_json) as unknown)
          if (receipt.expiresAt <= now || receipt.authority !== config.authority || receipt.keyId !== config.keyId) fail()
          ledger.exec('COMMIT'); return receipt
        }
        if (ledger.prepare('SELECT request_digest FROM source_approval_receipts WHERE plan_id = ?').get(request.planId) !== undefined) fail()
        const used = ledger.prepare('SELECT COUNT(*) AS count FROM source_approval_receipts WHERE grant_id = ?').get(config.grant.id) as { count: number }
        if (used.count >= config.grant.maxApprovals) fail()
        const receipt = receiptFor(config, request, privateKey, now, receiptExpiry)
        const receiptJson = JSON.stringify(receipt)
        ledger.prepare('INSERT INTO source_approval_receipts (request_digest, grant_id, config_digest, plan_id, plan_digest, receipt_json, receipt_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(requestDigest, config.grant.id, configDigest, request.planId, request.planDigest, receiptJson, controlPlaneDigest(receiptJson), now)
        ledger.exec('COMMIT'); return receipt
      } catch (error) { try { ledger.exec('ROLLBACK') } catch { /* no transaction after a failed commit */ } throw error }
    } finally { ledger.close() }
  } catch (error) {
    if (error instanceof SourceApprovalAuthorityError) throw error
    throw new SourceApprovalAuthorityError()
  }
}

async function readOneRequest(): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length
    if (size > MAX_REQUEST_BYTES) fail()
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { fail() }
}

/** CLI entrypoint: exactly --config <absolute-path>, one bounded JSON request on stdin, one receipt on stdout. */
export async function runSourceApprovalAuthority(argv = process.argv.slice(2)): Promise<void> {
  try {
    if (argv.length !== 2 || argv[0] !== '--config') fail()
    const configPath = pathText(argv[1]); const configBytes = readSafeFile(configPath, MAX_CONFIG_BYTES)
    let config: unknown; try { config = JSON.parse(configBytes.toString('utf8')) as unknown } catch { fail() }
    const request = await readOneRequest(); const receipt = await authorizePreparedSource(config as SourceApprovalAuthorityConfig, request as SourceApprovalRequest)
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  } catch { throw new SourceApprovalAuthorityError() }
}
