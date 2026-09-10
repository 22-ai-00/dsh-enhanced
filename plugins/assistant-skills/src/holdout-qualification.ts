import { fileObservationSteps } from './definition.js'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { GoalScope } from '@dsh-enhanced/assistant-goals'
import type { SkillDefinition } from './definition.js'
import { instantiate } from './definition.js'
import { replaySkill, validateReplayTrace, type ReplayResult } from './replay.js'
import { verifyHoldoutSignature, type BeginResult, type HoldoutReceipt, type SignedCell } from './holdout-authority.js'
import { verifyProspectiveCertificate } from './prospective-holdout.js'

export interface HoldoutExecutionConfig {
  readonly image: string
  readonly dockerPath: string
  readonly stateRoot: string
  readonly command: string
  readonly artifactPath: string
  readonly expiresAt: number
  readonly repeats: number
  readonly maxToolCalls: number
  readonly maxBytes: number
  readonly maxOutputBytes: number
  readonly cellDurationMs: number
  readonly verificationDurationMs: number
}

export interface CanaryAdmission {
  readonly protocol: 'assistant-skills/canary-admission/v1'
  readonly skillName: string
  readonly parentDefinitionDigest: string
  readonly candidateDefinitionDigest: string
  readonly taskFamily: {
    readonly goalDefinitionDigest: string
    readonly outcomeProfile: { readonly id: string; readonly version: number; readonly digest: string }
  }
}

export interface HoldoutQualificationInput {
  readonly baseline: SkillDefinition
  readonly candidate: SkillDefinition
  readonly scope: GoalScope
  readonly execution: HoldoutExecutionConfig
  readonly inputs?: Readonly<Record<string, unknown>>
  readonly files?: readonly { path: string; content: string }[]
  readonly pinnedPublicKey: string
  readonly expectedDatasetDigest?: string
  readonly expectedGeneratorDigest?: string
  readonly canaryAdmission?: CanaryAdmission
  readonly transport: { request(operation: 'begin' | 'next' | 'record' | 'finish', value?: unknown, signal?: AbortSignal): Promise<unknown> }
  readonly signal: AbortSignal
  readonly authorize: () => void
}

export interface HoldoutQualificationResult {
  readonly receipt: HoldoutReceipt
  readonly quality: { candidateChecksPassed: boolean; evaluationGain: number | null; evaluationGainObserved: boolean; criticalRegressionsPassed: boolean; heldoutIndependence: 'unproven' }
  readonly modelCalls: 0
  readonly promotionAuthorized: false
  readonly execution: 'native-file-tools-and-isolated-artifact'
  readonly prospectiveHoldout?: 'authority-attested-after-freeze'
  readonly admissionDigest?: string
}

const digest = (value: unknown) => acceptanceDigest(value)
const fail = (message: string): never => { throw new Error(`assistant-skills: holdout qualification ${message}`) }
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const cellId = (value: unknown): value is string => typeof value === 'string' && /^cell-[1-9][0-9]*$/u.test(value)
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Object.getOwnPropertySymbols(value).length === 0 && Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && 'value' in item)
function same(left: unknown, right: unknown): boolean { return digest(left) === digest(right) }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

