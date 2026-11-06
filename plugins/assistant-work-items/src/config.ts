import { isAbsolute, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { WorkItemErrorCode, WorkItemReportStatus, WorkItemScope } from './types.ts'
import { WorkItemError } from './types.ts'
import type { WorkItemIntakeSourcePolicy } from './intake.ts'
import { INTAKE_SOURCE_ID } from './intake.ts'

/** Raw operator configuration. Every field is optional except the two paths. */
export interface Config {
  enabled?: boolean
  mode?: 'observe' | 'active'
  databasePath?: string
  workRoot?: string
  intakeSourceId?: string
  workerAutomationId?: string
  scope?: ScopeConfig
  admission?: AdmissionConfig
  limits?: LimitsConfig
  delivery?: DeliveryConfig
  sources?: SourcesConfig
  settlement?: SettlementConfig
  diagnosis?: DiagnosisConfig
  ownerRecall?: { enabled?: boolean; linkedAliases?: string[] }
  /**
   * Cross-channel report routing. `linkedFallback` lists Delivery `linked`
   * principal ids, in order, that may receive a terminal report only when its
   * origin binding is unavailable. Absent or empty keeps origin-only delivery.
   * `prefer: 'recent'` (requires `linkedFallback`) sends to the listed alias the
   * owner most recently messaged from; default `'origin'` keeps the origin.
   */
  ownerReportRouting?: { linkedFallback?: string[]; prefer?: 'origin' | 'recent' }
  ownerContinuation?: OwnerContinuationConfig
  ownerReplyContinuation?: boolean
  ownerReportFeedback?: boolean
  intakeLedger?: IntakeLedgerConfig
  /**
   * WP21 slice 5: `autoSettle` reads bound items' verifier receipts on the
   * existing scheduler wake, at most `maxPerTick` (1–10, default 5) per wake.
   */
  /**
   * WP21 slice 6: `bindWorkerRun` binds each dispatched item to the
   * acceptance contract its worker run froze, on the same wake, at most
   * `maxPerTick` (1–10, default 5) per wake.
   */
  acceptance?: { autoSettle?: { enabled?: boolean; maxPerTick?: number }; bindWorkerRun?: { enabled?: boolean; maxPerTick?: number } }
  follows?: FollowsConfig
}

/**
 * Followed-thread sources the plugin registers itself. Each source is off by
 * default. `eventTriggers` lets a work item follow an Event Triggers
 * subscription (`<triggerId>@<afterSequence>`); it needs an enabled intake
 * with an owner scope.
 */
export interface FollowsConfig {
  eventTriggers?: { enabled?: boolean }
}

/**
 * Deterministic intake ledger (WP20 slice 1). Off by default; when enabled the
 * Host may record per-event metadata decisions. Each source opt-in admits
 * unaddressed group messages or unsubscribed events as metadata-only rows.
 */
export interface IntakeLedgerConfig {
  enabled?: boolean
  sources?: Record<string, { unaddressedGroupMessages?: boolean; unsubscribedEvents?: boolean }>
  /** WP20 stage 3: observe-only model evaluation of stored `inferred` rows. Off by default. */
  evaluation?: IntakeEvaluationConfig
}

export interface IntakeEvaluationConfig {
  enabled?: boolean
  timeoutMs?: number
  maxConsecutiveFailures?: number
  maxPerRun?: number
  maxCallsPerHour?: number
  /** WP21: route accepting `inferred` evaluations into `admitDecision`. Off by default. */
  admit?: IntakeAdmitConfig
}

/**
 * `observe` records each would-admit decision and admits nothing; `auto`
 * calls `admitDecision` and needs an active deployment whose
 * `admission.allowedKinds` includes `kind`.
 */
export interface IntakeAdmitConfig {
  enabled?: boolean
  mode?: 'observe' | 'auto'
  kind?: string
  originBindingId?: string
  maxPerHour?: number
}

/** A separately authorized Host worker; it never changes the diagnosis worker. */
export interface OwnerContinuationConfig extends DiagnosisConfig {
  automationId?: string
  allowedTools?: string[]
}
export interface NormalizedOwnerContinuation extends NormalizedDiagnosis {
  readonly automationId: string
  readonly allowedTools: readonly string[]
}

/** Independent finite diagnosis authority; enabled deployments must spell out every limit. */
export interface DiagnosisConfig {
  enabled?: boolean
  budgetId?: string
  budgetAmount?: number
  maxModelCalls?: number
  maxToolCalls?: number
  maxOutputTokens?: number
  timeoutMs?: number
  expiresAt?: number
}
export interface NormalizedDiagnosis {
  readonly enabled: true
  readonly budgetId: string
  readonly budgetAmount: number
  readonly maxModelCalls: number
  readonly maxToolCalls: number
  readonly maxOutputTokens: number
  readonly timeoutMs: number
  readonly expiresAt: number
}

export interface ScopeConfig {
  workspace?: string
  preset?: string
  principalId?: string
  ownerRouteId?: string
  expiresAt?: number
}

export interface AdmissionConfig {
  allowedKinds?: string[]
  maxOpenItems?: number
  maxAdmitsPerHour?: number
  dedupWindowMs?: number
  cooldownMs?: number
  maxBriefBytes?: number
}

export interface LimitsConfig {
  leaseMs?: number
  maxAttempts?: number
  maxReportsPerItem?: number
  maxReportBytes?: number
  waitingResumeMs?: number
}

export interface DeliveryConfig {
  notifyOn?: WorkItemReportStatus[]
}

/**
 * Bounded outcome settlement over the delivery evidence channel.
 *
 * Settlement is passive: it runs only when an unrelated call (a claim) already
 * touches the ledger, never on a timer of its own, and it never admits, wakes or
 * notifies. The window bounds how long an unverified outcome may stay pending.
 */
export interface SettlementConfig {
  enabled?: boolean
  windowMs?: number
  sweepIntervalMs?: number
  maxSourcesPerSweep?: number
  maxPendingPerSweep?: number
  maxSettlementsPerSweep?: number
}

/** Automatic signal sources mounted over optional peer services. */
export interface SourcesConfig {
  foregroundFailures?: ForegroundFailureSourceConfig
}

/**
 * Owner foreground failures observed through `assistant-delivery`.
 *
 * Disabled by default like the rest of the plugin: an operator must opt in,
 * name the admitted kind and bound both the per-sweep scan and write budget.
 */
export interface ForegroundFailureSourceConfig {
  enabled?: boolean
  kind?: string
  includeTimedOut?: boolean
  maxCandidatesPerSweep?: number
  maxAdmitsPerSweep?: number
  sweepIntervalMs?: number
}

/** Fully defaulted, validated configuration used by the service at runtime. */
export interface NormalizedConfig {
  readonly enabled: boolean
  readonly mode: 'observe' | 'active'
  readonly databasePath: string
  readonly workRoot: string
  readonly intakeSourceId: string
  readonly workerAutomationId: string | null
  readonly scope: WorkItemScope | null
  readonly admission: NormalizedAdmission
  readonly limits: NormalizedLimits
  readonly notifyOn: readonly WorkItemReportStatus[]
  readonly sources: NormalizedSources
  readonly settlement: NormalizedSettlement
  readonly diagnosis?: NormalizedDiagnosis
  /**
   * `linkedAliases` is the owner's explicit allowlist of Delivery `linked`
   * principal ids that may read through the alias path. Absent means no alias
   * is accepted, whatever Delivery or Policy would otherwise allow.
   */
  readonly ownerRecall?: Readonly<{ enabled: true; linkedAliases?: readonly string[] }>
  /** Present only when the owner named at least one linked fallback channel. */
  readonly ownerReportRouting?: Readonly<{ linkedFallback: readonly string[]; prefer?: 'recent' }>
  readonly ownerContinuation?: NormalizedOwnerContinuation
  readonly ownerReplyContinuation?: true
  readonly ownerReportFeedback?: true
  /** Present only when the intake ledger is enabled. */
  readonly intakeLedger?: NormalizedIntakeLedger
  /** Present only when `acceptance.autoSettle.enabled` is true. */
  readonly acceptanceAutoSettle?: Readonly<{ maxPerTick: number }>
  /** Present only when `acceptance.bindWorkerRun.enabled` is true. */
  readonly acceptanceBindWorkerRun?: Readonly<{ maxPerTick: number }>
  /** Present only when at least one built-in followed-thread source is enabled. */
  readonly follows?: NormalizedFollows
}

export interface NormalizedFollows {
  readonly eventTriggers: boolean
}

export interface NormalizedIntakeLedger {
  readonly enabled: true
  readonly sources: Readonly<Record<string, WorkItemIntakeSourcePolicy>>
  /** Present only when evaluation is enabled. */
  readonly evaluation?: NormalizedIntakeEvaluation
}

export interface NormalizedIntakeEvaluation {
  readonly enabled: true
  readonly timeoutMs: number
  readonly maxConsecutiveFailures: number
  readonly maxPerRun: number
  readonly maxCallsPerHour: number
  /** Present only when admission of accepting evaluations is enabled. */
  readonly admit?: NormalizedIntakeAdmit
}

export interface NormalizedIntakeAdmit {
  readonly enabled: true
  readonly mode: 'observe' | 'auto'
  readonly kind: string
  readonly originBindingId: string
  /** Items admitted from intake per rolling hour; reported to `admitDecision` as the remaining budget. */
  readonly maxPerHour: number
}

export interface NormalizedForegroundFailureSource {
  readonly enabled: boolean
  readonly kind: string
  readonly includeTimedOut: boolean
  readonly maxCandidatesPerSweep: number
  readonly maxAdmitsPerSweep: number
  readonly sweepIntervalMs: number
}

export interface NormalizedSettlement {
  readonly enabled: boolean
  readonly windowMs: number
  readonly sweepIntervalMs: number
  readonly maxSourcesPerSweep: number
  readonly maxPendingPerSweep: number
  readonly maxSettlementsPerSweep: number
}

export interface NormalizedSources {
  readonly foregroundFailures: NormalizedForegroundFailureSource
}

export interface NormalizedAdmission {
  readonly allowedKinds: readonly string[]
  readonly maxOpenItems: number
  readonly maxAdmitsPerHour: number
  readonly dedupWindowMs: number
  readonly cooldownMs: number
  readonly maxBriefBytes: number
}

export interface NormalizedLimits {
  readonly leaseMs: number
  readonly maxAttempts: number
  readonly maxReportsPerItem: number
  readonly maxReportBytes: number
  /**
   * Delay before a `waiting` item is handed to a fresh occurrence again.
   *
   * `waiting` is not terminal: the worker stopped without finishing, so the
   * item stays claimable. Re-arming is delayed rather than immediate so a
   * worker that reports `waiting` in a loop cannot spin up occurrences in the
   * same second, and it is bounded by the item's attempt budget.
   */
  readonly waitingResumeMs: number
}

const KIND = /^[a-z][a-z0-9-]{0,63}$/
const PRESET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const AUTOMATION_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}\/v[0-9]{1,3}$/
const SCOPE_KEYS = ['workspace', 'preset', 'principalId', 'ownerRouteId', 'expiresAt'] as const
const ADMISSION_KEYS = ['allowedKinds', 'maxOpenItems', 'maxAdmitsPerHour', 'dedupWindowMs', 'cooldownMs', 'maxBriefBytes'] as const
const LIMITS_KEYS = ['leaseMs', 'maxAttempts', 'maxReportsPerItem', 'maxReportBytes', 'waitingResumeMs'] as const
const DELIVERY_KEYS = ['notifyOn'] as const
const SETTLEMENT_KEYS = ['enabled', 'windowMs', 'sweepIntervalMs', 'maxSourcesPerSweep', 'maxPendingPerSweep', 'maxSettlementsPerSweep'] as const
const SOURCES_KEYS = ['foregroundFailures'] as const
const FOREGROUND_FAILURE_KEYS = ['enabled', 'kind', 'includeTimedOut', 'maxCandidatesPerSweep', 'maxAdmitsPerSweep', 'sweepIntervalMs'] as const
const TOP_LEVEL_KEYS = ['enabled', 'mode', 'databasePath', 'workRoot', 'intakeSourceId', 'workerAutomationId', 'scope', 'admission', 'limits', 'delivery', 'sources', 'settlement', 'diagnosis', 'ownerRecall', 'ownerReportRouting', 'ownerContinuation', 'ownerReplyContinuation', 'ownerReportFeedback', 'intakeLedger', 'follows', 'acceptance'] as const
const FOLLOWS_KEYS = ['eventTriggers'] as const
const FOLLOW_SOURCE_KEYS = ['enabled'] as const
const INTAKE_LEDGER_KEYS = ['enabled', 'sources', 'evaluation'] as const
const INTAKE_EVALUATION_KEYS = ['enabled', 'timeoutMs', 'maxConsecutiveFailures', 'maxPerRun', 'maxCallsPerHour', 'admit'] as const
const INTAKE_ADMIT_KEYS = ['enabled', 'mode', 'kind', 'originBindingId', 'maxPerHour'] as const
const BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/
const INTAKE_SOURCE_KEYS = ['unaddressedGroupMessages', 'unsubscribedEvents'] as const
const MAX_INTAKE_SOURCES = 32
const REPORT_STATUSES = ['progress', 'waiting', 'ready', 'blocked', 'failed'] as const
const NOTIFY_STATUSES = ['ready', 'blocked', 'failed'] as const

