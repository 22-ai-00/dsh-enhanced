import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { basename, dirname, isAbsolute, normalize } from 'node:path'
import type { ActionGrant } from './types.js'
import { commitOnGitHub, inspectGitHub } from './github.js'
import {
  brokerAdminRequestDigest,
  canonicalBrokerJson,
  normalizeBrokerInspectObservation,
  type BrokerAdminRequest,
  type BrokerAdminResponseUnsigned,
  type BrokerClientRequest,
  type BrokerCommitPayload,
  type BrokerInspectPayload,
  type BrokerInspectObservation,
  type BrokerServerResponseUnsigned,
  type BrokerSuccessResult,
} from './broker-protocol.js'
import {
  BrokerLedgerError,
  ExternalBrokerLedger,
  brokerLedgerRequestDigest,
  normalizeBrokerGrant,
  type BrokerAuthority,
  type BrokerControlMutation,
  type BrokerControlSnapshot,
  type BrokerLedgerOutcome,
  type BrokerLedgerRecord,
  type ExternalGitHubGrant,
} from './broker-ledger.js'

type BrokerResponse = Pick<BrokerServerResponseUnsigned, 'status' | 'dispatched' | 'result' | 'error' | 'completedAt'>
type BrokerAdminResponse = Pick<BrokerAdminResponseUnsigned, 'status' | 'state' | 'error' | 'completedAt'>
type GitHubTransport = typeof commitOnGitHub
type InspectTransport = typeof inspectGitHub
const FORCED_TEARDOWN_GRACE_MS = 100

export interface BrokerProtectedFileCredential {
  id: string
  provider: 'linux-protected-file'
  path: string
  maxLeaseMs: number
}

export interface ExternalBrokerCoreConfig {
  instanceId: string
  statePath: string
  credentials: readonly BrokerProtectedFileCredential[]
  grants: readonly ExternalGitHubGrant[]
  policyEpoch: number
  expectedGeneration?: number
  controllerTtlMs?: number
  credentialMaxBytes?: number
  now?: () => number
}

export interface ExternalBrokerCoreTransports {
  commit?: GitHubTransport
  inspect?: InspectTransport
  /** Deterministic race hook used only by filesystem-boundary tests. */
  beforeCredentialOpen?: () => void | Promise<void>
}

export function normalizeExternalBrokerCoreConfig(value: unknown): ExternalBrokerCoreConfig {
  if (!plain(value) || Object.keys(value).some(key => !['instanceId', 'statePath', 'credentials', 'grants', 'policyEpoch', 'expectedGeneration', 'controllerTtlMs', 'credentialMaxBytes', 'now'].includes(key))) fail('request-invalid')
  const instanceId = text(value.instanceId, 128), statePath = text(value.statePath, 1_024), policyEpoch = integer(value.policyEpoch, 0)
  if (!isAbsolute(statePath) || normalize(statePath) !== statePath || !Array.isArray(value.credentials) || !Array.isArray(value.grants)) fail('request-invalid')
  const credentials = value.credentials.map(normalizeCredential)
  if (credentials.length > 256 || new Set(credentials.map(item => item.id)).size !== credentials.length) fail('request-invalid')
  const grants = value.grants.map(normalizeBrokerGrant)
  if (grants.length > 1_000 || new Set(grants.map(item => item.id)).size !== grants.length || grants.some(grant => !credentials.some(item => item.id === grant.credentialId))) fail('request-invalid')
  return Object.freeze({ instanceId, statePath, credentials: Object.freeze(credentials), grants: Object.freeze(grants), policyEpoch,
    ...(value.expectedGeneration === undefined ? {} : { expectedGeneration: integer(value.expectedGeneration, 1) }),
    ...(value.controllerTtlMs === undefined ? {} : { controllerTtlMs: integer(value.controllerTtlMs, 1_000, 300_000) }),
    ...(value.credentialMaxBytes === undefined ? {} : { credentialMaxBytes: integer(value.credentialMaxBytes, 1, 65_536) }),
    ...(value.now === undefined ? {} : typeof value.now === 'function' ? { now: value.now as () => number } : fail('request-invalid')) })
}

