import { isIP } from 'node:net'
import { isAbsolute, relative, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { EventObserverConfig } from './observer.js'

export type FireWhen = 'changed' | 'truthy'
export type Ipv6Mode = 'deny' | 'native-only'
export type ObserverLifetime = 'shared' | 'goal'
export type WebhookAuthMode = 'hmac-sha256' | 'bearer' | 'shared-secret'
export type TaskSystemAuthScheme = 'bearer' | 'x-api-key'
export type CalendarFormat = 'ics' | 'json-events'
export type EmailProtocol = 'rest-json' | 'jmap'

export interface WebhookListenConfig {
  enabled?: boolean
  host?: string
  port?: number
  basePath?: string
  allowNonLoopback?: boolean
  maxConcurrentRequests?: number
  drainTimeoutMs?: number
}

export interface NormalizedWebhookListenConfig {
  readonly enabled: boolean
  readonly host: string
  readonly port: number
  readonly basePath: string
  readonly allowNonLoopback: boolean
  readonly maxConcurrentRequests: number
  readonly drainTimeoutMs: number
}

export interface EventTriggerIntakeConfig {
  /** Explicit per-source owner opt-in; defaults to false (off). */
  enabled?: boolean
  /** Whether this trigger represents an active subscription (default true when enabled). */
  subscribed?: boolean
  /** Optional bounded metadata-only label included in normalized intake summaries. */
  summaryLabel?: string
}

export interface NormalizedTriggerIntake {
  readonly enabled: true
  readonly subscribed: boolean
  readonly summaryLabel?: string
}

interface TriggerBase {
  id: string
  automationId: string
  enabled?: boolean
  cooldownMs?: number
  maxFires?: number
  ttlMs?: number
  observer?: EventObserverConfig
  /** A goal lifetime is claimed by the first exact owner-authorized event wait. */
  observerLifetime?: ObserverLifetime
  /** Explicit per-source owner opt-in for normalized WP20 intake observations (default off). */
  intake?: EventTriggerIntakeConfig
}

export interface FileTriggerConfig extends TriggerBase {
  kind: 'file'
  path: string
  fireWhen?: FireWhen
  debounceMs?: number
  mode?: 'content-hash' | 'exists'
}

export interface HttpJsonTriggerConfig extends TriggerBase {
  kind: 'http-json'
  url: string
  pointer: string
  fireWhen?: FireWhen
  debounceMs?: number
}

export interface WebhookTriggerConfig extends TriggerBase {
  kind: 'webhook'
  credentialHandle: string
  maxSkewMs?: number
  path?: string
  authMode?: WebhookAuthMode
  secretHeader?: string
}

export interface TaskSystemFieldsConfig {
  id?: string
  updatedAt?: string
  status?: string
  assignee?: string
  title?: string
}

export interface TaskSystemTriggerConfig extends TriggerBase {
  kind: 'task-system'
  url: string
  itemsPointer?: string
  fields?: TaskSystemFieldsConfig
  statusFilter?: string[]
  assigneeFilter?: string[]
  since?: string
  maxItems?: number
  credentialHandle?: string
  authScheme?: TaskSystemAuthScheme
  fireWhen?: FireWhen
  debounceMs?: number
}

export interface CalendarWindowConfig {
  mode: 'static' | 'rolling'
  startTime?: number
  endTime?: number
  lookbackSeconds?: number
  lookaheadSeconds?: number
}

export interface CalendarWindowParamsConfig {
  startParam: string
  endParam: string
  format?: 'iso' | 'unix-seconds'
}

export interface CalendarTriggerConfig extends TriggerBase {
  kind: 'calendar'
  url: string
  format: CalendarFormat
  itemsPointer?: string
  window?: CalendarWindowConfig
  windowParams?: CalendarWindowParamsConfig
  maxEvents?: number
  credentialHandle?: string
  fireWhen?: FireWhen
  debounceMs?: number
}

export interface EmailTriggerConfig extends TriggerBase {
  kind: 'email'
  url: string
  protocol?: EmailProtocol
  accountId?: string
  mailboxId?: string
  messagesPointer?: string
  fromFilter?: string[]
  subjectContains?: string
  unreadOnly?: boolean
  maxMessages?: number
  credentialHandle?: string
  fireWhen?: FireWhen
  debounceMs?: number
}

export interface GitHubRepositoryTriggerConfig extends TriggerBase {
  kind: 'github-repository'
  repository: string
  branch: string
  /** Delivery/base scope metadata for every repository observation mode. */
  baseBranch: string
  /** Omitted retains the legacy pull-request observation contract. */
  deliveryMode?: 'commit' | 'pull-request'
  /** Embedded mode only. Exactly one credentialHandle or externalGrant is required. */
  credentialHandle?: string
  /** External-unix-v1 capability projection; it never contains a credential. */
  externalGrant?: Readonly<{ id: string; revision: number; digest: string }>
  fireWhen?: FireWhen
  debounceMs?: number
  observer: EventObserverConfig
}

/**
 * An exact, owner-selected Lark calendar.  The channel service owns the app
 * credential and token cache; this trigger never receives either value.
 */
export interface LarkCalendarTriggerConfig extends TriggerBase {
  kind: 'lark-calendar'
  calendarId: string
  /** Inclusive Unix-second bounds sent to Lark's Calendar v4 list API; mutually exclusive with rolling lookback/lookahead. */
  startTime?: number
  endTime?: number
  /** Rolling window bounds relative to poll time `nowSec`: [max(0, baseSec - lookbackSeconds), baseSec + lookaheadSeconds]. */
  lookbackSeconds?: number
  lookaheadSeconds?: number
  /** Optional step quantization in seconds (e.g. 60) to reduce rolling boundary churn; omitted = exact `nowSec`. */
  windowStepSeconds?: number
  pageSize?: number
  maxPages?: number
  maxEvents?: number
  fireWhen?: FireWhen
  debounceMs?: number
  observer: EventObserverConfig
}

export type EventTriggerConfig =
  | FileTriggerConfig
  | HttpJsonTriggerConfig
  | WebhookTriggerConfig
  | GitHubRepositoryTriggerConfig
  | LarkCalendarTriggerConfig
  | TaskSystemTriggerConfig
  | CalendarTriggerConfig
  | EmailTriggerConfig

export interface Config {
  databasePath: string
  allowedFileRoots?: string[]
  allowedHttpOrigins?: string[]
  /** @deprecated Use allowedHttpOrigins. Legacy hosts authorize HTTPS port 443 only. */
  allowedHttpHosts?: string[]
  triggers?: EventTriggerConfig[]
  webhookListen?: WebhookListenConfig
  pollerEnabled?: boolean
  pollIntervalMs?: number
  pollConcurrency?: number
  requestTimeoutMs?: number
  maxBodyBytes?: number
  /**
   * IPv6 is denied unless the operator asserts that the egress network is native-only
   * and cannot translate network-specific prefixes to IPv4 destinations.
   */
  ipv6Mode?: Ipv6Mode
}

export type NormalizedTrigger =
  | (Required<Omit<FileTriggerConfig, 'ttlMs' | 'observer' | 'intake'>> & { ttlMs?: number; observer?: EventObserverConfig; intake?: NormalizedTriggerIntake })
  | (Required<Omit<HttpJsonTriggerConfig, 'ttlMs' | 'observer' | 'intake'>> & { ttlMs?: number; observer?: EventObserverConfig; intake?: NormalizedTriggerIntake })
  | (Required<Omit<WebhookTriggerConfig, 'ttlMs' | 'observer' | 'intake' | 'path' | 'authMode' | 'secretHeader'>> & { ttlMs?: number; observer?: EventObserverConfig; intake?: NormalizedTriggerIntake; path?: string; authMode?: WebhookAuthMode; secretHeader?: string })
  | (Required<Omit<GitHubRepositoryTriggerConfig, 'ttlMs' | 'credentialHandle' | 'externalGrant' | 'deliveryMode' | 'intake'>> & { ttlMs?: number; credentialHandle?: string; externalGrant?: Readonly<{ id: string; revision: number; digest: string }>; deliveryMode?: 'commit' | 'pull-request'; intake?: NormalizedTriggerIntake })
  | (Required<Omit<LarkCalendarTriggerConfig, 'ttlMs' | 'intake' | 'startTime' | 'endTime' | 'lookbackSeconds' | 'lookaheadSeconds' | 'windowStepSeconds'>> & { ttlMs?: number; intake?: NormalizedTriggerIntake; startTime?: number; endTime?: number; lookbackSeconds?: number; lookaheadSeconds?: number; windowStepSeconds?: number })
  | (Required<Omit<TaskSystemTriggerConfig, 'ttlMs' | 'observer' | 'intake' | 'fields' | 'statusFilter' | 'assigneeFilter' | 'since' | 'credentialHandle'>> & {
    ttlMs?: number; observer?: EventObserverConfig; intake?: NormalizedTriggerIntake
    fields?: Readonly<Required<TaskSystemFieldsConfig>>
    statusFilter?: readonly string[]
    assigneeFilter?: readonly string[]
    since?: string
    credentialHandle?: string
  })
  | (Required<Omit<CalendarTriggerConfig, 'ttlMs' | 'observer' | 'intake' | 'itemsPointer' | 'window' | 'windowParams' | 'credentialHandle'>> & {
    ttlMs?: number; observer?: EventObserverConfig; intake?: NormalizedTriggerIntake
    itemsPointer?: string
    window?: Readonly<CalendarWindowConfig>
    windowParams?: Readonly<Required<CalendarWindowParamsConfig>>
    credentialHandle?: string
  })
  | (Required<Omit<EmailTriggerConfig, 'ttlMs' | 'observer' | 'intake' | 'accountId' | 'mailboxId' | 'messagesPointer' | 'fromFilter' | 'subjectContains' | 'credentialHandle'>> & {
    ttlMs?: number; observer?: EventObserverConfig; intake?: NormalizedTriggerIntake
    accountId?: string
    mailboxId?: string
    messagesPointer?: string
    fromFilter?: readonly string[]
    subjectContains?: string
    credentialHandle?: string
  })

export interface NormalizedConfig {
  databasePath: string
  triggers: readonly NormalizedTrigger[]
  allowedFileRoots: readonly string[]
  allowedHttpOrigins: readonly string[]
  allowedHttpHosts: readonly string[]
  webhookListen?: NormalizedWebhookListenConfig
  pollerEnabled: boolean
  pollIntervalMs: number
  pollConcurrency: number
  requestTimeoutMs: number
  maxBodyBytes: number
  ipv6Mode: Ipv6Mode
}

const observerSchema = () => Schema.object({
  workspace: Schema.string().required(), preset: Schema.string().required(), principalId: Schema.string().required(),
  principalRecordId: Schema.string().required(), principalVersion: Schema.number().step(1).min(1).required(),
  ownerRouteId: Schema.string().required(), expiresAt: Schema.number().step(1).min(1).required(), budgetId: Schema.string().required(),
})

const base = {
  id: Schema.string().required(),
  automationId: Schema.string().required(),
  enabled: Schema.boolean().default(true),
  cooldownMs: Schema.number().step(1).min(0).max(86_400_000).default(0),
  maxFires: Schema.number().step(1).min(1).max(1_000_000).default(100),
  ttlMs: Schema.number().step(1).min(1_000).max(31_536_000_000),
  observer: Schema.any(),
  observerLifetime: Schema.union(['shared', 'goal'] as const).default('shared'),
  intake: Schema.any(),
}

const webhookListenSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  host: Schema.string().default('127.0.0.1'),
  port: Schema.number().step(1).min(0).max(65_535).default(0),
  basePath: Schema.string().default('/webhooks'),
  allowNonLoopback: Schema.boolean().default(false),
  maxConcurrentRequests: Schema.number().step(1).min(1).max(1_024).default(64),
  drainTimeoutMs: Schema.number().step(1).min(100).max(60_000).default(5_000),
})

