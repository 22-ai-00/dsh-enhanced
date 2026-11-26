import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { GoalScope } from '@dsh-ray/assistant-goals'
import { acceptanceDigest } from '@dsh-ray/task-acceptance-contract'
import type {
  SkillCompensationDirective,
  SkillCompensationKind,
  SkillCompensationStepSpec,
  SkillDefinition,
  SkillStep,
} from './definition.js'
import type { SkillCompensationRecord, SkillRunStep, SkillStore } from './store.js'
import { extractPatchAffectedPaths } from './patch-paths.js'
import { executeNestedTool } from './tool-batch.js'

const MAX_PREIMAGE_BYTES = 256 * 1024
export const NON_MUTATING_OBSERVATION_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'get_goal',
  'wiki_search',
  'wiki_read',
  'wiki_lint',
  'memory_search',
  'memory_search_confirmed',
  'memory_read_evidence',
  'work_item_list',
  'work_item_read_context',
  'work_item_read_source',
  'work_item_status',
  'action_github_grants',
  'action_github_inspect',
  'action_broker_grants',
  'isolation_grants',
])

export type ApplyPatchOutcomeInspection = 'completed' | 'partial-failed' | 'partial-unknown'

export function inspectApplyPatchValue(value: unknown): ApplyPatchOutcomeInspection {
  if (value === null || typeof value !== 'object') return 'completed'
  const record = value as { cancelled?: unknown; operations?: unknown }
  if (Array.isArray(record.operations)) {
    if (record.operations.some(op => op !== null && typeof op === 'object' && (op as { status?: unknown }).status === 'unknown')) {
      return 'partial-unknown'
    }
    if (record.cancelled === true) return 'partial-failed'
    if (record.operations.some(op => op !== null && typeof op === 'object' && (op as { status?: unknown }).status !== 'completed')) {
      return 'partial-failed'
    }
    return 'completed'
  }
  return record.cancelled === true ? 'partial-failed' : 'completed'
}

export function isNonMutatingStep(step: Pick<SkillStep, 'toolName' | 'arguments'>): boolean {
  if (NON_MUTATING_OBSERVATION_TOOLS.has(step.toolName)) return true
  if (!step.arguments || typeof step.arguments !== 'object' || Array.isArray(step.arguments)) return false
  const action = (step.arguments as { action?: unknown }).action
  if (step.toolName === 'action_calendar_action') {
    return action === 'calendar.list-events' || action === 'calendar.get-event'
  }
  if (step.toolName === 'action_lark_action') {
    return action === 'lark.read-messages'
  }
  return false
}