export class BrokerCoreError extends Error {
  constructor(readonly code: 'aborted' | 'broker-draining' | 'credential-unavailable' | 'deadline-exceeded' | 'grant-invalid' | 'internal-error' | 'policy-changed' | 'request-conflict' | 'request-invalid' | 'transport-failed' | 'unsupported-operation', readonly dispatched = false) {
    super('assistant-actions external broker: ' + code)
    this.name = 'BrokerCoreError'
  }
}

function fail(code: BrokerCoreError['code'], dispatched = false): never { throw new BrokerCoreError(code, dispatched) }
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype }
function text(value: unknown, maximum = 4_096): string { if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\p{Cc}]/u.test(value)) fail('request-invalid'); return value }
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail('request-invalid'); return value }
function safeCode(error: unknown): BrokerCoreError['code'] {
  if (error instanceof BrokerLedgerError) {
    if (error.code === 'conflict') return 'request-conflict'
    if (error.code === 'grant' || error.code === 'limit') return 'grant-invalid'
    if (error.code === 'stopped') return 'broker-draining'
    if (error.code === 'controller') return 'policy-changed'
    if (error.code === 'invalid-input') return 'request-invalid'
  }
  return 'internal-error'
}

async function settleWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  if (promises.length === 0) return true
  return await new Promise<boolean>(resolve => {
    let settled = false
    const finish = (value: boolean): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(value) }
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs)); timer.unref()
    void Promise.allSettled(promises).then(() => finish(true))
  })
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => { if (settled) return; settled = true; signal.removeEventListener('abort', onAbort); callback() }
    const onAbort = (): void => finish(() => reject(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) { onAbort(); return }
    operation.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
  })
}

function normalizeCredential(value: unknown): BrokerProtectedFileCredential {
  if (!plain(value) || Object.keys(value).length !== 4 || Object.keys(value).some(key => !['id', 'provider', 'path', 'maxLeaseMs'].includes(key)) || value.provider !== 'linux-protected-file') fail('request-invalid')
  const path = text(value.path, 1_024)
  if (process.platform !== 'linux' || !isAbsolute(path) || normalize(path) !== path || path === '/') fail('request-invalid')
  return Object.freeze({ id: text(value.id, 128), provider: 'linux-protected-file', path, maxLeaseMs: integer(value.maxLeaseMs, 1_000, 86_400_000) })
}

