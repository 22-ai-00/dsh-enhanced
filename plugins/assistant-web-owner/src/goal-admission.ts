import { createHash } from 'node:crypto'
import { isAbsolute, join, normalize } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isMap, isScalar, isSeq, parseDocument, type Node, type YAMLMap, type YAMLSeq } from 'yaml'
import { Config as GoalsConfig, validateGoalStrategyConfig, type GoalCallsBudgetConfig, type GoalTokenBudgetConfig, type GoalStrategyConfig } from '@dsh-enhanced/assistant-goals'
import { compileAcceptanceProfiles, createVerifierAuthorities, type AcceptanceProfile, type VerifierAuthorityInput, type RepositoryReadbackAuthorityInput } from '@dsh-enhanced/assistant-verifier'
import { DEEPSEEK_CHAT_COMPLETIONS_CONTRACT, DEEPSEEK_MODELS, DEEPSEEK_PROVIDER } from '@dsh-enhanced/assistant-deepseek-budget'
import type { ActiveWebOwnerBindingSnapshot } from '@dsh-enhanced/assistant-delivery'
import { inspectAutonomyProfile, type AutonomyDoctorProfile } from './doctor.js'
import * as Actions from '@dsh-enhanced/assistant-actions'
import { literalPath } from './setup.js'