const triggerSchema = Schema.union([
  Schema.object({ ...base, kind: Schema.const('github-repository').required(), repository: Schema.string().required(),
    branch: Schema.string().required(), baseBranch: Schema.string().required(), deliveryMode: Schema.union(['commit', 'pull-request'] as const), credentialHandle: Schema.string().default(''), externalGrant: Schema.any(),
    fireWhen: Schema.union(['changed', 'truthy'] as const).default('changed'), debounceMs: Schema.number().step(1).min(0).max(86_400_000).default(0), observer: observerSchema().required() }),
  Schema.object({ ...base, kind: Schema.const('lark-calendar').required(), calendarId: Schema.string().required(),
    startTime: Schema.number().step(1).min(0), endTime: Schema.number().step(1).min(1),
    lookbackSeconds: Schema.number().step(1).min(0).max(31_536_000),
    lookaheadSeconds: Schema.number().step(1).min(0).max(31_536_000),
    windowStepSeconds: Schema.number().step(1).min(1).max(86_400),
    pageSize: Schema.number().step(1).min(1).max(1_000).default(100), maxPages: Schema.number().step(1).min(1).max(100).default(10),
    maxEvents: Schema.number().step(1).min(1).max(10_000).default(1_000),
    fireWhen: Schema.union(['changed', 'truthy'] as const).default('changed'), debounceMs: Schema.number().step(1).min(0).max(86_400_000).default(0), observer: observerSchema().required() }),
  Schema.object({
    ...base,
    kind: Schema.const('file').required(),
    path: Schema.string().required(),
    fireWhen: Schema.union(['changed', 'truthy'] as const).default('changed'),
    debounceMs: Schema.number().step(1).min(0).max(86_400_000).default(0),
    mode: Schema.union(['content-hash', 'exists'] as const).default('content-hash'),
  }),
  Schema.object({
    ...base,
    kind: Schema.const('http-json').required(),
    url: Schema.string().required(),
    pointer: Schema.string().required(),
    fireWhen: Schema.union(['changed', 'truthy'] as const).default('changed'),
    debounceMs: Schema.number().step(1).min(0).max(86_400_000).default(0),
  }),
  Schema.object({
    ...base,
    kind: Schema.const('webhook').required(),
    credentialHandle: Schema.string().required(),
    maxSkewMs: Schema.number().step(1).min(1_000).max(3_600_000).default(300_000),
    path: Schema.string(),
    authMode: Schema.union(['hmac-sha256', 'bearer', 'shared-secret'] as const),
    secretHeader: Schema.string(),
  }),
  Schema.object({
    ...base,
    kind: Schema.const('task-system').required(),
    url: Schema.string().required(),
    itemsPointer: Schema.string().default(''),
    fields: Schema.any(),
    statusFilter: Schema.any(),
    assigneeFilter: Schema.any(),
    since: Schema.string(),
    maxItems: Schema.number().step(1).min(1).max(500).default(100),
    credentialHandle: Schema.string(),
    authScheme: Schema.union(['bearer', 'x-api-key'] as const).default('bearer'),
    fireWhen: Schema.union(['changed', 'truthy'] as const).default('changed'),
    debounceMs: Schema.number().step(1).min(0).max(86_400_000).default(0),
  }),
  Schema.object({
    ...base,
    kind: Schema.const('calendar').required(),
    url: Schema.string().required(),
    format: Schema.union(['ics', 'json-events'] as const).required(),
    itemsPointer: Schema.string(),
    window: Schema.any(),
    windowParams: Schema.any(),
    maxEvents: Schema.number().step(1).min(1).max(5_000).default(500),
    credentialHandle: Schema.string(),
    fireWhen: Schema.union(['changed', 'truthy'] as const).default('changed'),
    debounceMs: Schema.number().step(1).min(0).max(86_400_000).default(0),
  }),
  Schema.object({
    ...base,
    kind: Schema.const('email').required(),
    url: Schema.string().required(),
    protocol: Schema.union(['rest-json', 'jmap'] as const).default('rest-json'),
    accountId: Schema.string(),
    mailboxId: Schema.string(),
    messagesPointer: Schema.string(),
    fromFilter: Schema.any(),
    subjectContains: Schema.string(),
    unreadOnly: Schema.boolean().default(false),
    maxMessages: Schema.number().step(1).min(1).max(500).default(100),
    credentialHandle: Schema.string(),
    fireWhen: Schema.union(['changed', 'truthy'] as const).default('changed'),
    debounceMs: Schema.number().step(1).min(0).max(86_400_000).default(0),
  }),
])

