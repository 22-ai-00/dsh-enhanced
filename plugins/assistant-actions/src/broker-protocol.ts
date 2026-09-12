import { createHash, createPrivateKey, createPublicKey, KeyObject, randomBytes, randomUUID, sign, verify } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

export const GITHUB_BROKER_PROTOCOL = 'assistant-actions/github-broker/v1' as const
export const GITHUB_BROKER_REQUEST_MAX_BYTES = 8 * 1024 * 1024
export const GITHUB_BROKER_RESPONSE_MAX_BYTES = 2 * 1024 * 1024
export const GITHUB_BROKER_DEFAULT_HELLO_TTL_MS = 30_000

const HELLO_DOMAIN = 'assistant-actions/github-broker/v1/server-hello\0'
const REQUEST_DOMAIN = 'assistant-actions/github-broker/v1/client-request\0'
const RESPONSE_DOMAIN = 'assistant-actions/github-broker/v1/server-response\0'
const ADMIN_REQUEST_DOMAIN = 'assistant-actions/github-broker/v1/admin-request\0'
const ADMIN_RESPONSE_DOMAIN = 'assistant-actions/github-broker/v1/admin-response\0'
const MAX_CANONICAL_DEPTH = 64
const MAX_CANONICAL_NODES = 200_000
const DIGEST = /^[0-9a-f]{64}$/
const OID = /^[0-9a-f]{40,128}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const SENSITIVE_KEY = /^(?:access[_-]?token|api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token)$/i
const SENSITIVE_VALUE = /(?:authorization\s*:|bearer\s+|gh[opusr]_|github_pat_|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----)/i
const ERROR_CODE = /^[a-z][a-z0-9-]{0,127}$/

/** Canonical JSON input type; successful inspect responses use stricter DTOs below. */
export type BrokerJson = null | boolean | number | string | readonly BrokerJson[] | { readonly [key: string]: BrokerJson }

export class BrokerProtocolError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(`assistant-actions broker protocol: ${message}`)
    this.name = 'BrokerProtocolError'
    this.code = code
  }
}

function reject(code: string, message: string): never { throw new BrokerProtocolError(code, message) }
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
function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\p{Cc}]/u.test(value)) reject('invalid-message', `${label} is invalid`)
  return value
}
function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) reject('invalid-message', `${label} is invalid`)
  return value
}
function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) reject('invalid-message', `${label} is invalid`)
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
function oid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OID.test(value)) reject('invalid-message', `${label} is invalid`)
  return value
}

function canonical(value: unknown, state: { nodes: number }, depth: number): string {
  if (++state.nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) reject('invalid-json', 'canonical JSON complexity exceeded')
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) reject('invalid-json', 'only safe canonical integers are supported')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CANONICAL_NODES - state.nodes) reject('invalid-json', 'canonical JSON complexity exceeded')
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) reject('invalid-json', 'arrays must use the ordinary JSON shape')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.keys(descriptors).some(key => key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
      || Object.entries(descriptors).some(([key, descriptor]) => key !== 'length' && (!descriptor.enumerable || !('value' in descriptor)))) reject('invalid-json', 'arrays must be dense enumerable data values')
    const entries: string[] = []
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(descriptors, String(index))) reject('invalid-json', 'arrays must be dense enumerable data values')
      entries.push(canonical(value[index], state, depth + 1))
    }
    return `[${entries.join(',')}]`
  }
  if (typeof value !== 'object') reject('invalid-json', 'unsupported JSON value')
  const input = record(value, 'canonical JSON object')
  const keys = Object.keys(input)
  if (keys.length > MAX_CANONICAL_NODES - state.nodes) reject('invalid-json', 'canonical JSON complexity exceeded')
  keys.sort()
  return `{${keys.map(key => {
    if (SENSITIVE_KEY.test(key)) reject('secret-field', 'credentials are forbidden on the broker wire')
    return `${JSON.stringify(key)}:${canonical(input[key], state, depth + 1)}`
  }).join(',')}}`
}

/** RFC-8785-style deterministic JSON for this integer-only protocol. */
export function canonicalBrokerJson(value: unknown): string { return canonical(value, { nodes: 0 }, 0) }
export function brokerDigest(value: unknown): string { return createHash('sha256').update(canonicalBrokerJson(value)).digest('hex') }

function parseCanonicalJson(bytes: Buffer): unknown {
  const source = bytes.toString('utf8')
  if (!Buffer.from(source, 'utf8').equals(bytes)) reject('invalid-json', 'frame is not valid UTF-8')
  preflightJsonComplexity(source)
  let value: unknown
  try { value = JSON.parse(source) as unknown } catch { reject('invalid-json', 'frame is not valid JSON') }
  if (canonicalBrokerJson(value) !== source) reject('non-canonical-json', 'frame JSON is not canonical')
  return value
}

/** Bound structural work before JSON.parse allocates an attacker-sized tree. */
function preflightJsonComplexity(source: string): void {
  let depth = 0, tokens = 1, inString = false, escaped = false
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') { inString = true; tokens++ }
    else if (character === '{' || character === '[') { depth++; tokens++; if (depth > MAX_CANONICAL_DEPTH) reject('invalid-json', 'canonical JSON complexity exceeded') }
    else if (character === '}' || character === ']') depth--
    else if (character === ',') tokens++
    if (tokens > MAX_CANONICAL_NODES || depth < 0) reject('invalid-json', 'canonical JSON complexity exceeded')
  }
  if (inString || escaped || depth !== 0) reject('invalid-json', 'frame is not valid JSON')
}

export function encodeBrokerFrame(value: unknown, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 0xffff_ffff) reject('invalid-limit', 'frame limit is invalid')
  const payload = Buffer.from(canonicalBrokerJson(value), 'utf8')
  if (payload.length > maxBytes) reject('frame-too-large', 'frame exceeds its byte limit')
  const output = Buffer.allocUnsafe(payload.length + 4)
  output.writeUInt32BE(payload.length, 0)
  payload.copy(output, 4)
  return output
}

