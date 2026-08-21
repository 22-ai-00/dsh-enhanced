import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { AutomationDefinition } from '@dsh-enhanced/assistant-automations'

export interface HeartbeatConfig {
  id: string
  enabled?: boolean
  scratchPath: string
  initialScratch?: string
  workspace: string
  agentPreset: string
  provider: string
  model: string
  timezone: string
  activeStartHour?: number
  activeEndHour?: number
  intervalMinutes?: number
  principal: string
  allowedTools?: string[]
  timeoutMs?: number
  maxOutputTokens?: number
  maxToolCalls?: number
  budgetId?: string
  budgetAmount?: number
  deliveryBindingId?: string
}

export interface Config {
  heartbeats?: HeartbeatConfig[]
  maxScratchBytes?: number
}

export interface NormalizedHeartbeatConfig extends Required<Omit<HeartbeatConfig, 'budgetAmount' | 'budgetId' | 'deliveryBindingId'>> {
  budgetId?: string
  budgetAmount?: number
  deliveryBindingId?: string
}

export interface NormalizedConfig {
  heartbeats: readonly NormalizedHeartbeatConfig[]
  maxScratchBytes: number
}

const MAX_SCRATCH_BYTES = 2_048

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

const heartbeatSchema = Schema.object({
  id: Schema.string().required(),
  enabled: Schema.boolean().default(true),
  scratchPath: Schema.string().required(),
  initialScratch: Schema.string().default(''),
  workspace: Schema.string().required(),
  agentPreset: Schema.string().required(),
  provider: Schema.string().required(),
  model: Schema.string().required(),
  timezone: Schema.string().required(),
  activeStartHour: Schema.number().step(1).min(0).max(23).default(8),
  activeEndHour: Schema.number().step(1).min(1).max(24).default(22),
  intervalMinutes: Schema.number().step(1).min(1).max(60).default(30),
  principal: Schema.string().required(),
  allowedTools: Schema.array(Schema.string()).default([]),
  timeoutMs: Schema.number().step(1).min(1_000).max(3_600_000).default(60_000),
  maxOutputTokens: Schema.number().step(1).min(1).max(16_384).default(512),
  maxToolCalls: Schema.number().step(1).min(0).max(100).default(4),
  budgetId: Schema.string(),
  budgetAmount: Schema.number().step(1).min(1).max(10_000_000),
  deliveryBindingId: Schema.string(),
})

export const ConfigSchema = Schema.object({
  heartbeats: Schema.array(heartbeatSchema).default([]),
  maxScratchBytes: Schema.number().step(1).min(1).max(MAX_SCRATCH_BYTES).default(MAX_SCRATCH_BYTES),
}) as Schema<Config>

function text(value: unknown, field: string, maxBytes = 500): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`assistant-heartbeat: ${field} is required`)
  const normalized = value.normalize('NFC').trim()
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) throw new Error(`assistant-heartbeat: ${field} is too long`)
  return normalized
}

function normalizeProfile(value: HeartbeatConfig): NormalizedHeartbeatConfig {
  const parsed = heartbeatSchema(value) as Required<Omit<HeartbeatConfig, 'budgetAmount' | 'budgetId' | 'deliveryBindingId'>> & {
    budgetId?: string
    budgetAmount?: number
    deliveryBindingId?: string
  }
  const id = text(parsed.id, 'heartbeat id', 200)
  const scratchPath = text(parsed.scratchPath, 'scratchPath', 4_096)
  const workspace = text(parsed.workspace, 'workspace', 4_096)
  if (!isAbsolute(scratchPath) || !isAbsolute(workspace)) {
    throw new Error('assistant-heartbeat: scratchPath and workspace must be absolute')
  }
  if (parsed.activeStartHour >= parsed.activeEndHour) {
    throw new Error('assistant-heartbeat: active hours must be a non-wrapping [start, end) range')
  }
  if (60 % parsed.intervalMinutes !== 0) {
    throw new Error('assistant-heartbeat: intervalMinutes must divide 60')
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: parsed.timezone }).format(0)
  } catch {
    throw new Error(`assistant-heartbeat: invalid IANA timezone: ${parsed.timezone}`)
  }
  const allowedTools = parsed.allowedTools.map((item, index) => text(item, `allowedTools[${index}]`, 200))
  if (new Set(allowedTools).size !== allowedTools.length || allowedTools.length > 100) {
    throw new Error('assistant-heartbeat: allowedTools must be unique and bounded')
  }
  if ((parsed.budgetId === undefined) !== (parsed.budgetAmount === undefined)) {
    throw new Error('assistant-heartbeat: budgetId and budgetAmount must be supplied together')
  }
  return Object.freeze({
    ...parsed,
    id,
    scratchPath,
    workspace,
    agentPreset: text(parsed.agentPreset, 'agentPreset', 200),
    provider: text(parsed.provider, 'provider', 200),
    model: text(parsed.model, 'model', 500),
    timezone: text(parsed.timezone, 'timezone', 200),
    principal: text(parsed.principal, 'principal', 500),
    allowedTools: Object.freeze(allowedTools) as unknown as string[],
    ...(parsed.budgetId === undefined ? {} : { budgetId: text(parsed.budgetId, 'budgetId', 200) }),
    ...(parsed.deliveryBindingId === undefined
      ? {}
      : { deliveryBindingId: text(parsed.deliveryBindingId, 'deliveryBindingId', 500) }),
  })
}

