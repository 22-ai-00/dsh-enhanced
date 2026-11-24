import { createHash, createPrivateKey, createPublicKey, KeyObject, randomBytes, randomUUID, sign, verify } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { validateStrictHttpUrl } from './guards/http-guard.js'
import {
  normalizeBrokerWp08Constraints,
  type BrokerPolicyLease,
  type BrokerSensitivity,
  type BrokerWp08Constraints,
} from './broker-policy.js'
import {
  BrokerProtocolError,
  brokerDigest,
  canonicalBrokerJson,
  isCanonicalWorkspacePath,
  normalizeBrokerInspectObservation,
  type BrokerCommitPayload,
  type BrokerDataSource,
  type BrokerInspectPayload,
  type BrokerJson,
  type BrokerOperation,
  type BrokerPullRequestPayload,
  type BrokerRequestIntent,
  type BrokerSourceClassification,
  type BrokerSuccessResult,
} from './broker-protocol.js'

export const ACTION_BROKER_PROTOCOL = 'assistant-actions/action-broker/v2' as const
export const ACTION_GRANT_PROTOCOL = 'assistant-actions/external-action-grant/v2' as const
export const ACTION_INTENT_PROTOCOL = 'assistant-actions/action-broker-intent/v2' as const
export const ACTION_ID_PROTOCOL = 'assistant-actions/external-action-id/v2' as const
export const ACTION_BROKER_REQUEST_MAX_BYTES = 8 * 1024 * 1024
export const ACTION_BROKER_RESPONSE_MAX_BYTES = 2 * 1024 * 1024
export const ACTION_BROKER_DEFAULT_HELLO_TTL_MS = 30_000

const V2_HELLO_DOMAIN = 'assistant-actions/action-broker/v2/server-hello\0'
const V2_REQUEST_DOMAIN = 'assistant-actions/action-broker/v2/client-request\0'
const V2_RESPONSE_DOMAIN = 'assistant-actions/action-broker/v2/server-response\0'
const V2_ADMIN_REQUEST_DOMAIN = 'assistant-actions/action-broker/v2/admin-request\0'
const V2_ADMIN_RESPONSE_DOMAIN = 'assistant-actions/action-broker/v2/admin-response\0'

const DIGEST = /^[0-9a-f]{64}$/
const OID = /^[0-9a-f]{40,128}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const ERROR_CODE = /^[a-z][a-z0-9-]{0,127}$/
const SENSITIVE_VALUE = /(?:authorization\s*:|bearer\s+|gh[opusr]_|github_pat_|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----)/i

type KeyInput = KeyObject | string | Buffer

export type BrokerActionDomain = 'github' | 'http' | 'lark' | 'calendar' | 'shell'
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type LarkMessageType = 'text' | 'post' | 'interactive'
export type CalendarProvider = 'lark-calendar' | 'caldav' | 'google-calendar'
export type ActionCostMetric =
  | 'github-api-units'
  | 'http-requests'
  | 'lark-api-calls'
  | 'calendar-api-calls'
  | 'shell-exec-units'
  | 'micro-usd'

export type ActionBrokerOperation =
  | BrokerOperation
  | 'http.request'
  | 'lark.send-message'
  | 'lark.reply-message'
  | 'lark.read-messages'
  | 'calendar.list-events'
  | 'calendar.get-event'
  | 'calendar.create-event'
  | 'calendar.update-event'
  | 'calendar.delete-event'
  | 'shell.exec'

export type ActionBrokerEndpoint =
  | { kind: 'assistant-actions-host'; instanceId: string; generation: number }
  | { kind: 'action-broker'; instanceId: string; generation: number }
  | { kind: 'github-broker'; instanceId: string; generation: number }

export type ActionBrokerAdminEndpoint = { kind: 'assistant-actions-admin'; instanceId: string; generation: number }

export interface HttpGrantDestination {
  readonly classification: 'http-endpoint'
  readonly allowedSchemes: readonly ('https' | 'http')[]
  readonly allowedHosts: readonly string[]
  readonly allowedPorts?: readonly number[]
  readonly allowedMethods: readonly HttpMethod[]
  readonly allowedPathPrefixes: readonly string[]
  readonly allowRedirects: false
  readonly allowPrivateNetwork?: boolean
  readonly maxResponseBytes: number
  readonly authHeader?: string
  readonly authScheme?: string
}

export interface HttpRequestDestination {
  readonly classification: 'http-endpoint'
  readonly scheme: 'https' | 'http'
  readonly host: string
  readonly port?: number
  readonly path: string
}

export interface HttpRequestPayload {
  readonly method: HttpMethod
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly expectedResponseSha256?: string
}

export interface LarkGrantDestination {
  readonly classification: 'lark-workspace'
  readonly tenantKey: string
  readonly apiBaseUrl: string
  readonly allowedChatIds: readonly string[]
  readonly allowedOpenIds?: readonly string[]
  readonly allowedMsgTypes: readonly LarkMessageType[]
  readonly maxTextBytes: number
  readonly allowPrivateNetwork?: boolean
}

export interface LarkRequestDestination {
  readonly classification: 'lark-workspace'
  readonly tenantKey: string
  readonly receiveIdType: 'chat_id' | 'open_id'
  readonly receiveId: string
}

export interface LarkSendPayload {
  readonly receiveIdType: 'chat_id' | 'open_id'
  readonly receiveId: string
  readonly msgType: LarkMessageType
  readonly content: string
  readonly replyToMessageId?: string
  readonly uuid: string
}

export interface LarkReadPayload {
  readonly chatId: string
  readonly threadId?: string
  readonly pageSize: number
  readonly pageToken?: string
}

export interface CalendarGrantDestination {
  readonly classification: 'calendar-scope'
  readonly provider: CalendarProvider
  readonly apiBaseUrl: string
  readonly allowedCalendarIds: readonly string[]
  readonly windowStartMs?: number
  readonly windowEndMs?: number
  readonly rollingWindowMs?: number
  readonly rollingLookbackMs?: number
  readonly maxWindowSpanMs: number
  readonly allowMutations: boolean
  readonly allowExternalAttendees: boolean
  readonly allowedAttendeeDomains?: readonly string[]
  readonly allowPrivateNetwork?: boolean
}

export interface CalendarRequestDestination {
  readonly classification: 'calendar-scope'
  readonly provider: CalendarProvider
  readonly calendarId: string
}

export interface CalendarActionPayload {
  readonly calendarId: string
  readonly eventId?: string
  readonly startTimeMs?: number
  readonly endTimeMs?: number
  readonly summary?: string
  readonly description?: string
  readonly attendees?: readonly string[]
  readonly expectedRevision?: string
  readonly pageSize?: number
  readonly pageToken?: string
}

export interface ShellCommandRule {
  readonly executable: string
  readonly executableSha256?: string
  readonly allowedArgPrefixes?: readonly (readonly string[])[]
  readonly allowArgsPattern?: string
  readonly maxArgs: number
}

export interface ShellGrantDestination {
  readonly classification: 'shell-command'
  readonly allowedCwds: readonly string[]
  readonly allowedCommands: readonly ShellCommandRule[]
  readonly allowedEnvKeys: readonly string[]
  readonly maxTimeoutMs: number
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
  readonly allowNetwork: false
}

export interface ShellRequestDestination {
  readonly classification: 'shell-command'
  readonly executable: string
  readonly cwd: string
}

export interface ShellExecPayload {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly stdin?: string
  readonly timeoutMs: number
}

export interface GitHubGrantDestinationV2 {
  readonly classification: 'github-repository'
  readonly repository: string
  readonly branch: string
  readonly baseBranch?: string
  readonly paths: readonly string[]
}

export interface GitHubRequestDestinationV2 {
  readonly classification: 'github-repository'
  readonly repository: string
  readonly branch: string
  readonly baseBranch?: string
}

export type ActionGrantDestination =
  | GitHubGrantDestinationV2
  | HttpGrantDestination
  | LarkGrantDestination
  | CalendarGrantDestination
  | ShellGrantDestination

export type ActionRequestDestination =
  | GitHubRequestDestinationV2
  | HttpRequestDestination
  | LarkRequestDestination
  | CalendarRequestDestination
  | ShellRequestDestination

export type ActionBrokerPayload =
  | BrokerCommitPayload
  | BrokerInspectPayload
  | BrokerPullRequestPayload
  | HttpRequestPayload
  | LarkSendPayload
  | LarkReadPayload
  | CalendarActionPayload
  | ShellExecPayload

export interface ActionBrokerBudget {
  readonly reservationId: string
  readonly actions: number
  readonly bytes: number
  readonly costMetric: ActionCostMetric
  readonly maxCostUnits: number
  readonly estimatedCostMicros?: number
}

export interface ActionBrokerServerHelloUnsigned {
  readonly protocol: typeof ACTION_BROKER_PROTOCOL
  readonly type: 'server-hello'
  readonly instanceId: string
  readonly generation: number
  readonly policyEpoch: number
  readonly emergencyEpoch: number
  readonly challenge: string
  readonly expiresAt: number
}
export interface ActionBrokerServerHello extends ActionBrokerServerHelloUnsigned { readonly signature: string }

export interface ActionBrokerGrantAuthorityUnsigned {
  readonly protocol: typeof ACTION_GRANT_PROTOCOL
  readonly id: string
  readonly revision: number
  readonly domain: BrokerActionDomain
  readonly clientKeyId: string
  readonly owner: BrokerRequestIntent['owner']
  readonly sessionId: string
  readonly destination: ActionGrantDestination
  readonly credentialId: string
  readonly expiresAt: number
  readonly maxActions: number
  readonly maxTotalBytes: number
  readonly maxCostUnits: number
  readonly allowedOperations: readonly ActionBrokerOperation[]
  readonly allowedInspectKinds?: readonly BrokerInspectPayload['kind'][]
  readonly verifiedDelivery?: { ownerRouteId: string; budgetId: string; acceptance?: 'goal-outcome' | 'goal-step' }
  readonly client: Extract<ActionBrokerEndpoint, { kind: 'assistant-actions-host' }>
  readonly source: BrokerDataSource
  readonly policyEpoch: number
  readonly emergencyEpoch: number
  // WP08 additive constraint fields
  readonly lease?: BrokerPolicyLease
  readonly destinations?: readonly string[]
  readonly maxSensitivity?: BrokerSensitivity
  readonly monetaryCostCapMicros?: number
  readonly commitDigest?: string
}

export interface ActionBrokerGrantProjection {
  readonly protocol: typeof ACTION_GRANT_PROTOCOL
  readonly id: string
  readonly revision: number
  readonly domain: BrokerActionDomain
  readonly grantDigest: string
  readonly owner: BrokerRequestIntent['owner']
  readonly sessionId: string
  readonly destination: ActionGrantDestination
  readonly expiresAt: number
  readonly maxActions: number
  readonly maxTotalBytes: number
  readonly source: BrokerDataSource
  readonly maxCostUnits: number
  readonly allowedOperations: readonly ActionBrokerOperation[]
  readonly allowedInspectKinds?: readonly BrokerInspectPayload['kind'][]
  readonly verifiedDelivery?: { ownerRouteId: string; budgetId: string; acceptance?: 'goal-outcome' | 'goal-step' }
  readonly lease?: BrokerPolicyLease
  readonly destinations?: readonly string[]
  readonly maxSensitivity?: BrokerSensitivity
  readonly monetaryCostCapMicros?: number
  readonly commitDigest?: string
}

export interface ActionBrokerRequestIntent {
  readonly actionId: string
  readonly grantId: string
  readonly grantRevision: number
  readonly grantDigest: string
  readonly domain: BrokerActionDomain
  readonly owner: BrokerRequestIntent['owner']
  readonly sessionId: string
  readonly agentId: string
  readonly rootCallId: string
  readonly callId: string
  readonly operation: ActionBrokerOperation
  readonly source: BrokerDataSource
  readonly destination: ActionRequestDestination
  readonly payload: ActionBrokerPayload
  readonly deadline: number
  readonly budget: ActionBrokerBudget
  readonly estimatedCostMicros?: number
  readonly commitDigest?: string
  readonly predecessorDigest?: string
  readonly idempotencyKey?: string
}

export interface ActionBrokerClientRequestUnsigned extends ActionBrokerRequestIntent {
  readonly protocol: typeof ACTION_BROKER_PROTOCOL
  readonly type: 'client-request'
  readonly requestId: string
  readonly challenge: string
  readonly client: Extract<ActionBrokerEndpoint, { kind: 'assistant-actions-host' }>
  readonly broker: Extract<ActionBrokerEndpoint, { kind: 'action-broker' | 'github-broker' }>
  readonly payloadDigest: string
  readonly policyEpoch: number
  readonly emergencyEpoch: number
  readonly clientKeyId: string
}
export interface ActionBrokerClientRequest extends ActionBrokerClientRequestUnsigned { readonly signature: string }