export const ConfigSchema = Schema.object({
  databasePath: Schema.string().required(),
  allowedFileRoots: Schema.array(Schema.string()).default([]),
  allowedHttpOrigins: Schema.array(Schema.string()).default([]),
  allowedHttpHosts: Schema.array(Schema.string()).default([]),
  triggers: Schema.array(triggerSchema).default([]),
  webhookListen: Schema.any(),
  pollerEnabled: Schema.boolean().default(true),
  pollIntervalMs: Schema.number().step(1).min(1_000).max(3_600_000).default(5_000),
  pollConcurrency: Schema.number().step(1).min(1).max(32).default(8),
  requestTimeoutMs: Schema.number().step(1).min(100).max(300_000).default(10_000),
  maxBodyBytes: Schema.number().step(1).min(1).max(16_777_216).default(65_536),
  ipv6Mode: Schema.union(['deny', 'native-only'] as const).default('deny'),
}) as Schema<Config>

function id(value: string, field: string): string {
  const normalized = value.normalize('NFC').trim()
  if (!/^[a-z0-9][a-z0-9._:-]{0,199}$/u.test(normalized)) {
    throw new Error(`event-triggers: ${field} must be a stable lowercase identifier`)
  }
  return normalized
}

function contained(path: string, roots: readonly string[]): boolean {
  const target = resolve(path)
  return roots.some(root => {
    const child = relative(root, target)
    return child === '' || (!child.startsWith('..') && !isAbsolute(child))
  })
}