const scopeSchema = Schema.object({
  workspace: Schema.string().required(),
  preset: Schema.string().required(),
  principalId: Schema.string().required(),
  ownerRouteId: Schema.string().required(),
  expiresAt: Schema.number().step(1).required(),
})

const admissionSchema = Schema.object({
  allowedKinds: Schema.array(Schema.string()).default([]),
  maxOpenItems: Schema.number().step(1).min(1).max(100).default(8),
  maxAdmitsPerHour: Schema.number().step(1).min(1).max(100).default(4),
  dedupWindowMs: Schema.number().step(1).min(3_600_000).max(2_592_000_000).default(604_800_000),
  cooldownMs: Schema.number().step(1).min(0).max(86_400_000).default(600_000),
  maxBriefBytes: Schema.number().step(1).min(256).max(65_536).default(8_192),
})

const limitsSchema = Schema.object({
  leaseMs: Schema.number().step(1).min(30_000).max(86_400_000).default(900_000),
  maxAttempts: Schema.number().step(1).min(1).max(10).default(3),
  maxReportsPerItem: Schema.number().step(1).min(1).max(100).default(20),
  maxReportBytes: Schema.number().step(1).min(256).max(65_536).default(16_384),
  waitingResumeMs: Schema.number().step(1).min(60_000).max(3_600_000).default(300_000),
})