export type ActionBrokerSuccessResult =
  | BrokerSuccessResult
  | {
    readonly domain: 'http'
    readonly operation: 'http.request'
    readonly statusCode: number
    readonly responseHeaders: Readonly<Record<string, string>>
    readonly body: string
    readonly bodySha256: string
    readonly truncated: boolean
    readonly untrusted: true
  }
  | {
    readonly domain: 'lark'
    readonly operation: 'lark.send-message' | 'lark.reply-message' | 'lark.read-messages'
    readonly messageId?: string
    readonly chatId?: string
    readonly observed?: BrokerJson
    readonly observedDigest?: string
    readonly untrusted: true
  }
  | {
    readonly domain: 'calendar'
    readonly operation: 'calendar.list-events' | 'calendar.get-event' | 'calendar.create-event' | 'calendar.update-event' | 'calendar.delete-event'
    readonly calendarId: string
    readonly eventId?: string
    readonly revision?: string
    readonly observed?: BrokerJson
    readonly observedDigest?: string
    readonly untrusted: true
  }
  | {
    readonly domain: 'shell'
    readonly operation: 'shell.exec'
    readonly exitCode: number
    readonly signal?: string
    readonly stdout: string
    readonly stderr: string
    readonly stdoutSha256: string
    readonly stderrSha256: string
    readonly truncated: boolean
    readonly untrusted: true
  }

export interface ActionBrokerServerResponseUnsigned {
  readonly protocol: typeof ACTION_BROKER_PROTOCOL
  readonly type: 'server-response'
  readonly requestId: string
  readonly actionId: string
  readonly instanceId: string
  readonly generation: number
  readonly challenge: string
  readonly requestDigest: string
  readonly status: 'succeeded' | 'failed' | 'unknown'
  readonly dispatched: boolean
  readonly result: ActionBrokerSuccessResult | null
  readonly error: { readonly code: string } | null
  readonly completedAt: number
}
export interface ActionBrokerServerResponse extends ActionBrokerServerResponseUnsigned { readonly signature: string }

export type ActionBrokerAdminIntent =
  | { operation: 'status'; body: Record<string, never>; deadline: number }
  | { operation: 'stop'; body: { expectedControlVersion: number; drainDeadline: number; reason: 'operator-request' | 'security-response' | 'maintenance' }; deadline: number }
  | { operation: 'resume'; body: { expectedControlVersion: number; expectedGeneration: number }; deadline: number }
  | { operation: 'revoke'; body: { expectedControlVersion: number; grantId: string; grantRevision: number; grantDigest: string; policyEpoch: number; emergencyEpoch: number; reason: 'operator-request' | 'security-response' | 'grant-replaced' | 'grant-expired' }; deadline: number }

export interface ActionBrokerAdminRequestUnsigned {
  readonly protocol: typeof ACTION_BROKER_PROTOCOL
  readonly type: 'admin-request'
  readonly requestId: string
  readonly nonce: string
  readonly challenge: string
  readonly source: ActionBrokerAdminEndpoint
  readonly destination: ActionBrokerEndpoint
  readonly operation: ActionBrokerAdminIntent['operation']
  readonly body: ActionBrokerAdminIntent['body']
  readonly deadline: number
  readonly adminKeyId: string
}
export interface ActionBrokerAdminRequest extends ActionBrokerAdminRequestUnsigned { readonly signature: string }

export interface ActionBrokerAdminResponseUnsigned {
  readonly protocol: typeof ACTION_BROKER_PROTOCOL
  readonly type: 'admin-response'
  readonly requestId: string
  readonly instanceId: string
  readonly generation: number
  readonly challenge: string
  readonly requestDigest: string
  readonly status: 'succeeded' | 'failed'
  readonly state: { admission: 'accepting' | 'draining' | 'stopped'; generation: number; controlVersion: number; activeRequests: number; revocationEpoch: number }
  readonly error: { readonly code: string } | null
  readonly completedAt: number
}
export interface ActionBrokerAdminResponse extends ActionBrokerAdminResponseUnsigned { readonly signature: string }

function reject(code: string, message: string): never {
  throw new BrokerProtocolError(code, message)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject('invalid-message', `${label} must be an object`)
  if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) reject('invalid-message', `${label} must be a plain data object`)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some(descriptor => !descriptor.enumerable || !('value' in descriptor))) reject('invalid-message', `${label} must contain enumerable data fields only`)
  return value as Record<string, unknown>
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const output = record(value, label)
  const actual = Object.keys(output).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) reject('unknown-field', `${label} has unknown or missing fields`)
  return output
}

function exactOptional(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  const input = record(value, label)
  const keys = Object.keys(input)
  if (required.some(key => !Object.hasOwn(input, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) {
    reject('unknown-field', `${label} has unknown or missing fields`)
  }
  return input
}

function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\p{Cc}]/u.test(value)) reject('invalid-message', `${label} is invalid`)
  return value
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) reject('invalid-message', `${label} is invalid`)
  return value
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') reject('invalid-message', `${label} must be boolean`)
  return value
}

function truth(value: unknown, label: string): true {
  if (value !== true) reject('invalid-message', `${label} must be true`)
  return true
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) reject('invalid-message', `${label} is invalid`)
  return value
}

function oid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OID.test(value)) reject('invalid-message', `${label} is invalid`)
  return value
}

function base64url(value: unknown, label: string, bytes: number): string {
  if (typeof value !== 'string' || !BASE64URL.test(value)) reject('invalid-message', `${label} is invalid`)
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== bytes || decoded.toString('base64url') !== value) reject('invalid-message', `${label} is invalid`)
  return value
}

function instance(value: unknown, label: string): string {
  if (typeof value !== 'string' || !INSTANCE.test(value)) reject('invalid-message', `${label} is invalid`)
  return value
}

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\\p{Cc}]/u.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}

function validBranch(value: unknown, label: string): string {
  const branch = text(value, label, 255)
  if (!BRANCH.test(branch) || branch.includes('..') || branch.startsWith('refs/') || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) reject('invalid-message', `${label} is invalid`)
  return branch
}

function privateKey(value: KeyInput): KeyObject {
  let key: KeyObject
  try { key = value instanceof KeyObject ? value : createPrivateKey(value) } catch { reject('invalid-key', 'client private key is invalid') }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') reject('invalid-key', 'client private key must be Ed25519')
  return key
}

function publicKey(value: KeyInput): KeyObject {
  let key: KeyObject
  try {
    key = value instanceof KeyObject && value.type === 'public' ? value : createPublicKey(value)
  } catch { reject('invalid-key', 'server public key is invalid') }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') reject('invalid-key', 'server public key must be Ed25519')
  return key
}

function signingBytes(domain: string, value: unknown): Buffer {
  return Buffer.from(domain + canonicalBrokerJson(value), 'utf8')
}

function signatureFor(domain: string, value: unknown, key: KeyInput): string {
  return sign(null, signingBytes(domain, value), privateKey(key)).toString('base64url')
}

function verifySignature(domain: string, value: unknown, signature: string, key: KeyInput): void {
  if (!verify(null, signingBytes(domain, value), publicKey(key), Buffer.from(signature, 'base64url'))) {
    reject('invalid-signature', 'signature verification failed')
  }
}

function containsCredentialShapedValue(value: unknown): boolean {
  if (typeof value === 'string') return SENSITIVE_VALUE.test(value)
  if (Array.isArray(value)) return value.some(containsCredentialShapedValue)
  if (value !== null && typeof value === 'object') return Object.values(value).some(containsCredentialShapedValue)
  return false
}

function isAbsoluteCrossPlatform(value: string): boolean {
  return (!value.includes('\\') && posix.isAbsolute(value)) || (/^[A-Za-z]:\\/u.test(value) && win32.isAbsolute(value))
}

function owner(value: unknown): BrokerRequestIntent['owner'] {
  const input = exact(value, ['principalDigest', 'principalRecordId', 'principalVersion', 'workspace', 'preset', 'bindingId', 'bindingVersion', 'bindingGeneration'], 'request.owner')
  const workspace = text(input.workspace, 'request.owner.workspace', 4096)
  if (!isCanonicalWorkspacePath(workspace)) reject('invalid-message', 'request owner workspace is invalid')
  return Object.freeze({
    principalDigest: digest(input.principalDigest, 'request.owner.principalDigest'),
    principalRecordId: text(input.principalRecordId, 'request.owner.principalRecordId'),
    principalVersion: integer(input.principalVersion, 'request.owner.principalVersion', 1),
    workspace,
    preset: text(input.preset, 'request.owner.preset'),
    bindingId: text(input.bindingId, 'request.owner.bindingId'),
    bindingVersion: integer(input.bindingVersion, 'request.owner.bindingVersion', 1),
    bindingGeneration: integer(input.bindingGeneration, 'request.owner.bindingGeneration', 1),
  })
}

function dataSource(value: unknown): BrokerDataSource {
  const input = exact(value, ['classification', 'provenanceDigest'], 'request.source')
  if (!['public', 'internal', 'confidential', 'restricted'].includes(String(input.classification))) reject('invalid-message', 'request source classification is invalid')
  return Object.freeze({ classification: input.classification as BrokerSourceClassification, provenanceDigest: digest(input.provenanceDigest, 'request.source.provenanceDigest') })
}

function endpoint<K extends ActionBrokerEndpoint['kind']>(value: unknown, allowedKinds: readonly K[], label: string): Extract<ActionBrokerEndpoint, { kind: K }> {
  const input = exact(value, ['kind', 'instanceId', 'generation'], label)
  if (!allowedKinds.includes(input.kind as K)) reject('invalid-message', `${label}.kind is invalid`)
  return Object.freeze({ kind: input.kind as K, instanceId: instance(input.instanceId, `${label}.instanceId`), generation: integer(input.generation, `${label}.generation`, 1) }) as Extract<ActionBrokerEndpoint, { kind: K }>
}

function stringList(value: unknown, label: string, min = 1, max = 128, maxLen = 512): readonly string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) reject('invalid-message', `${label} is invalid`)
  const out = value.map((item, idx) => text(item, `${label}[${idx}]`, maxLen))
  if (new Set(out).size !== out.length) reject('invalid-message', `${label} contains duplicates`)
  return Object.freeze(out)
}

function stringRecord(value: unknown, label: string, maxEntries = 64, maxValueLen = 4_096): Readonly<Record<string, string>> {
  const input = record(value, label)
  const keys = Object.keys(input)
  if (keys.length > maxEntries) reject('invalid-message', `${label} has too many entries`)
  const out: Record<string, string> = {}
  for (const key of keys) {
    text(key, `${label} key`, 128)
    const val = input[key]
    if (typeof val !== 'string' || val.length > maxValueLen || val.includes('\0') || val.includes('\r') || val.includes('\n')) reject('invalid-message', `${label}[${key}] is invalid`)
    out[key] = val
  }
  return Object.freeze(out)
}

