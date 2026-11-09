import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual, promisify } from 'node:util'
import { isMap, isScalar, isSeq, parseDocument, YAMLMap, type YAMLSeq } from 'yaml'
import { literalAutonomyLinux, validateAutonomyLinuxPaths, type AutonomyLinuxConfig } from './autonomy.js'
import type { IsolationGrant } from '@dsh-enhanced/assistant-isolation'

interface AutonomyDoctorBase {
  stateRoot: string; databasePath: string
  grant: IsolationGrant
  principal: { channel: 'web'; account: string; tenant: string; user: string }
}
export type AutonomyDoctorProfile = AutonomyDoctorBase & { backend: 'linux-native'; linux: AutonomyLinuxConfig }
function fail(message: string): never { throw new Error(`autonomy doctor: ${message}`) }
function literal(node: unknown, label: string): unknown {
  if (isScalar(node) && (node.tag === undefined || node.tag === 'tag:yaml.org,2002:str')) return node.value
  fail(`${label} must be literal`)
}
function path(node: unknown, label: string, dshHome?: string): string {
  let value: unknown
  if (dshHome !== undefined && isScalar(node) && node.tag === 'tag:yaml.org,2002:js' && typeof node.value === 'string') {
    const match = /^dshHomePath\(['"]([^'"\n]+)['"]\)$/u.exec(node.value)
    if (!match || isAbsolute(match[1]!) || match[1]!.split('/').includes('..')) fail(`${label} has an unsupported expression`)
    value = join(dshHome, match[1]!)
  } else value = literal(node, label)
  if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value || /[\p{Cc}*]/u.test(value)) fail(`${label} must be a canonical absolute path`)
  return value
}
function object(node: unknown, label: string): Record<string, unknown> {
  if (!isMap(node)) fail(`${label} must be a mapping`)
  const result: Record<string, unknown> = Object.create(null)
  for (const pair of node.items) {
    const key = literal(pair.key, label)
    if (typeof key !== 'string') fail(`${label} keys must be strings`)
    result[key] = literal(pair.value, `${label}.${key}`)
  }
  return result
}

/** Inspect the composed profile without evaluating tagged expressions or changing its grants. */
export function inspectAutonomyProfile(source: string, profile: string, dshHome: string): AutonomyDoctorProfile {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile) || !isAbsolute(dshHome) || normalize(dshHome) !== dshHome || /[\p{Cc}*]/u.test(dshHome)) fail('invalid profile or home')
  const document = parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors.length || !isSeq(document.contents)) fail('effective profile must be an unambiguous sequence')
  const rows = document.contents as YAMLSeq
  const config = (slug: string): YAMLMap => {
    const id = `dsh-enhanced-${slug}`; const name = `@dsh-enhanced/${slug}`
    const matches = rows.items.filter(item => isMap(item) && (item.get('id') === id || item.get('name') === name)) as YAMLMap[]
    const row = matches[0]
    if (matches.length !== 1 || !row || literal(row.get('id', true), slug) !== id || literal(row.get('name', true), slug) !== name || (row.has('disabled') && literal(row.get('disabled', true), id) !== false)) fail(`missing, disabled or ambiguous ${slug}`)
    const value = row.get('config', true)
    if (!isMap(value)) fail(`${slug} config must be a mapping`)
    return value
  }
  const isolation = config('assistant-isolation'); const owner = config('assistant-web-owner'); const delivery = config('assistant-delivery')
  const principal = object(owner.get('principal', true), 'Web principal')
  if (!isDeepStrictEqual({ ...principal }, { account: profile, tenant: 'local', user: 'operator' })) fail('expected installer-managed Web owner')
  const workspace = path(owner.get('workspace', true), 'Web workspace')
  const preset = literal(owner.get('preset', true), 'Web preset')
  if (typeof preset !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(preset)) fail('invalid Web preset')
  const grants = isolation.get('grants', true)
  if (!isSeq(grants) || grants.items.length !== 1) fail('expected one installer-managed isolation grant')
  const grant = object(grants.items[0], 'Isolation grant')
  const fields = ['id', 'revision', 'principalDigest', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset', 'expiresAt', 'maxRuns', 'maxTotalDurationMs']
  if (Object.keys(grant).sort().join(',') !== fields.sort().join(',') || grant.id !== `autonomy-${profile}`
    || grant.principalDigest !== createHash('sha256').update(`web/${profile}/local/operator`).digest('hex')
    || grant.workspace !== workspace || grant.agentPreset !== preset
    || typeof grant.principalRecordId !== 'string' || grant.principalRecordId.length === 0
    || !['revision', 'principalVersion', 'expiresAt', 'maxRuns', 'maxTotalDurationMs'].every(key => Number.isSafeInteger(grant[key]) && (grant[key] as number) > 0)) fail('invalid managed grant or owner scope')
  const stateRoot = path(isolation.get('stateRoot', true), 'Isolation stateRoot')
  const common: AutonomyDoctorBase = { stateRoot,
    databasePath: path(delivery.get('databasePath', true), 'Delivery databasePath', dshHome),
    grant: { ...grant } as unknown as IsolationGrant, principal: { channel: 'web', account: profile, tenant: 'local', user: 'operator' } }
  const declaredBackend = isolation.has('backend') ? literal(isolation.get('backend', true), 'Isolation backend') : undefined
  // Docker profiles are never interpreted or rewritten here. Fail closed with a
  // migration hint so an old profile cannot be reported as healthy.
  if (declaredBackend === 'docker' || isolation.has('image') || isolation.has('dockerPath') || isolation.has('socketPath')) fail('Docker isolation was removed; migrate this profile explicitly to the linux-native backend')
  if (declaredBackend !== undefined && declaredBackend !== 'linux-native') fail('invalid isolation backend; migrate this profile explicitly to the linux-native backend')
  if (!isolation.has('linux')) fail('missing linux-native isolation descriptor; migrate this profile explicitly')
  const linux = literalAutonomyLinux(isolation.get('linux', true))
  validateAutonomyLinuxPaths(linux, stateRoot, dshHome)
  return { ...common, backend: 'linux-native', linux }
}

