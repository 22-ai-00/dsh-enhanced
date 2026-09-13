import { isAbsolute, relative, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { EventObserverConfig } from './observer.js'

export type FireWhen = 'changed' | 'truthy'
export type Ipv6Mode = 'deny' | 'native-only'
export type ObserverLifetime = 'shared' | 'goal'

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
  /** Inclusive Unix-second bounds sent to Lark's Calendar v4 list API. */
  startTime: number
  endTime: number
  pageSize?: number
  maxPages?: number
  maxEvents?: number
  fireWhen?: FireWhen
  debounceMs?: number
  observer: EventObserverConfig
}

export type EventTriggerConfig = FileTriggerConfig | HttpJsonTriggerConfig | WebhookTriggerConfig | GitHubRepositoryTriggerConfig | LarkCalendarTriggerConfig

export interface Config {
  databasePath: string
  allowedFileRoots?: string[]
  allowedHttpOrigins?: string[]
  /** @deprecated Use allowedHttpOrigins. Legacy hosts authorize HTTPS port 443 only. */
  allowedHttpHosts?: string[]
  triggers?: EventTriggerConfig[]
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
  | (Required<Omit<FileTriggerConfig, 'ttlMs' | 'observer'>> & { ttlMs?: number; observer?: EventObserverConfig })
  | (Required<Omit<HttpJsonTriggerConfig, 'ttlMs' | 'observer'>> & { ttlMs?: number; observer?: EventObserverConfig })
  | (Required<Omit<WebhookTriggerConfig, 'ttlMs' | 'observer'>> & { ttlMs?: number; observer?: EventObserverConfig })
  | (Required<Omit<GitHubRepositoryTriggerConfig, 'ttlMs' | 'credentialHandle' | 'externalGrant' | 'deliveryMode'>> & { ttlMs?: number; credentialHandle?: string; externalGrant?: Readonly<{ id: string; revision: number; digest: string }>; deliveryMode?: 'commit' | 'pull-request' })
  | (Required<Omit<LarkCalendarTriggerConfig, 'ttlMs'>> & { ttlMs?: number })

export interface NormalizedConfig {
  databasePath: string
  triggers: readonly NormalizedTrigger[]
  allowedFileRoots: readonly string[]
  allowedHttpOrigins: readonly string[]
  allowedHttpHosts: readonly string[]
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
}

const triggerSchema = Schema.union([
  Schema.object({ ...base, kind: Schema.const('github-repository').required(), repository: Schema.string().required(),
    branch: Schema.string().required(), baseBranch: Schema.string().required(), deliveryMode: Schema.union(['commit', 'pull-request'] as const), credentialHandle: Schema.string().default(''), externalGrant: Schema.any(),
    fireWhen: Schema.union(['changed', 'truthy'] as const).default('changed'), debounceMs: Schema.number().step(1).min(0).max(86_400_000).default(0), observer: observerSchema().required() }),
  Schema.object({ ...base, kind: Schema.const('lark-calendar').required(), calendarId: Schema.string().required(),
    startTime: Schema.number().step(1).min(0).required(), endTime: Schema.number().step(1).min(1).required(),
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
  }),
])

export const ConfigSchema = Schema.object({
  databasePath: Schema.string().required(),
  allowedFileRoots: Schema.array(Schema.string()).default([]),
  allowedHttpOrigins: Schema.array(Schema.string()).default([]),
  allowedHttpHosts: Schema.array(Schema.string()).default([]),
  triggers: Schema.array(triggerSchema).default([]),
  pollerEnabled: Schema.boolean().default(false),
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

function httpOrigin(value: string): string {
  let url: URL
  try { url = new URL(value.normalize('NFC').trim()) } catch { throw new Error('event-triggers: invalid HTTP origin') }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('event-triggers: HTTP origins must be exact HTTPS origins without credentials, path, query, or fragment')
  }
  return url.origin
}

export function normalizeEventTriggersConfig(input: Config): NormalizedConfig {
  if (typeof input === 'object' && input !== null && 'webhookListen' in input) {
    throw new Error('event-triggers: built-in webhook listener is not supported; use an authenticated loopback adapter')
  }
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
      if (!Number.isSafeInteger(trigger.startTime) || !Number.isSafeInteger(trigger.endTime)
        || trigger.calendarId.length === 0 || trigger.calendarId.length > 512 || trigger.calendarId.trim() !== trigger.calendarId || /[\p{Cc}]/u.test(trigger.calendarId)
        || trigger.endTime <= trigger.startTime || trigger.endTime - trigger.startTime > 31_536_000) {
        throw new Error('event-triggers: invalid Lark calendar scope')
      }
      return Object.freeze(trigger)
    }
    if (trigger.kind === 'file') {
      if (!isAbsolute(trigger.path) || !contained(trigger.path, roots)) {
        throw new Error('event-triggers: file path is outside allowedFileRoots')
      }
      return Object.freeze({ ...trigger, path: resolve(trigger.path) })
    }
    if (trigger.kind === 'http-json') {
      let url: URL
      try { url = new URL(trigger.url) } catch { throw new Error('event-triggers: invalid HTTP URL') }
      if (url.protocol !== 'https:') throw new Error('event-triggers: HTTP sensors require HTTPS')
      if (url.username !== '' || url.password !== '' || !origins.includes(url.origin)) {
        throw new Error('event-triggers: HTTP sensor host/origin is not allowlisted')
      }
      if (trigger.pointer !== '' && !trigger.pointer.startsWith('/')) {
        throw new Error('event-triggers: JSON pointer must be empty or start with /')
      }
      return Object.freeze({ ...trigger, url: url.toString() })
    }
    return Object.freeze({ ...trigger, credentialHandle: id(trigger.credentialHandle, 'credentialHandle') })
  }) as NormalizedTrigger[]
  if (triggers.length > 1_000) throw new Error('event-triggers: too many triggers')
  if (new Set(triggers.map(trigger => trigger.id)).size !== triggers.length) {
    throw new Error('event-triggers: trigger ids must be unique')
  }
  return Object.freeze({
    databasePath: parsed.databasePath,
    pollerEnabled: parsed.pollerEnabled,
    pollIntervalMs: parsed.pollIntervalMs,
    pollConcurrency: parsed.pollConcurrency,
    requestTimeoutMs: parsed.requestTimeoutMs,
    maxBodyBytes: parsed.maxBodyBytes,
    ipv6Mode: parsed.ipv6Mode,
    allowedFileRoots: Object.freeze(roots),
    allowedHttpHosts: Object.freeze(hosts),
    allowedHttpOrigins: Object.freeze(origins),
    triggers: Object.freeze(triggers),
  })
}