function normalizeTriggerIntake(raw: unknown): NormalizedTriggerIntake | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
    || (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)) {
    throw new Error('event-triggers: intake configuration must be a plain object')
  }
  const value = raw as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (!['enabled', 'subscribed', 'summaryLabel'].includes(key)) {
      throw new Error(`event-triggers: invalid intake configuration field ${key}`)
    }
  }
  const enabled = value['enabled'] ?? false
  if (typeof enabled !== 'boolean') throw new Error('event-triggers: intake.enabled must be a boolean')
  const subscribed = value['subscribed'] ?? true
  if (typeof subscribed !== 'boolean') throw new Error('event-triggers: intake.subscribed must be a boolean')
  const rawLabel = value['summaryLabel']
  let summaryLabel: string | undefined
  if (rawLabel !== undefined) {
    if (typeof rawLabel !== 'string') throw new Error('event-triggers: intake.summaryLabel must be a string')
    const normalized = rawLabel.normalize('NFC')
    if (normalized.length === 0 || normalized.length > 160 || normalized.trim() !== normalized || /[\p{Cc}]/u.test(normalized)) {
      throw new Error('event-triggers: intake.summaryLabel must be 1-160 trimmed non-control characters')
    }
    summaryLabel = normalized
  }
  if (!enabled) return undefined
  return Object.freeze({ enabled: true as const, subscribed, ...(summaryLabel === undefined ? {} : { summaryLabel }) })
}

function httpOrigin(value: string): string {
  let url: URL
  try { url = new URL(value.normalize('NFC').trim()) } catch { throw new Error('event-triggers: invalid HTTP origin') }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('event-triggers: HTTP origins must be exact HTTPS origins without credentials, path, query, or fragment')
  }
  return url.origin
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function trimmedText(value: unknown, field: string, max = 256): string {
  if (typeof value !== 'string') throw new Error(`event-triggers: ${field} must be a string`)
  const normalized = value.normalize('NFC').trim()
  if (normalized.length === 0 || normalized.length > max || /[\p{Cc}]/u.test(normalized)) {
    throw new Error(`event-triggers: ${field} must be 1-${max} non-control characters`)
  }
  return normalized
}

function isLoopbackHost(rawHost: string): boolean {
  const unbracketed = (rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost).toLowerCase()
  if (unbracketed === 'localhost') return true
  if (isIP(unbracketed) === 4) {
    return unbracketed.split('.')[0] === '127'
  }
  if (isIP(unbracketed) === 6) {
    if (unbracketed === '::1' || unbracketed === '0:0:0:0:0:0:0:1') return true
    if (unbracketed.startsWith('::ffff:127.')) return true
    if (/^(?:0{1,4}:){7}0{0,3}1$/u.test(unbracketed)) return true
  }
  return false
}

function normalizeListenHost(rawValue: unknown): string {
  const rawHost = trimmedText(rawValue, 'webhookListen.host', 256)
  if (/\s/u.test(rawHost)) throw new Error('event-triggers: webhookListen.host cannot contain whitespace')
  if (rawHost.startsWith('[') || rawHost.endsWith(']')) {
    if (!rawHost.startsWith('[') || !rawHost.endsWith(']')) {
      throw new Error('event-triggers: webhookListen.host has malformed IPv6 brackets')
    }
    const unbracketed = rawHost.slice(1, -1)
    if (isIP(unbracketed) !== 6) {
      throw new Error('event-triggers: webhookListen.host bracketed literal must be a valid IPv6 address')
    }
    return unbracketed
  }
  return rawHost
}

