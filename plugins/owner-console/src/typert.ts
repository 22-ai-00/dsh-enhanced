import { z } from 'zod'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'

const codec = <T>(typeSymbol: string, create: () => z.ZodType<T>) => ({ mode: 'strict' as const, typeSymbol, create })

const dependency = z.object({ name: z.string().min(1), available: z.boolean() }).readonly()
const bundleError = z.object({ code: z.string().min(1).max(64), diagnostic: z.string().max(2_048).optional() }).readonly()
const bundleRow = z.object({
  rowId: z.string().min(1).max(200),
  moduleName: z.string().min(1).max(200),
  entryId: z.string().min(1).max(200).optional(),
}).readonly()
const bundle = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  enabled: z.boolean(),
  installed: z.boolean(),
  removable: z.boolean(),
  error: bundleError.optional(),
  rows: z.array(bundleRow).max(32).readonly(),
}).readonly()
const plugin = z.object({
  entryId: z.string().min(1),
  moduleName: z.string().min(1),
  enabled: z.boolean(),
  fiberPhase: z.enum(['pending', 'loading', 'active', 'failed', 'unloading']).nullable(),
  diagnostic: z.string().max(4_096).optional(),
}).readonly()
/** `ok` read succeeds; `unavailable` means the Host service is absent; `failed` means the read rejected. */
const readPhase = z.enum(['ok', 'unavailable', 'failed'])
const host = z.object({
  settings: z.boolean(),
  pluginManager: z.boolean(),
  bundles: readPhase,
  plugins: readPhase,
  diagnostic: z.string().max(1_024).optional(),
}).readonly()
/** `absent`: no larkChannel service; `unknown`: it exists but gave no valid health. */
export const LARK_CONNECTIONS = ['absent', 'unknown', 'connected', 'connected-with-gap', 'connecting',
  'disabled', 'disconnected', 'reconnecting'] as const
export const LARK_ERROR_CODES = ['format_error', 'not_connected', 'permission_denied', 'rate_limited',
  'send_timeout', 'ssrf_blocked', 'target_revoked', 'unknown', 'upload_failed'] as const
/**
 * Scope-free availability of the intake agreement read. `absent`: no Evaluation service;
 * `unknown`: it exists but the read or its switch cannot be determined; `disabled`:
 * `intakeAttentionAgreementEnabled` is off; `available`: the switch is on. No scope or count.
 */
export const INTAKE_AGREEMENT_AVAILABILITY = ['absent', 'unknown', 'disabled', 'available'] as const
export type IntakeAgreementAvailability = typeof INTAKE_AGREEMENT_AVAILABILITY[number]
export const OwnerConsoleStatusSchema = z.object({
  feishu: z.object({
    entry: z.string().min(1).optional(),
    mode: z.enum(['env', 'handle']),
    installed: z.boolean(),
    enabled: z.boolean(),
    appIdConfigured: z.boolean(),
    connected: z.boolean(),
    connection: z.enum(LARK_CONNECTIONS),
    lastErrorCode: z.enum(LARK_ERROR_CODES).optional(),
  }).readonly(),
  traex: z.object({ entry: z.string().min(1).optional(), installed: z.boolean(), enabled: z.boolean(), command: z.string() }).readonly(),
  host,
  dependencies: z.array(dependency).readonly(),
  evaluation: z.object({ intakeAgreement: z.enum(INTAKE_AGREEMENT_AVAILABILITY) }).readonly(),
  bundles: z.array(bundle).readonly(),
  plugins: z.array(plugin).readonly(),
}).readonly()
export type OwnerConsoleStatus = Readonly<z.infer<typeof OwnerConsoleStatusSchema>>

/** `pendingBuilds` names dependency build scripts the Host recorded and a confirmed retry may approve. */
export const WRITE_RESULT = z.object({
  applied: z.boolean(),
  entry: z.string(),
  note: z.string(),
  pendingBuilds: z.array(z.string().min(1).max(200)).max(64).readonly().optional(),
}).readonly()
export type OwnerConsoleWriteResult = Readonly<z.infer<typeof WRITE_RESULT>>

/** Bounds of the read-only trend snapshot page; the control plane enforces the same page limit. */
export const TREND_SNAPSHOT_PAGE_MAX = 100
const DIGEST = z.string().regex(/^[a-f0-9]{64}$/u)
const PLAN_ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u)
const label = z.string().min(1).max(200)
const count = z.number().int().nonnegative()
export const TREND_FLAGS = ['parallel-trend-suspect', 'no-control-cohort', 'concurrent-adoptions', 'partial-window',
  'adoption-not-active'] as const