/** A read-only snapshot, never pairing, migration, or an authorization for future execution. */
export function inspectAutonomyOwner(profile: AutonomyDoctorProfile): { status: 'matched' | 'unavailable' | 'mismatch' } {
  let database: DatabaseSync | undefined
  try {
    if (!lstatSync(profile.databasePath).isFile() || realpathSync(profile.grant.workspace) !== profile.grant.workspace) return { status: 'unavailable' }
    database = new DatabaseSync(profile.databasePath, { readOnly: true })
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; BEGIN;')
    // Deliberately pinned rather than imported: each Delivery schema must be
    // reviewed before this self-contained read-only gate accepts it. v25 adds
    // foreground completion sequencing, v26 restart fences, v27 progress
    // handles, v28 foreground termination, v29 report/reply sidecars, v30 owner feedback and v31 attention audit.
    // Principal authority is unchanged from v24; reply state is not an owner receipt.
    // Unknown versions fail closed.
    const schemaVersion = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (![24, 25, 26, 27, 28, 29, 30, 31].includes(schemaVersion)) return { status: 'unavailable' }
    const row = database.prepare('SELECT principal_json, role, status, version, linked_to_id FROM delivery_principals WHERE id = ?').get(profile.grant.principalRecordId)
    if (!row || row.role !== 'owner' || row.status !== 'active' || row.version !== profile.grant.principalVersion || row.linked_to_id !== null
      || typeof row.principal_json !== 'string' || !isDeepStrictEqual(JSON.parse(row.principal_json), profile.principal)) return { status: 'mismatch' }
    return { status: 'matched' }
  } catch { return { status: 'unavailable' } } finally { database?.close() }
}

/** Verify only the persisted backend descriptor; never fetch, prepare or renew. */
export async function probeAutonomyProfileRuntime(profile: AutonomyDoctorProfile): Promise<void> {
  const { verifyLinuxRuntime } = await import('@dsh-enhanced/assistant-isolation')
  const { probeLinuxIsolationRuntime } = await import('@dsh-enhanced/assistant-isolation/native-resources')
  await verifyLinuxRuntime(profile.linux.runtime)
  await probeLinuxIsolationRuntime(profile.linux)
}

// ---------------------------------------------------------------------------
// Static autonomy readiness snapshot (ordinary-use learning assembly)

