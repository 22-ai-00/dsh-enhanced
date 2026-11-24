import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'
import {
  BrokerCredentialError,
  normalizeBrokerCredentialSpec,
  readBrokerCredential,
  type BrokerCredentialReadHooks,
  type BrokerCredentialSpec,
  type BrokerLinuxProtectedFileCredential,
} from './broker-credentials.js'
import type { WindowsAclInspection } from './broker-peer-windows.js'
import {
  BrokerLedgerError,
  ExternalBrokerLedger,
  brokerLedgerRequestDigest,
  normalizeActionGrant,
  normalizeBrokerGrant,
  type AnyExternalBrokerGrant,
  type BrokerAuthority,
  type BrokerControlMutation,
  type BrokerControlSnapshot,
  type BrokerLedgerOutcome,
  type BrokerLedgerRecord,
  type ExternalActionGrant,
  type ExternalGitHubGrant,
} from './broker-ledger.js'
import {
  canonicalBrokerJson,
  normalizeBrokerInspectObservation,
  type BrokerAdminRequest,
  type BrokerAdminResponseUnsigned,
  type BrokerClientRequest,
  type BrokerCommitPayload,
  type BrokerInspectObservation,
  type BrokerInspectPayload,
  type BrokerPullRequestPayload,
  type BrokerServerResponseUnsigned,
  type BrokerSuccessResult,
} from './broker-protocol.js'
import {
  ACTION_GRANT_PROTOCOL,
  type ActionBrokerAdminRequest,
  type ActionBrokerClientRequest,
  type ActionBrokerServerResponseUnsigned,
  type ActionBrokerSuccessResult,
  type CalendarActionPayload,
  type CalendarGrantDestination,
  type CalendarRequestDestination,
  type GitHubGrantDestinationV2,
  type HttpGrantDestination,
  type HttpRequestDestination,
  type HttpRequestPayload,
  type LarkGrantDestination,
  type LarkReadPayload,
  type LarkRequestDestination,
  type LarkSendPayload,
  type ShellExecPayload,
  type ShellGrantDestination,
  type ShellRequestDestination,
} from './broker-protocol-v2.js'
import { commitOnGitHub, createPullRequestOnGitHub, inspectGitHub } from './github.js'
import { CalendarGuardError, executeCalendarGuardedAction, validateCalendarAgainstGrant, type CalendarGuardDeps } from './guards/calendar-guard.js'
import { HttpGuardError, executeHttpGuardedAction, validateHttpAgainstGrant, type HttpGuardDeps } from './guards/http-guard.js'
import { LarkGuardError, executeLarkGuardedAction, validateLarkAgainstGrant, type LarkGuardDeps } from './guards/lark-guard.js'
import { ShellGuardError, executeShellGuardedAction, validateShellAgainstGrant, type ShellGuardDeps } from './guards/shell-guard.js'
import type { ActionGrant } from './types.js'

type BrokerResponse = Pick<BrokerServerResponseUnsigned, 'status' | 'dispatched' | 'result' | 'error' | 'completedAt'>
type ActionBrokerResponse = Pick<ActionBrokerServerResponseUnsigned, 'status' | 'dispatched' | 'result' | 'error' | 'completedAt'>
type BrokerAdminResponse = Pick<BrokerAdminResponseUnsigned, 'status' | 'state' | 'error' | 'completedAt'>
type GitHubTransport = typeof commitOnGitHub
type InspectTransport = typeof inspectGitHub
type PullRequestTransport = typeof createPullRequestOnGitHub
const FORCED_TEARDOWN_GRACE_MS = 100

export type BrokerProtectedFileCredential = BrokerLinuxProtectedFileCredential

export interface ExternalBrokerCoreConfig {
  instanceId: string
  statePath: string
  credentials: readonly BrokerCredentialSpec[]
  grants: readonly ExternalGitHubGrant[]
  actionGrants?: readonly AnyExternalBrokerGrant[]
  policyEpoch: number
  expectedGeneration?: number
  controllerTtlMs?: number
  credentialMaxBytes?: number
  now?: () => number
  platform?: NodeJS.Platform
  checkWindowsAcl?: (path: string) => WindowsAclInspection | undefined
}

export interface ExternalBrokerCoreTransports {
  commit?: GitHubTransport
  inspect?: InspectTransport
  pullRequest?: PullRequestTransport
  http?: HttpGuardDeps
  lark?: LarkGuardDeps
  calendar?: CalendarGuardDeps
  shell?: ShellGuardDeps
  /** Deterministic race hook used only by filesystem-boundary tests. */
  beforeCredentialOpen?: () => void | Promise<void>
  readCredentialOverride?: BrokerCredentialReadHooks['readCredentialOverride']
  credentialCommandRunner?: BrokerCredentialReadHooks['commandRunner']
}