function normalizeActionGrantDestination(domain: BrokerActionDomain, value: unknown): ActionGrantDestination {
  const raw = record(value, 'grant.destination')
  if (domain === 'github') {
    const input = exactOptional(raw, ['classification', 'repository', 'branch', 'paths'], ['baseBranch'], 'grant.destination')
    if (input.classification !== 'github-repository' || typeof input.repository !== 'string' || input.repository.length > 256 || !REPOSITORY.test(input.repository)) {
      reject('invalid-message', 'github grant destination is invalid')
    }
    const branch = validBranch(input.branch, 'grant.destination.branch')
    const baseBranch = input.baseBranch === undefined ? undefined : validBranch(input.baseBranch, 'grant.destination.baseBranch')
    if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 128 || !input.paths.every(validPath) || new Set(input.paths).size !== input.paths.length) {
      reject('invalid-message', 'github grant paths are invalid')
    }
    return Object.freeze({
      classification: 'github-repository',
      repository: input.repository,
      branch,
      ...(baseBranch === undefined ? {} : { baseBranch }),
      paths: Object.freeze([...input.paths]),
    })
  }

  if (domain === 'http') {
    const input = exactOptional(
      raw,
      ['classification', 'allowedSchemes', 'allowedHosts', 'allowedMethods', 'allowedPathPrefixes', 'allowRedirects', 'maxResponseBytes'],
      ['allowedPorts', 'allowPrivateNetwork', 'authHeader', 'authScheme'],
      'grant.destination',
    )
    if (input.classification !== 'http-endpoint' || input.allowRedirects !== false) reject('invalid-message', 'http grant destination is invalid')
    const allowedSchemes = stringList(input.allowedSchemes, 'http.allowedSchemes', 1, 2, 8)
    if (allowedSchemes.some(s => s !== 'https' && s !== 'http')) reject('invalid-message', 'http.allowedSchemes invalid')
    const allowedHosts = stringList(input.allowedHosts, 'http.allowedHosts', 1, 64, 256).map(h => h.toLowerCase())
    const allowedMethods = stringList(input.allowedMethods, 'http.allowedMethods', 1, 6, 16)
    if (allowedMethods.some(m => !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m))) reject('invalid-message', 'http.allowedMethods invalid')
    const allowedPathPrefixes = stringList(input.allowedPathPrefixes, 'http.allowedPathPrefixes', 1, 64, 512)
    if (allowedPathPrefixes.some(p => !p.startsWith('/') || p.includes('..'))) reject('invalid-message', 'http.allowedPathPrefixes invalid')
    const maxResponseBytes = integer(input.maxResponseBytes, 'http.maxResponseBytes', 1, 16 * 1024 * 1024)
    let allowedPorts: readonly number[] | undefined
    if (input.allowedPorts !== undefined) {
      if (!Array.isArray(input.allowedPorts) || input.allowedPorts.length < 1 || input.allowedPorts.length > 16) reject('invalid-message', 'http.allowedPorts invalid')
      allowedPorts = Object.freeze(input.allowedPorts.map((p, idx) => integer(p, `http.allowedPorts[${idx}]`, 1, 65535)))
    }
    const allowPrivateNetwork = input.allowPrivateNetwork === undefined ? undefined : boolean(input.allowPrivateNetwork, 'http.allowPrivateNetwork')
    const authHeader = input.authHeader === undefined ? undefined : text(input.authHeader, 'http.authHeader', 64)
    const authScheme = input.authScheme === undefined ? undefined : text(input.authScheme, 'http.authScheme', 32)
    return Object.freeze({
      classification: 'http-endpoint',
      allowedSchemes: Object.freeze([...allowedSchemes]) as readonly ('https' | 'http')[],
      allowedHosts: Object.freeze(allowedHosts),
      ...(allowedPorts === undefined ? {} : { allowedPorts }),
      allowedMethods: Object.freeze([...allowedMethods]) as readonly HttpMethod[],
      allowedPathPrefixes,
      allowRedirects: false as const,
      ...(allowPrivateNetwork === undefined ? {} : { allowPrivateNetwork }),
      maxResponseBytes,
      ...(authHeader === undefined ? {} : { authHeader }),
      ...(authScheme === undefined ? {} : { authScheme }),
    })
  }

  if (domain === 'lark') {
    const input = exactOptional(
      raw,
      ['classification', 'tenantKey', 'apiBaseUrl', 'allowedChatIds', 'allowedMsgTypes', 'maxTextBytes'],
      ['allowedOpenIds', 'allowPrivateNetwork'],
      'grant.destination',
    )
    if (input.classification !== 'lark-workspace') reject('invalid-message', 'lark grant destination is invalid')
    const allowedMsgTypes = stringList(input.allowedMsgTypes, 'lark.allowedMsgTypes', 1, 3, 32)
    if (allowedMsgTypes.some(t => !['text', 'post', 'interactive'].includes(t))) reject('invalid-message', 'lark.allowedMsgTypes invalid')
    const allowedOpenIds = input.allowedOpenIds === undefined ? undefined : stringList(input.allowedOpenIds, 'lark.allowedOpenIds', 0, 256, 128)
    const allowPrivateNetwork = input.allowPrivateNetwork === undefined ? undefined : boolean(input.allowPrivateNetwork, 'lark.allowPrivateNetwork')
    return Object.freeze({
      classification: 'lark-workspace',
      tenantKey: text(input.tenantKey, 'lark.tenantKey', 128),
      apiBaseUrl: text(input.apiBaseUrl, 'lark.apiBaseUrl', 512),
      allowedChatIds: stringList(input.allowedChatIds, 'lark.allowedChatIds', 0, 256, 128),
      ...(allowedOpenIds === undefined ? {} : { allowedOpenIds }),
      allowedMsgTypes: Object.freeze([...allowedMsgTypes]) as readonly LarkMessageType[],
      maxTextBytes: integer(input.maxTextBytes, 'lark.maxTextBytes', 1, 65_536),
      ...(allowPrivateNetwork === undefined ? {} : { allowPrivateNetwork }),
    })
  }

  if (domain === 'calendar') {
    const input = exactOptional(
      raw,
      ['classification', 'provider', 'apiBaseUrl', 'allowedCalendarIds', 'maxWindowSpanMs', 'allowMutations', 'allowExternalAttendees'],
      ['windowStartMs', 'windowEndMs', 'rollingWindowMs', 'rollingLookbackMs', 'allowedAttendeeDomains', 'allowPrivateNetwork'],
      'grant.destination',
    )
    if (input.classification !== 'calendar-scope' || !['lark-calendar', 'caldav', 'google-calendar'].includes(String(input.provider))) {
      reject('invalid-message', 'calendar grant destination is invalid')
    }
    const windowStartMs = input.windowStartMs === undefined ? undefined : integer(input.windowStartMs, 'calendar.windowStartMs', 0)
    const windowEndMs = input.windowEndMs === undefined ? undefined : integer(input.windowEndMs, 'calendar.windowEndMs', 1)
    if (windowStartMs !== undefined && windowEndMs !== undefined && windowStartMs >= windowEndMs) reject('invalid-message', 'calendar static window invalid')
    const rollingWindowMs = input.rollingWindowMs === undefined ? undefined : integer(input.rollingWindowMs, 'calendar.rollingWindowMs', 1)
    const rollingLookbackMs = input.rollingLookbackMs === undefined ? undefined : integer(input.rollingLookbackMs, 'calendar.rollingLookbackMs', 0)
    const allowedAttendeeDomains = input.allowedAttendeeDomains === undefined ? undefined : stringList(input.allowedAttendeeDomains, 'calendar.allowedAttendeeDomains', 0, 64, 256).map(d => d.toLowerCase())
    const allowPrivateNetwork = input.allowPrivateNetwork === undefined ? undefined : boolean(input.allowPrivateNetwork, 'calendar.allowPrivateNetwork')
    return Object.freeze({
      classification: 'calendar-scope',
      provider: input.provider as CalendarProvider,
      apiBaseUrl: text(input.apiBaseUrl, 'calendar.apiBaseUrl', 512),
      allowedCalendarIds: stringList(input.allowedCalendarIds, 'calendar.allowedCalendarIds', 1, 128, 256),
      ...(windowStartMs === undefined ? {} : { windowStartMs }),
      ...(windowEndMs === undefined ? {} : { windowEndMs }),
      ...(rollingWindowMs === undefined ? {} : { rollingWindowMs }),
      ...(rollingLookbackMs === undefined ? {} : { rollingLookbackMs }),
      maxWindowSpanMs: integer(input.maxWindowSpanMs, 'calendar.maxWindowSpanMs', 1),
      allowMutations: boolean(input.allowMutations, 'calendar.allowMutations'),
      allowExternalAttendees: boolean(input.allowExternalAttendees, 'calendar.allowExternalAttendees'),
      ...(allowedAttendeeDomains === undefined ? {} : { allowedAttendeeDomains: Object.freeze(allowedAttendeeDomains) }),
      ...(allowPrivateNetwork === undefined ? {} : { allowPrivateNetwork }),
    })
  }

  // shell
  const input = exact(
    raw,
    ['classification', 'allowedCwds', 'allowedCommands', 'allowedEnvKeys', 'maxTimeoutMs', 'maxStdoutBytes', 'maxStderrBytes', 'allowNetwork'],
    'grant.destination',
  )
  if (input.classification !== 'shell-command' || input.allowNetwork !== false) reject('invalid-message', 'shell grant destination is invalid')
  const allowedCwds = stringList(input.allowedCwds, 'shell.allowedCwds', 1, 64, 1_024)
  if (allowedCwds.some(cwd => !isAbsoluteCrossPlatform(cwd))) reject('invalid-message', 'shell.allowedCwds must be absolute paths')
  if (!Array.isArray(input.allowedCommands) || input.allowedCommands.length < 1 || input.allowedCommands.length > 64) reject('invalid-message', 'shell.allowedCommands invalid')
  const allowedCommands = Object.freeze(input.allowedCommands.map((cmd, idx) => {
    const c = exactOptional(cmd, ['executable', 'maxArgs'], ['executableSha256', 'allowedArgPrefixes', 'allowArgsPattern'], `shell.allowedCommands[${idx}]`)
    const executable = text(c.executable, `shell.allowedCommands[${idx}].executable`, 1_024)
    if (!isAbsoluteCrossPlatform(executable)) reject('invalid-message', 'shell executable must be absolute')
    const executableSha256 = c.executableSha256 === undefined ? undefined : digest(c.executableSha256, 'shell.executableSha256')
    let allowedArgPrefixes: readonly (readonly string[])[] | undefined
    if (c.allowedArgPrefixes !== undefined) {
      if (!Array.isArray(c.allowedArgPrefixes) || c.allowedArgPrefixes.length > 64) reject('invalid-message', 'shell.allowedArgPrefixes invalid')
      allowedArgPrefixes = Object.freeze(c.allowedArgPrefixes.map((prefix, pIdx) => {
        if (!Array.isArray(prefix) || prefix.length > 32) reject('invalid-message', `shell.allowedArgPrefixes[${pIdx}] invalid`)
        return Object.freeze(prefix.map((tok, tIdx) => text(tok, `shell.allowedArgPrefixes[${pIdx}][${tIdx}]`, 512)))
      }))
    }
    const allowArgsPattern = c.allowArgsPattern === undefined ? undefined : text(c.allowArgsPattern, 'shell.allowArgsPattern', 512)
    if (allowArgsPattern !== undefined) {
      try { new RegExp(allowArgsPattern, 'u') } catch { reject('invalid-message', 'shell.allowArgsPattern invalid regex') }
    }
    return Object.freeze({
      executable,
      ...(executableSha256 === undefined ? {} : { executableSha256 }),
      ...(allowedArgPrefixes === undefined ? {} : { allowedArgPrefixes }),
      ...(allowArgsPattern === undefined ? {} : { allowArgsPattern }),
      maxArgs: integer(c.maxArgs, `shell.allowedCommands[${idx}].maxArgs`, 0, 128),
    })
  }))
  const allowedEnvKeys = stringList(input.allowedEnvKeys, 'shell.allowedEnvKeys', 0, 64, 128)
  return Object.freeze({
    classification: 'shell-command',
    allowedCwds,
    allowedCommands,
    allowedEnvKeys,
    maxTimeoutMs: integer(input.maxTimeoutMs, 'shell.maxTimeoutMs', 1, 300_000),
    maxStdoutBytes: integer(input.maxStdoutBytes, 'shell.maxStdoutBytes', 1, 4 * 1024 * 1024),
    maxStderrBytes: integer(input.maxStderrBytes, 'shell.maxStderrBytes', 1, 4 * 1024 * 1024),
    allowNetwork: false as const,
  })
}

function normalizeActionRequestDestination(domain: BrokerActionDomain, value: unknown): ActionRequestDestination {
  const raw = record(value, 'request.destination')
  if (domain === 'github') {
    const input = exactOptional(raw, ['classification', 'repository', 'branch'], ['baseBranch'], 'request.destination')
    if (input.classification !== 'github-repository' || typeof input.repository !== 'string' || input.repository.length > 256 || !REPOSITORY.test(input.repository)) {
      reject('invalid-message', 'github request destination is invalid')
    }
    const branch = validBranch(input.branch, 'request.destination.branch')
    const baseBranch = input.baseBranch === undefined ? undefined : validBranch(input.baseBranch, 'request.destination.baseBranch')
    return Object.freeze({ classification: 'github-repository', repository: input.repository, branch, ...(baseBranch === undefined ? {} : { baseBranch }) })
  }
  if (domain === 'http') {
    const input = exactOptional(raw, ['classification', 'scheme', 'host', 'path'], ['port'], 'request.destination')
    if (input.classification !== 'http-endpoint' || (input.scheme !== 'https' && input.scheme !== 'http')) {
      reject('invalid-message', 'http request destination is invalid')
    }
    const port = input.port === undefined ? undefined : integer(input.port, 'request.destination.port', 1, 65535)
    return Object.freeze({
      classification: 'http-endpoint',
      scheme: input.scheme,
      host: text(input.host, 'request.destination.host', 256).toLowerCase(),
      ...(port === undefined ? {} : { port }),
      path: text(input.path, 'request.destination.path', 2_048),
    })
  }
  if (domain === 'lark') {
    const input = exact(raw, ['classification', 'tenantKey', 'receiveIdType', 'receiveId'], 'request.destination')
    if (input.classification !== 'lark-workspace' || (input.receiveIdType !== 'chat_id' && input.receiveIdType !== 'open_id')) {
      reject('invalid-message', 'lark request destination is invalid')
    }
    return Object.freeze({
      classification: 'lark-workspace',
      tenantKey: text(input.tenantKey, 'request.destination.tenantKey', 128),
      receiveIdType: input.receiveIdType,
      receiveId: text(input.receiveId, 'request.destination.receiveId', 128),
    })
  }
  if (domain === 'calendar') {
    const input = exact(raw, ['classification', 'provider', 'calendarId'], 'request.destination')
    if (input.classification !== 'calendar-scope' || !['lark-calendar', 'caldav', 'google-calendar'].includes(String(input.provider))) {
      reject('invalid-message', 'calendar request destination is invalid')
    }
    return Object.freeze({
      classification: 'calendar-scope',
      provider: input.provider as CalendarProvider,
      calendarId: text(input.calendarId, 'request.destination.calendarId', 256),
    })
  }
  const input = exact(raw, ['classification', 'executable', 'cwd'], 'request.destination')
  if (input.classification !== 'shell-command') reject('invalid-message', 'shell request destination is invalid')
  const executable = text(input.executable, 'request.destination.executable', 1_024)
  const cwd = text(input.cwd, 'request.destination.cwd', 1_024)
  if (!isAbsoluteCrossPlatform(executable) || !isAbsoluteCrossPlatform(cwd)) reject('invalid-message', 'shell destination paths must be absolute')
  return Object.freeze({ classification: 'shell-command', executable, cwd })
}

function normalizeBudgetV2(value: unknown): ActionBrokerBudget {
  const input = exactOptional(value, ['reservationId', 'actions', 'bytes', 'costMetric', 'maxCostUnits'], ['estimatedCostMicros'], 'request.budget')
  if (!['github-api-units', 'http-requests', 'lark-api-calls', 'calendar-api-calls', 'shell-exec-units', 'micro-usd'].includes(String(input.costMetric))) {
    reject('invalid-message', 'request.budget.costMetric is invalid')
  }
  const estimatedCostMicros = input.estimatedCostMicros === undefined ? undefined : integer(input.estimatedCostMicros, 'request.budget.estimatedCostMicros', 0)
  return Object.freeze({
    reservationId: text(input.reservationId, 'request.budget.reservationId'),
    actions: integer(input.actions, 'request.budget.actions', 1),
    bytes: integer(input.bytes, 'request.budget.bytes', 0),
    costMetric: input.costMetric as ActionCostMetric,
    maxCostUnits: integer(input.maxCostUnits, 'request.budget.maxCostUnits'),
    ...(estimatedCostMicros === undefined ? {} : { estimatedCostMicros }),
  })
}