function normalizeHttpPath(value: unknown, field: string): string {
  const path = trimmedText(value, field, 256)
  if (!path.startsWith('/') || /\s/u.test(path) || path.includes('..') || path.includes('?') || path.includes('#')) {
    throw new Error(`event-triggers: ${field} must be a valid HTTP pathname starting with /`)
  }
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

function normalizeWebhookListenConfig(raw: unknown): NormalizedWebhookListenConfig {
  if (!isPlainObject(raw)) {
    throw new Error('event-triggers: webhookListen must be a plain object')
  }
  const allowedKeys = new Set(['enabled', 'host', 'port', 'basePath', 'allowNonLoopback', 'maxConcurrentRequests', 'drainTimeoutMs'])
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) throw new Error(`event-triggers: invalid webhookListen field ${key}`)
  }
  let parsed: Required<WebhookListenConfig>
  try {
    parsed = webhookListenSchema(raw) as Required<WebhookListenConfig>
  } catch (error) {
    throw new Error(`event-triggers: invalid webhookListen configuration: ${String(error)}`, { cause: error })
  }
  const host = normalizeListenHost(parsed.host)
  if (!parsed.allowNonLoopback && !isLoopbackHost(host)) {
    throw new Error('event-triggers: webhookListen host requires allowNonLoopback: true for non-loopback addresses')
  }
  if (!Number.isSafeInteger(parsed.port) || parsed.port < 0 || parsed.port > 65_535) {
    throw new Error('event-triggers: webhookListen.port must be between 0 and 65535')
  }
  const basePath = normalizeHttpPath(parsed.basePath, 'webhookListen.basePath')
  return Object.freeze({
    enabled: parsed.enabled,
    host,
    port: parsed.port,
    basePath,
    allowNonLoopback: parsed.allowNonLoopback,
    maxConcurrentRequests: parsed.maxConcurrentRequests,
    drainTimeoutMs: parsed.drainTimeoutMs,
  })
}

function normalizeHttpsUrl(rawUrl: string, origins: readonly string[]): string {
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new Error('event-triggers: invalid HTTP URL') }
  if (url.protocol !== 'https:') throw new Error('event-triggers: HTTP sensors require HTTPS')
  if (url.username !== '' || url.password !== '' || !origins.includes(url.origin)) {
    throw new Error('event-triggers: HTTP sensor host/origin is not allowlisted')
  }
  return url.toString()
}

function normalizeFilterList(raw: unknown, field: string, maxItems = 50, maxLen = 128, lowercase = false): readonly string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > maxItems) {
    throw new Error(`event-triggers: ${field} must have between 1 and ${maxItems} entries`)
  }
  const normalized = raw.map(entry => {
    const text = trimmedText(entry, field, maxLen)
    return lowercase ? text.toLowerCase() : text
  })
  return Object.freeze([...new Set(normalized)])
}

function normalizeTaskSystemFields(raw: unknown): Readonly<Required<TaskSystemFieldsConfig>> | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) throw new Error('event-triggers: task-system fields must be a plain object')
  for (const key of Object.keys(raw)) {
    if (!['id', 'updatedAt', 'status', 'assignee', 'title'].includes(key)) {
      throw new Error(`event-triggers: invalid task-system field mapping ${key}`)
    }
  }
  const fieldName = (key: keyof TaskSystemFieldsConfig, fallback: string) =>
    raw[key] === undefined ? fallback : trimmedText(raw[key], `fields.${key}`, 128)
  return Object.freeze({
    id: fieldName('id', 'id'),
    updatedAt: fieldName('updatedAt', 'updatedAt'),
    status: fieldName('status', 'status'),
    assignee: fieldName('assignee', 'assignee'),
    title: fieldName('title', 'title'),
  })
}

function normalizeSince(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  const value = trimmedText(raw, 'since', 64)
  if (/^[0-9]+$/u.test(value)) {
    const ms = Number(value)
    if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('event-triggers: invalid since timestamp')
    return value
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || parsed < 0 || !/[T-]/u.test(value)) {
    throw new Error('event-triggers: since must be an ISO-8601 date or non-negative epoch ms string')
  }
  return value
}

function normalizeCalendarWindow(raw: unknown): Readonly<CalendarWindowConfig> | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) throw new Error('event-triggers: calendar window must be a plain object')
  for (const key of Object.keys(raw)) {
    if (!['mode', 'startTime', 'endTime', 'lookbackSeconds', 'lookaheadSeconds'].includes(key)) {
      throw new Error(`event-triggers: invalid calendar window field ${key}`)
    }
  }
  const mode = raw['mode']
  if (mode === 'static') {
    if (raw['lookbackSeconds'] !== undefined || raw['lookaheadSeconds'] !== undefined) {
      throw new Error('event-triggers: static calendar window cannot specify rolling bounds')
    }
    const startTime = raw['startTime']
    const endTime = raw['endTime']
    if (typeof startTime !== 'number' || typeof endTime !== 'number'
      || !Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime)
      || startTime < 0 || endTime <= startTime || endTime - startTime > 31_536_000) {
      throw new Error('event-triggers: invalid static calendar window')
    }
    return Object.freeze({ mode: 'static', startTime, endTime })
  }
  if (mode === 'rolling') {
    if (raw['startTime'] !== undefined || raw['endTime'] !== undefined) {
      throw new Error('event-triggers: rolling calendar window cannot specify static bounds')
    }
    const lookbackSeconds = raw['lookbackSeconds'] ?? 0
    const lookaheadSeconds = raw['lookaheadSeconds'] ?? 0
    if (typeof lookbackSeconds !== 'number' || typeof lookaheadSeconds !== 'number'
      || !Number.isSafeInteger(lookbackSeconds) || !Number.isSafeInteger(lookaheadSeconds)
      || lookbackSeconds < 0 || lookaheadSeconds < 0
      || lookbackSeconds + lookaheadSeconds < 1 || lookbackSeconds + lookaheadSeconds > 31_536_000) {
      throw new Error('event-triggers: invalid rolling calendar window')
    }
    return Object.freeze({ mode: 'rolling', lookbackSeconds, lookaheadSeconds })
  }
  throw new Error('event-triggers: calendar window.mode must be static or rolling')
}