/** Incremental four-byte big-endian length-prefixed canonical JSON decoder. */
export class BrokerFrameDecoder {
  readonly #maxBytes: number
  readonly #maxFrames: number
  readonly #header = Buffer.alloc(4)
  #headerOffset = 0
  #payload: Buffer | undefined
  #payloadOffset = 0
  #frames = 0
  constructor(maxBytes: number, maxFrames = 1) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 0xffff_ffff || !Number.isSafeInteger(maxFrames) || maxFrames < 1) reject('invalid-limit', 'decoder limits are invalid')
    this.#maxBytes = maxBytes
    this.#maxFrames = maxFrames
  }
  push(chunk: Buffer | Uint8Array): unknown[] {
    if (!(chunk instanceof Uint8Array)) reject('invalid-frame', 'frame chunk is invalid')
    if (chunk.byteLength === 0) return []
    if (this.#frames >= this.#maxFrames) reject('trailing-data', 'bytes follow the final frame')
    const output: unknown[] = []
    const input = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let offset = 0
    while (offset < input.length) {
      if (this.#frames >= this.#maxFrames) reject('trailing-data', 'bytes follow the final frame')
      if (!this.#payload) {
        const copied = input.copy(this.#header, this.#headerOffset, offset, Math.min(input.length, offset + 4 - this.#headerOffset))
        this.#headerOffset += copied; offset += copied
        if (this.#headerOffset < 4) continue
        const length = this.#header.readUInt32BE(0)
        if (length === 0) reject('invalid-frame', 'empty frames are invalid')
        if (length > this.#maxBytes) reject('frame-too-large', 'declared frame exceeds its byte limit')
        this.#payload = Buffer.allocUnsafe(length); this.#payloadOffset = 0
      }
      const copied = input.copy(this.#payload, this.#payloadOffset, offset, Math.min(input.length, offset + this.#payload.length - this.#payloadOffset))
      this.#payloadOffset += copied; offset += copied
      if (this.#payloadOffset === this.#payload.length) {
        output.push(parseCanonicalJson(this.#payload))
        this.#frames++; this.#headerOffset = 0; this.#payload = undefined; this.#payloadOffset = 0
      }
    }
    return output
  }
  finish(): void {
    if (this.#headerOffset !== 0 || this.#payload !== undefined) reject('truncated-frame', 'connection ended during a frame')
  }
  get frameCount(): number { return this.#frames }
}

type KeyInput = KeyObject | string | Buffer
function privateKey(value: KeyInput): KeyObject {
  let key: KeyObject
  try { key = value instanceof KeyObject ? value : createPrivateKey(value) } catch { reject('invalid-key', 'client private key is invalid') }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') reject('invalid-key', 'client private key must be Ed25519')
  return key
}
function publicKey(value: KeyInput): KeyObject {
  let key: KeyObject
  try {
    if (value instanceof KeyObject && value.type === 'public') key = value
    else key = createPublicKey(value)
  } catch { reject('invalid-key', 'server public key is invalid') }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') reject('invalid-key', 'server public key must be Ed25519')
  return key
}
function signingBytes(domain: string, value: unknown): Buffer { return Buffer.from(domain + canonicalBrokerJson(value), 'utf8') }
function signatureFor(domain: string, value: unknown, key: KeyInput): string { return sign(null, signingBytes(domain, value), privateKey(key)).toString('base64url') }
function verifySignature(domain: string, value: unknown, signature: string, key: KeyInput): void {
  if (!verify(null, signingBytes(domain, value), publicKey(key), Buffer.from(signature, 'base64url'))) reject('invalid-signature', 'signature verification failed')
}

export interface BrokerServerHelloUnsigned {
  protocol: typeof GITHUB_BROKER_PROTOCOL
  type: 'server-hello'
  instanceId: string
  generation: number
  policyEpoch: number
  emergencyEpoch: number
  challenge: string
  expiresAt: number
}
export interface BrokerServerHello extends BrokerServerHelloUnsigned { signature: string }

export function createBrokerServerHello(input: { instanceId: string; generation: number; policyEpoch: number; emergencyEpoch: number; expiresAt: number; challenge?: string }, key: KeyInput): BrokerServerHello {
  const unsigned = normalizeHelloUnsigned({ protocol: GITHUB_BROKER_PROTOCOL, type: 'server-hello', instanceId: input.instanceId, generation: input.generation, policyEpoch: input.policyEpoch, emergencyEpoch: input.emergencyEpoch, challenge: input.challenge ?? randomBytes(32).toString('base64url'), expiresAt: input.expiresAt })
  return Object.freeze({ ...unsigned, signature: signatureFor(HELLO_DOMAIN, unsigned, key) })
}
function normalizeHelloUnsigned(value: unknown): BrokerServerHelloUnsigned {
  const input = exact(value, ['protocol', 'type', 'instanceId', 'generation', 'policyEpoch', 'emergencyEpoch', 'challenge', 'expiresAt'], 'server hello')
  if (input.protocol !== GITHUB_BROKER_PROTOCOL || input.type !== 'server-hello') reject('wrong-protocol', 'server hello protocol is invalid')
  return Object.freeze({ protocol: GITHUB_BROKER_PROTOCOL, type: 'server-hello', instanceId: instance(input.instanceId, 'hello.instanceId'), generation: integer(input.generation, 'hello.generation', 1), policyEpoch: integer(input.policyEpoch, 'hello.policyEpoch'), emergencyEpoch: integer(input.emergencyEpoch, 'hello.emergencyEpoch'), challenge: base64url(input.challenge, 'hello.challenge', 32), expiresAt: integer(input.expiresAt, 'hello.expiresAt', 1) })
}
export function verifyBrokerServerHello(value: unknown, key: KeyInput, options: { now?: number; maxTtlMs?: number; expectedInstanceId?: string; minimumGeneration?: number } = {}): BrokerServerHello {
  const input = exact(value, ['protocol', 'type', 'instanceId', 'generation', 'policyEpoch', 'emergencyEpoch', 'challenge', 'expiresAt', 'signature'], 'server hello')
  const { signature: rawSignature, ...rawUnsigned } = input
  const unsigned = normalizeHelloUnsigned(rawUnsigned)
  const signature = base64url(rawSignature, 'hello.signature', 64)
  const now = options.now ?? Date.now(), maxTtlMs = options.maxTtlMs ?? GITHUB_BROKER_DEFAULT_HELLO_TTL_MS
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(maxTtlMs) || maxTtlMs < 1 || unsigned.expiresAt <= now || unsigned.expiresAt - now > maxTtlMs) reject('expired-hello', 'server hello is expired or has an excessive lifetime')
  if (options.expectedInstanceId !== undefined && unsigned.instanceId !== options.expectedInstanceId) reject('server-identity-mismatch', 'server instance does not match')
  if (options.minimumGeneration !== undefined && unsigned.generation < options.minimumGeneration) reject('server-identity-mismatch', 'server generation regressed')
  verifySignature(HELLO_DOMAIN, unsigned, signature, key)
  return Object.freeze({ ...unsigned, signature })
}

export type BrokerEndpoint =
  | { kind: 'assistant-actions-host'; instanceId: string; generation: number }
  | { kind: 'github-broker'; instanceId: string; generation: number }
export type BrokerSourceClassification = 'public' | 'internal' | 'confidential' | 'restricted'
export interface BrokerDataSource { classification: BrokerSourceClassification; provenanceDigest: string }
export interface BrokerDestination { classification: 'github-repository'; repository: string; branch: string; baseBranch?: string }
export interface BrokerBudget { reservationId: string; actions: number; bytes: number; costMetric: 'github-api-units'; maxCostUnits: number }
export interface BrokerCommitPayload { expectedHeadOid: string; headline: string; files: readonly Readonly<{ path: string; content: string }>[] }
export interface BrokerPullRequestPayload { expectedHeadOid: string; title: string; body: string }
export interface BrokerInspectPayload { kind: 'repository' | 'branch' | 'file' | 'pull-request' | 'checks' | 'reviews'; path?: string; pullRequestNumber?: number }
export type BrokerOperation = 'commit' | 'inspect' | 'pull-request'
export type BrokerOperationPayload = BrokerCommitPayload | BrokerInspectPayload | BrokerPullRequestPayload
export interface BrokerRequestIntent {
  actionId: string
  grantId: string
  grantRevision: number
  grantDigest: string
  owner: { principalDigest: string; principalRecordId: string; principalVersion: number; workspace: string; preset: string; bindingId: string; bindingVersion: number; bindingGeneration: number }
  sessionId: string
  agentId: string
  rootCallId: string
  callId: string
  operation: BrokerOperation
  source: BrokerDataSource
  destination: BrokerDestination
  payload: BrokerOperationPayload
  deadline: number
  budget: BrokerBudget
}
export interface BrokerClientRequestUnsigned extends BrokerRequestIntent {
  protocol: typeof GITHUB_BROKER_PROTOCOL
  type: 'client-request'
  requestId: string
  challenge: string
  client: Extract<BrokerEndpoint, { kind: 'assistant-actions-host' }>
  broker: Extract<BrokerEndpoint, { kind: 'github-broker' }>
  payloadDigest: string
  policyEpoch: number
  emergencyEpoch: number
  clientKeyId: string
}
export interface BrokerClientRequest extends BrokerClientRequestUnsigned { signature: string }

export interface BrokerGrantAuthorityUnsigned {
  protocol: 'assistant-actions/external-github-grant/v1'
  id: string
  revision: number
  clientKeyId: string
  owner: BrokerRequestIntent['owner']
  sessionId: string
  destination: BrokerDestination & { paths: readonly string[] }
  credentialId: string
  expiresAt: number
  maxActions: number
  maxTotalBytes: number
  maxCostUnits: number
  allowedOperations: readonly BrokerOperation[]
  allowedInspectKinds: readonly BrokerInspectPayload['kind'][]
  verifiedDelivery?: { ownerRouteId: string; budgetId: string; acceptance?: 'goal-outcome' | 'goal-step' }
  client: Extract<BrokerEndpoint, { kind: 'assistant-actions-host' }>
  source: BrokerDataSource
  policyEpoch: number
  emergencyEpoch: number
}
export interface BrokerGrantProjection {
  id: string
  revision: number
  grantDigest: string
  owner: BrokerRequestIntent['owner']
  sessionId: string
  destination: BrokerDestination & { paths: readonly string[] }
  expiresAt: number
  maxActions: number
  maxTotalBytes: number
  source: BrokerDataSource
  maxCostUnits: number
  allowedOperations: readonly BrokerOperation[]
  allowedInspectKinds: readonly BrokerInspectPayload['kind'][]
  verifiedDelivery?: { ownerRouteId: string; budgetId: string; acceptance?: 'goal-outcome' | 'goal-step' }
}

/**
 * Canonical digest of the broker-authoritative grant, including fields that
 * remain private to the broker. Host projections consume this issued digest;
 * they must never attempt to reconstruct it from a reduced mirror.
 */
export function normalizeBrokerGrantAuthority(value: unknown): BrokerGrantAuthorityUnsigned {
  const input = exactOptional(value, ['protocol', 'id', 'revision', 'clientKeyId', 'owner', 'sessionId', 'destination', 'credentialId', 'expiresAt', 'maxActions', 'maxTotalBytes', 'maxCostUnits', 'allowedOperations', 'allowedInspectKinds', 'client', 'source', 'policyEpoch', 'emergencyEpoch'], ['verifiedDelivery'], 'broker grant')
  if (input.protocol !== 'assistant-actions/external-github-grant/v1') reject('wrong-protocol', 'broker grant protocol is invalid')
  const normalizedOwner = owner(input.owner)
  if (!isAbsolute(normalizedOwner.workspace) || resolve(normalizedOwner.workspace) !== normalizedOwner.workspace || normalizedOwner.workspace === '/') reject('invalid-message', 'broker grant workspace is invalid')
  const rawDestination = grantDestination(input.destination, 'broker grant destination')
  const normalizedDestination = destination({ classification: rawDestination.classification, repository: rawDestination.repository, branch: rawDestination.branch, ...(rawDestination.baseBranch === undefined ? {} : { baseBranch: rawDestination.baseBranch }) })
  if (!Array.isArray(rawDestination.paths) || rawDestination.paths.length < 1 || rawDestination.paths.length > 128 || !rawDestination.paths.every(validPath) || new Set(rawDestination.paths).size !== rawDestination.paths.length) reject('invalid-message', 'broker grant paths are invalid')
  if (!Array.isArray(input.allowedOperations) || input.allowedOperations.length < 1 || input.allowedOperations.length > 3 || input.allowedOperations.some(value => !['commit', 'inspect', 'pull-request'].includes(String(value))) || new Set(input.allowedOperations).size !== input.allowedOperations.length) reject('invalid-message', 'broker grant operations are invalid')
  if (!Array.isArray(input.allowedInspectKinds) || input.allowedInspectKinds.length > 6 || input.allowedInspectKinds.some(value => !['repository', 'branch', 'file', 'pull-request', 'checks', 'reviews'].includes(String(value))) || new Set(input.allowedInspectKinds).size !== input.allowedInspectKinds.length
    || input.allowedOperations.includes('inspect') !== (input.allowedInspectKinds.length > 0)) reject('invalid-message', 'broker grant inspect kinds are invalid')
  if (input.allowedInspectKinds.some(kind => ['pull-request', 'checks', 'reviews'].includes(String(kind)))
    && (normalizedDestination.baseBranch === undefined || normalizedDestination.baseBranch === normalizedDestination.branch)) reject('invalid-message', 'broker grant base branch is required for pull request inspection')
  if (input.allowedOperations.includes('pull-request') && (normalizedDestination.baseBranch === undefined || normalizedDestination.baseBranch === normalizedDestination.branch)) reject('invalid-message', 'broker grant base branch is required for pull request delivery')
  const verifiedDelivery = input.verifiedDelivery === undefined ? undefined : deliveryMetadata(input.verifiedDelivery, 'broker grant verified delivery')
  if (verifiedDelivery !== undefined && !input.allowedOperations.includes('commit')) reject('invalid-message', 'broker grant verified delivery requires commit authority')
  return Object.freeze({
    protocol: 'assistant-actions/external-github-grant/v1', id: text(input.id, 'broker grant id'), revision: integer(input.revision, 'broker grant revision', 1), clientKeyId: instance(input.clientKeyId, 'broker grant clientKeyId'), owner: normalizedOwner, sessionId: text(input.sessionId, 'broker grant sessionId'),
    destination: Object.freeze({ ...normalizedDestination, paths: Object.freeze([...rawDestination.paths]) }) as BrokerGrantAuthorityUnsigned['destination'], credentialId: instance(input.credentialId, 'broker grant credentialId'), expiresAt: integer(input.expiresAt, 'broker grant expiresAt', 1),
    maxActions: integer(input.maxActions, 'broker grant maxActions', 1, 10_000), maxTotalBytes: integer(input.maxTotalBytes, 'broker grant maxTotalBytes', 1, 64 * 1024 * 1024), maxCostUnits: integer(input.maxCostUnits, 'broker grant maxCostUnits'),
    allowedOperations: Object.freeze([...input.allowedOperations]) as BrokerGrantAuthorityUnsigned['allowedOperations'], allowedInspectKinds: Object.freeze([...input.allowedInspectKinds]) as BrokerGrantAuthorityUnsigned['allowedInspectKinds'], ...(verifiedDelivery === undefined ? {} : { verifiedDelivery }),
    client: endpoint(input.client, 'assistant-actions-host', 'broker grant client') as Extract<BrokerEndpoint, { kind: 'assistant-actions-host' }>, source: dataSource(input.source), policyEpoch: integer(input.policyEpoch, 'broker grant policyEpoch'), emergencyEpoch: integer(input.emergencyEpoch, 'broker grant emergencyEpoch'),
  })
}
export function brokerGrantAuthorityDigest(grant: BrokerGrantAuthorityUnsigned): string {
  return brokerDigest(normalizeBrokerGrantAuthority(grant))
}
export function createBrokerGrantProjection(grant: BrokerGrantAuthorityUnsigned): BrokerGrantProjection {
  const value = normalizeBrokerGrantAuthority(grant)
  return Object.freeze({ id: value.id, revision: value.revision, grantDigest: brokerGrantAuthorityDigest(value), owner: value.owner, sessionId: value.sessionId, destination: value.destination, expiresAt: value.expiresAt, maxActions: value.maxActions, maxTotalBytes: value.maxTotalBytes, source: value.source, maxCostUnits: value.maxCostUnits, allowedOperations: value.allowedOperations, allowedInspectKinds: value.allowedInspectKinds, ...(value.verifiedDelivery === undefined ? {} : { verifiedDelivery: value.verifiedDelivery }) })
}
export function normalizeBrokerGrantProjection(value: unknown): BrokerGrantProjection {
  const input = exactOptional(value, ['id', 'revision', 'grantDigest', 'owner', 'sessionId', 'destination', 'expiresAt', 'maxActions', 'maxTotalBytes', 'source', 'maxCostUnits', 'allowedOperations', 'allowedInspectKinds'], ['verifiedDelivery'], 'broker grant projection')
  const rawDestination = grantDestination(input.destination, 'broker grant projection destination')
  const normalizedDestination = destination({ classification: rawDestination.classification, repository: rawDestination.repository, branch: rawDestination.branch, ...(rawDestination.baseBranch === undefined ? {} : { baseBranch: rawDestination.baseBranch }) })
  if (!Array.isArray(rawDestination.paths) || rawDestination.paths.length < 1 || rawDestination.paths.length > 128 || !rawDestination.paths.every(validPath) || new Set(rawDestination.paths).size !== rawDestination.paths.length) reject('invalid-message', 'broker grant projection paths are invalid')
  if (!Array.isArray(input.allowedOperations) || input.allowedOperations.length < 1 || input.allowedOperations.length > 3 || input.allowedOperations.some(value => !['commit', 'inspect', 'pull-request'].includes(String(value))) || new Set(input.allowedOperations).size !== input.allowedOperations.length) reject('invalid-message', 'broker grant projection operations are invalid')
  if (!Array.isArray(input.allowedInspectKinds) || input.allowedInspectKinds.length > 6 || input.allowedInspectKinds.some(value => !['repository', 'branch', 'file', 'pull-request', 'checks', 'reviews'].includes(String(value))) || new Set(input.allowedInspectKinds).size !== input.allowedInspectKinds.length
    || input.allowedOperations.includes('inspect') !== (input.allowedInspectKinds.length > 0)) reject('invalid-message', 'broker grant projection inspect kinds are invalid')
  if (input.allowedInspectKinds.some(kind => ['pull-request', 'checks', 'reviews'].includes(String(kind)))
    && (normalizedDestination.baseBranch === undefined || normalizedDestination.baseBranch === normalizedDestination.branch)) reject('invalid-message', 'broker grant projection base branch is required for pull request inspection')
  if (input.allowedOperations.includes('pull-request') && (normalizedDestination.baseBranch === undefined || normalizedDestination.baseBranch === normalizedDestination.branch)) reject('invalid-message', 'broker grant projection base branch is required for pull request delivery')
  const verifiedDelivery = input.verifiedDelivery === undefined ? undefined : deliveryMetadata(input.verifiedDelivery, 'broker grant projection verified delivery')
  if (verifiedDelivery !== undefined && !input.allowedOperations.includes('commit')) reject('invalid-message', 'broker grant projection verified delivery requires commit authority')
  const normalizedOwner = owner(input.owner)
  if (!isAbsolute(normalizedOwner.workspace) || resolve(normalizedOwner.workspace) !== normalizedOwner.workspace || normalizedOwner.workspace === '/') reject('invalid-message', 'broker grant projection workspace is invalid')
  return Object.freeze({ id: text(input.id, 'broker grant projection id'), revision: integer(input.revision, 'broker grant projection revision', 1), grantDigest: digest(input.grantDigest, 'broker grant projection digest'), owner: normalizedOwner, sessionId: text(input.sessionId, 'broker grant projection sessionId'), destination: Object.freeze({ ...normalizedDestination, paths: Object.freeze([...rawDestination.paths]) }) as BrokerGrantProjection['destination'], expiresAt: integer(input.expiresAt, 'broker grant projection expiresAt', 1), maxActions: integer(input.maxActions, 'broker grant projection maxActions', 1, 10_000), maxTotalBytes: integer(input.maxTotalBytes, 'broker grant projection maxTotalBytes', 1, 64 * 1024 * 1024), source: dataSource(input.source), maxCostUnits: integer(input.maxCostUnits, 'broker grant projection maxCostUnits'), allowedOperations: Object.freeze([...input.allowedOperations]) as BrokerGrantProjection['allowedOperations'], allowedInspectKinds: Object.freeze([...input.allowedInspectKinds]) as BrokerGrantProjection['allowedInspectKinds'], ...(verifiedDelivery === undefined ? {} : { verifiedDelivery }) })
}

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\\p{Cc}]/u.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}
function deliveryMetadata(value: unknown, label: string): { ownerRouteId: string; budgetId: string; acceptance?: 'goal-outcome' | 'goal-step' } {
  const input = exactOptional(value, ['ownerRouteId', 'budgetId'], ['acceptance'], label)
  if (input.acceptance !== undefined && input.acceptance !== 'goal-outcome' && input.acceptance !== 'goal-step') reject('invalid-message', `${label} acceptance is invalid`)
  return Object.freeze(input.acceptance === undefined ? { ownerRouteId: text(input.ownerRouteId, `${label} owner route`, 200), budgetId: text(input.budgetId, `${label} budget`, 200) } : { ownerRouteId: text(input.ownerRouteId, `${label} owner route`, 200), budgetId: text(input.budgetId, `${label} budget`, 200), acceptance: input.acceptance })
}
function dataSource(value: unknown): BrokerDataSource {
  const input = exact(value, ['classification', 'provenanceDigest'], 'request.source')
  if (!['public', 'internal', 'confidential', 'restricted'].includes(String(input.classification))) reject('invalid-message', 'request source classification is invalid')
  return Object.freeze({ classification: input.classification as BrokerSourceClassification, provenanceDigest: digest(input.provenanceDigest, 'request.source.provenanceDigest') })
}
function validBranch(value: unknown, label: string): string {
  const branch = text(value, label, 255)
  if (!BRANCH.test(branch) || branch.includes('..') || branch.startsWith('refs/') || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) reject('invalid-message', `${label} is invalid`)
  return branch
}
function grantDestination(value: unknown, label: string): Record<string, unknown> {
  const input = record(value, label)
  if (Object.keys(input).some(key => !['classification', 'repository', 'branch', 'baseBranch', 'paths'].includes(key))
    || !Object.hasOwn(input, 'classification') || !Object.hasOwn(input, 'repository') || !Object.hasOwn(input, 'branch') || !Object.hasOwn(input, 'paths')) reject('unknown-field', `${label} has unknown or missing fields`)
  return input
}
function destination(value: unknown): BrokerDestination {
  const input = record(value, 'request.destination')
  if (Object.keys(input).some(key => !['classification', 'repository', 'branch', 'baseBranch'].includes(key))
    || !Object.hasOwn(input, 'classification') || !Object.hasOwn(input, 'repository') || !Object.hasOwn(input, 'branch')) reject('unknown-field', 'request.destination has unknown or missing fields')
  if (input.classification !== 'github-repository' || typeof input.repository !== 'string' || input.repository.length > 256 || !REPOSITORY.test(input.repository)) reject('invalid-message', 'request destination repository is invalid')
  const branch = validBranch(input.branch, 'request.destination.branch')
  const baseBranch = input.baseBranch === undefined ? undefined : validBranch(input.baseBranch, 'request.destination.baseBranch')
  return Object.freeze(baseBranch === undefined ? { classification: 'github-repository', repository: input.repository, branch } : { classification: 'github-repository', repository: input.repository, branch, baseBranch })
}
function endpoint<K extends BrokerEndpoint['kind']>(value: unknown, kind: K, label: string): Extract<BrokerEndpoint, { kind: K }> {
  const input = exact(value, ['kind', 'instanceId', 'generation'], label)
  if (input.kind !== kind) reject('invalid-message', `${label}.kind is invalid`)
  return Object.freeze({ kind, instanceId: instance(input.instanceId, `${label}.instanceId`), generation: integer(input.generation, `${label}.generation`, 1) }) as Extract<BrokerEndpoint, { kind: K }>
}
function budget(value: unknown): BrokerBudget {
  const input = exact(value, ['reservationId', 'actions', 'bytes', 'costMetric', 'maxCostUnits'], 'request.budget')
  if (input.costMetric !== 'github-api-units') reject('invalid-message', 'request budget cost metric is invalid')
  return Object.freeze({ reservationId: text(input.reservationId, 'request.budget.reservationId'), actions: integer(input.actions, 'request.budget.actions', 1), bytes: integer(input.bytes, 'request.budget.bytes', 0), costMetric: 'github-api-units', maxCostUnits: integer(input.maxCostUnits, 'request.budget.maxCostUnits') })
}
function owner(value: unknown): BrokerRequestIntent['owner'] {
  const input = exact(value, ['principalDigest', 'principalRecordId', 'principalVersion', 'workspace', 'preset', 'bindingId', 'bindingVersion', 'bindingGeneration'], 'request.owner')
  const workspace = text(input.workspace, 'request.owner.workspace', 4096)
  if (!isAbsolute(workspace) || resolve(workspace) !== workspace || workspace === '/') reject('invalid-message', 'request owner workspace is invalid')
  return Object.freeze({ principalDigest: digest(input.principalDigest, 'request.owner.principalDigest'), principalRecordId: text(input.principalRecordId, 'request.owner.principalRecordId'), principalVersion: integer(input.principalVersion, 'request.owner.principalVersion', 1), workspace, preset: text(input.preset, 'request.owner.preset'), bindingId: text(input.bindingId, 'request.owner.bindingId'), bindingVersion: integer(input.bindingVersion, 'request.owner.bindingVersion', 1), bindingGeneration: integer(input.bindingGeneration, 'request.owner.bindingGeneration', 1) })
}
function commitPayload(value: unknown): BrokerCommitPayload {
  const input = exact(value, ['expectedHeadOid', 'headline', 'files'], 'commit payload')
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 32) reject('invalid-message', 'commit payload files are invalid')
  const files = Object.freeze(input.files.map((value, index) => {
    const file = exact(value, ['path', 'content'], `commit payload file ${index}`)
    if (!validPath(file.path) || typeof file.content !== 'string' || Buffer.byteLength(file.content) > 1_048_576 || Buffer.from(file.content, 'utf8').toString('utf8') !== file.content) reject('invalid-message', 'commit payload file is invalid')
    return Object.freeze({ path: file.path, content: file.content })
  }))
  if (new Set(files.map(file => file.path)).size !== files.length) reject('invalid-message', 'commit payload paths are not unique')
  return Object.freeze({ expectedHeadOid: oid(input.expectedHeadOid, 'commit payload expectedHeadOid'), headline: text(input.headline, 'commit payload headline', 200), files })
}
function pullRequestPayload(value: unknown): BrokerPullRequestPayload {
  const input = exact(value, ['expectedHeadOid', 'title', 'body'], 'pull request payload')
  if (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 65_536 || Buffer.from(input.body, 'utf8').toString('utf8') !== input.body) reject('invalid-message', 'pull request payload body is invalid')
  return Object.freeze({ expectedHeadOid: oid(input.expectedHeadOid, 'pull request payload expectedHeadOid'), title: text(input.title, 'pull request payload title', 200), body: input.body })
}
function inspectPayload(value: unknown): BrokerInspectPayload {
  const input = record(value, 'inspect payload')
  const kind = input.kind
  if (!['repository', 'branch', 'file', 'pull-request', 'checks', 'reviews'].includes(String(kind))) reject('invalid-message', 'inspect kind is invalid')
  const expected = kind === 'file' ? ['kind', 'path'] : ['pull-request', 'checks', 'reviews'].includes(String(kind)) ? ['kind', 'pullRequestNumber'] : ['kind']
  exact(input, expected, 'inspect payload')
  if (kind === 'file') {
    if (!validPath(input.path)) reject('invalid-message', 'inspect path is invalid')
    return Object.freeze({ kind, path: input.path }) as BrokerInspectPayload
  }
  if (expected.length === 2) return Object.freeze({ kind, pullRequestNumber: integer(input.pullRequestNumber, 'inspect pullRequestNumber', 1) }) as BrokerInspectPayload
  return Object.freeze({ kind }) as BrokerInspectPayload
}
function normalizePayload(operation: unknown, value: unknown): BrokerOperationPayload {
  if (operation === 'commit') return commitPayload(value)
  if (operation === 'inspect') return inspectPayload(value)
  if (operation === 'pull-request') return pullRequestPayload(value)
  reject('invalid-message', 'request operation is invalid')
}

const REQUEST_UNSIGNED_KEYS = ['protocol', 'type', 'requestId', 'challenge', 'client', 'broker', 'actionId', 'grantId', 'grantRevision', 'grantDigest', 'owner', 'sessionId', 'agentId', 'rootCallId', 'callId', 'operation', 'source', 'destination', 'payload', 'payloadDigest', 'deadline', 'policyEpoch', 'emergencyEpoch', 'budget', 'clientKeyId'] as const
function normalizeRequestUnsigned(value: unknown): BrokerClientRequestUnsigned {
  const input = exact(value, REQUEST_UNSIGNED_KEYS, 'client request')
  if (input.protocol !== GITHUB_BROKER_PROTOCOL || input.type !== 'client-request') reject('wrong-protocol', 'client request protocol is invalid')
  const operation = input.operation
  const payload = normalizePayload(operation, input.payload)
  const normalizedDestination = destination(input.destination)
  if ((operation === 'inspect' && ['pull-request', 'checks', 'reviews'].includes((payload as BrokerInspectPayload).kind) || operation === 'pull-request')
    && (normalizedDestination.baseBranch === undefined || normalizedDestination.baseBranch === normalizedDestination.branch)) reject('invalid-message', 'request base branch is required for pull request inspection')
  const payloadDigest = digest(input.payloadDigest, 'request.payloadDigest')
  if (brokerDigest(payload) !== payloadDigest) reject('digest-mismatch', 'request payload digest does not match')
  return Object.freeze({
    protocol: GITHUB_BROKER_PROTOCOL, type: 'client-request', requestId: text(input.requestId, 'request.requestId'), challenge: base64url(input.challenge, 'request.challenge', 32),
    client: endpoint(input.client, 'assistant-actions-host', 'request.client'), broker: endpoint(input.broker, 'github-broker', 'request.broker'),
    actionId: text(input.actionId, 'request.actionId'), grantId: text(input.grantId, 'request.grantId'), grantRevision: integer(input.grantRevision, 'request.grantRevision', 1), grantDigest: digest(input.grantDigest, 'request.grantDigest'),
    owner: owner(input.owner), sessionId: text(input.sessionId, 'request.sessionId'), agentId: text(input.agentId, 'request.agentId'), rootCallId: text(input.rootCallId, 'request.rootCallId'), callId: text(input.callId, 'request.callId'), operation: operation as BrokerOperation, source: dataSource(input.source), destination: normalizedDestination, payload, payloadDigest,
    deadline: integer(input.deadline, 'request.deadline', 1), policyEpoch: integer(input.policyEpoch, 'request.policyEpoch'), emergencyEpoch: integer(input.emergencyEpoch, 'request.emergencyEpoch'), budget: budget(input.budget), clientKeyId: instance(input.clientKeyId, 'request.clientKeyId'),
  })
}

export function createBrokerClientRequest(input: BrokerRequestIntent, hello: BrokerServerHello, source: Extract<BrokerEndpoint, { kind: 'assistant-actions-host' }>, clientKeyId: string, key: KeyInput, requestId: string = randomUUID()): BrokerClientRequest {
  const unsigned = normalizeRequestUnsigned({ protocol: GITHUB_BROKER_PROTOCOL, type: 'client-request', requestId, challenge: hello.challenge, client: source, broker: { kind: 'github-broker', instanceId: hello.instanceId, generation: hello.generation }, ...input, payloadDigest: brokerDigest(input.payload), policyEpoch: hello.policyEpoch, emergencyEpoch: hello.emergencyEpoch, clientKeyId })
  return Object.freeze({ ...unsigned, signature: signatureFor(REQUEST_DOMAIN, unsigned, key) })
}
export function verifyBrokerClientRequest(value: unknown, hello: BrokerServerHello, key: KeyInput, options: { now?: number; expectedClientKeyId?: string } = {}): BrokerClientRequest {
  const input = exact(value, [...REQUEST_UNSIGNED_KEYS, 'signature'], 'client request')
  const { signature: rawSignature, ...rawUnsigned } = input
  const unsigned = normalizeRequestUnsigned(rawUnsigned)
  const signature = base64url(rawSignature, 'request.signature', 64)
  const now = options.now ?? Date.now()
  if (hello.expiresAt <= now) reject('expired-hello', 'server hello expired before client request verification')
  if (unsigned.deadline <= now) reject('expired-request', 'client request deadline expired')
  if (unsigned.challenge !== hello.challenge || unsigned.broker.instanceId !== hello.instanceId || unsigned.broker.generation !== hello.generation
    || unsigned.policyEpoch !== hello.policyEpoch || unsigned.emergencyEpoch !== hello.emergencyEpoch) reject('challenge-mismatch', 'client request is not bound to this server hello')
  if (options.expectedClientKeyId !== undefined && unsigned.clientKeyId !== options.expectedClientKeyId) reject('client-identity-mismatch', 'client key identity does not match')
  verifySignature(REQUEST_DOMAIN, unsigned, signature, key)
  return Object.freeze({ ...unsigned, signature })
}
/** Stable action semantics used by the durable actionId idempotency ledger. */
export function brokerRequestDigest(request: BrokerClientRequest): string {
  return brokerDigest({
    protocol: 'assistant-actions/github-broker-intent/v1', actionId: request.actionId, grantId: request.grantId, grantRevision: request.grantRevision, grantDigest: request.grantDigest,
    owner: request.owner, sessionId: request.sessionId, operation: request.operation, source: request.source, destination: request.destination,
    payload: request.payload, payloadDigest: request.payloadDigest, budget: request.budget, clientKeyId: request.clientKeyId,
  })
}
/** Per-connection digest used only to bind a response to its exact signed request. */
export function brokerWireRequestDigest(request: BrokerClientRequest): string {
  const { signature: _signature, ...unsigned } = request
  return brokerDigest(unsigned)
}

export type BrokerSuccessResult =
  | { operation: 'commit'; repository: string; branch: string; parentOid: string; commitOid: string }
  | { operation: 'pull-request'; repository: string; branch: string; baseBranch: string; expectedHeadOid: string; pullRequestNumber: number }
  | { operation: 'inspect'; repository: string; branch: string; kind: BrokerInspectPayload['kind']; observed: BrokerInspectObservation; observedDigest: string }
export interface BrokerRepositoryObservation { full_name: string; untrusted: true }
export interface BrokerBranchObservation { name: string; commit: { sha: string }; untrusted: true }
export interface BrokerFileObservation { path: string; sha: string; content: string; untrusted: true }
export interface BrokerPullRequestScope { number: number; state: 'open' | 'closed'; merged: boolean; head: { ref: string; sha: string; repo: { full_name: string } }; base: { ref: string; repo: { full_name: string } } }
export interface BrokerPullRequestObservation extends BrokerPullRequestScope { untrusted: true }
export interface BrokerCheckObservation { id: number; name: string; status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending'; conclusion: string | null; head_sha: string; app: { id: number } }
export interface BrokerReviewObservation { id: number; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'; commit_id: string; user: { id: number }; submitted_at?: string }
export interface BrokerChecksObservation { pullRequest: BrokerPullRequestScope; headOid: string; items: readonly BrokerCheckObservation[]; truncated: boolean; untrusted: true }
export interface BrokerReviewsObservation { pullRequest: BrokerPullRequestScope; headOid: string; items: readonly BrokerReviewObservation[]; truncated: boolean; untrusted: true }
export type BrokerInspectObservation = BrokerRepositoryObservation | BrokerBranchObservation | BrokerFileObservation | BrokerPullRequestObservation | BrokerChecksObservation | BrokerReviewsObservation
export interface BrokerResponseError { code: string }
export interface BrokerServerResponseUnsigned {
  protocol: typeof GITHUB_BROKER_PROTOCOL
  type: 'server-response'
  requestId: string
  actionId: string
  instanceId: string
  generation: number
  challenge: string
  requestDigest: string
  status: 'succeeded' | 'failed' | 'unknown'
  dispatched: boolean
  result: BrokerSuccessResult | null
  error: BrokerResponseError | null
  completedAt: number
}
export interface BrokerServerResponse extends BrokerServerResponseUnsigned { signature: string }

function successResult(value: unknown, request: BrokerClientRequest): BrokerSuccessResult {
  const input = record(value, 'response result')
  if (request.operation === 'commit') {
    const result = exact(input, ['operation', 'repository', 'branch', 'parentOid', 'commitOid'], 'commit response result')
    if (result.operation !== 'commit' || result.repository !== request.destination.repository || result.branch !== request.destination.branch) reject('response-mismatch', 'commit response target does not match')
    const payload = request.payload as BrokerCommitPayload
    if (result.parentOid !== payload.expectedHeadOid) reject('response-mismatch', 'commit response parent does not match')
    return Object.freeze({ operation: 'commit', repository: result.repository, branch: result.branch, parentOid: oid(result.parentOid, 'response.parentOid'), commitOid: oid(result.commitOid, 'response.commitOid') })
  }
  if (request.operation === 'pull-request') {
    const result = exact(input, ['operation', 'repository', 'branch', 'baseBranch', 'expectedHeadOid', 'pullRequestNumber'], 'pull request response result')
    if (result.operation !== 'pull-request' || result.repository !== request.destination.repository || result.branch !== request.destination.branch || result.baseBranch !== request.destination.baseBranch) reject('response-mismatch', 'pull request response target does not match')
    const payload = request.payload as BrokerPullRequestPayload
    if (result.expectedHeadOid !== payload.expectedHeadOid) reject('response-mismatch', 'pull request response expected head does not match')
    return Object.freeze({ operation: 'pull-request', repository: result.repository, branch: result.branch, baseBranch: validBranch(result.baseBranch, 'response.baseBranch'), expectedHeadOid: oid(result.expectedHeadOid, 'response.expectedHeadOid'), pullRequestNumber: integer(result.pullRequestNumber, 'response.pullRequestNumber', 1) })
  }
  const result = exact(input, ['operation', 'repository', 'branch', 'kind', 'observed', 'observedDigest'], 'inspect response result')
  const payload = request.payload as BrokerInspectPayload
  if (result.operation !== 'inspect' || result.repository !== request.destination.repository || result.branch !== request.destination.branch || result.kind !== payload.kind) reject('response-mismatch', 'inspect response target does not match')
  const observed = normalizeBrokerInspectObservation(payload, result.observed, request.destination)
  const observedCanonical = canonicalBrokerJson(observed)
  if (containsCredentialShapedValue(result.observed)) reject('secret-field', 'credential-shaped response value is forbidden')
  const observedDigest = digest(result.observedDigest, 'response.observedDigest')
  if (createHash('sha256').update(observedCanonical).digest('hex') !== observedDigest) reject('digest-mismatch', 'response observation digest does not match')
  return Object.freeze({ operation: 'inspect', repository: result.repository, branch: result.branch, kind: result.kind as BrokerInspectPayload['kind'], observed, observedDigest })
}
function containsCredentialShapedValue(value: unknown): boolean {
  if (typeof value === 'string') return SENSITIVE_VALUE.test(value)
  if (Array.isArray(value)) return value.some(containsCredentialShapedValue)
  if (value !== null && typeof value === 'object') return Object.values(value).some(containsCredentialShapedValue)
  return false
}
function exactOptional(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  const input = record(value, label), keys = Object.keys(input)
  if (keys.length < required.length || keys.length > required.length + optional.length || required.some(key => !Object.hasOwn(input, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) reject('unknown-field', `${label} has unknown or missing fields`)
  return input
}
function truth(value: unknown, label: string): true { if (value !== true) reject('invalid-message', `${label} must be true`); return true }
function boolean(value: unknown, label: string): boolean { if (typeof value !== 'boolean') reject('invalid-message', `${label} must be boolean`); return value }
function pullRequestScope(value: unknown, destination: BrokerDestination, expectedNumber?: number, topLevel = false): BrokerPullRequestScope | BrokerPullRequestObservation {
  const input = exact(value, topLevel ? ['number', 'state', 'merged', 'head', 'base', 'untrusted'] : ['number', 'state', 'merged', 'head', 'base'], 'pull request observation')
  const head = exact(input.head, ['ref', 'sha', 'repo'], 'pull request head'), headRepo = exact(head.repo, ['full_name'], 'pull request head repository')
  const base = exact(input.base, ['ref', 'repo'], 'pull request base'), baseRepo = exact(base.repo, ['full_name'], 'pull request base repository')
  const number = integer(input.number, 'pull request number', 1), state = input.state
  if (expectedNumber !== undefined && number !== expectedNumber || !['open', 'closed'].includes(String(state)) || head.ref !== destination.branch || headRepo.full_name !== destination.repository || baseRepo.full_name !== destination.repository || destination.baseBranch === undefined || base.ref !== destination.baseBranch || head.ref === base.ref) reject('response-mismatch', 'pull request observation scope does not match')
  const output: BrokerPullRequestScope = Object.freeze({ number, state: state as 'open' | 'closed', merged: boolean(input.merged, 'pull request merged'), head: Object.freeze({ ref: validBranch(head.ref, 'pull request head ref'), sha: oid(head.sha, 'pull request head sha'), repo: Object.freeze({ full_name: text(headRepo.full_name, 'pull request head repository', 256) }) }), base: Object.freeze({ ref: validBranch(base.ref, 'pull request base ref'), repo: Object.freeze({ full_name: text(baseRepo.full_name, 'pull request base repository', 256) }) }) })
  return topLevel ? Object.freeze({ ...output, untrusted: truth(input.untrusted, 'pull request untrusted') }) : output
}
export function normalizeBrokerInspectObservation(payload: BrokerInspectPayload, value: unknown, destination: BrokerDestination): BrokerInspectObservation {
  if (payload.kind === 'repository') {
    const input = exact(value, ['full_name', 'untrusted'], 'repository observation')
    if (input.full_name !== destination.repository) reject('response-mismatch', 'repository observation does not match')
    return Object.freeze({ full_name: text(input.full_name, 'repository full_name', 256), untrusted: truth(input.untrusted, 'repository untrusted') })
  }
  if (payload.kind === 'branch') {
    const input = exact(value, ['name', 'commit', 'untrusted'], 'branch observation'), commit = exact(input.commit, ['sha'], 'branch commit')
    if (input.name !== destination.branch) reject('response-mismatch', 'branch observation does not match')
    return Object.freeze({ name: text(input.name, 'branch name', 255), commit: Object.freeze({ sha: oid(commit.sha, 'branch commit sha') }), untrusted: truth(input.untrusted, 'branch untrusted') })
  }
  if (payload.kind === 'file') {
    const input = exact(value, ['path', 'sha', 'content', 'untrusted'], 'file observation')
    if (!validPath(input.path) || input.path !== payload.path || typeof input.content !== 'string' || Buffer.byteLength(input.content) > 65_536 || Buffer.from(input.content, 'utf8').toString('utf8') !== input.content) reject('response-mismatch', 'file observation does not match')
    return Object.freeze({ path: input.path, sha: oid(input.sha, 'file observation sha'), content: input.content, untrusted: truth(input.untrusted, 'file untrusted') })
  }
  if (payload.kind === 'pull-request') return pullRequestScope(value, destination, payload.pullRequestNumber, true) as BrokerPullRequestObservation
  const input = exact(value, ['pullRequest', 'headOid', 'items', 'truncated', 'untrusted'], `${payload.kind} observation`)
  const pullRequest = pullRequestScope(input.pullRequest, destination, payload.pullRequestNumber) as BrokerPullRequestScope
  const headOid = oid(input.headOid, `${payload.kind} headOid`)
  if (headOid !== pullRequest.head.sha || !Array.isArray(input.items)) reject('response-mismatch', `${payload.kind} observation head does not match`)
  const truncated = boolean(input.truncated, `${payload.kind} truncated`), untrusted = truth(input.untrusted, `${payload.kind} untrusted`)
  if (payload.kind === 'checks') {
    if (input.items.length > 20) reject('invalid-message', 'checks observation is too large')
    const items = Object.freeze(input.items.map((value, index) => {
      const item = exact(value, ['id', 'name', 'status', 'conclusion', 'head_sha', 'app'], `check ${index}`), app = exact(item.app, ['id'], `check ${index} app`)
      if (!['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'].includes(String(item.status)) || item.conclusion !== null && typeof item.conclusion !== 'string' || item.head_sha !== headOid) reject('invalid-message', 'check observation is invalid')
      return Object.freeze({ id: integer(item.id, 'check id', 1), name: text(item.name, 'check name'), status: item.status as BrokerCheckObservation['status'], conclusion: item.conclusion as string | null, head_sha: oid(item.head_sha, 'check head sha'), app: Object.freeze({ id: integer(app.id, 'check app id', 1) }) })
    }))
    return Object.freeze({ pullRequest, headOid, items, truncated, untrusted })
  }
  if (input.items.length > 30) reject('invalid-message', 'reviews observation is too large')
  const items = Object.freeze(input.items.map((value, index) => {
    const item = exactOptional(value, ['id', 'state', 'commit_id', 'user'], ['submitted_at'], `review ${index}`), user = exact(item.user, ['id'], `review ${index} user`)
    if (!['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'].includes(String(item.state)) || item.submitted_at !== undefined && (typeof item.submitted_at !== 'string' || Number.isNaN(Date.parse(item.submitted_at)))) reject('invalid-message', 'review observation is invalid')
    return Object.freeze({ id: integer(item.id, 'review id', 1), state: item.state as BrokerReviewObservation['state'], commit_id: oid(item.commit_id, 'review commit id'), user: Object.freeze({ id: integer(user.id, 'review user id', 1) }), ...(item.submitted_at === undefined ? {} : { submitted_at: item.submitted_at }) })
  }))
  return Object.freeze({ pullRequest, headOid, items, truncated, untrusted })
}
const RESPONSE_UNSIGNED_KEYS = ['protocol', 'type', 'requestId', 'actionId', 'instanceId', 'generation', 'challenge', 'requestDigest', 'status', 'dispatched', 'result', 'error', 'completedAt'] as const
function normalizeResponseUnsigned(value: unknown, request: BrokerClientRequest): BrokerServerResponseUnsigned {
  const input = exact(value, RESPONSE_UNSIGNED_KEYS, 'server response')
  if (input.protocol !== GITHUB_BROKER_PROTOCOL || input.type !== 'server-response' || !['succeeded', 'failed', 'unknown'].includes(String(input.status)) || typeof input.dispatched !== 'boolean') reject('wrong-protocol', 'server response protocol is invalid')
  const status = input.status as BrokerServerResponseUnsigned['status']
  let result: BrokerSuccessResult | null = null, error: BrokerResponseError | null = null
  if (status === 'succeeded') {
    if (input.dispatched !== true || input.error !== null) reject('invalid-message', 'successful response state is invalid')
    result = successResult(input.result, request)
  } else {
    if (input.result !== null) reject('invalid-message', 'non-success response must not carry a result')
    const rawError = exact(input.error, ['code'], 'response error')
    const code = text(rawError.code, 'response.error.code')
    if (!ERROR_CODE.test(code)) reject('invalid-message', 'response error code is invalid')
    error = Object.freeze({ code })
    if (status === 'unknown' && input.dispatched !== true) reject('invalid-message', 'unknown response must be post-dispatch')
  }
  return Object.freeze({ protocol: GITHUB_BROKER_PROTOCOL, type: 'server-response', requestId: text(input.requestId, 'response.requestId'), actionId: text(input.actionId, 'response.actionId'), instanceId: instance(input.instanceId, 'response.instanceId'), generation: integer(input.generation, 'response.generation', 1), challenge: base64url(input.challenge, 'response.challenge', 32), requestDigest: digest(input.requestDigest, 'response.requestDigest'), status, dispatched: input.dispatched, result, error, completedAt: integer(input.completedAt, 'response.completedAt', 1) })
}

export function createBrokerServerResponse(input: Pick<BrokerServerResponseUnsigned, 'status' | 'dispatched' | 'result' | 'error' | 'completedAt'>, request: BrokerClientRequest, hello: BrokerServerHello, key: KeyInput): BrokerServerResponse {
  const unsigned = normalizeResponseUnsigned({ protocol: GITHUB_BROKER_PROTOCOL, type: 'server-response', requestId: request.requestId, actionId: request.actionId, instanceId: hello.instanceId, generation: hello.generation, challenge: hello.challenge, requestDigest: brokerWireRequestDigest(request), ...input }, request)
  return Object.freeze({ ...unsigned, signature: signatureFor(RESPONSE_DOMAIN, unsigned, key) })
}
export function verifyBrokerServerResponse(value: unknown, request: BrokerClientRequest, hello: BrokerServerHello, key: KeyInput): BrokerServerResponse {
  const input = exact(value, [...RESPONSE_UNSIGNED_KEYS, 'signature'], 'server response')
  const { signature: rawSignature, ...rawUnsigned } = input
  const unsigned = normalizeResponseUnsigned(rawUnsigned, request)
  const signature = base64url(rawSignature, 'response.signature', 64)
  if (unsigned.requestId !== request.requestId || unsigned.actionId !== request.actionId || unsigned.instanceId !== hello.instanceId || unsigned.generation !== hello.generation || unsigned.challenge !== hello.challenge || unsigned.requestDigest !== brokerWireRequestDigest(request)) reject('response-mismatch', 'server response is not bound to this request')
  verifySignature(RESPONSE_DOMAIN, unsigned, signature, key)
  return Object.freeze({ ...unsigned, signature })
}

export interface BrokerAdminEndpoint { kind: 'assistant-actions-admin'; instanceId: string; generation: number }
export type BrokerAdminIntent =
  | { operation: 'status'; body: Record<string, never>; deadline: number }
  | { operation: 'stop'; body: { expectedControlVersion: number; drainDeadline: number; reason: 'operator-request' | 'security-response' | 'maintenance' }; deadline: number }
  | { operation: 'resume'; body: { expectedControlVersion: number; expectedGeneration: number }; deadline: number }
  | { operation: 'revoke'; body: { expectedControlVersion: number; grantId: string; grantRevision: number; grantDigest: string; policyEpoch: number; emergencyEpoch: number; reason: 'operator-request' | 'security-response' | 'grant-replaced' | 'grant-expired' }; deadline: number }
export interface BrokerAdminRequestUnsigned {
  protocol: typeof GITHUB_BROKER_PROTOCOL
  type: 'admin-request'
  requestId: string
  nonce: string
  challenge: string
  source: BrokerAdminEndpoint
  destination: BrokerEndpoint
  operation: BrokerAdminIntent['operation']
  body: BrokerAdminIntent['body']
  deadline: number
  adminKeyId: string
}
export interface BrokerAdminRequest extends BrokerAdminRequestUnsigned { signature: string }

function adminEndpoint(value: unknown): BrokerAdminEndpoint {
  const input = exact(value, ['kind', 'instanceId', 'generation'], 'admin request source')
  if (input.kind !== 'assistant-actions-admin') reject('invalid-message', 'admin request source kind is invalid')
  return Object.freeze({ kind: 'assistant-actions-admin', instanceId: instance(input.instanceId, 'admin source instanceId'), generation: integer(input.generation, 'admin source generation', 1) })
}
function adminBody(operation: unknown, value: unknown): BrokerAdminIntent['body'] {
  if (operation === 'status') { exact(value, [], 'status body'); return Object.freeze({}) }
  if (operation === 'stop') {
    const input = exact(value, ['expectedControlVersion', 'drainDeadline', 'reason'], 'stop body')
    if (!['operator-request', 'security-response', 'maintenance'].includes(String(input.reason))) reject('invalid-message', 'stop reason is invalid')
    return Object.freeze({ expectedControlVersion: integer(input.expectedControlVersion, 'stop expectedControlVersion'), drainDeadline: integer(input.drainDeadline, 'stop drainDeadline', 1), reason: input.reason as 'operator-request' | 'security-response' | 'maintenance' })
  }
  if (operation === 'resume') {
    const input = exact(value, ['expectedControlVersion', 'expectedGeneration'], 'resume body')
    return Object.freeze({ expectedControlVersion: integer(input.expectedControlVersion, 'resume expectedControlVersion'), expectedGeneration: integer(input.expectedGeneration, 'resume expectedGeneration', 1) })
  }
  if (operation === 'revoke') {
    const input = exact(value, ['expectedControlVersion', 'grantId', 'grantRevision', 'grantDigest', 'policyEpoch', 'emergencyEpoch', 'reason'], 'revoke body')
    if (!['operator-request', 'security-response', 'grant-replaced', 'grant-expired'].includes(String(input.reason))) reject('invalid-message', 'revoke reason is invalid')
    return Object.freeze({ expectedControlVersion: integer(input.expectedControlVersion, 'revoke expectedControlVersion'), grantId: text(input.grantId, 'revoke grantId'), grantRevision: integer(input.grantRevision, 'revoke grantRevision', 1), grantDigest: digest(input.grantDigest, 'revoke grantDigest'), policyEpoch: integer(input.policyEpoch, 'revoke policyEpoch'), emergencyEpoch: integer(input.emergencyEpoch, 'revoke emergencyEpoch'), reason: input.reason as 'operator-request' | 'security-response' | 'grant-replaced' | 'grant-expired' })
  }
  reject('invalid-message', 'admin operation is invalid')
}
const ADMIN_REQUEST_UNSIGNED_KEYS = ['protocol', 'type', 'requestId', 'nonce', 'challenge', 'source', 'destination', 'operation', 'body', 'deadline', 'adminKeyId'] as const
function normalizeAdminRequestUnsigned(value: unknown): BrokerAdminRequestUnsigned {
  const input = exact(value, ADMIN_REQUEST_UNSIGNED_KEYS, 'admin request')
  if (input.protocol !== GITHUB_BROKER_PROTOCOL || input.type !== 'admin-request') reject('wrong-protocol', 'admin request protocol is invalid')
  const operation = input.operation
  if (!['status', 'stop', 'resume', 'revoke'].includes(String(operation))) reject('invalid-message', 'admin operation is invalid')
  return Object.freeze({ protocol: GITHUB_BROKER_PROTOCOL, type: 'admin-request', requestId: text(input.requestId, 'admin requestId'), nonce: base64url(input.nonce, 'admin nonce', 32), challenge: base64url(input.challenge, 'admin challenge', 32), source: adminEndpoint(input.source), destination: endpoint(input.destination, 'github-broker', 'admin destination'), operation: operation as BrokerAdminIntent['operation'], body: adminBody(operation, input.body), deadline: integer(input.deadline, 'admin deadline', 1), adminKeyId: instance(input.adminKeyId, 'admin keyId') })
}
export function createBrokerAdminRequest(input: BrokerAdminIntent, hello: BrokerServerHello, source: BrokerAdminEndpoint, adminKeyId: string, key: KeyInput, requestId: string = randomUUID(), nonce: string = randomBytes(32).toString('base64url')): BrokerAdminRequest {
  const unsigned = normalizeAdminRequestUnsigned({ protocol: GITHUB_BROKER_PROTOCOL, type: 'admin-request', requestId, nonce, challenge: hello.challenge, source, destination: { kind: 'github-broker', instanceId: hello.instanceId, generation: hello.generation }, ...input, adminKeyId })
  return Object.freeze({ ...unsigned, signature: signatureFor(ADMIN_REQUEST_DOMAIN, unsigned, key) })
}
export function verifyBrokerAdminRequest(value: unknown, hello: BrokerServerHello, key: KeyInput, options: { now?: number; expectedAdminKeyId?: string } = {}): BrokerAdminRequest {
  const input = exact(value, [...ADMIN_REQUEST_UNSIGNED_KEYS, 'signature'], 'admin request')
  const { signature: rawSignature, ...rawUnsigned } = input
  const unsigned = normalizeAdminRequestUnsigned(rawUnsigned), signature = base64url(rawSignature, 'admin signature', 64)
  const now = options.now ?? Date.now()
  if (hello.expiresAt <= now) reject('expired-hello', 'server hello expired before admin request verification')
  if (unsigned.deadline <= now) reject('expired-request', 'admin request deadline expired')
  if (unsigned.challenge !== hello.challenge || unsigned.destination.instanceId !== hello.instanceId || unsigned.destination.generation !== hello.generation) reject('challenge-mismatch', 'admin request is not bound to this server hello')
  if (options.expectedAdminKeyId !== undefined && unsigned.adminKeyId !== options.expectedAdminKeyId) reject('client-identity-mismatch', 'admin key identity does not match')
  verifySignature(ADMIN_REQUEST_DOMAIN, unsigned, signature, key)
  return Object.freeze({ ...unsigned, signature })
}
export function brokerAdminRequestDigest(request: BrokerAdminRequest): string { const { signature: _signature, ...unsigned } = request; return brokerDigest(unsigned) }

export interface BrokerAdminState { admission: 'accepting' | 'draining' | 'stopped'; generation: number; controlVersion: number; activeRequests: number; revocationEpoch: number }
export interface BrokerAdminResponseUnsigned {
  protocol: typeof GITHUB_BROKER_PROTOCOL
  type: 'admin-response'
  requestId: string
  instanceId: string
  generation: number
  challenge: string
  requestDigest: string
  status: 'succeeded' | 'failed'
  state: BrokerAdminState
  error: BrokerResponseError | null
  completedAt: number
}
export interface BrokerAdminResponse extends BrokerAdminResponseUnsigned { signature: string }
function adminState(value: unknown): BrokerAdminState {
  const input = exact(value, ['admission', 'generation', 'controlVersion', 'activeRequests', 'revocationEpoch'], 'admin state')
  if (!['accepting', 'draining', 'stopped'].includes(String(input.admission))) reject('invalid-message', 'admin admission state is invalid')
  return Object.freeze({ admission: input.admission as BrokerAdminState['admission'], generation: integer(input.generation, 'admin state generation', 1), controlVersion: integer(input.controlVersion, 'admin state controlVersion'), activeRequests: integer(input.activeRequests, 'admin state activeRequests'), revocationEpoch: integer(input.revocationEpoch, 'admin state revocationEpoch') })
}
const ADMIN_RESPONSE_UNSIGNED_KEYS = ['protocol', 'type', 'requestId', 'instanceId', 'generation', 'challenge', 'requestDigest', 'status', 'state', 'error', 'completedAt'] as const
function normalizeAdminResponseUnsigned(value: unknown): BrokerAdminResponseUnsigned {
  const input = exact(value, ADMIN_RESPONSE_UNSIGNED_KEYS, 'admin response')
  if (input.protocol !== GITHUB_BROKER_PROTOCOL || input.type !== 'admin-response' || !['succeeded', 'failed'].includes(String(input.status))) reject('wrong-protocol', 'admin response protocol is invalid')
  let error: BrokerResponseError | null = null
  if (input.status === 'succeeded') { if (input.error !== null) reject('invalid-message', 'successful admin response has an error') }
  else { const value = exact(input.error, ['code'], 'admin response error'); const code = text(value.code, 'admin response error code'); if (!ERROR_CODE.test(code)) reject('invalid-message', 'admin response error code is invalid'); error = Object.freeze({ code }) }
  return Object.freeze({ protocol: GITHUB_BROKER_PROTOCOL, type: 'admin-response', requestId: text(input.requestId, 'admin response requestId'), instanceId: instance(input.instanceId, 'admin response instanceId'), generation: integer(input.generation, 'admin response generation', 1), challenge: base64url(input.challenge, 'admin response challenge', 32), requestDigest: digest(input.requestDigest, 'admin response requestDigest'), status: input.status as BrokerAdminResponseUnsigned['status'], state: adminState(input.state), error, completedAt: integer(input.completedAt, 'admin response completedAt', 1) })
}
export function createBrokerAdminResponse(input: Pick<BrokerAdminResponseUnsigned, 'status' | 'state' | 'error' | 'completedAt'>, request: BrokerAdminRequest, hello: BrokerServerHello, key: KeyInput): BrokerAdminResponse {
  const unsigned = normalizeAdminResponseUnsigned({ protocol: GITHUB_BROKER_PROTOCOL, type: 'admin-response', requestId: request.requestId, instanceId: hello.instanceId, generation: hello.generation, challenge: hello.challenge, requestDigest: brokerAdminRequestDigest(request), ...input })
  return Object.freeze({ ...unsigned, signature: signatureFor(ADMIN_RESPONSE_DOMAIN, unsigned, key) })
}
export function verifyBrokerAdminResponse(value: unknown, request: BrokerAdminRequest, hello: BrokerServerHello, key: KeyInput): BrokerAdminResponse {
  const input = exact(value, [...ADMIN_RESPONSE_UNSIGNED_KEYS, 'signature'], 'admin response')
  const { signature: rawSignature, ...rawUnsigned } = input
  const unsigned = normalizeAdminResponseUnsigned(rawUnsigned), signature = base64url(rawSignature, 'admin response signature', 64)
  if (unsigned.requestId !== request.requestId || unsigned.instanceId !== hello.instanceId || unsigned.generation !== hello.generation || unsigned.challenge !== hello.challenge || unsigned.requestDigest !== brokerAdminRequestDigest(request)) reject('response-mismatch', 'admin response is not bound to this request')
  if (unsigned.state.generation !== unsigned.generation) reject('response-mismatch', 'admin state generation does not match the response')
  verifySignature(ADMIN_RESPONSE_DOMAIN, unsigned, signature, key)
  return Object.freeze({ ...unsigned, signature })
}