/** Resolve every existing component while preserving a normalized suffix that does not exist yet. */
export function canonicalHoldoutPath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) fail('absolute canonical path required')
  let existing = resolve(path)
  const suffix: string[] = []
  while (true) {
    let present = false
    try {
      lstatSync(existing)
      present = true
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
      if (code !== 'ENOENT') fail('canonical path is unavailable')
    }
    if (present) {
      try { return join(realpathSync(existing), ...suffix) } catch { fail('canonical path is unavailable') }
    }
    const parent = dirname(existing)
    if (parent === existing) fail('canonical path is unavailable')
    suffix.unshift(basename(existing)); existing = parent
  }
}
function separated(workspace: string, stateRoot: string): void {
  const canonicalWorkspace = canonicalHoldoutPath(workspace), canonicalStateRoot = canonicalHoldoutPath(stateRoot)
  if (inside(canonicalWorkspace, canonicalStateRoot) || inside(canonicalStateRoot, canonicalWorkspace)) fail('state root overlaps qualification workspace')
}
export function holdoutPathsOverlap(left: string, right: string): boolean {
  const canonicalLeft = canonicalHoldoutPath(left), canonicalRight = canonicalHoldoutPath(right)
  return inside(canonicalLeft, canonicalRight) || inside(canonicalRight, canonicalLeft)
}
function assertPrivateRoot(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) fail('private owned state root required')
  canonicalHoldoutPath(path)
}
function inside(parent: string, child: string): boolean { const value = relative(parent, child); return !value || !value.startsWith('..') && !isAbsolute(value) }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
async function request<T>(transport: HoldoutQualificationInput['transport'], operation: 'begin' | 'next' | 'record' | 'finish', value: unknown, signal: AbortSignal, expiresAt: number, durationMs: number): Promise<T> {
  const remaining = expiresAt - Date.now()
  if (remaining <= 0) fail('qualification expired')
  const local = new AbortController(), bounded = AbortSignal.any([signal, local.signal, AbortSignal.timeout(Math.min(remaining, durationMs))])
  bounded.throwIfAborted()
  const aborted = new Promise<never>((_resolve, reject) => bounded.addEventListener('abort', () => reject(new Error('assistant-skills: holdout qualification IPC deadline exceeded')), { once: true }))
  try { return await Promise.race([transport.request(operation, value, bounded) as Promise<T>, aborted]) } finally { local.abort() }
}
export function validateHoldoutExecution(value: HoldoutExecutionConfig): void {
  if (!plain(value) || typeof value.image !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.image) || typeof value.dockerPath !== 'string' || !isAbsolute(value.dockerPath)
    || typeof value.stateRoot !== 'string' || !isAbsolute(value.stateRoot) || typeof value.command !== 'string' || value.command.length === 0 || value.command.length > 16384
    || typeof value.artifactPath !== 'string' || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(value.artifactPath) || value.artifactPath.split('/').some(part => part === '.' || part === '..')
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0 || !Number.isSafeInteger(value.repeats) || value.repeats < 2 || value.repeats > 4
    || !Number.isSafeInteger(value.maxToolCalls) || value.maxToolCalls < 1 || value.maxToolCalls > 32 || !Number.isSafeInteger(value.maxBytes) || value.maxBytes < 1 || value.maxBytes > 262144
    || !Number.isSafeInteger(value.maxOutputBytes) || value.maxOutputBytes < 1 || value.maxOutputBytes > 262144 || !Number.isSafeInteger(value.cellDurationMs) || value.cellDurationMs < 1000 || value.cellDurationMs > 300000
    || !Number.isSafeInteger(value.verificationDurationMs) || value.verificationDurationMs < 1 || value.verificationDurationMs >= value.cellDurationMs) fail('invalid execution config')
}
export function validateCanaryAdmission(value: unknown): asserts value is CanaryAdmission {
  if (!exact(value, ['protocol', 'skillName', 'parentDefinitionDigest', 'candidateDefinitionDigest', 'taskFamily']) || value.protocol !== 'assistant-skills/canary-admission/v1'
    || typeof value.skillName !== 'string' || !/^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value.skillName)
    || !hex(value.parentDefinitionDigest) || !hex(value.candidateDefinitionDigest) || !exact(value.taskFamily, ['goalDefinitionDigest', 'outcomeProfile'])
    || !hex(value.taskFamily.goalDefinitionDigest) || !exact(value.taskFamily.outcomeProfile, ['id', 'version', 'digest'])
    || typeof value.taskFamily.outcomeProfile.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value.taskFamily.outcomeProfile.id)
    || typeof value.taskFamily.outcomeProfile.version !== 'number' || !Number.isSafeInteger(value.taskFamily.outcomeProfile.version) || value.taskFamily.outcomeProfile.version < 1 || !hex(value.taskFamily.outcomeProfile.digest)) fail('invalid canary admission')
}
export function canaryAdmissionMatches(value: unknown, baseline: SkillDefinition, candidate: SkillDefinition): value is CanaryAdmission {
  try {
    validateCanaryAdmission(value)
    return value.skillName === baseline.name && value.skillName === candidate.name
      && value.parentDefinitionDigest === digest(baseline) && value.candidateDefinitionDigest === digest(candidate)
      && value.taskFamily.goalDefinitionDigest === candidate.source.goal.definition.digest
  } catch { return false }
}
function binding(scope: GoalScope, baseline: SkillDefinition, candidate: SkillDefinition, execution: HoldoutExecutionConfig, inputs: Readonly<Record<string, unknown>>, files: readonly { path: string; content: string }[], canaryAdmission?: CanaryAdmission) {
  const limits = { maxToolCalls: execution.maxToolCalls, maxOutputBytes: execution.maxOutputBytes }
  return { scopeDigest: digest(scope), baselineDigest: digest(baseline), candidateDigest: digest(candidate),
    budgetDigest: digest({ inputsDigest: digest(inputs), filesDigest: digest(files), image: execution.image, dockerPath: execution.dockerPath, command: execution.command, artifactPath: execution.artifactPath, expiresAt: execution.expiresAt,
      repeats: execution.repeats, maxToolCalls: execution.maxToolCalls, maxBytes: execution.maxBytes, maxOutputBytes: execution.maxOutputBytes, cellDurationMs: execution.cellDurationMs, verificationDurationMs: execution.verificationDurationMs }),
    expiresAt: execution.expiresAt, repeats: execution.repeats, ...(canaryAdmission === undefined ? {} : { admissionDigest: digest(canaryAdmission) }), limits }
}
function validBegin(value: unknown, expected: ReturnType<typeof binding>, pinnedPublicKey: string): value is BeginResult {
  if (!plain(value)) return false
  const data = value as unknown as BeginResult
  const hasAdmission = Object.hasOwn(data, 'admissionDigest')
  if (typeof data.sessionId !== 'string' || data.sessionId.length === 0 || !hex(data.planDigest) || !hex(data.datasetDigest) || data.publicKey !== pinnedPublicKey || data.scopeDigest !== expected.scopeDigest
    || hasAdmission !== (expected.admissionDigest !== undefined) || data.baselineDigest !== expected.baselineDigest || data.candidateDigest !== expected.candidateDigest || data.budgetDigest !== expected.budgetDigest || data.admissionDigest !== expected.admissionDigest || data.expiresAt !== expected.expiresAt || data.repeats !== expected.repeats
    || !same(data.limits, expected.limits) || !Number.isSafeInteger(data.cellCount) || data.cellCount < 6 || data.cellCount > 96) return false
  return true
}
function validCell(value: unknown, begin: BeginResult, seen: ReadonlyMap<string, unknown>, lastCell: number, maxBytes: number): value is SignedCell {
  if (!plain(value) || value.sessionId !== begin.sessionId || value.planDigest !== begin.planDigest || !cellId(value.cellId) || seen.has(value.cellId) || (value.armDigest !== begin.baselineDigest && value.armDigest !== begin.candidateDigest)
    || Number(value.cellId.slice(5)) !== lastCell + 1 || Number(value.cellId.slice(5)) > begin.cellCount || typeof value.stdin !== 'string' || Buffer.byteLength(value.stdin, 'utf8') > maxBytes || typeof value.signature !== 'string') return false
  return verifyHoldoutSignature(value, begin.publicKey)
}
function toolCalls(replay: ReplayResult, definition: SkillDefinition) {
  const observations = fileObservationSteps(definition).map(value => ({ id: value.id, toolName: 'read', arguments: { file_path: value.filePath, limit: 1 } }))
  return replay.steps.map(step => {
    const source = [...definition.steps, ...observations].find(value => value.id === step.id)
    if (source === undefined) return fail('replay step is not in immutable trace')
    const inputDigest = digest({ id: source.id, toolName: source.toolName, arguments: source.arguments })
    return step.outcome === 'executed' ? { name: step.toolName, inputDigest, outputDigest: step.resultDigest } : { name: step.toolName, inputDigest }
  })
}
function validReceipt(value: unknown, begin: BeginResult, seen: ReadonlyMap<string, string>): value is HoldoutReceipt {
  if (!plain(value)) return false
  const data = value as unknown as HoldoutReceipt
  const hasAdmission = Object.hasOwn(data, 'admissionDigest')
  if (!verifyHoldoutSignature(data as unknown as Record<string, unknown>, begin.publicKey) || data.sessionId !== begin.sessionId || data.planDigest !== begin.planDigest || data.datasetDigest !== begin.datasetDigest || data.publicKey !== begin.publicKey
    || hasAdmission !== Object.hasOwn(begin, 'admissionDigest') || data.scopeDigest !== begin.scopeDigest || data.baselineDigest !== begin.baselineDigest || data.candidateDigest !== begin.candidateDigest || data.budgetDigest !== begin.budgetDigest || data.admissionDigest !== begin.admissionDigest
    || data.expiresAt !== begin.expiresAt || data.repeats !== begin.repeats || !same(data.limits, begin.limits) || data.cellCount !== begin.cellCount || typeof data.complete !== 'boolean'
    || !same(data.prospective ?? null, begin.prospective ?? null)
    || !Array.isArray(data.cellVerdicts) || data.cellVerdicts.length !== begin.cellCount || !hex(data.observationDigest) || typeof data.signature !== 'string') return false
  const ids = new Set<string>(), pairs = new Map<string, Set<string>>(), kinds = new Set<string>()
  return data.cellVerdicts.every(cell => {
    if (!plain(cell)) return false
    const item = cell as unknown as { cellId: unknown; armDigest: unknown; caseId: unknown; kind: unknown; repeat: unknown; verdict: unknown; observationDigest?: unknown }
    const repeat = item.repeat
    const issued = typeof item.cellId === 'string' ? seen.get(item.cellId) : undefined
    const pair = `${item.caseId}\u0000${repeat}`; const arms = pairs.get(pair) ?? new Set<string>(); arms.add(String(item.armDigest)); pairs.set(pair, arms); kinds.add(String(item.kind))
    return cellId(item.cellId) && !ids.has(item.cellId) && (issued === item.armDigest || issued === undefined && item.verdict === 'unknown' && item.observationDigest === undefined)
      && (item.armDigest === begin.baselineDigest || item.armDigest === begin.candidateDigest) && typeof item.caseId === 'string' && ['replay', 'evaluation', 'regression'].includes(String(item.kind))
      && typeof repeat === 'number' && Number.isSafeInteger(repeat) && repeat >= 1 && repeat <= begin.repeats && ['achieved', 'not-achieved', 'unknown'].includes(String(item.verdict))
      && (item.observationDigest === undefined || hex(item.observationDigest)) && (ids.add(item.cellId), true)
  }) && ids.size === begin.cellCount && pairs.size * 2 === begin.cellCount && kinds.size === 3 && [...pairs.values()].every(arms => arms.size === 2 && arms.has(begin.baselineDigest) && arms.has(begin.candidateDigest))
}
function quality(receipt: HoldoutReceipt): HoldoutQualificationResult['quality'] {
  const rate = (kind: string, arm: string) => { const cells = receipt.cellVerdicts.filter(cell => cell.kind === kind && cell.armDigest === arm); return cells.length ? cells.filter(cell => cell.verdict === 'achieved').length / cells.length : 0 }
  const complete = receipt.complete && receipt.cellVerdicts.every(cell => cell.verdict !== 'unknown')
  const evaluationGain = complete ? rate('evaluation', receipt.candidateDigest) - rate('evaluation', receipt.baselineDigest) : null
  return { candidateChecksPassed: complete && receipt.cellVerdicts.filter(cell => cell.armDigest === receipt.candidateDigest).every(cell => cell.verdict === 'achieved'), evaluationGain,
    evaluationGainObserved: evaluationGain !== null && evaluationGain > 0, criticalRegressionsPassed: complete && receipt.cellVerdicts.filter(cell => cell.kind === 'regression' && cell.armDigest === receipt.candidateDigest).every(cell => cell.verdict === 'achieved'), heldoutIndependence: 'unproven' }
}

