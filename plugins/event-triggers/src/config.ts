import { isAbsolute, relative, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { EventObserverConfig } from './observer.js'

export type FireWhen = 'changed' | 'truthy'
export type Ipv6Mode = 'deny' | 'native-only'

interface TriggerBase {
  id: string
  automationId: string
  enabled?: boolean
  cooldownMs?: number
  maxFires?: number
  ttlMs?: number
  observer?: EventObserverConfig
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
  baseBranch: string
  credentialHandle: string
  fireWhen?: FireWhen
  debounceMs?: number
  observer: EventObserverConfig
}

export type EventTriggerConfig = FileTriggerConfig | HttpJsonTriggerConfig | WebhookTriggerConfig | GitHubRepositoryTriggerConfig

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
  | (Required<Omit<GitHubRepositoryTriggerConfig, 'ttlMs'>> & { ttlMs?: number })

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
}

const triggerSchema = Schema.union([
  Schema.object({ ...base, kind: Schema.const('github-repository').required(), repository: Schema.string().required(),
    branch: Schema.string().required(), baseBranch: Schema.string().required(), credentialHandle: Schema.string().required(),
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
    if (trigger.kind === 'github-repository') {
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(trigger.repository)
        || trigger.baseBranch === trigger.branch || [trigger.branch, trigger.baseBranch].some(value => value.length === 0 || value.length > 256 || value.trim() !== value || /[\p{Cc}]/u.test(value))) throw new Error('event-triggers: invalid GitHub repository scope')
      return Object.freeze({ ...trigger, credentialHandle: id(trigger.credentialHandle, 'credentialHandle') })
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