export interface RecoveryCompensationExecutionRequest {
  readonly idempotencyKey: string
  readonly kind: string
  readonly target: Readonly<Record<string, unknown>>
  readonly forwardActionId?: string
  readonly scope?: GoalScope
  readonly sourcePlugin?: 'dsh-ray-assistant-skills'
  readonly runId?: string
  readonly stepId?: string
  readonly preimage?: Readonly<Record<string, unknown>>
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface RecoveryCompensationExecutionResult {
  readonly id?: string
  readonly idempotencyKey?: string
  readonly kind?: string
  readonly status: 'succeeded' | 'failed' | 'unknown'
  readonly resultCode: string
  readonly preimageDigest?: string
  readonly receipt?: Readonly<Record<string, unknown>>
  readonly receiptDigest?: string
  readonly reason?: string
  readonly replayed?: boolean
  readonly settledAt?: number
}

export interface AssistantRecoveryCompensationPort {
  executeCompensation(
    record: RecoveryCompensationExecutionRequest,
    options?: {
      readonly signal?: AbortSignal
      readonly timeoutMs?: number
      readonly authorize?: () => boolean | Promise<boolean>
    },
  ): Promise<RecoveryCompensationExecutionResult>
  hasCompensator?(kind: string): boolean
}

export type SkillCompensationHandler = (
  context: {
    readonly compensationId: string
    readonly idempotencyKey: string
    readonly compensatorKey: string
    readonly scope: GoalScope
    readonly runId: string
    readonly stepId: string
    readonly step: SkillStep
    readonly preimage?: CapturedPreimage
    readonly signal: AbortSignal
  },
) => Promise<RecoveryCompensationExecutionResult> | RecoveryCompensationExecutionResult

export interface CapturedPreimage {
  readonly existed: boolean
  readonly filePath: string
  readonly resolvedPath: string
  readonly content?: string
  readonly files?: readonly CapturedPreimage[]
  readonly snapshot?: Readonly<Record<string, unknown>>
  readonly digest: string
}

function isContainedRelativePath(rel: string): boolean {
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function resolveContainedWorkspaceFile(
  workspace: string,
  rawFilePath: string,
  options?: { readonly allowNonDirectoryParentForAbsent?: boolean },
): Promise<string> {
  if (typeof rawFilePath !== 'string' || rawFilePath === '' || rawFilePath.includes('\0')) {
    throw new Error('assistant-skills: invalid file path for preimage capture')
  }
  const workspaceAbs = resolve(workspace)
  let workspaceReal: string
  try {
    const wsStat = await lstat(workspaceAbs)
    if (wsStat.isSymbolicLink() || !wsStat.isDirectory()) {
      throw new Error('assistant-skills: symlinked or non-directory workspace root rejected')
    }
    workspaceReal = await realpath(workspaceAbs)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      workspaceReal = workspaceAbs
    } else {
      throw error
    }
  }
  let rel: string
  if (isAbsolute(rawFilePath)) {
    const resolvedRaw = resolve(rawFilePath)
    const relFromAbs = relative(workspaceAbs, resolvedRaw)
    const relFromReal = relative(workspaceReal, resolvedRaw)
    if (isContainedRelativePath(relFromAbs)) {
      rel = relFromAbs
    } else if (isContainedRelativePath(relFromReal)) {
      rel = relFromReal
    } else {
      throw new Error('assistant-skills: preimage path escapes workspace')
    }
  } else {
    rel = rawFilePath
  }
  const candidate = resolve(workspaceReal, rel)
  const relReal = relative(workspaceReal, candidate)
  if (!isContainedRelativePath(relReal)) {
    throw new Error('assistant-skills: preimage path escapes workspace')
  }
  const segments = relReal.split(sep).filter(Boolean)
  let cursor = workspaceReal
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!
    cursor = resolve(cursor, segment)
    try {
      const stat = await lstat(cursor)
      if (stat.isSymbolicLink()) {
        throw new Error('assistant-skills: symlink rejected during preimage capture')
      }
      if (index < segments.length - 1 && !stat.isDirectory()) {
        if (options?.allowNonDirectoryParentForAbsent && stat.isFile()) {
          return candidate
        }
        throw new Error('assistant-skills: non-directory parent rejected during preimage capture')
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        break
      }
      throw error
    }
  }
  return candidate
}

type RollbackTargetCheck =
  | { readonly ok: true; readonly safePath: string; readonly existed: boolean }
  | { readonly ok: false; readonly detail: 'rollback-target-unsafe' }

