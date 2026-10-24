import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { isExactDeliveryCommand, parseDeliveryCommand } from './session-commands.js'

/** Only the named, installed profile may be restarted. Model input never reaches an OS command. */
export interface RestartSupervisorConfig {
  dshHome: string
  profile: string
  databasePath: string
  deliveryDatabasePath: string
  policyDatabasePath: string
  automationDatabasePath: string
  policyEvaluatorPath: string
  unit: string
  expectedUnitDigest: string
  profilePatchDigest: string
  cohortReceiptDigest: string
  sourceCommit: string
  trustedFiles: readonly { path: string; digest: string }[]
  policyRules: readonly Record<string, unknown>[]
  restartOwnerRouteId: string
  hostBindingDigest: string
  hostReceiptPath: string
  hostReceiptSourceDigest: string
  readyTimeoutMs: number
  stableWindowMs: number
  maxRestarts: number
  windowMs: number
}

export interface RestartCandidate {
  id: string
  inboxId: string
  sourceInvocationId: string
  status: string
  updatedAt: number
}

export interface RestartTaskAuthority {
  inboxId: string
  eventId: string
  sourceInvocationId: string
  deadline: number
  binding: { id: string; version: number; generation: number; sessionId: string; workspace: string;
    preset: string; policyRef: string; authorityHash: string;
    conversation: { channel: string; account: string; tenant: string; kind: string; chat: string; thread?: string }
    principal: { channel: string; account: string; tenant: string; user: string } }
  owner: { principalRecordId: string; principalVersion: number }
}

/** The sidecar Store must implement these CAS operations with WAL and FULL sync. */
export interface RestartSupervisorLedger {
  listRequests(input: { statuses: readonly ('ready' | 'restarting')[]; limit: number }): readonly RestartCandidate[]
  getTask(inboxId: string): RestartTaskAuthority | undefined
  countDispatchedSince(sinceMs: number): number
  claimRestart(id: string, input: { holderId: string; invocationId: string }): unknown
  markRestarted(id: string, input: { invocationId: string }): unknown
  fail(id: string, code: string): unknown
}

export interface RestartSupervisorLedgerHandle extends RestartSupervisorLedger { close(): void }

export interface RestartUnitState {
  invocationId: string
  active: boolean
  mainPid: number
  fragmentPath: string
}

export interface RestartSupervisorSystem {
  unit(unit: string): Promise<RestartUnitState>
  restart(unit: string, signal: AbortSignal): Promise<void>
  ready(unit: string, invocationId: string): Promise<boolean>
  withLock<T>(home: string, task: () => Promise<T>): Promise<T | undefined>
  transactionExists(home: string): Promise<boolean>
  unitDigest(fragmentPath: string): Promise<string>
  authority(config: RestartSupervisorConfig, task: RestartTaskAuthority): Promise<boolean>
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

export type RestartSupervisorTick = 'idle' | 'deferred' | 'restarted' | 'failed' | 'observing'

const idPattern = /^[a-f0-9]{32}$/u
const shaPattern = /^[a-f0-9]{64}$/u
const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const unitPattern = /^dsh-profile-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.service$/u
const commitPattern = /^[a-f0-9]{40}$/u
const ownerRoutePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u

function positiveInteger(value: number, label: string, limit: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > limit) throw new Error(`restart-supervisor: invalid ${label}`)
  return value
}