const deliverySchema = Schema.object({
  notifyOn: Schema.array(Schema.union(NOTIFY_STATUSES)).default([...NOTIFY_STATUSES]),
})

const settlementSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  windowMs: Schema.number().step(1).min(3_600_000).max(777_600_000).default(604_800_000),
  sweepIntervalMs: Schema.number().step(1).min(60_000).max(86_400_000).default(600_000),
  maxSourcesPerSweep: Schema.number().step(1).min(1).max(100).default(25),
  maxPendingPerSweep: Schema.number().step(1).min(1).max(50).default(10),
  maxSettlementsPerSweep: Schema.number().step(1).min(1).max(50).default(10),
})

const foregroundFailureSchema = Schema.object({
  enabled: Schema.boolean().default(false),
  kind: Schema.string().default('foreground-repair'),
  includeTimedOut: Schema.boolean().default(true),
  maxCandidatesPerSweep: Schema.number().step(1).min(1).max(100).default(10),
  maxAdmitsPerSweep: Schema.number().step(1).min(1).max(10).default(2),
  sweepIntervalMs: Schema.number().step(1).min(60_000).max(86_400_000).default(3_600_000),
})

const sourcesSchema = Schema.object({
  foregroundFailures: foregroundFailureSchema,
})

/** Synchronous Standard-Schema validator used by DSH before construction. */
export const ConfigSchema = Schema.object({
  enabled: Schema.boolean().default(false),
  mode: Schema.union(['observe', 'active'] as const).default('observe'),
  databasePath: Schema.string().required(),
  workRoot: Schema.string().required(),
  intakeSourceId: Schema.string().default('work-items/v1'),
  workerAutomationId: Schema.string(),
  // Object schemas default to {}; the union preserves an absent optional scope.
  scope: Schema.union([Schema.const(undefined), scopeSchema]),
  admission: admissionSchema,
  limits: limitsSchema,
  delivery: deliverySchema,
  sources: sourcesSchema,
  settlement: settlementSchema,
  ownerReplyContinuation: Schema.boolean().default(false),
  ownerReportFeedback: Schema.boolean().default(false),
  intakeLedger: Schema.object({
    enabled: Schema.boolean().default(false),
    sources: Schema.dict(Schema.object({
      unaddressedGroupMessages: Schema.boolean().default(false),
      unsubscribedEvents: Schema.boolean().default(false),
    })),
    evaluation: Schema.object({
      enabled: Schema.boolean().default(false),
      timeoutMs: Schema.number().step(1), maxConsecutiveFailures: Schema.number().step(1),
      maxPerRun: Schema.number().step(1), maxCallsPerHour: Schema.number().step(1),
      admit: Schema.object({
        enabled: Schema.boolean().default(false),
        mode: Schema.union(['observe', 'auto'] as const).default('observe'),
        kind: Schema.string(), originBindingId: Schema.string(), maxPerHour: Schema.number().step(1),
      }),
    }),
  }),
  follows: Schema.object({ eventTriggers: Schema.object({ enabled: Schema.boolean().default(false) }) }),
  acceptance: Schema.object({
    autoSettle: Schema.object({ enabled: Schema.boolean().default(false), maxPerTick: Schema.number().step(1) }),
    bindWorkerRun: Schema.object({ enabled: Schema.boolean().default(false), maxPerTick: Schema.number().step(1) }),
  }),
  ownerRecall: Schema.object({ enabled: Schema.boolean().default(false), linkedAliases: Schema.array(Schema.string()) }),
  ownerReportRouting: Schema.object({ linkedFallback: Schema.array(Schema.string()), prefer: Schema.union(['origin', 'recent'] as const) }),
  ownerContinuation: Schema.object({
    enabled: Schema.boolean().default(false), automationId: Schema.string(), allowedTools: Schema.array(Schema.string()),
    budgetId: Schema.string(), budgetAmount: Schema.number().step(1),
    maxModelCalls: Schema.number().step(1), maxToolCalls: Schema.number().step(1),
    maxOutputTokens: Schema.number().step(1), timeoutMs: Schema.number().step(1), expiresAt: Schema.number().step(1),
  }),
  diagnosis: Schema.object({
    enabled: Schema.boolean().default(false),
    budgetId: Schema.string(), budgetAmount: Schema.number().step(1),
    maxModelCalls: Schema.number().step(1), maxToolCalls: Schema.number().step(1),
    maxOutputTokens: Schema.number().step(1), timeoutMs: Schema.number().step(1), expiresAt: Schema.number().step(1),
  }),
}) as Schema<Config>