async function verifyRollbackTargetPath(
  workspace: string,
  preimage: CapturedPreimage,
  options: {
    readonly allowAbsent: boolean
    readonly allowAncestorDirectoryCollision?: boolean
  },
): Promise<RollbackTargetCheck> {
  try {
    const safePath = await resolveContainedWorkspaceFile(workspace, preimage.filePath, {
      allowNonDirectoryParentForAbsent: options.allowAbsent && !preimage.existed,
    })
    if (safePath !== preimage.resolvedPath) {
      return { ok: false, detail: 'rollback-target-unsafe' }
    }
    const workspaceReal = await realpath(resolve(workspace))
    try {
      const stat = await lstat(safePath)
      if (!stat.isSymbolicLink() && stat.isDirectory() && options.allowAncestorDirectoryCollision === true && !preimage.existed) {
        const targetReal = await realpath(safePath)
        const rel = relative(workspaceReal, targetReal)
        if (targetReal !== safePath || !isContainedRelativePath(rel)) {
          return { ok: false, detail: 'rollback-target-unsafe' }
        }
        return { ok: true, safePath, existed: false }
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return { ok: false, detail: 'rollback-target-unsafe' }
      }
      const targetReal = await realpath(safePath)
      if (targetReal !== safePath) {
        return { ok: false, detail: 'rollback-target-unsafe' }
      }
      return { ok: true, safePath, existed: true }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if ((code === 'ENOENT' || (code === 'ENOTDIR' && !preimage.existed)) && options.allowAbsent) {
        let ancestor = dirname(safePath)
        while (true) {
          try {
            const ancestorStat = await lstat(ancestor)
            if (ancestorStat.isSymbolicLink() || (!ancestorStat.isDirectory() && !(code === 'ENOTDIR' && ancestorStat.isFile()))) {
              return { ok: false, detail: 'rollback-target-unsafe' }
            }
            const ancestorReal = await realpath(ancestor)
            const rel = relative(workspaceReal, ancestorReal)
            if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
              return { ok: false, detail: 'rollback-target-unsafe' }
            }
            if (code === 'ENOTDIR' && ancestorStat.isFile()) {
              if (ancestor === workspaceReal || ancestor === dirname(ancestor)) {
                break
              }
              ancestor = dirname(ancestor)
              continue
            }
            break
          } catch (ancestorError) {
            const ancCode = ancestorError && typeof ancestorError === 'object' && 'code' in ancestorError ? ancestorError.code : undefined
            if (ancCode === 'ENOENT' || (ancCode === 'ENOTDIR' && code === 'ENOTDIR')) {
              if (ancestor === workspaceReal || ancestor === dirname(ancestor)) {
                return { ok: false, detail: 'rollback-target-unsafe' }
              }
              ancestor = dirname(ancestor)
              continue
            }
            return { ok: false, detail: 'rollback-target-unsafe' }
          }
        }
        return { ok: true, safePath, existed: false }
      }
      return { ok: false, detail: 'rollback-target-unsafe' }
    }
  } catch {
    return { ok: false, detail: 'rollback-target-unsafe' }
  }
}

async function captureSingleFilePreimage(
  workspace: string,
  rawPath: string,
): Promise<CapturedPreimage> {
  const resolvedPath = await resolveContainedWorkspaceFile(workspace, rawPath)
  try {
    const stat = await lstat(resolvedPath)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('assistant-skills: preimage target must be a regular non-symlink file')
    }
    if (stat.size > MAX_PREIMAGE_BYTES) {
      throw new Error('assistant-skills: preimage exceeds 256 KiB bound')
    }
    const content = await readFile(resolvedPath, 'utf8')
    if (Buffer.byteLength(content, 'utf8') > MAX_PREIMAGE_BYTES) {
      throw new Error('assistant-skills: preimage exceeds 256 KiB bound')
    }
    return Object.freeze({
      existed: true,
      filePath: rawPath,
      resolvedPath,
      content,
      digest: acceptanceDigest({ existed: true, filePath: rawPath, content }),
    })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return Object.freeze({
        existed: false,
        filePath: rawPath,
        resolvedPath,
        digest: acceptanceDigest({ existed: false, filePath: rawPath }),
      })
    }
    throw error
  }
}