function normalizeCalendarWindowParams(raw: unknown, hasWindow: boolean): Readonly<Required<CalendarWindowParamsConfig>> | undefined {
  if (raw === undefined) return undefined
  if (!hasWindow) throw new Error('event-triggers: calendar windowParams requires window configuration')
  if (!isPlainObject(raw)) throw new Error('event-triggers: calendar windowParams must be a plain object')
  for (const key of Object.keys(raw)) {
    if (!['startParam', 'endParam', 'format'].includes(key)) {
      throw new Error(`event-triggers: invalid calendar windowParams field ${key}`)
    }
  }
  const startParam = trimmedText(raw['startParam'], 'windowParams.startParam', 64)
  const endParam = trimmedText(raw['endParam'], 'windowParams.endParam', 64)
  if (/\s/u.test(startParam) || /\s/u.test(endParam) || startParam === endParam) {
    throw new Error('event-triggers: invalid calendar windowParams parameter names')
  }
  const format = raw['format'] ?? 'iso'
  if (format !== 'iso' && format !== 'unix-seconds') {
    throw new Error('event-triggers: calendar windowParams.format must be iso or unix-seconds')
  }
  return Object.freeze({ startParam, endParam, format })
}

export function normalizeEventTriggersConfig(input: Config): NormalizedConfig {
  const webhookListen = input !== null && typeof input === 'object' && input.webhookListen !== undefined
    ? normalizeWebhookListenConfig(input.webhookListen)
    : undefined
  // Schemas intentionally discard unrelated keys for compatibility.  In direct
  // commit mode these PR selectors would misleadingly imply that they narrow
  // the observation, so reject them before schema normalization can erase them.
  for (const raw of input.triggers ?? []) {
    if (raw !== null && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'github-repository' && (raw as { deliveryMode?: unknown }).deliveryMode === 'commit'
      && ['pullRequestNumber', 'reviewerIds', 'minApprovals'].some(key => Object.hasOwn(raw, key))) {
      throw new Error('event-triggers: commit GitHub repository observation does not accept pull-request fields')
    }
  }
  let parsed: Required<Config>
  try {
    parsed = ConfigSchema(input) as typeof parsed
  } catch (error) {
    throw new Error(`event-triggers: invalid configuration: ${String(error)}`, { cause: error })
  }
  if (!isAbsolute(parsed.databasePath)) throw new Error('event-triggers: databasePath must be absolute')
  const roots = parsed.allowedFileRoots.map(root => {
    if (!isAbsolute(root)) throw new Error('event-triggers: allowed file roots must be absolute')
    return resolve(root)
  })
  const hosts = parsed.allowedHttpHosts.map(host => host.normalize('NFC').trim().toLowerCase())
  if (hosts.some(host => !/^[a-z0-9.-]+$/u.test(host))) {
    throw new Error('event-triggers: HTTP allowlist contains an invalid hostname')
  }
  const origins = [...new Set([
    ...hosts.map(host => `https://${host}`),
    ...parsed.allowedHttpOrigins.map(httpOrigin),
  ])]
  const triggers = parsed.triggers.map(raw => {
    const trigger = { ...raw, id: id(raw.id, 'trigger id'), automationId: id(raw.automationId, 'automationId') }
    if (trigger.observer !== undefined) {
      const owner = observerSchema()(trigger.observer) as EventObserverConfig
      if (Object.keys(owner).some(key => !['workspace', 'preset', 'principalId', 'principalRecordId', 'principalVersion', 'ownerRouteId', 'expiresAt', 'budgetId'].includes(key))) throw new Error('event-triggers: invalid observer fields')
      trigger.observer = owner
      if (!isAbsolute(owner.workspace) || !Number.isSafeInteger(owner.principalVersion) || !Number.isSafeInteger(owner.expiresAt)
        || [owner.preset, owner.principalId, owner.principalRecordId, owner.ownerRouteId, owner.budgetId].some(value => value.length === 0 || value.length > 256 || value.trim() !== value || /[\p{Cc}]/u.test(value))) throw new Error('event-triggers: invalid observer owner')
      Object.freeze(owner)
    }
    if (trigger.observerLifetime === 'goal' && trigger.observer === undefined) {
      throw new Error('event-triggers: goal observer lifetime requires an observer owner')
    }
    const intake = normalizeTriggerIntake(trigger.intake)
    if (intake !== undefined) {
      if (trigger.observer === undefined) {
        throw new Error('event-triggers: intake observation requires an observer owner')
      }
      trigger.intake = intake
    } else {
      delete trigger.intake
    }
    if (trigger.kind === 'github-repository') {
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(trigger.repository)
        || trigger.branch.length === 0 || trigger.branch.length > 256 || trigger.branch.trim() !== trigger.branch || /[\p{Cc}]/u.test(trigger.branch)) throw new Error('event-triggers: invalid GitHub repository scope')
      if (trigger.baseBranch === trigger.branch || trigger.baseBranch.length === 0 || trigger.baseBranch.length > 256 || trigger.baseBranch.trim() !== trigger.baseBranch || /[\p{Cc}]/u.test(trigger.baseBranch)) throw new Error('event-triggers: invalid GitHub repository scope')
      const hasCredential = typeof trigger.credentialHandle === 'string' && trigger.credentialHandle.length > 0
      const rawGrant = trigger.externalGrant
      if (hasCredential === (rawGrant !== undefined)) throw new Error('event-triggers: GitHub repository requires exactly one credentialHandle or externalGrant')
      if (rawGrant !== undefined) {
        if (!rawGrant || typeof rawGrant !== 'object'
          || (Object.getPrototypeOf(rawGrant) !== Object.prototype && Object.getPrototypeOf(rawGrant) !== null)
          || Reflect.ownKeys(rawGrant).length !== 3 || !['id', 'revision', 'digest'].every(key => Object.hasOwn(rawGrant, key))
          || Object.values(Object.getOwnPropertyDescriptors(rawGrant)).some(descriptor => !descriptor.enumerable || !('value' in descriptor))
          || typeof rawGrant.id !== 'string' || !Number.isSafeInteger(rawGrant.revision) || rawGrant.revision < 1
          || typeof rawGrant.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(rawGrant.digest)) throw new Error('event-triggers: invalid external GitHub grant')
        if (trigger.observerLifetime !== 'goal' || trigger.observer === undefined) throw new Error('event-triggers: external GitHub repository requires observer and goal lifetime')
        return Object.freeze({ ...trigger, credentialHandle: undefined, externalGrant: Object.freeze({ id: id(rawGrant.id, 'externalGrant.id'), revision: rawGrant.revision, digest: rawGrant.digest }) })
      }
      return Object.freeze({ ...trigger, credentialHandle: id(trigger.credentialHandle!, 'credentialHandle'), externalGrant: undefined })
    }
    if (trigger.kind === 'lark-calendar') {
      if (trigger.calendarId.length === 0 || trigger.calendarId.length > 512 || trigger.calendarId.trim() !== trigger.calendarId || /[\p{Cc}]/u.test(trigger.calendarId)) {
        throw new Error('event-triggers: invalid Lark calendar scope')
      }
      const hasStatic = trigger.startTime !== undefined || trigger.endTime !== undefined
      const hasRolling = trigger.lookbackSeconds !== undefined || trigger.lookaheadSeconds !== undefined || trigger.windowStepSeconds !== undefined
      if (hasStatic === hasRolling) {
        throw new Error('event-triggers: invalid Lark calendar scope')
      }
      const copy = { ...trigger }
      if (hasStatic) {
        if (copy.startTime === undefined || copy.endTime === undefined
          || !Number.isSafeInteger(copy.startTime) || !Number.isSafeInteger(copy.endTime)
          || copy.startTime < 0 || copy.endTime <= copy.startTime || copy.endTime - copy.startTime > 31_536_000) {
          throw new Error('event-triggers: invalid Lark calendar scope')
        }
        delete copy.lookbackSeconds
        delete copy.lookaheadSeconds
        delete copy.windowStepSeconds
        return Object.freeze(copy)
      }
      const lookbackSeconds = copy.lookbackSeconds ?? 0
      const lookaheadSeconds = copy.lookaheadSeconds ?? 0
      if (!Number.isSafeInteger(lookbackSeconds) || !Number.isSafeInteger(lookaheadSeconds)
        || lookbackSeconds < 0 || lookaheadSeconds < 0
        || lookbackSeconds + lookaheadSeconds < 1 || lookbackSeconds + lookaheadSeconds > 31_536_000) {
        throw new Error('event-triggers: invalid Lark calendar scope')
      }
      if (copy.windowStepSeconds !== undefined && (!Number.isSafeInteger(copy.windowStepSeconds)
        || copy.windowStepSeconds < 1 || copy.windowStepSeconds > 86_400
        || copy.windowStepSeconds > lookbackSeconds + lookaheadSeconds)) {
        throw new Error('event-triggers: invalid Lark calendar scope')
      }
      delete copy.startTime
      delete copy.endTime
      if (copy.windowStepSeconds === undefined) delete copy.windowStepSeconds
      return Object.freeze({ ...copy, lookbackSeconds, lookaheadSeconds })
    }
    if (trigger.kind === 'file') {
      if (!isAbsolute(trigger.path) || !contained(trigger.path, roots)) {
        throw new Error('event-triggers: file path is outside allowedFileRoots')
      }
      return Object.freeze({ ...trigger, path: resolve(trigger.path) })
    }
    if (trigger.kind === 'http-json') {
      const url = normalizeHttpsUrl(trigger.url, origins)
      if (trigger.pointer !== '' && !trigger.pointer.startsWith('/')) {
        throw new Error('event-triggers: JSON pointer must be empty or start with /')
      }
      return Object.freeze({ ...trigger, url })
    }
    if (trigger.kind === 'task-system') {
      const url = normalizeHttpsUrl(trigger.url, origins)
      const itemsPointer = trigger.itemsPointer ?? ''
      if (itemsPointer !== '' && !itemsPointer.startsWith('/')) {
        throw new Error('event-triggers: task-system itemsPointer must be empty or start with /')
      }
      const fields = normalizeTaskSystemFields(trigger.fields)
      const statusFilter = normalizeFilterList(trigger.statusFilter, 'statusFilter')
      const assigneeFilter = normalizeFilterList(trigger.assigneeFilter, 'assigneeFilter')
      const since = normalizeSince(trigger.since)
      const credentialHandle = trigger.credentialHandle !== undefined && trigger.credentialHandle !== ''
        ? id(trigger.credentialHandle, 'credentialHandle')
        : undefined
      const copy = { ...trigger, url, itemsPointer }
      if (fields !== undefined) copy.fields = fields; else delete copy.fields
      if (statusFilter !== undefined) copy.statusFilter = statusFilter as string[]; else delete copy.statusFilter
      if (assigneeFilter !== undefined) copy.assigneeFilter = assigneeFilter as string[]; else delete copy.assigneeFilter
      if (since !== undefined) copy.since = since; else delete copy.since
      if (credentialHandle !== undefined) copy.credentialHandle = credentialHandle; else delete copy.credentialHandle
      return Object.freeze(copy)
    }
    if (trigger.kind === 'calendar') {
      const url = normalizeHttpsUrl(trigger.url, origins)
      if (trigger.format === 'ics' && trigger.itemsPointer !== undefined) {
        throw new Error('event-triggers: ICS calendar does not accept itemsPointer')
      }
      const itemsPointer = trigger.format === 'json-events' ? (trigger.itemsPointer ?? '/items') : undefined
      if (itemsPointer !== undefined && itemsPointer !== '' && !itemsPointer.startsWith('/')) {
        throw new Error('event-triggers: calendar itemsPointer must be empty or start with /')
      }
      const window = normalizeCalendarWindow(trigger.window)
      const windowParams = normalizeCalendarWindowParams(trigger.windowParams, window !== undefined)
      const credentialHandle = trigger.credentialHandle !== undefined && trigger.credentialHandle !== ''
        ? id(trigger.credentialHandle, 'credentialHandle')
        : undefined
      const copy = { ...trigger, url }
      if (itemsPointer !== undefined) copy.itemsPointer = itemsPointer; else delete copy.itemsPointer
      if (window !== undefined) copy.window = window; else delete copy.window
      if (windowParams !== undefined) copy.windowParams = windowParams; else delete copy.windowParams
      if (credentialHandle !== undefined) copy.credentialHandle = credentialHandle; else delete copy.credentialHandle
      return Object.freeze(copy)
    }
    if (trigger.kind === 'email') {
      const url = normalizeHttpsUrl(trigger.url, origins)
      if (trigger.protocol === 'jmap' && trigger.messagesPointer !== undefined) {
        throw new Error('event-triggers: JMAP email trigger does not accept messagesPointer')
      }
      const messagesPointer = trigger.protocol === 'rest-json' ? (trigger.messagesPointer ?? '/messages') : undefined
      if (messagesPointer !== undefined && messagesPointer !== '' && !messagesPointer.startsWith('/')) {
        throw new Error('event-triggers: email messagesPointer must be empty or start with /')
      }
      const accountId = trigger.accountId !== undefined ? trimmedText(trigger.accountId, 'accountId', 256) : undefined
      if (trigger.protocol === 'jmap' && accountId === undefined) {
        throw new Error('event-triggers: JMAP email trigger requires accountId')
      }
      const mailboxId = trigger.mailboxId !== undefined ? trimmedText(trigger.mailboxId, 'mailboxId', 256) : undefined
      const fromFilter = normalizeFilterList(trigger.fromFilter, 'fromFilter', 50, 256, true)
      const subjectContains = trigger.subjectContains !== undefined ? trimmedText(trigger.subjectContains, 'subjectContains', 200) : undefined
      const credentialHandle = trigger.credentialHandle !== undefined && trigger.credentialHandle !== ''
        ? id(trigger.credentialHandle, 'credentialHandle')
        : undefined
      const copy = { ...trigger, url }
      if (accountId !== undefined) copy.accountId = accountId; else delete copy.accountId
      if (mailboxId !== undefined) copy.mailboxId = mailboxId; else delete copy.mailboxId
      if (messagesPointer !== undefined) copy.messagesPointer = messagesPointer; else delete copy.messagesPointer
      if (fromFilter !== undefined) copy.fromFilter = fromFilter as string[]; else delete copy.fromFilter
      if (subjectContains !== undefined) copy.subjectContains = subjectContains; else delete copy.subjectContains
      if (credentialHandle !== undefined) copy.credentialHandle = credentialHandle; else delete copy.credentialHandle
      return Object.freeze(copy)
    }
    const copy = { ...trigger, credentialHandle: id(trigger.credentialHandle, 'credentialHandle') }
    if (copy.path !== undefined) copy.path = normalizeHttpPath(copy.path, 'webhook.path')
    else delete copy.path
    if (copy.secretHeader !== undefined) {
      if (copy.authMode !== 'shared-secret') {
        throw new Error('event-triggers: webhook secretHeader requires authMode shared-secret')
      }
      const header = trimmedText(copy.secretHeader, 'webhook.secretHeader', 128).toLowerCase()
      if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(header) || ['host', 'content-length', 'authorization'].includes(header)) {
        throw new Error('event-triggers: invalid webhook secretHeader name')
      }
      copy.secretHeader = header
    } else {
      delete copy.secretHeader
    }
    if (copy.authMode === undefined) delete copy.authMode
    return Object.freeze(copy)
  }) as NormalizedTrigger[]
  if (triggers.length > 1_000) throw new Error('event-triggers: too many triggers')
  if (new Set(triggers.map(trigger => trigger.id)).size !== triggers.length) {
    throw new Error('event-triggers: trigger ids must be unique')
  }
  const basePath = webhookListen?.basePath ?? '/webhooks'
  const webhookRoutes = new Set<string>()
  for (const trigger of triggers) {
    if (trigger.kind !== 'webhook' || !trigger.enabled) continue
    const route = trigger.path ?? `${basePath === '/' ? '' : basePath}/${trigger.id}`
    if (webhookRoutes.has(route)) {
      throw new Error(`event-triggers: duplicate webhook route ${route}`)
    }
    webhookRoutes.add(route)
  }
  return Object.freeze({
    databasePath: parsed.databasePath,
    pollerEnabled: parsed.pollerEnabled,
    pollIntervalMs: parsed.pollIntervalMs,
    pollConcurrency: parsed.pollConcurrency,
    requestTimeoutMs: parsed.requestTimeoutMs,
    maxBodyBytes: parsed.maxBodyBytes,
    ipv6Mode: parsed.ipv6Mode,
    ...(webhookListen === undefined ? {} : { webhookListen }),
    allowedFileRoots: Object.freeze(roots),
    allowedHttpHosts: Object.freeze(hosts),
    allowedHttpOrigins: Object.freeze(origins),
    triggers: Object.freeze(triggers),
  })
}