function normalizePayloadV2(domain: BrokerActionDomain, operation: ActionBrokerOperation, value: unknown): ActionBrokerPayload {
  if (domain === 'github') {
    if (operation === 'commit') {
      const input = exact(value, ['expectedHeadOid', 'headline', 'files'], 'commit payload')
      if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 32) reject('invalid-message', 'commit payload files are invalid')
      const files = Object.freeze(input.files.map((item, index) => {
        const file = exact(item, ['path', 'content'], `commit payload file ${index}`)
        if (!validPath(file.path) || typeof file.content !== 'string' || Buffer.byteLength(file.content) > 1_048_576 || Buffer.from(file.content, 'utf8').toString('utf8') !== file.content) {
          reject('invalid-message', 'commit payload file is invalid')
        }
        return Object.freeze({ path: file.path, content: file.content })
      }))
      if (new Set(files.map(file => file.path)).size !== files.length) reject('invalid-message', 'commit payload paths are not unique')
      return Object.freeze({ expectedHeadOid: oid(input.expectedHeadOid, 'commit payload expectedHeadOid'), headline: text(input.headline, 'commit payload headline', 200), files })
    }
    if (operation === 'pull-request') {
      const input = exact(value, ['expectedHeadOid', 'title', 'body'], 'pull request payload')
      if (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 65_536 || Buffer.from(input.body, 'utf8').toString('utf8') !== input.body) reject('invalid-message', 'pull request payload body is invalid')
      return Object.freeze({ expectedHeadOid: oid(input.expectedHeadOid, 'pull request payload expectedHeadOid'), title: text(input.title, 'pull request payload title', 200), body: input.body })
    }
    if (operation === 'inspect') {
      const input = record(value, 'inspect payload')
      const kind = input.kind
      if (!['repository', 'branch', 'file', 'pull-request', 'checks', 'reviews', 'commit-checks'].includes(String(kind))) reject('invalid-message', 'inspect kind is invalid')
      const expected = kind === 'file' ? ['kind', 'path'] : ['pull-request', 'checks', 'reviews'].includes(String(kind)) ? ['kind', 'pullRequestNumber'] : kind === 'commit-checks' ? ['kind', 'commitOid'] : ['kind']
      exact(input, expected, 'inspect payload')
      if (kind === 'file') {
        if (!validPath(input.path)) reject('invalid-message', 'inspect path is invalid')
        return Object.freeze({ kind: 'file', path: input.path })
      }
      if (kind === 'commit-checks') return Object.freeze({ kind: 'commit-checks', commitOid: oid(input.commitOid, 'inspect commitOid') })
      if (expected.length === 2) return Object.freeze({ kind: kind as 'pull-request' | 'checks' | 'reviews', pullRequestNumber: integer(input.pullRequestNumber, 'inspect pullRequestNumber', 1) })
      return Object.freeze({ kind: kind as 'repository' | 'branch' })
    }
    reject('invalid-message', 'invalid github operation')
  }

  if (domain === 'http') {
    if (operation !== 'http.request') reject('invalid-message', 'invalid http operation')
    const input = exactOptional(value, ['method', 'url'], ['headers', 'body', 'expectedResponseSha256'], 'http payload')
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(input.method))) reject('invalid-message', 'http method invalid')
    const url = text(input.url, 'http.url', 4_096)
    const headers = input.headers === undefined ? undefined : stringRecord(input.headers, 'http.headers', 32, 4_096)
    const body = input.body === undefined ? undefined : (() => {
      if (typeof input.body !== 'string' || Buffer.byteLength(input.body, 'utf8') > 4 * 1024 * 1024) reject('invalid-message', 'http.body invalid')
      return input.body
    })()
    const expectedResponseSha256 = input.expectedResponseSha256 === undefined ? undefined : digest(input.expectedResponseSha256, 'http.expectedResponseSha256')
    return Object.freeze({
      method: input.method as HttpMethod,
      url,
      ...(headers === undefined ? {} : { headers }),
      ...(body === undefined ? {} : { body }),
      ...(expectedResponseSha256 === undefined ? {} : { expectedResponseSha256 }),
    })
  }

  if (domain === 'lark') {
    if (operation === 'lark.send-message' || operation === 'lark.reply-message') {
      const input = exactOptional(value, ['receiveIdType', 'receiveId', 'msgType', 'content', 'uuid'], ['replyToMessageId'], 'lark send payload')
      if (input.receiveIdType !== 'chat_id' && input.receiveIdType !== 'open_id') reject('invalid-message', 'lark receiveIdType invalid')
      if (!['text', 'post', 'interactive'].includes(String(input.msgType))) reject('invalid-message', 'lark msgType invalid')
      if (typeof input.content !== 'string' || input.content.length < 1 || Buffer.byteLength(input.content, 'utf8') > 65_536) reject('invalid-message', 'lark content invalid')
      const replyToMessageId = input.replyToMessageId === undefined ? undefined : text(input.replyToMessageId, 'lark.replyToMessageId', 128)
      if (operation === 'lark.reply-message' && !replyToMessageId) reject('invalid-message', 'lark.reply-message requires replyToMessageId')
      return Object.freeze({
        receiveIdType: input.receiveIdType,
        receiveId: text(input.receiveId, 'lark.receiveId', 128),
        msgType: input.msgType as LarkMessageType,
        content: input.content,
        ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
        uuid: text(input.uuid, 'lark.uuid', 128),
      })
    }
    if (operation === 'lark.read-messages') {
      const input = exactOptional(value, ['chatId', 'pageSize'], ['threadId', 'pageToken'], 'lark read payload')
      const threadId = input.threadId === undefined ? undefined : text(input.threadId, 'lark.threadId', 128)
      const pageToken = input.pageToken === undefined ? undefined : text(input.pageToken, 'lark.pageToken', 512)
      return Object.freeze({
        chatId: text(input.chatId, 'lark.chatId', 128),
        pageSize: integer(input.pageSize, 'lark.pageSize', 1, 100),
        ...(threadId === undefined ? {} : { threadId }),
        ...(pageToken === undefined ? {} : { pageToken }),
      })
    }
    reject('invalid-message', 'invalid lark operation')
  }

  if (domain === 'calendar') {
    if (!['calendar.list-events', 'calendar.get-event', 'calendar.create-event', 'calendar.update-event', 'calendar.delete-event'].includes(operation)) {
      reject('invalid-message', 'invalid calendar operation')
    }
    const input = exactOptional(
      value,
      ['calendarId'],
      ['eventId', 'startTimeMs', 'endTimeMs', 'summary', 'description', 'attendees', 'expectedRevision', 'pageSize', 'pageToken'],
      'calendar payload',
    )
    const eventId = input.eventId === undefined ? undefined : text(input.eventId, 'calendar.eventId', 256)
    const startTimeMs = input.startTimeMs === undefined ? undefined : integer(input.startTimeMs, 'calendar.startTimeMs', 0)
    const endTimeMs = input.endTimeMs === undefined ? undefined : integer(input.endTimeMs, 'calendar.endTimeMs', 1)
    const summary = input.summary === undefined ? undefined : text(input.summary, 'calendar.summary', 512)
    const description = input.description === undefined ? undefined : (() => {
      if (typeof input.description !== 'string' || Buffer.byteLength(input.description, 'utf8') > 16_384) reject('invalid-message', 'calendar.description invalid')
      return input.description
    })()
    const attendees = input.attendees === undefined ? undefined : stringList(input.attendees, 'calendar.attendees', 0, 100, 256)
    const expectedRevision = input.expectedRevision === undefined ? undefined : text(input.expectedRevision, 'calendar.expectedRevision', 128)
    const pageSize = input.pageSize === undefined ? undefined : integer(input.pageSize, 'calendar.pageSize', 1, 100)
    const pageToken = input.pageToken === undefined ? undefined : text(input.pageToken, 'calendar.pageToken', 512)
    return Object.freeze({
      calendarId: text(input.calendarId, 'calendar.calendarId', 256),
      ...(eventId === undefined ? {} : { eventId }),
      ...(startTimeMs === undefined ? {} : { startTimeMs }),
      ...(endTimeMs === undefined ? {} : { endTimeMs }),
      ...(summary === undefined ? {} : { summary }),
      ...(description === undefined ? {} : { description }),
      ...(attendees === undefined ? {} : { attendees }),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      ...(pageSize === undefined ? {} : { pageSize }),
      ...(pageToken === undefined ? {} : { pageToken }),
    })
  }

  // shell
  if (operation !== 'shell.exec') reject('invalid-message', 'invalid shell operation')
  const input = exactOptional(value, ['executable', 'args', 'cwd', 'timeoutMs'], ['env', 'stdin'], 'shell payload')
  const executable = text(input.executable, 'shell.executable', 1_024)
  const cwd = text(input.cwd, 'shell.cwd', 1_024)
  if (!isAbsoluteCrossPlatform(executable) || !isAbsoluteCrossPlatform(cwd)) reject('invalid-message', 'shell executable and cwd must be absolute')
  if (!Array.isArray(input.args) || input.args.length > 128) reject('invalid-message', 'shell.args invalid')
  const args = Object.freeze(input.args.map((arg, idx) => {
    if (typeof arg !== 'string' || Buffer.byteLength(arg, 'utf8') > 4_096 || /[\p{Cc}]/u.test(arg)) reject('invalid-message', `shell.args[${idx}] invalid`)
    return arg
  }))
  const env = input.env === undefined ? undefined : stringRecord(input.env, 'shell.env', 64, 4_096)
  const stdin = input.stdin === undefined ? undefined : (() => {
    if (typeof input.stdin !== 'string' || Buffer.byteLength(input.stdin, 'utf8') > 1_048_576) reject('invalid-message', 'shell.stdin invalid')
    return input.stdin
  })()
  return Object.freeze({
    executable,
    args,
    cwd,
    ...(env === undefined ? {} : { env }),
    ...(stdin === undefined ? {} : { stdin }),
    timeoutMs: integer(input.timeoutMs, 'shell.timeoutMs', 1, 300_000),
  })
}

const DOMAIN_OPERATIONS: Readonly<Record<BrokerActionDomain, readonly ActionBrokerOperation[]>> = {
  github: ['commit', 'inspect', 'pull-request'],
  http: ['http.request'],
  lark: ['lark.send-message', 'lark.reply-message', 'lark.read-messages'],
  calendar: ['calendar.list-events', 'calendar.get-event', 'calendar.create-event', 'calendar.update-event', 'calendar.delete-event'],
  shell: ['shell.exec'],
}

function normalizeDomain(value: unknown): BrokerActionDomain {
  if (value !== 'github' && value !== 'http' && value !== 'lark' && value !== 'calendar' && value !== 'shell') {
    reject('invalid-message', 'action domain is invalid')
  }
  return value
}

function wp08GrantFields(input: Record<string, unknown>): BrokerWp08Constraints {
  const raw: Record<string, unknown> = {}
  for (const key of ['lease', 'destinations', 'maxSensitivity', 'monetaryCostCapMicros', 'commitDigest'] as const) {
    if (input[key] !== undefined) raw[key] = input[key]
  }
  if (Object.keys(raw).length === 0) return {}
  try {
    return normalizeBrokerWp08Constraints(raw)
  } catch (error) {
    reject('invalid-message', error instanceof Error ? error.message : 'invalid WP08 grant constraint')
  }
}

