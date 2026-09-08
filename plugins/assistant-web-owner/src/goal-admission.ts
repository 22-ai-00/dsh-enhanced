import { createHash } from 'node:crypto'
import { isAbsolute, join, normalize } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isMap, isScalar, isSeq, parseDocument, type Node, type YAMLMap, type YAMLSeq } from 'yaml'
import { Config as GoalsConfig, validateGoalStrategyConfig, type GoalCallsBudgetConfig, type GoalTokenBudgetConfig, type GoalStrategyConfig } from '@dsh-enhanced/assistant-goals'
import { compileAcceptanceProfiles, createVerifierAuthorities, type AcceptanceProfile, type VerifierAuthorityInput } from '@dsh-enhanced/assistant-verifier'
import { DEEPSEEK_CHAT_COMPLETIONS_CONTRACT, DEEPSEEK_MODELS, DEEPSEEK_PROVIDER } from '@dsh-enhanced/assistant-deepseek-budget'
import type { ActiveWebOwnerBindingSnapshot } from '@dsh-enhanced/assistant-delivery'
import { inspectAutonomyProfile, type AutonomyDoctorProfile } from './doctor.js'
import * as Actions from '@dsh-enhanced/assistant-actions'

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
  repositoryDelivery?: { repository: string; baseBranch: string; branch: string; paths: string[]; credentialHandle: string; expiresAt: number; maxActions: number; maxTotalBytes: number; openPullRequest: boolean }
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
    shape(input.repositoryDelivery, ['repository', 'baseBranch', 'branch', 'paths', 'credentialHandle', 'expiresAt', 'maxActions', 'maxTotalBytes', 'openPullRequest'])
    const value = input.repositoryDelivery as NonNullable<GoalAdmissionTaskBase['repositoryDelivery']>
    for (const key of ['repository', 'baseBranch', 'branch', 'credentialHandle'] as const) if (typeof value[key] !== 'string' || value[key].length === 0 || value[key].length > 256) fail('invalid repository delivery')
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.repository) || !Array.isArray(value.paths) || value.paths.length !== 1 || value.paths[0] !== verification.artifactPath
      || value.baseBranch === value.branch || !Number.isSafeInteger(value.expiresAt) || typeof value.openPullRequest !== 'boolean') fail('invalid repository delivery')
    integer(value.maxActions, value.openPullRequest ? 3 : 2, 10_000); integer(value.maxTotalBytes, 1, 64 * 1024 * 1024)
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
  taskSource: string, snapshot: ActiveWebOwnerBindingSnapshot, now = Date.now(), settingsSource?: string): { patch: string; admissionId: string; profile: AutonomyDoctorProfile; repositoryDelivery?: { repository: string; branch: string; paths: string[] } } {
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
  const actions = task.repositoryDelivery ? config('assistant-actions') : undefined; const keychain = task.repositoryDelivery ? config('credentials-keychain', false) : undefined
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
  const wake = task.wake ?? (task.repositoryDelivery ? { maxDelayMs: Math.min(60_000, task.executionBudget.durationMs - 1), runTimeoutMs: Math.min(60_000, task.executionBudget.durationMs), maxRuns: 1 } : undefined)
  if (task.repositoryDelivery && (task.repositoryDelivery.expiresAt <= now + task.executionBudget.durationMs + 60_000 || task.repositoryDelivery.expiresAt > profile.grant.expiresAt)) fail('repository delivery deadline mismatch')
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
  const compiled = createVerifierAuthorities({ authorities: [authority] })[0]!
  const verificationWindow = task.verification.maxDurationMs * task.verification.cases.length
  const profiles: AcceptanceProfile[] = (['goal-step', 'goal-outcome'] as const).map(taskKind => ({ id: `${admissionId}-${taskKind}`, version: 1, taskKind,
    objective: task.objective, scope: { workspace: input.workspace, preset: input.preset }, owner: { principalRecordId: owner.id, principalVersion: owner.version },
    validityMs: task.executionBudget.durationMs, bounds: { maxDurationMs: verificationWindow, maxEvidenceBytes: 8192 },
    criteria: [{ id: 'artifact-behavior', kind: 'isolated-process-behavior', authority: { id: compiled.id, digest: compiled.digest }, artifactPath: task.verification.artifactPath, testSetId: 'cases' }] }))
  append(verifier, 'authorities', [authority]); append(verifier, 'profiles', profiles)
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
    // v2 never writes model or credential configuration. The exact configured
    // route is admitted into the calls budget and rechecked by runtime.
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
      const repository = task.repositoryDelivery; const handles = keychain!.get('handles', true)
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
      const grant = { id: `${admissionId}-repository`, revision: 1, principalDigest: createHash('sha256').update(principalId).digest('hex'), principalRecordId: owner.id, principalVersion: owner.version, workspace: input.workspace, agentPreset: input.preset, repository: repository.repository, branch: repository.branch, paths: repository.paths, credentialHandle: repository.credentialHandle, expiresAt: repository.expiresAt, maxActions: repository.maxActions, maxTotalBytes: repository.maxTotalBytes, repoWorkflow: { baseBranch: repository.baseBranch, allowBranchCreate: false, allowPullRequest: repository.openPullRequest }, verifiedDelivery: { ownerRouteId: admissionId, budgetId } }
      append(actions!, 'grants', [grant])
      if (typeof Actions.validateActionConfig !== 'function') fail('install matching @dsh-enhanced/assistant-actions first')
      Actions.validateActionConfig(actions!.toJSON())
      append(policy, 'rules', [
        { id: `${admissionId}-repository-agent`, effect: 'allow', subject: { kind: 'agent', id: input.preset, workspace: input.workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: `action:github:${grant.id}` }, context: { initiators: ['external', 'background'] } },
        ...['action_github_grants', 'action_github_inspect', 'action_github_deliver', 'action_github_delivery_status'].map(tool => ({ id: `${admissionId}-repository-${tool}`, effect: 'allow' as const, subject: { kind: 'agent' as const, id: input.preset, workspace: input.workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'tool' as const, id: tool }, context: { initiators: ['external', 'background'] } })),
        { id: `${admissionId}-repository-background`, effect: 'allow', subject: { kind: 'background', id: 'dsh-enhanced-assistant-actions', workspace: input.workspace, principal: principalId }, actions: ['execute'], resource: { kind: 'tool', id: `action:github:${grant.id}` }, context: { initiators: ['background'] } },
        { id: `${admissionId}-repository-credential`, effect: 'allow', subject: { kind: 'background', id: 'dsh-enhanced-assistant-actions' }, actions: ['credential.use'], resource: { kind: 'credential', id: repository.credentialHandle }, context: { initiators: ['background'] } },
        { id: `${admissionId}-repository-automation`, effect: 'allow', subject: { kind: 'background', id: '*', workspace: input.workspace, principal: principalId }, actions: ['reconcile', 'execute'], resource: { kind: 'automation', id: 'verified-delivery-*' }, context: { initiators: ['background'] } },
        { id: `${admissionId}-repository-notice`, effect: 'allow', subject: { kind: 'background', id: 'assistant-actions-verified-delivery/v1', workspace: input.workspace, principal: principalId }, actions: ['send'], resource: { kind: 'message', id: binding.id }, context: { initiators: ['background'] } },
      ])
    }
  }
  GoalsConfig(goals.toJSON())
  return { patch: target.document.toString({ lineWidth: 0 }), admissionId, profile,
    ...(task.repositoryDelivery ? { repositoryDelivery: { repository: task.repositoryDelivery.repository, branch: task.repositoryDelivery.branch, paths: [...task.repositoryDelivery.paths] } } : {}) }
}
