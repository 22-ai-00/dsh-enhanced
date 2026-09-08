import { createHash } from 'node:crypto'

export interface ExternalEventEnvelope {
  protocol: 'dsh-external-event/v1'
  source: Readonly<{ id: string; kind: 'file' | 'http-json' | 'webhook' | 'github-repository'; version: string; configDigest: string }>
  event: Readonly<{ id: string; occurredAt: number; receivedAt: number }>
  observation: Readonly<{ digest: string; revision: string; timeBasis: 'observed' | 'source-signed' }>
  trust: Readonly<{ method: 'local-observation' | 'https-observation' | 'hmac-sha256'; content: 'untrusted' }>
  target: Readonly<{ automationId: string }>
  deduplicationKey: string
}

const digest = /^[a-f0-9]{64}$/u
const maxEnvelopeBytes = 16_384

function fail(message: string): never { throw new TypeError(`invalid external event envelope: ${message}`) }

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(`${field} must be a plain object`)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const output = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') fail(`${field} must not contain symbol keys`)
    const descriptor = descriptors[key]!
    if (!('value' in descriptor) || !descriptor.enumerable) fail(`${field}.${key} must be an enumerable data property`)
    output[key] = descriptor.value
  }
  return output
}

function exact(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  const object = plainObject(value, field)
  const actual = Object.keys(object).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${field} has unexpected keys`)
  return object
}

function string(value: unknown, field: string, maximum = 1_000): string {
  if (typeof value !== 'string' || value.normalize('NFC').trim() !== value || value === '' || /\p{Cc}/u.test(value)
    || Buffer.byteLength(value, 'utf8') > maximum) fail(`${field} must be a bounded canonical string`)
  return value
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !digest.test(value)) fail(`${field} must be a SHA-256 digest`)
  return value
}

function time(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${field} must be a non-negative safe integer`)
  return value as number
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const input = value as Record<string, unknown>
  return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${canonical(input[key])}`).join(',')}}`
}

/** Validates only provenance metadata. It deliberately has no payload or goal field. */
export function parseExternalEventEnvelope(value: unknown): Readonly<ExternalEventEnvelope> {
  const root = exact(value, 'envelope', ['protocol', 'source', 'event', 'observation', 'trust', 'target', 'deduplicationKey'])
  if (root['protocol'] !== 'dsh-external-event/v1') fail('protocol is unsupported')
  const source = exact(root['source'], 'source', ['id', 'kind', 'version', 'configDigest'])
  const sourceId = string(source['id'], 'source.id', 500)
  const kind = source['kind']
  if (kind !== 'file' && kind !== 'http-json' && kind !== 'webhook' && kind !== 'github-repository') fail('source.kind is unsupported')
  const event = exact(root['event'], 'event', ['id', 'occurredAt', 'receivedAt'])
  const eventId = string(event['id'], 'event.id', 500)
  const occurredAt = time(event['occurredAt'], 'event.occurredAt')
  const receivedAt = time(event['receivedAt'], 'event.receivedAt')
  const observation = exact(root['observation'], 'observation', ['digest', 'revision', 'timeBasis'])
  const timeBasis = observation['timeBasis']
  if (timeBasis !== 'observed' && timeBasis !== 'source-signed') fail('observation.timeBasis is unsupported')
  const trust = exact(root['trust'], 'trust', ['method', 'content'])
  const method = trust['method']
  if (method !== 'local-observation' && method !== 'https-observation' && method !== 'hmac-sha256') fail('trust.method is unsupported')
  if (trust['content'] !== 'untrusted') fail('trust.content must be untrusted')
  const target = exact(root['target'], 'target', ['automationId'])
  const automationId = string(target['automationId'], 'target.automationId', 500)
  const deduplicationKey = string(root['deduplicationKey'], 'deduplicationKey', 1_000)
  if (deduplicationKey !== `${sourceId}:${eventId}`) fail('deduplicationKey does not bind source and event')
  const expected = kind === 'file'
    ? ['local-observation', 'observed']
    : (kind === 'http-json' || kind === 'github-repository') ? ['https-observation', 'observed'] : ['hmac-sha256', 'source-signed']
  if (method !== expected[0] || timeBasis !== expected[1]) fail('source, trust method, and time basis are inconsistent')
  if (timeBasis === 'observed' && occurredAt > receivedAt) fail('observed event time cannot exceed receipt time')
  const parsed: ExternalEventEnvelope = {
    protocol: 'dsh-external-event/v1',
    source: { id: sourceId, kind, version: string(source['version'], 'source.version', 200), configDigest: sha256(source['configDigest'], 'source.configDigest') },
    event: { id: eventId, occurredAt, receivedAt },
    observation: { digest: sha256(observation['digest'], 'observation.digest'), revision: string(observation['revision'], 'observation.revision', 500), timeBasis },
    trust: { method, content: 'untrusted' }, target: { automationId }, deduplicationKey,
  }
  if (Buffer.byteLength(canonical(parsed), 'utf8') > maxEnvelopeBytes) fail('envelope exceeds byte limit')
  return freeze(parsed)
}

export function externalEventDigest(value: unknown): string {
  return createHash('sha256').update(canonical(parseExternalEventEnvelope(value))).digest('hex')
}

export function canonicalExternalEventEnvelope(value: unknown): string {
  return canonical(parseExternalEventEnvelope(value))
}