export function normalizeActionGrantAuthority(value: unknown): ActionBrokerGrantAuthorityUnsigned {
  const input = exactOptional(
    value,
    ['protocol', 'id', 'revision', 'domain', 'clientKeyId', 'owner', 'sessionId', 'destination', 'credentialId', 'expiresAt', 'maxActions', 'maxTotalBytes', 'maxCostUnits', 'allowedOperations', 'client', 'source', 'policyEpoch', 'emergencyEpoch'],
    ['allowedInspectKinds', 'verifiedDelivery', 'lease', 'destinations', 'maxSensitivity', 'monetaryCostCapMicros', 'commitDigest'],
    'action broker grant',
  )
  if (input.protocol !== ACTION_GRANT_PROTOCOL) reject('wrong-protocol', 'action grant protocol is invalid')
  const domain = normalizeDomain(input.domain)
  const normalizedOwner = owner(input.owner)
  const destination = normalizeActionGrantDestination(domain, input.destination)
  const allowedOps = stringList(input.allowedOperations, 'grant.allowedOperations', 1, 16, 64)
  if (allowedOps.some(op => !DOMAIN_OPERATIONS[domain].includes(op as ActionBrokerOperation))) {
    reject('invalid-message', 'grant allowedOperations contain invalid operation for domain')
  }
  let allowedInspectKinds: readonly BrokerInspectPayload['kind'][] | undefined
  if (input.allowedInspectKinds !== undefined) {
    if (domain !== 'github') reject('invalid-message', 'allowedInspectKinds is only valid for github domain')
    const kinds = stringList(input.allowedInspectKinds, 'grant.allowedInspectKinds', 0, 7, 32)
    if (kinds.some(k => !['repository', 'branch', 'file', 'pull-request', 'checks', 'reviews', 'commit-checks'].includes(k))) {
      reject('invalid-message', 'invalid allowedInspectKinds')
    }
    allowedInspectKinds = kinds as readonly BrokerInspectPayload['kind'][]
  }
  if (domain === 'github' && allowedOps.includes('inspect') !== ((allowedInspectKinds?.length ?? 0) > 0)) {
    reject('invalid-message', 'github inspect grant requires allowedInspectKinds')
  }
  let verifiedDelivery: ActionBrokerGrantAuthorityUnsigned['verifiedDelivery']
  if (input.verifiedDelivery !== undefined) {
    const vd = exactOptional(input.verifiedDelivery, ['ownerRouteId', 'budgetId'], ['acceptance'], 'grant.verifiedDelivery')
    if (vd.acceptance !== undefined && vd.acceptance !== 'goal-outcome' && vd.acceptance !== 'goal-step') {
      reject('invalid-message', 'invalid verifiedDelivery acceptance')
    }
    verifiedDelivery = Object.freeze({
      ownerRouteId: text(vd.ownerRouteId, 'verifiedDelivery.ownerRouteId', 200),
      budgetId: text(vd.budgetId, 'verifiedDelivery.budgetId', 200),
      ...(vd.acceptance === undefined ? {} : { acceptance: vd.acceptance }),
    })
  }
  const wp08 = wp08GrantFields(input)
  return Object.freeze({
    protocol: ACTION_GRANT_PROTOCOL,
    id: text(input.id, 'grant.id'),
    revision: integer(input.revision, 'grant.revision', 1),
    domain,
    clientKeyId: instance(input.clientKeyId, 'grant.clientKeyId'),
    owner: normalizedOwner,
    sessionId: text(input.sessionId, 'grant.sessionId'),
    destination,
    credentialId: instance(input.credentialId, 'grant.credentialId'),
    expiresAt: integer(input.expiresAt, 'grant.expiresAt', 1),
    maxActions: integer(input.maxActions, 'grant.maxActions', 1, 10_000),
    maxTotalBytes: integer(input.maxTotalBytes, 'grant.maxTotalBytes', 1, 64 * 1024 * 1024),
    maxCostUnits: integer(input.maxCostUnits, 'grant.maxCostUnits'),
    allowedOperations: Object.freeze([...allowedOps]) as readonly ActionBrokerOperation[],
    ...(allowedInspectKinds === undefined ? {} : { allowedInspectKinds }),
    ...(verifiedDelivery === undefined ? {} : { verifiedDelivery }),
    client: endpoint(input.client, ['assistant-actions-host'], 'grant.client'),
    source: dataSource(input.source),
    policyEpoch: integer(input.policyEpoch, 'grant.policyEpoch'),
    emergencyEpoch: integer(input.emergencyEpoch, 'grant.emergencyEpoch'),
    ...(wp08.lease === undefined ? {} : { lease: wp08.lease }),
    ...(wp08.destinations === undefined ? {} : { destinations: wp08.destinations }),
    ...(wp08.maxSensitivity === undefined ? {} : { maxSensitivity: wp08.maxSensitivity }),
    ...(wp08.monetaryCostCapMicros === undefined ? {} : { monetaryCostCapMicros: wp08.monetaryCostCapMicros }),
    ...(wp08.commitDigest === undefined ? {} : { commitDigest: wp08.commitDigest }),
  })
}

export function actionGrantAuthorityDigest(grant: ActionBrokerGrantAuthorityUnsigned): string {
  return brokerDigest(normalizeActionGrantAuthority(grant))
}

export function createActionGrantProjection(grant: ActionBrokerGrantAuthorityUnsigned): ActionBrokerGrantProjection {
  const value = normalizeActionGrantAuthority(grant)
  return Object.freeze({
    protocol: ACTION_GRANT_PROTOCOL,
    id: value.id,
    revision: value.revision,
    domain: value.domain,
    grantDigest: actionGrantAuthorityDigest(value),
    owner: value.owner,
    sessionId: value.sessionId,
    destination: value.destination,
    expiresAt: value.expiresAt,
    maxActions: value.maxActions,
    maxTotalBytes: value.maxTotalBytes,
    source: value.source,
    maxCostUnits: value.maxCostUnits,
    allowedOperations: value.allowedOperations,
    ...(value.allowedInspectKinds === undefined ? {} : { allowedInspectKinds: value.allowedInspectKinds }),
    ...(value.verifiedDelivery === undefined ? {} : { verifiedDelivery: value.verifiedDelivery }),
    ...(value.lease === undefined ? {} : { lease: value.lease }),
    ...(value.destinations === undefined ? {} : { destinations: value.destinations }),
    ...(value.maxSensitivity === undefined ? {} : { maxSensitivity: value.maxSensitivity }),
    ...(value.monetaryCostCapMicros === undefined ? {} : { monetaryCostCapMicros: value.monetaryCostCapMicros }),
    ...(value.commitDigest === undefined ? {} : { commitDigest: value.commitDigest }),
  })
}

export function normalizeActionGrantProjection(value: unknown): ActionBrokerGrantProjection {
  const input = exactOptional(
    value,
    ['protocol', 'id', 'revision', 'domain', 'grantDigest', 'owner', 'sessionId', 'destination', 'expiresAt', 'maxActions', 'maxTotalBytes', 'source', 'maxCostUnits', 'allowedOperations'],
    ['allowedInspectKinds', 'verifiedDelivery', 'lease', 'destinations', 'maxSensitivity', 'monetaryCostCapMicros', 'commitDigest'],
    'action grant projection',
  )
  if (input.protocol !== ACTION_GRANT_PROTOCOL) reject('wrong-protocol', 'action grant projection protocol invalid')
  const domain = normalizeDomain(input.domain)
  const destination = normalizeActionGrantDestination(domain, input.destination)
  const allowedOps = stringList(input.allowedOperations, 'projection.allowedOperations', 1, 16, 64)
  if (allowedOps.some(op => !DOMAIN_OPERATIONS[domain].includes(op as ActionBrokerOperation))) {
    reject('invalid-message', 'projection allowedOperations invalid for domain')
  }
  const allowedInspectKinds = input.allowedInspectKinds === undefined
    ? undefined
    : stringList(input.allowedInspectKinds, 'projection.allowedInspectKinds', 0, 7, 32) as readonly BrokerInspectPayload['kind'][]
  let verifiedDelivery: ActionBrokerGrantProjection['verifiedDelivery']
  if (input.verifiedDelivery !== undefined) {
    const vd = exactOptional(input.verifiedDelivery, ['ownerRouteId', 'budgetId'], ['acceptance'], 'projection.verifiedDelivery')
    if (vd.acceptance !== undefined && vd.acceptance !== 'goal-outcome' && vd.acceptance !== 'goal-step') reject('invalid-message', 'invalid acceptance')
    verifiedDelivery = Object.freeze({
      ownerRouteId: text(vd.ownerRouteId, 'verifiedDelivery.ownerRouteId', 200),
      budgetId: text(vd.budgetId, 'verifiedDelivery.budgetId', 200),
      ...(vd.acceptance === undefined ? {} : { acceptance: vd.acceptance }),
    })
  }
  const wp08 = wp08GrantFields(input)
  return Object.freeze({
    protocol: ACTION_GRANT_PROTOCOL,
    id: text(input.id, 'projection.id'),
    revision: integer(input.revision, 'projection.revision', 1),
    domain,
    grantDigest: digest(input.grantDigest, 'projection.grantDigest'),
    owner: owner(input.owner),
    sessionId: text(input.sessionId, 'projection.sessionId'),
    destination,
    expiresAt: integer(input.expiresAt, 'projection.expiresAt', 1),
    maxActions: integer(input.maxActions, 'projection.maxActions', 1, 10_000),
    maxTotalBytes: integer(input.maxTotalBytes, 'projection.maxTotalBytes', 1, 64 * 1024 * 1024),
    source: dataSource(input.source),
    maxCostUnits: integer(input.maxCostUnits, 'projection.maxCostUnits'),
    allowedOperations: Object.freeze([...allowedOps]) as readonly ActionBrokerOperation[],
    ...(allowedInspectKinds === undefined ? {} : { allowedInspectKinds }),
    ...(verifiedDelivery === undefined ? {} : { verifiedDelivery }),
    ...(wp08.lease === undefined ? {} : { lease: wp08.lease }),
    ...(wp08.destinations === undefined ? {} : { destinations: wp08.destinations }),
    ...(wp08.maxSensitivity === undefined ? {} : { maxSensitivity: wp08.maxSensitivity }),
    ...(wp08.monetaryCostCapMicros === undefined ? {} : { monetaryCostCapMicros: wp08.monetaryCostCapMicros }),
    ...(wp08.commitDigest === undefined ? {} : { commitDigest: wp08.commitDigest }),
  })
}

function normalizeHelloUnsignedV2(value: unknown): ActionBrokerServerHelloUnsigned {
  const input = exact(value, ['protocol', 'type', 'instanceId', 'generation', 'policyEpoch', 'emergencyEpoch', 'challenge', 'expiresAt'], 'v2 server hello')
  if (input.protocol !== ACTION_BROKER_PROTOCOL || input.type !== 'server-hello') reject('wrong-protocol', 'v2 server hello protocol is invalid')
  return Object.freeze({
    protocol: ACTION_BROKER_PROTOCOL,
    type: 'server-hello',
    instanceId: instance(input.instanceId, 'hello.instanceId'),
    generation: integer(input.generation, 'hello.generation', 1),
    policyEpoch: integer(input.policyEpoch, 'hello.policyEpoch'),
    emergencyEpoch: integer(input.emergencyEpoch, 'hello.emergencyEpoch'),
    challenge: base64url(input.challenge, 'hello.challenge', 32),
    expiresAt: integer(input.expiresAt, 'hello.expiresAt', 1),
  })
}

export function createActionBrokerServerHello(
  input: { instanceId: string; generation: number; policyEpoch: number; emergencyEpoch: number; expiresAt: number; challenge?: string },
  key: KeyInput,
): ActionBrokerServerHello {
  const unsigned = normalizeHelloUnsignedV2({
    protocol: ACTION_BROKER_PROTOCOL,
    type: 'server-hello',
    instanceId: input.instanceId,
    generation: input.generation,
    policyEpoch: input.policyEpoch,
    emergencyEpoch: input.emergencyEpoch,
    challenge: input.challenge ?? randomBytes(32).toString('base64url'),
    expiresAt: input.expiresAt,
  })
  return Object.freeze({ ...unsigned, signature: signatureFor(V2_HELLO_DOMAIN, unsigned, key) })
}

export function verifyActionBrokerServerHello(
  value: unknown,
  key: KeyInput,
  options: { now?: number; maxTtlMs?: number; expectedInstanceId?: string; minimumGeneration?: number } = {},
): ActionBrokerServerHello {
  const input = exact(value, ['protocol', 'type', 'instanceId', 'generation', 'policyEpoch', 'emergencyEpoch', 'challenge', 'expiresAt', 'signature'], 'v2 server hello')
  const { signature: rawSignature, ...rawUnsigned } = input
  const unsigned = normalizeHelloUnsignedV2(rawUnsigned)
  const signature = base64url(rawSignature, 'hello.signature', 64)
  const now = options.now ?? Date.now()
  const maxTtlMs = options.maxTtlMs ?? ACTION_BROKER_DEFAULT_HELLO_TTL_MS
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(maxTtlMs) || maxTtlMs < 1 || unsigned.expiresAt <= now || unsigned.expiresAt - now > maxTtlMs) {
    reject('expired-hello', 'v2 server hello is expired or has an excessive lifetime')
  }
  if (options.expectedInstanceId !== undefined && unsigned.instanceId !== options.expectedInstanceId) reject('server-identity-mismatch', 'server instance does not match')
  if (options.minimumGeneration !== undefined && unsigned.generation < options.minimumGeneration) reject('server-identity-mismatch', 'server generation regressed')
  verifySignature(V2_HELLO_DOMAIN, unsigned, signature, key)
  return Object.freeze({ ...unsigned, signature })
}

const REQUEST_V2_REQUIRED_KEYS = [
  'protocol', 'type', 'requestId', 'challenge', 'client', 'broker', 'actionId', 'grantId', 'grantRevision', 'grantDigest',
  'domain', 'owner', 'sessionId', 'agentId', 'rootCallId', 'callId', 'operation', 'source', 'destination', 'payload',
  'payloadDigest', 'deadline', 'policyEpoch', 'emergencyEpoch', 'budget', 'clientKeyId',
] as const
const REQUEST_V2_OPTIONAL_KEYS = ['estimatedCostMicros', 'commitDigest', 'predecessorDigest', 'idempotencyKey'] as const