/** Installed bundles the ordinary-use learning assembly expects in one profile. */
const readinessBundleSlugs: readonly string[] = [
  'personal-assistant',
  'assistant-work-items',
  'assistant-delivery',
  'assistant-evaluation',
  'assistant-verifier',
  'event-triggers',
  'assistant-memory-learning',
  'assistant-growth-driver',
  'assistant-proactive',
  'plugin-control-plane',
]

/** Work-item intake evaluation levels; mirrors the work-items INTAKE_EVALUATION_LEVELS enum. */
const intakeEvaluationCeilings: ReadonlySet<string> = new Set(['ignore', 'digest', 'notify', 'accept'])
const intakeRuleIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

export type AutonomyReadinessStatus = 'ready' | 'not-ready' | 'not-verified'

export interface AutonomyReadinessReason {
  readonly code: string
  readonly message: string
}

export interface AutonomyReadinessCheck {
  readonly id: string
  /** Mandatory checks decide `ready`; optional rings are reported but never fail the snapshot. */
  readonly required: boolean
  readonly status: AutonomyReadinessStatus
  readonly summary: string
  readonly reasons: readonly AutonomyReadinessReason[]
  readonly details: Readonly<Record<string, unknown>>
}

export interface AutonomyReadinessReport {
  readonly protocol: 'dsh-enhanced/autonomy-readiness/v1'
  readonly profile: string
  readonly scope: 'ordinary-use-learning'
  readonly ready: boolean
  readonly checks: readonly AutonomyReadinessCheck[]
  /** Only composed YAML was read: runtime registration, model calls and external delivery are not observed. */
  readonly runtime: Readonly<{ observed: false; note: string }>
}

function readinessRows(source: string): YAMLSeq | undefined {
  try {
    const document = parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    return document.errors.length === 0 && isSeq(document.contents) ? document.contents : undefined
  } catch { return undefined }
}

function readinessRow(rows: YAMLSeq, slug: string): YAMLMap | undefined {
  const id = `dsh-enhanced-${slug}`
  const name = `@dsh-enhanced/${slug}`
  const matches = rows.items.filter(item => isMap(item) && (item.get('id') === id || item.get('name') === name)) as YAMLMap[]
  return matches.length === 1 ? matches[0] : undefined
}

function readinessLoaded(rows: YAMLSeq, slug: string): boolean | undefined {
  const row = readinessRow(rows, slug)
  return row === undefined ? undefined : row.get('disabled') !== true
}

function readinessConfig(rows: YAMLSeq, slug: string): YAMLMap | undefined {
  const config = readinessRow(rows, slug)?.get('config', true)
  if (config === undefined) return new YAMLMap()
  return isMap(config) ? config : undefined
}

function readinessPlain(node: unknown): unknown {
  if (node === undefined) return undefined
  if (isScalar(node)) return node.value
  if (isMap(node) || isSeq(node)) return node.toJSON()
  return node
}

/** Read one dotted config value without evaluating tagged expressions. */
function readinessValue(rows: YAMLSeq, slug: string, key: string): unknown {
  const config = readinessConfig(rows, slug)
  if (config === undefined) return undefined
  let node: unknown = config
  for (const segment of key.split('.')) {
    if (!isMap(node)) return undefined
    node = node.get(segment, true)
  }
  return readinessPlain(node)
}

function validIntakeEvaluationRules(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return false
  const ids = new Set<string>()
  return value.every(rule => {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) return false
    const record = rule as Record<string, unknown>
    if (Object.keys(record).sort().join(',') !== 'ceiling,ruleId') return false
    const { ruleId, ceiling } = record
    if (typeof ruleId !== 'string' || !intakeRuleIdPattern.test(ruleId) || ids.has(ruleId)) return false
    ids.add(ruleId)
    return typeof ceiling === 'string' && intakeEvaluationCeilings.has(ceiling)
  })
}

function routeText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null
}

/**
 * Inspect the composed profile without activating anything, calling a model or
 * reading a database. Missing or mismatched configuration is reported as
 * `not-ready` with a reason; this function never throws for an incomplete
 * assembly, so a doctor run degrades into a snapshot instead of a crash.
 */