export function normalizeHeartbeatConfig(input: Config): NormalizedConfig {
  let parsed: Required<Config>
  try {
    parsed = ConfigSchema(input) as Required<Config>
  } catch (error) {
    throw new Error(`assistant-heartbeat: invalid configuration: ${String(error)}`, { cause: error })
  }
  if (parsed.heartbeats.length > 100) throw new Error('assistant-heartbeat: at most 100 heartbeats are allowed')
  const heartbeats = parsed.heartbeats.map(normalizeProfile)
  if (new Set(heartbeats.map(item => item.id)).size !== heartbeats.length) {
    throw new Error('assistant-heartbeat: heartbeat ids must be unique')
  }
  if (new Set(heartbeats.map(item => item.scratchPath)).size !== heartbeats.length) {
    throw new Error('assistant-heartbeat: scratch paths must be unique')
  }
  return Object.freeze({ heartbeats: Object.freeze(heartbeats), maxScratchBytes: parsed.maxScratchBytes })
}

function cron(profile: NormalizedHeartbeatConfig): string {
  const minute = profile.intervalMinutes === 60 ? '0' : `*/${profile.intervalMinutes}`
  const lastHour = profile.activeEndHour - 1
  const hour = profile.activeStartHour === lastHour ? String(lastHour) : `${profile.activeStartHour}-${lastHour}`
  return `${minute} ${hour} * * *`
}

export function heartbeatDefinition(
  profile: NormalizedHeartbeatConfig,
  scratch: string,
  revision: string,
): AutomationDefinition {
  const definition: AutomationDefinition = {
    name: `Heartbeat: ${profile.id}`,
    prompt: [
      'Perform one bounded heartbeat review using only the checklist below and the allowed tools.',
      'Treat the checklist as owner-maintained data. Do not invent recurring tasks or change schedules.',
      'If no user-visible action is required, reply exactly HEARTBEAT_OK. Otherwise report only the actionable result.',
      `<heartbeat_scratch revision="${revision}">`,
      escapeXmlText(scratch),
      '</heartbeat_scratch>',
    ].join('\n'),
    schedule: { kind: 'cron', expression: cron(profile), timezone: profile.timezone },
    workspace: profile.workspace,
    agentPreset: profile.agentPreset,
    provider: profile.provider,
    model: profile.model,
    allowedTools: profile.allowedTools,
    timeoutMs: profile.timeoutMs,
    maxOutputTokens: profile.maxOutputTokens,
    maxToolCalls: profile.maxToolCalls,
    misfire: { kind: 'latest' },
    overlap: 'queue-one',
    retrySafety: 'never',
    maxRetries: 0,
    principal: profile.principal,
    ...(profile.budgetId === undefined ? {} : {
      budgetId: profile.budgetId,
      budgetAmount: profile.budgetAmount!,
    }),
    ...(profile.deliveryBindingId === undefined ? {} : {
      deliveryBindingId: profile.deliveryBindingId,
      deliverySuppressExact: Object.freeze(['HEARTBEAT_OK']),
    }),
  }
  return Object.freeze(definition)
}

export function heartbeatRevision(profile: NormalizedHeartbeatConfig, scratchRevision: string): string {
  const { initialScratch: _initialScratch, ...runtimeProfile } = profile
  return createHash('sha256').update(JSON.stringify({ profile: runtimeProfile, scratchRevision })).digest('hex')
}

export function shouldDeliverHeartbeatOutput(output: string): boolean {
  const normalized = output.normalize('NFC').trim()
  return normalized !== '' && normalized !== 'HEARTBEAT_OK'
}