export function validateRestartSupervisorConfig(value: RestartSupervisorConfig): RestartSupervisorConfig {
  if (value === null || typeof value !== 'object'
    || Object.keys(value).sort().join(',') !== [
      'automationDatabasePath', 'cohortReceiptDigest', 'databasePath', 'deliveryDatabasePath', 'dshHome', 'expectedUnitDigest',
      'hostBindingDigest', 'hostReceiptPath', 'hostReceiptSourceDigest',
      'maxRestarts', 'policyDatabasePath', 'policyEvaluatorPath', 'policyRules', 'profile', 'profilePatchDigest',
      'readyTimeoutMs', 'restartOwnerRouteId', 'sourceCommit', 'stableWindowMs', 'trustedFiles', 'unit', 'windowMs',
    ].sort().join(',')) throw new Error('restart-supervisor: invalid config shape')
  for (const name of ['dshHome', 'databasePath', 'deliveryDatabasePath', 'policyDatabasePath',
    'policyEvaluatorPath', 'automationDatabasePath', 'hostReceiptPath'] as const) {
    const path = value[name]
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
      throw new Error(`restart-supervisor: ${name} must be a normalized absolute path`)
    }
  }
  if (!profilePattern.test(value.profile) || value.unit !== `dsh-profile-${value.profile}.service`
    || !unitPattern.test(value.unit) || !shaPattern.test(value.expectedUnitDigest)
    || !shaPattern.test(value.profilePatchDigest) || !shaPattern.test(value.cohortReceiptDigest)
    || !shaPattern.test(value.hostBindingDigest) || !shaPattern.test(value.hostReceiptSourceDigest)
    || !commitPattern.test(value.sourceCommit) || !ownerRoutePattern.test(value.restartOwnerRouteId)
    || value.hostReceiptPath.startsWith(value.dshHome + sep)) {
    throw new Error('restart-supervisor: unit/profile or pinned digest is invalid')
  }
  if (!Array.isArray(value.trustedFiles) || value.trustedFiles.length < 3 || value.trustedFiles.length > 2048
    || value.trustedFiles.some(file => file === null || typeof file !== 'object'
      || Object.keys(file).sort().join(',') !== 'digest,path'
      || typeof file.path !== 'string' || !isAbsolute(file.path) || resolve(file.path) !== file.path
      || !file.path.startsWith(value.dshHome + sep) || !shaPattern.test(file.digest))
    || !Array.isArray(value.policyRules) || value.policyRules.length > 512
    || value.policyRules.some(rule => rule === null || typeof rule !== 'object' || Array.isArray(rule))) {
    throw new Error('restart-supervisor: invalid pinned files or policy rules')
  }
  if (!value.trustedFiles.some(file => file.path === value.policyEvaluatorPath)) {
    throw new Error('restart-supervisor: unpinned Policy evaluator')
  }
  positiveInteger(value.readyTimeoutMs, 'readyTimeoutMs', 600_000)
  positiveInteger(value.stableWindowMs, 'stableWindowMs', 120_000)
  if (value.stableWindowMs >= value.readyTimeoutMs) throw new Error('restart-supervisor: stability window exceeds readiness deadline')
  positiveInteger(value.maxRestarts, 'maxRestarts', 10)
  positiveInteger(value.windowMs, 'windowMs', 86_400_000)
  return Object.freeze({ ...value })
}

function requestIdentityValid(request: RestartCandidate, task: RestartTaskAuthority): boolean {
  return typeof request.id === 'string' && request.id.length > 0
    && Number.isSafeInteger(request.updatedAt) && request.updatedAt >= 0
    && request.inboxId === task.inboxId
    && idPattern.test(request.sourceInvocationId)
    && request.sourceInvocationId === task.sourceInvocationId
    && Number.isSafeInteger(task.deadline) && task.deadline > 0
    && Number.isSafeInteger(task.binding.version) && task.binding.version > 0
    && Number.isSafeInteger(task.binding.generation) && task.binding.generation > 0
    && Number.isSafeInteger(task.owner.principalVersion) && task.owner.principalVersion > 0
    && shaPattern.test(task.binding.authorityHash)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}