interface GoalAdmissionTaskBase {
  objective: string
  maxGoalRounds: number
  stepMaxDurationMs: number
  strategy?: Partial<GoalStrategyConfig>
  verification: {
    artifactPath: string; command: string; maxRuns: number; maxTotalDurationMs: number
    maxDurationMs: number; maxOutputBytes: number
    cases: Array<{ stdin: string; expectedStdout: string; expectedExitCode: number }>
  }
  wake?: { maxDelayMs: number; runTimeoutMs: number; maxRuns: number }
  repositoryDelivery?: { repository: string; baseBranch: string; branch: string; paths: string[]; credentialHandle?: string; externalGrantId?: string; expiresAt: number; maxActions: number; maxTotalBytes: number; openPullRequest: boolean; acceptance?: 'goal-outcome' | 'goal-step'; events?: { credentialHandle: string; maxPolls: number; maxFires: number; pollIntervalMs: number; requestTimeoutMs: number }; outcome?: Pick<RepositoryReadbackAuthorityInput, 'requiredChecks' | 'reviewerIds' | 'minApprovals' | 'timeoutMs' | 'freshnessMs'> }
}
/** Legacy v1 fixed DeepSeek route. Kept for existing private admission files. */
export interface GoalAdmissionTaskV1 extends GoalAdmissionTaskBase {
  version: 1
  model: 'deepseek-v4-flash' | 'deepseek-v4-pro'
  apiKeyEnv?: string
  executionBudget: Omit<GoalTokenBudgetConfig, 'costUsdMicros'>
}
/** v2 uses the deployment's already configured exact provider/model route. */
export interface GoalAdmissionTaskV2 extends GoalAdmissionTaskBase {
  version: 2
  route: { provider: string; model: string }
  executionBudget: GoalCallsBudgetConfig
}
export type GoalAdmissionTask = GoalAdmissionTaskV1 | GoalAdmissionTaskV2
export interface GoalAdmissionInput { dshHome: string; profile: string; workspace: string; preset: string }
export interface ConfiguredDefaultModelRoute { provider: string; model: string }
function fail(reason: string): never { throw new Error(`goal setup: ${reason}`) }
function shape(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('invalid task fields')
}
function integer(value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail('invalid task limit')
}
function route(value: unknown): asserts value is ConfiguredDefaultModelRoute {
  shape(value, ['provider', 'model'])
  for (const field of ['provider', 'model']) {
    const item = value[field]
    if (typeof item !== 'string' || item.length === 0 || item.length > 200 || item.trim() !== item || /[\p{Cc}]/u.test(item)) fail('invalid model route')
  }
}
/** Read only the public, effective default-route fields from DSH's user settings layer. */
export function parseSettingsDefaultModelRoute(source: string): ConfiguredDefaultModelRoute | undefined {
  if (Buffer.byteLength(source, 'utf8') > 1024 * 1024) fail('settings.yaml exceeds 1 MiB')
  const document = parseDocument(source)
  if (document.errors.length > 0 || !isMap(document.contents) || document.contents.tag !== undefined) fail('settings.yaml must be an untagged YAML mapping')
  const selected = document.contents.get('agent-default-model', true)
  if (selected === undefined) return undefined
  if (!isMap(selected) || selected.tag !== undefined) fail('settings.agent-default-model must be an untagged YAML mapping')
  const fields: Record<string, unknown> = {}
  for (const key of ['provider', 'model']) {
    const value = selected.get(key, true)
    if (!isScalar(value) || value.tag !== undefined || typeof value.value !== 'string') fail('settings.agent-default-model must contain public provider and model strings')
    fields[key] = value.value
  }
  route(fields)
  return fields
}
/** Parse bounded local operator data. No tagged YAML, scripts, credentials, or arbitrary model routes. */
export function parseGoalAdmissionTask(source: string): GoalAdmissionTask {
  if (Buffer.byteLength(source, 'utf8') > 1024 * 1024) fail('task file exceeds 1 MiB')
  let input: unknown
  try { input = JSON.parse(source) } catch { fail('task file must be JSON') }
  const version = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>).version : undefined
  if (version === 1) shape(input, ['version', 'objective', 'model', 'maxGoalRounds', 'stepMaxDurationMs', 'executionBudget', 'verification'], ['apiKeyEnv', 'wake', 'strategy'])
  else if (version === 2) shape(input, ['version', 'objective', 'route', 'maxGoalRounds', 'stepMaxDurationMs', 'executionBudget', 'verification'], ['wake', 'strategy', 'repositoryDelivery'])
  else fail('unsupported task version')
  if (typeof input.objective !== 'string' || input.objective.length === 0 || input.objective.trim() !== input.objective
    || Buffer.byteLength(input.objective) > 8192 || /[\p{Cc}]/u.test(input.objective)) fail('invalid objective')
  if (input.version === 1 && (!DEEPSEEK_MODELS.includes(input.model as GoalAdmissionTaskV1['model'])
    || input.apiKeyEnv !== undefined && (typeof input.apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(input.apiKeyEnv)))) fail('invalid DeepSeek model or credential reference')
  if (input.version === 2) route(input.route)
  integer(input.maxGoalRounds, 1, 32); integer(input.stepMaxDurationMs, 1000, 300000)
  if (input.strategy !== undefined) input.strategy = validateGoalStrategyConfig(input.strategy as Partial<GoalStrategyConfig>)
  if (input.version === 1) shape(input.executionBudget, ['modelCalls', 'toolCalls', 'inputTokens', 'outputTokens', 'durationMs', 'maxOutputTokensPerCall'])
  else shape(input.executionBudget, ['mode', 'modelCalls', 'toolCalls', 'durationMs', 'maxOutputTokensPerCall', 'routes'])
  const budget = input.executionBudget
  for (const name of input.version === 1 ? ['modelCalls', 'toolCalls', 'inputTokens', 'outputTokens'] : ['modelCalls', 'toolCalls']) integer(budget[name], 1, 1_000_000_000)
  integer(budget.durationMs, 1, 31 * 86_400_000)
  integer(budget.maxOutputTokensPerCall, 1, 32768)
  if (input.version === 1 && ((budget.inputTokens as number) < 2_097_152 || (budget.outputTokens as number) < budget.maxOutputTokensPerCall)) fail('budget cannot admit the fixed model route')
  if (input.version === 2) {
    if (budget.mode !== 'calls' || !Array.isArray(budget.routes) || budget.routes.length !== 1) fail('v2 calls budget needs one exact route')
    route(budget.routes[0])
    if (!isDeepStrictEqual(budget.routes[0], input.route)) fail('budget route must equal task route')
  }
  shape(input.verification, ['artifactPath', 'command', 'cases', 'maxRuns', 'maxTotalDurationMs', 'maxDurationMs', 'maxOutputBytes'])
  const verification = input.verification
  for (const name of ['artifactPath', 'command']) if (typeof verification[name] !== 'string' || verification[name].length === 0) fail('invalid verification input')
  if (!Array.isArray(verification.cases) || verification.cases.length === 0 || verification.cases.length > 32) fail('invalid verification cases')
  for (const value of verification.cases) {
    shape(value, ['stdin', 'expectedStdout', 'expectedExitCode'])
    if (typeof value.stdin !== 'string' || typeof value.expectedStdout !== 'string') fail('invalid verification case')
    integer(value.expectedExitCode, 0, 255)
  }
  integer(verification.maxRuns, 1, 10000); integer(verification.maxDurationMs, 1000, 300000)
  integer(verification.maxTotalDurationMs, verification.maxDurationMs, 86_400_000)
  integer(verification.maxOutputBytes, 1, 1024 * 1024)
  const verificationWindow = verification.maxDurationMs * verification.cases.length
  if (verificationWindow >= input.stepMaxDurationMs) fail('verification needs time within the step deadline')
  if (budget.durationMs <= input.stepMaxDurationMs + 2 * verificationWindow) fail('execution budget cannot cover the configured native round and verification')
  if (input.wake !== undefined) {
    shape(input.wake, ['maxDelayMs', 'runTimeoutMs', 'maxRuns'])
    integer(input.wake.maxDelayMs, 1, budget.durationMs - 1); integer(input.wake.runTimeoutMs, 1000, 300000); integer(input.wake.maxRuns, 1, 10000)
  }
  if (input.repositoryDelivery !== undefined) {
    if (input.version !== 2) fail('repository delivery requires task version 2')
    shape(input.repositoryDelivery, ['repository', 'baseBranch', 'branch', 'paths', 'expiresAt', 'maxActions', 'maxTotalBytes', 'openPullRequest'], ['credentialHandle', 'externalGrantId', 'acceptance', 'outcome', 'events'])
    const value = input.repositoryDelivery as NonNullable<GoalAdmissionTaskBase['repositoryDelivery']>
    if (value.acceptance !== undefined && !['goal-outcome', 'goal-step'].includes(value.acceptance)) fail('invalid repository acceptance')
    for (const key of ['repository', 'baseBranch', 'branch'] as const) if (typeof value[key] !== 'string' || value[key].length === 0 || value[key].length > 256) fail('invalid repository delivery')
    if ((typeof value.credentialHandle === 'string') === (typeof value.externalGrantId === 'string')
      || value.credentialHandle !== undefined && (value.credentialHandle.length === 0 || value.credentialHandle.length > 256)
      || value.externalGrantId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.externalGrantId)) fail('repository delivery requires exactly one credentialHandle or externalGrantId')
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.repository) || !Array.isArray(value.paths) || value.paths.length !== 1 || value.paths[0] !== verification.artifactPath
      || value.baseBranch === value.branch || !Number.isSafeInteger(value.expiresAt) || typeof value.openPullRequest !== 'boolean') fail('invalid repository delivery')
    integer(value.maxActions, value.openPullRequest ? 3 : 2, 10_000); integer(value.maxTotalBytes, 1, 64 * 1024 * 1024)
    if (value.events !== undefined) {
      shape(value.events, ['credentialHandle', 'maxPolls', 'maxFires', 'pollIntervalMs', 'requestTimeoutMs'])
      if (value.externalGrantId !== undefined || !value.outcome || typeof value.events.credentialHandle !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,199}$/u.test(value.events.credentialHandle)) fail('repository events require outcome and an existing observation credential')
      integer(value.events.maxPolls, 2, 10000); integer(value.events.maxFires, 1, 100)
      integer(value.events.pollIntervalMs, 1000, 3600000); integer(value.events.requestTimeoutMs, 100, 30000)
      if (value.events.maxPolls <= value.events.maxFires || input.maxGoalRounds < 2) fail('repository event budget cannot cover observation and continuation')
      // Each native round may create one outcome assessment with up to three verifier attempts.
      integer(value.maxActions, 3 + 12 * input.maxGoalRounds, 10000)
      if (input.wake && (input.wake as { maxRuns: number }).maxRuns < value.events.maxFires + 1) fail('wake budget must cover delivery and allowed event continuations')
    }
    if (value.outcome !== undefined) {
      shape(value.outcome, ['requiredChecks', 'reviewerIds', 'minApprovals', 'timeoutMs', 'freshnessMs'])
      if (value.acceptance !== 'goal-step' || !value.openPullRequest) fail('repository outcome requires explicit goal-step delivery and a pull request')
      createVerifierAuthorities({ authorities: [{ ...value.outcome, kind: 'repository-readback', id: 'repository-validation', grantId: 'repository-validation', grantRevision: 1, repository: value.repository, branch: value.branch, baseBranch: value.baseBranch }] })
      integer(value.maxActions, 7, 10_000)
      if (budget.durationMs <= input.stepMaxDurationMs + verificationWindow + value.outcome.timeoutMs) fail('execution budget cannot cover repository verification')
    }
  }
  return input as unknown as GoalAdmissionTask
}
function map(value: unknown): YAMLMap { if (!isMap(value)) fail('profile config must be a mapping'); return value }
function sequence(value: unknown): YAMLSeq { if (!isSeq(value)) fail('expected profile list'); return value }
function untagged(value: unknown, label: string): void {
  if (isScalar(value)) { if (value.tag !== undefined) fail(`tagged ${label}`); return }
  if (isSeq(value)) { if (value.tag !== undefined) fail(`tagged ${label}`); for (const item of value.items) untagged(item, label); return }
  if (isMap(value)) {
    if (value.tag !== undefined) fail(`tagged ${label}`)
    for (const pair of value.items) {
      if (!isScalar(pair.key) || pair.key.tag !== undefined || typeof pair.key.value !== 'string' || pair.value === null) fail(`invalid ${label}`)
      untagged(pair.value, label)
    }
    return
  }
  fail(`invalid ${label}`)
}
function literalString(value: unknown): string | undefined {
  return isScalar(value) && value.tag === undefined && typeof value.value === 'string' ? value.value : undefined
}
function literalInteger(value: unknown): number | undefined {
  return isScalar(value) && value.tag === undefined && typeof value.value === 'number' && Number.isSafeInteger(value.value) ? value.value : undefined
}
/** Accept only the public, credential-free broker projection used for this admission. */
function externalProjection(value: unknown): {
  id: string; revision: number; grantDigest: string; owner: { principalDigest: string; principalRecordId: string; principalVersion: number; workspace: string; preset: string; bindingId: string; bindingVersion: number; bindingGeneration: number }
  sessionId: string; destination: { repository: string; branch: string; baseBranch?: string; paths: string[] }; expiresAt: number; maxActions: number; maxTotalBytes: number
  allowedOperations: string[]; allowedInspectKinds: string[]; verifiedDelivery?: { ownerRouteId: string; budgetId: string; acceptance?: string }
} {
  const record = (input: unknown, required: string[], optional: string[] = []): Record<string, unknown> => {
    if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !Object.hasOwn(input, key))) fail('invalid external repository grant')
    return input as Record<string, unknown>
  }
  const text = (input: unknown): input is string => typeof input === 'string' && input.length > 0 && input.length <= 4096 && !/[\p{Cc}]/u.test(input)
  const positive = (input: unknown): input is number => typeof input === 'number' && Number.isSafeInteger(input) && input > 0
  const grant = record(value, ['id', 'revision', 'grantDigest', 'owner', 'sessionId', 'destination', 'expiresAt', 'maxActions', 'maxTotalBytes', 'source', 'maxCostUnits', 'allowedOperations', 'allowedInspectKinds'], ['verifiedDelivery'])
  const owner = record(grant.owner, ['principalDigest', 'principalRecordId', 'principalVersion', 'workspace', 'preset', 'bindingId', 'bindingVersion', 'bindingGeneration'])
  const destination = record(grant.destination, ['classification', 'repository', 'branch', 'paths'], ['baseBranch'])
  const source = record(grant.source, ['classification', 'provenanceDigest'])
  const delivery = grant.verifiedDelivery === undefined ? undefined : record(grant.verifiedDelivery, ['ownerRouteId', 'budgetId'], ['acceptance'])
  if (!text(grant.id) || !positive(grant.revision) || typeof grant.grantDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(grant.grantDigest) || !text(grant.sessionId)
    || !text(owner.principalDigest) || !text(owner.principalRecordId) || !positive(owner.principalVersion) || !text(owner.workspace) || !text(owner.preset) || !text(owner.bindingId) || !positive(owner.bindingVersion) || !positive(owner.bindingGeneration)
    || destination.classification !== 'github-repository' || !text(destination.repository) || !text(destination.branch) || destination.baseBranch !== undefined && !text(destination.baseBranch)
    || !Array.isArray(destination.paths) || destination.paths.length < 1 || destination.paths.some(path => !text(path)) || !positive(grant.expiresAt) || !positive(grant.maxActions) || !positive(grant.maxTotalBytes)
    || source.classification === undefined || typeof source.provenanceDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(source.provenanceDigest) || !positive(grant.maxCostUnits)
    || !Array.isArray(grant.allowedOperations) || grant.allowedOperations.some(operation => typeof operation !== 'string') || !Array.isArray(grant.allowedInspectKinds) || grant.allowedInspectKinds.some(kind => typeof kind !== 'string')
    || delivery !== undefined && (!text(delivery.ownerRouteId) || !text(delivery.budgetId) || delivery.acceptance !== undefined && !['goal-outcome', 'goal-step'].includes(String(delivery.acceptance)))) fail('invalid external repository grant')
  return { id: grant.id, revision: grant.revision, grantDigest: grant.grantDigest, owner: owner as { principalDigest: string; principalRecordId: string; principalVersion: number; workspace: string; preset: string; bindingId: string; bindingVersion: number; bindingGeneration: number }, sessionId: grant.sessionId,
    destination: { repository: destination.repository as string, branch: destination.branch as string, ...(destination.baseBranch === undefined ? {} : { baseBranch: destination.baseBranch as string }), paths: [...destination.paths] as string[] }, expiresAt: grant.expiresAt, maxActions: grant.maxActions, maxTotalBytes: grant.maxTotalBytes,
    allowedOperations: [...grant.allowedOperations] as string[], allowedInspectKinds: [...grant.allowedInspectKinds] as string[], ...(delivery === undefined ? {} : { verifiedDelivery: delivery as { ownerRouteId: string; budgetId: string; acceptance?: string } }) }
}
function parse(source: string) {
  const document = parseDocument(source.trim() || '[]', { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors.length || !isSeq(document.contents)) fail('profile must be an unambiguous YAML sequence')
  return { document, rows: document.contents as YAMLSeq }
}
function merge(base: YAMLMap, overlay: YAMLMap): YAMLMap {
  const result = map(base.clone())
  for (const pair of overlay.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') fail('profile keys must be strings')
    const inherited = result.get(pair.key.value, true); const value = pair.value as Node | null
    result.set(pair.key.value, isMap(inherited) && isMap(value) ? merge(inherited, value) : value?.clone() ?? null)
  }
  return result
}
/** Compose a complete candidate, preserving custom siblings and rejecting modified managed settings. */
export function prepareGoalAdmission(input: GoalAdmissionInput, source: string, effectiveSource: string,
  taskSource: string, snapshot: ActiveWebOwnerBindingSnapshot, now = Date.now(), settingsSource?: string, eventSupport?: typeof import('@dsh-enhanced/event-triggers')): { patch: string; admissionId: string; profile: AutonomyDoctorProfile; repositoryDelivery?: { repository: string; branch: string; paths: string[]; acceptance: 'goal-outcome' | 'goal-step' } } {
  const task = parseGoalAdmissionTask(taskSource)
  for (const value of [input.dshHome, input.workspace]) if (!isAbsolute(value) || normalize(value) !== value) fail('home and workspace must be canonical paths')
  if (!Number.isFinite(now) || task.version === 1 && now >= Date.parse(DEEPSEEK_CHAT_COMPLETIONS_CONTRACT.expiresAt)) fail('model contract expired')
  const target = parse(source); const effective = parse(effectiveSource)
  const row = (rows: YAMLSeq, slug: string, required: boolean): YAMLMap | undefined => {
    const id = `dsh-enhanced-${slug}`; const name = `@dsh-enhanced/${slug}`
    const found = rows.items.filter(value => isMap(value) && (value.get('id') === id || value.get('name') === name)) as YAMLMap[]
    if (found.length > 1) fail(`duplicate ${slug}`)
    const item = found[0]
    if (!item) { if (required) fail(`install ${name} first`); return undefined }
    if (item.get('id') !== id || item.has('name') && item.get('name') !== name || item.has('disabled') && item.get('disabled') !== false) fail(`disabled or shadowed ${slug}`)
    return item
  }
  const config = (slug: string, materialize = true): YAMLMap => {
    const inherited = row(effective.rows, slug, true)!; const existing = row(target.rows, slug, false)
    const base = inherited.has('config') ? map(inherited.get('config', true)) : target.document.createNode({}) as YAMLMap
    const value = existing?.has('config') ? merge(base, map(existing.get('config', true))) : map(base.clone())
    if (materialize) {
      const destination = existing ?? target.document.createNode({ id: `dsh-enhanced-${slug}`, name: `@dsh-enhanced/${slug}` }) as YAMLMap
      destination.set('config', value); if (!existing) target.rows.add(destination)
    }
    return value
  }
  // Include complete required rows in the candidate before inspecting its inherited isolation scope.
  for (const slug of ['assistant-isolation', 'assistant-web-owner']) config(slug)
  const delivery = config('assistant-delivery'); const goals = config('assistant-goals'); const verifier = config('assistant-verifier')
  const actions = task.repositoryDelivery ? config('assistant-actions') : undefined
  const keychain = task.repositoryDelivery?.credentialHandle === undefined ? undefined : config('credentials-keychain', false)
  const eventTriggers = task.repositoryDelivery?.events ? config('event-triggers') : undefined
  const provider = task.version === 1 ? config('assistant-deepseek-budget') : undefined; const personal = config('personal-assistant')
  const policy = map(personal.get('assistantPolicy', true))
  const principalId = `web/${input.profile}/local/operator`
  const profile = inspectAutonomyProfile(target.document.toString(), input.profile, input.dshHome)
  const { binding, owner } = snapshot
  if (profile.grant.workspace !== input.workspace || profile.grant.agentPreset !== input.preset || binding.workspace !== input.workspace || binding.agentPreset !== input.preset
    || !isDeepStrictEqual(binding.principal, profile.principal) || owner.id !== profile.grant.principalRecordId || owner.version !== profile.grant.principalVersion
    || !isDeepStrictEqual(owner.principal, profile.principal) || owner.role !== 'owner' || owner.status !== 'active'
    || now + task.executionBudget.durationMs > profile.grant.expiresAt) fail('owner, scope or remaining grant deadline mismatch')
  const admissionId = `goal-${createHash('sha256').update(JSON.stringify([input.profile, binding.id, owner.id, owner.version, task.objective])).digest('hex').slice(0,24)}`
  const wake = task.wake ?? (task.repositoryDelivery ? { maxDelayMs: task.repositoryDelivery.events ? task.executionBudget.durationMs - 1 : Math.min(60_000, task.executionBudget.durationMs - 1), runTimeoutMs: Math.min(task.repositoryDelivery.events ? 300_000 : 60_000, task.executionBudget.durationMs), maxRuns: (task.repositoryDelivery.events?.maxFires ?? 0) + 1 } : undefined)
  if (task.repositoryDelivery && (task.repositoryDelivery.expiresAt <= now + task.executionBudget.durationMs + 60_000 || task.repositoryDelivery.expiresAt > profile.grant.expiresAt)) fail('repository delivery deadline mismatch')
  const repository = task.repositoryDelivery
  const externalGrant = (() => {
    if (repository?.externalGrantId === undefined) return undefined
    const configured = actions!.toJSON() as { broker?: { mode?: unknown }; grants?: unknown; externalGrants?: unknown }
    if (configured.broker?.mode !== 'external-unix-v1' || !Array.isArray(configured.grants) || configured.grants.length !== 0 || !Array.isArray(configured.externalGrants)) fail('external repository grant requires external-unix-v1')
    const matches = configured.externalGrants.map(externalProjection).filter(grant => grant.id === repository.externalGrantId)
    if (matches.length !== 1) fail('external repository grant is unavailable')
    const grant = matches[0]!
    const expectedOwner = { principalDigest: createHash('sha256').update(principalId).digest('hex'), principalRecordId: owner.id, principalVersion: owner.version,
      workspace: input.workspace, preset: input.preset, bindingId: binding.id, bindingVersion: binding.version, bindingGeneration: binding.generation }
    const expectedOperations = ['commit', 'inspect', ...(repository.openPullRequest ? ['pull-request'] : [])]
    const expectedInspections = ['repository', 'branch', 'file', ...(repository.outcome ? ['pull-request', 'checks', 'reviews'] : [])]
    const acceptance = repository.acceptance ?? 'goal-outcome'
    if (!isDeepStrictEqual(grant.owner, expectedOwner) || grant.sessionId !== binding.sessionId
      || grant.destination.repository !== repository.repository || grant.destination.branch !== repository.branch || grant.destination.baseBranch !== repository.baseBranch
      || !isDeepStrictEqual(grant.destination.paths, repository.paths) || grant.expiresAt !== repository.expiresAt
      || grant.maxActions !== repository.maxActions || grant.maxTotalBytes !== repository.maxTotalBytes
      || !isDeepStrictEqual([...grant.allowedOperations].sort(), expectedOperations.sort())
      || !isDeepStrictEqual([...grant.allowedInspectKinds].sort(), expectedInspections.sort())
      || grant.verifiedDelivery === undefined || grant.verifiedDelivery.ownerRouteId !== admissionId
      || grant.verifiedDelivery.budgetId !== `${admissionId}-runs` || (grant.verifiedDelivery.acceptance ?? 'goal-outcome') !== acceptance) fail('external repository grant does not exactly match this admission')
    return grant
  })()
  const managed = isSeq(verifier.get('profiles', true)) && sequence(verifier.get('profiles', true)).items.some(value => isMap(value) && String(value.get('id')).startsWith('goal-'))
  const set = (config: YAMLMap, field: string, desired: unknown, defaults: unknown[] = []) => {
    if (config.has(field)) {
      const old = config.get(field, true)
      if (isScalar(old) && old.tag !== undefined) fail(`tagged managed ${field}`)
      const current = isMap(old) || isSeq(old) ? old.toJSON() : isScalar(old) ? old.value : old
      if (!isDeepStrictEqual(current, desired) && (managed || !defaults.some(value => isDeepStrictEqual(current, value)))) fail(`existing ${field} differs; no configuration was changed`)
    }
    config.set(field, target.document.createNode(desired))
  }
  const append = <T extends { id: string }>(config: YAMLMap, field: string, entries: T[]) => {
    let values: unknown = config.get(field, true)
    if (values === undefined) { values = target.document.createNode([]); config.set(field, values) }
    if (!isSeq(values)) fail(`invalid ${field}`)
    untagged(values, field)
    for (const entry of entries) {
      const matches = values.items.filter(value => isMap(value) && value.get('id') === entry.id) as YAMLMap[]
      if (matches.length > 1 || matches.length === 1 && !isDeepStrictEqual(matches[0]!.toJSON(), entry)) fail(`existing ${field} entry differs`)
      if (matches.length === 0) values.add(target.document.createNode(entry))
    }
  }
  const authority = { kind: 'isolated-runner' as const, id: `${admissionId}-verify`, stateRoot: join(input.dshHome, 'assistant-goal-verification', input.profile, admissionId),
    image: profile.image, dockerPath: profile.dockerPath, command: task.verification.command, expiresAt: profile.grant.expiresAt,
    maxRuns: task.verification.maxRuns, maxTotalDurationMs: task.verification.maxTotalDurationMs, maxDurationMs: task.verification.maxDurationMs,
    maxOutputBytes: task.verification.maxOutputBytes, testSets: [{ id: 'cases', cases: task.verification.cases }] }
  const remoteAuthority: RepositoryReadbackAuthorityInput | undefined = repository?.outcome === undefined ? undefined : {
    ...repository.outcome, kind: 'repository-readback', id: `${admissionId}-repository-verify`, grantId: externalGrant?.id ?? `${admissionId}-repository`, grantRevision: externalGrant?.revision ?? 1,
    repository: repository.repository, branch: repository.branch, baseBranch: repository.baseBranch,
  }
  const authorities: VerifierAuthorityInput[] = remoteAuthority ? [authority, remoteAuthority] : [authority]
  const compiled = createVerifierAuthorities({ authorities })
  const verificationWindow = task.verification.maxDurationMs * task.verification.cases.length
  const profiles: AcceptanceProfile[] = (['goal-step', 'goal-outcome'] as const).map(taskKind => ({ id: `${admissionId}-${taskKind}`, version: 1, taskKind,
    objective: task.objective, scope: { workspace: input.workspace, preset: input.preset }, owner: { principalRecordId: owner.id, principalVersion: owner.version },
    validityMs: task.executionBudget.durationMs, bounds: { maxDurationMs: taskKind === 'goal-outcome' && remoteAuthority ? remoteAuthority.timeoutMs : verificationWindow, maxEvidenceBytes: 8192 },
    criteria: taskKind === 'goal-outcome' && remoteAuthority
      ? [{ id: 'repository-ready', kind: 'target-readback', authority: { id: compiled[1]!.id, digest: compiled[1]!.digest }, objectId: `${remoteAuthority.repository}:${remoteAuthority.branch}`, expected: [{ pointer: '/ready', value: true }] }]
      : [{ id: 'artifact-behavior', kind: 'isolated-process-behavior', authority: { id: compiled[0]!.id, digest: compiled[0]!.digest }, artifactPath: task.verification.artifactPath, testSetId: 'cases' }] }))
  append(verifier, 'authorities', authorities); append(verifier, 'profiles', profiles)
  // Compile all effective authorities/profiles, detecting conflicting exact task matches too.
  compileAcceptanceProfiles({ databasePath: 'validation-only', authorities: sequence(verifier.get('authorities', true)).toJSON() as VerifierAuthorityInput[], profiles: sequence(verifier.get('profiles', true)).toJSON() as AcceptanceProfile[] })
  set(goals, 'verifyNativeRounds', true, [false]); set(goals, 'verifyGoalOutcome', true, [false])
  set(goals, 'preauthorizedCreateMaxRounds', task.maxGoalRounds, [0]); set(goals, 'stepMaxDurationMs', task.stepMaxDurationMs, [60000])
  set(goals, 'executionBudget', task.executionBudget)
  if (task.strategy !== undefined) {
    set(goals, 'strategy', task.strategy)
    append(policy, 'rules', [
      { id: `${admissionId}-strategy-goal`, effect: 'allow', subject: { kind: 'agent', id: input.preset, workspace: input.workspace, principal: principalId }, actions: ['delegate'], resource: { kind: 'goal', id: 'business-context' }, context: { initiators: wake === undefined ? ['external'] : ['external', 'background'] } },
      { id: `${admissionId}-strategy-tool`, effect: 'allow', subject: { kind: 'agent', id: input.preset, workspace: input.workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: 'goal_strategy' }, context: { initiators: wake === undefined ? ['external'] : ['external', 'background'] } },
    ])
  }
  const defaults = effective.rows.items.filter(value => isMap(value) && value.get('id') === 'agent-default-model') as YAMLMap[]
  const overrides = target.rows.items.filter(value => isMap(value) && value.get('id') === 'agent-default-model') as YAMLMap[]
  if (defaults.length > 1 || overrides.length > 1) fail('ambiguous default model')
  if (task.version === 1) {
    if (!provider) fail('DeepSeek provider configuration is unavailable')
    set(provider, 'enabled', true, [false]); set(provider, 'apiKeyEnv', task.apiKeyEnv ?? 'DEEPSEEK_API_KEY', ['DEEPSEEK_API_KEY'])
    set(provider, 'defaultMaxTokens', task.executionBudget.maxOutputTokensPerCall, [8192])
    if (!managed) {
      delivery.set('agentProvider', DEEPSEEK_PROVIDER); delivery.set('agentModel', task.model); delivery.set('agentMaxOutputTokens', task.executionBudget.maxOutputTokensPerCall)
    } else {
      set(delivery, 'agentProvider', DEEPSEEK_PROVIDER); set(delivery, 'agentModel', task.model); set(delivery, 'agentMaxOutputTokens', task.executionBudget.maxOutputTokensPerCall)
    }
    const modelRow = overrides[0] ?? target.document.createNode({ id: 'agent-default-model' }) as YAMLMap
    if (modelRow.has('disabled') && modelRow.get('disabled') !== false) fail('default model plugin is disabled')
    if (managed && modelRow.has('config') && !isDeepStrictEqual(map(modelRow.get('config', true)).toJSON(), { provider: DEEPSEEK_PROVIDER, model: task.model })) fail('existing default model differs')
    modelRow.set('config', target.document.createNode({ provider: DEEPSEEK_PROVIDER, model: task.model })); if (!overrides.length) target.rows.add(modelRow)
  } else {
    const settingsRoute = settingsSource === undefined ? undefined : parseSettingsDefaultModelRoute(settingsSource)
    const modelRow = defaults[0]
    if (settingsRoute === undefined && (!modelRow || modelRow.has('disabled') && modelRow.get('disabled') !== false || !modelRow.has('config'))) fail('configured default model route is unavailable')
    const configured = settingsRoute ?? map(modelRow!.get('config', true)).toJSON()
    if (!isDeepStrictEqual(configured, task.route)) fail('task route is not the configured default provider/model')
    // Scheduled Delivery does not read Web's default-model settings. Pin its
    // fallback to the already configured and admitted public route as well.
    // Credentials/provider configuration remains owned by the existing route.
    if (wake) {
      if (!managed) {
        delivery.set('agentProvider', task.route.provider); delivery.set('agentModel', task.route.model); delivery.set('agentMaxOutputTokens', task.executionBudget.maxOutputTokensPerCall)
      } else {
        set(delivery, 'agentProvider', task.route.provider); set(delivery, 'agentModel', task.route.model); set(delivery, 'agentMaxOutputTokens', task.executionBudget.maxOutputTokensPerCall)
      }
    }
  }
  if (wake) {
    append(delivery, 'ownerRoutes', [{ id: admissionId, conversation: binding.conversation, principal: binding.principal, workspace: binding.workspace,
      agentPreset: binding.agentPreset, policyRef: binding.policyRef, minimumGeneration: binding.generation }])
    const budgetId = `${admissionId}-runs`
    set(goals, 'backgroundWake', { ownerRouteId: admissionId, budgetId, maxDelayMs: wake.maxDelayMs, runTimeoutMs: wake.runTimeoutMs })
    set(goals, 'preauthorizedSchedule', true, [false])
    const automation = map(personal.get('assistantAutomations', true))
    set(automation, 'schedulerEnabled', true, [false])
    append(policy, 'budgets', [{ id: budgetId, metric: 'automation-runs', limit: wake.maxRuns, periodMs: Number.MAX_SAFE_INTEGER, scope: 'global' }])
    append(policy, 'rules', [
      { id: `${admissionId}-goal`, effect: 'allow', subject: { kind: 'agent', id: input.preset, workspace: input.workspace, principal: principalId }, actions: ['observe', 'inspect', 'snapshot', 'execute'], resource: { kind: 'goal', id: 'business-context' }, context: { initiators: ['background'] } },
      ...['isolation_run', 'isolation_grants', 'goal_context'].map(tool => ({ id: `${admissionId}-${tool}`, effect: 'allow', subject: { kind: 'agent', id: input.preset, workspace: input.workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: tool }, context: { initiators: ['background'] } })),
      { id: `${admissionId}-isolation-grant`, effect: 'allow', subject: { kind: 'agent', id: input.preset, workspace: input.workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: `isolation:${profile.grant.id}` }, context: { initiators: ['background'] } },
      { id: `${admissionId}-reply`, effect: 'allow', subject: { kind: 'agent', id: input.preset, workspace: input.workspace, principal: principalId }, actions: ['reply'], resource: { kind: 'message', id: binding.id }, context: { initiators: ['background'] } },
      { id: `${admissionId}-automation`, effect: 'allow', subject: { kind: 'background', id: '*', workspace: input.workspace, principal: principalId }, actions: ['reconcile', 'execute'], resource: { kind: 'automation', id: 'goal-wake-*' }, context: { initiators: ['background'] } },
      { id: `${admissionId}-resume`, effect: 'allow', subject: { kind: 'background', id: 'assistant-goals-wake/v1', workspace: input.workspace, principal: principalId }, actions: ['wake'], resource: { kind: 'goal', id: 'business-context' }, context: { initiators: ['background'] } },
    ])
    if (task.repositoryDelivery) {
      const repository = task.repositoryDelivery
      let grantId = externalGrant?.id
      if (!externalGrant) {
        const handles = keychain!.get('handles', true)
        if (!isSeq(handles)) fail('credential handle is unavailable')
        untagged(handles, 'credential handles')
        const matching = handles.items.filter(item => isMap(item) && literalString(item.get('id', true)) === repository.credentialHandle) as YAMLMap[]
        if (matching.length !== 1) fail('credential handle is unavailable')
        const consumers = matching[0]!.get('consumers', true); const purposes = matching[0]!.get('purposes', true)
        if (!isSeq(consumers) || !isSeq(purposes)
          || literalString(matching[0]!.get('provider', true)) === undefined
          || (literalInteger(matching[0]!.get('maxLeaseMs', true)) ?? 0) < 30_000
          || !consumers.items.some(item => literalString(item) === 'dsh-enhanced-assistant-actions')
          || !purposes.items.some(item => literalString(item) === 'github.commit')) fail('credential handle is unavailable')
        const grant = { id: `${admissionId}-repository`, revision: 1, principalDigest: createHash('sha256').update(principalId).digest('hex'), principalRecordId: owner.id, principalVersion: owner.version, workspace: input.workspace, agentPreset: input.preset, repository: repository.repository, branch: repository.branch, paths: repository.paths, credentialHandle: repository.credentialHandle!, expiresAt: repository.expiresAt, maxActions: repository.maxActions, maxTotalBytes: repository.maxTotalBytes, repoWorkflow: { baseBranch: repository.baseBranch, allowBranchCreate: false, allowPullRequest: repository.openPullRequest }, verifiedDelivery: { ownerRouteId: admissionId, budgetId, ...(repository.acceptance ? { acceptance: repository.acceptance } : {}) } }
        append(actions!, 'grants', [grant])
        if (typeof Actions.validateActionConfig !== 'function') fail('install matching @dsh-enhanced/assistant-actions first')
        Actions.validateActionConfig(actions!.toJSON())
        grantId = grant.id
      }
      const repositoryRules = [
        { id: `${admissionId}-repository-agent`, effect: 'allow', subject: { kind: 'agent', id: input.preset, workspace: input.workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: `action:github:${grantId}` }, context: { initiators: ['external', 'background'] } },
        ...['action_github_grants', 'action_github_inspect', 'action_github_deliver', 'action_github_delivery_status'].map(tool => ({ id: `${admissionId}-repository-${tool}`, effect: 'allow' as const, subject: { kind: 'agent' as const, id: input.preset, workspace: input.workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'tool' as const, id: tool }, context: { initiators: ['external', 'background'] } })),
        { id: `${admissionId}-repository-background`, effect: 'allow' as const, subject: { kind: 'background' as const, id: 'dsh-enhanced-assistant-actions', workspace: input.workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'tool' as const, id: `action:github:${grantId}` }, context: { initiators: ['background'] } },
        { id: `${admissionId}-repository-automation`, effect: 'allow' as const, subject: { kind: 'background' as const, id: '*', workspace: input.workspace, principal: principalId }, actions: ['reconcile', 'execute'], resource: { kind: 'automation' as const, id: 'verified-delivery-*' }, context: { initiators: ['background'] } },
        { id: `${admissionId}-repository-notice`, effect: 'allow' as const, subject: { kind: 'background' as const, id: 'assistant-actions-verified-delivery/v1', workspace: input.workspace, principal: principalId }, actions: ['send'], resource: { kind: 'message' as const, id: binding.id }, context: { initiators: ['background'] } },
        ...(externalGrant ? [] : [{ id: `${admissionId}-repository-credential`, effect: 'allow' as const, subject: { kind: 'background' as const, id: 'dsh-enhanced-assistant-actions' }, actions: ['credential.use'], resource: { kind: 'credential' as const, id: repository.credentialHandle! }, context: { initiators: ['background'] } }]),
      ]
      append(policy, 'rules', repositoryRules)
      if (repository.events) {
        if (typeof eventSupport?.normalizeEventTriggersConfig !== 'function' || typeof eventSupport.EVENT_OBSERVER_EXECUTOR !== 'string') fail('install matching event-triggers support for repository events')
        const { normalizeEventTriggersConfig, EVENT_OBSERVER_EXECUTOR } = eventSupport
        const events = repository.events, triggerId = `${admissionId}-repository-events`, automationId = `${triggerId}-source`, pollBudgetId = `${triggerId}-polls`, eventBudgetId = `${triggerId}-runs`
        const eventHandles = keychain!.get('handles', true)
        if (!isSeq(eventHandles)) fail('repository observation credential handle is unavailable')
        untagged(eventHandles, 'credential handles')
        const eventHandle = eventHandles.items.filter(item => isMap(item) && literalString(item.get('id', true)) === events.credentialHandle) as YAMLMap[]
        if (eventHandle.length !== 1) fail('repository observation credential handle is unavailable')
        const eventConsumers = eventHandle[0]!.get('consumers', true), eventPurposes = eventHandle[0]!.get('purposes', true)
        if (!isSeq(eventConsumers) || !isSeq(eventPurposes) || (literalInteger(eventHandle[0]!.get('maxLeaseMs', true)) ?? 0) < events.requestTimeoutMs
          || !eventConsumers.items.some(item => literalString(item) === 'dsh-enhanced-event-triggers') || !eventPurposes.items.some(item => literalString(item) === 'github.observe')) fail('repository observation handle must authorize event-triggers and github.observe')
        const observer = { workspace: input.workspace, preset: input.preset, principalId, principalRecordId: owner.id, principalVersion: owner.version, ownerRouteId: admissionId, expiresAt: repository.expiresAt, budgetId: eventBudgetId }
        append(eventTriggers!, 'triggers', [{ id: triggerId, automationId, kind: 'github-repository', observerLifetime: 'goal', repository: repository.repository, branch: repository.branch, baseBranch: repository.baseBranch, credentialHandle: events.credentialHandle,
          fireWhen: 'changed', debounceMs: 0, cooldownMs: 0, maxFires: events.maxFires, observer }])
        set(eventTriggers!, 'pollerEnabled', true, [false]); set(eventTriggers!, 'pollIntervalMs', events.pollIntervalMs, [5000]); set(eventTriggers!, 'requestTimeoutMs', events.requestTimeoutMs, [10000])
        set(goals, 'eventWaits', true, [false])
        append(policy, 'budgets', [{ id: pollBudgetId, metric: 'repository-observations', limit: events.maxPolls, periodMs: Number.MAX_SAFE_INTEGER, scope: 'subject' },
          { id: eventBudgetId, metric: 'automation-runs', limit: events.maxFires, periodMs: Number.MAX_SAFE_INTEGER, scope: 'subject' }])
        append(policy, 'rules', [
          { id: `${triggerId}-observe`, effect: 'allow', subject: { kind: 'background', id: `event-triggers:${triggerId}`, workspace: input.workspace, principal: principalId }, actions: ['observe'], resource: { kind: 'network', id: `https://api.github.com/repos/${repository.repository}` }, context: { initiators: ['background'] }, budget: { id: pollBudgetId, amount: 1 } },
          { id: `${triggerId}-credential`, effect: 'allow', subject: { kind: 'background', id: 'dsh-enhanced-event-triggers' }, actions: ['credential.use'], resource: { kind: 'credential', id: events.credentialHandle }, context: { initiators: ['background'] } },
          { id: `${triggerId}-ingest`, effect: 'allow', subject: { kind: 'external', id: `event-triggers:${triggerId}`, workspace: input.workspace }, actions: ['ingest'], resource: { kind: 'automation', id: automationId }, context: { initiators: ['external'] } },
          { id: `${triggerId}-host`, effect: 'allow', subject: { kind: 'background', id: EVENT_OBSERVER_EXECUTOR, workspace: input.workspace, principal: principalId }, actions: ['observe', 'reconcile', 'execute', 'pause'], resource: { kind: 'automation', id: automationId }, context: { initiators: ['background'] } },
          { id: `${triggerId}-execute`, effect: 'allow', subject: { kind: 'background', id: automationId, workspace: input.workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'automation', id: automationId }, context: { initiators: ['background'] } },
          { id: `${triggerId}-wait`, effect: 'allow', subject: { kind: 'agent', id: input.preset, workspace: input.workspace, principal: principalId }, actions: ['wait-for-event'], resource: { kind: 'automation', id: automationId }, context: { initiators: ['external', 'background'] } },
          { id: `${triggerId}-background-wait`, effect: 'allow', subject: { kind: 'background', id: 'assistant-goals-wake/v1', workspace: input.workspace, principal: principalId }, actions: ['wait-for-event'], resource: { kind: 'automation', id: automationId }, context: { initiators: ['background'] } },
          { id: `${triggerId}-wake`, effect: 'allow', subject: { kind: 'background', id: '*', workspace: input.workspace, principal: principalId }, actions: ['reconcile', 'execute'], resource: { kind: 'automation', id: 'goal-event-wake-*' }, context: { initiators: ['background'] } },
          { id: `${triggerId}-native-wait`, effect: 'allow', subject: { kind: 'agent', id: input.preset, workspace: input.workspace, principal: principalId }, actions: ['wait', 'pause'], resource: { kind: 'goal', id: 'business-context' }, context: { initiators: ['background'] } },
          { id: `${triggerId}-wait-tool`, effect: 'allow', subject: { kind: 'agent', id: input.preset, workspace: input.workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: 'goal_wait_event' }, context: { initiators: ['external', 'background'] } },
        ])
        normalizeEventTriggersConfig({ ...eventTriggers!.toJSON(), databasePath: literalPath(eventTriggers!.get('databasePath', true), input, 'EventTriggers databasePath') })
      }

    }
  }
  GoalsConfig(goals.toJSON())
  return { patch: target.document.toString({ lineWidth: 0 }), admissionId, profile,
    ...(task.repositoryDelivery ? { repositoryDelivery: { repository: task.repositoryDelivery.repository, branch: task.repositoryDelivery.branch, paths: [...task.repositoryDelivery.paths], acceptance: task.repositoryDelivery.acceptance ?? 'goal-outcome' } } : {}) }
}