const trendModel = z.union([
  z.object({ state: z.literal('frozen'), provider: label, model: label, reasoningEffort: label.optional() }).readonly(),
  z.object({ state: z.enum(['missing', 'inconsistent']) }).readonly(),
])
const trendStratum = z.object({
  model: trendModel,
  differenceInDifferences: z.union([
    z.object({ status: z.literal('estimated'), estimate: z.number(), low: z.number(), high: z.number() }).readonly(),
    z.object({ status: z.literal('insufficient') }).readonly(),
  ]),
  parallelTrend: z.enum(['not-flagged', 'parallel-trend-suspect', 'untestable']),
}).readonly()
const trendSnapshotItem = z.object({
  sequence: z.number().int().positive(),
  sealedAt: z.number().int().positive(),
  planId: PLAN_ID,
  digest: DIGEST,
  inputsDigest: DIGEST,
  trendDigest: DIGEST,
  window: z.object({ windowMs: z.number().int().positive(), preWindows: count, postWindows: count,
    startExclusive: z.number().int(), endInclusive: z.number().int(), complete: z.boolean() }).readonly(),
  cohorts: z.object({ treatedSessions: count, controlSessions: count }).readonly(),
  flags: z.array(z.enum(TREND_FLAGS)).max(TREND_FLAGS.length).readonly(),
  strata: z.array(trendStratum).max(64).readonly(),
}).readonly()
/**
 * `absent`: no control plane service; `unverifiable`: it refused the query or a sealed row failed its digest check.
 * Observational only: `causal` is always false and nothing here adopts, promotes or revokes.
 */
export const OwnerConsoleTrendSnapshotsSchema = z.object({
  state: z.enum(['absent', 'unverifiable', 'ok']),
  causal: z.literal(false),
  items: z.array(trendSnapshotItem).max(TREND_SNAPSHOT_PAGE_MAX).readonly(),
  nextBeforeSequence: z.number().int().positive().optional(),
}).readonly()
export type OwnerConsoleTrendSnapshots = Readonly<z.infer<typeof OwnerConsoleTrendSnapshotsSchema>>
export type OwnerConsoleTrendSnapshotItem = OwnerConsoleTrendSnapshots['items'][number]

/** Notification outcomes and intake levels as Evaluation's intake attention agreement reports them. */
export const INTAKE_AGREEMENT_OUTCOMES = ['pending', 'delivered', 'reacted', 'accepted', 'rejected', 'expired-unhandled', 'failed'] as const
export const INTAKE_AGREEMENT_LEVELS = ['ignore', 'digest', 'notify', 'accept'] as const
const intakeAgreementCell = z.object({
  notifications: count,
  items: count,
  outcomes: z.object(Object.fromEntries(INTAKE_AGREEMENT_OUTCOMES.map(outcome => [outcome, count])) as
    Record<typeof INTAKE_AGREEMENT_OUTCOMES[number], typeof count>).readonly(),
  agreed: count,
  disagreed: count,
  agreementPpm: z.number().int().min(0).max(1_000_000).nullable(),
}).readonly()
/**
 * `absent`: no Evaluation service; `disabled`: `intakeAttentionAgreementEnabled` is off;
 * `unverifiable`: the read was refused, failed or returned an unexpected shape.
 * Observational only: `causal` is always false and nothing here writes, adopts or sends.
 */
export const OwnerConsoleIntakeAgreementSchema = z.object({
  state: z.enum(['absent', 'disabled', 'unverifiable', 'ok']),
  causal: z.literal(false),
  summary: z.object({
    fromNotifiedAt: z.number().int().nonnegative(),
    toNotifiedAt: z.number().int().positive(),
    scanned: count,
    truncated: z.boolean(),
    provenanceAvailable: z.boolean(),
    notIntake: count,
    unresolved: count,
    foreign: count,
    intake: intakeAgreementCell,
    byLevel: z.array(z.object({ level: z.enum(INTAKE_AGREEMENT_LEVELS), cell: intakeAgreementCell }).readonly())
      .max(INTAKE_AGREEMENT_LEVELS.length).readonly(),
  }).readonly().optional(),
}).readonly()
export type OwnerConsoleIntakeAgreement = Readonly<z.infer<typeof OwnerConsoleIntakeAgreementSchema>>