/** Read-only Delivery witness. A possibly sent maintenance notice defers restart until reconciled. */
export function inspectRestartDeliveryAuthority(databasePath: string, task: RestartTaskAuthority, requestId: string):
  'ready' | 'notice-pending' | 'invalid' {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    db.exec('PRAGMA query_only = ON')
    const row = db.prepare(`
      SELECT inbox.id AS inbox_id, inbox.event_id, inbox.status AS inbox_status,
        inbox.failure_code AS inbox_failure, binding.id AS binding_id,
        binding.version AS binding_version, binding.generation, binding.session_id,
        binding.workspace, binding.agent_preset, binding.policy_ref,
        binding.conversation_json, binding.principal_json, binding.status AS binding_status,
        active.id AS active_binding_id, owner.id AS owner_id, owner.version AS owner_version,
        owner.role, owner.status AS owner_status, lease.state AS lease_state,
        execution.principal_record_id AS execution_owner_id,
        execution.principal_version AS execution_owner_version,
        execution.binding_id AS execution_binding_id,
        execution.binding_version AS execution_binding_version,
        execution.binding_generation AS execution_binding_generation,
        execution.workspace AS execution_workspace, execution.preset AS execution_preset,
        execution.status AS execution_status
      FROM inbox_messages AS inbox
      JOIN conversation_bindings AS binding ON binding.id = inbox.binding_id
      JOIN delivery_principals AS owner ON owner.id = binding.principal_id
      LEFT JOIN conversation_bindings AS active
        ON active.conversation_hash = binding.conversation_hash AND active.status = 'active'
      LEFT JOIN delivery_session_leases AS lease ON lease.session_id = binding.session_id
      JOIN delivery_foreground_executions AS execution ON execution.inbox_id = inbox.id
      WHERE inbox.id = ?
    `).get(task.inboxId) as Record<string, unknown> | undefined
    if (row === undefined || row.inbox_id !== task.inboxId || row.event_id !== task.eventId
      || row.inbox_status !== 'processed' || row.inbox_failure !== null
      || row.binding_id !== task.binding.id || row.binding_version !== task.binding.version
      || row.generation !== task.binding.generation || row.session_id !== task.binding.sessionId
      || row.workspace !== task.binding.workspace || row.agent_preset !== task.binding.preset
      || row.policy_ref !== task.binding.policyRef
      || canonical(JSON.parse(String(row.conversation_json))) !== canonical(task.binding.conversation)
      || canonical(JSON.parse(String(row.principal_json))) !== canonical(task.binding.principal)
      || row.binding_status !== 'active' || row.active_binding_id !== task.binding.id
      || row.owner_id !== task.owner.principalRecordId || row.owner_version !== task.owner.principalVersion
      || row.role !== 'owner' || row.owner_status !== 'active'
      || row.lease_state !== 'released'
      || row.execution_owner_id !== task.owner.principalRecordId
      || row.execution_owner_version !== task.owner.principalVersion
      || row.execution_binding_id !== task.binding.id
      || row.execution_binding_version !== task.binding.version
      || row.execution_binding_generation !== task.binding.generation
      || row.execution_workspace !== task.binding.workspace || row.execution_preset !== task.binding.preset
      || row.execution_status !== 'pending') return 'invalid'
    const controls = db.prepare(`SELECT message.envelope_json FROM inbox_messages AS message
      JOIN delivery_inbox_admissions AS admission ON admission.inbox_id = message.id
      WHERE admission.admission_sequence > (SELECT admission_sequence FROM delivery_inbox_admissions WHERE inbox_id = ?)
        AND message.status != 'dead_letter' AND json_extract(message.envelope_json, '$.kind') = 'command'`)
      .all(task.inboxId) as { envelope_json: string }[]
    if (controls.some(control => {
      const envelope = JSON.parse(control.envelope_json)
      return canonical(envelope.conversation) === canonical(task.binding.conversation)
        && canonical(envelope.principal) === canonical(task.binding.principal)
        && isExactDeliveryCommand(parseDeliveryCommand(envelope), 'stop', 'new', 'clear')
    })) return 'invalid'
    const outstanding = db.prepare("SELECT count(*) AS count FROM inbox_messages WHERE status = 'claimed'")
      .get() as { count: number }
    if (outstanding.count !== 0) return 'invalid'
    const inFlightLeases = db.prepare("SELECT count(*) AS count FROM delivery_session_leases WHERE state IN ('prepared','dispatched','unknown')")
      .get() as { count: number }
    if (inFlightLeases.count !== 0) return 'invalid'
    const fence = db.prepare('SELECT request_id,source_invocation_id FROM delivery_restart_fence WHERE singleton=1')
      .get() as { request_id: string; source_invocation_id: string } | undefined
    if (fence?.request_id !== requestId || fence.source_invocation_id !== task.sourceInvocationId) return 'invalid'
    const reply = db.prepare(`SELECT id FROM outbox_messages WHERE idempotency_key IN (?, ?, ?)
      LIMIT 1`).get(`inbound:${task.inboxId}:reply`, `inbound:${task.eventId}:reply`,
      `inbound:${task.inboxId}:interrupted`)
    if (reply !== undefined) return 'invalid'
    const sending = db.prepare("SELECT count(*) AS count FROM outbox_messages WHERE status = 'attempting'").get() as { count: number }
    if (sending.count !== 0) return 'notice-pending'
    const notice = db.prepare(`SELECT status,provider_message_id FROM outbox_messages
      WHERE idempotency_key = ? AND binding_id = ?`).get(
      `inbound:${task.inboxId}:maintenance`, task.binding.id,
    ) as { status: string; provider_message_id: string | null } | undefined
    return notice !== undefined && ['accepted', 'delivered', 'read'].includes(notice.status)
      && typeof notice.provider_message_id === 'string' && notice.provider_message_id.length > 0
      ? 'ready' : 'notice-pending'
  } finally { db.close() }
}