export async function capturePreimageForStep(
  workspace: string,
  step: SkillStep,
  options?: { readonly capturePreimage?: boolean; readonly targetSnapshot?: Readonly<Record<string, unknown>> },
): Promise<CapturedPreimage | undefined> {
  if (!step.arguments || typeof step.arguments !== 'object' || Array.isArray(step.arguments)) return undefined
  if (step.toolName === 'write' || step.toolName === 'edit') {
    const rawPath = (step.arguments as { file_path?: unknown }).file_path
    if (typeof rawPath !== 'string') return undefined
    return captureSingleFilePreimage(workspace, rawPath)
  }
  if (step.toolName === 'apply_patch') {
    const patchInput = (step.arguments as { input?: unknown }).input
    if (typeof patchInput !== 'string') return undefined
    const paths = extractPatchAffectedPaths(patchInput)
    if (paths.length === 0) return undefined
    const files: CapturedPreimage[] = []
    let totalBytes = 0
    for (const rawPath of paths) {
      const entry = await captureSingleFilePreimage(workspace, rawPath)
      if (entry.content !== undefined) {
        totalBytes += Buffer.byteLength(entry.content, 'utf8')
        if (totalBytes > MAX_PREIMAGE_BYTES) {
          throw new Error('assistant-skills: multi-file preimage exceeds 256 KiB bound')
        }
      }
      files.push(entry)
    }
    const primary = files[0]!
    return Object.freeze({
      existed: primary.existed,
      filePath: primary.filePath,
      resolvedPath: primary.resolvedPath,
      ...(primary.content === undefined ? {} : { content: primary.content }),
      files: Object.freeze(files),
      digest: acceptanceDigest({
        kind: 'apply_patch',
        files: files.map(file => ({ existed: file.existed, filePath: file.filePath, digest: file.digest })),
      }),
    })
  }
  if (options?.capturePreimage === true && !isNonMutatingStep(step)) {
    const argsCopy = JSON.parse(JSON.stringify(step.arguments)) as Record<string, unknown>
    const snapshot = Object.freeze({
      toolName: step.toolName,
      stepId: step.id,
      arguments: argsCopy,
      ...(options.targetSnapshot === undefined
        ? {}
        : { target: JSON.parse(JSON.stringify(options.targetSnapshot)) as Record<string, unknown> }),
    })
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_PREIMAGE_BYTES) {
      throw new Error('assistant-skills: snapshot preimage exceeds 256 KiB bound')
    }
    return Object.freeze({
      existed: true,
      filePath: '',
      resolvedPath: '',
      snapshot,
      digest: acceptanceDigest(snapshot),
    })
  }
  return undefined
}

export function resolveRecoveryCompensationPort(
  ctx: Context,
): AssistantRecoveryCompensationPort | undefined {
  const comp = ctx.get('assistantCompensation' as never, false) as unknown as Partial<AssistantRecoveryCompensationPort> | undefined
  if (comp && typeof comp.executeCompensation === 'function') {
    return comp as AssistantRecoveryCompensationPort
  }
  const recovery = ctx.get('assistantRecovery' as never, false) as unknown as Partial<AssistantRecoveryCompensationPort> | undefined
  if (recovery && typeof recovery.executeCompensation === 'function') {
    return recovery as AssistantRecoveryCompensationPort
  }
  return undefined
}

function stepCompensationIdempotencyKey(
  scope: GoalScope,
  runId: string,
  stepId: string,
  kind: Exclude<SkillCompensationKind, 'stop-and-report'>,
  preimageDigest: string | undefined,
): string {
  return `skill-comp:v1:${acceptanceDigest([scope, runId, stepId, kind, preimageDigest ?? null])}`
}

export function recordSkippedUnknownCompensation(input: {
  readonly store: SkillStore
  readonly scope: GoalScope
  readonly runId: string
  readonly definition: SkillDefinition & { version: number }
  readonly steps: readonly SkillRunStep[]
}): readonly SkillCompensationRecord[] {
  if (input.definition.compensation === 'stop-and-report') return []
  const kind = input.definition.compensation
  const targetStep = [...input.steps]
    .reverse()
    .find(step => !step.id.startsWith('file-observation:'))
  const stepId = targetStep?.id ?? input.definition.steps[0]?.id ?? 'run'
  const idempotencyKey = stepCompensationIdempotencyKey(input.scope, input.runId, stepId, kind, undefined)
  const claimed = input.store.claimCompensation(input.scope, {
    runId: input.runId,
    skillName: input.definition.name,
    version: input.definition.version,
    stepId,
    compensationKind: kind,
    idempotencyKey,
  })
  if (!claimed.claimed) return input.store.listCompensations(input.scope, input.runId)
  input.store.finishCompensation(
    input.scope,
    claimed.record.id,
    'skipped-unknown',
    'unknown-execution-state-no-speculative-compensation',
  )
  return input.store.listCompensations(input.scope, input.runId)
}