export type ProspectiveQualificationContext = Pick<HoldoutQualificationInput, 'scope' | 'baseline' | 'candidate' | 'execution' | 'inputs' | 'files' | 'pinnedPublicKey' | 'canaryAdmission'> & { readonly expectedGeneratorDigest: string }

function prospectiveBinding(begin: BeginResult, frozen: ReturnType<typeof binding>, key: string, generator: string): boolean {
  const { limits: _limits, ...expected } = frozen
  return verifyProspectiveCertificate(begin.prospective, expected, key, generator) && begin.prospective.datasetDigest === begin.datasetDigest
}

/** Reinspect a privately persisted qualification against the current exact profile and definitions.
 * The caller must obtain the result from its trusted comparison store, never model arguments.
 * Quality is recomputed from signed verdicts; the certificate attests generation order, not training history.
 */
export function inspectProspectiveQualification(value: unknown, input: ProspectiveQualificationContext): HoldoutQualificationResult | undefined {
  try {
    if (!plain(value) || value.modelCalls !== 0 || value.promotionAuthorized !== false || value.execution !== 'native-file-tools-and-isolated-artifact'
      || !hex(input.expectedGeneratorDigest)) return undefined
    const admissionDigest = input.canaryAdmission === undefined ? undefined : digest(input.canaryAdmission)
    if (input.canaryAdmission === undefined ? Object.hasOwn(value, 'admissionDigest')
      : !canaryAdmissionMatches(input.canaryAdmission, input.baseline, input.candidate) || !Object.hasOwn(value, 'admissionDigest') || value.admissionDigest !== admissionDigest) return undefined
    validateHoldoutExecution(input.execution)
    if (input.execution.expiresAt <= Date.now() || digest(input.baseline.source.scope) !== digest(input.scope) || digest(input.candidate.source.scope) !== digest(input.scope)) return undefined
    const frozen = binding(input.scope, input.baseline, input.candidate, input.execution, input.inputs ?? {}, input.files ?? [], input.canaryAdmission)
    const receipt = value.receipt
    if (!validBegin(receipt, frozen, input.pinnedPublicKey) || !prospectiveBinding(receipt, frozen, input.pinnedPublicKey, input.expectedGeneratorDigest)
      || !Array.isArray((receipt as HoldoutReceipt).cellVerdicts)) return undefined
    const saved = receipt as HoldoutReceipt
    const seen = new Map(saved.cellVerdicts.map(cell => [cell.cellId, cell.armDigest]))
    if (!validReceipt(saved, receipt, seen)) return undefined
    return { receipt: clone(saved), quality: quality(saved), modelCalls: 0, promotionAuthorized: false, execution: 'native-file-tools-and-isolated-artifact', prospectiveHoldout: 'authority-attested-after-freeze',
      ...(admissionDigest === undefined ? {} : { admissionDigest }) }
  } catch { return undefined }
}