/** Scheduled/unknown work is durable; only live dispatch/attempts prevent process replacement. */
export function inspectRestartAutomationQuiescence(databasePath: string): boolean {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    db.exec('PRAGMA query_only = ON')
    const tasks = db.prepare("SELECT count(*) AS count FROM automation_tasks WHERE status IN ('claimed','running')")
      .get() as { count: number }
    const attempts = db.prepare("SELECT count(*) AS count FROM automation_attempts WHERE status IN ('claimed','running')")
      .get() as { count: number }
    return tasks.count === 0 && attempts.count === 0
  } finally { db.close() }
}

/** A tick issues at most one command. A persisted restarting request is observation-only. */
export async function runRestartSupervisorTick(configInput: RestartSupervisorConfig,
  ledger: RestartSupervisorLedger, options: {
    system?: RestartSupervisorSystem
    now?: () => number
    holderId?: string
    signal?: AbortSignal
  } = {}): Promise<RestartSupervisorTick> {
  const config = validateRestartSupervisorConfig(configInput)
  const system = options.system ?? createSystemRestartSupervisor()
  const now = options.now ?? Date.now
  const signal = options.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const request = ledger.listRequests({ statuses: ['ready', 'restarting'], limit: 1 })[0]
  if (request === undefined) return 'idle'
  if (request.status !== 'ready' && request.status !== 'restarting') {
    throw new Error('restart-supervisor: Store returned an ineligible request')
  }
  const task = ledger.getTask(request.inboxId)
  if (task === undefined || !requestIdentityValid(request, task) || task.deadline <= now()) {
    ledger.fail(request.id, 'restart-task-invalid-or-expired')
    return 'failed'
  }
  if (await system.transactionExists(config.dshHome)) return 'deferred'
  return await system.withLock(config.dshHome, async () => {
      signal.throwIfAborted()
      if (await system.transactionExists(config.dshHome)) return 'deferred'
      const authority = inspectRestartDeliveryAuthority(config.deliveryDatabasePath, task, request.id)
      if (authority === 'notice-pending') return 'deferred'
      if (authority !== 'ready') {
        ledger.fail(request.id, 'restart-owner-or-drain-changed')
        return 'failed'
      }
      if (!inspectRestartAutomationQuiescence(config.automationDatabasePath)
        || !await system.authority(config, task)) {
        ledger.fail(request.id, 'restart-policy-or-code-changed')
        return 'failed'
      }
      const unit = await system.unit(config.unit)
      if (await system.unitDigest(unit.fragmentPath) !== config.expectedUnitDigest) {
        ledger.fail(request.id, 'restart-unit-drift')
        return 'failed'
      }
      const observationStartedAt = request.status === 'restarting' ? request.updatedAt : now()
      if (request.status === 'ready' && unit.invocationId === request.sourceInvocationId) {
        if (!unit.active || unit.mainPid < 1) return 'deferred'
        if (ledger.countDispatchedSince(Math.max(0, now() - config.windowMs)) >= config.maxRestarts) {
          ledger.fail(request.id, 'restart-budget-exhausted')
          return 'failed'
        }
        // SQLite CAS commits before crossing the OS boundary. An uncertain
        // subprocess result never grants another restart for this operation.
        const claimed = ledger.claimRestart(request.id, {
          holderId: options.holderId ?? randomUUID(), invocationId: unit.invocationId,
        })
        if (!claimed) return 'deferred'
        try { await system.restart(config.unit, signal) } catch { /* Outcome may be unknown; observe only. */ }
      }
      const deadline = Math.min(task.deadline, observationStartedAt + config.readyTimeoutMs)
      let stableSince: number | undefined
      let stablePid: number | undefined
      let stableInvocation: string | undefined
      while (now() < deadline) {
        signal.throwIfAborted()
        const current = await system.unit(config.unit)
        if (current.active && current.mainPid > 0 && idPattern.test(current.invocationId)
          && current.invocationId !== request.sourceInvocationId
          && await system.ready(config.unit, current.invocationId)) {
          if (stablePid !== current.mainPid || stableInvocation !== current.invocationId) {
            stableSince = undefined
          }
          stablePid = current.mainPid
          stableInvocation = current.invocationId
          stableSince ??= now()
          if (now() - stableSince >= config.stableWindowMs) {
            if (now() >= task.deadline) {
              ledger.fail(request.id, 'restart-task-deadline-expired')
              return 'failed'
            }
            if (inspectRestartDeliveryAuthority(config.deliveryDatabasePath, task, request.id) !== 'ready'
              || !inspectRestartAutomationQuiescence(config.automationDatabasePath)
              || !await system.authority(config, task)) {
              ledger.fail(request.id, 'restart-owner-or-notice-changed')
              return 'failed'
            }
            if (await system.unitDigest(current.fragmentPath) !== config.expectedUnitDigest) {
              ledger.fail(request.id, 'restart-unit-drift')
              return 'failed'
            }
            ledger.markRestarted(request.id, { invocationId: current.invocationId })
            return 'restarted'
          }
        } else { stableSince = undefined; stablePid = undefined; stableInvocation = undefined }
        await system.sleep(Math.min(1_000, deadline - now()), signal)
      }
      ledger.fail(request.id, 'restart-outcome-unknown')
      return 'failed'
  }) ?? 'deferred'
}