export function inspectAutonomyReadiness(source: string, profile: string): AutonomyReadinessReport {
  const runtime = { observed: false as const,
    note: 'static composed profile only; runtime registration, model calls, external delivery and Policy readiness are not observed' }
  const rows = readinessRows(source)
  if (rows === undefined) {
    const check: AutonomyReadinessCheck = { id: 'profile-composition', required: true, status: 'not-ready',
      summary: 'effective profile is not an unambiguous YAML sequence',
      reasons: [{ code: 'profile-unreadable', message: 'the composed profile could not be parsed; doctor reports not-ready instead of crashing' }],
      details: {} }
    return { protocol: 'dsh-enhanced/autonomy-readiness/v1', profile, scope: 'ordinary-use-learning', ready: false, checks: [check], runtime }
  }
  const checks: AutonomyReadinessCheck[] = []

  const missing: string[] = []
  const disabled: string[] = []
  for (const slug of readinessBundleSlugs) {
    const loaded = readinessLoaded(rows, slug)
    if (loaded === undefined) missing.push(slug)
    else if (!loaded) disabled.push(slug)
  }
  checks.push({
    id: 'bundles', required: true,
    status: missing.length === 0 && disabled.length === 0 ? 'ready' : 'not-ready',
    summary: `${readinessBundleSlugs.length - missing.length - disabled.length}/${readinessBundleSlugs.length} expected bundles loaded`,
    reasons: [
      ...missing.map(slug => ({ code: `bundle-missing:${slug}`, message: `@dsh-enhanced/${slug} is not installed in this profile` })),
      ...disabled.map(slug => ({ code: `bundle-disabled:${slug}`, message: `@dsh-enhanced/${slug} is installed but its loader row is disabled` })),
    ],
    details: { expected: readinessBundleSlugs.length, missing, disabled },
  })

  const workItemsLoaded = readinessLoaded(rows, 'assistant-work-items')
  const workItemsEnabled = readinessValue(rows, 'assistant-work-items', 'enabled')
  const workItemsMode = readinessValue(rows, 'assistant-work-items', 'mode')
  const intakeLedger = readinessValue(rows, 'assistant-work-items', 'intakeLedger.enabled')
  const workItemsReasons: AutonomyReadinessReason[] = []
  if (workItemsLoaded !== true) {
    workItemsReasons.push({ code: 'work-items-unavailable', message: 'assistant-work-items is not installed and loaded, so no observe ledger can be written' })
  } else {
    if (workItemsEnabled !== true) workItemsReasons.push({ code: 'work-items-not-enabled', message: 'assistant-work-items.enabled is off; the ledger is inert' })
    if (workItemsMode !== 'observe') workItemsReasons.push({ code: 'work-items-not-observe', message: `assistant-work-items.mode is ${JSON.stringify(workItemsMode ?? null)}; the default assembly stays observe-only` })
    if (intakeLedger !== true) workItemsReasons.push({ code: 'work-items-intake-disabled', message: 'assistant-work-items.intakeLedger.enabled is off; inbound metadata is not recorded' })
  }
  checks.push({
    id: 'work-items-observe-intake', required: true,
    status: workItemsReasons.length === 0 ? 'ready' : 'not-ready',
    summary: workItemsReasons.length === 0 ? 'observe ledger enabled with the deterministic intake ledger' : 'observe ledger / intake not assembled',
    reasons: workItemsReasons,
    details: { enabled: workItemsEnabled === true, mode: workItemsMode ?? null, intakeLedgerEnabled: intakeLedger === true },
  })

  const proactiveLoaded = readinessLoaded(rows, 'assistant-proactive')
  const intakeEvaluationEnabled = readinessValue(rows, 'assistant-proactive', 'intakeEvaluation.enabled')
  const intakeProvider = routeText(readinessValue(rows, 'assistant-proactive', 'intakeEvaluation.provider'))
  const intakeModel = routeText(readinessValue(rows, 'assistant-proactive', 'intakeEvaluation.model'))
  const intakeRules = readinessValue(rows, 'assistant-proactive', 'intakeEvaluation.rules')
  const workItemsEvaluation = readinessValue(rows, 'assistant-work-items', 'intakeLedger.evaluation.enabled')
  const evaluatorReasons: AutonomyReadinessReason[] = []
  if (workItemsLoaded !== true) evaluatorReasons.push({ code: 'intake-evaluator-work-items-missing', message: 'assistant-work-items is unavailable, so an evaluator cannot register' })
  else if (workItemsEvaluation !== true) evaluatorReasons.push({ code: 'intake-evaluator-work-items-evaluation-off', message: 'assistant-work-items.intakeLedger.evaluation.enabled is off; the queue would refuse an evaluator registration' })
  if (proactiveLoaded !== true) evaluatorReasons.push({ code: 'intake-evaluator-producer-missing', message: 'assistant-proactive is not installed and loaded, so no production intake evaluator exists' })
  else {
    if (intakeEvaluationEnabled !== true) evaluatorReasons.push({ code: 'intake-evaluator-disabled', message: 'assistant-proactive.intakeEvaluation.enabled is off; the preset only enables it after the owner declared rules and a model route' })
    if (intakeProvider === null) evaluatorReasons.push({ code: 'intake-evaluator-provider-missing', message: 'assistant-proactive.intakeEvaluation.provider is not configured' })
    if (intakeModel === null) evaluatorReasons.push({ code: 'intake-evaluator-model-missing', message: 'assistant-proactive.intakeEvaluation.model is not configured' })
    if (!validIntakeEvaluationRules(intakeRules)) evaluatorReasons.push({ code: 'intake-evaluator-rules-invalid', message: 'assistant-proactive.intakeEvaluation.rules needs 1-16 entries with unique ruleId and ceiling in ignore|digest|notify|accept' })
  }
  checks.push({
    id: 'intake-evaluator', required: true,
    status: evaluatorReasons.length === 0 ? 'ready' : 'not-ready',
    summary: evaluatorReasons.length === 0
      ? `configured with ${Array.isArray(intakeRules) ? intakeRules.length : 0} rules; runtime registration is not observable from a static dump`
      : 'production intake evaluator not assembled',
    reasons: evaluatorReasons,
    details: { configured: evaluatorReasons.length === 0, runtimeRegistration: 'not-observed',
      provider: intakeProvider, model: intakeModel,
      rules: Array.isArray(intakeRules) ? intakeRules.length : 0,
      workItemsEvaluationEnabled: workItemsEvaluation === true },
  })

  const deliveryLoaded = readinessLoaded(rows, 'assistant-delivery')
  const ownerReportFeedback = readinessValue(rows, 'assistant-work-items', 'ownerReportFeedback') === true
  const ownerReplyContinuation = readinessValue(rows, 'assistant-work-items', 'ownerReplyContinuation') === true
  checks.push({
    id: 'delivery-natural-feedback', required: true,
    status: deliveryLoaded === true ? 'ready' : 'not-ready',
    summary: deliveryLoaded === true
      ? `Delivery loaded; the natural feedback parser ships with the bundle (work-item report feedback: ${ownerReportFeedback ? 'on' : 'off'}, reply continuation: ${ownerReplyContinuation ? 'on' : 'off'})`
      : 'assistant-delivery is not installed and loaded, so owner replies cannot become trusted feedback',
    reasons: deliveryLoaded === true ? [] : [{ code: 'delivery-unavailable', message: 'assistant-delivery is not installed and loaded in this profile' }],
    details: { installed: deliveryLoaded === true, ownerReportFeedback, ownerReplyContinuation },
  })

  const learningReasons: AutonomyReadinessReason[] = []
  const memoryLoaded = readinessLoaded(rows, 'assistant-memory-learning')
  const memoryFlag = readinessValue(rows, 'assistant-memory-learning', 'workItemExperiences') === true
  const reviewFlag = readinessValue(rows, 'assistant-verifier', 'memoryReviews.workItemExperiences') === true
  const adoptionFlag = readinessValue(rows, 'personal-assistant', 'personalMemory.automaticLearning.workItemExperiences') === true
  if (memoryLoaded !== true) learningReasons.push({ code: 'memory-learning-unavailable', message: 'assistant-memory-learning is not installed and loaded' })
  else if (!memoryFlag) learningReasons.push({ code: 'memory-work-item-experiences-off', message: 'assistant-memory-learning.workItemExperiences is off; the preset only turns it on after both signed grants already carry the same flag' })
  else {
    if (!reviewFlag) learningReasons.push({ code: 'memory-review-grant-not-expanded', message: 'assistant-verifier.memoryReviews.workItemExperiences is off; a fresh review grant is required' })
    if (!adoptionFlag) learningReasons.push({ code: 'memory-adoption-grant-not-expanded', message: 'personal-assistant.personalMemory.automaticLearning.workItemExperiences is off; a fresh adoption grant is required' })
  }
  const growthLoaded = readinessLoaded(rows, 'assistant-growth-driver')
  const growthEnabled = readinessValue(rows, 'assistant-growth-driver', 'enabled') === true
  const usageEnabled = readinessValue(rows, 'assistant-growth-driver', 'usageLearning.enabled') === true
  const workItemFailures = readinessValue(rows, 'assistant-growth-driver', 'usageLearning.workItemFailures') === true
  if (growthLoaded !== true) learningReasons.push({ code: 'growth-driver-unavailable', message: 'assistant-growth-driver is not installed and loaded' })
  else if (!growthEnabled || !usageEnabled) learningReasons.push({ code: 'growth-usage-learning-off', message: 'assistant-growth-driver enabled / usageLearning.enabled is off; ordinary usage is not scanned' })
  else if (!workItemFailures) learningReasons.push({ code: 'growth-work-item-failures-not-authorized', message: 'usageLearning.workItemFailures is off; it needs signed workItemAuthorities pins that a preset never invents or extends' })
  const evaluationLoaded = readinessLoaded(rows, 'assistant-evaluation')
  const notificationOutcomes = readinessValue(rows, 'assistant-evaluation', 'notificationOutcomesEnabled') === true
  if (evaluationLoaded !== true) learningReasons.push({ code: 'evaluation-unavailable', message: 'assistant-evaluation is not installed and loaded' })
  else if (!notificationOutcomes) learningReasons.push({ code: 'evaluation-notification-outcomes-off', message: 'assistant-evaluation.notificationOutcomesEnabled is off; notification results are not synced into the ledger' })
  checks.push({
    id: 'background-learning', required: true,
    status: learningReasons.length === 0 ? 'ready' : 'not-ready',
    summary: learningReasons.length === 0 ? 'ordinary-use learning switches are assembled' : `${learningReasons.length} background learning switch(es) not ready`,
    reasons: learningReasons,
    details: { memoryWorkItemExperiences: memoryFlag, memoryReviewGrant: reviewFlag, memoryAdoptionGrant: adoptionFlag,
      growthEnabled, growthUsageLearning: usageEnabled, growthWorkItemFailures: workItemFailures, notificationOutcomesEnabled: notificationOutcomes },
  })

  const controlLoaded = readinessLoaded(rows, 'plugin-control-plane')
  const revisionCapabilities = readinessValue(rows, 'plugin-control-plane', 'revisionCapabilities')
  const creationCapabilities = readinessValue(rows, 'plugin-control-plane', 'creationCapabilities')
  const revisionVerifications = readinessValue(rows, 'plugin-control-plane', 'revisionVerifications')
  const sourceJobs = readinessValue(rows, 'plugin-control-plane', 'sourceJobs')
  const sourceBuild = readinessValue(rows, 'plugin-control-plane', 'sourceBuild')
  const revisionJobs = sourceJobs !== null && typeof sourceJobs === 'object' && !Array.isArray(sourceJobs)
    ? (sourceJobs as Record<string, unknown>).revision : undefined
  const revisionConfigured = revisionCapabilities !== null && typeof revisionCapabilities === 'object' && !Array.isArray(revisionCapabilities)
    && typeof (revisionCapabilities as Record<string, unknown>).authorityId === 'string'
    && typeof (revisionCapabilities as Record<string, unknown>).keyId === 'string'
    && typeof (revisionCapabilities as Record<string, unknown>).namePrefix === 'string'
    && typeof (revisionCapabilities as Record<string, unknown>).expiresAt === 'number'
  const revisionReasons: AutonomyReadinessReason[] = []
  if (controlLoaded !== true) revisionReasons.push({ code: 'control-plane-unavailable', message: 'plugin-control-plane is not installed and loaded' })
  else if (!revisionConfigured) revisionReasons.push({ code: 'revision-capabilities-not-configured', message: 'revision adoption requires owner-generated ed25519 key material and explicit adoption/rollback grants; nothing is generated by a preset' })
  else if (creationCapabilities === undefined || revisionVerifications === undefined || revisionJobs === undefined || sourceBuild === undefined) {
    revisionReasons.push({ code: 'revision-prerequisites-missing', message: 'revisionCapabilities also needs creationCapabilities, revisionVerifications, sourceBuild and sourceJobs.revision; verify the owner setup' })
  }
  checks.push({
    id: 'revision-adoption', required: true,
    status: revisionReasons.length === 0 ? 'ready' : 'not-ready',
    summary: revisionReasons.length === 0 ? 'verified revision adoption and exact parent rollback are configured' : 'revision adoption authorization is not configured',
    reasons: revisionReasons,
    details: { configured: revisionConfigured, prerequisites: { creationCapabilities: creationCapabilities !== undefined, revisionVerifications: revisionVerifications !== undefined, sourceBuild: sourceBuild !== undefined, revisionJobs: revisionJobs !== undefined } },
  })

  const triggersLoaded = readinessLoaded(rows, 'event-triggers')
  const pollerEnabled = readinessValue(rows, 'event-triggers', 'pollerEnabled') === true
  const triggers = readinessValue(rows, 'event-triggers', 'triggers')
  const triggerCount = Array.isArray(triggers) ? triggers.length : 0
  const pollerReasons: AutonomyReadinessReason[] = []
  if (triggersLoaded !== true) pollerReasons.push({ code: 'event-triggers-unavailable', message: 'event-triggers is not installed and loaded' })
  else if (!pollerEnabled) pollerReasons.push({ code: 'event-poller-disabled', message: 'event-triggers.pollerEnabled is off; configured triggers never fire' })
  checks.push({
    id: 'event-poller', required: true,
    status: pollerReasons.length === 0 ? 'ready' : 'not-ready',
    summary: pollerReasons.length === 0
      ? `poller enabled with ${triggerCount} trigger definition(s)${triggerCount === 0 ? '; none configured, so nothing will fire yet' : ''}`
      : 'event poller not ready',
    reasons: pollerReasons,
    details: { pollerEnabled, triggers: triggerCount },
  })

  // Optional ring (Lead request): PTC presentation is a configuration hint only.
  const toolPresentation = readinessValue(rows, 'assistant-growth-driver', 'toolPresentation')
  const ptcConfigured = toolPresentation === 'ptc'
  checks.push({
    id: 'ptc-presentation', required: false,
    status: ptcConfigured ? 'not-verified' : 'ready',
    summary: ptcConfigured
      ? 'toolPresentation=ptc; a live run still needs a mounted ctx.ptcRuntime, run_code that does not request human approval, and an exact Policy allow rule for the growth agent background run_code (this static doctor verifies none of the runtime conditions)'
      : 'toolPresentation is native (PTC is an explicit owner opt-in)',
    reasons: [],
    details: { toolPresentation: typeof toolPresentation === 'string' ? toolPresentation : 'native' },
  })

  const ready = checks.filter(check => check.required).every(check => check.status === 'ready')
  return { protocol: 'dsh-enhanced/autonomy-readiness/v1', profile, scope: 'ordinary-use-learning', ready, checks, runtime }
}