/** Strict Host and client descriptors: three reads plus owner-clicked one-step writes. */
export const TYPERT = {
  package: '@dsh-enhanced/owner-console',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/status',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'status',
      invocation: { kind: 'direct' }, parameters: [],
      result: codec('@dsh-enhanced/owner-console#OwnerConsoleStatus', () => OwnerConsoleStatusSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 30, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/trendSnapshots',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'trendSnapshots',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'planId', wire: 'planId', source: 'json', codec: codec('owner-console#trendPlanId', () => z.string().max(160)) },
        { name: 'beforeSequence', wire: 'beforeSequence', source: 'json',
          codec: codec('owner-console#trendBeforeSequence', () => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)) },
        { name: 'limit', wire: 'limit', source: 'json',
          codec: codec('owner-console#trendLimit', () => z.number().int().min(1).max(TREND_SNAPSHOT_PAGE_MAX)) },
      ],
      result: codec('@dsh-enhanced/owner-console#OwnerConsoleTrendSnapshots', () => OwnerConsoleTrendSnapshotsSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 37, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/intakeAgreement',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'intakeAgreement',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'workspace', wire: 'workspace', source: 'json', codec: codec('owner-console#intakeWorkspace', () => z.string().max(4_096)) },
        { name: 'preset', wire: 'preset', source: 'json', codec: codec('owner-console#intakePreset', () => z.string().max(200)) },
      ],
      result: codec('@dsh-enhanced/owner-console#OwnerConsoleIntakeAgreement', () => OwnerConsoleIntakeAgreementSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 109, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/configureFeishu',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'configureFeishu',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'appId', wire: 'appId', source: 'json', codec: codec('owner-console#appId', () => z.string().max(64)) },
        { name: 'appSecretEnv', wire: 'appSecretEnv', source: 'json', codec: codec('owner-console#appSecretEnv', () => z.string().max(128)) },
        { name: 'credentialHandle', wire: 'credentialHandle', source: 'json', codec: codec('owner-console#credentialHandle', () => z.string().max(128)) },
        { name: 'account', wire: 'account', source: 'json', codec: codec('owner-console#account', () => z.string().max(128)) },
        { name: 'tenant', wire: 'tenant', source: 'json', codec: codec('owner-console#tenant', () => z.string().max(128)) },
        { name: 'discoverAppId', wire: 'discoverAppId', source: 'json', codec: codec('owner-console#discoverAppId', () => z.boolean()) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 38, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/configureTraex',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'configureTraex',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'enabled', wire: 'enabled', source: 'json', codec: codec('owner-console#enabled', () => z.boolean()) },
        { name: 'command', wire: 'command', source: 'json', codec: codec('owner-console#command', () => z.string().max(1_024)) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 52, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/configureBundle',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'configureBundle',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'entry', wire: 'entry', source: 'json', codec: codec('owner-console#entry', () => z.string().max(128)) },
        { name: 'config', wire: 'config', source: 'json', codec: codec('owner-console#config', () => z.record(z.string(), z.unknown())) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 62, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/setBundleEnabled',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'setBundleEnabled',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'name', wire: 'name', source: 'json', codec: codec('owner-console#bundleName', () => z.string().max(200)) },
        { name: 'enabled', wire: 'enabled', source: 'json', codec: codec('owner-console#enabled', () => z.boolean()) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 74, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/setPluginEnabled',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'setPluginEnabled',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'entryId', wire: 'entryId', source: 'json', codec: codec('owner-console#entryId', () => z.string().max(200)) },
        { name: 'enabled', wire: 'enabled', source: 'json', codec: codec('owner-console#enabled', () => z.boolean()) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 84, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/removeProjectBundle',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'removeProjectBundle',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'name', wire: 'name', source: 'json', codec: codec('owner-console#bundleName', () => z.string().max(200)) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 102, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/installProjectBundle',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'installProjectBundle',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'spec', wire: 'spec', source: 'json', codec: codec('owner-console#spec', () => z.string().max(300)) },
        { name: 'approvedBuilds', wire: 'approvedBuilds', source: 'json',
          codec: codec('owner-console#approvedBuilds', () => z.array(z.string().min(1).max(200)).max(64)) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 93, column: 3 },
    },
  ],
  model: { services: [], events: [], objects: [] },
} satisfies TypertContribution

/** The generated client shape is bundled into the Web module by build-client. */
export const TYPERT_REMOTE = { package: TYPERT.package, descriptors: TYPERT.invocations }