function fail(code: WorkItemErrorCode, message: string): never {
  throw new WorkItemError(code, message)
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-input', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('invalid-input', `${field} contains unknown field ${key}`)
  }
}

function assertAbsolute(value: string, field: string): string {
  if (!isAbsolute(value)) fail('invalid-input', `${field} must be an absolute path`)
  const normalized = resolve(value)
  if (normalized === resolve('/')) fail('invalid-input', `${field} must not be the filesystem root`)
  return normalized
}

/** Byte length under UTF-8 without allocating a Buffer for short values. */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** Normalize NFC, trim, reject empties and over-long text at a byte boundary. */
export function text(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string') fail('invalid-input', `${field} must be a string`)
  const normalized = value.normalize('NFC').trim()
  if (normalized.length === 0) fail('invalid-input', `${field} must not be empty`)
  if (byteLength(normalized) > maxBytes) fail('invalid-input', `${field} exceeds ${maxBytes} bytes`)
  return normalized
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (byteLength(value) <= maxBytes) return { value, truncated: false }
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (byteLength(value.slice(0, middle)) <= maxBytes) low = middle
    else high = middle - 1
  }
  let end = low
  // Never leave a dangling high surrogate at the cut point.
  const code = value.charCodeAt(end - 1)
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1
  return { value: value.slice(0, end), truncated: true }
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('invalid-input', `${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function normalizeScope(raw: ScopeConfig | undefined, now: number, historicalFeedback = false): WorkItemScope | null {
  if (raw === undefined) return null
  const scope = plainObject(raw, 'scope')
  rejectUnknown(scope, SCOPE_KEYS, 'scope')
  const normalized: WorkItemScope = {
    workspace: assertAbsolute(text(scope['workspace'], 'scope.workspace', 4_096), 'scope.workspace'),
    preset: text(scope['preset'], 'scope.preset', 128),
    principalId: text(scope['principalId'], 'scope.principalId', 256),
    ownerRouteId: text(scope['ownerRouteId'], 'scope.ownerRouteId', 256),
    expiresAt: integer(scope['expiresAt'], 'scope.expiresAt', 1, Number.MAX_SAFE_INTEGER),
  }
  if (!PRESET.test(normalized.preset)) fail('invalid-input', 'scope.preset has an invalid shape')
  if (!historicalFeedback && normalized.expiresAt <= now) fail('invalid-input', 'scope.expiresAt must be in the future')
  return Object.freeze(normalized)
}

function normalizeAdmission(raw: AdmissionConfig | undefined, mode: 'observe' | 'active'): NormalizedAdmission {
  const value = raw === undefined ? {} : plainObject(raw, 'admission')
  rejectUnknown(value, ADMISSION_KEYS, 'admission')
  const allowedKinds = (value['allowedKinds'] ?? []) as unknown
  if (!Array.isArray(allowedKinds)) fail('invalid-input', 'admission.allowedKinds must be an array')
  const kinds = allowedKinds.map(entry => text(entry, 'admission.allowedKinds[]', 64))
  for (const kind of kinds) if (!KIND.test(kind)) fail('invalid-input', `admission.allowedKinds entry ${kind} has an invalid shape`)
  if (new Set(kinds).size !== kinds.length) fail('invalid-input', 'admission.allowedKinds must not repeat an entry')
  const normalized: NormalizedAdmission = Object.freeze({
    allowedKinds: Object.freeze(kinds),
    maxOpenItems: integer(value['maxOpenItems'] ?? 8, 'admission.maxOpenItems', 1, 100),
    maxAdmitsPerHour: integer(value['maxAdmitsPerHour'] ?? 4, 'admission.maxAdmitsPerHour', 1, 100),
    dedupWindowMs: integer(value['dedupWindowMs'] ?? 604_800_000, 'admission.dedupWindowMs', 3_600_000, 2_592_000_000),
    cooldownMs: integer(value['cooldownMs'] ?? 600_000, 'admission.cooldownMs', 0, 86_400_000),
    maxBriefBytes: integer(value['maxBriefBytes'] ?? 8_192, 'admission.maxBriefBytes', 256, 65_536),
  })
  if (mode === 'active' && kinds.length === 0) {
    fail('kind-rejected', 'an active work-item intake requires at least one admission.allowedKinds entry')
  }
  return normalized
}

function normalizeLimits(raw: LimitsConfig | undefined): NormalizedLimits {
  const value = raw === undefined ? {} : plainObject(raw, 'limits')
  rejectUnknown(value, LIMITS_KEYS, 'limits')
  return Object.freeze({
    leaseMs: integer(value['leaseMs'] ?? 900_000, 'limits.leaseMs', 30_000, 86_400_000),
    maxAttempts: integer(value['maxAttempts'] ?? 3, 'limits.maxAttempts', 1, 10),
    maxReportsPerItem: integer(value['maxReportsPerItem'] ?? 20, 'limits.maxReportsPerItem', 1, 100),
    maxReportBytes: integer(value['maxReportBytes'] ?? 16_384, 'limits.maxReportBytes', 256, 65_536),
    waitingResumeMs: integer(value['waitingResumeMs'] ?? 300_000, 'limits.waitingResumeMs', 60_000, 3_600_000),
  })
}

function normalizeDelivery(raw: DeliveryConfig | undefined): readonly WorkItemReportStatus[] {
  const value = raw === undefined ? {} : plainObject(raw, 'delivery')
  rejectUnknown(value, DELIVERY_KEYS, 'delivery')
  const notifyOn = (value['notifyOn'] ?? [...NOTIFY_STATUSES]) as unknown
  if (!Array.isArray(notifyOn) || notifyOn.length === 0) fail('invalid-input', 'delivery.notifyOn must be a non-empty array')
  const statuses = notifyOn.map(entry => {
    if (typeof entry !== 'string' || !(NOTIFY_STATUSES as readonly string[]).includes(entry)) {
      fail('invalid-input', `delivery.notifyOn entry ${String(entry)} is not a notifiable status`)
    }
    return entry as WorkItemReportStatus
  })
  if (new Set(statuses).size !== statuses.length) fail('invalid-input', 'delivery.notifyOn must not repeat an entry')
  return Object.freeze(statuses)
}

function normalizeSources(raw: SourcesConfig | undefined): NormalizedSources {
  const value = raw === undefined ? {} : plainObject(raw, 'sources')
  rejectUnknown(value, SOURCES_KEYS, 'sources')
  const foreground = value['foregroundFailures'] === undefined
    ? {}
    : plainObject(value['foregroundFailures'], 'sources.foregroundFailures')
  rejectUnknown(foreground, FOREGROUND_FAILURE_KEYS, 'sources.foregroundFailures')
  const enabled = foreground['enabled'] ?? false
  if (typeof enabled !== 'boolean') fail('invalid-input', 'sources.foregroundFailures.enabled must be a boolean')
  const kind = text(foreground['kind'] ?? 'foreground-repair', 'sources.foregroundFailures.kind', 64)
  if (!KIND.test(kind)) fail('invalid-input', 'sources.foregroundFailures.kind has an invalid shape')
  const includeTimedOut = foreground['includeTimedOut'] ?? true
  if (typeof includeTimedOut !== 'boolean') fail('invalid-input', 'sources.foregroundFailures.includeTimedOut must be a boolean')
  return Object.freeze({
    foregroundFailures: Object.freeze({
      enabled,
      kind,
      includeTimedOut,
      maxCandidatesPerSweep: integer(foreground['maxCandidatesPerSweep'] ?? 10, 'sources.foregroundFailures.maxCandidatesPerSweep', 1, 100),
      maxAdmitsPerSweep: integer(foreground['maxAdmitsPerSweep'] ?? 2, 'sources.foregroundFailures.maxAdmitsPerSweep', 1, 10),
      sweepIntervalMs: integer(foreground['sweepIntervalMs'] ?? 3_600_000, 'sources.foregroundFailures.sweepIntervalMs', 60_000, 86_400_000),
    }),
  })
}

function normalizeSettlement(raw: SettlementConfig | undefined): NormalizedSettlement {
  const value = raw === undefined ? {} : plainObject(raw, 'settlement')
  rejectUnknown(value, SETTLEMENT_KEYS, 'settlement')
  const enabled = value['enabled'] ?? true
  if (typeof enabled !== 'boolean') fail('invalid-input', 'settlement.enabled must be a boolean')
  return Object.freeze({
    enabled,
    windowMs: integer(value['windowMs'] ?? 604_800_000, 'settlement.windowMs', 3_600_000, 777_600_000),
    sweepIntervalMs: integer(value['sweepIntervalMs'] ?? 600_000, 'settlement.sweepIntervalMs', 60_000, 86_400_000),
    maxSourcesPerSweep: integer(value['maxSourcesPerSweep'] ?? 25, 'settlement.maxSourcesPerSweep', 1, 100),
    maxPendingPerSweep: integer(value['maxPendingPerSweep'] ?? 10, 'settlement.maxPendingPerSweep', 1, 50),
    maxSettlementsPerSweep: integer(value['maxSettlementsPerSweep'] ?? 10, 'settlement.maxSettlementsPerSweep', 1, 50),
  })
}

function normalizeDiagnosis(raw: DiagnosisConfig | undefined, scope: WorkItemScope | null, now: number, historicalFeedback = false): NormalizedDiagnosis | undefined {
  if (raw === undefined) return undefined
  const value = plainObject(raw, 'diagnosis')
  rejectUnknown(value, ['enabled', 'budgetId', 'budgetAmount', 'maxModelCalls', 'maxToolCalls', 'maxOutputTokens', 'timeoutMs', 'expiresAt'], 'diagnosis')
  if (value['enabled'] === undefined || value['enabled'] === false) return undefined
  if (value['enabled'] !== true) fail('invalid-input', 'diagnosis.enabled must be a boolean')
  if (scope === null) fail('invalid-input', 'diagnosis requires an explicit owner scope')
  const expiresAt = integer(value['expiresAt'], 'diagnosis.expiresAt', 1, Number.MAX_SAFE_INTEGER)
  if ((!historicalFeedback && expiresAt <= now) || expiresAt > scope.expiresAt) fail('invalid-input', 'diagnosis expiry must be future and no later than the owner scope')
  return Object.freeze({ enabled: true, budgetId: text(value['budgetId'], 'diagnosis.budgetId', 200),
    budgetAmount: integer(value['budgetAmount'], 'diagnosis.budgetAmount', 1, 10_000_000),
    maxModelCalls: integer(value['maxModelCalls'], 'diagnosis.maxModelCalls', 1, 100),
    maxToolCalls: integer(value['maxToolCalls'], 'diagnosis.maxToolCalls', 1, 1000),
    maxOutputTokens: integer(value['maxOutputTokens'], 'diagnosis.maxOutputTokens', 1, 131072),
    timeoutMs: integer(value['timeoutMs'], 'diagnosis.timeoutMs', 1000, 300000), expiresAt })
}

/** True when at least one automatic signal source is armed. */
export function anySourceEnabled(config: NormalizedConfig): boolean {
  return config.sources.foregroundFailures.enabled
}

/**
 * Validate and default operator configuration synchronously.
 *
 * Unknown fields anywhere fail closed, paths must be absolute, and an
 * `enabled: true` + `mode: 'active'` deployment must name its worker
 * automation, owner scope and at least one admitted kind. The default
 * deployment is `enabled: false`, `mode: 'observe'`: it writes only local
 * observation rows and never calls automations or delivery.
 */
export function normalizeConfig(raw: Config, now = Date.now()): NormalizedConfig {
  const value = plainObject(raw, 'config')
  rejectUnknown(value, TOP_LEVEL_KEYS, 'config')
  const ownerReportFeedback = value['ownerReportFeedback']
  if (ownerReportFeedback !== undefined && typeof ownerReportFeedback !== 'boolean') fail('invalid-input', 'ownerReportFeedback must be a boolean')
  const enabled = value['enabled'] ?? false
  if (typeof enabled !== 'boolean') fail('invalid-input', 'enabled must be a boolean')
  const mode = value['mode'] ?? 'observe'
  if (mode !== 'observe' && mode !== 'active') fail('invalid-input', "mode must be 'observe' or 'active'")
  const databasePath = assertAbsolute(text(value['databasePath'], 'databasePath', 4_096), 'databasePath')
  const workRoot = assertAbsolute(text(value['workRoot'], 'workRoot', 4_096), 'workRoot')
  if (databasePath === workRoot) fail('invalid-input', 'databasePath and workRoot must differ')
  if (workRoot.startsWith(`${databasePath}/`)) fail('invalid-input', 'databasePath must not contain workRoot')
  const intakeSourceId = text(value['intakeSourceId'] ?? 'work-items/v1', 'intakeSourceId', 128)
  if (!SOURCE_ID.test(intakeSourceId)) fail('invalid-input', 'intakeSourceId must look like <source>/v<number>')
  const rawAutomationId = value['workerAutomationId']
  const workerAutomationId = rawAutomationId === undefined ? null : text(rawAutomationId, 'workerAutomationId', 128)
  if (workerAutomationId !== null && !AUTOMATION_ID.test(workerAutomationId)) {
    fail('invalid-input', 'workerAutomationId has an invalid shape')
  }
  const scope = normalizeScope(value['scope'] as ScopeConfig | undefined, now, ownerReportFeedback === true)
  const admission = normalizeAdmission(value['admission'] as AdmissionConfig | undefined, mode)
  const limits = normalizeLimits(value['limits'] as LimitsConfig | undefined)
  const notifyOn = normalizeDelivery(value['delivery'] as DeliveryConfig | undefined)
  const sources = normalizeSources(value['sources'] as SourcesConfig | undefined)
  const settlement = normalizeSettlement(value['settlement'] as SettlementConfig | undefined)
  const diagnosis = normalizeDiagnosis(value['diagnosis'] as DiagnosisConfig | undefined, scope, now, ownerReportFeedback === true)
  if (diagnosis && (!enabled || mode !== 'active' || !sources.foregroundFailures.enabled)) fail('invalid-input', 'diagnosis requires active enabled intake and foreground failure source')
  if (enabled && mode === 'active' && (workerAutomationId === null || scope === null)) {
    fail('invalid-input', "an active work-item deployment requires workerAutomationId and scope")
  }
  if (enabled && mode === 'active' && sources.foregroundFailures.enabled && !admission.allowedKinds.includes(sources.foregroundFailures.kind)) {
    fail('invalid-input', 'sources.foregroundFailures.kind must be one of admission.allowedKinds')
  }
  const ownerRecall = value['ownerRecall'] === undefined ? {} : plainObject(value['ownerRecall'], 'ownerRecall')
  rejectUnknown(ownerRecall, ['enabled', 'linkedAliases'], 'ownerRecall')
  if (ownerRecall['enabled'] !== undefined && typeof ownerRecall['enabled'] !== 'boolean') fail('invalid-input', 'ownerRecall.enabled must be a boolean')
  if (ownerRecall['enabled'] === true && (!enabled || mode !== 'active' || scope === null || workerAutomationId === null)) {
    fail('invalid-input', 'ownerRecall requires an enabled active worker and complete scope')
  }
  const linkedAliases = normalizeLinkedAliases(ownerRecall['linkedAliases'], ownerRecall['enabled'] === true, scope)
  const ownerReportRouting = value['ownerReportRouting'] === undefined ? {} : plainObject(value['ownerReportRouting'], 'ownerReportRouting')
  rejectUnknown(ownerReportRouting, ['linkedFallback', 'prefer'], 'ownerReportRouting')
  const linkedFallback = normalizeLinkedAliases(ownerReportRouting['linkedFallback'],
    enabled && mode === 'active' && scope !== null && workerAutomationId !== null, scope, 'ownerReportRouting.linkedFallback',
    'an enabled active worker and complete scope')
  const reportPrefer = ownerReportRouting['prefer']
  if (reportPrefer !== undefined && reportPrefer !== 'origin' && reportPrefer !== 'recent') fail('invalid-input', "ownerReportRouting.prefer must be 'origin' or 'recent'")
  if (reportPrefer === 'recent' && linkedFallback === undefined) fail('invalid-input', "ownerReportRouting.prefer 'recent' requires a non-empty linkedFallback")
  const ownerContinuation = normalizeOwnerContinuation(value['ownerContinuation'], scope, workerAutomationId, now, ownerReportFeedback === true)
  if (ownerContinuation && !admission.allowedKinds.includes('owner-continuation')) fail('invalid-input', 'ownerContinuation requires owner-continuation in admission.allowedKinds')
  if (ownerContinuation && (!enabled || mode !== 'active' || ownerRecall['enabled'] !== true)) {
    fail('invalid-input', 'ownerContinuation requires active intake and ownerRecall')
  }
  if (ownerReportFeedback === true && !ownerContinuation) fail('invalid-input', 'ownerReportFeedback requires configured ownerContinuation')
  const ownerReplyContinuation = value['ownerReplyContinuation']
  if (ownerReplyContinuation !== undefined && typeof ownerReplyContinuation !== 'boolean') fail('invalid-input', 'ownerReplyContinuation must be a boolean')
  if (ownerReplyContinuation === true && !ownerContinuation) fail('invalid-input', 'ownerReplyContinuation requires active ownerContinuation authorization')
  const intakeLedger = normalizeIntakeLedger(value['intakeLedger'])
  const intakeAdmit = intakeLedger?.evaluation?.admit
  if (intakeAdmit?.mode === 'auto') {
    if (!enabled || mode !== 'active' || diagnosis) fail('invalid-input', 'intakeLedger.evaluation.admit auto mode requires an enabled active intake without diagnosis')
    if (!admission.allowedKinds.includes(intakeAdmit.kind)) fail('invalid-input', 'intakeLedger.evaluation.admit.kind must be one of admission.allowedKinds')
  }
  const follows = normalizeFollows(value['follows'])
  if (follows?.eventTriggers === true && (!enabled || scope === null)) fail('invalid-input', 'follows.eventTriggers requires an enabled intake with an owner scope')
  const acceptance = normalizeAcceptance(value['acceptance'])
  const acceptanceAutoSettle = acceptance.autoSettle
  if (acceptanceAutoSettle && (!enabled || mode !== 'active')) fail('invalid-input', 'acceptance.autoSettle requires an enabled active intake')
  const acceptanceBindWorkerRun = acceptance.bindWorkerRun
  if (acceptanceBindWorkerRun && (!enabled || mode !== 'active')) fail('invalid-input', 'acceptance.bindWorkerRun requires an enabled active intake')
  return Object.freeze({
    enabled,
    mode,
    databasePath,
    workRoot,
    intakeSourceId,
    workerAutomationId,
    scope,
    admission,
    limits,
    notifyOn,
    sources,
    settlement,
    ...(diagnosis === undefined ? {} : { diagnosis }),
    ...(ownerRecall['enabled'] === true ? { ownerRecall: Object.freeze({ enabled: true as const, ...(linkedAliases ? { linkedAliases } : {}) }) } : {}),
    ...(linkedFallback === undefined ? {} : { ownerReportRouting: Object.freeze({ linkedFallback, ...(reportPrefer === 'recent' ? { prefer: 'recent' as const } : {}) }) }),
    ...(ownerContinuation === undefined ? {} : { ownerContinuation }),
    ...(ownerReplyContinuation === true ? { ownerReplyContinuation: true as const } : {}),
    ...(ownerReportFeedback === true ? { ownerReportFeedback: true as const } : {}),
    ...(intakeLedger === undefined ? {} : { intakeLedger }),
    ...(follows === undefined ? {} : { follows }),
    ...(acceptanceAutoSettle === undefined ? {} : { acceptanceAutoSettle }),
    ...(acceptanceBindWorkerRun === undefined ? {} : { acceptanceBindWorkerRun }),
  })
}

/** Absent or disabled acceptance passes normalize to `undefined`. */
function normalizeAcceptance(raw: unknown): Readonly<{ autoSettle?: Readonly<{ maxPerTick: number }>; bindWorkerRun?: Readonly<{ maxPerTick: number }> }> {
  if (raw === undefined) return {}
  const value = plainObject(raw, 'acceptance')
  rejectUnknown(value, ['autoSettle', 'bindWorkerRun'], 'acceptance')
  const pass = (key: 'autoSettle' | 'bindWorkerRun'): Readonly<{ maxPerTick: number }> | undefined => {
    if (value[key] === undefined) return undefined
    const section = plainObject(value[key], `acceptance.${key}`)
    rejectUnknown(section, ['enabled', 'maxPerTick'], `acceptance.${key}`)
    const enabled = section['enabled'] ?? false
    if (typeof enabled !== 'boolean') fail('invalid-input', `acceptance.${key}.enabled must be a boolean`)
    if (!enabled) return undefined
    return Object.freeze({ maxPerTick: integer(section['maxPerTick'] ?? 5, `acceptance.${key}.maxPerTick`, 1, 10) })
  }
  const autoSettle = pass('autoSettle'), bindWorkerRun = pass('bindWorkerRun')
  return { ...(autoSettle === undefined ? {} : { autoSettle }), ...(bindWorkerRun === undefined ? {} : { bindWorkerRun }) }
}

/** Absent or all-disabled follow sources normalize to `undefined`. */
function normalizeFollows(raw: unknown): NormalizedFollows | undefined {
  if (raw === undefined) return undefined
  const value = plainObject(raw, 'follows')
  rejectUnknown(value, FOLLOWS_KEYS, 'follows')
  const source = value['eventTriggers'] === undefined ? {} : plainObject(value['eventTriggers'], 'follows.eventTriggers')
  rejectUnknown(source, FOLLOW_SOURCE_KEYS, 'follows.eventTriggers')
  const eventTriggers = source['enabled'] ?? false
  if (typeof eventTriggers !== 'boolean') fail('invalid-input', 'follows.eventTriggers.enabled must be a boolean')
  return eventTriggers ? Object.freeze({ eventTriggers }) : undefined
}

/** Absent or disabled ledgers normalize to `undefined`; opt-ins default off. */
function normalizeIntakeLedger(raw: unknown): NormalizedIntakeLedger | undefined {
  if (raw === undefined) return undefined
  const value = plainObject(raw, 'intakeLedger')
  rejectUnknown(value, INTAKE_LEDGER_KEYS, 'intakeLedger')
  const enabled = value['enabled'] ?? false
  if (typeof enabled !== 'boolean') fail('invalid-input', 'intakeLedger.enabled must be a boolean')
  const rawSources = value['sources'] === undefined ? {} : plainObject(value['sources'], 'intakeLedger.sources')
  const ids = Object.keys(rawSources)
  if (ids.length > MAX_INTAKE_SOURCES) fail('invalid-input', `intakeLedger.sources accepts at most ${MAX_INTAKE_SOURCES} sources`)
  const sources: Record<string, WorkItemIntakeSourcePolicy> = Object.create(null) as Record<string, WorkItemIntakeSourcePolicy>
  for (const id of ids.sort()) {
    if (!INTAKE_SOURCE_ID.test(id)) fail('invalid-input', 'intakeLedger.sources keys must be lowercase source ids')
    const entry = plainObject(rawSources[id], `intakeLedger.sources.${id}`)
    rejectUnknown(entry, INTAKE_SOURCE_KEYS, `intakeLedger.sources.${id}`)
    const policy: Record<string, boolean> = {}
    for (const key of INTAKE_SOURCE_KEYS) {
      const flag = entry[key] ?? false
      if (typeof flag !== 'boolean') fail('invalid-input', `intakeLedger.sources.${id}.${key} must be a boolean`)
      policy[key] = flag
    }
    sources[id] = Object.freeze(policy as unknown as WorkItemIntakeSourcePolicy)
  }
  const evaluation = normalizeIntakeEvaluation(value['evaluation'])
  if (!enabled) return undefined
  return Object.freeze({ enabled: true as const, sources: Object.freeze(sources), ...(evaluation === undefined ? {} : { evaluation }) })
}

/** Absent or disabled evaluation normalizes to `undefined`; limits default small. */
function normalizeIntakeEvaluation(raw: unknown): NormalizedIntakeEvaluation | undefined {
  if (raw === undefined) return undefined
  const value = plainObject(raw, 'intakeLedger.evaluation')
  rejectUnknown(value, INTAKE_EVALUATION_KEYS, 'intakeLedger.evaluation')
  const enabled = value['enabled'] ?? false
  if (typeof enabled !== 'boolean') fail('invalid-input', 'intakeLedger.evaluation.enabled must be a boolean')
  const normalized = Object.freeze({
    enabled: true as const,
    timeoutMs: integer(value['timeoutMs'] ?? 30_000, 'intakeLedger.evaluation.timeoutMs', 100, 600_000),
    maxConsecutiveFailures: integer(value['maxConsecutiveFailures'] ?? 3, 'intakeLedger.evaluation.maxConsecutiveFailures', 1, 10),
    maxPerRun: integer(value['maxPerRun'] ?? 5, 'intakeLedger.evaluation.maxPerRun', 1, 50),
    maxCallsPerHour: integer(value['maxCallsPerHour'] ?? 20, 'intakeLedger.evaluation.maxCallsPerHour', 1, 1_000),
  })
  const admit = normalizeIntakeAdmit(value['admit'])
  if (!enabled) return undefined
  return admit === undefined ? normalized : Object.freeze({ ...normalized, admit })
}

/** Absent or disabled admission normalizes to `undefined`; enabled needs a kind and binding. */
function normalizeIntakeAdmit(raw: unknown): NormalizedIntakeAdmit | undefined {
  if (raw === undefined) return undefined
  const value = plainObject(raw, 'intakeLedger.evaluation.admit')
  rejectUnknown(value, INTAKE_ADMIT_KEYS, 'intakeLedger.evaluation.admit')
  const enabled = value['enabled'] ?? false
  if (typeof enabled !== 'boolean') fail('invalid-input', 'intakeLedger.evaluation.admit.enabled must be a boolean')
  if (!enabled) return undefined
  const mode = value['mode'] ?? 'observe'
  if (mode !== 'observe' && mode !== 'auto') fail('invalid-input', "intakeLedger.evaluation.admit.mode must be 'observe' or 'auto'")
  const kind = text(value['kind'] ?? 'intake-inferred', 'intakeLedger.evaluation.admit.kind', 64)
  if (!KIND.test(kind)) fail('invalid-input', 'intakeLedger.evaluation.admit.kind has an invalid shape')
  const originBindingId = text(value['originBindingId'], 'intakeLedger.evaluation.admit.originBindingId', 256)
  if (!BINDING_ID.test(originBindingId)) fail('invalid-input', 'intakeLedger.evaluation.admit.originBindingId has an invalid shape')
  return Object.freeze({
    enabled: true as const, mode, kind, originBindingId,
    maxPerHour: integer(value['maxPerHour'] ?? 5, 'intakeLedger.evaluation.admit.maxPerHour', 1, 100),
  })
}

/** Maximum explicitly allowlisted linked aliases per owner scope. */
export const MAX_LINKED_ALIASES = 8

/**
 * Canonical Delivery external principal id: four `encodeURIComponent`-encoded
 * components (`channel/account/tenant/user`) of Delivery's key alphabet
 * `[A-Za-z0-9][A-Za-z0-9._@/-]*`, so only `%40` and `%2F` escapes occur.
 * Mirrors assistant-delivery `externalPrincipalId`; anything else (Unicode,
 * NFD/compatibility variants, whitespace, lower-case escapes) can never equal
 * a Delivery receipt and is rejected rather than silently never matching.
 */
const DELIVERY_PRINCIPAL_COMPONENT = String.raw`[A-Za-z0-9](?:[A-Za-z0-9._-]|%40|%2F)*`
const DELIVERY_PRINCIPAL_ID = new RegExp(`^${DELIVERY_PRINCIPAL_COMPONENT}(?:/${DELIVERY_PRINCIPAL_COMPONENT}){3}$`, 'u')

/**
 * Normalize the owner's explicit linked-alias allowlist.
 *
 * An alias read is a cross-channel identity decision, so it must be named
 * here rather than inherited from a Delivery link plus a Policy rule that
 * happens not to match on `principal`. Entries are exact Delivery principal
 * ids, unique, bounded, and never the root owner itself.
 */
function normalizeLinkedAliases(raw: unknown, recallEnabled: boolean, scope: WorkItemScope | null,
  field = 'ownerRecall.linkedAliases', requirement = 'ownerRecall.enabled'): readonly string[] | undefined {
  // Schema defaults materialize an empty array; only a non-empty list is a choice.
  if (raw === undefined || Array.isArray(raw) && raw.length === 0) return undefined
  if (!recallEnabled) fail('invalid-input', `${field} requires ${requirement}`)
  if (!Array.isArray(raw) || raw.length > MAX_LINKED_ALIASES) fail('invalid-input', `${field} must be an array of at most ${MAX_LINKED_ALIASES} principal ids`)
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length > 256 || !DELIVERY_PRINCIPAL_ID.test(entry)) {
      fail('invalid-input', `${field} entries must be canonical Delivery principal ids (channel/account/tenant/user)`)
    }
    if (entry === scope?.principalId) fail('invalid-input', `${field} must not contain the owner principal`)
    if (seen.has(entry)) fail('invalid-input', `${field} must not contain duplicates`)
    seen.add(entry)
  }
  return seen.size === 0 ? undefined : Object.freeze([...seen])
}

function normalizeOwnerContinuation(raw: unknown, scope: WorkItemScope | null, workerId: string | null, now: number, historicalFeedback = false): NormalizedOwnerContinuation | undefined {
  if (raw === undefined) return undefined
  const value = plainObject(raw, 'ownerContinuation')
  const { automationId, allowedTools, ...limits } = value
  const budget = normalizeDiagnosis(limits as DiagnosisConfig, scope, now, historicalFeedback)
  if (!budget) {
    if (automationId !== undefined || allowedTools !== undefined && (!Array.isArray(allowedTools) || allowedTools.length !== 0)) fail('invalid-input', 'disabled ownerContinuation cannot carry execution settings')
    return undefined
  }
  const id = text(automationId, 'ownerContinuation.automationId', 128)
  if (!AUTOMATION_ID.test(id) || id === workerId) fail('invalid-input', 'ownerContinuation requires a distinct automationId')
  if (!Array.isArray(allowedTools) || allowedTools.length < 3 || allowedTools.length > 64) fail('invalid-input', 'ownerContinuation requires a bounded explicit tool list')
  const tools = allowedTools.map(value => text(value, 'ownerContinuation.allowedTools', 128))
  if (new Set(tools).size !== tools.length || tools.some(name => !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(name)
    || ['work_item_continue', 'work_item_list', 'work_item_recall', 'work_item_read_source'].includes(name))
    || ['work_item_claim', 'work_item_report', 'work_item_read_context'].some(name => !tools.includes(name))) {
    fail('invalid-input', 'continuation tools require claim/report/context and cannot include foreground or diagnosis capabilities')
  }
  return Object.freeze({ ...budget, automationId: id, allowedTools: Object.freeze(tools.sort()) })
}

/** True only when external admission and dispatch may happen. */
export function isActive(config: NormalizedConfig): boolean {
  return config.enabled && config.mode === 'active'
}

/** Prove the config exposes only known report statuses (used by tests). */
export function knownReportStatuses(): readonly WorkItemReportStatus[] {
  return REPORT_STATUSES
}