function normalizeRequestUnsignedV2(value: unknown): ActionBrokerClientRequestUnsigned {
  const input = exactOptional(value, REQUEST_V2_REQUIRED_KEYS, REQUEST_V2_OPTIONAL_KEYS, 'v2 client request')
  if (input.protocol !== ACTION_BROKER_PROTOCOL || input.type !== 'client-request') reject('wrong-protocol', 'v2 client request protocol is invalid')
  const domain = normalizeDomain(input.domain)
  const operation = text(input.operation, 'request.operation', 64) as ActionBrokerOperation
  if (!DOMAIN_OPERATIONS[domain].includes(operation)) reject('invalid-message', 'request operation invalid for domain')
  const normalizedDestination = normalizeActionRequestDestination(domain, input.destination)
  const payload = normalizePayloadV2(domain, operation, input.payload)
  const payloadDigest = digest(input.payloadDigest, 'request.payloadDigest')
  if (brokerDigest(payload) !== payloadDigest) reject('digest-mismatch', 'v2 request payload digest does not match')
  const estimatedCostMicros = input.estimatedCostMicros === undefined ? undefined : integer(input.estimatedCostMicros, 'request.estimatedCostMicros', 0)
  const commitDigest = input.commitDigest === undefined ? undefined : digest(input.commitDigest, 'request.commitDigest')
  const predecessorDigest = input.predecessorDigest === undefined ? undefined : digest(input.predecessorDigest, 'request.predecessorDigest')
  const idempotencyKey = input.idempotencyKey === undefined ? undefined : text(input.idempotencyKey, 'request.idempotencyKey', 256)
  return Object.freeze({
    protocol: ACTION_BROKER_PROTOCOL,
    type: 'client-request',
    requestId: text(input.requestId, 'request.requestId'),
    challenge: base64url(input.challenge, 'request.challenge', 32),
    client: endpoint(input.client, ['assistant-actions-host'], 'request.client'),
    broker: endpoint(input.broker, ['action-broker', 'github-broker'], 'request.broker'),
    actionId: text(input.actionId, 'request.actionId'),
    grantId: text(input.grantId, 'request.grantId'),
    grantRevision: integer(input.grantRevision, 'request.grantRevision', 1),
    grantDigest: digest(input.grantDigest, 'request.grantDigest'),
    domain,
    owner: owner(input.owner),
    sessionId: text(input.sessionId, 'request.sessionId'),
    agentId: text(input.agentId, 'request.agentId'),
    rootCallId: text(input.rootCallId, 'request.rootCallId'),
    callId: text(input.callId, 'request.callId'),
    operation,
    source: dataSource(input.source),
    destination: normalizedDestination,
    payload,
    payloadDigest,
    deadline: integer(input.deadline, 'request.deadline', 1),
    policyEpoch: integer(input.policyEpoch, 'request.policyEpoch'),
    emergencyEpoch: integer(input.emergencyEpoch, 'request.emergencyEpoch'),
    budget: normalizeBudgetV2(input.budget),
    clientKeyId: instance(input.clientKeyId, 'request.clientKeyId'),
    ...(estimatedCostMicros === undefined ? {} : { estimatedCostMicros }),
    ...(commitDigest === undefined ? {} : { commitDigest }),
    ...(predecessorDigest === undefined ? {} : { predecessorDigest }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  })
}

export function createActionBrokerClientRequest(
  input: ActionBrokerRequestIntent,
  hello: ActionBrokerServerHello,
  source: Extract<ActionBrokerEndpoint, { kind: 'assistant-actions-host' }>,
  clientKeyId: string,
  key: KeyInput,
  requestId: string = randomUUID(),
): ActionBrokerClientRequest {
  const unsigned = normalizeRequestUnsignedV2({
    protocol: ACTION_BROKER_PROTOCOL,
    type: 'client-request',
    requestId,
    challenge: hello.challenge,
    client: source,
    broker: { kind: 'action-broker', instanceId: hello.instanceId, generation: hello.generation },
    ...input,
    payloadDigest: brokerDigest(input.payload),
    policyEpoch: hello.policyEpoch,
    emergencyEpoch: hello.emergencyEpoch,
    clientKeyId,
  })
  return Object.freeze({ ...unsigned, signature: signatureFor(V2_REQUEST_DOMAIN, unsigned, key) })
}

export function verifyActionBrokerClientRequest(
  value: unknown,
  hello: ActionBrokerServerHello,
  key: KeyInput,
  options: { now?: number; expectedClientKeyId?: string } = {},
): ActionBrokerClientRequest {
  const input = exactOptional(value, [...REQUEST_V2_REQUIRED_KEYS, 'signature'], REQUEST_V2_OPTIONAL_KEYS, 'v2 client request')
  const { signature: rawSignature, ...rawUnsigned } = input
  const unsigned = normalizeRequestUnsignedV2(rawUnsigned)
  const signature = base64url(rawSignature, 'request.signature', 64)
  const now = options.now ?? Date.now()
  if (hello.expiresAt <= now) reject('expired-hello', 'v2 server hello expired before client request verification')
  if (unsigned.deadline <= now) reject('expired-request', 'v2 client request deadline expired')
  if (unsigned.challenge !== hello.challenge || unsigned.broker.instanceId !== hello.instanceId || unsigned.broker.generation !== hello.generation
    || unsigned.policyEpoch !== hello.policyEpoch || unsigned.emergencyEpoch !== hello.emergencyEpoch) {
    reject('challenge-mismatch', 'v2 client request is not bound to this server hello')
  }
  if (options.expectedClientKeyId !== undefined && unsigned.clientKeyId !== options.expectedClientKeyId) {
    reject('client-identity-mismatch', 'client key identity does not match')
  }
  verifySignature(V2_REQUEST_DOMAIN, unsigned, signature, key)
  return Object.freeze({ ...unsigned, signature })
}

export function actionBrokerRequestDigest(request: ActionBrokerClientRequest): string {
  return brokerDigest({
    protocol: ACTION_INTENT_PROTOCOL,
    actionId: request.actionId,
    grantId: request.grantId,
    grantRevision: request.grantRevision,
    grantDigest: request.grantDigest,
    domain: request.domain,
    owner: request.owner,
    sessionId: request.sessionId,
    operation: request.operation,
    source: request.source,
    destination: request.destination,
    payload: request.payload,
    payloadDigest: request.payloadDigest,
    budget: request.budget,
    clientKeyId: request.clientKeyId,
    ...(request.estimatedCostMicros === undefined ? {} : { estimatedCostMicros: request.estimatedCostMicros }),
    ...(request.commitDigest === undefined ? {} : { commitDigest: request.commitDigest }),
    ...(request.predecessorDigest === undefined ? {} : { predecessorDigest: request.predecessorDigest }),
    ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
  })
}

export function actionBrokerWireRequestDigest(request: ActionBrokerClientRequest): string {
  const { signature: _signature, ...unsigned } = request
  return brokerDigest(unsigned)
}

function normalizeSuccessResultV2(value: unknown, request: ActionBrokerClientRequest): ActionBrokerSuccessResult {
  const input = record(value, 'v2 response result')
  if (request.domain === 'github') {
    if (request.operation === 'commit') {
      const result = exact(input, ['operation', 'repository', 'branch', 'parentOid', 'commitOid'], 'commit response result')
      const dest = request.destination as GitHubRequestDestinationV2
      const payload = request.payload as BrokerCommitPayload
      if (result.operation !== 'commit' || result.repository !== dest.repository || result.branch !== dest.branch || result.parentOid !== payload.expectedHeadOid) {
        reject('response-mismatch', 'commit response target does not match')
      }
      return Object.freeze({ operation: 'commit', repository: dest.repository, branch: dest.branch, parentOid: oid(result.parentOid, 'response.parentOid'), commitOid: oid(result.commitOid, 'response.commitOid') })
    }
    if (request.operation === 'pull-request') {
      const result = exact(input, ['operation', 'repository', 'branch', 'baseBranch', 'expectedHeadOid', 'pullRequestNumber'], 'pull request response result')
      const dest = request.destination as GitHubRequestDestinationV2
      const payload = request.payload as BrokerPullRequestPayload
      if (result.operation !== 'pull-request' || result.repository !== dest.repository || result.branch !== dest.branch || result.baseBranch !== dest.baseBranch || result.expectedHeadOid !== payload.expectedHeadOid) {
        reject('response-mismatch', 'pull request response target does not match')
      }
      return Object.freeze({ operation: 'pull-request', repository: dest.repository, branch: dest.branch, baseBranch: validBranch(result.baseBranch, 'response.baseBranch'), expectedHeadOid: oid(result.expectedHeadOid, 'response.expectedHeadOid'), pullRequestNumber: integer(result.pullRequestNumber, 'response.pullRequestNumber', 1) })
    }
    const result = exact(input, ['operation', 'repository', 'branch', 'kind', 'observed', 'observedDigest'], 'inspect response result')
    const dest = request.destination as GitHubRequestDestinationV2
    const payload = request.payload as BrokerInspectPayload
    if (result.operation !== 'inspect' || result.repository !== dest.repository || result.branch !== dest.branch || result.kind !== payload.kind) {
      reject('response-mismatch', 'inspect response target does not match')
    }
    const observed = normalizeBrokerInspectObservation(payload, result.observed, dest)
    if (containsCredentialShapedValue(result.observed)) reject('secret-field', 'credential-shaped response value is forbidden')
    const observedDigest = digest(result.observedDigest, 'response.observedDigest')
    if (createHash('sha256').update(canonicalBrokerJson(observed)).digest('hex') !== observedDigest) reject('digest-mismatch', 'observedDigest mismatch')
    return Object.freeze({ operation: 'inspect', repository: dest.repository, branch: dest.branch, kind: payload.kind, observed, observedDigest })
  }

  if (request.domain === 'http') {
    const result = exact(input, ['domain', 'operation', 'statusCode', 'responseHeaders', 'body', 'bodySha256', 'truncated', 'untrusted'], 'http response result')
    if (result.domain !== 'http' || result.operation !== 'http.request') reject('response-mismatch', 'http response domain/operation mismatch')
    if (typeof result.body !== 'string') reject('invalid-message', 'http response body must be string')
    const bodySha256 = digest(result.bodySha256, 'http response bodySha256')
    if (containsCredentialShapedValue(result.body) || containsCredentialShapedValue(result.responseHeaders)) reject('secret-field', 'credential-shaped http response forbidden')
    return Object.freeze({
      domain: 'http',
      operation: 'http.request',
      statusCode: integer(result.statusCode, 'http.statusCode', 100, 599),
      responseHeaders: stringRecord(result.responseHeaders, 'http.responseHeaders', 128, 8_192),
      body: result.body,
      bodySha256,
      truncated: boolean(result.truncated, 'http.truncated'),
      untrusted: truth(result.untrusted, 'http.untrusted'),
    })
  }

  if (request.domain === 'lark') {
    const result = exactOptional(input, ['domain', 'operation', 'untrusted'], ['messageId', 'chatId', 'observed', 'observedDigest'], 'lark response result')
    if (result.domain !== 'lark' || result.operation !== request.operation) reject('response-mismatch', 'lark response domain/operation mismatch')
    if (containsCredentialShapedValue(result.observed)) reject('secret-field', 'credential-shaped lark response forbidden')
    const observedDigest = result.observedDigest === undefined ? undefined : digest(result.observedDigest, 'lark.observedDigest')
    return Object.freeze({
      domain: 'lark',
      operation: request.operation as 'lark.send-message' | 'lark.reply-message' | 'lark.read-messages',
      ...(result.messageId === undefined ? {} : { messageId: text(result.messageId, 'lark.messageId', 128) }),
      ...(result.chatId === undefined ? {} : { chatId: text(result.chatId, 'lark.chatId', 128) }),
      ...(result.observed === undefined ? {} : { observed: result.observed as BrokerJson }),
      ...(observedDigest === undefined ? {} : { observedDigest }),
      untrusted: truth(result.untrusted, 'lark.untrusted'),
    })
  }

  if (request.domain === 'calendar') {
    const result = exactOptional(input, ['domain', 'operation', 'calendarId', 'untrusted'], ['eventId', 'revision', 'observed', 'observedDigest'], 'calendar response result')
    const dest = request.destination as CalendarRequestDestination
    if (result.domain !== 'calendar' || result.operation !== request.operation || result.calendarId !== dest.calendarId) {
      reject('response-mismatch', 'calendar response mismatch')
    }
    if (containsCredentialShapedValue(result.observed)) reject('secret-field', 'credential-shaped calendar response forbidden')
    const observedDigest = result.observedDigest === undefined ? undefined : digest(result.observedDigest, 'calendar.observedDigest')
    return Object.freeze({
      domain: 'calendar',
      operation: request.operation as 'calendar.list-events' | 'calendar.get-event' | 'calendar.create-event' | 'calendar.update-event' | 'calendar.delete-event',
      calendarId: dest.calendarId,
      ...(result.eventId === undefined ? {} : { eventId: text(result.eventId, 'calendar.eventId', 256) }),
      ...(result.revision === undefined ? {} : { revision: text(result.revision, 'calendar.revision', 128) }),
      ...(result.observed === undefined ? {} : { observed: result.observed as BrokerJson }),
      ...(observedDigest === undefined ? {} : { observedDigest }),
      untrusted: truth(result.untrusted, 'calendar.untrusted'),
    })
  }

  // shell
  const result = exactOptional(input, ['domain', 'operation', 'exitCode', 'stdout', 'stderr', 'stdoutSha256', 'stderrSha256', 'truncated', 'untrusted'], ['signal'], 'shell response result')
  if (result.domain !== 'shell' || result.operation !== 'shell.exec') reject('response-mismatch', 'shell response mismatch')
  if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string') reject('invalid-message', 'shell stdout/stderr must be strings')
  if (containsCredentialShapedValue(result.stdout) || containsCredentialShapedValue(result.stderr)) reject('secret-field', 'credential-shaped shell output forbidden')
  return Object.freeze({
    domain: 'shell',
    operation: 'shell.exec',
    exitCode: integer(result.exitCode, 'shell.exitCode', 0, 255),
    ...(result.signal === undefined ? {} : { signal: text(result.signal, 'shell.signal', 32) }),
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutSha256: digest(result.stdoutSha256, 'shell.stdoutSha256'),
    stderrSha256: digest(result.stderrSha256, 'shell.stderrSha256'),
    truncated: boolean(result.truncated, 'shell.truncated'),
    untrusted: truth(result.untrusted, 'shell.untrusted'),
  })
}

const RESPONSE_V2_KEYS = ['protocol', 'type', 'requestId', 'actionId', 'instanceId', 'generation', 'challenge', 'requestDigest', 'status', 'dispatched', 'result', 'error', 'completedAt'] as const

function normalizeResponseUnsignedV2(value: unknown, request: ActionBrokerClientRequest): ActionBrokerServerResponseUnsigned {
  const input = exact(value, RESPONSE_V2_KEYS, 'v2 server response')
  if (input.protocol !== ACTION_BROKER_PROTOCOL || input.type !== 'server-response' || !['succeeded', 'failed', 'unknown'].includes(String(input.status)) || typeof input.dispatched !== 'boolean') {
    reject('wrong-protocol', 'v2 server response protocol is invalid')
  }
  const status = input.status as ActionBrokerServerResponseUnsigned['status']
  let result: ActionBrokerSuccessResult | null = null
  let error: { readonly code: string } | null = null
  if (status === 'succeeded') {
    if (input.dispatched !== true || input.error !== null) reject('invalid-message', 'successful v2 response state is invalid')
    result = normalizeSuccessResultV2(input.result, request)
  } else {
    if (input.result !== null) reject('invalid-message', 'non-success v2 response must not carry a result')
    const rawError = exact(input.error, ['code'], 'v2 response error')
    const code = text(rawError.code, 'response.error.code')
    if (!ERROR_CODE.test(code)) reject('invalid-message', 'response error code is invalid')
    error = Object.freeze({ code })
    if (status === 'unknown' && input.dispatched !== true) reject('invalid-message', 'unknown response must be post-dispatch')
  }
  return Object.freeze({
    protocol: ACTION_BROKER_PROTOCOL,
    type: 'server-response',
    requestId: text(input.requestId, 'response.requestId'),
    actionId: text(input.actionId, 'response.actionId'),
    instanceId: instance(input.instanceId, 'response.instanceId'),
    generation: integer(input.generation, 'response.generation', 1),
    challenge: base64url(input.challenge, 'response.challenge', 32),
    requestDigest: digest(input.requestDigest, 'response.requestDigest'),
    status,
    dispatched: input.dispatched,
    result,
    error,
    completedAt: integer(input.completedAt, 'response.completedAt', 1),
  })
}

export function createActionBrokerServerResponse(
  input: Pick<ActionBrokerServerResponseUnsigned, 'status' | 'dispatched' | 'result' | 'error' | 'completedAt'>,
  request: ActionBrokerClientRequest,
  hello: ActionBrokerServerHello,
  key: KeyInput,
): ActionBrokerServerResponse {
  const unsigned = normalizeResponseUnsignedV2({
    protocol: ACTION_BROKER_PROTOCOL,
    type: 'server-response',
    requestId: request.requestId,
    actionId: request.actionId,
    instanceId: hello.instanceId,
    generation: hello.generation,
    challenge: hello.challenge,
    requestDigest: actionBrokerWireRequestDigest(request),
    ...input,
  }, request)
  return Object.freeze({ ...unsigned, signature: signatureFor(V2_RESPONSE_DOMAIN, unsigned, key) })
}

export function verifyActionBrokerServerResponse(
  value: unknown,
  request: ActionBrokerClientRequest,
  hello: ActionBrokerServerHello,
  key: KeyInput,
): ActionBrokerServerResponse {
  const input = exact(value, [...RESPONSE_V2_KEYS, 'signature'], 'v2 server response')
  const { signature: rawSignature, ...rawUnsigned } = input
  const unsigned = normalizeResponseUnsignedV2(rawUnsigned, request)
  const signature = base64url(rawSignature, 'response.signature', 64)
  if (unsigned.requestId !== request.requestId || unsigned.actionId !== request.actionId || unsigned.instanceId !== hello.instanceId
    || unsigned.generation !== hello.generation || unsigned.challenge !== hello.challenge || unsigned.requestDigest !== actionBrokerWireRequestDigest(request)) {
    reject('response-mismatch', 'v2 server response is not bound to this request')
  }
  verifySignature(V2_RESPONSE_DOMAIN, unsigned, signature, key)
  return Object.freeze({ ...unsigned, signature })
}

function adminBodyV2(operation: unknown, value: unknown): ActionBrokerAdminIntent['body'] {
  if (operation === 'status') { exact(value, [], 'status body'); return Object.freeze({}) }
  if (operation === 'stop') {
    const input = exact(value, ['expectedControlVersion', 'drainDeadline', 'reason'], 'stop body')
    if (!['operator-request', 'security-response', 'maintenance'].includes(String(input.reason))) reject('invalid-message', 'stop reason invalid')
    return Object.freeze({ expectedControlVersion: integer(input.expectedControlVersion, 'stop expectedControlVersion'), drainDeadline: integer(input.drainDeadline, 'stop drainDeadline', 1), reason: input.reason as 'operator-request' | 'security-response' | 'maintenance' })
  }
  if (operation === 'resume') {
    const input = exact(value, ['expectedControlVersion', 'expectedGeneration'], 'resume body')
    return Object.freeze({ expectedControlVersion: integer(input.expectedControlVersion, 'resume expectedControlVersion'), expectedGeneration: integer(input.expectedGeneration, 'resume expectedGeneration', 1) })
  }
  if (operation === 'revoke') {
    const input = exact(value, ['expectedControlVersion', 'grantId', 'grantRevision', 'grantDigest', 'policyEpoch', 'emergencyEpoch', 'reason'], 'revoke body')
    if (!['operator-request', 'security-response', 'grant-replaced', 'grant-expired'].includes(String(input.reason))) reject('invalid-message', 'revoke reason invalid')
    return Object.freeze({
      expectedControlVersion: integer(input.expectedControlVersion, 'revoke expectedControlVersion'),
      grantId: text(input.grantId, 'revoke grantId'),
      grantRevision: integer(input.grantRevision, 'revoke grantRevision', 1),
      grantDigest: digest(input.grantDigest, 'revoke grantDigest'),
      policyEpoch: integer(input.policyEpoch, 'revoke policyEpoch'),
      emergencyEpoch: integer(input.emergencyEpoch, 'revoke emergencyEpoch'),
      reason: input.reason as 'operator-request' | 'security-response' | 'grant-replaced' | 'grant-expired',
    })
  }
  reject('invalid-message', 'admin operation invalid')
}

const ADMIN_REQUEST_V2_KEYS = ['protocol', 'type', 'requestId', 'nonce', 'challenge', 'source', 'destination', 'operation', 'body', 'deadline', 'adminKeyId'] as const
const ADMIN_RESPONSE_V2_KEYS = ['protocol', 'type', 'requestId', 'instanceId', 'generation', 'challenge', 'requestDigest', 'status', 'state', 'error', 'completedAt'] as const

function normalizeAdminRequestUnsignedV2(value: unknown): ActionBrokerAdminRequestUnsigned {
  const input = exact(value, ADMIN_REQUEST_V2_KEYS, 'v2 admin request')
  if (input.protocol !== ACTION_BROKER_PROTOCOL || input.type !== 'admin-request') reject('wrong-protocol', 'v2 admin request protocol invalid')
  const src = exact(input.source, ['kind', 'instanceId', 'generation'], 'v2 admin source')
  if (src.kind !== 'assistant-actions-admin') reject('invalid-message', 'v2 admin source kind invalid')
  const operation = text(input.operation, 'admin.operation', 32) as ActionBrokerAdminIntent['operation']
  return Object.freeze({
    protocol: ACTION_BROKER_PROTOCOL,
    type: 'admin-request',
    requestId: text(input.requestId, 'admin.requestId'),
    nonce: text(input.nonce, 'admin.nonce', 128),
    challenge: base64url(input.challenge, 'admin.challenge', 32),
    source: Object.freeze({ kind: 'assistant-actions-admin', instanceId: instance(src.instanceId, 'admin.source.instanceId'), generation: integer(src.generation, 'admin.source.generation', 1) }),
    destination: endpoint(input.destination, ['action-broker', 'github-broker'], 'admin.destination'),
    operation,
    body: adminBodyV2(operation, input.body),
    deadline: integer(input.deadline, 'admin.deadline', 1),
    adminKeyId: instance(input.adminKeyId, 'admin.adminKeyId'),
  })
}

export function createActionBrokerAdminRequest(
  intent: ActionBrokerAdminIntent,
  hello: ActionBrokerServerHello,
  source: ActionBrokerAdminEndpoint,
  adminKeyId: string,
  key: KeyInput,
  requestId: string = randomUUID(),
  nonce: string = randomBytes(24).toString('base64url'),
): ActionBrokerAdminRequest {
  const unsigned = normalizeAdminRequestUnsignedV2({
    protocol: ACTION_BROKER_PROTOCOL,
    type: 'admin-request',
    requestId,
    nonce,
    challenge: hello.challenge,
    source,
    destination: { kind: 'action-broker', instanceId: hello.instanceId, generation: hello.generation },
    operation: intent.operation,
    body: intent.body,
    deadline: intent.deadline,
    adminKeyId,
  })
  return Object.freeze({ ...unsigned, signature: signatureFor(V2_ADMIN_REQUEST_DOMAIN, unsigned, key) })
}

export function verifyActionBrokerAdminRequest(
  value: unknown,
  hello: ActionBrokerServerHello,
  key: KeyInput,
  options: { now?: number; expectedAdminKeyId?: string } = {},
): ActionBrokerAdminRequest {
  const input = exact(value, [...ADMIN_REQUEST_V2_KEYS, 'signature'], 'v2 admin request')
  const { signature: rawSignature, ...rawUnsigned } = input
  const unsigned = normalizeAdminRequestUnsignedV2(rawUnsigned)
  const signature = base64url(rawSignature, 'admin.signature', 64)
  const now = options.now ?? Date.now()
  if (hello.expiresAt <= now) reject('expired-hello', 'v2 server hello expired')
  if (unsigned.deadline <= now) reject('expired-request', 'v2 admin request expired')
  if (unsigned.challenge !== hello.challenge || unsigned.destination.instanceId !== hello.instanceId || unsigned.destination.generation !== hello.generation) {
    reject('challenge-mismatch', 'v2 admin request challenge mismatch')
  }
  if (options.expectedAdminKeyId !== undefined && unsigned.adminKeyId !== options.expectedAdminKeyId) reject('client-identity-mismatch', 'adminKeyId mismatch')
  verifySignature(V2_ADMIN_REQUEST_DOMAIN, unsigned, signature, key)
  return Object.freeze({ ...unsigned, signature })
}

export function actionBrokerAdminRequestDigest(request: ActionBrokerAdminRequest): string {
  const { signature: _signature, ...unsigned } = request
  return brokerDigest(unsigned)
}

function normalizeAdminResponseUnsignedV2(value: unknown): ActionBrokerAdminResponseUnsigned {
  const input = exact(value, ADMIN_RESPONSE_V2_KEYS, 'v2 admin response')
  if (input.protocol !== ACTION_BROKER_PROTOCOL || input.type !== 'admin-response' || (input.status !== 'succeeded' && input.status !== 'failed')) {
    reject('wrong-protocol', 'v2 admin response protocol invalid')
  }
  const st = exact(input.state, ['admission', 'generation', 'controlVersion', 'activeRequests', 'revocationEpoch'], 'v2 admin state')
  if (!['accepting', 'draining', 'stopped'].includes(String(st.admission))) reject('invalid-message', 'admin admission invalid')
  let error: { readonly code: string } | null = null
  if (input.status === 'succeeded') {
    if (input.error !== null) reject('invalid-message', 'succeeded admin response must not carry error')
  } else {
    const err = exact(input.error, ['code'], 'admin response error')
    const code = text(err.code, 'admin.error.code')
    if (!ERROR_CODE.test(code)) reject('invalid-message', 'admin error code invalid')
    error = Object.freeze({ code })
  }
  return Object.freeze({
    protocol: ACTION_BROKER_PROTOCOL,
    type: 'admin-response',
    requestId: text(input.requestId, 'admin.response.requestId'),
    instanceId: instance(input.instanceId, 'admin.response.instanceId'),
    generation: integer(input.generation, 'admin.response.generation', 1),
    challenge: base64url(input.challenge, 'admin.response.challenge', 32),
    requestDigest: digest(input.requestDigest, 'admin.response.requestDigest'),
    status: input.status,
    state: Object.freeze({
      admission: st.admission as 'accepting' | 'draining' | 'stopped',
      generation: integer(st.generation, 'admin.state.generation', 1),
      controlVersion: integer(st.controlVersion, 'admin.state.controlVersion'),
      activeRequests: integer(st.activeRequests, 'admin.state.activeRequests'),
      revocationEpoch: integer(st.revocationEpoch, 'admin.state.revocationEpoch'),
    }),
    error,
    completedAt: integer(input.completedAt, 'admin.response.completedAt', 1),
  })
}

export function createActionBrokerAdminResponse(
  input: Pick<ActionBrokerAdminResponseUnsigned, 'status' | 'state' | 'error' | 'completedAt'>,
  request: ActionBrokerAdminRequest,
  hello: ActionBrokerServerHello,
  key: KeyInput,
): ActionBrokerAdminResponse {
  const unsigned = normalizeAdminResponseUnsignedV2({
    protocol: ACTION_BROKER_PROTOCOL,
    type: 'admin-response',
    requestId: request.requestId,
    instanceId: hello.instanceId,
    generation: hello.generation,
    challenge: hello.challenge,
    requestDigest: actionBrokerAdminRequestDigest(request),
    ...input,
  })
  return Object.freeze({ ...unsigned, signature: signatureFor(V2_ADMIN_RESPONSE_DOMAIN, unsigned, key) })
}

export function verifyActionBrokerAdminResponse(
  value: unknown,
  request: ActionBrokerAdminRequest,
  hello: ActionBrokerServerHello,
  key: KeyInput,
): ActionBrokerAdminResponse {
  const input = exact(value, [...ADMIN_RESPONSE_V2_KEYS, 'signature'], 'v2 admin response')
  const { signature: rawSignature, ...rawUnsigned } = input
  const unsigned = normalizeAdminResponseUnsignedV2(rawUnsigned)
  const signature = base64url(rawSignature, 'admin.response.signature', 64)
  if (unsigned.requestId !== request.requestId || unsigned.instanceId !== hello.instanceId || unsigned.generation !== hello.generation
    || unsigned.challenge !== hello.challenge || unsigned.requestDigest !== actionBrokerAdminRequestDigest(request)) {
    reject('response-mismatch', 'v2 admin response does not match request')
  }
  verifySignature(V2_ADMIN_RESPONSE_DOMAIN, unsigned, signature, key)
  return Object.freeze({ ...unsigned, signature })
}

export function actionDestinationString(domain: BrokerActionDomain, destination: ActionRequestDestination): string {
  if (domain === 'github') {
    const dest = destination as GitHubRequestDestinationV2
    return `github://${dest.repository}#${dest.branch}`
  }
  if (domain === 'http') {
    const dest = destination as HttpRequestDestination
    const portSuffix = dest.port === undefined ? '' : `:${dest.port}`
    return `${dest.scheme}://${dest.host}${portSuffix}${dest.path}`
  }
  if (domain === 'lark') {
    const dest = destination as LarkRequestDestination
    return `lark://${dest.tenantKey}/${dest.receiveIdType}/${dest.receiveId}`
  }
  if (domain === 'calendar') {
    const dest = destination as CalendarRequestDestination
    return `calendar://${dest.provider}/${dest.calendarId}`
  }
  const dest = destination as ShellRequestDestination
  return `shell://${dest.executable}?cwd=${dest.cwd}`
}

export function actionScopeKey(domain: BrokerActionDomain, destination: ActionRequestDestination): string {
  return actionDestinationString(domain, destination)
}

export function resolveWp08DestinationString(
  domain: BrokerActionDomain,
  destination: ActionRequestDestination,
  payload: ActionBrokerPayload,
): string {
  const fallback = actionDestinationString(domain, destination)
  if (domain !== 'http') return fallback
  const dest = destination as HttpRequestDestination
  const rawUrl = payload && typeof payload === 'object' ? (payload as Partial<HttpRequestPayload>).url : undefined
  if (typeof rawUrl !== 'string') return fallback
  try {
    const parsed = validateStrictHttpUrl(rawUrl)
    const scheme = parsed.protocol === 'https:' ? 'https' : 'http'
    const host = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
    const port = parsed.port ? Number(parsed.port) : (scheme === 'https' ? 443 : 80)
    if (dest.scheme !== scheme || dest.host.toLowerCase() !== host) return fallback
    if (dest.port !== undefined && dest.port !== port) return fallback
    if (parsed.pathname !== dest.path) return fallback
    return parsed.href
  } catch {
    return fallback
  }
}

export type BrokerActionEnvelope =
  | {
    readonly kind: 'http'
    readonly operation: 'fetch' | 'request' | 'http.request'
    readonly destination: string
    readonly method: HttpMethod
    readonly grantId: string
    readonly idempotencyKey: string
    readonly workspace?: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string
  }
  | {
    readonly kind: 'lark'
    readonly operation: 'send-message' | 'reply-message' | 'read-messages' | 'lark.send-message' | 'lark.reply-message' | 'lark.read-messages'
    readonly chatId: string
    readonly text?: string
    readonly content?: string
    readonly msgType?: LarkMessageType
    readonly tenantKey?: string
    readonly replyToMessageId?: string
    readonly grantId: string
    readonly idempotencyKey: string
  }
  | {
    readonly kind: 'calendar'
    readonly operation: 'list-events' | 'get-event' | 'create-event' | 'update-event' | 'delete-event' | 'calendar.list-events' | 'calendar.get-event' | 'calendar.create-event' | 'calendar.update-event' | 'calendar.delete-event'
    readonly calendarId: string
    readonly startTime?: number
    readonly endTime?: number
    readonly startTimeMs?: number
    readonly endTimeMs?: number
    readonly eventId?: string
    readonly summary?: string
    readonly attendees?: readonly string[]
    readonly grantId: string
    readonly idempotencyKey: string
  }
  | {
    readonly kind: 'shell'
    readonly operation: 'exec' | 'shell.exec'
    readonly command: readonly string[]
    readonly cwd: string
    readonly env?: Readonly<Record<string, string>>
    readonly timeoutMs?: number
    readonly grantId: string
    readonly idempotencyKey: string
  }

export function validateBrokerActionRequest(value: unknown): BrokerActionEnvelope {
  const input = record(value, 'broker action request')
  const kind = input.kind
  const grantId = text(input.grantId, 'request.grantId', 256)
  const idempotencyKey = text(input.idempotencyKey, 'request.idempotencyKey', 256)
  if (containsCredentialShapedValue(input)) reject('secret-field', 'credential-shaped value forbidden in action request')

  if (kind === 'http') {
    const op = text(input.operation, 'http.operation', 32)
    if (!['fetch', 'request', 'http.request'].includes(op)) reject('invalid-message', 'invalid http action operation')
    const destination = text(input.destination, 'http.destination', 4_096)
    try {
      validateStrictHttpUrl(destination)
    } catch (error) {
      reject('invalid-message', error instanceof Error ? error.message : 'http destination URL violates strict safety rules')
    }
    const method = text(input.method ?? 'GET', 'http.method', 16)
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) reject('invalid-message', 'invalid http method')
    const workspace = input.workspace === undefined ? undefined : text(input.workspace, 'http.workspace', 4_096)
    if (workspace !== undefined && !isCanonicalWorkspacePath(workspace)) reject('invalid-message', 'invalid http workspace')
    const headers = input.headers === undefined ? undefined : stringRecord(input.headers, 'http.headers', 32, 4_096)
    const body = input.body === undefined ? undefined : (() => {
      if (typeof input.body !== 'string' || Buffer.byteLength(input.body, 'utf8') > 4 * 1024 * 1024) reject('invalid-message', 'invalid http body')
      return input.body
    })()
    return Object.freeze({
      kind: 'http',
      operation: op as 'fetch' | 'request' | 'http.request',
      destination,
      method: method as HttpMethod,
      grantId,
      idempotencyKey,
      ...(workspace === undefined ? {} : { workspace }),
      ...(headers === undefined ? {} : { headers }),
      ...(body === undefined ? {} : { body }),
    })
  }

  if (kind === 'lark') {
    const op = text(input.operation, 'lark.operation', 32)
    if (!['send-message', 'reply-message', 'read-messages', 'lark.send-message', 'lark.reply-message', 'lark.read-messages'].includes(op)) {
      reject('invalid-message', 'invalid lark action operation')
    }
    const chatId = text(input.chatId, 'lark.chatId', 128)
    if (chatId === '.' || chatId === '..' || /[/\\?%#\s\p{Cc}]/u.test(chatId)) reject('invalid-message', 'invalid lark chatId')
    const textBody = input.text === undefined ? undefined : text(input.text, 'lark.text', 65_536)
    const content = input.content === undefined ? undefined : text(input.content, 'lark.content', 65_536)
    if ((op === 'send-message' || op === 'reply-message' || op === 'lark.send-message' || op === 'lark.reply-message') && textBody === undefined && content === undefined) {
      reject('invalid-message', 'lark message requires text or content')
    }
    const msgType = input.msgType === undefined ? undefined : text(input.msgType, 'lark.msgType', 32)
    if (msgType !== undefined && !['text', 'post', 'interactive'].includes(msgType)) reject('invalid-message', 'invalid lark msgType')
    const tenantKey = input.tenantKey === undefined ? undefined : text(input.tenantKey, 'lark.tenantKey', 128)
    const replyToMessageId = input.replyToMessageId === undefined ? undefined : text(input.replyToMessageId, 'lark.replyToMessageId', 128)
    if (replyToMessageId !== undefined && (replyToMessageId === '.' || replyToMessageId === '..' || /[/\\?%#\s\p{Cc}]/u.test(replyToMessageId))) {
      reject('invalid-message', 'invalid lark replyToMessageId')
    }
    return Object.freeze({
      kind: 'lark',
      operation: op as 'send-message' | 'reply-message' | 'read-messages' | 'lark.send-message' | 'lark.reply-message' | 'lark.read-messages',
      chatId,
      ...(textBody === undefined ? {} : { text: textBody }),
      ...(content === undefined ? {} : { content }),
      ...(msgType === undefined ? {} : { msgType: msgType as LarkMessageType }),
      ...(tenantKey === undefined ? {} : { tenantKey }),
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
      grantId,
      idempotencyKey,
    })
  }

  if (kind === 'calendar') {
    const op = text(input.operation, 'calendar.operation', 32)
    if (!['list-events', 'get-event', 'create-event', 'update-event', 'delete-event', 'calendar.list-events', 'calendar.get-event', 'calendar.create-event', 'calendar.update-event', 'calendar.delete-event'].includes(op)) {
      reject('invalid-message', 'invalid calendar action operation')
    }
    const calendarId = text(input.calendarId, 'calendar.calendarId', 256)
    if (calendarId === '.' || calendarId === '..' || /[/\\?%#\s\p{Cc}]/u.test(calendarId)) reject('invalid-message', 'invalid calendar calendarId')
    const startTime = input.startTime === undefined ? undefined : integer(input.startTime, 'calendar.startTime', 0)
    const endTime = input.endTime === undefined ? undefined : integer(input.endTime, 'calendar.endTime', 1)
    if (startTime !== undefined && endTime !== undefined && startTime >= endTime) reject('invalid-message', 'calendar startTime must precede endTime')
    const startTimeMs = input.startTimeMs === undefined ? undefined : integer(input.startTimeMs, 'calendar.startTimeMs', 0)
    const endTimeMs = input.endTimeMs === undefined ? undefined : integer(input.endTimeMs, 'calendar.endTimeMs', 1)
    if (startTimeMs !== undefined && endTimeMs !== undefined && startTimeMs >= endTimeMs) reject('invalid-message', 'calendar startTimeMs must precede endTimeMs')
    const eventId = input.eventId === undefined ? undefined : text(input.eventId, 'calendar.eventId', 256)
    if (eventId !== undefined && (eventId === '.' || eventId === '..' || /[/\\?%#\s\p{Cc}]/u.test(eventId))) {
      reject('invalid-message', 'invalid calendar eventId')
    }
    const summary = input.summary === undefined ? undefined : text(input.summary, 'calendar.summary', 512)
    const attendees = input.attendees === undefined ? undefined : stringList(input.attendees, 'calendar.attendees', 0, 100, 256)
    return Object.freeze({
      kind: 'calendar',
      operation: op as 'list-events' | 'get-event' | 'create-event' | 'update-event' | 'delete-event' | 'calendar.list-events' | 'calendar.get-event' | 'calendar.create-event' | 'calendar.update-event' | 'calendar.delete-event',
      calendarId,
      ...(startTime === undefined ? {} : { startTime }),
      ...(endTime === undefined ? {} : { endTime }),
      ...(startTimeMs === undefined ? {} : { startTimeMs }),
      ...(endTimeMs === undefined ? {} : { endTimeMs }),
      ...(eventId === undefined ? {} : { eventId }),
      ...(summary === undefined ? {} : { summary }),
      ...(attendees === undefined ? {} : { attendees }),
      grantId,
      idempotencyKey,
    })
  }

  if (kind === 'shell') {
    const op = text(input.operation, 'shell.operation', 32)
    if (op !== 'exec' && op !== 'shell.exec') reject('invalid-message', 'invalid shell action operation')
    if (!Array.isArray(input.command) || input.command.length < 1 || input.command.length > 128) reject('invalid-message', 'shell.command must be a non-empty array')
    const command = Object.freeze(input.command.map((item, idx) => text(item, `shell.command[${idx}]`, 4_096)))
    if (!isAbsoluteCrossPlatform(command[0]!)) reject('invalid-message', 'shell command executable must be absolute')
    const cwd = text(input.cwd, 'shell.cwd', 4_096)
    if (!isAbsoluteCrossPlatform(cwd)) reject('invalid-message', 'shell cwd must be absolute')
    const env = input.env === undefined ? undefined : stringRecord(input.env, 'shell.env', 64, 4_096)
    const timeoutMs = input.timeoutMs === undefined ? undefined : integer(input.timeoutMs, 'shell.timeoutMs', 1, 300_000)
    return Object.freeze({
      kind: 'shell',
      operation: op as 'exec' | 'shell.exec',
      command,
      cwd,
      ...(env === undefined ? {} : { env }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      grantId,
      idempotencyKey,
    })
  }

  reject('invalid-message', `unsupported action kind: ${String(kind)}`)
}