/** Lock before opening either journal. The installer may be replacing the entire Home. */
export async function runLockedRestartSupervisorTick(configInput: RestartSupervisorConfig,
  openLedger: () => RestartSupervisorLedgerHandle, options: {
    system?: RestartSupervisorSystem
    now?: () => number
    holderId?: string
    signal?: AbortSignal
  } = {}): Promise<RestartSupervisorTick> {
  const config = validateRestartSupervisorConfig(configInput)
  const system = options.system ?? createSystemRestartSupervisor()
  return await system.withLock(config.dshHome, async () => {
    if (await system.transactionExists(config.dshHome)) return 'deferred'
    const ledger = openLedger()
    try {
      const held: RestartSupervisorSystem = {
        ...system,
        withLock: async (_home, task) => task(),
      }
      return await runRestartSupervisorTick(config, ledger, { ...options, system: held })
    } finally { ledger.close() }
  }) ?? 'deferred'
}

async function command(executable: string, args: readonly string[], signal: AbortSignal,
  timeoutMs = 15_000): Promise<string> {
  signal.throwIfAborted()
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C',
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtimeDirectory}/bus`,
      XDG_RUNTIME_DIR: runtimeDirectory } })
  const output: Buffer[] = []
  let size = 0
  const abort = () => child.kill('SIGKILL')
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  const closed = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', value => resolve(value ?? 1))
  })
  try {
    for await (const chunk of child.stdout) {
      size += chunk.length
      if (size > 262_144) { abort(); throw new Error('restart-supervisor: command output too large') }
      output.push(chunk)
    }
    const code = await closed
    if (code !== 0) throw new Error('restart-supervisor: command failed')
    return Buffer.concat(output).toString('utf8')
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
}

function parseSystemctlState(source: string, expectedUnit: string): RestartUnitState {
  const fields = new Map<string, string>()
  for (const line of source.trim().split('\n')) {
    const separator = line.indexOf('=')
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1))
  }
  const invocationId = fields.get('InvocationID') ?? ''
  const mainPid = Number(fields.get('MainPID'))
  const fragmentPath = fields.get('FragmentPath') ?? ''
  if (fields.get('Id') !== expectedUnit || fields.get('LoadState') !== 'loaded'
    || invocationId !== '' && !idPattern.test(invocationId)
    || !Number.isSafeInteger(mainPid) || mainPid < 0
    || !isAbsolute(fragmentPath)) throw new Error('restart-supervisor: invalid service identity')
  return { invocationId, mainPid, fragmentPath,
    active: fields.get('ActiveState') === 'active' && fields.get('SubState') === 'running' }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

async function pinnedDigest(path: string, maxSize: number, allowEmpty = false): Promise<{ digest: string; source: Buffer }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat(), named = await lstat(path)
    if (!before.isFile() || !named.isFile() || named.isSymbolicLink()
      || before.uid !== process.getuid?.() || before.dev !== named.dev || before.ino !== named.ino
      || before.mode & 0o022 || !allowEmpty && before.size < 1 || before.size > maxSize) {
      throw new Error('restart-supervisor: unsafe pinned file')
    }
    const source = await handle.readFile()
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('restart-supervisor: pinned file changed while reading')
    }
    return { digest: createHash('sha256').update(source).digest('hex'), source }
  } finally { await handle.close() }
}

async function hostCodeMatches(config: RestartSupervisorConfig): Promise<boolean> {
  const binding = await pinnedDigest(join(config.dshHome, '.dsh-rsi-host.json'), 16_384)
  if (binding.digest !== config.hostBindingDigest) return false
  const bound = JSON.parse(binding.source.toString('utf8')) as Record<string, unknown>
  if (bound.schemaVersion !== 1 || typeof bound.cacheRoot !== 'string'
    || !isAbsolute(bound.cacheRoot) || resolve(bound.cacheRoot) !== bound.cacheRoot
    || typeof bound.version !== 'string' || !/^0\.2\.[0-9]+-rc\.[0-9]+$/u.test(bound.version)
    || typeof bound.receiptDigest !== 'string' || !shaPattern.test(bound.receiptDigest)) return false
  const hostRoot = join(bound.cacheRoot, bound.version)
  if (hostRoot !== dirname(config.hostReceiptPath) || await realpath(hostRoot) !== hostRoot) return false
  const source = await pinnedDigest(config.hostReceiptPath, 16_777_216)
  if (source.digest !== config.hostReceiptSourceDigest) return false
  const receipt = JSON.parse(source.source.toString('utf8')) as {
    schemaVersion?: number; version?: string; entries?: Array<{
      path?: string; type?: string; target?: string; sha256?: string
    }>
  }
  if (receipt.schemaVersion !== 1 || receipt.version !== bound.version
    || !Array.isArray(receipt.entries) || receipt.entries.length < 2 || receipt.entries.length > 150_000
    || createHash('sha256').update(JSON.stringify(receipt)).digest('hex') !== bound.receiptDigest) return false
  const executable = join(hostRoot, 'node_modules', '.bin', 'dsh')
  const link = receipt.entries.find(entry => entry.path === 'node_modules/.bin/dsh')
  if (link?.type !== 'link' || typeof link.target !== 'string'
    || await readlink(executable) !== link.target
    || !(await realpath(executable)).startsWith(hostRoot + sep)) return false
  for (const entry of receipt.entries) {
    if (entry.type !== 'link') continue
    if (typeof entry.path !== 'string' || !/^[A-Za-z0-9_./+@=-]+$/u.test(entry.path)
      || entry.path.includes('..') || typeof entry.target !== 'string'
      || await readlink(join(hostRoot, entry.path)) !== entry.target) return false
  }
  const code = receipt.entries.filter(entry => entry.type === 'file'
    && typeof entry.path === 'string'
    && (/\.(?:js|mjs|cjs|node)$/u.test(entry.path) || entry.path.endsWith('/package.json')))
  if (code.length < 2 || code.length > 30_000) return false
  for (let index = 0; index < code.length; index += 64) {
    const valid = await Promise.all(code.slice(index, index + 64).map(async entry => {
      if (typeof entry.path !== 'string' || !/^[A-Za-z0-9_./+@=-]+$/u.test(entry.path)
        || entry.path.includes('..') || typeof entry.sha256 !== 'string' || !shaPattern.test(entry.sha256)) return false
      const path = join(hostRoot, entry.path)
      return (await realpath(path)).startsWith(hostRoot + sep)
        && (await pinnedDigest(path, 16_777_216, true)).digest === entry.sha256
    }))
    if (valid.some(value => !value)) return false
  }
  return true
}

/** Use the installed Policy's pure evaluator after verifying its frozen cohort bytes. */
export async function inspectRestartPolicyAndCode(config: RestartSupervisorConfig,
  task: RestartTaskAuthority): Promise<boolean> {
  try {
    const receiptPath = join(config.dshHome, 'rsi-local-cohorts', config.profile, 'receipt.json')
    const patchPath = join(config.dshHome, 'profiles', config.profile, 'cordis.patch.yml')
    const [receipt, patch] = await Promise.all([
      pinnedDigest(receiptPath, 2_000_000), pinnedDigest(patchPath, 2_000_000),
    ])
    if (receipt.digest !== config.cohortReceiptDigest || patch.digest !== config.profilePatchDigest) return false
    const cohort = JSON.parse(receipt.source.toString('utf8')) as Record<string, unknown>
    if (cohort.sourceCommit !== config.sourceCommit
      || cohort.root !== join(config.dshHome, 'rsi-local-cohorts', config.profile)
      || !Array.isArray(cohort.packages)) return false
    for (const file of config.trustedFiles) {
      const result = await pinnedDigest(file.path, 2_000_000)
      if (result.digest !== file.digest) return false
    }
    if (!await hostCodeMatches(config)) return false
    const db = new DatabaseSync(config.policyDatabasePath, { readOnly: true })
    let emergency: { enabled: number } | undefined
    try {
      db.exec('PRAGMA query_only = ON')
      emergency = db.prepare('SELECT enabled FROM emergency_state WHERE singleton=1').get() as
        { enabled: number } | undefined
    } finally { db.close() }
    if (emergency !== undefined && emergency.enabled !== 0) return false
    const evaluator = await import(pathToFileURL(config.policyEvaluatorPath).href) as {
      compilePolicy?: (rules: readonly Record<string, unknown>[]) => unknown
      evaluatePolicy?: (policy: unknown, request: unknown) => { effect?: string }
    }
    if (typeof evaluator.compilePolicy !== 'function' || typeof evaluator.evaluatePolicy !== 'function') return false
    const principal = [task.binding.principal.channel, task.binding.principal.account,
      task.binding.principal.tenant, task.binding.principal.user].map(encodeURIComponent).join('/')
    const decision = evaluator.evaluatePolicy(evaluator.compilePolicy(config.policyRules), {
      subject: { kind: 'agent', id: task.binding.preset, workspace: task.binding.workspace, principal },
      action: 'maintenance.restart', resource: { kind: 'message', id: `maintenance:${config.restartOwnerRouteId}` },
      context: { initiator: 'external' },
    })
    return decision.effect === 'allow'
  } catch { return false }
}

export function createSystemRestartSupervisor(): RestartSupervisorSystem {
  const systemctl = '/usr/bin/systemctl'
  return {
    async unit(unit) {
      const raw = await command(systemctl, ['--user', 'show', unit, '-p', 'Id', '-p', 'LoadState',
        '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'InvocationID', '-p', 'FragmentPath'],
      new AbortController().signal)
      return parseSystemctlState(raw, unit)
    },
    restart(unit, signal) { return command(systemctl, ['--user', 'restart', '--job-mode=fail', unit], signal).then(() => {}) },
    async ready(unit, invocationId) {
      let raw: string
      try {
        raw = await command('/usr/bin/journalctl', ['--user', '-u', unit,
          `_SYSTEMD_INVOCATION_ID=${invocationId}`, '--no-pager', '--output=json',
          '--grep=dsh-enhanced host ready: v1|lark-channel: connected', '-n', '256'],
        new AbortController().signal)
      } catch { return false /* journalctl exits 1 before this instance has either marker. */ }
      let hostReady = false, channelReady = false
      for (const line of raw.trim().split('\n')) {
        if (!line) continue
        const entry = JSON.parse(line) as Record<string, unknown>
        if (entry._SYSTEMD_INVOCATION_ID !== invocationId) continue
        const message = entry.MESSAGE
        if (typeof message !== 'string') continue
        if (message.includes('dsh-enhanced host ready: v1')) hostReady = true
        if (message.includes('lark-channel: connected')) channelReady = true
      }
      return hostReady && channelReady
    },
    async transactionExists(home) {
      try { await lstat(`${home}.dsh-enhanced-transaction`); return true }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    },
    async unitDigest(fragmentPath) {
      const handle = await open(fragmentPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = await handle.stat()
        const linked = await lstat(fragmentPath)
        if (!before.isFile() || !linked.isFile() || linked.isSymbolicLink()
          || before.uid !== process.getuid?.() || before.dev !== linked.dev || before.ino !== linked.ino
          || before.mode & 0o022) throw new Error('restart-supervisor: unsafe unit fragment')
        const source = await handle.readFile()
        const after = await handle.stat()
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || source.byteLength > 128_000) {
          throw new Error('restart-supervisor: unit fragment changed')
        }
        return createHash('sha256').update(source).digest('hex')
      } finally { await handle.close() }
    },
    authority: inspectRestartPolicyAndCode,
    sleep: delay,
    async withLock(home, task) {
      const physical = await realpath(home)
      if (physical !== home) throw new Error('restart-supervisor: noncanonical Home')
      const temporary = await lstat('/tmp')
      if (!temporary.isDirectory() || temporary.isSymbolicLink() || temporary.uid !== 0
        || (temporary.mode & 0o7777) !== 0o1777) throw new Error('restart-supervisor: unsafe /tmp')
      const digest = createHash('sha256').update(physical).digest('hex')
      const uid = process.getuid?.()
      if (!Number.isSafeInteger(uid)) throw new Error('restart-supervisor: missing UID')
      const lockPath = `/tmp/.dsh-enhanced-lifecycle-${uid}-${digest}.lock`
      const fd = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
      try {
        const [opened, linked] = await Promise.all([fd.stat(), lstat(lockPath)])
        if (!opened.isFile() || !linked.isFile() || linked.isSymbolicLink()
          || opened.uid !== uid || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600
          || linked.dev !== opened.dev || linked.ino !== opened.ino) {
          throw new Error('restart-supervisor: unsafe lifecycle lock')
        }
        const result = spawnSync('/usr/bin/flock', ['-n', '-E', '75', '3'], {
          stdio: ['ignore', 'ignore', 'pipe', fd.fd], encoding: 'utf8', timeout: 10_000,
          env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        })
        if (result.status === 75) return undefined
        if (result.status !== 0) throw new Error('restart-supervisor: lifecycle lock failed')
        return await task()
      } finally { await fd.close() }
    },
  }
}