function sameNode(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode && left.nlink === right.nlink }
async function safeCredentialAncestors(value: string, uid: number, gid: number): Promise<void> {
  let cursor = value, leaf = true
  for (;;) {
    const [canonical, stat] = await Promise.all([realpath(cursor), lstat(cursor, { bigint: true })])
    const mode = Number(stat.mode & 0o7777n), owner = Number(stat.uid), group = Number(stat.gid), stickyRoot = owner === 0 && (mode & 0o1000) !== 0 && (mode & 0o022) !== 0
    if (canonical !== cursor || stat.isSymbolicLink() || !stat.isDirectory() || !stickyRoot && (mode & 0o022) !== 0 || leaf && (owner !== uid || group !== gid || mode !== 0o700)) fail('credential-unavailable')
    const parent = dirname(cursor); if (parent === cursor) return
    cursor = parent; leaf = false
  }
}
async function readProtectedCredential(credential: BrokerProtectedFileCredential, maximum: number, beforeOpen?: () => void | Promise<void>): Promise<string> {
  const uid = process.geteuid?.(), gid = process.getegid?.()
  if (process.platform !== 'linux' || uid === undefined || gid === undefined) fail('credential-unavailable')
  const parentPath = dirname(credential.path)
  try { await safeCredentialAncestors(parentPath, uid, gid) } catch { return fail('credential-unavailable') }
  let parent
  try { parent = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) } catch { return fail('credential-unavailable') }
  let descriptor
  try {
    const parentBefore = await parent.stat({ bigint: true }), visibleParent = await lstat(parentPath, { bigint: true })
    if (!parentBefore.isDirectory() || !sameNode(parentBefore, visibleParent)) fail('credential-unavailable')
    await beforeOpen?.()
    descriptor = await open('/proc/self/fd/' + parent.fd + '/' + basename(credential.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const pathParent = await lstat(parentPath, { bigint: true })
    if (!sameNode(parentBefore, await parent.stat({ bigint: true })) || !sameNode(parentBefore, pathParent)) fail('credential-unavailable')
  } catch { await descriptor?.close().catch(() => undefined); await parent.close().catch(() => undefined); return fail('credential-unavailable') }
  const bytes = Buffer.alloc(maximum + 1)
  try {
    const before = await descriptor.stat({ bigint: true })
    if (!before.isFile() || before.uid !== BigInt(uid) || before.nlink !== 1n || Number(before.mode & 0o7777n) !== 0o600 || before.size > BigInt(maximum)) fail('credential-unavailable')
    let offset = 0
    while (offset < bytes.length) { const read = await descriptor.read(bytes, offset, bytes.length - offset, offset); if (read.bytesRead === 0) break; offset += read.bytesRead }
    const after = await descriptor.stat({ bigint: true }), visible = await lstat(credential.path, { bigint: true }), parentAfter = await parent.stat({ bigint: true }), visibleParent = await lstat(parentPath, { bigint: true })
    if (offset > maximum || BigInt(offset) !== after.size || !sameNode(before, after) || !sameNode(after, visible) || !sameNode(parentAfter, visibleParent) || !after.isFile()) fail('credential-unavailable')
    await safeCredentialAncestors(parentPath, uid, gid)
    const token = bytes.subarray(0, offset).toString('utf8').replace(/[\r\n]+$/u, '')
    if (!token || token.includes('\0') || Buffer.from(token, 'utf8').length > maximum || !/^[\x21-\x7e]+$/u.test(token)) fail('credential-unavailable')
    return token
  } catch (error) { if (error instanceof BrokerCoreError) throw error; return fail('credential-unavailable') }
  finally { bytes.fill(0); await descriptor.close().catch(() => undefined); await parent.close().catch(() => undefined) }
}

function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return secret.length > 0 && value.includes(secret)
  if (Array.isArray(value)) return value.some(item => containsSecret(item, secret))
  if (plain(value)) return Object.entries(value).some(([key, item]) => key.includes(secret) || containsSecret(item, secret))
  return false
}
function containsCredentialShape(value: unknown): boolean {
  if (typeof value === 'string') return /(?:\bbearer\s+[A-Za-z0-9._~-]+|\bbasic\s+[A-Za-z0-9+/=]+|github_pat_|gh[pousr]_|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bauthorization\s*:|\bcookie\s*:)/iu.test(value)
  if (Array.isArray(value)) return value.some(containsCredentialShape)
  if (plain(value)) return Object.entries(value).some(([key, item]) => /^(?:authorization|cookie|password|secret|token)$/iu.test(key) || containsCredentialShape(item))
  return false
}

function inspectProjection(payload: BrokerInspectPayload, observed: unknown, grant: ExternalGitHubGrant): BrokerInspectObservation | undefined {
  try {
    // The protocol normalizer is the single wire DTO boundary.  In particular,
    // it binds PR number, head, repository, and base branch before an untrusted
    // GitHub response can enter the signed broker result.
    return normalizeBrokerInspectObservation(payload, observed, grant.destination)
  } catch { return undefined }
}

function githubGrant(grant: ExternalGitHubGrant): ActionGrant {
  return Object.freeze({ id: grant.id, revision: grant.revision, principalDigest: grant.owner.principalDigest, principalRecordId: grant.owner.principalRecordId, principalVersion: grant.owner.principalVersion, workspace: grant.owner.workspace, agentPreset: grant.owner.preset, repository: grant.destination.repository, branch: grant.destination.branch, paths: [...grant.destination.paths], credentialHandle: grant.credentialId, expiresAt: grant.expiresAt, maxActions: grant.maxActions, maxTotalBytes: grant.maxTotalBytes,
    ...(grant.destination.baseBranch === undefined ? {} : { repoWorkflow: Object.freeze({ baseBranch: grant.destination.baseBranch, allowBranchCreate: false, allowPullRequest: false }) }) })
}

function response(record: BrokerLedgerRecord): BrokerResponse {
  const value = record.outcome
  if (!value) return { status: 'unknown', dispatched: record.status === 'dispatched', result: null, error: { code: 'transport-failed' }, completedAt: Date.now() }
  return { status: value.status, dispatched: value.dispatched, result: value.result, error: value.error, completedAt: value.completedAt }
}

