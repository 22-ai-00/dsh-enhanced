import { isAbsolute, relative, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export type FireWhen = 'changed' | 'truthy'

interface TriggerBase {
  id: string
  automationId: string
  enabled?: boolean
  cooldownMs?: number
  maxFires?: number
  ttlMs?: number
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

export type EventTriggerConfig = FileTriggerConfig | HttpJsonTriggerConfig | WebhookTriggerConfig

export interface Config {
  databasePath: string
  allowedFileRoots?: string[]
  allowedHttpHosts?: string[]
  triggers?: EventTriggerConfig[]
  pollerEnabled?: boolean
  pollIntervalMs?: number
  requestTimeoutMs?: number
  maxBodyBytes?: number
}

export type NormalizedTrigger =
  | (Required<Omit<FileTriggerConfig, 'ttlMs'>> & { ttlMs?: number })
  | (Required<Omit<HttpJsonTriggerConfig, 'ttlMs'>> & { ttlMs?: number })
  | (Required<Omit<WebhookTriggerConfig, 'ttlMs'>> & { ttlMs?: number })

export interface NormalizedConfig {
  databasePath: string
  triggers: readonly NormalizedTrigger[]
  allowedFileRoots: readonly string[]
  allowedHttpHosts: readonly string[]
  pollerEnabled: boolean
  pollIntervalMs: number
  requestTimeoutMs: number
  maxBodyBytes: number
}

const base = {
  id: Schema.string().required(),
  automationId: Schema.string().required(),
  enabled: Schema.boolean().default(true),
  cooldownMs: Schema.number().step(1).min(0).max(86_400_000).default(0),
  maxFires: Schema.number().step(1).min(1).max(1_000_000).default(100),
  ttlMs: Schema.number().step(1).min(1_000).max(31_536_000_000),
}

const triggerSchema = Schema.union([
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
  allowedHttpHosts: Schema.array(Schema.string()).default([]),
  triggers: Schema.array(triggerSchema).default([]),
  pollerEnabled: Schema.boolean().default(false),
  pollIntervalMs: Schema.number().step(1).min(1_000).max(3_600_000).default(5_000),
  requestTimeoutMs: Schema.number().step(1).min(100).max(300_000).default(10_000),
  maxBodyBytes: Schema.number().step(1).min(1).max(16_777_216).default(65_536),
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
  const triggers = parsed.triggers.map(raw => {
    const trigger = { ...raw, id: id(raw.id, 'trigger id'), automationId: id(raw.automationId, 'automationId') }
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
      if (url.username !== '' || url.password !== '' || !hosts.includes(url.hostname.toLowerCase())) {
        throw new Error('event-triggers: HTTP sensor host is not allowlisted')
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
    requestTimeoutMs: parsed.requestTimeoutMs,
    maxBodyBytes: parsed.maxBodyBytes,
    allowedFileRoots: Object.freeze(roots),
    allowedHttpHosts: Object.freeze(hosts),
    triggers: Object.freeze(triggers),
  })
}