/** Host-only coordinator: the authority supplies signed private inputs and judges every submitted observation. */
export async function qualifyHoldout(input: HoldoutQualificationInput): Promise<HoldoutQualificationResult> {
  if (!input || !input.signal || typeof input.authorize !== 'function' || !input.transport || typeof input.transport.request !== 'function' || typeof input.pinnedPublicKey !== 'string' || input.pinnedPublicKey.length === 0
    || (input.expectedDatasetDigest === undefined) === (input.expectedGeneratorDigest === undefined) || !hex(input.expectedDatasetDigest ?? input.expectedGeneratorDigest)) fail('invalid input')
  const pinnedPublicKey = input.pinnedPublicKey
  const expectedDatasetDigest = input.expectedDatasetDigest
  const expectedGeneratorDigest = input.expectedGeneratorDigest
  const canaryAdmission = input.canaryAdmission === undefined ? undefined : clone(input.canaryAdmission)
  const execution = clone(input.execution); const scope = clone(input.scope); const inputs = clone(input.inputs ?? {}); const files = clone(input.files ?? [])
  if (!plain(scope) || typeof scope.principalId !== 'string' || typeof scope.principalRecordId !== 'string' || !Number.isSafeInteger(scope.principalVersion) || scope.principalVersion < 1 || typeof scope.workspace !== 'string' || !isAbsolute(scope.workspace) || typeof scope.preset !== 'string') fail('invalid qualification scope')
  validateHoldoutExecution(execution); if (execution.expiresAt <= Date.now()) fail('qualification expired')
  separated(scope.workspace, execution.stateRoot); assertPrivateRoot(execution.stateRoot); separated(scope.workspace, execution.stateRoot)
  const arms = clone({ baseline: input.baseline, candidate: input.candidate }) as { baseline: SkillDefinition; candidate: SkillDefinition }
  const scopeDigest = digest(scope)
  if (digest(arms.baseline.source.scope) !== scopeDigest || digest(arms.candidate.source.scope) !== scopeDigest) fail('definition scope does not exactly match qualification scope')
  if (canaryAdmission !== undefined && (expectedGeneratorDigest === undefined || !canaryAdmissionMatches(canaryAdmission, arms.baseline, arms.candidate))) fail('canary admission does not match exact definitions')
  const materialized = { baseline: instantiate(arms.baseline, inputs), candidate: instantiate(arms.candidate, inputs) }
  for (const definition of Object.values(materialized)) validateReplayTrace(definition, execution.maxToolCalls, execution.maxBytes)
  const frozen = binding(scope, arms.baseline, arms.candidate, execution, inputs, files, canaryAdmission)
  const revalidate = () => { input.signal.throwIfAborted(); if (Date.now() >= execution.expiresAt) fail('qualification expired'); separated(scope.workspace, execution.stateRoot); assertPrivateRoot(execution.stateRoot); separated(scope.workspace, execution.stateRoot); input.authorize() }
  revalidate()
  const { limits: _limits, ...authorityBinding } = frozen
  const beginValue = await request<unknown>(input.transport, 'begin', authorityBinding, input.signal, execution.expiresAt, execution.cellDurationMs)
  if (!validBegin(beginValue, frozen, pinnedPublicKey)) fail('begin binding or pinned key is invalid')
  const begin = beginValue as BeginResult
  if (expectedDatasetDigest !== undefined && begin.datasetDigest !== expectedDatasetDigest) fail('dataset does not match the pinned plan')
  if (expectedGeneratorDigest !== undefined && !prospectiveBinding(begin, frozen, pinnedPublicKey, expectedGeneratorDigest)) fail('prospective certificate does not match the frozen plan')
  revalidate()
  const { IsolatedVerifierRunner } = await import('@dsh-enhanced/assistant-isolation')
  const runner = new IsolatedVerifierRunner({ stateRoot: join(execution.stateRoot, 'verification'), image: execution.image, dockerPath: execution.dockerPath,
    authorityDigest: digest({ protocol: 'assistant-skills/holdout-qualification/v1', binding: frozen }), command: execution.command, expiresAt: execution.expiresAt,
    maxRuns: begin.cellCount, maxTotalDurationMs: begin.cellCount * execution.verificationDurationMs, maxDurationMs: execution.verificationDurationMs, maxOutputBytes: execution.maxOutputBytes })
  const seen = new Map<string, string>()
  try {
    while (true) {
      revalidate(); const next = await request<unknown>(input.transport, 'next', undefined, input.signal, execution.expiresAt, execution.cellDurationMs)
      if (next === null || next === undefined) break
      if (!validCell(next, begin, seen, seen.size, execution.maxBytes)) fail('next cell signature or binding is invalid')
      const signed = next as SignedCell
      seen.set(signed.cellId, signed.armDigest)
      const originalArm = signed.armDigest === begin.baselineDigest ? arms.baseline : arms.candidate
      const executedArm = signed.armDigest === begin.baselineDigest ? materialized.baseline : materialized.candidate
      const cellSignal = AbortSignal.any([input.signal, AbortSignal.timeout(execution.cellDurationMs)])
      const replay = await replaySkill({ definition: originalArm, inputs, files, artifactPath: execution.artifactPath, stateRoot: execution.stateRoot,
        maxToolCalls: execution.maxToolCalls, maxBytes: execution.maxBytes, signal: cellSignal, authorize: revalidate })
      revalidate()
      const observed = await runner.run(`${begin.sessionId}:${signed.cellId}`, replay.artifact, signed.stdin, cellSignal)
      revalidate()
      const recorded = await request<unknown>(input.transport, 'record', { cellId: signed.cellId, armDigest: signed.armDigest, stdout: observed.stdout, exitCode: observed.exitCode ?? null, quiescent: observed.quiescent,
        status: observed.status === 'succeeded' ? 'completed' : observed.status === 'failed' ? 'failed' : 'unknown', artifactDigest: digest(replay.artifact), toolCalls: toolCalls(replay, executedArm) }, input.signal, execution.expiresAt, execution.cellDurationMs)
      if (!['achieved', 'not-achieved', 'unknown'].includes(String(recorded))) fail('authority record verdict is invalid')
      if (recorded === 'unknown' || !observed.quiescent || observed.status === 'unknown' || observed.status === 'cancelled' || observed.status === 'timed-out') break
    }
    revalidate(); const receiptValue = await request<unknown>(input.transport, 'finish', undefined, input.signal, execution.expiresAt, execution.cellDurationMs)
    if (!validReceipt(receiptValue, begin, seen)) fail('receipt signature or binding is invalid')
    const receipt = receiptValue as HoldoutReceipt
    return { receipt, quality: quality(receipt), modelCalls: 0, promotionAuthorized: false, execution: 'native-file-tools-and-isolated-artifact',
      ...(expectedGeneratorDigest === undefined ? {} : { prospectiveHoldout: 'authority-attested-after-freeze' as const }),
      ...(canaryAdmission === undefined ? {} : { admissionDigest: digest(canaryAdmission) }) }
  } finally { await runner.close() }
}