export class ExternalBrokerCore {
  readonly #ledger: ExternalBrokerLedger
  readonly #authority: BrokerAuthority
  readonly #credentials: ReadonlyMap<string, BrokerProtectedFileCredential>
  readonly #commit: GitHubTransport
  readonly #inspect: InspectTransport
  readonly #beforeCredentialOpen: (() => void | Promise<void>) | undefined
  readonly #now: () => number
  readonly #credentialMaxBytes: number
  readonly #pending = new Map<string, { controller: AbortController; done: Promise<BrokerResponse> }>()
  readonly #renewal: ReturnType<typeof setInterval>
  #active = true
  #closing: Promise<void> | undefined

  constructor(input: ExternalBrokerCoreConfig, transports: ExternalBrokerCoreTransports = {}) {
    const config = normalizeExternalBrokerCoreConfig(input)
    const { instanceId, statePath, policyEpoch } = config
    const controllerTtlMs = config.controllerTtlMs ?? 30_000
    this.#credentialMaxBytes = config.credentialMaxBytes ?? 8_192
    this.#now = config.now ?? Date.now
    const credentials = [...config.credentials]
    this.#credentials = new Map(credentials.map(item => [item.id, item]))
    const grants = [...config.grants]
    this.#commit = transports.commit ?? commitOnGitHub
    this.#inspect = transports.inspect ?? inspectGitHub
    this.#beforeCredentialOpen = transports.beforeCredentialOpen
    this.#ledger = new ExternalBrokerLedger(statePath, instanceId, { now: this.#now })
    try {
      this.#authority = this.#ledger.claimController(randomUUID(), controllerTtlMs)
      if (config.expectedGeneration !== undefined && this.#authority.generation !== config.expectedGeneration) fail('policy-changed')
      this.#ledger.syncGrants(grants, policyEpoch, this.#authority)
    } catch (error) { this.#ledger.close(); throw error }
    this.#renewal = setInterval(() => {
      try { this.#ledger.renewController(this.#authority, controllerTtlMs) } catch { this.#active = false; for (const pending of this.#pending.values()) pending.controller.abort() }
    }, Math.max(100, Math.floor(controllerTtlMs / 3)))
    this.#renewal.unref()
  }

  snapshot(): BrokerControlSnapshot { return this.#ledger.snapshot() }

  execute = async (request: BrokerClientRequest, signal: AbortSignal): Promise<BrokerResponse> => {
    if (!this.#active || signal.aborted) fail('aborted')
    let prepared
    try { prepared = this.#ledger.prepare(request, this.#authority) } catch (error) { return fail(safeCode(error)) }
    if (!prepared.created) {
      if (prepared.record.outcome) return response(prepared.record)
      const pending = this.#pending.get(prepared.record.actionId)
      return pending ? await pending.done : fail('request-conflict', prepared.record.status === 'dispatched')
    }
    const controller = new AbortController()
    const done = this.#executePrepared(request, prepared.record, AbortSignal.any([signal, controller.signal]))
    this.#pending.set(prepared.record.actionId, { controller, done })
    try { return await done } finally { this.#pending.delete(prepared.record.actionId) }
  }

  async #executePrepared(request: BrokerClientRequest, initial: BrokerLedgerRecord, signal: AbortSignal): Promise<BrokerResponse> {
    let record = initial
    const requestDigestValue = brokerLedgerRequestDigest(request)
    try {
      const grant = this.#ledger.grant(record.grantId), credential = grant && this.#credentials.get(grant.credentialId)
      if (!grant || !credential) return response(this.#ledger.failPrepared(record.actionId, record.version, requestDigestValue, 'credential-unavailable', this.#authority))
      if (signal.aborted || request.deadline <= this.#now()) return response(this.#ledger.failPrepared(record.actionId, record.version, requestDigestValue, 'deadline-exceeded', this.#authority))
      const token = await readProtectedCredential(credential, this.#credentialMaxBytes, this.#beforeCredentialOpen)
      const secrets: string[] = []
      try { for (const configured of this.#credentials.values()) secrets.push(configured.id === credential.id ? token : await readProtectedCredential(configured, this.#credentialMaxBytes, this.#beforeCredentialOpen)) } catch { return response(this.#ledger.failPrepared(record.actionId, record.version, requestDigestValue, 'credential-unavailable', this.#authority)) }
      if (secrets.some(secret => containsSecret(request.payload, secret)) || containsCredentialShape(request.payload)) return response(this.#ledger.failPrepared(record.actionId, record.version, requestDigestValue, 'request-invalid', this.#authority))
      const leaseExpiresAt = Math.min(request.deadline, grant.expiresAt, this.#now() + credential.maxLeaseMs)
      record = this.#ledger.dispatch(record.actionId, record.version, requestDigestValue, credential.id, leaseExpiresAt, this.#authority)
      const deadline = AbortSignal.timeout(Math.max(1, leaseExpiresAt - this.#now()))
      const combined = AbortSignal.any([signal, deadline])
      let result: BrokerSuccessResult | null = null
      if (request.operation === 'commit') {
        const payload = request.payload as BrokerCommitPayload
        const commit = await abortable(this.#commit({ actionId: request.actionId, grant: githubGrant(grant), request: { grantId: grant.id, idempotencyKey: request.actionId, expectedHeadOid: payload.expectedHeadOid, headline: payload.headline, files: payload.files.map(file => ({ ...file })) }, token, signal: combined }), combined)
        if (commit.status === 'succeeded' && commit.commitOid) result = { operation: 'commit', repository: grant.destination.repository, branch: grant.destination.branch, parentOid: payload.expectedHeadOid, commitOid: commit.commitOid }
      } else {
        const payload = request.payload as BrokerInspectPayload
        const inspected = await abortable(this.#inspect({ grant: githubGrant(grant), kind: payload.kind, ...(payload.path === undefined ? {} : { path: payload.path }), ...(payload.pullRequestNumber === undefined ? {} : { pullRequestNumber: payload.pullRequestNumber }), token, signal: combined }), combined)
        if (inspected) {
          const projected = inspectProjection(payload, inspected.observed, grant)
          if (projected && !secrets.some(secret => containsSecret(projected, secret)) && !containsCredentialShape(projected)) { const canonical = canonicalBrokerJson(projected); result = { operation: 'inspect', repository: grant.destination.repository, branch: grant.destination.branch, kind: payload.kind, observed: projected, observedDigest: createHash('sha256').update(canonical).digest('hex') } }
        }
      }
      if (combined.aborted || signal.aborted || this.#now() >= leaseExpiresAt) return response(this.#settle(record, requestDigestValue, null, 'aborted'))
      return response(result ? this.#ledger.settle(record.actionId, record.version, requestDigestValue, { status: 'succeeded', dispatched: true, result, error: null, completedAt: Math.max(1, this.#now()) }, this.#authority) : this.#settle(record, requestDigestValue, null, 'transport-failed'))
    } catch (error) {
      if (record.status === 'dispatched') {
        try { return response(this.#settle(record, requestDigestValue, null, error instanceof BrokerCoreError ? error.code : 'transport-failed')) } catch { return fail('transport-failed', true) }
      }
      try { return response(this.#ledger.failPrepared(record.actionId, record.version, requestDigestValue, error instanceof BrokerCoreError ? error.code : safeCode(error), this.#authority)) } catch { return fail(safeCode(error)) }
    }
  }

  #settle(record: BrokerLedgerRecord, requestDigestValue: string, result: BrokerSuccessResult | null, code: string): BrokerLedgerRecord {
    const value: BrokerLedgerOutcome = result
      ? { status: 'succeeded', dispatched: true, result, error: null, completedAt: Math.max(1, this.#now()) }
      : { status: 'unknown', dispatched: true, result: null, error: { code }, completedAt: Math.max(1, this.#now()) }
    return this.#ledger.settle(record.actionId, record.version, requestDigestValue, value, this.#authority)
  }

  admin = async (request: BrokerAdminRequest, signal: AbortSignal): Promise<BrokerAdminResponse> => {
    if (signal.aborted) fail('aborted')
    // The signed request digest is deliberately evaluated even for status so
    // malformed or secret-bearing admin input cannot reach the control plane.
    const adminDigest = brokerAdminRequestDigest(request)
    try {
      let mutation: BrokerControlMutation | undefined
      if (request.operation === 'stop') {
        const body = request.body as Extract<import('./broker-protocol.js').BrokerAdminIntent, { operation: 'stop' }>['body']
        mutation = this.#ledger.applyAdminMutation({ adminKeyId: request.adminKeyId, nonce: request.nonce, requestDigest: adminDigest, expiresAt: request.deadline, mutation: { operation: 'stop', expectedControlVersion: body.expectedControlVersion, reason: body.reason }, authority: this.#authority })
      }
      else if (request.operation === 'resume') {
        const body = request.body as Extract<import('./broker-protocol.js').BrokerAdminIntent, { operation: 'resume' }>['body']
        mutation = this.#ledger.applyAdminMutation({ adminKeyId: request.adminKeyId, nonce: request.nonce, requestDigest: adminDigest, expiresAt: request.deadline, mutation: { operation: 'resume', expectedControlVersion: body.expectedControlVersion, expectedGeneration: body.expectedGeneration, reason: 'operator-resume' }, authority: this.#authority })
      } else if (request.operation === 'revoke') {
        const body = request.body as Extract<import('./broker-protocol.js').BrokerAdminIntent, { operation: 'revoke' }>['body']
        mutation = this.#ledger.applyAdminMutation({ adminKeyId: request.adminKeyId, nonce: request.nonce, requestDigest: adminDigest, expiresAt: request.deadline, mutation: { operation: 'revoke', expectedControlVersion: body.expectedControlVersion, grantId: body.grantId, grantRevision: body.grantRevision, grantDigest: body.grantDigest, policyEpoch: body.policyEpoch, emergencyEpoch: body.emergencyEpoch, reason: body.reason }, authority: this.#authority })
      } else this.#ledger.consumeAdminNonce(request.adminKeyId, request.nonce, adminDigest, request.deadline, this.#authority)
      if (mutation) for (const actionId of mutation.abortActionIds) this.#pending.get(actionId)?.controller.abort()
      const state = this.#adminState()
      return { status: 'succeeded', state, error: null, completedAt: Math.max(1, this.#now()) }
    } catch (error) { return { status: 'failed', state: this.#adminState(), error: { code: safeCode(error) }, completedAt: Math.max(1, this.#now()) } }
  }

  #adminState(): BrokerAdminResponse['state'] {
    const snapshot = this.#ledger.snapshot()
    return { admission: snapshot.stopped ? 'stopped' : snapshot.draining ? 'draining' : 'accepting', generation: snapshot.generation, controlVersion: snapshot.controlVersion, activeRequests: this.#pending.size, revocationEpoch: snapshot.emergencyEpoch }
  }
  beginDrain = (reason: 'sigterm' | 'sigint' | 'admin' | 'lifecycle' = 'lifecycle'): void => { if (!this.#active) return; this.#ledger.beginDrain(this.#ledger.snapshot().controlVersion, reason, this.#authority) }
  drain = async (deadlineAt: number): Promise<void> => {
    integer(deadlineAt, 1)
    if (this.#pending.size === 0) return
    const pending = [...this.#pending.values()]
    if (await settleWithin(pending.map(value => value.done), Math.max(1, deadlineAt - this.#now()))) return
    for (const pending of this.#pending.values()) pending.controller.abort()
    try { this.#ledger.terminalizeActive('drain-deadline', this.#authority) } catch { /* Startup recovery keeps no-replay if the fence was lost. */ }
    await settleWithin(pending.map(value => value.done), FORCED_TEARDOWN_GRACE_MS)
  }
  close = (): Promise<void> => this.#closing ??= this.#close()
  async #close(): Promise<void> {
    this.#active = false
    clearInterval(this.#renewal)
    const pending = [...this.#pending.values()]
    for (const pending of this.#pending.values()) pending.controller.abort()
    try { this.#ledger.terminalizeActive('core-close', this.#authority) } catch { /* A successor will recover if the fence was lost. */ }
    await settleWithin(pending.map(value => value.done), FORCED_TEARDOWN_GRACE_MS)
    try { if (this.#ledger.hasController(this.#authority)) this.#ledger.releaseController(this.#authority) } finally { this.#ledger.close() }
  }
}

export function createExternalBrokerCore(config: ExternalBrokerCoreConfig, transports: ExternalBrokerCoreTransports = {}): ExternalBrokerCore { return new ExternalBrokerCore(config, transports) }