export async function compensateFailedSkillRun(input: {
  readonly ctx: Context
  readonly store: SkillStore
  readonly scope: GoalScope
  readonly runId: string
  readonly definition: SkillDefinition & { version: number }
  readonly directive: SkillCompensationDirective
  readonly completed: readonly SkillRunStep[]
  readonly preimages: ReadonlyMap<string, CapturedPreimage>
  readonly allowedTools: readonly string[]
  readonly toolsCtx: Context | undefined
  readonly exec: ToolRunContext
  readonly signal: AbortSignal
  readonly localHandlers: ReadonlyMap<string, SkillCompensationHandler>
  readonly settle?: <T>(work: Promise<T>) => Promise<T>
}): Promise<readonly SkillCompensationRecord[]> {
  if (!input.directive.executeCompensation || input.definition.compensation === 'stop-and-report') {
    return []
  }
  const runAsync = input.settle ?? (<T>(work: Promise<T>): Promise<T> => work)
  const kind = input.definition.compensation
  const executableCompleted = input.completed.filter(step => !step.id.startsWith('file-observation:'))
  if (executableCompleted.some(step => step.state === 'unknown')) {
    return recordSkippedUnknownCompensation({
      store: input.store,
      scope: input.scope,
      runId: input.runId,
      definition: input.definition,
      steps: input.completed,
    })
  }

  const stepById = new Map(input.definition.steps.map(step => [step.id, step]))
  const hasExplicitPlan = input.definition.compensationPlan !== undefined
  const planByStepId = new Map<string, SkillCompensationStepSpec>(
    (input.definition.compensationPlan?.entries ?? []).map(entry => [entry.stepId, entry]),
  )
  const rollbackCandidates = [...executableCompleted].reverse().filter(completedStep => {
    if (completedStep.state === 'succeeded') return true
    if (completedStep.state === 'failed') {
      const defStep = stepById.get(completedStep.id)
      return defStep?.toolName === 'apply_patch' && input.preimages.has(completedStep.id)
    }
    return false
  })

  for (const completedStep of rollbackCandidates) {
    const step = stepById.get(completedStep.id)
    if (!step) continue
    const spec = planByStepId.get(step.id)
    if (kind === 'rollback-state') {
      if (isNonMutatingStep(step)) continue
    } else if (kind === 'compensating-action') {
      if (spec === undefined) continue
    } else {
      if (hasExplicitPlan && spec === undefined) continue
      if (!hasExplicitPlan && isNonMutatingStep(step)) continue
    }
    const preimage = input.preimages.get(step.id)
    const compensatorKey = kind === 'compensate-via-registry'
      ? spec?.compensatorKey ?? `skill.${input.definition.name}.${step.id}`
      : undefined
    const toolName = kind === 'compensating-action'
      ? spec?.toolName
      : kind === 'rollback-state' && (preimage?.existed === true || preimage?.files?.some(entry => entry.existed) === true)
        ? (input.allowedTools.includes('write') ? 'write' : input.allowedTools.includes('apply_patch') ? 'apply_patch' : input.allowedTools.includes('edit') ? 'edit' : 'write')
        : undefined
    const idempotencyKey = stepCompensationIdempotencyKey(
      input.scope,
      input.runId,
      step.id,
      kind,
      preimage?.digest,
    )

    const claimed = input.store.claimCompensation(input.scope, {
      runId: input.runId,
      skillName: input.definition.name,
      version: input.definition.version,
      stepId: step.id,
      compensationKind: kind,
      idempotencyKey,
      ...(compensatorKey === undefined ? {} : { compensatorKey }),
      ...(toolName === undefined ? {} : { toolName }),
      ...(preimage === undefined ? {} : { preimageDigest: preimage.digest }),
    })

    if (!claimed.claimed) {
      if (claimed.record.status === 'pending') {
        input.store.finishCompensation(
          input.scope,
          claimed.record.id,
          'unknown',
          'interrupted-pending-compensation',
        )
      }
      continue
    }

    const compId = claimed.record.id
    try {
      if (input.signal.aborted) {
        input.store.finishCompensation(input.scope, compId, 'unknown', 'aborted-before-compensation')
        continue
      }

      if (kind === 'rollback-state') {
        if ((step.toolName !== 'write' && step.toolName !== 'edit' && step.toolName !== 'apply_patch') || preimage === undefined) {
          input.store.finishCompensation(input.scope, compId, 'failed', 'rollback-preimage-unavailable')
          continue
        }
        const isFailingApplyPatch = completedStep.state === 'failed' && step.toolName === 'apply_patch'
        const preimageFiles = preimage.files
        const entries = preimageFiles && preimageFiles.length > 0 ? [...preimageFiles].reverse() : [preimage]
        const verifiedEntries: { readonly entry: CapturedPreimage; readonly check: Extract<RollbackTargetCheck, { ok: true }> }[] = []
        let unsafeDetail: string | undefined
        for (const entry of entries) {
          const entryIndex = preimageFiles ? preimageFiles.indexOf(entry) : -1
          const allowAncestorDirectoryCollision = isFailingApplyPatch
            && preimageFiles !== undefined
            && !entry.existed
            && entryIndex > 0
            && preimageFiles.some((other, otherIndex) =>
              otherIndex < entryIndex && other.resolvedPath.startsWith(`${entry.resolvedPath}${sep}`),
            )
          const targetCheck = await verifyRollbackTargetPath(input.scope.workspace, entry, {
            allowAbsent: true,
            allowAncestorDirectoryCollision,
          })
          if (!targetCheck.ok) {
            unsafeDetail = targetCheck.detail
            break
          }
          verifiedEntries.push({ entry, check: targetCheck })
        }
        if (unsafeDetail !== undefined) {
          input.store.finishCompensation(input.scope, compId, 'failed', unsafeDetail)
          continue
        }

        let rollbackStatus: 'succeeded' | 'failed' | 'unknown' = 'succeeded'
        let rollbackCode = 'rollback-restored'
        for (const [entryIndex, { entry, check: targetCheck }] of verifiedEntries.entries()) {
          if (entry.existed) {
            if (input.allowedTools.includes('write') && input.toolsCtx !== undefined && input.exec.agent) {
              const callSuffix = verifiedEntries.length > 1 ? `:${entryIndex + 1}` : ''
              const result = await runAsync(executeNestedTool(input.toolsCtx, {
                callId: ToolCallId(`${input.exec.callId}:skill-comp:${step.id}${callSuffix}`),
                rootCallId: input.exec.rootCallId,
                parent: input.exec.token,
                ...(input.exec.toolSet === undefined ? {} : { toolSet: input.exec.toolSet }),
                agent: input.exec.agent,
                name: 'write',
                arguments: { file_path: entry.filePath, content: entry.content ?? '' },
                signal: input.signal,
              }))
              for (const context of result.additionalContexts ?? []) input.exec.deferContext(context)
              const code = result.isError ? result.error.info?.code ?? 'rollback-write-failed' : 'rollback-restored'
              const interrupted = input.signal.aborted || code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH'
              if (interrupted) {
                rollbackStatus = 'unknown'
                rollbackCode = code
                break
              }
              if (result.isError) {
                rollbackStatus = 'failed'
                rollbackCode = code
                break
              }
              let postWriteSafe = true
              try {
                if (
                  result.value !== null
                  && typeof result.value === 'object'
                  && 'path' in result.value
                  && typeof (result.value as { path?: unknown }).path === 'string'
                ) {
                  const reportedResolved = await resolveContainedWorkspaceFile(
                    input.scope.workspace,
                    (result.value as { path: string }).path,
                  )
                  if (reportedResolved !== targetCheck.safePath) {
                    postWriteSafe = false
                  }
                }
                const postStat = await lstat(targetCheck.safePath)
                const postReal = await realpath(targetCheck.safePath)
                if (postStat.isSymbolicLink() || !postStat.isFile() || postReal !== targetCheck.safePath) {
                  postWriteSafe = false
                }
              } catch {
                postWriteSafe = false
              }
              if (!postWriteSafe) {
                rollbackStatus = 'failed'
                rollbackCode = 'rollback-target-unsafe'
                break
              }
              rollbackCode = 'rollback-restored'
              continue
            }
            if (!input.allowedTools.includes('apply_patch') && !input.allowedTools.includes('edit')) {
              rollbackStatus = 'failed'
              rollbackCode = 'rollback-write-tool-unavailable'
              break
            }
            let directWriteSafe = true
            try {
              const rechecked = await verifyRollbackTargetPath(input.scope.workspace, entry, { allowAbsent: true })
              if (!rechecked.ok) {
                rollbackStatus = 'failed'
                rollbackCode = rechecked.detail
                break
              }
              await mkdir(dirname(rechecked.safePath), { recursive: true })
              const afterMkdir = await resolveContainedWorkspaceFile(input.scope.workspace, entry.filePath)
              if (afterMkdir !== rechecked.safePath) {
                rollbackStatus = 'failed'
                rollbackCode = 'rollback-target-unsafe'
                break
              }
              const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0)
              const handle = await open(rechecked.safePath, flags, 0o666)
              try {
                await handle.writeFile(entry.content ?? '', 'utf8')
              } finally {
                await handle.close()
              }
              const postStat = await lstat(rechecked.safePath)
              const postReal = await realpath(rechecked.safePath)
              if (postStat.isSymbolicLink() || !postStat.isFile() || postReal !== rechecked.safePath) {
                directWriteSafe = false
              }
            } catch {
              directWriteSafe = false
            }
            if (!directWriteSafe) {
              rollbackStatus = 'failed'
              rollbackCode = 'rollback-target-unsafe'
              break
            }
            rollbackCode = 'rollback-restored'
            continue
          }

          // entry.existed === false: remove newly created file if possible
          if (!targetCheck.existed) {
            rollbackCode = 'rollback-already-absent'
            continue
          }

          const localRemove = input.localHandlers.get('fs.remove-created-file')
          if (localRemove !== undefined) {
            const outcome = await runAsync(Promise.resolve(localRemove({
              compensationId: compId,
              idempotencyKey,
              compensatorKey: 'fs.remove-created-file',
              scope: input.scope,
              runId: input.runId,
              stepId: step.id,
              step,
              preimage: entry,
              signal: input.signal,
            })))
            rollbackStatus = outcome.status
            rollbackCode = outcome.resultCode
            if (rollbackStatus !== 'succeeded') break
            continue
          }

          const recoveryPort = resolveRecoveryCompensationPort(input.ctx)
          if (recoveryPort !== undefined && recoveryPort.hasCompensator?.('fs.remove-created-file') === true) {
            const removeKey = verifiedEntries.length > 1
              ? `${idempotencyKey}:file:${entryIndex + 1}`
              : idempotencyKey
            const outcome = await runAsync(recoveryPort.executeCompensation(
              {
                idempotencyKey: removeKey,
                kind: 'fs.remove-created-file',
                target: { filePath: entry.filePath, resolvedPath: entry.resolvedPath },
                forwardActionId: `${input.runId}:${step.id}`,
                scope: input.scope,
                sourcePlugin: 'dsh-ray-assistant-skills',
                runId: input.runId,
                stepId: step.id,
                preimage: { existed: false, filePath: entry.filePath, digest: entry.digest },
              },
              { signal: input.signal },
            ))
            rollbackStatus = outcome.status
            rollbackCode = outcome.resultCode
            if (rollbackStatus !== 'succeeded') break
            continue
          }

          if (!input.allowedTools.includes('write') && !input.allowedTools.includes('apply_patch')) {
            rollbackStatus = 'failed'
            rollbackCode = 'rollback-delete-denied'
            break
          }
          try {
            await unlink(targetCheck.safePath)
            rollbackCode = 'rollback-deleted-created-file'
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
              rollbackCode = 'rollback-already-absent'
            } else {
              rollbackStatus = 'unknown'
              rollbackCode = 'rollback-delete-unconfirmed'
              break
            }
          }
        }
        input.store.finishCompensation(input.scope, compId, rollbackStatus, rollbackCode)
        continue
      }

      if (kind === 'compensating-action') {
        if (!spec?.toolName || !input.allowedTools.includes(spec.toolName) || input.toolsCtx === undefined || !input.exec.agent) {
          input.store.finishCompensation(input.scope, compId, 'failed', 'compensating-action-unavailable')
          continue
        }
        const result = await runAsync(executeNestedTool(input.toolsCtx, {
          callId: ToolCallId(`${input.exec.callId}:skill-comp:${step.id}`),
          rootCallId: input.exec.rootCallId,
          parent: input.exec.token,
          ...(input.exec.toolSet === undefined ? {} : { toolSet: input.exec.toolSet }),
          agent: input.exec.agent,
          name: spec.toolName,
          arguments: spec.arguments,
          signal: input.signal,
        }))
        for (const context of result.additionalContexts ?? []) input.exec.deferContext(context)
        const code = result.isError ? result.error.info?.code ?? 'compensating-action-failed' : 'compensating-action-succeeded'
        const interrupted = input.signal.aborted || code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH'
        input.store.finishCompensation(
          input.scope,
          compId,
          interrupted ? 'unknown' : result.isError ? 'failed' : 'succeeded',
          code,
        )
        continue
      }

      // kind === 'compensate-via-registry'
      if (spec?.capturePreimage === true && preimage === undefined) {
        input.store.finishCompensation(input.scope, compId, 'failed', 'rollback-preimage-unavailable')
        continue
      }
      const key = compensatorKey!
      const localHandler = input.localHandlers.get(key)
      if (localHandler !== undefined) {
        const outcome = await runAsync(Promise.resolve(localHandler({
          compensationId: compId,
          idempotencyKey,
          compensatorKey: key,
          scope: input.scope,
          runId: input.runId,
          stepId: step.id,
          step,
          ...(preimage === undefined ? {} : { preimage }),
          signal: input.signal,
        })))
        input.store.finishCompensation(input.scope, compId, outcome.status, outcome.resultCode)
        continue
      }

      const recoveryPort = resolveRecoveryCompensationPort(input.ctx)
      if (recoveryPort === undefined) {
        input.store.finishCompensation(input.scope, compId, 'failed', 'compensation-registry-unavailable')
        continue
      }
      if (typeof recoveryPort.hasCompensator === 'function' && !recoveryPort.hasCompensator(key)) {
        input.store.finishCompensation(input.scope, compId, 'failed', 'handler-not-registered')
        continue
      }
      const outcome = await runAsync(recoveryPort.executeCompensation(
        {
          idempotencyKey,
          kind: key,
          target: {
            skillName: input.definition.name,
            version: input.definition.version,
            stepId: step.id,
            toolName: step.toolName,
            arguments: step.arguments as Readonly<Record<string, unknown>>,
          },
          forwardActionId: `${input.runId}:${step.id}`,
          scope: input.scope,
          sourcePlugin: 'dsh-ray-assistant-skills',
          runId: input.runId,
          stepId: step.id,
          ...(preimage === undefined
            ? {}
            : {
                preimage: {
                  existed: preimage.existed,
                  filePath: preimage.filePath,
                  digest: preimage.digest,
                  ...(preimage.content === undefined ? {} : { content: preimage.content }),
                  ...(preimage.snapshot === undefined ? {} : { snapshot: preimage.snapshot }),
                  ...(preimage.files === undefined
                    ? {}
                    : {
                        files: preimage.files.map(file => ({
                          existed: file.existed,
                          filePath: file.filePath,
                          digest: file.digest,
                          ...(file.content === undefined ? {} : { content: file.content }),
                        })),
                      }),
                },
              }),
        },
        { signal: input.signal },
      ))
      input.store.finishCompensation(input.scope, compId, outcome.status, outcome.resultCode)
    } catch {
      try {
        input.store.finishCompensation(
          input.scope,
          compId,
          'unknown',
          input.signal.aborted ? 'compensation-aborted-no-replay' : 'compensation-error-no-replay',
        )
      } catch {
        // Already settled or disposed; fail closed.
      }
    }
  }

  return input.store.listCompensations(input.scope, input.runId)
}