export function normalizeExternalBrokerCoreConfig(value: unknown): ExternalBrokerCoreConfig {
  if (!plain(value) || Object.keys(value).some(key => !['instanceId', 'statePath', 'credentials', 'grants', 'actionGrants', 'policyEpoch', 'expectedGeneration', 'controllerTtlMs', 'credentialMaxBytes', 'now', 'platform', 'checkWindowsAcl'].includes(key))) fail('request-invalid')
  const instanceId = text(value.instanceId, 128), statePath = text(value.statePath, 1_024), policyEpoch = integer(value.policyEpoch, 0)
  if ((statePath !== ':memory:' && (!isAbsolute(statePath) || normalize(statePath) !== statePath)) || !Array.isArray(value.credentials) || !Array.isArray(value.grants)) fail('request-invalid')
  if (value.actionGrants !== undefined && !Array.isArray(value.actionGrants)) fail('request-invalid')
  const platform = typeof value.platform === 'string' ? value.platform as NodeJS.Platform : process.platform
  const credentials = value.credentials.map(item => normalizeCredential(item, platform))
  if (credentials.length > 256 || new Set(credentials.map(item => item.id)).size !== credentials.length) fail('request-invalid')
  const grants = value.grants.map(grant => plain(grant) && grant.protocol === ACTION_GRANT_PROTOCOL ? normalizeActionGrant(grant) : normalizeBrokerGrant(grant))
  const actionGrants = (value.actionGrants ?? []).map(grant => plain(grant) && grant.protocol === ACTION_GRANT_PROTOCOL ? normalizeActionGrant(grant) : normalizeBrokerGrant(grant))
  const allGrants = [...grants, ...actionGrants]
  if (allGrants.length > 1_000 || new Set(allGrants.map(item => item.id)).size !== allGrants.length || allGrants.some(grant => !credentials.some(item => item.id === grant.credentialId))) fail('request-invalid')
  return Object.freeze({
    instanceId,
    statePath,
    credentials: Object.freeze(credentials),
    grants: Object.freeze(grants as readonly ExternalGitHubGrant[]),
    ...(value.actionGrants === undefined ? {} : { actionGrants: Object.freeze(actionGrants) }),
    policyEpoch,
    ...(value.expectedGeneration === undefined ? {} : { expectedGeneration: integer(value.expectedGeneration, 1) }),
    ...(value.controllerTtlMs === undefined ? {} : { controllerTtlMs: integer(value.controllerTtlMs, 1_000, 300_000) }),
    ...(value.credentialMaxBytes === undefined ? {} : { credentialMaxBytes: integer(value.credentialMaxBytes, 1, 65_536) }),
    ...(value.now === undefined ? {} : typeof value.now === 'function' ? { now: value.now as () => number } : fail('request-invalid')),
    ...(value.platform === undefined ? {} : { platform }),
    ...(value.checkWindowsAcl === undefined ? {} : typeof value.checkWindowsAcl === 'function' ? { checkWindowsAcl: value.checkWindowsAcl as (path: string) => WindowsAclInspection | undefined } : fail('request-invalid')),
  })
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
  if (error instanceof BrokerCoreError) return error.code
  if (error instanceof HttpGuardError || error instanceof LarkGuardError || error instanceof CalendarGuardError || error instanceof ShellGuardError) {
    if (error.code === 'request-invalid') return 'request-invalid'
    if (error.code === 'target-mismatch' && !error.dispatched) return 'request-invalid'
    if (error.code === 'grant-invalid') return 'grant-invalid'
    if (error.code === 'aborted') return 'aborted'
    if (error.code === 'deadline-exceeded') return 'deadline-exceeded'
    return 'transport-failed'
  }
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

function normalizeCredential(value: unknown, platform: NodeJS.Platform): BrokerCredentialSpec {
  try {
    return normalizeBrokerCredentialSpec(value, platform)
  } catch (error) {
    if (error instanceof BrokerCredentialError) fail(error.code)
    fail('request-invalid')
  }
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

function inspectProjection(payload: BrokerInspectPayload, observed: unknown, grant: AnyExternalBrokerGrant): BrokerInspectObservation | undefined {
  try {
    const dest = grant.destination as GitHubGrantDestinationV2
    return normalizeBrokerInspectObservation(payload, observed, {
      classification: 'github-repository',
      repository: dest.repository,
      branch: dest.branch,
      ...(dest.baseBranch === undefined ? {} : { baseBranch: dest.baseBranch }),
    })
  } catch { return undefined }
}

function githubGrant(grant: AnyExternalBrokerGrant, allowPullRequest = false): ActionGrant {
  const dest = grant.destination as GitHubGrantDestinationV2
  return Object.freeze({
    id: grant.id,
    revision: grant.revision,
    principalDigest: grant.owner.principalDigest,
    principalRecordId: grant.owner.principalRecordId,
    principalVersion: grant.owner.principalVersion,
    workspace: grant.owner.workspace,
    agentPreset: grant.owner.preset,
    repository: dest.repository,
    branch: dest.branch,
    paths: [...dest.paths],
    credentialHandle: grant.credentialId,
    expiresAt: grant.expiresAt,
    maxActions: grant.maxActions,
    maxTotalBytes: grant.maxTotalBytes,
    ...(dest.baseBranch === undefined ? {} : { repoWorkflow: Object.freeze({ baseBranch: dest.baseBranch, allowBranchCreate: false, allowPullRequest }) }),
  })
}

function response(record: BrokerLedgerRecord): ActionBrokerResponse {
  const value = record.outcome
  if (!value) return { status: 'unknown', dispatched: record.status === 'dispatched', result: null, error: { code: 'transport-failed' }, completedAt: Date.now() }
  return { status: value.status, dispatched: value.dispatched, result: value.result, error: value.error, completedAt: value.completedAt }
}

export class ExternalBrokerCore {
  readonly #ledger: ExternalBrokerLedger
  readonly #authority: BrokerAuthority
  readonly #credentials: ReadonlyMap<string, BrokerCredentialSpec>
  readonly #commit: GitHubTransport
  readonly #inspect: InspectTransport
  readonly #pullRequest: PullRequestTransport
  readonly #httpDeps: HttpGuardDeps | undefined
  readonly #larkDeps: LarkGuardDeps | undefined
  readonly #calendarDeps: CalendarGuardDeps | undefined
  readonly #shellDeps: ShellGuardDeps | undefined
  readonly #credentialHooks: BrokerCredentialReadHooks
  readonly #now: () => number
  readonly #credentialMaxBytes: number
  readonly #pending = new Map<string, { controller: AbortController; done: Promise<ActionBrokerResponse> }>()
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
    const grants = [...config.grants, ...(config.actionGrants ?? [])]
    this.#commit = transports.commit ?? commitOnGitHub
    this.#inspect = transports.inspect ?? inspectGitHub
    this.#pullRequest = transports.pullRequest ?? createPullRequestOnGitHub
    this.#httpDeps = transports.http
    this.#larkDeps = transports.lark
    this.#calendarDeps = transports.calendar
    this.#shellDeps = transports.shell
    this.#credentialHooks = {
      ...(transports.beforeCredentialOpen === undefined ? {} : { beforeCredentialOpen: transports.beforeCredentialOpen }),
      ...(config.platform === undefined ? {} : { platform: config.platform }),
      ...(transports.credentialCommandRunner === undefined ? {} : { commandRunner: transports.credentialCommandRunner }),
      ...(config.checkWindowsAcl === undefined ? {} : { checkWindowsAcl: config.checkWindowsAcl }),
      ...(transports.readCredentialOverride === undefined ? {} : { readCredentialOverride: transports.readCredentialOverride }),
    }
    this.#ledger = new ExternalBrokerLedger(statePath, instanceId, {
      now: this.#now,
      ...(config.platform === undefined ? {} : { platform: config.platform }),
      ...(config.checkWindowsAcl === undefined ? {} : { checkWindowsAcl: config.checkWindowsAcl }),
    })
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
    const out = await this.executeAction(request, signal)
    return out as BrokerResponse
  }

  executeAction = async (request: BrokerClientRequest | ActionBrokerClientRequest, signal: AbortSignal): Promise<ActionBrokerResponse> => {
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

  async #readAllSecrets(primary: BrokerCredentialSpec, signal: AbortSignal): Promise<{ token: string; secrets: string[] }> {
    const token = await readBrokerCredential(primary, this.#credentialMaxBytes, this.#credentialHooks, signal)
    const secrets: string[] = []
    for (const configured of this.#credentials.values()) {
      const value = configured.id === primary.id
        ? token
        : await readBrokerCredential(configured, this.#credentialMaxBytes, this.#credentialHooks, signal)
      if (value.length > 0) secrets.push(value)
    }
    return { token, secrets }
  }

  async #executePrepared(request: BrokerClientRequest | ActionBrokerClientRequest, initial: BrokerLedgerRecord, signal: AbortSignal): Promise<ActionBrokerResponse> {
    let record = initial
    const requestDigestValue = brokerLedgerRequestDigest(request)
    try {
      const grant = this.#ledger.anyGrant(record.grantId)
      const credential = grant && this.#credentials.get(grant.credentialId)
      if (!grant || !credential) return response(this.#ledger.failPrepared(record.actionId, record.version, requestDigestValue, 'credential-unavailable', this.#authority))
      if (signal.aborted || request.deadline <= this.#now()) return response(this.#ledger.failPrepared(record.actionId, record.version, requestDigestValue, 'deadline-exceeded', this.#authority))

      let token: string
      let secrets: string[]
      try {
        ({ token, secrets } = await this.#readAllSecrets(credential, signal))
      } catch {
        return response(this.#ledger.failPrepared(record.actionId, record.version, requestDigestValue, 'credential-unavailable', this.#authority))
      }

      if (secrets.some(secret => containsSecret(request.payload, secret)) || containsCredentialShape(request.payload)) {
        return response(this.#ledger.failPrepared(record.actionId, record.version, requestDigestValue, 'request-invalid', this.#authority))
      }

      const domain = 'domain' in request ? request.domain : 'github'
      if (domain === 'http') {
        const req2 = request as ActionBrokerClientRequest
        const grant2 = grant as ExternalActionGrant
        validateHttpAgainstGrant(
          grant2.destination as HttpGrantDestination,
          req2.destination as HttpRequestDestination,
          req2.payload as HttpRequestPayload,
        )
      } else if (domain === 'lark') {
        const req2 = request as ActionBrokerClientRequest
        const grant2 = grant as ExternalActionGrant
        validateLarkAgainstGrant(
          req2.operation as 'lark.send-message' | 'lark.reply-message' | 'lark.read-messages',
          grant2.destination as LarkGrantDestination,
          req2.destination as LarkRequestDestination,
          req2.payload as LarkSendPayload | LarkReadPayload,
        )
      } else if (domain === 'calendar') {
        const req2 = request as ActionBrokerClientRequest
        const grant2 = grant as ExternalActionGrant
        validateCalendarAgainstGrant(
          req2.operation as 'calendar.list-events' | 'calendar.get-event' | 'calendar.create-event' | 'calendar.update-event' | 'calendar.delete-event',
          grant2.destination as CalendarGrantDestination,
          req2.destination as CalendarRequestDestination,
          req2.payload as CalendarActionPayload,
          this.#now(),
        )
      } else if (domain === 'shell') {
        const req2 = request as ActionBrokerClientRequest
        const grant2 = grant as ExternalActionGrant
        await validateShellAgainstGrant(
          grant2.destination as ShellGrantDestination,
          req2.destination as ShellRequestDestination,
          req2.payload as ShellExecPayload,
          this.#shellDeps,
        )
      }

      const leaseExpiresAt = Math.min(request.deadline, grant.expiresAt, this.#now() + credential.maxLeaseMs)
      record = this.#ledger.dispatch(record.actionId, record.version, requestDigestValue, credential.id, leaseExpiresAt, this.#authority)
      const remainingMs = Math.max(1, leaseExpiresAt - this.#now())
      const deadline = AbortSignal.timeout(remainingMs)
      const combined = AbortSignal.any([signal, deadline])

      let result: ActionBrokerSuccessResult | null = null

      if (domain === 'github') {
        const dest = grant.destination as GitHubGrantDestinationV2
        if (request.operation === 'commit') {
          const payload = request.payload as BrokerCommitPayload
          const commit = await abortable(this.#commit({ actionId: request.actionId, grant: githubGrant(grant), request: { grantId: grant.id, idempotencyKey: request.actionId, expectedHeadOid: payload.expectedHeadOid, headline: payload.headline, files: payload.files.map(file => ({ ...file })) }, token, signal: combined }), combined)
          if (commit.status === 'succeeded' && commit.commitOid) result = { operation: 'commit', repository: dest.repository, branch: dest.branch, parentOid: payload.expectedHeadOid, commitOid: commit.commitOid }
        } else if (request.operation === 'pull-request') {
          const payload = request.payload as BrokerPullRequestPayload
          const created = await abortable(this.#pullRequest({ actionId: request.actionId, grant: githubGrant(grant, true), expectedHeadOid: payload.expectedHeadOid, title: payload.title, body: payload.body, token, signal: combined }), combined)
          if (created.status === 'succeeded' && created.pullRequestNumber && dest.baseBranch !== undefined) result = { operation: 'pull-request', repository: dest.repository, branch: dest.branch, baseBranch: dest.baseBranch, expectedHeadOid: payload.expectedHeadOid, pullRequestNumber: created.pullRequestNumber }
        } else {
          const payload = request.payload as BrokerInspectPayload
          const inspected = await abortable(this.#inspect({ grant: githubGrant(grant), kind: payload.kind, ...(payload.path === undefined ? {} : { path: payload.path }), ...(payload.pullRequestNumber === undefined ? {} : { pullRequestNumber: payload.pullRequestNumber }), ...(payload.commitOid === undefined ? {} : { commitOid: payload.commitOid }), token, signal: combined }), combined)
          if (inspected) {
            const projected = inspectProjection(payload, inspected.observed, grant)
            if (projected && !secrets.some(secret => containsSecret(projected, secret)) && !containsCredentialShape(projected)) {
              const canonical = canonicalBrokerJson(projected)
              result = { operation: 'inspect', repository: dest.repository, branch: dest.branch, kind: payload.kind, observed: projected, observedDigest: createHash('sha256').update(canonical).digest('hex') }
            }
          }
        }
      } else if (domain === 'http') {
        const req2 = request as ActionBrokerClientRequest
        const grant2 = grant as ExternalActionGrant
        result = await executeHttpGuardedAction({
          grantDestination: grant2.destination as HttpGrantDestination,
          requestDestination: req2.destination as HttpRequestDestination,
          payload: req2.payload as HttpRequestPayload,
          token,
          timeoutMs: remainingMs,
          signal: combined,
          deps: { ...this.#httpDeps, secrets },
        })
      } else if (domain === 'lark') {
        const req2 = request as ActionBrokerClientRequest
        const grant2 = grant as ExternalActionGrant
        result = await executeLarkGuardedAction({
          actionId: req2.actionId,
          operation: req2.operation as 'lark.send-message' | 'lark.reply-message' | 'lark.read-messages',
          grantDestination: grant2.destination as LarkGrantDestination,
          requestDestination: req2.destination as LarkRequestDestination,
          payload: req2.payload as LarkSendPayload | LarkReadPayload,
          token,
          timeoutMs: remainingMs,
          signal: combined,
          deps: { ...this.#larkDeps, secrets },
        })
      } else if (domain === 'calendar') {
        const req2 = request as ActionBrokerClientRequest
        const grant2 = grant as ExternalActionGrant
        result = await executeCalendarGuardedAction({
          operation: req2.operation as 'calendar.list-events' | 'calendar.get-event' | 'calendar.create-event' | 'calendar.update-event' | 'calendar.delete-event',
          grantDestination: grant2.destination as CalendarGrantDestination,
          requestDestination: req2.destination as CalendarRequestDestination,
          payload: req2.payload as CalendarActionPayload,
          token,
          timeoutMs: remainingMs,
          signal: combined,
          deps: { now: this.#now, ...this.#calendarDeps, secrets },
        })
      } else if (domain === 'shell') {
        const req2 = request as ActionBrokerClientRequest
        const grant2 = grant as ExternalActionGrant
        result = await executeShellGuardedAction({
          grantDestination: grant2.destination as ShellGrantDestination,
          requestDestination: req2.destination as ShellRequestDestination,
          payload: req2.payload as ShellExecPayload,
          remainingLeaseMs: remainingMs,
          signal: combined,
          deps: { ...this.#shellDeps, secrets },
        })
      }

      if (result && (secrets.some(secret => containsSecret(result, secret)) || containsCredentialShape(result))) {
        return response(this.#settle(record, requestDigestValue, null, 'request-invalid'))
      }
      if (combined.aborted || signal.aborted || this.#now() >= leaseExpiresAt) return response(this.#settle(record, requestDigestValue, null, 'aborted'))
      return response(result ? this.#ledger.settle(record.actionId, record.version, requestDigestValue, { status: 'succeeded', dispatched: true, result, error: null, completedAt: Math.max(1, this.#now()) }, this.#authority) : this.#settle(record, requestDigestValue, null, 'transport-failed'))
    } catch (error) {
      if (record.status === 'dispatched') {
        try { return response(this.#settle(record, requestDigestValue, null, safeCode(error))) } catch { return fail('transport-failed', true) }
      }
      try { return response(this.#ledger.failPrepared(record.actionId, record.version, requestDigestValue, safeCode(error), this.#authority)) } catch { return fail(safeCode(error)) }
    }
  }

  #settle(record: BrokerLedgerRecord, requestDigestValue: string, result: BrokerSuccessResult | ActionBrokerSuccessResult | null, code: string): BrokerLedgerRecord {
    const value: BrokerLedgerOutcome = result
      ? { status: 'succeeded', dispatched: true, result, error: null, completedAt: Math.max(1, this.#now()) }
      : { status: 'unknown', dispatched: true, result: null, error: { code }, completedAt: Math.max(1, this.#now()) }
    return this.#ledger.settle(record.actionId, record.version, requestDigestValue, value, this.#authority)
  }

  admin = async (request: BrokerAdminRequest | ActionBrokerAdminRequest, signal: AbortSignal): Promise<BrokerAdminResponse> => {
    if (signal.aborted) fail('aborted')
    const adminDigest = 'protocol' in request && request.protocol === 'assistant-actions/action-broker/v2'
      ? createHash('sha256').update(canonicalBrokerJson((() => { const { signature: _s, ...u } = request; return u })())).digest('hex')
      : createHash('sha256').update(canonicalBrokerJson((() => { const { signature: _s, ...u } = request; return u })())).digest('hex')
    try {
      let mutation: BrokerControlMutation | undefined
      if (request.operation === 'stop') {
        const body = request.body as Extract<import('./broker-protocol.js').BrokerAdminIntent, { operation: 'stop' }>['body']
        mutation = this.#ledger.applyAdminMutation({ adminKeyId: request.adminKeyId, nonce: request.nonce, requestDigest: adminDigest, expiresAt: request.deadline, mutation: { operation: 'stop', expectedControlVersion: body.expectedControlVersion, reason: body.reason }, authority: this.#authority })
      } else if (request.operation === 'resume') {
        const body = request.body as Extract<import('./broker-protocol.js').BrokerAdminIntent, { operation: 'resume' }>['body']
        mutation = this.#ledger.applyAdminMutation({ adminKeyId: request.adminKeyId, nonce: request.nonce, requestDigest: adminDigest, expiresAt: request.deadline, mutation: { operation: 'resume', expectedControlVersion: body.expectedControlVersion, expectedGeneration: body.expectedGeneration, reason: 'operator-resume' }, authority: this.#authority })
      } else if (request.operation === 'revoke') {
        const body = request.body as Extract<import('./broker-protocol.js').BrokerAdminIntent, { operation: 'revoke' }>['body']
        mutation = this.#ledger.applyAdminMutation({ adminKeyId: request.adminKeyId, nonce: request.nonce, requestDigest: adminDigest, expiresAt: request.deadline, mutation: { operation: 'revoke', expectedControlVersion: body.expectedControlVersion, grantId: body.grantId, grantRevision: body.grantRevision, grantDigest: body.grantDigest, policyEpoch: body.policyEpoch, emergencyEpoch: body.emergencyEpoch, reason: body.reason }, authority: this.#authority })
      } else {
        this.#ledger.consumeAdminNonce(request.adminKeyId, request.nonce, adminDigest, request.deadline, this.#authority)
      }
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
    for (const item of this.#pending.values()) item.controller.abort()
    try { this.#ledger.terminalizeActive('drain-deadline', this.#authority) } catch { /* Startup recovery keeps no-replay if the fence was lost. */ }
    await settleWithin(pending.map(value => value.done), FORCED_TEARDOWN_GRACE_MS)
  }
  close = (): Promise<void> => this.#closing ??= this.#close()
  async #close(): Promise<void> {
    this.#active = false
    clearInterval(this.#renewal)
    const pending = [...this.#pending.values()]
    for (const item of this.#pending.values()) item.controller.abort()
    try { this.#ledger.terminalizeActive('core-close', this.#authority) } catch { /* A successor will recover if the fence was lost. */ }
    await settleWithin(pending.map(value => value.done), FORCED_TEARDOWN_GRACE_MS)
    try { if (this.#ledger.hasController(this.#authority)) this.#ledger.releaseController(this.#authority) } finally { this.#ledger.close() }
  }
}

export function createExternalBrokerCore(config: ExternalBrokerCoreConfig, transports: ExternalBrokerCoreTransports = {}): ExternalBrokerCore { return new ExternalBrokerCore(config, transports) }