/** Deterministic human-readable form of the same snapshot the JSON line carries. */
export function formatAutonomyReadiness(report: AutonomyReadinessReport): string {
  const label = (status: AutonomyReadinessStatus) => status === 'ready' ? 'ready      ' : status === 'not-ready' ? 'not-ready  ' : 'not-verified'
  const lines = [`Autonomy readiness (static composed profile, no model, no writes): ${report.ready ? 'READY' : 'NOT READY'} (profile ${report.profile})`]
  for (const check of report.checks) {
    lines.push(`  ${label(check.status)} ${check.id}: ${check.summary}`)
    for (const reason of check.reasons) lines.push(`               - [${reason.code}] ${reason.message}`)
  }
  lines.push(`  runtime: not observed (${report.runtime.note})`)
  return `${lines.join('\n')}\n`
}

export async function runAutonomyDoctor(argv = process.argv.slice(2)): Promise<void> {
  const usage = [
    'Usage: dsh-autonomy-doctor [--profile web] [--dsh-home <absolute-path>] [--readiness]',
    'Default: checks the installed finite isolation grant, paired owner and a temporary backend-specific probe.',
    '--readiness: prints the static ordinary-use-learning readiness snapshot (text plus one JSON line) and exits 1 when a mandatory ring is not ready.',
    'The readiness snapshot reads only the composed profile: it never activates a Host, calls a model, writes state, renews grants or verifies runtime registration, Policy or external delivery.',
    '',
  ].join('\n')
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(usage); return }
  let profile = 'web'; let dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh'); let readinessOnly = false
  for (let index = 0; index < argv.length;) {
    const option = argv[index]
    if (option === '--readiness') { readinessOnly = true; index += 1; continue }
    const value = argv[index + 1]
    if (!['--profile', '--dsh-home'].includes(option ?? '') || value === undefined || value.startsWith('--')) fail('invalid arguments')
    if (option === '--profile') profile = value; else dshHome = value
    index += 2
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile) || !isAbsolute(dshHome) || normalize(dshHome) !== dshHome || /[\p{Cc}*]/u.test(dshHome)) fail('invalid profile or home')
  const dump = async () => {
    try { return (await promisify(execFile)('dsh', ['--profile', profile, '--dump-config'], { env: { ...process.env, DSH_HOME: dshHome }, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout }
    catch { fail('could not compose profile; inspect installed bundles and configuration') }
  }
  if (readinessOnly) {
    let source: string
    try { source = await dump() } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const report: AutonomyReadinessReport = { protocol: 'dsh-enhanced/autonomy-readiness/v1', profile, scope: 'ordinary-use-learning', ready: false,
        checks: [{ id: 'profile-composition', required: true, status: 'not-ready', summary: 'the profile could not be composed',
          reasons: [{ code: 'profile-composition-failed', message }], details: {} }],
        runtime: { observed: false, note: 'static composed profile only; nothing was activated' } }
      process.stdout.write(formatAutonomyReadiness(report))
      process.stdout.write(`${JSON.stringify(report)}\n`)
      process.exitCode = 1
      return
    }
    const report = inspectAutonomyReadiness(source, profile)
    process.stdout.write(formatAutonomyReadiness(report))
    process.stdout.write(`${JSON.stringify(report)}\n`)
    if (!report.ready) process.exitCode = 1
    return
  }
  const source = await dump()
  // Finite-isolation mode keeps its existing output exactly: the ordinary-use
  // readiness snapshot is an explicit `--readiness` opt-in so an autonomy
  // profile's diagnostic run is unchanged.
  const parsed = inspectAutonomyProfile(source, profile, dshHome)
  const { inspectIsolationGrant } = await import('@dsh-enhanced/assistant-isolation')
  if (typeof inspectIsolationGrant !== 'function') fail('install the matching assistant-isolation version with grant diagnostics; no state was changed')
  const owner = inspectAutonomyOwner(parsed)
  const grant = inspectIsolationGrant({ stateRoot: parsed.stateRoot, grant: parsed.grant })
  // Report persisted state before dispatching a disposable, separately bounded probe.
  process.stdout.write(`${JSON.stringify({ scope: 'finite-isolation', owner, grant, modelAndGoals: 'not-checked', externalActions: 'not-checked' })}\n`)
  if (owner.status !== 'matched' || grant.status !== 'available') fail('owner or persisted grant checks failed; no authority was renewed')
  await probeAutonomyProfileRuntime(parsed)
  if (!isDeepStrictEqual(inspectAutonomyProfile(await dump(), profile, dshHome), parsed)
    || inspectAutonomyOwner(parsed).status !== 'matched'
    || inspectIsolationGrant({ stateRoot: parsed.stateRoot, grant: parsed.grant }).status !== 'available') fail('configuration or authority changed during probe; retry diagnostics')
  process.stdout.write('Finite isolation configuration, owner, persisted grant and temporary runtime probe passed. This is a diagnostic snapshot; Policy, live resource admission, model budgets, Goal verification and external Actions still require their own checks.\n')
}
